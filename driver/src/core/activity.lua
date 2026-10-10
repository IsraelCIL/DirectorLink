-- The controller's activity history (ADR-046, docs/HISTORY.md): what DirectorLink did and what it
-- noticed, for admins (Settings → Controller → History in the app, GET /v1/activity). Scenes run,
-- schedules run or skipped and why, doors and gates opened, keys paired, revoked and changed,
-- invitations accepted, changes made in Composer, backups and restores, driver updates, and the
-- remote connection when it was away for more than a minute.
-- Each entry says when, who (a key's device and person, a schedule, Composer or DirectorLink itself),
-- what, by the names the controller had then, and how it went (ran; skipped and why; failed and on
-- how many devices), with a few ids.
-- The newest entries are kept (MAX_ENTRIES, none older than MAX_AGE_SECONDS) in the driver's
-- persistent data, so they survive restarts and driver updates. They are kept in pages of PAGE_SIZE,
-- and only pages that changed are written: at most once every SAVE_DELAY_MS, and at once when the
-- driver stops (Activity.flush). This module only keeps what it is told: the code that acts says
-- what happened, in one call (Activity.record), and a failure here never reaches it.

local Clock = require("src.core.clock")
local Json = require("src.core.json")
local Log = require("src.core.log")
local Store = require("src.core.store")

local Activity = {}

Activity.MAX_ENTRIES = 500
Activity.PAGE_SIZE = 50
Activity.MAX_AGE_SECONDS = 30 * 24 * 3600
Activity.SAVE_DELAY_MS = 3000
-- Names and texts are cut to this many bytes (whole characters); a list of changes to MAX_CHANGES.
Activity.MAX_TEXT = 100
Activity.MAX_CHANGES = 20
-- The remote connection is in the history only when it was away longer than this (a drop of a
-- second or two, then back, is not news; the log has every one).
Activity.AWAY_SECONDS = 60
-- What an entry is about; GET /v1/activity filters by them.
Activity.KINDS = { scene = true, schedule = true, door = true, composer = true, access = true, system = true }
Activity.COMPOSER = { type = "composer" }

local PAGE_KEY = "directorlink_activity_" -- .. the page's slot, 1 to MAX_ENTRIES / PAGE_SIZE
local STATE_KEY = "directorlink_activity"
local STORE_VERSION = 1

-- The fields an entry may have besides id, at, kind, action and who (docs/HISTORY.md).
local TEXTS = { "what", "room", "via", "outcome", "reason", "note", "from", "to" }
local NUMBERS = { "count", "seconds", "more" }
local COUNTS = { "ran", "skipped", "failed" }
local IDS = { "scene_id", "schedule_id", "device_id", "key_id", "room_id", "invitation_id", "link_id", "doorbell_id" }
local CHANGE_TEXTS = { "change", "type", "name", "room", "from" }
-- control4: a door or gate opened that DirectorLink did not open (1.7.0, ADR-050).
-- `link` (1.7.0, ADR-051): a scene run by its link, from a phone's automation.
local WHO_TYPES = { key = true, schedule = true, composer = true, controller = true, control4 = true, link = true }
local OUTCOMES = { ran = true, skipped = true, failed = true }

local state = {
    loaded = false,
    pages = {}, -- oldest first: { seq, slot, items = { entry, ... } }, each in the order recorded
    nextId = 1,
    nextSeq = 1,
    dirty = {}, -- slot -> true: to be written
    timer = nil,
    keyInfo = nil, -- function(keyId) -> { name, profile } or nil (Activity.load)
    driver = nil, -- the DirectorLink version that last started
    listener = nil, -- function(entry), told of each entry (Activity.onRecord)
}

-- `value` as text without control characters, at most `limit` bytes and never half a character
-- (names are UTF-8; a Hebrew letter is two bytes).
local function cut(value, limit)
    if value == nil or value == Json.null then
        return nil
    end
    local text = tostring(value):gsub("%c", " ")
    if #text <= limit then
        return text
    end
    text = text:sub(1, limit)
    for index = #text, math.max(1, #text - 3), -1 do
        local byte = text:byte(index)
        if byte < 0x80 then
            break
        elseif byte >= 0xC0 then
            local length = byte >= 0xF0 and 4 or byte >= 0xE0 and 3 or 2
            if #text - index + 1 < length then
                text = text:sub(1, index - 1)
            end
            break
        end
    end
    return text
end

local function number(value)
    return type(value) == "number" and value == value and value or nil
end

local function pageLimit()
    return math.max(1, math.ceil(Activity.MAX_ENTRIES / Activity.PAGE_SIZE))
end

-- Who did it: a key (by its id, or the API's ctx.apiKey), else `fields.who` (a schedule, Composer),
-- else Composer for its own changes and DirectorLink for the rest.
local function whoOf(kind, fields)
    local by = fields.by
    if type(by) == "table" then
        by = by.id
    end
    if type(by) == "string" and by ~= "" then
        local info = state.keyInfo and state.keyInfo(by) or nil
        local who = {
            type = "key",
            key_id = cut(by, 16),
            name = cut((info and info.name) or (type(fields.by) == "table" and fields.by.name) or nil, Activity.MAX_TEXT),
            profile = cut(info and info.profile, Activity.MAX_TEXT),
        }
        -- Through the account, away from home.
        if type(fields.by) == "table" and fields.by.remote == true then
            who.remote = true
        end
        return who
    end
    local given = fields.who
    if type(given) == "table" and WHO_TYPES[given.type] then
        local who = { type = given.type }
        if given.type == "schedule" then
            who.schedule_id = cut(given.schedule_id, 16)
            -- What the app says the schedule in (its time and days), as it was then.
            if type(given.trigger) == "table" then
                who.trigger = Json.decode(Json.encode(given.trigger))
            end
            if type(given.days) == "table" then
                who.days = Json.array()
                for _, day in ipairs(given.days) do
                    who.days[#who.days + 1] = number(day)
                end
            end
        elseif given.type == "link" then
            -- The link's id, and the label an admin gave it (if any), as it was then.
            who.link_id = cut(given.link_id, 16)
            who.name = cut(given.name, Activity.MAX_TEXT)
        end
        return who
    end
    return { type = kind == "composer" and "composer" or "controller" }
end

-- The entry without its id: finding who did it may record an entry of its own first (a key that
-- just expired goes when it is looked up), and that one must not get the same id.
local function build(kind, action, fields)
    local entry = { at = Clock.now(), kind = kind, action = cut(action, 32), who = whoOf(kind, fields) }
    for _, field in ipairs(TEXTS) do
        entry[field] = cut(fields[field], Activity.MAX_TEXT)
    end
    for _, field in ipairs(NUMBERS) do
        entry[field] = number(fields[field])
    end
    if type(fields.counts) == "table" then
        entry.counts = {}
        for _, field in ipairs(COUNTS) do
            entry.counts[field] = number(fields.counts[field]) or 0
        end
        -- A scene's ACs left off, their last mode not known yet (1.10.0, ADR-070): from its problems.
        local unknown = 0
        for _, problem in ipairs(type(fields.counts.problems) == "table" and fields.counts.problems or {}) do
            if type(problem) == "table" and problem.code == "NO_LAST_MODE" then
                unknown = unknown + 1
            end
        end
        if unknown > 0 then
            entry.counts.no_last_mode = unknown
        end
        -- Of the skipped, the switches a level for a room or the whole home left as they are
        -- (ON_OFF_ONLY; ADR-077, 2026-10-09): the run counts them all, its problems only 50.
        local switches = number(fields.counts.on_off_only)
        if switches and switches > 0 then
            entry.counts.on_off_only = switches
        end
        -- Failed on a device, nothing sent (all skipped), or ran.
        if not entry.outcome then
            local counts = entry.counts
            entry.outcome = counts.failed > 0 and "failed" or (counts.ran == 0 and counts.skipped > 0) and "skipped" or "ran"
        end
    end
    if entry.outcome and not OUTCOMES[entry.outcome] then
        entry.outcome = nil
    end
    if type(fields.ids) == "table" then
        local ids = {}
        for _, field in ipairs(IDS) do
            local value = fields.ids[field]
            ids[field] = number(value) or cut(value, 16)
        end
        entry.ids = next(ids) and ids or nil
    end
    if type(fields.changes) == "table" then
        entry.changes = Json.array()
        for index, change in ipairs(fields.changes) do
            if index > Activity.MAX_CHANGES then
                entry.more = (entry.more or 0) + 1
            elseif type(change) == "table" then
                local item = {}
                for _, field in ipairs(CHANGE_TEXTS) do
                    item[field] = cut(change[field], Activity.MAX_TEXT)
                end
                entry.changes[#entry.changes + 1] = item
            end
        end
    end
    return entry
end

local function cancelTimer()
    local timer = state.timer
    state.timer = nil
    if timer then
        pcall(function()
            timer:Cancel()
        end)
    end
end

-- Writes the pages that changed (an emptied slot as an empty page).
local function save()
    cancelTimer()
    for slot in pairs(state.dirty) do
        local items, seq = Json.array(), 0
        for _, page in ipairs(state.pages) do
            if page.slot == slot then
                seq = page.seq
                for index, entry in ipairs(page.items) do
                    items[index] = entry
                end
            end
        end
        if not Store.write(PAGE_KEY .. slot, { version = STORE_VERSION, seq = seq, items = items }, false) then
            Log.warn("activity", "could not save the history", { page = slot })
        end
    end
    state.dirty = {}
end

local function saveSoon()
    if state.timer then
        return
    end
    local ok, timer = pcall(function()
        return C4:SetTimer(Activity.SAVE_DELAY_MS, function()
            state.timer = nil
            save()
        end, false)
    end)
    if ok and timer then
        state.timer = timer
    else
        save()
    end
end

-- Pages whose newest entry is older than MAX_AGE_SECONDS go (their slots are written empty).
local function prune(now)
    local oldest = now - Activity.MAX_AGE_SECONDS
    while #state.pages > 0 do
        local page = state.pages[1]
        local newest = page.items[#page.items]
        if newest and newest.at >= oldest then
            break
        end
        table.remove(state.pages, 1)
        state.dirty[page.slot] = true
    end
end

-- A new page for the next entries, in a free slot; when every slot is used, the oldest page goes.
local function newPage()
    if #state.pages >= pageLimit() then
        local oldest = table.remove(state.pages, 1)
        state.dirty[oldest.slot] = true
    end
    local used = {}
    for _, page in ipairs(state.pages) do
        used[page.slot] = true
    end
    local slot = 1
    while used[slot] do
        slot = slot + 1
    end
    local page = { seq = state.nextSeq, slot = slot, items = {} }
    state.nextSeq = state.nextSeq + 1
    state.pages[#state.pages + 1] = page
    return page
end

local function valid(entry)
    return type(entry) == "table" and type(entry.id) == "number" and type(entry.at) == "number"
        and type(entry.kind) == "string" and Activity.KINDS[entry.kind] and type(entry.action) == "string"
        and type(entry.who) == "table" and WHO_TYPES[entry.who.type] ~= nil
end

-- Reads the history kept. `options.keyInfo(keyId)` says a key's name and person ({ name, profile })
-- for the entries to come. Returns how many entries there are. Until it runs, nothing is recorded.
function Activity.load(options)
    options = options or {}
    cancelTimer()
    state.keyInfo = options.keyInfo
    state.pages, state.dirty, state.nextId, state.nextSeq = {}, {}, 1, 1
    local count = 0
    for slot = 1, pageLimit() do
        local stored = Store.read(PAGE_KEY .. slot, false)
        if type(stored) == "table" and type(stored.seq) == "number" then
            local items = {}
            for _, entry in ipairs(Store.items(stored.items)) do
                if valid(entry) then
                    items[#items + 1] = entry
                    state.nextId = math.max(state.nextId, entry.id + 1)
                end
            end
            state.nextSeq = math.max(state.nextSeq, stored.seq + 1)
            if #items > 0 then
                state.pages[#state.pages + 1] = { seq = stored.seq, slot = slot, items = items }
                count = count + #items
            end
        end
    end
    table.sort(state.pages, function(a, b)
        return a.seq < b.seq
    end)
    local stored = Store.read(STATE_KEY, false)
    state.driver = type(stored) == "table" and type(stored.driver) == "string" and stored.driver or nil
    state.loaded = true
    prune(Clock.now())
    if next(state.dirty) then
        saveSoon()
    end
    return count
end

-- Records what happened: `kind` (Activity.KINDS), `action` (what it was), and `fields` (by: the key
-- that did it, its id or the API's ctx.apiKey; or who: { type = "schedule" | "composer" |
-- "controller" | "control4", ... }; what, room, via, outcome, reason, note, from, to; count, seconds; counts
-- { ran, skipped, failed }; ids; changes { { change, type, name, room, from } }). No fields: nothing
-- happened, and nothing is recorded. Returns the entry, or nil.
function Activity.record(kind, action, fields)
    if not state.loaded or not Activity.KINDS[kind] or type(fields) ~= "table" then
        return nil
    end
    local ok, entry = pcall(build, kind, action, fields)
    if not ok then
        Log.warn("activity", "could not record an entry", { kind = kind, action = tostring(action), error = tostring(entry) })
        return nil
    end
    -- Only now: an entry recorded while this one was built has taken the id before it.
    entry.id = state.nextId
    state.nextId = state.nextId + 1
    local now = entry.at
    prune(now)
    local page = state.pages[#state.pages]
    if not page or #page.items >= Activity.PAGE_SIZE then
        page = newPage()
    end
    page.items[#page.items + 1] = entry
    state.dirty[page.slot] = true
    saveSoon()
    if state.listener then
        local told, err = pcall(state.listener, entry)
        if not told then
            Log.warn("activity", "an entry's listener failed", { kind = kind, action = tostring(action), error = tostring(err) })
        end
    end
    return entry
end

-- `listener(entry)` is told of every entry recorded from now on (alerts: a door opened, ADR-050).
-- What it does never reaches the code that recorded the entry.
function Activity.onRecord(listener)
    state.listener = listener
end

-- Writes what waits to be written (the driver stops).
function Activity.flush()
    if next(state.dirty) then
        save()
    end
    cancelTimer()
end

-- At every start: a new DirectorLink (`version` is not the one that started last, or Director
-- updated the driver), the driver just added, or started again (the controller restarted).
function Activity.started(version, initType)
    local before = state.driver
    if before ~= version then
        state.driver = version
        Store.write(STATE_KEY, { version = STORE_VERSION, driver = version }, false)
    end
    if initType == "DIT_ADDING" then
        return Activity.record("system", "driver_added", { to = version })
    elseif (before and before ~= version) or initType == "DIT_UPDATING" then
        return Activity.record("system", "driver_updated", { from = before, to = version })
    end
    return Activity.record("system", "driver_started", { to = version })
end

-- An entry as GET /v1/activity shows it.
function Activity.view(entry)
    local item = { id = entry.id, at = Clock.iso(entry.at), kind = entry.kind, action = entry.action, who = {} }
    for field, value in pairs(entry.who) do
        item.who[field] = value
    end
    if item.who.days then
        item.who.days = Json.array(Store.items(item.who.days))
    end
    for _, field in ipairs(TEXTS) do
        item[field] = entry[field]
    end
    for _, field in ipairs(NUMBERS) do
        item[field] = entry[field]
    end
    item.counts = entry.counts
    item.ids = entry.ids
    if entry.changes then
        item.changes = Json.array(Store.items(entry.changes))
    end
    return item
end

-- The entries newest first: of `options.kinds` (a set; nil for all), recorded before the entry
-- `options.before` (an id; nil for the newest), at most `options.limit`, none older than
-- MAX_AGE_SECONDS. Returns them (as Activity.view shows them) and the id to ask for the next ones
-- before, or nil when there are no more.
function Activity.list(options)
    options = options or {}
    local limit = options.limit or 50
    local oldest = Clock.now() - Activity.MAX_AGE_SECONDS
    local items, more = Json.array(), false
    for pageIndex = #state.pages, 1, -1 do
        local page = state.pages[pageIndex]
        for index = #page.items, 1, -1 do
            local entry = page.items[index]
            if entry.at >= oldest and (not options.before or entry.id < options.before) and (not options.kinds or options.kinds[entry.kind]) then
                if #items >= limit then
                    more = true
                    break
                end
                items[#items + 1] = Activity.view(entry)
            end
        end
        if more then
            break
        end
    end
    return items, more and items[#items].id or nil
end

-- How many entries are kept (for tests and the log).
function Activity.count()
    local count = 0
    for _, page in ipairs(state.pages) do
        count = count + #page.items
    end
    return count
end

return Activity
