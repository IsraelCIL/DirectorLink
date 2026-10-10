-- API representations. This is the only place internal registry records become public JSON,
-- so Control4 specifics (proxy drivers, command names, variable IDs) stay out of the API.

local Classifier = require("src.adapters.classifier")
local Json = require("src.core.json")
local RoomNames = require("src.core.room_names")
local LastModes = require("src.core.last_modes")
local Units = require("src.adapters.thermostat_units")

local Views = {}

local TYPE_BY_KIND = {
    light = "light",
    climate = "thermostat",
    fan = "fan",
    blind = "blind",
    camera = "camera",
    relay = "relay",
    doorbell = "doorbell",
    refrigerator = "refrigerator",
}

local RESOURCE_PATH = {
    light = "/v1/lights/",
    thermostat = "/v1/thermostats/",
    fan = "/v1/fans/",
    blind = "/v1/blinds/",
    camera = "/v1/cameras/",
    relay = "/v1/relays/",
    doorbell = "/v1/doorbells/",
    refrigerator = "/v1/refrigerators/",
}

local SETTABLE_MODES = {
    off = true,
    heat = true,
    cool = true,
    auto = true,
}

-- The FanSpeed values of the API. A thermostat may list others (e.g. "Humidify"); they are not
-- offered, so every fan speed shown can be sent back with PATCH.
local SETTABLE_FAN_SPEEDS = {
    low = true,
    medium = true,
    high = true,
    auto = true,
    on = true,
    circulate = true,
}

local function nullable(value)
    if value == nil or value == "" then
        return Json.null
    end
    return value
end

local function slug(value)
    local text = string.lower(tostring(value or ""))
    text = text:gsub("[^%w]+", "_"):gsub("^_+", ""):gsub("_+$", "")
    return text
end

function Views.roomRef(registry, roomId, fallbackName)
    roomId = tonumber(roomId)
    if not roomId then
        return Json.null
    end
    local room = (registry.rooms or {})[roomId] or (registry.locations or {})[roomId]
    return {
        id = roomId,
        name = (room and room.name) or fallbackName or ("Room " .. tostring(roomId)),
        names = RoomNames.get(roomId),
    }
end

function Views.room(registry, room, deviceCounts)
    local floor = Json.null
    local parent = room.parent_id and (registry.locations or {})[room.parent_id]
    if parent and parent.type == "floor" then
        floor = { id = parent.id, name = parent.name }
    end
    return {
        id = room.id,
        name = room.name,
        names = RoomNames.get(room.id),
        floor = floor,
        device_count = deviceCounts[room.id] or 0,
    }
end

function Views.deviceType(device)
    -- A door controller's button shown as the KNX relay it drives (ADR-069) is that relay's door.
    if device.shown_as ~= nil then
        return "other"
    end
    return TYPE_BY_KIND[device.kind] or "other"
end

local function shown(device)
    return type(device) == "table" and device.supported == true and RESOURCE_PATH[Views.deviceType(device)] ~= nil
end

-- The device an unsupported one is part of (1.10.1), when DirectorLink shows that one: a door
-- controller's button shown as the KNX relay it drives, a KNX relay on a controller's Close or Stop
-- connection (ADR-069), a DoorBird's button, intercom or camera (its doorbell). Its id, or nil.
function Views.partOf(registry, device)
    local wholeId = tonumber(device.part_of)
    if not wholeId or shown(device) then
        return nil
    end
    local whole = registry.getDevice(wholeId)
    return shown(whole) and wholeId or nil
end

