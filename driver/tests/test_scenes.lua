-- Scenes (src/core/scenes.lua, /v1/scenes): admins make them, members run them, and a run sends
-- the same commands as the device routes.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")

local tests = {}

local function start()
    local mock = Mock.startDriver()
    local admin = T.pair(mock, "Chrome on Windows")
    return mock, admin
end

local function createKey(mock, admin, role)
    local created = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = role .. " phone", role = role } })
    T.eq(created.status, 201, created.body)
    return created.json.key
end

local function commandsSince(mock, before)
    local list = {}
    for index = before + 1, #mock.commands do
        list[#list + 1] = mock.commands[index]
    end
    return list
end

local function devicesOf(commands)
    local devices = {}
    for _, command in ipairs(commands) do
        devices[#devices + 1] = command.device
    end
    return devices
end

local GOOD_NIGHT = {
    name = "Good night",
    icon = "moon",
    show_on_home = true,
    steps = {
        { type = "lights", set = { on = false } },
        { type = "climate", room_id = 11, set = { mode = "cool", target_temperature = 24, fan_speed = "low" } },
        { type = "blinds", room_id = 10, set = { position = 0 } },
        { type = "lights", room_id = 11, device_ids = { 22 }, set = { brightness = 10 } },
        { type = "relays", device_ids = { 70 }, set = { action = "pulse" } },
    },
}

function tests.an_admin_makes_a_scene_and_a_member_runs_it()
    local mock, admin = start()
    local created = T.http(mock, "POST", "/v1/scenes", { key = admin, body = GOOD_NIGHT })
    T.eq(created.status, 201, created.body)
    local scene = created.json
    T.truthy(scene.id:match("^%x%x%x%x%x%x%x%x$"))
    T.eq(scene.version, 1)
    T.eq(#scene.steps, 5)
    T.contains(created.body, '"room_id":null', "the whole home")
    T.contains(created.body, '"device_ids":[22]')

    -- A member runs the scenes an admin chose for them, in full (ADR-054): the door too, while
    -- Door Control is on.
    local member = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = "member phone", role = "member", access = { scenes = { scene.id } } } }).json.key
    T.eq(T.http(mock, "GET", "/v1/scenes", { key = member }).json.items[1].name, "Good night")
    local before = #mock.commands
    local ran = T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = member })
    T.eq(ran.status, 202, ran.body)
    T.eq(ran.json.scene_id, scene.id)
    T.eq(ran.json.ran, 6, "3 lights, the AC, a blind and the desk lamp")
    T.eq(ran.json.skipped, 1, "the door: Door Control is off")
    T.eq(ran.json.failed, 0)
    T.eq(ran.json.problems[1].step, 5)
    T.eq(ran.json.problems[1].device_id, 70)
    T.eq(ran.json.problems[1].code, "DOOR_CONTROL_DISABLED")

    local sent = commandsSince(mock, before)
    local devices = devicesOf(sent)
    local lights = { devices[1], devices[2], devices[3] }
    table.sort(lights)
    T.same(lights, { 20, 21, 22 }, "every light in the home, first")
    T.eq(devices[#devices], 22, "the desk lamp last, dimmed")
    T.same(sent[#sent].params, { LIGHT_BRIGHTNESS_TARGET = 10, RATE = 0 })
    local thermostat = {}
    for _, command in ipairs(sent) do
        if command.device == 30 then
            thermostat[#thermostat + 1] = command.command
        end
    end
    T.same(thermostat, { "SET_MODE_HVAC", "SET_MODE_FAN", "SET_SETPOINT_SINGLE" })
    T.truthy(devices[#devices - 1] == 51, "only the kitchen blind")
    for _, device in ipairs(devices) do
        T.truthy(device ~= 70 and device ~= 50, "no door, no living-room blind")
    end
end

function tests.doors_run_only_with_door_access_and_door_control()
    local mock, admin = start()
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Gate", steps = { { type = "relays", device_ids = { 70 }, set = { action = "pulse" } } } } }).json
    local run = function()
        return T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = admin }).json
    end
    Properties["Door Control"] = "Disabled"
    local off = run()
    T.eq(off.skipped, 1)
    T.eq(off.problems[1].code, "DOOR_CONTROL_DISABLED")
    Properties["Door Control"] = "Enabled"
    local before = #mock.commands
    local on = run()
    T.eq(on.ran, 1, on)
    T.same(mock.commands[before + 1], { device = 70, command = "Close Relay", params = { Relay = "1" } }, "a pulse, like the Open button")
    Mock.fireTimers(mock)
    T.same(mock.commands[before + 2], { device = 70, command = "Open Relay", params = { Relay = "1" } }, "and released: never held closed")
    local doors = createKey(mock, admin, "doors")
    T.eq(T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = doors }).json.ran, 1)
end

function tests.roles_limit_who_changes_and_runs_scenes()
    local mock, admin = start()
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "All off", steps = { { type = "lights", set = { on = false } } } } }).json
    local member = createKey(mock, admin, "member")
    local viewer = createKey(mock, admin, "viewer")
    -- 1.7.0 roles (ADR-054): a viewer runs no scene (for them it does not exist); a member got
    -- the scenes there were.
    T.eq(T.http(mock, "GET", "/v1/scenes/" .. scene.id, { key = viewer }).status, 404, "a viewer sees none")
    T.eq(T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = viewer }).status, 404, "nor runs one")
    T.eq(T.http(mock, "GET", "/v1/scenes/" .. scene.id, { key = member }).status, 200)
    T.eq(T.http(mock, "POST", "/v1/scenes", { key = member, body = { name = "Mine" } }).status, 403, "members do not make them")
    T.eq(T.http(mock, "PATCH", "/v1/scenes/" .. scene.id, { key = member, body = { name = "X" } }).status, 403)
    T.eq(T.http(mock, "DELETE", "/v1/scenes/" .. scene.id, { key = member }).status, 403)
    T.eq(T.http(mock, "POST", "/v1/scenes/try", { key = member, body = { steps = {} } }).status, 403)
    T.eq(T.http(mock, "GET", "/v1/scenes/nothex", { key = viewer }).status, 400)
    T.eq(T.http(mock, "GET", "/v1/scenes/deadbeef", { key = viewer }).status, 404)
