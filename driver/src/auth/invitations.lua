-- Invitations (docs/ACCOUNTS.md): an admin creates one for a person, an admin or a member with the
-- permissions the admin chose (1.8.0, ADR-054: `access`, src/auth/people.lua; `role` is the 1.7.0
-- role it becomes, which DirectorLink 1.7.0 reads), and its secret travels only in the link the
-- admin shares (after "#", so it never reaches a server). Whoever opens the link and
-- signs in sends a request sealed with the invitation's lock key, and gets their own API key back,
-- sealed the same way. The controller keeps each invitation's lock key, never its secret, and an
-- invitation works once.
--
-- Since 1.12.0 (ADR-083) an invitation for a new user carries that user's name (`user_name`, kept
-- here only: the account service is never told it), and a device may make a move invitation for
-- itself (`move`, its key id): the device that accepts it joins the same user, and the key that made
-- it goes as soon as the new key is first used (Invitations.recordMove, Invitations.takeMove), so a
-- user keeps the same number of devices (Safari to the Home Screen app on iPhone and iPad).

local Clock = require("src.core.clock")
local Random = require("src.core.random")
local Roles = require("src.auth.roles")
local Store = require("src.core.store")
local Lock = require("src.cloud.lock")

local Invitations = {}

Invitations.MAX_PENDING = 20
Invitations.DEFAULT_SECONDS = 7 * 24 * 3600
Invitations.MIN_SECONDS = 60
Invitations.MAX_SECONDS = 7 * 24 * 3600

local STORE_KEY = "directorlink_invitations"

