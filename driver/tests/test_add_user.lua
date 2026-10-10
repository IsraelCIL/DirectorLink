-- Adding users and their devices (1.12.0, ADR-083; src/api/handlers/invitations.lua,
-- src/auth/invitations.lua, src/cloud/remote.lua, src/api/handlers/auth.lua and profiles.lua): an
-- invitation names the new user, and the name stays on the controller (the account service is told
-- the invitation's id, email and expiry, as before; the joining device reads the name in the sealed
-- answer); a device moves to another device of the same user (Safari to the Home Screen app), the
-- key it moved from going at the new key's first use, never before and never another; a user names
-- themself, and renames their own devices.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")
local Harness = require("relay_harness")

local tests = {}

local function get(mock, key, path)
    return T.http(mock, "GET", path, { key = key })
end

-- A connected driver (the fake relay) with the owner's key.
local function session()
    local mock = Mock.startDriver()
    local key = T.pair(mock, "Chrome on Windows")
    local _, connection = Harness.connected({ mock = mock })
    local me = get(mock, key, "/v1/api-keys/current").json
    local remote = get(mock, key, "/v1/remote").json
    return { mock = mock, connection = connection, key = key, keyId = me.id, profile = me.profile_id, home = remote.home_id }
end

local function newUser(mock, admin, name, access, role)
    local created = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = name, role = role or "member", access = access or {} } })
    T.eq(created.status, 201, created.body)
    return created.json.key, created.json
end

local function addDevice(mock, admin, profileId, name)
    local created = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = name, profile_id = profileId } })
    T.eq(created.status, 201, created.body)
    return created.json.key, created.json
end

local counter = 0

-- Opens an invitation as the app does, through the relay; the sealed answer's body, or nil and the
-- code.
local function join(s, invitation, name)
    local Lock = require("src.cloud.lock")
    local lock = Lock.invitationKey(invitation.secret)
    counter = counter + 1
    local request = { id = "join-" .. counter, ts = os.time(), method = "POST", path = "/v1/auth/join", body = { name = name } }
    local envelope = Lock.seal(lock, s.home, invitation.id, "req", Json.encode(request))
    local reply = Harness.relayRequest(s.mock, s.connection, { type = "join", id = "relay-join-" .. counter, invitation = invitation.id, envelope = envelope })
    if not reply.ok then
        return nil, reply.code
    end
    return Json.decode(Json.decode(Lock.open(lock, reply.envelope, "res")).body)
end

-- A request sealed with `key` through the relay, as an iPhone sends every request: its status and
-- body, or nil and the relay's code.
local function e2e(s, key, keyId, method, path, body)
    local Lock = require("src.cloud.lock")
    local lock = Lock.deviceKey(key)
    counter = counter + 1
    local request = { id = "e2e-" .. counter, ts = os.time(), method = method, path = path, body = body }
    local envelope = Lock.seal(lock, s.home, keyId, "req", Json.encode(request))
    local reply = Harness.relayRequest(s.mock, s.connection, { type = "e2e", id = "relay-e2e-" .. counter, envelope = envelope })
    if not reply.envelope then
        return nil, reply.code
    end
    local answer = Json.decode(Lock.open(lock, reply.envelope, "res"))
    return answer.status, answer.body ~= "" and Json.decode(answer.body) or nil
end

