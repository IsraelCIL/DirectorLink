-- Runs the driver test suites under plain Lua 5.1. From the repository root:
--   lua5.1 driver/tests/run.lua                             (every suite)
--   lua5.1 driver/tests/run.lua test_sun test_holy_times    (only these, in this order)
--   lua5.1 driver/tests/run.lua --shard 2/3                 (the second of three parts, as CI runs them)
--   lua5.1 driver/tests/run.lua --shard 2/3 --list          (which suites that part runs)

package.path = "./driver/?.lua;./driver/tests/?.lua;" .. package.path

-- A test that cannot run here (T.skip in helpers.lua, e.g. one for another time zone) is counted
-- and named, not failed.
local T = require("helpers")
local skipped = 0

local suites = {
    "test_json",
    "test_http",
    "test_router",
    "test_api",
    "test_discovery",
    "test_shades",
    "test_relay",
    "test_resend",
    "test_lock",
    "test_remote",
    "test_profiles",
    "test_scenes",
    "test_scene_links",
    "test_ask_links",
    "test_schedules",
    "test_calendar",
    "test_hebrew_date",
    "test_holidays",
    "test_parasha",
    "test_sun",
    "test_holy_times",
    "test_x25519",
    "test_cpace",
    "test_cpace_pairing",
    "test_key_expiry",
    "test_access",
    "test_people",
    "test_users",
    "test_owner",
    "test_security",
    "test_light_v1",
    "test_light_v2",
    "test_thermostat_v2_heat",
    "test_thermostat_proxy",
    "test_dual_thermostat",
    "test_fahrenheit",
    "test_last_modes",
    "test_fans",
    "test_refrigerators",
    "test_driver_updates",
    "test_alarm",
    "test_backup",
    "test_auto_backup",
    "test_sonos",
    "test_sonos_groups",
    "test_activity",
    "test_alerts",
    "test_cameras",
    "test_camera_drivers",
    "test_door_controllers",
    "test_doorbell_doors",
    "test_https",
}

-- About how many seconds each suite takes (all of them in one run on a PC, 2026-10-03; CI takes
-- about 1.7 times as long),
-- for --shard to split them into parts of about equal time. A suite not listed counts as
-- DEFAULT_SECONDS: add it here once measured (lua5.1 driver/tests/run.lua <suite>).
local SECONDS = {
    test_json = 1,
    test_access = 1,
    test_people = 16,
    test_users = 20,
    test_owner = 10,
    test_http = 1,
    test_router = 1,
    test_api = 16,
    test_discovery = 5,
    test_shades = 25,
    test_relay = 9,
    test_resend = 30,
    test_activity = 7,
    test_auto_backup = 7,
    test_alerts = 7,
    test_cameras = 4,
    test_camera_drivers = 5,
    test_door_controllers = 13,
    test_doorbell_doors = 5,
    test_https = 8,
    test_lock = 1,
    test_remote = 18,
    test_profiles = 3,
    test_scenes = 8,
    test_scene_links = 16,
    test_ask_links = 15,
    test_schedules = 8,
    test_calendar = 16,
    test_hebrew_date = 1,
    test_holidays = 1,
    test_parasha = 1,
    test_sun = 1,
    test_holy_times = 1,
    test_x25519 = 1,
    test_cpace = 1,
    test_cpace_pairing = 12,
    test_key_expiry = 5,
    test_security = 7,
    test_light_v1 = 1,
    test_light_v2 = 3,
    test_thermostat_v2_heat = 6,
    test_thermostat_proxy = 1,
    test_dual_thermostat = 6,
    test_fahrenheit = 5,
    test_last_modes = 3,
    test_fans = 6,
    test_refrigerators = 9,
    test_driver_updates = 3,
    test_alarm = 41,
    test_backup = 93,
    test_sonos = 14,
    test_sonos_groups = 8,
}
local DEFAULT_SECONDS = 5

-- The suites of part `index` of `count`: longest first, each goes to the part with the least time
-- so far (the first of equals), so every suite is in exactly one part. Each part keeps the order.
local function shard(list, index, count)
    local order = {}
    for position, suiteName in ipairs(list) do
        order[#order + 1] = { name = suiteName, position = position, seconds = SECONDS[suiteName] or DEFAULT_SECONDS }
    end
    table.sort(order, function(a, b)
        if a.seconds ~= b.seconds then
            return a.seconds > b.seconds
        end
        return a.position < b.position
    end)
    local totals, mine = {}, {}
    for part = 1, count do
        totals[part] = 0
    end
    for _, suite in ipairs(order) do
        local least = 1
        for part = 2, count do
            if totals[part] < totals[least] then
                least = part
            end
        end
        totals[least] = totals[least] + suite.seconds
        if least == index then
            mine[suite.name] = true
        end
    end
    local result = {}
    for _, suiteName in ipairs(list) do
        if mine[suiteName] then
            result[#result + 1] = suiteName
        end
    end
    return result
end

local named, shardIndex, shardCount, listOnly = {}, nil, nil, false
local position = 1
while position <= #arg do
    local value = arg[position]
    if value == "--shard" then
        local index, count = tostring(arg[position + 1]):match("^(%d+)/(%d+)$")
        shardIndex, shardCount = tonumber(index), tonumber(count)
        if not shardIndex or shardIndex < 1 or shardIndex > shardCount then
            print("--shard takes K/N: the K-th of N parts, such as 1/3")
            os.exit(1)
        end
        position = position + 2
    elseif value == "--list" then
        listOnly = true
        position = position + 1
    else
        named[#named + 1] = value
        position = position + 1
    end
end

if #named > 0 then
    local known = {}
    for _, suiteName in ipairs(suites) do
        known[suiteName] = true
    end
    for _, suiteName in ipairs(named) do
        if not known[suiteName] then
            print("unknown suite " .. suiteName .. " (driver/tests/run.lua lists them)")
            os.exit(1)
        end
    end
    suites = named
end

if shardIndex then
    suites = shard(suites, shardIndex, shardCount)
    if not listOnly then
        print(string.format("part %d/%d: %s", shardIndex, shardCount, table.concat(suites, " ")))
    end
end

if listOnly then
    for _, suiteName in ipairs(suites) do
        print(suiteName)
    end
    os.exit(0)
end

local passed, failed = 0, 0

for _, suiteName in ipairs(suites) do
    local suite = require(suiteName)
    local names = {}
    for name in pairs(suite) do
        names[#names + 1] = name
    end
    table.sort(names)

    for _, name in ipairs(names) do
        local ok, err = pcall(suite[name])
        if ok then
            passed = passed + 1
        elseif T.skipped(err) then
            skipped = skipped + 1
            print("SKIP " .. suiteName .. " :: " .. name .. " (" .. T.skipped(err) .. ")")
        else
            failed = failed + 1
            print("FAIL " .. suiteName .. " :: " .. name .. "\n     " .. tostring(err))
        end
    end
end

print(string.format("%d passed, %d failed", passed, failed) .. (skipped > 0 and string.format(", %d skipped", skipped) or ""))
os.exit(failed == 0 and 0 or 1)
