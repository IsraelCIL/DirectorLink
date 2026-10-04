-- Samsung refrigerators (ADR-049, src/adapters/refrigerator.lua): the owner's Samsung Refrigerator
-- (DirectorLink) driver as one device in its room, its state from the driver's variables (1.0.0's
-- twelve, and REPORTED_VARIABLES and TEMPERATURE_UNIT when it has them), /v1/refrigerators with the
-- four features switched by SET_FEATURE, refrigerator steps in scenes and schedules, the door left
-- open once per opening, and the steps kept through a downgrade to 1.6.0. The fake refrigerator is
-- Mock.withRefrigerator: the driver 140 with its proxies 141 (the refrigerator) to 145, in the
-- kitchen.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")

local tests = {}

local function isNull(value)
    return type(value) == "table" and tostring(value) == "null"
end

local function start(options, change, prepare)
    local project = Mock.withRefrigerator(Mock.project(), options)
    if change then
        change(project)
    end
    local mock = Mock.startDriver(project, nil, nil, prepare)
    return mock, T.pair(mock)
end

local function commandsSince(mock, before)
    local list = {}
    for index = before + 1, #mock.commands do
        local command = mock.commands[index]
        list[#list + 1] = { device = command.device, command = command.command, params = command.params }
    end
    return list
end

local function listening(mock, deviceId, variableId)
    for _, entry in ipairs(mock.listeners) do
        if entry[1] == deviceId and entry[2] == variableId then
            return true
        end
    end
    return false
end

local function createKey(mock, admin, role)
    local created = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = role .. " phone", role = role } })
    T.eq(created.status, 201, created.body)
    return created.json.key, created.json.id
end

local function fridge(mock, key)
    local answer = T.http(mock, "GET", "/v1/refrigerators/141", { key = key })
    T.eq(answer.status, 200, answer.body)
    return answer.json
end

