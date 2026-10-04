-- Alerts the controller makes (ADR-050, docs/RELAY.md): a doorbell rang, a door or gate was opened,
-- the refrigerator's door was left open, a schedule failed. Each goes to DirectorLink's servers as
-- one "notify" message that names only the key ids it is for and, for each, the details sealed to
-- that key: what happened, when, by the names the controller has (the doorbell, the door, who opened
-- it as the history names them), so that the servers can deliver it to the browsers of those keys
-- (Web Push) without being able to read it. Only the device of that key can open its part.
--
-- Who gets what is decided here: a key whose role may get the kind (ROLES), whose device has
-- switched alerts on, and whose own choices include it (DEFAULTS until it chose). The choices are
-- each key's, kept in the driver's persistent data and read and set by that key only
-- (GET and PUT /v1/alerts/choices, src/api/handlers/alerts.lua).
--
-- A key's alert key is HMAC-SHA256(its lock key, LABEL); its "enc" and "mac" keys seal a detail as
-- lock.lua seals a request: AES-256-CBC, then an HMAC-SHA256 over the home, the key id, the IV and
-- the ciphertext, through C4:Encrypt and C4:HMAC. tests/vectors/alert.json is shared with the app,
-- whose service worker keeps only that alert key (never the lock key or the API key).

local Base64 = require("src.core.base64")
local Clock = require("src.core.clock")
local DoorBird = require("src.adapters.doorbird")
local KnxRelay = require("src.adapters.knx_relay")
local Json = require("src.core.json")
local Log = require("src.core.log")
local Random = require("src.core.random")
local Roles = require("src.auth.roles")
local Store = require("src.core.store")

local Alerts = {}

Alerts.LABEL = "DirectorLink alert v1"
-- In the order the app lists them.
Alerts.KINDS = { "doorbell", "door_opened", "fridge_door", "schedule_failed" }
-- The least role that gets each: whoever may see a doorbell (every key), the admins for doors
-- opened and schedules, members and admins (and doors keys) for the refrigerator.
Alerts.ROLES = { doorbell = "viewer", door_opened = "admin", fridge_door = "member", schedule_failed = "admin" }
-- A key that never chose gets these.
Alerts.DEFAULTS = { doorbell = true, door_opened = false, fridge_door = true, schedule_failed = true }
-- At most one alert per doorbell in RING_SECONDS, per door in DOOR_SECONDS, per refrigerator in
-- FRIDGE_SECONDS; SCHEDULE_PER_HOUR schedule alerts, and PER_HOUR alerts in all, an hour.
Alerts.RING_SECONDS = 30
Alerts.DOOR_SECONDS = 60
Alerts.FRIDGE_SECONDS = 300
Alerts.SCHEDULE_PER_HOUR = 3
Alerts.PER_HOUR = 60
-- A door or doorbell reporting an opening this soon after DirectorLink's own command to it was
-- opened by that command (already in the history, with who did it).
Alerts.OWN_SECONDS = 15
-- Names in a detail are cut to this many bytes (whole characters). Every detail is padded with
-- spaces to DETAIL_BYTES before it is sealed, so that every part's ciphertext has the same size
-- (512 bytes, 684 in base64) whatever its kind and names; one larger has its names shortened. Every
-- push is padded to one size too (cloud/src/web-push.js).
Alerts.MAX_NAME = 60
Alerts.DETAIL_BYTES = 496

local STORE_KEY = "directorlink_alert_choices"
local STORE_VERSION = 1
local HOUR = 3600

local state = {
    loaded = false,
    readable = true,
    -- key id -> { on = boolean, kinds = { kind -> boolean } }
    choices = {},
    options = nil,
    -- What was sent when, for the limits: "kind:id" -> time, and the times of the last hour.
    last = {},
    hour = {},
    schedules = {},
    -- The alert keys of lock keys: key id -> { lock, enc, mac }.
    sealing = {},
}

local KNOWN = {}
for _, kind in ipairs(Alerts.KINDS) do
    KNOWN[kind] = true
end

local function hmac(key, keyEncoding, data)
    local mac, err = C4:HMAC("SHA256", key, data, { key_encoding = keyEncoding, data_encoding = "NONE", return_encoding = "HEX" })
    if type(mac) ~= "string" or #mac ~= 64 then
        error("HMAC-SHA256 failed: " .. tostring(err), 0)
    end
    return mac:lower()
