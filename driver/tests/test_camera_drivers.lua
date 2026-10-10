-- DirectorLink's camera agreement (1.10.0, ADR-065, docs/CAMERA_DRIVERS.md, src/control4/camera_drivers.lua):
-- a camera driver of DirectorLink Drivers says so with DIRECTORLINK_CAMERA ("1") and
-- DIRECTORLINK_CAMERA_KIND ("camera" or "doorbell"); a detection is LAST_ALERT and its event named
-- Alert, a doorbell press LAST_RING and its event named Ring. DirectorLink finds them by name, sets a
-- camera up again when its marker comes later or its driver is updated, makes a doorbell camera a
-- doorbell (listed, ringing, its ring alert), and keeps knowing the DirectorLink · Hikvision drivers
-- by their file name until they set the marker, never handling one twice.
-- The fake agreement drivers are Mock.withAgreementCameras: 67 "Porch" (a camera, Living Room, driver
-- 157) and 68 "Entrance" (a doorbell, Kitchen, driver 158); their Alert is event 7, Ring 8.

local T = require("helpers")
local Json = require("src.core.json")
local Base64 = require("src.core.base64")
local Mock = require("c4mock")
local Harness = require("relay_harness")

local tests = {}

local function count(map)
    local total = 0
    for _ in pairs(map or {}) do
        total = total + 1
    end
    return total
end

local function hmacHex(key, data)
    return C4:HMAC("SHA256", key, data, { key_encoding = "HEX", data_encoding = "NONE", return_encoding = "HEX" }):lower()
end

-- Opens `sealed` as the device of `apiKey` does (its service worker).
local function open(apiKey, keyId, sealed)
    local alertKey = require("src.cloud.alerts").alertKey(require("src.cloud.lock").deviceKey(apiKey))
    local enc = hmacHex(alertKey, "enc")
    local plaintext = C4:Decrypt("AES-256-CBC", enc, Base64.toHex(Base64.decode(sealed.iv)), Base64.toHex(Base64.decode(sealed.ct)), {
        key_encoding = "HEX",
        iv_encoding = "HEX",
        data_encoding = "HEX",
        return_encoding = "NONE",
        padding = true,
    })
    T.truthy(keyId, "a key id")
    return Json.decode(plaintext)
end

