-- Runs the real driver against the fake Director for scripts/dev_server.py.
-- Protocol (hex keeps it binary-safe through text-mode pipes on Windows):
--   in:  "<handle> <hex bytes>\n"   (empty hex = the client disconnected)
--   out: "<closed 0|1> <hex response bytes>\n"
--   in:  "code\n" runs the Composer action New Pairing Code; out: "CODE <code>\n"
--   in:  "property <hex name> <hex value>\n" sets a Composer property; out: "PROPERTY\n"
--   in:  "variable <device id> <variable id> <hex value>\n" a device reports; out: "VARIABLE <times>\n"
--   in:  "seal <hex JSON { key, key_id, request }>\n" seals a request at home, as the app does;
--        out: "SEALED <hex JSON envelope>\n"
--   in:  "open <hex JSON { key, envelope }>\n" opens a sealed answer; out: "OPENED <hex JSON>\n"
--        (with "isk" in hex instead of "key": the answer of a pairing with CPace)
--   in:  "tick\n" runs the schedules' minute now (the fake Director runs no timers), "tick <unix time>\n"
--        the minute of that time (the home's minute of automatic backups); out: "TICKED <ran>\n"
--   in:  "remove <device id>\n" removes a device from the project in Composer, then Refresh Project;
--        out: "REMOVED\n"
--   in:  "linked\n" switches Remote Access on and marks the home's identity as one the relay has
--        accepted (there is no relay here), so scene links can be made; out: "LINKED <home id>\n"
--   in:  "event <device id> <event id>\n" a device fires an event; out: "EVENT <times delivered>\n"
--   in:  "ask <hex JSON { link, secret }>\n" runs an ask-to-open link (ADR-058) as the account service
--        would pass it on, the relay counting as connected meanwhile; out: "ASKED <hex JSON { answer,
--        questions: [{ key_id, detail }] }>\n", each question opened as that device's worker would
--   in:  "alert <driver id> <hex label>\n" a camera's driver (the DirectorLink · Hikvision Camera
--        driver, or one of DirectorLink's camera agreement) raises an alert (LAST_ALERT, then its
--        event named Alert); out: "ALERTED <times delivered>\n"
--   in:  "ring <driver id>\n" a doorbell camera's driver of the agreement rings (LAST_RING, then its
--        event named Ring); out: "RANG <times delivered>\n"
--   in:  "scene_links unreadable\n" / "scene_links readable\n": the scene links' store cannot be read
--        (and is read again at once), or has what it had back; out: "SCENE_LINKS <complete>\n"
-- With an argument "agreement" (scripts/dev_server.py --agreement-cameras), two cameras whose
-- drivers follow DirectorLink's camera agreement (1.10.0, ADR-065) join the project: 67 "Porch" (a
-- camera, driver 157) and 68 "Entrance" (a doorbell, driver 158), Mock.withAgreementCameras.
-- With an argument "doors" (scripts/dev_server.py --door-controllers), Control4's Relay Door, Gate and
-- Garage Door Controllers (1.10.0, ADR-069) join the project, Mock.withRelayControllers: 71 "Main
-- Gate" (driver 161, the DoorBird's relay, a contact), 72 "Garage Door" (driver 162, two relays, no
-- contact), the KNX relay 75 "Back Door Relay" that door controller 163 drives, and 74 "Side Gate"
-- (nothing bound); "event 161 1" is the gate's controller saying Opened, "event 161 2" Closed.
-- With both (scripts/dev_server.py --agreement-cameras --door-controllers), the doorbell camera 68
-- "Entrance" has its gate (1.11.0, ADR-078): 76 "Entrance Gate", a Relay Gate Controller (driver
-- 166) on the relay of the doorbell's driver 158, Mock.withDoorbellGate.
-- With an argument "c4sonos" (scripts/dev_server.py --control4-sonos), Control4's own Sonos drivers
-- join the project (1.11.0, ADR-080), Mock.withControl4Sonos: 84 "Sonos Network" and 85 "Kitchen
-- Sonos" in the Kitchen, 86 "Living Room Sonos" and 87 "Sonos Line In" in the Living Room, and 88
-- "Sonance Amp" (not Sonos); with Sonos On they are part of Music (/v1/devices: part_of_music).
-- With an argument "sonos" (scripts/dev_server.py --sonos), the driver's requests to Sonos
-- players go out through the dev server to the fake players (tests/sonos/fake-sonos.mjs):
--   out: "FETCH <hex JSON { method, url, headers, body_hex }>\n"
--   in:  "FETCHED <hex JSON { code, headers, body_hex } or { error }>\n"
-- and the driver's search for players gets the fake players' answers.
-- With an argument "cameras=N" (scripts/dev_server.py --cameras N), the project's two plain cameras
-- are N cameras on the DirectorLink · Hikvision Camera driver instead (ADR-055, ADR-056), and every
-- camera's pictures (the DoorBird's too) come from the dev server's fake cameras, later, as from real
-- ones; the driver keeps working meanwhile:
--   out: "CAMERA <n> <hex JSON { url, headers, login = { type, username, password }, name }>\n" (any time
--        before an answer line)
--   in:  "CAMERA_ANSWER <n> <hex JSON { code, headers, body_hex } or { error }>\n"; out: "PUSHED <hex
--        JSON [{ handle, data_hex, closed }]>\n", what the driver sent to its clients meanwhile
--   in:  "clock <milliseconds>\n" before each line: DirectorLink's millisecond clock (no answer)

