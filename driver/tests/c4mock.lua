-- A fake Director for running the DirectorLink driver in plain Lua 5.1.
-- Records everything the driver sends so tests can assert on it.

local Mock = {}

local Json = require("src.core.json")
local md5 = require("md5")
local sha1 = require("sha1")
local sha256 = require("sha256")
local aes = require("aes")
local Base64 = require("src.core.base64")
local X509Fake = require("x509_fake")

-- The driver folder, which build.py packages as the .c4z root (this file is driver/tests/c4mock.lua).
local DRIVER_ROOT = debug.getinfo(1, "S").source:match("^@(.-)[/\\]tests[/\\][^/\\]+$") or "./driver"

-- Byte XOR without bit operators (HMAC pads are short).
local function xorByte(a, b)
    local result, bit = 0, 1
    for _ = 1, 8 do
        if a % 2 ~= b % 2 then
            result = result + bit
        end
        a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
    end
    return result
end

local function hmacSha256(key, data)
    if #key > 64 then
        key = sha256(key)
    end
    key = key .. string.rep("\000", 64 - #key)
    local inner, outer = {}, {}
    for i = 1, 64 do
        inner[i] = string.char(xorByte(key:byte(i), 0x36))
        outer[i] = string.char(xorByte(key:byte(i), 0x5c))
    end
    return sha256(table.concat(outer) .. sha256(table.concat(inner) .. data))
end

-- Values in and out of Director's crypto functions: NONE (bytes), HEX or BASE64. Like OpenSSL,
-- BASE64 output is broken into lines of 64 characters, so the driver must not depend on it.
local function decodeValue(value, encoding)
    if encoding == "HEX" then
        return Base64.fromHex(value)
    elseif encoding == "BASE64" then
        return Base64.decode(value)
    end
    return value
end

local function encodeValue(value, encoding)
    if encoding == "HEX" then
        return Base64.toHex(value)
    elseif encoding == "BASE64" then
        local text = Base64.encode(value)
        return (text:gsub(("."):rep(64), "%0\n"))
    end
    return value
end

-- What the KNX drivers' driver.xml declare in <capabilities> (as read on a real controller, OS
-- 4.2.1, 2026-10-09), as C4:GetDeviceData(id, "capabilities") gives it: what is inside the tag.
Mock.KNX_SWITCH_CAPABILITIES = [[
    <dimmer>False</dimmer>
    <set_level>False</set_level>
    <ramp_level>False</ramp_level>
    <on_off>True</on_off>
]]
Mock.KNX_DIMMER_CAPABILITIES = [[
    <dimmer>True</dimmer>
    <set_level>True</set_level>
    <ramp_level>True</ramp_level>
    <supports_target>True</supports_target>
    <requires_target_preset_ids>True</requires_target_preset_ids>
]]