function tests.the_refrigerator_driver_is_one_device_in_its_room()
    local mock, key = start()
    local devices = T.http(mock, "GET", "/v1/devices", { key = key }).json.items
    local ids = {}
    for _, device in ipairs(devices) do
        ids[device.id] = device
    end
    T.truthy(ids[141], "the refrigerator: the driver's first proxy, its status tile")
    T.eq(ids[141].type, "refrigerator")
    T.eq(ids[141].name, "Refrigerator")
    T.eq(ids[141].room.id, 10)
    T.eq(ids[141].supported, true)
    T.eq(ids[141].href, "/v1/refrigerators/141")
    for id = 142, 145 do
        T.eq(ids[id], nil, "the feature tiles are no devices of their own: " .. id)
    end
    T.eq(ids[140], nil, "nor the driver")
    T.eq(#T.http(mock, "GET", "/v1/devices?type=refrigerator", { key = key }).json.items, 1)
    T.eq(T.http(mock, "GET", "/v1/devices/142", { key = key }).status, 404)

    local system = T.http(mock, "GET", "/v1/system", { key = key }).json
    T.eq(system.inventory.refrigerators, 1)
    T.eq(system.features.refrigerators, true)
    T.contains(mock.properties["Inventory"], "1 doorbells, 1 refrigerators")
    local list = T.http(mock, "GET", "/v1/refrigerators", { key = key }).json.items
    T.eq(#list, 1)
    T.eq(#T.http(mock, "GET", "/v1/refrigerators?room_id=11", { key = key }).json.items, 0)
    T.eq(T.http(mock, "GET", "/v1/refrigerators/20", { key = key }).status, 404, "a light is not a refrigerator")
    T.eq(T.http(mock, "GET", "/v1/refrigerators/142", { key = key }).status, 404)
    T.eq(T.http(mock, "GET", "/v1/refrigerators/x", { key = key }).status, 400)

    -- Composer changes: read again with the project.
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    T.eq(#T.http(mock, "GET", "/v1/refrigerators", { key = key }).json.items, 1)
    T.truthy(listening(mock, 140, 1009), "and watched again")
end

function tests.composer_s_copy_of_the_driver_and_its_name_in_any_case_are_recognized()
    for _, file in ipairs({ "DirectorLink-Samsung-Refrigerator (1).c4z", "directorlink-samsung-refrigerator (12).C4Z", "DIRECTORLINK-SAMSUNG-REFRIGERATOR.c4z" }) do
        local mock, key = start({ file = file })
        T.eq(#T.http(mock, "GET", "/v1/refrigerators", { key = key }).json.items, 1, file)
    end
    local Classifier = require("src.adapters.classifier")
    T.eq(Classifier.isRefrigeratorDriver("DirectorLink-Samsung-Refrigerator(1).c4z"), false)
    T.eq(Classifier.isRefrigeratorDriver("Samsung-Refrigerator.c4z"), false)
    T.eq(Classifier.isRefrigeratorDriver("DirectorLink-Samsung-Refrigerator (x).c4z"), false)
    -- Another driver's buttons stay buttons.
    local mock, key = start({ file = "other_fridge.c4z" })
    T.eq(#T.http(mock, "GET", "/v1/refrigerators", { key = key }).json.items, 0)
    T.eq(T.http(mock, "GET", "/v1/devices/142", { key = key }).json.type, "other")
end

function tests.the_state_comes_from_the_driver_s_variables()
    local mock, key = start()
    local view = fridge(mock, key)
    T.eq(view.id, 141)
    T.eq(view.name, "Refrigerator")
    T.eq(view.room.name, "Kitchen")
    T.eq(view.online, true)
    T.eq(view.fridge_temperature, 3)
    T.eq(view.fridge_setpoint, 3)
    T.eq(view.freezer_temperature, -18)
    T.eq(view.freezer_setpoint, -18)
    T.eq(view.door_open, false)
    T.eq(view.water_filter_usage, 40)
    T.eq(view.power_cool, false)
    T.eq(view.sabbath_mode, false)
    T.same(view.features, { "power_cool", "power_freeze", "sabbath_mode", "ice_maker" }, "driver 1.0.0 does not say: all four")
    T.eq(view.features_reported, false)
    local keys = {}
    for name in pairs(view) do
        keys[#keys + 1] = name
    end
    table.sort(keys)
    T.same(keys, {
        "door_open", "features", "features_reported", "freezer_setpoint", "freezer_temperature", "fridge_setpoint",
        "fridge_temperature", "ice_maker", "id", "name", "online", "power_cool", "power_freeze", "room",
        "sabbath_mode", "water_filter_usage",
    }, "no Control4 names or ids")

    -- Watched on the driver itself, by id as Director numbers them (1001 on), not the power.
    for id = 1001, 1012 do
        T.eq(listening(mock, 140, id), id ~= 1011, "variable " .. id)
    end
    T.truthy(not listening(mock, 141, 1001), "not on the proxy")

    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "1", SABBATH_MODE = "1", FRIDGE_TEMP = "4.5", ONLINE = "0", WATER_FILTER_USAGE = "95" })
    view = fridge(mock, key)
    T.eq(view.door_open, true)
    T.eq(view.sabbath_mode, true)
    T.eq(view.fridge_temperature, 4.5)
    T.eq(view.online, false)
    T.eq(view.water_filter_usage, 95)
end

function tests.variables_are_found_by_name_else_by_their_ids()
    -- A Director whose GetDeviceVariables lists nothing: the ids the driver's order gives.
    local mock, key = start(nil, nil, function()
        local listed = C4.GetDeviceVariables
        function C4:GetDeviceVariables(deviceId)
            return deviceId == 140 and {} or listed(self, deviceId)
        end
    end)
    T.eq(fridge(mock, key).freezer_setpoint, -18)
    -- A driver without the variables is not a refrigerator DirectorLink can show.
    mock, key = start(nil, function(project)
        project.variables[140] = {}
    end)
    T.eq(#T.http(mock, "GET", "/v1/refrigerators", { key = key }).json.items, 0)
    T.eq(T.http(mock, "GET", "/v1/devices/141", { key = key }).json.supported, false)
end

function tests.driver_1_0_0_s_zeros_are_not_shown_as_values()
    -- The driver starts every variable at 0 and leaves it there for what the refrigerator lacks.
    local mock, key = start({ values = { FREEZER_TEMP = "0", FREEZER_SETPOINT = "0", WATER_FILTER_USAGE = "0" } })
    local view = fridge(mock, key)
    T.eq(view.fridge_temperature, 3)
    T.truthy(isNull(view.freezer_temperature) and isNull(view.freezer_setpoint), "no freezer")
    T.truthy(isNull(view.water_filter_usage), "no water filter")

    -- In °F (the fridge's setpoint says so), 0 °F is a usual freezer setting.
    mock, key = start({ values = { FRIDGE_TEMP = "38", FRIDGE_SETPOINT = "37", FREEZER_TEMP = "0", FREEZER_SETPOINT = "0" } })
    view = fridge(mock, key)
    T.eq(view.fridge_setpoint, 2.8)
    T.eq(view.fridge_temperature, 3.3)
    T.eq(view.freezer_setpoint, -17.8)
    T.eq(view.freezer_temperature, -17.8)
end

function tests.the_unit_is_the_driver_s_else_the_setpoints_tell_else_the_project_s()
    local Refrigerator = require("src.adapters.refrigerator")
    T.eq(Refrigerator.unit({ TEMPERATURE_UNIT = "F", FRIDGE_SETPOINT = "3" }), "F", "the driver says")
    T.eq(Refrigerator.unit({ TEMPERATURE_UNIT = "c" }, "FAHRENHEIT"), "C")
    T.eq(Refrigerator.unit({ TEMPERATURE_UNIT = "", FRIDGE_SETPOINT = "37" }), "F")
    T.eq(Refrigerator.unit({ FRIDGE_SETPOINT = "7" }), "C")
    T.eq(Refrigerator.unit({ FRIDGE_SETPOINT = "0", FREEZER_SETPOINT = "-20" }), "C")
    T.eq(Refrigerator.unit({ FRIDGE_SETPOINT = "0", FREEZER_SETPOINT = "-4" }), "F")
    T.eq(Refrigerator.unit({ FRIDGE_SETPOINT = "0", FREEZER_SETPOINT = "0" }, "FAHRENHEIT"), "F", "nothing read yet: the project's")
    T.eq(Refrigerator.unit({}, "CELSIUS"), "C")
    T.eq(Refrigerator.unit({}), "C")
end

function tests.a_driver_that_says_what_it_reports_is_taken_at_its_word()
    local mock, key = start({
        values = { FRIDGE_TEMP = "38", FRIDGE_SETPOINT = "37", FREEZER_TEMP = "0", FREEZER_SETPOINT = "0", WATER_FILTER_USAGE = "0" },
        reported = { variables = "POWER_COOL,POWER_FREEZE,DOOR_OPEN,FRIDGE_TEMP,FRIDGE_SETPOINT,WATER_FILTER_USAGE", unit = "F" },
    })
    local view = fridge(mock, key)
    T.same(view.features, { "power_cool", "power_freeze" })
    T.eq(view.features_reported, true)
    T.eq(view.power_cool, false)
    T.truthy(isNull(view.sabbath_mode) and isNull(view.ice_maker), "features it does not have")
    T.truthy(isNull(view.freezer_temperature) and isNull(view.freezer_setpoint), "a one-door refrigerator")
    T.eq(view.fridge_setpoint, 2.8)
    T.eq(view.water_filter_usage, 0, "a new filter")
    T.eq(view.door_open, false)
    T.truthy(listening(mock, 140, 1013) and listening(mock, 140, 1014))

    -- Without a door sensor the door is not known.
    Mock.setRefrigerator(mock, 140, { REPORTED_VARIABLES = "POWER_COOL,FRIDGE_TEMP" })
    view = fridge(mock, key)
    T.truthy(isNull(view.door_open))
    T.same(view.features, { "power_cool" })
    -- Before the driver has read the refrigerator (after another was selected), as with 1.0.0.
    Mock.setRefrigerator(mock, 140, { REPORTED_VARIABLES = "" })
    view = fridge(mock, key)
    T.eq(view.features_reported, false)
    T.eq(#view.features, 4)
end

function tests.patch_switches_features_with_set_feature()
    local mock, key = start()
    local function patch(body)
        local before = #mock.commands
        local response = T.http(mock, "PATCH", "/v1/refrigerators/141", { key = key, body = body })
        T.eq(response.status, 202, response.body)
        return commandsSince(mock, before), response.json
    end
    local sent, answer = patch({ sabbath_mode = true })
    T.same(sent, { { device = 140, command = "SET_FEATURE", params = { Feature = "Sabbath Mode", State = "On" } } }, "to the driver, not its proxy")
    T.eq(answer.id, 141)
    T.eq(answer.sabbath_mode, false, "the answer is the last state reported: the refrigerator confirms later")
    sent = patch({ ice_maker = false, power_cool = true, power_freeze = false })
    T.same(sent, {
        { device = 140, command = "SET_FEATURE", params = { Feature = "Power Cool", State = "On" } },
        { device = 140, command = "SET_FEATURE", params = { Feature = "Power Freeze", State = "Off" } },
        { device = 140, command = "SET_FEATURE", params = { Feature = "Ice Maker", State = "Off" } },
    })
    -- The driver confirms through the variable.
    Mock.setRefrigerator(mock, 140, { SABBATH_MODE = "1" })
    T.eq(fridge(mock, key).sabbath_mode, true)
end

function tests.patch_checks_everything_before_sending_anything()
    local mock, key = start({ reported = { variables = "POWER_COOL,SABBATH_MODE,DOOR_OPEN", unit = "C" } })
    local before = #mock.commands
    local function refused(id, body, status, code)
        local response = T.http(mock, "PATCH", "/v1/refrigerators/" .. id, { key = key, body = body })
        T.eq(response.status, status, response.body)
        T.eq(response.json.code, code, response.body)
        return response.json
    end
    T.eq(refused(141, { sabbath_mode = "on" }, 400, "INVALID_FIELD").errors[1].field, "sabbath_mode")
    refused(141, { sabbath_mode = 1 }, 400, "INVALID_FIELD")
    refused(141, { door_open = true }, 400, "INVALID_FIELD")
    refused(141, { fridge_setpoint = 4 }, 400, "INVALID_FIELD")
    refused(141, {}, 400, "INVALID_REQUEST")
    T.contains(refused(141, { ice_maker = true }, 409, "FEATURE_NOT_SUPPORTED").detail, "Ice Maker")
    refused(141, { power_cool = true, ice_maker = true }, 409, "FEATURE_NOT_SUPPORTED")
    refused(142, { sabbath_mode = true }, 404, "NOT_FOUND")
    refused(20, { sabbath_mode = true }, 404, "NOT_FOUND")
    refused(99, { sabbath_mode = true }, 404, "NOT_FOUND")
    T.eq(#mock.commands, before, "nothing is sent")
end

function tests.members_switch_features_and_viewers_read()
    local mock, admin = start()
    local viewer = createKey(mock, admin, "viewer")
    local member = createKey(mock, admin, "member")
    T.eq(T.http(mock, "GET", "/v1/refrigerators", { key = viewer }).status, 200)
    T.eq(T.http(mock, "GET", "/v1/refrigerators/141", { key = viewer }).status, 200)
    local before = #mock.commands
    local refused = T.http(mock, "PATCH", "/v1/refrigerators/141", { key = viewer, body = { sabbath_mode = true } })
    T.eq(refused.status, 403)
    T.eq(refused.json.code, "FORBIDDEN")
    T.eq(#mock.commands, before)
    T.eq(T.http(mock, "PATCH", "/v1/refrigerators/141", { key = member, body = { sabbath_mode = true } }).status, 202)
    T.eq(#mock.commands, before + 1)
end

local function activity(mock, key)
    return T.http(mock, "GET", "/v1/activity?kind=door", { key = key }).json.items
end

function tests.a_door_left_open_is_noted_once_per_opening()
    local mock, key = start()
    local Activity = require("src.core.activity")
    local found = false
    for _, event in ipairs(mock.deviceEvents) do
        found = found or (event[1] == 140 and event[2] == 15)
    end
    T.truthy(found, "Door Left Open is watched on the driver")

    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "1" })
    T.eq(#activity(mock, key), 0, "an open door is not news")
    T.eq(Mock.fireDeviceEvent(mock, 140, 15), 1)
    Activity.flush()
    local entries = activity(mock, key)
    T.eq(#entries, 1)
    T.eq(entries[1].action, "left_open")
    T.eq(entries[1].what, "Refrigerator")
    T.eq(entries[1].room, "Kitchen")
    T.eq(entries[1].ids.device_id, 141)
    T.eq(entries[1].who.type, "controller")

    -- The driver says it again (it restarted): the same opening.
    Mock.fireDeviceEvent(mock, 140, 15)
    T.eq(#activity(mock, key), 1)
    -- Another event of the driver is not this one.
    Mock.fireDeviceEvent(mock, 140, 13)
    T.eq(#activity(mock, key), 1)
    -- Closed, then left open again: a new opening.
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "0" })
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "1" })
    Mock.fireDeviceEvent(mock, 140, 15)
    T.eq(#activity(mock, key), 2)
    -- A project refresh while it stays open keeps the opening.
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    Mock.fireDeviceEvent(mock, 140, 15)
    T.eq(#activity(mock, key), 2)
end

function tests.the_hook_runs_once_per_opening_with_the_refrigerator()
    local mock = start()
    local Refrigerator = require("src.adapters.refrigerator")
    local calls = {}
    Refrigerator.onDoorLeftOpen(function(device)
        calls[#calls + 1] = device.id
    end)
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "1" })
    Mock.fireDeviceEvent(mock, 140, 15)
    Mock.fireDeviceEvent(mock, 140, 15)
    T.same(calls, { 141 })
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "0" })
    Mock.fireDeviceEvent(mock, 140, 15)
    T.same(calls, { 141, 141 }, "the driver's word is enough: it fires only for an open door")
    -- A handler that fails never reaches the driver.
    Refrigerator.onDoorLeftOpen(function()
        error("boom")
    end)
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "0" })
    Mock.fireDeviceEvent(mock, 140, 15)
end

-- The hook says for how long at least the door has been open: since its DOOR_OPEN turned "1" (read
-- at the refrigerator driver's poll), kept through a project refresh; not known for a door that was
-- already open when DirectorLink started.
function tests.the_hook_says_since_when_the_door_has_been_open()
    local mock, key = start()
    local Clock = require("src.core.clock")
    local now = os.time()
    Clock.now = function()
        return now
    end
    local calls = {}
    local function listen()
        require("src.adapters.refrigerator").onDoorLeftOpen(function(_, seconds)
            calls[#calls + 1] = seconds or "unknown"
        end)
    end
    listen()
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "1" })
    now = now + 300
    Mock.setRefrigerator(mock, 140, { FRIDGE_TEMP = "5", DOOR_OPEN = "1" })
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    now = now + 90
    Mock.fireDeviceEvent(mock, 140, 15)
    T.same(calls, { 390 })

    -- Closed, then open again: from the new opening.
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "0" })
    now = now + 60
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "1" })
    now = now + 400
    Mock.fireDeviceEvent(mock, 140, 15)
    T.same(calls, { 390, 400 })

    -- Open when DirectorLink starts (a driver update): since when is not known.
    local updated = Mock.updateDriver(mock, mock.project)
    T.eq(T.http(updated, "GET", "/v1/refrigerators/141", { key = key }).json.door_open, true)
    listen()
    Mock.fireDeviceEvent(updated, 140, 15)
    T.same(calls, { 390, 400, "unknown" })
end

function tests.scenes_switch_refrigerator_features()
    local mock, key = start()
    local before = #mock.commands
    local ran = T.http(mock, "POST", "/v1/scenes/try", { key = key, body = { steps = {
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true } },
        { type = "refrigerators", room_id = 10, set = { ice_maker = false, power_cool = true } },
        { type = "refrigerators", set = { power_freeze = false } },
        { type = "lights", device_ids = { 20 }, set = { on = false } },
    } } })
    T.eq(ran.status, 202, ran.body)
    T.eq(ran.json.ran, 4)
    T.eq(ran.json.skipped, 0)
    T.eq(#ran.json.problems, 0)
    local sent = commandsSince(mock, before)
    T.eq(#sent, 5)
    T.same(sent[1], { device = 140, command = "SET_FEATURE", params = { Feature = "Sabbath Mode", State = "On" } })
    T.same(sent[2], { device = 140, command = "SET_FEATURE", params = { Feature = "Power Cool", State = "On" } })
    T.same(sent[3], { device = 140, command = "SET_FEATURE", params = { Feature = "Ice Maker", State = "Off" } })
    T.same(sent[4], { device = 140, command = "SET_FEATURE", params = { Feature = "Power Freeze", State = "Off" } })
    T.eq(sent[5].device, 20)

    local created = T.http(mock, "POST", "/v1/scenes", { key = key, body = { name = "Shabbat", steps = {
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true } },
    } } })
    T.eq(created.status, 201, created.body)
    T.same(created.json.steps[1], { type = "refrigerators", room_id = Json.null, device_ids = { 141 }, set = { sabbath_mode = true } })
    local member = createKey(mock, key, "member")
    local viewer = createKey(mock, key, "viewer")
    T.eq(T.http(mock, "POST", "/v1/scenes/" .. created.json.id .. "/run", { key = viewer }).status, 403)
    local run = T.http(mock, "POST", "/v1/scenes/" .. created.json.id .. "/run", { key = member })
    T.eq(run.status, 202)
    T.eq(run.json.ran, 1, "members run them: no door access needed")