end

function tests.scene_input_is_checked()
    local mock, admin = start()
    local before = #mock.commands
    local post = function(body)
        return T.http(mock, "POST", "/v1/scenes", { key = admin, body = body }).json
    end
    local step = function(item)
        local answer = post({ name = "Test", steps = { item } })
        T.eq(answer.code, "INVALID_FIELD", answer)
        return answer
    end
    T.eq(post({ icon = "moon" }).code, "INVALID_FIELD", "a name is needed")
    T.eq(post({ name = "X", icon = "rocket" }).code, "INVALID_FIELD")
    T.eq(post({ name = "X", show_on_home = "yes" }).code, "INVALID_FIELD")
    T.eq(post({ name = "X", colour = "red" }).code, "INVALID_FIELD")
    step({ type = "speakers", set = { on = true } })
    step({ type = "lights", room_id = 99, set = { on = true } })
    step({ type = "lights", device_ids = { 30 }, set = { on = true } })
    step({ type = "climate", device_ids = { 20 }, set = { mode = "cool" } })
    step({ type = "lights", device_ids = {}, set = { on = true } })
    step({ type = "lights", set = { on = true, brightness = 50 } })
    step({ type = "lights", set = { brightness = 101 } })
    step({ type = "lights", set = {} })
    step({ type = "climate", set = { mode = "off", target_temperature = 22 } })
    step({ type = "climate", set = { mode = "dry" } })
    step({ type = "climate", set = { target_temperature = 60 } })
    step({ type = "blinds", set = { position = "open" } })
    step({ type = "relays", set = { state = "closed" } })
    step({ type = "relays", set = { action = "close" } })
    step({ type = "lights", set = { on = true }, delay = 5 })
    local many = {}
    for index = 1, 41 do
        many[index] = { type = "lights", set = { on = true } }
    end
    T.eq(post({ name = "Long", steps = many }).code, "INVALID_FIELD", "at most 40 steps")
    T.eq(#commandsSince(mock, before), 0, "nothing is sent")
    T.eq(#T.http(mock, "GET", "/v1/scenes", { key = admin }).json.items, 0, "nothing is saved")
end

function tests.scenes_are_changed_kept_across_updates_and_deleted()
    local mock, admin = start()
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = GOOD_NIGHT }).json
    local patch = function(body)
        return T.http(mock, "PATCH", "/v1/scenes/" .. scene.id, { key = admin, body = body })
    end
    local renamed = patch({ name = "Night", show_on_home = false, version = 1 })
    T.eq(renamed.status, 200, renamed.body)
    T.eq(renamed.json.version, 2)
    T.eq(#renamed.json.steps, 5, "steps stay unless sent")
    T.eq(patch({ name = "Late", version = 1 }).json.code, "VERSION_CONFLICT")
    local shorter = patch({ steps = { { type = "blinds", set = { position = 100 } } } })
    T.eq(#shorter.json.steps, 1)

    local updated = Mock.updateDriver(mock)
    local kept = T.http(updated, "GET", "/v1/scenes/" .. scene.id, { key = admin })
    T.eq(kept.status, 200, "kept across a driver update")
    T.eq(kept.json.name, "Night")
    T.eq(kept.json.show_on_home, false)
    T.eq(kept.json.version, 3)
    T.same(kept.json.steps[1].set, { position = 100 })

    T.eq(T.http(updated, "DELETE", "/v1/scenes/" .. scene.id, { key = admin }).status, 204)
    T.eq(T.http(updated, "GET", "/v1/scenes/" .. scene.id, { key = admin }).status, 404)
    T.eq(#T.http(Mock.updateDriver(updated), "GET", "/v1/scenes", { key = admin }).json.items, 0)
end

function tests.try_runs_steps_without_saving_them_and_keeps_the_thermostat_range()
    local mock, admin = start()
    local max = T.http(mock, "GET", "/v1/thermostats/30", { key = admin }).json.target_temperature_max
    local before = #mock.commands
    local tried = T.http(mock, "POST", "/v1/scenes/try", { key = admin, body = { steps = { { type = "climate", set = { target_temperature = 38 } } } } })
    T.eq(tried.status, 202, tried.body)
    T.eq(tried.json.ran, 1)
    T.truthy(tried.json.scene_id == nil)
    local sent = commandsSince(mock, before)
    T.eq(#sent, 1)
    T.eq(sent[1].params.CELSIUS, max, "kept within the thermostat's range")
    T.eq(#T.http(mock, "GET", "/v1/scenes", { key = admin }).json.items, 0, "nothing is saved")

    local unsupported = T.http(mock, "POST", "/v1/scenes/try", { key = admin, body = { steps = { { type = "climate", set = { mode = "auto" } } } } }).json
    T.eq(unsupported.skipped, 1)
    T.eq(unsupported.problems[1].code, "MODE_NOT_SUPPORTED")
end

function tests.a_device_gone_from_the_project_is_skipped()
    local mock, admin = start()
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Desk", steps = {
        { type = "lights", device_ids = { 22, 20 }, set = { brightness = 50 } },
    } } }).json
    local project = Mock.project()
    project.devices[22] = nil
    project.devices[103] = nil
    local updated = Mock.updateDriver(mock, project)
    local before = #updated.commands
    local ran = T.http(updated, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = admin }).json
    T.eq(ran.ran, 1)
    T.eq(ran.skipped, 1)
    T.eq(ran.problems[1].device_id, 22)
    T.eq(ran.problems[1].code, "NOT_FOUND")
    T.same(devicesOf(commandsSince(updated, before)), { 20 })