-- A connected driver with the clock in the test's hands (as test_alerts.lua): { mock, connection,
-- clock, admin, adminId, keys = { name -> { key, id } }, add(name, role, access), on(name, kinds),
-- notified() }.
local function home(project, setup)
    local mock = Mock.startDriver(project, nil, nil, setup)
    local _, connection = Harness.connected({ mock = mock })
    local Clock = require("src.core.clock")
    local clock = { now = os.time() }
    Clock.now = function()
        return clock.now
    end
    local admin = T.pair(mock, "Chrome on Windows")
    local adminId = T.http(mock, "GET", "/v1/api-keys/current", { key = admin }).json.id
    local state = { mock = mock, connection = connection, clock = clock, admin = admin, adminId = adminId, keys = {} }
    state.keys.admin = { key = admin, id = adminId }
    function state.add(name, role, access)
        local created = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = name, role = role, access = access } })
        T.eq(created.status, 201, created.body)
        state.keys[name] = { key = created.json.key, id = created.json.id }
        return created.json.key, created.json.id
    end
    function state.on(name, kinds)
        local answer = T.http(mock, "PUT", "/v1/alerts/choices", { key = state.keys[name].key, body = { on = true, kinds = kinds } })
        T.eq(answer.status, 200, answer.body)
        return answer.json
    end
    function state.notified()
        local found = {}
        for _, frame in ipairs(Harness.clientFrames(connection.sent)) do
            local message = Json.decode(frame.payload)
            if type(message) == "table" and message.type == "notify" then
                found[#found + 1] = { text = frame.payload, message = message }
            end
        end
        connection.sent = ""
        return found
    end
    -- The detail sealed for `name` in the only notify sent since the last look.
    function state.detail(name)
        local notified = state.notified()
        T.eq(#notified, 1, "one message")
        local key = state.keys[name]
        local sealed = notified[1].message["for"][key.id]
        return sealed and open(key.key, key.id, sealed) or nil, notified[1].message
    end
    state.notified()
    return state
end

local function get(mock, key, path)
    local answer = T.http(mock, "GET", path, { key = key })
    T.eq(answer.status, 200, answer.body)
    return answer.json
end

local function ids(items)
    local list = {}
    for _, item in ipairs(items or {}) do
        list[#list + 1] = item.id
    end
    table.sort(list)
    return list
end

-- How many times DirectorLink registered for `driver`'s event `event`.
local function registrations(mock, driver, event)
    local total = 0
    for _, watched in ipairs(mock.deviceEvents) do
        if watched[1] == driver and (event == nil or watched[2] == event) then
            total = total + 1
        end
    end
    return total
end

local function logged(mock, text)
    local total = 0
    for _, line in ipairs(mock.debugLog) do
        if line:find(text, 1, true) then
            total = total + 1
        end
    end
    return total
end

local function minutes(n)
    local Scheduler = require("src.core.scheduler")
    for _ = 1, n or 1 do
        Scheduler.tick()
    end
end

-- The last log line with `text` about the device `deviceId`, or "".
local function lineOf(mock, text, deviceId)
    local found = ""
    for _, line in ipairs(mock.debugLog) do
        if line:find(text, 1, true) and line:find('"device_id":' .. deviceId .. "[,}]") then
            found = line
        end
    end
    return found
end

local function iso(at)
    return os.date("!%Y-%m-%dT%H:%M:%SZ", at)
end

-- ---- reading the agreement ------------------------------------------------------------------------

function tests.labels_times_and_events_are_read_as_drivers_write_them()
    Mock.startDriver()
    local Camera = require("src.adapters.camera")
    for label, what in pairs({
        ["Person"] = "person", ["Vehicle"] = "vehicle", ["Animal"] = "animal", ["Package"] = "package",
        ["Face"] = "face", ["License Plate"] = "license_plate", ["license_plate"] = "license_plate",
        ["LICENCE-PLATE"] = "license_plate", ["Line Crossing"] = "line_crossing", ["Intrusion"] = "intrusion",
        ["Motion"] = "motion", [" package "] = "package", ["Object Left"] = "object_left", ["PIR"] = "pir",
        ["Region  Entrance"] = "region_entrance", ["Smoke"] = "other", [""] = "other",
        -- Words need no space between them (docs/CAMERA_DRIVERS.md: case, spaces, "_" and "-" aside).
        ["LicensePlate"] = "license_plate", ["LineCrossing"] = "line_crossing", ["SceneChange"] = "scene_change",
        ["line-crossing"] = "line_crossing", ["REGION_EXITING"] = "region_exiting", ["ObjectRemoved"] = "object_removed",
        ["Alarm_Input"] = "alarm_input", ["PIR Alarm"] = "other",
    }) do
        T.eq(Camera.detection(label), what, label)
    end
    T.eq(Camera.detection(nil), "other")
    -- The sounds a camera hears (1.11.0, ADR-080), as the DirectorLink · UniFi Protect driver names
    -- them (its AUDIO_LABELS), and as others may write them.
    for label, what in pairs({
        ["Smoke alarm"] = "smoke_alarm", ["CO alarm"] = "co_alarm", ["Siren"] = "siren", ["Baby crying"] = "baby_crying",
        ["Speech"] = "speech", ["Barking"] = "barking", ["Burglar alarm"] = "burglar_alarm", ["Car horn"] = "car_horn",
        ["Glass break"] = "glass_break",
        ["SMOKE_ALARM"] = "smoke_alarm", ["SmokeAlarm"] = "smoke_alarm", ["smoke-alarm"] = "smoke_alarm", [" CO Alarm "] = "co_alarm",
        ["co_alarm"] = "co_alarm", ["BabyCrying"] = "baby_crying", ["GLASS-BREAK"] = "glass_break", ["car_horn"] = "car_horn",
        -- One label, as the agreement says: several, or a word alone, is no label.
        ["Smoke"] = "other", ["CO"] = "other", ["Smoke alarm, Siren"] = "other", ["Glass"] = "other", ["Sound"] = "other",
    }) do
        T.eq(Camera.detection(label), what, label)
    end

    local Clock = require("src.core.clock")
    T.eq(Clock.parseIso("1970-01-01T00:00:00Z"), 0)
    T.eq(Clock.parseIso("2026-10-05T18:14:03Z"), 1791224043)
    T.eq(Clock.parseIso("2026-10-05T18:14:03.250Z"), 1791224043, "a fraction of a second")
    T.eq(Clock.parseIso("2026-10-05T21:14:03+03:00"), 1791224043, "an offset")
    T.eq(Clock.parseIso("2026-10-05T13:14:03-0500"), 1791224043)
    T.eq(Clock.parseIso("2024-02-29T12:00:00Z"), 1709208000, "a leap day")
    T.eq(Clock.iso(Clock.parseIso("2026-10-05T18:14:03Z")), "2026-10-05T18:14:03Z")
    for _, bad in ipairs({ "2026-10-05T18:14:03", "2026-10-05", "2026-13-05T18:14:03Z", "yesterday", "", 1791224043 }) do
        T.eq(Clock.parseIso(bad), nil, tostring(bad))
    end

    local CameraDrivers = require("src.control4.camera_drivers")
    -- Events by name: in lower case (an event's name is matched without case or spaces around).
    local xml = Mock.eventsXml({ { 7, "Alert" }, { 8, "Ring" }, { 9, "Alert Ended" } })
    T.same(CameraDrivers.parseEvents(xml), { alert = 7, ["alert ended"] = 9, ring = 8 })
    T.same(select(2, CameraDrivers.parseEvents(xml)), { "Alert", "Ring", "Alert Ended" }, "the names as written")
    T.same(CameraDrivers.parseEvents("<events>" .. xml .. "</events>"), { alert = 7, ["alert ended"] = 9, ring = 8 }, "the tag whole")
    T.same(CameraDrivers.parseEvents((xml:gsub("<", "&lt;"):gsub(">", "&gt;"))), { alert = 7, ["alert ended"] = 9, ring = 8 }, "as escaped text")
    T.same(CameraDrivers.parseEvents("<event><id> 3 </id><name> Ring </name></event>"), { ring = 3 })
    T.same(CameraDrivers.parseEvents("<event/><event/>"), {}, "no ids: nothing")
    T.same(CameraDrivers.parseEvents(nil), {})
    T.same(CameraDrivers.parseEvents("<event><id>3</id><name>alert</name></event><event><id>4</id><name> RING </name></event>"), { alert = 3, ring = 4 }, "any case")
    T.same(CameraDrivers.parseEvents("<!-- <event><id>99</id><name>Alert</name></event> -->" .. xml), { alert = 7, ["alert ended"] = 9, ring = 8 }, "a comment is not an event")
    T.same(CameraDrivers.parseEvents("<event><id>5</id><name><![CDATA[Alert]]></name><description><![CDATA[<b>x</b></event>]]></description></event>"), { alert = 5 }, "CDATA")
    T.same(CameraDrivers.parseEvents('<event id="a"><id>4</id><name>Alert</name></event><event><id>5</id><name>Alert</name></event>'), { alert = 4 }, "the first in the text")
    T.same(CameraDrivers.parseEvents("<event><id>6</id><name>Ring</name></event><event><id>7</id><name>ring</name></event>"), { ring = 6 }, "the first of a name")
    -- DIRECTORLINK_CAMERA_EVENTS: "Alert=<id>,Ring=<id>" (a camera: "Alert=<id>"), else not used.
    local function eventIds(value, kind)
        return CameraDrivers.eventIds({ DIRECTORLINK_CAMERA_EVENTS = value and { value = value } or nil }, kind)
    end
    T.same(eventIds("Alert=7,Ring=8", "doorbell"), { alert = 7, ring = 8, key = "alert=7,ring=8" })
    T.same(eventIds(" ring = 8 , ALERT=7, ", "doorbell"), { alert = 7, ring = 8, key = "alert=7,ring=8" }, "case and spaces aside")
    T.same(eventIds("Alert=7,Ring=8", "camera"), { alert = 7, key = "alert=7" }, "a camera has no ring")
    T.same(eventIds("Alert=7,Motion=3", "camera"), { alert = 7, key = "alert=7" }, "a name of a later version: left")
    for _, case in ipairs({ { nil, "camera" }, { "", "camera" }, { "  ", "doorbell" } }) do
        T.same({ eventIds(case[1], case[2]) }, {}, "not set: " .. tostring(case[1]))
    end
    for _, case in ipairs({
        { "Alert=seven", "camera", "not Name=<id>: Alert=seven" }, { "Alert=0", "camera", "not Name=<id>: Alert=0" },
        { "Alert=-7", "camera", "not Name=<id>: Alert=-7" }, { "Alert=7.5", "camera", "not Name=<id>: Alert=7.5" },
        { "Alert 7", "camera", "not Name=<id>: Alert 7" }, { "=7", "camera", "not Name=<id>: =7" },
        { "Alert=7;Ring=8", "doorbell", "not Name=<id>: Alert=7;Ring=8" }, { "Alert=7,Alert=9", "camera", "twice: alert" },
        { "Ring=8", "camera", "no Alert" }, { "Alert=7", "doorbell", "no Ring" }, { "Alert=1234567890", "camera", "not Name=<id>: Alert=1234567890" },
    }) do
        local ids, problem = eventIds(case[1], case[2])
        T.eq(ids, nil, case[1])
        T.eq(problem, case[3], case[1])
    end
    -- The marker: a whole number from 1 (a later version read as this one); the kind, else a camera.
    local function marker(version, kind)
        return CameraDrivers.marker({ DIRECTORLINK_CAMERA = version and { value = version } or nil, DIRECTORLINK_CAMERA_KIND = kind and { value = kind } or nil })
    end
    T.same({ marker("1", "doorbell") }, { 1, "doorbell" })
    T.same({ marker(" 1 ", " Doorbell ") }, { 1, "doorbell" })
    T.same({ marker("2", nil) }, { 2, "camera" })
    T.same({ marker("1", "nvr") }, { 1, "camera" })
    for _, bad in ipairs({ "0", "", "yes", "1.5", "-1" }) do
        T.eq(marker(bad, "doorbell"), nil, bad)
    end
    T.eq(marker(nil, "doorbell"), nil)
end

-- ---- cameras ------------------------------------------------------------------------------------

-- An agreement camera's Alert, found by its name (event 7 here), goes sealed as the Hikvision
-- drivers' does, with the new labels; its other events are not alerts.
function tests.an_agreement_camera_alerts_by_its_event_named_alert()
    local home = home(Mock.withAgreementCameras(Mock.project()))
    local mock = home.mock
    T.eq(get(mock, home.admin, "/v1/system").features.camera_alerts, true)
    T.eq(get(mock, home.admin, "/v1/alerts/choices").kinds.camera, false, "offered, off until chosen")
    T.eq(registrations(mock, 157, 7), 1, "its Alert, by name")
    T.eq(registrations(mock, 157), 1, "nothing else of it")
    T.eq(registrations(mock, 157, 1), 0, "not event 1: that is its Camera Online")
    home.on("admin", { camera = true })
    home.notified()

    for _, case in ipairs({ { "Animal", "animal" }, { "Package", "package" }, { "License Plate", "license_plate" }, { "Person", "person" } }) do
        home.clock.now = home.clock.now + 61
        T.eq(Mock.cameraAlert(mock, 157, case[1]), 1, case[1])
        local detail, message = home.detail("admin")
        T.same(detail, { at = message.at, id = 67, kind = "camera", name = "Porch", room = "Living Room", room_id = 11, what = case[2], v = 1 }, case[1])
        T.eq(message.brief, nil)
    end
    home.clock.now = home.clock.now + 61
    T.eq(Mock.fireDeviceEvent(mock, 157, 1), 0, "Camera Online is not watched")
    T.eq(#home.notified(), 0)
    -- Pictures as for any camera.
    T.same(ids(get(mock, home.admin, "/v1/cameras").items), { 60, 61, 67, 68, 92 })
    local picture = T.http(mock, "GET", "/v1/cameras/67/snapshot?width=320", { key = home.admin })
    T.eq(picture.status, 200, picture.body)
    T.eq(picture.headers["content-type"], "image/jpeg")
end

-- ---- doorbells -----------------------------------------------------------------------------------

-- A doorbell camera is a doorbell: listed with the doorbells, its picture its own; its Ring is a ring
-- (last_ring_at from LAST_RING, its rings kept as a DoorBird's), the sealed ring alert to those who
-- see it, at most one in 30 s; its Alert is still a camera alert; it opens nothing.
function tests.a_doorbell_camera_is_a_doorbell_that_rings()
    local home = home(Mock.withAgreementCameras(Mock.project()), function()
        Properties["Door Control"] = "Enabled"
    end)
    local mock = home.mock
    local doorbells = get(mock, home.admin, "/v1/doorbells").items
    T.same(ids(doorbells), { 68, 93 }, "the DoorBird and the doorbell camera; not the camera Porch")
    local entrance = get(mock, home.admin, "/v1/doorbells/68")
    T.eq(entrance.name, "Entrance")
    T.eq(entrance.room.id, 10)
    T.same(entrance.camera, { id = 68, snapshot_href = "/v1/cameras/68/snapshot" }, "its picture its own")
    T.eq(entrance.can_open, false)
    for _, field in ipairs({ "connected", "last_ring_at", "last_motion_at", "last_opened_at", "last_access_at" }) do
        T.eq(entrance[field], Json.null, field)
    end
    T.eq(#entrance.events, 0)
    T.truthy(get(mock, home.admin, "/v1/cameras/68").id == 68, "a camera too")
    local inventory = get(mock, home.admin, "/v1/system").inventory
    T.eq(inventory.doorbells, 2)
    T.eq(inventory.cameras, 5)
    T.eq(registrations(mock, 158, 8), 1, "its Ring, by name")
    T.eq(registrations(mock, 158, 7), 1, "and its Alert")
    local refused = T.http(mock, "POST", "/v1/doorbells/68/open", { key = home.admin })
    T.eq(refused.status, 409, refused.body)
    T.eq(refused.json.code, "NOT_SUPPORTED")
    T.contains(refused.body, "nothing to open")

    home.add("Hall tablet", "member")
    home.on("admin", { camera = true })
    home.on("Hall tablet")
    home.notified()

    -- The driver's own time of the ring (a second ago).
    home.clock.now = home.clock.now + 3600
    local rang = os.date("!%Y-%m-%dT%H:%M:%SZ", os.time() - 1)
    T.eq(Mock.cameraRing(mock, 158, rang), 1)
    local detail, message = home.detail("admin")
    T.eq(message.brief, true, "a ring is brief")
    T.eq(count(message["for"]), 2, "the admin and the member")
    T.same(detail, { at = rang, id = 68, kind = "doorbell", name = "Entrance", room = "Kitchen", room_id = 10, v = 1 })
    entrance = get(mock, home.admin, "/v1/doorbells/68")
    T.eq(entrance.last_ring_at, rang)
    T.same(entrance.events, { { type = "doorbell", at = rang } })
    T.eq(logged(mock, "the doorbell rang"), 1)

    -- Again within 30 s: one alert is enough, the ring is kept. A LAST_RING the driver did not set
    -- (an old one) is not the ring's time: now is.
    home.clock.now = home.clock.now + 20
    T.eq(Mock.cameraRing(mock, 158, "2026-01-01T00:00:00Z"), 1)
    T.eq(#home.notified(), 0, "at most one in 30 s")
    entrance = get(mock, home.admin, "/v1/doorbells/68")
    T.eq(#entrance.events, 2)
    T.truthy(entrance.last_ring_at ~= "2026-01-01T00:00:00Z", "not a time long gone")
    T.truthy(math.abs(require("src.core.clock").parseIso(entrance.last_ring_at) - os.time()) <= 2, "the moment it came")
    home.clock.now = home.clock.now + 11
    Mock.cameraRing(mock, 158)
    T.eq(#home.notified(), 1)

    -- Its detections are camera alerts, to those who chose them.
    home.clock.now = home.clock.now + 61
    T.eq(Mock.cameraAlert(mock, 158, "Package"), 1)
    detail = home.detail("admin")
    T.eq(detail.kind, "camera")
    T.eq(detail.what, "package")
    T.eq(detail.id, 68)

    -- The kept rings go through a Refresh Project.
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    T.eq(#get(mock, home.admin, "/v1/doorbells/68").events, 3, "kept")
end

-- A doorbell camera opens nothing: in a home without doors, gates or a DoorBird, "doors opened" is
-- not offered for it.
function tests.a_doorbell_camera_offers_no_door_alerts()
    local project = Mock.withAgreementCameras(Mock.project())
    for _, id in ipairs({ 70, 90, 91, 92, 93, 110 }) do
        Mock.removeDevice(project, id)
    end
    local home = home(project)
    T.same(ids(get(home.mock, home.admin, "/v1/doorbells").items), { 68 })
    local kinds = get(home.mock, home.admin, "/v1/alerts/choices").kinds
    T.eq(kinds.doorbell, true)
    T.eq(kinds.door_opened, nil, "nothing here opens")
end

-- Who sees a doorbell camera (ADR-054): a member in its room sees the doorbell and gets its ring,
-- its picture only with cameras; a member without its room sees nothing of it.
function tests.a_doorbell_camera_follows_access_as_a_doorbell_does()
    local home = home(Mock.withAgreementCameras(Mock.project()))
    local mock = home.mock
    local kinds = { light = true, climate = true, fan = true, blind = true, music = true, refrigerator = true }
    local noCameras = home.add("Kids phone", "member", { all_rooms = true, rooms = {}, kinds = kinds, cameras = false, doors = false, alarm = false, scenes = {} })
    local elsewhere = home.add("Guest phone", "member", { all_rooms = false, rooms = { 11 }, kinds = kinds, cameras = true, doors = false, alarm = false, scenes = {} })

    local listed = get(mock, noCameras, "/v1/doorbells").items
    T.same(ids(listed), { 68, 93 })
    for _, doorbell in ipairs(listed) do
        T.eq(doorbell.camera, Json.null, "no picture without cameras")
    end
    T.eq(T.http(mock, "GET", "/v1/cameras/68", { key = noCameras }).status, 404)
    T.eq(T.http(mock, "GET", "/v1/cameras/68/snapshot", { key = noCameras }).status, 404)
    T.eq(get(mock, noCameras, "/v1/system").inventory.doorbells, 2)
    T.eq(get(mock, noCameras, "/v1/system").inventory.cameras, 0)
    T.same(get(mock, noCameras, "/v1/alerts/choices").kinds, { doorbell = true }, "its ring, no camera alerts")

    T.same(ids(get(mock, elsewhere, "/v1/doorbells").items), {}, "the Kitchen is not theirs")
    T.eq(T.http(mock, "GET", "/v1/doorbells/68", { key = elsewhere }).status, 404)
    T.eq(get(mock, elsewhere, "/v1/system").inventory.doorbells, 0)

    home.on("Kids phone")
    home.on("Guest phone", { camera = true, doorbell = true })
    home.on("admin", { camera = true })
    home.notified()
    home.clock.now = home.clock.now + 3600
    Mock.cameraRing(mock, 158)
    local message = home.notified()[1].message
    T.truthy(message["for"][home.keys["Kids phone"].id], "the ring: they see the doorbell")
    T.eq(message["for"][home.keys["Guest phone"].id], nil, "not theirs")
    home.clock.now = home.clock.now + 61
    Mock.cameraAlert(mock, 158, "Person")
    message = home.notified()[1].message
    T.eq(count(message["for"]), 1, "a camera alert: only who may see its pictures and chose it")
    T.truthy(message["for"][home.adminId])
end

-- ---- the marker later, a driver update ------------------------------------------------------------

-- A driver that adds the marker once it runs (after DirectorLink set its camera up), or changes its
-- kind: DirectorLink looks again, a few cameras a minute, and sets that camera up again.
function tests.a_marker_that_comes_later_is_seen_within_minutes()
    local project = Mock.withAgreementCameras(Mock.project(), {
        { id = 68, protocol = 158, name = "Entrance", room = 10, address = "192.0.2.52", kind = "doorbell", marker = false },
    })
    local home = home(project)
    local mock = home.mock
    T.same(ids(get(mock, home.admin, "/v1/doorbells").items), { 93 }, "a plain camera until it says otherwise")
    T.eq(registrations(mock, 158), 0)
    T.eq(get(mock, home.admin, "/v1/system").features.camera_alerts, false)

    Mock.addVariables(mock, 158, { DIRECTORLINK_CAMERA = "1", DIRECTORLINK_CAMERA_KIND = "doorbell" })
    -- Five cameras a minute (60, 61, 68, 92 here): within a minute or two.
    minutes(2)
    T.same(ids(get(mock, home.admin, "/v1/doorbells").items), { 68, 93 }, "a doorbell now")
    T.eq(registrations(mock, 158, 8), 1)
    T.eq(get(mock, home.admin, "/v1/system").features.camera_alerts, true)
    T.eq(logged(mock, "says something else of DirectorLink's camera agreement; set up again"), 1)
    home.on("admin")
    home.notified()
    home.clock.now = home.clock.now + 3600
    T.eq(Mock.cameraRing(mock, 158), 1)
    T.eq(home.detail("admin").kind, "doorbell")

    -- Nothing changes: nothing is set up again.
    minutes(3)
    T.eq(logged(mock, "set up again"), 1)

    -- Its kind changes (the driver learned its model): a camera again, its rings gone with it.
    Mock.addVariables(mock, 158, { DIRECTORLINK_CAMERA_KIND = "camera" })
    minutes(2)
    T.same(ids(get(mock, home.admin, "/v1/doorbells").items), { 93 })
    T.eq(T.http(mock, "GET", "/v1/doorbells/68", { key = home.admin }).status, 404)
    T.eq(Mock.cameraRing(mock, 158), 1, "still registered with Director")
    T.eq(#home.notified(), 0, "but no ring")
    T.eq(logged(mock, "set up again"), 2)
end

-- A driver updated in Composer is read again (ADR-059): its new events, its marker.
function tests.a_driver_update_reads_the_agreement_again()
    local home = home(Mock.withAgreementCameras(Mock.project()))
    local mock = home.mock
    home.on("admin", { camera = true })
    home.notified()
    -- Version 2 of the driver numbers its events otherwise, and the doorbell is now a camera.
    mock.project.deviceData[158].events = Mock.eventsXml({ { 1, "Camera Online" }, { 11, "Alert" }, { 12, "Ring" } })
    Mock.addVariables(mock, 158, { DIRECTORLINK_CAMERA_KIND = "camera" })
    Mock.updateDeviceDriver(mock, 158, "2")
    minutes(2)
    T.eq(registrations(mock, 158, 11), 1, "its new Alert")
    T.same(ids(get(mock, home.admin, "/v1/doorbells").items), { 93 }, "a camera now")
    home.clock.now = home.clock.now + 3600
    T.eq(Mock.cameraAlert(mock, 158, "Person"), 1)
    T.eq(home.detail("admin").what, "person")
    T.eq(Mock.fireDeviceEvent(mock, 158, 7), 1, "the old Alert's id is still registered with Director")
    T.eq(#home.notified(), 0, "but nothing")
end

-- After a restart DirectorLink knows the last ring from LAST_RING; a time ahead of the controller's
-- clock is not believed.
function tests.the_last_ring_survives_a_restart_through_last_ring()
    local home = home(Mock.withAgreementCameras(Mock.project()))
    local rang = os.date("!%Y-%m-%dT%H:%M:%SZ", os.time() - 30)
    Mock.cameraRing(home.mock, 158, rang)
    local updated = Mock.updateDriver(home.mock, home.mock.project)
    T.eq(get(updated, home.admin, "/v1/doorbells/68").last_ring_at, rang, "from LAST_RING")
    T.eq(#get(updated, home.admin, "/v1/doorbells/68").events, 0, "its rings are since DirectorLink started")
    Mock.cameraRing(updated, 158, os.date("!%Y-%m-%dT%H:%M:%SZ", os.time() + 3600))
    local again = Mock.updateDriver(updated, updated.project)
    T.eq(get(again, home.admin, "/v1/doorbells/68").last_ring_at, Json.null, "an hour ahead: not believed")
end

-- ---- what Director may not say ------------------------------------------------------------------

-- Director may give a tag's first levels only: the whole <devicedata> then. A driver whose events
-- Director names nowhere is not watched (said in the log); one with several cameras neither.
function tests.events_are_found_in_the_whole_driver_xml_or_not_watched()
    local project = Mock.withAgreementCameras(Mock.project())
    local events = Mock.eventsXml(Mock.AGREEMENT_EVENTS)
    project.deviceData[157].devicedata = "<devicedata><version>1</version><events>" .. events .. "</events></devicedata>"
    project.deviceData[157].events = "<event/><event/><event/><event/><event/>"
    project.deviceData[158] = { version = "1" }
    local first = home(project)
    T.eq(registrations(first.mock, 157, 7), 1, "from the whole <devicedata>")
    T.eq(registrations(first.mock, 158), 0, "nothing named")
    T.eq(logged(first.mock, "without an event named Alert: its alerts are not watched"), 1)
    T.eq(logged(first.mock, "without an event named Ring: its rings are not watched"), 1)
    T.same(ids(get(first.mock, first.admin, "/v1/doorbells").items), { 68, 93 }, "still a doorbell, as its driver says")
    T.eq(get(first.mock, first.admin, "/v1/doorbells/68").camera.id, 68, "with its picture")

    -- One driver, two cameras: neither is watched (one camera a driver).
    local two = Mock.withAgreementCameras(Mock.project(), { { id = 67, protocol = 157, name = "Porch", room = 11, address = "192.0.2.51" } })
    two.devices[157].proxies[69] = { deviceName = "Porch 2", driverFileName = "camera.c4i" }
    two.devices[69] = { deviceName = "Porch 2", driverFileName = "camera.c4i", roomId = 11, roomName = "Living Room", protocol = { [157] = { deviceName = "Porch", driverFileName = Mock.AGREEMENT_FILE } } }
    local other = home(two)
    T.eq(registrations(other.mock, 157), 0)
    T.eq(logged(other.mock, "with several cameras"), 2)
end

-- ---- the Hikvision drivers ------------------------------------------------------------------------

-- Without the marker, by its file name (ADR-056); with it, by the marker; once either way: one
-- registration, one alert.
function tests.a_hikvision_driver_is_one_camera_with_or_without_the_marker()
    local project = Mock.withHikvisionCameras(Mock.project(), {
        { id = 65, protocol = 150, name = "Garden", room = 11, address = "192.0.2.31" },
        { id = 66, protocol = 151, name = "Back Gate", room = 10, address = "192.0.2.32", marker = true },
        { id = 67, protocol = 152, name = "Pool", room = 11, address = "192.0.2.33", events = true },
    })
    local home = home(project)
    local mock = home.mock
    for _, driver in ipairs({ 150, 151, 152 }) do
        T.eq(registrations(mock, driver, 1), 1, "Alert, once: " .. driver)
        T.eq(registrations(mock, driver), 1, "nothing else: " .. driver)
    end
    home.on("admin", { camera = true })
    home.notified()
    for _, case in ipairs({ { 150, 65 }, { 151, 66 }, { 152, 67 } }) do
        home.clock.now = home.clock.now + 61
        T.eq(Mock.hikvisionAlert(mock, case[1], "Vehicle"), 1)
        local detail = home.detail("admin")
        T.eq(detail.id, case[2])
        T.eq(detail.what, "vehicle")
    end

    -- Garden's driver is updated to a version that sets the marker: by the marker now, still once.
    Mock.updateDeviceDriver(mock, 150, "107", { DIRECTORLINK_CAMERA = "1", DIRECTORLINK_CAMERA_KIND = "camera" })
    mock.project.deviceData[150].events = Mock.eventsXml(Mock.HIKVISION_EVENTS)
    minutes(2)
    T.eq(registrations(mock, 150), 1, "the same event, registered once")
    home.clock.now = home.clock.now + 61
    T.eq(Mock.hikvisionAlert(mock, 150, "Person"), 1)
    T.eq(#home.notified(), 1, "one alert")
    -- And when Director names no events, a marked Hikvision driver's Alert is still its event 1.
    mock.project.deviceData[151] = { version = "100" }
    ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
    home.clock.now = home.clock.now + 61
    T.eq(Mock.hikvisionAlert(mock, 151, "Person"), 1)
    T.eq(home.detail("admin").id, 66)
end

-- ---- DIRECTORLINK_CAMERA_EVENTS and the log --------------------------------------------------------

-- A driver that gives its events' ids itself (DIRECTORLINK_CAMERA_EVENTS, optional in version 1) is
-- watched by them, and DirectorLink asks Director nothing of its driver.xml (C4:GetDeviceData): its
-- alerts and rings work where Director names none of its events.
function tests.directorlink_camera_events_give_the_ids_without_asking_director()
    local project = Mock.withAgreementCameras(Mock.project(), {
        { id = 67, protocol = 157, name = "Porch", room = 11, address = "192.0.2.51", kind = "camera", events_variable = " alert = 7 " },
        { id = 68, protocol = 158, name = "Entrance", room = 10, address = "192.0.2.52", kind = "doorbell", events_variable = "Alert=7,Ring=8" },
    })
    project.deviceData[157] = { version = "1" }
    project.deviceData[158] = { version = "1" }
    local asked = {}
    local home = home(project, function()
        local real = C4.GetDeviceData
        C4.GetDeviceData = function(self, id, tag)
            if (id == 157 or id == 158) and tag ~= "version" then
                asked[#asked + 1] = tostring(id) .. " " .. tostring(tag)
            end
            return real(self, id, tag)
        end
    end)
    local mock = home.mock
    T.same(asked, {}, "nothing asked of Director but the drivers' versions")
    T.eq(registrations(mock, 157, 7), 1)
    T.eq(registrations(mock, 157), 1)
    T.eq(registrations(mock, 158, 7), 1)
    T.eq(registrations(mock, 158, 8), 1)
    T.eq(logged(mock, "not watched"), 0)
    T.contains(lineOf(mock, "a camera of DirectorLink's camera agreement", 67), '"events_by":"by DIRECTORLINK_CAMERA_EVENTS"')
    T.contains(lineOf(mock, "a camera of DirectorLink's camera agreement", 68), '"events_by":"by DIRECTORLINK_CAMERA_EVENTS"')

    home.on("admin", { camera = true })
    home.notified()
    home.clock.now = home.clock.now + 3600
    Mock.addVariables(mock, 158, { LAST_RING = iso(os.time()) })
    T.eq(Mock.fireDeviceEvent(mock, 158, 8), 1)
    T.eq(home.detail("admin").kind, "doorbell")
    home.clock.now = home.clock.now + 61
    Mock.addVariables(mock, 157, { LAST_ALERT = "Person" })
    T.eq(Mock.fireDeviceEvent(mock, 157, 7), 1)
    T.eq(home.detail("admin").what, "person")
end

-- A DIRECTORLINK_CAMERA_EVENTS not as the agreement says (or without what the kind needs) is not
-- used, with a warning; the events are looked for by name. Set right later, it is taken at the next
-- look, without a driver update.
function tests.a_malformed_directorlink_camera_events_is_ignored_with_a_warning()
    local project = Mock.withAgreementCameras(Mock.project(), {
        { id = 67, protocol = 157, name = "Porch", room = 11, address = "192.0.2.51", kind = "camera", events_variable = "Alert=seven" },
        { id = 68, protocol = 158, name = "Entrance", room = 10, address = "192.0.2.52", kind = "doorbell", events_variable = "Alert=9" },
    })
    local home = home(project)
    local mock = home.mock
    T.eq(registrations(mock, 157, 7), 1, "by name")
    T.eq(registrations(mock, 158, 7), 1, "by name")
    T.eq(registrations(mock, 158, 8), 1, "by name")
    T.eq(registrations(mock, 158, 9), 0, "nothing of the half it gave")
    local warned = lineOf(mock, "DIRECTORLINK_CAMERA_EVENTS is not Alert=<id>,Ring=<id>", 67)
    T.contains(warned, "[WARN]")
    T.contains(warned, '"problem":"not Name=<id>: Alert=seven"')
    T.contains(warned, '"value":"Alert=seven"')
    T.contains(lineOf(mock, "DIRECTORLINK_CAMERA_EVENTS is not Alert=<id>,Ring=<id>", 68), '"problem":"no Ring"')
    T.contains(lineOf(mock, "a camera of DirectorLink's camera agreement", 67), '"events_by":"by name from Director"')
    T.contains(lineOf(mock, "a camera of DirectorLink's camera agreement", 68), '"events_by":"by name from Director"')

    Mock.addVariables(mock, 158, { DIRECTORLINK_CAMERA_EVENTS = "Alert=11,Ring=12" })
    minutes(1)
    T.eq(registrations(mock, 158, 12), 1)
    T.contains(lineOf(mock, "agreement; set up again", 68), '"events_to":"alert=11,ring=12"')
    home.on("admin")
    home.notified()
    home.clock.now = home.clock.now + 3600
    T.eq(Mock.fireDeviceEvent(mock, 158, 12), 1)
    T.eq(home.detail("admin").kind, "doorbell")
end

-- Once a camera is set up, the log says at Info how its events were found, and at Debug what
-- Director gave of its driver.xml (its shape, not its text): what a home's Director log shows.
function tests.the_log_says_how_each_camera_found_its_events()
    local project = Mock.withAgreementCameras(Mock.project())
    project.deviceData[158] = { version = "1" }
    local mock = home(project, function()
        Properties["Log Level"] = "Debug"
    end).mock
    local found = lineOf(mock, "a camera of DirectorLink's camera agreement", 67)
    T.contains(found, "[INFO]")
    T.contains(found, '"events_by":"by name from Director"')
    T.contains(found, '"alert_event":7')
    local given = lineOf(mock, "what Director gives of a camera driver's events", 67)
    T.contains(given, "[DEBUG]")
    T.contains(given, '"events_tag":"a text of ')
    T.contains(given, "with 5 <event> tags")
    T.contains(given, '"named":5')
    T.contains(given, '"names":"Camera Online, Camera Offline, Motion, Alert, Ring"')
    T.eq(given:find("<id>", 1, true), nil, "not the text itself")
    T.contains(lineOf(mock, "a camera of DirectorLink's camera agreement", 68), '"events_by":"not found"')
    given = lineOf(mock, "what Director gives of a camera driver's events", 68)
    T.contains(given, '"events_tag":"an empty text"')
    T.contains(given, '"devicedata":"a text of ')
    T.contains(given, '"named":0')

    -- The Hikvision drivers, at the shipped Log Level (Info).
    local hikvision = Mock.withHikvisionCameras(Mock.project(), {
        { id = 65, protocol = 150, name = "Garden", room = 11, address = "192.0.2.31" },
        { id = 66, protocol = 151, name = "Back Gate", room = 10, address = "192.0.2.32", marker = true },
        { id = 67, protocol = 152, name = "Pool", room = 11, address = "192.0.2.33", marker = true },
    })
    hikvision.deviceData[152] = { version = "100" }
    mock = home(hikvision).mock
    found = lineOf(mock, "a camera of DirectorLink's camera agreement", 65)
    T.contains(found, '"by":"file name"')
    T.contains(found, '"events_by":"Hikvision event 1"')
    T.contains(lineOf(mock, "a camera of DirectorLink's camera agreement", 66), '"events_by":"by name from Director"')
    found = lineOf(mock, "a camera of DirectorLink's camera agreement", 67)
    T.contains(found, '"by":"marker"')
    T.contains(found, '"events_by":"Hikvision event 1"')
    T.eq(logged(mock, "what Director gives of a camera driver's events"), 0, "not at Info")
end

-- ---- rings, opening, what a driver may say ----------------------------------------------------------

-- A ring's time is LAST_RING only when it is new (later than the ring before) and not ahead of the
-- controller's clock (5 s at most); else the moment the event came, always after the ring before: a
-- Ring without a new LAST_RING is a new ring, with a time of its own. After a restart, a LAST_RING
-- ahead of the clock is not the last ring either.
function tests.a_ring_time_is_last_ring_only_when_new_and_not_ahead()
    local home = home(Mock.withAgreementCameras(Mock.project()))
    local mock = home.mock
    local Clock = require("src.core.clock")
    home.on("admin")
    home.notified()
    home.clock.now = home.clock.now + 3600

    -- A minute ahead: not believed.
    T.eq(Mock.cameraRing(mock, 158, iso(os.time() + 60)), 1)
    local first = get(mock, home.admin, "/v1/doorbells/68").last_ring_at
    T.truthy(Clock.parseIso(first) <= os.time() + 1, "not ahead: " .. tostring(first))
    T.eq(home.detail("admin").at, first)

    -- Again, without a new LAST_RING: a ring of its own, and its alert says its own time.
    home.clock.now = home.clock.now + 31
    T.eq(Mock.fireDeviceEvent(mock, 158, 8), 1)
    local entrance = get(mock, home.admin, "/v1/doorbells/68")
    local second = entrance.last_ring_at
    T.truthy(Clock.parseIso(second) > Clock.parseIso(first), "later: " .. tostring(second))
    T.same(entrance.events, { { type = "doorbell", at = second }, { type = "doorbell", at = first } })
    T.eq(home.detail("admin").at, second)

    -- A LAST_RING not later than the ring before is not this ring's time.
    home.clock.now = home.clock.now + 31
    Mock.cameraRing(mock, 158, iso(os.time() - 1))
    local third = get(mock, home.admin, "/v1/doorbells/68").last_ring_at
    T.truthy(Clock.parseIso(third) > Clock.parseIso(second), "later: " .. tostring(third))
    home.notified()

    -- A new one, a few seconds ahead at most, is.
    home.clock.now = home.clock.now + 31
    local rang = iso(os.time() + 4)
    Mock.cameraRing(mock, 158, rang)
    T.eq(get(mock, home.admin, "/v1/doorbells/68").last_ring_at, rang)
    home.notified()

    Mock.cameraRing(mock, 158, iso(os.time() + 60))
    local updated = Mock.updateDriver(mock, mock.project)
    T.eq(get(updated, home.admin, "/v1/doorbells/68").last_ring_at, Json.null, "a minute ahead: not its last ring")
end

-- A doorbell camera opens nothing: POST …/open answers 409 NOT_SUPPORTED first, whatever Door Control
-- (here as shipped: Disabled) and the caller's doors and gates. A DoorBird with its button answers
-- as before.
function tests.opening_a_doorbell_camera_is_not_supported_whatever_door_control()
    local home = home(Mock.withAgreementCameras(Mock.project()))
    local mock = home.mock
    local member = home.add("Hall tablet", "member", { all_rooms = true, rooms = {}, kinds = { light = true }, cameras = true, doors = false, alarm = false, scenes = {} })
    for _, key in ipairs({ home.admin, member }) do
        local refused = T.http(mock, "POST", "/v1/doorbells/68/open", { key = key })
        T.eq(refused.status, 409, refused.body)
        T.eq(refused.json.code, "NOT_SUPPORTED")
        T.contains(refused.body, "nothing to open")
    end
    local doorbird = T.http(mock, "POST", "/v1/doorbells/93/open", { key = home.admin })
    T.eq(doorbird.status, 403, doorbird.body)
    T.eq(doorbird.json.code, "DOOR_CONTROL_DISABLED")
    T.eq(T.http(mock, "POST", "/v1/doorbells/93/open", { key = member }).json.code, "FORBIDDEN")
end

-- Events named in any case, with spaces around, after a comment naming another id: watched. A
-- doorbell without a Ring is warned about its Ring, and only that.
function tests.events_are_named_in_any_case_and_the_warning_says_which_is_missing()
    local project = Mock.withAgreementCameras(Mock.project(), {
        { id = 67, protocol = 157, name = "Porch", room = 11, address = "192.0.2.51", kind = "doorbell", events = { { 1, "alert" }, { 2, " RING " } } },
        { id = 68, protocol = 158, name = "Entrance", room = 10, address = "192.0.2.52", kind = "doorbell", events = { { 1, "Camera Online" }, { 7, "Alert" } } },
    })
    project.deviceData[157].events = "<!-- <event><id>99</id><name>Alert</name></event> -->" .. project.deviceData[157].events
    local home = home(project)
    local mock = home.mock
    T.eq(registrations(mock, 157, 1), 1, "alert")
    T.eq(registrations(mock, 157, 2), 1, "RING")
    T.eq(registrations(mock, 157, 99), 0, "not the commented one")
    T.eq(registrations(mock, 158, 7), 1)
    T.eq(logged(mock, "without an event named Alert"), 0)
    local warned = lineOf(mock, "without an event named Ring: its rings are not watched", 68)
    T.contains(warned, '"missing":"Ring"')
    T.contains(warned, '"events_named":2')
    T.eq(logged(mock, "without an event named"), 1, "only that one")
end

-- One read of a doorbell driver's variables without its own (Composer reloading it, before it adds
-- them again) drops nothing: a doorbell camera goes back to a plain camera only when the next look at
-- it says so too.
function tests.one_read_without_the_marker_drops_nothing()
    local home = home(Mock.withAgreementCameras(Mock.project()))
    local mock = home.mock
    home.on("admin")
    home.notified()
    local real = C4.GetDeviceVariables
    local empty = 1
    C4.GetDeviceVariables = function(self, id)
        if id == 158 and empty > 0 then
            empty = empty - 1
            return {}
        end
        return real(self, id)
    end
    minutes(1)
    T.eq(empty, 0, "looked at")
    T.same(ids(get(mock, home.admin, "/v1/doorbells").items), { 68, 93 }, "still a doorbell")
    home.clock.now = home.clock.now + 3600
    T.eq(Mock.cameraRing(mock, 158), 1)
    T.eq(home.detail("admin").kind, "doorbell")
    minutes(3)
    T.same(ids(get(mock, home.admin, "/v1/doorbells").items), { 68, 93 })
    T.eq(logged(mock, "agreement; set up again"), 0)

    -- The marker gone for two looks in a row: a plain camera.
    Mock.addVariables(mock, 158, { DIRECTORLINK_CAMERA = "" })
    minutes(1)
    T.same(ids(get(mock, home.admin, "/v1/doorbells").items), { 68, 93 }, "one look")
    minutes(1)
    T.same(ids(get(mock, home.admin, "/v1/doorbells").items), { 93 }, "two")
    T.eq(logged(mock, "agreement; set up again"), 1)
    C4.GetDeviceVariables = real
end

-- /v1/devices?type=doorbell lists the doorbell cameras too, as doorbells (as /v1/doorbells and
-- inventory.doorbells count them); everywhere else such a camera is a camera, once.
function tests.devices_of_type_doorbell_include_doorbell_cameras()
    local home = home(Mock.withAgreementCameras(Mock.project()))
    local mock = home.mock
    local doorbells = get(mock, home.admin, "/v1/devices?type=doorbell").items
    T.same(ids(doorbells), { 68, 93 })
    for _, item in ipairs(doorbells) do
        T.eq(item.type, "doorbell")
        T.eq(item.href, "/v1/doorbells/" .. item.id)
        T.eq(item.supported, true)
    end
    T.same(ids(get(mock, home.admin, "/v1/devices?type=camera").items), { 60, 61, 67, 68, 92 })
    local entries = 0
    for _, item in ipairs(get(mock, home.admin, "/v1/devices").items) do
        if item.id == 68 then
            entries = entries + 1
            T.eq(item.type, "camera")
        end
    end
    T.eq(entries, 1)
    T.same(ids(get(mock, home.admin, "/v1/devices?type=doorbell&room_id=10").items), { 68, 93 })
    T.same(ids(get(mock, home.admin, "/v1/devices?type=doorbell&room_id=11").items), {})

    -- A member without cameras sees the doorbell, not the camera; one without its room, neither.
    local noCameras = home.add("Kids phone", "member", { all_rooms = true, rooms = {}, kinds = { light = true }, cameras = false, doors = false, alarm = false, scenes = {} })
    local elsewhere = home.add("Guest phone", "member", { all_rooms = false, rooms = { 11 }, kinds = { light = true }, cameras = true, doors = false, alarm = false, scenes = {} })
    T.same(ids(get(mock, noCameras, "/v1/devices?type=doorbell").items), { 68, 93 })
    T.same(ids(get(mock, noCameras, "/v1/devices?type=camera").items), {})
    T.same(ids(get(mock, elsewhere, "/v1/devices?type=doorbell").items), {})
end

return tests
