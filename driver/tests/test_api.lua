-- End-to-end tests: the real driver against the fake Director, requests sent as raw bytes.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")
local sha256 = require("sha256")

local tests = {}

local function hex(bytes)
    return (bytes:gsub(".", function(c)
        return string.format("%02x", c:byte())
    end))
end

local function isNull(value)
    return type(value) == "table" and tostring(value) == "null"
end

local function start()
    local mock = Mock.startDriver()
    local key = T.pair(mock)
    return mock, key
end

local function lastCommand(mock)
    return mock.commands[#mock.commands]
end

local function byId(items, id)
    for _, item in ipairs(items) do
        if item.id == id then
            return item
        end
    end
end

function tests.driver_starts_the_api_and_reports_ready()
    local mock = Mock.startDriver()
    T.truthy(mock.servers[41999], "API server created on port 41999")
    T.eq(mock.servers[41999].delimiter, "", "raw mode: no delimiter")
    T.eq(mock.properties["Status"], "Ready")
    T.eq(mock.properties["API Status"], "Online - port 41999")
    T.eq(mock.properties["Inventory"], "2 rooms, 14 devices, 3 lights, 1 thermostats, 0 fans, 2 blinds, 3 cameras, 1 relays, 1 doorbells")
    T.truthy(mock.properties["Pairing Code"]:match("^%d%d%d%d %d%d%d%d$"), "a new driver offers a code, shown as 1234 5678")
    T.contains(mock.properties["Pairing Status"], "Ready until")
    for _, removed in ipairs({ "Controller OS", "Location", "API Port", "Access Request", "Reload Counter",
        "Last Init Type", "Last Init Time", "Last Destroy Type", "Last Destroy Time" }) do
        T.eq(mock.properties[removed], nil, removed .. " is no longer a Composer property")
    end
end

-- The API server's port check (api/server.lua): the next one not fired yet.
local function portCheck(mock)
    for _, timer in ipairs(mock.timers) do
        if not timer.fired and not timer.cancelled and timer.source:find("src/api/server.lua", 1, true) then
            return timer
        end
    end
end

local function apiLog(message)
    local found, count = nil, 0
    for _, entry in ipairs(require("src.core.log").query({ category = "api" })) do
        if entry.message == message then
            found, count = entry, count + 1
        end
    end
    return found, count
end

-- Seen on a real controller: a camera driver took port 41999 at boot, and Director refused the
-- port to DirectorLink without telling it. DirectorLink says so and asks again every minute.
function tests.a_port_held_by_another_driver_is_reported_and_asked_for_again()
    local creates = 0
    local mock = Mock.startDriver(nil, nil, nil, function(m)
        m.portTaken = true
        local create = C4.CreateServer
        function C4:CreateServer(port, delimiter, udp)
            creates = creates + 1
            return create(self, port, delimiter, udp)
        end
    end)
    T.eq(mock.properties["API Status"], "Starting...")
    T.eq(creates, 1)
    local check = portCheck(mock)
    T.eq(check.delay, 15000, "checked 15 s after asking")
    check.fired = true
    check.callback()
    T.eq(mock.properties["API Status"], "Port 41999 taken by another driver - retrying every minute")
    T.eq(creates, 1, "not asked again yet: an ONLINE that is only slow comes first")
    local taken, count = apiLog("the API port is taken by another driver; asking again every minute")
    T.truthy(taken, "logged")
    T.eq(taken.level, "error")
    T.eq(taken.data.port, 41999)

    check = portCheck(mock)
    T.eq(check.delay, 60000, "then every minute")
    check.fired = true
    check.callback()
    T.eq(creates, 2, "asked again")
    check = portCheck(mock)
    check.fired = true
    check.callback()
    T.eq(creates, 3)
    local _, again = apiLog("the API port is taken by another driver; asking again every minute")
    T.eq(again, count, "the error is logged once")

    -- The other driver lets go: Director gives the port at the next try.
    OnServerStatusChanged(41999, "ONLINE")
    T.eq(mock.properties["API Status"], "Online - port 41999")
    T.eq(portCheck(mock), nil, "no more checks")
    T.eq(apiLog("API server ONLINE").data.taken_before, 3)
end

-- An ONLINE later than the first check: the port is DirectorLink's, and nothing is asked twice.
function tests.a_slow_online_is_not_asked_for_twice()
    local creates = 0
    local mock = Mock.startDriver(nil, nil, nil, function(m)
        m.portTaken = true
        local create = C4.CreateServer
        function C4:CreateServer(port, delimiter, udp)
            creates = creates + 1
            return create(self, port, delimiter, udp)
        end
    end)
    local check = portCheck(mock)
    check.fired = true
    check.callback()
    OnServerStatusChanged(41999, "ONLINE")
    T.eq(mock.properties["API Status"], "Online - port 41999")
    T.eq(creates, 1)
    T.eq(portCheck(mock), nil)
end

-- The port lost after it was DirectorLink's is asked for again; stopping the server is not a loss.
function tests.a_port_lost_later_is_asked_for_again()
    local creates = 0
    local mock = Mock.startDriver(nil, nil, nil, function()
        local create = C4.CreateServer
        function C4:CreateServer(port, delimiter, udp)
            creates = creates + 1
            return create(self, port, delimiter, udp)
        end
    end)
    T.eq(creates, 1)
    OnServerStatusChanged(41999, "OFFLINE")
    local check = portCheck(mock)
    T.eq(check.delay, 15000)
    check.fired = true
    check.callback()
    T.eq(creates, 2, "asked again")
    T.eq(mock.properties["API Status"], "Port 41999 taken by another driver - retrying every minute")
    OnServerStatusChanged(41999, "ONLINE")
    T.eq(portCheck(mock), nil)

    require("src.api.server").stop()
    OnServerStatusChanged(41999, "OFFLINE")
    T.eq(portCheck(mock), nil, "stopped on purpose: not asked for again")
end

function tests.a_port_given_at_once_is_not_asked_for_again()
    local mock = Mock.startDriver()
    T.eq(portCheck(mock), nil, "the check ends when the port is ONLINE")
    T.eq(apiLog("API server ONLINE").data.taken_before, nil)
end

function tests.health_and_api_description_are_public()
    local mock = Mock.startDriver()
    local health = T.http(mock, "GET", "/v1/health")
    T.eq(health.status, 200)
    T.eq(health.json.product, "directorlink")
    T.eq(health.json.status, "ok")
    T.eq(health.json.api_version, "1")
    T.truthy(isNull(health.json.detail), "detail is null when ok")
    T.truthy(health.closed, "connection closed after the response")

    local spec = T.http(mock, "GET", "/v1/openapi.json")
    T.eq(spec.status, 200)
    T.eq(spec.json.openapi, "3.1.0")
end

function tests.protected_routes_need_a_valid_key()
    local mock = Mock.startDriver()
    local response = T.http(mock, "GET", "/v1/system")
    T.eq(response.status, 401)
    T.eq(response.headers["content-type"], "application/problem+json")
    T.eq(response.json.code, "UNAUTHORIZED")
    T.eq(response.json.type, "about:blank")
    T.eq(response.json.title, "Unauthorized")
    T.contains(response.headers["www-authenticate"], "Bearer")

    T.eq(T.http(mock, "GET", "/v1/system", { key = "ak_wrong" }).status, 401)
    T.eq(T.http(mock, "GET", "/v1/system", { headers = { Authorization = "Basic abc" } }).status, 401)
end

function tests.pairing_code_works_once_and_gives_admin()
    local mock = Mock.startDriver()
    local shown = mock.properties["Pairing Code"]

    local wrong = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = "0000 0000" } })
    T.eq(wrong.status, 403)
    T.eq(wrong.json.code, "PAIRING_CODE_INVALID")
    T.eq(wrong.json.attempts_remaining, 4)

    local paired = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = shown, name = "Chrome" } })
    T.eq(paired.status, 201, "the code is accepted as Composer shows it, with the space")
    T.eq(paired.json.name, "Chrome")
    T.eq(paired.json.role, "admin")
    T.truthy(paired.json.key:match("^ak_%x+$"), "key format")
    T.truthy(paired.json.id:match("^%x%x%x%x%x%x%x%x$"), "key id format")
    T.eq(mock.properties["API Keys"], "1")

    T.eq(mock.properties["Pairing Code"], "-", "no code after use")
    T.contains(mock.properties["Pairing Status"], "Used at")
    local reused = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = shown } })
    T.eq(reused.status, 403, "a used code cannot pair again")
    T.eq(reused.json.code, "PAIRING_NOT_ACTIVE")

    T.eq(T.http(mock, "GET", "/v1/system", { key = paired.json.key }).status, 200)
