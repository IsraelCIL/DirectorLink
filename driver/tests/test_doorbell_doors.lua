-- A doorbell's doors (1.11.0, ADR-078): a Relay Door, Gate or Garage Door Controller whose Open/Toggle
-- relay is bound to a relay connection of a doorbell camera's own driver is that doorbell's door, by
-- itself (as on the owner's controller: gate 530's relay on the DirectorLink · DoorBird driver 761,
-- whose camera 763 is a doorbell of the camera agreement); an admin links other doors (a KNX relay);
-- `doors` in /v1/doorbells says which, and who may open each; a door is opened from the doorbell's
-- screen with its own Open, once, by whoever may open it, and the history says it came from the
-- doorbell; the links are kept, and come back with a backup, never onto another door.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")

local tests = {}

local ENTRANCE, ENTRANCE_DRIVER = 68, 158
local ENTRANCE_GATE, ENTRANCE_GATE_DRIVER = 76, 166
local MAIN_DOOR = 70
local FRONT_GATE = 93
local MAIN_GATE, MAIN_GATE_DRIVER = 71, 161
local GARAGE = 72

-- The owner's arrangement: the doorbell camera 68 "Entrance" (Kitchen) on driver 158, and the gate
-- controller 166 (its button 76 "Entrance Gate", Kitchen) on 158's relay; Control4's other door
-- controllers (71 "Main Gate" on the DoorBird's relay, Living Room; 72 "Garage Door"), the KNX relay
-- 70 "Main Door" and the DoorBird 93 "Front Gate".
local function project(gate)
    return Mock.withDoorbellGate(Mock.withRelayControllers(Mock.withAgreementCameras(Mock.project())), gate)
end

local function start(theProject, prepare)
    local mock = Mock.startDriver(theProject or project(), nil, nil, function(m)
        Properties["Door Control"] = "Enabled"
        if prepare then
            prepare(m)
        end
    end)
    return mock, T.pair(mock, "Owner's iPhone")
end

local function doorbell(mock, key, id)
    local answer = T.http(mock, "GET", "/v1/doorbells/" .. (id or ENTRANCE), { key = key })
    T.eq(answer.status, 200, answer.body)
    return answer.json
end

local function listed(mock, key)
    local found = {}
    for _, item in ipairs(T.http(mock, "GET", "/v1/doorbells", { key = key }).json.items) do
        found[item.id] = item
    end
    return found
end

local function member(mock, admin, name, access)
    local created = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = name, role = "member", access = access } })
    T.eq(created.status, 201, created.body)
    return created.json.key
end

local function link(mock, key, ids, id)
    return T.http(mock, "PUT", "/v1/doorbells/" .. (id or ENTRANCE) .. "/doors", { key = key, body = { door_ids = ids } })
end

