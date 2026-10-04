-- API keys: named bearer secrets. Only a hash of each key is stored, so the key itself cannot be
-- read back from the controller's storage or a backup of it. Each key also has a lock key for
-- sealed requests (src/cloud/lock.lua, derived from the key), made when the key is created or, for
-- older keys, the first time the key is used on the home network; that one is stored as it is, and
-- opens sealed requests at home and through the relay (docs/ACCOUNTS.md, "What the lock does not
-- protect"). A key may have an expiry (ADR-040: the console's lasts a day); once it has passed,
-- the key is refused and removed.

local Json = require("src.core.json")
local Clock = require("src.core.clock")
local Roles = require("src.auth.roles")
local Store = require("src.core.store")
local Lock = require("src.cloud.lock")
local Random = require("src.core.random")

local Keys = {}

Keys.MAX_KEYS = 20

local STORE_KEY = "directorlink_api_key_hashes"
-- 0.8.0 and 0.9.0 kept the keys themselves, encrypted, under this name. They are moved to hashes
-- when Director can still read that store, which is then emptied.
local OLD_STORE_KEY = "directorlink_api_keys"
-- Keys are "ak_" plus 48 hex digits; anything much longer is not worth hashing.
local MAX_PRESENTED_LENGTH = 128
-- Strongest first. Each key keeps the algorithm it was hashed with.
local ALGORITHMS = {
    { name = "sha256", c4 = "SHA256", length = 64 },
    { name = "sha1", c4 = "SHA1", length = 40 },
}

-- The console's key name (console/js/session.js). Its keys from before 1.3.0 expire a day after
-- the first start of 1.3.0 (store version 4), like the ones it pairs now.
local CONSOLE_NAME = "DirectorLink Console"
local CONSOLE_SECONDS = 24 * 60 * 60
-- No key is made to last longer (expires_in, src/api/handlers/auth.lua). One with more left was
-- made while the controller's clock ran ahead, which has since been put back: it is over too, or
-- it would last as much longer (ADR-040). The margin is for small corrections of the clock.
Keys.LONGEST_LIFE = 30 * 24 * 60 * 60
local CLOCK_MARGIN = 60 * 60
local STORE_VERSION = 4
Keys.STORE_VERSION = STORE_VERSION

local state = {
    keys = {},
    lastUsed = {},
    onExpired = nil,
}

-- 32 random hex characters (src/core/random.lua: Director's UUIDs mixed into a pool).
local function randomHex()
    return Random.hex(32)
end

local function constantTimeEqual(left, right)
    if #left ~= #right then
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

-- Hashes a key with the strongest algorithm this controller offers.
local function hashKey(secret)
    for _, algorithm in ipairs(ALGORITHMS) do
        local hash = digest(algorithm, secret)
        if hash then
            return hash, algorithm.name
        end
    end
    return nil
end

local function save()
    local records = Json.array()
    for _, key in ipairs(state.keys) do
        records[#records + 1] = {
            id = key.id,
            name = key.name,
            role = key.role,
            alg = key.alg,
            hash = key.hash,
            lock = key.lock,
            created_at = key.created_at,
            profile = key.profile,
            expires = key.expires,
        }
    end
    local ok = Store.write(STORE_KEY, { version = 4, keys = records }, false)
    if ok then
        state.complete = true
    end
    return ok
end

local function validLock(value)
    return type(value) == "string" and value:match("^%x+$") and #value == 64 and value:lower() or nil
end

-- The lock key of a key (hex), or nil when this controller cannot make one.
local function lockFor(secret)
    local ok, lock = pcall(Lock.deviceKey, secret)
    return ok and lock or nil
end

local function loaded(key, hash, alg, lock)
    return {
        id = key.id,
        name = tostring(key.name or "API key"),
        -- Keys from before roles existed (0.6 and older) keep full access.
        role = Roles.valid(key.role) and key.role or "admin",
        alg = alg,
        hash = hash,
        lock = validLock(lock),
        created_at = type(key.created_at) == "string" and key.created_at or Clock.iso(),
        -- The person's profile (profiles.lua); keys from before 0.12.0 get one at start.
        profile = type(key.profile) == "string" and key.profile or nil,
        -- When it stops working (os.time), or nil for never (ADR-040).
        expires = tonumber(key.expires),
    }
end

-- True for a key that expires, once that time has passed (or it has more left than any key gets).
local function over(key, now)
    return key.expires ~= nil and (key.expires <= now or key.expires - now > Keys.LONGEST_LIFE + CLOCK_MARGIN)
end

-- The same rule for a key record that is not (yet) one of the controller's: a backup's (ADR-042).
function Keys.over(key, now)
    return over(key, now or os.time())
end

local function addLoaded(key, hash, alg, lock)
    state.keys[#state.keys + 1] = loaded(key, hash, alg, lock)
end

-- Removes the keys whose expiry has passed and tells the driver (Keys.onExpired): their
-- invitations go, and the profiles and the relay's list of keys follow. Returns what was removed
-- ({ id, name }).
local function expire(now)
    now = now or os.time()
    local removed = {}
    for index = #state.keys, 1, -1 do
        local key = state.keys[index]
        if over(key, now) then
            table.remove(state.keys, index)
            state.lastUsed[key.id] = nil
            table.insert(removed, 1, { id = key.id, name = key.name })
        end
    end
    if #removed > 0 then
        save()
        if state.onExpired then
            pcall(state.onExpired, removed)
        end
    end
    return removed
end

-- callback(removed) runs after expired keys were removed.
function Keys.onExpired(callback)
    state.onExpired = callback
end

-- The console's keys from before 1.3.0 (a store before version 4) expire a day from now.
local function expireOldConsoleKeys(now, keys)
    for _, key in ipairs(keys or state.keys) do
        if key.name == CONSOLE_NAME and not key.expires then
            key.expires = now + CONSOLE_SECONDS
        end
    end
end

-- Moves keys from the encrypted store of 0.9.0 and older, when Director can still read it.
-- Returns how that store came back.
local function migrate()
    local old, form = Store.read(OLD_STORE_KEY, true)
    for _, key in ipairs(Store.items(old and old.keys)) do
        if type(key) == "table" and type(key.id) == "string" and type(key.secret) == "string" then
            local hash, alg = hashKey(key.secret)
            if hash then
                addLoaded(key, hash, alg, lockFor(key.secret))
            end
        end
    end
    if save() and old then
        Store.write(OLD_STORE_KEY, { version = 2, keys = Json.array() }, true)
    end
    return form
end

-- Returns the number of keys, how the store came back ("json", "table", "missing",
-- "unreadable") and, when it was missing, how the old encrypted store came back.
function Keys.load()
    state.keys = {}
    state.lastUsed = {}

    local data, form = Store.read(STORE_KEY, false)
    -- A store Director could not read this time may still hold keys: until one is saved again,
    -- the list is not known to be complete (Keys.complete).
    state.complete = form ~= "unreadable"
    local now = os.time()
    if form == "missing" then
        local oldForm = migrate()
        if #state.keys > 0 then
            expireOldConsoleKeys(now)
            save()
        end
        return #state.keys, form, oldForm
    end
    state.keys = Keys.read(data)
    local version = type(data) == "table" and tonumber(data.version) or 0
    if form ~= "unreadable" and version < 4 then
        -- Once, when 1.3.0 first starts: the store is version 4 from then on.
        expireOldConsoleKeys(now)
        save()
    elseif form == "table" then
        -- Written by 0.9.1 as plain JSON, which Director hands back decoded: store it as it is now.
        save()
    end
    -- Keys that expired meanwhile go at the first look at the keys (Keys.onExpired is set by then).
    return #state.keys, form
end

-- The keys of a stored record ({ version, keys }, as the store or a backup holds them), each read
-- as the store's are; the ones that cannot be used are left out. From a store before version 4,
-- the console's keys expire a day from now. Returns them and how many were left out.
function Keys.read(data)
    local keys, dropped = {}, 0
    for _, key in ipairs(Store.items(type(data) == "table" and data.keys or nil)) do
        if type(key) == "table" and type(key.id) == "string" and type(key.hash) == "string" and algorithmNamed(key.alg) then
            keys[#keys + 1] = loaded(key, key.hash, key.alg, key.lock)
        else
            dropped = dropped + 1
        end
    end
    if (type(data) == "table" and tonumber(data.version) or 0) < STORE_VERSION then
        expireOldConsoleKeys(os.time(), keys)
    end
    return keys, dropped
end

local function isLowerHex(value, length)
    return type(value) == "string" and #value == length and value:match("^[0-9a-f]+$") ~= nil
end

-- The keys of a backup (ADR-042), checked as the driver makes keys: an id of 8 hex digits, a role
-- (none is not admin here: only a store from before roles existed had none, and no backup is
-- that old), a hash of the algorithm's length, a lock key of 64 hex digits or none, and a hash no
-- other key has (the same secret would open both). The rest is left out. Returns them and how
-- many were left out.
function Keys.readBackup(data)
    local keys, dropped, hashes = {}, 0, {}
    for _, key in ipairs(Store.items(type(data) == "table" and data.keys or nil)) do
        local algorithm = type(key) == "table" and algorithmNamed(key.alg) or nil
        local lock = algorithm and key.lock
        if algorithm and isLowerHex(key.id, 8) and Roles.valid(key.role) and isLowerHex(key.hash, algorithm.length)
            and not hashes[key.hash] and (lock == nil or lock == Json.null or validLock(lock))
            and (key.expires == nil or key.expires == Json.null or tonumber(key.expires)) then
            hashes[key.hash] = true
            local record = loaded(key, key.hash, key.alg, lock ~= Json.null and lock or nil)
            record.name = type(key.name) == "string" and key.name or "API key"
            record.profile = type(key.profile) == "string" and key.profile:match("^%x+$") and key.profile or nil
            keys[#keys + 1] = record
        else
            dropped = dropped + 1
        end
    end
    if (type(data) == "table" and tonumber(data.version) or 0) < STORE_VERSION then
        expireOldConsoleKeys(os.time(), keys)
    end
    return keys, dropped
end

-- Backups (ADR-042, src/core/backup.lua): the keys as save() stores them: each key's hash and
-- lock key, never a key itself.
function Keys.backup()
    local records = Json.array()
    for _, key in ipairs(state.keys) do
        records[#records + 1] = {
            id = key.id,
            name = key.name,
            role = key.role,
            alg = key.alg,
            hash = key.hash,
            lock = key.lock,
            created_at = key.created_at,
            profile = key.profile,
            expires = key.expires,
        }
    end
    return { version = STORE_VERSION, keys = records }
end

-- Replaces every key with the ones of `data`, read as Keys.read reads them. Returns true once
-- saved; the keys are the new ones either way (a restore that fails puts the old ones back so).
function Keys.restore(data)
    local keys = Keys.read(data)
    local used = {}
    for _, key in ipairs(keys) do
        used[key.id] = state.lastUsed[key.id]
    end
    state.keys, state.lastUsed = keys, used
    return save()
end

function Keys.count()
    expire()
    return #state.keys
end

-- False after a load that could not read the store (the keys may come back at the next start):
-- then nobody may be told that keys are gone.
function Keys.complete()
    return state.complete ~= false
end

-- Returns the key record for a presented secret, or nil (and "KEY_EXPIRED" for a key whose
-- expiry has passed: it is removed now).
function Keys.verify(presented)
    if type(presented) ~= "string" or presented == "" or #presented > MAX_PRESENTED_LENGTH then
        return nil
    end
    local now = os.time()
    local hashes = {}
    local match
    for _, key in ipairs(state.keys) do
        if hashes[key.alg] == nil then
            hashes[key.alg] = digest(algorithmNamed(key.alg), presented) or false
        end
        if hashes[key.alg] and constantTimeEqual(hashes[key.alg], key.hash) then
            match = key
        end
    end
    if match and over(match, now) then
        expire(now)
        return nil, "KEY_EXPIRED"
    end
    if match then
        state.lastUsed[match.id] = Clock.iso()
        -- A key from before remote access gets its lock key the first time it is used here.
        if not match.lock then
            match.lock = lockFor(presented)
            if match.lock then
                save()
            end
        end
    end
    return match
end

-- A key for a remote request: { id, name, role, lock }, or nil when unknown, expired (it is removed
-- now) or without a lock key.
function Keys.remote(id)
    expire()
    for _, key in ipairs(state.keys) do
        if key.id == id and key.lock then
            return { id = key.id, name = key.name, role = key.role, lock = key.lock, profile = key.profile }
        end
    end
    return nil
end

-- Whether a key with this id is kept, without the look at expiry every other read makes (it tells
-- the driver of keys that expired, Keys.onExpired): for what keys made (scene links).
function Keys.exists(id)
    for _, key in ipairs(state.keys) do
        if key.id == id then
            return true
        end
    end
    return false
end

function Keys.touch(id)
    for _, key in ipairs(state.keys) do
        if key.id == id then
            state.lastUsed[id] = Clock.iso()
        end
    end
end

-- Returns the new record (including its secret, which is not kept), or nil plus an error code.
-- `profile`: the id of the profile it belongs to (profiles.lua); `expires` (os.time): when it stops
-- working, nil for never.
function Keys.create(name, role, profile, expires)
    role = role or "member"
    if not Roles.valid(role) then
        return nil, "INVALID_ROLE"
    end
    if #state.keys >= Keys.MAX_KEYS then
        return nil, "KEY_LIMIT_REACHED"
    end

    local ok, idSource, secretA, secretB = pcall(function()
        return randomHex(), randomHex(), randomHex()
    end)
    if not ok then
        return nil, "RANDOM_UNAVAILABLE"
    end

    local id = idSource:sub(1, 8)
    for _, key in ipairs(state.keys) do
        if key.id == id then
            id = idSource:sub(9, 16)
        end
    end

    local secret = "ak_" .. secretA .. secretB:sub(1, 16)
    local hash, alg = hashKey(secret)
    if not hash then
        return nil, "HASH_UNAVAILABLE"
    end

    local record = {
        id = id,
        name = name,
        role = role,
        alg = alg,
        hash = hash,
        lock = lockFor(secret),
        created_at = Clock.iso(),
        profile = profile,
        expires = expires,
    }
    table.insert(state.keys, record)

    if not save() then
        table.remove(state.keys)
        return nil, "PERSIST_FAILED"
    end
    return {
        id = record.id,
        name = record.name,
        role = record.role,
        created_at = record.created_at,
        profile = record.profile,
        expires_at = expires and Clock.iso(expires) or nil,
        secret = secret,
    }
end

function Keys.list()
    expire()
    local items = {}
    for _, key in ipairs(state.keys) do
        items[#items + 1] = {
            id = key.id,
            name = key.name,
            role = key.role,
            created_at = key.created_at,
            last_used_at = state.lastUsed[key.id],
            profile = key.profile,
            expires_at = key.expires and Clock.iso(key.expires) or nil,
        }
    end
    return items
end

function Keys.adminCount()
    expire()
    local count = 0
    for _, key in ipairs(state.keys) do
        if key.role == "admin" then
            count = count + 1
        end
    end
    return count
end

function Keys.find(id)
    expire()
    for _, key in ipairs(state.keys) do
        if key.id == id then
            return {
                id = key.id,
                name = key.name,
                role = key.role,
                created_at = key.created_at,
                last_used_at = state.lastUsed[key.id],
                profile = key.profile,
                expires_at = key.expires and Clock.iso(key.expires) or nil,
            }
        end
    end
    return nil
end

-- Changes a key's name and/or role. Returns the updated record, or nil plus an error code. An
-- expired key is gone first: it is not found, and it is no admin that another could leave to.
function Keys.update(id, changes)
    expire()
    for _, key in ipairs(state.keys) do
        if key.id == id then
            if changes.role and not Roles.valid(changes.role) then
                return nil, "INVALID_ROLE"
            end
            if changes.role and key.role == "admin" and changes.role ~= "admin" and Keys.adminCount() == 1 then
                return nil, "LAST_ADMIN"
            end
            local previous = { name = key.name, role = key.role, profile = key.profile }
            key.name = changes.name or key.name
            key.role = changes.role or key.role
            key.profile = changes.profile or key.profile
            if not save() then
                key.name, key.role, key.profile = previous.name, previous.role, previous.profile
                return nil, "PERSIST_FAILED"
            end
            return Keys.find(id)
        end
    end
    return nil, "NOT_FOUND"
end

function Keys.revoke(id)
    for index, key in ipairs(state.keys) do
        if key.id == id then
            table.remove(state.keys, index)
            state.lastUsed[id] = nil
            save()
            return true
        end
    end
    return false
end

function Keys.revokeAll()
    local count = #state.keys
    state.keys = {}
    state.lastUsed = {}
    save()
    return count
end

return Keys
