-- Remote access with accounts (docs/ACCOUNTS.md): what the relay passes on for signed-in devices,
-- always sealed with the lock (lock.lua). The relay only routes: it sees which key or invitation an
-- envelope is for, never what is inside. Three messages arrive:
--   e2e    a device's sealed API request; run as that device's key and role, the answer sealed back
--   join   a sealed request from someone opening an invitation link; answered with their new key
--   claim  the cloud checks a claim token, which proves that whoever claims this home holds an
--          admin key here on the home network
-- And one that is not sealed (1.7.0, ADR-051):
--   link   a scene's link, run from a phone's automation: the link's id and secret, checked against
--          the hash kept here (src/api/handlers/scene_links.lua); answered with how it went
-- Problems the relay has to know about (unknown key, broken seal, replay) are sent in the clear as
-- a `code`; they reveal nothing about the home. Remote.handleLocal opens requests sealed the same
-- way on the home network (POST /v1/sealed, naming the home "lan").

local Json = require("src.core.json")
local Random = require("src.core.random")
local Http = require("src.api.http")
local Clock = require("src.core.clock")
local Lock = require("src.cloud.lock")
local Store = require("src.core.store")
local Activity = require("src.core.activity")
local SceneLinkHandlers = require("src.api.handlers.scene_links")

local Remote = {}

Remote.CLAIM_SECONDS = 300
Remote.MAX_REQUEST_BYTES = 64 * 1024
-- The home that sealed requests on the home network name (POST /v1/sealed): not the relay's home
-- id, which is not given out without a key, and never valid through the relay.
Remote.LAN_HOME = "lan"

-- Every method routes.lua uses: the app seals all its requests, at home too, so a method left out
-- here fails everywhere (PUT /v1/rooms/order did, 1.0.0). scripts/check_package.py checks it.
local METHODS = { GET = true, POST = true, PUT = true, PATCH = true, DELETE = true }
local JOIN_PATH = "/v1/auth/join"
-- Requests dated ahead of this controller's clock could still be inside the window after a restart;
-- their ids are kept in persistence until the window has passed.
local SEEN_KEY = "directorlink_remote_seen"
local MAX_SAVED = 500

local state = {
    available = false,
    startedAt = 0,
    seen = {},
    saved = {},
    claim = nil,
    services = nil,
    handleRequest = nil,
    homeId = nil,
}

local function log(level, message, data)
    if state.services and state.services.log then
        state.services.log.write(level, "remote", message, data)
    end
end

local function randomHex(length)
    return Random.hex(length)
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

