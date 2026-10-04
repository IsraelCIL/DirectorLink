-- Alerts (ADR-047, ADR-050, docs/RELAY.md): which of its keys are admin keys the driver tells the
-- relay; what it alerts about (a doorbell rang, a door or gate opened, the refrigerator's door left
-- open, a schedule failed) it sends as one "notify" message that names only the key ids it is for,
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
-- adminId, keys = { name -> { key, id } } }. `setup` runs before the start (Composer properties).
local function home(setup)
    local mock = Mock.startDriver(nil, nil, nil, setup)
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
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = viewer }).json, { on = false, kinds = { doorbell = true } }, "a viewer: the doorbell")
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = member }).json.kinds, { doorbell = true })
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = doors }).json.kinds, { doorbell = true })

    local changed = T.http(mock, "PUT", "/v1/alerts/choices", { key = admin, body = { on = true, kinds = { door_opened = true, doorbell = false } } })
    T.eq(changed.status, 200, changed.body)
    T.same(changed.json, { on = true, kinds = { doorbell = false, door_opened = true, schedule_failed = true } })
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = admin }).json, changed.json, "kept")
    T.same(T.http(mock, "PUT", "/v1/alerts/choices", { key = admin, body = { on = false } }).json.kinds, changed.json.kinds, "switched off, the choices stay")
    -- Only its own: another key's are untouched.
    T.same(T.http(mock, "GET", "/v1/alerts/choices", { key = viewer }).json, { on = false, kinds = { doorbell = true } })
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
    home.add("Hall tablet", "viewer")
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
    T.eq(count(message), 4, "type, at, brief and for: nothing else in the clear")
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
    T.same(sizes, { 684, 684, 684, 684, 684 }, "512 bytes, in base64")
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
    Alerts.start({
        relay = require("src.cloud.relay"),
        remote = require("src.cloud.remote"),
        keys = require("src.auth.keys"),
        registry = require("src.core.registry"),
        adapters = require("src.adapters.manager"),
        activity = require("src.core.activity"),
        hasFridge = function()
            return true
        end,
    })
    T.same(T.http(home.mock, "GET", "/v1/alerts/choices", { key = kids.key }).json.kinds, { doorbell = true, fridge_door = true })
    T.same(T.http(home.mock, "GET", "/v1/alerts/choices", { key = home.keys["Hall tablet"].key }).json.kinds, { doorbell = true }, "not for a viewer")
    local fridge = { id = 500, name = "Refrigerator", room_name = "Kitchen", room_id = 10 }
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