-- Whether an unsupported device is part of Music (1.11.0, ADR-080): its protocol driver (or the
-- device itself, a driver without proxies) is a Sonos driver (Classifier.isSonosDriver: Control4's
-- sonos.c4z and the like) while DirectorLink plays Sonos itself (`sonosOn`: Composer's Sonos On).
function Views.partOfMusic(device, sonosOn)
    if sonosOn ~= true or type(device) ~= "table" or shown(device) then
        return false
    end
    if Classifier.isSonosDriver(device.proxy and device.proxy.driver) then
        return true
    end
    for _, protocol in ipairs(device.protocols or {}) do
        if Classifier.isSonosDriver(protocol.driver) then
            return true
        end
    end
    return false
end

-- `sonosOn`: DirectorLink plays Sonos itself (part_of_music, 1.11.0).
function Views.device(registry, device, sonosOn)
    local deviceType = Views.deviceType(device)
    local supported = shown(device)
    return {
        id = device.id,
        name = device.name,
        type = deviceType,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        supported = supported,
        href = supported and (RESOURCE_PATH[deviceType] .. tostring(device.id)) or Json.null,
        part_of = Views.partOf(registry, device) or Json.null,
        part_of_music = Views.partOfMusic(device, sonosOn),
    }
end

function Views.light(registry, device)
    local capabilities = device.capabilities or {}
    local state = device.state or {}
    return {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        on = state.power == true,
        brightness = nullable(state.brightness),
        dimmable = capabilities.brightness == true,
        brightness_reported = capabilities.brightness_feedback == true,
    }
end

-- Fans (1.2.0). `speed` is how fast the fan runs, from 1 (low) to 4 (high): null while it is off,
-- and when the controller reports no speed. `speeds` lists the ones PATCH takes.
function Views.fan(registry, device)
    local capabilities = device.capabilities or {}
    local state = device.state or {}
    local speeds = Json.array()
    for speed = 1, tonumber(capabilities.speeds) or 0 do
        speeds[#speeds + 1] = speed
    end
    return {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        on = state.power == true,
        speed = nullable(state.speed),
        speeds = speeds,
    }
end

-- `capabilities` and the movement fields came in 1.1.0: a shade may only open and close fully
-- (PATCH takes 0 and 100), or not stop; `moving` is null when the controller does not report it.
function Views.blind(registry, device)
    local capabilities = device.capabilities or {}
    local state = device.state or {}
    return {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        position = nullable(state.position),
        position_reported = capabilities.position_reported == true,
        capabilities = {
            position = capabilities.position ~= false,
            stop = capabilities.stop ~= false,
        },
        moving = state.moving == nil and Json.null or state.moving,
        direction = nullable(state.direction),
        target_position = nullable(state.target_position),
    }
end

function Views.camera(registry, device)
    return {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        snapshot_href = "/v1/cameras/" .. tostring(device.id) .. "/snapshot",
    }
end

-- A door or gate. `kind` (1.10.0, ADR-069): "door", "gate" or "garage_door" for a Relay Door, Gate
-- or Garage Door Controller's, "relay" for a relay DirectorLink pulses itself. `door_state`: "open",
-- "closed" or "partly_open" when the controller has a contact that says, else null; `state` is the
-- relay's contact, null for a controller's door unless it is a KNX relay's.
function Views.relay(registry, device)
    local capabilities = device.capabilities or {}
    local state = device.state or {}
    return {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        state = state.relay or Json.null,
        state_reported = capabilities.state_reported == true,
        kind = device.door_kind or "relay",
        door_state = capabilities.door_state == true and state.door or Json.null,
    }
end

function Views.doorbell(registry, device)
    local capabilities = device.capabilities or {}
    local state = device.state or {}
    local last = state.last or {}
    local camera = Json.null
    local cameraId = device.linked and device.linked.camera
    local cameraDevice = cameraId and registry.getDevice(cameraId)
    if cameraDevice and cameraDevice.supported then
        camera = { id = cameraDevice.id, snapshot_href = "/v1/cameras/" .. tostring(cameraDevice.id) .. "/snapshot" }
    end
    local events = Json.array()
    for index, event in ipairs(state.events or {}) do
        events[index] = { type = event.type, at = event.at }
    end
    return {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        camera = camera,
        can_open = capabilities.open == true,
        connected = state.connected == nil and Json.null or state.connected,
        last_ring_at = last.doorbell or Json.null,
        last_motion_at = last.motion or Json.null,
        last_opened_at = last.opened or Json.null,
        last_access_at = last.access or Json.null,
        events = events,
    }
end

-- Samsung refrigerators (1.7.0, ADR-049). Temperatures and setpoints in °C, null when the
-- refrigerator does not report them; a feature it does not have is null and not in `features`, the
-- ones PATCH takes. `features_reported` is false when its driver does not say which it has: then all
-- four are listed.
function Views.refrigerator(registry, device)
    local capabilities = device.capabilities or {}
    local state = device.state or {}
    local features = Json.array()
    for _, feature in ipairs(capabilities.features or {}) do
        features[#features + 1] = feature
    end
    local function feature(key)
        if state[key] == nil then
            return Json.null
        end
        return state[key]
    end
    return {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        online = state.online == true,
        fridge_temperature = nullable(state.fridge_temperature),
        fridge_setpoint = nullable(state.fridge_setpoint),
        freezer_temperature = nullable(state.freezer_temperature),
        freezer_setpoint = nullable(state.freezer_setpoint),
        door_open = state.door_open == nil and Json.null or state.door_open,
        water_filter_usage = nullable(state.water_filter_usage),
        power_cool = feature("power_cool"),
        power_freeze = feature("power_freeze"),
        sabbath_mode = feature("sabbath_mode"),
        ice_maker = feature("ice_maker"),
        features = features,
        features_reported = capabilities.features_reported == true,
    }
end

-- A partition of the home's alarm, read-only (GET /v1/alarm, ADR-038). `state` is the panel's own
-- word in lower case (disarmed_ready, armed, exit_delay, ...). The type of arming and of alarm are
-- the panel's words too, and only while armed or in alarm; the delay only while one counts. In
-- /v1/devices a partition stays a device of type "other": nothing there tells viewers more.
local ALARM_DELAYS = { entry_delay = "entry", exit_delay = "exit" }

-- The panel's words are cut to these many bytes (never inside a character), with control
-- characters made spaces, and its counts stop at ALARM_MAX_COUNT, so that a partition's answer
-- can never be longer than its longest form, which GET /v1/alarm is padded to (handlers/alarm.lua).
Views.ALARM_TEXT_BYTES = { state = 32, armed_type = 32, alarm_type = 32, trouble = 100 }
Views.ALARM_MAX_COUNT = 99999

local function panelText(value, bytes)
    if value == nil then
        return nil
    end
    local text = tostring(value):gsub("%c", " ")
    local cut = math.min(#text, bytes)
    -- Back to the start of a character (a UTF-8 continuation byte is 128-191).
    while cut > 0 and cut < #text and text:byte(cut + 1) >= 128 and text:byte(cut + 1) < 192 do
        cut = cut - 1
    end
    return text:sub(1, cut)
end

local function panelCount(value)
    return value and math.min(value, Views.ALARM_MAX_COUNT) or nil
end

function Views.alarmPartition(registry, device)
    local state = device.state or {}
    local partitionState = state.partition_state and slug(state.partition_state):sub(1, Views.ALARM_TEXT_BYTES.state) or nil
    if partitionState == "" then
        partitionState = nil
    end
    local armed = state.home == true or state.away == true or partitionState == "armed"
    local alarm = state.alarm == true or partitionState == "alarm"
    local delayType = partitionState and ALARM_DELAYS[partitionState] or nil
    local delay = Json.null
    if delayType or (state.delay_remaining or 0) > 0 then
        delay = {
            type = delayType or Json.null,
            remaining = nullable(panelCount(state.delay_remaining)),
            total = nullable(panelCount(state.delay_total)),
        }
    end
    return {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        state = nullable(partitionState),
        armed = armed,
        armed_mode = (state.away and "away") or (state.home and "home") or Json.null,
        armed_type = armed and nullable(panelText(state.armed_type, Views.ALARM_TEXT_BYTES.armed_type)) or Json.null,
        alarm = alarm,
        alarm_type = alarm and nullable(panelText(state.alarm_type, Views.ALARM_TEXT_BYTES.alarm_type)) or Json.null,
        open_zones = nullable(panelCount(state.open_zones)),
        delay = delay,
        trouble = nullable(panelText(state.trouble, Views.ALARM_TEXT_BYTES.trouble)),
    }
end

-- The longest form a partition's view can take, whatever the panel reports: the same id, name and
-- room, and every field that follows the panel at its longest (a quote takes the most room once
-- the view is JSON inside a sealed answer's JSON).
function Views.alarmPartitionLongest(view)
    local form = {}
    for field, value in pairs(view) do
        form[field] = value
    end
    local bytes, count = Views.ALARM_TEXT_BYTES, Views.ALARM_MAX_COUNT
    form.state = string.rep("x", bytes.state)
    form.armed, form.alarm = false, false
    form.armed_mode = "home"
    form.armed_type = string.rep('"', bytes.armed_type)
    form.alarm_type = string.rep('"', bytes.alarm_type)
    form.open_zones = count
    form.delay = { type = "entry", remaining = count, total = count }
    form.trouble = string.rep('"', bytes.trouble)
    return form
end

-- What the zone is doing now, from the thermostat's reported HVAC state.
local function activity(value)
    local text = string.lower(tostring(value or ""))
    if text == "" then
        return Json.null
    elseif text:find("heat") then
        return "heating"
    elseif text:find("cool") then
        return "cooling"
    elseif text:find("dry") then
        return "drying"
    elseif text:find("fan") then
        return "fan"
    elseif text == "off" or text == "idle" then
        return "idle"
    end
    return slug(text)
end

-- Modes and fan speeds that PATCH /v1/thermostats/{id} accepts for this device.
function Views.thermostatOptions(device)
    local capabilities = device.capabilities or {}
    local modes = Json.array()
    for _, mode in ipairs(capabilities.hvac_modes or {}) do
        local name = string.lower(tostring(mode))
        if SETTABLE_MODES[name] then
            modes[#modes + 1] = name
        end
    end
    local fanSpeeds = Json.array()
    for _, speed in ipairs(capabilities.fan_modes or {}) do
        local name = string.lower(tostring(speed))
        if SETTABLE_FAN_SPEEDS[name] then
            fanSpeeds[#fanSpeeds + 1] = name
        end
    end
    return {
        modes = modes,
        fan_speeds = fanSpeeds,
        min = capabilities.target_temperature_min_c or 16,
        max = capabilities.target_temperature_max_c or 32,
    }
end

-- True for thermostats with separate heat and cool setpoints (the Control4 thermostat proxy, and
-- since 1.10.2 a Thermostat V2 one that reports them instead of a single setpoint, as a Nest does).
function Views.isDual(device)
    return (device.capabilities or {}).setpoints == "dual"
end

-- "F" or "C": the scale the thermostat works in (1.10.2, its adapter's), °C when it says none.
function Views.thermostatScale(device)
    return (device.capabilities or {}).scale == "F" and "F" or "C"
end

-- A thermostat proxy that only reads a temperature (and humidity), with nothing to set (1.10.2).
function Views.isSensor(device)
    return (device.capabilities or {}).sensor == true
end

-- On a dual-setpoint thermostat `target_temperature` is the setpoint of the current mode (null in
-- auto and off); the three setpoint keys are null on single-setpoint ones. A setpoint the
-- thermostat does not use (no mode for it, such as heat on an Off,Cool one) is null too, even when
-- the proxy has its variables: clients treat a reported setpoint as one they can set.
--
-- 1.10.2 (ADR-076), additive: `scale` is the thermostat's ("F" or "C", as Control4 reports it), and
-- a °F thermostat also has its values in °F as it reports them (`*_f`: whole °F setpoints, the
-- range inside the °C one); °C thermostats have no `*_f` fields. A value not reported is null,
-- never 0 °C or -18 °C. `sensor`: a temperature (and humidity) reading with nothing to set (no
-- mode, setpoint or fan speed; PATCH answers 409); `humidity` (%) only when reported.
function Views.thermostat(registry, device)
    local state = device.state or {}
    local capabilities = device.capabilities or {}
    local options = Views.thermostatOptions(device)
    local dual = capabilities.setpoints == "dual"
    local heat = dual and capabilities.has_heat and state.heat_setpoint_c or nil
    local cool = dual and capabilities.has_cool and state.cool_setpoint_c or nil
    local scale = Views.thermostatScale(device)
    local view = {
        id = device.id,
        name = device.name,
        room = Views.roomRef(registry, device.room_id, device.room_name),
        online = state.connected ~= false,
        current_temperature = nullable(state.current_temperature_c),
        target_temperature = nullable(state.target_temperature_c),
        target_temperature_min = options.min,
        target_temperature_max = options.max,
        mode = state.hvac_mode and slug(state.hvac_mode) or Json.null,
        modes = options.modes,
        activity = activity(state.hvac_state),
        fan_speed = state.fan_mode and slug(state.fan_mode) or Json.null,
        fan_speeds = options.fan_speeds,
        setpoints = dual and "dual" or "single",
        heat_setpoint = nullable(heat),
        cool_setpoint = nullable(cool),
        setpoint_deadband = nullable(capabilities.deadband_c),
        -- Its last mode that was not off (1.10.0, ADR-070): what "on as it was" turns it on in.
        last_mode = nullable(LastModes.get(device.id)),
        scale = scale,
        sensor = Views.isSensor(device),
    }
    if type(state.humidity) == "number" then
        view.humidity = state.humidity
    end
    if scale == "F" then
        local low, high = Units.fahrenheitRange(options.min, options.max)
        view.current_temperature_f = nullable(state.current_temperature_f)
        view.target_temperature_f = nullable(state.target_temperature_f)
        view.target_temperature_min_f = low
        view.target_temperature_max_f = high
        view.heat_setpoint_f = nullable(heat and state.heat_native)
        view.cool_setpoint_f = nullable(cool and state.cool_native)
        view.setpoint_deadband_f = nullable(dual and capabilities.deadband_native or nil)
    end
    return view
end

function Views.apiKey(record, currentId)
    return {
        id = record.id,
        name = record.name,
        role = record.role,
        created_at = record.created_at,
        last_used_at = nullable(record.last_used_at),
        current = record.id == currentId,
        profile_id = nullable(record.profile),
        expires_at = nullable(record.expires_at),
    }
end

function Views.newApiKey(record, currentId)
    local view = Views.apiKey(record, currentId)
    view.key = record.secret
    return view
end

return Views