-- A move accepted waits this long for the new key's first use; then it is forgotten, and the key
-- that made it stays (the new device never used its key: nothing is lost).
Invitations.MOVE_WAIT_SECONDS = 7 * 24 * 3600
-- At most this many accepted moves wait at once (each is one key's).
Invitations.MAX_MOVES = 20

local state = { items = {}, moves = {} }

local function randomHex(length)
    return Random.hex(length)
end

local function save()
    local items = {}
    for _, item in ipairs(state.items) do
        items[#items + 1] = { id = item.id, role = item.role, lock = item.lock, created_at = item.created_at, expires = item.expires, created_by = item.created_by, profile = item.profile }
        items[#items].access = item.access
        items[#items].for_user = item.for_user
        items[#items].user_name = item.user_name
        items[#items].move = item.move
    end
    local moves = {}
    for _, move in ipairs(state.moves) do
        moves[#moves + 1] = { key = move.key, replaces = move.replaces, profile = move.profile, at = move.at }
    end
    return Store.write(STORE_KEY, { version = 1, items = items, moves = moves }, false)
end

local function prune(now)
    local kept, changed = {}, false
    for _, item in ipairs(state.items) do
        if item.expires > now then
            kept[#kept + 1] = item
        else
            changed = true
        end
    end
    state.items = kept
    local moves = {}
    for _, move in ipairs(state.moves) do
        if math.abs(now - move.at) < Invitations.MOVE_WAIT_SECONDS then
            moves[#moves + 1] = move
        else
            changed = true
        end
    end
    state.moves = moves
    if changed then
        save()
    end
end

local KEY_ID = "^%x%x%x%x%x%x%x%x$"

local function validName(value)
    return type(value) == "string" and value ~= "" and #value <= 256 and value or nil
end

function Invitations.load()
    state.items = {}
    state.moves = {}
    local stored = Store.read(STORE_KEY, false)
    for _, move in ipairs(Store.items(stored and stored.moves)) do
        if type(move) == "table" and type(move.key) == "string" and move.key:match(KEY_ID) and type(move.replaces) == "string"
            and move.replaces:match(KEY_ID) and type(move.profile) == "string" and type(move.at) == "number" then
            state.moves[#state.moves + 1] = { key = move.key, replaces = move.replaces, profile = move.profile, at = move.at }
        end
    end
    for _, item in ipairs(Store.items(stored and stored.items)) do
        if type(item) == "table" and type(item.id) == "string" and Roles.valid(item.role)
            and type(item.lock) == "string" and #item.lock == 64 and type(item.expires) == "number" then
            state.items[#state.items + 1] = {
                id = item.id,
                role = item.role,
                lock = item.lock,
                created_at = type(item.created_at) == "string" and item.created_at or Clock.iso(),
                expires = item.expires,
                created_by = type(item.created_by) == "string" and item.created_by or nil,
                profile = type(item.profile) == "string" and item.profile or nil,
                access = type(item.access) == "table" and item.access or nil,
                for_user = item.for_user == true or nil,
                user_name = validName(item.user_name),
                move = type(item.move) == "string" and item.move:match(KEY_ID) and item.move or nil,
            }
        end
    end
    prune(Clock.now())
    return #state.items
end

-- `name` (1.12.0): the new user's name, for an invitation that makes one; `move`: a move invitation.
local function view(item)
    return { id = item.id, role = item.role, created_at = item.created_at, expires_at = Clock.iso(item.expires), created_by = item.created_by, for_me = item.profile ~= nil and not item.for_user, profile_id = item.for_user and item.profile or nil, access = item.access, name = item.user_name, move = item.move ~= nil or nil }
end

-- Returns { id, secret, role, created_at, expires_at } (the secret only here), or nil and
-- INVALID_ROLE, INVALID_DURATION, INVITATION_LIMIT_REACHED or LOCK_UNAVAILABLE. `createdBy` is the
-- key id of the admin who made it: revoking that key revokes its invitations. `profile`: for the
-- admin's own other device, the admin's profile (the new key joins it). `access`: the person the
-- invitation makes (src/auth/people.lua, as People.view shows it), for anyone else. `forUser`
-- (1.9.0, ADR-061): `profile` is an existing user an admin invites another device for, not the
-- inviter's own (DirectorLink 1.8.0 joins it into `profile` all the same). `options` (1.12.0,
-- ADR-083): { user_name = the new user's name (with `access`), move = true (the inviter's own other
-- device, which takes the place of the inviting key `createdBy`) }.
function Invitations.create(role, seconds, createdBy, profile, access, forUser, options)
    options = options or {}
    if not Roles.valid(role) then
        return nil, "INVALID_ROLE"
    end
    seconds = seconds or Invitations.DEFAULT_SECONDS
    if type(seconds) ~= "number" or seconds ~= math.floor(seconds) or seconds < Invitations.MIN_SECONDS or seconds > Invitations.MAX_SECONDS then
        return nil, "INVALID_DURATION"
    end
    local now = Clock.now()
    prune(now)
    if #state.items >= Invitations.MAX_PENDING then
        return nil, "INVITATION_LIMIT_REACHED"
    end
    local secret = randomHex(64)
    local ok, lock = pcall(Lock.invitationKey, secret)
    if not ok then
        return nil, "LOCK_UNAVAILABLE"
    end
    local item = { id = randomHex(8), role = role, lock = lock, created_at = Clock.iso(now), expires = now + seconds, created_by = createdBy, profile = profile, access = access, for_user = (forUser and profile ~= nil) or nil }
    if profile == nil and access ~= nil then
        item.user_name = validName(options.user_name)
    end
    if options.move and profile ~= nil and not forUser and type(createdBy) == "string" then
        item.move = createdBy
    end
    table.insert(state.items, item)
    if not save() then
        table.remove(state.items)
        return nil, "PERSIST_FAILED"
    end
    local result = view(item)
    result.secret = secret
    return result
end

function Invitations.list()
    prune(Clock.now())
    local items = {}
    for _, item in ipairs(state.items) do
        items[#items + 1] = view(item)
    end
    return items
end

function Invitations.revoke(id)
    for index, item in ipairs(state.items) do
        if item.id == id then
            table.remove(state.items, index)
            save()
            return true
        end
    end
    return false
end

-- Revokes every invitation (Composer's Revoke All API Keys), and forgets the moves waiting; returns
-- how many invitations.
function Invitations.revokeAll()
    local count = #state.items
    state.items = {}
    state.moves = {}
    save()
    return count
end

-- Revokes the invitations into users who are gone (their last device went: ADR-061), which could
-- only make a new user of whoever opened them. `gone`: { { id }, ... } (Profiles.prune).
function Invitations.revokeForUsers(gone)
    local ids = {}
    for _, user in ipairs(gone or {}) do
        ids[user.id] = true
    end
    local kept = {}
    for _, item in ipairs(state.items) do
        if not (item.profile and ids[item.profile]) then
            kept[#kept + 1] = item
        end
    end
    if #kept ~= #state.items then
        state.items = kept
        save()
    end
end

-- Revokes the invitations a key made, when that key is revoked.
function Invitations.revokeCreatedBy(keyId)
    local kept = {}
    for _, item in ipairs(state.items) do
        if item.created_by ~= keyId then
            kept[#kept + 1] = item
        end
    end
    if #kept ~= #state.items then
        state.items = kept
        save()
    end
end

-- The invitations waiting for another device of the user `profileId` itself (`for_me`, made by one
-- of their devices; not an admin's for that user), oldest first: { { id, expires_at } }.
function Invitations.ownPending(profileId)
    prune(Clock.now())
    local items = {}
    for _, item in ipairs(state.items) do
        if profileId ~= nil and item.profile == profileId and not item.for_user then
            items[#items + 1] = { id = item.id, expires_at = Clock.iso(item.expires) }
        end
    end
    return items
end

-- A pending invitation with its lock key, or nil.
function Invitations.find(id)
    prune(Clock.now())
    for _, item in ipairs(state.items) do
        if item.id == id then
            return { id = item.id, role = item.role, lock = item.lock, profile = item.profile, access = item.access, created_by = item.created_by, for_user = item.for_user, user_name = item.user_name, move = item.move }
        end
    end
    return nil
end

-- Uses the invitation up.
function Invitations.consume(id)
    return Invitations.revoke(id)
end

-- The move invitations a key made that are still waiting: { { id } } (1.12.0: one at a time, a new
-- one replaces the one before).
function Invitations.movesBy(keyId)
    prune(Clock.now())
    local items = {}
    for _, item in ipairs(state.items) do
        if keyId ~= nil and item.move == keyId then
            items[#items + 1] = { id = item.id }
        end
    end
    return items
end

-- A move invitation was accepted (1.12.0, ADR-083): the new key `keyId`, in the user `profile`,
-- takes the place of `replaces` at its first use (Invitations.takeMove). Returns whether it was kept.
function Invitations.recordMove(keyId, replaces, profile)
    prune(Clock.now())
    local kept = {}
    for _, move in ipairs(state.moves) do
        if move.key ~= keyId and move.replaces ~= replaces then
            kept[#kept + 1] = move
        end
    end
    while #kept >= Invitations.MAX_MOVES do
        table.remove(kept, 1)
    end
    kept[#kept + 1] = { key = keyId, replaces = replaces, profile = profile, at = Clock.now() }
    state.moves = kept
    return save()
end

-- The key `keyId` was used: the move it finishes, { replaces, profile }, taken (forgotten), or nil.
function Invitations.takeMove(keyId)
    if #state.moves == 0 then
        return nil
    end
    for index, move in ipairs(state.moves) do
        if move.key == keyId then
            table.remove(state.moves, index)
            save()
            if math.abs(Clock.now() - move.at) >= Invitations.MOVE_WAIT_SECONDS then
                return nil
            end
            return { replaces = move.replaces, profile = move.profile }
        end
    end
    return nil
end

return Invitations
