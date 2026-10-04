-- Scene links (ADR-051, docs/SCENES.md): a private link per scene that the phone's own automations
-- call (iPhone Shortcuts, Android automation apps, an NFC tag opened in a browser). The account
-- service takes the link and its secret and passes them to this home over the relay (docs/RELAY.md,
-- `link`); src/api/handlers/scene_links.lua runs the scene.
-- One link per scene. The controller keeps only a hash of its secret, as it keeps API keys
-- (ADR-028), the home id the link was made for (the address names it) and the key that made it:
-- revoking that key, or its expiry, removes the link. Only a scene whose steps are all of types a
-- link may run (SceneLinks.ALLOWED: never doors or gates) has one: making one is refused
-- otherwise, a change that adds another step removes the scene's link, and every run checks again.

local Clock = require("src.core.clock")
local Json = require("src.core.json")
local Log = require("src.core.log")
local Random = require("src.core.random")
local Store = require("src.core.store")
local Activity = require("src.core.activity")

local SceneLinks = {}

local STORE_KEY = "directorlink_scene_links"
SceneLinks.STORE_VERSION = 1
-- The secret: 40 hex digits, 160 bits from src/core/random.lua. The link's id: 8.
SceneLinks.SECRET_LENGTH = 40
SceneLinks.ID_LENGTH = 8
-- Runs of one link that go through: at most this many in WINDOW_SECONDS (the account service also
-- lets only so many requests a minute reach a home).
SceneLinks.RUNS_PER_WINDOW = 6
SceneLinks.WINDOW_SECONDS = 60
-- Strongest first, as for API keys; each link keeps the algorithm it was hashed with.
local ALGORITHMS = {
    { name = "sha256", c4 = "SHA256", length = 64 },
    { name = "sha1", c4 = "SHA1", length = 40 },
}

-- `complete` is false after the stored links could not be read: saving then would lose them.
-- `runs`: link id -> the times its last runs went through (memory only).
local state = { links = {}, complete = true, runs = {} }

local function isLowerHex(value, length)
    return type(value) == "string" and #value == length and value:match("^[0-9a-f]+$") ~= nil
end

local function algorithmNamed(name)
    for _, algorithm in ipairs(ALGORITHMS) do
        if algorithm.name == name then
            return algorithm
        end
    end
    return nil
end

local function digest(algorithm, text)
    local ok, hash = pcall(function()
        return C4:Hash(algorithm.c4, text, { return_encoding = "HEX" })
    end)
    if ok and type(hash) == "string" and #hash == algorithm.length then
        return hash:lower()
    end
    return nil
end

local function hashSecret(secret)
    for _, algorithm in ipairs(ALGORITHMS) do
        local hash = digest(algorithm, secret)
        if hash then
            return hash, algorithm.name
        end
    end
    return nil
end

local function sameText(left, right)
    if type(left) ~= "string" or type(right) ~= "string" or #left ~= #right then
        return false
    end
    local same = true
    for index = 1, #left do
        if left:byte(index) ~= right:byte(index) then
            same = false
        end
    end
    return same
end

-- The step types a linked scene may have: what anyone holding its link may switch, from anywhere.
-- Doors and gates never (REFUSED). A step type on neither list (one added later) keeps a scene
-- from having a link until it is put on one (tests/test_scene_links.lua checks Scenes.TYPES).
SceneLinks.ALLOWED = { lights = true, climate = true, fans = true, blinds = true, music = true, refrigerators = true }
SceneLinks.REFUSED = { relays = true }

-- True for a scene that may have a link: every one of its steps is of an allowed type.
function SceneLinks.linkable(scene)
    for _, step in ipairs(type(scene) == "table" and scene.steps or {}) do
        if type(step) ~= "table" or not SceneLinks.ALLOWED[step.type] then
            return false
        end
    end
    return true
end

