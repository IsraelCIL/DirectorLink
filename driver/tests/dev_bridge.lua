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
-- With a second argument "sonos" (scripts/dev_server.py --sonos), the driver's requests to Sonos
-- players go out through the dev server to the fake players (tests/sonos/fake-sonos.mjs):
--   out: "FETCH <hex JSON { method, url, headers, body_hex }>\n"
--   in:  "FETCHED <hex JSON { code, headers, body_hex } or { error }>\n"
-- and the driver's search for players gets the fake players' answers.

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
local sonosForwarding = arg and arg[2] == "sonos"

-- The default project plus the device families of 1.1.0 (older lights, a thermostat with heat and
-- cool setpoints, floor heating on its heat setpoint), the fans and the alarm's partitions (1.2.0),
-- so the app preview shows them all. The fake home shows its (fake) alarm: Alarm Status is On.
local mock = Mock.startDriver(Mock.demoProject(), specText, nil, function()
    Properties["Alarm Status"] = "On"
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
-- And a fake Open-Meteo answers for its weather.
local Json = require("src.core.json")
mock.weather = {
    current = { temperature_2m = 27, precipitation = 0, weather_code = 1, wind_speed_10m = 12, wind_gusts_10m = 20 },
    daily = {
        temperature_2m_max = Json.array({ 31 }),
        temperature_2m_min = Json.array({ 22 }),
        precipitation_probability_max = Json.array({ 10 }),
    },
}

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

-- What the contract test and the dev server ask for besides HTTP (see the protocol at the top).
local Lock = require("src.cloud.lock")
local Remote = require("src.cloud.remote")
local Clock = require("src.core.clock")
local sealCount = 0

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
    local fired, event = line:match("^event (%d+) (%d+)$")
    if fired then
        return "EVENT " .. Mock.fireDeviceEvent(mock, tonumber(fired), tonumber(event))
    end
    local removed = line:match("^remove (%d+)$")
    if removed then
        Mock.removeDevice(mock.project, tonumber(removed))
        ExecuteCommand("LUA_ACTION", { ACTION = "REFRESH_PROJECT" })
        return "REMOVED"
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

local offsets = {}
for line in io.lines() do
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
