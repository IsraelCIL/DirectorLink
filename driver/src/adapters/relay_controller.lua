local Log = require("src.core.log")
local DeviceEvents = require("src.control4.device_events")
local Classifier = require("src.adapters.classifier")
local KnxRelay = require("src.adapters.knx_relay")

-- Control4's Relay Door, Gate and Garage Door Controllers (door_relay_control.c4z,
-- gate_relay_control.c4z, garagedoor_relay_control.c4z, also a second download of one; 1.10.0,
-- ADR-069). Each has one uibutton proxy, its button in the Control4 app, which DirectorLink shows as
-- a door, a gate or a garage door in that proxy's room, under the proxy's id, whatever relay it
-- drives (a DoorBird's, a KNX actuator's, a contact/relay module's). What Snap One's drivers
-- (versions 10 and 11, the same code in all three) do:
-- - Their command OPEN (ExecuteCommand, as Composer's programming and the action Open Gate send it)
--   opens. With Relay Configuration Pulse (the default) it is one pulse of the Open/Toggle relay
--   (connection 1) for its Open/Toggle Relay Pulse Time (500 ms by default), released by the
--   controller itself, the Close and Stop relays (2, 3) released first; with one relay that pulse is
--   the gate's own button, which may also close it, unless a contact says it is open already.
--   OPEN is all DirectorLink sends: never CLOSE or STOP (a gate closing or stopping on someone),
--   never SELECT (the Control4 app's button, which closes whatever is not Closed), never a relay of
--   its own (the controller's Invert settings decide what a relay's states mean).
-- - With Relay Configuration Hold, OPEN holds the Open relay until CLOSE or STOP (its Fail Safe time
--   ends it only with three relays: it then sends Stop): a hold (ADR-036). DirectorLink reads that
--   property where Director gives it with the driver's <devicedata> (C4:GetDeviceData), again at
--   every opening, and then opens such a controller only where Relay Hold is Allowed, scenes never.
-- - Its state: the variable STATE and the events Opened (1), Closed (2), Partial (3) and Unknown
--   (4), from its Closed Contact (connection 4) and Opened Contact (5) when one is bound. Without a
--   contact STATE is only what it was last told (Opened at once after an OPEN with two or three
--   relays, where a second OPEN changes nothing; always Unknown with one pulsed relay):
--   DirectorLink shows a state only with a contact, and uses what the controller says otherwise
--   only to notice an opening made elsewhere (Closed, then Opened: without a contact, an OPEN sent
--   in Control4 after a CLOSE).
-- A KNX Contact/Relay on a controller's Close (2) or Stop (3) connection is part of that door: no
-- door of its own (its pulse would close or stop the gate).
-- A controller whose Open/Toggle relay is a KNX Contact/Relay DirectorLink shows on its own is that
-- relay's door: one door, under the relay's id and name, in its room, as before (scene steps,
-- favorites, ask-to-open links and the history keep naming it), opened by the controller and with
-- its kind and state; the controller's button is then no door of its own. A DoorBird doorbell whose
-- driver gives the controller its relay opens the same gate: both stay (the doorbell's Open is its
-- banner's), and each is the other's partner, so that one opening is noticed once (src/cloud/alerts.lua).
local RelayController = {}

-- The controllers' events (their driver.xml) and the door states they mean (false: not known).
RelayController.EVENTS = { [1] = "open", [2] = "closed", [3] = "partly_open", [4] = false }
-- Their variable STATE, and what its values mean.
RelayController.STATE_VARIABLE = "STATE"
local STATES = { opened = "open", closed = "closed", partial = "partly_open", ["partially open"] = "partly_open" }
-- Their connections: the relays (Open/Toggle, Close, Stop) and the contacts (Closed, Opened).
RelayController.RELAYS = { 1, 2, 3 }
RelayController.CONTACTS = { 4, 5 }

-- proxy id -> what the last project read found of its controller: { proxy, controller, kind,
-- relays = { [binding] = device id }, contacts (how many bound), answered (Director said what is
-- bound), relay (the KNX Contact/Relay it is shown as), partners }.
local surveyed = {}
-- KNX Contact/Relay id -> the controller's proxy whose door it is.
local merged = {}
-- KNX Contact/Relay id -> the controller's proxy whose Close or Stop relay it is (no door, ADR-069).
local closers = {}
-- device id -> { controller, relay (a KNX Contact/Relay's id), hold }
local tracked = {}

local function controllerOf(device)
    for _, protocol in ipairs(type(device) == "table" and device.protocols or {}) do
        local kind = Classifier.relayController(protocol.driver)
        if kind and tonumber(protocol.id) then
            return tonumber(protocol.id), kind
        end
    end
    return nil
end

-- The device bound to connection `binding` of the controller: its id, or nil; and false when Director
-- could not say. Only a number is an answer (0: nothing bound); an error, nil, a table or anything
-- else is Director not saying, and the controller is then taken as bound.
local function boundTo(controllerId, binding)
    local ok, providerId = pcall(function()
        return C4:GetBoundProviderDevice(controllerId, binding)
    end)
    if not ok then
        return nil, false
    end
    if type(providerId) == "string" then
        providerId = tonumber(providerId)
    end
    if type(providerId) ~= "number" then
        return nil, false
    end
    return providerId > 0 and providerId or nil, true
end

local function isDoorbell(device)
    return type(device) == "table" and device.kind == "doorbell"
end

-- The doorbells whose driver is the device `providerId` (a DoorBird's, which gives relay connections).
local function doorbellsOf(registry, providerId)
    local found = {}
    for id, device in pairs(registry.devices or {}) do
        if isDoorbell(device) then
            for _, protocol in ipairs(device.protocols or {}) do
                if tonumber(protocol.id) == providerId then
                    found[#found + 1] = tonumber(id)
                end
            end
        end
    end
    table.sort(found)
    return found
end

local function addPartner(device, id)
    device.partners = device.partners or {}
    for _, known in ipairs(device.partners) do
        if known == id then
            return
        end
    end
    device.partners[#device.partners + 1] = id
end

-- Before the adapters start (src/adapters/manager.lua): what each controller's connections are bound
-- to, which KNX Contact/Relay is a controller's door (or its Close or Stop relay), and which doorbell
-- or other controller opens the same gate. A few Director calls a controller (five
-- C4:GetBoundProviderDevice).
function RelayController.survey(registry)
    surveyed, merged, closers = {}, {}, {}
    local ids = {}
    for id, device in pairs(registry.devices or {}) do
        if device.door_kind and controllerOf(device) then
            ids[#ids + 1] = tonumber(id)
        end
    end
    table.sort(ids)
    for _, id in ipairs(ids) do
        local device = registry.devices[id]
        local controllerId, kind = controllerOf(device)
        local info = { proxy = id, controller = controllerId, kind = kind, relays = {}, contacts = 0, answered = true, partners = {} }
        for _, binding in ipairs(RelayController.RELAYS) do
            local providerId, answered = boundTo(controllerId, binding)
            info.relays[binding] = providerId
            info.answered = info.answered and answered
        end
        for _, binding in ipairs(RelayController.CONTACTS) do
            local providerId, answered = boundTo(controllerId, binding)
            info.contacts = info.contacts + (providerId and 1 or 0)
            info.answered = info.answered and answered
        end
        local openRelay = info.relays[1]
        local relay = openRelay and registry.devices[openRelay]
        if relay and KnxRelay.matches(relay) and not merged[openRelay] then
            merged[openRelay] = id
            info.relay = openRelay
            -- The controller's button is no door of its own (/v1/devices: another device, part of
            -- the relay's door).
            device.shown_as = openRelay
            device.part_of = openRelay
        elseif openRelay then
            for _, doorbellId in ipairs(doorbellsOf(registry, openRelay)) do
                info.partners[#info.partners + 1] = doorbellId
                addPartner(registry.devices[doorbellId], id)
            end
        end
        surveyed[id] = info
    end
    -- A KNX Contact/Relay on a Close or Stop connection is no door (unless it is a controller's door);
    -- one relay opened by two controllers makes their doors each other's partners.
    local byRelay, relayIds = {}, {}
    for _, id in ipairs(ids) do
        local info = surveyed[id]
        for _, binding in ipairs({ 2, 3 }) do
            local relayId = info.relays[binding]
            local relay = relayId and registry.devices[relayId]
            if relay and KnxRelay.matches(relay) and not merged[relayId] and not closers[relayId] then
                closers[relayId] = id
                -- Part of the controller's door (/v1/devices: part_of), under its relay's id when
                -- it is shown as one.
                relay.part_of = info.relay or id
            end
        end
        local openRelay = info.relays[1]
        if openRelay then
            if not byRelay[openRelay] then
                byRelay[openRelay] = {}
                relayIds[#relayIds + 1] = openRelay
            end
            table.insert(byRelay[openRelay], info)
        end
    end
    for _, relayId in ipairs(relayIds) do
        local infos = byRelay[relayId]
        if #infos > 1 then
            local doors = {}
            for index, info in ipairs(infos) do
                doors[index] = info.relay or info.proxy
            end
            for index, info in ipairs(infos) do
                for other, door in ipairs(doors) do
                    if other ~= index then
                        addPartner(info, door)
                    end
                end
            end
            Log.warn("relay", "door controllers open the same relay: one gate shown more than once", { relay = relayId, doors = table.concat(doors, ",") })
        end
    end
end

-- The controller's proxy whose door `device` is: itself, or the controller a KNX Contact/Relay is the
-- door of; nil for any other device, and for a controller's proxy shown as its relay.
local function infoOf(device)
    local id = tonumber(device and device.id)
    if not id then
        return nil
    end
    if merged[id] then
        return surveyed[merged[id]]
    end
    local info = surveyed[id]
    if info and not info.relay then
        return info
    end
    return nil
end

function RelayController.matches(device)
    return infoOf(device) ~= nil or closers[tonumber(device and device.id)] ~= nil
end

-- The KNX Contact/Relay a controller's proxy is shown as (ADR-069), or nil.
function RelayController.shownAs(deviceId)
    local info = surveyed[tonumber(deviceId)]
    return info and info.relay or nil
end

-- A doorbell's doors (1.11.0, ADR-078): the doors set up now whose controller's Open/Toggle relay is
-- bound to a relay connection of the doorbell camera's own driver (the DirectorLink · DoorBird
-- driver's "Relay 1", for one), or of the camera itself; every one when there are several. Their ids
-- (the controller's button, or the KNX Contact/Relay it is shown as), sorted. Only a doorbell camera
-- of the camera agreement (ADR-065): a DoorBird doorstation opens its gate with its own button, and
-- a controller on its relay is its partner (survey). Nothing is asked of Director: the survey read
-- the bindings.
function RelayController.doorsAtDoorbell(registry, doorbell)
    if type(doorbell) ~= "table" or not doorbell.camera_doorbell or not tonumber(doorbell.id) then
        return {}
    end
    local providers = { [tonumber(doorbell.id)] = true }
    local camera = registry and registry.getDevice and registry.getDevice(tonumber(doorbell.id)) or nil
    for _, protocol in ipairs(type(camera) == "table" and camera.protocols or {}) do
        if tonumber(protocol.id) then
            providers[tonumber(protocol.id)] = true
        end
    end
    local doors = {}
    for id, info in pairs(surveyed) do
        local openRelay = info.relays[1]
        local door = info.relay or id
        if openRelay and providers[openRelay] and tracked[door] then
            doors[#doors + 1] = door
        end
    end
    table.sort(doors)
    return doors
end

local function unescape(text)
    return (text:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&amp;", "&"))
end

-- The controller's Relay Configuration ("Pulse" or "Hold") where Director gives the values of its
-- properties with its <devicedata>; nil where it does not (a <default> is not a value).
function RelayController.relayConfiguration(controllerId)
    local ok, data = pcall(function()
        return C4:GetDeviceData(controllerId)
    end)
    if not ok or type(data) ~= "string" or data == "" then
        return nil
    end
    if not data:find("<property>", 1, true) then
        data = unescape(data)
    end
    for block in data:gmatch("<property>(.-)</property>") do
        local name = block:match("<name>%s*(.-)%s*</name>")
        if name == "Relay Configuration" then
            local value = block:match("<value>%s*(.-)%s*</value>")
            if value == "Pulse" or value == "Hold" then
                return value
            end
            return nil
        end
    end
    return nil
end

-- The controller's STATE as DirectorLink shows a door's state: "open", "closed", "partly_open", or
-- nil (Unknown); and whether it was read at all.
local function readState(controllerId)
    local ok, variables = pcall(function()
        return C4:GetDeviceVariables(controllerId)
    end)
    if not ok or type(variables) ~= "table" then
        return nil, false
    end
    for _, variable in pairs(variables) do
        if type(variable) == "table" and string.upper(tostring(variable.name or "")) == RelayController.STATE_VARIABLE then
            return STATES[string.lower(tostring(variable.value or ""))], true
        end
    end
    return nil, false
end

-- before: this door as it was before a project refresh, if it was one.
function RelayController.initialize(device, _registry, before)
    local info = infoOf(device)
    local closing = closers[tonumber(device.id)]
    if not info and closing then
        -- Shown as before it would be a door whose Open closes or stops the gate: part of the
        -- controller's door instead (/v1/devices: an unsupported relay).
        Log.info("relay", "a door controller's Close or Stop relay: not a door of its own", { device_id = device.id, door = surveyed[closing].relay or closing })
        return false, "the Close or Stop relay of a Relay Door, Gate or Garage Door Controller: part of that door, never opened on its own"
    elseif not info then
        return false, "not a Relay Door, Gate or Garage Door Controller's button"
    end
    if info.answered and not info.relays[1] then
        return false, "the controller's Open/Toggle relay connection is not bound to a relay"
    end

    local watching = true
    for eventId in pairs(RelayController.EVENTS) do
        local ok, err = DeviceEvents.watch(info.controller, eventId)
        if not ok then
            watching = false
            Log.warn("relay", "unable to watch a door controller's events", { device_id = device.id, controller = info.controller, event_id = eventId, error = tostring(err) })
        end
    end
    -- A KNX Contact/Relay shown as the controller's door: its own events too (a pulse made in
    -- Control4 that the controller's state does not show, with one relay and no contact).
    local relayWatching = false
    if info.relay then
        relayWatching = true
        for _, eventId in ipairs({ KnxRelay.OPENED_EVENT, KnxRelay.CLOSED_EVENT }) do
            local ok, err = DeviceEvents.watch(info.relay, eventId)
            if not ok then
                relayWatching = false
                Log.warn("relay", "unable to watch relay events", { device_id = device.id, event_id = eventId, error = tostring(err) })
            end
        end
    end

    local configuration = RelayController.relayConfiguration(info.controller)
    tracked[device.id] = { controller = info.controller, relay = info.relay, hold = configuration == "Hold" }

    device.supported = true
    device.adapter_error = nil
    device.door_kind = info.kind
    device.controller_id = info.controller
    -- Events come from the controller; the manager routes them to this door.
    device.event_source_id = info.controller
    if #info.partners > 0 then
        device.partners = {}
        for index, id in ipairs(info.partners) do
            device.partners[index] = id
        end
    end
    device.capabilities = {
        pulse = true,
        set_state = info.relay ~= nil,
        state_reported = relayWatching,
        door_state = info.contacts > 0 and watching,
        hold = configuration == "Hold",
    }
    -- The state as the controller says it now; what a refresh had, when Director gives no STATE.
    local kept = before and before.state or {}
    local door, read = readState(info.controller)
    if not read then
        door = kept.door
    end
    device.state = { relay = info.relay and kept.relay or nil, door = door }
    device.actions = info.relay and { "pulse", "open", "close" } or { "pulse" }

    Log.info("relay", "door controller set up", {
        device_id = device.id,
        controller = info.controller,
        kind = info.kind,
        relays = (info.relays[1] and 1 or 0) + (info.relays[2] and 1 or 0) + (info.relays[3] and 1 or 0),
        contacts = info.contacts,
        bindings_read = info.answered,
        relay_configuration = configuration or "not given by Director",
        shown_as_relay = info.relay,
        partners = #info.partners > 0 and table.concat(info.partners, ",") or nil,
    })
    return true
end

-- True when the door's state (or its relay's) changed. `sourceId`: the device that fired the event
-- (the controller, or the KNX Contact/Relay the door is shown as).
function RelayController.onDeviceEvent(device, eventId, sourceId)
    local info = tracked[device.id]
    if not info or not device.state then
        return false
    end
    eventId = tonumber(eventId)
    if info.relay and tonumber(sourceId) == info.relay then
        local reported
        if eventId == KnxRelay.OPENED_EVENT then
            reported = "open"
        elseif eventId == KnxRelay.CLOSED_EVENT then
            reported = "closed"
        else
            return false
        end
        if device.state.relay == reported then
            return false
        end
        device.state.relay = reported
        return true
    end
    local door = RelayController.EVENTS[eventId]
    if door == nil then
        return false
    end
    door = door or nil
    if device.state.door == door then
        return false
    end
    device.state.door = door
    Log.debug("relay", "door state changed", { device_id = device.id, state = door or "unknown" })
    return true
end

-- Whether the event that just changed the door (`before`: its state before) was it opening:
-- "pulse", else nil. The controller saying Opened or Partial after Closed (with a contact, the door
-- moving; without one, an OPEN sent in Control4 after a CLOSE), or its KNX relay closing from open.
function RelayController.opening(device, eventId, before, sourceId)
    local info = tracked[device.id]
    if not info or type(before) ~= "table" or type(device.state) ~= "table" then
        return nil
    end
    if info.relay and tonumber(sourceId) == info.relay then
        return KnxRelay.closedEvent(eventId) and before.relay == "open" and "pulse" or nil
    end
    local now = device.state.door
    if before.door == "closed" and (now == "open" or now == "partly_open") then
        return "pulse"
    end
    return nil
end

-- Whether the event that just changed the door was the controller saying Closed after Opened or
-- Partial: the opening DirectorLink last commanded is over, and the next one is someone else's
-- (src/adapters/manager.lua). Not its KNX relay's events, and not Closed after Unknown (a contact
-- read late, before the door had moved).
function RelayController.closed(device, _eventId, before, sourceId)
    local info = tracked[device.id]
    if not info or type(before) ~= "table" or type(device.state) ~= "table" then
        return false
    end
    if info.relay and tonumber(sourceId) == info.relay then
        return false
    end
    return device.state.door == "closed" and (before.door == "open" or before.door == "partly_open")
end

function RelayController.onVariableChanged()
    return false
end

-- A door of a controller (ADR-069).
function RelayController.handles(device)
    return type(device) == "table" and tracked[tonumber(device.id)] ~= nil
end

function RelayController.execute(device, action, params)
    local info = tracked[device.id]
    if not info or not device.supported then
        return false, { code = "DEVICE_NOT_SUPPORTED", message = "This door is not initialized" }
    end
    local sent, err
    if action == "pulse" then
        -- Read again at each opening: an installer who sets Hold in Composer sends DirectorLink no
        -- project event. Where Director gives no value now, what the set-up read stands.
        local configuration = RelayController.relayConfiguration(info.controller)
        if configuration then
            info.hold = configuration == "Hold"
            if type(device.capabilities) == "table" then
                device.capabilities.hold = info.hold
            end
        end
        if info.hold and not (type(params) == "table" and params.hold_allowed == true) then
            return false, {
                code = "HOLD_NOT_ALLOWED",
                message = "This controller holds its relay (Relay Configuration Hold in Composer), which holds the door or gate open. Set it to Pulse, or an installer can allow holds (Relay Hold).",
            }
        end
        sent, err = pcall(function()
            C4:SendToDevice(info.controller, "OPEN", {})
        end)
        err = not sent and tostring(err) or nil
    elseif (action == "open" or action == "close") and info.relay then
        -- The KNX Contact/Relay's own release and hold, as before it was a controller's door.
        sent, err = KnxRelay.send(info.relay, action == "open" and "Open Relay" or "Close Relay")
    else
        return false, { code = "ACTION_NOT_SUPPORTED", message = "A Relay Door, Gate or Garage Door Controller is only opened, with its own Open" }
    end
    if not sent then
        Log.error("relay_command", "Control4 command failed", { device_id = device.id, action = action, error = err })
        return false, { code = "CONTROL4_COMMAND_FAILED", message = "Director rejected the command: " .. tostring(err) }
    end
    Log.info("relay_command", action == "pulse" and "door controller told to open" or "relay command sent", { device_id = device.id, controller = info.controller, action = action })
    return true, { device_id = device.id, action = action }
end

function RelayController.reset()
    tracked = {}
end

return RelayController