-- A link as stored (with its hash), or nil when it is not one.
local function readLink(item)
    if type(item) ~= "table" or not isLowerHex(item.id, SceneLinks.ID_LENGTH) or not isLowerHex(item.scene_id, 8) then
        return nil
    end
    local algorithm = algorithmNamed(item.alg)
    if not algorithm or not isLowerHex(item.hash, algorithm.length) or not isLowerHex(item.home, 32) then
        return nil
    end
    local label = type(item.label) == "string" and item.label ~= "" and item.label:sub(1, 256) or nil
    return {
        id = item.id,
        scene_id = item.scene_id,
        label = label,
        alg = item.alg,
        hash = item.hash,
        home = item.home,
        -- The key that made it; none for a link made before DirectorLink recorded it (a test build
        -- of 1.7.0): Revoke All API Keys ends those.
        by = isLowerHex(item.by, 8) and item.by or nil,
        created_at = type(item.created_at) == "string" and item.created_at or Clock.iso(),
        last_used_at = type(item.last_used_at) == "string" and item.last_used_at or nil,
    }
end

local function record(link)
    return {
        id = link.id,
        scene_id = link.scene_id,
        label = link.label,
        alg = link.alg,
        hash = link.hash,
        home = link.home,
        by = link.by,
        created_at = link.created_at,
        last_used_at = link.last_used_at,
    }
end

-- What the API shows of a link: never its hash.
local function view(link)
    return {
        id = link.id,
        scene_id = link.scene_id,
        label = link.label,
        home = link.home,
        by = link.by,
        created_at = link.created_at,
        last_used_at = link.last_used_at,
    }
end