end

function tests.a_feature_a_refrigerator_lacks_is_left_out_of_a_scene()
    local mock, key = start({ reported = { variables = "POWER_COOL,SABBATH_MODE", unit = "C" } })
    local before = #mock.commands
    local ran = T.http(mock, "POST", "/v1/scenes/try", { key = key, body = { steps = {
        { type = "refrigerators", device_ids = { 141 }, set = { ice_maker = true } },
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true, ice_maker = false } },
    } } }).json
    T.eq(ran.ran, 1)
    T.eq(ran.skipped, 1)
    T.eq(ran.problems[1].outcome, "skipped")
    T.eq(ran.problems[1].code, "NOT_SUPPORTED")
    T.contains(ran.problems[1].detail, "no Ice Maker")
    T.eq(ran.problems[2].outcome, "partial", "sabbath mode still went")
    T.same(commandsSince(mock, before), { { device = 140, command = "SET_FEATURE", params = { Feature = "Sabbath Mode", State = "On" } } })

    -- A refrigerator removed in Composer is skipped, the rest still runs.
    local scene = T.http(mock, "POST", "/v1/scenes", { key = key, body = { name = "Shabbat", steps = {
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true } },
        { type = "lights", device_ids = { 20 }, set = { on = true } },
    } } }).json
    for id = 140, 145 do
        Mock.removeDevice(mock.project, id)
    end
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    local run = T.http(mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = key }).json
    T.eq(run.ran, 1)
    T.eq(run.skipped, 1)
    T.eq(run.problems[1].code, "NOT_FOUND")