end

-- A key's alert key (hex) from its lock key (hex).
function Alerts.alertKey(lockHex)
    return hmac(lockHex, "HEX", Alerts.LABEL)
end

local function keysOf(keyId, lockHex)
    local cached = state.sealing[keyId]
    if cached and cached.lock == lockHex then
        return cached.enc, cached.mac
    end
    local alertKey = Alerts.alertKey(lockHex)
    cached = { lock = lockHex, enc = hmac(alertKey, "HEX", "enc"), mac = hmac(alertKey, "HEX", "mac") }
    state.sealing[keyId] = cached
    return cached.enc, cached.mac
end

-- `plaintext` sealed to the key `keyId` whose lock key is `lockHex`, for `home`: { iv, ct, mac }
-- (base64). ivHex: tests only.
function Alerts.seal(lockHex, home, keyId, plaintext, ivHex)
    local encKey, macKey = keysOf(keyId, lockHex)
    ivHex = ivHex or Random.hex(32)
    local ct, err = C4:Encrypt("AES-256-CBC", encKey, ivHex, plaintext, {
        key_encoding = "HEX",
        iv_encoding = "HEX",
        data_encoding = "NONE",
        return_encoding = "BASE64",
        padding = true,
    })
    if type(ct) ~= "string" then
        error("AES-256-CBC failed: " .. tostring(err), 0)
    end
    ct = ct:gsub("%s+", "")
    local iv = Base64.encode(Base64.fromHex(ivHex))
    local mac = Base64.encode(Base64.fromHex(hmac(macKey, "HEX", "alert v1|" .. home .. "|" .. keyId .. "|" .. iv .. "|" .. ct)))
    return { iv = iv, ct = ct, mac = mac }
end

-- `value` as text without control characters, at most `limit` bytes and never half a character.
local function cut(value, limit)
    if type(value) ~= "string" then
        return nil
    end
    local text = value:gsub("%c", " ")
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

-- ---- the choices -----------------------------------------------------------------------------

local function save()
    local keys = {}
    for id, choice in pairs(state.choices) do
        local kinds = {}
        for kind, on in pairs(choice.kinds) do
            kinds[kind] = on
        end
        keys[id] = { on = choice.on, kinds = kinds }
    end
    return Store.write(STORE_KEY, { version = STORE_VERSION, keys = keys }, false)
end

-- Reads the stored choices. A store that cannot be read is never written over (its choices may come
-- back at the next start); meanwhile nobody gets alerts and nobody can choose.
function Alerts.load()
    state.choices, state.readable = {}, true
    local data, how = Store.read(STORE_KEY, false)
    if how == "unreadable" or (data ~= nil and type(data.keys) ~= "table") then
        state.readable = false
        Log.error("alerts", "the alert choices could not be read; nobody gets alerts until the next start")
    elseif data then
        for id, choice in pairs(data.keys) do
            if type(id) == "string" and id:match("^%x+$") and type(choice) == "table" then
                local kinds = {}
                for kind, on in pairs(type(choice.kinds) == "table" and choice.kinds or {}) do
                    if KNOWN[kind] and type(on) == "boolean" then
                        kinds[kind] = on
                    end
                end
                state.choices[id] = { on = choice.on == true, kinds = kinds }
            end
        end
    end
    state.loaded = true
    return state.readable
end

-- options: connected() and tell(message) (the relay connection; false while not connected), keys
-- (src/auth/keys.lua), homeId(), available() (the lock passed its self-test), present(kind) (the
-- home has what the kind is about: a doorbell, a door, a refrigerator); for deviceEvent, below.
function Alerts.configure(options)
    state.options = options
end

local function present(kind)
    local options = state.options
    if kind == "schedule_failed" then
        return true
    end
    return options ~= nil and options.present ~= nil and options.present(kind) == true
end

