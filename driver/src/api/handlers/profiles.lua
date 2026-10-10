-- Profiles (docs/PREFERENCES.md, src/auth/profiles.lua): each person's preferences, shared by their
-- devices. /v1/profile is the caller's own (any key); /v1/profiles lists them for admins, who can
-- rename them and move a key to another (PATCH /v1/api-keys/{keyId} profile_id).
-- A person is an admin or a member (1.8.0, ADR-054): /v1/profiles/{profileId}/access reads and
-- sets that, and what a member may see and do (src/auth/people.lua, src/auth/access.lua). The
-- home's owner is always an admin, and only they change their own; the last admin stays one.

local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local RoomNames = require("src.core.room_names")
local Access = require("src.auth.access")
local People = require("src.auth.people")
local Scenes = require("src.core.scenes")
local Activity = require("src.core.activity")
local FavoritesGone = require("src.core.favorites_gone")

local Profiles = {}

local PALETTE = "^%l[%l%d%-]*$"
local FAVORITE = "^%l+:%d+$"

local function nullable(value)
    if value == nil then
        return Json.null
    end
    return value
end

-- A person's role and permissions: as kept; for a person without a record (the people's store could
-- not be read, or the scenes at the first start of 1.8.0), what the highest 1.7.0 role among their
-- keys becomes (ADR-054), as Access answers for those keys. True as a second value when kept.
local function personRecord(services, profileId)
    local record = People.get(profileId)
    if record then
        return record, true
    end
    local highest, rank = "viewer", { viewer = 1, member = 2, doors = 3, admin = 4 }
    for _, key in ipairs(services.keys.list()) do
        if key.profile == profileId and (rank[key.role] or 0) > rank[highest] then
            highest = key.role
        end
    end
    return People.fromLegacy(highest, Scenes.list()), false
end

-- A person's role and permissions, and whether they are the home's owner.
local function accessView(services, profileId, owner)
    local result = People.view((personRecord(services, profileId)))
    result.owner = profileId == (owner or Access.owner())
    return result
end
Profiles.accessView = accessView

local function view(profile, keyIds)
    local prefs = profile.prefs or {}
    local result = {
        id = profile.id,
        name = profile.name,
        created_at = profile.created_at,
        version = profile.version,
        prefs = {
            language = nullable(prefs.language),
            theme = nullable(prefs.theme),
            palette = nullable(prefs.palette),
            favorites = prefs.favorites or Json.array(),
            hidden_rooms = prefs.hidden_rooms or Json.array(),
        },
    }
    if keyIds then
        result.key_ids = keyIds
    end
    return result
end

