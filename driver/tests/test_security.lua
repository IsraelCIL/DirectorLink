-- Security of the home network (docs/ACCOUNTS.md): pairing with a key exchange, so the new key is
-- never sent in the clear; sealed requests at home, so the key never crosses the network again;
-- and random values that do not depend on Director's UUIDs alone.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")

local tests = {}

local function hex(data)
    return (data:gsub(".", function(char)
        return string.format("%02x", char:byte())
    end))
end

local function modules()
    return require("src.core.base64"), require("src.cloud.lock"), require("src.core.x25519")
end

-- Pairs like the app: with the public half of a key exchange. Returns the opened answer.
local function sealedPair(mock)
    local Base64, Lock, X25519 = modules()
    ExecuteCommand("LUA_ACTION", { ACTION = "NEW_PAIRING_CODE" })
    local code = mock.properties["Pairing Code"]:gsub(" ", "")
    local private = string.rep(string.char(7), 31) .. string.char(42)
    local public = Base64.encode(X25519.publicKey(private))
    local response = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = code, name = "Chrome", exchange = { public_key = public } } })
    T.eq(response.status, 201, response.body)
    local driverPublic = response.json.exchange.public_key
    local shared = X25519.shared(private, Base64.decode(driverPublic))
    local lockKey = Lock.pairingKey(hex(shared), code, public, driverPublic)
    local plaintext = Lock.open(lockKey, response.json.sealed, "res")
    T.truthy(plaintext, "the answer opens with the exchanged key")
    return Json.decode(plaintext), response
end

function tests.pairing_with_a_key_exchange_never_sends_the_key_in_the_clear()
    local mock = Mock.startDriver()
    local created, response = sealedPair(mock)
    T.truthy(created.key and created.key:match("^ak_%x+$"), "a key")
    T.notContains(response.body, created.key, "the key is not readable on the network")
    T.eq(T.http(mock, "GET", "/v1/system", { key = created.key }).status, 200, "and it works")
    T.eq(created.role, "admin")
end

function tests.a_bad_exchange_key_is_refused_before_the_code_is_used()
    local mock = Mock.startDriver()
    local Base64 = modules()
    local code = mock.properties["Pairing Code"]
    local short = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = code, exchange = { public_key = "AAAA" } } })
    T.eq(short.status, 400)
    local zero = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = code, exchange = { public_key = string.rep("A", 43) .. "=" } } })
    T.eq(zero.status, 400, "a public key that gives no shared secret")
    -- A point of small order, with the top bit set (the same point to X25519).
    local small = Base64.encode(Base64.fromHex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b880"))
    local order = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = code, exchange = { public_key = small } } })
    T.eq(order.status, 400)
    T.eq(order.json.errors[1].field, "exchange.public_key")
    T.eq(mock.properties["API Keys"], "0", "no key was made")
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = code, name = "Script" } }).status, 201, "and the code still works")
end

function tests.a_controller_that_cannot_seal_pairs_without_the_exchange_and_keeps_the_code()
    local mock = Mock.startDriver(nil, nil, nil, function()
        function C4:Encrypt()
            return nil
        end
    end)
    local Base64, _, X25519 = modules()
    local code = mock.properties["Pairing Code"]
    local public = Base64.encode(X25519.publicKey(string.rep(string.char(9), 32)))
    local refused = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = code, exchange = { public_key = public } } })
    T.eq(refused.status, 400)
    T.eq(refused.json.errors[1].field, "exchange", "the app then pairs without it")
    T.eq(T.http(mock, "GET", "/v1/sealed").json.code, "LOCK_UNAVAILABLE")
    local created = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = code, name = "Chrome" } })
    T.eq(created.status, 201, "the code was not used up")
    T.eq(T.http(mock, "POST", "/v1/sealed", { body = { envelope = { v = 1, home = "lan", key = created.json.id, iv = "", ct = "", mac = "" } } }).json.code, "LOCK_UNAVAILABLE")
end

-- A sealed request at home: POST /v1/sealed with the device's lock key, no Authorization header.
local function sealed(mock, key, keyId, request)
    local _, Lock = modules()
    local info = T.http(mock, "GET", "/v1/sealed").json
    local lock = Lock.deviceKey(key)
    request.id = request.id or ("r" .. tostring(math.random(1, 1e9)))
    request.ts = request.ts or info.time
    local envelope = Lock.seal(lock, info.home, keyId, "req", Json.encode(request))
    local response = T.http(mock, "POST", "/v1/sealed", { body = { envelope = envelope } })
    if response.status ~= 200 then
        return nil, response, envelope
    end
    return Json.decode(Lock.open(lock, response.json.envelope, "res")), response, envelope