-- Wires the alerts to the rest of the driver (main.lua, at start): deps = { relay, remote, keys,
-- registry, adapters (src/adapters/manager.lua), activity (src/core/activity.lua), hasFridge? }.
-- `hasFridge()`: the home has a refrigerator (ADR-049), so its members may choose its alert.
function Alerts.start(deps)
    Alerts.load()
    Alerts.configure({
        connected = deps.relay.connected,
        tell = deps.relay.tell,
        keys = deps.keys,
        homeId = function()
            return deps.relay.identity().home_id
        end,
        available = deps.remote.available,
        present = function(kind)
            local registry = deps.registry
            if kind == "doorbell" then
                return #registry.doorbellList() > 0
            elseif kind == "door_opened" then
                return #registry.relayList() > 0 or #registry.doorbellList() > 0
            end
            return kind == "fridge_door" and deps.hasFridge ~= nil and deps.hasFridge() == true
        end,
        doorbellEvent = function(eventId)
            return DoorBird.EVENTS[tonumber(eventId)]
        end,
        relayClosed = KnxRelay.closedEvent,
        commandedAt = deps.adapters.commandedAt,
        record = deps.activity.record,
    })
    deps.adapters.onEvent(Alerts.deviceEvent)
    deps.activity.onRecord(Alerts.recorded)
end

local function wants(choice, kind)
    local chosen = choice and choice.kinds[kind]
    if chosen == nil then
        return Alerts.DEFAULTS[kind]
    end
    return chosen
end

-- What a key may choose, and what it chose: { on, kinds = { kind -> boolean } } for the kinds its
-- role may get that this home has.
function Alerts.view(key)
    local choice = state.choices[key.id]
    local kinds = {}
    for _, kind in ipairs(Alerts.KINDS) do
        if Roles.allows(key.role, Alerts.ROLES[kind]) and present(kind) then
            kinds[kind] = wants(choice, kind)
        end
    end
    return { on = choice ~= nil and choice.on == true, kinds = kinds }
end

-- A key's new choices: `on` (its device switched alerts on or off) and `kinds` (kind -> boolean;
-- kinds its role may not get are left out). Returns the view, or nil and UNAVAILABLE (the store
-- could not be read at start, or not written now).
function Alerts.choose(key, on, kinds)
    if not state.readable then
        return nil, "UNAVAILABLE"
    end
    local before = state.choices[key.id]
    local choice = { on = before ~= nil and before.on == true, kinds = {} }
    for kind, value in pairs(before and before.kinds or {}) do
        choice.kinds[kind] = value
    end
    if on ~= nil then
        choice.on = on
    end
    for kind, value in pairs(kinds or {}) do
        if Roles.allows(key.role, Alerts.ROLES[kind]) then
            choice.kinds[kind] = value
        end
    end
    state.choices[key.id] = choice
    if not save() then
        state.choices[key.id] = before
        return nil, "UNAVAILABLE"
    end
    Log.info("alerts", "alert choices changed", { key_id = key.id, on = choice.on })
    return Alerts.view(key)
end

-- Keys that are gone take their choices with them (`keys`: the keys that exist).
function Alerts.prune(keys)
    if not state.readable then
        return 0
    end
    local exists = {}
    for _, key in ipairs(keys) do
        exists[key.id] = true
    end
    local removed = 0
    for id in pairs(state.choices) do
        if not exists[id] then
            state.choices[id] = nil
            state.sealing[id] = nil
            removed = removed + 1
        end
    end
    if removed > 0 then
        save()
    end
    return removed
end

-- ---- sending ---------------------------------------------------------------------------------

