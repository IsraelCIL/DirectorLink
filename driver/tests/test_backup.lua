-- Backup and restore (ADR-042, docs/BACKUP.md): GET /v1/backup, POST /v1/restore/parts and
-- POST /v1/restore, for admins, only in sealed requests. A round trip into a driver with fresh
-- storage, the document's checks, all or nothing, the restoring admin's key, devices matched by id
-- or by name, the remote identity, and a big home in parts.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")
local Harness = require("relay_harness")

local tests = {}

local counter = 0

local function Lock()
    return require("src.cloud.lock")
end

-- A driver with `project` (Mock.project()), an admin key paired at home: { mock, key, id }.
local function start(project, prepare)
    local mock = Mock.startDriver(project or Mock.project(), nil, nil, prepare)
    local key = T.pair(mock, "Owner phone")
    local me = T.http(mock, "GET", "/v1/api-keys/current", { key = key }).json
    return { mock = mock, key = key, id = me.id }
end

-- A request sealed at home, as the app sends every request (POST /v1/sealed). Returns the opened
-- answer (`json` decoded) and the HTTP request's body size.
local function sealed(s, request, key, keyId)
    local info = T.http(s.mock, "GET", "/v1/sealed").json
    counter = counter + 1
    request.id = "backup-" .. counter
    request.ts = info.time
    local lock = Lock().deviceKey(key or s.key)
    local envelope = Lock().seal(lock, info.home, keyId or s.id, "req", Json.encode(request))
    local body = Json.encode({ envelope = envelope })
    local response = T.http(s.mock, "POST", "/v1/sealed", { body = body })
    T.eq(response.status, 200, response.body)
    local answer = Json.decode(Lock().open(lock, response.json.envelope, "res"))
    answer.json = answer.body ~= "" and Json.decode(answer.body) or nil
    return answer, #body
end