local function commandsSince(mock, since)
    local list = {}
    for index = since + 1, #mock.commands do
        list[#list + 1] = mock.commands[index]
    end
    return list
end

local function stored(mock)
    local value = mock.persist.directorlink_doorbell_doors
    return type(value) == "string" and Json.decode(value:gsub("^json:", "")) or nil
end

-- ---- found by itself -----------------------------------------------------------------------------

function tests.a_gate_on_the_doorbell_camera_s_relay_is_the_doorbell_s_door()
    local mock, key = start()
    local entrance = doorbell(mock, key)
    T.same(entrance.doors, { { id = ENTRANCE_GATE, link = "automatic", can_open = true } }, "the gate whose relay is the doorbell driver's")
    T.eq(entrance.can_open, false, "the doorbell itself still opens nothing (ADR-065)")
    T.same(listed(mock, key)[ENTRANCE].doors, entrance.doors, "in the list too")
    -- The gate is a door of its own as before, in its room.
    local gate = T.http(mock, "GET", "/v1/relays/" .. ENTRANCE_GATE, { key = key })
    T.eq(gate.status, 200)
    T.eq(gate.json.kind, "gate")
    -- A DoorBird doorstation opens its gate with its own button: the controller on its relay is its
    -- partner (ADR-069), not a door shown at it.
    local front = doorbell(mock, key, FRONT_GATE)
    T.eq(front.can_open, true)
    T.same(front.doors, Json.array(), "nothing found by itself at a DoorBird")
    -- Nothing asked of Director to say it: the survey read the bindings.
    local reads = #mock.commands
    doorbell(mock, key)
    T.eq(#mock.commands, reads)
end

function tests.the_camera_s_own_id_counts_and_every_gate_on_the_relay_is_listed()
    -- Director names the camera's proxy as the relay's provider; a second controller on the same relay
    -- (a button for the gate in another room) is shown too.
    local home = project({ id = ENTRANCE_GATE, controller = ENTRANCE_GATE_DRIVER, name = "Entrance Gate", room = 10, kind = "gate", state = "Unknown", bindings = { [1] = ENTRANCE } })
    Mock.withRelayControllers(home, { { id = 78, controller = 168, name = "Entrance Gate (garden)", room = 11, kind = "gate", state = "Unknown", bindings = { [1] = ENTRANCE_DRIVER } } })
    local mock, key = start(home)
    local ids = {}
    for _, door in ipairs(doorbell(mock, key).doors) do
        ids[#ids + 1] = door.id .. ":" .. door.link
    end
    T.same(ids, { "76:automatic", "78:automatic" })
    -- The camera that is not a doorbell has no doors; a gate whose relay is elsewhere is not one.
    T.eq(T.http(mock, "GET", "/v1/doorbells/67", { key = key }).status, 404)
end

function tests.a_binding_changed_in_composer_moves_the_gate_with_the_next_project_read()
    local mock, key = start()
    T.eq(#doorbell(mock, key).doors, 1)
    mock.project.bindings[ENTRANCE_GATE_DRIVER][1] = 173
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    T.same(doorbell(mock, key).doors, Json.array(), "its relay is elsewhere now")
    mock.project.bindings[ENTRANCE_GATE_DRIVER][1] = nil
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    T.same(doorbell(mock, key).doors, Json.array(), "nothing bound: no door at all")
end

-- ---- linked by an admin --------------------------------------------------------------------------

function tests.an_admin_links_a_door_and_removes_it_and_the_link_is_kept()
    local mock, key = start()
    local answer = link(mock, key, { MAIN_DOOR, ENTRANCE_GATE, MAIN_DOOR })
    T.eq(answer.status, 200, answer.body)
    T.same(answer.json.doors, {
        { id = ENTRANCE_GATE, link = "automatic", can_open = true },
        { id = MAIN_DOOR, link = "manual", can_open = true },
    }, "the gate found by itself stays automatic, the KNX door is linked once")
    T.same(stored(mock).links, { ["68"] = { MAIN_DOOR } }, "only what the admin linked is kept")

    -- Kept through a driver update.
    local updated = Mock.updateDriver(mock, project())
    Properties["Door Control"] = "Enabled"
    T.same(doorbell(updated, key).doors[2], { id = MAIN_DOOR, link = "manual", can_open = true })

    -- A DoorBird doorstation can have doors linked too, besides its own Open.
    T.eq(link(updated, key, { GARAGE }, FRONT_GATE).status, 200)
    T.same(doorbell(updated, key, FRONT_GATE).doors, { { id = GARAGE, link = "manual", can_open = true } })

    -- Removed: what was found by itself stays.
    answer = link(updated, key, {})
    T.eq(answer.status, 200, answer.body)
    T.same(answer.json.doors, { { id = ENTRANCE_GATE, link = "automatic", can_open = true } })
    T.same(stored(updated).links, { ["93"] = { GARAGE } })
end

function tests.only_doors_and_gates_up_to_ten_and_only_by_an_admin()
    local mock, key = start()
    local function refused(body, status, code, id)
        local answer = T.http(mock, "PUT", "/v1/doorbells/" .. (id or ENTRANCE) .. "/doors", { key = key, body = body })
        T.eq(answer.status, status, answer.body)
        if code then
            T.eq(answer.json.code, code)
        end
    end
    refused({ door_ids = { 20 } }, 400, "INVALID_FIELD") -- a light
    refused({ door_ids = { 99 } }, 400, "INVALID_FIELD")
    refused({ door_ids = { 73 } }, 400, "INVALID_FIELD") -- a controller shown as its KNX relay
    refused({ door_ids = { "70" } }, 400, "INVALID_FIELD")
    refused({ door_ids = { 70.5 } }, 400, "INVALID_FIELD")
    refused({ door_ids = MAIN_DOOR }, 400, "INVALID_FIELD")
    refused({ door_ids = { 70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70 } }, 400, "INVALID_FIELD")
    refused({ doors = { 70 } }, 400, "INVALID_FIELD")
    refused({}, 400, "INVALID_REQUEST")
    refused({ door_ids = { 70 } }, 404, "NOT_FOUND", 67) -- a camera that is not a doorbell
    refused({ door_ids = { 70 } }, 404, "NOT_FOUND", 99)
    T.eq(stored(mock), nil, "nothing saved")

    local cook = member(mock, key, "Cook's phone", { all_rooms = true, doors = true })
    local answer = link(mock, cook, { MAIN_DOOR })
    T.eq(answer.status, 403, answer.body)
    T.eq(stored(mock), nil)
end

function tests.a_store_that_cannot_be_written_changes_nothing()
    local mock, key = start()
    T.eq(link(mock, key, { MAIN_DOOR }).status, 200)
    local persist = C4.PersistSetValue
    C4.PersistSetValue = function()
        error("disk full")
    end
    local answer = link(mock, key, { GARAGE })
    C4.PersistSetValue = persist
    T.eq(answer.status, 503, answer.body)
    T.eq(answer.json.code, "UNAVAILABLE")
    T.eq(doorbell(mock, key).doors[2].id, MAIN_DOOR, "the link before stays")
end

function tests.a_store_that_cannot_be_read_is_never_written_over()
    local mock, key = start(nil, function(m)
        m.persist.directorlink_doorbell_doors = "json:{not json"
    end)
    T.same(doorbell(mock, key).doors, { { id = ENTRANCE_GATE, link = "automatic", can_open = true } })
    T.eq(link(mock, key, { MAIN_DOOR }).json.code, "UNAVAILABLE")
    T.eq(mock.persist.directorlink_doorbell_doors, "json:{not json")
end

-- ---- who may open --------------------------------------------------------------------------------

function tests.only_those_who_may_open_the_door_get_its_open()
    local mock, admin = start()
    T.eq(link(mock, admin, { MAIN_GATE }).status, 200) -- in the Living Room
    -- A member in the Kitchen with doors: the gate, not the Living Room's.
    local kitchen = member(mock, admin, "Cook's phone", { all_rooms = false, rooms = { 10 }, doors = true })
    T.same(doorbell(mock, kitchen).doors, { { id = ENTRANCE_GATE, link = "automatic", can_open = true } }, "a door they do not see is not there")
    -- Without doors: the gate is shown, and not theirs to open.
    local kid = member(mock, admin, "Kid's phone", { all_rooms = true })
    T.same(doorbell(mock, kid).doors, {
        { id = ENTRANCE_GATE, link = "automatic", can_open = false },
        { id = MAIN_GATE, link = "manual", can_open = false },
    })
    -- Door Control off in Composer: nobody's.
    Properties["Door Control"] = "Disabled"
    for _, door in ipairs(doorbell(mock, admin).doors) do
        T.eq(door.can_open, false, "Door Control is off")
    end
end

-- ---- opening --------------------------------------------------------------------------------------

function tests.opening_from_the_doorbell_is_the_door_s_own_open_once()
    local mock, key = start()
    local before = #mock.commands
    -- The doorbell itself opens nothing, as before.
    T.eq(T.http(mock, "POST", "/v1/doorbells/" .. ENTRANCE .. "/open", { key = key }).status, 409)
    T.eq(#commandsSince(mock, before), 0)

    local opened = T.http(mock, "POST", "/v1/relays/" .. ENTRANCE_GATE .. "/pulse", { key = key, body = { doorbell = ENTRANCE } })
    T.eq(opened.status, 202, opened.body)
    local sent = commandsSince(mock, before)
    T.eq(#sent, 1, "exactly one command")
    T.eq(sent[1].device, ENTRANCE_GATE_DRIVER, "to the gate's controller")
    T.eq(sent[1].command, "OPEN", "its own Open")

    local entry = T.http(mock, "GET", "/v1/activity?kind=door", { key = key }).json.items[1]
    T.eq(entry.action, "pulse", "an ordinary opening of the door")
    T.eq(entry.what, "Entrance Gate")
    T.eq(entry.who.type, "key")
    T.eq(entry.who.name, "Owner's iPhone")
    T.eq(entry.ids.device_id, ENTRANCE_GATE)
    T.eq(entry.ids.doorbell_id, ENTRANCE, "from the doorbell")
    T.eq(entry.note, "Entrance", "the doorbell's name")

    -- A doorbell the door is not at: opened all the same, the history says nothing of a doorbell.
    T.eq(T.http(mock, "POST", "/v1/relays/" .. MAIN_DOOR .. "/pulse", { key = key, body = { doorbell = ENTRANCE } }).status, 202)
    entry = T.http(mock, "GET", "/v1/activity?kind=door", { key = key }).json.items[1]
    T.eq(entry.what, "Main Door")
    T.eq(entry.ids.doorbell_id, nil)
    T.eq(entry.note, nil)
    -- Anything else in `doorbell` is ignored, as any other body.
    T.eq(T.http(mock, "POST", "/v1/relays/" .. MAIN_DOOR .. "/pulse", { key = key, body = { doorbell = "68" } }).status, 202)
    T.eq(#commandsSince(mock, before), 3)
end

function tests.opening_from_the_doorbell_is_checked_as_any_opening()
    local mock, admin = start()
    local kid = member(mock, admin, "Kid's phone", { all_rooms = true })
    local before = #mock.commands
    local refused = T.http(mock, "POST", "/v1/relays/" .. ENTRANCE_GATE .. "/pulse", { key = kid, body = { doorbell = ENTRANCE } })
    T.eq(refused.status, 403)
    T.eq(refused.json.code, "FORBIDDEN")
    Properties["Door Control"] = "Disabled"
    refused = T.http(mock, "POST", "/v1/relays/" .. ENTRANCE_GATE .. "/pulse", { key = admin, body = { doorbell = ENTRANCE } })
    T.eq(refused.json.code, "DOOR_CONTROL_DISABLED")
    T.eq(#commandsSince(mock, before), 0, "nothing sent")
end

-- ---- backups --------------------------------------------------------------------------------------

-- A request as it runs once opened from a sealed one (as tests/test_backup.lua's `opened`).
local function sealedAs(mock, keyId, method, path, body)
    local status, _, text = require("src.api.server").handleRequest({
        method = method,
        path = path,
        query = {},
        headers = body and { ["content-type"] = "application/json" } or {},
        body = body and Json.encode(body) or "",
        principal = { id = keyId, name = "Owner's iPhone", role = "admin", sealed = true },
    }, { ip = "192.168.1.50", port = "0" })
    return { status = status, json = Json.decode(text), body = text }
end

local function restoreInto(mock, keyId, document)
    local text = Json.encode(document)
    local part = sealedAs(mock, keyId, "POST", "/v1/restore/parts", { index = 0, count = 1, text = text })
    T.eq(part.status, 200, part.body)
    local check = sealedAs(mock, keyId, "POST", "/v1/restore", { upload = part.json.upload })
    T.eq(check.status, 200, check.body)
    local done = sealedAs(mock, keyId, "POST", "/v1/restore", { upload = part.json.upload, dry_run = false })
    T.eq(done.status, 200, done.body)
    return check.json.restore
end

local function keyIdOf(mock, key)
    return T.http(mock, "GET", "/v1/api-keys/current", { key = key }).json.id
end

function tests.a_backup_brings_the_links_back_never_onto_another_door()
    local mock, key = start()
    T.eq(link(mock, key, { MAIN_DOOR, GARAGE }).status, 200)
    local document = sealedAs(mock, keyIdOf(mock, key), "GET", "/v1/backup").json
    T.same(document.sections.doorbell_doors, { version = 1, links = { ["68"] = { MAIN_DOOR, GARAGE } } })
    T.eq(document.references.devices["68"].name, "Entrance")
    T.eq(document.references.devices[tostring(MAIN_DOOR)].name, "Main Door")

    -- A controller whose project was rebuilt: the garage door renamed, the rest as it was.
    local rebuilt = project()
    rebuilt.devices[GARAGE].deviceName = "Carport"
    local fresh, freshKey = start(rebuilt)
    local preview = restoreInto(fresh, keyIdOf(fresh, freshKey), document)
    T.eq(preview.counts.doorbell_doors, 1, "one door stays linked")
    local gone
    for _, entry in ipairs(preview.references.unmatched) do
        if entry.id == GARAGE then
            gone = entry
        end
    end
    T.eq(gone.kind, "relay")
    T.eq(gone.now, "Carport", "a door renamed is not moved")
    T.eq(gone.used_in[1].section, "doorbell_doors")
    T.eq(gone.used_in[1].name, "Entrance")
    local ids = {}
    for _, door in ipairs(doorbell(fresh, freshKey).doors) do
        ids[#ids + 1] = door.id .. ":" .. door.link
    end
    T.same(ids, { "76:automatic", "70:manual" })

    -- A backup made before 1.11.0 (no such section) leaves the links here as they are.
    document.sections.doorbell_doors = nil
    preview = restoreInto(fresh, keyIdOf(fresh, freshKey), document)
    T.eq(preview.counts.doorbell_doors, Json.null)
    T.eq(#doorbell(fresh, freshKey).doors, 2)
end

return tests