end

function tests.refrigerator_steps_are_checked()
    local mock, key = start()
    local before = #mock.commands
    local function refused(set, deviceIds)
        local answer = T.http(mock, "POST", "/v1/scenes", { key = key, body = { name = "Bad", steps = { { type = "refrigerators", device_ids = deviceIds, set = set } } } }).json
        T.eq(answer.code, "INVALID_FIELD", Json.encode(set))
        return answer
    end
    T.eq(refused({ sabbath_mode = "on" }).errors[1].field, "steps[0].set.sabbath_mode")
    refused({ sabbath_mode = 1 })
    refused({})
    T.eq(refused({ door_open = true }).errors[1].field, "steps[0].set.door_open")
    refused({ on = true })
    refused({ sabbath_mode = true }, { 142 })
    refused({ sabbath_mode = true }, { 20 })
    T.eq(#T.http(mock, "GET", "/v1/scenes", { key = key }).json.items, 0, "nothing is saved")
    T.eq(#mock.commands, before, "nothing is sent")
end

function tests.a_shabbat_schedule_switches_sabbath_mode()
    local mock, admin = start()
    local now = os.time()
    local Clock = require("src.core.clock")
    Clock.now = function()
        return now
    end
    local Scheduler = require("src.core.scheduler")
    local fields = os.date("*t", now + 86400)
    fields.hour, fields.min, fields.sec = 17, 30, 0
    local runAt = os.time(fields)
    local scene = T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Shabbat fridge", steps = {
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true } },
    } } }).json
    local created = T.http(mock, "POST", "/v1/schedules", { key = admin, body = {
        scene_id = scene.id, trigger = { type = "time", at = "17:30" }, days = { fields.wday - 1 },
    } })
    T.eq(created.status, 201, created.body)
    local before = #mock.commands
    now = runAt + 5
    T.eq(Scheduler.tick(), 1)
    T.same(commandsSince(mock, before), { { device = 140, command = "SET_FEATURE", params = { Feature = "Sabbath Mode", State = "On" } } }, "schedules run as members")
    T.eq(T.http(mock, "GET", "/v1/schedules/" .. created.json.id, { key = admin }).json.last_run.ran, 1)