end

function tests.pairing_codes_are_created_on_demand_and_expire()
    local mock = Mock.startDriver()
    T.pair(mock, "Owner")
    -- A driver that already has keys starts without a code.
    local restarted = Mock.updateDriver(mock)
    T.eq(restarted.properties["Pairing Code"], "-")
    T.contains(restarted.properties["Pairing Status"], "New Pairing Code")
    T.eq(T.http(restarted, "POST", "/v1/auth/pair", { body = { pairing_code = "12345678" } }).json.code, "PAIRING_NOT_ACTIVE")

    ExecuteCommand("LUA_ACTION", { ACTION = "NEW_PAIRING_CODE" })
    local code = restarted.properties["Pairing Code"]
    T.truthy(code:match("^%d%d%d%d %d%d%d%d$"), "New Pairing Code shows a code")
    local expiry = restarted.timers[#restarted.timers]
    T.eq(expiry.delay, 15 * 60 * 1000, "valid for 15 minutes")
    expiry.callback()
    T.eq(restarted.properties["Pairing Code"], "-")
    T.contains(restarted.properties["Pairing Status"], "Expired")
    T.eq(T.http(restarted, "POST", "/v1/auth/pair", { body = { pairing_code = code } }).json.code, "PAIRING_NOT_ACTIVE")

    ExecuteCommand("LUA_ACTION", { ACTION = "NEW_PAIRING_CODE" })
    local dashed = restarted.properties["Pairing Code"]:gsub(" ", "-")
    T.eq(T.http(restarted, "POST", "/v1/auth/pair", { body = { pairing_code = dashed, name = "Tablet" } }).status, 201,
        "a dash works too")
end

function tests.pairing_is_rate_limited()
    local mock = Mock.startDriver()
    local response
    for _ = 1, 5 do
        response = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = "00000000" } })
    end
    T.eq(response.status, 429)
    T.eq(response.json.code, "PAIRING_RATE_LIMITED")
    T.eq(response.headers["retry-after"], "60")
    T.eq(response.json.retry_after, 60, "the wait is in the body too")
    local locked = T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = mock.properties["Pairing Code"] } })
    T.eq(locked.status, 429, "even the right code waits for the lock")
    local other = T.http(mock, "POST", "/v1/auth/pair", { ip = "192.168.1.77", body = { pairing_code = mock.properties["Pairing Code"] } })
    T.eq(other.status, 201, "another device is not locked out by the first one's guesses")
end

function tests.a_pairing_code_closes_after_twenty_wrong_codes()
    local mock = Mock.startDriver()
    local code = mock.properties["Pairing Code"]
    local response
    for attempt = 1, 20 do
        response = T.http(mock, "POST", "/v1/auth/pair", { ip = "10.0.0." .. attempt, body = { pairing_code = "00000000" } })
    end
    T.eq(response.json.code, "PAIRING_NOT_ACTIVE", "from many devices, the code is closed")
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { ip = "10.0.0.99", body = { pairing_code = code } }).json.code, "PAIRING_NOT_ACTIVE")
    T.contains(mock.properties["Pairing Status"], "Closed after 20 wrong codes")
end

function tests.pairing_validates_its_body()
    local mock = Mock.startDriver()
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = "123" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = "1234 567a" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { body = { pairing_code = 12345678 } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { body = { code = "12345678" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { body = "[1]" }).json.code, "INVALID_REQUEST")
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { body = "{nope" }).json.code, "INVALID_JSON")
    T.eq(T.http(mock, "POST", "/v1/auth/pair", { body = "{}", contentType = "text/plain" }).status, 415)
end

function tests.system_reports_controller_location_and_inventory()
    local mock, key = start()
    local system = T.http(mock, "GET", "/v1/system", { key = key }).json
    T.eq(system.bridge.status, "ok")
    T.eq(system.controller.platform, "control4")
    T.eq(system.controller.os_version, "3.4.3.727848-res")
    T.eq(system.controller.model, "XDT_CORE1")
    T.eq(system.location.country_code, "IL")
    T.eq(system.location.latitude, 32.08)
    T.eq(system.location.timezone, "Asia/Jerusalem")
    T.same(system.inventory, { rooms = 2, devices = 14, supported_devices = 11, lights = 3, thermostats = 1, fans = 0, blinds = 2, cameras = 3, relays = 1, doorbells = 1, refrigerators = 0 })
    T.eq(system.lifecycle.reload_count, 1)
    T.eq(system.lifecycle.last_init_type, "DIT_STARTUP")
end

