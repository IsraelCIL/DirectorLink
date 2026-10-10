-- Alerts (ADR-047, ADR-050, docs/RELAY.md): which of its keys are admin keys the driver tells the
-- relay; what it alerts about (a doorbell rang, a camera of the DirectorLink · Hikvision drivers saw
-- someone (ADR-056), a door or gate opened, the refrigerator's door left open, a schedule failed) it sends as one "notify" message that names only the key ids it is for,
-- each with the details sealed to that key (tests/vectors/alert.json); who gets what (the role, the
-- device's switch, the key's own choices, GET and PUT /v1/alerts/choices); and how often.

local T = require("helpers")
local Json = require("src.core.json")
local Base64 = require("src.core.base64")
local Mock = require("c4mock")
local Harness = require("relay_harness")

local tests = {}

-- The driver's messages to the relay since the last look (key id lists included).
local function sent(connection)
    local messages = {}
    for _, frame in ipairs(Harness.clientFrames(connection.sent)) do
        messages[#messages + 1] = { text = frame.payload, message = Json.decode(frame.payload) }
    end
    connection.sent = ""
    return messages
end

local function ofType(messages, kind)
    local found = {}
    for _, item in ipairs(messages) do
        if type(item.message) == "table" and item.message.type == kind then
            found[#found + 1] = item
        end
    end
    return found
end

local function count(map)
    local total = 0
    for _ in pairs(map or {}) do
        total = total + 1
    end
    return total
end

-- Local time `hh:mm` on the day `days` after today.
local function at(days, hh, mm)
    local fields = os.date("*t", os.time() + days * 86400)
    fields.hour, fields.min, fields.sec = hh, mm, 0
    return os.time(fields)
end

local function vectors()
    local file = assert(io.open("tests/vectors/alert.json", "rb"))
    local text = file:read("*a")
    file:close()
    return Json.decode(text)
end

local function hmacHex(key, data)
    return C4:HMAC("SHA256", key, data, { key_encoding = "HEX", data_encoding = "NONE", return_encoding = "HEX" }):lower()
end

-- Opens `sealed` as the device of `apiKey` does (its service worker): the detail, or a failure.
local function open(apiKey, home, keyId, sealed)
    local Lock = require("src.cloud.lock")
    local alertKey = require("src.cloud.alerts").alertKey(Lock.deviceKey(apiKey))
    local enc, mac = hmacHex(alertKey, "enc"), hmacHex(alertKey, "mac")
    local expected = Base64.encode(Base64.fromHex(hmacHex(mac, "alert v1|" .. home .. "|" .. keyId .. "|" .. sealed.iv .. "|" .. sealed.ct)))
    T.eq(sealed.mac, expected, "sealed to this key, for this home")
    local plaintext = C4:Decrypt("AES-256-CBC", enc, Base64.toHex(Base64.decode(sealed.iv)), Base64.toHex(Base64.decode(sealed.ct)), {
        key_encoding = "HEX",
        iv_encoding = "HEX",
        data_encoding = "HEX",
        return_encoding = "NONE",
        padding = true,
    })
    return Json.decode(plaintext), plaintext
end

-- A connected driver with the clock in the test's hands: { mock, connection, clock, home, admin,
-- adminId, keys = { name -> { key, id } } }. `setup` runs before the start (Composer properties);
-- `project`: the fake Director's project (Mock.project() by default).
local function home(setup, project)
    local mock = Mock.startDriver(project, nil, nil, setup)
    local _, connection = Harness.connected({ mock = mock })
    local Clock = require("src.core.clock")
    local clock = { now = os.time() }
    Clock.now = function()
        return clock.now
    end
    local admin = T.pair(mock, "Chrome on Windows")
    local adminId = T.http(mock, "GET", "/v1/api-keys/current", { key = admin }).json.id
    local profile = T.http(mock, "GET", "/v1/profile", { key = admin }).json
    T.eq(T.http(mock, "PATCH", "/v1/profiles/" .. profile.id, { key = admin, body = { name = "Dana" } }).status, 200)
    local state = { mock = mock, connection = connection, clock = clock, admin = admin, adminId = adminId, keys = {} }
    state.home = require("src.cloud.relay").identity().home_id
    state.keys.admin = { key = admin, id = adminId }
    function state.add(name, role)
        local created = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = name, role = role } })
        T.eq(created.status, 201, created.body)
        state.keys[name] = { key = created.json.key, id = created.json.id }
        return created.json.key, created.json.id
    end
    -- The device of `name` switches alerts on (and chooses `kinds`).
    function state.on(name, kinds)
        local answer = T.http(mock, "PUT", "/v1/alerts/choices", { key = state.keys[name].key, body = { on = true, kinds = kinds } })
        T.eq(answer.status, 200, answer.body)
        return answer.json
    end
    -- The notify messages sent since the last look.
    function state.notified()
        return ofType(sent(connection), "notify")
    end
    sent(connection)
    return state
end

-- ---- the seal -----------------------------------------------------------------------------------

function tests.details_are_sealed_as_the_shared_vectors_say()
    Mock.startDriver()
    local Alerts = require("src.cloud.alerts")
    local vector = vectors()
    T.eq(Alerts.alertKey(vector.device.lock_key_hex), vector.device.alert_key_hex, "the alert key")
    T.eq(Alerts.alertKey(require("src.cloud.lock").deviceKey(vector.device.api_key)), vector.device.alert_key_hex, "from the API key's lock key")
    for _, detail in ipairs(vector.details) do
        local sealed = Alerts.seal(vector.device.lock_key_hex, vector.home, vector.key, detail.plaintext, detail.iv_hex)
        T.same(sealed, detail.sealed, detail.name)
        -- The detail as the driver writes it: its JSON padded with spaces to one size.
        T.eq(Alerts.plaintext(Json.decode(detail.plaintext)), detail.plaintext, detail.name .. ": padded")
        T.eq(#detail.plaintext, Alerts.DETAIL_BYTES)
    end
    -- Another key, another home: another seal.
    local detail = vector.details[1]
    T.truthy(Alerts.seal(vector.device.lock_key_hex, vector.home, "0badc0de", detail.plaintext, detail.iv_hex).mac ~= detail.sealed.mac)
    T.truthy(Alerts.seal(vector.device.lock_key_hex, "ffeeddccbbaa99887766554433221100", vector.key, detail.plaintext, detail.iv_hex).mac ~= detail.sealed.mac)
end

-- ---- the choices --------------------------------------------------------------------------------

function tests.each_key_chooses_its_own_alerts_among_those_of_its_role()
    local mock = Mock.startDriver()
    local admin = T.pair(mock, "Chrome on Windows")
    local function create(role)
        return T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = role .. " phone", role = role } }).json.key
    end
    local viewer, member, doors = create("viewer"), create("member"), create("doors")
    local system = T.http(mock, "GET", "/v1/system", { key = viewer }).json
    T.eq(system.features.alert_choices, true, "the app knows it may ask")

    -- Off until the device switches them on; everything else on, but doors opened.
    local mine = T.http(mock, "GET", "/v1/alerts/choices", { key = admin })
    T.eq(mine.status, 200, mine.body)
    T.same(mine.json, { on = false, kinds = { doorbell = true, door_opened = false, schedule_failed = true } })
    -- The refrigerator's door is not there: this home has none (yet).
    -- A viewer of 1.7.0 has no rooms (ADR-054): no doorbell of theirs.
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = viewer }).json, { on = false, kinds = {} }, "a viewer: nothing")
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = member }).json.kinds, { doorbell = true })
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = doors }).json.kinds, { doorbell = true })

    local changed = T.http(mock, "PUT", "/v1/alerts/choices", { key = admin, body = { on = true, kinds = { door_opened = true, doorbell = false } } })
    T.eq(changed.status, 200, changed.body)
    T.same(changed.json, { on = true, kinds = { doorbell = false, door_opened = true, schedule_failed = true } })
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = admin }).json, changed.json, "kept")
    T.same(T.http(mock, "PUT", "/v1/alerts/choices", { key = admin, body = { on = false } }).json.kinds, changed.json.kinds, "switched off, the choices stay")
    -- Only its own: another key's are untouched.
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = viewer }).json, { on = false, kinds = {} })
    -- What its role may not get is not kept.
    T.same(T.http(mock, "PUT", "/v1/alerts/choices", { key = member, body = { on = true, kinds = { door_opened = true } } }).json, { on = true, kinds = { doorbell = true } })

    for _, body in ipairs({ {}, { on = "yes" }, { kinds = { doorbell = 1 } }, { kinds = { lights = true } }, { kinds = { true } }, { on = true, other = 1 } }) do
        local refused = T.http(mock, "PUT", "/v1/alerts/choices", { key = viewer, body = body })
        T.eq(refused.status, 400, Json.encode(body))
    end
    T.eq(T.http(mock, "GET", "/v1/alerts/choices").status, 401, "a key is needed")

    -- Kept through a driver update; a revoked key's go with it.
    local updated = Mock.updateDriver(mock)
    T.same(T.http(updated, "GET", "/v1/alerts/choices", { key = admin }).json, { on = false, kinds = { doorbell = false, door_opened = true, schedule_failed = true } })
    T.same(T.http(updated, "GET", "/v1/alerts/choices", { key = member }).json.on, true)
    local memberId = T.http(updated, "GET", "/v1/api-keys/current", { key = member }).json.id
    T.contains(updated.persist.directorlink_alert_choices, memberId)
    T.eq(T.http(updated, "DELETE", "/v1/api-keys/" .. memberId, { key = admin }).status, 204)
    T.notContains(updated.persist.directorlink_alert_choices, memberId, "a revoked key's choices go")
