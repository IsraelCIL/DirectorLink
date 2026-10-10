-- Random values for secrets (API keys, the home secret, invitation secrets, claim tokens, pairing
-- codes, lock IVs, key exchange keys). Director's C4:UUID("RANDOM") is the source, but how Director
-- makes it is not documented, so it is never used alone: every output is a SHA-256 over a pool
-- that keeps what it has seen (earlier outputs' state, the arrival times of requests, the clock,
-- and /dev/urandom where the sandbox lets the driver read it) together with fresh UUIDs. The pool
-- changes after every output, so one weak source is not enough to predict a secret. What is kept
-- across restarts is a hash of the pool, never the pool itself: a copy of the driver's data does
-- not tell the outputs that follow it.

local Clock = require("src.core.clock")
local Store = require("src.core.store")

local Random = {}

local POOL_KEY = "directorlink_entropy"
-- Saved at most this often (sealed answers each take an IV from the pool: a camera shown live
-- would otherwise write to the controller's storage every few seconds).
local SAVE_SECONDS = 600

local state = { pool = nil, counter = 0, unsaved = 0, savedAt = 0, algorithm = nil }

local function detect()
    state.algorithm = nil
    for _, name in ipairs({ "SHA256", "SHA1" }) do
        local ok, value = pcall(function()
            return C4:Hash(name, "directorlink", { return_encoding = "HEX" })
        end)
        if ok and type(value) == "string" and #value >= 40 then
            state.algorithm = name
            return
        end
    end
end

-- SHA-256, or SHA-1 on a controller without it (like the key hashes, src/auth/keys.lua).
local function hash(data)
    for _ = 1, 2 do
        if not state.algorithm then
            detect()
        end
        local ok, value = pcall(function()
            return C4:Hash(state.algorithm or "SHA256", data, { return_encoding = "HEX" })
        end)
        if ok and type(value) == "string" and #value >= 40 then
            return value:lower()
        end
        state.algorithm = nil
    end
    error("hashing failed", 0)
end

local function urandom()
    local ok, bytes = pcall(function()
        if type(io) ~= "table" or type(io.open) ~= "function" then
            return nil
        end
        local file = io.open("/dev/urandom", "rb")
        if not file then
            return nil
        end
        local data = file:read(32)
        file:close()
        return data
    end)
    if ok and type(bytes) == "string" and #bytes > 0 then
        return (bytes:gsub(".", function(char)
            return string.format("%02x", char:byte())
        end))
    end
    return ""
end

-- Everything that may be unpredictable, now.
local function sources()
    return table.concat({
        tostring(C4:UUID("RANDOM")),
        tostring(C4:UUID("RANDOM")),
        tostring(os.time()),
        tostring(os.clock()),
        tostring(Clock.millis()),
        tostring(state.counter),
        tostring({}),
        urandom(),
    }, "|")
end

local function save()
    state.unsaved = 0
    state.savedAt = os.time()
    Store.write(POOL_KEY, { version = 2, pool = hash("seed|" .. state.pool) }, false)
end

local function ensure()
    if state.pool then
        return
    end
    local saved = Store.read(POOL_KEY, false)
    local previous = type(saved) == "table" and type(saved.pool) == "string" and saved.pool or ""
    state.pool = hash("pool|" .. previous .. "|" .. sources())
    save()
end

-- Mixes something observed (a request's arrival time, a client's port) into the pool.
function Random.stir(data)
    ensure()
    state.pool = hash(state.pool .. "|stir|" .. tostring(data) .. "|" .. tostring(Clock.millis()))
end

-- `length` random hex characters.
function Random.hex(length)
    ensure()
    local out = ""
    while #out < length do
        state.counter = state.counter + 1
        out = out .. hash(state.pool .. "|out|" .. state.counter .. "|" .. sources())
    end
    -- The pool moves on: an output never tells what the next one is.
    state.pool = hash(state.pool .. "|next|" .. state.counter .. "|" .. sources())
    state.unsaved = state.unsaved + 1
    if os.time() - state.savedAt >= SAVE_SECONDS then
        save()
    end
    return out:sub(1, length)
end

-- `count` random bytes, as a string.
function Random.bytes(count)
    return (Random.hex(count * 2):gsub("%x%x", function(pair)
        return string.char(tonumber(pair, 16))
    end))
end

-- A random integer from 0 to `limit` - 1 (limit up to 2^40). From 48 random bits added up byte by
-- byte: up to 1.11.0 it read 52 bits with tonumber(hex, 16), which a Lua whose C unsigned long has
-- 32 bits (32-bit controllers) caps at 4294967295, so every pairing code there was 9496 7295.
-- A draw past the last whole multiple of `limit` is drawn again: no modulo bias.
local SPAN = 2 ^ 48
function Random.below(limit)
    local cutoff = SPAN - SPAN % limit
    while true do
        local bytes, value = Random.bytes(6), 0
        for index = 1, 6 do
            value = value * 256 + bytes:byte(index)
        end
        if value < cutoff then
            return value % limit
        end
    end
end

-- Forgets the pool in memory (tests: a new driver instance).
function Random.reset()
    state.pool, state.counter, state.unsaved, state.savedAt = nil, 0, 0, 0
end

return Random
