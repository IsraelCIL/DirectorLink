local Classifier = require("src.adapters.classifier")

local Normalize = {}

local LOCATION_TYPES = {
    [2] = "site",
    [3] = "building",
    [4] = "floor",
    [8] = "room",
}

local function toId(value)
    local id = tonumber(value)
    if id and id > 0 then
        return id
    end
    return nil
end

local function sortedIds(values)
    local result = {}
    for id, _ in pairs(values or {}) do
        local numeric = toId(id)
        if numeric then
            table.insert(result, numeric)
        end
    end
    table.sort(result)
    return result
end

local function locationKind(rawType)
    local numericType = tonumber(rawType)
    if numericType then
        return LOCATION_TYPES[numericType] or ("type_" .. tostring(numericType))
    end

    local value = string.lower(tostring(rawType or ""))
    if value == "site" or value == "building" or value == "floor" or value == "room" then
        return value
    end

    return value ~= "" and value or "unknown"
end

local function collectLocations(node, nodeId, parentId, result, visited)
    if type(node) ~= "table" then
        return
    end

    if visited[node] then
        return
    end
    visited[node] = true

    local id = toId(node.id or node.ID or node.locationId or node.locationID or nodeId)
    local name = node.name or node.Name or node.locationName or node.location_name
    local rawType = node.type or node.Type or node.locationType or node.location_type

    if id and name then
        result[id] = {
            id = id,
            name = tostring(name),
            type = locationKind(rawType),
            raw_type = rawType,
            parent_id = toId(parentId),
        }
        parentId = id
    end

    for key, child in pairs(node) do
        if type(child) == "table" and key ~= "parent" and key ~= "Parent" then
            collectLocations(child, key, parentId, result, visited)
        end
    end
end

function Normalize.locations(hierarchy, rawDevices)
    local locations = {}
    collectLocations(hierarchy, nil, nil, locations, {})

    -- GetDevices also carries room ID/name. This is a fallback for projects
    -- whose hierarchy representation differs between Director releases.
    for _, device in pairs(rawDevices or {}) do
        if type(device) == "table" then
            local roomId = toId(device.roomId or device.roomID)
            if roomId and not locations[roomId] then
                locations[roomId] = {
                    id = roomId,
                    name = tostring(device.roomName or ("Room " .. tostring(roomId))),
                    type = "room",
                    raw_type = nil,
                    parent_id = nil,
                }
            end
        end
    end

    return locations
end

local function normalizeLinkTable(raw)
    local result = {}
    for _, id in ipairs(sortedIds(raw)) do
        local item = raw[id] or raw[tostring(id)]
        if type(item) == "table" then
            table.insert(result, {
                id = id,
                driver = item.driverFileName,
                name = item.deviceName,
            })
        end
    end
    return result
end

-- The Samsung Refrigerator (DirectorLink) driver has five uibutton proxies: its status tile (the
-- primary, listed first in its driver.xml, so Director gives it the lowest id) and one per feature.
-- The refrigerator is that first proxy, in its room; the others are no devices of their own.
-- Returns protocol id -> the id of its refrigerator.
local function refrigeratorProxies(rawDevices)
    local first = {}
    for rawId, raw in pairs(rawDevices or {}) do
        local id = toId(rawId)
        if id and type(raw) == "table" and type(raw.protocol) == "table" then
            for protocolId, link in pairs(raw.protocol) do
                protocolId = toId(protocolId)
                if protocolId and type(link) == "table" and Classifier.isRefrigeratorDriver(link.driverFileName) then
                    if not first[protocolId] or id < first[protocolId] then
                        first[protocolId] = id
                    end
                end
            end
        end
    end
    return first
end

-- The refrigerator a proxy belongs to: true when it is the refrigerator, false when it is one of its
-- other proxies, nil when it is not a refrigerator's.
local function refrigeratorPart(raw, id, refrigerators)
    if type(raw.protocol) ~= "table" then
        return nil
    end
    for protocolId in pairs(raw.protocol) do
        local first = refrigerators[toId(protocolId)]
        if first then
            return first == id
        end
    end
    return nil
end

function Normalize.devices(rawDevices, bridgeDeviceId)
    local entities = {}
    local protocols = {}
    bridgeDeviceId = toId(bridgeDeviceId)
    local refrigerators = refrigeratorProxies(rawDevices)

    -- First collect backing protocol devices. They are retained internally
    -- but are not duplicated in the homeowner-facing entity list.
    for rawId, raw in pairs(rawDevices or {}) do
        local id = toId(rawId)
        if id and id ~= bridgeDeviceId and type(raw) == "table" and type(raw.proxies) == "table" and next(raw.proxies) ~= nil then
            protocols[id] = {
                id = id,
                name = raw.deviceName,
                driver = raw.driverFileName,
                room_id = toId(raw.roomId or raw.roomID),
                room_name = raw.roomName,
                proxies = normalizeLinkTable(raw.proxies),
            }
        end
    end

    for rawId, raw in pairs(rawDevices or {}) do
        local id = toId(rawId)
        -- DirectorLink's own proxies are not homeowner devices.
        local ownProxy = bridgeDeviceId ~= nil and type(raw) == "table" and type(raw.protocol) == "table"
            and (raw.protocol[bridgeDeviceId] ~= nil or raw.protocol[tostring(bridgeDeviceId)] ~= nil)
        if id and id ~= bridgeDeviceId and not ownProxy and type(raw) == "table" then
            local hasProtocol = type(raw.protocol) == "table" and next(raw.protocol) ~= nil
            local isBackingProtocol = type(raw.proxies) == "table" and next(raw.proxies) ~= nil

            local refrigerator = refrigeratorPart(raw, id, refrigerators)
            if (hasProtocol or not isBackingProtocol) and refrigerator ~= false then
                local classification = refrigerator and { kind = "refrigerator", recognized = true } or Classifier.classify(raw.driverFileName)
                local protocolLinks = hasProtocol and normalizeLinkTable(raw.protocol) or {}

                entities[id] = {
                    id = id,
                    name = tostring(raw.deviceName or ("Device " .. tostring(id))),
                    room_id = toId(raw.roomId or raw.roomID),
                    room_name = raw.roomName,
                    kind = classification.kind,
                    recognized = classification.recognized,

                    -- Normalization never guesses control support. Adapters enable
                    -- support only after their required state contract is verified.
                    supported = false,

                    proxy = {
                        id = id,
                        driver = raw.driverFileName,
                    },
                    protocols = protocolLinks,
                }
            end
        end
    end

    return entities, protocols
end

function Normalize.project(raw)
    local rawDevices = raw.devices or {}
    local locations = Normalize.locations(raw.hierarchy or {}, rawDevices)
    local devices, protocols = Normalize.devices(rawDevices, (raw.metadata or {}).bridgeDeviceId)

    local rooms = {}
    for id, location in pairs(locations) do
        if location.type == "room" then
            rooms[id] = location
        end
    end

    return {
        metadata = raw.metadata or {},
        locations = locations,
        rooms = rooms,
        devices = devices,
        protocols = protocols,
    }
end

return Normalize