package.path = "./driver/?.lua;./driver/tests/?.lua;" .. package.path

local Mock = require("c4mock")

local specText
local specPath = arg and arg[1]
if specPath and specPath ~= "" then
    local file = io.open(specPath, "rb")
    if file then
        specText = file:read("*a")
        file:close()
    end
end
local sonosForwarding = false
local agreementCameras = false
local doorControllers = false
local control4Sonos = false
local fahrenheit = false
local fakeCameras = 0
for index = 2, #(arg or {}) do
    if arg[index] == "sonos" then
        sonosForwarding = true
    end
    agreementCameras = agreementCameras or arg[index] == "agreement"
    doorControllers = doorControllers or arg[index] == "doors"
    control4Sonos = control4Sonos or arg[index] == "c4sonos"
    fahrenheit = fahrenheit or arg[index] == "fahrenheit"
    fakeCameras = tonumber((arg[index] or ""):match("^cameras=(%d+)$")) or fakeCameras
end

-- Made-up names of the fake Hikvision cameras (--cameras), in English as every demo home.
local CAMERA_NAMES = {
    "Front Gate", "Driveway", "Garden", "Pool", "Back Door", "Garage", "Side Path", "Terrace",
    "Parking", "Entrance", "Playground", "Storage", "Roof", "Lobby", "Yard", "Shed",
}

-- The default project plus the device families of 1.1.0 (older lights, a thermostat with heat and
-- cool setpoints, floor heating on its heat setpoint), the fans and the alarm's partitions (1.2.0),
-- so the app preview shows them all. The fake home shows its (fake) alarm: Alarm Status is On.
-- An ask-to-open link's run ("ask", below): the relay counts as connected while it runs, and what
-- the driver tells it (the sealed question) is kept here instead.
local relaying = { on = false, told = {} }
-- With an argument "fahrenheit" (scripts/dev_server.py --fahrenheit, 1.10.2): a US home in °F,
-- with the thermostats of #75 (Mock.fahrenheitProject).
local project = fahrenheit and Mock.fahrenheitProject() or Mock.demoProject()
if fakeCameras > 0 then
    for _, id in ipairs({ 60, 61, 107, 108 }) do
        project.devices[id] = nil
    end
    project.cameras[60], project.cameras[61] = nil, nil
    local list = {}
    for index = 1, fakeCameras do
        list[index] = {
            id = 600 + index, protocol = 700 + index, room = index % 2 == 0 and 10 or 11,
            name = CAMERA_NAMES[index] or ("Camera " .. index), address = "192.0.2." .. tostring(40 + index),
        }
    end
    Mock.withHikvisionCameras(project, list)