-- The driver's messages to the relay since the last look (its key announcements left out).
local function relayed(s)
    local list = {}
    for _, frame in ipairs(Harness.answers(Harness.clientFrames(s.connection.sent))) do
        list[#list + 1] = Json.decode(frame.payload)
    end
    s.connection.sent = ""
    return list
end

local function relayAnswers(message)
    ReceivedFromNetwork(Harness.BINDING, 443, Harness.serverFrame(1, Json.encode(message)))
end

local function userById(mock, key, id)
    for _, item in ipairs(get(mock, key, "/v1/users").json.items) do
        if item.id == id then
            return item
        end
    end
    return nil
end

local function history(mock, admin, action)
    local found = {}
    for _, entry in ipairs(get(mock, admin, "/v1/activity?kind=access&limit=200").json.items) do
        if entry.action == action then
            found[#found + 1] = entry
        end
    end
    return found
end

-- ---- an invitation names the new user ------------------------------------------------------------

function tests.an_invitation_names_the_new_user_and_the_name_stays_home()
    local s = session()
    s.connection.sent = ""
    local pending = T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { role = "member", access = { all_rooms = false, rooms = { 11 }, doors = true }, name = "Dana Levi", email = "dana@example.com" } })
    T.eq(pending.status, nil, "waits for the account service")
    local asked = relayed(s)
    T.eq(#asked, 1)
    T.eq(asked[1].type, "invitation")
    T.eq(asked[1].email, "dana@example.com")
    T.notContains(Json.encode(asked[1]), "Dana", "the account service is never told the user's name")
    relayAnswers({ type = "invitation_result", id = asked[1].id, ok = true })
    local made = T.response(s.mock, pending.handle)
    T.eq(made.status, 201, made.body)
    T.eq(made.json.name, "Dana Levi")
    local listed = get(s.mock, s.key, "/v1/invitations").json.items
    T.eq(listed[1].name, "Dana Levi", "admins see whom it is for")
    -- Opened on Dana's iPad: a user named Dana Levi, with what the admin chose, and a device named
    -- after the iPad.
    local joined = join(s, made.json, "Safari on iPad")
    T.truthy(joined, "joined")
    T.eq(joined.name, "Safari on iPad")
    T.eq(joined.user.name, "Dana Levi", "the sealed answer says whom the device joined as")
    T.eq(joined.home_name, "Home", "and the home's name")
    local me = get(s.mock, joined.key, "/v1/api-keys/current").json
    T.eq(me.access.role, "member")
    T.same(me.access.rooms, { 11 })
    T.eq(me.access.doors, true)
    local profile = get(s.mock, joined.key, "/v1/profile").json
    T.eq(profile.name, "Dana Levi")
    T.eq(profile.name_from_device, false, "nothing to ask: the admin named them")
    T.eq(#get(s.mock, s.key, "/v1/invitations").json.items, 0, "used up")
end

function tests.without_a_name_the_new_user_is_named_after_the_device_as_before()
    local s = session()
    local made = T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { role = "member" } }).json
    local joined = join(s, made, "Samsung Internet on Android")
    T.eq(joined.user.name, "Samsung Internet on Android")
    local profile = get(s.mock, joined.key, "/v1/profile").json
    T.eq(profile.name_from_device, true, "the app asks for their name once")
end

function tests.a_name_is_only_for_a_new_user()
    local s = session()
    local _, kid = newUser(s.mock, s.key, "Kid's phone")
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { role = "member", name = "" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { role = "member", name = string.rep("x", 65) } }).json.code, "INVALID_FIELD")
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { role = "member", name = 7 } }).json.code, "INVALID_FIELD")
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { for_me = true, name = "Me" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { role = "member", profile_id = kid.profile_id, name = "Kid" } }).json.code, "INVALID_FIELD")
    -- A name in Hebrew is 64 letters, not bytes.
    local hebrew = string.rep("ד", 40)
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { role = "admin", name = hebrew } }).status, 201)
    -- A member invites nobody else, named or not.
    local member = newUser(s.mock, s.key, "Member's phone")
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = member, body = { role = "member", name = "Friend" } }).status, 403)
end

-- An invitation kept before a restart keeps its name; one from 1.11.0 (no name) joins as before.
function tests.the_name_survives_a_restart()
    local s = session()
    local made = T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { role = "admin", name = "Grandma" } }).json
    local again = Mock.updateDriver(s.mock)
    local _, connection = Harness.connected({ mock = again })
    local s2 = { mock = again, connection = connection, key = s.key, home = s.home }
    local joined = join(s2, made, "Safari on iPhone")
    T.eq(joined.user.name, "Grandma")
    T.eq(get(again, joined.key, "/v1/api-keys/current").json.access.role, "admin")
