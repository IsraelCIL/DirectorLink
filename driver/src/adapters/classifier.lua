local Classifier = {}

local function normalizedDriverName(value)
    return string.lower(tostring(value or ""))
end

-- The owner's Samsung Refrigerator (DirectorLink) driver (ADR-049), also as Composer installs a
-- second download of it: "DirectorLink-Samsung-Refrigerator (1).c4z".
local REFRIGERATOR_DRIVER = "directorlink-samsung-refrigerator.c4z"

function Classifier.isRefrigeratorDriver(driverFileName)
    local name = normalizedDriverName(driverFileName)
    return name == REFRIGERATOR_DRIVER or name:gsub(" %(%d+%)%.c4z$", ".c4z") == REFRIGERATOR_DRIVER
end

-- The DirectorLink · Hikvision Camera driver (1.8.0, ADR-056), whose alerts DirectorLink passes on;
-- also a second download of it.
local HIKVISION_CAMERA_DRIVER = "directorlink-hikvision-camera.c4z"

function Classifier.isHikvisionCameraDriver(driverFileName)
    local name = normalizedDriverName(driverFileName)
    return name == HIKVISION_CAMERA_DRIVER or name:gsub(" %(%d+%)%.c4z$", ".c4z") == HIKVISION_CAMERA_DRIVER
end

-- Control4's Relay Door, Gate and Garage Door Controllers (1.10.0, ADR-069), also a second download
-- of one ("gate_relay_control (1).c4z"): the kind of door each opens, or nil for any other driver.
local RELAY_CONTROLLERS = {
    ["door_relay_control.c4z"] = "door",
    ["gate_relay_control.c4z"] = "gate",
    ["garagedoor_relay_control.c4z"] = "garage_door",
}

function Classifier.relayController(driverFileName)
    local name = normalizedDriverName(driverFileName)
    return RELAY_CONTROLLERS[name] or RELAY_CONTROLLERS[(name:gsub(" %(%d+%)%.c4z$", ".c4z"))]
end

-- A Sonos driver of the project (1.11.0, ADR-080): Control4's own, "Works With Sonos Certified"
-- (sonos.c4z, a Sonos player; sonosNetwork.c4z, the household; sonosGlobalLineIn.c4z), their
-- copies ("sonos (1).c4z") and any other driver with Sonos in its file name. DirectorLink plays the
-- same players itself (Music, ADR-044), so their proxies are part of Music, not other devices.
function Classifier.isSonosDriver(driverFileName)
    return normalizedDriverName(driverFileName):find("sonos", 1, true) ~= nil
end

function Classifier.classify(driverFileName)
    local name = normalizedDriverName(driverFileName)

    if name == "light_v2.c4i" or name == "light_v2.c4z" or name == "light.c4i" then
        return { kind = "light", recognized = true }
    end

    if name == "thermostatv2.c4i" or name == "thermostatv2.c4z" or name == "control4_thermostat_proxy.c4i" then
        return { kind = "climate", recognized = true }
    end

    if name == "fan.c4i" then
        return { kind = "fan", recognized = true }
    end

    if name == "blind.c4i" or name == "blind.c4z" then
        return { kind = "blind", recognized = true }
    end

    if name == "camera.c4i" or name == "camera.c4z" then
        return { kind = "camera", recognized = true }
    end

    if name == "knx_contact_relay.c4z" then
        return { kind = "relay", recognized = true }
    end

    if name == "doorstation.c4i" or name == "doorstation.c4z" then
        return { kind = "doorbell", recognized = true }
    end

    -- A partition of the home's alarm: read-only, and watched only while Alarm Status is On in
    -- Composer (src/adapters/alarm.lua); unsupported otherwise, as before 1.2.0.
    if name == "security.c4i" then
        return { kind = "alarm", recognized = true }
    end

    return { kind = "unsupported", recognized = false }
end

return Classifier
