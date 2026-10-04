local Classifier = require("src.adapters.classifier")
local Clock = require("src.core.clock")
local DeviceEvents = require("src.control4.device_events")
local Log = require("src.core.log")
local Units = require("src.adapters.thermostat_units")

-- Samsung refrigerators, through the owner's Samsung Refrigerator (DirectorLink) driver
-- (DirectorLink-Samsung-Refrigerator.c4z, ADR-049). That driver talks to Samsung's SmartThings
-- cloud and keeps the refrigerator's state in variables of its own (on the driver, not on its five
-- uibutton proxies), added in this order, so Director numbers them from 1001:
--   POWER_COOL, POWER_FREEZE, SABBATH_MODE, ICE_MAKER, ONLINE, DOOR_OPEN ("1"/"0"), FRIDGE_TEMP,
--   FREEZER_TEMP, FRIDGE_SETPOINT, FREEZER_SETPOINT, POWER_W, WATER_FILTER_USAGE (numbers),
-- and, when the driver has them (added after those), REPORTED_VARIABLES (which of them hold a value
-- the refrigerator reports) and TEMPERATURE_UNIT ("C" or "F"). They are found by name, else by those
-- ids. The driver starts every one at "0" and leaves it there for what the refrigerator lacks, and
-- its temperatures are in the refrigerator's own unit; the API's are °C (refrigerator.unit).
-- A feature is switched with the driver's SET_FEATURE {Feature, State = "On" | "Off"}. It goes
-- through Samsung's cloud, and the driver changes the variable only once the refrigerator confirms
-- (typically in about 4 s; it gives up after about a minute and fires Command Failed).
-- Its event 15, Door Left Open (a door open longer than its Composer property Door Open Alert,
-- 5 minutes by default; doors are read at its poll interval, 2 minutes by default), reaches the
-- handler set with Refrigerator.onDoorLeftOpen, once per opening.
--
-- The record the API layer reads (views, refrigerator and scene handlers):
--   capabilities: features (the keys of the features it has, or all four when its driver does not
--     say), features_reported (true when it says)
--   state: online, door_open, fridge_temperature, fridge_setpoint, freezer_temperature,
--     freezer_setpoint (°C, 0.1; nil when not reported), water_filter_usage (percent used),
--     power_cool, power_freeze, sabbath_mode, ice_maker (nil for a feature it does not have)
--   actions: set_feature ({ feature = "sabbath_mode", on = true })
local Refrigerator = {}

Refrigerator.FEATURES = {
    { key = "power_cool", variable = "POWER_COOL", name = "Power Cool" },
    { key = "power_freeze", variable = "POWER_FREEZE", name = "Power Freeze" },
    { key = "sabbath_mode", variable = "SABBATH_MODE", name = "Sabbath Mode" },
    { key = "ice_maker", variable = "ICE_MAKER", name = "Ice Maker" },
}
-- The driver's Door Left Open event.
Refrigerator.DOOR_LEFT_OPEN = 15

local FEATURE_BY_KEY = {}
for _, feature in ipairs(Refrigerator.FEATURES) do
    FEATURE_BY_KEY[feature.key] = feature
end

-- The variables read, in the order the driver adds them (the id is 1000 + the position).
local VARIABLES = {
    "POWER_COOL", "POWER_FREEZE", "SABBATH_MODE", "ICE_MAKER", "ONLINE", "DOOR_OPEN", "FRIDGE_TEMP",
    "FREEZER_TEMP", "FRIDGE_SETPOINT", "FREEZER_SETPOINT", "POWER_W", "WATER_FILTER_USAGE",
    "REPORTED_VARIABLES", "TEMPERATURE_UNIT",
}
local FIRST_ID = 1001
-- Read only for the Debug log.
local NOT_WATCHED = { POWER_W = true }
local REQUIRED = { "POWER_COOL", "POWER_FREEZE", "SABBATH_MODE", "ICE_MAKER", "ONLINE" }

