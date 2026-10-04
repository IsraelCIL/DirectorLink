-- Scenes (docs/SCENES.md, src/core/scenes.lua): the home's one-tap actions. Everyone sees them,
-- members and above run them, admins make and change them, and try steps before saving
-- (POST /v1/scenes/try). A run sends the same commands as the device routes do; doors and gates
-- get a pulse (their Open button), only for keys with the doors role and while Door Control is on.
-- POST /v1/off (1.3.0, Home's "Turn off all") runs one step of that kind: lights off, AC off or
-- blinds closed, on the devices it names. A music step (1.5.0, ADR-044) pauses or stops the Sonos
-- music in a room or the whole home; it names no devices. A refrigerators step (1.7.0, ADR-049)
-- switches features of Samsung refrigerators on or off: Sabbath Mode in a Shabbat schedule.

local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Roles = require("src.auth.roles")
local Validate = require("src.api.validate")
local Views = require("src.api.views")
local Scenes = require("src.core.scenes")
local Schedules = require("src.core.schedules")
local Sonos = require("src.sonos.sonos")
local Activity = require("src.core.activity")
local SceneLinks = require("src.core.scene_links")

local Handlers = {}

local KINDS = { lights = "light", climate = "climate", fans = "fan", blinds = "blind", relays = "relay", refrigerators = "refrigerator" }
local LISTS = { lights = "lightList", climate = "climateList", fans = "fanList", blinds = "blindList", relays = "relayList", refrigerators = "refrigeratorList" }
-- A refrigerators step's features, in the order their commands go out.
local REFRIGERATOR_FEATURES = { "power_cool", "power_freeze", "sabbath_mode", "ice_maker" }
local MAX_PROBLEMS = 50
-- Why a music step did nothing (src/sonos/sonos.lua, Sonos.sceneStep): a problem with device_id 0.
local MUSIC_SKIPPED = {
    SONOS_OFF = "Sonos is off; turn on the Sonos property of DirectorLink in Composer",
    NO_PLAYERS = "No Sonos players have been found yet",
    NO_SONOS_ROOM = "No Sonos room is shown in this room",
}

local function nullable(value)
    if value == nil then
        return Json.null
    end
    return value
end

local function isList(value)
    return type(value) == "table" and value ~= Json.null and (Json.isArray(value) or next(value) == nil)
end

local function isWhole(value, minimum, maximum)
    return type(value) == "number" and value == math.floor(value) and value >= minimum and value <= maximum
end

local function contains(list, value)
    for _, item in ipairs(list) do
        if item == value then
            return true
        end
    end
    return false
end

local function stepView(step)
    local set = {}
    for key, value in pairs(step.set) do
        set[key] = value
    end
    return {
        type = step.type,
        room_id = nullable(step.room_id),
        device_ids = step.device_ids and step.device_ids or Json.null,
        set = set,
    }
end

local function view(scene)
    local steps = Json.array()
    for _, step in ipairs(scene.steps) do
        steps[#steps + 1] = stepView(step)
    end
    return {
        id = scene.id,
        name = scene.name,
        icon = scene.icon,
        show_on_home = scene.show_on_home,
        steps = steps,
        created_at = scene.created_at,
        updated_at = scene.updated_at,
        version = scene.version,
    }
end

-- What a step sets, checked for its type; returns the stored form or nil and a problem.
local function validateSet(stepType, set, field)
    if type(set) ~= "table" or set == Json.null or Json.isArray(set) then
        return nil, Problem.invalidField(field, field .. " must be an object")
    end
    local allowed = ({
        lights = { on = true, brightness = true },
        climate = { mode = true, target_temperature = true, fan_speed = true, heat_setpoint = true, cool_setpoint = true },
        fans = { on = true, speed = true },
        blinds = { position = true },
        relays = { action = true },
        music = { action = true },
        refrigerators = Scenes.REFRIGERATOR_FEATURES,
    })[stepType]
    for key in pairs(set) do
        if not allowed[key] then
            return nil, Problem.invalidField(field .. "." .. tostring(key), "Unknown field for " .. stepType .. ": " .. tostring(key))
        end
    end
    if stepType == "lights" then
        if set.on ~= nil and set.brightness ~= nil then
            return nil, Problem.invalidField(field, 'Send either "on" or a brightness, not both')
        end
        if set.brightness ~= nil then
            if not isWhole(set.brightness, 0, 100) then
                return nil, Problem.invalidField(field .. ".brightness", "brightness must be a whole number from 0 to 100")
            end
            return { brightness = set.brightness }
        end
        if type(set.on) ~= "boolean" then
            return nil, Problem.invalidField(field .. ".on", 'lights need "on": true or false, or a brightness')
        end
        return { on = set.on }
    elseif stepType == "climate" then
        local result = {}
        if set.mode ~= nil then
            if not Scenes.MODES[set.mode] then
                return nil, Problem.invalidField(field .. ".mode", "mode must be one of off, heat, cool, auto")
            end
            result.mode = set.mode
        end
        if set.fan_speed ~= nil then
            if not Scenes.FAN_SPEEDS[set.fan_speed] then
                return nil, Problem.invalidField(field .. ".fan_speed", "fan_speed must be one of low, medium, high, auto, on, circulate")
            end
            result.fan_speed = set.fan_speed
        end
        for _, name in ipairs({ "target_temperature", "heat_setpoint", "cool_setpoint" }) do
            local value = set[name]
            if value ~= nil then
                if type(value) ~= "number" or value < Scenes.MIN_TEMPERATURE or value > Scenes.MAX_TEMPERATURE then
                    return nil, Problem.invalidField(field .. "." .. name, name .. " must be a number from 5 to 40")
                end
                result[name] = value
            end
        end
        local heat, cool = result.heat_setpoint, result.cool_setpoint
        if (heat or cool) and result.target_temperature then
            return nil, Problem.invalidField(field, "Send either target_temperature or heat_setpoint/cool_setpoint")
        end
        if heat and cool and cool <= heat then
            return nil, Problem.invalidField(field .. ".cool_setpoint", "cool_setpoint must be above heat_setpoint")
        end
        if next(result) == nil then
            return nil, Problem.invalidField(field, "Set a mode, a temperature or a fan speed")
        end
        if result.mode == "off" and (result.fan_speed or result.target_temperature or heat or cool) then
            return nil, Problem.invalidField(field, 'mode "off" turns the AC off; leave out the temperature, setpoints and fan speed')
        end
        return result
    elseif stepType == "fans" then
        if set.on ~= nil and set.speed ~= nil then
            return nil, Problem.invalidField(field, 'Send either "on" or a speed, not both')
        end
        if set.speed ~= nil then
            if not isWhole(set.speed, 1, Scenes.MAX_FAN_SPEED) then
                return nil, Problem.invalidField(field .. ".speed", "speed must be a whole number from 1 (low) to " .. Scenes.MAX_FAN_SPEED .. " (high)")
            end
            return { speed = set.speed }
        end
        if type(set.on) ~= "boolean" then
            return nil, Problem.invalidField(field .. ".on", 'fans need "on": true or false, or a speed')
        end
        return { on = set.on }
    elseif stepType == "blinds" then
        if not isWhole(set.position, 0, 100) then
            return nil, Problem.invalidField(field .. ".position", "position must be a whole number from 0 (closed) to 100 (open)")
        end
        return { position = set.position }
    end
    if stepType == "refrigerators" then
        local result = {}
        for _, feature in ipairs(REFRIGERATOR_FEATURES) do
            if set[feature] ~= nil then
                if type(set[feature]) ~= "boolean" then
                    return nil, Problem.invalidField(field .. "." .. feature, feature .. " must be true (on) or false (off)")
                end
                result[feature] = set[feature]
            end
        end
        if next(result) == nil then
            return nil, Problem.invalidField(field, "Set at least one of power_cool, power_freeze, sabbath_mode, ice_maker")
        end
        return result
    end
    if stepType == "music" then
        if not Scenes.MUSIC_ACTIONS[set.action] then
            return nil, Problem.invalidField(field .. ".action", 'music takes {"action": "pause"} or {"action": "stop"}')
        end
        return { action = set.action }
    end
    -- A door or gate relay is only pulsed, like its Open button: holding it closed would keep the
    -- door unlocked or the gate's input pressed.
    if set.action ~= "pulse" then
        return nil, Problem.invalidField(field .. ".action", 'doors and gates take {"action": "pulse"}, like their Open button')
    end
    return { action = "pulse" }
end

-- 1 to `maximum` ids of supported devices of the step type, without repeats; nil and a problem
-- otherwise.
local function validateDeviceIds(registry, ids, stepType, field, maximum)
    if not isList(ids) or #ids == 0 or #ids > maximum then
        return nil, Problem.invalidField(field, "device_ids must be a list of 1 to " .. maximum .. " device ids")
    end
    local deviceIds = Json.array()
    local seen = {}
    for _, id in ipairs(ids) do
        local device = isWhole(id, 1, math.huge) and registry.getDevice(id) or nil
        if not device or device.kind ~= KINDS[stepType] or device.supported ~= true then
            return nil, Problem.invalidField(field, "Device " .. tostring(id) .. " is not one of this home's " .. stepType)
        end
        if not seen[id] then
            seen[id] = true
            deviceIds[#deviceIds + 1] = id
        end
    end
    return deviceIds
end

local function validateStep(registry, item, field)
    if type(item) ~= "table" or item == Json.null or Json.isArray(item) then
        return nil, Problem.invalidField(field, field .. " must be an object")
    end
    for key in pairs(item) do
        if key ~= "type" and key ~= "room_id" and key ~= "device_ids" and key ~= "set" then
            return nil, Problem.invalidField(field .. "." .. tostring(key), "Unknown field: " .. tostring(key))
        end
    end
    local stepType = item.type
    if type(stepType) ~= "string" or not (KINDS[stepType] or stepType == "music") then
        return nil, Problem.invalidField(field .. ".type", "type must be one of lights, climate, fans, blinds, relays, music, refrigerators")
    end
    local roomId = nil
    if item.room_id ~= nil and item.room_id ~= Json.null then
        if not isWhole(item.room_id, 1, math.huge) or not (registry.rooms or {})[item.room_id] then
            return nil, Problem.invalidField(field .. ".room_id", "Unknown room: " .. tostring(item.room_id))
        end
        roomId = item.room_id
    end
    local deviceIds = nil
    if stepType == "music" and item.device_ids ~= nil and item.device_ids ~= Json.null then
        return nil, Problem.invalidField(field .. ".device_ids", "A music step names a room (room_id), or none for the whole home")
    end
    if item.device_ids ~= nil and item.device_ids ~= Json.null then
        local problem
        deviceIds, problem = validateDeviceIds(registry, item.device_ids, stepType, field .. ".device_ids", Scenes.MAX_DEVICES)
        if not deviceIds then
            return nil, problem
        end
    end
    local set, problem = validateSet(stepType, item.set, field .. ".set")
    if not set then
        return nil, problem
    end
    -- The same rules the store applies when it loads.
    set = Scenes.cleanSet(stepType, set)
    if not set then
        return nil, Problem.invalidField(field .. ".set", "This step is not valid")
    end
    return { type = stepType, room_id = roomId, device_ids = deviceIds, set = set }
end

local function validateSteps(registry, steps)
    if not isList(steps) or #steps > Scenes.MAX_STEPS then
        return nil, Problem.invalidField("steps", "steps must be a list of at most " .. Scenes.MAX_STEPS .. " steps")
    end
    local result = {}
    for index, item in ipairs(steps) do
        local step, problem = validateStep(registry, item, "steps[" .. (index - 1) .. "]")
        if not step then
            return nil, problem
        end
        result[#result + 1] = step
    end
    return result
end

-- The scene fields of a POST or PATCH body; `creating` requires the name.
local function validateFields(ctx, body, creating)
    local fields = {}
    if creating or body.name ~= nil then
        local name, problem = Validate.name(body.name, "name")
        if problem then
            return nil, problem
        end
        if not name then
            return nil, Problem.invalidField("name", "name is required")
        end
        fields.name = name
    end
    if body.icon ~= nil then
        if type(body.icon) ~= "string" or not Scenes.ICONS[body.icon] then
            return nil, Problem.invalidField("icon", "icon must be one of moon, sun, leave, movie, bulb, climate, blinds, home")
        end
        fields.icon = body.icon
    end
    if body.show_on_home ~= nil then
        if type(body.show_on_home) ~= "boolean" then
            return nil, Problem.invalidField("show_on_home", "show_on_home must be true or false")
        end
        fields.show_on_home = body.show_on_home
    end
    if body.steps ~= nil then
        local steps, problem = validateSteps(ctx.services.registry, body.steps)
        if not steps then
            return nil, problem
        end
        fields.steps = steps
    end
    return fields
end

-- A change the store could not make: not read at start (it would overwrite the saved scenes) or
-- not saved.
local function storeProblem(failure, what)
    if failure == "STORE_UNREADABLE" then
        return Problem.new(503, "UNAVAILABLE", "The saved scenes could not be read when DirectorLink started; restart the driver and try again")
    end
    return Problem.internal("The scene could not be " .. what)
end

local function findScene(ctx)
    local id = tostring(ctx.params.sceneId or "")
    if #id ~= 8 or not id:match("^[%da-f]+$") then
        return nil, Problem.invalidParameter("sceneId", "sceneId is 8 hex characters")
    end
    local scene = Scenes.find(id)
    if not scene then
        return nil, Problem.notFound("Scene", id)
    end
    return scene
end

-- The devices a step works on: the ones it names, or all of its kind in its room (or the home).
local function stepDevices(registry, step)
    if step.device_ids then
        local devices = {}
        for _, id in ipairs(step.device_ids) do
            local device = registry.getDevice(id)
            if device and device.kind == KINDS[step.type] and device.supported == true then
                devices[#devices + 1] = device
            else
                devices[#devices + 1] = { id = id, missing = true }
            end
        end
        return devices
    end
    local devices = {}
    for _, device in ipairs(registry[LISTS[step.type]]()) do
        if step.room_id == nil or tonumber(device.room_id) == step.room_id then
            devices[#devices + 1] = device
        end
    end
    return devices
end

-- "a; b": what a step leaves out on one device, when more than one thing is.
local function also(leftOut, detail)
    return leftOut and (leftOut .. "; " .. detail) or detail
end

-- The temperature commands of a climate step. A thermostat with heat and cool setpoints takes
-- them as they are, and a target as the setpoint of the mode; one with a single target takes the
-- setpoint of the mode it will be in. Returns the command, or nil and what is left out.
local function temperatureCommand(set, device, options)
    local function clamp(value)
        return math.max(options.min, math.min(options.max, value))
    end
    local heat, cool = set.heat_setpoint, set.cool_setpoint
    -- The step's mode, else the one the thermostat reports: the mode command sent just before
    -- changes the reported one only later.
    local mode = set.mode or string.lower(tostring((device.state or {}).hvac_mode or ""))
    if Views.isDual(device) then
        if set.target_temperature then
            if mode ~= "heat" and mode ~= "cool" then
                return nil, "In " .. (mode ~= "" and mode or "this mode") .. " this thermostat takes a heat and a cool setpoint"
            end
            return { action = "set_temperature", params = { value = clamp(set.target_temperature), mode = set.mode } }
        end
        return { action = "set_setpoints", params = { heat = heat and clamp(heat), cool = cool and clamp(cool) } }
    end
    if set.target_temperature then
        -- Thermostat V2 reads only the value.
        return { action = "set_temperature", params = { value = clamp(set.target_temperature), mode = set.mode } }
    end
    local value = (mode == "heat" and heat) or (mode == "cool" and cool) or nil
    if not value then
        return nil, "This thermostat has one target temperature"
    end
    return { action = "set_temperature", params = { value = clamp(value) } }
end

-- The adapter commands for one device, or nil and why it is skipped; then what is left out, if
-- anything (a fan speed the unit does not have, a setpoint it cannot take).
local function deviceCommands(step, device)
    local set = step.set
    if step.type == "lights" then
        if set.on == false or set.brightness == 0 then
            return { { action = "off" } }
        end
        if type(set.brightness) == "number" and device.capabilities and device.capabilities.brightness then
            return { { action = "set_brightness", params = { value = set.brightness } } }
        end
        if set.on == true or type(set.brightness) == "number" then
            return { { action = "on" } }
        end
        return nil, "INVALID_STEP", "This step does not say what to do"
    elseif step.type == "climate" then
        local options = Views.thermostatOptions(device)
        local commands, leftOut = {}, nil
        if set.mode then
            if not contains(options.modes, set.mode) then
                return nil, "MODE_NOT_SUPPORTED", "This thermostat does not support mode " .. set.mode
            end
            commands[#commands + 1] = { action = "set_hvac_mode", params = { value = set.mode } }
        end
        if set.fan_speed then
            if contains(options.fan_speeds, set.fan_speed) then
                commands[#commands + 1] = { action = "set_fan_mode", params = { value = set.fan_speed } }
            else
                leftOut = "This thermostat has no fan speed " .. set.fan_speed
            end
        end
        if set.target_temperature or set.heat_setpoint or set.cool_setpoint then
            local command, why = temperatureCommand(set, device, options)
            if command then
                command.check = true
                commands[#commands + 1] = command
            else
                leftOut = also(leftOut, why)
            end
        end
        if #commands == 0 then
            return nil, "NOT_SUPPORTED", leftOut or "Nothing in this step applies to this thermostat"
        end
        return commands, leftOut
    elseif step.type == "fans" then
        if set.on == false then
            return { { action = "off" } }
        end
        if type(set.speed) == "number" then
            return { { action = "set_speed", params = { speed = set.speed } } }
        end
        return { { action = "on" } }
    elseif step.type == "blinds" then
        -- Checked first: a shade that only opens and closes fully is skipped for a position between.
        return { { action = "set_position", params = { position = set.position }, check = true } }
    elseif step.type == "refrigerators" then
        -- Checked first: a feature the refrigerator does not have is left out, the others still go.
        local commands = {}
        for _, feature in ipairs(REFRIGERATOR_FEATURES) do
            if set[feature] ~= nil then
                commands[#commands + 1] = { action = "set_feature", params = { feature = feature, on = set[feature] }, check = true }
            end
        end
        return commands
    end
    return { { action = "pulse" } }
end

-- The thermostat checks its setpoint commands before anything is sent to it: one it refuses (heat
-- and cool closer than its deadband, no room to move the other one) is left out, and the rest of
-- the step still runs on it, like a fan speed it does not have.
local function withoutRefused(services, device, commands, leftOut)
    local kept = {}
    for _, command in ipairs(commands) do
        local ok, failure = true, nil
        if command.check then
            ok, failure = services.adapters.prepare(device.id, command.action, command.params)
        end
        if ok then
            kept[#kept + 1] = command
        else
            leftOut = also(leftOut, failure and failure.message or "This thermostat refused the temperature")
        end
    end
    return kept, leftOut
end

-- Runs `steps` in order and reports what happened to each device: sent (ran), not for this key or
-- not possible (skipped), or refused by the controller (failed). A device that ran with a setting
-- left out is listed in `problems` as "partial" (it counts as ran). `via`: the scene's name, for the
-- history of the doors it opens.
local function run(ctx, steps, via)
    local services = ctx.services
    local result = { ran = 0, skipped = 0, failed = 0, problems = Json.array() }
    local function note(outcome, index, deviceId, code, detail)
        if outcome ~= "partial" then
            result[outcome] = result[outcome] + 1
        end
        if #result.problems < MAX_PROBLEMS then
            result.problems[#result.problems + 1] = { step = index, device_id = deviceId, outcome = outcome, code = code, detail = detail }
        end
    end
    for index, step in ipairs(steps) do
        local refusal, why
        if step.type == "music" then
            -- The Sonos groups with a room in the step's room (or every group): each one handled
            -- counts as ran (one that does not play is left as it is); what the players answer is
            -- not waited for (src/sonos/sonos.lua). None: skipped, and why (MUSIC_SKIPPED).
            local sent, missing = Sonos.sceneStep(step.room_id, step.set.action)
            if sent then
                result.ran = result.ran + #sent
            else
                note("skipped", index, 0, missing, MUSIC_SKIPPED[missing] or MUSIC_SKIPPED.NO_PLAYERS)
            end
        elseif step.type == "relays" then
            if not Roles.allows(ctx.apiKey.role, "doors") then
                refusal, why = "FORBIDDEN", "Doors and gates run only for keys with door access"
            elseif not services.doorControlEnabled() then
                refusal, why = "DOOR_CONTROL_DISABLED", "Door control is off; turn on the Door Control property of DirectorLink in Composer"
            end
        end
        for _, device in ipairs(step.type == "music" and {} or stepDevices(services.registry, step)) do
            if device.missing then
                note("skipped", index, device.id, "NOT_FOUND", "This device is no longer in the project")
            elseif refusal then
                note("skipped", index, device.id, refusal, why)
            else
                local commands, code, detail = deviceCommands(step, device)
                local leftOut = commands and code or nil
                if commands then
                    commands, leftOut = withoutRefused(services, device, commands, leftOut)
                    if #commands == 0 then
                        commands, code, detail = nil, "NOT_SUPPORTED", leftOut
                    end
                end
                if not commands then
                    note("skipped", index, device.id, code, detail)
                else
                    local failure
                    for _, command in ipairs(commands) do
                        local ok, problem = services.adapters.execute(device.id, command.action, command.params)
                        if not ok then
                            failure = Problem.fromAdapter(problem)
                            break
                        end
                    end
                    if failure then
                        note("failed", index, device.id, failure.code, failure.detail)
                    else
                        result.ran = result.ran + 1
                        if leftOut then
                            note("partial", index, device.id, "NOT_SUPPORTED", leftOut)
                        end
                        if step.type == "relays" then
                            services.log.info("relay_command", "relay pulse requested by a scene", {
                                device_id = device.id,
                                key_id = ctx.apiKey.id,
                                client = ctx.client and ctx.client.ip or Json.null,
                            })
                            Activity.record("door", "pulse", { by = ctx.apiKey, what = device.name, room = device.room_name, via = via, ids = { device_id = device.id, room_id = device.room_id } })
                        end
                    end
                end
            end
        end
    end
    return result
end

function Handlers.list(ctx)
    local items = Json.array()
    for _, scene in ipairs(Scenes.list()) do
        items[#items + 1] = view(scene)
    end
    return 200, { items = items }
end

function Handlers.get(ctx)
    local scene, problem = findScene(ctx)
    if not scene then
        return problem
    end
    return 200, view(scene)
end

function Handlers.create(ctx)
    local body = ctx.body
    local problem = Validate.body(body, { name = true, icon = true, show_on_home = true, steps = true }, true)
    if problem then
        return problem
    end
    local fields
    fields, problem = validateFields(ctx, body, true)
    if not fields then
        return problem
    end
    local scene, failure = Scenes.create(fields)
    if not scene then
        if failure == "SCENE_LIMIT_REACHED" then
            return Problem.new(409, failure, "This home has " .. Scenes.MAX_SCENES .. " scenes, as many as it allows")
        end
        return storeProblem(failure, "saved")
    end
    ctx.services.log.info("scenes", "scene created", { scene = scene.id, steps = #scene.steps, by = ctx.apiKey.id })
    return 201, view(scene)
end

-- PATCH {"name": ..., "steps": [...], "version": 3}: with `version`, only if nobody changed the
-- scene since (409 VERSION_CONFLICT).
function Handlers.update(ctx)
    local scene, problem = findScene(ctx)
    if not scene then
        return problem
    end
    local body = ctx.body
    problem = Validate.body(body, { name = true, icon = true, show_on_home = true, steps = true, version = true }, true)
    if problem then
        return problem
    end
    if body.version ~= nil and not isWhole(body.version, 1, math.huge) then
        return Problem.invalidField("version", "version must be the scene's version, a whole number")
    end
    local fields
    fields, problem = validateFields(ctx, body, false)
    if not fields then
        return problem
    end
    if next(fields) == nil then
        return Problem.invalidRequest("Send at least one of name, icon, show_on_home or steps")
    end
    local updated, failure = Scenes.update(scene.id, fields, body.version)
    if not updated then
        if failure == "VERSION_CONFLICT" then
            return Problem.new(409, failure, "The scene was changed on another device; read it again", { version = scene.version })
        elseif failure == "NOT_FOUND" then
            return Problem.notFound("Scene", scene.id)
        end
        return storeProblem(failure, "saved")
    end
    ctx.services.log.info("scenes", "scene changed", { scene = scene.id, by = ctx.apiKey.id })
    -- A scene that now opens doors or gates loses its link (ADR-051); the app warns before saving.
    SceneLinks.sceneChanged(updated, ctx.apiKey)
    return 200, view(updated)
end

function Handlers.delete(ctx)
    local scene, problem = findScene(ctx)
    if not scene then
        return problem
    end
    -- Unknown which schedules run it while they could not be read.
    if not Schedules.complete() then
        return Problem.new(503, "UNAVAILABLE", "The saved schedules could not be read when DirectorLink started; restart the driver and try again")
    end
    local schedules = Schedules.usingScene(scene.id)
    if schedules > 0 then
        return Problem.new(409, "SCENE_IN_USE", "Schedules run this scene; change or delete them first", { schedules = schedules })
    end
    local deleted, failure = Scenes.delete(scene.id)
    if not deleted then
        if failure == "NOT_FOUND" then
            return Problem.notFound("Scene", scene.id)
        end
        return storeProblem(failure, "deleted")
    end
    ctx.services.log.info("scenes", "scene deleted", { scene = scene.id, by = ctx.apiKey.id })
    -- Its link goes with it (ADR-051).
    SceneLinks.sceneDeleted(scene.id, scene.name, ctx.apiKey)
    return 204
end

-- A saved scene run by the controller itself (schedules): `caller` { id, role } stands for the key.
function Handlers.runSaved(services, sceneId, caller)
    local scene = Scenes.find(sceneId)
    if not scene then
        return nil, "SCENE_NOT_FOUND"
    end
    return run({ services = services, apiKey = caller }, scene.steps)
end

function Handlers.run(ctx)
    local scene, problem = findScene(ctx)
    if not scene then
        return problem
    end
    local result = run(ctx, scene.steps, scene.name)
    result.scene_id = scene.id
    Activity.record("scene", "run", { by = ctx.apiKey, what = scene.name, counts = result, ids = { scene_id = scene.id } })
    -- Shown to the installer in Composer (Last Automation), with the device that ran it.
    if ctx.services.onAutomation then
        local key = ctx.services.keys and ctx.services.keys.find and ctx.services.keys.find(ctx.apiKey.id)
        pcall(ctx.services.onAutomation, { at = os.time(), scene_id = scene.id, key_name = key and key.name or nil, result = result })
    end
    ctx.services.log.info("scenes", "scene ran", {
        scene = scene.id, by = ctx.apiKey.id, ran = result.ran, skipped = result.skipped, failed = result.failed,
    })
    return 202, result
end

-- POST {"steps": [...]}: runs steps once without saving them, for "Try it now" (admins).
function Handlers.try(ctx)
    local body = ctx.body
    local problem = Validate.body(body, { steps = true }, true)
    if problem then
        return problem
    end
    local steps
    steps, problem = validateSteps(ctx.services.registry, body.steps)
    if not steps then
        return problem
    end
    local result = run(ctx, steps)
    ctx.services.log.info("scenes", "steps tried", { steps = #steps, by = ctx.apiKey.id, ran = result.ran })
    return 202, result
end

-- What POST /v1/off does to each type: never anything that opens or turns on.
local OFF = { lights = { on = false }, climate = { mode = "off" }, blinds = { position = 0 } }
local MAX_OFF_DEVICES = 500

-- POST {"type": "lights" | "climate" | "blinds", "device_ids": [...]}: turns off those lights or
-- thermostats, or closes those blinds, in one request (members): Home's "Turn off all" in the app,
-- which names the ones it shows on or open. Answers like running a scene.
function Handlers.off(ctx)
    local body = ctx.body
    local problem = Validate.body(body, { type = true, device_ids = true }, true)
    if problem then
        return problem
    end
    local offType = body.type
    if type(offType) ~= "string" or not OFF[offType] then
        return Problem.invalidField("type", "type must be one of lights, climate, blinds")
    end
    local deviceIds
    deviceIds, problem = validateDeviceIds(ctx.services.registry, body.device_ids, offType, "device_ids", MAX_OFF_DEVICES)
    if not deviceIds then
        return problem
    end
    local result = run(ctx, { { type = offType, device_ids = deviceIds, set = OFF[offType] } })
    Activity.record("scene", "off", { by = ctx.apiKey, note = offType, counts = result })
    ctx.services.log.info("scenes", "turned off", {
        type = offType, devices = #deviceIds, by = ctx.apiKey.id, ran = result.ran, skipped = result.skipped, failed = result.failed,
    })
    return 202, result
end

return Handlers
