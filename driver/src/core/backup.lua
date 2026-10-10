-- Backups (ADR-042, docs/BACKUP.md): everything DirectorLink keeps on the controller, in one
-- document an admin downloads (GET /v1/backup) and restores (POST /v1/restore), only in sealed
-- requests: it holds every key's hash and lock key and the home's remote identity. The app encrypts
-- it with a password before it is saved and decrypts it before it comes back; the controller never
-- sees the password or the file.
--
-- A restore checks the whole document first, then replaces every store together or none: when a
-- write fails, the values from before are put back. What refers to the project's devices and rooms
-- by id (scene steps, favorites, hidden rooms, room names, the room order and the rooms chosen for
-- Sonos players) is matched to the project as it is now: by id, else by the same name in the same
-- room; what matches nothing is left out and listed. Doors and gates are never moved to another
-- device. The backup's keys come back only onto a controller where nothing but the restoring
-- device is paired; otherwise every key stays as it is. Another home's backup is told apart, and
-- its remote identity moves here only when the admin asks. Composer properties are never restored,
-- only listed: a file must never switch a safety setting on.

local Clock = require("src.core.clock")
local Json = require("src.core.json")
local Log = require("src.core.log")
local Random = require("src.core.random")
local Version = require("src.core.version")
local Keys = require("src.auth.keys")
local Profiles = require("src.auth.profiles")
local People = require("src.auth.people")
local RoomNames = require("src.core.room_names")
local RoomLayout = require("src.core.room_layout")
local Scenes = require("src.core.scenes")
local Schedules = require("src.core.schedules")
local JewishCalendar = require("src.core.jewish_calendar")
local Relay = require("src.cloud.relay")
local SonosRooms = require("src.sonos.rooms")
local SceneLinks = require("src.core.scene_links")
local DoorbellDoors = require("src.core.doorbell_doors")

local Backup = {}

Backup.FORMAT = "directorlink-backup"
Backup.FORMAT_VERSION = 1
-- The document comes back as its JSON text in parts (POST /v1/restore/parts), each small enough for
-- a sealed request at home (64 KiB of HTTP body) and through the account.
Backup.MAX_BYTES = 2 * 1024 * 1024
Backup.MAX_PART_BYTES = 48 * 1024
Backup.MAX_PARTS = 100
Backup.UPLOAD_SECONDS = 600
-- Uploads held at once: one per key, at most this many in all (the one used longest ago goes).
Backup.MAX_UPLOADS = 3
-- References that match nothing, listed one by one in a preview (all are counted).
Backup.MAX_LISTED = 100
-- DirectorLink's Composer properties: listed in the preview, never restored.
Backup.COMPOSER = { "Door Control", "Relay Hold", "Schedules", "Jewish Calendar", "Alarm Status", "Remote Access", "Log Level" }

-- Each section: the newest version of its store this driver reads (an older one is read as an
-- update reads it), and what it is. An `optional` one may be missing (a backup made before it
-- existed): then what this controller has stays as it is.
local SECTIONS = {
    keys = { version = Keys.STORE_VERSION, list = "keys" },
    profiles = { version = 1, list = "profiles" },
    room_names = { version = 1, object = "rooms" },
    room_order = { version = 1, list = "order" },
    scenes = { version = 1, list = "scenes" },
    schedules = { version = 1, list = "schedules" },
    calendar = { version = 1, object = "settings" },
    remote_identity = { version = 1 },
    -- The Sonos room choices (src/sonos/rooms.lua), from 1.6.0 (ADR-048).
    sonos_rooms = { version = 1, object = "rooms", optional = true },
    -- The scene links (src/core/scene_links.lua), hashes only, from 1.7.0 (ADR-051).
    scene_links = { version = SceneLinks.STORE_VERSION, list = "links", optional = true },
    -- People's roles and permissions, the owner and the rooms hidden from members
    -- (src/auth/people.lua), from 1.8.0 (ADR-054).
    people = { version = People.STORE_VERSION, object = "people", optional = true },
    -- The doors and gates an admin linked to a doorbell (src/core/doorbell_doors.lua), from 1.11.0
    -- (ADR-078).
    doorbell_doors = { version = DoorbellDoors.STORE_VERSION, object = "links", optional = true },
}

-- Scene step types and favorites ("kind:id") name the kinds of the project's devices so.
local STEP_KINDS = { lights = "light", climate = "climate", fans = "fan", blinds = "blind", relays = "relay", refrigerators = "refrigerator" }
local FAVORITE_KINDS = { light = "light", thermostat = "climate", fan = "fan", blind = "blind", camera = "camera", relay = "relay", doorbell = "doorbell", refrigerator = "refrigerator" }
-- What opens doors and gates: kept only on the device (or room) with the same id and the same
-- name, never moved to another one, which would open the wrong door.
local DOOR_KINDS = { relay = true, doorbell = true }
-- A waiting replacement for the home secret dated later than this after the restore's clock is
-- not kept (made while a clock ran ahead, it would be kept for good).
local CLOCK_MARGIN = 3600
local PALETTE = "^%l[%l%d%-]*$"

local function isWhole(value, minimum, maximum)
    return type(value) == "number" and value == math.floor(value) and value >= minimum and value <= maximum
end

local function isObject(value)
    return type(value) == "table" and value ~= Json.null and not Json.isArray(value)
end

local function isHex(value, length)
    return type(value) == "string" and #value == length and value:match("^%x+$") ~= nil
end

local function isLowerHex(value, length)
    return type(value) == "string" and #value == length and value:match("^[0-9a-f]+$") ~= nil
end

