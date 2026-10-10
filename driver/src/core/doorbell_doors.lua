-- The doors and gates an admin linked to a doorbell (1.11.0, ADR-078): a gate not wired through the
-- doorbell (a KNX relay, a relay module) shown at the doorbell all the same, on its ring screen and
-- Home's ring banner, with its own Open. The links found by themselves (a Relay Door, Gate or Garage
-- Door Controller on the doorbell camera's driver's relay, RelayController.doorsAtDoorbell) are not
-- kept here: they follow the project.
--
-- Kept in the driver's persistent data: { version, links = { ["<doorbell id>"] = { door ids } } },
-- by id only, and in backups (src/core/backup.lua, matched to the project as doors are: the same id
-- with the same name). A link to a door or doorbell no longer in the project waits, as a favorite
-- does: it shows nothing, and shows again if the device comes back. A link opens nothing by itself:
-- each door's Open is its own, for whoever may open that door.

local Log = require("src.core.log")
local Store = require("src.core.store")

local DoorbellDoors = {}

local STORE_KEY = "directorlink_doorbell_doors"
DoorbellDoors.STORE_VERSION = 1
-- Doors linked to one doorbell, and doorbells with links.
DoorbellDoors.MAX_DOORS = 10
DoorbellDoors.MAX_DOORBELLS = 50

-- doorbell id -> { door ids, in the order they were linked }. `complete` is false when the store
-- could not be read at start: writing then would lose what it holds.
local state = { links = {}, complete = true }

local function whole(value)
    local number = tonumber(value)
    if number and number >= 1 and number == math.floor(number) then
        return number
    end
    return nil
end

local function copy(list)
    local result = {}
    for index, id in ipairs(list or {}) do
        result[index] = id
    end
    return result
end

local function count()
    local total = 0
    for _ in pairs(state.links) do
        total = total + 1
    end
    return total
end

-- The links of a stored record ({ version, links }), doorbell id -> door ids: whole ids only, each
-- door once, at most MAX_DOORS a doorbell and MAX_DOORBELLS doorbells (the lowest ids first).
function DoorbellDoors.read(data)
    local links = {}
    local stored = type(data) == "table" and type(data.links) == "table" and data.links or {}
    local doorbells = {}
    for key in pairs(stored) do
        if whole(key) then
            doorbells[#doorbells + 1] = whole(key)
        end
    end
    table.sort(doorbells)
    local kept = 0
    for _, doorbellId in ipairs(doorbells) do
        local list = stored[doorbellId] or stored[tostring(doorbellId)]
        local doors, seen = {}, {}
        for _, value in ipairs(Store.items(list)) do
            local id = whole(value)
            if id and id ~= doorbellId and not seen[id] and #doors < DoorbellDoors.MAX_DOORS then
                seen[id] = true
                doors[#doors + 1] = id
            end
        end
        if #doors > 0 and kept < DoorbellDoors.MAX_DOORBELLS then
            links[doorbellId] = doors
            kept = kept + 1
        end
    end
    return links
end

local function record(links)
    local stored = {}
    for doorbellId, doors in pairs(links) do
        stored[tostring(doorbellId)] = copy(doors)
    end
    return { version = DoorbellDoors.STORE_VERSION, links = stored }
end

local function save(links)
    return Store.write(STORE_KEY, record(links), false)
end

-- At start. Returns how many doorbells have links, and how the store came back (for the log).
function DoorbellDoors.load()
    local data, form = Store.read(STORE_KEY, false)
    state.complete = form ~= "unreadable"
    state.links = DoorbellDoors.read(data)
    if not state.complete then
        Log.warn("doorbell", "the doors linked to doorbells could not be read; they cannot be changed until the next start")
    end
    return count(), form
end

-- The doors linked to the doorbell `doorbellId` by an admin, in the order they were linked.
function DoorbellDoors.get(doorbellId)
    return copy(state.links[tonumber(doorbellId)])
end

-- Replaces the doors linked to a doorbell (an empty list removes them all). `ids` are whole door ids,
-- checked by the caller. `present(id)`: whether a doorbell is in the project now; a doorbell with
-- links that is not makes room when MAX_DOORBELLS have links. Returns true once saved, or false and
-- "UNAVAILABLE" (the store could not be read at start, or not written now) or "LIMIT_REACHED".
function DoorbellDoors.set(doorbellId, ids, present)
    doorbellId = tonumber(doorbellId)
    if not state.complete then
        return false, "UNAVAILABLE"
    end
    local links = {}
    for id, doors in pairs(state.links) do
        links[id] = doors
    end
    local doors = {}
    for index, id in ipairs(ids or {}) do
        doors[index] = id
    end
    links[doorbellId] = #doors > 0 and doors or nil
    local total = 0
    for _ in pairs(links) do
        total = total + 1
    end
    if links[doorbellId] and not state.links[doorbellId] and total > DoorbellDoors.MAX_DOORBELLS then
        for id in pairs(links) do
            if id ~= doorbellId and present and not present(id) then
                links[id] = nil
                total = total - 1
            end
        end
        if total > DoorbellDoors.MAX_DOORBELLS then
            return false, "LIMIT_REACHED"
        end
    end
    if not save(links) then
        Log.error("doorbell", "could not save the doors linked to a doorbell", { doorbell_id = doorbellId })
        return false, "UNAVAILABLE"
    end
    state.links = links
    return true
end

-- Backups (ADR-042, src/core/backup.lua): the links as stored.
function DoorbellDoors.backup()
    return record(state.links)
end

-- Replaces every link with those of `data` ({ version, links }). Returns true once saved.
function DoorbellDoors.restore(data)
    local links = DoorbellDoors.read(data)
    if not save(links) then
        return false
    end
    state.links, state.complete = links, true
    return true
end

-- False when the stored links could not be read at start: a restore would overwrite them.
function DoorbellDoors.complete()
    return state.complete
end

-- How many doors are linked, in all (for a backup's preview and the log).
function DoorbellDoors.count(data)
    local links = data and DoorbellDoors.read(data) or state.links
    local total = 0
    for _, doors in pairs(links) do
        total = total + #doors
    end
    return total
end

function DoorbellDoors.reset()
    state.links, state.complete = {}, true
end

return DoorbellDoors