end

function tests.the_composer_printout_shows_refrigerator_steps()
    local mock, admin = start()
    T.http(mock, "POST", "/v1/scenes", { key = admin, body = { name = "Fridge", steps = {
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true, ice_maker = false } },
    } } })
    local lines = {}
    local realPrint = print
    _G.print = function(line)
        lines[#lines + 1] = line
    end
    ExecuteCommand("LUA_ACTION", { ACTION = "PRINT_AUTOMATION" })
    _G.print = realPrint
    T.contains(table.concat(lines, "\n"), "Refrigerator (141) -> sabbath mode on, ice maker off")
end

local function storedScenes(mock)
    return Json.decode((mock.persist.directorlink_scenes:gsub("^json:", "")))
end

-- DirectorLink 1.6.0 does not know refrigerator steps: it leaves them out when it loads the scenes
-- (src/core/scenes.lua: not one of its TYPES), and its next save writes the scenes without them.
-- Back on 1.7.0 they are put back where they were.
function tests.refrigerator_steps_come_back_after_a_downgrade()
    local mock, key = start()
    local scene = T.http(mock, "POST", "/v1/scenes", { key = key, body = { name = "Shabbat", steps = {
        { type = "lights", device_ids = { 20 }, set = { on = false } },
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true } },
        { type = "climate", device_ids = { 30 }, set = { mode = "off" } },
    } } }).json
    T.truthy(mock.persist.directorlink_scene_steps, "kept apart too")
    T.eq(storedScenes(mock).steps_kept, true, "the scenes say 1.7.0 wrote them")

    -- What 1.6.0 does, with its own scenes module: the step is left out as it loads.
    local Scenes = require("src.core.scenes")
    Scenes.TYPES.refrigerators = nil
    local loaded = Scenes.read(storedScenes(mock))
    Scenes.TYPES.refrigerators = true
    T.eq(#loaded[1].steps, 2, "1.6.0 runs the other steps")
    -- Its next save (any scene changed) writes them without it, as { version, scenes } only.
    local data = storedScenes(mock)
    table.remove(data.scenes[1].steps, 2)
    data.scenes[1].name = "Shabbat (changed in 1.6.0)"
    data.steps_kept = nil
    mock.persist.directorlink_scenes = "json:" .. Json.encode(data)

    local updated = Mock.updateDriver(mock, mock.project)
    local key2 = key
    local back = T.http(updated, "GET", "/v1/scenes/" .. scene.id, { key = key2 }).json
    T.eq(back.name, "Shabbat (changed in 1.6.0)", "the change made in 1.6.0 stays")
    T.eq(#back.steps, 3)
    T.eq(back.steps[2].type, "refrigerators", "in its place")
    T.same(back.steps[2].set, { sabbath_mode = true })
    T.eq(#storedScenes(updated).scenes[1].steps, 3, "and saved again")
    T.eq(storedScenes(updated).steps_kept, true)
    T.contains(table.concat(updated.debugLog, "\n"), "put back")

    -- Removed in 1.7.0, it does not come back.
    T.eq(T.http(updated, "PATCH", "/v1/scenes/" .. scene.id, { key = key2, body = { steps = {
        { type = "lights", device_ids = { 20 }, set = { on = false } },
    } } }).status, 200)
    local again = Mock.updateDriver(updated, updated.project)
    T.eq(#T.http(again, "GET", "/v1/scenes/" .. scene.id, { key = key2 }).json.steps, 1)
end

-- A step removed in 1.7.0 stays removed when the copy kept apart could not be written then: the
-- scenes record 1.7.0 wrote says so, and only one an older version wrote gets steps back.
function tests.a_refrigerator_step_removed_stays_removed_when_its_copy_could_not_be_written()
    local mock, key = start()
    local scene = T.http(mock, "POST", "/v1/scenes", { key = key, body = { name = "Evening", steps = {
        { type = "lights", device_ids = { 20 }, set = { on = false } },
        { type = "refrigerators", device_ids = { 141 }, set = { sabbath_mode = true } },
    } } }).json
    local kept = mock.persist.directorlink_scene_steps
    local write = C4.PersistSetValue
    C4.PersistSetValue = function(self, name, value, encrypted)
        if name == "directorlink_scene_steps" then
            error("persist failed")
        end
        return write(self, name, value, encrypted)
    end
    local ok, patched = pcall(T.http, mock, "PATCH", "/v1/scenes/" .. scene.id, { key = key, body = { steps = {
        { type = "lights", device_ids = { 20 }, set = { on = false } },
    } } })
    C4.PersistSetValue = write
    T.truthy(ok, patched)
    T.eq(patched.status, 200, patched.body)
    T.eq(mock.persist.directorlink_scene_steps, kept, "the copy still has the step")
    T.contains(table.concat(mock.debugLog, "\n"), "could not keep the newer scene steps apart")

    local restarted = Mock.updateDriver(mock, mock.project)
    local steps = T.http(restarted, "GET", "/v1/scenes/" .. scene.id, { key = key }).json.steps
    T.eq(#steps, 1, "not put back")
    T.eq(steps[1].type, "lights")
end

function tests.a_home_without_refrigerator_steps_keeps_nothing_apart()
    local mock, key = start()
    T.eq(T.http(mock, "POST", "/v1/scenes", { key = key, body = { name = "Lights", steps = {
        { type = "lights", set = { on = false } },
    } } }).status, 201)
    T.eq(mock.persist.directorlink_scene_steps, nil)
end

-- The dev server's project has the refrigerator too (driver 1.0.0).
function tests.the_demo_project_has_a_refrigerator()
    local mock = Mock.startDriver(Mock.demoProject())
    T.contains(mock.properties["Inventory"], "1 refrigerators")
    local key = T.pair(mock)
    T.eq(T.http(mock, "GET", "/v1/refrigerators/141", { key = key }).json.fridge_temperature, 3)
end

return tests