end

function tests.a_store_that_cannot_be_read_is_never_written_over()
    local mock = Mock.startDriver(nil, nil, nil, function(fresh)
        fresh.persist.directorlink_alert_choices = "json:{not json"
    end)
    local admin = T.pair(mock)
    local refused = T.http(mock, "PUT", "/v1/alerts/choices", { key = admin, body = { on = true } })
    T.eq(refused.status, 503)
    T.eq(refused.json.code, "UNAVAILABLE")
    T.eq(mock.persist.directorlink_alert_choices, "json:{not json", "left as it was")
end

-- ---- doorbells ----------------------------------------------------------------------------------

function tests.a_ring_goes_sealed_to_every_key_that_switched_alerts_on_and_wants_it()
    local home = home()
    home.add("Hall tablet", "member")
    home.add("Kids phone", "member")
    home.add("Guest phone", "viewer")
    home.on("admin")
    home.on("Hall tablet")
    home.on("Kids phone", { doorbell = false })
    -- Guest phone never switched them on.
    home.notified()

    -- DirectorLink's clock for its limits apart from the ring's own time.
    home.clock.now = os.time() + 3600
    T.eq(Mock.fireDeviceEvent(home.mock, 110, 102), 1, "the DoorBird rings")
    local notified = home.notified()
    T.eq(#notified, 1, "one message")
    local message = notified[1].message
    T.eq(message.brief, true, "a ring is worth something only for a minute")
    -- The ring's own time, as the app shows it (last_ring_at): it knows the alert's ring.
    local doorbell = T.http(home.mock, "GET", "/v1/doorbells/93", { key = home.admin }).json
    T.eq(message.at, doorbell.last_ring_at)
    -- And (1.10.1, ADR-073) a random id, for the relay to answer it.
    T.eq(count(message), 5, "type, at, brief, for and its id: nothing else in the clear")
    T.truthy(type(message.id) == "string" and message.id:match("^%x+$") and #message.id == 16, "16 random hex digits")
    T.eq(count(message["for"]), 2)
    for _, word in ipairs({ "Front Gate", "Kitchen", "doorbell", "Dana", "Hall" }) do
        T.notContains(notified[1].text, word, "no names and no kind in the clear")
    end
    for _, name in ipairs({ "admin", "Hall tablet" }) do
        local key = home.keys[name]
        local detail = open(key.key, home.home, key.id, message["for"][key.id])
        T.same(detail, { at = message.at, id = 93, kind = "doorbell", name = "Front Gate", room = "Kitchen", room_id = 10, v = 1 }, name)
    end
    T.eq(message["for"][home.keys["Kids phone"].id], nil, "it chose not to")

    -- Rung again within 30 s: one alert is enough. After, another.
    home.clock.now = home.clock.now + 20
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 0, "at most one in 30 s")
    home.clock.now = home.clock.now + 11
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 1)
    -- Motion is no alert.
    home.clock.now = home.clock.now + 60
    Mock.fireDeviceEvent(home.mock, 110, 103)
    T.eq(#home.notified(), 0)
end

-- 1.9.0 (ADR-062): the account service says which keys' browsers it no longer has ("alerts_gone":
-- their push service no longer knew them, or they went without the device telling the controller).
-- Their alerts are off from then on, kept so, until their app says otherwise.
function tests.a_key_whose_browser_the_account_service_dropped_gets_nothing_more()
    local home = home()
    home.add("Hall tablet", "member")
    home.on("admin")
    home.on("Hall tablet", { doorbell = true })
    home.notified()
    local tabletId = home.keys["Hall tablet"].id
    local function gone(message)
        ReceivedFromNetwork(6001, 443, Harness.serverFrame(1, Json.encode(message)))
    end

    -- Unknown key ids and anything that is not a list change nothing; never answered.
    gone({ type = "alerts_gone", id = "g1", keys = { "ffffffff", 7 } })
    gone({ type = "alerts_gone", id = "g2", keys = "all" })
    gone({ type = "alerts_gone", id = "g3" })
    T.eq(#sent(home.connection), 0, "no answer")
    T.eq(T.http(home.mock, "GET", "/v1/alerts/choices", { key = home.keys["Hall tablet"].key }).json.on, true)

    gone({ type = "alerts_gone", id = "g4", keys = { tabletId } })
    T.eq(#sent(home.connection), 0, "no answer")
    local choices = T.http(home.mock, "GET", "/v1/alerts/choices", { key = home.keys["Hall tablet"].key }).json
    T.eq(choices.on, false, "off, as if its app had said so")
    T.eq(choices.kinds.doorbell, true, "its kinds stay")
    T.eq(T.http(home.mock, "GET", "/v1/alerts/choices", { key = home.admin }).json.on, true, "another key's stay on")
    home.clock.now = os.time() + 3600
    Mock.fireDeviceEvent(home.mock, 110, 102)
    local notified = home.notified()
    T.eq(#notified, 1)
    T.eq(count(notified[1].message["for"]), 1, "only the admin's device")
    T.truthy(notified[1].message["for"][home.adminId])
    local logs = T.http(home.mock, "GET", "/v1/logs?category=alerts&limit=50", { key = home.admin }).body
    T.contains(logs, "alerts off for devices DirectorLink's servers can no longer reach")

    -- Kept through an update; its app switching alerts on again (its next start) brings them back.
    local updated = Mock.updateDriver(home.mock)
    T.eq(T.http(updated, "GET", "/v1/alerts/choices", { key = home.keys["Hall tablet"].key }).json.on, false, "kept")
    T.eq(T.http(updated, "PUT", "/v1/alerts/choices", { key = home.keys["Hall tablet"].key, body = { on = true } }).json.on, true)
end

function tests.nothing_goes_out_for_nobody_or_without_the_relay()
    local home = home()
    home.add("Hall tablet", "viewer")
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 0, "nobody switched alerts on: nothing at all")

    home.on("Hall tablet")
    Properties["Remote Access"] = "Off"
    OnPropertyChanged("Remote Access")
    home.connection.sent = ""
    home.clock.now = home.clock.now + 60
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(home.connection.sent, "", "nothing goes out without the relay")
end

-- ---- cameras (1.8.0, ADR-056) --------------------------------------------------------------------

-- The DirectorLink · Hikvision Camera driver's Alert goes sealed to the keys that chose camera
-- alerts and may see that camera, saying which camera, where and what it saw; at most one a camera
-- a minute; not brief.
function tests.a_camera_alert_goes_sealed_to_the_keys_that_chose_it_and_may_see_that_camera()
    local home = home(nil, Mock.withHikvisionCameras(Mock.project()))
    -- Members with every room and cameras (1.8.0, ADR-054: a viewer of 1.7.0 has no rooms).
    home.add("Hall tablet", "member")
    home.add("Kids phone", "member")
    home.add("Guest phone", "member")
    T.eq(T.http(home.mock, "GET", "/v1/system", { key = home.keys["Kids phone"].key }).json.features.camera_alerts, true, "the app may offer it")
    -- Offered to every role, off until chosen.
    for _, name in ipairs({ "admin", "Hall tablet", "Kids phone" }) do
        T.eq(T.http(home.mock, "GET", "/v1/alerts/choices", { key = home.keys[name].key }).json.kinds.camera, false, name)
    end
    home.on("admin", { camera = true })
    home.on("Hall tablet", { camera = true })
    home.on("Kids phone")
    T.eq(T.http(home.mock, "PUT", "/v1/alerts/choices", { key = home.keys["Guest phone"].key, body = { kinds = { camera = true } } }).status, 200, "chosen, but its device never switched alerts on")
    home.notified()

    home.clock.now = home.clock.now + 3600
    T.eq(Mock.hikvisionAlert(home.mock, 150, "Person"), 1, "the camera's driver raises an alert")
    local notified = home.notified()
    T.eq(#notified, 1, "one message")
    local message = notified[1].message
    T.eq(message.brief, nil, "not brief")
    T.eq(count(message), 4, "type, at, for and its id (1.10.1): nothing else in the clear")
    T.eq(count(message["for"]), 2, "the admin and the hall tablet; not the member who did not choose it, nor the guest")
    for _, word in ipairs({ "Garden", "Living Room", "camera", "erson" }) do
        T.notContains(notified[1].text, word, "no names and no kind in the clear")
    end
    for _, name in ipairs({ "admin", "Hall tablet" }) do
        local key = home.keys[name]
        local detail = open(key.key, home.home, key.id, message["for"][key.id])
        T.same(detail, { at = message.at, id = 65, kind = "camera", name = "Garden", room = "Living Room", room_id = 11, what = "person", v = 1 }, name)
    end

    -- Again within a minute: one is enough. Another camera is its own.
    home.clock.now = home.clock.now + 30
    Mock.hikvisionAlert(home.mock, 150, "Vehicle")
    T.eq(#home.notified(), 0, "at most one a camera a minute")
    Mock.hikvisionAlert(home.mock, 151, "Line Crossing")
    notified = home.notified()
    T.eq(#notified, 1)
    local key = home.keys.admin
    local detail = open(key.key, home.home, key.id, notified[1].message["for"][key.id])
    T.eq(detail.name, "Back Gate")
    T.eq(detail.what, "line_crossing")
    home.clock.now = home.clock.now + 31
    Mock.hikvisionAlert(home.mock, 150, "Something new")
    notified = home.notified()
    T.eq(#notified, 1, "a minute later, again")
    T.eq(open(key.key, home.home, key.id, notified[1].message["for"][key.id]).what, "other", "a label DirectorLink does not know")

    -- Its detections alone (Person Detected, 4) are no alert: the driver's Alert is.
    home.clock.now = home.clock.now + 120
    T.eq(Mock.fireDeviceEvent(home.mock, 150, 4), 0, "not even watched")
    T.eq(#home.notified(), 0)

    -- Only the keys that may see that camera's pictures (src/auth/access.lua decides).
    local Access = require("src.auth.access")
    local canSeePictures = Access.canSeePictures
    local hall = home.keys["Hall tablet"].id
    Access.canSeePictures = function(actor, device)
        if actor.id == hall and tonumber(device.id) == 65 then
            return false
        end
        return canSeePictures(actor, device)
    end
    Mock.hikvisionAlert(home.mock, 150, "Intrusion")
    notified = home.notified()
    Access.canSeePictures = canSeePictures
    T.eq(count(notified[1].message["for"]), 1)
    T.eq(notified[1].message["for"][hall], nil, "the hall tablet may not see the garden")
end

-- Control4's own camera drivers raise nothing new; a home without the Hikvision drivers is not
-- offered camera alerts; the choice is kept like the others.
function tests.only_the_directorlink_hikvision_cameras_raise_alerts()
    local plain = home()
    T.eq(T.http(plain.mock, "GET", "/v1/system", { key = plain.admin }).json.features.camera_alerts, false)
    T.eq(T.http(plain.mock, "GET", "/v1/alerts/choices", { key = plain.admin }).json.kinds.camera, nil, "not offered")
    plain.on("admin", { camera = true })
    plain.notified()
    -- Driveway's driver is Control4's Hikvision driver (camera_ip_hik_ipc_static.c4z).
    for _, eventId in ipairs({ 1, 2, 4 }) do
        T.eq(Mock.fireDeviceEvent(plain.mock, 107, eventId), 0, "its events are not watched")
    end
    local registry = require("src.core.registry")
    require("src.cloud.alerts").deviceEvent(registry.getDevice(60), 1, {})
    T.eq(#plain.notified(), 0)
    for _, watched in ipairs(plain.mock.deviceEvents) do
        T.truthy(watched[1] ~= 107 and watched[1] ~= 60, "nothing watched on a Control4 camera")
    end

    -- The Hikvision driver also as Composer installs a second download of it.
    local project = Mock.withHikvisionCameras(Mock.project(), {
        { id = 67, protocol = 152, name = "Pool", room = 11, address = "192.0.2.33", driver = "DirectorLink-Hikvision-Camera (1).c4z" },
    })
    local copy = home(nil, project)
    T.eq(T.http(copy.mock, "GET", "/v1/system", { key = copy.admin }).json.features.camera_alerts, true)
    local chosen = copy.on("admin", { camera = true })
    T.eq(chosen.kinds.camera, true)
    copy.notified()
    copy.clock.now = copy.clock.now + 60
    Mock.hikvisionAlert(copy.mock, 152, "Person")
    T.eq(#copy.notified(), 1)
    -- Kept through a driver update.
    local updated = Mock.updateDriver(copy.mock, project)
    T.eq(T.http(updated, "GET", "/v1/alerts/choices", { key = copy.admin }).json.kinds.camera, true)
end

-- Busy cameras leave room for the rest: at most 30 camera alerts an hour, of the 60 in all.
function tests.camera_alerts_are_at_most_thirty_an_hour()
    local home = home()
    home.on("admin", { camera = true })
    home.notified()
    local Alerts = require("src.cloud.alerts")
    for index = 1, 30 do
        home.clock.now = home.clock.now + 10
        T.eq(Alerts.camera({ id = 1000 + index, name = "Camera " .. index, state = { alert = { what = "motion" } } }), 1)
    end
    home.clock.now = home.clock.now + 10
    local none, why = Alerts.camera({ id = 2000, name = "One more", state = { alert = { what = "motion" } } })
    T.eq(none, nil)
    T.eq(why, "limit")
    T.eq(#home.notified(), 30)
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 1, "a ring still goes")
    home.clock.now = home.clock.now + 3600
    T.eq(Alerts.camera({ id = 2000, name = "One more", state = { alert = { what = "motion" } } }), 1, "an hour later, again")
end

-- A smoke or CO alarm a camera heard (1.11.0, ADR-080) is not held back behind that camera's other
-- alerts: it has a minute of its own per camera and label. The other labels keep the camera's minute.
function tests.a_smoke_or_co_alarm_is_not_held_back_by_the_cameras_other_alerts()
    local home = home(nil, Mock.withHikvisionCameras(Mock.project()))
    home.on("admin", { camera = true })
    home.notified()
    local key = home.keys.admin
    -- What the alerts since the last look said they saw, as the admin's device opens them.
    local function said()
        local list = {}
        for _, item in ipairs(home.notified()) do
            list[#list + 1] = open(key.key, home.home, key.id, item.message["for"][key.id]).what
        end
        return list
    end

    home.clock.now = home.clock.now + 3600
    Mock.hikvisionAlert(home.mock, 150, "Motion")
    T.same(said(), { "motion" })
    home.clock.now = home.clock.now + 20
    Mock.hikvisionAlert(home.mock, 150, "Smoke alarm")
    Mock.hikvisionAlert(home.mock, 150, "Person")
    Mock.hikvisionAlert(home.mock, 150, "CO alarm")
    Mock.hikvisionAlert(home.mock, 150, "Glass break")
    T.same(said(), { "smoke_alarm", "co_alarm" }, "the alarms go within the minute of a motion; a person and glass breaking wait")
    home.clock.now = home.clock.now + 20
    Mock.hikvisionAlert(home.mock, 150, "SMOKE_ALARM")
    T.same(said(), {}, "one smoke alarm a camera a minute")
    Mock.hikvisionAlert(home.mock, 151, "Smoke alarm")
    T.same(said(), { "smoke_alarm" }, "another camera's is its own")
    -- The camera's minute after its motion is over: anything again; its smoke alarm's minute is not.
    home.clock.now = home.clock.now + 21
    Mock.hikvisionAlert(home.mock, 150, "Barking")
    Mock.hikvisionAlert(home.mock, 150, "Speech")
    T.same(said(), { "barking" }, "noisy sounds keep the camera's minute")
    Mock.hikvisionAlert(home.mock, 150, "Smoke alarm")
    T.same(said(), {}, "41 seconds after the last smoke alarm")
    home.clock.now = home.clock.now + 20
    Mock.hikvisionAlert(home.mock, 150, "Smoke alarm")
    T.same(said(), { "smoke_alarm" }, "a minute after it")
end

-- A busy camera cannot use up what a smoke or CO alarm needs (ADR-080): they count apart from the
-- cameras' 30 an hour, at most 10 an hour of their own, and the home's 60 an hour holds for them too.
function tests.smoke_and_co_alarms_have_an_hour_of_their_own_within_the_homes_sixty()
    local home = home()
    home.on("admin", { camera = true })
    home.notified()
    local Alerts = require("src.cloud.alerts")
    T.eq(Alerts.URGENT_PER_HOUR, 10)
    local function camera(id, what)
        return Alerts.camera({ id = id, name = "Camera " .. id, state = { alert = { what = what } } })
    end
    for index = 1, 30 do
        home.clock.now = home.clock.now + 10
        T.eq(camera(1000 + index, "motion"), 1)
    end
    home.clock.now = home.clock.now + 10
    T.eq(select(2, camera(2000, "person")), "limit", "the cameras' 30")
    T.eq(select(2, camera(2001, "glass_break")), "limit", "a sound that is not an alarm counts with the cameras")
    for index = 1, 10 do
        home.clock.now = home.clock.now + 10
        local what = index % 2 == 0 and "co_alarm" or "smoke_alarm"
        T.eq(camera(3000 + index, what), 1, what .. " " .. index)
    end
    home.clock.now = home.clock.now + 10
    local none, why = camera(4000, "smoke_alarm")
    T.eq(none, nil)
    T.eq(why, "limit", "10 an hour")
    T.eq(#home.notified(), 40)
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 1, "a ring still goes")

    -- An hour later: the home's 60 hold for them too.
    home.clock.now = home.clock.now + 3600
    for index = 1, 60 do
        home.clock.now = home.clock.now + 1
        T.eq(Alerts.ring({ id = 5000 + index, name = "Door " .. index }), 1)
    end
    home.notified()
    T.eq(select(2, camera(4001, "co_alarm")), "limit", "the home's 60")
    T.eq(#home.notified(), 0)
end

-- ---- doors and gates ----------------------------------------------------------------------------

function tests.doors_opened_reach_the_admins_who_chose_it_saying_which_and_who()
    local home = home(function()
        Properties["Door Control"] = "Enabled"
        Properties["Relay Hold"] = "Allowed"
    end)
    home.add("Avi's laptop", "admin")
    home.add("Gate phone", "doors")
    home.on("admin", { door_opened = true })
    home.on("Avi's laptop") -- doors opened is off unless chosen
    home.on("Gate phone", { door_opened = true }) -- not for its role
    home.notified()

    local gatePhone = home.keys["Gate phone"].key
    T.eq(T.http(home.mock, "POST", "/v1/relays/70/pulse", { key = gatePhone }).status, 202)
    local notified = home.notified()
    T.eq(#notified, 1)
    local message = notified[1].message
    T.eq(message.brief, nil, "kept as long as other alerts")
    T.eq(count(message["for"]), 1, "Dana only")
    T.notContains(notified[1].text, "Main Door")
    local detail = open(home.admin, home.home, home.adminId, message["for"][home.adminId])
    T.same(detail, {
        action = "pulse",
        at = message.at,
        id = 70,
        kind = "door_opened",
        name = "Main Door",
        room = "Kitchen",
        room_id = 10,
        v = 1,
        who = { name = "Gate phone", profile = "Gate phone", type = "key" },
    })

    -- The relay then reports that it closed and opened again: DirectorLink's own pulse, nothing more.
    home.clock.now = home.clock.now + 1
    T.eq(Mock.fireDeviceEvent(home.mock, 70, 4), 1)
    Mock.fireDeviceEvent(home.mock, 70, 3)
    T.eq(#home.notified(), 0)

    -- Opened in Control4 (its app, a keypad): in the history, and to the admins, as Control4's.
    home.clock.now = home.clock.now + 120
    Mock.fireDeviceEvent(home.mock, 70, 4)
    Mock.fireDeviceEvent(home.mock, 70, 3)
    local outside = home.notified()
    T.eq(#outside, 1)
    detail = open(home.admin, home.home, home.adminId, outside[1].message["for"][home.adminId])
    T.eq(detail.action, "pulse")
    T.same(detail.who, { type = "control4" })
    local history = T.http(home.mock, "GET", "/v1/activity?kind=door", { key = home.admin }).json.items
    T.eq(history[1].who.type, "control4", "the history says so too")
    T.eq(history[1].what, "Main Door")
    T.eq(#history, 2, "and DirectorLink's own pulse once")

    -- Opened again within the minute: one alert, and one entry, a door a minute.
    home.clock.now = home.clock.now + 30
    Mock.fireDeviceEvent(home.mock, 70, 4)
    Mock.fireDeviceEvent(home.mock, 70, 3)
    T.eq(#home.notified(), 0)
    T.eq(#T.http(home.mock, "GET", "/v1/activity?kind=door", { key = home.admin }).json.items, 2)
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 70, 4)
    Mock.fireDeviceEvent(home.mock, 70, 3)
    T.eq(#home.notified(), 1)
    T.eq(#T.http(home.mock, "GET", "/v1/activity?kind=door", { key = home.admin }).json.items, 3)

    -- The gate at a doorbell, opened from the DoorBird's own app: the same.
    home.clock.now = home.clock.now + 5
    Mock.fireDeviceEvent(home.mock, 110, 104)
    detail = open(home.admin, home.home, home.adminId, home.notified()[1].message["for"][home.adminId])
    T.eq(detail.action, "doorbell")
    T.eq(detail.name, "Front Gate")
    T.same(detail.who, { type = "control4" })

    -- Opened by a scene: which scene.
    home.clock.now = home.clock.now + 120
    local scene = T.http(home.mock, "POST", "/v1/scenes", { key = home.admin, body = { name = "Good night", steps = { { type = "relays", device_ids = { 70 }, set = { action = "pulse" } } } } }).json
    T.eq(T.http(home.mock, "POST", "/v1/scenes/" .. scene.id .. "/run", { key = home.admin }).status, 202)
    detail = open(home.admin, home.home, home.adminId, home.notified()[1].message["for"][home.adminId])
    T.eq(detail.via, "Good night")
    T.same(detail.who, { name = "Chrome on Windows", profile = "Dana", type = "key" })

    -- Held open is an opening; released is not.
    home.clock.now = home.clock.now + 120
    T.eq(T.http(home.mock, "PATCH", "/v1/relays/70", { key = home.admin, body = { state = "closed" } }).status, 202)
    T.eq(open(home.admin, home.home, home.adminId, home.notified()[1].message["for"][home.adminId]).action, "hold")
    home.clock.now = home.clock.now + 120
    T.eq(T.http(home.mock, "PATCH", "/v1/relays/70", { key = home.admin, body = { state = "open" } }).status, 202)
    T.eq(#home.notified(), 0)
end

-- A relay that reports "closed" again without opening in between (a status read after a restart, a
-- report its KNX driver repeats), or whose state is not known yet, opened nothing.
function tests.a_relay_that_says_closed_again_opened_nothing()
    local home = home(function()
        Properties["Door Control"] = "Enabled"
        Properties["Relay Hold"] = "Allowed"
    end)
    home.on("admin", { door_opened = true })
    home.notified()
    local function entries()
        return #T.http(home.mock, "GET", "/v1/activity?kind=door", { key = home.admin }).json.items
    end

    -- Its first report after the driver started: what it was before is not known.
    home.clock.now = home.clock.now + 100
    T.eq(Mock.fireDeviceEvent(home.mock, 70, 4), 1)
    T.eq(#home.notified(), 0)
    T.eq(entries(), 0)
    Mock.fireDeviceEvent(home.mock, 70, 3)

    -- Held open from the app (the relay closes), then "closed" again, twice: one opening, the hold.
    home.clock.now = home.clock.now + 100
    T.eq(T.http(home.mock, "PATCH", "/v1/relays/70", { key = home.admin, body = { state = "closed" } }).status, 202)
    Mock.fireDeviceEvent(home.mock, 70, 4)
    T.eq(#home.notified(), 1, "the hold")
    for _ = 1, 2 do
        home.clock.now = home.clock.now + 100
        Mock.fireDeviceEvent(home.mock, 70, 4)
    end
    T.eq(#home.notified(), 0, "the same state again is no opening")
    T.eq(entries(), 1)
    T.eq(T.http(home.mock, "GET", "/v1/relays/70", { key = home.admin }).json.state, "closed")
end

-- Every part is sealed at one size, whatever its kind and names: the cloud cannot tell a ring from
-- a door, a refrigerator or a schedule by its length.
function tests.every_alert_is_sealed_at_one_size()
    local home = home(function()
        Properties["Door Control"] = "Enabled"
    end)
    home.on("admin", { door_opened = true })
    home.notified()
    local Alerts = require("src.cloud.alerts")
    local sizes = {}
    local function look(what)
        local notified = home.notified()
        T.eq(#notified, 1, what)
        local part = notified[1].message["for"][home.adminId]
        sizes[#sizes + 1] = #part.ct
        local detail, plaintext = open(home.admin, home.home, home.adminId, part)
        T.eq(#plaintext, Alerts.DETAIL_BYTES, what .. ": padded")
        T.truthy(plaintext:match("}%s+$"), what .. ": with spaces")
        return detail
    end

    home.clock.now = home.clock.now + 100
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(look("a ring").kind, "doorbell")
    home.clock.now = home.clock.now + 100
    T.eq(T.http(home.mock, "POST", "/v1/relays/70/pulse", { key = home.admin }).status, 202)
    T.eq(look("a door opened by a key").who.type, "key")
    home.clock.now = home.clock.now + 100
    Mock.fireDeviceEvent(home.mock, 70, 3)
    Mock.fireDeviceEvent(home.mock, 70, 4)
    T.eq(look("a door opened in Control4").who.type, "control4")
    home.clock.now = home.clock.now + 100
    Alerts.fridgeDoor({ id = 500, name = "Refrigerator", room_name = "Kitchen", room_id = 10 }, 400)
    T.eq(look("the refrigerator").minutes, 6)
    home.clock.now = home.clock.now + 100
    Alerts.scheduleFailed(home.clock.now, { what = "Morning blinds" })
    T.eq(look("a schedule").name, "Morning blinds")
    home.clock.now = home.clock.now + 100
    T.eq(T.http(home.mock, "PUT", "/v1/alerts/choices", { key = home.admin, body = { kinds = { camera = true } } }).status, 200)
    home.notified()
    local long = string.rep("\215\169", 40)
    Alerts.camera({ id = 65, name = long, room_name = long, room_id = 11, state = { alert = { what = "region_entrance" } } })
    T.eq(look("a camera").what, "region_entrance")
    T.same(sizes, { 684, 684, 684, 684, 684, 684 }, "512 bytes, in base64")
end

-- Names that take more room in JSON (a quote or a backslash takes two bytes) are shortened, whole
-- characters at a time and the longest first, until the detail fits: the alert is never dropped.
function tests.a_detail_too_large_has_its_names_shortened()
    local home = home()
    home.on("admin", { door_opened = true })
    home.notified()
    local Alerts = require("src.cloud.alerts")
    local quotes = string.rep('"', 30) .. string.rep("x", 30)
    local hebrew = string.rep("\215\169", 30) -- 30 letters, 60 bytes
    T.eq(Alerts.doorOpened({
        kind = "door", action = "pulse", what = quotes, room = hebrew, via = quotes,
        who = { type = "key", name = quotes, profile = "Dana", remote = true },
        ids = { device_id = 7001, room_id = 9001 },
    }, home.clock.now + 100), 1)
    local part = home.notified()[1].message["for"][home.adminId]
    T.eq(#part.ct, 684)
    local detail, plaintext = open(home.admin, home.home, home.adminId, part)
    T.eq(#plaintext, Alerts.DETAIL_BYTES)
    for _, item in ipairs({ { detail.name, quotes }, { detail.room, hebrew }, { detail.via, quotes }, { detail.who.name, quotes } }) do
        T.truthy(#item[1] < 60, "shortened")
        T.eq(item[2]:sub(1, #item[1]), item[1], "from its start")
    end
    T.eq(#detail.room % 2, 0, "whole letters")
    T.eq(detail.who.profile, "Dana", "a short name is kept whole")
    T.eq(detail.kind, "door_opened")
end

-- ---- the refrigerator ---------------------------------------------------------------------------

function tests.the_refrigerator_door_reaches_members_and_admins()
    local home = home()
    home.add("Kids phone", "member")
    home.add("Hall tablet", "viewer")
    home.on("admin")
    home.on("Kids phone")
    home.on("Hall tablet")
    home.notified()
    local Alerts = require("src.cloud.alerts")
    -- Members choose it only in a home with a refrigerator: the integration says so (hasFridge).
    local kids = home.keys["Kids phone"]
    T.eq(T.http(home.mock, "GET", "/v1/alerts/choices", { key = kids.key }).json.kinds.fridge_door, nil)
    -- A refrigerator in the kitchen, as the registry would list it.
    local fridge = { id = 500, kind = "refrigerator", name = "Refrigerator", room_name = "Kitchen", room_id = 10 }
    local Registry = require("src.core.registry")
    Alerts.start({
        relay = require("src.cloud.relay"),
        remote = require("src.cloud.remote"),
        keys = require("src.auth.keys"),
        registry = setmetatable({ refrigeratorList = function()
            return { fridge }
        end }, { __index = Registry }),
        adapters = require("src.adapters.manager"),
        activity = require("src.core.activity"),
        hasFridge = function()
            return true
        end,
    })
    T.same(T.http(home.mock, "GET", "/v1/alerts/choices", { key = kids.key }).json.kinds, { doorbell = true, fridge_door = true })
    T.same(T.http(home.mock, "GET", "/v1/alerts/choices", { key = home.keys["Hall tablet"].key }).json.kinds, {}, "not for a viewer, who has no rooms")
    T.eq(Alerts.fridgeDoor(fridge, 300), 2)
    local message = home.notified()[1].message
    T.eq(count(message["for"]), 2, "not the viewer")
    T.same(open(kids.key, home.home, kids.id, message["for"][kids.id]), {
        at = message.at, id = 500, kind = "fridge_door", minutes = 5, name = "Refrigerator", room = "Kitchen", room_id = 10, v = 1,
    })
    home.clock.now = home.clock.now + 120
    T.eq(Alerts.fridgeDoor(fridge, 420), nil, "once in 5 minutes")
    T.eq(#home.notified(), 0)
    home.clock.now = home.clock.now + 200
    T.eq(Alerts.fridgeDoor(fridge), 2)
end

-- Who gets an alert asks Access (ADR-054): a ring and the refrigerator's door go to those who see
-- that doorbell or refrigerator (its room theirs; the refrigerator a kind they have), cameras or not;
-- doors opened and schedules that failed to admins only.
function tests.alerts_go_to_those_who_see_what_they_are_about()
    local home = home()
    local function member(name, access)
        local created = T.http(home.mock, "POST", "/v1/api-keys", { key = home.admin, body = { name = name, role = "member", access = access } })
        T.eq(created.status, 201, created.body)
        home.keys[name] = { key = created.json.key, id = created.json.id }
    end
    member("Living room", { all_rooms = false, rooms = { 11 } })
    member("No cameras", { cameras = false })
    member("No fridge", { kinds = { refrigerator = false } })
    member("Doors", { doors = true })
    for _, name in ipairs({ "admin", "Living room", "No cameras", "No fridge", "Doors" }) do
        home.on(name, { door_opened = true })
    end
    home.notified()
    home.clock.now = os.time() + 3600
    T.eq(Mock.fireDeviceEvent(home.mock, 110, 102), 1)
    local ring = home.notified()[1].message["for"]
    T.truthy(ring[home.keys["No cameras"].id] and ring[home.keys["No fridge"].id] and ring[home.keys.Doors.id] and ring[home.adminId], "whoever sees the doorbell")
    T.eq(ring[home.keys["Living room"].id], nil, "the doorbell's room is not theirs")
    T.same(T.http(home.mock, "GET", "/v1/alerts/choices", { key = home.keys["Living room"].key }).json.kinds, {}, "nothing offered to them")

    local Alerts = require("src.cloud.alerts")
    local fridge = { id = 500, name = "Refrigerator", room_name = "Kitchen", room_id = 10 }
    Alerts.fridgeDoor(fridge, 300)
    local cold = home.notified()[1].message["for"]
    T.eq(cold[home.keys["No fridge"].id], nil, "not given refrigerators")
    T.eq(cold[home.keys["Living room"].id], nil)
    T.truthy(cold[home.keys["No cameras"].id] and cold[home.adminId])

    Properties["Door Control"] = "Enabled"
    T.eq(T.http(home.mock, "POST", "/v1/relays/70/pulse", { key = home.keys.Doors.key }).status, 202)
    local opened = home.notified()[1].message["for"]
    T.eq(count(opened), 1, "doors opened: the admins only, even for a member who opens doors")
    T.truthy(opened[home.adminId])
end

-- The integration (src/main.lua): the refrigerator driver's Door Left Open goes to the history and
-- to the members who chose it, and a home with a refrigerator offers it to members by itself.
function tests.a_refrigerator_door_left_open_alerts_through_the_integration()
    local mock = Mock.startDriver(Mock.withRefrigerator(Mock.project()))
    local _, connection = Harness.connected({ mock = mock })
    local admin = T.pair(mock, "Chrome on Windows")
    local created = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = "Kids phone", role = "member" } })
    T.eq(created.status, 201, created.body)
    local member = created.json
    T.eq(T.http(mock, "GET", "/v1/alerts/choices", { key = member.key }).json.kinds.fridge_door, true, "offered with a refrigerator")
    T.eq(T.http(mock, "PUT", "/v1/alerts/choices", { key = member.key, body = { on = true } }).status, 200)
    -- The admin wants doors opened only, not the refrigerator.
    local adminId = T.http(mock, "GET", "/v1/api-keys/current", { key = admin }).json.id
    T.eq(T.http(mock, "PUT", "/v1/alerts/choices", { key = admin, body = { on = true, kinds = { door_opened = true, fridge_door = false } } }).status, 200)
    sent(connection)

    local Clock = require("src.core.clock")
    local now = os.time()
    Clock.now = function()
        return now
    end
    Mock.setRefrigerator(mock, 140, { DOOR_OPEN = "1" })
    now = now + 7 * 60 + 59
    Mock.fireDeviceEvent(mock, 140, 15)
    local messages = ofType(sent(connection), "notify")
    T.eq(#messages, 1)
    local home = require("src.cloud.relay").identity().home_id
    local detail = open(member.key, home, member.id, messages[1].message["for"][member.id])
    T.eq(detail.kind, "fridge_door")
    T.eq(detail.id, 141)
    T.eq(detail.name, "Refrigerator")
    T.eq(detail.room, "Kitchen")
    T.eq(detail.minutes, 7, "open at least since DirectorLink saw it open, in whole minutes")
    -- Not a door or gate opened: the admin, who chose doors and not the refrigerator, gets nothing.
    T.eq(count(messages[1].message["for"]), 1)
    T.eq(messages[1].message["for"][adminId], nil)
end

-- ---- schedules ----------------------------------------------------------------------------------

function tests.a_schedule_that_fails_tells_its_admins_sealed_and_names_nothing_in_the_clear()
    local home = home()
    home.add("Avi's laptop", "admin")
    home.add("Kids phone", "member")
    home.on("admin")
    home.on("Avi's laptop", { schedule_failed = false })
    home.on("Kids phone")
    local Scheduler = require("src.core.scheduler")
    local scene = T.http(home.mock, "POST", "/v1/scenes", { key = home.admin, body = { name = "Morning blinds", steps = { { type = "lights", device_ids = { 20 }, set = { on = true } } } } })
    T.eq(scene.status, 201, scene.body)
    local schedule = T.http(home.mock, "POST", "/v1/schedules", { key = home.admin, body = { scene_id = scene.json.id, trigger = { type = "time", at = "08:00" }, days = { 0, 1, 2, 3, 4, 5, 6 } } })
    T.eq(schedule.status, 201, schedule.body)
    home.notified()

    -- It runs: nothing to tell.
    home.clock.now = at(1, 8, 0) + 5
    T.eq(Scheduler.tick(), 1)
    T.eq(#home.notified(), 0, "a schedule that ran tells nothing")

    -- A device refuses: the admins who want it, with the scene's name, sealed.
    local Manager = require("src.adapters.manager")
    local execute = Manager.execute
    Manager.execute = function()
        return false, { code = "DEVICE_UNAVAILABLE", message = "Living room light did not answer" }
    end
    home.clock.now = at(2, 8, 0) + 5
    local ok, err = pcall(function()
        T.eq(Scheduler.tick(), 1)
    end)
    Manager.execute = execute
    T.truthy(ok, err)
    local notified = home.notified()
    T.eq(#notified, 1, "one alert")
    T.eq(#ofType(sent(home.connection), "alert"), 0, "no longer the alert of 1.6.0, which named its kind")
    local message = notified[1].message
    T.eq(count(message["for"]), 1, "Dana only: Avi chose not to, the member may not")
    for _, word in ipairs({ "Morning", "Living", scene.json.id, schedule.json.id, "DEVICE", "schedule" }) do
        T.notContains(notified[1].text, word, "no names, ids or kind in the clear")
    end
    local detail = open(home.admin, home.home, home.adminId, message["for"][home.adminId])
    T.same(detail, { at = os.date("!%Y-%m-%dT%H:%M:%SZ", home.clock.now), kind = "schedule_failed", name = "Morning blinds", v = 1 })

    -- At most three an hour.
    local Alerts = require("src.cloud.alerts")
    for _ = 1, 4 do
        Alerts.scheduleFailed(home.clock.now, { what = "Morning blinds" })
    end
    T.eq(#home.notified(), 2, "three in the hour with the first")
    home.clock.now = home.clock.now + 3601
    T.eq(Alerts.scheduleFailed(home.clock.now, { what = "Morning blinds" }), 1)
end

-- ---- the limit ----------------------------------------------------------------------------------

function tests.at_most_sixty_alerts_an_hour_leave_the_controller()
    local home = home()
    home.on("admin")
    home.notified()
    for _ = 1, 60 do
        home.clock.now = home.clock.now + 31
        Mock.fireDeviceEvent(home.mock, 110, 102)
    end
    T.eq(#home.notified(), 60)
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 0, "the 61st in the hour waits")
    home.clock.now = home.clock.now + 3600
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 1)
end

-- ---- sent again after a lost connection (1.10.1, ADR-073) ----------------------------------------

local function Outbox()
    return require("src.cloud.outbox")
end

local features = 0

-- The relay says it answers alerts, as a relay from 1.10.1 does right after the hello.
local function answersAlerts()
    features = features + 1
    Harness.relaySays({ type = "relay_features", id = "features-" .. features, features = { "alert_acks" } })
end

local function has(list, value)
    for _, item in ipairs(list or {}) do
        if item == value then
            return true
        end
    end
    return false
end

-- The timers that bound how long alerts are kept (src/cloud/outbox.lua), not run or cancelled.
local function keeping(mock)
    local found = {}
    for _, timer in ipairs(mock.timers) do
        if not timer.fired and not timer.cancelled and (timer.source or ""):find("cloud/outbox", 1, true) then
            found[#found + 1] = timer
        end
    end
    return found
end

-- The relay connection's keep-alive tick (every 5 s).
local function keepalive(mock)
    for index = #mock.timers, 1, -1 do
        local timer = mock.timers[index]
        if timer.repeating and not timer.cancelled and timer.delay == 5000 and (timer.source or ""):find("cloud/relay", 1, true) then
            return timer
        end
    end
    return nil
end

-- The 21:01 case for alerts: the doorbell rang just as the connection died without a close, so the
-- ring went into the dead connection and the relay never had it (up to 1.10.0 it was lost). After
-- the reconnect, once the relay says it answers alerts, the driver sends the same ring again: the
-- same id and the same sealed parts (not sealed again), marked resent. A ring the relay answered
-- goes no more.
function tests.a_ring_sent_into_a_dead_connection_goes_again_after_the_reconnect()
    local home = home()
    home.on("admin")
    answersAlerts()
    home.notified()
    home.clock.now = os.time() + 3600
    T.eq(Mock.fireDeviceEvent(home.mock, 110, 102), 1)
    local answered = home.notified()[1].message
    Harness.relaySays({ type = "notify_result", id = answered.id, ok = true })
    T.eq(Outbox().counts(), 0, "answered: kept no more")
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    local first = home.notified()
    T.eq(#first, 1)
    local ring = first[1].message
    T.truthy(ring.id ~= answered.id, "each alert its own id")
    T.eq(Outbox().counts(), 1, "kept until the relay answers it")

    local hello = Harness.reconnect(home.mock, home.connection)
    T.truthy(has(hello.features, "alert_acks"), "the hello says the driver keeps its alerts")
    T.eq(#home.notified(), 0, "nothing before the relay says it answers alerts")
    answersAlerts()
    local again = home.notified()
    T.eq(#again, 1, "sent again, once: not the ring the relay answered")
    local resent = again[1].message
    T.eq(resent.id, ring.id, "the same id")
    T.eq(resent.resent, 1)
    T.eq(resent.at, ring.at)
    T.eq(resent.brief, true)
    T.same(resent["for"], ring["for"], "the same sealed parts")
    T.eq(count(resent), 6, "type, at, brief, for, id and resent: nothing else in the clear")

    Harness.relaySays({ type = "notify_result", id = ring.id, ok = true })
    T.eq(Outbox().counts(), 0)
    T.eq(#keeping(home.mock), 0, "and its timer is gone")
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    T.eq(#home.notified(), 0, "answered: never again")
    local logs = T.http(home.mock, "GET", "/v1/logs?category=relay&limit=100", { key = home.admin }).body
    T.contains(logs, "alerts sent again")
end

-- A ring sent into a connection that died, and the next connection died too before the relay said
-- anything (the route flipping again): the driver cannot tell that relay's answer, so it keeps the
-- ring, and the connection after sends it again (resent twice).
function tests.an_alert_is_kept_through_a_connection_that_died_before_the_relay_said_anything()
    local home = home()
    home.on("admin")
    answersAlerts()
    home.notified()
    home.clock.now = os.time() + 3600
    Mock.fireDeviceEvent(home.mock, 110, 102)
    local ring = home.notified()[1].message
    Harness.reconnect(home.mock, home.connection)
    -- Nothing heard on this one: its keep-alive tick decides nothing.
    keepalive(home.mock).callback()
    T.eq(Outbox().counts(), 1)
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    local again = home.notified()
    T.eq(#again, 1)
    T.eq(again[1].message.id, ring.id)
    T.eq(again[1].message.resent, 1, "it went once before: on the first connection")
end

-- The doorbell rang in the second the driver was reconnecting, after a relay that answers alerts:
-- the ring is sealed and kept, and goes after the next hello once the relay says it answers alerts
-- (not marked resent: it never went). Up to 1.10.0 it was not sent at all.
function tests.an_alert_made_while_the_driver_reconnects_goes_after_the_hello()
    local home = home()
    home.on("admin")
    answersAlerts()
    home.notified()
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    home.connection.sent = ""
    home.clock.now = os.time() + 3600
    T.eq(Mock.fireDeviceEvent(home.mock, 110, 102), 1)
    T.eq(home.connection.sent, "", "no connection to carry it")
    T.eq(Outbox().counts(), 1, "kept")
    Harness.reconnect(home.mock, home.connection)
    T.eq(#home.notified(), 0)
    answersAlerts()
    local sentNow = home.notified()
    T.eq(#sentNow, 1)
    T.eq(sentNow[1].message.resent, nil, "it never went before")
    T.truthy(sentNow[1].message.id)
    T.eq(count(sentNow[1].message["for"]), 1)
end

-- A relay before 1.10.1 never says it answers alerts. Once it is heard without saying so (what it
-- sends after the driver's keys, such as `alerts_gone`; or the second keep-alive tick after a pong),
-- what the driver kept is let go, and the alerts that follow go once, without an id, as from 1.10.0;
-- nothing goes again after a reconnect, and nothing is kept while the connection is down.
function tests.a_relay_that_does_not_answer_alerts_gets_each_once_as_before()
    local home = home()
    home.on("admin")
    home.clock.now = os.time() + 3600
    Mock.fireDeviceEvent(home.mock, 110, 102)
    local first = home.notified()[1].message
    T.truthy(first.id, "not known yet: with an id")
    T.eq(Outbox().counts(), 1)
    Harness.relaySays({ type = "alerts_gone", id = "g1", keys = { "ffffffff" } })
    T.eq(Outbox().counts(), 0, "let go")
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    local second = home.notified()[1].message
    T.eq(second.id, nil, "as before 1.10.1")
    T.eq(count(second), 4, "type, at, brief and for")
    T.eq(Outbox().counts(), 0)

    -- Down: nothing kept, nothing sealed for later.
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(Outbox().counts(), 0)
    T.contains(T.http(home.mock, "GET", "/v1/logs?category=alerts&limit=20", { key = home.admin }).body, "not connected")
    Harness.reconnect(home.mock, home.connection)
    T.eq(#home.notified(), 0)

    -- The next connection, to the same relay: an alert with an id again, until the relay is heard (a
    -- pong) and two keep-alive ticks come without its word.
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.truthy(home.notified()[1].message.id)
    ReceivedFromNetwork(6001, 443, Harness.serverFrame(1, "pong"))
    keepalive(home.mock).callback()
    T.eq(Outbox().counts(), 1, "one tick: not decided yet")
    keepalive(home.mock).callback()
    T.eq(Outbox().counts(), 0, "let go")
    -- Even if the next relay answers alerts (the Worker updated meanwhile), what went to this one is
    -- never sent again: it may have pushed it.
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    T.eq(#home.notified(), 0)
end

-- The window after a lost connection while alerts are kept (Relay.KEEP_WINDOW_SECONDS), if open.
local function keepWindow(mock)
    for index = #mock.timers, 1, -1 do
        local timer = mock.timers[index]
        if not timer.repeating and not timer.fired and not timer.cancelled and timer.delay == 120000 and (timer.source or ""):find("cloud/relay", 1, true) then
            return timer
        end
    end
    return nil
end

-- The alerts log's last line.
local function lastAlertLine(home)
    local items = T.http(home.mock, "GET", "/v1/logs?category=alerts&limit=10", { key = home.admin }).json.items
    return items[#items]
end

-- 1.10.1 review (rv-acks, finding 1): alerts made while the connection is down are kept only within
-- two minutes of losing a connection whose relay answered alerts, by a timer of its own; after it,
-- as in 1.10.0, an alert is not made at all (nothing sealed, nothing kept, "not connected"). The
-- window opens again at the next connection lost after its relay said it answers alerts, not after
-- one that ended before it said anything. What was kept before the window ended still goes within
-- its own time.
function tests.alerts_are_kept_only_within_two_minutes_of_losing_the_connection()
    T.eq(require("src.cloud.relay").KEEP_WINDOW_SECONDS, 120)
    local home = home()
    home.on("admin")
    answersAlerts()
    home.notified()
    T.eq(keepWindow(home.mock), nil, "connected: no window")
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    local window = keepWindow(home.mock)
    T.truthy(window, "the window opens when the connection is lost")
    home.clock.now = os.time() + 3600
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(Outbox().counts(), 1, "kept")
    T.eq(lastAlertLine(home).message, "alert kept for the next connection")

    window.fired = true
    window.callback()
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(Outbox().counts(), 1, "after the window: nothing more kept")
    T.eq(#keeping(home.mock), 1, "nor sealed for later")
    local last = lastAlertLine(home)
    T.eq(last.message, "alert not sent")
    T.eq(last.data.why, "not connected")

    -- Back within the first ring's minute: it goes; the window does not open again for a connection
    -- that ends before its relay says anything.
    Harness.reconnect(home.mock, home.connection)
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    T.eq(keepWindow(home.mock), nil, "nothing heard on it: no window")
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(Outbox().counts(), 1)
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    T.eq(#home.notified(), 1, "the ring kept before the window ended")
    -- Lost again after a relay that said it answers alerts: a new window.
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    T.truthy(keepWindow(home.mock))
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(Outbox().counts(), 2)
    T.eq(lastAlertLine(home).message, "alert kept for the next connection")
    -- A door's question too (an ask-to-open link's, ADR-058) says it was kept, not sent.
    local count = require("src.cloud.alerts").openRequest({ id = 300, name = "Gate", room_name = "Yard", room_id = 3 }, { id = "r1", seconds = 120, label = "Courier" }, { [home.adminId] = true })
    T.eq(count, 1)
    T.eq(lastAlertLine(home).message, "open request kept for the next connection")
    T.eq(Outbox().counts(), 3)
    -- Remote access switched off: no window, nothing kept.
    require("src.cloud.relay").stop()
    T.eq(keepWindow(home.mock), nil)
    T.eq(Outbox().counts(), 0)
end

-- 1.10.1 review (rv-acks, finding 1): an alert kept for the next connection and let go before it
-- ever went uses up no hourly limit (PER_HOUR, CAMERA_PER_HOUR): only what was sent counts. Here the
-- window's timer is not run, so that every alert of a long outage is kept and let go: once back,
-- a camera's alert and a ring still go (up to the review: "limit" for an hour).
function tests.an_alert_kept_and_let_go_uses_up_no_hourly_limit()
    local home = home(nil, Mock.withHikvisionCameras(Mock.project()))
    home.on("admin", { camera = true })
    answersAlerts()
    home.notified()
    home.clock.now = os.time() + 3600
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    for _ = 1, 30 do
        home.clock.now = home.clock.now + 61
        T.eq(Mock.hikvisionAlert(home.mock, 150, "Person"), 1)
        Mock.fireDeviceEvent(home.mock, 110, 102)
        for _, timer in ipairs(keeping(home.mock)) do
            timer.fired = true
            timer.callback()
        end
    end
    T.eq(Outbox().counts(), 0, "all let go")
    T.eq(lastAlertLine(home).message, "alert kept for the next connection", "kept, not sent")
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    T.eq(#home.notified(), 0, "nothing left to send")
    home.clock.now = home.clock.now + 61
    T.eq(Mock.hikvisionAlert(home.mock, 150, "Person"), 1)
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 2, "a camera's alert and a ring")
    local logs = T.http(home.mock, "GET", "/v1/logs?category=alerts&limit=10", { key = home.admin }).body
    T.truthy(not logs:find('"limit"', 1, true), logs)

    -- One kept and sent once the connection is back counts, as one sent while connected.
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    local ring = home.notified()[1].message
    Harness.relaySays({ type = "notify_result", id = ring.id, ok = true })
    for _ = 1, 57 do
        home.clock.now = home.clock.now + 31
        Mock.fireDeviceEvent(home.mock, 110, 102)
    end
    T.eq(#home.notified(), 57, "60 in the hour with the camera's alert, the ring and the ring kept")
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 0, "the 61st waits")
end

-- 1.10.1 review (rv-acks, finding 3): a relay's `relay_features` that comes after the first
-- keep-alive tick that follows a pong (a slow wake of the relay) still counts: the relay is taken as
-- one that does not answer alerts only at the second tick, so what was kept through the blink goes.
function tests.a_late_word_from_the_relay_still_gets_what_was_kept()
    local home = home()
    home.on("admin")
    answersAlerts()
    home.notified()
    home.clock.now = os.time() + 3600
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(Outbox().counts(), 1)
    Harness.reconnect(home.mock, home.connection)
    ReceivedFromNetwork(6001, 443, Harness.serverFrame(1, "pong"))
    keepalive(home.mock).callback()
    T.eq(Outbox().counts(), 1, "one tick after a pong decides nothing")
    answersAlerts()
    local again = home.notified()
    T.eq(#again, 1, "the ring kept through the blink goes")
    T.eq(again[1].message.resent, nil)
end

-- 1.10.1 review (rv-acks, finding 2): an alert that went on a connection whose relay had not said it
-- answers alerts (here after a relay before 1.10.1), which then ended before it said anything, is
-- not sent again to the next relay even if that one answers alerts: the relay it went to may have
-- been one before 1.10.1, which pushed it and ignored its id, and the next one would push it a
-- second time. One that went before its relay said so, on a connection whose relay then did, is
-- sent again after a cut as any other.
function tests.an_alert_that_went_to_a_relay_not_known_to_answer_alerts_is_not_sent_again()
    local home = home()
    home.on("admin")
    Harness.relaySays({ type = "alerts_gone", id = "g1", keys = { "ffffffff" } })
    home.notified()
    Harness.reconnect(home.mock, home.connection)
    home.clock.now = os.time() + 3600
    Mock.fireDeviceEvent(home.mock, 110, 102)
    local ring = home.notified()[1].message
    T.truthy(ring.id, "not known yet: with an id")
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    T.eq(#home.notified(), 0, "not sent again")
    T.eq(Outbox().counts(), 0, "and let go")
    T.contains(T.http(home.mock, "GET", "/v1/logs?category=relay&limit=20", { key = home.admin }).body, "an alert was not sent again")

    -- Went before the word, on a connection whose relay then said it answers alerts: sent again.
    Harness.reconnect(home.mock, home.connection)
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    local early = home.notified()[1].message
    answersAlerts()
    T.eq(#home.notified(), 0, "it went on this connection")
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    local again = home.notified()
    T.eq(#again, 1)
    T.eq(again[1].message.id, early.id)
    T.eq(again[1].message.resent, 1)
    Harness.relaySays({ type = "notify_result", id = early.id, ok = true })

    -- Also after a relay that answered alerts: the next connection's relay may be another version
    -- (a Worker rolled back, or a gradual deploy), so one that went before it said anything and then
    -- died is let go too. A loss, as in 1.10.0, rather than a second push.
    OnConnectionStatusChanged(6001, 443, "OFFLINE")
    Harness.reconnect(home.mock, home.connection)
    home.clock.now = home.clock.now + 31
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(#home.notified(), 1, "went on the new connection before its relay said anything")
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    T.eq(#home.notified(), 0)
    T.eq(Outbox().counts(), 0)
end

-- How long and how many: a ring (and a door's question) a minute, a camera's alert two (each by a
-- timer of its own, in real time); at most twenty alerts and 128 KB, the oldest let go first; and
-- what goes again goes oldest first.
function tests.alerts_are_kept_a_minute_or_two_and_at_most_twenty()
    T.same(require("src.cloud.alerts").KEEP_SECONDS, { doorbell = 60, open_request = 60, camera = 120, door_opened = 120, fridge_door = 120, schedule_failed = 120 })
    local home = home(nil, Mock.withHikvisionCameras(Mock.project()))
    home.on("admin", { camera = true })
    answersAlerts()
    home.notified()
    home.clock.now = os.time() + 3600
    Mock.fireDeviceEvent(home.mock, 110, 102)
    T.eq(Mock.hikvisionAlert(home.mock, 150, "Person"), 1)
    local ring, camera = unpack(home.notified())
    local timers = keeping(home.mock)
    T.eq(#timers, 2)
    T.eq(timers[1].delay, 60000, "a ring: a minute")
    T.eq(timers[2].delay, 120000, "a camera: two minutes")
    timers[1].fired = true
    timers[1].callback()
    T.eq(Outbox().counts(), 1, "the ring is let go after its minute")
    T.contains(T.http(home.mock, "GET", "/v1/logs?category=relay&limit=50", { key = home.admin }).body, "an alert was not acknowledged in time")
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    local again = home.notified()
    T.eq(#again, 1)
    T.eq(again[1].message.id, camera.message.id, "only the camera's alert")
    T.truthy(ring.message.id ~= camera.message.id)
    Harness.relaySays({ type = "notify_result", id = camera.message.id, ok = true })

    -- Twenty-two rings unanswered: the newest twenty are kept, and go again oldest first.
    local ids = {}
    for index = 1, 22 do
        home.clock.now = home.clock.now + 31
        Mock.fireDeviceEvent(home.mock, 110, 102)
        ids[index] = home.notified()[1].message.id
    end
    T.eq(Outbox().counts(), 20)
    T.eq(#keeping(home.mock), 20, "the timers of those let go are cancelled")
    Harness.reconnect(home.mock, home.connection)
    answersAlerts()
    local resent = home.notified()
    T.eq(#resent, 20)
    for index, item in ipairs(resent) do
        T.eq(item.message.id, ids[index + 2], "oldest first")
    end

    -- At most 128 KB together.
    Outbox().clear()
    for _ = 1, 3 do
        Outbox().add({ type = "notify", ["for"] = { big = string.rep("a", 50000) } }, 60, "doorbell")
    end
    local kept, bytes = Outbox().counts()
    T.eq(kept, 2)
    T.truthy(bytes <= Outbox().MAX_BYTES, "within the budget: " .. bytes)
end

-- ---- admin keys ---------------------------------------------------------------------------------

function tests.the_relay_learns_which_keys_are_admin_keys()
    local mock, connection = Harness.connected()
    local admin = T.pair(mock)
    local function lastKeys()
        local found = ofType(sent(connection), "keys")
        return found[#found].message
    end
    local first = lastKeys()
    T.eq(#first.admins, 1, "the paired key is an admin key")
    T.eq(first.admins[1], first.ids[1])

    local viewer = T.http(mock, "POST", "/v1/api-keys", { key = admin, body = { name = "Wall tablet", role = "viewer" } }).json
    local afterViewer = lastKeys()
    T.eq(#afterViewer.ids, 2)
    T.eq(#afterViewer.admins, 1, "a viewer is not an admin")
    T.eq(afterViewer.admins[1], first.ids[1])

    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. viewer.id, { key = admin, body = { role = "admin" } }).status, 200)
    T.eq(#lastKeys().admins, 2, "made an admin: the relay is told")
    T.eq(T.http(mock, "PATCH", "/v1/api-keys/" .. viewer.id, { key = admin, body = { role = "member" } }).status, 200)
    local demoted = lastKeys()
    T.eq(#demoted.admins, 1, "and when it no longer is")
    T.eq(demoted.admins[1], first.ids[1])
end

return tests