-- Times of the last hour in `list`, without older ones.
local function lastHour(list, now)
    local kept = {}
    for _, at in ipairs(list) do
        if now - at < HOUR and at <= now then
            kept[#kept + 1] = at
        end
    end
    return kept
end

-- The names a detail may hold: { field } of the detail, or { "who", field }.
local NAMES = { { "name" }, { "room" }, { "via" }, { "who", "name" }, { "who", "profile" } }

-- `detail` as the text sealed: its JSON padded with spaces to DETAIL_BYTES. Quotes and backslashes
-- in names take two bytes each in JSON: a detail still larger has its names shortened together,
-- the longest first (whole characters), until it fits; nil only if it never does.
function Alerts.plaintext(detail)
    local text = Json.encode(detail)
    if #text > Alerts.DETAIL_BYTES then
        local names = {}
        for _, path in ipairs(NAMES) do
            local holder = #path == 1 and detail or detail[path[1]]
            local field = path[#path]
            if type(holder) == "table" and type(holder[field]) == "string" then
                names[#names + 1] = { holder = holder, field = field, value = holder[field] }
            end
        end
        for limit = Alerts.MAX_NAME - 1, 0, -1 do
            for _, item in ipairs(names) do
                item.holder[item.field] = cut(item.value, limit)
            end
            text = Json.encode(detail)
            if #text <= Alerts.DETAIL_BYTES then
                break
            end
        end
        if #text > Alerts.DETAIL_BYTES then
            return nil
        end
    end
    return text .. string.rep(" ", Alerts.DETAIL_BYTES - #text)
end

-- Whether `name` ("kind:id") was alerted less than `seconds` ago; if not, it is now.
local function tooSoon(name, seconds, now)
    local last = state.last[name]
    if last and now - last < seconds and now >= last then
        return true
    end
    state.last[name] = now
    return false
end

-- Sends `detail` (its kind and what to say) to every key that gets that kind, saying it happened at
-- `at` (a time, or the ISO text of one; default `now`). `brief`: kept by the push services a minute
-- only (a doorbell). Returns how many keys it went to, or nil and why not.
local function send(detail, now, brief, at)
    local options = state.options
    if not state.loaded or not state.readable or not options then
        return nil, "not ready"
    end
    -- Only while connected: an unreachable home is the account service's own alert (ADR-047).
    if options.connected and not options.connected() then
        return nil, "not connected"
    end
    if options.available and not options.available() then
        return nil, "lock unavailable"
    end
    local home = options.homeId and options.homeId()
    if type(home) ~= "string" or home == "" then
        return nil, "no remote identity"
    end
    state.hour = lastHour(state.hour, now)
    if #state.hour >= Alerts.PER_HOUR then
        return nil, "limit"
    end
    detail.v = 1
    detail.at = type(at) == "string" and at or Clock.iso(at or now)
    local plaintext = Alerts.plaintext(detail)
    if not plaintext then
        return nil, "too large"
    end
    local recipients, count = {}, 0
    for _, key in ipairs(options.keys.list()) do
        local choice = state.choices[key.id]
        if choice and choice.on and Roles.allows(key.role, Alerts.ROLES[detail.kind]) and wants(choice, detail.kind) then
            local remote = options.keys.remote(key.id)
            if remote and remote.lock then
                recipients[key.id] = Alerts.seal(remote.lock, home, key.id, plaintext)
                count = count + 1
            end
        end
    end
    if count == 0 then
        return 0
    end
    local message = { type = "notify", at = detail.at, ["for"] = recipients }
    if brief then
        message.brief = true
    end
    if not options.tell(message) then
        return nil, "not connected"
    end
    state.hour[#state.hour + 1] = now
    return count
end

local function sent(kind, count, why)
    if count then
        Log.info("alerts", count > 0 and "alert sent" or "alert for nobody", { kind = kind, keys = count })
    else
        Log.info("alerts", "alert not sent", { kind = kind, why = why })
    end
    return count, why
end

local function deviceDetail(kind, device)
    return {
        kind = kind,
        id = tonumber(device.id),
        name = cut(device.name, Alerts.MAX_NAME),
        room = cut(device.room_name, Alerts.MAX_NAME),
        room_id = tonumber(device.room_id),
    }
end

-- A doorbell rang (the DoorBird's event): everyone who may see it, at most once in RING_SECONDS. The
-- ring's time is the doorbell's own (its last_ring_at), so that the app knows the alert's ring.
function Alerts.ring(device, now)
    now = now or Clock.now()
    if tooSoon("doorbell:" .. tostring(device.id), Alerts.RING_SECONDS, now) then
        return sent("doorbell", nil, "too soon")
    end
    local last = device.state and device.state.last and device.state.last.doorbell
    return sent("doorbell", send(deviceDetail("doorbell", device), now, true, type(last) == "string" and last or nil))
end

-- The history recorded a door or gate opened (`entry`, src/core/activity.lua: a pulse, a relay held
-- open, the door at a doorbell; by a key, a scene, or in Control4): its admins, if they chose it,
-- at most once a door in DOOR_SECONDS.
function Alerts.doorOpened(entry, now)
    now = now or Clock.now()
    local ids = entry.ids or {}
    if tooSoon("door_opened:" .. tostring(ids.device_id), Alerts.DOOR_SECONDS, now) then
        return sent("door_opened", nil, "too soon")
    end
    local who = entry.who or {}
    local detail = {
        kind = "door_opened",
        action = entry.action,
        id = tonumber(ids.device_id),
        name = cut(entry.what, Alerts.MAX_NAME),
        room = cut(entry.room, Alerts.MAX_NAME),
        room_id = tonumber(ids.room_id),
        via = cut(entry.via, Alerts.MAX_NAME),
        who = {
            type = who.type,
            name = who.type == "key" and cut(who.name, Alerts.MAX_NAME) or nil,
            profile = who.type == "key" and cut(who.profile, Alerts.MAX_NAME) or nil,
            remote = who.remote == true or nil,
        },
    }
    return sent("door_opened", send(detail, now))
end

-- The refrigerator `device` ({ id, name, room_name, room_id }, as the registry has it) has had its
-- door open for at least `seconds` (optional: since DirectorLink saw it open, which its driver reads
-- at its poll): members and admins who chose it, at most once a refrigerator in FRIDGE_SECONDS, with
-- the whole minutes (rounded down; none under one). The refrigerator's integration calls this when
-- the door is left open (ADR-049, main.lua).
function Alerts.fridgeDoor(device, seconds, now)
    now = now or Clock.now()
    if type(device) ~= "table" then
        return nil, "no refrigerator"
    end
    if tooSoon("fridge_door:" .. tostring(device.id), Alerts.FRIDGE_SECONDS, now) then
        return sent("fridge_door", nil, "too soon")
    end
    local detail = deviceDetail("fridge_door", device)
    if type(seconds) == "number" and seconds >= 60 then
        detail.minutes = math.floor(seconds / 60)
    end
    return sent("fridge_door", send(detail, now))
end

-- A scheduled scene failed at `at` (src/core/scheduler.lua; `info.what`: the scene's name): the
-- admins who chose it, at most SCHEDULE_PER_HOUR an hour.
function Alerts.scheduleFailed(at, info, now)
    now = now or Clock.now()
    state.schedules = lastHour(state.schedules, now)
    if #state.schedules >= Alerts.SCHEDULE_PER_HOUR then
        return sent("schedule_failed", nil, "limit")
    end
    state.schedules[#state.schedules + 1] = now
    local detail = { kind = "schedule_failed", name = cut(info and info.what, Alerts.MAX_NAME) }
    -- At the run's own time (a run caught up after a restart is late).
    return sent("schedule_failed", send(detail, now, false, at))
end

-- ---- what the controller notices ---------------------------------------------------------------

-- An entry the history just recorded (Activity.onRecord): a door opened.
local OPENINGS = { pulse = true, hold = true, doorbell = true }

function Alerts.recorded(entry)
    if type(entry) == "table" and entry.kind == "door" and OPENINGS[entry.action] then
        Alerts.doorOpened(entry, entry.at)
    end
end

-- A device's event that its adapter took (src/adapters/manager.lua; `before`: the device's state
-- before it): a doorbell's ring, or a door or gate opened that DirectorLink did not open (in
-- Control4: its app, a keypad, its programming, the DoorBird's own app), which goes into the
-- history, at most once a door in DOOR_SECONDS, and from there to the admins. A relay counts only
-- when it closes from open as last reported: a relay that reports "closed" again (a status read
-- after a restart, a cyclic report) or whose state is not known yet opened nothing.
-- options (configure): doorbellEvent(eventId) -> "doorbell" | "opened" | ...; relayClosed(eventId);
-- commandedAt(deviceId) (DirectorLink's last command to it); record(kind, action, fields).
function Alerts.deviceEvent(device, eventId, before)
    local options = state.options
    if not options or type(device) ~= "table" then
        return
    end
    local now = Clock.now()
    local opened
    if device.kind == "doorbell" then
        local event = options.doorbellEvent and options.doorbellEvent(eventId)
        if event == "doorbell" then
            Alerts.ring(device, now)
            return
        end
        opened = event == "opened" and "doorbell" or nil
    elseif device.kind == "relay" and options.relayClosed and options.relayClosed(eventId) then
        opened = type(before) == "table" and before.relay == "open" and "pulse" or nil
    end
    if not opened then
        return
    end
    local commanded = options.commandedAt and options.commandedAt(device.id)
    if commanded and now - commanded <= Alerts.OWN_SECONDS and now >= commanded then
        return -- DirectorLink's own command: the history has it already, with who
    end
    if tooSoon("control4:" .. tostring(device.id), Alerts.DOOR_SECONDS, now) then
        return
    end
    if options.record then
        options.record("door", opened, {
            who = { type = "control4" },
            what = device.name,
            room = device.room_name,
            ids = { device_id = tonumber(device.id), room_id = tonumber(device.room_id) },
        })
    end
end

return Alerts
