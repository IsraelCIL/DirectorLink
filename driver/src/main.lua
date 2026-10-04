local Version = require("src.core.version")
local Log = require("src.core.log")
local Registry = require("src.core.registry")
local Discovery = require("src.control4.discovery")
local Normalize = require("src.control4.normalize")
local ProjectEvents = require("src.control4.project_events")
local AdapterManager = require("src.adapters.manager")
local Alarm = require("src.adapters.alarm")
local Refrigerator = require("src.adapters.refrigerator")
local Keys = require("src.auth.keys")
local RoomNames = require("src.core.room_names")
local RoomLayout = require("src.core.room_layout")
local Scenes = require("src.core.scenes")
local Schedules = require("src.core.schedules")
local Scheduler = require("src.core.scheduler")
local Weather = require("src.core.weather")
local JewishCalendar = require("src.core.jewish_calendar")
local SceneHandlers = require("src.api.handlers.scenes")
local SceneLinks = require("src.core.scene_links")
local SceneLinkHandlers = require("src.api.handlers.scene_links")
local InstallerView = require("src.core.installer_view")
local Store = require("src.core.store")
local Clock = require("src.core.clock")
local Profiles = require("src.auth.profiles")
local Pairing = require("src.auth.pairing")
local Api = require("src.api.server")
local Relay = require("src.cloud.relay")
local Remote = require("src.cloud.remote")
local Invitations = require("src.auth.invitations")
local Sonos = require("src.sonos.sonos")
local SonosClient = require("src.sonos.client")
local SonosRooms = require("src.sonos.rooms")
local Activity = require("src.core.activity")
local AutoBackup = require("src.cloud.auto_backup")
local Alerts = require("src.cloud.alerts")

local LIFECYCLE_KEYS = {
    reload_count = "directorlink_reload_count",
    last_init_type = "directorlink_last_init_type",
    last_init_time = "directorlink_last_init_time",
    last_destroy_type = "directorlink_last_destroy_type",
    last_destroy_time = "directorlink_last_destroy_time",
}

-- Composer's "Log Level" list uses these labels.
local COMPOSER_LEVEL = {
    debug = "Debug",
    info = "Info",
    warn = "Warning",
    error = "Error",
}

local STATE = {
    controllerVersion = nil,
    supported = false,
    status = "starting",
    detail = nil,
}

local function updateProperty(name, value)
    pcall(function()
        C4:UpdateProperty(name, tostring(value or ""))
    end)
end

local function persistSet(key, value)
    pcall(function()
        C4:PersistSetValue(key, tostring(value or ""), false)
    end)
end

local function persistGet(key)
    local ok, value = pcall(function()
        return C4:PersistGetValue(key, false)
    end)
    if ok and value ~= nil and tostring(value) ~= "" then
        return tostring(value)
    end
    return nil
end

local function lifecycle()
    local snapshot = {}
    for field, key in pairs(LIFECYCLE_KEYS) do
        snapshot[field] = persistGet(key)
    end
    return snapshot
end

local function setStatus(status, detail)
    STATE.status = status
    STATE.detail = detail
    if status == "ok" then
        updateProperty("Status", "Ready")
    elseif status == "starting" then
        updateProperty("Status", detail or "Starting...")
    else
        updateProperty("Status", "Error: " .. tostring(detail))
    end
end

local function publishKeyCount()
    updateProperty("API Keys", Keys.count())
end

-- A key was created, changed or revoked: profiles nobody uses go, and the scene links a revoked
-- key made (ADR-051), then Composer's count and the cloud's list of key ids.
local function keysChanged()
    Profiles.prune(Keys.list())
    if Keys.complete() then
        Alerts.prune(Keys.list())
    end
    SceneLinkHandlers.prune()
    publishKeyCount()
    Relay.announceKeys()
end

