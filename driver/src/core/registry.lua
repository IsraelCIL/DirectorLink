local Registry = {
    metadata = {},
    locations = {},
    rooms = {},
    devices = {},
    protocols = {},
    refreshedAt = nil,
}

local function count(values)
    local total = 0
    for _, _ in pairs(values or {}) do
        total = total + 1
    end
    return total
end

function Registry.reset()
    Registry.metadata = {}
    Registry.locations = {}
    Registry.rooms = {}
    Registry.devices = {}
    Registry.protocols = {}
    Registry.refreshedAt = nil
end

function Registry.replace(normalized)
    Registry.metadata = normalized.metadata or {}
    Registry.locations = normalized.locations or {}
    Registry.rooms = normalized.rooms or {}
    Registry.devices = normalized.devices or {}
    Registry.protocols = normalized.protocols or {}
    Registry.refreshedAt = os.time()
end

local function sortedList(values)
    local result = {}
    for _, value in pairs(values or {}) do
        table.insert(result, value)
    end

    table.sort(result, function(a, b)
        local aName = string.lower(tostring(a.name or ""))
        local bName = string.lower(tostring(b.name or ""))
        if aName == bName then
            return tonumber(a.id or 0) < tonumber(b.id or 0)
        end
        return aName < bName
    end)

    return result
end

function Registry.getDevice(id)
    return Registry.devices[tonumber(id)]
end

function Registry.roomList()
    return sortedList(Registry.rooms)
end

function Registry.deviceList()
    return sortedList(Registry.devices)
end

function Registry.climateList()
    local climates = {}

    for id, device in pairs(Registry.devices or {}) do
        if device.kind == "climate" and device.supported == true then
            climates[id] = device
        end
    end

    return sortedList(climates)
end

function Registry.fanList()
    local fans = {}

    for id, device in pairs(Registry.devices or {}) do
        if device.kind == "fan" and device.supported == true then
            fans[id] = device
        end
    end

    return sortedList(fans)
end

function Registry.blindList()
    local blinds = {}

    for id, device in pairs(Registry.devices or {}) do
        if device.kind == "blind" and device.supported == true then
            blinds[id] = device
        end
    end

    return sortedList(blinds)
end

function Registry.cameraList()
    local cameras = {}

    for id, device in pairs(Registry.devices or {}) do
        if device.kind == "camera" and device.supported == true then
            cameras[id] = device
        end
    end

    return sortedList(cameras)
end

function Registry.relayList()
    local relays = {}

    for id, device in pairs(Registry.devices or {}) do
        if device.kind == "relay" and device.supported == true then
            relays[id] = device
        end
    end

    return sortedList(relays)
end

function Registry.doorbellList()
    local doorbells = {}

    for id, device in pairs(Registry.devices or {}) do
        if device.kind == "doorbell" and device.supported == true then
            doorbells[id] = device
        end
    end

    return sortedList(doorbells)
end

-- Samsung refrigerators (ADR-049).
function Registry.refrigeratorList()
    local refrigerators = {}

    for id, device in pairs(Registry.devices or {}) do
        if device.kind == "refrigerator" and device.supported == true then
            refrigerators[id] = device
        end
    end

    return sortedList(refrigerators)
end

function Registry.lightList()
    local lights = {}

    for id, device in pairs(Registry.devices or {}) do
        if device.kind == "light" and device.supported == true then
            lights[id] = device
        end
    end

    return sortedList(lights)
end

-- The alarm's partitions DirectorLink watches (Alarm Status On in Composer, ADR-038), without the
-- ones the panel does not use (IS_ACTIVE = 0).
local function alarmPartition(device)
    return device.kind == "alarm" and device.supported == true and not (device.state and device.state.active == false)
end

function Registry.alarmList()
    local partitions = {}

    for id, device in pairs(Registry.devices or {}) do
        if alarmPartition(device) then
            partitions[id] = device
        end
    end

    return sortedList(partitions)
end

