local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local Views = require("src.api.views")
local Activity = require("src.core.activity")
local Access = require("src.auth.access")
local DoorbellDoors = require("src.core.doorbell_doors")
local RelayController = require("src.adapters.relay_controller")

local Doorbells = {}

local function findDoorbell(ctx)
    local id, problem = Validate.id(ctx.params.doorbellId, "doorbellId")
    if not id then
        return nil, problem
    end
    -- A DoorBird's doorstation, or a camera that is a doorbell (ADR-065), as a doorbell.
    local device = ctx.services.registry.getDoorbell(id)
    -- A doorbell the caller may not see is, for them, one that does not exist (ADR-054).
    if not device or device.kind ~= "doorbell" or device.supported ~= true or not Access.canSee(ctx.apiKey, device) then
        return nil, Problem.notFound("Doorbell", id)
    end
    return device
end

-- A door or gate of the project DirectorLink shows now (a relay, ADR-069's controllers' doors too).
local function shownDoor(registry, id)
    local door = registry.getDevice(tonumber(id))
    if type(door) == "table" and door.kind == "relay" and door.supported == true then
        return door
    end
    return nil
end

-- The doorbell's doors (1.11.0, ADR-078): each door or gate at it, once, those found by themselves
-- first (a Relay Door, Gate or Garage Door Controller on the doorbell camera's driver's relay,
-- `automatic`), then those an admin linked (`manual`); only doors the caller sees (ADR-054: a door
-- they may not see does not exist for them), and with `can_open` when they may open it now
-- (Access.canOpen, and Door Control on). The doorbell opens none of them itself: each is opened with
-- its own Open (POST /v1/relays/{id}/pulse), so nobody gets a door they could not open there.
function Doorbells.doors(ctx, device)
    local registry = ctx.services.registry
    local list, seen = Json.array(), {}
    local doorControl = ctx.services.doorControlEnabled ~= nil and ctx.services.doorControlEnabled() == true
    local function add(id, link)
        id = tonumber(id)
        if not id or seen[id] then
            return
        end
        seen[id] = true
        local door = shownDoor(registry, id)
        if door and Access.canSee(ctx.apiKey, door) then
            list[#list + 1] = { id = id, link = link, can_open = doorControl and Access.canOpen(ctx.apiKey, door) }
        end
    end
    for _, id in ipairs(RelayController.doorsAtDoorbell(registry, device)) do
        add(id, "automatic")
    end
    for _, id in ipairs(DoorbellDoors.get(device.id)) do
        add(id, "manual")
    end
    return list
end

-- Its picture only for those who may see it (ADR-054: a member with cameras).
local function view(ctx, device)
    local result = Views.doorbell(ctx.services.registry, device)
    if not Access.canSeePictures(ctx.apiKey, device) then
        result.camera = Json.null
    end
    result.doors = Doorbells.doors(ctx, device)
    return result
end

function Doorbells.list(ctx)
    local roomId, problem = Validate.optionalInteger(ctx.query.room_id, "room_id", 1)
    if problem then
        return problem
    end
    local registry = ctx.services.registry
    local items = Json.array()
    for _, device in ipairs(Access.filter(ctx.apiKey, registry.doorbellList())) do
        if roomId == nil or tonumber(device.room_id) == roomId then
            items[#items + 1] = view(ctx, device)
        end
    end
    return 200, { items = items }
end

function Doorbells.get(ctx)
    local device, problem = findDoorbell(ctx)
    if not device then
        return problem
    end
    return 200, view(ctx, device)
end

-- Opens the gate or door wired to the DoorBird, like its button in the Control4 app.
function Doorbells.open(ctx)
    local device, problem = findDoorbell(ctx)
    if not device then
        return problem
    end
    -- One that opens nothing (a doorbell camera, a DoorBird without its button) says so first,
    -- whatever Door Control and the caller's doors: no setting would let it open.
    if not (device.capabilities and device.capabilities.open == true) then
        return Problem.fromAdapter({
            code = "ACTION_NOT_SUPPORTED",
            message = device.camera_doorbell and "This doorbell has nothing to open" or "This DoorBird has no button to open with",
        })
    end
    if not Access.canOpen(ctx.apiKey, device) then
        return Problem.new(403, "FORBIDDEN", "Opening doors and gates is not among this person's permissions")
    end
    if not ctx.services.doorControlEnabled() then
        return Problem.new(403, "DOOR_CONTROL_DISABLED",
            "Door control is off; turn on the Door Control property of DirectorLink in Composer")
    end
    local ok, failure = ctx.services.adapters.execute(device.id, "open")
    if not ok then
        return Problem.fromAdapter(failure)
    end
    ctx.services.log.info("doorbell_command", "open requested", {
        device_id = device.id,
        key_id = ctx.apiKey and ctx.apiKey.id or Json.null,
        client = ctx.client and ctx.client.ip or Json.null,
    })
    Activity.record("door", "doorbell", { by = ctx.apiKey, what = device.name, room = device.room_name, ids = { device_id = device.id, room_id = device.room_id } })
    return 202, view(ctx, device)
end

-- PUT {"door_ids": [ids]} (1.11.0, ADR-078, admins): the doors and gates an admin links to the
-- doorbell, replacing the ones linked before ([] removes them). Each must be a door or gate
-- DirectorLink shows (GET /v1/relays), at most DoorbellDoors.MAX_DOORS; one found by itself (its
-- controller on the doorbell's relay) is at the doorbell already and is not kept again. A link opens
-- nothing: who may open each door, and Door Control, decide as for the door itself.
function Doorbells.set_doors(ctx)
    local device, problem = findDoorbell(ctx)
    if not device then
        return problem
    end
    local body = ctx.body
    problem = Validate.body(body, { door_ids = true }, true)
    if problem then
        return problem
    end
    local ids = body.door_ids
    if type(ids) ~= "table" or ids == Json.null or not (Json.isArray(ids) or next(ids) == nil) then
        return Problem.invalidField("door_ids", "door_ids must be a list of door and gate ids")
    end
    if #ids > DoorbellDoors.MAX_DOORS then
        return Problem.invalidField("door_ids", "At most " .. DoorbellDoors.MAX_DOORS .. " doors and gates can be linked to a doorbell")
    end
    local registry = ctx.services.registry
    local automatic = {}
    for _, id in ipairs(RelayController.doorsAtDoorbell(registry, device)) do
        automatic[id] = true
    end
    local doors, seen = {}, {}
    for _, value in ipairs(ids) do
        local id = type(value) == "number" and value == math.floor(value) and value >= 1 and value or nil
        if not id or not shownDoor(registry, id) then
            return Problem.invalidField("door_ids", tostring(value) .. " is not a door or gate DirectorLink shows")
        end
        if not seen[id] and not automatic[id] then
            seen[id] = true
            doors[#doors + 1] = id
        end
    end
    local saved, why = DoorbellDoors.set(device.id, doors, function(doorbellId)
        return registry.getDoorbell(doorbellId) ~= nil
    end)
    if not saved and why == "LIMIT_REACHED" then
        return Problem.new(409, "DOORBELL_LINK_LIMIT_REACHED",
            "Doors are linked to " .. DoorbellDoors.MAX_DOORBELLS .. " doorbells already: remove the links of another doorbell first")
    elseif not saved then
        return Problem.new(503, "UNAVAILABLE", "The doors linked to doorbells could not be saved; nothing changed")
    end
    ctx.services.log.info("doorbell", "doors linked to a doorbell changed", {
        device_id = device.id,
        doors = #doors > 0 and table.concat(doors, ",") or "none",
        key_id = ctx.apiKey and ctx.apiKey.id or Json.null,
    })
    return 200, view(ctx, device)
end

-- The doorbell a door's Open came from (POST /v1/relays/{id}/pulse with {"doorbell": id}, 1.11.0,
-- ADR-078), for the history: { id, name } when it is a doorbell the caller sees whose doors include
-- `door`; else nil (the opening is the door's own all the same).
function Doorbells.at(ctx, door, doorbellId)
    local id = type(doorbellId) == "number" and doorbellId == math.floor(doorbellId) and doorbellId >= 1 and doorbellId or nil
    local device = id and ctx.services.registry.getDoorbell(id) or nil
    if not device or device.supported ~= true or not Access.canSee(ctx.apiKey, device) then
        return nil
    end
    for _, item in ipairs(Doorbells.doors(ctx, device)) do
        if item.id == tonumber(door.id) then
            return { id = id, name = device.name }
        end
    end
    return nil
end

return Doorbells