-- Keys whose expiry passed (ADR-040: the console's) were removed: like a revoked key.
local function keysExpired(removed)
    for _, key in ipairs(removed) do
        Invitations.revokeCreatedBy(key.id)
        Log.info("auth", "API key expired and was removed", { key_id = key.id, name = key.name })
        Activity.record("access", "expired", { what = key.name, ids = { key_id = key.id } })
    end
    keysChanged()
end

-- A key's device name and person, for the history (src/core/activity.lua).
local function keyInfo(id)
    local key = Keys.find(id)
    local profile = key and key.profile and Profiles.find(key.profile)
    return key and { name = key.name, profile = profile and profile.name or nil } or nil
end

-- Keys from before 0.12.0 (or whose profile is gone) each get a profile of their own.
local function assignProfiles()
    local assigned = 0
    for _, key in ipairs(Keys.list()) do
        if not (key.profile and Profiles.find(key.profile)) then
            local profile = Profiles.create(key.name)
            if profile then
                Keys.update(key.id, { profile = profile.id })
                assigned = assigned + 1
            end
        end
    end
    local removed = Profiles.prune(Keys.list())
    if assigned > 0 or removed > 0 then
        Log.info("auth", "profiles updated", { new = assigned, removed = removed })
    end
end

-- What DirectorLink automates, shown to the installer in Composer (src/core/installer_view.lua).
local LAST_AUTOMATION_KEY = "directorlink_last_automation"
local shownScheduleStatus = nil

local function schedulesPaused()
    return Properties ~= nil and Properties["Schedules"] == "Paused"
end

local function refreshScheduleStatus(now)
    local ok, text = pcall(InstallerView.scheduleStatus, now or Clock.now(), schedulesPaused(), JewishCalendar)
    if ok and text ~= shownScheduleStatus then
        shownScheduleStatus = text
        updateProperty("Schedule Status", text)
    end
end

-- Calendar Status: what the Jewish calendar works out (src/core/jewish_calendar.lua), or Off.
local shownCalendarStatus = nil

local function refreshCalendarStatus(now)
    local ok, text = pcall(JewishCalendar.statusText, now or Clock.now())
    if ok and text ~= shownCalendarStatus then
        shownCalendarStatus = text
        updateProperty("Calendar Status", text)
    end
end

-- The calendar's settings, location or switch changed: the times, and what runs next, with them.
-- Turned on again, or given a location, it catches up nothing that was due meanwhile.
local function calendarChanged()
    JewishCalendar.invalidate()
    Scheduler.switchesChanged()
    refreshCalendarStatus()
    refreshScheduleStatus()
end

local function automationRan(event)
    local ok, text = pcall(InstallerView.lastAutomation, event)
    if ok then
        updateProperty("Last Automation", text)
        Store.write(LAST_AUTOMATION_KEY, { version = 1, text = text }, false)
    end
end

-- After a restore from a backup (ADR-042): invitations and a claim token made before it go (they
-- were for the keys and the home there were), keys get their profiles, and the calendar and what
-- runs next are worked out again. With another home's identity, the relay connection is made again
-- once the answer has gone out; it announces the keys then.
local function restored(restore)
    Invitations.revokeAll()
    Remote.clearClaim()
    if Keys.complete() then
        assignProfiles()
    end
    publishKeyCount()
    if restore.switching then
        Relay.reconnect(2, "remote identity restored from a backup")
    else
        Relay.announceKeys()
    end
    shownScheduleStatus, shownCalendarStatus = nil, nil
    calendarChanged()
    -- Scene links (ADR-051) whose scene did not come back, or that name another home, go.
    SceneLinkHandlers.prune()
end

local services = {
    registry = Registry,
    adapters = AdapterManager,
    keys = Keys,
    profiles = Profiles,
    invitations = Invitations,
    pairing = Pairing,
    log = Log,
    -- Remote access with accounts (src/cloud/remote.lua, src/api/handlers/remote.lua).
    remote = {
        enabled = function()
            return Properties ~= nil and Properties["Remote Access"] == "On"
        end,
        connected = function()
            return Relay.connected()
        end,
        available = function()
            return Remote.available()
        end,
        homeId = function()
            return Relay.identity().home_id
        end,
        createClaim = function(keyId)
            return Remote.createClaim(keyId)
        end,
        -- A replacement home secret for the owner to approve (POST /v1/remote/secret).
        prepareSecret = function()
            return Relay.prepareSecret()
        end,
        -- Asks the account service over the home's connection (invitations).
        ask = function(message, seconds, done)
            Relay.ask(message, seconds, done)
        end,
        -- Tells it something that needs no answer; false when not connected.
        tell = function(message)
            return Relay.tell(message)
        end,
    },
    startedAt = os.time(),
    controllerVersion = nil,
    lifecycle = lifecycle,
    -- Opening doors and gates from the API needs the Composer property "Door Control" = Enabled.
    doorControlEnabled = function()
        return Properties ~= nil and Properties["Door Control"] == "Enabled"
    end,
    -- Holding a relay closed (PATCH state closed) also needs "Relay Hold" = Allowed: a door or gate
    -- stays open while its relay is held. A pulse and opening the relay do not need it.
    relayHoldAllowed = function()
        return Properties ~= nil and Properties["Relay Hold"] == "Allowed"
    end,
    -- Shabbat and holiday times (the Jewish calendar, ADR-037) need the Composer property "Jewish
    -- Calendar" = On: /v1/system says so, and schedules may use the calendar only then.
    calendarEnabled = function()
        return Properties ~= nil and Properties["Jewish Calendar"] == "On"
    end,
    calendar = JewishCalendar,
    onCalendarChanged = calendarChanged,
    -- The alarm's partitions are watched, and shown to members and admins (read-only), only with
    -- "Alarm Status" = On (ADR-038). Read at every request, like the door switches.
    alarmStatusEnabled = Alarm.enabled,
    -- Sonos players on the home network (ADR-044, src/sonos/sonos.lua), only with "Sonos" = On.
    sonosEnabled = Sonos.enabled,
    status = function()
        return { state = STATE.status, detail = STATE.detail }
    end,
    onKeysChanged = keysChanged,
    -- A restore from a backup replaced every store (ADR-042, src/core/backup.lua).
    onRestored = function(restore)
        restored(restore)
    end,
    schedulesPaused = schedulesPaused,
    onAutomation = automationRan,
    onSchedulesChanged = function()
        refreshScheduleStatus()
    end,
    onLogLevelChanged = function(level)
        updateProperty("Log Level", COMPOSER_LEVEL[level] or "Info")
    end,
    onServerStatus = function(online, status)
        if online then
            updateProperty("API Status", "Online - port " .. Api.PORT)
        elseif status == "TAKEN" then
            -- Another driver holds the port (api/server.lua); remote access still works.
            updateProperty("API Status", "Port " .. Api.PORT .. " taken by another driver - retrying every minute")
        else
            updateProperty("API Status", "Offline (" .. status .. ")")
        end
    end,
}

local function readControllerVersion()
    local ok, info = pcall(function()
        return C4:GetVersionInfo()
    end)
    if ok and type(info) == "table" then
        return info.version
    end
    return nil
end

-- A failed read at start is the driver's status. A failed refresh leaves the project read before
-- in use, and the status as it was.
local function fail(message, reason)
    if reason then
        Log.error("discovery", "project refresh failed; the project read before stays in use", { reason = reason, error = message })
        return false
    end
    Log.error("discovery", message)
    setStatus("error", message)
    return false
end

-- Composer's Inventory: what DirectorLink found. Alarm partitions are counted only while Alarm
-- Status is On (ADR-038).
local function publishInventory()
    local counts = Registry.counts()
    local text = string.format(
        "%d rooms, %d devices, %d lights, %d thermostats, %d fans, %d blinds, %d cameras, %d relays, %d doorbells",
        counts.rooms,
        counts.devices,
        counts.supported_lights,
        counts.supported_climate,
        counts.supported_fans,
        counts.supported_blinds,
        counts.supported_cameras,
        counts.supported_relays,
        counts.supported_doorbells
    )
    if counts.supported_refrigerators > 0 then
        text = text .. string.format(", %d refrigerators", counts.supported_refrigerators)
    end
    if Alarm.enabled() then
        text = text .. string.format(", %d alarm partitions", counts.alarm_partitions)
    end
    updateProperty("Inventory", text)
    return counts
end

-- A refrigerator's door has been open longer than its driver's Door Open Alert (ADR-049): once per
-- opening, from the driver's Door Left Open event (src/adapters/refrigerator.lua). It goes into the
-- history, and to the members and admins who chose the alert, sealed to each one's key (ADR-050),
-- saying for how many minutes at least, when DirectorLink saw the door open (`seconds`).
Refrigerator.onDoorLeftOpen(function(device, seconds)
    Activity.record("door", "left_open", { what = device.name, room = device.room_name, ids = { device_id = device.id, room_id = device.room_id } })
    local ok, err = pcall(Alerts.fridgeDoor, device, seconds)
    if not ok then
        Log.warn("alerts", "refrigerator alert failed", { device_id = device.id, error = tostring(err) })
    end
end)

-- Reads the project from Director and (re)starts the adapters. `reason` is set for a refresh while
-- the driver runs (src/control4/project_events.lua, or the action Refresh Project): the API keeps
-- answering throughout (Lua runs one thing at a time), and keys, pairing, scenes, schedules, room
-- names and the room order stay as they are; they refer to devices and rooms by id.
local function discover(reason)
    if not reason then
        setStatus("starting", "Discovering project...")
    end

    local ok, raw = pcall(Discovery.collect)
    if not ok then
        return fail("Discovery failed: " .. tostring(raw), reason)
    end

    local normalizeOk, normalized = pcall(Normalize.project, raw)
    if not normalizeOk then
        return fail("Normalization failed: " .. tostring(normalized), reason)
    end
    -- Director answers with an empty project while it loads one: not a reason to show nothing.
    if reason and next(normalized.devices or {}) == nil and next(Registry.devices or {}) ~= nil then
        return fail("Director listed no devices", reason)
    end

    local previousDevices, previousRooms = Registry.devices, Registry.rooms
    Registry.reset()
    Registry.replace(normalized)
    AdapterManager.initialize(Registry, reason and previousDevices or nil)

    local counts = publishInventory()
    if reason then
        local changes = Registry.changes(previousDevices, previousRooms)
        changes.reason = reason
        changes.rooms = counts.rooms
        changes.devices = counts.devices
        changes.supported = counts.supported
        Log.info("discovery", "project rediscovered", changes)
        Activity.record("composer", "project", Registry.changeList(previousDevices, previousRooms))
        -- The project's location may have changed with it, and with it the next sunrise or sunset
        -- a schedule waits for, and Shabbat and holiday times.
        shownScheduleStatus, shownCalendarStatus = nil, nil
        calendarChanged()
    else
        Log.info("discovery", "project discovered", counts)
    end
    setStatus("ok")
    return true
end

-- Composer changes (a device moved to another room, renamed, added or removed) without restarting
-- the driver: the action Refresh Project, and Director's project events a few seconds after the
-- last one (a refresh they started that fails is tried once more). The events are watched once a
-- project was read.
local refreshProject

local function watchProject()
    ProjectEvents.start({
        ownIds = { (Registry.metadata or {}).bridgeDeviceId },
        onChange = function(events)
            return refreshProject("Composer changes (" .. events .. ")")
        end,
    })
end

refreshProject = function(reason)
    if not STATE.supported then
        return false
    end
    ProjectEvents.cancel()
    local refreshed = discover(reason)
    if refreshed then
        watchProject()
    end
    return refreshed
end

function OnDriverInit(driverInitType)
    services.startedAt = os.time()
    if Properties then
        Log.setLevel(Properties["Log Level"])
    end

    local count = (tonumber(persistGet(LIFECYCLE_KEYS.reload_count)) or 0) + 1
    persistSet(LIFECYCLE_KEYS.reload_count, count)
    persistSet(LIFECYCLE_KEYS.last_init_type, tostring(driverInitType or "nil"))
    persistSet(LIFECYCLE_KEYS.last_init_time, os.date("%Y-%m-%d %H:%M:%S"))

    STATE.controllerVersion = readControllerVersion()
    services.controllerVersion = STATE.controllerVersion
    STATE.supported = Version.isSupported(STATE.controllerVersion)

    Log.info("lifecycle", "driver init", {
        version = Version.BRIDGE_VERSION,
        init_type = tostring(driverInitType),
        controller_os = STATE.controllerVersion,
        reload_count = count,
    })
end

function OnDriverLateInit(driverInitType)
    updateProperty("Version", Version.BRIDGE_VERSION)

    if not STATE.supported then
        setStatus("error", "Unsupported controller OS (DirectorLink requires 3.3.0 or newer)")
        updateProperty("API Status", "Disabled")
        return
    end

    -- What happens from now on goes into the history (ADR-046), with the names keys have then.
    local activityCount = Activity.load({ keyInfo = keyInfo })
    Activity.started(Version.BRIDGE_VERSION, driverInitType)
    Log.info("activity", "history loaded", { entries = activityCount })
    Keys.onExpired(keysExpired)
    local keyCount, keysStoredAs, oldKeysStoredAs = Keys.load()
    Log.info("auth", "keys loaded", { count = keyCount, stored_as = keysStoredAs, old_store = oldKeysStoredAs })
    -- Before the first look at the keys, which removes expired ones and their invitations.
    Invitations.load()
    RoomNames.load()
    RoomLayout.load()
    local sceneCount, scenesStoredAs = Scenes.load()
    Log.info("scenes", "scenes loaded", { count = sceneCount, stored_as = scenesStoredAs })
    -- Scene links (ADR-051): a scene changed to open doors meanwhile (by an older DirectorLink)
    -- loses its link now.
    local linkCount, linksStoredAs = SceneLinks.load()
    Log.info("scenes", "scene links loaded", { count = linkCount, stored_as = linksStoredAs })
    SceneLinkHandlers.prune()
    local scheduleCount, schedulesStoredAs = Schedules.load()
    Log.info("schedules", "schedules loaded", { count = scheduleCount, stored_as = schedulesStoredAs })
    Profiles.load()
    SonosRooms.load()
    AutoBackup.load()
    -- Only with a key store read in full: after a failed read, keys may come back at the next start.
    if Keys.complete() then
        assignProfiles()
    end
    publishKeyCount()

    -- A driver without keys (just added, or all keys revoked) offers a pairing code right away;
    -- otherwise codes are created on demand with the New Pairing Code action.
    local pairingOk, pairingError = Pairing.initialize({
        log = Log,
        openNow = Keys.count() == 0,
        onChange = function(code, status)
            updateProperty("Pairing Code", code)
            updateProperty("Pairing Status", status)
        end,
    })
    if not pairingOk then
        Log.error("auth", "pairing is unavailable", { error = tostring(pairingError) })
    end

    -- Start the API before discovery so health and logs stay reachable if discovery fails.
    Api.init(services)
    local started = Api.start()
    updateProperty("API Status", started and "Starting..." or "Failed to start")

    Log.info("lifecycle", "late init", { init_type = tostring(driverInitType) })
    if discover() then
        watchProject()
    end

    -- Sonos (ADR-044): DirectorLink looks for the players and talks to them only while the
    -- installer has set Sonos to On; Sonos Players shows what it found.
    Sonos.configure({
        registry = Registry,
        roomNames = RoomNames.get,
        onStatus = function(text)
            updateProperty(Sonos.STATUS_PROPERTY, text)
        end,
    })
    Sonos.apply()

    -- Schedules run on the controller (src/core/scheduler.lua); the weather is for the project's
    -- location (Composer project properties).
    Weather.load()
    Weather.configure(function()
        local properties = (Registry.metadata or {}).properties or {}
        return tonumber(properties.Latitude), tonumber(properties.Longitude)
    end)
    -- Shabbat and holiday times, for the same location; Israel or abroad from it, or else from the
    -- project's country and time zone (src/core/jewish_calendar.lua).
    JewishCalendar.configure({
        enabled = services.calendarEnabled,
        location = Weather.location,
        region = function()
            local metadata = Registry.metadata or {}
            return { country_code = (metadata.properties or {}).CountryCode, timezone = metadata.timezone }
        end,
    })
    JewishCalendar.load()
    Scheduler.start({
        runScene = function(sceneId, caller)
            return SceneHandlers.runSaved(services, sceneId, caller)
        end,
        paused = schedulesPaused,
        calendar = JewishCalendar,
        onRun = automationRan,
        -- A schedule that failed: the home's admins are alerted, sealed to their keys (ADR-050).
        onFailed = Alerts.scheduleFailed,
        onTick = function(now)
            refreshScheduleStatus(now)
            refreshCalendarStatus(now)
            -- Keys that expired go within a minute, with their invitations, even when nothing asks.
            Keys.count()
            -- The day's automatic backup, at the home's minute (ADR-048).
            AutoBackup.tick(now)
        end,
    })
    shownScheduleStatus, shownCalendarStatus = nil, nil
    refreshScheduleStatus()
    refreshCalendarStatus()
    local last = Store.read(LAST_AUTOMATION_KEY, false)
    if type(last) == "table" and type(last.text) == "string" then
        updateProperty("Last Automation", last.text)
    end

    Remote.init({
        services = services,
        handleRequest = Api.handleRequest,
        homeId = function()
            return Relay.identity().home_id
        end,
    })
    Relay.init({
        services = services,
        remote = Remote.handle,
        onStatus = function(text)
            updateProperty("Remote Status", text)
        end,
    })
    -- Automatic backups go to the account over the relay connection (ADR-048).
    AutoBackup.configure({
        registry = Registry,
        ready = function()
            return STATE.status == "ok"
        end,
        remoteEnabled = services.remote.enabled,
        lockAvailable = Remote.available,
    })
    -- Alerts the controller makes, sealed to each device's key (ADR-050): doorbells rang, doors
    -- and gates opened (as the history has them), schedules that failed; the refrigerator's door
    -- left open calls Alerts.fridgeDoor (above), and members are offered it in a home with one.
    Alerts.start({
        relay = Relay,
        remote = Remote,
        keys = Keys,
        registry = Registry,
        adapters = AdapterManager,
        activity = Activity,
        hasFridge = function()
            return next(Registry.refrigeratorList()) ~= nil
        end,
    })
    if Properties and Properties["Remote Access"] == "On" then
        Relay.start()
    else
        updateProperty("Remote Status", "Off")
    end
end

-- Every scene link goes (ADR-051): Composer's Remove All Scene Links (`always`: in the history even
-- when there were none), Revoke All API Keys and Reset Remote Identity (`reason`). Links that could
-- not be removed for good (the store was not written) stay, and the history, the log and Remote
-- Status say so. Returns how many there were and whether they went.
local function removeSceneLinks(reason, always)
    local count, saved = SceneLinks.removeAll()
    if not saved then
        Log.error("scenes", "scene links not removed: they could not be saved", { count = count, reason = reason })
        updateProperty("Remote Status", "Scene links not removed: could not save")
        Activity.record("access", "links_removed", { who = Activity.COMPOSER, count = count, reason = reason, outcome = "failed" })
    elseif count > 0 or always then
        Activity.record("access", "links_removed", { who = Activity.COMPOSER, count = count, reason = reason })
    end
    return count, saved
