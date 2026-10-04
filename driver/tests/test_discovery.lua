-- Picking up Composer changes while the driver runs: the action Refresh Project and Director's
-- project events (src/control4/project_events.lua), against the fake Director's project changed
-- the way an installer changes it in Composer.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")

local tests = {}

local function start(prepare)
    local mock = Mock.startDriver(nil, nil, nil, prepare)
    local key = T.pair(mock)
    return mock, key
end

local function get(mock, key, path)
    return T.http(mock, "GET", path, { key = key })
end

local function refresh()
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
end

-- The driver's log entries with this message (every level the driver records).
local function logged(message)
    local found = {}
    for _, entry in ipairs(require("src.core.log").query({ limit = 500 })) do
        if entry.message == message then
            found[#found + 1] = entry
        end
    end
    return found
end

local function byId(items, id)
    for _, item in ipairs(items) do
        if item.id == id then
            return item
        end
    end
end

-- A system event from Director; returns the timer it set, if it set one.
local function event(mock, name, params)
    local before = #mock.timers
    T.truthy(Mock.systemEvent(mock, name, params), name .. " is registered")
    return #mock.timers > before and mock.timers[#mock.timers] or nil
end

local function fire(timer)
    T.truthy(timer and not timer.cancelled and not timer.fired, "the timer is waiting")
    timer.fired = true
    timer.callback()
end

-- Timers that have neither fired nor been cancelled.
local function waitingTimers(mock)
    local count = 0
    for _, timer in ipairs(mock.timers) do
        if not timer.fired and not timer.cancelled then
            count = count + 1
        end
    end
    return count
end

-- The driver's log entries with this message and level.
local function loggedAt(message, level)
    local count = 0
    for _, entry in ipairs(logged(message)) do
        if entry.level == level then
            count = count + 1
        end
    end
    return count
end

function tests.the_composer_action_picks_up_moved_renamed_added_and_removed_devices()
    local mock, key = start()
    T.eq(get(mock, key, "/v1/blinds/51").json.room.id, 10, "the kitchen shutter starts in the kitchen")
    local roomsBefore = get(mock, key, "/v1/rooms").json.items

    Mock.moveDevice(mock.project, 51, 11)
    Mock.renameDevice(mock.project, 20, "Island")
    Mock.addLight(mock.project, 23, 109, 10, "Pantry Light", 60)
    Mock.removeDevice(mock.project, 60)
    Mock.removeDevice(mock.project, 107)
    T.eq(get(mock, key, "/v1/blinds/51").json.room.id, 10, "nothing changes before the refresh")

    refresh()
    T.eq(mock.properties["Status"], "Ready")
    local blind = get(mock, key, "/v1/blinds/51").json
    T.eq(blind.room.id, 11)
    T.eq(blind.room.name, "Living Room")
    T.eq(#get(mock, key, "/v1/blinds?room_id=11").json.items, 2)
    T.eq(get(mock, key, "/v1/lights/20").json.name, "Island")
    local added = get(mock, key, "/v1/lights/23").json
    T.eq(added.name, "Pantry Light")
    T.eq(added.brightness, 60)
    T.eq(added.room.id, 10)
    T.eq(get(mock, key, "/v1/cameras/60").status, 404)
    local devices = get(mock, key, "/v1/devices").json.items
    T.truthy(byId(devices, 23) and not byId(devices, 60), "the device list follows")
    local rooms = get(mock, key, "/v1/rooms").json.items
    T.eq(byId(rooms, 10).device_count, byId(roomsBefore, 10).device_count - 1, "kitchen: shutter and camera out, a light in")
    T.eq(byId(rooms, 11).device_count, byId(roomsBefore, 11).device_count + 1)
    T.eq(mock.properties["Inventory"], "2 rooms, 14 devices, 4 lights, 1 thermostats, 0 fans, 2 blinds, 2 cameras, 1 relays, 1 doorbells")

    local entry = logged("project rediscovered")[1]
    T.truthy(entry, "the refresh is logged")
    T.eq(entry.data.reason, "Composer action")
    T.eq(entry.data.moved, 1)
    T.eq(entry.data.renamed, 1)
    T.eq(entry.data.added, 1)
    T.eq(entry.data.removed, 1)
    T.eq(entry.data.devices, 14)
end

function tests.a_room_removed_in_composer_goes_and_scenes_follow_by_id()
    local mock, key = start()
    T.http(mock, "PATCH", "/v1/rooms/10", { key = key, body = { names = { he = "מטבח" } } })
    local kitchen = T.http(mock, "POST", "/v1/scenes", { key = key, body = {
        name = "Kitchen closed", steps = { { type = "blinds", room_id = 10, set = { position = 0 } } },
    } }).json
    local chosen = T.http(mock, "POST", "/v1/scenes", { key = key, body = {
        name = "Shutter and lamp", steps = {
            { type = "blinds", room_id = 10, device_ids = { 51 }, set = { position = 100 } },
            { type = "lights", device_ids = { 22 }, set = { on = true } },
        },
    } }).json

    for id, device in pairs(mock.project.devices) do
        if device.roomId == 10 then
            Mock.moveDevice(mock.project, id, 11)
        end
    end
    Mock.removeRoom(mock.project, 10)
    Mock.removeDevice(mock.project, 22)
    Mock.removeDevice(mock.project, 103)
    refresh()

    local rooms = get(mock, key, "/v1/rooms").json.items
    T.eq(#rooms, 1)
    T.eq(rooms[1].id, 11)
    T.eq(get(mock, key, "/v1/rooms/10").status, 404)
    T.eq(T.http(mock, "PUT", "/v1/rooms/order", { key = key, body = { room_ids = { 10 } } }).status, 400, "a removed room cannot be ordered")

    local sent = #mock.commands
    local ran = T.http(mock, "POST", "/v1/scenes/" .. kitchen.id .. "/run", { key = key }).json
    T.eq(ran.ran, 0, "the kitchen has no blinds any more")
    T.eq(#mock.commands, sent)
    local second = T.http(mock, "POST", "/v1/scenes/" .. chosen.id .. "/run", { key = key }).json
    T.eq(second.ran, 1, "the shutter, chosen by id, still runs in its new room")
    T.eq(second.skipped, 1)
    T.eq(second.problems[1].device_id, 22)
    T.eq(second.problems[1].code, "NOT_FOUND")
    T.same(mock.commands[#mock.commands], { device = 51, command = "SET_LEVEL_TARGET", params = { LEVEL_TARGET = 100 } })
    T.eq(require("src.core.room_names").get(10).he, "מטבח", "its names stay stored, should the room come back")
end

function tests.project_events_are_registered_for_every_device()
    local mock = start()
    local registered = {}
    for _, event in ipairs(mock.systemEvents) do
        T.eq(event[2], 0, "on every device")
        registered[event[1]] = true
    end
    for _, name in ipairs({ "OnItemAdded", "OnItemRemoved", "OnItemNameChanged", "OnItemMoved", "OnPIP", "OnDriverAdded", "OnProjectLoaded" }) do
        T.truthy(registered[Mock.SYSTEM_EVENTS[name]], name)
    end
    T.truthy(not registered[Mock.SYSTEM_EVENTS.OnProjectChanged], "not the deprecated one")
    T.truthy(not registered[Mock.SYSTEM_EVENTS.OnItemDataChanged], "not data changes, which may come all the time")
    T.eq(#mock.systemEvents, 7)
    refresh()
    T.eq(#mock.systemEvents, 7, "registered once")
end

function tests.composer_changes_are_read_five_seconds_after_the_last_event()
    local mock, key = start(function()
        Properties["Log Level"] = "Debug"
    end)
    Mock.moveDevice(mock.project, 51, 11)
    local first = event(mock, "OnItemMoved", { iditem = 51, idparent = 11 })
    T.eq(first.delay, 5000)
    T.eq(get(mock, key, "/v1/blinds/51").json.room.id, 10, "not yet")
    Mock.renameDevice(mock.project, 51, "Terrace Shutter")
    local second = event(mock, "OnItemNameChanged", { iditem = 51 })
    T.truthy(first.cancelled, "each event starts the wait again")
    event(mock, "OnItemMoved", { iditem = 52 })
    T.truthy(second.cancelled)
    local last = mock.timers[#mock.timers]
    fire(last)

    local blind = get(mock, key, "/v1/blinds/51").json
    T.eq(blind.room.id, 11)
    T.eq(blind.name, "Terrace Shutter")
    local done = logged("project rediscovered")
    T.eq(#done, 1, "one refresh for the burst")
    T.eq(done[1].data.reason, "Composer changes (OnItemMoved, OnItemNameChanged)")
    T.eq(done[1].data.moved, 1)
    T.eq(done[1].data.renamed, 1)
    local raw = logged("project event")
    T.eq(#raw, 3, "every payload is logged at debug level")
    T.contains(raw[1].data.data, '<param name="iditem" type="ulong">51</param>')
end

function tests.a_stream_of_events_waits_at_most_thirty_seconds()
    local mock = start()
    local first = event(mock, "OnItemAdded", { iditem = 200 })
    T.eq(first.delay, 5000)
    mock.clock = mock.clock + 26000
    local later = event(mock, "OnItemAdded", { iditem = 201 })
    T.truthy(later.delay < 5000 and later.delay > 3000, "what is left of the 30 s: " .. tostring(later.delay))
    mock.clock = mock.clock + 4500
    local timers = #mock.timers
    event(mock, "OnItemAdded", { iditem = 202 })
    T.eq(#logged("project rediscovered"), 1, "past 30 s the project is read at once")
    T.eq(#mock.timers, timers, "without another wait")
    T.truthy(later.cancelled)
    local next = event(mock, "OnItemRemoved", { iditem = 203 })
    T.eq(next.delay, 5000, "and the next change waits again")
end

function tests.events_about_directorlink_itself_are_ignored()
    local mock = start()
    T.eq(event(mock, "OnItemNameChanged", { iditem = 572 }), nil, "DirectorLink renamed: nothing to read")
    T.eq(event(mock, "OnItemMoved", { iditem = 572, idparent = 11 }), nil)
    T.truthy(event(mock, "OnItemMoved", { iditem = 51, idparent = 11 }), "any other device counts")
    T.truthy(event(mock, "OnPIP", {}), "Refresh Navigators always counts")
    OnSystemEvent("not an event at all")
    OnSystemEvent(nil)
    T.eq(mock.properties["Status"], "Ready")
end

-- Director sends only the events registered, so a payload whose name is not known here is still a
-- change; it is logged first, whatever it is.
function tests.an_event_without_a_known_name_still_counts()
    local mock, key = start(function()
        Properties["Log Level"] = "Debug"
    end)
    Mock.moveDevice(mock.project, 51, 11)
    for _, payload in ipairs({ '<event><param name="iditem">51</param></event>', "", 12, {} }) do
        local before = #mock.timers
        OnSystemEvent(payload)
        T.eq(#mock.timers, before + 1, "a refresh waits: " .. tostring(payload))
        T.eq(mock.timers[#mock.timers].delay, 5000)
    end
    local raw = logged("project event")
    T.eq(#raw, 4, "each payload is logged")
    T.eq(raw[1].data.event, "unnamed event")
    T.contains(raw[1].data.data, '<param name="iditem">51</param>')
    fire(mock.timers[#mock.timers])
    T.eq(get(mock, key, "/v1/blinds/51").json.room.id, 11)
    T.eq(logged("project rediscovered")[1].data.reason, "Composer changes (unnamed event)")

    local before = #mock.timers
    OnSystemEvent('<event><param name="iditem">572</param></event>')
    T.eq(#mock.timers, before, "one about DirectorLink alone is still left out")
    T.eq(#logged("project event"), 5)
end

-- A refresh started by events that fails (Director busy, or answering with an empty project while it
-- loads one) is tried once more a minute later.
function tests.a_refresh_after_events_that_fails_is_tried_again_once()
    local mock, key = start()
    Mock.moveDevice(mock.project, 51, 11)
    local devices = C4.GetDevices
    function C4:GetDevices()
        error("Director is busy")
    end
    fire(event(mock, "OnItemMoved", { iditem = 51, idparent = 11 }))
    T.eq(#logged("project refresh failed; the project read before stays in use"), 1)
    local retry = mock.timers[#mock.timers]
    T.truthy(not retry.fired and not retry.cancelled, "a second try waits")
    T.eq(retry.delay, 60000)
    T.eq(logged("the project refresh is tried again")[1].data.events, "OnItemMoved")
    T.eq(get(mock, key, "/v1/blinds/51").json.room.id, 10, "the project read before stays in use")

    -- It fails too: no third try (the next change, or the action, reads the project).
    local waiting = waitingTimers(mock)
    fire(retry)
    T.eq(#logged("project refresh failed; the project read before stays in use"), 2)
    T.eq(waitingTimers(mock), waiting - 1)

    -- A new change gets a second try of its own; this one works.
    fire(event(mock, "OnItemNameChanged", { iditem = 20 }))
    C4.GetDevices = devices
    fire(mock.timers[#mock.timers])
    T.eq(get(mock, key, "/v1/blinds/51").json.room.id, 11)
    T.eq(logged("project rediscovered")[1].data.reason, "Composer changes (OnItemNameChanged)")
    T.eq(logged("project rediscovered")[1].data.moved, 1)

    -- The action is not tried again: whoever ran it sees what happened.
    function C4:GetDevices()
        error("Director is busy")
    end
    waiting = waitingTimers(mock)
    refresh()
    T.eq(#logged("project refresh failed; the project read before stays in use"), 4)
    T.eq(waitingTimers(mock), waiting)
    C4.GetDevices = devices
end

-- OnPIP alone (Refresh Navigators, and changes to bindings, names or media) reads the project at
-- most every two minutes, and once more at their end; other events and the action are not held back.
function tests.refresh_navigators_alone_reads_the_project_at_most_every_two_minutes()
    local mock = start()
    local first = event(mock, "OnPIP", {})
    T.eq(first.delay, 5000)
    fire(first)
    T.eq(#logged("project rediscovered"), 1)

    mock.clock = mock.clock + 10000
    local later = event(mock, "OnPIP", {})
    T.truthy(later.delay > 105000 and later.delay <= 110000, "at the end of the two minutes: " .. tostring(later.delay))
    T.eq(event(mock, "OnPIP", {}), nil, "the next ones wait for the same refresh")
    fire(later)
    T.eq(#logged("project rediscovered"), 2)
    T.eq(logged("project rediscovered")[2].data.reason, "Composer changes (OnPIP)")

    mock.clock = mock.clock + 1000
    local held = event(mock, "OnPIP", {})
    T.truthy(held.delay > 100000)
    local moved = event(mock, "OnItemMoved", { iditem = 51 })
    T.eq(moved.delay, 5000, "an item event is not held back")
    T.truthy(held.cancelled)
    fire(moved)
    T.eq(logged("project rediscovered")[3].data.reason, "Composer changes (OnPIP, OnItemMoved)")
    refresh()
    T.eq(#logged("project rediscovered"), 4, "nor the action")

    mock.clock = mock.clock + 120000
    T.eq(event(mock, "OnPIP", {}).delay, 5000, "two minutes later OnPIP alone reads it as before")
end

-- A refresh initializes every device again: what the adapters log about each one goes to debug
-- level then (on the contributor's home, 22 thermostat lines per refresh pushed door openings out
-- of the log). The first discovery logs it at info level.
function tests.a_refresh_logs_the_devices_again_at_debug_level_only()
    local mock = Mock.startDriver(Mock.demoProject(), nil, nil, function()
        Properties["Log Level"] = "Debug"
    end)
    local function thermostats(level)
        return loggedAt("initialized thermostat", level) + loggedAt("initialized dual-setpoint thermostat", level)
    end
    T.eq(thermostats("info"), 3, "the first discovery")
    T.eq(thermostats("debug"), 0)
    T.eq(loggedAt("initialized fan", "info"), 2, "fans too (1.2.0)")
    refresh()
    T.eq(thermostats("info"), 3, "not again at info level")
    T.eq(thermostats("debug"), 3, "but at debug level")
    T.eq(loggedAt("initialized fan", "info"), 2)
    T.eq(loggedAt("initialized fan", "debug"), 2)
    T.eq(loggedAt("project rediscovered", "info"), 1)
    T.eq(loggedAt("initialized 20 controllable proxies", "info"), 2, "the count stays at info level")
    T.eq(loggedAt("unsupported device 27: Light State variable (1000) is unavailable", "info"), 2, "and devices that failed")
    local Log = require("src.core.log")
    T.eq(Log.info("test", "after the refresh").level, "info", "and the log is as before")
    T.eq(mock.properties["Status"], "Ready")
end

function tests.the_action_reads_the_project_now_instead_of_waiting()
    local mock, key = start()
    Mock.moveDevice(mock.project, 51, 11)
    local waiting = event(mock, "OnItemMoved", { iditem = 51 })
    refresh()
    T.eq(get(mock, key, "/v1/blinds/51").json.room.id, 11)
    T.truthy(waiting.cancelled, "the refresh the event waited for is not needed any more")
    T.eq(#logged("project rediscovered"), 1)
end

function tests.without_project_events_the_action_still_works()
    for _, prepare in ipairs({
        function()
            C4SystemEvents = nil
        end,
        function()
            function C4:RegisterSystemEvent()
                error("not available")
            end
        end,
    }) do
        local mock, key = start(prepare)
        T.eq(#mock.systemEvents, 0)
        T.eq(#logged("Director does not announce Composer changes to DirectorLink; after changing the project, run the action Refresh Project"), 1)
        Mock.moveDevice(mock.project, 51, 11)
        refresh()
        refresh()
        T.eq(get(mock, key, "/v1/blinds/51").json.room.id, 11)
        T.eq(#logged("Director does not announce Composer changes to DirectorLink; after changing the project, run the action Refresh Project"), 1, "said once")
        T.eq(mock.properties["Status"], "Ready")
    end
end

function tests.listeners_and_device_events_fire_once_after_several_refreshes()
    local mock, key = start()
    local listeners = #mock.listeners
    refresh()
    refresh()
    refresh()
    T.eq(#mock.listeners, listeners, "variables are watched once")
    local pairs = {}
    for _, registration in ipairs(mock.deviceEvents) do
        local name = registration[1] .. ":" .. registration[2]
        T.truthy(not pairs[name], "device event " .. name .. " registered once")
        pairs[name] = true
    end

    T.eq(Mock.changeVariable(mock, 20, 1001, "55"), 1)
    T.eq(get(mock, key, "/v1/lights/20").json.brightness, 55)
    T.eq(Mock.fireDeviceEvent(mock, 110, 102), 1, "a ring arrives once")
    T.eq(#get(mock, key, "/v1/doorbells/93").json.events, 1)
    T.eq(Mock.fireDeviceEvent(mock, 70, 3), 1)
    T.eq(get(mock, key, "/v1/relays/70").json.state, "open")
end

function tests.a_refresh_keeps_what_director_cannot_tell_again()
    local mock, key = start()
    Mock.fireDeviceEvent(mock, 70, 3)
    Mock.fireDeviceEvent(mock, 110, 102)
    Mock.fireDeviceEvent(mock, 110, 103)
    local before = get(mock, key, "/v1/doorbells/93").json
    T.truthy(before.last_ring_at ~= Json.null)
    refresh()
    T.eq(get(mock, key, "/v1/relays/70").json.state, "open", "the relay's last state")
    local after = get(mock, key, "/v1/doorbells/93").json
    T.eq(after.last_ring_at, before.last_ring_at, "the ring")
    T.same(after.events, before.events)
    T.eq(after.connected, true)

    -- A device that is not the same kind any more starts afresh.
    mock.project.devices[70].driverFileName = "unknown_relay.c4z"
    refresh()
    T.eq(get(mock, key, "/v1/relays/70").status, 404)
    mock.project.devices[70].driverFileName = "knx_contact_relay.c4z"
    refresh()
    T.eq(get(mock, key, "/v1/relays/70").json.state, Json.null)
end

function tests.snapshots_asked_for_before_a_refresh_are_answered()
    local mock, key = start()
    local held = {}
    local url = C4.url
    function C4:url()
        local transfer = url(self)
        local send = transfer.Get
        function transfer:Get(target, headers)
            held[#held + 1] = function()
                send(self, target, headers)
            end
            return self
        end
        return transfer
    end
    local waiting = {}
    for index = 1, 5 do
        waiting[index] = T.http(mock, "GET", "/v1/cameras/" .. (index % 2 == 0 and 61 or 60) .. "/snapshot", { key = key })
        T.eq(waiting[index].status, nil, "fetched later")
    end
    T.eq(#held, 3, "three at once, two waiting")
    refresh()
    while #held > 0 do
        table.remove(held, 1)()
    end
    for index = 1, 5 do
        local answer = T.response(mock, waiting[index].handle)
        T.eq(answer.status, 200, "snapshot " .. index)
    end
    T.eq(get(mock, key, "/v1/cameras/60/snapshot").status, nil, "and the limit still holds")
    T.eq(#held, 1)
end

function tests.a_failed_or_empty_read_keeps_the_project()
    local mock, key = start()
    local devices = C4.GetDevices
    function C4:GetDevices()
        error("Director is busy")
    end
    refresh()
    T.eq(mock.properties["Status"], "Ready", "the status stays")
    T.eq(#get(mock, key, "/v1/blinds").json.items, 2, "the project read before is still served")
    local failed = logged("project refresh failed; the project read before stays in use")
    T.eq(#failed, 1)
    T.contains(failed[1].data.error, "Director is busy")

    function C4:GetDevices()
        return {}
    end
    refresh()
    T.eq(#get(mock, key, "/v1/blinds").json.items, 2, "an empty project while Director loads one is not taken")
    T.eq(#logged("project refresh failed; the project read before stays in use"), 2)
    C4.GetDevices = devices
    refresh()
    T.eq(#logged("project rediscovered"), 1)
end

function tests.a_failed_start_is_mended_by_the_action()
    local mock = Mock.startDriver(nil, nil, nil, function()
        function C4:GetDevices()
            error("not ready")
        end
    end)
    T.contains(mock.properties["Status"], "Error: Discovery failed")
    T.eq(#mock.systemEvents, 0, "events are watched once a project was read")
    C4.GetDevices = function()
        return mock.project.devices
    end
    refresh()
    T.eq(mock.properties["Status"], "Ready")
    T.contains(mock.properties["Inventory"], "2 blinds")
    T.eq(#mock.systemEvents, 7)
end

function tests.a_door_pulse_across_a_refresh_still_releases()
    local mock, key = start()
    Properties["Door Control"] = "Enabled"
    T.eq(T.http(mock, "POST", "/v1/relays/70/pulse", { key = key }).status, 202)
    T.eq(mock.commands[#mock.commands].command, "Close Relay")
    refresh()
    Mock.fireTimers(mock)
    local released = false
    for _, command in ipairs(mock.commands) do
        released = released or (command.device == 70 and command.command == "Open Relay")
    end
    T.truthy(released, "the relay is released after the pulse")
end

function tests.composer_properties_follow_a_refresh()
    local mock = start()
    mock.properties["Inventory"] = "stale"
    mock.properties["Schedule Status"] = "stale"
    mock.properties["Status"] = "stale"
    refresh()
    T.eq(mock.properties["Inventory"], "2 rooms, 14 devices, 3 lights, 1 thermostats, 0 fans, 2 blinds, 3 cameras, 1 relays, 1 doorbells")
    T.eq(mock.properties["Schedule Status"], "None")
    T.eq(mock.properties["Status"], "Ready")
end

return tests