local tracked = {}
-- Doors left open whose handler ran (protocol id -> true), until they close; and when DOOR_OPEN
-- turned "1" (protocol id -> Clock.now(): at the driver's poll after the door opened, so the door
-- has been open at least since then). Both kept through a project refresh (reset() leaves them), so
-- the handler runs once per opening; a door already open when DirectorLink starts has no time.
local leftOpen = {}
local openedAt = {}
local doorLeftOpenHandler = nil

-- handler(device, seconds): a refrigerator's door has been open longer than its driver's Door Open
-- Alert; `seconds`: for at least this long (since DOOR_OPEN turned "1"), nil when not known.
function Refrigerator.onDoorLeftOpen(handler)
    doorLeftOpenHandler = handler
end

-- True or false as a variable says it ("1", "True", ...); nil when it says neither.
local function flag(value)
    local text = string.lower(tostring(value or "")):gsub("^%s+", ""):gsub("%s+$", "")
    if text == "1" or text == "true" or text == "on" then
        return true
    elseif text == "0" or text == "false" or text == "off" then
        return false
    end
    return nil
end

local function protocolOf(device)
    for _, protocol in ipairs(device.protocols or {}) do
        if Classifier.isRefrigeratorDriver(protocol.driver) then
            return tonumber(protocol.id)
        end
    end
    return nil
end

function Refrigerator.matches(device)
    return device ~= nil and device.kind == "refrigerator" and protocolOf(device) ~= nil
end