end

function tests.a_change_that_cannot_be_saved_changes_nothing()
    local mock, admin = start()
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = GOOD_NIGHT }).json
    local write = C4.PersistSetValue
    C4.PersistSetValue = function()
        error("disk full")
    end
    local renamed = T.http(mock, "PATCH", "/v1/scenes/" .. scene.id, { key = admin, body = { name = "Renamed" } })
    local deleted = T.http(mock, "DELETE", "/v1/scenes/" .. scene.id, { key = admin })
    C4.PersistSetValue = write
    T.eq(renamed.status, 500, renamed.body)
    T.eq(deleted.status, 500, deleted.body)
    local now = T.http(mock, "GET", "/v1/scenes/" .. scene.id, { key = admin }).json
    T.eq(now.name, "Good night", "the change was undone")
    T.eq(now.version, 1)
    T.eq(T.http(Mock.updateDriver(mock), "GET", "/v1/scenes/" .. scene.id, { key = admin }).json.name, "Good night")
end

function tests.stored_steps_are_checked_again_when_loaded()
    local mock, admin = start()
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Mixed", steps = { { type = "lights", device_ids = { 20 }, set = { on = false } } } } }).json
    local raw = mock.persist.directorlink_scenes
    local data = Json.decode(raw:sub(#"json:" + 1))
    local steps = data.scenes[1].steps
    steps[#steps + 1] = { type = "climate", set = { mode = true } }
    steps[#steps + 1] = { type = "climate", set = { target_temperature = "hot" } }
    steps[#steps + 1] = { type = "lights", set = { on = "false" } }
    steps[#steps + 1] = { type = "lights", set = {} }
    steps[#steps + 1] = { type = "relays", device_ids = { 70 }, set = { state = "closed" } }
    steps[#steps + 1] = { type = "lights", device_ids = Json.null, set = { on = false } }
    steps[#steps + 1] = { type = "blinds", device_ids = {}, set = { position = 0 } }
    mock.persist.directorlink_scenes = "json:" .. Json.encode(data)
    local updated = Mock.updateDriver(mock)
    local loaded = T.http(updated, "GET", "/v1/scenes/" .. scene.id, { key = admin }).json
    T.eq(#loaded.steps, 2, "only the valid steps are kept")
    T.same(loaded.steps[1].device_ids, { 20 })
    T.truthy(loaded.steps[2].device_ids == Json.null, "a stored null is the whole home, not an empty list")
    local ran = T.http(updated, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = admin })
    T.eq(ran.status, 202, ran.body)
    for _, command in ipairs(updated.commands) do
        T.truthy(command.device ~= 70, "no relay held closed")
    end
end

function tests.scenes_that_could_not_be_read_are_not_overwritten()
    local mock, admin = start()
    T.http(mock, "POST", "/v1/scenes", { key = admin, body = GOOD_NIGHT })
    T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Morning" } })
    local stuck = Mock.startDriver(nil, nil, "DIT_UPDATING", function(next)
        next.uuidCount = mock.uuidCount
        for name, value in pairs(mock.persist) do
            next.persist[name] = value
            next.persistEncrypted[name] = mock.persistEncrypted[name]
        end
        local read = C4.PersistGetValue
        C4.PersistGetValue = function(self, name, encrypted)
            if name == "directorlink_scenes" then
                error("database busy")
            end
            return read(self, name, encrypted)
        end
    end)
    T.eq(#T.http(stuck, "GET", "/v1/scenes", { key = admin }).json.items, 0)
    local refused = T.http(stuck, "POST", "/v1/scenes", { key = admin, body = { name = "New" } })
    T.eq(refused.status, 503, refused.body)
    T.eq(refused.json.code, "UNAVAILABLE")
    stuck.persist.directorlink_scenes = mock.persist.directorlink_scenes
    local later = Mock.updateDriver(stuck)
    T.eq(#T.http(later, "GET", "/v1/scenes", { key = admin }).json.items, 2, "both scenes are still there")
end

-- Scenes on a thermostat with heat and cool setpoints: 31 (Mock.withDualThermostat, Kitchen, in
-- auto, heat 68 °F, cool 76 °F, deadband 3 °F) next to the V2 zone 30 (Living Room, in cool).
local function startDual()
    local mock = Mock.startDriver(Mock.withDualThermostat(Mock.project()))
    local admin = T.pair(mock, "Chrome on Windows")
    return mock, admin
end

-- Tries one climate step; returns the result and what each thermostat got, as { command, params }.
local function tryClimate(mock, admin, set, deviceIds)
    local before = #mock.commands
    local tried = T.http(mock, "POST", "/v1/scenes/try", { key = admin, body = { steps = {
        { type = "climate", device_ids = deviceIds, set = set },
    } } })
    T.eq(tried.status, 202, tried.body)
    local by = { [30] = {}, [31] = {} }
    for _, command in ipairs(commandsSince(mock, before)) do
        local list = by[command.device]
        list[#list + 1] = { command.command, command.params }
    end
    return tried.json, by
end

function tests.a_whole_home_target_sets_each_thermostat_its_own_way()
    local mock, admin = startDual()
    local result, sent = tryClimate(mock, admin, { mode = "cool", target_temperature = 24 })
    T.eq(result.ran, 2, result)
    T.eq(#result.problems, 0, result)
    T.same(sent[30], { { "SET_MODE_HVAC", { MODE = "Cool" } }, { "SET_SETPOINT_SINGLE", { CELSIUS = 24 } } })
    T.same(sent[31], { { "SET_MODE_HVAC", { MODE = "Cool" } }, { "SET_SETPOINT_COOL", { FAHRENHEIT = 75 } } },
        "the cool setpoint: the step's mode, not the auto it reports")

    result, sent = tryClimate(mock, admin, { mode = "heat", target_temperature = 21 }, { 31 })
    T.eq(result.ran, 1)
    T.same(sent[31], { { "SET_MODE_HVAC", { MODE = "Heat" } }, { "SET_SETPOINT_HEAT", { FAHRENHEIT = 70 } } })
end

function tests.a_step_with_heat_and_cool_setpoints_runs_on_dual_thermostats()
    local mock, admin = startDual()
    local result, sent = tryClimate(mock, admin, { mode = "auto", heat_setpoint = 20, cool_setpoint = 24 })
    T.eq(result.ran, 1, result)
    T.eq(result.skipped, 1)
    T.eq(result.problems[1].device_id, 30)
    T.eq(result.problems[1].code, "MODE_NOT_SUPPORTED", "the AC zone has no auto")
    T.same(sent[31], {
        { "SET_MODE_HVAC", { MODE = "Auto" } },
        { "SET_SETPOINT_HEAT", { FAHRENHEIT = 68 } },
        { "SET_SETPOINT_COOL", { FAHRENHEIT = 75 } },
    })
    T.eq(#sent[30], 0)

    -- One setpoint alone moves the other to keep the deadband, as PATCH does.
    result, sent = tryClimate(mock, admin, { cool_setpoint = 21 }, { 31 })
    T.eq(result.ran, 1)
    T.same(sent[31], { { "SET_SETPOINT_HEAT", { FAHRENHEIT = 67 } }, { "SET_SETPOINT_COOL", { FAHRENHEIT = 70 } } })
end

function tests.a_single_setpoint_zone_takes_the_setpoint_of_its_mode()
    local mock, admin = startDual()
    local result, sent = tryClimate(mock, admin, { mode = "heat", heat_setpoint = 21 }, { 30 })
    T.eq(result.ran, 1)
    T.same(sent[30], { { "SET_MODE_HVAC", { MODE = "Heat" } }, { "SET_SETPOINT_SINGLE", { CELSIUS = 21 } } })
    result, sent = tryClimate(mock, admin, { cool_setpoint = 24 }, { 30 })
    T.eq(result.ran, 1, "the zone reports cool")
    T.same(sent[30], { { "SET_SETPOINT_SINGLE", { CELSIUS = 24 } } })
    result, sent = tryClimate(mock, admin, { mode = "cool", heat_setpoint = 20, cool_setpoint = 24 }, { 30 })
    T.same(sent[30], { { "SET_MODE_HVAC", { MODE = "Cool" } }, { "SET_SETPOINT_SINGLE", { CELSIUS = 24 } } })

    result, sent = tryClimate(mock, admin, { heat_setpoint = 21 }, { 30 })
    T.eq(result.skipped, 1, "in cool a heat setpoint does not apply")
    T.eq(result.problems[1].code, "NOT_SUPPORTED")
    T.contains(result.problems[1].detail, "one target temperature")
    T.eq(#sent[30], 0)
    result, sent = tryClimate(mock, admin, { mode = "heat", fan_speed = "high", cool_setpoint = 24 }, { 30 })
    T.eq(result.ran, 1)
    T.eq(result.problems[1].outcome, "partial")
    T.same(sent[30], { { "SET_MODE_HVAC", { MODE = "Heat" } }, { "SET_MODE_FAN", { MODE = "High" } } })
end

function tests.a_setpoint_a_dual_thermostat_refuses_is_left_out()
    local mock, admin = startDual()
    local result, sent = tryClimate(mock, admin, { mode = "auto", target_temperature = 22 }, { 31 })
    T.eq(result.ran, 1)
    T.eq(result.problems[1].outcome, "partial")
    T.eq(result.problems[1].code, "NOT_SUPPORTED")
    T.eq(result.problems[1].detail, "In auto this thermostat takes a heat and a cool setpoint")
    T.same(sent[31], { { "SET_MODE_HVAC", { MODE = "Auto" } } }, "only the mode")

    -- 22 and 22.5 °C are 72 and 73 °F: closer than the 3 °F deadband.
    local steps = { { type = "climate", device_ids = { 31 }, set = { heat_setpoint = 22, cool_setpoint = 22.5 } } }
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Close", steps = steps } })
    T.eq(scene.status, 201, "valid as a step: " .. tostring(scene.body))
    local before = #mock.commands
    local ran = T.http(mock, "POST", "/v1/scenes/" .. scene.json.id .. "/run", { key = admin }).json
    T.eq(ran.skipped, 1, "nothing else in the step")
    T.eq(ran.problems[1].code, "NOT_SUPPORTED")
    T.contains(ran.problems[1].detail, "at least 1.7")
    T.eq(#commandsSince(mock, before), 0)
    result, sent = tryClimate(mock, admin, { mode = "auto", heat_setpoint = 22, cool_setpoint = 22.5 }, { 31 })
    T.eq(result.ran, 1)
    T.eq(result.problems[1].outcome, "partial")
    T.same(sent[31], { { "SET_MODE_HVAC", { MODE = "Auto" } } })
end

function tests.setpoint_steps_are_checked()
    local mock, admin = startDual()
    local before = #mock.commands
    local step = function(set)
        local answer = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Test", steps = { { type = "climate", set = set } } } })
        T.eq(answer.status, 400, answer.body)
        T.eq(answer.json.code, "INVALID_FIELD")
        return answer.json
    end
    step({ target_temperature = 22, heat_setpoint = 20 })
    step({ mode = "off", heat_setpoint = 20 })
    T.eq(step({ heat_setpoint = 4 }).errors[1].field, "steps[0].set.heat_setpoint")
    step({ cool_setpoint = 41 })
    T.eq(step({ heat_setpoint = 24, cool_setpoint = 24 }).errors[1].field, "steps[0].set.cool_setpoint", "cool above heat")
    step({ heat_setpoint = 24, cool_setpoint = 20 })
    step({ heat_setpoint = "20" })
    step({ fan_speed = "humidify" })
    T.eq(#commandsSince(mock, before), 0, "nothing is sent")
    T.eq(#T.http(mock, "GET", "/v1/scenes", { key = admin }).json.items, 0, "nothing is saved")
    local fan = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Fan", steps = { { type = "climate", set = { fan_speed = "circulate" } } } } })
    T.eq(fan.status, 201, fan.body)
end

function tests.a_setpoint_step_is_kept_across_updates_and_checked_when_loaded()
    local mock, admin = startDual()
    local set = { mode = "auto", heat_setpoint = 20, cool_setpoint = 24 }
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Auto", steps = {
        { type = "climate", device_ids = { 31 }, set = set },
    } } }).json
    T.same(scene.steps[1].set, set)

    local raw = mock.persist.directorlink_scenes
    local data = Json.decode(raw:sub(#"json:" + 1))
    local steps = data.scenes[1].steps
    steps[#steps + 1] = { type = "climate", set = { heat_setpoint = 24, cool_setpoint = 20 } }
    steps[#steps + 1] = { type = "climate", set = { target_temperature = 22, cool_setpoint = 24 } }
    steps[#steps + 1] = { type = "climate", set = { mode = "off", cool_setpoint = 24 } }
    steps[#steps + 1] = { type = "climate", set = { heat_setpoint = "warm" } }
    mock.persist.directorlink_scenes = "json:" .. Json.encode(data)

    local updated = Mock.updateDriver(mock, Mock.withDualThermostat(Mock.project()))
    local kept = T.http(updated, "GET", "/v1/scenes/" .. scene.id, { key = admin }).json
    T.eq(#kept.steps, 1, "only the valid step is kept")
    T.same(kept.steps[1].set, set)
    local before = #updated.commands
    T.eq(T.http(updated, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = admin }).json.ran, 1)
    T.eq(#commandsSince(updated, before), 3, "the mode and both setpoints")
end

function tests.a_fan_speed_a_unit_does_not_have_is_reported()
    local mock, admin = start()
    local tried = T.http(mock, "POST", "/v1/scenes/try", { key = admin, body = { steps = { { type = "climate", set = { mode = "cool", fan_speed = "auto" } } } } }).json
    T.eq(tried.ran, 1)
    T.eq(tried.problems[1].outcome, "partial")
    T.contains(tried.problems[1].detail, "auto")
    local onlyFan = T.http(mock, "POST", "/v1/scenes/try", { key = admin, body = { steps = { { type = "climate", set = { fan_speed = "auto" } } } } }).json
    T.eq(onlyFan.skipped, 1)
    T.eq(onlyFan.problems[1].code, "NOT_SUPPORTED")
end

-- POST /v1/off (1.3.0): Home's "Turn off all" turns off the lights or AC, or closes the blinds,
-- that the app shows on or open, in one request.
local function turnOff(mock, key, body)
    local before = #mock.commands
    local answer = T.http(mock, "POST", "/v1/off", { key = key, body = body })
    return answer, commandsSince(mock, before)
end

function tests.a_member_turns_off_the_lights_it_names_in_one_request()
    local mock, admin = start()
    local member = createKey(mock, admin, "member")
    local answer, sent = turnOff(mock, member, { type = "lights", device_ids = { 20, 22, 20 } })
    T.eq(answer.status, 202, answer.body)
    T.eq(answer.json.ran, 2, "a repeated id counts once")
    T.eq(answer.json.skipped, 0)
    T.eq(answer.json.failed, 0)
    T.eq(#answer.json.problems, 0)
    T.truthy(answer.json.scene_id == nil)
    T.same(sent, {
        { device = 20, command = "SET_BRIGHTNESS_TARGET", params = { LIGHT_BRIGHTNESS_TARGET_PRESET_ID = 2 } },
        { device = 22, command = "SET_BRIGHTNESS_TARGET", params = { LIGHT_BRIGHTNESS_TARGET_PRESET_ID = 2 } },
    }, "the Off preset, as PATCH {\"on\": false} sends; nothing to the hall light")
end

function tests.turn_off_sets_the_ac_off_and_closes_the_blinds()
    local mock, admin = startDual()
    local member = createKey(mock, admin, "member")
    local climate, sent = turnOff(mock, member, { type = "climate", device_ids = { 30, 31 } })
    T.eq(climate.status, 202, climate.body)
    T.eq(climate.json.ran, 2)
    T.same(sent, {
        { device = 30, command = "SET_MODE_HVAC", params = { MODE = "Off" } },
        { device = 31, command = "SET_MODE_HVAC", params = { MODE = "Off" } },
    }, "only the mode, as a scene's All AC: Off")

    local blinds
    blinds, sent = turnOff(mock, member, { type = "blinds", device_ids = { 50 } })
    T.eq(blinds.status, 202, blinds.body)
    T.eq(blinds.json.ran, 1)
    T.eq(#sent, 1, "only the living-room blind")
    T.eq(sent[1].device, 50)
    T.eq(sent[1].command, "SET_LEVEL_TARGET")
    T.same(sent[1].params, { LEVEL_TARGET = 0 })
end

function tests.turn_off_says_which_devices_did_not_turn_off_and_runs_the_rest()
    local project = Mock.project()
    project.variables[30][1120] = "Heat,Cool"
    local mock = Mock.startDriver(project)
    local admin = T.pair(mock, "Chrome on Windows")
    local skipped = turnOff(mock, admin, { type = "climate", device_ids = { 30 } })
    T.eq(skipped.json.skipped, 1, "a thermostat without Off is left as it is")
    T.eq(skipped.json.problems[1].device_id, 30)
    T.eq(skipped.json.problems[1].code, "MODE_NOT_SUPPORTED")

    local send = C4.SendToDevice
    C4.SendToDevice = function(self, deviceId, command, params)
        if deviceId == 20 then
            error("device offline")
        end
        return send(self, deviceId, command, params)
    end
    local answer, sent = turnOff(mock, admin, { type = "lights", device_ids = { 20, 22 } })
    C4.SendToDevice = send
    T.eq(answer.status, 202, answer.body)
    T.eq(answer.json.ran, 1)
    T.eq(answer.json.failed, 1)
    T.eq(answer.json.problems[1].device_id, 20)
    T.eq(answer.json.problems[1].outcome, "failed")
    T.eq(answer.json.problems[1].step, 1)
    T.same(devicesOf(sent), { 22 }, "the desk lamp still turned off")
end

function tests.turn_off_is_for_members_and_never_opens_or_turns_on_anything()
    local mock, admin = start()
    local viewer = createKey(mock, admin, "viewer")
    local doors = createKey(mock, admin, "doors")
    local before = #mock.commands
    T.eq(T.http(mock, "POST", "/v1/off", { key = viewer, body = { type = "lights", device_ids = { 20 } } }).status, 400, "a viewer has no rooms: a light they do not see")
    T.eq(T.http(mock, "POST", "/v1/off", { body = { type = "lights", device_ids = { 20 } } }).status, 401)
    local refused = function(body, field)
        local answer = T.http(mock, "POST", "/v1/off", { key = doors, body = body })
        T.eq(answer.status, 400, answer.body)
        T.eq(answer.json.code, "INVALID_FIELD", answer.body)
        T.eq(answer.json.errors[1].field, field, answer.body)
    end
    refused({ type = "relays", device_ids = { 70 } }, "type")
    refused({ type = "fans", device_ids = { 41 } }, "type")
    refused({ device_ids = { 20 } }, "type")
    refused({ type = "lights" }, "device_ids")
    refused({ type = "lights", device_ids = {} }, "device_ids")
    refused({ type = "lights", device_ids = { 70 } }, "device_ids")
    refused({ type = "climate", device_ids = { 20 } }, "device_ids")
    refused({ type = "blinds", device_ids = { 50, 999 } }, "device_ids")
    refused({ type = "lights", device_ids = { 20 }, set = { on = true } }, "set")
    local many = {}
    for index = 1, 501 do
        many[index] = 20
    end
    refused({ type = "lights", device_ids = many }, "device_ids")
    T.eq(#commandsSince(mock, before), 0, "nothing is sent")
    local ok = T.http(mock, "POST", "/v1/off", { key = doors, body = { type = "lights", device_ids = { 21 } } })
    T.eq(ok.status, 202, "doors and admin keys can do what members can")
end

-- ---- A level for a room or the whole home (ADR-077, 2026-10-09) -------------------------------
-- A switch is a light whose driver says it only turns on and off (1.10.2). A level for a room or
-- the whole home goes to the dimmers there and leaves the switches as they are (on the owner's
-- home some are heaters, one a door lock): skipped, ON_OFF_ONLY. A switch a step names turns on;
-- off, a level of 0 and on go to every light, switches too.

local function sentTo(commands)
    local byDevice = {}
    for _, command in ipairs(commands) do
        byDevice[command.device] = byDevice[command.device] or {}
        table.insert(byDevice[command.device], command)
    end
    return byDevice
end

local DIM_50 = { command = "SET_BRIGHTNESS_TARGET", params = { LIGHT_BRIGHTNESS_TARGET = 50, RATE = 0 } }
local PRESET_ON = { LIGHT_BRIGHTNESS_TARGET_PRESET_ID = 1 }
local PRESET_OFF = { LIGHT_BRIGHTNESS_TARGET_PRESET_ID = 2 }

-- `count` more KNX switches in the Living Room, as the owner's: proxies 301 on, drivers 401 on.
local function withSwitches(project, count)
    for index = 1, count do
        local id, protocol = 300 + index, 400 + index
        project.devices[protocol] = {
            deviceName = "KNX Switch", driverFileName = "knx_switch.c4i", roomId = 11, roomName = "Living Room",
            proxies = { [id] = { deviceName = "Heater " .. index, driverFileName = "light_v2.c4i" } },
        }
        project.devices[id] = {
            deviceName = "Heater " .. index, driverFileName = "light_v2.c4i", roomId = 11, roomName = "Living Room",
            protocol = { [protocol] = { deviceName = "KNX Switch", driverFileName = "knx_switch.c4i" } },
        }
        project.variables[id] = { [1000] = "0", [1001] = "0" }
        project.deviceData[protocol] = { capabilities = Mock.KNX_SWITCH_CAPABILITIES }
    end
    return project
end

function tests.a_level_for_a_room_dims_its_dimmers_and_leaves_its_switches()
    local mock, admin = start()
    T.eq(T.http(mock, "GET", "/v1/lights/21", { key = admin }).json.dimmable, false, "the hall light is a switch")
    local before = #mock.commands
    -- Try it now.
    local tried = T.http(mock, "POST", "/v1/scenes/try", { key = admin, body = { steps = {
        { type = "lights", room_id = 11, set = { brightness = 50 } },
    } } })
    T.eq(tried.status, 202, tried.body)
    T.eq(tried.json.ran, 1, "the desk lamp")
    T.eq(tried.json.skipped, 1, "the hall light")
    T.eq(tried.json.failed, 0)
    T.eq(tried.json.on_off_only, 1)
    T.eq(#tried.json.problems, 1)
    local problem = tried.json.problems[1]
    T.same({ problem.step, problem.device_id, problem.outcome, problem.code }, { 1, 21, "skipped", "ON_OFF_ONLY" })
    T.contains(problem.detail, "only turns on and off")
    local sent = commandsSince(mock, before)
    T.eq(#sent, 1, "nothing goes to the switch")
    T.same(sent[1], { device = 22, command = DIM_50.command, params = DIM_50.params })

    -- A saved scene, run from the app: the same, and History says the switch stayed as it was.
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Evening", steps = {
        { type = "lights", room_id = 11, set = { brightness = 50 } },
    } } }).json
    before = #mock.commands
    local ran = T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = admin })
    T.eq(ran.status, 202, ran.body)
    T.same({ ran.json.ran, ran.json.skipped, ran.json.failed, ran.json.on_off_only }, { 1, 1, 0, 1 })
    T.same(devicesOf(commandsSince(mock, before)), { 22 })
    local entry = T.http(mock, "GET", "/v1/activity?kind=scene", { key = admin }).json.items[1]
    T.eq(entry.outcome, "ran")
    T.same(entry.counts, { ran = 1, skipped = 1, failed = 0, on_off_only = 1 })
    T.contains(mock.properties["Last Automation"], "Evening · run from Chrome on Windows · 1 device, 1 switch left as it was")
    T.notContains(mock.properties["Last Automation"], "skipped")
end

function tests.a_level_for_the_whole_home_dims_every_dimmer_and_leaves_every_switch()
    local mock = Mock.startDriver(Mock.withLegacyLights(Mock.project()))
    local admin = T.pair(mock, "Chrome on Windows")
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Dim all", steps = {
        { type = "lights", set = { brightness = 50 } },
    } } }).json
    local before = #mock.commands
    local ran = T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = admin }).json
    T.same({ ran.ran, ran.skipped, ran.failed, ran.on_off_only }, { 3, 2, 0, 2 })
    local sent = sentTo(commandsSince(mock, before))
    T.same(sent[20], { { device = 20, command = DIM_50.command, params = DIM_50.params } }, "the KNX dimmer")
    T.same(sent[22], { { device = 22, command = DIM_50.command, params = DIM_50.params } })
    T.same(sent[25], { { device = 25, command = "SET_LEVEL", params = { LEVEL = 50 } } }, "a legacy dimmer")
    T.eq(sent[21], nil, "the KNX switch stays as it is")
    T.eq(sent[26], nil, "and the legacy switch")
    local skipped = {}
    for _, problem in ipairs(ran.problems) do
        T.eq(problem.code, "ON_OFF_ONLY")
        skipped[#skipped + 1] = problem.device_id
    end
    table.sort(skipped)
    T.same(skipped, { 21, 26 })
    -- A member the scene was chosen for runs it the same way.
    local member = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = "member phone", role = "member", access = { scenes = { scene.id } } } }).json.key
    before = #mock.commands
    local theirs = T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = member }).json
    T.same({ theirs.ran, theirs.skipped, theirs.on_off_only }, { 3, 2, 2 })
    T.eq(sentTo(commandsSince(mock, before))[21], nil)
end

function tests.a_switch_a_step_names_still_turns_on_with_a_level()
    local mock, admin = start()
    local before = #mock.commands
    local tried = T.http(mock, "POST", "/v1/scenes/try", { key = admin, body = { steps = {
        { type = "lights", device_ids = { 21 }, set = { brightness = 50 } },
        { type = "lights", room_id = 11, device_ids = { 21, 22 }, set = { brightness = 50 } },
    } } }).json
    T.same({ tried.ran, tried.skipped, tried.failed }, { 3, 0, 0 })
    T.eq(tried.on_off_only, nil)
    T.eq(#tried.problems, 0)
    local sent = sentTo(commandsSince(mock, before))
    T.same(sent[21], {
        { device = 21, command = "SET_BRIGHTNESS_TARGET", params = PRESET_ON },
        { device = 21, command = "SET_BRIGHTNESS_TARGET", params = PRESET_ON },
    }, "named by its id, it turns on (1.10.2)")
    T.same(sent[22], { { device = 22, command = DIM_50.command, params = DIM_50.params } })
end

function tests.off_a_level_of_0_and_on_still_go_to_a_room_s_switches()
    local mock, admin = start()
    for _, case in ipairs({
        { set = { brightness = 0 }, params = PRESET_OFF },
        { set = { on = false }, params = PRESET_OFF },
        { set = { on = true }, params = PRESET_ON },
    }) do
        local before = #mock.commands
        local tried = T.http(mock, "POST", "/v1/scenes/try", { key = admin, body = { steps = {
            { type = "lights", room_id = 11, set = case.set },
        } } }).json
        T.same({ tried.ran, tried.skipped, tried.failed }, { 2, 0, 0 }, Json.encode(case.set))
        T.eq(tried.on_off_only, nil)
        local sent = sentTo(commandsSince(mock, before))
        T.same(sent[21], { { device = 21, command = "SET_BRIGHTNESS_TARGET", params = case.params } }, "the switch: " .. Json.encode(case.set))
        T.truthy(sent[22] ~= nil, "and the dimmer")
    end
    -- Home's Turn off all turns switches off too.
    local before = #mock.commands
    local off = T.http(mock, "POST", "/v1/off", { key = admin, body = { type = "lights", device_ids = { 21, 22 } } }).json
    T.same({ off.ran, off.skipped }, { 2, 0 })
    T.same(sentTo(commandsSince(mock, before))[21], { { device = 21, command = "SET_BRIGHTNESS_TARGET", params = PRESET_OFF } })
end

-- The owner's home has 107 switches: a whole home's do not crowd the other problems out of the 50,
-- and the run and History count every one.
function tests.many_switches_left_as_they_are_are_counted_and_listed_after_the_other_problems()
    local mock = Mock.startDriver(withSwitches(Mock.project(), 60))
    local admin = T.pair(mock, "Chrome on Windows")
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Movie", steps = {
        { type = "lights", set = { brightness = 30 } },
        { type = "climate", room_id = 11, set = { mode = "auto" } },
    } } }).json
    local before = #mock.commands
    local ran = T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = admin }).json
    T.same({ ran.ran, ran.skipped, ran.failed, ran.on_off_only }, { 2, 62, 0, 61 }, "two dimmers; 61 switches and the AC skipped")
    T.eq(#ran.problems, 50)
    T.same({ ran.problems[1].step, ran.problems[1].device_id, ran.problems[1].code }, { 2, 30, "MODE_NOT_SUPPORTED" }, "the AC first")
    for index = 2, 50 do
        T.eq(ran.problems[index].code, "ON_OFF_ONLY")
    end
    for _, command in ipairs(commandsSince(mock, before)) do
        T.truthy(command.device == 20 or command.device == 22, "only the dimmers get a command: " .. tostring(command.device))
    end
    local entry = T.http(mock, "GET", "/v1/activity?kind=scene", { key = admin }).json.items[1]
    T.same(entry.counts, { ran = 2, skipped = 62, failed = 0, on_off_only = 61 })
    T.contains(mock.properties["Last Automation"], "2 devices, 1 skipped, 61 switches left as they were")
end

function tests.the_driver_says_a_level_for_a_room_goes_to_dimmers_only()
    local mock, admin = start()
    T.eq(T.http(mock, "GET", "/v1/system", { key = admin }).json.features.scene_levels_dimmers_only, true)
end

return tests
