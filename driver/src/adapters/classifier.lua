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