-- The unit of the refrigerator's temperatures: TEMPERATURE_UNIT when its driver says; else the
-- fridge setpoint tells (Samsung's are 1 to 7 °C, 33 to 46 °F), else the freezer's (-23 to -15 °C,
-- -8 to 5 °F); else the project's scale. `values`: variable name -> value.
function Refrigerator.unit(values, projectScale)
    local said = string.upper(tostring(values.TEMPERATURE_UNIT or "")):gsub("%s", "")
    if said == "C" or said == "F" then
        return said
    end
    local fridge = tonumber(values.FRIDGE_SETPOINT)
    if fridge and fridge ~= 0 then
        return fridge >= 25 and "F" or "C"
    end
    local freezer = tonumber(values.FREEZER_SETPOINT)
    if freezer and freezer ~= 0 then
        return freezer <= -12 and "C" or "F"
    end
    return Units.scale(projectScale) == "F" and "F" or "C"
end

-- The variables REPORTED_VARIABLES lists (name -> true); nil when the driver does not say (1.0.0,
-- or before it has read the refrigerator).
local function reportedSet(values)
    local text = values.REPORTED_VARIABLES
    if type(text) ~= "string" or not text:find("%w") then
        return nil
    end
    local set = {}
    for name in text:gmatch("[%w_]+") do
        set[string.upper(name)] = true
    end
    return set
end

local function celsius(value, unit)
    if value == nil then
        return nil
    end
    local c = unit == "F" and (value - 32) * 5 / 9 or value
    return math.floor(c * 10 + 0.5) / 10
end

-- The state the API shows, from the variables' last values.
local function update(device, info)
    local values = info.values
    local reported = reportedSet(values)
    local unit = Refrigerator.unit(values, info.projectScale)
    -- A number the refrigerator reports. Without REPORTED_VARIABLES an exact 0 is taken as not
    -- reported (the driver's starting value), except a freezer's in °F, where 0 °F is a usual setting.
    local function numberOf(name, zeroIsValue)
        local value = tonumber(values[name])
        if value == nil or value ~= value then
            return nil
        end
        if reported then
            return reported[name] and value or nil
        end
        if value == 0 and not zeroIsValue then
            return nil
        end
        return value
    end
    local freezerZero = unit == "F"
    local state = {
        online = flag(values.ONLINE) == true,
        fridge_temperature = celsius(numberOf("FRIDGE_TEMP"), unit),
        fridge_setpoint = celsius(numberOf("FRIDGE_SETPOINT"), unit),
        freezer_temperature = celsius(numberOf("FREEZER_TEMP", freezerZero), unit),
        freezer_setpoint = celsius(numberOf("FREEZER_SETPOINT", freezerZero), unit),
        water_filter_usage = numberOf("WATER_FILTER_USAGE"),
    }
    if not reported or reported.DOOR_OPEN then
        state.door_open = flag(values.DOOR_OPEN)
    end
    local features = {}
    for _, feature in ipairs(Refrigerator.FEATURES) do
        if not reported or reported[feature.variable] then
            features[#features + 1] = feature.key
            state[feature.key] = flag(values[feature.variable]) == true
        end
    end
    device.state = state
    device.capabilities = { features = features, features_reported = reported ~= nil, unit = unit }
    -- The door closed: the next time it is left open is a new opening.
    if state.door_open ~= true then
        leftOpen[info.protocol] = nil
        openedAt[info.protocol] = nil
    end
end

local function safeGetVariable(deviceId, variableId)
    local ok, value = pcall(function()
        return C4:GetVariable(deviceId, variableId)
    end)
    if ok then
        return value
    end
    return nil
end

-- The driver's variables: name -> id and name -> value, by name, else by their ids; and
-- "<id>=<name>:<value>, ..." of every one for the Debug log.
local function findVariables(protocolId)
    local ok, variables = pcall(function()
        return C4:GetDeviceVariables(protocolId)
    end)
    if not ok or type(variables) ~= "table" then
        variables = {}
    end
    local wanted = {}
    for _, name in ipairs(VARIABLES) do
        wanted[name] = true
    end
    local ids, values, listed = {}, {}, {}
    for id, variable in pairs(variables) do
        local name = type(variable) == "table" and string.upper(tostring(variable.name or "")) or ""
        if wanted[name] and tonumber(id) and not ids[name] then
            ids[name] = tonumber(id)
            values[name] = variable.value
        end
        listed[#listed + 1] = { id = tonumber(id) or 0, text = tostring(id) .. "=" .. name .. ":" .. tostring(type(variable) == "table" and variable.value or nil) }
    end
    table.sort(listed, function(a, b)
        return a.id < b.id
    end)
    for index, name in ipairs(VARIABLES) do
        if not ids[name] then
            local value = safeGetVariable(protocolId, FIRST_ID + index - 1)
            if value ~= nil then
                ids[name] = FIRST_ID + index - 1
                values[name] = value
            end
        end
    end
    local text = {}
    for _, item in ipairs(listed) do
        text[#text + 1] = item.text
    end
    return ids, values, table.concat(text, ", ")
end

-- A project refresh reads the variables again: nothing is kept from before.
function Refrigerator.initialize(device, registry)
    local protocolId = protocolOf(device)
    if not protocolId then
        return false, "no Samsung Refrigerator driver behind this device"
    end
    local ids, values, listed = findVariables(protocolId)
    Log.debug("refrigerator", "driver variables", { device_id = device.id, driver_id = protocolId, variables = listed })
    for _, name in ipairs(REQUIRED) do
        if not ids[name] then
            device.supported = false
            device.adapter_error = "The refrigerator driver's variable " .. name .. " is unavailable"
            return false, device.adapter_error
        end
    end

    local properties = registry and registry.metadata and registry.metadata.properties or {}
    -- Tracked before the listeners: Director calls OnWatchedVariableChanged right after each
    -- registration, and those first values should land in the state.
    local info = { protocol = protocolId, roles = {}, values = values, projectScale = properties.TemperatureScale }
    for name, id in pairs(ids) do
        info.roles[id] = name
    end
    tracked[device.id] = info
    device.supported = true
    device.adapter_error = nil
    -- Variables and events come from the refrigerator's driver; the manager routes them here.
    device.event_source_id = protocolId
    device.actions = { "set_feature" }
    update(device, info)

    for name, id in pairs(ids) do
        if not NOT_WATCHED[name] then
            local ok, err = pcall(function()
                C4:RegisterVariableListener(protocolId, id)
            end)
            if not ok then
                Log.warn("refrigerator", "unable to watch a refrigerator variable", { device_id = device.id, variable = name, error = tostring(err) })
            end
        end
    end
    local watching, err = DeviceEvents.watch(protocolId, Refrigerator.DOOR_LEFT_OPEN)
    if not watching then
        Log.warn("refrigerator", "unable to watch the refrigerator's Door Left Open", { device_id = device.id, error = tostring(err) })
    end

    Log.info("refrigerator", "initialized refrigerator", {
        device_id = device.id,
        driver_id = protocolId,
        online = device.state.online,
        features = table.concat(device.capabilities.features, ","),
        features_reported = device.capabilities.features_reported,
        unit = device.capabilities.unit,
    })
    return true
end

function Refrigerator.onVariableChanged(device, variableId, value)
    local info = tracked[device.id]
    local name = info and info.roles[tonumber(variableId)]
    if not name then
        return false
    end
    local wasOpen = type(device.state) == "table" and device.state.door_open == true
    info.values[name] = value
    update(device, info)
    if device.state.door_open == true and not wasOpen and not openedAt[info.protocol] then
        openedAt[info.protocol] = Clock.now()
    end
    Log.debug("refrigerator_state", "refrigerator variable changed", { device_id = device.id, variable = name, value = value })
    return true
end

-- Door Left Open: the handler runs once per opening (the door must close before it runs again).
function Refrigerator.onDeviceEvent(device, eventId)
    local info = tracked[device.id]
    if not info or tonumber(eventId) ~= Refrigerator.DOOR_LEFT_OPEN then
        return false
    end
    if leftOpen[info.protocol] then
        return false
    end
    leftOpen[info.protocol] = true
    local since = openedAt[info.protocol]
    local seconds = since and math.max(0, Clock.now() - since) or nil
    Log.info("refrigerator", "a refrigerator door was left open", { device_id = device.id, seconds = seconds })
    if doorLeftOpenHandler then
        local ok, err = pcall(doorLeftOpenHandler, device, seconds)
        if not ok then
            Log.error("refrigerator", "door left open handler failed", { device_id = device.id, error = tostring(err) })
        end
    end
    return true
end

-- True when the refrigerator has the feature, or does not say which it has.
function Refrigerator.hasFeature(device, key)
    for _, feature in ipairs(device.capabilities and device.capabilities.features or {}) do
        if feature == key then
            return true
        end
    end
    return false
end

-- Checks set_feature without sending anything (src/adapters/manager.lua prepare).
function Refrigerator.prepare(device, action, params)
    if not tracked[device.id] or not device.supported then
        return false, { code = "DEVICE_NOT_SUPPORTED", message = "This refrigerator is not initialized" }
    end
    if action ~= "set_feature" then
        return false, { code = "ACTION_NOT_SUPPORTED", message = "Unsupported refrigerator action: " .. tostring(action) }
    end
    local feature = FEATURE_BY_KEY[params and params.feature]
    if not feature or type(params.on) ~= "boolean" then
        return false, { code = "INVALID_FEATURE", message = "A feature is one of power_cool, power_freeze, sabbath_mode, ice_maker, set on (true) or off (false)" }
    end
    if not Refrigerator.hasFeature(device, feature.key) then
        return false, { code = "FEATURE_NOT_SUPPORTED", message = "This refrigerator has no " .. feature.name }
    end
    return true
end

-- set_feature { feature = "sabbath_mode", on = true } -> SET_FEATURE { Feature = "Sabbath Mode",
-- State = "On" } to the refrigerator's driver.
function Refrigerator.execute(device, action, params)
    local ok, failure = Refrigerator.prepare(device, action, params)
    if not ok then
        return false, failure
    end
    local info = tracked[device.id]
    local feature = FEATURE_BY_KEY[params.feature]
    local command = { Feature = feature.name, State = params.on and "On" or "Off" }
    local sent, err = pcall(function()
        C4:SendToDevice(info.protocol, "SET_FEATURE", command)
    end)
    if not sent then
        Log.error("refrigerator_command", "Control4 command failed", { device_id = device.id, feature = feature.key, error = tostring(err) })
        return false, { code = "CONTROL4_COMMAND_FAILED", message = "Director rejected the refrigerator command: " .. tostring(err) }
    end
    Log.info("refrigerator_command", "refrigerator command sent", { device_id = device.id, feature = feature.key, on = params.on })
    return true, { device_id = device.id, action = action, feature = feature.key, on = params.on }
end

function Refrigerator.reset()
    tracked = {}
end

return Refrigerator
