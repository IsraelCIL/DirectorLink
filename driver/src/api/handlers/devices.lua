local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local Views = require("src.api.views")
local Access = require("src.auth.access")

local Devices = {}

local TYPES = {
    light = true,
    thermostat = true,
    fan = true,
    blind = true,
    camera = true,
    relay = true,
    doorbell = true,
    refrigerator = true,
    other = true,
}

-- A device as the caller sees it: `part_of` names only a device they see too (ADR-054), and
-- `part_of_music` (1.11.0, ADR-080) is for those who have Music there (a kind a member is given).
local function view(ctx, registry, device)
    local sonosEnabled = ctx.services.sonosEnabled
    local item = Views.device(registry, device, sonosEnabled ~= nil and sonosEnabled() == true)
    if item.part_of ~= Json.null and not Access.canSee(ctx.apiKey, registry.getDevice(item.part_of)) then
        item.part_of = Json.null
    end
    if item.part_of_music and not Access.canSee(ctx.apiKey, { id = device.id, kind = "music", room_id = device.room_id }) then
        item.part_of_music = false
    end
    return item
end

function Devices.list(ctx)
    local query = ctx.query
    local roomId, roomProblem = Validate.optionalInteger(query.room_id, "room_id", 1)
    if roomProblem then
        return roomProblem
    end
    if query.type ~= nil and not TYPES[query.type] then
        return Problem.invalidParameter("type", "type must be one of light, thermostat, fan, blind, camera, relay, doorbell, refrigerator, other")
    end
    local supported, supportedProblem = Validate.optionalBoolean(query.supported, "supported")
    if supportedProblem then
        return supportedProblem
    end

    local registry = ctx.services.registry
    local items = Json.array()
    for _, device in ipairs(registry.deviceList()) do
        -- A camera that is a doorbell (ADR-065) is a camera, and with type=doorbell the doorbell it
        -- is too, as /v1/doorbells lists it (seen as a doorbell is: ADR-054).
        if query.type == "doorbell" and device.kind ~= "doorbell" then
            device = registry.getDoorbell(device.id) or device
        end
        if Access.canSee(ctx.apiKey, device) then
            local item = view(ctx, registry, device)
            if (roomId == nil or tonumber(device.room_id) == roomId)
                and (query.type == nil or item.type == query.type)
                and (supported == nil or item.supported == supported) then
                items[#items + 1] = item
            end
        end
    end
    return 200, { items = items }
end

function Devices.get(ctx)
    local id, problem = Validate.id(ctx.params.deviceId, "deviceId")
    if not id then
        return problem
    end
    local registry = ctx.services.registry
    local device = registry.getDevice(id)
    -- A device the caller may not see is, for them, one that does not exist (ADR-054).
    if not device or not Access.canSee(ctx.apiKey, device) then
        return Problem.notFound("Device", id)
    end
    return 200, view(ctx, registry, device)
end

return Devices