-- options: { services, handleRequest = Server.handleRequest, homeId = function() return id end }
function Remote.init(options)
    state.services = options.services
    state.handleRequest = options.handleRequest
    state.homeId = options.homeId
    state.seen = {}
    state.claim = nil
    -- Request ids are remembered in memory: anything sealed before this start is refused, so a
    -- request captured before a restart cannot be replayed after it. Requests dated after this start
    -- that were accepted before it (a device clock ahead of the controller's) were saved.
    state.startedAt = Clock.now()
    state.saved = {}
    local stored = Store.read(SEEN_KEY, false)
    for _, item in ipairs(Store.items(type(stored) == "table" and stored.items or nil)) do
        if type(item) == "table" and type(item.k) == "string" and type(item.i) == "string" and type(item.t) == "number"
            and item.t >= state.startedAt - Lock.WINDOW_SECONDS then
            state.saved[#state.saved + 1] = { k = item.k, i = item.i, t = item.t }
            state.seen[item.k] = state.seen[item.k] or {}
            state.seen[item.k][item.i] = state.startedAt
        end
    end
    local ok, step = Lock.selfTest()
    state.available = ok
    if ok then
        log("info", "lock self-test passed")
    else
        log("error", "lock self-test failed; remote requests are refused", { step = step })
    end
    return ok, step
end

function Remote.available()
    return state.available
end

-- A claim token for the home's owner to hand to the cloud: works once, for 5 minutes, and only
-- while `keyId`, the admin key that asked for it, is still an admin key.
function Remote.createClaim(keyId)
    state.claim = { token = randomHex(48), expires = Clock.now() + Remote.CLAIM_SECONDS, by = keyId }
    return { claim_token = state.claim.token, expires_at = Clock.iso(state.claim.expires) }
end

function Remote.clearClaim()
    state.claim = nil
end

local function useClaim(token)
    local claim = state.claim
    if not claim or Clock.now() > claim.expires or not sameText(token, claim.token) then
        return false
    end
    state.claim = nil
    local owner = type(claim.by) == "string" and state.services.keys.find(claim.by) or nil
    return owner ~= nil and owner.role == "admin"
end

-- Saves an accepted request dated ahead of this controller's clock (see SEEN_KEY).
local function remember(keyId, requestId, ts, now)
    local kept = {}
    for _, item in ipairs(state.saved) do
        if item.t >= now - Lock.WINDOW_SECONDS then
            kept[#kept + 1] = item
        end
    end
    kept[#kept + 1] = { k = keyId, i = requestId, t = ts }
    while #kept > MAX_SAVED do
        table.remove(kept, 1)
    end
    state.saved = kept
    if not Store.write(SEEN_KEY, { version = 1, items = kept }, false) then
        log("warn", "could not save a request id")
    end
end

-- A request id is accepted once, and only within the lock's window of this controller's clock.
local function fresh(keyId, requestId, ts)
    local now = Clock.now()
    -- The controller's clock was set back after the start: whatever is sealed from now on is newer.
    if now < state.startedAt then
        state.startedAt = now
    end
    if type(ts) ~= "number" or math.abs(now - ts) > Lock.WINDOW_SECONDS or ts < state.startedAt then
        return false, "STALE"
    end
    if type(requestId) ~= "string" or not requestId:match("^[%w_-]+$") or #requestId > 64 then
        return false, "BAD_REQUEST"
    end
    local seen = state.seen[keyId] or {}
    for id, at in pairs(seen) do
        if now - at > Lock.REMEMBER_SECONDS then
            seen[id] = nil
        end
    end
    if seen[requestId] then
        return false, "REPLAYED"
    end
    seen[requestId] = now
    state.seen[keyId] = seen
    if ts > now then
        remember(keyId, requestId, ts, now)
    end
    return true
end

local function isText(contentType)
    local value = string.lower(tostring(contentType or ""))
    return value == "" or value:find("json", 1, true) ~= nil or value:find("^text/") ~= nil
end

local function headerValue(headers, name)
    for _, header in ipairs(headers or {}) do
        if string.lower(header[1]) == name then
            return header[2]
        end
    end
    return nil
end

local function problemJson(status, code, detail)
    return Json.encode({ type = "about:blank", status = status, code = code, detail = detail })
end

-- Opens `envelope` with `lockKey` and checks it is a fresh request. Returns the request, or nil
-- and a code.
local function openRequest(lockKey, envelope, keyId, home)
    if type(envelope) ~= "table" or envelope.key ~= keyId or envelope.home ~= home then
        return nil, "BAD_ENVELOPE"
    end
    if type(envelope.ct) == "string" and #envelope.ct > Remote.MAX_REQUEST_BYTES * 2 then
        return nil, "TOO_LARGE"
    end
    local plaintext, code = Lock.open(lockKey, envelope, "req")
    if not plaintext then
        return nil, code
    end
    local request = Json.decode(plaintext)
    if type(request) ~= "table" then
        return nil, "BAD_REQUEST"
    end
    local ok, freshCode = fresh(keyId, request.id, request.ts)
    if not ok then
        return nil, freshCode
    end
    return request
end

-- Seals an answer to `request` for `keyId`.
local function sealAnswer(lockKey, home, keyId, request, status, contentType, body)
    local answer = { id = request.id, ts = Clock.now(), status = status, content_type = contentType or "" }
    if isText(contentType) then
        answer.body = body or ""
    else
        answer.body_base64 = C4:Base64Encode(body or ""):gsub("%s+", "")
    end
    return Lock.seal(lockKey, home, keyId, "res", Json.encode(answer))
end

-- Runs an API request as `principal` through the same code as LAN requests; done(status, headers,
-- body) is called once, now or later (camera pictures). `client`: where it came from.
local function run(request, principal, done, client)
    local method = string.upper(tostring(request.method or "GET"))
    local path, query = tostring(request.path or ""):match("^([^?]*)%??(.*)$")
    if not METHODS[method] or not path or path:sub(1, 4) ~= "/v1/" then
        done(400, { { "Content-Type", "application/problem+json" } }, problemJson(400, "BAD_REQUEST", "Remote requests are GET, POST, PUT, PATCH or DELETE on /v1/..."))
        return
    end
    -- A sealed request inside a sealed request would run as one from the home network.
    if path:gsub("/+$", "") == "/v1/sealed" then
        done(400, { { "Content-Type", "application/problem+json" } }, problemJson(400, "BAD_REQUEST", "A sealed request cannot carry another sealed request"))
        return
    end
    local hasBody = request.body ~= nil and request.body ~= Json.null
    local apiRequest = {
        method = method,
        path = path,
        query = Http.parseQuery(query or ""),
        headers = hasBody and { ["content-type"] = "application/json" } or {},
        body = hasBody and Json.encode(request.body) or "",
        principal = principal,
    }
    local status, headers, body = state.handleRequest(apiRequest, client or { ip = "relay", port = "0" }, done)
    if status then
        done(status, headers, body)
    end
end

local function handleE2e(message, send)
    local keyId = type(message.envelope) == "table" and message.envelope.key or nil
    local key = type(keyId) == "string" and state.services.keys.remote(keyId) or nil
    if not key then
        send({ type = "e2e", id = message.id, code = "UNKNOWN_KEY" })
        return
    end
    local home = state.homeId()
    local request, code = openRequest(key.lock, message.envelope, keyId, home)
    if not request then
        log("warn", "refused a remote request", { key_id = keyId, code = code })
        send({ type = "e2e", id = message.id, code = code })
        return
    end
    state.services.keys.touch(keyId)
    local answered = false
    run(request, { id = key.id, name = key.name, role = key.role, remote = true }, function(status, headers, body)
        if answered then
            return
        end
        answered = true
        local envelope = sealAnswer(key.lock, home, keyId, request, status, headerValue(headers, "content-type"), body)
        send({ type = "e2e", id = message.id, envelope = envelope })
    end)
end

-- A sealed request that came on the home network (POST /v1/sealed): opened and checked exactly
-- like one through the account; done(envelope) with the sealed answer, or done(nil, code).
function Remote.handleLocal(envelope, client, done)
    if not state.available then
        done(nil, "LOCK_UNAVAILABLE")
        return
    end
    local keyId = type(envelope) == "table" and envelope.key or nil
    local key = type(keyId) == "string" and state.services.keys.remote(keyId) or nil
    if not key then
        done(nil, "UNKNOWN_KEY")
        return
    end
    local request, code = openRequest(key.lock, envelope, keyId, Remote.LAN_HOME)
    if not request then
        log("warn", "refused a sealed request on the home network", { key_id = keyId, code = code })
        done(nil, code)
        return
    end
    state.services.keys.touch(keyId)
    local answered = false
    run(request, { id = key.id, name = key.name, role = key.role, remote = false, sealed = true }, function(status, headers, body)
        if answered then
            return
        end
        answered = true
        done(sealAnswer(key.lock, Remote.LAN_HOME, keyId, request, status, headerValue(headers, "content-type"), body))
    end, client)
end

-- The home id sealed requests name, and how far their clock may be off.
function Remote.homeId()
    return state.homeId and state.homeId() or nil
end

function Remote.windowSeconds()
    return Lock.WINDOW_SECONDS
end

local function handleJoin(message, send)
    local invitationId = message.invitation
    -- Keys that expired go first, and the invitations they made with them (ADR-040).
    state.services.keys.count()
    local invitation = type(invitationId) == "string" and state.services.invitations.find(invitationId) or nil
    if not invitation then
        send({ type = "join_result", id = message.id, ok = false, code = "INVITATION_NOT_FOUND" })
        return
    end
    local request, code = openRequest(invitation.lock, message.envelope, invitationId, state.homeId())
    if not request then
        log("warn", "refused an invitation", { invitation = invitationId, code = code })
        send({ type = "join_result", id = message.id, ok = false, code = code })
        return
    end
    if string.upper(tostring(request.method)) ~= "POST" or request.path ~= JOIN_PATH then
        send({ type = "join_result", id = message.id, ok = false, code = "BAD_REQUEST" })
        return
    end
    local name = type(request.body) == "table" and type(request.body.name) == "string" and request.body.name or "Invited device"
    name = name:gsub("[%c]", ""):sub(1, 64)
    if name == "" then
        name = "Invited device"
    end
    -- The inviter's own other device joins the inviter's profile; anyone else gets a new one.
    local profiles = state.services.profiles
    local profile = profiles and invitation.profile and profiles.find(invitation.profile)
    if profiles and not profile then
        profile = profiles.create(name)
    end
    local record, failure = state.services.keys.create(name, invitation.role, profile and profile.id or nil)
    if not record and profiles then
        profiles.prune(state.services.keys.list())
    end
    if not record then
        send({ type = "join_result", id = message.id, ok = false, code = failure or "KEY_NOT_CREATED" })
        return
    end
    state.services.invitations.consume(invitationId)
    if state.services.onKeysChanged then
        pcall(state.services.onKeysChanged)
    end
    log("info", "an invitation was accepted", { invitation = invitationId, key_id = record.id, role = record.role })
    Activity.record("access", "joined", { by = record.id, what = record.name, to = record.role, ids = { key_id = record.id, invitation_id = invitationId } })
    local body = Json.encode({ key = record.secret, id = record.id, name = record.name, role = record.role, created_at = record.created_at })
    local envelope = sealAnswer(invitation.lock, state.homeId(), invitationId, request, 201, "application/json; charset=utf-8", body)
    send({ type = "join_result", id = message.id, ok = true, key_id = record.id, envelope = envelope })
end

local function handleClaim(message, send)
    local ok = useClaim(message.token)
    log(ok and "info" or "warn", ok and "the home was claimed for an account" or "refused a claim")
    send({ type = "claim_result", id = message.id, ok = ok, code = (not ok) and "INVALID_CLAIM" or nil })
end

-- True when `message` was one of the account messages (handled, or refused with a code).
function Remote.handle(message, send)
    local kind = message.type
    if kind ~= "e2e" and kind ~= "join" and kind ~= "claim" and kind ~= "link" then
        return false
    end
    if type(message.id) ~= "string" or message.id == "" then
        return true
    end
    if kind == "link" then
        local ok, err = pcall(SceneLinkHandlers.relayRun, state.services, message, send)
        if not ok then
            log("error", "scene link run failed", { error = tostring(err) })
            send({ type = "link_result", id = message.id, ok = false, code = "INTERNAL" })
        end
        return true
    end
    if kind == "claim" then
        handleClaim(message, send)
        return true
    end
    if not state.available then
        send({ type = kind == "join" and "join_result" or "e2e", id = message.id, ok = false, code = "LOCK_UNAVAILABLE" })
        return true
    end
    local ok, err = pcall(kind == "e2e" and handleE2e or handleJoin, message, send)
    if not ok then
        log("error", "remote request failed", { type = kind, error = tostring(err) })
        send({ type = kind == "join" and "join_result" or "e2e", id = message.id, ok = false, code = "INTERNAL" })
    end
    return true
end

return Remote
