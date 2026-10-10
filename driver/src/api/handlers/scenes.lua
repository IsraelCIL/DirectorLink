-- Scenes (docs/SCENES.md, src/core/scenes.lua): the home's one-tap actions. Admins make and change
-- them, and try steps before saving (POST /v1/scenes/try); a member sees and runs only the scenes an
-- admin chose for them (ADR-054), in full. A run sends the same commands as the device routes do;
-- doors and gates get a pulse (their Open button), while Door Control is on, never when DirectorLink
-- runs a scene itself (schedules, scene links). POST /v1/off (1.3.0, Home's "Turn off all") runs one
-- step of that kind: lights off, AC off or blinds closed, on the devices it names (a member's own).
-- A music step (1.5.0, ADR-044) pauses or stops the Sonos music in a room or the whole home; it
-- names no devices. Since 1.8.0 (ADR-057) it also resumes it, sets the volume, or plays a Sonos
-- favorite in a room, with other rooms grouped with it. A refrigerators step (1.7.0, ADR-049)
-- switches features of Samsung refrigerators on or off: Sabbath Mode in a Shabbat schedule.

local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Access = require("src.auth.access")
local Validate = require("src.api.validate")
local Views = require("src.api.views")
local Scenes = require("src.core.scenes")
local Schedules = require("src.core.schedules")
local Sonos = require("src.sonos.sonos")
local Activity = require("src.core.activity")
local SceneLinks = require("src.core.scene_links")
local LastModes = require("src.core.last_modes")

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
    -- 1.8.0 (ADR-057): the detail names the rooms or the favorite.
    FORBIDDEN = "Not allowed for this key",
    FAVORITE_GONE = "The Sonos favorite is no longer in Sonos favorites",
    FAVORITE_NOT_PLAYABLE = "This Sonos favorite can only be started in the Sonos app",
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

-- A step as `actor` sees it: an admin (or nil: the controller itself) the whole step; a member
-- (ADR-054) only the rooms and devices they see, with `elsewhere` when the step also works on others
-- (a room left out: room_id null; devices left out of device_ids, null when none is left; rooms
-- left out of a favorite's with_room_ids), and a favorite without what only Sonos reads (its uri
-- and meta).
local function stepView(step, actor, registry)
    local set = Scenes.copySet(step.set)
    local result = {
        type = step.type,
        room_id = nullable(step.room_id),
        device_ids = step.device_ids and step.device_ids or Json.null,
        set = set,
    }
    if actor == nil or Access.isAdmin(actor) then
        return result
    end
    local elsewhere = false
    if step.room_id ~= nil and not Access.seesRoom(actor, step.room_id) then
        result.room_id = Json.null
        elsewhere = true
    end
    if step.device_ids then
        local ids = Json.array()
        for _, id in ipairs(step.device_ids) do
            local device = registry and registry.getDevice(id)
            if device and Access.canSee(actor, device) then
                ids[#ids + 1] = id
            else
                elsewhere = true
            end
        end
        -- None of them: the step names no device (and says elsewhere).
        result.device_ids = #ids > 0 and ids or Json.null
    end
    if type(set.with_room_ids) == "table" then
        local rooms = Json.array()
        for _, id in ipairs(set.with_room_ids) do
            if Access.seesRoom(actor, id) then
                rooms[#rooms + 1] = id
            else
                elsewhere = true
            end
        end
        set.with_room_ids = rooms
    end
    if type(set.favorite) == "table" then
        set.favorite.uri, set.favorite.meta = nil, nil
    end
    if elsewhere then
        result.elsewhere = true
    end
    return result
end

-- A scene as `ctx`'s caller sees it (stepView).
local function view(scene, ctx)
    local actor = ctx and ctx.apiKey or nil
    local registry = ctx and ctx.services and ctx.services.registry or nil
    local steps = Json.array()
    for _, step in ipairs(scene.steps) do
        steps[#steps + 1] = stepView(step, actor, registry)
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

local MUSIC_TAKES = 'music takes {"action": "pause"}, {"action": "stop"}, {"action": "resume"}, {"action": "volume", "volume": 0-100} or {"action": "play_favorite", "favorite": {"id": "12"}}'
local FAVORITE_FIELDS = { id = true, title = true, uri = true, meta = true }

-- A music step's setting (1.5.0; resume, volume and play_favorite since 1.8.0, ADR-057).
local function validateMusic(set, field)
    local action = set.action
    if type(action) ~= "string" or not Scenes.MUSIC_ACTIONS[action] then
        return nil, Problem.invalidField(field .. ".action", MUSIC_TAKES)
    end
    local takes = action == "volume" and { volume = true } or action == "play_favorite" and { volume = true, favorite = true, with_room_ids = true } or {}
    for key in pairs(set) do
        if key ~= "action" and not takes[key] then
            return nil, Problem.invalidField(field .. "." .. tostring(key), action .. " does not take " .. tostring(key))
        end
    end
    if (action == "volume" or set.volume ~= nil) and not isWhole(set.volume, 0, 100) then
        return nil, Problem.invalidField(field .. ".volume", "volume must be a whole number from 0 to 100")
    end
    if action == "play_favorite" then
        local favorite = set.favorite
        if type(favorite) ~= "table" or favorite == Json.null or Json.isArray(favorite) then
            return nil, Problem.invalidField(field .. ".favorite", 'play_favorite needs the favorite: {"id": "12"}, as GET /v1/music/{musicId}/favorites lists it')
        end
        for key, value in pairs(favorite) do
            if not FAVORITE_FIELDS[key] then
                return nil, Problem.invalidField(field .. ".favorite." .. tostring(key), "Unknown field: " .. tostring(key))
            end
            if type(value) ~= "string" then
                return nil, Problem.invalidField(field .. ".favorite." .. tostring(key), key .. " must be text")
            end
        end
        if type(favorite.id) ~= "string" or #favorite.id > 9 or not favorite.id:match("^%d+$") then
            return nil, Problem.invalidField(field .. ".favorite.id", "id is a favorite's id, as GET /v1/music/{musicId}/favorites lists it")
        end
        for name, limit in pairs({ title = Scenes.MAX_FAVORITE_TITLE, uri = Scenes.MAX_FAVORITE_URI, meta = Scenes.MAX_FAVORITE_META }) do
            if favorite[name] and #favorite[name] > limit then
                return nil, Problem.invalidField(field .. ".favorite." .. name, name .. " is longer than " .. limit .. " bytes")
            end
        end
        if set.with_room_ids ~= nil and (not isList(set.with_room_ids) or not Scenes.cleanRooms(set.with_room_ids)) then
            return nil, Problem.invalidField(field .. ".with_room_ids", "with_room_ids must be a list of at most " .. Scenes.MAX_WITH_ROOMS .. " room ids")
        end
    end
    return set
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
        music = { action = true, volume = true, favorite = true, with_room_ids = true },
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
                return nil, Problem.invalidField(field .. ".mode", "mode must be one of off, on, heat, cool, auto")
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
        if result.mode == "on" and (result.fan_speed or result.target_temperature or heat or cool) then
            return nil, Problem.invalidField(field, 'mode "on" turns each AC on as it was, in its last mode with its own temperature and fan; leave out the temperature, setpoints and fan speed')
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
        return validateMusic(set, field)
    end
    -- A door or gate relay is only pulsed, like its Open button: holding it closed would keep the
    -- door unlocked or the gate's input pressed.
    if set.action ~= "pulse" then
        return nil, Problem.invalidField(field .. ".action", 'doors and gates take {"action": "pulse"}, like their Open button')
    end
    return { action = "pulse" }
end

-- 1 to `maximum` ids of supported devices of the step type, without repeats; nil and a problem
-- otherwise. With `actor`, only devices it may control: another is, for it, one that does not exist.
local function validateDeviceIds(registry, ids, stepType, field, maximum, actor)
    if not isList(ids) or #ids == 0 or #ids > maximum then
        return nil, Problem.invalidField(field, "device_ids must be a list of 1 to " .. maximum .. " device ids")
    end
    local deviceIds = Json.array()
    local seen = {}
    for _, id in ipairs(ids) do
        local device = isWhole(id, 1, math.huge) and registry.getDevice(id) or nil
        if not device or device.kind ~= KINDS[stepType] or device.supported ~= true or (actor and not Access.canControl(actor, device)) then
            return nil, Problem.invalidField(field, "Device " .. tostring(id) .. " is not one of this home's " .. stepType)
        end
        if not seen[id] then
            seen[id] = true
            deviceIds[#deviceIds + 1] = id
        end
    end
    return deviceIds
end

-- A play_favorite step (1.8.0, ADR-057): in a room; the rooms grouped with it are the project's
-- (others are left out: a room removed in Composer since, sent back by an app that does not know
-- them); and the favorite as the favorites list read lately has it (its name, address and
-- description, what starts it again later). A favorite not read lately keeps what was sent: a
-- step saved again as it was. nil, or a problem.
local function checkFavorite(registry, roomId, set, field)
    if not roomId then
        return Problem.invalidField(field .. ".room_id", "A favorite plays in a room: room_id")
    end
    local rooms = Json.array()
    for _, id in ipairs(set.with_room_ids or {}) do
        if id ~= roomId and (registry.rooms or {})[id] then
            rooms[#rooms + 1] = id
        end
    end
    set.with_room_ids = #rooms > 0 and rooms or nil
    local known = Sonos.knownFavorite(set.favorite.id)
    if known and not known.playable then
        return Problem.invalidField(field .. ".set.favorite", "This favorite can only be started in the Sonos app")
    end
    if known then
        set.favorite = Scenes.cleanFavorite({ id = known.id, title = known.title, uri = known.uri, meta = known.meta })
    end
    return nil
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
    if stepType == "music" and set.action == "play_favorite" then
        problem = checkFavorite(registry, roomId, set, field)
        if problem then
            return nil, problem
        end
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
    -- A scene a member may not run is, for them, one that does not exist (ADR-054).
    if not scene or not Access.mayRunScene(ctx.apiKey, scene.id) then
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
        -- A temperature sensor (1.10.2) is no AC: a step for a room's climate leaves it out.
        if (step.room_id == nil or tonumber(device.room_id) == step.room_id) and not Views.isSensor(device) then
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

-- A climate step's "on" (1.10.0, ADR-070): a thermostat that is off goes back to its last mode that
-- was not off, and nothing else is sent, so its temperature and fan stay as they were. One that is
-- on is left as it is (no commands: it ran). One whose last mode is not known yet is skipped and
-- told so: DirectorLink never guesses heat or cool.
local function onAsItWas(device, options)
    local current = string.lower(tostring((device.state or {}).hvac_mode or ""))
    if current ~= "" and current ~= "off" then
        return {}
    end
    local mode = LastModes.get(device.id)
    if not mode then
        return nil, "NO_LAST_MODE", "No last mode known yet; set it once (turn it on in a mode) and DirectorLink remembers it"
    end
    if not contains(options.modes, mode) then
        return nil, "MODE_NOT_SUPPORTED", "Its last mode, " .. mode .. ", is not one DirectorLink can set"
    end
    return { { action = "set_hvac_mode", params = { value = mode } } }
end

-- The adapter commands for one device, or nil and why it is skipped; then what is left out, if
-- anything (a fan speed the unit does not have, a setpoint it cannot take). No commands: the device
-- is already as the step sets it (an AC on, for "on as it was").
local function deviceCommands(step, device)
    local set = step.set
    if step.type == "lights" then
        if set.on == false or set.brightness == 0 then
            return { { action = "off" } }
        end
        if type(set.brightness) == "number" and device.capabilities and device.capabilities.brightness then
            return { { action = "set_brightness", params = { value = set.brightness } } }
        end
        -- A level for a room or the whole home is for its dimmers (ADR-077, 2026-10-09): a light
        -- that only turns on and off stays as it is there (a KNX switch may be a door lock or a
        -- heater). One the step names turns on.
        if type(set.brightness) == "number" and not step.device_ids then
            return nil, "ON_OFF_ONLY", "This light only turns on and off; a level for a room or the whole home goes to dimmers only"
        end
        if set.on == true or type(set.brightness) == "number" then
            return { { action = "on" } }
        end
        return nil, "INVALID_STEP", "This step does not say what to do"
    elseif step.type == "climate" then
        if Views.isSensor(device) then
            return nil, "NOT_SUPPORTED", "This is a temperature sensor; it has nothing to set"
        end
        local options = Views.thermostatOptions(device)
        if set.mode == "on" then
            return onAsItWas(device, options)
        end
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
-- Switches a room's or the home's level left as they are (ON_OFF_ONLY) are skipped and also
-- counted in `on_off_only`; their problems come after the others, so that a whole home's switches
-- do not crowd a failure out of the 50.
local function run(ctx, steps, via)
    local services = ctx.services
    local result = { ran = 0, skipped = 0, failed = 0, problems = Json.array() }
    local switches = {}
    local function note(outcome, index, deviceId, code, detail)
        if outcome ~= "partial" then
            result[outcome] = result[outcome] + 1
        end
        local problem = { step = index, device_id = deviceId, outcome = outcome, code = code, detail = detail }
        if code == "ON_OFF_ONLY" then
            result.on_off_only = (result.on_off_only or 0) + 1
            if #switches < MAX_PROBLEMS then
                switches[#switches + 1] = problem
            end
        elseif #result.problems < MAX_PROBLEMS then
            result.problems[#result.problems + 1] = problem
        end
    end
    for index, step in ipairs(steps) do
        local refusal, why
        if step.type == "music" then
            -- The Sonos groups (or rooms) the step handles count as ran (a group that does not
            -- play is left as it is); what the players answer is not waited for
            -- (src/sonos/sonos.lua). What it leaves out is skipped, and why (MUSIC_SKIPPED). A scene
            -- runs in full for whoever may run it (ADR-054: an admin chose what it does), so no
            -- Sonos room is left out for its runner (Sonos.sceneStep without `may`).
            local handled, skipped = Sonos.sceneStep(step)
            result.ran = result.ran + handled
            for _, missing in ipairs(skipped) do
                note("skipped", index, 0, missing.code, missing.detail or MUSIC_SKIPPED[missing.code] or MUSIC_SKIPPED.NO_PLAYERS)
            end
        elseif step.type == "relays" then
            -- A scene runs in full for whoever may run it (ADR-054: an admin chose what it does);
            -- DirectorLink's own runs (schedules, scene links) never open doors or gates.
            if not Access.scenesOpenDoors(ctx.apiKey) then
                refusal, why = "FORBIDDEN", "Doors and gates open only when a person runs the scene"
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
                local already = commands ~= nil and #commands == 0
                if commands and not already then
                    commands, leftOut = withoutRefused(services, device, commands, leftOut)
                    if #commands == 0 then
                        commands, code, detail = nil, "NOT_SUPPORTED", leftOut
                    end
                end
                if already then
                    -- As the step sets it already: nothing to send (ADR-070).
                    result.ran = result.ran + 1
                elseif not commands then
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
    for _, problem in ipairs(switches) do
        if #result.problems >= MAX_PROBLEMS then
            break
        end
        result.problems[#result.problems + 1] = problem
    end
    return result
end

-- Admins get every scene; a member the scenes they may run (ADR-054).
function Handlers.list(ctx)
    local items = Json.array()
    for _, scene in ipairs(Scenes.list()) do
        if Access.mayRunScene(ctx.apiKey, scene.id) then
            items[#items + 1] = view(scene, ctx)
        end
    end
    return 200, { items = items }
end

function Handlers.get(ctx)
    local scene, problem = findScene(ctx)
    if not scene then
        return problem
    end
    return 200, view(scene, ctx)
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

-- What a member is told of a scene's run (ADR-054): a device they do not see is not named in its
-- problems (device_id 0, a general detail), as in the scene's steps (stepView).
local function forCaller(ctx, result)
    if Access.isAdmin(ctx.apiKey) then
        return result
    end
    for _, problem in ipairs(result.problems) do
        if problem.device_id ~= 0 then
            local device = ctx.services.registry.getDevice(problem.device_id)
            if not (device and Access.canSee(ctx.apiKey, device)) then
                problem.device_id = 0
                problem.detail = "A device elsewhere (" .. tostring(problem.code) .. ")"
            end
        end
    end
    return result
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
    return 202, forCaller(ctx, result)
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
    -- Only the devices the caller may control (ADR-054): what a member's Home shows.
    deviceIds, problem = validateDeviceIds(ctx.services.registry, body.device_ids, offType, "device_ids", MAX_OFF_DEVICES, ctx.apiKey)
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
