local Json = require("src.core.json")
local Clock = require("src.core.clock")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local Views = require("src.api.views")
local Roles = require("src.auth.roles")
local Base64 = require("src.core.base64")
local Lock = require("src.cloud.lock")
local Random = require("src.core.random")
local X25519 = require("src.core.x25519")
local CpacePairing = require("src.auth.cpace_pairing")
local Keys = require("src.auth.keys")
local Activity = require("src.core.activity")
local Access = require("src.auth.access")
local People = require("src.auth.people")
local Scenes = require("src.core.scenes")
local ProfileHandlers = require("src.api.handlers.profiles")
local UserHandlers = require("src.api.handlers.users")
local Users = require("src.auth.users")

local Auth = {}

local function keyLimitProblem(keys)
    return Problem.new(409, "KEY_LIMIT_REACHED",
        "The bridge already has " .. keys.MAX_KEYS .. " API keys; revoke one first")
end

local function roleProblem()
    return Problem.invalidField("role", "role must be one of " .. Roles.list())
end

-- `profileId`: the profile (user) the key joins, whose permissions it has, while they have fewer
-- than five devices (1.9.0, ADR-061: 409 USER_DEVICE_LIMIT); without one, it gets a new user of its
-- own, named `userName` or after the key: `person` (src/auth/people.lua), else what the 1.7.0
-- `role` becomes (ADR-054). The key keeps its person's 1.7.0 role. `expiresAt` (os.time): when the
-- key stops working (ADR-040); nil for never.
local function createKey(ctx, name, role, profileId, expiresAt, person, userName)
    local keys = ctx.services.keys
    local profiles = ctx.services.profiles
    if profileId and Users.full(profileId) then
        return nil, UserHandlers.limitProblem(ctx, profileId)
    end
    if not profileId and profiles then
        local profile, profileFailure = profiles.create(userName or name)
        if profileFailure == "UNAVAILABLE" then
            return nil, Problem.new(503, "UNAVAILABLE", "The people's profiles could not be read when DirectorLink started; restart the driver and try again")
        elseif not profile then
            return nil, Problem.new(409, profileFailure, "This controller has as many profiles as it allows")
        end
        profileId = profile.id
        person = person or People.fromLegacy(role, Scenes.list())
    else
        person = nil
    end
    local theirs = profileId and People.peek(profileId)
    role = People.legacyRole(person or theirs) or role
    local record, failure = keys.create(name, role, profileId, expiresAt)
    if not record and profiles then
        profiles.prune(keys.list())
    end
    if not record then
        if failure == "KEY_LIMIT_REACHED" then
            return nil, keyLimitProblem(keys)
        end
        return nil, Problem.internal("The API key could not be created (" .. tostring(failure) .. ")")
    end
    -- A member whose person could not be kept would answer as the 1.7.0 role, which may be more
    -- than they were given (every room): the key goes again. An admin is an admin either way.
    if person and not People.set(profileId, person) and person.role ~= "admin" then
        keys.revoke(record.id)
        if profiles then
            profiles.prune(keys.list())
        end
        if not People.complete() then
            return nil, Problem.new(503, "UNAVAILABLE", "The people's permissions could not be read when DirectorLink started; restart the driver and try again")
        end
        return nil, Problem.internal("The new person's permissions could not be saved, so no key was made")
    end
    return record
end

-- A key asked for with expires_in (ADR-040; the console asks for a day) lasts from 60 seconds to
-- 30 days.
Auth.EXPIRES_IN_MIN = 60
Auth.EXPIRES_IN_MAX = Keys.LONGEST_LIFE

local function expiresIn(value)
    if value == nil then
        return nil
    end
    if type(value) ~= "number" or value % 1 ~= 0 or value < Auth.EXPIRES_IN_MIN or value > Auth.EXPIRES_IN_MAX then
        return nil, Problem.invalidField("expires_in", "expires_in must be a whole number of seconds from "
            .. Auth.EXPIRES_IN_MIN .. " to " .. Auth.EXPIRES_IN_MAX .. " (30 days)")
    end
    return value