local function keyIdsByProfile(keys)
    local byProfile = {}
    for _, key in ipairs(keys.list()) do
        if key.profile then
            byProfile[key.profile] = byProfile[key.profile] or Json.array()
            local list = byProfile[key.profile]
            list[#list + 1] = key.id
        end
    end
    return byProfile
end

-- The caller's profile; a key without one (it should not happen) gets one now.
local function ownProfile(ctx)
    local services = ctx.services
    local key = services.keys.find(ctx.apiKey.id)
    if not key then
        return nil, Problem.new(401, "UNAUTHORIZED", "This API key is no longer valid")
    end
    local profile = key.profile and services.profiles.find(key.profile)
    if profile then
        return profile
    end
    local created, failure = services.profiles.create(key.name)
    if failure == "UNAVAILABLE" then
        -- The profiles could not be read at start: the key's own comes back at the next start.
        return nil, Problem.new(503, "UNAVAILABLE", "The people's profiles could not be read when DirectorLink started; restart the driver and try again")
    elseif not created then
        return nil, Problem.new(409, failure, "This controller has as many profiles as it allows")
    end
    services.keys.update(key.id, { profile = created.id })
    return created
end

-- Checks the fields of `prefs`; returns the changes for Profiles.updatePrefs (false clears a
-- field), or nil and a problem.
local function validatePrefs(prefs, maxFavorites)
    if type(prefs) ~= "table" or prefs == Json.null or Json.isArray(prefs) then
        return nil, Problem.invalidField("prefs", "prefs must be an object")
    end
    local changes = {}
    for field, value in pairs(prefs) do
        if field == "language" then
            if value == Json.null then
                changes.language = false
            elseif value == "auto" or RoomNames.validLanguage(value) then
                changes.language = value
            else
                return nil, Problem.invalidField("prefs.language", 'language must be "auto" or a language tag such as "en" or "he"')
            end
        elseif field == "theme" then
            if value == Json.null then
                changes.theme = false
            elseif type(value) == "string" and (value == "auto" or value == "light" or value == "dark") then
                changes.theme = value
            else
                return nil, Problem.invalidField("prefs.theme", "theme must be auto, light or dark")
            end
        elseif field == "palette" then
            if value == Json.null then
                changes.palette = false
            elseif type(value) == "string" and #value <= 20 and value:match(PALETTE) then
                changes.palette = value
            else
                return nil, Problem.invalidField("prefs.palette", "palette must be a short name such as graphite or ocean")
            end
        elseif field == "favorites" then
            if type(value) ~= "table" or value == Json.null or (not Json.isArray(value) and next(value) ~= nil) then
                return nil, Problem.invalidField("prefs.favorites", 'favorites must be a list such as ["light:21", "thermostat:30"]')
            end
            if #value > maxFavorites then
                return nil, Problem.invalidField("prefs.favorites", "at most " .. maxFavorites .. " favorites")
            end
            local list, seen = Json.array(), {}
            for _, entry in ipairs(value) do
                if type(entry) ~= "string" or #entry > 40 or not entry:match(FAVORITE) then
                    return nil, Problem.invalidField("prefs.favorites", 'each favorite is "kind:id", e.g. "light:21"')
                end
                if not seen[entry] then
                    seen[entry] = true
                    list[#list + 1] = entry
                end
            end
            changes.favorites = list
        elseif field == "hidden_rooms" then
            -- The rooms this person hides from their lists (only them: the home's order is shared).
            if type(value) ~= "table" or value == Json.null or (not Json.isArray(value) and next(value) ~= nil) or #value > 1000 then
                return nil, Problem.invalidField("prefs.hidden_rooms", "hidden_rooms must be a list of room ids")
            end
            local list, seen = Json.array(), {}
            for _, id in ipairs(value) do
                if type(id) ~= "number" or id ~= math.floor(id) or id < 1 then
                    return nil, Problem.invalidField("prefs.hidden_rooms", "each hidden room is a room id")
                end
                if not seen[id] then
                    seen[id] = true
                    list[#list + 1] = id
                end
            end
            changes.hidden_rooms = list
        else
            return nil, Problem.invalidField("prefs." .. tostring(field), "Unknown preference: " .. tostring(field))
        end
    end
    return changes
end

-- The caller's own profile, with its favorites of devices removed in Composer (1.8.0, ADR-059): the
-- app shows them as removed, with Remove, until the controller drops them (src/core/favorites_gone.lua);
-- and what the caller may do (ADR-054), so that the app shows only that.
-- Since 1.12.0 (ADR-083) also whether the user's name is still one of their devices' names (a user
-- made by a device that joined or paired is named after it): the app then asks once for their name.
local function ownView(ctx, profile)
    local result = view(profile)
    result.gone_favorites = FavoritesGone.list(result.prefs.favorites, ctx.apiKey)
    result.access = Access.describe(ctx.apiKey)
    local fromDevice = false
    for _, key in ipairs(ctx.services.keys.list()) do
        if key.profile == profile.id and key.name == profile.name then
            fromDevice = true
        end
    end
    result.name_from_device = fromDevice
    return result
end

function Profiles.current(ctx)
    local profile, problem = ownProfile(ctx)
    if not profile then
        return problem
    end
    return 200, ownView(ctx, profile)
end

-- PATCH {"prefs": {"language": "he", "favorites": [...]}, "version": 3}: changes the named
-- preferences (null clears one). With `version`, it applies only if nobody changed the profile
-- since that version was read (409 VERSION_CONFLICT). Since 1.12.0 (ADR-083) `name` renames the
-- caller's own user, whoever they are (an admin renames anyone with PATCH /v1/profiles/{id}).
function Profiles.update(ctx)
    local body = ctx.body
    local problem = Validate.body(body, { prefs = true, version = true, name = true }, true)
    if problem then
        return problem
    end
    if body.prefs == nil and body.name == nil then
        return Problem.invalidField("prefs", "prefs is required")
    end
    local version = body.version
    if version ~= nil and (type(version) ~= "number" or version ~= math.floor(version) or version < 0) then
        return Problem.invalidField("version", "version must be the profile's version, a whole number")
    end
    local name = nil
    if body.name ~= nil then
        local nameProblem
        name, nameProblem = Validate.name(body.name, "name")
        if nameProblem then
            return nameProblem
        end
    end
    local profile
    profile, problem = ownProfile(ctx)
    if not profile then
        return problem
    end
    local changes = nil
    if body.prefs ~= nil then
        changes, problem = validatePrefs(body.prefs, ctx.services.profiles.MAX_FAVORITES)
        if not changes then
            return problem
        end
    end
    if name ~= nil then
        if version ~= nil and version ~= profile.version then
            return Problem.new(409, "VERSION_CONFLICT", "The profile changed on another device; read it again", { version = profile.version })
        end
        local renamed = name == profile.name and profile or ctx.services.profiles.rename(profile.id, name)
        if not renamed then
            return Problem.notFound("Profile", profile.id)
        end
        if renamed ~= profile then
            ctx.services.log.info("auth", "a user named themself", { profile = profile.id, key_id = ctx.apiKey.id })
        end
        profile = renamed
        if changes == nil then
            return 200, ownView(ctx, profile)
        end
        version = nil
    end
    local updated, failure = ctx.services.profiles.updatePrefs(profile.id, changes, version)
    if not updated then
        if failure == "VERSION_CONFLICT" then
            return Problem.new(409, "VERSION_CONFLICT", "The profile changed on another device; read it again", { version = profile.version })
        end
        return Problem.notFound("Profile", profile.id)
    end
    return 200, ownView(ctx, updated)
end

-- Every person, with their role and permissions (ADR-054).
function Profiles.list(ctx)
    local byProfile = keyIdsByProfile(ctx.services.keys)
    local owner = Access.owner()
    local items = Json.array()
    for _, profile in ipairs(ctx.services.profiles.list()) do
        local item = view(profile, byProfile[profile.id] or Json.array())
        item.access = accessView(ctx.services, profile.id, owner)
        items[#items + 1] = item
    end
    return 200, { items = items }
end

-- PATCH /v1/profiles/{profileId} {"name": "Dana"} (admins).
function Profiles.rename(ctx)
    local id = tostring(ctx.params.profileId or "")
    if not id:match("^%x%x%x%x%x%x%x%x$") then
        return Problem.invalidParameter("profileId", "profileId is 8 hex characters")
    end
    local body = ctx.body
    local problem = Validate.body(body, { name = true }, true)
    if problem then
        return problem
    end
    local name, nameProblem = Validate.name(body.name, "name")
    if nameProblem then
        return nameProblem
    end
    local renamed = ctx.services.profiles.rename(id, name)
    if not renamed then
        return Problem.notFound("Profile", id)
    end
    ctx.services.log.info("auth", "profile renamed", { profile = id, by = ctx.apiKey.id })
    return 200, view(renamed, keyIdsByProfile(ctx.services.keys)[id] or Json.array())
end

-- ---- a person's role and permissions (ADR-054) ------------------------------------------------

local ACCESS_FIELDS = { role = true, all_rooms = true, rooms = true, kinds = true, cameras = true, doors = true, alarm = true, scenes = true }
local ROLES = { admin = true, member = true }

local function isList(value)
    return type(value) == "table" and value ~= Json.null and (Json.isArray(value) or next(value) == nil)
end

-- `body` (an object of ACCESS_FIELDS) applied to `base` (a record of src/auth/people.lua): the new
-- record, or nil and a problem. `field` names the body in problems ("access" inside another body).
-- Rooms must be the home's, scenes its scenes.
function Profiles.readAccess(services, body, base, field)
    local prefix = field and (field .. ".") or ""
    if type(body) ~= "table" or body == Json.null or Json.isArray(body) then
        return nil, Problem.invalidField(field or "body", (field or "The body") .. " must be an object")
    end
    for key in pairs(body) do
        if not ACCESS_FIELDS[key] then
            return nil, Problem.invalidField(prefix .. tostring(key), "Unknown field: " .. prefix .. tostring(key))
        end
    end
    local record = People.view(base or People.defaults("member"))
    if body.role ~= nil then
        if not ROLES[body.role] then
            return nil, Problem.invalidField(prefix .. "role", "role must be admin or member")
        end
        record.role = body.role
    end
    for _, name in ipairs({ "all_rooms", "cameras", "doors", "alarm" }) do
        if body[name] ~= nil then
            if type(body[name]) ~= "boolean" then
                return nil, Problem.invalidField(prefix .. name, name .. " must be true or false")
            end
            record[name] = body[name]
        end
    end
    if body.kinds ~= nil then
        if type(body.kinds) ~= "table" or body.kinds == Json.null or Json.isArray(body.kinds) then
            return nil, Problem.invalidField(prefix .. "kinds", "kinds must be an object of kind to true or false")
        end
        for kind, on in pairs(body.kinds) do
            if not People.KIND[kind] then
                return nil, Problem.invalidField(prefix .. "kinds." .. tostring(kind), "kinds are " .. table.concat(People.KINDS, ", "))
            end
            if type(on) ~= "boolean" then
                return nil, Problem.invalidField(prefix .. "kinds." .. kind, kind .. " must be true or false")
            end
            record.kinds[kind] = on
        end
    end
    if body.rooms ~= nil then
        if not isList(body.rooms) or #body.rooms > People.MAX_ROOMS then
            return nil, Problem.invalidField(prefix .. "rooms", "rooms must be a list of room ids")
        end
        local rooms, seen = Json.array(), {}
        for _, id in ipairs(body.rooms) do
            if type(id) ~= "number" or id ~= math.floor(id) or not (services.registry.rooms or {})[id] then
                return nil, Problem.invalidField(prefix .. "rooms", "Unknown room: " .. tostring(id))
            end
            if not seen[id] then
                seen[id] = true
                rooms[#rooms + 1] = id
            end
        end
        record.rooms = rooms
    end
    if body.scenes ~= nil then
        if not isList(body.scenes) or #body.scenes > People.MAX_SCENES then
            return nil, Problem.invalidField(prefix .. "scenes", "scenes must be a list of scene ids")
        end
        local scenes, seen = Json.array(), {}
        for _, id in ipairs(body.scenes) do
            if type(id) ~= "string" or not Scenes.find(id) then
                return nil, Problem.invalidField(prefix .. "scenes", "Unknown scene: " .. tostring(id))
            end
            if not seen[id] then
                seen[id] = true
                scenes[#scenes + 1] = id
            end
        end
        record.scenes = scenes
    end
    return record
end

-- How many people other than `except` are admins (a person without a record as their keys say).
local function otherAdmins(services, except)
    local count, keys = 0, services.keys.list()
    for _, profile in ipairs(services.profiles.list()) do
        if profile.id ~= except and Access.isAdminPerson(profile.id, keys) then
            count = count + 1
        end
    end
    return count
end

local function unavailable()
    return Problem.new(503, "UNAVAILABLE", "The people's permissions could not be read when DirectorLink started; restart the driver and try again")
end

-- The problem for a change Access.mayChangePerson refused (`code`: OWNER_PROTECTED or UNAVAILABLE).
-- `detail`: what only the owner does, for OWNER_PROTECTED.
function Profiles.refused(code, detail)
    if code == "UNAVAILABLE" then
        return Problem.new(503, "UNAVAILABLE", "Who the home's owner is could not be read when DirectorLink started, so admins' devices and permissions stay as they are; restart the driver and try again")
    end
    return Problem.new(403, "OWNER_PROTECTED", detail or "Only the home's owner changes the owner's devices and permissions")
end

-- Sets the person `profileId`'s role and permissions to `record`, for the caller `ctx.apiKey`: the
-- owner's are only theirs to change, and stay an admin's, and only the owner makes an admin who
-- would then be the owner (Access.mayChangePerson); the last admin stays one. Every key of the
-- person follows (its 1.7.0 role, saved first: when the keys' store cannot be written, nothing
-- changes); a person no longer an admin keeps no invitation their keys made (only admins make
-- them); the history says what changed, and the account service learns the admins' keys again.
-- Returns the person's view, or nil and a problem.
function Profiles.setAccess(ctx, profileId, record)
    local services = ctx.services
    local profile = services.profiles.find(profileId)
    if not profile then
        return nil, Problem.notFound("Profile", profileId)
    end
    if not People.complete() then
        return nil, unavailable()
    end
    -- A person without a record is what their keys say (accessView), an admin too.
    local before = personRecord(services, profileId)
    local wasAdmin = before.role == "admin"
    local allowed, refusal = Access.mayChangePerson(ctx.apiKey, profileId, record.role == "admin" and not wasAdmin)
    if not allowed then
        return nil, Profiles.refused(refusal, wasAdmin and "Only the home's owner changes the owner's role and permissions"
            or "Only the home's owner makes this person an admin: they would be the home's owner")
    end
    if profileId == Access.owner() and record.role ~= "admin" then
        return nil, Problem.new(409, "OWNER_STAYS_ADMIN", "The home's owner is always an admin")
    end
    if wasAdmin and record.role ~= "admin" and otherAdmins(services, profileId) == 0 then
        return nil, Problem.new(409, "LAST_ADMIN", "This is the only admin; make someone else an admin first")
    end
    -- The keys' 1.7.0 role first: a person kept with keys whose role says otherwise would be read
    -- again from those keys at the next start (People.reconcile).
    local legacy, previous = People.legacyRole(record), {}
    local _, keysSaved = services.keys.setRoles(function(key)
        if key.profile ~= profileId then
            return nil
        end
        previous[key.id] = key.role
        return legacy
    end)
    if not keysSaved then
        return nil, Problem.internal("The devices' roles could not be saved, so nothing was changed")
    end
    local ok, failure = People.set(profileId, record)
    if not ok then
        services.keys.setRoles(function(key)
            return previous[key.id]
        end)
        return nil, failure == "UNAVAILABLE" and unavailable() or Problem.internal("The permissions could not be saved, so nothing was changed")
    end
    People.syncKeys(services.keys)
    local after = People.get(profileId)
    if wasAdmin and after.role ~= "admin" and services.invitations then
        for _, key in ipairs(services.keys.list()) do
            if key.profile == profileId then
                services.invitations.revokeCreatedBy(key.id)
            end
        end
    end
    if before.role ~= after.role then
        Activity.record("access", "role_changed", { by = ctx.apiKey, what = profile.name, from = before.role, to = after.role })
    elseif after.role == "member" and Json.encode(People.view(before)) ~= Json.encode(People.view(after)) then
        Activity.record("access", "permissions_changed", { by = ctx.apiKey, what = profile.name })
    end
    services.log.info("auth", "person's access changed", { profile = profileId, role = after.role, by = ctx.apiKey.id })
    if services.onKeysChanged then
        services.onKeysChanged()
    end
    return accessView(services, profileId)
end

local function profileParam(ctx)
    local id = tostring(ctx.params.profileId or "")
    if not id:match("^%x%x%x%x%x%x%x%x$") then
        return nil, Problem.invalidParameter("profileId", "profileId is 8 hex characters")
    end
    if not ctx.services.profiles.find(id) then
        return nil, Problem.notFound("Profile", id)
    end
    return id
end

-- GET /v1/profiles/{profileId}/access (admins): the person's role and permissions.
function Profiles.get_access(ctx)
    local id, problem = profileParam(ctx)
    if not id then
        return problem
    end
    return 200, accessView(ctx.services, id)
end

-- PATCH /v1/profiles/{profileId}/access (admins): {"role": "member", "all_rooms": false,
-- "rooms": [12], "kinds": {"music": false}, "cameras": true, "doors": false, "alarm": true,
-- "scenes": ["a1b2c3d4"]}, any of them; the rest stays as it is.
function Profiles.update_access(ctx)
    local id, problem = profileParam(ctx)
    if not id then
        return problem
    end
    local body = ctx.body
    problem = Validate.body(body, ACCESS_FIELDS, true)
    if problem then
        return problem
    end
    -- Onto what the person has now; for a person without a record, what their keys' 1.7.0 role
    -- becomes, which for a member needs the scenes (theirs are every scene there is, or every one
    -- that opens no door).
    local base, kept = personRecord(ctx.services, id)
    if not kept and base.role ~= "admin" and not Scenes.complete() then
        return Problem.new(503, "UNAVAILABLE", "The scenes could not be read when DirectorLink started, so this person's permissions are not known yet; restart the driver and try again")
    end
    local record
    record, problem = Profiles.readAccess(ctx.services, body, base)
    if not record then
        return problem
    end
    local result
    result, problem = Profiles.setAccess(ctx, id, record)
    if not result then
        return problem
    end
    return 200, result
end

return Profiles