local function items(list)
    local result = {}
    if type(list) == "table" and list ~= Json.null then
        for _, item in ipairs(list) do
            result[#result + 1] = item
        end
    end
    return result
end

local function nullable(value)
    if value == nil then
        return Json.null
    end
    return value
end

-- A name as the API takes one (src/api/validate.lua: trimmed, 1 to 64 characters), cut to 64
-- characters; `fallback` when there is none.
local function cleanName(value, fallback)
    if type(value) ~= "string" then
        return fallback
    end
    local trimmed = value:gsub("^%s+", ""):gsub("%s+$", "")
    if trimmed == "" then
        return fallback
    end
    -- A character starts at a byte that is not a UTF-8 continuation byte.
    local count = 0
    for position = 1, #trimmed do
        local byte = trimmed:byte(position)
        if byte < 128 or byte >= 192 then
            count = count + 1
            if count > 64 then
                return trimmed:sub(1, position - 1)
            end
        end
    end
    return trimmed
end

-- ---- The document ----------------------------------------------------------------------------

-- The project's name: its site, the top of Composer's project tree.
local function homeName(registry)
    local found
    for id, location in pairs(registry.locations or {}) do
        if location.type == "site" and (not found or tonumber(id) < found.id) then
            found = { id = tonumber(id), name = location.name }
        end
    end
    return found and found.name or nil
end

-- Calls visit(kind, id) for every device a section names ("room" for rooms).
local function eachReference(sections, visit)
    for _, scene in ipairs(items(sections.scenes and sections.scenes.scenes)) do
        for _, step in ipairs(items(type(scene) == "table" and scene.steps or nil)) do
            if type(step) == "table" then
                if tonumber(step.room_id) then
                    visit("room", tonumber(step.room_id))
                end
                -- The rooms a music step plays a favorite in besides its own (1.8.0, ADR-057).
                for _, id in ipairs(items(isObject(step.set) and step.set.with_room_ids or nil)) do
                    if tonumber(id) then
                        visit("room", tonumber(id))
                    end
                end
                for _, id in ipairs(items(step.device_ids)) do
                    if tonumber(id) then
                        visit(STEP_KINDS[step.type], tonumber(id))
                    end
                end
            end
        end
    end
    for _, profile in ipairs(items(sections.profiles and sections.profiles.profiles)) do
        local prefs = type(profile) == "table" and type(profile.prefs) == "table" and profile.prefs or {}
        for _, entry in ipairs(items(prefs.favorites)) do
            local kind, id = tostring(entry):match("^(%l+):(%d+)$")
            if kind then
                visit(FAVORITE_KINDS[kind], tonumber(id))
            end
        end
        for _, id in ipairs(items(prefs.hidden_rooms)) do
            if tonumber(id) then
                visit("room", tonumber(id))
            end
        end
    end
    local names = sections.room_names and sections.room_names.rooms
    for id in pairs(isObject(names) and names or {}) do
        if tonumber(id) then
            visit("room", tonumber(id))
        end
    end
    for _, id in ipairs(items(sections.room_order and sections.room_order.order)) do
        if tonumber(id) then
            visit("room", tonumber(id))
        end
    end
    local sonos = sections.sonos_rooms and sections.sonos_rooms.rooms
    for _, choice in pairs(isObject(sonos) and sonos or {}) do
        if isObject(choice) and tonumber(choice.room_id) then
            visit("room", tonumber(choice.room_id))
        end
    end
    local people = sections.people
    for _, person in pairs(isObject(people) and isObject(people.people) and people.people or {}) do
        for _, id in ipairs(items(isObject(person) and person.rooms or nil)) do
            if tonumber(id) then
                visit("room", tonumber(id))
            end
        end
    end
    for _, id in ipairs(items(isObject(people) and people.hidden_rooms or nil)) do
        if tonumber(id) then
            visit("room", tonumber(id))
        end
    end
    local links = sections.doorbell_doors and sections.doorbell_doors.links
    for doorbellId, doors in pairs(isObject(links) and links or {}) do
        if tonumber(doorbellId) then
            visit("doorbell", tonumber(doorbellId))
        end
        for _, id in ipairs(items(doors)) do
            if tonumber(id) then
                visit("relay", tonumber(id))
            end
        end
    end
end

-- The names of the rooms and devices the sections name, as the project has them now: what a
-- restore matches by name when an id no longer fits.
local function references(registry, sections)
    local rooms, devices = {}, {}
    local function addRoom(id)
        local room = (registry.rooms or {})[id]
        if room then
            rooms[tostring(id)] = { name = room.name }
        end
    end
    eachReference(sections, function(kind, id)
        if kind == "room" then
            addRoom(id)
            return
        end
        local device = (registry.devices or {})[id]
        if device then
            devices[tostring(id)] = { name = device.name, kind = device.kind, room_id = nullable(tonumber(device.room_id)) }
            if tonumber(device.room_id) then
                addRoom(tonumber(device.room_id))
            end
        end
    end)
    return { rooms = rooms, devices = devices }
end

-- This controller, as a backup names it: a hash of its MAC address (C4:GetUniqueMAC), the same
-- after the driver is removed and added again, another on a replacement. nil when Director does
-- not give it: then the home id and the other signs decide (Backup.plan).
function Backup.controllerId()
    local ok, mac = pcall(function()
        return C4:GetUniqueMAC()
    end)
    if not ok or type(mac) ~= "string" or mac == "" then
        return nil
    end
    local hashed, hash = pcall(C4.Hash, C4, "SHA256", "DirectorLink controller " .. mac:lower(), { return_encoding = "HEX" })
    if hashed and type(hash) == "string" and #hash == 64 then
        return hash:lower():sub(1, 32)
    end
    return nil
end

local function composerValues()
    local values = {}
    for _, name in ipairs(Backup.COMPOSER) do
        values[name] = nullable(Properties and Properties[name] or nil)
    end
    return values
end

-- The document GET /v1/backup answers (docs/BACKUP.md).
function Backup.export(registry)
    local sections = {
        keys = Keys.backup(),
        profiles = Profiles.backup(),
        room_names = RoomNames.backup(),
        room_order = RoomLayout.backup(),
        scenes = Scenes.backup(),
        schedules = Schedules.backup(),
        calendar = JewishCalendar.backup(),
        remote_identity = Relay.backupIdentity(),
        sonos_rooms = SonosRooms.backup(),
        scene_links = SceneLinks.backup(),
        people = People.backup(),
        doorbell_doors = DoorbellDoors.backup(),
    }
    return {
        format = Backup.FORMAT,
        format_version = Backup.FORMAT_VERSION,
        driver_version = Version.BRIDGE_VERSION,
        created_at = Clock.iso(),
        home = { name = nullable(homeName(registry)) },
        controller_id = nullable(Backup.controllerId()),
        composer = composerValues(),
        references = references(registry, sections),
        sections = sections,
    }
end

-- ---- Parts of a document on its way back -------------------------------------------------------

-- One upload per key (its next first part replaces it), at most MAX_UPLOADS in all; each is dropped
-- UPLOAD_SECONDS after its last use, by a timer too, so that a backup checked and then left does
-- not stay in the controller's memory (some MB for a big one).
local uploads = {}
local sweeper = nil

local function uploadProblem(code, detail)
    return nil, { status = code == "UPLOAD_NOT_FOUND" and 404 or 400, code = code, detail = detail }
end

-- Drops the uploads whose time has passed.
function Backup.sweep(now)
    now = now or Clock.now()
    for keyId, upload in pairs(uploads) do
        if now > upload.expires then
            uploads[keyId] = nil
        end
    end
end

-- The timer that drops the next upload whose time passes (kept referenced, one at a time).
local function scheduleSweep(now)
    if sweeper then
        pcall(function()
            sweeper:Cancel()
        end)
        sweeper = nil
    end
    local soonest = nil
    for _, upload in pairs(uploads) do
        if not soonest or upload.expires < soonest then
            soonest = upload.expires
        end
    end
    if not soonest then
        return
    end
    pcall(function()
        sweeper = C4:SetTimer((math.max(soonest - now, 0) + 1) * 1000, function()
            sweeper = nil
            local at = Clock.now()
            Backup.sweep(at)
            scheduleSweep(at)
        end, false)
    end)
end

-- A part of the document's JSON text: { upload (after the first), index (from 0), count, text }.
-- Returns { upload, received, count, complete }, or nil and a problem.
function Backup.receivePart(keyId, body, now)
    Backup.sweep(now)
    local count, index, text = body.count, body.index, body.text
    if not isWhole(count, 1, Backup.MAX_PARTS) then
        return uploadProblem("INVALID_FIELD", "count is how many parts there are, 1 to " .. Backup.MAX_PARTS)
    end
    if not isWhole(index, 0, count - 1) then
        return uploadProblem("INVALID_FIELD", "index is this part's place, from 0")
    end
    if type(text) ~= "string" or text == "" or #text > Backup.MAX_PART_BYTES then
        return uploadProblem("INVALID_FIELD", "text is a part of the backup's JSON, at most " .. Backup.MAX_PART_BYTES .. " bytes")
    end
    local upload = uploads[keyId]
    if index == 0 then
        if body.upload ~= nil then
            return uploadProblem("INVALID_FIELD", "The first part starts a new upload: leave out upload")
        end
        if not upload then
            local held, oldest = 0, nil
            for otherKey, other in pairs(uploads) do
                held = held + 1
                if not oldest or other.expires < uploads[oldest].expires then
                    oldest = otherKey
                end
            end
            if held >= Backup.MAX_UPLOADS then
                uploads[oldest] = nil
            end
        end
        upload = { id = Random.hex(16), count = count, parts = { text }, bytes = #text, expires = now + Backup.UPLOAD_SECONDS }
        uploads[keyId] = upload
    else
        if not upload or upload.id ~= body.upload or not upload.parts then
            return uploadProblem("UPLOAD_NOT_FOUND", "No upload with this id is waiting; send the backup again from its first part")
        end
        if upload.count ~= count or index ~= #upload.parts then
            return uploadProblem("INVALID_FIELD", "Send the parts in order: part " .. #upload.parts .. " of " .. upload.count .. " is next")
        end
        if upload.bytes + #text > Backup.MAX_BYTES then
            uploads[keyId] = nil
            scheduleSweep(now)
            return uploadProblem("BACKUP_TOO_LARGE", "A backup is at most " .. Backup.MAX_BYTES .. " bytes")
        end
        upload.parts[#upload.parts + 1] = text
        upload.bytes = upload.bytes + #text
        upload.expires = now + Backup.UPLOAD_SECONDS
    end
    scheduleSweep(now)
    return { upload = upload.id, received = #upload.parts, count = upload.count, complete = #upload.parts == upload.count }
end

-- The document an upload of `keyId` carried, once all its parts are in (read once, then kept for
-- the restore that follows its check); nil and a problem otherwise.
function Backup.uploaded(keyId, id, now)
    Backup.sweep(now)
    local upload = uploads[keyId]
    if not upload or upload.id ~= id then
        return uploadProblem("UPLOAD_NOT_FOUND", "No upload with this id is waiting; send the backup again")
    end
    if upload.parts then
        if #upload.parts ~= upload.count then
            return nil, { status = 409, code = "UPLOAD_INCOMPLETE", detail = "Part " .. #upload.parts .. " of " .. upload.count .. " is next" }
        end
        local document, err = Json.decode(table.concat(upload.parts))
        upload.parts = nil
        if type(document) ~= "table" then
            uploads[keyId] = nil
            scheduleSweep(now)
            return nil, { status = 422, code = "BACKUP_INVALID", detail = "The backup is not valid JSON: " .. tostring(err) }
        end
        upload.document = document
    end
    upload.expires = now + Backup.UPLOAD_SECONDS
    scheduleSweep(now)
    return upload.document
end

-- How many uploads are held now.
function Backup.held()
    local count = 0
    for _ in pairs(uploads) do
        count = count + 1
    end
    return count
end

-- The upload of `keyId` was restored: it goes.
function Backup.forget(keyId, id)
    if uploads[keyId] and uploads[keyId].id == id then
        uploads[keyId] = nil
        scheduleSweep(Clock.now())
    end
end

-- ---- Checking a document ---------------------------------------------------------------------

local function versionNumbers(text)
    local major, minor, patch = tostring(text or ""):match("^(%d+)%.(%d+)%.(%d+)")
    if major then
        return { tonumber(major), tonumber(minor), tonumber(patch) }
    end
    return nil
end

-- True when `version` is a DirectorLink newer than `installed` (a development build is neither).
function Backup.newer(version, installed)
    local backup, mine = versionNumbers(version), versionNumbers(installed)
    if not backup or not mine then
        return false
    end
    for index = 1, 3 do
        if backup[index] ~= mine[index] then
            return backup[index] > mine[index]
        end
    end
    return false
end

local function invalid(errors)
    local detail = errors[1] and errors[1].message or "The backup is not valid"
    return nil, { status = 422, code = "BACKUP_INVALID", detail = detail, errors = errors }
end

local function tooNew(detail)
    return nil, { status = 409, code = "BACKUP_TOO_NEW", detail = detail }
end

local function absent(value)
    return value == nil or value == Json.null
end

-- The remote identity as the relay accepts one (cloud/src/index.js): a home id of 32 lower-case
-- hex digits, a secret of 64 hex digits, and the replacements waiting for approval. A backup made
-- where the relay had accepted none holds none (`linked` false).
local function validIdentity(section)
    if section.linked ~= true then
        return (absent(section.linked) or section.linked == false) and absent(section.home_id) and absent(section.home_secret)
    end
    if not isLowerHex(section.home_id, 32) or not isHex(section.home_secret, 64) then
        return false
    end
    if not absent(section.next_secrets) then
        if type(section.next_secrets) ~= "table" then
            return false
        end
        for _, item in ipairs(section.next_secrets) do
            if type(item) ~= "table" or not isHex(item.secret, 64) or not isWhole(item.at, 0, math.huge) then
                return false
            end
        end
    end
    return true
end

-- The document's own checks: what it is, from which DirectorLink, and a section of the right shape
-- for every store. Returns true, or nil and a problem.
local function validate(document)
    if not isObject(document) or document.format ~= Backup.FORMAT then
        return invalid({ { field = "format", message = "This is not a DirectorLink backup" } })
    end
    if not isWhole(document.format_version, 1, math.huge) then
        return invalid({ { field = "format_version", message = "format_version is missing" } })
    end
    if document.format_version > Backup.FORMAT_VERSION or Backup.newer(document.driver_version, Version.BRIDGE_VERSION) then
        return tooNew("This backup was made by DirectorLink " .. tostring(document.driver_version)
            .. ", newer than this one (" .. tostring(Version.BRIDGE_VERSION) .. "). Update DirectorLink first.")
    end
    if type(document.created_at) ~= "string" or type(document.driver_version) ~= "string" then
        return invalid({ { field = "created_at", message = "created_at and driver_version say when and by which DirectorLink the backup was made" } })
    end
    local sections = document.sections
    if not isObject(sections) then
        return invalid({ { field = "sections", message = "sections is missing" } })
    end
    local errors = {}
    for name in pairs(sections) do
        if not SECTIONS[name] then
            errors[#errors + 1] = { field = "sections." .. tostring(name), message = "Unknown section: " .. tostring(name) }
        end
    end
    for name, rule in pairs(SECTIONS) do
        local section = sections[name]
        local field = "sections." .. name
        if rule.optional and absent(section) then
            sections[name] = nil
        elseif not isObject(section) then
            errors[#errors + 1] = { field = field, message = "The backup has no " .. name }
        elseif not isWhole(section.version, 1, math.huge) then
            errors[#errors + 1] = { field = field .. ".version", message = name .. " has no version" }
        elseif section.version > rule.version then
            return tooNew("This backup's " .. name .. " were saved by a newer DirectorLink (store version " .. section.version .. "). Update DirectorLink first.")
        elseif rule.list and not (type(section[rule.list]) == "table" and (Json.isArray(section[rule.list]) or next(section[rule.list]) == nil)) then
            errors[#errors + 1] = { field = field .. "." .. rule.list, message = name .. " must have a list " .. rule.list }
        elseif rule.object and not isObject(section[rule.object]) then
            errors[#errors + 1] = { field = field .. "." .. rule.object, message = name .. " must have an object " .. rule.object }
        elseif name == "remote_identity" and not validIdentity(section) then
            errors[#errors + 1] = { field = field, message = "The remote identity is not one the relay accepts" }
        end
    end
    if #errors > 0 then
        table.sort(errors, function(a, b)
            return a.field < b.field
        end)
        return invalid(errors)
    end
    return true
end

-- ---- Matching the project ----------------------------------------------------------------------

-- Matches the backup's room and device ids to the project (`registry`), with what the backup says
-- of them (`refs`: its references), and keeps count for the preview.
local function newMatcher(registry, refs)
    refs = isObject(refs) and refs or {}
    return {
        registry = registry,
        rooms = isObject(refs.rooms) and refs.rooms or {},
        devices = isObject(refs.devices) and refs.devices or {},
        found = {},
        byId = 0,
        byName = {},
        renamed = {},
        unmatched = {},
        missing = {},
    }
end

local function infoName(info)
    return isObject(info) and type(info.name) == "string" and info.name or nil
end

-- The room a backup's room id is now: the same id with the same name; else the one other room of
-- that name (the ids were swapped, or the room was made again); else the same id with another name
-- (renamed). `strict` (a step that opens doors): only the same id with the same name.
local function findRoom(m, id, strict)
    local rooms = m.registry.rooms or {}
    local room = rooms[id]
    local name = infoName(m.rooms[tostring(id)])
    if room and room.name == name then
        return id, "id"
    end
    if strict then
        return nil
    end
    if name then
        local match, count = nil, 0
        for roomId, candidate in pairs(rooms) do
            if candidate.name == name and tonumber(roomId) ~= id then
                match, count = tonumber(roomId), count + 1
            end
        end
        if count == 1 then
            return match, "name"
        end
    end
    if room then
        return id, "id"
    end
    return nil
end

-- Whether `device` is of `kind`: a camera that is a doorbell (ADR-065) is a doorbell too.
local function isKind(device, kind)
    return device ~= nil and (device.kind == kind or (kind == "doorbell" and device.kind == "camera" and type(device.doorbell) == "table"))
end

-- The device of `kind` a backup's device id is now: the same id, still a device of that kind, with
-- the same name; else the one other device of that kind with that name in the same room (the ids
-- were swapped, or it was added again); else the same id with another name (renamed). Doors and
-- gates (DOOR_KINDS): only the same id with the same name, never another device.
local function findDevice(m, id, kind)
    local devices = m.registry.devices or {}
    local device = devices[id]
    local same = isKind(device, kind)
    local info = m.devices[tostring(id)]
    local name = infoName(info)
    if same and device.name == name then
        return id, "id"
    end
    if DOOR_KINDS[kind] then
        return nil
    end
    if name then
        local placed = tonumber(info.room_id) ~= nil
        local room = placed and findRoom(m, tonumber(info.room_id)) or nil
        -- In a room that is gone, a name tells no device apart.
        if room or not placed then
            local match, count = nil, 0
            for deviceId, candidate in pairs(devices) do
                if candidate.kind == kind and candidate.name == name and tonumber(deviceId) ~= id and (room == nil or tonumber(candidate.room_id) == room) then
                    match, count = tonumber(deviceId), count + 1
                end
            end
            if count == 1 then
                return match, "name"
            end
        end
    end
    if same then
        return id, "id"
    end
    return nil
end

local function roomLabel(m, roomId)
    local info = m.rooms[tostring(roomId)]
    return infoName(info)
end

-- Resolves one reference: returns the id to keep, or nil (left out, listed with `where`: the
-- section and the name of what used it). `strict` for a room a step that opens doors acts on.
local function resolve(m, kind, id, where, strict)
    local key = kind .. (strict and "!" or "") .. ":" .. tostring(id)
    local found = m.found[key]
    if found == nil then
        local newId, how
        if kind == "room" then
            newId, how = findRoom(m, id, strict)
        else
            newId, how = findDevice(m, id, kind)
        end
        local info = kind == "room" and m.rooms[tostring(id)] or m.devices[tostring(id)]
        local name = infoName(info)
        local current = newId and (kind == "room" and (m.registry.rooms or {})[newId] or (m.registry.devices or {})[newId]) or nil
        if how == "id" then
            m.byId = m.byId + 1
            if name and current and current.name ~= name then
                m.renamed[#m.renamed + 1] = { kind = kind, id = id, name = name, now = current.name }
            end
        elseif how == "name" then
            m.byName[#m.byName + 1] = { kind = kind, name = name, room = kind ~= "room" and nullable(roomLabel(m, info.room_id)) or Json.null, from = id, to = newId }
        else
            -- What the id is now, when it is still a room or a device of this kind: a door or gate
            -- renamed or swapped is not moved, and says so.
            local now = nil
            if kind == "room" then
                now = (m.registry.rooms or {})[id]
            else
                now = (m.registry.devices or {})[id]
                now = isKind(now, kind) and now or nil
            end
            local entry = {
                kind = kind,
                id = id,
                name = nullable(name),
                room = kind ~= "room" and isObject(info) and nullable(roomLabel(m, info.room_id)) or Json.null,
                now = now and nullable(now.name) or Json.null,
                used_in = Json.array(),
            }
            m.missing[key] = entry
            m.unmatched[#m.unmatched + 1] = entry
        end
        found = newId or false
        m.found[key] = found
    end
    if found == false then
        local entry = m.missing[key]
        if #entry.used_in < 10 then
            local seen = false
            for _, use in ipairs(entry.used_in) do
                seen = seen or (use.section == where.section and use.name == where.name)
            end
            if not seen then
                entry.used_in[#entry.used_in + 1] = { section = where.section, name = nullable(where.name) }
            end
        end
        return nil
    end
    return found
end

-- The scenes with their steps matched; a step left with no device, or whose room is not in the
-- project (it would reach every room), is left out.
local function matchScenes(m, scenes, counts)
    local seen = {}
    local result = Json.array()
    for _, scene in ipairs(scenes) do
        if seen[scene.id] then
            counts.scenes = counts.scenes + 1
        else
            seen[scene.id] = true
            local name = cleanName(scene.name, "Scene")
            local steps = Json.array()
            local where = { section = "scenes", name = name }
            for _, step in ipairs(scene.steps) do
                local keep = true
                local roomId = step.room_id
                if roomId and step.device_ids then
                    -- Only the room its devices were picked in (docs/SCENES.md): kept if it is found.
                    roomId = findRoom(m, roomId)
                elseif roomId then
                    -- Every device of the room: doors and gates only in the very same room.
                    roomId = resolve(m, "room", roomId, where, step.type == "relays")
                    keep = roomId ~= nil
                end
                local ids = nil
                if keep and step.device_ids then
                    ids = Json.array()
                    local listed = {}
                    for _, id in ipairs(step.device_ids) do
                        local newId = resolve(m, STEP_KINDS[step.type], id, where)
                        if newId and not listed[newId] then
                            listed[newId] = true
                            ids[#ids + 1] = newId
                        end
                    end
                    keep = #ids > 0
                end
                local set = step.set
                if keep and step.type == "music" and set.with_room_ids then
                    -- The rooms grouped with it: each matched as a step's room; one not found is
                    -- left out, and the favorite still plays in the others.
                    set = Scenes.copySet(set)
                    local rooms = Json.array()
                    for _, id in ipairs(set.with_room_ids) do
                        local newId = resolve(m, "room", id, where)
                        if newId and newId ~= roomId then
                            rooms[#rooms + 1] = newId
                        end
                    end
                    set.with_room_ids = #rooms > 0 and rooms or nil
                end
                if keep then
                    steps[#steps + 1] = { type = step.type, room_id = roomId, device_ids = ids, set = set }
                else
                    counts.steps = counts.steps + 1
                end
            end
            result[#result + 1] = {
                id = scene.id,
                name = name,
                icon = scene.icon,
                show_on_home = scene.show_on_home,
                steps = steps,
                created_at = scene.created_at,
                updated_at = scene.updated_at,
                version = scene.version,
            }
        end
    end
    return result
end

-- Preferences as the API takes them (src/api/handlers/profiles.lua); anything else is left out.
local function cleanPrefs(prefs)
    local palette = prefs.palette
    return {
        language = (prefs.language == "auto" or RoomNames.validLanguage(prefs.language)) and prefs.language or nil,
        theme = Profiles.THEMES[prefs.theme] and prefs.theme or nil,
        palette = type(palette) == "string" and #palette <= 20 and palette:match(PALETTE) and palette or nil,
    }
end

local function matchProfiles(m, profiles, counts)
    local seen = {}
    local result = Json.array()
    for _, profile in ipairs(profiles) do
        if seen[profile.id] or #result >= Profiles.MAX_PROFILES then
            counts.profiles = counts.profiles + 1
        else
            seen[profile.id] = true
            local name = cleanName(profile.name, "Profile")
            local where = { section = "profiles", name = name }
            local favorites, listed = Json.array(), {}
            for _, entry in ipairs(profile.prefs.favorites or {}) do
                local kind, id = tostring(entry):match("^(%l+):(%d+)$")
                -- A kind this driver does not know matches no device: it is listed like one gone.
                local newId = kind and resolve(m, FAVORITE_KINDS[kind] or kind, tonumber(id), where) or nil
                local value = newId and (kind .. ":" .. newId) or nil
                if value and not listed[value] and #favorites < Profiles.MAX_FAVORITES then
                    listed[value] = true
                    favorites[#favorites + 1] = value
                end
            end
            local hidden, hiddenSeen = Json.array(), {}
            for _, id in ipairs(profile.prefs.hidden_rooms or {}) do
                local newId = tonumber(id) and resolve(m, "room", tonumber(id), where) or nil
                if newId and not hiddenSeen[newId] then
                    hiddenSeen[newId] = true
                    hidden[#hidden + 1] = newId
                end
            end
            local prefs = cleanPrefs(profile.prefs)
            prefs.favorites, prefs.hidden_rooms = favorites, hidden
            result[#result + 1] = {
                id = profile.id,
                name = name,
                created_at = profile.created_at,
                version = profile.version,
                prefs = prefs,
            }
        end
    end
    return result
end

-- Room names matched to the project, each a name as the API takes one, in at most
-- RoomNames.MAX_LANGUAGES languages a room.
local function matchRoomNames(m, names)
    local rooms = {}
    local ids = {}
    for id in pairs(names) do
        ids[#ids + 1] = id
    end
    table.sort(ids)
    local count = 0
    for _, id in ipairs(ids) do
        local newId = resolve(m, "room", id, { section = "room_names" })
        if newId and next(names[id]) then
            local key = tostring(newId)
            local languages = {}
            for language in pairs(names[id]) do
                languages[#languages + 1] = language
            end
            table.sort(languages)
            for _, language in ipairs(languages) do
                local name = cleanName(names[id][language], nil)
                local room = rooms[key] or {}
                local held = 0
                for _ in pairs(room) do
                    held = held + 1
                end
                if name and not room[language] and held < RoomNames.MAX_LANGUAGES then
                    if not rooms[key] then
                        rooms[key] = room
                        count = count + 1
                    end
                    room[language] = name
                end
            end
        end
    end
    return rooms, count
end

-- The Sonos room choices matched to the project: a player whose room matches nothing is left out
-- (listed), and is shown in the room of its own name again, as before an admin chose one.
local function matchSonosRooms(m, rooms)
    local players = {}
    for playerId in pairs(rooms) do
        players[#players + 1] = playerId
    end
    table.sort(players)
    local result, count = {}, 0
    for _, playerId in ipairs(players) do
        local choice = rooms[playerId]
        local newId = resolve(m, "room", choice.room_id, { section = "sonos_rooms", name = choice.name })
        if newId then
            result[playerId] = { room_id = newId, name = choice.name }
            count = count + 1
        end
    end
    return result, count
end

-- The doors linked to doorbells (1.11.0, ADR-078) matched to the project as doors are (DOOR_KINDS):
-- each doorbell and each door only with the same id and the same name, never another device, which
-- would show a gate at the wrong doorbell; what matches nothing is left out (listed). Returns the
-- section and how many doors stay linked.
local function matchDoorbellDoors(m, links)
    local doorbells = {}
    for doorbellId in pairs(links) do
        doorbells[#doorbells + 1] = doorbellId
    end
    table.sort(doorbells)
    local result, count = {}, 0
    for _, doorbellId in ipairs(doorbells) do
        local doorbellName = infoName(m.devices[tostring(doorbellId)])
        local where = { section = "doorbell_doors", name = doorbellName }
        local newId = resolve(m, "doorbell", doorbellId, where)
        local doors = {}
        for _, doorId in ipairs(links[doorbellId]) do
            -- Each door is looked at, so that one that matches nothing is listed even when its
            -- doorbell is gone too.
            local newDoor = resolve(m, "relay", doorId, where)
            if newId and newDoor then
                doors[#doors + 1] = newDoor
            end
        end
        if #doors > 0 then
            result[tostring(newId)] = doors
            count = count + #doors
        end
    end
    return { version = DoorbellDoors.STORE_VERSION, links = result }, count
end

local function matchRoomOrder(m, order)
    local result, seen = Json.array(), {}
    for _, id in ipairs(order) do
        local newId = resolve(m, "room", id, { section = "room_order" })
        if newId and not seen[newId] then
            seen[newId] = true
            result[#result + 1] = newId
        end
    end
    return result
end

-- People's roles and permissions, the owner and the rooms hidden from members (ADR-054), as they will
-- be after the restore. They follow the keys' rule: the backup's when its keys come back
-- (`restoring`), their rooms matched to the project like scene steps, else the ones here, so that a
-- permission taken away since the backup was made never comes back. Only the people of `profiles`
-- (those after the restore), and of a member's scenes only those that come back (`sceneIds`). From
-- a backup made before 1.8.0 (no `section`), the people its keys come back with have none: they are
-- worked out from their keys after the restore, as at the update (main.lua). Returns the section and
-- how many people it keeps.
local function matchPeople(m, restoring, section, profiles, sceneIds)
    local here = People.read(People.backup())
    local matched = restoring and section ~= nil
    local from = here
    if matched then
        from = People.read(section)
    elseif restoring then
        from = People.read(nil)
    end
    local people, count, present = {}, 0, {}
    for _, profile in ipairs(profiles) do
        present[profile.id] = true
        local fromBackup = matched and from.people[profile.id] ~= nil
        -- The restoring device's own person, when the backup does not have them, stays as here.
        local record = from.people[profile.id] or (restoring and here.people[profile.id]) or nil
        if record then
            local view = People.view(record)
            local rooms = Json.array()
            for _, id in ipairs(view.rooms) do
                local newId = id
                if fromBackup then
                    newId = resolve(m, "room", id, { section = "people", name = profile.name })
                end
                if newId then
                    rooms[#rooms + 1] = newId
                end
            end
            view.rooms = rooms
            local scenes = Json.array()
            for _, id in ipairs(view.scenes) do
                if sceneIds[id] then
                    scenes[#scenes + 1] = id
                end
            end
            view.scenes = scenes
            people[profile.id] = view
            count = count + 1
        end
    end
    local ids = {}
    for id in pairs(matched and from.hidden or here.hidden) do
        ids[#ids + 1] = id
    end
    table.sort(ids)
    local hidden = Json.array()
    for _, id in ipairs(ids) do
        local newId = id
        if matched then
            newId = resolve(m, "room", id, { section = "people" })
        end
        if newId then
            hidden[#hidden + 1] = newId
        end
    end
    local owner = matched and from.owner or here.owner
    return {
        version = People.STORE_VERSION,
        people = people,
        owner = owner and present[owner] and owner or nil,
        hidden_rooms = hidden,
    }, count
end

-- ---- The keys and the remote identity ----------------------------------------------------------

-- The keys after the restore (ADR-042). The backup's come back only onto a controller where no key
-- but the restoring admin's is paired, and that one was paired after the backup was made (the
-- driver was removed and added again, or the controller replaced): every device with its key then
-- works without pairing again. Otherwise every key stays exactly as it is now: a key revoked, or an
-- admin made a member, since the backup was made must not come back. The restoring admin's key stays as it is now either way; with `replaces` (the id
-- of one of the backup's keys: "this device is …") it takes that key's profile and role, and that
-- key stays out, so that nobody's old key is left on no device. Returns the keys, what the preview
-- says of them and the restoring key as it will be; or nil and a problem.
local function mergeKeys(section, restorerId, now, replaces)
    -- Keys whose expiry passed go first, as at every look at the keys.
    Keys.list()
    local currentKeys = Keys.backup().keys
    local current, others = nil, 0
    for _, key in ipairs(currentKeys) do
        if key.id == restorerId then
            current = key
        else
            others = others + 1
        end
    end
    local backupKeys, dropped = Keys.readBackup(section)
    -- The restoring key is in the backup: this controller kept its keys since it was made.
    local kept = false
    for _, key in ipairs(backupKeys) do
        kept = kept or (current ~= nil and key.id == current.id and key.hash == current.hash)
    end
    local info = {
        action = (others == 0 and not kept) and "restore" or "kept",
        in_backup = #backupKeys + dropped,
        expired = 0,
        left_out = 0,
        conflict = false,
        yours = "added",
        limit = Keys.MAX_KEYS,
        replaced = Json.null,
        items = Json.array(),
    }
    if info.action == "kept" then
        if replaces ~= nil then
            return nil, { status = 409, code = "KEYS_KEPT", detail = "Other devices are paired with this controller, so its keys stay as they are and the backup's are not restored: leave out replaces_key" }
        end
        local result = Json.array()
        for _, key in ipairs(currentKeys) do
            result[#result + 1] = key
        end
        info.yours = "kept"
        info.count = #result
        info.over_limit = #result > Keys.MAX_KEYS
        return result, info, current
    end
    info.left_out = dropped
    local result, seen = Json.array(), {}
    local taken, replacing = 0, nil
    for _, key in ipairs(backupKeys) do
        key.name = cleanName(key.name, "API key")
        if Keys.over(key, now) then
            info.expired = info.expired + 1
        elseif seen[key.id] or (current and key.hash == current.hash and key.id ~= current.id) then
            -- The same key twice, or the restoring key's secret under another id.
            info.left_out = info.left_out + 1
        elseif current and key.id == current.id then
            -- Another key with this key's id (8 random hex digits): the one in use wins.
            seen[key.id] = true
            info.conflict = true
            result[#result + 1] = current
        elseif replaces ~= nil and key.id == replaces then
            seen[key.id] = true
            replacing = key
        elseif taken >= Keys.MAX_KEYS then
            -- The backup's own keys stay within the limit (a DirectorLink never has more).
            info.left_out = info.left_out + 1
        else
            seen[key.id] = true
            taken = taken + 1
            result[#result + 1] = key
            info.items[#info.items + 1] = { id = key.id, name = key.name, role = key.role, expires_at = key.expires and Clock.iso(key.expires) or Json.null }
        end
    end
    if replaces ~= nil then
        if not replacing or not current then
            return nil, {
                status = 400,
                code = "INVALID_FIELD",
                detail = "replaces_key is the id of one of the backup's keys that comes back, other than this device's own",
                errors = { { field = "replaces_key", message = "Not one of the backup's keys that comes back" } },
            }
        end
        current.role, current.profile = replacing.role, replacing.profile
        info.replaced = { id = replacing.id, name = replacing.name, role = replacing.role }
    end
    if current and not seen[current.id] then
        result[#result + 1] = current
    end
    local admins = 0
    for _, key in ipairs(result) do
        admins = admins + (key.role == "admin" and 1 or 0)
    end
    if admins == 0 then
        return nil, { status = 409, code = "LAST_ADMIN", detail = "This device would become " .. tostring(current and current.role) .. " and no admin would be left: choose another key, or none" }
    end
    info.count = #result
    info.over_limit = #result > Keys.MAX_KEYS
    return result, info, current
end

local function copyIdentity(identity)
    if not identity then
        return nil
    end
    local candidates = nil
    for _, item in ipairs(identity.next_secrets or {}) do
        candidates = candidates or {}
        candidates[#candidates + 1] = { secret = item.secret, at = item.at }
    end
    return {
        home_id = identity.home_id,
        home_secret = identity.home_secret,
        next_secrets = candidates,
        linked = identity.linked,
        previous = copyIdentity(identity.previous),
    }
end

-- Whether the backup is this home's (ADR-042). By the home id when both the backup and this
-- controller have one the relay accepted, else by the controller it was made on; and besides, by
-- the home's name and by how much of what it refers to this project has. Returns { another_home,
-- reasons, home_now, controller ("same", "other" or "unknown") }.
local function origin(document, context, m, current)
    local reasons = Json.array()
    local section = document.sections.remote_identity
    local mine = {}
    if current and current.linked then
        mine[current.home_id] = true
    end
    if current and current.previous and current.previous.linked then
        mine[current.previous.home_id] = true
    end
    local made = isLowerHex(document.controller_id, 32) and document.controller_id or nil
    local controller = "unknown"
    if made and context.controller then
        controller = made == context.controller and "same" or "other"
    end
    if section.linked == true and next(mine) then
        if not mine[section.home_id] then
            reasons[#reasons + 1] = "home_id"
        end
    elseif controller == "other" then
        reasons[#reasons + 1] = "controller"
    end
    local home = isObject(document.home) and document.home or {}
    local name, now = cleanName(home.name, nil), cleanName(context.homeName, nil)
    if name and now and name ~= now then
        reasons[#reasons + 1] = "name"
    end
    local total = m.byId + #m.byName + #m.unmatched
    if total > 0 and #m.unmatched * 2 > total then
        reasons[#reasons + 1] = "references"
    end
    return { another_home = #reasons > 0, reasons = reasons, home_now = nullable(now), controller = controller }
end

-- The identity to use after the restore (ADR-042), and what happens to it: "same" (the backup's
-- home is the one in use, which stays: its secret may be newer), "restore" (the backup's is used,
-- with the one it replaces kept as `previous` until the relay accepts it; if the relay refuses it,
-- that one comes back), "kept" (another home's, which moves here only when the admin asks:
-- `move`), or "none" (the backup holds no identity: the one in use stays).
local function chooseIdentity(section, current, from, move, now)
    current = copyIdentity(current)
    if section.linked ~= true then
        return current, "none"
    end
    local backup = { home_id = section.home_id, home_secret = section.home_secret:lower(), linked = true }
    for _, item in ipairs(items(section.next_secrets)) do
        -- At most the few the relay tries, none made later than now.
        if item.at <= now + CLOCK_MARGIN and #(backup.next_secrets or {}) < Relay.CANDIDATES then
            backup.next_secrets = backup.next_secrets or {}
            backup.next_secrets[#backup.next_secrets + 1] = { secret = item.secret:lower(), at = item.at }
        end
    end
    if current and section.home_id == current.home_id then
        return current, "same"
    end
    local fallback = current and (current.previous or current) or nil
    if fallback and section.home_id == fallback.home_id then
        -- This controller's own, from before another one was restored.
        fallback.previous = nil
        return fallback, "restore"
    end
    if from.another_home and not move then
        return current, "kept"
    end
    if fallback then
        fallback.previous = nil
        backup.previous = fallback
    end
    return backup, "restore"
end

-- ---- Planning and applying a restore --------------------------------------------------------------

-- The stores a restore writes that keep whether they were read in full at start: one that was not
-- may still hold data (it comes back at the next start) that a restore would overwrite, and that
-- could not be put back if the restore failed.
local READ_AT_START = {
    { name = "keys", complete = Keys.complete },
    -- The people (src/auth/people.lua) are kept by profile: profiles left out would take them.
    { name = "profiles", complete = Profiles.complete },
    { name = "scenes", complete = Scenes.complete },
    { name = "schedules", complete = Schedules.complete },
    { name = "calendar", complete = JewishCalendar.complete },
    -- Only written when the backup has them.
    { name = "sonos_rooms", complete = SonosRooms.complete, optional = true },
    -- Always written: from a backup without them, the people here that still apply.
    { name = "people", complete = People.complete },
    -- Always written: from a backup without them, the links here that still apply.
    { name = "scene_links", complete = SceneLinks.complete },
    -- Only written when the backup has them (1.11.0, ADR-078).
    { name = "doorbell_doors", complete = DoorbellDoors.complete, optional = true },
}

-- Checks `document` against this controller and works out everything a restore writes, without
-- changing anything. `context`: { registry, restorer (the admin's key id), now, replaces (the id of
-- the backup's key this device is), move_remote (another home's identity moves here),
-- controller (Backup.controllerId()) }. Returns the plan ({ sections, identity, preview }), or nil
-- and a problem ({ status, code, detail, errors }).
function Backup.plan(document, context)
    local ok, problem = validate(document)
    if not ok then
        return nil, problem
    end
    for _, store in ipairs(READ_AT_START) do
        if store.complete() == false and (not store.optional or document.sections[store.name] ~= nil) then
            return nil, {
                status = 503,
                code = "UNAVAILABLE",
                detail = "DirectorLink could not read its " .. store.name .. " when it started: a restore would overwrite them. Restart the driver and try again",
                extra = { store = store.name },
            }
        end
    end
    local now = context.now or Clock.now()
    local sections = document.sections
    local m = newMatcher(context.registry, document.references)
    local counts = { scenes = 0, steps = 0, schedules = 0, profiles = 0 }

    local keys, keyInfo, restorer = mergeKeys(sections.keys, context.restorer, now, context.replaces)
    if not keys then
        return nil, keyInfo
    end

    -- Each key's profile comes along: the backup's, else the one it has now (the restoring admin's
    -- when the backup does not have it; with the keys kept, every key's). With the keys kept, the
    -- backup's profiles no key uses stay out.
    local profiles, droppedProfiles = Profiles.read(sections.profiles)
    counts.profiles = droppedProfiles
    local used = {}
    for _, key in ipairs(keys) do
        if key.profile then
            used[key.profile] = true
        end
    end
    if keyInfo.action == "kept" then
        local wanted = {}
        for _, profile in ipairs(profiles) do
            if used[profile.id] then
                wanted[#wanted + 1] = profile
            end
        end
        profiles = wanted
    end
    local matchedProfiles = matchProfiles(m, profiles, counts)
    local present = {}
    for _, profile in ipairs(matchedProfiles) do
        present[profile.id] = true
    end
    for _, key in ipairs(keys) do
        if key.profile and not present[key.profile] and (keyInfo.action == "kept" or key == restorer) then
            local own = Profiles.find(key.profile)
            if own then
                present[own.id] = true
                matchedProfiles[#matchedProfiles + 1] = own
            end
        end
    end

    local scenes, droppedSteps, droppedScenes = Scenes.read(sections.scenes)
    counts.steps, counts.scenes = droppedSteps, droppedScenes
    local matchedScenes = matchScenes(m, scenes, counts)
    local sceneIds = {}
    for _, scene in ipairs(matchedScenes) do
        sceneIds[scene.id] = true
    end

    local schedules, droppedSchedules = Schedules.read(sections.schedules)
    counts.schedules = droppedSchedules
    local keptSchedules, scheduleIds = Json.array(), {}
    for _, schedule in ipairs(schedules) do
        -- A schedule runs a scene of the backup, or none.
        if sceneIds[schedule.scene_id] and not scheduleIds[schedule.id] then
            scheduleIds[schedule.id] = true
            keptSchedules[#keptSchedules + 1] = schedule
        else
            counts.schedules = counts.schedules + 1
        end
    end

    local roomNames, namedRooms = matchRoomNames(m, RoomNames.read(sections.room_names))
    local order = matchRoomOrder(m, RoomLayout.read(sections.room_order))
    local calendar = JewishCalendar.read(sections.calendar)
    -- A backup made before 1.6.0 has no Sonos rooms: the choices made here stay.
    local sonosRooms, sonosCount = nil, nil
    if sections.sonos_rooms ~= nil then
        sonosRooms, sonosCount = matchSonosRooms(m, SonosRooms.read(sections.sonos_rooms))
    end

    local current = Relay.storedIdentity()
    local from = origin(document, { controller = context.controller, homeName = homeName(context.registry) }, m, current)
    local identity, action = chooseIdentity(sections.remote_identity, current, from, context.move_remote == true, now)

    -- Scene links (1.7.0, ADR-051) follow the keys' rule: the backup's only when its keys come back
    -- (the driver added again, or the controller replaced), else the ones here, so that a link
    -- removed or replaced since the backup was made never comes back. Each only while its scene
    -- comes back without doors or gates, the link names the home whose identity is in use after the
    -- restore (its address names that home) and the key that made it is among the keys after it
    -- (one this device replaces passes its links to this device's). Hashes only, like keys.
    local restoredScenes = {}
    for _, scene in ipairs(matchedScenes) do
        restoredScenes[scene.id] = scene
    end
    local keyIds = {}
    for _, key in ipairs(keys) do
        keyIds[key.id] = true
    end
    local links = Json.array()
    local home = identity and identity.linked and identity.home_id or nil
    local source = keyInfo.action == "restore" and sections.scene_links or SceneLinks.backup()
    for _, link in ipairs((SceneLinks.read(source))) do
        local scene = restoredScenes[link.scene_id]
        if link.by and context.replaces ~= nil and link.by == context.replaces and restorer then
            link.by = restorer.id
        end
        if scene and home and link.home == home and SceneLinks.linkable(scene) and (not link.by or keyIds[link.by]) then
            links[#links + 1] = link
        end
    end

    local people, peopleCount = matchPeople(m, keyInfo.action == "restore", sections.people, matchedProfiles, sceneIds)
    -- A backup made before 1.11.0 has no doors linked to doorbells: the links made here stay.
    local doorbellDoors, doorbellDoorsCount = nil, nil
    if sections.doorbell_doors ~= nil then
        doorbellDoors, doorbellDoorsCount = matchDoorbellDoors(m, DoorbellDoors.read(sections.doorbell_doors))
    end

    local composer = Json.array()
    local stored = isObject(document.composer) and document.composer or {}
    for _, name in ipairs(Backup.COMPOSER) do
        local value = stored[name]
        composer[#composer + 1] = {
            name = name,
            backup = type(value) == "string" and value or Json.null,
            current = nullable(Properties and Properties[name] or nil),
        }
    end

    local home = isObject(document.home) and document.home or {}
    local unmatched = Json.array()
    for index = 1, math.min(#m.unmatched, Backup.MAX_LISTED) do
        unmatched[index] = m.unmatched[index]
    end
    local preview = {
        backup = {
            created_at = document.created_at,
            driver_version = document.driver_version,
            format_version = document.format_version,
            home = type(home.name) == "string" and home.name or Json.null,
        },
        origin = from,
        counts = {
            keys = #keys,
            profiles = #matchedProfiles,
            scenes = #matchedScenes,
            schedules = #keptSchedules,
            room_names = namedRooms,
            room_order = #order,
            sonos_rooms = nullable(sonosCount),
            scene_links = #links,
            people = peopleCount,
            doorbell_doors = nullable(doorbellDoorsCount),
        },
        left_out = counts,
        keys = keyInfo,
        remote = {
            action = action,
            home_id = sections.remote_identity.linked == true and sections.remote_identity.home_id or Json.null,
            current_home_id = current and nullable(current.home_id) or Json.null,
            remote_access = Properties ~= nil and Properties["Remote Access"] == "On",
            -- The controller the backup was made on may still be on with this identity: the two
            -- would push each other off the relay.
            old_controller = action == "restore" and from.controller ~= "same",
        },
        references = {
            by_id = m.byId,
            by_name = Json.array(m.byName),
            renamed = Json.array(m.renamed),
            unmatched = unmatched,
            unmatched_count = #m.unmatched,
        },
        composer = composer,
    }
    return {
        preview = preview,
        switching = action == "restore",
        sections = {
            keys = { version = Keys.STORE_VERSION, keys = keys },
            profiles = { version = 1, profiles = matchedProfiles },
            room_names = { version = 1, rooms = roomNames },
            room_order = { version = 1, order = order },
            scenes = { version = 1, scenes = matchedScenes },
            schedules = { version = 1, schedules = keptSchedules },
            calendar = { version = 1, settings = calendar },
            remote_identity = identity,
            sonos_rooms = sonosRooms and { version = 1, rooms = sonosRooms } or nil,
            scene_links = { version = SceneLinks.STORE_VERSION, links = links },
            people = people,
            doorbell_doors = doorbellDoors,
        },
    }
end

-- The stores in the order a restore writes them. `take` is what goes back when a later one fails.
local PARTS = {
    { name = "keys", take = Keys.backup, write = Keys.restore },
    { name = "profiles", take = Profiles.backup, write = Profiles.restore },
    { name = "room_names", take = RoomNames.backup, write = RoomNames.restore },
    { name = "room_order", take = RoomLayout.backup, write = RoomLayout.restore },
    { name = "scenes", take = Scenes.backup, write = Scenes.restore },
    {
        name = "schedules",
        take = Schedules.snapshot,
        write = function(data, now)
            return Schedules.restore(data, now)
        end,
        putBack = function(snapshot)
            return Schedules.restore(snapshot.data, nil, snapshot)
        end,
    },
    { name = "calendar", take = JewishCalendar.backup, write = JewishCalendar.restore },
    {
        name = "remote_identity",
        take = function()
            return copyIdentity(Relay.storedIdentity())
        end,
        write = Relay.restoreIdentity,
    },
    -- Only when the backup has them (1.6.0 and later).
    { name = "sonos_rooms", take = SonosRooms.backup, write = SonosRooms.restore, optional = true },
    { name = "scene_links", take = SceneLinks.backup, write = SceneLinks.restore },
    -- Always written (1.8.0, ADR-054): from a backup without them, the people here that still apply.
    { name = "people", take = People.backup, write = People.restore },
    -- Only when the backup has them (1.11.0, ADR-078).
    { name = "doorbell_doors", take = DoorbellDoors.backup, write = DoorbellDoors.restore, optional = true },
}

local function write(part, data, now)
    local ok, saved = pcall(part.write, data, now)
    return ok and saved == true
end

-- Writes every store of `plan` (Backup.plan), or none: when one cannot be written, the ones written
-- so far, and that one, get their values from before. Returns true, or nil and the store that failed.
function Backup.apply(plan, now)
    now = now or Clock.now()
    local before = {}
    for index, part in ipairs(PARTS) do
        before[index] = part.take()
    end
    local function skipped(part)
        return part.optional and plan.sections[part.name] == nil
    end
    for index, part in ipairs(PARTS) do
        if not skipped(part) and not write(part, plan.sections[part.name], now) then
            for back = index, 1, -1 do
                local previous = PARTS[back]
                local ok, restored = true, true
                if not skipped(previous) then
                    ok, restored = pcall(previous.putBack or previous.write, before[back], now)
                end
                if not (ok and restored == true) then
                    Log.error("backup", "a store could not be put back after a failed restore", { store = previous.name })
                end
            end
            Log.error("backup", "restore failed; the stores were put back", { store = part.name })
            return nil, part.name
        end
    end
    local counts = plan.preview.counts
    Log.info("backup", "restored from a backup", {
        made = plan.preview.backup.created_at,
        driver_version = plan.preview.backup.driver_version,
        keys = counts.keys,
        keys_from_backup = plan.preview.keys.action == "restore",
        profiles = counts.profiles,
        scenes = counts.scenes,
        schedules = counts.schedules,
        sonos_rooms = counts.sonos_rooms,
        scene_links = counts.scene_links,
        remote = plan.preview.remote.action,
        another_home = plan.preview.origin.another_home,
        unmatched = plan.preview.references.unmatched_count,
    })
    return true
end

return Backup