end

local function pairingFailure(ctx, failure)
    local status = 403
    local headers
    if failure.code == "PAIRING_RATE_LIMITED" then
        status = 429
        headers = { { "Retry-After", tostring(failure.retry_after or 60) } }
    elseif failure.code == "PAIRING_UNAVAILABLE" then
        status = 503
    end
    ctx.services.log.info("auth", "pairing rejected", { reason = failure.code, client = ctx.client.ip })
    return Problem.new(status, failure.code, failure.message, {
        attempts_remaining = failure.attempts_remaining,
        retry_after = failure.retry_after,
    }), headers
end

local function decoded(value, length)
    local raw = type(value) == "string" and Base64.decode(value) or nil
    if raw and #raw == length then
        return raw
    end
    return nil
end

local function onlyFields(value, field, allowed)
    if type(value) ~= "table" or value == Json.null or Json.isArray(value) then
        return Problem.invalidField(field, field .. " must be an object")
    end
    for key in pairs(value) do
        if not allowed[key] then
            return Problem.invalidField(field .. "." .. tostring(key), "Unknown field: " .. field .. "." .. tostring(key))
        end
    end
    return nil
end

-- The user a pairing code is for (1.9.0, ADR-061; src/auth/pairing.lua's target): Composer's makes
-- a new admin user, as before; one an admin made in the app, the user they chose (still there,
-- with room for a device, and the admin who made it still one who may add a device to them) or a
-- new user with the name and permissions they chose. Never one the pairing device asks for.
-- Returns { profile } or { person, userName } or { composer = true }, or nil, the problem, and
-- whether the code should close (it can no longer be used).
local function pairingTarget(ctx, target)
    if not target then
        return { composer = true }
    end
    local maker = type(target.by) == "string" and ctx.services.keys.find(target.by) or nil
    if not (maker and Access.isAdmin(maker)) then
        return nil, Problem.new(403, "PAIRING_NOT_ACTIVE", "This pairing code no longer works: the admin who made it is no longer one. Ask an admin for a new code"), true
    end
    if not target.profile then
        return { person = target.person, userName = target.name }
    end
    if not ctx.services.profiles.find(target.profile) then
        return nil, Problem.new(403, "PAIRING_NOT_ACTIVE", "This pairing code no longer works: the user it was made for is gone. Ask an admin for a new code"), true
    end
    if not (Access.mayChangePerson(maker, target.profile)) then
        return nil, Problem.new(403, "PAIRING_NOT_ACTIVE", "This pairing code no longer works: only the home's owner pairs a device of theirs"), true
    end
    if Users.full(target.profile) then
        return nil, UserHandlers.limitProblem(ctx, target.profile), false
    end
    return { profile = target.profile }
end

-- The key for a device that proved it knew the code, in the user the code was for.
local function pairedKey(ctx, name, resolved, expiresAt)
    if resolved.profile then
        return createKey(ctx, name, "member", resolved.profile, expiresAt)
    elseif resolved.person then
        return createKey(ctx, name, resolved.person.role, nil, expiresAt, resolved.person, resolved.userName)
    end
    -- The Composer pairing code proves access to the project: the key gets full access.
    return createKey(ctx, name, "admin", nil, expiresAt)
end

-- CPace (ADR-039, src/auth/cpace_pairing.lua), first request: the app's nonce, the controller's
-- share. The code is not sent; the attempt counts as a wrong one until it succeeds.
local function cpaceStart(ctx, body)
    local problem = Validate.body(body, { name = true, expires_in = true, cpace = true })
        or onlyFields(body.cpace, "cpace", { nonce = true })
    if problem then
        return problem
    end
    local nonce = decoded(body.cpace.nonce, CpacePairing.NONCE_BYTES)
    if not nonce then
        return Problem.invalidField("cpace.nonce", "cpace.nonce is " .. CpacePairing.NONCE_BYTES .. " random bytes, base64")
    end
    -- The answer comes sealed: a controller whose lock failed its self-test cannot pair this way.
    -- Its own code, so the app can tell it from DirectorLink before 1.3.0 (which refuses the field
    -- cpace): updating would not help here.
    if not ctx.services.remote.available() then
        return Problem.new(503, "LOCK_UNAVAILABLE", "This controller cannot seal the answer (the lock self-test failed; see the log); pair with pairing_code")
    end
    local _, nameProblem = Validate.name(body.name, "name", "Paired client")
    if nameProblem then
        return nameProblem
    end
    local expires, expiresProblem = expiresIn(body.expires_in)
    if expiresProblem then
        return expiresProblem
    end
    local keys = ctx.services.keys
    if keys.count() >= keys.MAX_KEYS then
        return keyLimitProblem(keys)
    end
    -- A code made for a user who has five devices: said before anything counts against the code.
    local target = ctx.services.pairing.target and ctx.services.pairing.target()
    if target and target.profile and Users.full(target.profile) then
        return UserHandlers.limitProblem(ctx, target.profile)
    end
    local ip = ctx.client and ctx.client.ip
    local attempt, failure = ctx.services.pairing.begin(ip)
    if not attempt then
        return pairingFailure(ctx, failure)
    end
    local ok, answer = pcall(CpacePairing.open, attempt, ip, nonce, body.name, expires)
    if not ok then
        ctx.services.log.error("auth", "could not start a pairing exchange", { error = tostring(answer) })
        return Problem.internal("The pairing exchange could not start; pair again")
    end
    return 200, { cpace = answer }
end

-- CPace, second request: the app's share and its tag, which proves it knew the code; then the
-- key, sealed for this exchange, and the controller's tag.
local function cpaceFinish(ctx, body)
    local problem = Validate.body(body, { cpace = true })
        or onlyFields(body.cpace, "cpace", { session = true, share = true, confirm = true })
    if problem then
        return problem
    end
    local ip = ctx.client and ctx.client.ip
    local session = CpacePairing.take(body.cpace.session, ip)
    if not session then
        return Problem.new(409, "PAIRING_SESSION_EXPIRED", "This pairing exchange is not open (it lasts "
            .. CpacePairing.SESSION_SECONDS .. " seconds and works once); start again")
    end
    local share, tag = decoded(body.cpace.share, 32), decoded(body.cpace.confirm, 64)
    if not share then
        return Problem.invalidField("cpace.share", "cpace.share is a 32-byte X25519 point, base64")
    elseif not tag then
        return Problem.invalidField("cpace.confirm", "cpace.confirm is a 64-byte HMAC-SHA512 tag, base64")
    end
    local keys = ctx.services.keys
    if keys.count() >= keys.MAX_KEYS then
        return keyLimitProblem(keys)
    end
    local ok, isk, answerTag = pcall(CpacePairing.confirm, session, share, tag)
    if not ok then
        ctx.services.log.error("auth", "could not finish a pairing exchange", { error = tostring(isk) })
        return Problem.internal("The pairing exchange failed; pair again")
    end
    if not isk and answerTag == "INVALID_SHARE" then
        return Problem.invalidField("cpace.share", "cpace.share is a point of low order; pair again")
    end
    -- It knew the code: the user it is for is checked before the code is used (1.9.0, ADR-061).
    local resolved, targetProblem, closeCode
    if isk then
        resolved, targetProblem, closeCode = pairingTarget(ctx, session.attempt.target)
        if not resolved then
            -- The code it began with, not one made since.
            if closeCode and ctx.services.pairing.target() == session.attempt.target then
                ctx.services.pairing.cancel()
            end
            return targetProblem
        end
    end
    local paired, failure = ctx.services.pairing.conclude(session.attempt, isk ~= nil)
    if not paired then
        return pairingFailure(ctx, failure)
    end

    -- It proved it knew the code: Composer's gives full access, one made in the app its user's.
    local name = Validate.name(session.name, "name", "Paired client")
    local record, createProblem = pairedKey(ctx, name, resolved, session.expiresIn and os.time() + session.expiresIn)
    if not record then
        return createProblem
    end
    ctx.services.log.info("auth", "paired a new client", { key_id = record.id, name = record.name, role = record.role, client = ip, cpace = true })
    Activity.record("access", "paired", { by = record.id, what = record.name, to = record.role, ids = { key_id = record.id } })
    ctx.services.onKeysChanged()
    local sealedOk, sealed = pcall(Lock.seal, Lock.cpaceKey(Base64.toHex(isk)), "pair", "pair", "res", Json.encode(Views.newApiKey(record)))
    if not sealedOk then
        ctx.services.keys.revoke(record.id)
        ctx.services.onKeysChanged()
        ctx.services.log.error("auth", "could not seal the pairing answer", { error = tostring(sealed) })
        return Problem.internal("The pairing answer could not be sealed; pair again")
    end
    return 201, { cpace = { confirm = Base64.encode(answerTag) }, sealed = sealed }
end

function Auth.pair(ctx)
    -- A code is for the home network: a sealed remote request (any member, from anywhere) never
    -- gets to guess it.
    if ctx.request and ctx.request.principal then
        return Problem.new(403, "PAIRING_ONLY_ON_HOME_NETWORK", "Pair on the home network, with the code from Composer")
    end
    local body = ctx.body
    if type(body) == "table" and body ~= Json.null and body.cpace ~= nil then
        if type(body.cpace) == "table" and body.cpace.session ~= nil then
            return cpaceFinish(ctx, body)
        end
        return cpaceStart(ctx, body)
    end
    -- With the code itself (scripts; the app only after warning that it travels unprotected).
    local problem = Validate.body(body, { pairing_code = true, name = true, exchange = true, expires_in = true })
    if problem then
        return problem
    end
    -- The app's half of a key exchange: the answer is then sealed, and the new key never crosses
    -- the network in the clear (docs/ACCOUNTS.md). Without it (a script), the key comes back as is.
    local appPublic
    if body.exchange ~= nil then
        local exchange = body.exchange
        local raw = type(exchange) == "table" and type(exchange.public_key) == "string" and Base64.decode(exchange.public_key) or nil
        if not raw or #raw ~= 32 or X25519.smallOrder(raw) then
            return Problem.invalidField("exchange.public_key", "exchange.public_key is a 32-byte X25519 public key, base64")
        end
        -- A controller whose lock failed its self-test cannot seal: the app pairs without the
        -- exchange (it does so when the field "exchange" is refused), and the code is kept.
        if not ctx.services.remote.available() then
            return Problem.invalidField("exchange", "This controller cannot seal the answer (the lock self-test failed); pair without exchange")
        end
        appPublic = { raw = raw, text = exchange.public_key }
    end

    local code = ctx.services.pairing.normalize(body.pairing_code)
    if not code then
        return Problem.invalidField("pairing_code", "pairing_code must be the 8-digit code shown in Composer, e.g. 1234 5678")
    end
    local name, nameProblem = Validate.name(body.name, "name", "Paired client")
    if nameProblem then
        return nameProblem
    end
    local expires, expiresProblem = expiresIn(body.expires_in)
    if expiresProblem then
        return expiresProblem
    end

    local keys = ctx.services.keys
    if keys.count() >= keys.MAX_KEYS then
        return keyLimitProblem(keys)
    end
    -- Who the active code is for, before it is used up (1.9.0, ADR-061).
    local target = ctx.services.pairing.target and ctx.services.pairing.target()
    if target and target.profile and Users.full(target.profile) then
        return UserHandlers.limitProblem(ctx, target.profile)
    end

    local paired, failure = ctx.services.pairing.verify(code, ctx.client and ctx.client.ip)
    if not paired then
        return pairingFailure(ctx, failure)
    end

    local resolved, targetProblem = pairingTarget(ctx, target)
    if not resolved then
        return targetProblem
    end
    local record, createProblem = pairedKey(ctx, name, resolved, expires and os.time() + expires)
    if not record then
        return createProblem
    end
    ctx.services.log.info("auth", "paired a new client", { key_id = record.id, name = record.name, role = record.role, client = ctx.client.ip, sealed = appPublic ~= nil })
    Activity.record("access", "paired", { by = record.id, what = record.name, to = record.role, ids = { key_id = record.id } })
    ctx.services.onKeysChanged()
    if not appPublic then
        return 201, Views.newApiKey(record)
    end
    local ok, sealed = pcall(function()
        local private = Random.bytes(32)
        local driverPublic = Base64.encode(X25519.publicKey(private))
        local shared = X25519.shared(private, appPublic.raw)
        if not shared then
            error("the app's public key is not usable", 0)
        end
        local lockKey = Lock.pairingKey(Base64.toHex(shared), code, appPublic.text, driverPublic)
        return { exchange = { public_key = driverPublic }, sealed = Lock.seal(lockKey, "pair", "pair", "res", Json.encode(Views.newApiKey(record))) }
    end)
    if not ok then
        -- Nobody can use a key they never got: take it back.
        ctx.services.keys.revoke(record.id)
        ctx.services.onKeysChanged()
        ctx.services.log.error("auth", "could not seal the pairing answer", { error = tostring(sealed) })
        return Problem.invalidField("exchange.public_key", "The key exchange failed; pair again")
    end
    return 201, sealed
end

function Auth.list_keys(ctx)
    local currentId = ctx.apiKey and ctx.apiKey.id
    local items = Json.array()
    for _, record in ipairs(ctx.services.keys.list()) do
        items[#items + 1] = Views.apiKey(record, currentId)
    end
    return 200, { items = items }
end

-- POST {"name", "role", "access", "profile_id"}: a key for a new person, an admin or a member
-- (`access`: what a member may see and do, as PATCH /v1/profiles/{id}/access takes it; the roles of
-- 1.7.0, viewer, member without `access`, and doors, become what they did then: ADR-054), or with
-- `profile_id` another device of a person, with that person's permissions.
function Auth.create_key(ctx)
    local body = ctx.body
    local problem = Validate.body(body, { name = true, role = true, profile_id = true, access = true })
    if problem then
        return problem
    end
    if body.name == nil then
        return Problem.invalidField("name", "name is required")
    end
    local name, nameProblem = Validate.name(body.name, "name")
    if nameProblem then
        return nameProblem
    end
    local role = body.role or "member"
    if not Roles.valid(role) then
        return roleProblem()
    end
    -- Another device of an existing person: it joins their profile, and has their permissions; the
    -- owner's only by the owner (ADR-054), or another admin would hold the owner's key.
    if body.profile_id ~= nil then
        if not (type(body.profile_id) == "string" and ctx.services.profiles.find(body.profile_id)) then
            return Problem.invalidField("profile_id", "profile_id must be the id of an existing profile")
        end
        local allowed, refusal = Access.mayChangePerson(ctx.apiKey, body.profile_id)
        if not allowed then
            return ProfileHandlers.refused(refusal, "This is the home's owner: only the owner adds a device of theirs")
        end
    end
    local person = nil
    if body.access ~= nil then
        if body.profile_id ~= nil then
            return Problem.invalidField("access", "Another device of a person has that person's permissions: leave out access")
        end
        if role ~= "admin" and role ~= "member" then
            return Problem.invalidField("role", "With access, role is admin or member")
        end
        person, problem = ProfileHandlers.readAccess(ctx.services, body.access, People.defaults(role), "access")
        if not person then
            return problem
        end
        person.role = role
    end

    local record, createProblem = createKey(ctx, name, role, body.profile_id, nil, person)
    if not record then
        return createProblem
    end
    ctx.services.log.info("auth", "API key created", { key_id = record.id, name = record.name, role = record.role, by = ctx.apiKey.id })
    Activity.record("access", "created", { by = ctx.apiKey, what = record.name, to = record.role, ids = { key_id = record.id } })
    ctx.services.onKeysChanged()
    return 201, Views.newApiKey(record, ctx.apiKey.id)
end

-- With what the caller may do (ADR-054: `access`), so that the app shows only that; `role` is the
-- 1.7.0 role the key keeps.
function Auth.current_key(ctx)
    local record = ctx.services.keys.find(ctx.apiKey.id)
    if not record then
        return Problem.unauthorized()
    end
    local view = Views.apiKey(record, ctx.apiKey.id)
    view.access = Access.describe(ctx.apiKey)
    return 200, view
end

-- Whether the caller may change the person `profileId` by revoking, moving or adding a device
-- (Access.mayChangePerson: the owner's devices are only the owner's, or Composer's Revoke All API
-- Keys); nil, or the problem.
local function personRefused(ctx, profileId)
    local allowed, refusal = Access.mayChangePerson(ctx.apiKey, profileId)
    if allowed then
        return nil
    end
    return ProfileHandlers.refused(refusal, "This is a device of the home's owner: only the owner removes or moves it, or moves a device to them")
end

-- Whether some key would still be an admin's if the key `keyId` were moved to `profileId`.
local function adminLeftAfterMove(ctx, keyId, profileId)
    local keys = ctx.services.keys.list()
    for _, key in ipairs(keys) do
        if Access.isAdminPerson(key.id == keyId and profileId or key.profile, keys) then
            return true
        end
    end
    return false
end

-- Any key may revoke itself ("forget this device"), whatever its role.
function Auth.revoke_current_key(ctx)
    local id = ctx.apiKey.id
    -- Before it goes, while its name and person are known.
    Activity.record("access", "forgotten", { by = ctx.apiKey, what = ctx.apiKey.name, ids = { key_id = id } })
    ctx.services.keys.revoke(id)
    if ctx.services.invitations then
        ctx.services.invitations.revokeCreatedBy(id)
    end
    ctx.services.log.info("auth", "API key revoked by its own client", { key_id = id })
    ctx.services.onKeysChanged()
    return 204, nil
end

-- PATCH {"name", "role", "profile_id"}: renames a key, moves it to another person (it then has
-- their permissions), or, as 1.7.0 clients do, gives it a role: since 1.8.0 (ADR-054) a role is its
-- person's, so that changes the person, all of their devices, into what that 1.7.0 role becomes
-- (nothing changes when the key has that role already). The owner's devices are only theirs to
-- move, and the owner stays an admin. Since 1.12.0 (ADR-083) a member renames the devices of their
-- own user (only `name`): another user's device is, for them, one that does not exist, and changing
-- a role or a user stays the admins'.
function Auth.update_key(ctx)
    local body = ctx.body
    local problem = Validate.body(body, { name = true, role = true, profile_id = true }, true)
    if problem then
        return problem
    end
    if not Access.isAdmin(ctx.apiKey) then
        if body.role ~= nil or body.profile_id ~= nil then
            return Problem.new(403, "FORBIDDEN", "Only admins change a device's access or user; you may rename your own devices", { role = ctx.apiKey.role, required_role = "admin" })
        end
        local target = ctx.services.keys.find(ctx.params.keyId)
        if not (target and target.profile and Access.seesUser(ctx.apiKey, target.profile)) then
            return Problem.notFound("API key", ctx.params.keyId)
        end
    end
    local changes = {}
    if body.name ~= nil then
        local name, nameProblem = Validate.name(body.name, "name")
        if nameProblem then
            return nameProblem
        end
        changes.name = name
    end
    if body.role ~= nil and not Roles.valid(body.role) then
        return roleProblem()
    end
    -- Moving a key to another person's profile (e.g. two devices of one person paired apart).
    if body.profile_id ~= nil then
        if not (type(body.profile_id) == "string" and ctx.services.profiles.find(body.profile_id)) then
            return Problem.invalidField("profile_id", "profile_id must be the id of an existing profile")
        end
        changes.profile = body.profile_id
    end

    local id = ctx.params.keyId
    local before = ctx.services.keys.find(id)
    if not before then
        return Problem.notFound("API key", id)
    end
    if changes.profile and changes.profile ~= before.profile then
        problem = personRefused(ctx, before.profile) or personRefused(ctx, changes.profile)
        if problem then
            return problem
        end
        if not adminLeftAfterMove(ctx, id, changes.profile) then
            return Problem.new(409, "LAST_ADMIN", "This is the only admin's device; make someone else an admin first")
        end
        -- Up to five devices a user (1.9.0, ADR-061).
        problem = UserHandlers.refuseWhenFull(ctx, changes.profile)
        if problem then
            return problem
        end
        -- With its new person's 1.7.0 role, saved at once: a key whose role says otherwise would
        -- make that person be read again from it at the next start (People.reconcile).
        changes.role = People.legacyRole(People.peek(changes.profile))
    end
    local record, failure = ctx.services.keys.update(id, changes)
    if not record then
        if failure == "NOT_FOUND" then
            return Problem.notFound("API key", id)
        elseif failure == "LAST_ADMIN" then
            return Problem.new(409, "LAST_ADMIN", "This is the only admin's device; make someone else an admin first")
        end
        return Problem.internal("The API key could not be changed (" .. tostring(failure) .. ")")
    end
    -- The key has its (new) person's permissions, and keeps their 1.7.0 role.
    People.syncKeys(ctx.services.keys)
    record = ctx.services.keys.find(id)
    if body.role ~= nil and body.role ~= record.role and record.profile then
        local _, personProblem = ProfileHandlers.setAccess(ctx, record.profile, People.fromLegacy(body.role, Scenes.list()))
        if personProblem then
            if personProblem.code == "LAST_ADMIN" then
                return Problem.new(409, "LAST_ADMIN", "This is the only admin key; make another key admin first")
            end
            return personProblem
        end
        record = ctx.services.keys.find(id)
    end
    -- Only admins make invitations: a key that is no longer admin keeps none (its claim token
    -- stops working too, src/cloud/remote.lua). A rename alone changes nothing of that (1.12.0: a
    -- member renames their own devices, whose own invitations stay).
    if (body.role ~= nil or changes.profile ~= nil) and record.role ~= "admin" and ctx.services.invitations then
        ctx.services.invitations.revokeCreatedBy(id)
    end
    ctx.services.log.info("auth", "API key changed", { key_id = id, name = record.name, role = record.role, by = ctx.apiKey.id })
    ctx.services.onKeysChanged()
    return 200, Views.apiKey(record, ctx.apiKey.id)
end

-- The owner's devices are only theirs (or Composer's Revoke All API Keys) to revoke (ADR-054). Since
-- 1.9.0 (ADR-061) a member removes the other devices of their own user too; another user's device
-- is, for them, one that does not exist.
function Auth.delete_key(ctx)
    local id = ctx.params.keyId
    local revoked = ctx.services.keys.find(id)
    if revoked and revoked.id ~= ctx.apiKey.id then
        local allowed, refusal = Access.mayRemoveDevice(ctx.apiKey, revoked)
        if not allowed then
            if refusal == "NOT_FOUND" then
                return Problem.notFound("API key", id)
            end
            return ProfileHandlers.refused(refusal, "This is a device of the home's owner: only the owner removes or moves it, or moves a device to them")
        end
    elseif not revoked and not Access.isAdmin(ctx.apiKey) then
        return Problem.notFound("API key", id)
    end
    if not ctx.services.keys.revoke(id) then
        return Problem.notFound("API key", id)
    end
    if ctx.services.invitations then
        ctx.services.invitations.revokeCreatedBy(id)
    end
    ctx.services.log.info("auth", "API key revoked", { key_id = id, by = ctx.apiKey.id })
    Activity.record("access", "revoked", { by = ctx.apiKey, what = revoked and revoked.name, ids = { key_id = id } })
    ctx.services.onKeysChanged()
    return 204, nil
end

return Auth