function tests.rooms_list_and_get()
    local mock, key = start()
    local rooms = T.http(mock, "GET", "/v1/rooms", { key = key }).json.items
    T.eq(#rooms, 2)
    T.eq(rooms[1].name, "Kitchen")
    T.eq(rooms[1].floor.name, "Ground Floor")
    T.eq(rooms[1].device_count, 9)
    T.eq(rooms[2].name, "Living Room")

    T.eq(T.http(mock, "GET", "/v1/rooms/11", { key = key }).json.name, "Living Room")
    T.eq(T.http(mock, "GET", "/v1/rooms/999", { key = key }).status, 404)
    T.eq(T.http(mock, "GET", "/v1/rooms/abc", { key = key }).json.code, "INVALID_PARAMETER")
end

function tests.devices_use_logical_types_and_filters()
    local mock, key = start()
    local all = T.http(mock, "GET", "/v1/devices", { key = key }).json.items
    T.eq(#all, 14)
    local camera = byId(all, 40)
    T.eq(camera.type, "other")
    T.eq(camera.supported, false)
    T.truthy(isNull(camera.href), "unsupported devices have no href")
    T.eq(byId(all, 30).href, "/v1/thermostats/30")
    T.eq(byId(all, 50).type, "blind")
    T.eq(byId(all, 50).href, "/v1/blinds/50")
    T.eq(byId(all, 20).room.name, "Kitchen")

    for _, device in ipairs(all) do
        T.eq(device.proxy, nil, "no Control4 proxy data in the API")
        T.eq(device.protocols, nil, "no Control4 protocol data in the API")
    end

    T.eq(#T.http(mock, "GET", "/v1/devices?type=light", { key = key }).json.items, 3)
    T.eq(#T.http(mock, "GET", "/v1/devices?supported=false", { key = key }).json.items, 3, "the camera, the DoorBird button and intercom")
    T.eq(#T.http(mock, "GET", "/v1/devices?room_id=10", { key = key }).json.items, 9)
    T.eq(byId(all, 93).href, "/v1/doorbells/93")
    T.eq(byId(all, 70).href, "/v1/relays/70")
    T.eq(byId(all, 60).href, "/v1/cameras/60")
    T.eq(#T.http(mock, "GET", "/v1/devices?type=blind", { key = key }).json.items, 2)
    T.eq(T.http(mock, "GET", "/v1/devices?type=lamp", { key = key }).status, 400)
    T.eq(T.http(mock, "GET", "/v1/devices?supported=maybe", { key = key }).status, 400)
    T.eq(T.http(mock, "GET", "/v1/devices/40", { key = key }).json.name, "Front Door")
end

function tests.lights_report_state_and_capabilities()
    local mock, key = start()
    local lights = T.http(mock, "GET", "/v1/lights", { key = key }).json.items
    T.eq(#lights, 3)

    local knx = byId(lights, 20)
    T.eq(knx.on, true)
    T.eq(knx.dimmable, true)
    T.eq(knx.brightness_reported, false, "KNX dimmers do not report their level")

    local switch = byId(lights, 21)
    T.eq(switch.on, false)
    T.eq(switch.dimmable, false)
    T.truthy(isNull(switch.brightness), "on/off lights have null brightness")

    T.eq(byId(lights, 22).brightness, 40)
    T.eq(#T.http(mock, "GET", "/v1/lights?room_id=11", { key = key }).json.items, 2)
    T.eq(T.http(mock, "GET", "/v1/lights/30", { key = key }).status, 404, "a thermostat is not a light")
end

function tests.light_patch_maps_to_control4_commands()
    local mock, key = start()

    local on = T.http(mock, "PATCH", "/v1/lights/21", { key = key, body = { on = true } })
    T.eq(on.status, 202)
    T.eq(on.json.id, 21)
    T.same(lastCommand(mock), { device = 21, command = "SET_BRIGHTNESS_TARGET", params = { LIGHT_BRIGHTNESS_TARGET_PRESET_ID = 1 } })

    T.http(mock, "PATCH", "/v1/lights/21", { key = key, body = { on = false } })
    T.same(lastCommand(mock).params, { LIGHT_BRIGHTNESS_TARGET_PRESET_ID = 2 })

    T.http(mock, "PATCH", "/v1/lights/20", { key = key, body = { brightness = 60 } })
    T.same(lastCommand(mock), { device = 20, command = "RAMP_TO_LEVEL", params = { LEVEL = 60, TIME = 0 } })

    T.http(mock, "PATCH", "/v1/lights/22", { key = key, body = { on = true, brightness = 35 } })
    T.same(lastCommand(mock), { device = 22, command = "SET_BRIGHTNESS_TARGET", params = { PERCENT = 35 } })
end

function tests.light_patch_validates_input()
    local mock, key = start()
    local before = #mock.commands
    local function patch(body, options)
        options = options or {}
        options.key = key
        options.body = body
        return T.http(mock, "PATCH", options.path or "/v1/lights/22", options)
    end

    T.eq(patch({}).json.code, "INVALID_REQUEST")
    T.eq(patch({ on = "yes" }).json.code, "INVALID_FIELD")
    T.eq(patch({ brightness = 101 }).json.code, "INVALID_FIELD")
    T.eq(patch({ brightness = 12.5 }).json.code, "INVALID_FIELD")
    T.eq(patch('{"brightness": null}').json.code, "INVALID_FIELD")
    T.eq(patch({ color = "red" }).json.code, "INVALID_FIELD")
    T.eq(patch({ on = false, brightness = 20 }).json.code, "INVALID_REQUEST")
    T.eq(patch({ brightness = 20 }, { path = "/v1/lights/21" }).json.code, "NOT_SUPPORTED")
    T.eq(patch({ on = true }, { path = "/v1/lights/99" }).status, 404)
    T.eq(#mock.commands, before, "no command is sent for invalid requests")
end

function tests.thermostats_report_state_and_options()
    local mock, key = start()
    local thermostat = T.http(mock, "GET", "/v1/thermostats", { key = key }).json.items[1]
    T.eq(thermostat.id, 30)
    T.eq(thermostat.online, true)
    T.eq(thermostat.current_temperature, 26)
    T.eq(thermostat.target_temperature, 22)
    T.eq(thermostat.mode, "cool")
    T.same(thermostat.modes, { "off", "heat", "cool" })
    T.eq(thermostat.activity, "cooling")
    T.eq(thermostat.fan_speed, "low")
    T.same(thermostat.fan_speeds, { "low", "medium", "high" })
    T.eq(thermostat.target_temperature_min, 16)
    T.eq(thermostat.target_temperature_max, 32, "the range Control4 allows, for AC zones too")
end

-- An AC switched off at 32 °C (as found on the real system): the target it reports can be set.
function tests.a_thermostat_accepts_the_target_it_reports()
    local project = Mock.project()
    project.variables[30][1107] = "Off"
    project.variables[30][1149] = "89.6"
    local mock = Mock.startDriver(project)
    local key = T.pair(mock)
    local thermostat = T.http(mock, "GET", "/v1/thermostats/30", { key = key }).json
    T.eq(thermostat.target_temperature, 32)
    T.truthy(thermostat.target_temperature <= thermostat.target_temperature_max, "never outside its own range")
    for _, target in ipairs({ thermostat.target_temperature, 31, 25 }) do
        T.eq(T.http(mock, "PATCH", "/v1/thermostats/30", { key = key, body = { target_temperature = target } }).status, 202, tostring(target))
    end
end

function tests.thermostat_patch_applies_fields_in_order()
    local mock, key = start()
    local before = #mock.commands
    local response = T.http(mock, "PATCH", "/v1/thermostats/30", {
        key = key,
        body = { target_temperature = 23, fan_speed = "high", mode = "heat" },
    })
    T.eq(response.status, 202)
    T.eq(#mock.commands, before + 3)
    T.same(mock.commands[before + 1], { device = 30, command = "SET_MODE_HVAC", params = { MODE = "Heat" } })
    T.same(mock.commands[before + 2], { device = 30, command = "SET_MODE_FAN", params = { MODE = "High" } })
    T.same(mock.commands[before + 3], { device = 30, command = "SET_SETPOINT_SINGLE", params = { CELSIUS = 23 } })
end

function tests.thermostat_patch_validates_input()
    local mock, key = start()
    local before = #mock.commands
    local function patch(body)
        return T.http(mock, "PATCH", "/v1/thermostats/30", { key = key, body = body })
    end
    T.eq(patch({ mode = "auto" }).json.code, "MODE_NOT_SUPPORTED")
    T.eq(patch({ mode = "Cool" }).json.code, "INVALID_FIELD", "modes are lowercase")
    T.eq(patch({ target_temperature = 33 }).json.code, "INVALID_FIELD", "above the range")
    T.eq(patch({ target_temperature = 15 }).json.code, "INVALID_FIELD", "below the range")
    T.eq(patch({ fan_speed = "turbo" }).json.code, "INVALID_FIELD")
    T.eq(patch({ fan_speed = "auto" }).json.code, "NOT_SUPPORTED")
    T.eq(patch({ humidity = 40 }).json.code, "INVALID_FIELD")
    T.eq(#mock.commands, before, "nothing is sent when validation fails")
end

function tests.blinds_report_their_position()
    local mock, key = start()
    local blinds = T.http(mock, "GET", "/v1/blinds", { key = key }).json.items
    T.eq(#blinds, 2)
    T.eq(blinds[1].name, "Kitchen Shutter", "sorted by name")
    T.truthy(isNull(blinds[1].position), "an unknown level (-255) is null")
    T.eq(blinds[1].position_reported, true)
    T.eq(byId(blinds, 50).position, 40)
    T.eq(byId(blinds, 50).room.name, "Living Room")
    T.eq(#T.http(mock, "GET", "/v1/blinds?room_id=11", { key = key }).json.items, 1)
    T.eq(T.http(mock, "GET", "/v1/blinds/20", { key = key }).status, 404, "a light is not a blind")

    OnWatchedVariableChanged(51, 1000, "75")
    T.eq(T.http(mock, "GET", "/v1/blinds/51", { key = key }).json.position, 75)
    OnWatchedVariableChanged(51, 1000, "-255")
    T.truthy(isNull(T.http(mock, "GET", "/v1/blinds/51", { key = key }).json.position))
end

function tests.blind_commands_use_the_blind_proxy()
    local mock, key = start()
    local response = T.http(mock, "PATCH", "/v1/blinds/50", { key = key, body = { position = 100 } })
    T.eq(response.status, 202)
    T.eq(response.json.id, 50)
    T.same(lastCommand(mock), { device = 50, command = "SET_LEVEL_TARGET", params = { LEVEL_TARGET = 100 } })

    T.http(mock, "PATCH", "/v1/blinds/51", { key = key, body = { position = 30 } })
    T.same(lastCommand(mock), { device = 51, command = "SET_LEVEL_TARGET", params = { LEVEL_TARGET = 30 } })

    T.eq(T.http(mock, "POST", "/v1/blinds/50/stop", { key = key }).status, 202)
    T.same(lastCommand(mock), { device = 50, command = "STOP", params = {} })
end

function tests.blind_patch_validates_input()
    local mock, key = start()
    local before = #mock.commands
    local function patch(body, path)
        return T.http(mock, "PATCH", path or "/v1/blinds/50", { key = key, body = body })
    end
    T.eq(patch({}).json.code, "INVALID_REQUEST")
    T.eq(patch({ position = 101 }).json.code, "INVALID_FIELD")
    T.eq(patch({ position = 50.5 }).json.code, "INVALID_FIELD")
    T.eq(patch({ position = "open" }).json.code, "INVALID_FIELD")
    T.eq(patch({ open = true }).json.code, "INVALID_FIELD")
    T.eq(patch({ position = 0 }, "/v1/blinds/99").status, 404)
    T.eq(T.http(mock, "POST", "/v1/blinds/99/stop", { key = key }).status, 404)
    T.eq(#mock.commands, before, "no command is sent for invalid requests")
end

function tests.cameras_are_listed_without_secrets()
    local mock, key = start()
    local cameras = T.http(mock, "GET", "/v1/cameras", { key = key }).json.items
    T.eq(#cameras, 3)
    T.eq(cameras[1].name, "Driveway")
    T.eq(cameras[1].room.name, "Kitchen")
    T.eq(cameras[1].snapshot_href, "/v1/cameras/60/snapshot")
    T.eq(#T.http(mock, "GET", "/v1/cameras?room_id=11", { key = key }).json.items, 1)
    T.eq(T.http(mock, "GET", "/v1/cameras/61", { key = key }).json.name, "Gate")
    T.eq(T.http(mock, "GET", "/v1/cameras/20", { key = key }).status, 404, "a light is not a camera")

    local raw = T.http(mock, "GET", "/v1/cameras", { key = key }).body
    T.truthy(not raw:find("s3cret", 1, true) and not raw:find("192.0.2.21", 1, true), "no camera login or address in the API")
end

function tests.snapshot_with_digest_login()
    local mock, key = start()
    local response = T.http(mock, "GET", "/v1/cameras/60/snapshot?width=1280", { key = key })
    T.eq(response.status, 200)
    T.eq(response.headers["content-type"], "image/jpeg")
    T.eq(response.headers["cache-control"], "no-store")
    T.truthy(response.body:find("^\255\216"), "JPEG bytes passed through")
    T.eq(#mock.urlRequests, 2, "challenge, then the digest answer")
    T.eq(mock.urlRequests[1].url, "http://192.0.2.21/ISAPI/Streaming/channels/101/picture?snapShotImageType=JPEG&size=1280x720")
    T.truthy(mock.urlRequests[2].headers.Authorization:find('^Digest username="admin"'))

    for _, entry in ipairs(mock.debugLog) do
        T.truthy(not entry:find("s3cret", 1, true), "the camera password is never logged")
    end
end

function tests.snapshot_with_basic_login_and_port()
    local mock, key = start()
    local response = T.http(mock, "GET", "/v1/cameras/61/snapshot", { key = key })
    T.eq(response.status, 200)
    T.eq(#mock.urlRequests, 1)
    T.eq(mock.urlRequests[1].url, "http://192.0.2.22:8080/bha-api/image.cgi")
    T.eq(mock.urlRequests[1].headers.Authorization, "Basic dXNlcjpkb29y")
end

function tests.snapshot_failures_are_problems()
    local mock, key = start()
    T.eq(T.http(mock, "GET", "/v1/cameras/60/snapshot?width=500", { key = key }).json.code, "INVALID_PARAMETER")
    T.eq(T.http(mock, "GET", "/v1/cameras/99/snapshot", { key = key }).status, 404)
    T.eq(T.http(mock, "GET", "/v1/cameras/60/snapshot").status, 401)

    mock.camerasOffline = true
    local offline = T.http(mock, "GET", "/v1/cameras/60/snapshot", { key = key })
    T.eq(offline.status, 502)
    T.eq(offline.json.code, "CAMERA_UNREACHABLE")

    local project = Mock.project()
    project.cameras[60].camera_password = "changed on the camera"
    local rejected = Mock.startDriver(project)
    local login = T.http(rejected, "GET", "/v1/cameras/60/snapshot", { key = T.pair(rejected) })
    T.eq(login.status, 502)
    T.eq(login.json.code, "CAMERA_LOGIN_FAILED")
end

function tests.relays_report_state_from_device_events()
    local mock, key = start()
    local relayEvents = {}
    for _, watched in ipairs(mock.deviceEvents) do
        if watched[1] == 70 then
            relayEvents[#relayEvents + 1] = watched
        end
    end
    T.same(relayEvents, { { 70, 3 }, { 70, 4 } }, "relay 1 opened and closed events are watched")
    local relays = T.http(mock, "GET", "/v1/relays", { key = key }).json.items
    T.eq(#relays, 1)
    T.eq(relays[1].name, "Main Door")
    T.truthy(isNull(relays[1].state), "unknown until the relay reports")
    T.eq(relays[1].state_reported, true)

    OnDeviceEvent(70, 4)
    T.eq(T.http(mock, "GET", "/v1/relays/70", { key = key }).json.state, "closed")
    OnDeviceEvent(70, 3)
    T.eq(T.http(mock, "GET", "/v1/relays/70", { key = key }).json.state, "open")
    OnDeviceEvent(70, 105)
    T.eq(T.http(mock, "GET", "/v1/relays/70", { key = key }).json.state, "open", "contact events are ignored")
    T.eq(T.http(mock, "GET", "/v1/relays/20", { key = key }).status, 404, "a light is not a relay")
end

function tests.relay_pulse_closes_then_opens()
    local mock, key = start()
    Properties["Door Control"] = "Enabled"
    local before = #mock.commands
    local response = T.http(mock, "POST", "/v1/relays/70/pulse", { key = key })
    T.eq(response.status, 202)
    T.eq(#mock.commands, before + 1)
    T.same(mock.commands[#mock.commands], { device = 70, command = "Close Relay", params = { Relay = "1" } })
    local pulse = mock.timers[#mock.timers]
    T.eq(pulse.delay, 500)
    pulse.callback()
    T.same(mock.commands[#mock.commands], { device = 70, command = "Open Relay", params = { Relay = "1" } })
end

-- DriverWorks cancels a timer whose object is garbage-collected: a pulse keeps its release timer
-- until it fires, or a door relay could stay closed, which holds the door open.
function tests.a_pulse_keeps_its_release_timer_until_it_fires()
    local mock, key = start()
    Properties["Door Control"] = "Enabled"
    local realSetTimer = C4.SetTimer
    local live = setmetatable({}, { __mode = "k" }) -- timer object -> its callback, gone when collected
    C4.SetTimer = function(_, delay, callback)
        local timer = { Cancel = function() end }
        live[timer] = { delay = delay, callback = callback }
        return timer
    end
    local ok, err = pcall(function()
        T.eq(T.http(mock, "POST", "/v1/relays/70/pulse", { key = key }).status, 202)
        T.eq(lastCommand(mock).command, "Close Relay")
        collectgarbage("collect")
        collectgarbage("collect")
        local releases = {}
        for _, entry in pairs(live) do
            if entry.delay == 500 then
                releases[#releases + 1] = entry.callback
            end
        end
        T.eq(#releases, 1, "the release timer was collected before it fired")
        releases[1]()
        T.same(lastCommand(mock), { device = 70, command = "Open Relay", params = { Relay = "1" } })
    end)
    C4.SetTimer = realSetTimer
    if not ok then
        error(err, 0)
    end
end

function tests.relay_state_can_be_set_and_is_validated()
    local mock, key = start()
    Properties["Door Control"] = "Enabled"
    -- Holding a relay closed needs Relay Hold (1.1.1); allowed, it works as before.
    Properties["Relay Hold"] = "Allowed"
    T.eq(T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = "closed" } }).status, 202)
    T.same(mock.commands[#mock.commands], { device = 70, command = "Close Relay", params = { Relay = "1" } })
    T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = "open" } })
    T.eq(mock.commands[#mock.commands].command, "Open Relay")
    local before = #mock.commands
    T.eq(T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = "unlocked" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = {} }).json.code, "INVALID_REQUEST")
    T.eq(T.http(mock, "POST", "/v1/relays/99/pulse", { key = key }).status, 404)
    T.eq(T.http(mock, "POST", "/v1/relays/70/pulse").status, 401)
    T.eq(#mock.commands, before, "nothing is sent for invalid requests")
end

function tests.rooms_have_names_per_language()
    local mock, key = start()
    local room = T.http(mock, "GET", "/v1/rooms/10", { key = key }).json
    T.eq(room.name, "Kitchen")
    T.same(room.names, {})

    local updated = T.http(mock, "PATCH", "/v1/rooms/10", { key = key, body = { names = { en = "Kitchen", he = " מטבח " } } })
    T.eq(updated.status, 200)
    T.same(updated.json.names, { en = "Kitchen", he = "מטבח" }, "names are trimmed")
    T.eq(byId(T.http(mock, "GET", "/v1/lights", { key = key }).json.items, 20).room.names.he, "מטבח", "room references carry the names")

    T.same(T.http(mock, "PATCH", "/v1/rooms/10", { key = key, body = { names = { en = "" } } }).json.names, { he = "מטבח" }, "an empty name removes a language")

    T.eq(T.http(mock, "PATCH", "/v1/rooms/10", { key = key, body = { names = { english = "x" } } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "PATCH", "/v1/rooms/10", { key = key, body = { names = { en = 5 } } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "PATCH", "/v1/rooms/10", { key = key, body = { names = "Kitchen" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "PATCH", "/v1/rooms/10", { key = key, body = { name = "x" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "PATCH", "/v1/rooms/999", { key = key, body = { names = { en = "x" } } }).status, 404)

    -- Names survive a driver update.
    local updated = Mock.updateDriver(mock)
    T.same(T.http(updated, "GET", "/v1/rooms/10", { key = key }).json.names, { he = "מטבח" })
end

function tests.doors_stay_shut_until_door_control_is_enabled()
    local mock, key = start()
    local before = #mock.commands
    local refused = T.http(mock, "POST", "/v1/relays/70/pulse", { key = key })
    T.eq(refused.status, 403)
    T.eq(refused.json.code, "DOOR_CONTROL_DISABLED")
    T.eq(T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = "closed" } }).json.code, "DOOR_CONTROL_DISABLED")
    T.eq(#mock.commands, before, "nothing reaches the relay")
    Properties["Door Control"] = "Enabled"
    T.eq(T.http(mock, "POST", "/v1/relays/70/pulse", { key = key }).status, 202)
end

local function keyWithRole(mock, adminKey, role)
    local created = T.http(mock, "POST", "/v1/api-keys", { key = adminKey, body = { name = role .. " key", role = role } })
    T.eq(created.status, 201)
    T.eq(created.json.role, role)
    return created.json.key, created.json.id
end

function tests.roles_limit_what_a_key_can_do()
    local mock, admin = start()
    Properties["Door Control"] = "Enabled"
    local viewer = keyWithRole(mock, admin, "viewer")
    local member = keyWithRole(mock, admin, "member")
    local doors = keyWithRole(mock, admin, "doors")

    local function status(method, path, key, body)
        return T.http(mock, method, path, { key = key, body = body }).status
    end

    -- viewer: read only
    T.eq(status("GET", "/v1/lights", viewer), 200)
    T.eq(status("GET", "/v1/cameras/60/snapshot", viewer), 200)
    local forbidden = T.http(mock, "PATCH", "/v1/lights/21", { key = viewer, body = { on = true } })
    T.eq(forbidden.status, 403)
    T.eq(forbidden.json.code, "FORBIDDEN")
    T.eq(forbidden.json.role, "viewer")
    T.eq(forbidden.json.required_role, "member")
    -- member: control, no doors, no admin
    T.eq(status("PATCH", "/v1/lights/21", member, { on = true }), 202)
    T.eq(status("POST", "/v1/blinds/50/stop", member), 202)
    T.eq(status("POST", "/v1/relays/70/pulse", member), 403)
    T.eq(status("GET", "/v1/api-keys", member), 403)
    T.eq(status("GET", "/v1/logs", member), 403)
    T.eq(status("PATCH", "/v1/rooms/10", member, { names = { en = "x" } }), 403)
    -- doors: can open doors, still no admin
    T.eq(status("POST", "/v1/relays/70/pulse", doors), 202)
    T.eq(status("POST", "/v1/api-keys", doors, { name = "sneaky", role = "admin" }), 403)
    -- every key can see its own role
    local me = T.http(mock, "GET", "/v1/api-keys/current", { key = viewer }).json
    T.eq(me.role, "viewer")
    T.eq(me.current, true)
    T.eq(me.key, nil, "the secret is never shown again")
    -- any key may revoke itself, but not others
    T.eq(status("DELETE", "/v1/api-keys/current", viewer), 204)
    T.eq(status("GET", "/v1/lights", viewer), 401)
    T.eq(status("GET", "/v1/lights", member), 200)
end

-- A door or gate opens while its relay is closed, so a relay held closed holds it open until
-- someone sends "open". The app and scenes only pulse; PATCH {"state": "closed"} is refused and
-- nothing is sent, unless an installer sets Relay Hold to Allowed in Composer (1.1.1, ADR-036).
function tests.a_relay_is_not_held_closed_unless_relay_hold_is_allowed()
    local mock, key = start()
    Properties["Door Control"] = "Enabled"
    local before = #mock.commands
    local refused = T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = "closed" } })
    T.eq(refused.status, 409)
    T.eq(refused.headers["content-type"], "application/problem+json")
    T.eq(refused.json.code, "HOLD_NOT_ALLOWED")
    T.contains(refused.json.detail, "use pulse")
    T.contains(refused.json.detail, "Relay Hold")
    Properties["Relay Hold"] = "Not allowed"
    T.eq(T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = "closed" } }).json.code, "HOLD_NOT_ALLOWED", "Composer's default")
    T.eq(#mock.commands, before, "nothing reaches the relay")
end

-- Releasing a relay (the safe state) and pulsing it need no Relay Hold. The key's role and Door
-- Control still come first, for holding too.
function tests.without_relay_hold_relays_still_open_and_pulse()
    local mock, admin = start()
    local member = keyWithRole(mock, admin, "member")
    local doors = keyWithRole(mock, admin, "doors")
    Properties["Relay Hold"] = "Not allowed"
    local function patch(key, state)
        return T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = state } })
    end

    T.eq(patch(doors, "closed").json.code, "DOOR_CONTROL_DISABLED")
    T.eq(patch(doors, "open").json.code, "DOOR_CONTROL_DISABLED")
    Properties["Door Control"] = "Enabled"
    T.eq(patch(member, "closed").json.code, "FORBIDDEN")
    T.eq(patch(member, "open").json.code, "FORBIDDEN")

    local released = patch(doors, "open")
    T.eq(released.status, 202)
    T.eq(released.json.id, 70)
    T.same(lastCommand(mock), { device = 70, command = "Open Relay", params = { Relay = "1" } })
    T.eq(T.http(mock, "POST", "/v1/relays/70/pulse", { key = doors }).status, 202)
    T.same(lastCommand(mock), { device = 70, command = "Close Relay", params = { Relay = "1" } })
    local pulse = mock.timers[#mock.timers]
    T.eq(pulse.delay, 500)
    pulse.callback()
    T.same(lastCommand(mock), { device = 70, command = "Open Relay", params = { Relay = "1" } }, "released after the pulse")

    local before = #mock.commands
    T.eq(patch(doors, "closed").json.code, "HOLD_NOT_ALLOWED", "only holding is refused")
    T.eq(patch(admin, "closed").json.code, "HOLD_NOT_ALLOWED", "for admin keys too")
    T.eq(#mock.commands, before)
end

-- Relay Hold is read at each request, like Door Control: a change in Composer applies at once and
-- is logged. Allowed, a relay is held closed as in 1.1.0, until "open".
function tests.relay_hold_changed_in_composer_applies_at_once()
    local mock, key = start()
    Properties["Door Control"] = "Enabled"
    Properties["Relay Hold"] = "Not allowed"
    local function hold()
        return T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = "closed" } })
    end
    T.eq(hold().status, 409)

    Properties["Relay Hold"] = "Allowed"
    OnPropertyChanged("Relay Hold")
    local timers = #mock.timers
    local held = hold()
    T.eq(held.status, 202)
    T.eq(held.json.id, 70)
    T.same(lastCommand(mock), { device = 70, command = "Close Relay", params = { Relay = "1" } })
    T.eq(#mock.timers, timers, "held, not pulsed: nothing releases it")
    OnDeviceEvent(70, 4)
    T.eq(T.http(mock, "GET", "/v1/relays/70", { key = key }).json.state, "closed")
    T.eq(T.http(mock, "PATCH", "/v1/relays/70", { key = key, body = { state = "open" } }).status, 202)
    T.same(lastCommand(mock), { device = 70, command = "Open Relay", params = { Relay = "1" } })

    Properties["Relay Hold"] = "Not allowed"
    OnPropertyChanged("Relay Hold")
    local before = #mock.commands
    T.eq(hold().json.code, "HOLD_NOT_ALLOWED", "not allowed again")
    T.eq(#mock.commands, before)

    local messages = {}
    for _, entry in ipairs(T.http(mock, "GET", "/v1/logs?category=relay_command", { key = key }).json.items) do
        messages[#messages + 1] = entry.message
    end
    T.contains(table.concat(messages, "\n"), "relay hold allowed in Composer")
    T.contains(table.concat(messages, "\n"), "relay hold not allowed in Composer")
end

function tests.admins_change_roles_but_keep_one_admin()
    local mock, admin = start()
    local adminId = T.http(mock, "GET", "/v1/api-keys/current", { key = admin }).json.id
    local _, memberId = keyWithRole(mock, admin, "member")

    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. memberId, { key = admin, body = { role = "doors" } }).json.role, "doors")
    local renamed = T.http(mock, "PATCH", "/v1/api-keys/" .. memberId, { key = admin, body = { name = "Kitchen tablet" } })
    T.eq(renamed.json.name, "Kitchen tablet")
    T.eq(renamed.json.role, "doors")

    local last = T.http(mock, "PATCH", "/v1/api-keys/" .. adminId, { key = admin, body = { role = "member" } })
    T.eq(last.status, 409)
    T.eq(last.json.code, "LAST_ADMIN")
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. memberId, { key = admin, body = { role = "owner" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. memberId, { key = admin, body = {} }).json.code, "INVALID_REQUEST")
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/deadbeef", { key = admin, body = { role = "viewer" } }).status, 404)
    T.eq(T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = "x", role = "root" } }).json.code, "INVALID_FIELD")
    T.eq(T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = "default role" } }).json.role, "member")

    -- With a second admin the first may step down.
    T.http(mock, "PATCH", "/v1/api-keys/" .. memberId, { key = admin, body = { role = "admin" } })
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. adminId, { key = admin, body = { role = "member" } }).json.role, "member")
end

function tests.keys_in_the_old_encrypted_store_are_moved_to_hashes()
    -- Up to 0.9.0 the keys themselves were stored encrypted. If Director can still read them they
    -- are moved, and keys from before roles existed keep full access.
    local mock = Mock.startDriver(nil, nil, "DIT_UPDATING", function(fresh)
        fresh.persist["directorlink_api_keys"] = '{"version":1,"keys":[{"id":"0a1b2c3d","name":"Old laptop","secret":"ak_old","created_at":"2026-09-26T10:00:00Z"}]}'
        fresh.persistEncrypted["directorlink_api_keys"] = true
    end)
    local me = T.http(mock, "GET", "/v1/api-keys/current", { key = "ak_old" })
    T.eq(me.status, 200)
    T.eq(me.json.role, "admin")
    T.eq(me.json.name, "Old laptop")
    T.eq(mock.properties["Pairing Code"], "-", "no pairing code opens when the keys were kept")
    T.notContains(mock.persist["directorlink_api_keys"], "ak_old", "the old store no longer holds the keys")
    T.notContains(mock.persist["directorlink_api_key_hashes"], "ak_old")

    local updated = Mock.updateDriver(mock)
    T.eq(T.http(updated, "GET", "/v1/api-keys/current", { key = "ak_old" }).status, 200, "and they survive the next update")
end

function tests.keys_stored_by_0_9_1_as_plain_json_are_still_read()
    -- 0.9.1 stored plain JSON, which Director hands back decoded.
    local hash = hex(sha256("ak_phone"))
    local mock = Mock.startDriver(nil, nil, "DIT_UPDATING", function(fresh)
        fresh.persist["directorlink_api_key_hashes"] = '{"keys":[{"alg":"sha256","created_at":"2026-09-27T15:00:42Z","hash":"'
            .. hash .. '","id":"4fde46cc","name":"Chrome on Windows","role":"admin"}],"version":3}'
    end)
    T.eq(T.http(mock, "GET", "/v1/api-keys/current", { key = "ak_phone" }).json.id, "4fde46cc")
    T.eq(mock.properties["Pairing Code"], "-")
    T.eq(mock.persist["directorlink_api_key_hashes"]:sub(1, 5), "json:", "and it is stored the current way")
    T.contains(table.concat(mock.debugLog, "\n"), '"stored_as":"table"', "the log says how the keys came back")
end

function tests.a_new_driver_has_no_keys_and_opens_pairing()
    local mock = Mock.startDriver()
    T.eq(mock.properties["API Keys"], "0")
    T.truthy(mock.properties["Pairing Code"]:match("^%d%d%d%d %d%d%d%d$"), "a pairing code is shown")
    T.eq(mock.persist["directorlink_api_keys"], nil, "no old store is created")
    T.contains(table.concat(mock.debugLog, "\n"), '"old_store":"missing"')
end

function tests.access_requests_are_gone()
    local mock = start()
    T.eq(T.http(mock, "POST", "/v1/auth/requests", { body = { name = "Phone" } }).status, 404)
    T.eq(mock.properties["Access Request"], nil)
end

function tests.doorbells_are_listed_with_their_camera()
    local mock, key = start()
    local doorbells = T.http(mock, "GET", "/v1/doorbells", { key = key }).json.items
    T.eq(#doorbells, 1)
    local bell = doorbells[1]
    T.eq(bell.id, 93)
    T.eq(bell.name, "Front Gate")
    T.eq(bell.room.name, "Kitchen")
    T.same(bell.camera, { id = 92, snapshot_href = "/v1/cameras/92/snapshot" })
    T.eq(bell.can_open, true)
    T.truthy(isNull(bell.connected) and isNull(bell.last_ring_at), "nothing known before the first event")
    T.eq(#bell.events, 0)
    T.eq(T.http(mock, "GET", "/v1/cameras/92/snapshot", { key = key }).status, 200, "its camera works like any camera")
    T.eq(T.http(mock, "GET", "/v1/doorbells/92", { key = key }).status, 404, "a camera is not a doorbell")
    local watched = {}
    for _, event in ipairs(mock.deviceEvents) do
        if event[1] == 110 then
            watched[#watched + 1] = event[2]
        end
    end
    table.sort(watched)
    T.same(watched, { 100, 102, 103, 104, 106 }, "DoorBird's events are watched on its driver")
end

function tests.doorbird_events_update_the_doorbell()
    local mock, key = start()
    OnDeviceEvent(110, 103)
    OnDeviceEvent(110, 102)
    local bell = T.http(mock, "GET", "/v1/doorbells/93", { key = key }).json
    T.truthy(bell.last_ring_at:match("^%d%d%d%d%-%d%d%-%d%dT"), "ring time")
    T.truthy(bell.last_motion_at, "motion time")
    T.eq(bell.connected, true)
    T.eq(bell.events[1].type, "doorbell", "newest first")
    T.eq(bell.events[2].type, "motion")

    OnDeviceEvent(110, 104)
    OnDeviceEvent(110, 106)
    OnDeviceEvent(110, 999)
    bell = T.http(mock, "GET", "/v1/doorbells/93", { key = key }).json
    T.truthy(bell.last_opened_at and bell.last_access_at, "gate opened and keypad access")
    T.eq(#bell.events, 4, "unknown events are ignored")

    OnDeviceEvent(110, 100)
    T.eq(T.http(mock, "GET", "/v1/doorbells/93", { key = key }).json.connected, false)
    for _ = 1, 30 do
        OnDeviceEvent(110, 103)
    end
    T.eq(#T.http(mock, "GET", "/v1/doorbells/93", { key = key }).json.events, 20, "the last 20 events are kept")
end

function tests.opening_presses_the_doorbird_button()
    local mock, admin = start()
    local refused = T.http(mock, "POST", "/v1/doorbells/93/open", { key = admin })
    T.eq(refused.status, 403)
    T.eq(refused.json.code, "DOOR_CONTROL_DISABLED")
    Properties["Door Control"] = "Enabled"

    local member = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = "Phone", role = "member" } }).json.key
    T.eq(T.http(mock, "POST", "/v1/doorbells/93/open", { key = member }).json.required_role, "doors")

    local before = #mock.commands
    local opened = T.http(mock, "POST", "/v1/doorbells/93/open", { key = admin })
    T.eq(opened.status, 202)
    T.eq(#mock.commands, before + 1)
    T.same(mock.commands[#mock.commands], { device = 90, command = "SELECT", params = {} }, "the DoorBird button, as the Control4 app presses it")
    T.eq(T.http(mock, "POST", "/v1/doorbells/99/open", { key = admin }).status, 404)
end

function tests.api_keys_can_be_listed_created_and_revoked()
    local mock, key = start()
    local list = T.http(mock, "GET", "/v1/api-keys", { key = key }).json.items
    T.eq(#list, 1)
    T.eq(list[1].current, true)
    T.eq(list[1].key, nil, "secrets are never listed")
    T.truthy(type(list[1].last_used_at) == "string", "last use is tracked")

    local created = T.http(mock, "POST", "/v1/api-keys", { key = key, body = { name = "Home Assistant" } })
    T.eq(created.status, 201)
    T.eq(created.json.current, false)
    T.eq(T.http(mock, "GET", "/v1/lights", { key = created.json.key }).status, 200)
    T.eq(T.http(mock, "POST", "/v1/api-keys", { key = key, body = {} }).json.code, "INVALID_FIELD")

    T.eq(T.http(mock, "DELETE", "/v1/api-keys/" .. created.json.id, { key = key }).status, 204)
    T.eq(T.http(mock, "GET", "/v1/lights", { key = created.json.key }).status, 401, "revoked keys stop working")
    T.eq(T.http(mock, "DELETE", "/v1/api-keys/deadbeef", { key = key }).status, 404)
    T.eq(mock.properties["API Keys"], "1")
end

-- A value as the driver stored it: "json:" plus JSON.
local function stored(mock, name)
    local value = mock.persist[name]
    T.eq(value:sub(1, 5), "json:", name .. " is stored with its prefix")
    return Json.decode(value:sub(6))
end

function tests.keys_survive_a_driver_update_and_only_hashes_are_stored()
    local mock, key = start()
    T.eq(mock.persistEncrypted["directorlink_api_key_hashes"], false)
    T.notContains(mock.persist["directorlink_api_key_hashes"], key:sub(4), "the key itself is never stored")
    local record = stored(mock, "directorlink_api_key_hashes").keys[1]
    T.eq(record.alg, "sha256")
    T.eq(record.hash, hex(sha256(key)))
    T.eq(record.secret, nil)

    local updated = Mock.updateDriver(mock)
    T.eq(T.http(updated, "GET", "/v1/system", { key = key }).status, 200, "the key still works after an update")
    T.eq(updated.properties["API Keys"], "1")
    T.eq(updated.properties["Pairing Code"], "-", "no pairing code opens")
    T.eq(T.http(updated, "GET", "/v1/system", { key = key .. "0" }).status, 401)
    T.eq(T.http(updated, "GET", "/v1/system", { key = string.rep("a", 4096) }).status, 401)
end

function tests.keys_are_hashed_with_sha1_when_sha256_is_missing()
    local mock = Mock.startDriver()
    local hash = C4.Hash
    function C4:Hash(algorithm, data, options)
        assert(algorithm ~= "SHA256", "unsupported digest")
        return hash(self, algorithm, data, options)
    end
    local key = T.pair(mock)
    T.eq(stored(mock, "directorlink_api_key_hashes").keys[1].alg, "sha1")
    T.eq(T.http(mock, "GET", "/v1/system", { key = key }).status, 200)
    T.eq(T.http(Mock.updateDriver(mock), "GET", "/v1/system", { key = key }).status, 200)
end

function tests.composer_action_revokes_all_keys()
    local mock, key = start()
    ExecuteCommand("LUA_ACTION", { ACTION = "REVOKE_API_KEYS" })
    T.eq(T.http(mock, "GET", "/v1/system", { key = key }).status, 401)
    T.eq(mock.properties["API Keys"], "0")

    local code = mock.properties["Pairing Code"]
    ExecuteCommand("LUA_ACTION", { ACTION = "NEW_PAIRING_CODE" })
    T.truthy(mock.properties["Pairing Code"] ~= code, "new pairing code on request")
end

function tests.logs_record_requests_and_filter()
    local mock, key = start()
    T.http(mock, "PATCH", "/v1/logs/settings", { key = key, body = { level = "debug" } })
    T.eq(mock.properties["Log Level"], "Debug", "Composer property follows the API")
    T.http(mock, "GET", "/v1/rooms", { key = key })
    T.http(mock, "GET", "/v1/nope", { key = key })

    local logs = T.http(mock, "GET", "/v1/logs?category=api", { key = key }).json
    T.eq(logs.level, "debug")
    local messages = {}
    for _, entry in ipairs(logs.items) do
        messages[#messages + 1] = entry.message
        T.eq(entry.category, "api")
    end
    local joined = table.concat(messages, "\n")
    T.contains(joined, "GET /v1/rooms -> 200")
    T.contains(joined, "GET /v1/nope -> 404")

    local newer = T.http(mock, "GET", "/v1/logs?after=" .. logs.last_seq, { key = key }).json
    T.truthy(#newer.items <= 1, "only entries after last_seq")
    local warnings = T.http(mock, "GET", "/v1/logs?level=warn", { key = key }).json.items
    for _, entry in ipairs(warnings) do
        T.truthy(entry.level == "warn" or entry.level == "error", "level filter")
    end

    T.eq(T.http(mock, "GET", "/v1/logs?level=loud", { key = key }).status, 400)
    T.eq(T.http(mock, "GET", "/v1/logs?limit=0", { key = key }).status, 400)
    T.eq(T.http(mock, "PATCH", "/v1/logs/settings", { key = key, body = { level = "verbose" } }).status, 400)
end

function tests.secrets_never_reach_the_log()
    local mock = Mock.startDriver()
    local code = mock.properties["Pairing Code"]
    local key = T.pair(mock)
    T.http(mock, "GET", "/v1/system", { key = key })
    local everything = table.concat(mock.debugLog, "\n")
    T.notContains(everything, key, "API key in driver log")
    T.notContains(everything, code, "pairing code in driver log")
end

-- Director may report DirectorLink's own property updates back to OnPropertyChanged: the pairing
-- code among them is neither acted on nor logged, as typed or as shown.
function tests.the_pairing_code_reported_back_by_director_is_never_logged()
    local mock = Mock.startDriver()
    require("src.core.log").setLevel("debug")
    local code = mock.properties["Pairing Code"]
    for _, name in ipairs({ "Pairing Code", "Pairing Status", "Status", "API Keys" }) do
        -- As Director holds them once DirectorLink updated them.
        Properties[name] = mock.properties[name]
        OnPropertyChanged(name)
    end
    local key = T.pair(mock)
    local entries = T.http(mock, "GET", "/v1/logs?level=debug&limit=500", { key = key }).json.items
    local everything = table.concat(mock.debugLog, "\n") .. Json.encode(entries)
    T.notContains(everything, code, "pairing code in the log")
    T.notContains(everything, (code:gsub("%s", "")), "pairing code as typed in the log")
end

function tests.cors_allows_the_app_and_console_and_rejects_other_origins()
    local mock, key = start()
    local preflight = T.http(mock, "OPTIONS", "/v1/lights/20", { headers = { Origin = "https://app.directorlink.io" } })
    T.eq(preflight.status, 204)
    T.eq(preflight.headers["access-control-allow-origin"], "https://app.directorlink.io")
    T.contains(preflight.headers["access-control-allow-methods"], "PATCH")
    T.eq(preflight.headers["access-control-allow-private-network"], "true")

    local fromApp = T.http(mock, "GET", "/v1/lights", { key = key, headers = { Origin = "https://app.directorlink.io" } })
    T.eq(fromApp.headers["access-control-allow-origin"], "https://app.directorlink.io")
    T.eq(fromApp.headers["access-control-expose-headers"], "Retry-After")
    local fromConsole = T.http(mock, "GET", "/v1/lights", { key = key, headers = { Origin = "https://console.directorlink.io" } })
    T.eq(fromConsole.headers["access-control-allow-origin"], "https://console.directorlink.io")
    T.eq(T.http(mock, "GET", "/v1/lights", { key = key, headers = { Origin = "https://app.c4bridge.io" } }).status, 403,
        "the old app is retired")
    T.eq(T.http(mock, "GET", "/v1/lights", { key = key, headers = { Origin = "http://localhost:8080" } }).status, 403,
        "a page on the same computer is not the app")
    T.eq(T.http(mock, "GET", "/v1/lights", { key = key, headers = { Origin = "http://127.0.0.1:5500" } }).status, 403)

    local evil = T.http(mock, "GET", "/v1/lights", { key = key, headers = { Origin = "https://evil.example" } })
    T.eq(evil.status, 403)
    T.eq(evil.json.code, "ORIGIN_NOT_ALLOWED")
    T.eq(evil.headers["access-control-allow-origin"], nil)
end

function tests.only_the_controllers_address_is_accepted_as_host()
    local mock, key = start()
    for _, host in ipairs({ "192.168.1.10:41999", "director.local:41999", "core1-000fff123456:41999", "[fe80::1]:41999", "controller.home.arpa",
        "Director.Local.:41999", "[::ffff:192.168.1.5]:41999", "[fe80::1%25eth0]", "my_controller.lan" }) do
        T.eq(T.http(mock, "GET", "/v1/health", { host = host }).status, 200, host)
    end
    -- DNS rebinding: a public name made to point at the controller.
    local rebound = T.http(mock, "GET", "/v1/health", { host = "evil.example:41999" })
    T.eq(rebound.status, 421)
    T.eq(rebound.json.code, "MISDIRECTED_REQUEST")
    T.eq(T.http(mock, "GET", "/v1/lights", { key = key, host = "attacker.com" }).status, 421)
    for _, host in ipairs({ "evil.com.", "1.2.3.4.nip.io", "director.local..", "[evil.com]", "user@director.local", "controller.myhome.net" }) do
        T.eq(T.http(mock, "GET", "/v1/health", { host = host }).status, 421, host)
    end
end

-- The app's Find my controller asks GET /v1/health, without a key, at the addresses homes use
-- most: the Host is whichever address it tried, and the page is the app.
function tests.find_my_controller_health_answers_the_app_at_any_lan_address()
    local mock = Mock.startDriver()
    local app = "https://app.directorlink.io"
    for _, host in ipairs({ "192.168.1.201:41999", "192.168.0.7:41999", "10.0.0.5:41999", "172.16.0.9:41999", "192.168.50.20:41999" }) do
        local health = T.http(mock, "GET", "/v1/health", { host = host, headers = { Origin = app } })
        T.eq(health.status, 200, host)
        T.eq(health.headers["access-control-allow-origin"], app, host)
        T.eq(health.json.product, "directorlink", host)
        T.eq(type(health.json.version), "string", host)
    end
    -- Chromium before Local Network Access asks first (a Private Network Access preflight).
    local preflight = T.http(mock, "OPTIONS", "/v1/health", { host = "10.0.0.5:41999", headers = {
        Origin = app, ["Access-Control-Request-Method"] = "GET", ["Access-Control-Request-Private-Network"] = "true" } })
    T.eq(preflight.status, 204)
    T.eq(preflight.headers["access-control-allow-origin"], app)
    T.eq(preflight.headers["access-control-allow-private-network"], "true")
end

function tests.unknown_routes_and_methods()
    local mock, key = start()
    T.eq(T.http(mock, "GET", "/v1/unknown", { key = key }).json.code, "NOT_FOUND")
    local wrongMethod = T.http(mock, "DELETE", "/v1/lights/20", { key = key })
    T.eq(wrongMethod.status, 405)
    T.eq(wrongMethod.headers["allow"], "GET, PATCH")
end

function tests.requests_can_arrive_in_small_chunks()
    local mock, key = start()
    local get = T.http(mock, "GET", "/v1/lights/22", { key = key, chunkSize = 7 })
    T.eq(get.status, 200)
    T.eq(get.json.name, "Desk Lamp")
    local patch = T.http(mock, "PATCH", "/v1/lights/22", { key = key, body = { brightness = 70 }, chunkSize = 5 })
    T.eq(patch.status, 202)
    T.same(lastCommand(mock).params, { PERCENT = 70 })
end

function tests.malformed_http_gets_a_problem_response()
    local mock = Mock.startDriver()
    OnServerDataIn(900, "NONSENSE\r\n\r\n", "192.168.1.50", "1")
    T.contains(mock.sent[900], "HTTP/1.1 400 Bad Request")
    T.contains(mock.sent[900], "application/problem+json")
    T.truthy(mock.closed[900], "connection closed")
end

function tests.unsupported_controller_os_disables_the_api()
    local project = Mock.project()
    project.osVersion = "3.2.9"
    local mock = Mock.startDriver(project)
    T.eq(mock.servers[41999], nil, "no server on unsupported OS")
    T.contains(mock.properties["Status"], "Unsupported controller OS")
    T.eq(mock.properties["API Status"], "Disabled")
end

return tests