end

function tests.sealed_requests_at_home_run_as_their_key_and_answer_sealed()
    local mock = Mock.startDriver()
    local created = sealedPair(mock)
    local info = T.http(mock, "GET", "/v1/sealed").json
    T.eq(info.home, "lan", "envelopes at home name the home \"lan\"")
    T.eq(info.home_id, nil, "the remote-access home id is not given out without a key")
    T.truthy(type(info.time) == "number")
    T.eq(mock.persist.directorlink_remote_identity, nil, "and no remote identity is made for it")
    local answer, response = sealed(mock, created.key, created.id, { method = "GET", path = "/v1/lights" })
    T.eq(answer.status, 200)
    T.truthy(Json.decode(answer.body).items[1], "the lights, inside the sealed answer")
    T.notContains(response.body, "Kitchen Island", "nothing readable on the network")

    local command = sealed(mock, created.key, created.id, { method = "PATCH", path = "/v1/lights/20", body = { on = true } })
    T.eq(command.status, 202)
    local _, first, envelope = sealed(mock, created.key, created.id, { method = "GET", path = "/v1/system", id = "once" })
    T.eq(first.status, 200)
    local again = T.http(mock, "POST", "/v1/sealed", { body = { envelope = envelope } })
    T.eq(again.json.code, "REPLAYED", "an envelope works once")
    local _, stale = sealed(mock, created.key, created.id, { method = "GET", path = "/v1/system", ts = os.time() - 600 })
    T.eq(stale.json.code, "STALE")
    T.truthy(type(stale.json.time) == "number", "the controller's time, to set the clock right")
    local _, unknown = sealed(mock, created.key, "deadbeef", { method = "GET", path = "/v1/system" })
    T.eq(unknown.status, 401)
    T.eq(unknown.json.code, "UNKNOWN_KEY")
    local pair = sealed(mock, created.key, created.id, { method = "POST", path = "/v1/auth/pair", body = { pairing_code = "12345678" } })
    T.eq(pair.status, 403, "pairing is never sealed")

    -- An envelope for the relay's home id is not one for the home network.
    local _, Lock = modules()
    local lock = Lock.deviceKey(created.key)
    local remoteOne = Lock.seal(lock, string.rep("a", 32), created.id, "req", Json.encode({ id = "x1", ts = info.time, method = "GET", path = "/v1/system" }))
    T.eq(T.http(mock, "POST", "/v1/sealed", { body = { envelope = remoteOne } }).json.code, "BAD_ENVELOPE")
    -- And a sealed request cannot carry another one.
    local inner = Lock.seal(lock, "lan", created.id, "req", Json.encode({ id = "x2", ts = info.time, method = "GET", path = "/v1/system" }))
    local nested = sealed(mock, created.key, created.id, { method = "POST", path = "/v1/sealed", body = { envelope = inner } })
    T.eq(nested.status, 400)
    T.eq(Json.decode(nested.body).code, "BAD_REQUEST")
end

function tests.a_viewer_key_sealed_at_home_keeps_its_role()
    local mock = Mock.startDriver()
    local admin = sealedPair(mock)
    local viewer = T.http(mock, "POST", "/v1/api-keys", { key = admin.key, body = { name = "Guest", role = "viewer" } }).json
    local answer = sealed(mock, viewer.key, viewer.id, { method = "PATCH", path = "/v1/lights/20", body = { on = true } })
    T.eq(answer.status, 404, "a viewer of 1.7.0 has no rooms (ADR-054): the light is not theirs")
    T.eq(sealed(mock, viewer.key, viewer.id, { method = "GET", path = "/v1/api-keys" }).status, 403)
end