end

function ExecuteCommand(command, params)
    if command ~= "LUA_ACTION" or type(params) ~= "table" then
        return
    end
    if params.ACTION == "NEW_PAIRING_CODE" then
        Pairing.open()
    elseif params.ACTION == "RESET_REMOTE_IDENTITY" then
        -- The last resort when the home's connection cannot be trusted and its secret cannot be
        -- replaced by the owner (someone else holds it, or took the home over): a new home id.
        -- Invitations and claim tokens were for the old one. The owner links the home again.
        local ok, code = Relay.resetIdentity()
        if ok then
            local invitations = Invitations.revokeAll()
            Remote.clearClaim()
            -- Scene links name the old home in their addresses: none of them can work any more.
            local links = removeSceneLinks("new_identity")
            Log.warn("relay", "remote identity reset from Composer", { invitations = invitations, scene_links = links })
        else
            updateProperty("Remote Status", "Identity not reset: " .. tostring(code))
        end
    elseif params.ACTION == "REFRESH_PROJECT" then
        -- After moving, renaming, adding or removing devices and rooms in Composer, when Director
        -- does not announce it (or has not yet): no driver restart needed.
        refreshProject("Composer action")
    elseif params.ACTION == "PRINT_AUTOMATION" then
        -- To Composer's Lua output, for the installer: every schedule and scene in full.
        local ok, lines = pcall(InstallerView.printout, Clock.now(), schedulesPaused(), Registry, JewishCalendar)
        for _, line in ipairs(ok and lines or { "DirectorLink could not list its schedules: " .. tostring(lines) }) do
            print(line)
        end
        Log.info("schedules", "schedules and scenes printed for Composer")
    elseif params.ACTION == "REVOKE_API_KEYS" then
        local count = Keys.revokeAll()
        -- Nobody may join afterwards with an invitation or claim the home with an older token, nor
        -- run a scene with a link someone made before (ADR-051).
        local invitations = Invitations.revokeAll()
        Remote.clearClaim()
        Activity.record("access", "all_revoked", { who = Activity.COMPOSER, count = count })
        local links = removeSceneLinks("keys_revoked")
        keysChanged()
        Log.warn("auth", "all API keys revoked from Composer", { count = count, invitations = invitations, scene_links = links })
    elseif params.ACTION == "REMOVE_SCENE_LINKS" then
        -- Every scene's link stops working at once (ADR-051); admins can make new ones.
        local count, saved = removeSceneLinks(nil, true)
        if saved then
            Log.warn("scenes", "all scene links removed from Composer", { count = count })
        end
    end