end

-- ---- a device moves to another of the same user ----------------------------------------------------

function tests.a_move_takes_the_place_of_its_device_at_the_new_keys_first_use()
    local s = session()
    local safari, kid = newUser(s.mock, s.key, "Safari on iPad", { all_rooms = false, rooms = { 11 } })
    -- Five devices: the move adds none.
    for index = 2, 5 do
        addDevice(s.mock, s.key, kid.profile_id, "Kid's device " .. index)
    end
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = safari, body = { for_me = true } }).json.code, "USER_DEVICE_LIMIT")
    local made = T.http(s.mock, "POST", "/v1/invitations", { key = safari, body = { for_me = true, move = true } })
    T.eq(made.status, 201, made.body)
    T.eq(made.json.move, true)
    T.eq(made.json.for_me, true)
    local joined = join(s, made.json, "DirectorLink app on iPad")
    T.truthy(joined, "joined, five devices or not")
    T.eq(joined.moved, true)
    T.eq(joined.user.id, kid.profile_id, "the same user")
    T.eq(joined.name, "DirectorLink app on iPad")
    -- Until the new device uses its key, the old one still works: a lost answer loses nothing.
    T.eq(get(s.mock, safari, "/v1/api-keys/current").status, 200)
    T.eq(#userById(s.mock, s.key, kid.profile_id).devices, 6)
    -- Its first request: the Safari key goes, and only it.
    local status, body = e2e(s, joined.key, joined.id, "GET", "/v1/api-keys/current")
    T.eq(status, 200)
    T.eq(body.profile_id, kid.profile_id)
    T.same(body.access.rooms, { 11 }, "with the user's access, never more")
    T.eq(get(s.mock, safari, "/v1/api-keys/current").status, 401, "the Safari key was revoked")
    local devices = userById(s.mock, s.key, kid.profile_id).devices
    T.eq(#devices, 5, "as many devices as before")
    for _, device in ipairs(devices) do
        T.truthy(device.name ~= "Safari on iPad")
    end
    local moved = history(s.mock, s.key, "moved")
    T.eq(#moved, 1)
    T.eq(moved[1].what, "DirectorLink app on iPad")
    T.eq(moved[1].from, "Safari on iPad")
    -- Its next requests change nothing more.
    T.eq((e2e(s, joined.key, joined.id, "GET", "/v1/lights")), 200)
    T.eq(#userById(s.mock, s.key, kid.profile_id).devices, 5)
end

function tests.a_move_is_short_one_at_a_time_and_only_for_ones_own_device()
    local s = session()
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { move = true } }).json.code, "INVALID_FIELD", "for_me too")
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { for_me = true, move = "yes" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { for_me = true, move = true, expires_in = 3600 } }).json.code, "INVALID_FIELD", "an admin's move lasts 10 minutes at most too")
    local first = T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { for_me = true, move = true } }).json
    local second = T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { for_me = true, move = true } }).json
    local items = get(s.mock, s.key, "/v1/invitations").json.items
    T.eq(#items, 1, "the second replaced the first")
    T.eq(items[1].id, second.id)
    T.eq(items[1].move, true)
    local _, code = join(s, first, "DirectorLink app on iPhone")
    T.eq(code, "INVITATION_NOT_FOUND")
    -- An Add my other device stays an added device: nothing goes.
    local added = T.http(s.mock, "POST", "/v1/invitations", { key = s.key, body = { for_me = true } }).json
    local other = join(s, added, "Safari on iPhone")
    T.eq(other.moved, nil)
    T.eq((e2e(s, other.key, other.id, "GET", "/v1/lights")), 200)
    T.eq(get(s.mock, s.key, "/v1/api-keys/current").status, 200, "the owner's key stays")
end

function tests.a_move_whose_device_left_the_user_moves_nothing()
    local s = session()
    local safari, kid = newUser(s.mock, s.key, "Safari on iPhone")
    local _, sister = newUser(s.mock, s.key, "Sister's phone")
    -- Moved to another user before the move was accepted: refused, and nobody becomes a user.
    local made = T.http(s.mock, "POST", "/v1/invitations", { key = safari, body = { for_me = true, move = true } }).json
    T.eq(T.http(s.mock, "PATCH", "/v1/api-keys/" .. kid.id, { key = s.key, body = { profile_id = sister.profile_id } }).status, 200)
    local _, code = join(s, made, "DirectorLink app on iPhone")
    T.eq(code, "INVITATION_NOT_FOUND")
    T.eq(#get(s.mock, s.key, "/v1/invitations").json.items, 0, "it went")
    -- Moved to another user after it was accepted: the new key keeps working, the old one stays.
    local phone, noa = newUser(s.mock, s.key, "Safari on iPad")
    made = T.http(s.mock, "POST", "/v1/invitations", { key = phone, body = { for_me = true, move = true } }).json
    local joined = join(s, made, "DirectorLink app on iPad")
    T.eq(T.http(s.mock, "PATCH", "/v1/api-keys/" .. noa.id, { key = s.key, body = { profile_id = sister.profile_id } }).status, 200)
    T.eq((e2e(s, joined.key, joined.id, "GET", "/v1/lights")), 200)
    T.eq(get(s.mock, phone, "/v1/api-keys/current").status, 200, "a device of another user is never revoked by a move")
    T.eq(#history(s.mock, s.key, "moved"), 0)
    -- The device that made it removed: its move invitation goes with it.
    local tablet = newUser(s.mock, s.key, "Safari on iPad 2")
    made = T.http(s.mock, "POST", "/v1/invitations", { key = tablet, body = { for_me = true, move = true } }).json
    T.eq(T.http(s.mock, "DELETE", "/v1/api-keys/current", { key = tablet }).status, 204)
    _, code = join(s, made, "DirectorLink app on iPad")
    T.eq(code, "INVITATION_NOT_FOUND")
end

-- A move accepted before a restart finishes after it.
function tests.a_move_waits_across_a_restart()
    local s = session()
    local safari, kid = newUser(s.mock, s.key, "Safari on iPhone")
    local made = T.http(s.mock, "POST", "/v1/invitations", { key = safari, body = { for_me = true, move = true } }).json
    local joined = join(s, made, "DirectorLink app on iPhone")
    local again = Mock.updateDriver(s.mock)
    local _, connection = Harness.connected({ mock = again })
    local s2 = { mock = again, connection = connection, key = s.key, home = s.home }
    T.eq(get(again, safari, "/v1/api-keys/current").status, 200)
    T.eq((e2e(s2, joined.key, joined.id, "GET", "/v1/lights")), 200)
    T.eq(get(again, safari, "/v1/api-keys/current").status, 401)
    T.eq(#userById(again, s.key, kid.profile_id).devices, 1)
end

-- ---- names --------------------------------------------------------------------------------------

function tests.a_user_names_themself()
    local mock = Mock.startDriver()
    local owner = T.pair(mock, "Chrome on Windows")
    local profile = get(mock, owner, "/v1/profile").json
    T.eq(profile.name, "Chrome on Windows", "paired from Composer: named after the device")
    T.eq(profile.name_from_device, true)
    local renamed = T.http(mock, "PATCH", "/v1/profile", { key = owner, body = { name = "  Israel " } })
    T.eq(renamed.status, 200, renamed.body)
    T.eq(renamed.json.name, "Israel")
    T.eq(renamed.json.name_from_device, false)
    T.eq(renamed.json.access.owner, true, "the owner too")
    T.eq(T.http(mock, "PATCH", "/v1/profile", { key = owner, body = { name = "" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "PATCH", "/v1/profile", { key = owner, body = { name = "Dana", version = 0 } }).json.code, "VERSION_CONFLICT")
    -- A member names their own user, never another's; and their preferences change as before.
    local member, created = newUser(mock, owner, "Samsung Internet on Android")
    T.eq(get(mock, member, "/v1/profile").json.name_from_device, true)
    local mine = T.http(mock, "PATCH", "/v1/profile", { key = member, body = { name = "Ort", prefs = { theme = "dark" } } })
    T.eq(mine.status, 200, mine.body)
    T.eq(mine.json.name, "Ort")
    T.eq(mine.json.prefs.theme, "dark")
    T.eq(get(mock, owner, "/v1/profile").json.name, "Israel")
    T.eq(T.http(mock, "PATCH", "/v1/profiles/" .. created.profile_id, { key = member, body = { name = "x" } }).status, 403, "renaming others stays the admins'")
    T.eq(get(mock, owner, "/v1/system").json.features.user_names, true)
end

function tests.devices_are_renamed_by_their_user_or_an_admin()
    local mock = Mock.startDriver()
    local owner = T.pair(mock, "Chrome on Windows")
    local ownerId = get(mock, owner, "/v1/api-keys/current").json.id
    local phone, kid = newUser(mock, owner, "Safari on iPhone")
    local _, tablet = addDevice(mock, owner, kid.profile_id, "Safari on iPad")
    local _, sister = newUser(mock, owner, "Chrome on Android")
    -- Their own devices, this one too.
    local renamed = T.http(mock, "PATCH", "/v1/api-keys/" .. tablet.id, { key = phone, body = { name = "Kid's iPad" } })
    T.eq(renamed.status, 200, renamed.body)
    T.eq(renamed.json.name, "Kid's iPad")
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. kid.id, { key = phone, body = { name = "Kid's iPhone" } }).status, 200)
    T.eq(get(mock, phone, "/v1/api-keys/current").json.name, "Kid's iPhone")
    -- Another user's device does not exist for them; changing access or user stays the admins'.
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. sister.id, { key = phone, body = { name = "x" } }).status, 404)
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. ownerId, { key = phone, body = { name = "x" } }).status, 404)
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/deadbeef", { key = phone, body = { name = "x" } }).status, 404)
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. tablet.id, { key = phone, body = { role = "admin" } }).status, 403)
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. tablet.id, { key = phone, body = { name = "x", profile_id = sister.profile_id } }).status, 403)
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. tablet.id, { key = phone, body = { name = "" } }).json.code, "INVALID_FIELD")
    T.eq(get(mock, phone, "/v1/api-keys/current").json.access.role, "member", "still a member")
    -- An admin renames any device, the owner's too.
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. sister.id, { key = owner, body = { name = "Sister's phone" } }).status, 200)
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. ownerId, { key = owner, body = { name = "Office PC" } }).status, 200)
end

-- A rename is only a name: the invitations the device made stay (a move waiting, say).
function tests.a_renamed_device_keeps_its_invitations()
    local s = session()
    local safari, kid = newUser(s.mock, s.key, "Safari on iPhone")
    local made = T.http(s.mock, "POST", "/v1/invitations", { key = safari, body = { for_me = true, move = true } }).json
    T.eq(T.http(s.mock, "PATCH", "/v1/api-keys/" .. kid.id, { key = safari, body = { name = "Kid's Safari" } }).status, 200)
    T.eq(T.http(s.mock, "PATCH", "/v1/api-keys/" .. kid.id, { key = s.key, body = { name = "Kid's iPhone Safari" } }).status, 200)
    T.eq(#get(s.mock, s.key, "/v1/invitations").json.items, 1, "still waiting")
    T.truthy(join(s, made, "DirectorLink app on iPhone"), "and it works")
end

return tests