function Registry.counts()
    local recognized = 0
    local unsupported = 0
    local supported = 0
    local supportedLights = 0
    local supportedClimate = 0
    local supportedFans = 0
    local supportedBlinds = 0
    local supportedCameras = 0
    local supportedRelays = 0
    local supportedDoorbells = 0
    local supportedRefrigerators = 0
    local alarmPartitions = 0

    for _, device in pairs(Registry.devices) do
        -- A partition is not watched while Alarm Status is Off: unsupported, as before 1.2.0.
        if device.recognized and not (device.kind == "alarm" and device.supported ~= true) then
            recognized = recognized + 1
        else
            unsupported = unsupported + 1
        end

        if device.kind == "alarm" then
            -- Read-only and for members and admins only: counted apart from the devices the API
            -- controls.
            if alarmPartition(device) then
                alarmPartitions = alarmPartitions + 1
            end
        elseif device.supported then
            supported = supported + 1
            if device.kind == "light" then
                supportedLights = supportedLights + 1
            elseif device.kind == "climate" then
                supportedClimate = supportedClimate + 1
            elseif device.kind == "fan" then
                supportedFans = supportedFans + 1
            elseif device.kind == "blind" then
                supportedBlinds = supportedBlinds + 1
            elseif device.kind == "camera" then
                supportedCameras = supportedCameras + 1
            elseif device.kind == "relay" then
                supportedRelays = supportedRelays + 1
            elseif device.kind == "doorbell" then
                supportedDoorbells = supportedDoorbells + 1
            elseif device.kind == "refrigerator" then
                supportedRefrigerators = supportedRefrigerators + 1
            end
        end
    end

    return {
        locations = count(Registry.locations),
        rooms = count(Registry.rooms),
        devices = count(Registry.devices),
        protocols = count(Registry.protocols),
        recognized = recognized,
        unsupported = unsupported,
        supported = supported,
        supported_lights = supportedLights,
        supported_climate = supportedClimate,
        supported_fans = supportedFans,
        supported_blinds = supportedBlinds,
        supported_cameras = supportedCameras,
        supported_relays = supportedRelays,
        supported_doorbells = supportedDoorbells,
        supported_refrigerators = supportedRefrigerators,
        alarm_partitions = alarmPartitions,
    }
end

-- What a project refresh changed, against the devices and rooms read before (id -> record):
-- devices moved to another room, renamed, added and removed, and rooms added, removed and renamed.
function Registry.changes(previousDevices, previousRooms)
    local changes = { moved = 0, renamed = 0, added = 0, removed = 0, rooms_added = 0, rooms_removed = 0, rooms_renamed = 0 }
    local function compare(before, now, added, removed, renamed, moved)
        for id, record in pairs(now) do
            local old = before[id]
            if not old then
                changes[added] = changes[added] + 1
            else
                if old.name ~= record.name then
                    changes[renamed] = changes[renamed] + 1
                end
                if moved and old.room_id ~= record.room_id then
                    changes[moved] = changes[moved] + 1
                end
            end
        end
        for id in pairs(before) do
            if not now[id] then
                changes[removed] = changes[removed] + 1
            end
        end
    end
    compare(previousDevices or {}, Registry.devices or {}, "added", "removed", "renamed", "moved")
    compare(previousRooms or {}, Registry.rooms or {}, "rooms_added", "rooms_removed", "rooms_renamed")
    return changes
end

-- The same changes one by one, by name, for the history (ADR-046): devices and rooms removed, added,
-- renamed and moved, in that order, by name within each; DirectorLink sees every device in the
-- project, also those it cannot control (a keypad's button). Each is { change, type ("device" or
-- "room"), name, room, from (the name before, or the room before) }. Returns { changes = list }, or
-- nil when nothing changed.
function Registry.changeList(previousDevices, previousRooms)
    local groups = { removed = {}, added = {}, renamed = {}, moved = {} }
    local function compare(before, now, kind)
        for id, record in pairs(now) do
            local old = before[id]
            local room = kind == "device" and record.room_name or nil
            if not old then
                table.insert(groups.added, { change = "added", type = kind, name = record.name, room = room })
            else
                if old.name ~= record.name then
                    table.insert(groups.renamed, { change = "renamed", type = kind, name = record.name, room = room, from = old.name })
                end
                if kind == "device" and old.room_id ~= record.room_id then
                    table.insert(groups.moved, { change = "moved", type = kind, name = record.name, room = room, from = old.room_name })
                end
            end
        end
        for id, old in pairs(before) do
            if not now[id] then
                table.insert(groups.removed, { change = "removed", type = kind, name = old.name, room = kind == "device" and old.room_name or nil })
            end
        end
    end
    compare(previousDevices or {}, Registry.devices or {}, "device")
    compare(previousRooms or {}, Registry.rooms or {}, "room")
    local changes = {}
    for _, change in ipairs({ "removed", "added", "renamed", "moved" }) do
        local group = groups[change]
        table.sort(group, function(a, b)
            if a.type ~= b.type then
                return a.type == "device"
            end
            return string.lower(tostring(a.name)) < string.lower(tostring(b.name))
        end)
        for _, item in ipairs(group) do
            changes[#changes + 1] = item
        end
    end
    if #changes == 0 then
        return nil
    end
    return { changes = changes }
end

function Registry.snapshot()
    return {
        metadata = Registry.metadata,
        locations = Registry.locations,
        rooms = Registry.rooms,
        devices = Registry.devices,
        protocols = Registry.protocols,
        refreshedAt = Registry.refreshedAt,
    }
end

return Registry