end

-- Composer settings whose changes go into the history (ADR-046): what decides whether automation
-- runs and doors open, and what DirectorLink reaches.
local HISTORY_SETTINGS = {
    ["Remote Access"] = true,
    ["Schedules"] = true,
    ["Jewish Calendar"] = true,
    ["Door Control"] = true,
    ["Relay Hold"] = true,
    [Alarm.PROPERTY] = true,
    [Sonos.PROPERTY] = true,
}

function OnPropertyChanged(name)
    if HISTORY_SETTINGS[name] and Properties then
        Activity.record("composer", "setting", { what = name, to = Properties[name] })
    end
    if name == "Remote Access" and Properties then
        if Properties[name] == "On" then
            Relay.start()
        else
            Relay.stop()
        end
    end
    if name == "Schedules" and Properties then
        Log.info("schedules", schedulesPaused() and "schedules paused in Composer" or "schedules resumed in Composer")
        -- Resumed: what was due while paused is never caught up, not even after a restart.
        Scheduler.switchesChanged()
        refreshScheduleStatus()
    end
    -- No restart needed: the scheduler asks the calendar every minute. Turned on again, it catches
    -- nothing up (calendarChanged).
    if name == "Jewish Calendar" and Properties then
        Log.info("calendar", services.calendarEnabled() and "jewish calendar on in Composer" or "jewish calendar off in Composer")
        calendarChanged()
    end
    if name == "Door Control" and Properties then
        Log.info("relay_command", "door control " .. string.lower(tostring(Properties[name])) .. " in Composer")
    end
    if name == "Relay Hold" and Properties then
        Log.info("relay_command", "relay hold " .. string.lower(tostring(Properties[name])) .. " in Composer")
    end
    if name == Alarm.PROPERTY and Properties and STATE.supported then
        -- The partitions are watched from now on, or no longer; nothing about their state is logged.
        local started, released = AdapterManager.onPropertyChanged(name)
        Log.info("alarm", Alarm.enabled() and "alarm status on in Composer" or "alarm status off in Composer", {
            partitions_watched = started,
            partitions_released = released,
        })
        publishInventory()
    end
    if (name == Sonos.PROPERTY or name == Sonos.ADDRESS_PROPERTY) and Properties and STATE.supported then
        Sonos.apply(name)
    end
    if name == "Log Level" and Properties then
        if Log.setLevel(Properties[name]) then
            Log.info("logs", "log level changed from Composer", { level = Log.getLevel() })
        end
    end
