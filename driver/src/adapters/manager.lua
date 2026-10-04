local Clock = require("src.core.clock")
local Log = require("src.core.log")
local LightV2 = require("src.adapters.light_v2")
local LightV1 = require("src.adapters.light_v1")
local ThermostatV2 = require("src.adapters.thermostat_v2")
local ThermostatProxy = require("src.adapters.thermostat_proxy")
local Fan = require("src.adapters.fan")
local Blind = require("src.adapters.blind")
local Camera = require("src.adapters.camera")
local KnxRelay = require("src.adapters.knx_relay")
local DoorBird = require("src.adapters.doorbird")
local Alarm = require("src.adapters.alarm")
local Refrigerator = require("src.adapters.refrigerator")

local Manager = {}

local adapters = {
    LightV2,
    LightV1,
    ThermostatV2,
    ThermostatProxy,
    Fan,
    Blind,
    Camera,
    KnxRelay,
    DoorBird,
    Alarm,
    Refrigerator,
}

local attached = {}
-- Told of each device event an adapter took (alerts: a doorbell's ring, a door opened elsewhere).
local eventListener = nil
-- When DirectorLink last sent each device a command that worked (Clock.now()): what the device
-- reports soon after is that command's doing.
local commanded = {}
-- Device whose events (and variables) belong to another device: a DoorBird driver's events -> its
-- doorbell, a Samsung Refrigerator driver's variables and events -> its refrigerator.
local eventTargets = {}
local registry = nil
local initializedCounts = { total = 0, light = 0, climate = 0, fan = 0, blind = 0, camera = 0, relay = 0, doorbell = 0, alarm = 0, refrigerator = 0 }

local function log(message)
    Log.info("adapters", tostring(message))
end

local function countKind(device, step)
    initializedCounts.total = initializedCounts.total + step
    local kind = tostring(device.kind or "")
    if initializedCounts[kind] ~= nil then
        initializedCounts[kind] = initializedCounts[kind] + step
    end
end

-- Starts `adapter` on the device; true when it controls (or watches) it from now on.
local function attach(id, device, adapter, before, quietly)
    attached[id] = adapter
    local ok, success, err
    if quietly then
        ok, success, err = Log.quietly(pcall, adapter.initialize, device, registry, before)
    else
        ok, success, err = pcall(adapter.initialize, device, registry, before)
    end
    if not ok then
        attached[id] = nil
        device.supported = false
        device.adapter_error = tostring(success)
        log("failed to initialize device " .. tostring(id) .. ": " .. tostring(success))
        return false
    elseif not success then
        attached[id] = nil
        device.supported = false
        device.adapter_error = tostring(err or "adapter initialization failed")
        log("unsupported device " .. tostring(id) .. ": " .. tostring(device.adapter_error))
        return false
    end
    if device.event_source_id then
        eventTargets[tonumber(device.event_source_id)] = id
    end
    countKind(device, 1)
    return true
end

-- previous: the devices before a project refresh (id -> device). An adapter gets the device it
-- controlled with the same id and kind, to keep what Director cannot tell it again (a relay's last
-- state, a doorbell's rings); everything else is read again. What the adapters log at info level
-- about each device is written at debug level then: the first discovery logged it already.
function Manager.initialize(deviceRegistry, previous)
    registry = deviceRegistry
    attached = {}
    eventTargets = {}
    initializedCounts = { total = 0, light = 0, climate = 0, fan = 0, blind = 0, camera = 0, relay = 0, doorbell = 0, alarm = 0, refrigerator = 0 }
    local refreshing = previous ~= nil and next(previous) ~= nil

    pcall(function()
        C4:UnregisterAllVariableListeners()
    end)

    for _, adapter in ipairs(adapters) do
        if adapter.reset then
            adapter.reset()
        end
    end

    local initialized = 0

    for id, device in pairs(registry.devices or {}) do
        local before = previous and previous[tonumber(id)]
        if before and (before.kind ~= device.kind or before.supported ~= true) then
            before = nil
        end
        for _, adapter in ipairs(adapters) do
            if adapter.matches(device) then
                if attach(tonumber(id), device, adapter, before, refreshing) then
                    initialized = initialized + 1
                end
                break
            end
        end
    end

    log("initialized " .. tostring(initialized) .. " controllable proxies")
    return initialized
end

-- A Composer property that decides which devices an adapter takes changed (Alarm Status: the
-- alarm's partitions, ADR-038). The devices it takes now start; the ones it no longer takes are
-- let go, their variables no longer watched. Nothing else is read again. Returns how many
-- devices started and how many were let go.
function Manager.onPropertyChanged(name)
    local started, released = 0, 0
    if not registry then
        return started, released
    end
    for _, adapter in ipairs(adapters) do
        if adapter.PROPERTY ~= nil and adapter.PROPERTY == name then
            for rawId, device in pairs(registry.devices or {}) do
                local id = tonumber(rawId)
                if attached[id] == adapter and not adapter.matches(device) then
                    if adapter.release then
                        pcall(adapter.release, device)
                    end
                    attached[id] = nil
                    device.supported = false
                    countKind(device, -1)
                    released = released + 1
                elseif attached[id] == nil and adapter.matches(device) then
                    if attach(id, device, adapter, nil, false) then
                        started = started + 1
                    end
                end
            end
        end
    end
    return started, released
end

function Manager.counts()
    return {
        total = initializedCounts.total,
        light = initializedCounts.light,
        climate = initializedCounts.climate,
        fan = initializedCounts.fan,
        blind = initializedCounts.blind,
        camera = initializedCounts.camera,
        relay = initializedCounts.relay,
        doorbell = initializedCounts.doorbell,
        alarm = initializedCounts.alarm,
        refrigerator = initializedCounts.refrigerator,
    }
end

function Manager.onVariableChanged(deviceId, variableId, value)
    deviceId = tonumber(deviceId)
    deviceId = eventTargets[deviceId] or deviceId
    local adapter = attached[deviceId]
    if not adapter or not registry then
        return false
    end

    local device = registry.getDevice(deviceId)
    if not device then
        return false
    end

    local ok, changed = pcall(adapter.onVariableChanged, device, variableId, value)
    if not ok then
        log("state update failed for device " .. tostring(deviceId) .. ": " .. tostring(changed))
        return false
    end

    return changed == true
end

function Manager.onDeviceEvent(deviceId, eventId)
    deviceId = tonumber(deviceId)
    deviceId = eventTargets[deviceId] or deviceId
    local adapter = attached[deviceId]
    if not adapter or not adapter.onDeviceEvent or not registry then
        return false
    end
    local device = registry.getDevice(deviceId)
    if not device then
        return false
    end
    -- The state as it was, for the listener (a relay closing from open is a door opened).
    local before = {}
    for key, value in pairs(type(device.state) == "table" and device.state or {}) do
        before[key] = value
    end
    local ok, changed = pcall(adapter.onDeviceEvent, device, eventId)
    if not ok then
        log("event handling failed for device " .. tostring(deviceId) .. ": " .. tostring(changed))
        return false
    end
    if changed == true and eventListener then
        local told, err = pcall(eventListener, device, eventId, before)
        if not told then
            log("event listener failed for device " .. tostring(deviceId) .. ": " .. tostring(err))
        end
    end
    return changed == true
end

-- `listener(device, eventId, before)` is told of each event an adapter took, after it did (`before`:
-- a copy of the device's state before).
function Manager.onEvent(listener)
    eventListener = listener
end

-- When DirectorLink last sent `deviceId` a command that worked (Clock.now()), or nil.
function Manager.commandedAt(deviceId)
    return commanded[tonumber(deviceId)]
end

function Manager.execute(deviceId, action, params)
    deviceId = tonumber(deviceId)
    if not deviceId or not registry then
        return false, {
            code = "DEVICE_NOT_FOUND",
            message = "Invalid device ID",
        }
    end

    local device = registry.getDevice(deviceId)
    if not device then
        return false, {
            code = "DEVICE_NOT_FOUND",
            message = "Device " .. tostring(deviceId) .. " does not exist",
        }
    end

    local adapter = attached[deviceId]
    if not adapter then
        return false, {
            code = "DEVICE_NOT_SUPPORTED",
            message = "Device " .. tostring(deviceId) .. " has no controllable DirectorLink adapter",
        }
    end

    local ok, success, result = pcall(adapter.execute, device, action, params or {})
    if not ok then
        return false, {
            code = "ADAPTER_ERROR",
            message = tostring(success),
        }
    end

    if not success then
        return false, result
    end

    commanded[deviceId] = Clock.now()
    return true, result
end

-- Checks a command without sending anything: true, or false and a failure like execute's (a
-- failure may name the request `field` it is about). A request that sends several commands checks
-- them all first, so a refused setpoint cannot leave the mode already changed. Adapters without
-- prepare accept everything here and check in execute.
function Manager.prepare(deviceId, action, params)
    local adapter = attached[tonumber(deviceId)]
    if not adapter or not adapter.prepare or not registry then
        return true
    end
    local ok, success, failure = pcall(adapter.prepare, registry.getDevice(tonumber(deviceId)), action, params or {})
    if not ok then
        return false, { code = "ADAPTER_ERROR", message = tostring(success) }
    end
    return success ~= false, failure
end

-- Lets an adapter read again what it keeps about a device and what may change without a project
-- refresh (a blind's setup, when it is some minutes old). Cheap when nothing is due.
function Manager.refresh(deviceId)
    local adapter = attached[tonumber(deviceId)]
    local device = adapter and adapter.refresh and registry and registry.getDevice(tonumber(deviceId))
    if device then
        local ok, err = pcall(adapter.refresh, device)
        if not ok then
            log("refresh failed for device " .. tostring(deviceId) .. ": " .. tostring(err))
        end
    end
end

function Manager.shutdown()
    pcall(function()
        C4:UnregisterAllVariableListeners()
    end)

    attached = {}
    eventTargets = {}
    registry = nil
    initializedCounts = { total = 0, light = 0, climate = 0, fan = 0, blind = 0, camera = 0, relay = 0, doorbell = 0, alarm = 0, refrigerator = 0 }

    for _, adapter in ipairs(adapters) do
        if adapter.reset then
            adapter.reset()
        end
    end
end

return Manager