local function save()
    local records = Json.array()
    for _, link in ipairs(state.links) do
        records[#records + 1] = record(link)
    end
    local ok = Store.write(STORE_KEY, { version = SceneLinks.STORE_VERSION, links = records }, false)
    if ok then
        state.complete = true
    else
        Log.error("scenes", "could not save the scene links")
    end
    return ok
end

-- The links of a stored record ({ version, links }, as the store or a backup holds them), each
-- checked; one link a scene and one scene a link id. Returns them and how many were left out.
function SceneLinks.read(data)
    local links, dropped, ids, scenes = {}, 0, {}, {}
    for _, item in ipairs(Store.items(type(data) == "table" and data.links or nil)) do
        local link = readLink(item)
        if link and not ids[link.id] and not scenes[link.scene_id] then
            ids[link.id], scenes[link.scene_id] = true, true
            links[#links + 1] = link
        else
            dropped = dropped + 1
        end
    end
    return links, dropped
end

-- Returns how many links there are and how the store came back ("json", "missing", "unreadable").
-- DirectorLink before 1.7.0 never reads this store: going back to it loses nothing it knows.
function SceneLinks.load()
    local data, form = Store.read(STORE_KEY, false)
    state.complete = form ~= "unreadable"
    state.runs = {}
    local dropped
    state.links, dropped = SceneLinks.read(data)
    if dropped > 0 then
        Log.warn("scenes", "stored scene links that are not valid were left out", { links = dropped })
    end
    return #state.links, form
end

-- False after the stored links could not be read at start (they may come back at the next one).
function SceneLinks.complete()
    return state.complete
end

function SceneLinks.list()
    local items = {}
    for _, link in ipairs(state.links) do
        items[#items + 1] = view(link)
    end
    return items
end

local function indexOfScene(sceneId)
    for index, link in ipairs(state.links) do
        if link.scene_id == sceneId then
            return index
        end
    end
    return nil
end

function SceneLinks.forScene(sceneId)
    local index = indexOfScene(sceneId)
    return index and view(state.links[index]) or nil
end

-- A new link for `sceneId`, made for the home `home` (its id) by the key `by` (its id), with an
-- optional `label`. It replaces the scene's link, which stops working at once. Returns the link (as
-- the API shows it), its secret (never kept), and the link it replaced, or nil and a code.
function SceneLinks.create(sceneId, label, home, by)
    if not state.complete then
        return nil, "STORE_UNREADABLE"
    end
    local ok, idSource, secret = pcall(function()
        return Random.hex(32), Random.hex(SceneLinks.SECRET_LENGTH)
    end)
    if not ok then
        return nil, "RANDOM_UNAVAILABLE"
    end
    local hash, alg = hashSecret(secret)
    if not hash then
        return nil, "HASH_UNAVAILABLE"
    end
    local used = {}
    for _, link in ipairs(state.links) do
        used[link.id] = true
    end
    local id
    for start = 1, #idSource - SceneLinks.ID_LENGTH + 1, SceneLinks.ID_LENGTH do
        local candidate = idSource:sub(start, start + SceneLinks.ID_LENGTH - 1)
        if not used[candidate] then
            id = candidate
            break
        end
    end
    if not id then
        return nil, "RANDOM_UNAVAILABLE"
    end
    local link = { id = id, scene_id = sceneId, label = label, alg = alg, hash = hash, home = home, by = by, created_at = Clock.iso() }
    local before = state.links
    local index = indexOfScene(sceneId)
    local replaced = index and view(before[index]) or nil
    local links = {}
    for _, other in ipairs(before) do
        if other.scene_id ~= sceneId then
            links[#links + 1] = other
        end
    end
    links[#links + 1] = link
    state.links = links
    if not save() then
        state.links = before
        return nil, "PERSIST_FAILED"
    end
    if replaced then
        state.runs[replaced.id] = nil
    end
    return view(link), secret, replaced
end

-- Removes the links for which `drop(link)` is true. Returns the removed links (as the API shows
-- them), or nil when they could not be saved (then they stay).
local function removeWhere(drop)
    local kept, removed = {}, {}
    for _, link in ipairs(state.links) do
        if drop(link) then
            removed[#removed + 1] = view(link)
        else
            kept[#kept + 1] = link
        end
    end
    if #removed == 0 then
        return removed
    end
    local before = state.links
    state.links = kept
    if not save() then
        state.links = before
        return nil
    end
    for _, link in ipairs(removed) do
        state.runs[link.id] = nil
    end
    return removed
end

-- Removes the scene's link. Returns it, or nil and a code (NOT_FOUND, STORE_UNREADABLE,
-- PERSIST_FAILED).
function SceneLinks.remove(sceneId)
    if not state.complete then
        return nil, "STORE_UNREADABLE"
    end
    if not indexOfScene(sceneId) then
        return nil, "NOT_FOUND"
    end
    local removed = removeWhere(function(link)
        return link.scene_id == sceneId
    end)
    if not removed then
        return nil, "PERSIST_FAILED"
    end
    return removed[1]
end

-- Composer's Remove All Scene Links and Revoke All API Keys, and a new remote identity (the
-- addresses named the old home). Returns how many there were and whether that was saved: when it
-- could not be, they stay, here as in the store (a restart would bring them back). A store that
-- could not be read at start is written empty: whatever it still held is removed too.
function SceneLinks.removeAll()
    local count, links, runs = #state.links, state.links, state.runs
    state.links = {}
    state.runs = {}
    if not save() then
        state.links, state.runs = links, runs
        return count, false
    end
    return count, true
end

-- A link that went without an admin removing it: logged, and in the history with why (`reason`:
-- doors, scene_gone, other_home, key_gone) and the scene's name; `by`: the key whose change made
-- it go.
local function noteRemoved(link, reason, sceneName, by)
    Log.info("scenes", "scene link removed", { link_id = link.id, scene = link.scene_id, reason = reason })
    Activity.record("access", "link_removed", {
        by = by,
        what = sceneName,
        reason = reason,
        note = link.label,
        ids = { scene_id = link.scene_id, link_id = link.id },
    })
end

-- The links whose scene is gone or now has a step a link may not run (doors or gates), that were
-- made for another home than `home` (when given), or whose key is gone (`keyExists(id)`, when
-- given: revoked or expired; a link that names no key stays) go. `findScene(id)` gives a scene or
-- nil. Returns them.
function SceneLinks.prune(findScene, home, keyExists)
    if not state.complete or #state.links == 0 then
        return {}
    end
    local why = {}
    local removed = removeWhere(function(link)
        local scene = findScene(link.scene_id)
        if not scene then
            why[link.id] = { reason = "scene_gone" }
        elseif not SceneLinks.linkable(scene) then
            why[link.id] = { reason = "doors", name = scene.name }
        elseif home and link.home ~= home then
            why[link.id] = { reason = "other_home", name = scene.name }
        elseif keyExists and link.by and not keyExists(link.by) then
            why[link.id] = { reason = "key_gone", name = scene.name }
        end
        return why[link.id] ~= nil
    end) or {}
    for _, link in ipairs(removed) do
        noteRemoved(link, why[link.id].reason, why[link.id].name)
    end
    return removed
end

-- A scene was changed (`scene`, as saved) by the key `by`: once it has a step a link may not run
-- (doors or gates), its link goes. Returns the link removed, or nil.
function SceneLinks.sceneChanged(scene, by)
    if not state.complete or SceneLinks.linkable(scene) or not indexOfScene(scene.id) then
        return nil
    end
    local removed = removeWhere(function(link)
        return link.scene_id == scene.id
    end)
    if removed and removed[1] then
        noteRemoved(removed[1], "doors", scene.name, by)
        return removed[1]
    end
    return nil
end

-- A scene was deleted: its link goes with it. Returns the link removed, or nil.
function SceneLinks.sceneDeleted(sceneId, sceneName, by)
    if not state.complete or not indexOfScene(sceneId) then
        return nil
    end
    local removed = removeWhere(function(link)
        return link.scene_id == sceneId
    end)
    if removed and removed[1] then
        noteRemoved(removed[1], "scene_gone", sceneName, by)
        return removed[1]
    end
    return nil
end

-- The link with this id when `secret` is its secret, or nil: an unknown link and a wrong secret
-- look the same. The presented secret is hashed even for an unknown link, and the hashes are
-- compared in constant time.
function SceneLinks.check(linkId, secret)
    if type(secret) ~= "string" or #secret ~= SceneLinks.SECRET_LENGTH or not secret:match("^%x+$") then
        return nil
    end
    secret = secret:lower()
    local found
    for _, link in ipairs(state.links) do
        if link.id == linkId then
            found = link
        end
    end
    local algorithm = algorithmNamed(found and found.alg or "sha256") or ALGORITHMS[1]
    local hash = digest(algorithm, secret)
    if found and hash and sameText(hash, found.hash) then
        return view(found)
    end
    return nil
end

-- Whether another run of this link may go through now (at most RUNS_PER_WINDOW a window); if not,
-- also how many seconds until one may.
function SceneLinks.allow(linkId, now)
    now = now or Clock.now()
    local kept = {}
    for _, at in ipairs(state.runs[linkId] or {}) do
        if now - at < SceneLinks.WINDOW_SECONDS and at <= now then
            kept[#kept + 1] = at
        end
    end
    if #kept >= SceneLinks.RUNS_PER_WINDOW then
        state.runs[linkId] = kept
        return false, math.max(1, SceneLinks.WINDOW_SECONDS - (now - kept[1]))
    end
    kept[#kept + 1] = now
    state.runs[linkId] = kept
    return true
end

-- The link ran now: when it was last used, for the app's list.
function SceneLinks.used(linkId, now)
    for _, link in ipairs(state.links) do
        if link.id == linkId then
            link.last_used_at = Clock.iso(now)
            save()
        end
    end
end

-- Backups (ADR-042, src/core/backup.lua): the links as the store keeps them, hashes only, never a
-- secret.
function SceneLinks.backup()
    local records = Json.array()
    for _, link in ipairs(state.links) do
        records[#records + 1] = record(link)
    end
    return { version = SceneLinks.STORE_VERSION, links = records }
end

-- Replaces every link with the ones of `data`, read as the store's are. Returns true once saved.
function SceneLinks.restore(data)
    state.links = SceneLinks.read(data)
    state.runs = {}
    return save()
end

-- Test support: what a fresh start has.
function SceneLinks.reset()
    state.links, state.complete, state.runs = {}, true, {}
end

return SceneLinks