-- The app seals the room order at home too (PUT /v1/rooms/order, refused as a method since 1.0.0).
function tests.the_room_order_is_set_sealed_at_home_by_admins_only()
    local mock = Mock.startDriver()
    local admin = sealedPair(mock)
    local answer = sealed(mock, admin.key, admin.id, { method = "PUT", path = "/v1/rooms/order", body = { room_ids = { 11, 10 } } })
    T.eq(answer.status, 200, answer.body)
    local items = Json.decode(answer.body).items
    T.eq(items[1].id, 11)
    T.eq(items[2].id, 10)

    local member = T.http(mock, "POST", "/v1/api-keys", { key = admin.key, body = { name = "Phone", role = "member" } }).json
    local refused = sealed(mock, member.key, member.id, { method = "PUT", path = "/v1/rooms/order", body = { room_ids = { 10, 11 } } })
    T.eq(refused.status, 403)
    T.eq(Json.decode(refused.body).code, "FORBIDDEN")
    T.eq(T.http(mock, "GET", "/v1/rooms", { key = admin.key }).json.items[1].id, 11, "the order stays")
end

-- Sealed at home, a relay is held closed only with Relay Hold allowed, as without the seal (1.1.1).
function tests.a_sealed_request_at_home_holds_a_relay_closed_only_with_relay_hold()
    local mock = Mock.startDriver()
    local admin = sealedPair(mock)
    Properties["Door Control"] = "Enabled"
    local function send(method, path, body)
        return sealed(mock, admin.key, admin.id, { method = method, path = path, body = body })
    end
    local before = #mock.commands
    local refused = send("PATCH", "/v1/relays/70", { state = "closed" })
    T.eq(refused.status, 409)
    T.eq(Json.decode(refused.body).code, "HOLD_NOT_ALLOWED")
    T.eq(#mock.commands, before, "nothing reaches the relay")
    T.eq(send("PATCH", "/v1/relays/70", { state = "open" }).status, 202)
    T.eq(mock.commands[#mock.commands].command, "Open Relay")
    T.eq(send("POST", "/v1/relays/70/pulse").status, 202)
    T.eq(mock.commands[#mock.commands].command, "Close Relay")
    local pulse = mock.timers[#mock.timers]
    T.eq(pulse.delay, 500)
    pulse.callback()
    T.eq(mock.commands[#mock.commands].command, "Open Relay", "released after the pulse")

    Properties["Relay Hold"] = "Allowed"
    OnPropertyChanged("Relay Hold")
    T.eq(send("PATCH", "/v1/relays/70", { state = "closed" }).status, 202)
    T.eq(mock.commands[#mock.commands].command, "Close Relay", "held")
end

function tests.secrets_differ_even_if_directors_uuids_do_not()
    local mock = Mock.startDriver()
    function C4:UUID()
        return "00000000-0000-4000-8000-000000000000"
    end
    local Random = require("src.core.random")
    local seen = {}
    for _ = 1, 50 do
        local value = Random.hex(64)
        T.truthy(not seen[value], "no value repeats")
        seen[value] = true
    end
    T.truthy(mock.persist.directorlink_entropy, "the pool is kept across restarts")
end

-- On a 32-bit controller C's unsigned long has 32 bits, and Lua 5.1's tonumber(hex, 16) caps
-- every number above it at 4294967295: up to 1.11.0 every pairing code there was 9496 7295.
function tests.pairing_codes_vary_where_tonumber_caps_hex_at_32_bits()
    Mock.startDriver()
    local Random = require("src.core.random")
    local realToNumber = tonumber
    tonumber = function(value, base)
        local number = realToNumber(value, base)
        if base == 16 and number and number > 4294967295 then
            return 4294967295
        end
        return number
    end
    local ok, failure = pcall(function()
        local seen, count = {}, 0
        for _ = 1, 40 do
            local value = Random.below(100000000)
            T.truthy(value >= 0 and value < 100000000 and value % 1 == 0, "a whole number below the limit")
            if not seen[value] then
                seen[value], count = true, count + 1
            end
        end
        T.truthy(count >= 39, "pairing codes differ: " .. count .. " of 40")
    end)
    tonumber = realToNumber
    if not ok then
        error(failure, 0)
    end
end

function tests.random_below_stays_below_small_and_large_limits()
    Mock.startDriver()
    local Random = require("src.core.random")
    local hits = {}
    for _ = 1, 300 do
        local value = Random.below(3)
        T.truthy(value == 0 or value == 1 or value == 2)
        hits[value] = true
    end
    T.truthy(hits[0] and hits[1] and hits[2], "every value comes up")
    for _ = 1, 20 do
        local value = Random.below(2 ^ 40)
        T.truthy(value >= 0 and value < 2 ^ 40 and value % 1 == 0)
    end
end

return tests