-- A small project: two rooms, three lights (KNX dimmer, KNX switch, other dimmer),
-- one thermostat, two blinds (one without a known level), two cameras (digest and basic login)
-- and one unsupported device. The KNX switch's proxy has a level, 0 or 100, as the real ones do;
-- its driver declares it a switch. The other dimmer's driver declares nothing.
function Mock.project()
    return {
        osVersion = "3.4.3.727848-res",
        bridgeId = 572,
        projectProperties = {
            CityName = "Tel Aviv",
            CountryCode = "IL",
            CountryName = "Israel",
            Latitude = "32.08",
            Longitude = "34.78",
        },
        hierarchy = {
            id = 1, name = "Home", type = 2,
            {
                id = 2, name = "House", type = 3,
                {
                    id = 3, name = "Ground Floor", type = 4,
                    { id = 10, name = "Kitchen", type = 8 },
                    { id = 11, name = "Living Room", type = 8 },
                },
            },
        },
        devices = {
            [101] = {
                deviceName = "KNX Dimmer", driverFileName = "knx_dimmer.c4i", roomId = 10, roomName = "Kitchen",
                proxies = { [20] = { deviceName = "Kitchen Island", driverFileName = "light_v2.c4i" } },
            },
            [20] = {
                deviceName = "Kitchen Island", driverFileName = "light_v2.c4i", roomId = 10, roomName = "Kitchen",
                protocol = { [101] = { deviceName = "KNX Dimmer", driverFileName = "knx_dimmer.c4i" } },
            },
            [102] = {
                deviceName = "KNX Switch", driverFileName = "knx_switch.c4i", roomId = 11, roomName = "Living Room",
                proxies = { [21] = { deviceName = "Hall Light", driverFileName = "light_v2.c4i" } },
            },
            [21] = {
                deviceName = "Hall Light", driverFileName = "light_v2.c4i", roomId = 11, roomName = "Living Room",
                protocol = { [102] = { deviceName = "KNX Switch", driverFileName = "knx_switch.c4i" } },
            },
            [103] = {
                deviceName = "Dimmer Module", driverFileName = "zigbee_dimmer.c4i", roomId = 11, roomName = "Living Room",
                proxies = { [22] = { deviceName = "Desk Lamp", driverFileName = "light_v2.c4i" } },
            },
            [22] = {
                deviceName = "Desk Lamp", driverFileName = "light_v2.c4i", roomId = 11, roomName = "Living Room",
                protocol = { [103] = { deviceName = "Dimmer Module", driverFileName = "zigbee_dimmer.c4i" } },
            },
            [104] = {
                deviceName = "AC Zone", driverFileName = "coolautomation_cmnet_zone.c4z", roomId = 11, roomName = "Living Room",
                proxies = { [30] = { deviceName = "Parents", driverFileName = "thermostatV2.c4i" } },
            },
            [30] = {
                deviceName = "Parents", driverFileName = "thermostatV2.c4i", roomId = 11, roomName = "Living Room",
                protocol = { [104] = { deviceName = "AC Zone", driverFileName = "coolautomation_cmnet_zone.c4z" } },
            },
            [105] = {
                deviceName = "KNX Blinds (2.9+)", driverFileName = "knx_blind.c4z", roomId = 11, roomName = "Living Room",
                proxies = { [50] = { deviceName = "Window Blind", driverFileName = "blind.c4i" } },
            },
            [50] = {
                deviceName = "Window Blind", driverFileName = "blind.c4i", roomId = 11, roomName = "Living Room",
                protocol = { [105] = { deviceName = "KNX Blinds (2.9+)", driverFileName = "knx_blind.c4z" } },
            },
            [106] = {
                deviceName = "KNX Blinds (2.9+)", driverFileName = "knx_blind.c4z", roomId = 10, roomName = "Kitchen",
                proxies = { [51] = { deviceName = "Kitchen Shutter", driverFileName = "blind.c4i" } },
            },
            [51] = {
                deviceName = "Kitchen Shutter", driverFileName = "blind.c4i", roomId = 10, roomName = "Kitchen",
                protocol = { [106] = { deviceName = "KNX Blinds (2.9+)", driverFileName = "knx_blind.c4z" } },
            },
            [107] = {
                deviceName = "Hikvision IPC Camera (Static)", driverFileName = "camera_ip_hik_ipc_static.c4z", roomId = 10, roomName = "Kitchen",
                proxies = { [60] = { deviceName = "Driveway", driverFileName = "camera.c4i" } },
            },
            [60] = {
                deviceName = "Driveway", driverFileName = "camera.c4i", roomId = 10, roomName = "Kitchen",
                protocol = { [107] = { deviceName = "Hikvision IPC Camera (Static)", driverFileName = "camera_ip_hik_ipc_static.c4z" } },
            },
            [108] = {
                deviceName = "DoorBird", driverFileName = "doorbird_doorstation.c4z", roomId = 11, roomName = "Living Room",
                proxies = { [61] = { deviceName = "Gate", driverFileName = "camera.c4i" } },
            },
            [61] = {
                deviceName = "Gate", driverFileName = "camera.c4i", roomId = 11, roomName = "Living Room",
                protocol = { [108] = { deviceName = "DoorBird", driverFileName = "doorbird_doorstation.c4z" } },
            },
            -- A DoorBird: one driver, four proxies (button, intercom, camera, doorstation), as in a real project.
            [110] = {
                deviceName = "DoorBird Doorstation", driverFileName = "doorbird_doorstation.c4z", roomId = 10, roomName = "Kitchen",
                proxies = {
                    [90] = { deviceName = "Gate Intercom", driverFileName = "uibutton.c4i" },
                    [91] = { deviceName = "DoorBird", driverFileName = "intercomproxy.c4i" },
                    [92] = { deviceName = "Gate Camera", driverFileName = "camera.c4i" },
                    [93] = { deviceName = "Front Gate", driverFileName = "doorstation.c4i" },
                },
            },
            [90] = {
                deviceName = "Gate Intercom", driverFileName = "uibutton.c4i", roomId = 10, roomName = "Kitchen",
                protocol = { [110] = { deviceName = "DoorBird Doorstation", driverFileName = "doorbird_doorstation.c4z" } },
            },
            [91] = {
                deviceName = "DoorBird", driverFileName = "intercomproxy.c4i", roomId = 10, roomName = "Kitchen",
                protocol = { [110] = { deviceName = "DoorBird Doorstation", driverFileName = "doorbird_doorstation.c4z" } },
            },
            [92] = {
                deviceName = "Gate Camera", driverFileName = "camera.c4i", roomId = 10, roomName = "Kitchen",
                protocol = { [110] = { deviceName = "DoorBird Doorstation", driverFileName = "doorbird_doorstation.c4z" } },
            },
            [93] = {
                deviceName = "Front Gate", driverFileName = "doorstation.c4i", roomId = 10, roomName = "Kitchen",
                protocol = { [110] = { deviceName = "DoorBird Doorstation", driverFileName = "doorbird_doorstation.c4z" } },
            },
            -- A combo driver: the relay device is its own proxy.
            [70] = {
                deviceName = "Main Door", driverFileName = "knx_contact_relay.c4z", roomId = 10, roomName = "Kitchen",
            },
            [40] = {
                deviceName = "Front Door", driverFileName = "camera_ip_hik_ipc_static.c4z", roomId = 10, roomName = "Kitchen",
            },
            [572] = {
                deviceName = "DirectorLink", driverFileName = "DirectorLink.c4z", roomId = 10, roomName = "Kitchen",
            },
        },
        variables = {
            [20] = { [1000] = "1", [1001] = "80" },
            [21] = { [1000] = "0", [1001] = "0" },
            [22] = { [1000] = "1", [1001] = "40" },
            [30] = {
                [1100] = "CELSIUS",
                [1104] = "Cool",
                [1105] = "Low",
                [1107] = "Cool",
                [1112] = "1",
                [1120] = "Off,Heat,Cool",
                [1131] = "26",
                [1149] = "71.6",
            },
            [50] = { [1000] = "40", [1001] = "40" },
            [51] = { [1000] = "-255", [1001] = "-255" },
        },
        -- Camera proxies: what GET_PROPERTIES / GET_SNAPSHOT_QUERY_STRING return, and the fake camera
        -- (`composer_auth_type`: the login type set in Composer, when it is not the camera's own).
        cameras = {
            [60] = {
                address = "192.0.2.21", http_port = 80, auth_type = "DIGEST", username = "admin", password = "s3cret&pw",
                query = "ISAPI/Streaming/channels/101/picture?snapShotImageType=JPEG&amp;size=%dx%d",
            },
            [61] = {
                address = "192.0.2.22", http_port = 8080, auth_type = "BASIC", username = "user", password = "door",
                query = "/bha-api/image.cgi",
            },
            [92] = {
                address = "192.0.2.23", http_port = 80, auth_type = "BASIC", username = "bird", password = "gate",
                query = "/bha-api/image.cgi",
            },
        },
        -- Names for C4:GetDeviceVariables (blind proxies are looked up by variable name).
        variableNames = {
            [50] = { [1000] = "Level", [1001] = "Target Level" },
            [51] = { [1000] = "Level", [1001] = "Target Level" },
        },
        -- The <devicedata> tags of drivers' driver.xml (C4:GetDeviceData).
        deviceData = {
            [101] = { capabilities = Mock.KNX_DIMMER_CAPABILITIES },
            [102] = { capabilities = Mock.KNX_SWITCH_CAPABILITIES },
        },
    }
end

-- Adds the device families of 1.1.0 and later to a project. Mock.project() itself stays as it is:
-- the inventory and scene tests count its devices.

-- Legacy Light proxies (light.c4i): a dimmer (25, Kitchen), a switch (26, Living Room) and one
-- whose Light State cannot be read (27, its own proxy). The protocol driver names are placeholders.
function Mock.withLegacyLights(project)
    project.devices[120] = {
        deviceName = "Pantry Dimmer", driverFileName = "ldz_dimmer.c4i", roomId = 10, roomName = "Kitchen",
        proxies = { [25] = { deviceName = "Pantry", driverFileName = "light.c4i" } },
    }
    project.devices[25] = {
        deviceName = "Pantry", driverFileName = "light.c4i", roomId = 10, roomName = "Kitchen",
        protocol = { [120] = { deviceName = "Pantry Dimmer", driverFileName = "ldz_dimmer.c4i" } },
    }
    project.devices[121] = {
        deviceName = "Porch Switch", driverFileName = "ldz_switch.c4i", roomId = 11, roomName = "Living Room",
        proxies = { [26] = { deviceName = "Porch", driverFileName = "light.c4i" } },
    }
    project.devices[26] = {
        deviceName = "Porch", driverFileName = "light.c4i", roomId = 11, roomName = "Living Room",
        protocol = { [121] = { deviceName = "Porch Switch", driverFileName = "ldz_switch.c4i" } },
    }
    project.devices[27] = { deviceName = "Garage", driverFileName = "Light.c4i", roomId = 11, roomName = "Living Room" }
    project.variables[25] = { [1000] = "1", [1001] = "65" }
    project.variables[26] = { [1000] = "0" }
    project.variableNames[25] = { [1000] = "LIGHT_STATE", [1001] = "LIGHT_LEVEL" }
    project.variableNames[26] = { [1000] = "LIGHT_STATE" }
    return project
end

-- A Thermostat V2 floor-heating zone that keeps its target in the heat setpoint (1133) and leaves
-- the single setpoint at 0 in both scales, as seen on a real °F project (#19).
-- options: id (32), protocol (113), room (11), name, scale ("FAHRENHEIT"), heat ("21.5").
function Mock.withHeatOnlyZone(project, options)
    options = options or {}
    local id, protocol = options.id or 32, options.protocol or 113
    local roomId = options.room or 11
    local roomName = roomId == 10 and "Kitchen" or "Living Room"
    local name = options.name or "Bathroom floor"
    project.devices[protocol] = {
        deviceName = "Floor Heating", driverFileName = "floor_heating.c4z", roomId = roomId, roomName = roomName,
        proxies = { [id] = { deviceName = name, driverFileName = "thermostatV2.c4i" } },
    }
    project.devices[id] = {
        deviceName = name, driverFileName = "thermostatV2.c4i", roomId = roomId, roomName = roomName,
        protocol = { [protocol] = { deviceName = "Floor Heating", driverFileName = "floor_heating.c4z" } },
    }
    project.variables[id] = {
        [1100] = options.scale or "FAHRENHEIT",
        [1104] = "Heat",
        [1105] = "Undefined",
        [1107] = "Heat",
        [1112] = "1",
        [1120] = "Off,Heat",
        [1131] = "20",
        [1133] = options.heat or "21.5",
        [1149] = "0",
        [1150] = "0",
    }
    project.variableNames[id] = {
        [1100] = "SCALE", [1104] = "HVAC_MODE", [1105] = "FAN_MODE", [1107] = "HVAC_STATE",
        [1112] = "IS_CONNECTED", [1120] = "HVAC_MODES_LIST", [1131] = "TEMPERATURE_C",
        [1133] = "HEAT_SETPOINT_C", [1149] = "SINGLE_SETPOINT_F", [1150] = "SINGLE_SETPOINT_C",
    }
    return project
end

-- A Control4 thermostat (control4_thermostat_proxy.c4i) with separate heat and cool setpoints,
-- in Auto. options: id (31), protocol (112), room (10), scale ("FAHRENHEIT" or "CELSIUS"),
-- deadband (the project-scale deadband, e.g. "1.7" in °C; false for none).
--   °F: current 71 °F, heat 68 °F (20 °C), cool 76 °F (24.4 °C), deadband 3 °F (1.7 °C)
--   °C: current 21 °C, heat 20.5 °C, cool 24 °C, deadband 2 °C
function Mock.withDualThermostat(project, options)
    options = options or {}
    local id, protocol = options.id or 31, options.protocol or 112
    local roomId = options.room or 10
    local roomName = roomId == 10 and "Kitchen" or "Living Room"
    local fahrenheit = (options.scale or "FAHRENHEIT") == "FAHRENHEIT"
    project.devices[protocol] = {
        deviceName = "Wireless Thermostat", driverFileName = "control4_wireless_thermostat.c4i", roomId = roomId, roomName = roomName,
        proxies = { [id] = { deviceName = "Study", driverFileName = "control4_thermostat_proxy.c4i" } },
    }
    project.devices[id] = {
        deviceName = "Study", driverFileName = "control4_thermostat_proxy.c4i", roomId = roomId, roomName = roomName,
        protocol = { [protocol] = { deviceName = "Wireless Thermostat", driverFileName = "control4_wireless_thermostat.c4i" } },
    }
    local variables = {
        [1100] = options.scale or "FAHRENHEIT",
        [1104] = "Auto",
        [1105] = "Auto",
        [1107] = "Off",
        [1112] = "1",
        [1120] = "Off,Heat,Cool,Auto",
        [1121] = "Auto,On",
        [1130] = fahrenheit and "71" or "70",
        [1131] = fahrenheit and "21.7" or "21",
        [1132] = fahrenheit and "68" or "69",
        [1133] = fahrenheit and "20" or "20.5",
        [1134] = fahrenheit and "76" or "75",
        [1135] = fahrenheit and "24.4" or "24",
        [1146] = fahrenheit and "3" or "4",
        [1147] = fahrenheit and "1.7" or "2",
    }
    if options.deadband == false then
        variables[1146], variables[1147] = nil, nil
    elseif options.deadband ~= nil then
        local deadband = tonumber(options.deadband)
        if fahrenheit then
            variables[1146] = tostring(options.deadband)
            variables[1147] = tostring(math.floor(deadband * 5 / 9 * 10 + 0.5) / 10)
        else
            variables[1146] = tostring(math.floor(deadband * 9 / 5 + 0.5))
            variables[1147] = tostring(options.deadband)
        end
    end
    project.variables[id] = variables
    project.variableNames[id] = {
        [1100] = "SCALE", [1104] = "HVAC_MODE", [1105] = "FAN_MODE", [1107] = "HVAC_STATE",
        [1112] = "IS_CONNECTED", [1120] = "HVAC_MODES_LIST", [1121] = "FAN_MODES_LIST",
        [1130] = "TEMPERATURE_F", [1131] = "TEMPERATURE_C", [1132] = "HEAT_SETPOINT_F",
        [1133] = "HEAT_SETPOINT_C", [1134] = "COOL_SETPOINT_F", [1135] = "COOL_SETPOINT_C",
        [1146] = "DEADBAND_F", [1147] = "DEADBAND_C",
    }
    return project
end

-- The thermostat variable names of Thermostat V2 (1100-1150, docs/RESEARCH.md; 1138 HUMIDITY).
Mock.THERMOSTAT_NAMES = {
    [1100] = "SCALE", [1104] = "HVAC_MODE", [1105] = "FAN_MODE", [1107] = "HVAC_STATE",
    [1112] = "IS_CONNECTED", [1120] = "HVAC_MODES_LIST", [1121] = "FAN_MODES_LIST",
    [1130] = "TEMPERATURE_F", [1131] = "TEMPERATURE_C", [1132] = "HEAT_SETPOINT_F",
    [1133] = "HEAT_SETPOINT_C", [1134] = "COOL_SETPOINT_F", [1135] = "COOL_SETPOINT_C", [1138] = "HUMIDITY",
    [1146] = "DEADBAND_F", [1147] = "DEADBAND_C", [1149] = "SINGLE_SETPOINT_F", [1150] = "SINGLE_SETPOINT_C",
}

-- A Thermostat V2 proxy (thermostatV2.c4i) and its protocol driver. options: id, protocol, room
-- (10 Kitchen or 11 Living Room), name, driver (the protocol driver's file), driverName, variables.
function Mock.withThermostatV2(project, options)
    local id, protocol = options.id, options.protocol
    local roomId = options.room or 11
    local roomName = roomId == 10 and "Kitchen" or "Living Room"
    local driverName = options.driverName or "Thermostat"
    project.devices[protocol] = {
        deviceName = driverName, driverFileName = options.driver, roomId = roomId, roomName = roomName,
        proxies = { [id] = { deviceName = options.name, driverFileName = "thermostatV2.c4i" } },
    }
    project.devices[id] = {
        deviceName = options.name, driverFileName = "thermostatV2.c4i", roomId = roomId, roomName = roomName,
        protocol = { [protocol] = { deviceName = driverName, driverFileName = options.driver } },
    }
    project.variables[id] = options.variables
    project.variableNames[id] = {}
    for variableId in pairs(options.variables) do
        project.variableNames[id][variableId] = Mock.THERMOSTAT_NAMES[variableId] or tostring(variableId)
    end
    return project
end

-- The thermostats of #75 (1.10.2, ADR-076), as a °F project reports them. options: id, protocol,
-- room, name, and what each lists below.
--   minisplit: one setpoint, 74 °F now, 69 °F set, in Cool.
--   Nest: no single setpoint (0), its heat and cool setpoints (68 °F, 71 °F) instead, 72 °F now, fan
--     speeds Auto and On, in Cool; mode, heat, heatC, cool, coolC change them (false: not reported).
--   sensor: a temperature and humidity reading (73 °F, 30 %) with no scale variable and no mode or
--     setpoint; scale, fahrenheit, celsius, humidity change them.
--   weather: an outdoor weather driver on the thermostat proxy; driver changes its file.
function Mock.withMinisplit(project, options)
    options = options or {}
    return Mock.withThermostatV2(project, {
        id = options.id or 33, protocol = options.protocol or 171, room = options.room or 11,
        name = options.name or "Living Room Minisplit", driver = "minisplit_wifi.c4z", driverName = "Minisplit",
        variables = {
            [1100] = "FAHRENHEIT", [1104] = "Cool", [1105] = "Low", [1107] = "Cool", [1112] = "1",
            [1120] = "Auto,Cool,Heat,Off", [1130] = "74", [1131] = "23.3", [1149] = "69", [1150] = "20.6",
        },
    })
end

function Mock.withNestThermostat(project, options)
    options = options or {}
    local function value(given, default)
        if given == false then
            return nil
        end
        return given or default
    end
    return Mock.withThermostatV2(project, {
        id = options.id or 34, protocol = options.protocol or 172, room = options.room or 10,
        name = options.name or "Hallway", driver = "nest_thermostat.c4z", driverName = "Nest Thermostat",
        variables = {
            [1100] = "FAHRENHEIT", [1104] = options.mode or "Cool", [1105] = "Auto", [1107] = "Off", [1112] = "1",
            [1120] = "Off,Heat,Cool,Auto", [1121] = "Auto,On", [1130] = "72", [1131] = "22.2",
            [1132] = value(options.heat, "68"), [1133] = value(options.heatC, "20"),
            [1134] = value(options.cool, "71"), [1135] = value(options.coolC, "21.7"),
            [1146] = "3", [1147] = "1.7", [1149] = "0",
        },
    })
end

function Mock.withTemperatureSensor(project, options)
    options = options or {}
    local variables = {
        [1104] = "Undefined", [1105] = "Undefined", [1107] = "Undefined", [1112] = "1",
        [1130] = options.fahrenheit or "73", [1131] = options.celsius or "0", [1138] = options.humidity or "30", [1149] = "0",
    }
    if options.scale then
        variables[1100] = options.scale
    end
    return Mock.withThermostatV2(project, {
        id = options.id or 36, protocol = options.protocol or 174, room = options.room or 11,
        name = options.name or "Bathroom", driver = "temperature_humidity_sensor.c4z", driverName = "Temperature Sensor",
        variables = variables,
    })
end

function Mock.withWeatherThermostat(project, options)
    options = options or {}
    return Mock.withThermostatV2(project, {
        id = options.id or 37, protocol = options.protocol or 175, room = options.room or 10,
        name = options.name or "Weather Driver", driver = options.driver or "weather.c4z", driverName = "Weather",
        variables = {
            [1100] = "FAHRENHEIT", [1104] = "Off", [1107] = "Off", [1112] = "1",
            [1130] = "84", [1131] = "28.9", [1149] = "0",
        },
    })
end

-- A °C floor-heating zone that reports no room temperature (1131 left at 0), off, as seen on a
-- CoolMaster floor zone (1.10.2): its card says "—", never 0°.
function Mock.withUnreportedTemperatureZone(project, options)
    options = options or {}
    return Mock.withThermostatV2(project, {
        id = options.id or 35, protocol = options.protocol or 173, room = options.room or 10,
        name = options.name or "Kitchen floor", driver = "coolautomation_cmnet_zone.c4z", driverName = "Floor Zone",
        variables = {
            [1100] = "CELSIUS", [1104] = "Off", [1105] = "Undefined", [1107] = "Off", [1112] = "1",
            [1120] = "Off,Heat", [1131] = "0", [1149] = "77",
        },
    })
end

-- A Fan proxy (fan.c4i) with the variables read on a live Director (#18): IS_ON (1000),
-- CURRENT_SPEED (1001: 0 off, 1 low to 4 high) and PRESET_SPEED (1003). options: id, protocol,
-- room (11), name, on (false), speed (0), preset (4), variables (the values instead), names (the
-- variable names instead). The protocol driver's name is a placeholder.
function Mock.withFan(project, options)
    local id, protocol = options.id, options.protocol
    local roomId = options.room or 11
    local roomName = roomId == 10 and "Kitchen" or "Living Room"
    local name = options.name or "Fan"
    project.devices[protocol] = {
        deviceName = "Fan Speed Controller", driverFileName = "fan_speed_controller.c4i", roomId = roomId, roomName = roomName,
        proxies = { [id] = { deviceName = name, driverFileName = "fan.c4i" } },
    }
    project.devices[id] = {
        deviceName = name, driverFileName = "fan.c4i", roomId = roomId, roomName = roomName,
        protocol = { [protocol] = { deviceName = "Fan Speed Controller", driverFileName = "fan_speed_controller.c4i" } },
    }
    project.variables[id] = options.variables or {
        [1000] = options.on and "1" or "0",
        [1001] = tostring(options.speed or 0),
        [1003] = tostring(options.preset or 4),
    }
    project.variableNames[id] = options.names or { [1000] = "IS_ON", [1001] = "CURRENT_SPEED", [1003] = "PRESET_SPEED" }
    return project
end

-- The demo's fans: 41 on at Medium in the living room, 42 off in the kitchen.
function Mock.withFans(project)
    Mock.withFan(project, { id = 41, protocol = 116, room = 11, name = "Ceiling Fan", on = true, speed = 2, preset = 3 })
    Mock.withFan(project, { id = 42, protocol = 117, room = 10, name = "Patio Fan" })
    return project
end

-- The Samsung Refrigerator (DirectorLink) driver (1.7.0, ADR-049): the driver with five uibutton
-- proxies (the status tile first, then Power Cool, Power Freeze, Sabbath Mode, Ice Maker), and its
-- variables on the driver itself, numbered from 1001 in the order it adds them.
Mock.REFRIGERATOR_VARIABLES = {
    "POWER_COOL", "POWER_FREEZE", "SABBATH_MODE", "ICE_MAKER", "ONLINE", "DOOR_OPEN", "FRIDGE_TEMP",
    "FREEZER_TEMP", "FRIDGE_SETPOINT", "FREEZER_SETPOINT", "POWER_W", "WATER_FILTER_USAGE",
}

-- options: protocol (140), id (141, the status tile; the other proxies follow), room (10), name
-- ("Refrigerator", the status tile's), file (the driver's file name), values (variable name ->
-- value, over these: online, a 3 °C fridge and a -18 °C freezer, the door closed, the filter 40 %
-- used, every feature off), reported (the driver's REPORTED_VARIABLES and TEMPERATURE_UNIT, added
-- after the others: { variables = "POWER_COOL,...", unit = "C" }; without it the driver is 1.0.0,
-- which has neither).
function Mock.withRefrigerator(project, options)
    options = options or {}
    local protocol, first = options.protocol or 140, options.id or 141
    local roomId = options.room or 10
    local roomName = roomId == 10 and "Kitchen" or "Living Room"
    local file = options.file or "DirectorLink-Samsung-Refrigerator.c4z"
    local driverName = "Samsung Refrigerator (DirectorLink)"
    local proxies = {}
    for index, proxyName in ipairs({ options.name or "Refrigerator", "Power Cool", "Power Freeze", "Sabbath Mode", "Ice Maker" }) do
        local id = first + index - 1
        proxies[id] = { deviceName = proxyName, driverFileName = "uibutton.c4i" }
        project.devices[id] = {
            deviceName = proxyName, driverFileName = "uibutton.c4i", roomId = roomId, roomName = roomName,
            protocol = { [protocol] = { deviceName = driverName, driverFileName = file } },
        }
    end
    project.devices[protocol] = { deviceName = driverName, driverFileName = file, roomId = roomId, roomName = roomName, proxies = proxies }
    -- Its driver.xml's <version> (C4:GetDeviceData).
    project.deviceData = project.deviceData or {}
    project.deviceData[protocol] = { version = options.version or "100" }
    local values = {
        POWER_COOL = "0", POWER_FREEZE = "0", SABBATH_MODE = "0", ICE_MAKER = "0", ONLINE = "1", DOOR_OPEN = "0",
        FRIDGE_TEMP = "3", FREEZER_TEMP = "-18", FRIDGE_SETPOINT = "3", FREEZER_SETPOINT = "-18", POWER_W = "95",
        WATER_FILTER_USAGE = "40",
    }
    local names = {}
    for _, name in ipairs(Mock.REFRIGERATOR_VARIABLES) do
        names[#names + 1] = name
    end
    if options.reported then
        names[#names + 1] = "REPORTED_VARIABLES"
        names[#names + 1] = "TEMPERATURE_UNIT"
        values.REPORTED_VARIABLES = options.reported.variables or ""
        values.TEMPERATURE_UNIT = options.reported.unit or ""
    end
    for name, value in pairs(options.values or {}) do
        values[name] = value
    end
    project.variables[protocol] = {}
    project.variableNames[protocol] = {}
    for index, name in ipairs(names) do
        project.variables[protocol][1000 + index] = values[name]
        project.variableNames[protocol][1000 + index] = name
    end
    return project
end

-- Composer updates a driver (1.8.0): its <version> changes and, as the refrigerator driver 1.1.0 did,
-- it may add variables after its own (`added`: { NAME = value, ... }, in that order by name), each
-- with the next id. Director tells other drivers nothing.
function Mock.updateDeviceDriver(mock, deviceId, version, added)
    local project = mock.project
    project.deviceData = project.deviceData or {}
    project.deviceData[deviceId] = project.deviceData[deviceId] or {}
    project.deviceData[deviceId].version = version
    local names = {}
    for name in pairs(added or {}) do
        names[#names + 1] = name
    end
    table.sort(names)
    project.variables[deviceId] = project.variables[deviceId] or {}
    project.variableNames[deviceId] = project.variableNames[deviceId] or {}
    local last = 1000
    for id in pairs(project.variables[deviceId]) do
        last = math.max(last, id)
    end
    for _, name in ipairs(names) do
        last = last + 1
        project.variables[deviceId][last] = added[name]
        project.variableNames[deviceId][last] = name
    end
end

-- Cameras on the DirectorLink · Hikvision Camera driver (DirectorLink-Hikvision-Camera.c4z, 1.8.0,
-- ADR-056): each its own driver with one camera proxy, digest login, its snapshot the sub stream's
-- picture at the size asked for, and the driver's variables, numbered from 1001 in the order it adds
-- them. Its event 1 is Alert. `list`: { { id, protocol, name, room (10 or 11), address, channel,
-- driver, marker, events } }; by default 65 "Garden" (Living Room, driver 150) and 66 "Back Gate"
-- (Kitchen, 151). A camera whose `address` another uses too is an NVR's channel. `marker`: the driver
-- sets DirectorLink's camera agreement's marker (1.10.0, ADR-065: DIRECTORLINK_CAMERA "1", KIND
-- "camera", its 15th and 16th variables); `events`: Director gives its driver.xml's events (by name).
Mock.HIKVISION_VARIABLES = {
    "ONLINE", "ALERTS_ENABLED", "ALERT_ACTIVE", "MOTION", "PERSON", "VEHICLE", "LINE_CROSSING",
    "INTRUSION", "TAMPER", "ALARM_INPUT", "MOTION_DETECTION_ENABLED", "LAST_DETECTION", "LAST_ALERT",
    "LAST_ALERT_TIME",
}
Mock.HIKVISION_ALERT = 1

function Mock.withHikvisionCameras(project, list)
    list = list or {
        { id = 65, protocol = 150, name = "Garden", room = 11, address = "192.0.2.31" },
        { id = 66, protocol = 151, name = "Back Gate", room = 10, address = "192.0.2.32" },
    }
    project.cameras = project.cameras or {}
    -- An NVR's channels share its login, and so the nonces it gave.
    local logins = {}
    for _, camera in ipairs(list) do
        local room = camera.room or 11
        local roomName = room == 10 and "Kitchen" or "Living Room"
        local driver = camera.driver or "DirectorLink-Hikvision-Camera.c4z"
        project.devices[camera.protocol] = {
            deviceName = camera.name, driverFileName = driver, roomId = room, roomName = roomName,
            proxies = { [camera.id] = { deviceName = camera.name, driverFileName = "camera.c4i" } },
        }
        project.devices[camera.id] = {
            deviceName = camera.name, driverFileName = "camera.c4i", roomId = room, roomName = roomName,
            protocol = { [camera.protocol] = { deviceName = camera.name, driverFileName = driver } },
        }
        project.cameras[camera.id] = {
            address = camera.address, http_port = 80, auth_type = "DIGEST", username = "admin", password = "hik-pass",
            query = "ISAPI/Streaming/channels/" .. tostring(camera.channel or 1) .. "02/picture?videoResolutionWidth=%d&amp;videoResolutionHeight=%d",
        }
        logins[camera.address] = logins[camera.address] or { issued = 0, accepted = 0, nonces = {} }
        project.cameras[camera.id].digest = logins[camera.address]
        project.variables[camera.protocol] = {}
        project.variableNames[camera.protocol] = {}
        for index, name in ipairs(Mock.HIKVISION_VARIABLES) do
            local isText = name == "LAST_DETECTION" or name == "LAST_ALERT" or name == "LAST_ALERT_TIME"
            project.variables[camera.protocol][1000 + index] = isText and "" or (name == "ONLINE" and "1" or "0")
            project.variableNames[camera.protocol][1000 + index] = name
        end
        if camera.marker then
            local count = #Mock.HIKVISION_VARIABLES
            project.variables[camera.protocol][1001 + count] = "1"
            project.variableNames[camera.protocol][1001 + count] = "DIRECTORLINK_CAMERA"
            project.variables[camera.protocol][1002 + count] = "camera"
            project.variableNames[camera.protocol][1002 + count] = "DIRECTORLINK_CAMERA_KIND"
        end
        if camera.marker or camera.events then
            project.deviceData = project.deviceData or {}
            project.deviceData[camera.protocol] = { version = "100", events = Mock.eventsXml(Mock.HIKVISION_EVENTS) }
        end
    end
    return project
end

-- The Hikvision camera driver.xml's first events (ids and names).
Mock.HIKVISION_EVENTS = {
    { 1, "Alert" }, { 2, "Motion Detected" }, { 3, "Motion Ended" }, { 4, "Person Detected" },
    { 5, "Vehicle Detected" }, { 6, "Line Crossing" }, { 18, "Camera Online" }, { 19, "Camera Offline" },
}

-- A driver.xml's <events> as Director gives the tag: `list` { { id, name }, ... }.
function Mock.eventsXml(list)
    local parts = {}
    for _, event in ipairs(list) do
        parts[#parts + 1] = string.format("\n\t\t<event><id>%d</id><name>%s</name><description>When NAME: %s</description></event>", event[1], event[2], event[2])
    end
    return table.concat(parts) .. "\n\t"
end

-- Variables a driver adds while it runs (`added`: { NAME = value }, in that order by name), each with
-- the next id; one it has already is set instead. Director tells other drivers nothing of a new one.
function Mock.addVariables(mock, deviceId, added)
    local project = mock.project
    project.variables[deviceId] = project.variables[deviceId] or {}
    project.variableNames[deviceId] = project.variableNames[deviceId] or {}
    local names = {}
    for name in pairs(added or {}) do
        names[#names + 1] = name
    end
    table.sort(names)
    local last = 1000
    for id in pairs(project.variables[deviceId]) do
        last = math.max(last, id)
    end
    for _, name in ipairs(names) do
        local existing = nil
        for id, known in pairs(project.variableNames[deviceId]) do
            if known == name then
                existing = id
            end
        end
        if existing then
            Mock.changeVariable(mock, deviceId, existing, added[name])
        else
            last = last + 1
            project.variables[deviceId][last] = added[name]
            project.variableNames[deviceId][last] = name
        end
    end
end

-- Cameras whose drivers follow DirectorLink's camera agreement (1.10.0, ADR-065; made up: no such
-- driver is in this repository): one camera proxy each, a basic login, and the driver's variables
-- ONLINE, then (with `marker`, "1" by default; false: not yet) DIRECTORLINK_CAMERA and
-- DIRECTORLINK_CAMERA_KIND (`kind`, "camera" or "doorbell"), then LAST_ALERT and LAST_RING, then
-- (with `events_variable`) DIRECTORLINK_CAMERA_EVENTS. Its events, as Director gives its driver.xml:
-- Mock.AGREEMENT_EVENTS (Alert is 7, Ring 8), or `events` ({ { id, name } }). `list`: { { id,
-- protocol, name, room (10 or 11), address, kind, marker, events, events_variable, file } }; by
-- default 67 "Porch" (a camera, Living Room, driver 157) and 68 "Entrance" (a doorbell, Kitchen,
-- driver 158).
Mock.AGREEMENT_EVENTS = { { 1, "Camera Online" }, { 2, "Camera Offline" }, { 3, "Motion" }, { 7, "Alert" }, { 8, "Ring" } }
Mock.AGREEMENT_FILE = "DirectorLink-Example-Camera.c4z"

function Mock.withAgreementCameras(project, list)
    list = list or {
        { id = 67, protocol = 157, name = "Porch", room = 11, address = "192.0.2.51", kind = "camera" },
        { id = 68, protocol = 158, name = "Entrance", room = 10, address = "192.0.2.52", kind = "doorbell" },
    }
    project.cameras = project.cameras or {}
    project.deviceData = project.deviceData or {}
    for _, camera in ipairs(list) do
        local room = camera.room or 11
        local roomName = room == 10 and "Kitchen" or "Living Room"
        local driver = camera.file or Mock.AGREEMENT_FILE
        project.devices[camera.protocol] = {
            deviceName = camera.name, driverFileName = driver, roomId = room, roomName = roomName,
            proxies = { [camera.id] = { deviceName = camera.name, driverFileName = "camera.c4i" } },
        }
        project.devices[camera.id] = {
            deviceName = camera.name, driverFileName = "camera.c4i", roomId = room, roomName = roomName,
            protocol = { [camera.protocol] = { deviceName = camera.name, driverFileName = driver } },
        }
        project.cameras[camera.id] = {
            address = camera.address, http_port = 80, auth_type = "BASIC", username = "viewer", password = "cam-pass",
            query = "snapshot.jpg?size=%dx%d",
        }
        local names, values = { "ONLINE" }, { ONLINE = "1", LAST_ALERT = "", LAST_RING = "" }
        if camera.marker ~= false then
            names[#names + 1] = "DIRECTORLINK_CAMERA"
            names[#names + 1] = "DIRECTORLINK_CAMERA_KIND"
            values.DIRECTORLINK_CAMERA = camera.marker or "1"
            values.DIRECTORLINK_CAMERA_KIND = camera.kind or "camera"
        end
        names[#names + 1] = "LAST_ALERT"
        names[#names + 1] = "LAST_RING"
        if camera.events_variable then
            names[#names + 1] = "DIRECTORLINK_CAMERA_EVENTS"
            values.DIRECTORLINK_CAMERA_EVENTS = camera.events_variable
        end
        project.variables[camera.protocol] = {}
        project.variableNames[camera.protocol] = {}
        for index, name in ipairs(names) do
            project.variables[camera.protocol][1000 + index] = values[name]
            project.variableNames[camera.protocol][1000 + index] = name
        end
        project.deviceData[camera.protocol] = { version = "1", events = Mock.eventsXml(camera.events or Mock.AGREEMENT_EVENTS) }
    end
    return project
end

-- The id of the event `name` among the driver's events (as Director gives its driver.xml), or nil.
local function eventNamed(mock, deviceId, name)
    local data = (mock.project.deviceData or {})[deviceId]
    for id, eventName in tostring(data and data.events or ""):gmatch("<id>(%d+)</id><name>(.-)</name>") do
        if eventName == name then
            return tonumber(id)
        end
    end
    return nil
end

local function setNamed(mock, deviceId, name, value)
    for variableId, known in pairs(mock.project.variableNames[deviceId] or {}) do
        if known == name then
            Mock.changeVariable(mock, deviceId, variableId, value)
        end
    end
end

-- A camera driver of the agreement raises an alert as the agreement says: LAST_ALERT (the label),
-- then its event named Alert. Returns how many registrations of the event heard it.
function Mock.cameraAlert(mock, protocol, label)
    setNamed(mock, protocol, "LAST_ALERT", label)
    return Mock.fireDeviceEvent(mock, protocol, eventNamed(mock, protocol, "Alert") or -1)
end

-- A doorbell camera's driver of the agreement rings: LAST_RING (`at`, ISO 8601 UTC; now by default),
-- then its event named Ring. Returns how many registrations of the event heard it.
function Mock.cameraRing(mock, protocol, at)
    setNamed(mock, protocol, "LAST_RING", at or os.date("!%Y-%m-%dT%H:%M:%SZ"))
    return Mock.fireDeviceEvent(mock, protocol, eventNamed(mock, protocol, "Ring") or -1)
end

-- The Hikvision camera driver raises an alert as it does: LAST_ALERT (the detection's label, e.g.
-- "Person" or "Line Crossing") and LAST_ALERT_TIME set, then its Alert event. Returns how many
-- registrations of the event heard it.
function Mock.hikvisionAlert(mock, protocol, label)
    for variableId, name in pairs(mock.project.variableNames[protocol] or {}) do
        if name == "LAST_ALERT" then
            Mock.changeVariable(mock, protocol, variableId, label)
        elseif name == "LAST_ALERT_TIME" then
            Mock.changeVariable(mock, protocol, variableId, os.date("%Y-%m-%d %H:%M:%S"))
        end
    end
    return Mock.fireDeviceEvent(mock, protocol, Mock.HIKVISION_ALERT)
end

-- Control4's Relay Door, Gate and Garage Door Controllers (ADR-069): each a driver with one uibutton
-- proxy, its variable STATE (1001) and its connections, as C4:GetBoundProviderDevice gives them
-- (project.bindings[controller][connection] = the device bound there: 1 Open/Toggle relay, 2 Close,
-- 3 Stop, 4 Closed Contact, 5 Opened Contact). `list`: { { id (the proxy), controller, name, room,
-- file, kind ("door", "gate", "garage_door"), state ("Opened", "Closed", "Partial", "Unknown"),
-- bindings } }; by default:
--   71 "Main Gate" (Living Room; driver 161, gate_relay_control.c4z): its relay is the DoorBird's
--      (driver 110, whose doorstation is 93 "Front Gate"), a Closed Contact bound; Closed.
--   72 "Garage Door" (Kitchen; driver 162, a second download "garagedoor_relay_control (1).c4z"):
--      Open and Close relays on a relay module (173, 174), no contact; Unknown.
--   73 "Back Door" (Kitchen; driver 163, door_relay_control.c4z): its relay is a KNX Contact/Relay
--      DirectorLink shows, 75 "Back Door Relay" (Kitchen), an Opened Contact bound; Closed.
--   74 "Side Gate" (Living Room; driver 164): nothing bound to its Open/Toggle relay.
Mock.CONTROLLER_FILES = { door = "door_relay_control.c4z", gate = "gate_relay_control.c4z", garage_door = "garagedoor_relay_control.c4z" }

function Mock.withRelayControllers(project, list)
    list = list or {
        { id = 71, controller = 161, name = "Main Gate", room = 11, kind = "gate", state = "Closed", bindings = { [1] = 110, [4] = 175 } },
        { id = 72, controller = 162, name = "Garage Door", room = 10, kind = "garage_door", file = "garagedoor_relay_control (1).c4z", state = "Unknown", bindings = { [1] = 173, [2] = 174 } },
        { id = 73, controller = 163, name = "Back Door", room = 10, kind = "door", state = "Closed", bindings = { [1] = 75, [5] = 176 }, relay = { id = 75, name = "Back Door Relay" } },
        { id = 74, controller = 164, name = "Side Gate", room = 11, kind = "gate", state = "Unknown", bindings = {} },
    }
    project.bindings = project.bindings or {}
    project.variableNames = project.variableNames or {}
    for _, door in ipairs(list) do
        local room = door.room or 11
        local roomName = door.roomName or (room == 10 and "Kitchen" or "Living Room")
        local file = door.file or Mock.CONTROLLER_FILES[door.kind or "gate"]
        local driverName = door.kind == "door" and "Relay Door Controller (OS2.9+)" or door.kind == "garage_door" and "Relay Garage Door Controller (OS2.9+)" or "Relay Gate Controller (OS2.9+)"
        project.devices[door.controller] = {
            deviceName = driverName, driverFileName = file, roomId = room, roomName = roomName,
            proxies = { [door.id] = { deviceName = door.name, driverFileName = "uibutton.c4i" } },
        }
        project.devices[door.id] = {
            deviceName = door.name, driverFileName = "uibutton.c4i", roomId = room, roomName = roomName,
            protocol = { [door.controller] = { deviceName = driverName, driverFileName = file } },
        }
        if door.relay then
            project.devices[door.relay.id] = {
                deviceName = door.relay.name, driverFileName = "knx_contact_relay.c4z", roomId = door.relay.room or room, roomName = door.relay.roomName or roomName,
            }
        end
        project.bindings[door.controller] = door.bindings or {}
        project.variables[door.controller] = { [1001] = door.state or "Unknown" }
        project.variableNames[door.controller] = { [1001] = "STATE" }
    end
    return project
end

-- A gate at a doorbell camera of the camera agreement (1.11.0, ADR-078), as on the owner's
-- controller (the Relay Gate Controller 530, its button 531, whose Open/Toggle relay is bound to the
-- DirectorLink · DoorBird driver 761's relay connection "Relay 1"; 761's camera 763 is a doorbell):
-- by default 76 "Entrance Gate" (Kitchen; driver 166, gate_relay_control.c4z, one relay, no contact)
-- on the driver 158 of 68 "Entrance" (Mock.withAgreementCameras). `gate`: as an item of
-- Mock.withRelayControllers' list.
function Mock.withDoorbellGate(project, gate)
    return Mock.withRelayControllers(project, {
        gate or { id = 76, controller = 166, name = "Entrance Gate", room = 10, kind = "gate", state = "Unknown", bindings = { [1] = 158 } },
    })
end

-- Control4's own Sonos drivers (1.11.0, ADR-080), as Snap One names them ("Works With Sonos
-- Certified"): the household (sonosNetwork.c4z, an AV switch, 84 "Sonos Network" in the Kitchen),
-- a player each (sonos.c4z, a media service: 85 "Kitchen Sonos", and 86 "Living Room Sonos" on a
-- copy in another case), a Sonos driver that is its own device (87 "Sonos Line In",
-- sonosGlobalLineIn.c4z), and Sonance's amplifier (88 "Sonance Amp"), which is not Sonos.
function Mock.withControl4Sonos(project)
    local function driver(protocol, file, room, roomName, proxy, name, proxyFile)
        project.devices[protocol] = {
            deviceName = "Sonos (Works With Sonos Certified)", driverFileName = file, roomId = room, roomName = roomName,
            proxies = { [proxy] = { deviceName = name, driverFileName = proxyFile } },
        }
        project.devices[proxy] = {
            deviceName = name, driverFileName = proxyFile, roomId = room, roomName = roomName,
            protocol = { [protocol] = { deviceName = "Sonos (Works With Sonos Certified)", driverFileName = file } },
        }
    end
    driver(180, "sonosNetwork.c4z", 10, "Kitchen", 84, "Sonos Network", "avswitch.c4i")
    driver(181, "sonos.c4z", 10, "Kitchen", 85, "Kitchen Sonos", "media_service.c4i")
    driver(182, "SONOS (1).c4z", 11, "Living Room", 86, "Living Room Sonos", "media_service.c4i")
    project.devices[87] = { deviceName = "Sonos Line In", driverFileName = "sonosGlobalLineIn.c4z", roomId = 11, roomName = "Living Room" }
    project.devices[88] = { deviceName = "Sonance Amp", driverFileName = "sonance_dsp2_750.c4z", roomId = 11, roomName = "Living Room" }
    return project
end

-- A door controller's state changes as its driver does it: STATE, then the event of that state
-- (Opened 1, Closed 2, Partial 3, Unknown 4). Returns how many registrations heard the event.
Mock.CONTROLLER_EVENTS = { Opened = 1, Closed = 2, Partial = 3, Unknown = 4 }

function Mock.controllerState(mock, controller, value)
    Mock.changeVariable(mock, controller, 1001, value)
    return Mock.fireDeviceEvent(mock, controller, Mock.CONTROLLER_EVENTS[value])
end

-- The refrigerator's driver reports: variables by name, e.g. { DOOR_OPEN = "1" }.
function Mock.setRefrigerator(mock, protocol, values)
    for variableId, name in pairs(mock.project.variableNames[protocol] or {}) do
        if values[name] ~= nil then
            Mock.changeVariable(mock, protocol, variableId, values[name])
        end
    end
end

-- Security partitions (security.c4i, 1.2.0) with the variables bkwagner read on a live Director
-- (#15). Variable 1004, which DirectorLink does not read, holds a text that must never reach the API.
Mock.PARTITION_VARIABLES = {
    [1000] = "HOME_STATE", [1001] = "AWAY_STATE", [1002] = "DISARMED_STATE", [1003] = "ALARM_STATE",
    [1005] = "TROUBLE_TEXT", [1006] = "IS_ACTIVE", [1007] = "PARTITION_STATE", [1008] = "DELAY_TIME_TOTAL",
    [1009] = "DELAY_TIME_REMAINING", [1010] = "OPEN_ZONE_COUNT", [1011] = "ALARM_TYPE", [1012] = "ARMED_TYPE",
}
Mock.PARTITION_NAMES = {}
for id, name in pairs(Mock.PARTITION_VARIABLES) do
    Mock.PARTITION_NAMES[name] = id
end

-- An alarm panel (its driver's name is a placeholder) that lists three partitions, as a real panel
-- lists every partition it has: 80 "House" (Living Room), disarmed with a zone open; 81 "Garage"
-- (Kitchen), armed away; and 82 "Partition 3", which the panel does not use (IS_ACTIVE 0).
function Mock.withPartitions(project)
    local partitions = {
        { id = 80, name = "House", room = 11, state = "DISARMED_NOT_READY", disarmed = "1", open = "1" },
        { id = 81, name = "Garage", room = 10, state = "ARMED", away = "1", armedType = "Away" },
        { id = 82, name = "Partition 3", room = 11, state = "DISARMED_READY", disarmed = "1", active = "0" },
    }
    local proxies = {}
    for _, partition in ipairs(partitions) do
        proxies[partition.id] = { deviceName = partition.name, driverFileName = "security.c4i" }
    end
    project.devices[130] = {
        deviceName = "Alarm Panel", driverFileName = "alarm_panel.c4z", roomId = 11, roomName = "Living Room", proxies = proxies,
    }
    for _, partition in ipairs(partitions) do
        project.devices[partition.id] = {
            deviceName = partition.name, driverFileName = "security.c4i", roomId = partition.room,
            roomName = partition.room == 10 and "Kitchen" or "Living Room",
            protocol = { [130] = { deviceName = "Alarm Panel", driverFileName = "alarm_panel.c4z" } },
        }
        project.variables[partition.id] = {
            [1000] = "0", [1001] = partition.away or "0", [1002] = partition.disarmed or "0", [1003] = "0",
            [1004] = "Keypad text of " .. partition.name, [1005] = "", [1006] = partition.active or "1",
            [1007] = partition.state, [1008] = "0", [1009] = "0", [1010] = partition.open or "0",
            [1011] = "", [1012] = partition.armedType or "",
        }
        project.variableNames[partition.id] = {}
        for variableId, name in pairs(Mock.PARTITION_VARIABLES) do
            project.variableNames[partition.id][variableId] = name
        end
    end
    return project
end

-- A partition reports: variables by name, e.g. { PARTITION_STATE = "ALARM", ALARM_STATE = "1" },
-- each delivered like any variable change.
function Mock.setPartition(mock, id, values)
    for name, value in pairs(values) do
        Mock.changeVariable(mock, id, assert(Mock.PARTITION_NAMES[name], "no partition variable " .. name), value)
    end
end

-- The project the dev server and the app preview show: the default one plus every family added
-- since (1.1.0, the fans and the alarm's partitions of 1.2.0, and a Samsung refrigerator of 1.7.0
-- with its driver's 1.0.0 variables).
-- Its thermostats are all in °C since 1.10.2 (the °F ones are in Mock.fahrenheitProject), with a
-- floor zone that reports no room temperature.
function Mock.demoProject()
    local project = Mock.withShades(Mock.withLegacyLights(Mock.project()))
    Mock.withDualThermostat(project, { id = 31, protocol = 112, room = 10, scale = "CELSIUS" })
    Mock.withHeatOnlyZone(project, { id = 32, protocol = 113, room = 11, name = "Bathroom floor", scale = "CELSIUS", heat = "21.5" })
    Mock.withUnreportedTemperatureZone(project)
    Mock.withFans(project)
    Mock.withPartitions(project)
    Mock.withRefrigerator(project)
    return project
end

-- The dev server's °F project (scripts/dev_server.py --fahrenheit, 1.10.2): the demo home as a US
-- home reports it (Composer's TemperatureScale and every thermostat in °F), with the thermostats of
-- #75: a minisplit (69 °F set, 74 °F now), a thermostat with heat and cool setpoints and no single
-- one (a Nest), a temperature and humidity sensor without a scale variable, and a weather driver on
-- the thermostat proxy (left out of Climate).
function Mock.fahrenheitProject()
    local project = Mock.withShades(Mock.withLegacyLights(Mock.project()))
    project.projectProperties.TemperatureScale = "FAHRENHEIT"
    local parents = project.variables[30]
    parents[1100], parents[1130], parents[1131], parents[1149] = "FAHRENHEIT", "78", "25.6", "72"
    Mock.withDualThermostat(project, { id = 31, protocol = 112, room = 10, scale = "FAHRENHEIT" })
    Mock.withHeatOnlyZone(project, { id = 32, protocol = 113, room = 11, name = "Bathroom floor", scale = "FAHRENHEIT", heat = "21.5" })
    project.variables[32][1132] = "71"
    Mock.withMinisplit(project)
    Mock.withNestThermostat(project)
    Mock.withTemperatureSensor(project)
    Mock.withWeatherThermostat(project)
    Mock.withFans(project)
    Mock.withPartitions(project)
    Mock.withRefrigerator(project)
    return project
end

-- Director's C4SystemEvents (names and ids as in Snap One's drivers-common-public handlers.lua).
Mock.SYSTEM_EVENTS = {
    OnAll = 1, OnAlive = 2, OnProjectChanged = 3, OnProjectNew = 4, OnProjectLoaded = 5, OnPIP = 6,
    OnItemAdded = 7, OnItemNameChanged = 8, OnItemDataChanged = 9, OnDeviceDataChanged = 10,
    OnItemRemoved = 11, OnItemMoved = 12, OnDriverAdded = 13, OnDeviceIdentified = 14,
    OnBindingAdded = 15, OnBindingRemoved = 16,
}

-- Installs global C4 and Properties objects backed by `project`.
function Mock.install(project)
    project = project or Mock.project()
    local mock = {
        -- The project Director serves: tests change it as an installer would in Composer.
        project = project,
        persist = {},
        persistEncrypted = {},
        -- Outgoing network connections (the relay): binding -> { host, port, kind, options,
        -- connects, disconnects, sent }.
        network = {},
        properties = {},
        debugLog = {},
        sent = {},
        closed = {},
        commands = {},
        proxy = {},
        listeners = {},
        urlRequests = {},
        -- Answers waiting while mock.httpDeferred is set (Mock.deliverHttp).
        httpQueue = {},
        deviceEvents = {},
        -- System events registered: { eventId, deviceId }.
        systemEvents = {},
        servers = {},
        -- Direct HTTPS (ADR-082): TLS servers, CSRs asked for, the private keys handed out, the
        -- ports of servers destroyed.
        tlsServers = {},
        tlsCalls = {},
        csrCalls = {},
        privateKeys = {},
        destroyedServers = {},
        timers = {},
        uuidCount = 0,
        clock = 5000,
    }

    local C4 = {}

    function C4:UUID(_kind)
        mock.uuidCount = mock.uuidCount + 1
        local n = mock.uuidCount
        return string.format("%08x-%04x-4%03x-8%03x-%012x", (n * 2654435761) % 4294967296, n % 65536, n % 4096, (n * 7) % 4096, n * 97)
    end

    function C4:PersistGetValue(key, _encrypted)
        local value = mock.persist[key]
        -- Like Director (OS 3.4.3): a stored string that is a JSON object or array comes back decoded.
        if type(value) == "string" and value:match("^%s*[%[{]") then
            local decoded = Json.decode(value)
            if type(decoded) == "table" then
                return decoded
            end
        end
        return value
    end

    function C4:PersistSetValue(key, value, encrypted)
        mock.persist[key] = value
        mock.persistEncrypted[key] = encrypted == true
    end

    function C4:UpdateProperty(name, value)
        mock.properties[name] = value
    end

    function C4:DebugLog(message)
        mock.debugLog[#mock.debugLog + 1] = message
    end

    function C4:GetTime()
        mock.clock = mock.clock + 3
        return mock.clock
    end

    function C4:GetVersionInfo()
        return { version = project.osVersion }
    end

    function C4:GetSystemType()
        return "XDT_CORE1"
    end

    function C4:GetTimeZone()
        return "Asia/Jerusalem"
    end

    function C4:GetBootID()
        return "boot-1"
    end

    function C4:GetDeviceID()
        return project.bridgeId
    end

    -- The controller's MAC address: the same for every project unless a test gives one (another
    -- controller).
    function C4:GetUniqueMAC()
        return project.mac or "000FFF0A1B2C"
    end

    function C4:GetProjectProperty(name)
        return project.projectProperties[name]
    end

    function C4:GetProjectHierarchy()
        return project.hierarchy
    end

    function C4:GetDevices(_filter)
        return project.devices
    end

    function C4:GetVariable(deviceId, variableId)
        local values = project.variables[deviceId]
        return values and values[variableId]
    end

    function C4:GetDeviceVariables(deviceId)
        local result = {}
        local names = (project.variableNames or {})[deviceId] or {}
        for id, value in pairs(project.variables[deviceId] or {}) do
            result[id] = { name = names[id] or tostring(id), value = value }
        end
        return result
    end

    -- The <devicedata> tags of a driver's driver.xml (project.deviceData[id][tag]); a driver without
    -- any says "" for "version", as Director gives a missing tag. Every protocol driver has version
    -- "1" unless a test says otherwise; Director updating a driver changes it (Mock.updateDeviceDriver).
    -- Without a tag, the whole <devicedata> (its version, capabilities and events, or a test's
    -- `devicedata`).
    function C4:GetDeviceData(deviceId, tag)
        local data = (project.deviceData or {})[deviceId]
        if tag == nil then
            if not data then
                return ""
            end
            if data.devicedata ~= nil then
                return data.devicedata
            end
            local parts = { "<devicedata>" }
            for _, name in ipairs({ "version", "capabilities", "events" }) do
                if data[name] ~= nil then
                    parts[#parts + 1] = "<" .. name .. ">" .. tostring(data[name]) .. "</" .. name .. ">"
                end
            end
            parts[#parts + 1] = "</devicedata>"
            return table.concat(parts)
        end
        if data and data[tag] ~= nil then
            return data[tag]
        end
        local device = project.devices[deviceId]
        if tag == "version" and device and type(device.proxies) == "table" and next(device.proxies) ~= nil then
            return "1"
        end
        return ""
    end

    function C4:RegisterDeviceEvent(deviceId, eventId)
        mock.deviceEvents[#mock.deviceEvents + 1] = { deviceId, eventId }
    end

    -- The device bound to a connection of another device (project.bindings), 0 when none; an error
    -- while project.bindingsUnreadable is set, as a Director without the call.
    function C4:GetBoundProviderDevice(deviceId, bindingId)
        if project.bindingsUnreadable then
            error("GetBoundProviderDevice is not available")
        end
        local bindings = (project.bindings or {})[deviceId]
        return bindings and bindings[bindingId] or 0
    end

    function C4:RegisterSystemEvent(eventId, deviceId)
        mock.systemEvents[#mock.systemEvents + 1] = { eventId, deviceId }
    end

    function C4:UnregisterAllSystemEvents()
        mock.systemEvents = {}
    end

    function C4:RegisterVariableListener(deviceId, variableId)
        mock.listeners[#mock.listeners + 1] = { deviceId, variableId }
    end

    function C4:UnregisterVariableListener(deviceId, variableId)
        for index = #mock.listeners, 1, -1 do
            if mock.listeners[index][1] == deviceId and mock.listeners[index][2] == variableId then
                table.remove(mock.listeners, index)
            end
        end
    end

    function C4:UnregisterAllVariableListeners()
        mock.listeners = {}
    end

    function C4:SendToDevice(deviceId, command, params)
        mock.commands[#mock.commands + 1] = { device = deviceId, command = command, params = params }
    end

    function C4:SendUIRequest(deviceId, request, params)
        -- Blind proxies of Mock.withShade answer GET_SETUP; the others fail it, like a Director
        -- that does not know the request.
        local setup = project.blindSetups and project.blindSetups[deviceId]
        if setup and request == "GET_SETUP" then
            return setup
        end
        local camera = project.cameras and project.cameras[deviceId]
        if camera and request == "GET_PROPERTIES" then
            return string.format(
                "<camera_properties><address>%s</address><http_port>%d</http_port><https_port>443</https_port>"
                    .. "<use_https>false</use_https><authentication_required>true</authentication_required>"
                    .. "<authentication_type>%s</authentication_type><username>%s</username><password>%s</password>"
                    .. "</camera_properties>",
                camera.address, camera.http_port, camera.composer_auth_type or camera.auth_type, camera.username, camera.password:gsub("&", "&amp;")
            )
        elseif camera and request == "GET_SNAPSHOT_QUERY_STRING" then
            local query = camera.query:find("%%d") and string.format(camera.query, params.SIZE_X, params.SIZE_Y) or camera.query
            return "<snapshot_query_string>" .. query .. "</snapshot_query_string>"
        end
        error("UI request failed")
    end

    function C4:Hash(algorithm, data, options)
        local hashes = { SHA1 = sha1, SHA256 = sha256 }
        if hashes[algorithm] then
            local digest = hashes[algorithm](data)
            if options and options.return_encoding == "BASE64" then
                return C4:Base64Encode(digest)
            end
            return (digest:gsub(".", function(c)
                return string.format("%02X", c:byte())
            end))
        end
        assert(algorithm == "MD5", "only MD5, SHA1 and SHA256 are faked")
        return string.upper(md5(data))
    end

    function C4:HMAC(digest, key, data, options)
        options = options or {}
        assert(digest == "SHA256", "only HMAC-SHA256 is faked")
        key, data = decodeValue(key, options.key_encoding), decodeValue(data, options.data_encoding)
        if not key or not data then
            return nil, "bad encoding"
        end
        return encodeValue(hmacSha256(key, data), options.return_encoding or "NONE")
    end

    local function crypt(encrypt, cipher, key, iv, data, options)
        options = options or {}
        if cipher ~= "AES-256-CBC" then
            return nil, "unsupported cipher " .. tostring(cipher)
        end
        key, iv, data = decodeValue(key, options.key_encoding), decodeValue(iv, options.iv_encoding), decodeValue(data, options.data_encoding)
        if not key or not iv or not data or #key ~= 32 then
            return nil, "bad key, IV or data"
        end
        mock.cryptCalls = (mock.cryptCalls or 0) + 1
        local result, err = (encrypt and aes.encryptCBC or aes.decryptCBC)(key, iv, data, options.padding ~= false)
        if not result then
            return nil, err
        end
        return encodeValue(result, options.return_encoding or "NONE")
    end

    function C4:Encrypt(cipher, key, iv, data, options)
        return crypt(true, cipher, key, iv, data, options)
    end

    function C4:Decrypt(cipher, key, iv, data, options)
        return crypt(false, cipher, key, iv, data, options)
    end

    function C4:CreateNetworkConnection(binding, host)
        assert(mock.network[binding] == nil, "network binding " .. tostring(binding) .. " created twice")
        mock.network[binding] = { host = host, connects = 0, disconnects = 0, sent = "" }
    end

    function C4:NetPortOptions(binding, port, kind, options)
        local connection = assert(mock.network[binding], "NetPortOptions before CreateNetworkConnection")
        connection.port, connection.kind, connection.options = port, kind, options
        -- Like Director, a CA file is read from the driver package (its path is relative to it);
        -- nil when the package has no such file.
        if options and options.CACERTFILE then
            local file = io.open(DRIVER_ROOT .. "/" .. tostring(options.CACERTFILE):gsub("^%./", ""), "rb")
            connection.caCertificates = file and file:read("*a") or nil
            if file then
                file:close()
            end
        end
    end

    function C4:NetConnect(binding, port, kind)
        local connection = assert(mock.network[binding], "NetConnect before CreateNetworkConnection")
        -- UDP (the search for Sonos players) needs no options; TCP and SSL ones have them.
        if kind == "UDP" then
            connection.port, connection.kind = port, kind
        else
            assert(connection.port == port, "NetConnect on a port without options")
        end
        connection.connects = connection.connects + 1
    end

    function C4:NetDisconnect(binding, _port)
        local connection = mock.network[binding]
        if connection then
            connection.disconnects = connection.disconnects + 1
        end
    end

    function C4:SendToNetwork(binding, port, data)
        local connection = assert(mock.network[binding], "SendToNetwork before CreateNetworkConnection")
        connection.sent = connection.sent .. data
        -- Each message apart too (UDP datagrams), with the port it went to.
        connection.datagrams = connection.datagrams or {}
        connection.datagrams[#connection.datagrams + 1] = { port = port, data = data }
    end

    function C4:Base64Encode(data)
        local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        return ((data:gsub(".", function(c)
            local bits, byte = "", c:byte()
            for i = 8, 1, -1 do
                bits = bits .. (byte % 2 ^ i - byte % 2 ^ (i - 1) > 0 and "1" or "0")
            end
            return bits
        end) .. "0000"):gsub("%d%d%d?%d?%d?%d?", function(bits)
            if #bits < 6 then
                return ""
            end
            local n = 0
            for i = 1, 6 do
                n = n + (bits:sub(i, i) == "1" and 2 ^ (6 - i) or 0)
            end
            return chars:sub(n + 1, n + 1)
        end) .. ({ "", "==", "=" })[#data % 3 + 1])
    end

    -- A digest login at a fake camera (qop=auth), as a Hikvision camera checks one: every 401 gives a
    -- new nonce ("n1", "n2", ... per camera), and each nonce is taken while the camera knows it
    -- (camera.digest.nonces = {} forgets them, as a restart does), with its counts going up only:
    -- one out of order, or used again, is refused (401). `camera.staleAfter`: a nonce used that many
    -- times is refused with stale=TRUE. Kept in camera.digest: issued (401s given), accepted.
    local function digestAccepted(camera, authorization, path)
        local digest = camera.digest
        local fields = {}
        for name, value in authorization:gmatch('([%w_-]+)="([^"]*)"') do
            fields[name] = value
        end
        for name, value in authorization:gmatch("([%w_-]+)=([^\",%s]+)") do
            fields[name] = fields[name] or value
        end
        local known = fields.nonce and digest.nonces[fields.nonce]
        if not known or fields.uri ~= path or fields.opaque ~= "op1" then
            return false
        end
        local ha1 = md5(camera.username .. ":Camera:" .. (camera.camera_password or camera.password))
        local ha2 = md5("GET:" .. path)
        if fields.response ~= md5(ha1 .. ":" .. fields.nonce .. ":" .. tostring(fields.nc) .. ":" .. tostring(fields.cnonce) .. ":auth:" .. ha2) then
            return false
        end
        local count = tonumber(fields.nc or "", 16)
        if camera.staleAfter and known.uses >= camera.staleAfter then
            return false, true
        end
        if not count or count <= known.last then
            return false
        end
        known.last, known.uses = count, known.uses + 1
        digest.accepted = digest.accepted + 1
        return true
    end

    -- A fake camera web server: digest (qop=auth) or basic login, answers with a tiny "JPEG".
    local function cameraAnswer(url, headers)
        mock.urlRequests[#mock.urlRequests + 1] = { url = url, headers = headers }
        if url:match("^https://api%.open%-meteo%.com/") then
            if not mock.weather then
                return nil, "Couldn't resolve host"
            end
            -- A function answers at the moment it is asked (driver/tests/weather_fake.lua).
            local answer = type(mock.weather) == "function" and mock.weather(url) or mock.weather
            return { code = 200, headers = { ["Content-Type"] = "application/json" }, body = Json.encode(answer) }
        end
        if mock.camerasOffline then
            return nil, "Couldn't connect to server"
        end
        local host, path = url:match("^https?://([^/:]+)[^/]*(/.*)$")
        for _, camera in pairs(project.cameras or {}) do
            if camera.address == host then
                local authorization = headers and headers.Authorization or ""
                local ok, stale = false, false
                if camera.auth_type == "BASIC" then
                    ok = authorization == "Basic " .. C4:Base64Encode(camera.username .. ":" .. (camera.camera_password or camera.password))
                else
                    camera.digest = camera.digest or { issued = 0, accepted = 0, nonces = {} }
                    ok, stale = digestAccepted(camera, authorization, path)
                end
                if ok then
                    return { code = 200, headers = { ["Content-Type"] = "image/jpeg" }, body = "\255\216JPEG-" .. path .. "\255\217" }
                end
                local challenge = 'Basic realm="Camera"'
                if camera.auth_type ~= "BASIC" then
                    local digest = camera.digest
                    digest.issued = digest.issued + 1
                    local nonce = "n" .. digest.issued
                    digest.nonces[nonce] = { last = 0, uses = 0 }
                    challenge = 'Digest realm="Camera", qop="auth", nonce="' .. nonce .. '", opaque="op1", algorithm=MD5' .. (stale and ", stale=TRUE" or "")
                end
                -- `offersBasic`: Basic offered too, in a WWW-Authenticate header before digest's.
                if camera.offersBasic and camera.auth_type ~= "BASIC" then
                    return { code = 401, headers = { ["WWW-Authenticate"] = { 'Basic realm="Camera"', challenge } }, body = "" }
                end
                return { code = 401, headers = { ["WWW-Authenticate"] = challenge }, body = "" }
            end
        end
        return nil, "Couldn't resolve host"
    end

    -- mock.http(request), when a test sets it, answers first (Sonos players, driver/tests/
    -- sonos_fake.lua): a response, nil and an error (no answer), or false to leave the request to
    -- the cameras and the weather. With mock.httpDeferred, answers wait in mock.httpQueue until
    -- Mock.deliverHttp, as real transfers arrive later.
    local function answer(transfer, method, url, headers, body)
        local response, err
        if mock.http then
            mock.urlRequests[#mock.urlRequests + 1] = { method = method, url = url, headers = headers, body = body }
            response, err = mock.http({ method = method, url = url, headers = headers or {}, body = body })
            if response == false then
                table.remove(mock.urlRequests)
                response, err = nil, nil
            end
        end
        if response == nil and err == nil then
            if method == "GET" then
                response, err = cameraAnswer(url, headers)
            else
                mock.urlRequests[#mock.urlRequests + 1] = { method = method, url = url, headers = headers, body = body }
                err = "Couldn't connect to server"
            end
        end
        local function deliver()
            if response then
                transfer.callback(transfer, { { url = url, code = response.code, headers = response.headers or {}, body = response.body } }, 0, nil)
            else
                transfer.callback(transfer, {}, 7, err)
            end
        end
        if mock.httpDeferred then
            mock.httpQueue[#mock.httpQueue + 1] = { deliver = deliver, url = url, method = method, headers = headers }
        else
            deliver()
        end
        return transfer
    end

    function C4:url()
        local transfer = { options = {} }
        function transfer:SetOptions(options)
            for name, value in pairs(options) do
                self.options[name] = value
            end
            return self
        end
        function transfer:OnDone(callback)
            self.callback = callback
            return self
        end
        function transfer:Get(url, headers)
            return answer(self, "GET", url, headers)
        end
        function transfer:Post(url, body, headers)
            return answer(self, "POST", url, headers, body)
        end
        return transfer
    end

    function C4:SendToProxy(binding, command, params)
        mock.proxy[#mock.proxy + 1] = { binding = binding, command = command, params = params }
    end

    function C4:CreateServer(port, delimiter, udp)
        mock.servers[port] = { delimiter = delimiter, udp = udp }
    end

    -- Direct HTTPS (ADR-082): the TLS servers made (mock.tlsServers by port, mock.tlsCalls in
    -- order); mock.tlsFails makes the next ones fail with that text.
    function C4:CreateTLSServer(port, delimiter, options, verifyMode, cipherList, certificate, privateKey, password, chain, identifier)
        local server = {
            port = port, delimiter = delimiter, options = options, verifyMode = verifyMode, cipherList = cipherList,
            certificate = certificate, privateKey = privateKey, password = password, chain = chain, identifier = identifier,
        }
        mock.tlsCalls[#mock.tlsCalls + 1] = server
        if mock.tlsFails then
            return false, mock.tlsFails
        end
        mock.tlsServers[port] = server
        return true
    end

    -- A key and CSR as Director makes them (OS 3.3.1 and newer: CSR, public key, private key), with
    -- a made-up key (x509_fake.lua). mock.csrMode: "csr_only" (before OS 3.3.1), "fail", "explicit"
    -- (the curve given by its parameters, as an old OpenSSL wrote it).
    function C4:GenerateCSR_ECC(digest, curve, subject, extensions)
        mock.csrCalls[#mock.csrCalls + 1] = { digest = digest, curve = curve, subject = subject, extensions = extensions }
        if mock.csrMode == "fail" then
            return nil, "EC key generation failed"
        end
        local seed = #mock.csrCalls + mock.uuidCount
        local name = tostring(subject):match("CN=([^/]+)") or "unknown"
        local point = X509Fake.point(seed)
        local csr = X509Fake.pem(X509Fake.request(name, point, mock.csrMode == "explicit"), "CERTIFICATE REQUEST")
        if mock.csrMode == "csr_only" then
            return csr
        end
        local privateKey = X509Fake.privateKey(seed)
        mock.privateKeys[#mock.privateKeys + 1] = privateKey
        return csr, X509Fake.pem(X509Fake.spki(point), "PUBLIC KEY"), privateKey
    end

    -- The controller's LAN address (Direct HTTPS tells the Worker it for the name's A record):
    -- mock.controllerAddress, a test changes it as DHCP would; false: Director gives nothing.
    function C4:GetControllerNetworkAddress()
        if mock.controllerAddress == false then
            return nil
        end
        return mock.controllerAddress or "192.168.1.10"
    end

    function C4:DestroyServer(port)
        mock.servers[port] = nil
        mock.tlsServers[port] = nil
        mock.destroyedServers[#mock.destroyedServers + 1] = port
    end

    function C4:ServerSend(handle, data)
        mock.sent[handle] = (mock.sent[handle] or "") .. data
    end

    function C4:ServerCloseClient(handle)
        mock.closed[handle] = true
    end

    function C4:SetTimer(delay, callback, repeating)
        -- source: the file its callback comes from (with "/"), so a test can tell the scheduler's
        -- minute timer (whose delay depends on the wall clock) from the one it is looking for.
        local defined = type(callback) == "function" and debug.getinfo(callback, "S")
        local timer = {
            delay = delay, callback = callback, repeating = repeating, cancelled = false, fired = false,
            source = defined and (defined.source:gsub("\\", "/")) or "",
        }
        function timer:Cancel()
            self.cancelled = true
        end
        mock.timers[#mock.timers + 1] = timer
        return timer
    end

    _G.C4 = C4
    _G.Properties = { ["Log Level"] = "Info" }
    _G.C4SystemEvents = {}
    for name, id in pairs(Mock.SYSTEM_EVENTS) do
        C4SystemEvents[name] = id
    end
    return mock
end

-- Delivers the answers waiting in mock.httpQueue (mock.httpDeferred), oldest first: `count` of them,
-- or all, including those asked for while delivering. Returns how many were delivered.
function Mock.deliverHttp(mock, count)
    local delivered = 0
    while #mock.httpQueue > 0 and (count == nil or delivered < count) do
        local item = table.remove(mock.httpQueue, 1)
        item.deliver()
        delivered = delivered + 1
    end
    return delivered
end

-- Runs timers that have not fired yet, including ones they schedule (up to `rounds` passes).
function Mock.fireTimers(mock, rounds)
    for _ = 1, rounds or 10 do
        local pending = {}
        for _, timer in ipairs(mock.timers) do
            if not timer.fired and not timer.cancelled then
                pending[#pending + 1] = timer
            end
        end
        if #pending == 0 then
            return
        end
        for _, timer in ipairs(pending) do
            timer.fired = true
            timer.callback()
        end
    end
end

-- Loads a fresh copy of the driver (all src.* modules) and runs its init callbacks.
-- specText replaces the stub API description (the dev server passes the built one).
-- Loads the driver as Director does. `prepare(mock)`, if given, runs first (e.g. to seed persisted
-- values).
function Mock.startDriver(project, specText, initType, prepare)
    -- The JSON module is stateless; keep it shared so tests and driver agree on Json.null.
    for name in pairs(package.loaded) do
        if name:sub(1, 4) == "src." and name ~= "src.core.json" then
            package.loaded[name] = nil
        end
    end
    package.preload["src.api.openapi_spec"] = function()
        return specText or '{"openapi":"3.1.0","info":{"title":"test"}}'
    end

    local mock = Mock.install(project)
    if prepare then
        prepare(mock)
    end
    require("src.main")
    OnDriverInit(initType or "DIT_STARTUP")
    OnDriverLateInit(initType or "DIT_STARTUP")
    -- Director gives the port; a test sets mock.portTaken in `prepare` for one held by another driver.
    if not mock.portTaken then
        OnServerStatusChanged(41999, "ONLINE")
    end
    return mock
end

-- A driver update in Composer: the driver reloads in place and keeps its persistent data (Director
-- keeps it in state.db, encrypted values included).
function Mock.updateDriver(previous, project)
    return Mock.startDriver(project, nil, "DIT_UPDATING", function(mock)
        -- Random values must not repeat, or a lost identity would be regenerated unnoticed.
        mock.uuidCount = previous.uuidCount
        for name, value in pairs(previous.persist) do
            mock.persist[name] = value
            mock.persistEncrypted[name] = previous.persistEncrypted[name]
        end
    end)
end

-- ---- Director while the driver runs ----------------------------------------------------------

-- A variable changes: Director tells the driver once per listener registered for it. Returns how
-- many times it did.
function Mock.changeVariable(mock, deviceId, variableId, value)
    mock.project.variables[deviceId] = mock.project.variables[deviceId] or {}
    mock.project.variables[deviceId][variableId] = value
    local delivered = 0
    for _, listener in ipairs(mock.listeners) do
        if listener[1] == deviceId and listener[2] == variableId then
            delivered = delivered + 1
            OnWatchedVariableChanged(deviceId, variableId, value)
        end
    end
    return delivered
end

-- A device fires an event: delivered once per registration of it. Returns how many times.
function Mock.fireDeviceEvent(mock, deviceId, eventId)
    local delivered = 0
    for _, event in ipairs(mock.deviceEvents) do
        if event[1] == deviceId and event[2] == eventId then
            delivered = delivered + 1
            OnDeviceEvent(deviceId, eventId)
        end
    end
    return delivered
end

-- A system event, as XML with its name and parameters (e.g. { iditem = 51 }), to a driver that
-- registered for it on every device (id 0). Returns whether it was delivered.
function Mock.systemEvent(mock, name, params)
    local id = Mock.SYSTEM_EVENTS[name]
    local registered = false
    for _, event in ipairs(mock.systemEvents) do
        registered = registered or (event[1] == id and event[2] == 0)
    end
    if not registered then
        return false
    end
    local names = {}
    for param in pairs(params or {}) do
        names[#names + 1] = param
    end
    table.sort(names)
    local parts = { '<systemevent name="' .. name .. '">' }
    for _, param in ipairs(names) do
        parts[#parts + 1] = string.format('<param name="%s" type="ulong">%s</param>', param, tostring(params[param]))
    end
    parts[#parts + 1] = "</systemevent>"
    OnSystemEvent(table.concat(parts))
    return true
end

-- ---- Composer changes to the project (read again when the driver refreshes it) ---------------

local function findRoom(node, roomId)
    if type(node) ~= "table" then
        return nil
    end
    if node.id == roomId then
        return node
    end
    for _, child in ipairs(node) do
        local found = findRoom(child, roomId)
        if found then
            return found
        end
    end
    return nil
end

-- The floor that holds the rooms (Ground Floor in Mock.project).
local function roomsFloor(project)
    return project.hierarchy[1][1]
end

function Mock.moveDevice(project, id, roomId)
    local room = assert(findRoom(project.hierarchy, roomId), "no room " .. tostring(roomId))
    project.devices[id].roomId, project.devices[id].roomName = roomId, room.name
end

function Mock.renameDevice(project, id, name)
    project.devices[id].deviceName = name
    for _, device in pairs(project.devices) do
        for _, links in ipairs({ device.proxies or {}, device.protocol or {} }) do
            if links[id] then
                links[id].deviceName = name
            end
        end
    end
end

-- Removes the device, its variables and every link to it (its protocol driver's proxy list).
function Mock.removeDevice(project, id)
    project.devices[id] = nil
    project.variables[id] = nil
    for _, device in pairs(project.devices) do
        if device.proxies then
            device.proxies[id] = nil
        end
        if device.protocol then
            device.protocol[id] = nil
        end
    end
end

-- A Light V2 dimmer (proxy `id`, protocol driver `protocol`) in `roomId`, at `level` percent.
function Mock.addLight(project, id, protocol, roomId, name, level)
    local room = assert(findRoom(project.hierarchy, roomId), "no room " .. tostring(roomId))
    project.devices[protocol] = {
        deviceName = "Dimmer " .. tostring(id), driverFileName = "zigbee_dimmer.c4i", roomId = roomId, roomName = room.name,
        proxies = { [id] = { deviceName = name, driverFileName = "light_v2.c4i" } },
    }
    project.devices[id] = {
        deviceName = name, driverFileName = "light_v2.c4i", roomId = roomId, roomName = room.name,
        protocol = { [protocol] = { deviceName = "Dimmer " .. tostring(id), driverFileName = "zigbee_dimmer.c4i" } },
    }
    project.variables[id] = { [1000] = (level or 0) > 0 and "1" or "0", [1001] = tostring(level or 0) }
end

function Mock.addRoom(project, id, name)
    local floor = roomsFloor(project)
    floor[#floor + 1] = { id = id, name = name, type = 8 }
end

-- The room goes from the hierarchy; move its devices first, or they bring it back by their room id.
function Mock.removeRoom(project, id)
    local floor = roomsFloor(project)
    for index = #floor, 1, -1 do
        if floor[index].id == id then
            table.remove(floor, index)
        end
    end
end

-- ---- Shades as the blind proxy shows KNX blinds on Director 3.4.3 (1.1.0) --------------------

local SHADE_VARIABLES = {
    [1000] = "Open", [1001] = "Fully Closed", [1002] = "Stopped", [1003] = "Fully Open", [1004] = "Level",
    [1005] = "Target Level", [1006] = "Type", [1007] = "Movement", [1008] = "Opening", [1009] = "Closing",
}

-- What GET_SETUP answered for the KNX blinds of a real Director 3.4.3 (the levels trimmed of their
-- colours and texts): level_discrete_control, can_stop, the movement type, and the levels.
local SHADE_SETUP = "<blind_setup><has_level>True</has_level><level_discrete_control>%s</level_discrete_control>"
    .. "<can_stop>%s</can_stop><type_locked>False</type_locked>"
    .. "<types>Shade,Group,Blind,Louver,Curtain,Shutter,Blackout,Opaque Glass,Awning,Door,Screen</types><type>4</type>"
    .. "<movements>Open-Close,Up-Down,Down-Up,Out-In,Left-Right,Right-Left</movements><movement_locked>False</movement_locked>"
    .. '<movement>1</movement><online>True</online><levels minimum="%d" maximum="%d" resolution="1" unknown="-1">'
    .. '<level name="Closed" id="2" level_setable="true" level="%d" levelType="1" buttonLinkBindingId="301"/>'
    .. '<level name="Open" id="1" level_setable="true" level="%d" levelType="1" buttonLinkBindingId="300"/>'
    .. '<level name="Toggle" buttonLinkBindingId="0" level_setable="false"/>'
    .. '<level name="Stop" buttonLinkBindingId="0" level_setable="false"/></levels>'
    .. '<presets><preset name="Closed" id="2" level="%d" levelType="1"/><preset name="Open" id="1" level="%d" levelType="1"/></presets>'
    .. "</blind_setup>"

-- A shade with the proxy's ten variables, at rest, and the setup GET_SETUP returns. options: id,
-- protocol, room (11), name, level ("0"), position (level_discrete_control, true), stop (can_stop,
-- true), open (its Open level, 100; Closed is 0), movement (the Movement variable, the movement
-- type: "Up to Down"), setup (the whole GET_SETUP answer instead).
function Mock.withShade(project, options)
    local id, protocol = options.id, options.protocol
    local roomId = options.room or 11
    local roomName = roomId == 10 and "Kitchen" or "Living Room"
    project.devices[protocol] = {
        deviceName = "KNX Blinds (2.9+)", driverFileName = "knx_blind.c4z", roomId = roomId, roomName = roomName,
        proxies = { [id] = { deviceName = options.name, driverFileName = "blind.c4i" } },
    }
    project.devices[id] = {
        deviceName = options.name, driverFileName = "blind.c4i", roomId = roomId, roomName = roomName,
        protocol = { [protocol] = { deviceName = "KNX Blinds (2.9+)", driverFileName = "knx_blind.c4z" } },
    }
    local level = options.level or "0"
    local number = tonumber(level) or -255
    local open = options.open or 100
    project.variables[id] = {
        [1000] = number > 0 and "1" or "0",
        [1001] = number == 0 and "1" or "0",
        [1002] = "1",
        [1003] = number == open and "1" or "0",
        [1004] = level,
        [1005] = level,
        [1006] = "0",
        [1007] = options.movement or "Up to Down",
        [1008] = "0",
        [1009] = "0",
    }
    project.variableNames[id] = {}
    for variableId, name in pairs(SHADE_VARIABLES) do
        project.variableNames[id][variableId] = name
    end
    project.blindSetups = project.blindSetups or {}
    project.blindSetups[id] = options.setup or string.format(
        SHADE_SETUP,
        options.position == false and "False" or "True",
        options.stop == false and "False" or "True",
        0, open, 0, open, 0, open
    )
    return project
end

-- The demo's shades: 52 goes to any position and stops (a KNX blind with a percent address),
-- 53 only opens and closes fully and cannot stop.
function Mock.withShades(project)
    Mock.withShade(project, { id = 52, protocol = 114, room = 11, name = "Terrace Shade", level = "35" })
    Mock.withShade(project, { id = 53, protocol = 115, room = 10, name = "Patio Shutter", level = "0", position = false, stop = false })
    return project
end

-- A shade reports: variables by name, e.g. { Level = "45", Opening = "1", Stopped = "0" }, each
-- delivered like any variable change.
function Mock.setShade(mock, id, values)
    for variableId, name in pairs(mock.project.variableNames[id] or {}) do
        if values[name] ~= nil then
            Mock.changeVariable(mock, id, variableId, values[name])
        end
    end
end

return Mock