end

function OnWatchedVariableChanged(idDevice, idVariable, strValue)
    AdapterManager.onVariableChanged(idDevice, idVariable, strValue)
end

-- Events of devices DirectorLink registered with C4:RegisterDeviceEvent (relay opened/closed).
function OnDeviceEvent(firingDevice, eventId)
    AdapterManager.onDeviceEvent(firingDevice, eventId)
end

-- Director's system events DirectorLink registered for: Composer changed the project.
function OnSystemEvent(data)
    ProjectEvents.onSystemEvent(data)
end

-- The relay's outgoing connection (network binding 6001), and the search for Sonos players (UDP,
-- binding 6100).
function OnConnectionStatusChanged(idBinding, nPort, strStatus)
    if SonosClient.onConnectionStatus(idBinding, nPort, strStatus) then
        return
    end
    Relay.onConnectionStatus(idBinding, nPort, strStatus)
end

function ReceivedFromNetwork(idBinding, nPort, strData)
    if SonosClient.onData(idBinding, nPort, strData) then
        return
    end
    Relay.onData(idBinding, nPort, strData)
end

-- Director polls a connection it monitors; the relay's asks not to be (src/cloud/websocket.lua).
function OnPoll(idBinding, nPort)
    Relay.onPoll(idBinding, nPort)
end

function OnServerStatusChanged(port, status)
    Api.onStatusChanged(port, status)
end

function OnServerConnectionStatusChanged(handle, port, status)
    Api.onConnectionStatusChanged(handle, port, status)
end

function OnServerDataIn(handle, data, clientAddress, clientPort)
    Api.onData(handle, data, clientAddress, clientPort)
end

function OnDriverDestroyed(driverInitType)
    Scheduler.stop()
    ProjectEvents.stop()
    persistSet(LIFECYCLE_KEYS.last_destroy_type, tostring(driverInitType or "nil"))
    persistSet(LIFECYCLE_KEYS.last_destroy_time, os.date("%Y-%m-%d %H:%M:%S"))
    Log.info("lifecycle", "driver destroyed", { init_type = tostring(driverInitType) })
    Activity.flush()
    Relay.stop()
    Sonos.shutdown()
    Api.stop()
    AdapterManager.shutdown()
end