-- The same request as it runs once opened (src/cloud/remote.lua: the key as principal), without the
-- fake Director's AES, which is plain Lua and slow for a big home; with the size of the POST
-- /v1/sealed that would carry it (AES-CBC pads to 16 bytes, base64 takes 4 for 3).
local function opened(s, request)
    local plaintext = Json.encode({ id = "backup-0000", ts = os.time(), method = request.method, path = request.path, body = request.body or Json.null })
    local padded = (math.floor(#plaintext / 16) + 1) * 16
    local envelope = { v = 1, home = "lan", key = s.id, iv = string.rep("A", 22) .. "==", ct = string.rep("A", 4 * math.ceil(padded / 3)), mac = string.rep("A", 43) .. "=" }
    local status, _, body = require("src.api.server").handleRequest({
        method = request.method,
        path = request.path,
        query = {},
        headers = request.body and { ["content-type"] = "application/json" } or {},
        body = request.body and Json.encode(request.body) or "",
        principal = { id = s.id, name = "Owner phone", role = "admin", sealed = true },
    }, { ip = "192.168.1.50", port = "0" })
    return { status = status, body = body, json = Json.decode(body) }, #Json.encode({ envelope = envelope })
end

local function export(s, send)
    local answer = (send or sealed)(s, { method = "GET", path = "/v1/backup" })
    T.eq(answer.status, 200, answer.body)
    return answer.json, answer.body
end

-- Sends the document's JSON in parts of at most `size` bytes; returns the upload id and the
-- largest HTTP body a part took at home.
local function upload(s, document, size, send)
    local text = type(document) == "string" and document or Json.encode(document)
    size = size or 24000
    local count = math.ceil(#text / size)
    local id, largest = nil, 0
    for index = 0, count - 1 do
        local answer, bytes = (send or sealed)(s, { method = "POST", path = "/v1/restore/parts", body = {
            upload = id, index = index, count = count, text = text:sub(index * size + 1, (index + 1) * size),
        } })
        T.eq(answer.status, 200, answer.body)
        id = answer.json.upload
        largest = math.max(largest, bytes)
        T.eq(answer.json.received, index + 1)
        T.eq(answer.json.complete, index == count - 1)
    end
    return id, largest
end

local function restore(s, body, send)
    return (send or sealed)(s, { method = "POST", path = "/v1/restore", body = body })
end

-- Checks, then replaces everything with `document`; returns the result.
local function replace(s, document)
    local id = upload(s, document)
    local check = restore(s, { upload = id })
    T.eq(check.status, 200, check.body)
    T.eq(check.json.dry_run, true)
    local done = restore(s, { upload = id, dry_run = false })
    T.eq(done.status, 200, done.body)
    T.eq(done.json.dry_run, false)
    return done.json.restore, check.json.restore
end

local function createKey(s, name, role)
    local created = T.http(s.mock, "POST", "/v1/api-keys", { key = s.key, body = { name = name, role = role } })
    T.eq(created.status, 201, created.body)
    return created.json.key, created.json.id
end

local function stored(mock, name)
    local value = mock.persist[name]
    return type(value) == "string" and Json.decode(value:gsub("^json:", "")) or nil
end

-- The home as it was before the accident: scenes, a schedule, preferences, room names and order,
-- the calendar's settings, a member and a viewer, and its remote identity.
local function furnish(s)
    local night = T.http(s.mock, "POST", "/v1/scenes", { key = s.key, body = {
        name = "Good night", icon = "moon", show_on_home = true,
        steps = {
            { type = "lights", device_ids = { 20, 21 }, set = { on = false } },
            { type = "blinds", room_id = 11, set = { position = 0 } },
            { type = "climate", device_ids = { 30 }, set = { mode = "cool", target_temperature = 24 } },
        },
    } })
    T.eq(night.status, 201, night.body)
    local morning = T.http(s.mock, "POST", "/v1/scenes", { key = s.key, body = {
        name = "Morning", steps = { { type = "lights", room_id = 10, set = { brightness = 60 } } },
    } }).json
    local schedule = T.http(s.mock, "POST", "/v1/schedules", { key = s.key, body = {
        scene_id = night.json.id, trigger = { type = "time", at = "23:30" }, days = { 0, 1, 2, 3, 4 },
    } })
    T.eq(schedule.status, 201, schedule.body)
    T.eq(T.http(s.mock, "PATCH", "/v1/profile", { key = s.key, body = { prefs = {
        language = "he", theme = "dark", favorites = { "light:20", "thermostat:30", "blind:50" }, hidden_rooms = { 10 },
    } } }).status, 200)
    T.eq(T.http(s.mock, "PATCH", "/v1/rooms/11", { key = s.key, body = { names = { he = "סלון" } } }).status, 200)
    T.eq(T.http(s.mock, "PUT", "/v1/rooms/order", { key = s.key, body = { room_ids = { 11, 10 } } }).status, 200)
    -- The calendar's settings change only while it is on in Composer.
    Properties["Jewish Calendar"] = "On"
    T.eq(T.http(s.mock, "PATCH", "/v1/calendar/settings", { key = s.key, body = { candle_lighting_minutes = 30, havdalah_minutes = 50 } }).status, 200)
    local member, memberId = createKey(s, "Dana phone", "member")
    local viewer = createKey(s, "Hall tablet", "viewer")
    return { night = night.json, morning = morning, schedule = schedule.json, member = member, memberId = memberId, viewer = viewer }
end

local function list(mock, key, path)
    local response = T.http(mock, "GET", path, { key = key })
    T.eq(response.status, 200, response.body)
    return response.json
end

function tests.only_admins_in_sealed_requests_reach_the_backup()
    local s = start()
    for _, route in ipairs({ { "GET", "/v1/backup" }, { "POST", "/v1/restore/parts" }, { "POST", "/v1/restore" } }) do
        local clear = T.http(s.mock, route[1], route[2], { key = s.key, body = route[1] == "POST" and { dry_run = true } or nil })
        T.eq(clear.status, 403, route[2])
        T.eq(clear.json.code, "SEALED_REQUEST_REQUIRED", "in the clear the lock keys would cross the network")
    end
    for _, role in ipairs({ "viewer", "member", "doors" }) do
        local key, id = createKey(s, role .. " device", role)
        local answer = sealed(s, { method = "GET", path = "/v1/backup" }, key, id)
        T.eq(answer.status, 403, role)
        T.eq(answer.json.code, "FORBIDDEN")
        T.eq(sealed(s, { method = "POST", path = "/v1/restore", body = { document = {} } }, key, id).status, 403)
    end
    T.eq(export(s).format, "directorlink-backup")
end

-- The app shows Backup only when GET /v1/system says the driver has it: drivers before 1.4.0 do not.
function tests.the_system_says_that_backups_are_there_whatever_the_properties()
    local s = start()
    local viewer = createKey(s, "viewer device", "viewer")
    T.eq(T.http(s.mock, "GET", "/v1/system", { key = s.key }).json.features.backup, true)
    T.eq(T.http(s.mock, "GET", "/v1/system", { key = viewer }).json.features.backup, true, "the app hides it from other roles itself")
    -- Not a Composer property: nothing an installer switches turns it off.
    Properties["Jewish Calendar"] = "On"
    OnPropertyChanged("Jewish Calendar")
    local features = T.http(s.mock, "GET", "/v1/system", { key = s.key }).json.features
    T.eq(features.jewish_calendar, true)
    T.eq(features.backup, true)
end

function tests.the_document_holds_every_store_as_stored_and_no_key()
    local s = start()
    local home = furnish(s)
    -- The relay accepted the home's identity: a backup holds it.
    Harness.connected({ mock = s.mock })
    Properties["Door Control"] = "Enabled"
    local document, text = export(s)
    T.eq(document.format_version, 1)
    T.eq(document.driver_version, "dev")
    T.eq(document.home.name, "Home", "the project's site")
    T.truthy(document.controller_id:match("^[0-9a-f]+$") and #document.controller_id == 32, "the controller, as a hash of its MAC address")
    local made = T.http(s.mock, "GET", "/v1/logs?category=backup", { key = s.key }).json.items
    T.eq(made[#made].data.controller_known, true, "the log says whether Director gave the MAC address")
    T.eq(made[#made].data.remote_identity, true)
    T.truthy(document.created_at:match("^%d%d%d%d%-%d%d%-%d%dT"))
    T.eq(document.composer["Door Control"], "Enabled", "Composer's settings are listed")
    T.eq(document.composer["Remote Access"], "On")
    local sections = document.sections
    T.eq(#sections.scenes.scenes, 2)
    T.eq(#sections.schedules.schedules, 1)
    T.eq(sections.schedules.schedules[1].last_run, nil, "what schedules ran stays behind")
    T.eq(#sections.keys.keys, 3)
    T.eq(sections.keys.version, 4, "the keys as the store keeps them")
    for _, record in ipairs(sections.keys.keys) do
        T.truthy(record.hash:match("^%x+$") and record.lock:match("^%x+$"), "hashes and lock keys")
    end
    for _, secret in ipairs({ s.key, home.member, home.viewer }) do
        T.notContains(text, secret, "never a key itself")
    end
    T.eq(sections.profiles.profiles[1].prefs.language, "he")
    T.eq(sections.room_names.rooms["11"].he, "סלון")
    T.same(sections.room_order.order, { 11, 10 })
    T.eq(sections.calendar.settings.candle_lighting_minutes, 30)
    local identity = stored(s.mock, "directorlink_remote_identity")
    T.eq(sections.remote_identity.linked, true)
    T.eq(sections.remote_identity.home_id, identity.home_id)
    T.eq(sections.remote_identity.home_secret, identity.home_secret)
    -- What the ids were, for a project whose ids changed.
    T.eq(document.references.devices["20"].name, "Kitchen Island")
    T.eq(document.references.devices["20"].room_id, 10)
    T.eq(document.references.devices["30"].kind, "climate")
    T.eq(document.references.rooms["11"].name, "Living Room")
    local invitations = require("src.auth.invitations")
    T.truthy(invitations.create("member", 3600, s.id), "an invitation waits")
    T.eq(export(s).sections.invitations, nil, "pending invitations are not in a backup")
end

function tests.a_restore_into_fresh_storage_brings_everything_back()
    -- The dev bridge's fake home (Mock.demoProject: every device family).
    local old = start(Mock.demoProject())
    local home = furnish(old)
    Harness.connected({ mock = old.mock })
    local document = export(old)
    local scenes = list(old.mock, old.key, "/v1/scenes").items
    local schedules = list(old.mock, old.key, "/v1/schedules").items
    local profile = list(old.mock, old.key, "/v1/profile")
    local rooms = list(old.mock, old.key, "/v1/rooms").items

    -- The driver was removed and added again: nothing is left, and the owner pairs anew.
    local s = start(Mock.demoProject())
    T.eq(#list(s.mock, s.key, "/v1/scenes").items, 0)
    local done, preview = replace(s, document)
    T.eq(preview.counts.scenes, 2)
    T.eq(preview.counts.schedules, 1)
    T.eq(preview.counts.keys, 4, "three from the backup, and the one restoring")
    T.eq(preview.keys.action, "restore", "only the restoring device is paired: the backup's keys come back")
    T.eq(preview.keys.yours, "added")
    local named = {}
    for _, item in ipairs(preview.keys.items) do
        named[#named + 1] = item.name .. ":" .. item.role
    end
    table.sort(named)
    T.same(named, { "Dana phone:member", "Hall tablet:viewer", "Owner phone:admin" }, "each by name and role")
    T.eq(preview.origin.another_home, false, "the same controller and home")
    T.eq(preview.remote.action, "restore", "a controller with no identity takes its own backup's")
    T.eq(preview.remote.old_controller, false)
    T.eq(preview.backup.home, "Home")
    T.eq(preview.references.unmatched_count, 0)
    T.eq(preview.references.by_id, 6, "rooms 10 and 11, lights 20 and 21, thermostat 30 and blind 50")
    T.eq(done.counts.scenes, 2)

    T.same(list(s.mock, s.key, "/v1/scenes").items, scenes, "the same scenes, ids and versions")
    local restoredSchedules = list(s.mock, s.key, "/v1/schedules").items
    T.eq(#restoredSchedules, 1)
    for _, field in ipairs({ "id", "scene_id", "trigger", "days", "enabled", "version", "created_at" }) do
        T.same(restoredSchedules[1][field], schedules[1][field], field)
    end
    -- Every device keeps working without pairing again: at home with its key, and sealed.
    T.eq(list(s.mock, old.key, "/v1/profile").prefs.language, "he", "the owner's old phone")
    T.same(list(s.mock, old.key, "/v1/profile").prefs, profile.prefs)
    T.eq(list(s.mock, home.member, "/v1/api-keys/current").role, "member")
    T.eq(list(s.mock, home.viewer, "/v1/api-keys/current").role, "viewer")
    T.eq(sealed(s, { method = "GET", path = "/v1/scenes" }, old.key, old.id).status, 200, "sealed with its lock key")
    T.eq(list(s.mock, s.key, "/v1/api-keys/current").role, "admin", "and the restoring admin's own")
    T.same(list(s.mock, s.key, "/v1/rooms").items, rooms, "names and order")
    Properties["Jewish Calendar"] = "On"
    T.eq(list(s.mock, s.key, "/v1/calendar").settings.candle_lighting_minutes, 30)
    T.eq(stored(s.mock, "directorlink_remote_identity").home_id, document.sections.remote_identity.home_id)
    T.eq(s.mock.properties["API Keys"], "4")
    -- And after the next start.
    local again = Mock.updateDriver(s.mock)
    T.same(list(again, old.key, "/v1/scenes").items, scenes)
end

function tests.a_check_changes_nothing()
    local old = start()
    furnish(old)
    local document = export(old)
    local s = start()
    local before = {}
    for name, value in pairs(s.mock.persist) do
        before[name] = value
    end
    local id = upload(s, document)
    local check = restore(s, { upload = id })
    T.eq(check.status, 200, check.body)
    T.eq(restore(s, { document = document }).status, 200, "a document in the request, checked the same way")
    for name, value in pairs(s.mock.persist) do
        if name ~= "directorlink_remote_seen" and name ~= "directorlink_random_pool" then
            T.eq(value, before[name], name .. " is unchanged")
        end
    end
    T.eq(#list(s.mock, s.key, "/v1/scenes").items, 0)
end

local function problem(s, document)
    local answer = restore(s, { document = document })
    return answer.status, answer.json and answer.json.code, answer.json
end

function tests.a_document_is_checked_before_anything_changes()
    local s = start()
    local good = export(s)
    local function variant(change)
        local document = Json.decode(Json.encode(good))
        change(document)
        return document
    end
    T.eq(problem(s, { hello = 1 }), 422, "not a backup")
    local status, code, body = problem(s, variant(function(d)
        d.format = "something-else"
    end))
    T.eq(status, 422)
    T.eq(code, "BACKUP_INVALID")
    T.eq(body.errors[1].field, "format")
    status, code, body = problem(s, variant(function(d)
        d.sections.scenes = nil
    end))
    T.eq(code, "BACKUP_INVALID", "every store has its section")
    T.eq(body.errors[1].field, "sections.scenes")
    status, code, body = problem(s, variant(function(d)
        d.sections.schedules.schedules = "all of them"
    end))
    T.eq(body.errors[1].field, "sections.schedules.schedules")
    status, code = problem(s, variant(function(d)
        d.sections.remote_identity.home_secret = "short"
    end))
    T.eq(code, "BACKUP_INVALID")
    status, code = problem(s, variant(function(d)
        d.sections.extra = { version = 1 }
    end))
    T.eq(code, "BACKUP_INVALID", "unknown sections")
    status, code = problem(s, variant(function(d)
        d.format_version = 2
    end))
    T.eq(status, 409)
    T.eq(code, "BACKUP_TOO_NEW")
    status, code = problem(s, variant(function(d)
        d.sections.keys.version = 5
    end))
    T.eq(code, "BACKUP_TOO_NEW", "a key store written by a newer DirectorLink")
    local parts = sealed(s, { method = "POST", path = "/v1/restore/parts", body = { index = 0, count = 1, text = "{not json" } })
    local bad = restore(s, { upload = parts.json.upload })
    T.eq(bad.status, 422)
    T.eq(bad.json.code, "BACKUP_INVALID")
    T.eq(restore(s, { upload = parts.json.upload, document = good }).status, 400, "one of upload and document")
    T.eq(restore(s, { document = good, dry_run = "yes" }).status, 400)
end

function tests.a_newer_directorlink_s_backup_is_refused_and_an_older_one_migrated()
    local s = start()
    local Version = require("src.core.version")
    Version.BRIDGE_VERSION = "1.4.0"
    local document = export(s)
    document.driver_version = "1.5.0"
    local status, code, body = problem(s, document)
    T.eq(status, 409)
    T.eq(code, "BACKUP_TOO_NEW")
    T.contains(body.detail, "1.5.0")
    document.driver_version = "1.4.1"
    T.eq(problem(s, document), 409)

    -- 1.2.0 kept its keys in store version 3: the console's key expires a day from the restore, as
    -- it does at an update to 1.3.0.
    local console = { id = "c0501e00", name = "DirectorLink Console", role = "admin", alg = "sha256", hash = string.rep("ab", 32), lock = string.rep("cd", 32), created_at = "2026-01-01T00:00:00Z" }
    document.driver_version = "1.2.0"
    document.sections.keys = { version = 3, keys = { console } }
    local answer = restore(s, { document = document, dry_run = false })
    T.eq(answer.status, 200, answer.body)
    local keys = stored(s.mock, "directorlink_api_key_hashes")
    T.eq(keys.version, 4)
    local expires
    for _, key in ipairs(keys.keys) do
        if key.id == console.id then
            expires = key.expires
        end
    end
    T.truthy(expires and math.abs(expires - (os.time() + 86400)) < 60, "the console's key expires in a day")
    Version.BRIDGE_VERSION = "dev"
end

function tests.a_write_that_fails_puts_every_store_back()
    local old = start()
    local home = furnish(old)
    local document = export(old)
    -- A controller with a home of its own in every store.
    local s = start()
    local mine = T.http(s.mock, "POST", "/v1/scenes", { key = s.key, body = { name = "Mine", steps = {} } }).json
    T.eq(T.http(s.mock, "POST", "/v1/schedules", { key = s.key, body = { scene_id = mine.id, trigger = { type = "time", at = "07:00" }, days = { 1 } } }).status, 201)
    T.eq(T.http(s.mock, "PATCH", "/v1/rooms/10", { key = s.key, body = { names = { he = "\215\158\215\152\215\145\215\151" } } }).status, 200)
    T.eq(T.http(s.mock, "PUT", "/v1/rooms/order", { key = s.key, body = { room_ids = { 10, 11 } } }).status, 200)
    Properties["Jewish Calendar"] = "On"
    T.eq(T.http(s.mock, "PATCH", "/v1/calendar/settings", { key = s.key, body = { havdalah_minutes = 72 } }).status, 200)
    Harness.connected({ mock = s.mock })
    local id = upload(s, document)
    T.eq(restore(s, { upload = id }).status, 200)
    local before = {}
    for name, value in pairs(s.mock.persist) do
        before[name] = value
    end
    local write = C4.PersistSetValue
    C4.PersistSetValue = function(self, name, value, encrypted)
        if name == "directorlink_calendar" then
            error("storage full")
        end
        return write(self, name, value, encrypted)
    end
    local failed = restore(s, { upload = id, dry_run = false })
    C4.PersistSetValue = write
    T.eq(failed.status, 500)
    T.eq(failed.json.code, "RESTORE_FAILED")
    T.eq(failed.json.store, "calendar")
    for _, name in ipairs({ "directorlink_api_key_hashes", "directorlink_profiles", "DIRECTORLINK_ROOM_NAMES", "directorlink_room_layout",
        "directorlink_scenes", "directorlink_schedules", "directorlink_calendar", "directorlink_remote_identity" }) do
        T.truthy(before[name], name .. " was there")
        T.same(stored(s.mock, name), Json.decode((before[name]:gsub("^json:", ""))), name .. " as before")
    end
    T.eq(#list(s.mock, s.key, "/v1/scenes").items, 1, "the scenes in use are the ones from before")
    T.eq(list(s.mock, s.key, "/v1/schedules").items[1].scene_id, mine.id)
    T.eq(list(s.mock, s.key, "/v1/calendar").settings.havdalah_minutes, 72)
    T.eq(list(s.mock, s.key, "/v1/rooms").items[1].names.he, "\215\158\215\152\215\145\215\151")
    T.eq(T.http(s.mock, "GET", "/v1/profile", { key = home.member }).status, 401, "the backup's keys are not in use")
    T.eq(list(s.mock, s.key, "/v1/api-keys/current").role, "admin")
    -- The upload is still there: once the controller can save again, the restore goes through.
    T.eq(restore(s, { upload = id, dry_run = false }).status, 200)
    T.eq(#list(s.mock, s.key, "/v1/scenes").items, 2)
end

-- The keys' ids, roles and names as the controller lists them now ("id:role").
local function keyList(s, key)
    local result = {}
    for _, item in ipairs(list(s.mock, key or s.key, "/v1/api-keys").items) do
        result[#result + 1] = item.id .. ":" .. item.role
    end
    table.sort(result)
    return result
end

function tests.an_older_backup_brings_back_no_key_revoked_or_demoted_since()
    -- The same controller: a phone was lost and its key revoked, the tablet is a member's now.
    local s = start()
    local lost, lostId = createKey(s, "Lost phone", "admin")
    local tablet, tabletId = createKey(s, "Tablet", "admin")
    local document = export(s)
    T.eq(T.http(s.mock, "DELETE", "/v1/api-keys/" .. lostId, { key = s.key }).status, 204)
    T.eq(T.http(s.mock, "PATCH", "/v1/api-keys/" .. tabletId, { key = s.key, body = { role = "member" } }).status, 200)
    local before = keyList(s)
    local check = restore(s, { document = document })
    T.eq(check.status, 200, check.body)
    local keys = check.json.restore.keys
    T.eq(keys.action, "kept", "other devices are paired: every key stays as it is now")
    T.eq(keys.yours, "kept")
    T.eq(#keys.items, 0, "none of the backup's comes back")
    T.eq(keys.in_backup, 3)
    T.eq(check.json.restore.counts.keys, 2)
    T.eq(restore(s, { document = document, dry_run = false }).status, 200)
    T.eq(T.http(s.mock, "GET", "/v1/api-keys/current", { key = lost }).status, 401, "the lost phone stays out")
    T.eq(list(s.mock, tablet, "/v1/api-keys/current").role, "member", "and the tablet a member")
    T.same(keyList(s), before)

    -- Only the owner's key is left, and the backup has it: the controller kept its keys since,
    -- and the lost phone stays out too.
    T.eq(T.http(s.mock, "DELETE", "/v1/api-keys/" .. tabletId, { key = s.key }).status, 204)
    local alone = restore(s, { document = document, dry_run = false })
    T.eq(alone.json.restore.keys.action, "kept")
    T.eq(T.http(s.mock, "GET", "/v1/api-keys/current", { key = lost }).status, 401)
    T.eq(#list(s.mock, s.key, "/v1/api-keys").items, 1)
    -- "This device is …" is for a controller where only this device is paired.
    local refused = restore(s, { document = document, replaces_key = s.id })
    T.eq(refused.status, 409)
    T.eq(refused.json.code, "KEYS_KEPT")
end

function tests.with_the_keys_kept_each_key_keeps_its_profile_and_gets_the_backup_s_preferences()
    local s = start()
    local member, memberId = createKey(s, "Dana phone", "member")
    T.eq(T.http(s.mock, "PATCH", "/v1/profile", { key = member, body = { prefs = { theme = "dark" } } }).status, 200)
    local document = export(s)
    T.eq(T.http(s.mock, "PATCH", "/v1/profile", { key = member, body = { prefs = { theme = "light" } } }).status, 200)
    -- A key paired after the backup was made has a profile the backup does not have.
    local late = createKey(s, "Late phone", "viewer")
    T.eq(T.http(s.mock, "PATCH", "/v1/profile", { key = late, body = { prefs = { language = "he" } } }).status, 200)
    T.eq(restore(s, { document = document, dry_run = false }).status, 200)
    T.eq(list(s.mock, member, "/v1/profile").prefs.theme, "dark", "the backup's preferences")
    T.eq(list(s.mock, late, "/v1/profile").prefs.language, "he", "kept where the backup has none")
    T.truthy(memberId)
end

function tests.a_restoring_device_can_take_its_old_key_s_place()
    local old = start()
    local home = furnish(old)
    local ownerId = old.id
    local document = export(old)
    -- The driver was removed and added again: the owner's phone paired anew.
    local s = start()
    local check = restore(s, { document = document })
    T.eq(check.json.restore.keys.action, "restore")
    local offered = {}
    for _, item in ipairs(check.json.restore.keys.items) do
        offered[item.id] = item.name .. ":" .. item.role
    end
    T.eq(offered[ownerId], "Owner phone:admin", "the backup's keys, offered by name and role")
    local done = restore(s, { document = document, dry_run = false, replaces_key = ownerId })
    T.eq(done.status, 200, done.body)
    T.same(done.json.restore.keys.replaced, { id = ownerId, name = "Owner phone", role = "admin" })
    T.eq(done.json.restore.counts.keys, 3, "the member, the viewer and this device: no key left on no device")
    T.eq(T.http(s.mock, "GET", "/v1/api-keys/current", { key = old.key }).status, 401, "the old key stays out")
    local me = list(s.mock, s.key, "/v1/api-keys/current")
    T.eq(me.role, "admin")
    T.eq(me.id, s.id, "this device keeps its own key")
    local prefs = list(s.mock, s.key, "/v1/profile").prefs
    T.eq(prefs.language, "he", "with the owner's preferences")
    T.same(prefs.favorites, { "light:20", "thermostat:30", "blind:50" })
    T.eq(list(s.mock, home.member, "/v1/api-keys/current").role, "member")

    -- Not one of the backup's keys, or a member's when no admin would be left.
    local fresh = start()
    T.eq(restore(fresh, { document = document, replaces_key = "0badc0de" }).status, 400)
    local members = Json.decode(Json.encode(document))
    local kept = {}
    for _, record in ipairs(members.sections.keys.keys) do
        if record.role ~= "admin" then
            kept[#kept + 1] = record
        end
    end
    members.sections.keys.keys = kept
    local refused = restore(fresh, { document = members, replaces_key = home.memberId })
    T.eq(refused.status, 409)
    T.eq(refused.json.code, "LAST_ADMIN")
    T.eq(list(fresh.mock, fresh.key, "/v1/api-keys/current").role, "admin", "nothing changed")
end

function tests.the_restoring_admin_keeps_their_key_and_their_role()
    -- Only this device is paired, and the backup has it: as it is now.
    local s = start()
    local document = export(s)
    local answer = restore(s, { document = document, dry_run = false })
    T.eq(answer.status, 200, answer.body)
    T.eq(answer.json.restore.keys.yours, "kept")
    T.eq(list(s.mock, s.key, "/v1/api-keys/current").role, "admin")

    -- A backup with another key of the same id (8 random hex digits): the one in use wins.
    local clash = Json.decode(Json.encode(document))
    for _, record in ipairs(clash.sections.keys.keys) do
        if record.id == s.id then
            record.hash = string.rep("0", 64)
            record.role = "viewer"
        end
    end
    local check = restore(s, { document = clash })
    T.eq(check.json.restore.keys.conflict, true)
    T.eq(restore(s, { document = clash, dry_run = false }).status, 200)
    T.eq(list(s.mock, s.key, "/v1/api-keys/current").role, "admin")

    -- The key limit: the restoring admin's own comes on top of a full backup.
    local full = Json.decode(Json.encode(document))
    full.sections.keys.keys = {}
    for index = 1, 20 do
        full.sections.keys.keys[index] = { id = string.format("%08x", index), name = "Device " .. index, role = "member", alg = "sha256", hash = string.rep(string.format("%02x", index), 32), lock = string.rep("ef", 32), created_at = "2026-01-01T00:00:00Z" }
    end
    local restored = restore(s, { document = full, dry_run = false })
    T.eq(restored.status, 200, restored.body)
    T.eq(restored.json.restore.keys.count, 21)
    T.eq(restored.json.restore.keys.over_limit, true)
    T.eq(list(s.mock, s.key, "/v1/api-keys/current").role, "admin")
    T.eq(T.http(s.mock, "POST", "/v1/api-keys", { key = s.key, body = { name = "One more" } }).json.code, "KEY_LIMIT_REACHED")
    -- More than a DirectorLink ever has (a file made by hand): the limit, and the restoring key.
    local fresh = start()
    full.sections.keys.keys[21] = { id = "00000015", name = "Device 21", role = "member", alg = "sha256", hash = string.rep("15", 32), lock = string.rep("ef", 32) }
    local capped = restore(fresh, { document = full }).json.restore.keys
    T.eq(capped.count, 21)
    T.eq(capped.left_out, 1)
end

function tests.a_backup_s_key_records_are_checked_as_keys_are_made()
    local old = start()
    local member, memberId = createKey(old, "Kid tablet", "member")
    local document = export(old)
    local keys = document.sections.keys.keys
    local memberHash
    for _, record in ipairs(keys) do
        if record.id == memberId then
            memberHash = record.hash
        end
    end
    local function record(id, role, hash)
        return { id = id, name = "Crafted", role = role, alg = "sha256", hash = hash, lock = string.rep("2b", 32), created_at = "x" }
    end
    keys[#keys + 1] = record("0000aaaa", nil, string.rep("1a", 32))
    keys[#keys + 1] = record("0000bbbb", "guest", string.rep("3c", 32))
    keys[#keys + 1] = record("NOT-HEX!", "member", string.rep("5e", 32))
    keys[#keys + 1] = record(string.rep("a", 300), "member", string.rep("7a", 32))
    keys[#keys + 1] = record("00c0ffee", "admin", memberHash)
    keys[#keys + 1] = record("0000cccc", "member", string.rep("AB", 32))
    local badLock = record("0000dddd", "member", string.rep("9d", 32))
    badLock.lock = "not a lock"
    keys[#keys + 1] = badLock
    local s = start()
    -- The restoring key's secret under another id would open both.
    local mine = record("0000eeee", "admin", nil)
    for _, item in ipairs(require("src.auth.keys").backup().keys) do
        if item.id == s.id then
            mine.hash = item.hash
        end
    end
    keys[#keys + 1] = mine
    local check = restore(s, { document = document })
    T.eq(check.json.restore.keys.left_out, 8, "no role, an unknown role, two bad ids, two keys of one secret, an upper-case hash, a bad lock key")
    T.eq(restore(s, { document = document, dry_run = false }).status, 200)
    local expected = { memberId .. ":member", old.id .. ":admin", s.id .. ":admin" }
    table.sort(expected)
    T.same(keyList(s), expected, "none of them, and none made admin")
    T.eq(list(s.mock, member, "/v1/api-keys/current").role, "member", "the member's secret is still only the member's")
end

function tests.a_key_with_more_left_than_any_key_gets_is_counted_as_expired()
    local document = export(start())
    local s = start()
    local keys = document.sections.keys.keys
    keys[#keys + 1] = { id = "0000cccc", name = "Clock ahead", role = "admin", alg = "sha256", hash = string.rep("9c", 32), lock = string.rep("ad", 32), created_at = "x", expires = os.time() + 40 * 86400 }
    keys[#keys + 1] = { id = "0000dddd", name = "In a week", role = "member", alg = "sha256", hash = string.rep("9d", 32), lock = string.rep("ae", 32), created_at = "x", expires = os.time() + 7 * 86400 }
    local check = restore(s, { document = document }).json.restore
    T.eq(check.keys.expired, 1, "more than 30 days and an hour left: made while a clock ran ahead (ADR-040)")
    T.eq(check.counts.keys, 3, "the backup's owner, the one for a week, and this device")
    T.eq(restore(s, { document = document, dry_run = false }).status, 200)
    T.eq(#list(s.mock, s.key, "/v1/api-keys").items, 3, "what the preview said")
end

function tests.expired_keys_and_more_profiles_than_a_directorlink_has_stay_out()
    local document = export(start())
    local s = start()
    document.sections.keys.keys[#document.sections.keys.keys + 1] = { id = "0badc0de", name = "Old console", role = "admin", alg = "sha256", hash = string.rep("12", 32), lock = string.rep("34", 32), created_at = "2026-01-01T00:00:00Z", expires = os.time() - 60 }
    -- A file made by hand: more profiles than DirectorLink keeps.
    local profiles = document.sections.profiles.profiles
    for index = 1, 105 do
        profiles[#profiles + 1] = { id = string.format("%08x", 4096 + index), name = "Guest " .. index, prefs = {} }
    end
    local check = restore(s, { document = document })
    T.eq(check.json.restore.keys.expired, 1)
    T.eq(check.json.restore.counts.keys, 2, "the backup's owner and this device")
    T.eq(check.json.restore.counts.profiles, 101, "a hundred, and this device's own on top")
    T.eq(check.json.restore.left_out.profiles, 6)
end

-- The project was rebuilt: the kitchen light has another id, the hall light is gone, the living
-- room is now the lounge (another id) and the kitchen another id with the same name.
local function rebuilt()
    local project = Mock.project()
    Mock.removeDevice(project, 20)
    Mock.addLight(project, 120, 220, 10, "Kitchen Island", 0)
    Mock.removeDevice(project, 21)
    Mock.renameDevice(project, 30, "Parents AC")
    return project
end

function tests.devices_are_matched_by_id_else_by_name_in_the_same_room_and_the_rest_listed()
    local old = start()
    furnish(old)
    T.eq(T.http(old.mock, "POST", "/v1/scenes", { key = old.key, body = {
        name = "Hall", steps = { { type = "lights", device_ids = { 21 }, set = { on = true } } },
    } }).status, 201)
    local document = export(old)
    -- A favorite of a kind this DirectorLink does not know (a later one's).
    for _, profile in ipairs(document.sections.profiles.profiles) do
        if profile.name == "Owner phone" then
            profile.prefs.favorites[#profile.prefs.favorites + 1] = "sprinkler:77"
        end
    end

    local s = start(rebuilt())
    local done, preview = replace(s, document)
    local references = preview.references
    T.eq(#references.by_name, 1)
    T.eq(references.by_name[1].name, "Kitchen Island")
    T.eq(references.by_name[1].from, 20)
    T.eq(references.by_name[1].to, 120)
    T.eq(#references.renamed, 1, "found by id, with another name now")
    T.same(references.renamed[1], { id = 30, kind = "climate", name = "Parents", now = "Parents AC" })
    T.eq(references.unmatched_count, 2)
    T.eq(references.unmatched[1].kind, "sprinkler", "never dropped without a word")
    T.eq(references.unmatched[1].used_in[1].name, "Owner phone")
    local missing = references.unmatched[2]
    T.eq(missing.id, 21)
    T.eq(missing.name, "Hall Light")
    T.eq(missing.room, "Living Room")
    T.eq(missing.kind, "light")
    T.eq(missing.used_in[1].section, "scenes")
    T.eq(missing.used_in[1].name, "Good night")
    T.eq(missing.used_in[2].name, "Hall")
    T.eq(preview.left_out.steps, 1, "the step with only the missing light")
    T.same(done.references, references, "the result says the same")

    local scenes = list(s.mock, s.key, "/v1/scenes").items
    local night, hall
    for _, scene in ipairs(scenes) do
        if scene.name == "Good night" then
            night = scene
        elseif scene.name == "Hall" then
            hall = scene
        end
    end
    T.same(night.steps[1].device_ids, { 120 }, "the kitchen light by its new id, the hall light left out")
    T.eq(#hall.steps, 0, "a scene whose only device is gone stays, without the step")
    T.same(list(s.mock, old.key, "/v1/profile").prefs.favorites, { "light:120", "thermostat:30", "blind:50" })
end

function tests.a_room_that_is_gone_never_becomes_the_whole_home()
    local old = start()
    furnish(old)
    -- Devices picked in a room: the room is only where they were picked.
    T.eq(T.http(old.mock, "POST", "/v1/scenes", { key = old.key, body = {
        name = "Hall", steps = { { type = "lights", room_id = 11, device_ids = { 21 }, set = { on = true } } },
    } }).status, 201)
    local document = export(old)
    local project = Mock.project()
    -- The living room is gone (its devices moved to the kitchen); the kitchen has a new id.
    for id, device in pairs(project.devices) do
        if device.roomId == 11 then
            Mock.moveDevice(project, id, 10)
        end
    end
    Mock.removeRoom(project, 11)
    Mock.addRoom(project, 12, "Kitchen")
    Mock.removeRoom(project, 10)
    for id, device in pairs(project.devices) do
        if device.roomId == 10 then
            device.roomId = 12
        end
    end
    local s = start(project)
    local done = replace(s, document)
    local byName = done.references.by_name
    local kitchen = false
    for _, entry in ipairs(byName) do
        kitchen = kitchen or (entry.kind == "room" and entry.name == "Kitchen" and entry.from == 10 and entry.to == 12)
    end
    T.truthy(kitchen, "the kitchen by its name")
    local night = list(s.mock, s.key, "/v1/scenes").items[1]
    for _, step in ipairs(night.steps) do
        T.truthy(step.type ~= "blinds", "the living room's blinds step is left out, not run in every room")
    end
    local morning = list(s.mock, s.key, "/v1/scenes").items[2]
    T.eq(morning.steps[1].room_id, 12, "the kitchen step in the kitchen's new id")
    local hall = list(s.mock, s.key, "/v1/scenes").items[3]
    T.same(hall.steps[1].device_ids, { 21 }, "the hall light, now in the kitchen, stays")
    T.eq(tostring(hall.steps[1].room_id), "null", "without the room that is gone")
    local rooms = list(s.mock, s.key, "/v1/rooms").items
    T.eq(#rooms, 1)
    T.same(list(s.mock, old.key, "/v1/profile").prefs.hidden_rooms, { 12 })
    local living = false
    for _, entry in ipairs(done.references.unmatched) do
        living = living or (entry.kind == "room" and entry.id == 11 and entry.name == "Living Room")
    end
    T.truthy(living, "the living room is listed")
end

function tests.a_schedule_starts_after_the_restore_and_its_scene_comes_with_it()
    local old = start()
    local home = furnish(old)
    local document = export(old)
    -- A schedule whose scene is not in the backup is left out.
    local orphan = Json.decode(Json.encode(document.sections.schedules.schedules[1]))
    orphan.id = "0000beef"
    orphan.scene_id = "0000dead"
    document.sections.schedules.schedules[2] = orphan
    local s = start()
    local done = replace(s, document)
    T.eq(done.counts.schedules, 1)
    T.eq(done.left_out.schedules, 1)
    local schedules = stored(s.mock, "directorlink_schedules").schedules
    T.truthy(schedules[1].updated_epoch >= os.time() - 5, "nothing due before the restore runs")
    local state = stored(s.mock, "directorlink_schedule_state")
    T.truthy(state.catch_up_after >= os.time() - 5, "and nothing is caught up")
    T.eq(schedules[1].id, home.schedule.id)
end

function tests.invitations_and_claims_from_before_are_revoked()
    local s = start()
    local document = export(s)
    local invitations = require("src.auth.invitations")
    T.truthy(invitations.create("member", 3600, s.id))
    T.eq(#invitations.list(), 1)
    T.eq(restore(s, { document = document, dry_run = false }).status, 200)
    T.eq(#invitations.list(), 0, "they were for the keys and the home there were")
end

function tests.uploads_come_in_order_for_one_key_and_expire()
    local s = start()
    local document = export(s)
    local text = Json.encode(document)
    local first = sealed(s, { method = "POST", path = "/v1/restore/parts", body = { index = 0, count = 2, text = text:sub(1, 100) } })
    T.eq(first.status, 200)
    local id = first.json.upload
    local incomplete = restore(s, { upload = id })
    T.eq(incomplete.status, 409)
    T.eq(incomplete.json.code, "UPLOAD_INCOMPLETE")
    T.eq(sealed(s, { method = "POST", path = "/v1/restore/parts", body = { upload = id, index = 2, count = 2, text = "x" } }).status, 400)
    T.eq(sealed(s, { method = "POST", path = "/v1/restore/parts", body = { upload = id, index = 1, count = 3, text = "x" } }).status, 400)
    local other, otherId = createKey(s, "Another admin", "admin")
    local foreign = sealed(s, { method = "POST", path = "/v1/restore/parts", body = { upload = id, index = 1, count = 2, text = text:sub(101) } }, other, otherId)
    T.eq(foreign.status, 404, "an upload is its key's")
    T.eq(sealed(s, { method = "POST", path = "/v1/restore/parts", body = { upload = id, index = 1, count = 2, text = text:sub(101) } }).status, 200)
    T.eq(restore(s, { upload = id }).status, 200)
    -- A part is at most 48 KiB (at home, a sealed request is at most 64 KiB anyway), a backup 2 MiB.
    local Backup = require("src.core.backup")
    local _, tooBig = Backup.receivePart(s.id, { index = 0, count = 1, text = string.rep("x", 48 * 1024 + 1) }, os.time())
    T.eq(tooBig.code, "INVALID_FIELD")
    local limit = Backup.MAX_BYTES
    Backup.MAX_BYTES = 100
    local begun = Backup.receivePart(s.id, { index = 0, count = 2, text = string.rep("x", 60) }, os.time())
    local _, large = Backup.receivePart(s.id, { upload = begun.upload, index = 1, count = 2, text = string.rep("x", 60) }, os.time())
    Backup.MAX_BYTES = limit
    T.eq(large.code, "BACKUP_TOO_LARGE")
    -- A new upload replaced the one before.
    T.eq(restore(s, { upload = id }).json.code, "UPLOAD_NOT_FOUND")
    id = upload(s, document)
    -- Ten minutes later it is gone.
    local now = os.time
    os.time = function(t)
        return t and now(t) or now() + 601
    end
    local late = restore(s, { upload = id })
    os.time = now
    T.eq(late.status, 404)
    T.eq(late.json.code, "UPLOAD_NOT_FOUND")
end

-- Two door relays in the kitchen, 70 and 71, and a second light there, 120.
local function withDoors(project, first, second, island, pantry)
    project.devices[70].deviceName = first
    project.devices[71] = { deviceName = second, driverFileName = "knx_contact_relay.c4z", roomId = 10, roomName = "Kitchen" }
    Mock.renameDevice(project, 20, island)
    Mock.addLight(project, 120, 220, 10, pantry, 0)
    return project
end

local function sceneNamed(s, name)
    for _, scene in ipairs(list(s.mock, s.key, "/v1/scenes").items) do
        if scene.name == name then
            return scene
        end
    end
end

function tests.a_swapped_device_follows_its_name_and_a_door_is_never_moved()
    local old = start(withDoors(Mock.project(), "Garden Gate", "Main Door", "Kitchen Island", "Pantry Light"))
    for _, scene in ipairs({
        { name = "Morning gate", steps = { { type = "relays", device_ids = { 70 }, set = { action = "pulse" } } } },
        { name = "Island", steps = { { type = "lights", device_ids = { 20 }, set = { on = true } } } },
    }) do
        T.eq(T.http(old.mock, "POST", "/v1/scenes", { key = old.key, body = scene }).status, 201)
    end
    T.eq(T.http(old.mock, "PATCH", "/v1/profile", { key = old.key, body = { prefs = { favorites = { "relay:70", "light:20" } } } }).status, 200)
    local document = export(old)

    -- The project was rebuilt: the two relays and the two lights came back with each other's ids.
    local s = start(withDoors(Mock.project(), "Main Door", "Garden Gate", "Pantry Light", "Kitchen Island"))
    local done, preview = replace(s, document)
    local byName = {}
    for _, entry in ipairs(preview.references.by_name) do
        byName[#byName + 1] = entry.kind .. ":" .. entry.from .. ">" .. entry.to
    end
    T.same(byName, { "light:20>120" }, "the light by its name, in the same room")
    local gate
    for _, entry in ipairs(preview.references.unmatched) do
        if entry.kind == "relay" then
            gate = entry
        end
    end
    T.eq(gate.id, 70)
    T.eq(gate.name, "Garden Gate")
    T.eq(gate.now, "Main Door", "listed with what that id is now")
    T.same(sceneNamed(s, "Island").steps[1].device_ids, { 120 })
    T.eq(#sceneNamed(s, "Morning gate").steps, 0, "the gate's step is left out, never moved to the main door")
    T.same(list(s.mock, old.key, "/v1/profile").prefs.favorites, { "light:120" }, "the owner's favorites")
    T.truthy(done)
end

-- Refrigerator steps and favorites (1.7.0, ADR-049) follow the refrigerator like any device: here it
-- was added again in Composer, with new ids, the same name and room.
function tests.a_refrigerator_step_and_favorite_follow_the_refrigerator()
    local old = start(Mock.withRefrigerator(Mock.project()))
    T.eq(T.http(old.mock, "POST", "/v1/scenes", { key = old.key, body = { name = "Shabbat fridge", steps = {
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true } },
        { type = "refrigerators", room_id = 10, set = { ice_maker = false } },
    } } }).status, 201)
    T.eq(T.http(old.mock, "PATCH", "/v1/profile", { key = old.key, body = { prefs = { favorites = { "refrigerator:141", "light:20" } } } }).status, 200)
    local document = export(old)
    T.eq(document.sections.scenes.scenes[1].steps[1].type, "refrigerators")

    local s = start(Mock.withRefrigerator(Mock.project(), { protocol = 150, id = 151 }))
    local done, preview = replace(s, document)
    T.eq(#preview.references.by_name, 1)
    T.eq(preview.references.by_name[1].kind, "refrigerator")
    T.eq(preview.references.by_name[1].from, 141)
    T.eq(preview.references.by_name[1].to, 151)
    T.eq(preview.left_out.steps, 0)
    local scene = sceneNamed(s, "Shabbat fridge")
    T.same(scene.steps[1].device_ids, { 151 })
    T.same(scene.steps[1].set, { sabbath_mode = true })
    T.eq(scene.steps[2].room_id, 10)
    T.same(list(s.mock, old.key, "/v1/profile").prefs.favorites, { "refrigerator:151", "light:20" })
    T.truthy(done)
    local before = #s.mock.commands
    T.eq(T.http(s.mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = old.key }).json.ran, 2)
    T.eq(s.mock.commands[before + 1].device, 150, "to the refrigerator's driver as it is now")
end

-- The kitchen (10) and the living room (11) swapped their ids.
local function swappedRooms()
    local project = Mock.project()
    for _, room in ipairs(project.hierarchy[1][1]) do
        if room.id == 10 then
            room.name = "Living Room"
        elseif room.id == 11 then
            room.name = "Kitchen"
        end
    end
    for _, device in pairs(project.devices) do
        if device.roomId == 10 then
            device.roomName = "Living Room"
        elseif device.roomId == 11 then
            device.roomName = "Kitchen"
        end
    end
    return project
end

function tests.a_swapped_room_follows_its_name_and_doors_stay_in_their_own_room()
    local old = start()
    for _, scene in ipairs({
        { name = "Kitchen lights", steps = { { type = "lights", room_id = 10, set = { on = true } } } },
        { name = "Kitchen doors", steps = { { type = "relays", room_id = 10, set = { action = "pulse" } } } },
    }) do
        T.eq(T.http(old.mock, "POST", "/v1/scenes", { key = old.key, body = scene }).status, 201)
    end
    local document = export(old)
    local s = start(swappedRooms())
    local done = replace(s, document)
    T.eq(sceneNamed(s, "Kitchen lights").steps[1].room_id, 11, "the kitchen by its name")
    T.eq(#sceneNamed(s, "Kitchen doors").steps, 0, "every door of a room only in the very same room")
    local kitchen
    for _, entry in ipairs(done.references.unmatched) do
        if entry.kind == "room" and entry.id == 10 then
            kitchen = entry
        end
    end
    T.eq(kitchen.name, "Kitchen")
    T.eq(kitchen.now, "Living Room")
end

function tests.a_store_not_read_at_start_is_never_overwritten()
    local old = start()
    furnish(old)
    local document = export(old)
    -- Director could not read the scenes at start: they may come back at the next one.
    local readable = false
    local s = start(nil, function(mock)
        mock.persist["directorlink_scenes"] = 'json:{"version":1,"scenes":[{"id":"0badbeef","name":"Kept","steps":[]}]}'
        local get = C4.PersistGetValue
        C4.PersistGetValue = function(self, name, encrypted)
            if name == "directorlink_scenes" and not readable then
                error("database is locked")
            end
            return get(self, name, encrypted)
        end
    end)
    readable = true
    local before = s.mock.persist["directorlink_scenes"]
    local check = restore(s, { document = document })
    T.eq(check.status, 503)
    T.eq(check.json.code, "UNAVAILABLE")
    T.eq(check.json.store, "scenes")
    T.eq(restore(s, { document = document, dry_run = false }).status, 503)
    T.eq(s.mock.persist["directorlink_scenes"], before, "the saved scenes stay, to come back at the next start")
end

function tests.names_and_preferences_are_cut_to_what_the_api_takes()
    local s = start()
    local document = export(s)
    local long = string.rep("A", 100000)
    local sections = document.sections
    sections.scenes.scenes = { { id = "0000abcd", name = long, steps = {}, version = 1 } }
    local profile = sections.profiles.profiles[1]
    profile.name = "  " .. string.rep("\215\144", 70) .. "  "
    profile.prefs.theme = "<b>x</b>"
    profile.prefs.palette = string.rep("p", 5000)
    profile.prefs.language = "not a language"
    local names = {}
    for first = 1, 26 do
        for second = 1, 26 do
            names[string.char(96 + first, 96 + second)] = "n"
        end
    end
    sections.room_names.rooms = { ["10"] = names, ["11"] = { he = long, en = "   " } }
    sections.keys.keys[#sections.keys.keys + 1] = { id = "0000abcd", name = long, role = "member", alg = "sha256", hash = string.rep("9c", 32), lock = string.rep("ad", 32) }
    -- Larger than a sealed request: as it runs once opened.
    T.eq(restore(s, { document = document, dry_run = false }, opened).status, 200)
    T.eq(#list(s.mock, s.key, "/v1/scenes").items[1].name, 64)
    local mine = list(s.mock, s.key, "/v1/profile")
    T.eq(mine.name, string.rep("\215\144", 64), "64 characters, trimmed")
    T.eq(tostring(mine.prefs.theme), "null")
    T.eq(tostring(mine.prefs.palette), "null")
    T.eq(tostring(mine.prefs.language), "null")
    local RoomNames = require("src.core.room_names")
    local count = 0
    for _ in pairs(RoomNames.get(10)) do
        count = count + 1
    end
    T.eq(count, RoomNames.MAX_LANGUAGES)
    T.eq(#RoomNames.get(11).he, 64)
    T.eq(RoomNames.get(11).en, nil)
    for _, key in ipairs(list(s.mock, s.key, "/v1/api-keys").items) do
        T.truthy(#key.name <= 64, "a key's name")
    end
end

-- The backup module's own timer that was set last and has not run.
local function sweepTimer(mock)
    for index = #mock.timers, 1, -1 do
        local timer = mock.timers[index]
        if not timer.cancelled and not timer.fired and (timer.source or ""):find("core/backup", 1, true) then
            return timer
        end
    end
end

function tests.each_key_has_its_own_upload_and_none_stays_past_its_ten_minutes()
    local s = start()
    local _, otherId = createKey(s, "Second admin", "admin")
    local Backup = require("src.core.backup")
    local text = Json.encode(export(s))
    local now = os.time()
    local mine = Backup.receivePart(s.id, { index = 0, count = 2, text = text:sub(1, 100) }, now)
    local theirs = Backup.receivePart(otherId, { index = 0, count = 1, text = text }, now)
    T.truthy(theirs.complete)
    local next, problem = Backup.receivePart(s.id, { upload = mine.upload, index = 1, count = 2, text = text:sub(101) }, now)
    T.eq(problem, nil, "another admin's upload does not replace this one")
    T.truthy(next.complete)
    T.truthy(Backup.uploaded(otherId, theirs.upload, now + 1))
    T.eq(Backup.held(), 2)
    -- At most three at once: a fourth key's replaces the one used longest ago.
    Backup.receivePart("0000aaaa", { index = 0, count = 1, text = "{}" }, now + 2)
    Backup.receivePart("0000bbbb", { index = 0, count = 1, text = "{}" }, now + 3)
    T.eq(Backup.held(), 3)
    T.eq(Backup.uploaded(s.id, mine.upload, now + 3), nil, "the one used longest ago went")
    T.truthy(Backup.uploaded(otherId, theirs.upload, now + 3))

    -- Ten minutes after the last use, the timer drops them all, and their memory with them.
    local clock = os.time
    os.time = function(t)
        return t and clock(t) or now + 3 + Backup.UPLOAD_SECONDS + 1
    end
    local ok, err = pcall(function()
        local timer = assert(sweepTimer(s.mock), "a timer for the uploads")
        timer.fired = true
        timer.callback()
    end)
    os.time = clock
    T.truthy(ok, err)
    T.eq(Backup.held(), 0)
end

-- ---- The remote identity ----------------------------------------------------------------------

-- The relay's last live timer of this delay.
local function timerOf(mock, delay)
    for index = #mock.timers, 1, -1 do
        local timer = mock.timers[index]
        if timer.delay == delay and not timer.cancelled and not timer.fired and (timer.source or ""):find("cloud/relay", 1, true) then
            return timer
        end
    end
end

local function fire(mock, delay)
    local timer = assert(timerOf(mock, delay), "a timer of " .. delay .. " ms")
    timer.fired = true
    timer.callback()
end

-- The request the driver makes to connect again, `delay` ms after the restore's answer.
local function reconnection(mock, connection)
    connection.sent = ""
    fire(mock, 2000)
    local closing = Harness.clientFrames(connection.sent)
    T.eq(closing[#closing].opcode, 8, "the connection there was is closed")
    connection.sent = ""
    fire(mock, 1000)
    OnConnectionStatusChanged(Harness.BINDING, 443, "ONLINE")
    local request = connection.sent
    connection.sent = ""
    return request
end

local function refuse()
    local body = '{"type":"about:blank","title":"Unauthorized","status":401,"code":"WRONG_HOME_SECRET"}'
    ReceivedFromNetwork(Harness.BINDING, 443, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/problem+json\r\n"
        .. "Content-Length: " .. #body .. "\r\n\r\n" .. body)
end

-- A restore sealed through the account, as the app sends it away from home; `extra`: more fields
-- of the request's body.
local function remoteRestore(s, connection, home, document, extra)
    counter = counter + 1
    local lock = Lock().deviceKey(s.key)
    local body = { document = document, dry_run = false }
    for name, value in pairs(extra or {}) do
        body[name] = value
    end
    local envelope = Lock().seal(lock, home, s.id, "req", Json.encode({
        id = "remote-" .. counter, ts = os.time(), method = "POST", path = "/v1/restore", body = body,
    }))
    local reply = Harness.relayRequest(s.mock, connection, { type = "e2e", id = "relay-" .. counter, envelope = envelope })
    T.truthy(reply.envelope, "answered sealed")
    return Json.decode(Json.decode(Lock().open(lock, reply.envelope, "res")).body)
end

function tests.the_same_home_keeps_its_connection_and_newer_secret()
    local s = start()
    local _, connection = Harness.connected({ mock = s.mock })
    local document = export(s)
    -- The owner replaced the home secret after the backup was made.
    local Relay = require("src.cloud.relay")
    local identity = Relay.identity()
    identity.home_secret = string.rep("5a", 32)
    local home = identity.home_id
    local result = remoteRestore(s, connection, home, document)
    T.eq(result.restore.remote.action, "same")
    T.eq(timerOf(s.mock, 2000), nil, "no new connection")
    T.eq(Relay.identity().home_secret, string.rep("5a", 32), "the newer secret stays")
    T.eq(stored(s.mock, "directorlink_remote_identity").home_secret, string.rep("5a", 32))
end

function tests.another_home_s_identity_is_used_once_the_answer_is_out_and_kept_when_the_relay_knows_it()
    local old = start()
    Harness.connected({ mock = old.mock })
    local document = export(old)
    local backupHome = document.sections.remote_identity
    -- The controller linked again after the accident: another home, connected.
    local s = start()
    local _, connection = Harness.connected({ mock = s.mock })
    local currentHome = T.http(s.mock, "GET", "/v1/remote", { key = s.key }).json.home_id
    T.truthy(currentHome ~= backupHome.home_id)
    -- Linked to another home in the account: it moves here only when the admin asks.
    local result = remoteRestore(s, connection, currentHome, document, { move_remote = true })
    T.eq(result.restore.origin.another_home, true)
    T.eq(result.restore.remote.action, "restore")
    T.eq(result.restore.remote.home_id, backupHome.home_id)
    T.eq(result.restore.remote.current_home_id, currentHome)
    T.eq(connection.disconnects, 0, "the answer went out on the connection there was")
    local saved = stored(s.mock, "directorlink_remote_identity")
    T.eq(saved.home_id, backupHome.home_id)
    T.eq(saved.previous.home_id, currentHome, "the controller's own is kept until the relay accepts the backup's")

    local request = reconnection(s.mock, connection)
    T.contains(request, "X-DirectorLink-Home: " .. backupHome.home_id)
    T.contains(request, "Authorization: Bearer " .. backupHome.home_secret)
    Harness.accept(request)
    local frames = Harness.clientFrames(connection.sent)
    local hello = Json.decode(frames[1].payload)
    T.eq(hello.type, "hello")
    T.eq(hello.home, backupHome.home_id)
    T.eq(Json.decode(frames[2].payload).type, "keys", "the restored keys are announced to that home")
    T.eq(stored(s.mock, "directorlink_remote_identity").previous, nil, "accepted: it is the home's now")
end

function tests.an_identity_the_relay_refuses_gives_way_to_the_controller_s_own()
    local old = start()
    Harness.connected({ mock = old.mock })
    local document = export(old)
    local s = start()
    local _, connection = Harness.connected({ mock = s.mock })
    local currentHome = T.http(s.mock, "GET", "/v1/remote", { key = s.key }).json.home_id
    local currentSecret = stored(s.mock, "directorlink_remote_identity").home_secret
    remoteRestore(s, connection, currentHome, document, { move_remote = true })
    local request = reconnection(s.mock, connection)
    T.contains(request, "X-DirectorLink-Home: " .. document.sections.remote_identity.home_id)
    -- Its secret was replaced after the backup was made: the relay does not accept it.
    refuse()
    T.contains(s.mock.properties["Remote Status"], "Reconnecting in 1 s")
    local saved = stored(s.mock, "directorlink_remote_identity")
    T.eq(saved.home_id, currentHome, "the controller's own identity is back")
    T.eq(saved.home_secret, currentSecret)
    T.eq(saved.previous, nil)
    connection.sent = ""
    fire(s.mock, 1000)
    OnConnectionStatusChanged(Harness.BINDING, 443, "ONLINE")
    T.contains(connection.sent, "X-DirectorLink-Home: " .. currentHome)
    Harness.accept(connection.sent)
    T.contains(s.mock.properties["Remote Status"], "home " .. currentHome:sub(1, 8) .. " (the relay refused the backup's home)", "Composer says so")
    local said = false
    for _, line in ipairs(s.mock.debugLog) do
        said = said or line:find("refused the remote identity restored from a backup", 1, true) ~= nil
    end
    T.truthy(said, "the log says so")
end

function tests.with_remote_access_off_the_backup_s_identity_waits_for_the_relay()
    local old = start()
    Harness.connected({ mock = old.mock })
    local document = export(old)
    -- This controller had remote access on after the accident, then off.
    local s = start()
    Harness.connected({ mock = s.mock })
    Properties["Remote Access"] = "Off"
    OnPropertyChanged("Remote Access")
    local own = stored(s.mock, "directorlink_remote_identity").home_id
    T.eq(restore(s, { document = document, dry_run = false, move_remote = true }).status, 200)
    T.eq(timerOf(s.mock, 2000), nil, "nothing to reconnect")
    local saved = stored(s.mock, "directorlink_remote_identity")
    T.eq(saved.home_id, document.sections.remote_identity.home_id)
    T.eq(saved.previous.home_id, own)
    local updated = Mock.updateDriver(s.mock)
    local _, _, request = Harness.connected({ mock = updated })
    T.contains(request, "X-DirectorLink-Home: " .. document.sections.remote_identity.home_id, "switched on later, it is tried then")
    T.eq(stored(updated, "directorlink_remote_identity").previous, nil)
end

function tests.a_backup_makes_no_remote_identity_and_holds_only_one_the_relay_accepted()
    -- Remote Access was never on: nothing to hold, and nothing is made for the backup.
    local s = start()
    T.eq(s.mock.persist["directorlink_remote_identity"], nil)
    local document = export(s)
    T.same(document.sections.remote_identity, { version = 1, linked = false })
    T.eq(s.mock.persist["directorlink_remote_identity"], nil, "no identity made")
    -- One the app asked about (GET /v1/remote makes it) that the relay never saw is not linked either.
    T.eq(T.http(s.mock, "GET", "/v1/remote", { key = s.key }).status, 200)
    T.eq(export(s).sections.remote_identity.linked, false)
    -- Once the relay has accepted it, a backup holds it.
    Harness.connected({ mock = s.mock })
    local linked = export(s).sections.remote_identity
    T.eq(linked.linked, true)
    T.eq(linked.home_id, stored(s.mock, "directorlink_remote_identity").home_id)
    -- The one without, restored onto a controller linked since, changes nothing there.
    local fresh = start()
    Harness.connected({ mock = fresh.mock })
    local own = stored(fresh.mock, "directorlink_remote_identity")
    local done = restore(fresh, { document = document, dry_run = false })
    T.eq(done.json.restore.remote.action, "none")
    T.eq(tostring(done.json.restore.remote.home_id), "null")
    T.eq(stored(fresh.mock, "directorlink_remote_identity").home_id, own.home_id)
    T.eq(timerOf(fresh.mock, 2000), nil, "no new connection")
end

function tests.another_home_s_backup_is_told_apart_and_its_identity_moves_only_when_asked()
    local old = start()
    furnish(old)
    Harness.connected({ mock = old.mock })
    local document = export(old)
    local backupHome = document.sections.remote_identity.home_id

    -- Another controller, linked to its home, whose project has none of the backup's devices.
    local project = Mock.project()
    for _, id in ipairs({ 20, 21, 30, 50 }) do
        Mock.removeDevice(project, id)
    end
    project.mac = "001122334455"
    local s = start(project)
    local _, connection = Harness.connected({ mock = s.mock })
    local own = stored(s.mock, "directorlink_remote_identity").home_id
    local other = Json.decode(Json.encode(document))
    other.home.name = "Cohen family"
    local check = restore(s, { document = other }).json.restore
    T.eq(check.origin.another_home, true)
    T.same(check.origin.reasons, { "home_id", "name", "references" })
    T.eq(check.origin.controller, "other")
    T.eq(check.remote.action, "kept", "its identity does not move here unasked")
    T.eq(check.remote.home_id, backupHome)
    T.eq(check.remote.current_home_id, own)
    local done = restore(s, { document = other, dry_run = false })
    T.eq(done.status, 200, done.body)
    T.eq(stored(s.mock, "directorlink_remote_identity").home_id, own, "this home stays linked as it is")
    T.eq(stored(s.mock, "directorlink_remote_identity").previous, nil)
    T.eq(timerOf(s.mock, 2000), nil, "and its connection stays")

    -- Asked: it moves, and the controller it was made on may still run with it.
    local moved = restore(s, { document = other, dry_run = false, move_remote = true }).json.restore
    T.eq(moved.remote.action, "restore")
    T.eq(moved.remote.old_controller, true)
    T.eq(stored(s.mock, "directorlink_remote_identity").home_id, backupHome)
    T.truthy(connection)

    -- A replacement controller with no identity yet: told apart by the controller it was made on.
    local replacement = Mock.project()
    replacement.mac = "665544332211"
    local r = start(replacement)
    local fresh = restore(r, { document = document }).json.restore
    T.same(fresh.origin.reasons, { "controller" })
    T.eq(fresh.remote.action, "kept")
    T.eq(restore(r, { document = document, dry_run = false, move_remote = true }).json.restore.remote.action, "restore")
    T.eq(stored(r.mock, "directorlink_remote_identity").home_id, backupHome)

    -- The same controller with its driver added again: its own backup, nothing to ask.
    local same = start()
    local again = restore(same, { document = document, dry_run = false }).json.restore
    T.eq(again.origin.another_home, false)
    T.eq(again.origin.controller, "same")
    T.eq(again.remote.action, "restore")
    T.eq(again.remote.old_controller, false)
end

function tests.a_backup_s_identity_is_checked_as_the_relay_takes_it()
    local old = start()
    Harness.connected({ mock = old.mock })
    local document = export(old)
    local function variant(change)
        local copy = Json.decode(Json.encode(document))
        change(copy.sections.remote_identity)
        return copy
    end
    local s = start()
    local status, code = problem(s, variant(function(identity)
        identity.home_id = identity.home_id:upper()
    end))
    T.eq(status, 422, "the relay takes a home id in lower case only")
    T.eq(code, "BACKUP_INVALID")
    T.eq(problem(s, variant(function(identity)
        identity.linked = nil
    end)), 422, "an identity not marked linked")
    -- At most the few waiting secrets the relay tries, none dated after now.
    local many = variant(function(identity)
        identity.home_secret = identity.home_secret:upper()
        identity.next_secrets = {}
        for index = 1, 500 do
            identity.next_secrets[index] = { secret = string.rep(string.format("%02x", index % 256), 32), at = index <= 2 and os.time() + 10 * 365 * 86400 or os.time() - index }
        end
    end)
    T.eq(restore(s, { document = many, dry_run = false }).status, 200)
    local saved = stored(s.mock, "directorlink_remote_identity")
    T.eq(saved.home_secret, document.sections.remote_identity.home_secret, "in lower case")
    T.eq(#saved.next_secrets, 3)
    for _, item in ipairs(saved.next_secrets) do
        T.truthy(item.at <= os.time(), "none dated ahead")
    end
end

function tests.an_identity_the_relay_finds_not_valid_gives_way_too()
    local old = start()
    Harness.connected({ mock = old.mock })
    local document = export(old)
    local s = start()
    local _, connection = Harness.connected({ mock = s.mock })
    local currentHome = T.http(s.mock, "GET", "/v1/remote", { key = s.key }).json.home_id
    remoteRestore(s, connection, currentHome, document, { move_remote = true })
    reconnection(s.mock, connection)
    local body = '{"type":"about:blank","title":"Bad Request","status":400,"code":"INVALID_HOME_SECRET"}'
    ReceivedFromNetwork(Harness.BINDING, 443, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/problem+json\r\n"
        .. "Content-Length: " .. #body .. "\r\n\r\n" .. body)
    T.eq(stored(s.mock, "directorlink_remote_identity").home_id, currentHome, "the controller's own is back")
    T.contains(s.mock.properties["Remote Status"], "Reconnecting in 1 s")
end

-- ---- A big home --------------------------------------------------------------------------------

-- Like the owner's: 111 lights in 40 rooms, 22 thermostats, 15 blinds; 50 scenes of 15 steps, 50
-- schedules, 20 keys with a profile each, 60 favorites each, and Hebrew names for every room.
local function bigProject()
    local project = Mock.project()
    for room = 1, 40 do
        Mock.addRoom(project, 200 + room, "Room " .. room)
    end
    for light = 1, 111 do
        Mock.addLight(project, 1000 + light, 5000 + light, 200 + (light % 40) + 1, "Light " .. light, 0)
    end
    return project
end

function tests.a_big_home_goes_both_ways_in_parts_that_fit_a_sealed_request()
    local s = start(bigProject())
    local Scenes = require("src.core.scenes")
    local Schedules = require("src.core.schedules")
    local Profiles = require("src.auth.profiles")
    local RoomNames = require("src.core.room_names")
    local sceneIds = {}
    for scene = 1, 50 do
        local steps = {}
        for step = 1, 15 do
            local ids = {}
            for index = 1, 8 do
                ids[index] = 1000 + ((scene * 15 + step * 8 + index) % 111) + 1
            end
            steps[step] = { type = "lights", device_ids = ids, set = { brightness = (scene + step) % 100 } }
        end
        local created = assert(Scenes.create({ name = "Scene " .. scene .. " — סצנה", steps = steps }))
        sceneIds[scene] = created.id
    end
    for index = 1, 50 do
        assert(Schedules.create(assert(Schedules.check({ scene_id = sceneIds[index], trigger = { type = "time", at = string.format("%02d:%02d", index % 24, index % 60) }, days = Json.array({ 0, 1, 2, 3, 4, 5, 6 }) }))))
    end
    for index = 1, 19 do
        createKey(s, "Phone " .. index, index % 2 == 0 and "member" or "viewer")
    end
    local favorites = Json.array()
    for index = 1, 60 do
        favorites[index] = "light:" .. (1000 + index)
    end
    for _, profile in ipairs(Profiles.list()) do
        Profiles.updatePrefs(profile.id, { favorites = favorites, language = "he" })
    end
    for room = 1, 40 do
        RoomNames.update(200 + room, { he = "חדר מספר " .. room, en = "Room number " .. room })
    end

    local document, text = export(s, opened)
    T.truthy(#text > 100 * 1024, "a big document: " .. #text .. " bytes")
    T.eq(#document.sections.scenes.scenes, 50)
    local scenes = list(s.mock, s.key, "/v1/scenes").items

    local fresh = start(bigProject())
    local id, largest = upload(fresh, text, 30000, opened)
    T.truthy(largest < 64 * 1024, "every part fits the 64 KiB a request at home may have: " .. largest)
    local check = restore(fresh, { upload = id }, opened)
    T.eq(check.status, 200, check.body)
    T.eq(check.json.restore.counts.scenes, 50)
    T.eq(check.json.restore.counts.schedules, 50)
    T.eq(check.json.restore.counts.keys, 21)
    T.eq(check.json.restore.counts.room_names, 40)
    T.eq(check.json.restore.references.unmatched_count, 0)
    local done = restore(fresh, { upload = id, dry_run = false }, opened)
    T.eq(done.status, 200, done.body)
    T.same(list(fresh.mock, s.key, "/v1/scenes").items, scenes)
    T.eq(#list(fresh.mock, s.key, "/v1/profile").prefs.favorites, 60)

    -- What the driver itself does (the controller's C4:Encrypt seals natively; the fake Director's
    -- AES here is plain Lua): on this PC, where the CORE-1's Cortex-A53 is some ten times slower.
    local Backup = require("src.core.backup")
    local Registry = require("src.core.registry")
    local started = os.clock()
    local encoded = Json.encode(Backup.export(Registry))
    local exported = os.clock() - started
    started = os.clock()
    local plan = Backup.plan(Json.decode(encoded), { registry = Registry, restorer = fresh.id })
    T.truthy(Backup.apply(plan))
    local restored = os.clock() - started
    T.truthy(exported < 0.5 and restored < 0.5, string.format("export %.2f s, restore %.2f s", exported, restored))
end

function tests.through_the_account_a_backup_comes_sealed_end_to_end()
    local s = start()
    furnish(s)
    local _, connection = Harness.connected({ mock = s.mock })
    local home = T.http(s.mock, "GET", "/v1/remote", { key = s.key }).json.home_id
    local lock = Lock().deviceKey(s.key)
    local envelope = Lock().seal(lock, home, s.id, "req", Json.encode({ id = "remote-backup", ts = os.time(), method = "GET", path = "/v1/backup" }))
    local reply, frame = Harness.relayRequest(s.mock, connection, { type = "e2e", id = "relay-backup", envelope = envelope })
    local answer = Json.decode(Lock().open(lock, reply.envelope, "res"))
    T.eq(answer.status, 200)
    local document = Json.decode(answer.body)
    T.eq(#document.sections.scenes.scenes, 2)
    for _, secret in ipairs({ document.sections.remote_identity.home_secret, document.sections.keys.keys[1].lock, "Good night" }) do
        T.notContains(frame.payload, secret, "the relay sees nothing of it")
    end
end

-- ---- The Sonos room choices (1.6.0, ADR-048) ------------------------------------------------------

local KITCHEN_AMP = "RINCON_000E58A0B1C201400"
local LOUNGE_AMP = "RINCON_000E58A0B1C201401"

-- Rooms an admin chose for two Sonos players, as src/sonos/rooms.lua keeps them.
local function withSonosRooms(rooms)
    return function(mock)
        mock.persist["directorlink_sonos_rooms"] = "json:" .. Json.encode({ version = 1, rooms = rooms })
    end
end

local CHOSEN = {
    [KITCHEN_AMP] = { room_id = 10, name = "Kitchen Amp" },
    [LOUNGE_AMP] = { room_id = 11, name = "Lounge" },
}

function tests.the_sonos_room_choices_go_into_a_backup_and_come_back()
    local old = start(nil, withSonosRooms(CHOSEN))
    local document = export(old)
    T.same(document.sections.sonos_rooms, { version = 1, rooms = CHOSEN }, "as the store keeps them")
    T.eq(document.references.rooms["11"].name, "Living Room", "with the rooms' names, to match them")
    local s = start()
    local done, preview = replace(s, document)
    T.eq(preview.counts.sonos_rooms, 2)
    T.eq(done.counts.sonos_rooms, 2)
    T.same(stored(s.mock, "directorlink_sonos_rooms").rooms, CHOSEN)
    local Rooms = require("src.sonos.rooms")
    T.eq(Rooms.choice(KITCHEN_AMP), 10, "in use at once")
    T.eq(Rooms.choice(LOUNGE_AMP), 11)
    Mock.updateDriver(s.mock)
    T.eq(require("src.sonos.rooms").choice(LOUNGE_AMP), 11, "and after the next start")
end

function tests.a_sonos_room_follows_its_name_and_one_that_is_gone_is_listed()
    local document = export(start(nil, withSonosRooms(CHOSEN)))
    -- The project was rebuilt: the kitchen and the living room swapped ids.
    local s = start(swappedRooms())
    local done = replace(s, document)
    T.eq(done.counts.sonos_rooms, 2)
    local Rooms = require("src.sonos.rooms")
    T.eq(Rooms.choice(KITCHEN_AMP), 11, "the kitchen by its name")
    T.eq(Rooms.choice(LOUNGE_AMP), 10)
    -- A room that is not in the project any more (its devices moved to the kitchen).
    local project = Mock.project()
    for id, device in pairs(project.devices) do
        if device.roomId == 11 then
            Mock.moveDevice(project, id, 10)
        end
    end
    Mock.removeRoom(project, 11)
    local other = start(project)
    local result = replace(other, document)
    T.eq(result.counts.sonos_rooms, 1)
    T.eq(require("src.sonos.rooms").choice(LOUNGE_AMP), nil, "shown in the room of its own name again")
    local listed
    for _, entry in ipairs(result.references.unmatched) do
        if entry.kind == "room" and entry.id == 11 then
            listed = entry
        end
    end
    T.truthy(listed, "the room is listed")
    T.same(listed.used_in, { { section = "sonos_rooms", name = "Lounge" } }, "with the player that used it")
end

-- A backup made by 1.5.0 has no Sonos rooms: it restores as before, and the choices made on this
-- controller stay.
function tests.a_backup_from_before_1_6_0_restores_and_keeps_the_sonos_rooms()
    local newer = export(start(nil, withSonosRooms(CHOSEN)))
    local document = export(start())
    document.driver_version = "1.5.0"
    document.sections.sonos_rooms = nil
    local s = start(nil, withSonosRooms({ [KITCHEN_AMP] = { room_id = 11, name = "Kitchen Amp" } }))
    local before = s.mock.persist["directorlink_sonos_rooms"]
    local done, preview = replace(s, document)
    T.eq(tostring(preview.counts.sonos_rooms), "null", "none in the backup")
    T.eq(done.counts.scenes, 0)
    T.eq(s.mock.persist["directorlink_sonos_rooms"], before, "not written")
    T.eq(require("src.sonos.rooms").choice(KITCHEN_AMP), 11)
    -- Nor do they stop a restore when they could not be read at start.
    local unread = start(nil, function(mock)
        withSonosRooms(CHOSEN)(mock)
        local get = C4.PersistGetValue
        C4.PersistGetValue = function(self, name, encrypted)
            if name == "directorlink_sonos_rooms" then
                error("database is locked")
            end
            return get(self, name, encrypted)
        end
    end)
    T.eq(restore(unread, { document = document }).status, 200)
    local refused = restore(unread, { document = newer })
    T.eq(refused.status, 503, "a backup with Sonos rooms would overwrite those not read")
    T.eq(refused.json.store, "sonos_rooms")
end

function tests.a_failed_write_of_the_sonos_rooms_puts_every_store_back()
    local document = export(start(nil, withSonosRooms(CHOSEN)))
    local s = start(nil, withSonosRooms({ [KITCHEN_AMP] = { room_id = 11, name = "Kitchen Amp" } }))
    local mine = T.http(s.mock, "POST", "/v1/scenes", { key = s.key, body = { name = "Mine", steps = {} } })
    T.eq(mine.status, 201)
    local write = C4.PersistSetValue
    C4.PersistSetValue = function(self, name, value, encrypted)
        if name == "directorlink_sonos_rooms" then
            error("storage full")
        end
        return write(self, name, value, encrypted)
    end
    local failed = restore(s, { document = document, dry_run = false })
    C4.PersistSetValue = write
    T.eq(failed.status, 500)
    T.eq(failed.json.store, "sonos_rooms")
    T.eq(list(s.mock, s.key, "/v1/scenes").items[1].name, "Mine", "the scenes from before")
    T.eq(require("src.sonos.rooms").choice(KITCHEN_AMP), 11)
end

function tests.a_restore_waits_for_the_project()
    -- Director could not list the devices at start: nothing can be matched yet.
    local s = start(nil, function()
        C4.GetDevices = function()
            error("Director is busy")
        end
    end)
    local answer = restore(s, { document = export(s) })
    T.eq(answer.status, 503)
    T.eq(answer.json.code, "PROJECT_NOT_READY")
end

return tests
