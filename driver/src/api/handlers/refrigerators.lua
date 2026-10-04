local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local Views = require("src.api.views")

-- Samsung refrigerators (1.7.0, ADR-049; src/adapters/refrigerator.lua): temperatures, doors, the
-- water filter, and Power Cool, Power Freeze, Sabbath Mode and the ice maker switched on and off.
local Refrigerators = {}

-- The features PATCH takes, in the order their commands go out.
local FEATURES = { "power_cool", "power_freeze", "sabbath_mode", "ice_maker" }

local function findRefrigerator(ctx)
    local id, problem = Validate.id(ctx.params.refrigeratorId, "refrigeratorId")
    if not id then
        return nil, problem
    end
    local device = ctx.services.registry.getDevice(id)
    if not device or device.kind ~= "refrigerator" or device.supported ~= true then
        return nil, Problem.notFound("Refrigerator", id)
    end
    return device
end

function Refrigerators.list(ctx)
    local roomId, problem = Validate.optionalInteger(ctx.query.room_id, "room_id", 1)
    if problem then
        return problem
    end
    local registry = ctx.services.registry
    local items = Json.array()
    for _, device in ipairs(registry.refrigeratorList()) do
        if roomId == nil or tonumber(device.room_id) == roomId then
            items[#items + 1] = Views.refrigerator(registry, device)
        end
    end
    return 200, { items = items }
end

function Refrigerators.get(ctx)
    local device, problem = findRefrigerator(ctx)
    if not device then
        return problem
    end
    return 200, Views.refrigerator(ctx.services.registry, device)
end

-- PATCH {"sabbath_mode": true} (any of power_cool, power_freeze, sabbath_mode, ice_maker) switches
-- those features. Every one is checked before anything is sent: a feature this refrigerator does not
-- have is refused (409 FEATURE_NOT_SUPPORTED) and nothing goes out. The answer (202) is the state
-- last reported: the refrigerator confirms through Samsung's cloud a few seconds later.
function Refrigerators.update(ctx)
    local device, problem = findRefrigerator(ctx)
    if not device then
        return problem
    end
    local body = ctx.body
    problem = Validate.body(body, { power_cool = true, power_freeze = true, sabbath_mode = true, ice_maker = true }, true)
    if problem then
        return problem
    end
    local commands = {}
    for _, feature in ipairs(FEATURES) do
        if body[feature] ~= nil then
            if type(body[feature]) ~= "boolean" then
                return Problem.invalidField(feature, feature .. " must be true (on) or false (off)")
            end
            commands[#commands + 1] = { feature = feature, on = body[feature] }
        end
    end
    local adapters = ctx.services.adapters
    for _, command in ipairs(commands) do
        local ok, failure = adapters.prepare(device.id, "set_feature", command)
        if not ok then
            return Problem.fromAdapter(failure)
        end
    end
    for _, command in ipairs(commands) do
        local ok, failure = adapters.execute(device.id, "set_feature", command)
        if not ok then
            return Problem.fromAdapter(failure)
        end
    end
    return 202, Views.refrigerator(ctx.services.registry, device)
end

return Refrigerators