end
if agreementCameras then
    Mock.withAgreementCameras(project)
end
if doorControllers then
    Mock.withRelayControllers(project)
end
if agreementCameras and doorControllers then
    Mock.withDoorbellGate(project)
end
if control4Sonos then
    Mock.withControl4Sonos(project)
end
local mock = Mock.startDriver(project, specText, nil, function()
    Properties["Alarm Status"] = "On"
    local Relay = require("src.cloud.relay")
    local connected, tell, mayAlert, alert = Relay.connected, Relay.tell, Relay.mayAlert, Relay.alert
    Relay.connected = function()
        return relaying.on or connected()
    end
    Relay.tell = function(message)
        if relaying.on then
            relaying.told[#relaying.told + 1] = message
            return true
        end
        return tell(message)
    end
    -- Alerts go through these since 1.10.1 (ADR-073).
    Relay.mayAlert = function()
        return relaying.on or mayAlert()
    end
    Relay.alert = function(message, seconds, kind, letGo)
        if relaying.on then
            relaying.told[#relaying.told + 1] = message
            return "sent"
        end
        return alert(message, seconds, kind, letGo)
    end
end)
-- The fake home lets the API open its (fake) doors.
Properties["Door Control"] = "Enabled"
-- The app and console served from this PC (python -m http.server) may call this test bridge. The
-- driver itself answers only DirectorLink's own sites; this is the test harness, never packaged.
local Server = require("src.api.server")
local driverOrigins = Server.originAllowed
Server.originAllowed = function(origin)
    if type(origin) ~= "string" then
        return driverOrigins(origin)
    end
    return driverOrigins(origin) or origin:match("^http://localhost:%d+$") ~= nil or origin:match("^http://127%.0%.0%.1:%d+$") ~= nil
end
-- And a fake Open-Meteo answers for its weather: a forecast, the same every hour (ADR-071).
local Json = require("src.core.json")
mock.weather = require("weather_fake").steady(27, { wind = 12, max = 31, min = 22, chance = 10 })

-- Blinds move in the fake home as KNX blinds do: SECONDS_PER_PERCENT per percent, reporting their
-- level every few seconds and when they stop, and the actuator's own report of where it is about a
-- second after the stop. A shade that only opens and closes fully goes all the way (its driver sends
-- up for any target above 0). Movement is the shade's movement type and does not change. Moves
-- advance whenever a request comes in.
local SECONDS_PER_PERCENT = 0.3
local REPORT_SECONDS = 3
local moves, actuators, commandsSeen = {}, {}, #mock.commands

local function shadeVariable(id, name)
    for variableId, variableName in pairs(mock.project.variableNames[id] or {}) do
        if variableName == name then
            return variableId
        end
    end
end

local function report(id, values)
    for name, value in pairs(values) do
        local variableId = shadeVariable(id, name)
        if variableId then
            Mock.changeVariable(mock, id, variableId, value)
        end
    end
end

local function levelNow(move, now)
    local share = math.min(1, (now - move.started) / math.max(1, math.abs(move.to - move.from) * SECONDS_PER_PERCENT))
    return math.floor(move.from + (move.to - move.from) * share + 0.5)
end

local function stopShade(id, level, now)
    moves[id] = nil
    report(id, { Level = tostring(level), ["Target Level"] = tostring(level), Stopped = "1", Opening = "0", Closing = "0" })
    actuators[id] = { level = level, at = now + 1 }
end

local function advanceShades()
    local now = os.time()
    for id, actuator in pairs(actuators) do
        if now >= actuator.at then
            actuators[id] = nil
            report(id, { Level = tostring(actuator.level) })
        end
    end
    for index = commandsSeen + 1, #mock.commands do
        local command = mock.commands[index]
        local id = command.device
        local device = mock.project.devices[id]
        if device and string.lower(device.driverFileName or "") == "blind.c4i" then
            local level = moves[id] and levelNow(moves[id], now) or tonumber((mock.project.variables[id] or {})[shadeVariable(id, "Level")])
            if command.command == "STOP" then
                stopShade(id, level or 0, now)
            elseif command.command == "SET_LEVEL_TARGET" then
                local to = tonumber(command.params.LEVEL_TARGET) or 0
                local setup = (mock.project.blindSetups or {})[id] or ""
                if setup:find("<level_discrete_control>False", 1, true) and to > 0 then
                    to = 100
                end
                local from = (level and level >= 0 and level <= 100) and level or (to > 50 and 0 or 100)
                if from ~= to then
                    local opening = to > from
                    moves[id] = { from = from, to = to, started = now, reported = now }
                    actuators[id] = nil
                    report(id, { ["Target Level"] = tostring(to), Stopped = "0", Opening = opening and "1" or "0",
                        Closing = opening and "0" or "1" })
                end
            end
        end
    end
    commandsSeen = #mock.commands
    for id, move in pairs(moves) do
        local level = levelNow(move, now)
        if level == move.to then
            stopShade(id, level, now)
        elseif now - move.reported >= REPORT_SECONDS then
            move.reported = now
            report(id, { Level = tostring(level) })
        end
    end
end

-- Fans follow their commands as Snap One documents the Fan proxy: ON goes to the preset speed, OFF
-- to 0, SET_SPEED to its speed (0 is off); the speed is reported first, then whether it is on.
-- No real fan has been seen doing this. Like the shades, they move when a request comes in.
local FAN_IS_ON, FAN_SPEED, FAN_PRESET = 1000, 1001, 1003
local fanCommandsSeen = #mock.commands

local function advanceFans()
    for index = fanCommandsSeen + 1, #mock.commands do
        local command = mock.commands[index]
        local device = mock.project.devices[command.device]
        if device and string.lower(device.driverFileName or "") == "fan.c4i" then
            local speed
            if command.command == "ON" then
                speed = tonumber((mock.project.variables[command.device] or {})[FAN_PRESET]) or 4
            elseif command.command == "OFF" then
                speed = 0
            elseif command.command == "SET_SPEED" then
                speed = tonumber(command.params and command.params.SPEED) or 0
            end
            if speed then
                Mock.changeVariable(mock, command.device, FAN_SPEED, tostring(speed))
                Mock.changeVariable(mock, command.device, FAN_IS_ON, speed > 0 and "1" or "0")
            end
        end
    end
    fanCommandsSeen = #mock.commands
end

-- The Samsung refrigerator (Mock.withRefrigerator, the driver 140) follows SET_FEATURE as its
-- driver does: the variable changes once the refrigerator confirms, REFRIGERATOR_SECONDS later
-- (through Samsung's cloud, typically 4 s). Like the shades, it moves on when a request comes in.
local REFRIGERATOR_SECONDS = 4
local REFRIGERATOR_FEATURES = { ["Power Cool"] = "POWER_COOL", ["Power Freeze"] = "POWER_FREEZE", ["Sabbath Mode"] = "SABBATH_MODE", ["Ice Maker"] = "ICE_MAKER" }
local fridgeCommandsSeen, fridgeChanges = #mock.commands, {}

local function advanceRefrigerators()
    local now = os.time()
    for index = fridgeCommandsSeen + 1, #mock.commands do
        local command = mock.commands[index]
        local device = mock.project.devices[command.device]
        local variable = command.command == "SET_FEATURE" and REFRIGERATOR_FEATURES[command.params and command.params.Feature]
        if device and variable and require("src.adapters.classifier").isRefrigeratorDriver(device.driverFileName) then
            fridgeChanges[#fridgeChanges + 1] = { at = now + REFRIGERATOR_SECONDS, protocol = command.device, values = { [variable] = command.params.State == "On" and "1" or "0" } }
        end
    end
    fridgeCommandsSeen = #mock.commands
    local waiting = {}
    for _, change in ipairs(fridgeChanges) do
        if now >= change.at then
            Mock.setRefrigerator(mock, change.protocol, change.values)
        else
            waiting[#waiting + 1] = change
        end
    end
    fridgeChanges = waiting
end

local function fromHex(text)
    return (text:gsub("%x%x", function(pair)
        return string.char(tonumber(pair, 16))
    end))
end

local function toHex(text)
    return (text:gsub(".", function(char)
        return string.format("%02x", char:byte())
    end))
end

-- ---- Sonos through the dev server (see the protocol at the top) ------------------------------

local SonosSearch = 6100
local searchesSeen = 0

local function fetch(method, url, headers, body)
    io.write("FETCH " .. toHex(Json.encode({ method = method, url = url, headers = headers or {}, body_hex = toHex(body or "") })) .. "\n")
    io.flush()
    local line = io.read("*l") or ""
    local answer = Json.decode(fromHex(line:match("^FETCHED (%x*)$") or "")) or { error = "no answer from the dev server" }
    if answer.error then
        return nil, answer.error
    end
    return { code = answer.code, headers = answer.headers or {}, body = fromHex(answer.body_hex or "") }
end

if sonosForwarding then
    -- Only the players' own addresses, as on a controller.
    mock.http = function(request)
        if not tostring(request.url):match("^http://[%d%.]+:1400/") then
            return false
        end
        return fetch(request.method, request.url, request.headers, request.body)
    end
end

-- The driver searched for players: Director says the connection is up, the fake players answer,
-- and the search ends (the fake Director runs no timers by itself).
local function answerSonosSearch()
    local search = mock.network[SonosSearch]
    if not sonosForwarding or not search or search.connects <= searchesSeen then
        return
    end
    searchesSeen = search.connects
    OnConnectionStatusChanged(SonosSearch, 1900, "ONLINE")
    local listed = fetch("GET", "http://127.0.0.1/fake/ssdp", {})
    for _, reply in ipairs(listed and Json.decode(listed.body) or {}) do
        ReceivedFromNetwork(SonosSearch, 1900, reply)
    end
    for _, timer in ipairs(mock.timers) do
        if not timer.fired and not timer.cancelled and timer.source:find("/sonos/client.lua", 1, true) and timer.delay == 4000 then
            timer.fired = true
            timer.callback()
        end
    end
end

-- The players are read as the driver's tick would read them.
local function sonosTick()
    pcall(function()
        require("src.sonos.sonos").tick()
    end)
end

-- ---- fake cameras through the dev server (see the protocol at the top) -----------------------

local cameraTransfers, cameraCount = {}, 0
if fakeCameras > 0 then
    local byAddress, names = {}, {}
    for id, camera in pairs(mock.project.cameras) do
        byAddress[camera.address] = camera
        names[camera.address] = mock.project.devices[id] and mock.project.devices[id].deviceName or nil
    end
    local mockUrl = C4.url
    C4.url = function(self)
        local transfer = mockUrl(self)
        local get = transfer.Get
        function transfer:Get(url, headers)
            local address = tostring(url):match("^https?://([^/:]+)") or ""
            local camera = byAddress[address]
            if not camera then
                return get(self, url, headers)
            end
            cameraCount = cameraCount + 1
            cameraTransfers[cameraCount] = self
            local login = { type = camera.auth_type, username = camera.username, password = camera.password }
            io.write("CAMERA " .. cameraCount .. " " .. toHex(Json.encode({ url = url, headers = headers or {}, login = login, name = names[address] })) .. "\n")
            io.flush()
            return self
        end
        return transfer
    end
end

-- A fake camera's answer reached the driver: what it sent to its clients meanwhile.
local offsets = {}
local reportedClosed = {}
local function pushed()
    local list = {}
    for handle, sent in pairs(mock.sent) do
        local from = (offsets[handle] or 0) + 1
        local closed = mock.closed[handle] == true and not reportedClosed[handle]
        if #sent >= from or closed then
            list[#list + 1] = { handle = handle, data_hex = toHex(sent:sub(from)), closed = mock.closed[handle] == true }
            offsets[handle] = #sent
            reportedClosed[handle] = mock.closed[handle] == true or nil
        end
    end
    return Json.encode(Json.array(list))
end

local function cameraAnswer(n, hex)
    local transfer = cameraTransfers[n]
    cameraTransfers[n] = nil
    local answer = Json.decode(fromHex(hex)) or { error = "no answer" }
    if transfer and transfer.callback then
        if answer.error then
            transfer.callback(transfer, {}, 7, answer.error)
        else
            transfer.callback(transfer, { { url = "", code = answer.code, headers = answer.headers or {}, body = fromHex(answer.body_hex or "") } }, 0, nil)
        end
    end
    return "PUSHED " .. toHex(pushed())
end

-- What the contract test and the dev server ask for besides HTTP (see the protocol at the top).
local Lock = require("src.cloud.lock")
local Remote = require("src.cloud.remote")
local Clock = require("src.core.clock")
local sealCount = 0

-- The scene links' store while "scene_links unreadable" holds it.
local keptSceneLinks = nil

local function command(line)
    local name, value = line:match("^property (%x*) (%x*)$")
    if name then
        Properties[fromHex(name)] = fromHex(value)
        OnPropertyChanged(fromHex(name))
        return "PROPERTY"
    end
    local device, variable, reported = line:match("^variable (%d+) (%d+) (%x*)$")
    if device then
        return "VARIABLE " .. Mock.changeVariable(mock, tonumber(device), tonumber(variable), fromHex(reported))
    end
    local sealing = line:match("^seal (%x+)$")
    if sealing then
        local asked = Json.decode(fromHex(sealing))
        sealCount = sealCount + 1
        local request = asked.request
        request.id = request.id or ("dev-" .. sealCount)
        request.ts = request.ts or Clock.now()
        local envelope = Lock.seal(Lock.deviceKey(asked.key), Remote.LAN_HOME, asked.key_id, "req", Json.encode(request))
        return "SEALED " .. toHex(Json.encode(envelope))
    end
    local tick = line:match("^tick ?(%d*)$")
    if tick then
        return "TICKED " .. tostring(require("src.core.scheduler").tick(tonumber(tick)))
    end
    if line == "linked" then
        local Relay = require("src.cloud.relay")
        local identity = Relay.identity()
        identity.linked = true
        Relay.restoreIdentity(identity)
        Properties["Remote Access"] = "On"
        OnPropertyChanged("Remote Access")
        return "LINKED " .. identity.home_id
    end
    local storeState = line:match("^scene_links (%a+)$")
    if storeState then
        local SceneLinks = require("src.core.scene_links")
        if storeState == "unreadable" then
            keptSceneLinks = mock.persist["directorlink_scene_links"]
            mock.persist["directorlink_scene_links"] = "json:{not json"
        else
            mock.persist["directorlink_scene_links"] = keptSceneLinks
        end
        SceneLinks.load()
        return "SCENE_LINKS " .. tostring(SceneLinks.complete())
    end
    local fired, event = line:match("^event (%d+) (%d+)$")
    if fired then
        return "EVENT " .. Mock.fireDeviceEvent(mock, tonumber(fired), tonumber(event))
    end
    local alerting, label = line:match("^alert (%d+) (%x*)$")
    if alerting then
        -- By the event's name when Director names the driver's events, else the Hikvision driver's 1.
        local data = (mock.project.deviceData or {})[tonumber(alerting)]
        local named = data and tostring(data.events or ""):find("<name>Alert</name>", 1, true)
        return "ALERTED " .. (named and Mock.cameraAlert or Mock.hikvisionAlert)(mock, tonumber(alerting), fromHex(label))
    end
    local ringing = line:match("^ring (%d+)$")
    if ringing then
        return "RANG " .. Mock.cameraRing(mock, tonumber(ringing))
    end
    local answered, answerHex = line:match("^CAMERA_ANSWER (%d+) (%x*)$")
    if answered then
        return cameraAnswer(tonumber(answered), answerHex)
    end
    local removed = line:match("^remove (%d+)$")
    if removed then
        Mock.removeDevice(mock.project, tonumber(removed))
        ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
        return "REMOVED"
    end
    local asking = line:match("^ask (%x+)$")
    if asking then
        local asked = Json.decode(fromHex(asking)) or {}
        local services = {
            registry = require("src.core.registry"),
            log = require("src.core.log"),
            doorControlEnabled = function()
                return Properties["Door Control"] == "Enabled"
            end,
        }
        local answer = { type = "link_result", ok = false, code = "NOT_FOUND" }
        relaying.on, relaying.told = true, {}
        local ok, err = pcall(require("src.api.handlers.ask_links").relayRun, services, { type = "link", id = "dev", link = asked.link, secret = asked.secret }, function(message)
            answer = message
        end)
        relaying.on = false
        if not ok then
            answer = { error = tostring(err) }
        end
        -- Each question opened with that device's alert key, as its service worker would.
        local Alerts = require("src.cloud.alerts")
        local Base64 = require("src.core.base64")
        local questions = Json.array()
        for _, message in ipairs(relaying.told) do
            for keyId, sealed in pairs(type(message["for"]) == "table" and message["for"] or {}) do
                local remote = require("src.auth.keys").remote(keyId)
                if remote and remote.lock then
                    local alertKey = Alerts.alertKey(remote.lock)
                    local enc = C4:HMAC("SHA256", alertKey, "enc", { key_encoding = "HEX", data_encoding = "NONE", return_encoding = "HEX" }):lower()
                    local plaintext = C4:Decrypt("AES-256-CBC", enc, Base64.toHex(Base64.decode(sealed.iv)), Base64.toHex(Base64.decode(sealed.ct)), {
                        key_encoding = "HEX",
                        iv_encoding = "HEX",
                        data_encoding = "HEX",
                        return_encoding = "NONE",
                        padding = true,
                    })
                    questions[#questions + 1] = { key_id = keyId, detail = Json.decode(plaintext or "") }
                end
            end
        end
        return "ASKED " .. toHex(Json.encode({ answer = answer, questions = questions }))
    end
    local opening = line:match("^open (%x+)$")
    if opening then
        local asked = Json.decode(fromHex(opening))
        local lockKey = asked.isk and Lock.cpaceKey(asked.isk) or Lock.deviceKey(asked.key)
        return "OPENED " .. toHex(Lock.open(lockKey, asked.envelope, "res") or "null")
    end
    return nil
end

io.write("READY " .. tostring(mock.properties["Pairing Code"]) .. "\n")
io.flush()

for line in io.lines() do
    local clock = line:match("^clock (%d+)$")
    if clock then
        mock.clock = tonumber(clock)
        line = ""
    end
    if line:match("^code") then
        ExecuteCommand("LUA_ACTION", { ACTION = "NEW_PAIRING_CODE" })
        io.write("CODE " .. tostring(mock.properties["Pairing Code"]) .. "\n")
        io.flush()
    end
    local answer = command(line)
    answerSonosSearch()
    if answer then
        io.write(answer .. "\n")
        io.flush()
    end
    local handle, hex = line:match("^(%d+) ?(%x*)$")
    if handle then
        advanceShades()
        advanceFans()
        advanceRefrigerators()
        sonosTick()
        answerSonosSearch()
        handle = tonumber(handle)
        if hex == "" then
            OnServerConnectionStatusChanged(handle, 41999, "OFFLINE")
        else
            OnServerDataIn(handle, fromHex(hex), "127.0.0.1", "0")
        end
        local sent = mock.sent[handle] or ""
        local start = (offsets[handle] or 0) + 1
        offsets[handle] = #sent
        io.write((mock.closed[handle] and "1" or "0") .. " " .. toHex(sent:sub(start)) .. "\n")
        io.flush()
    end
end
