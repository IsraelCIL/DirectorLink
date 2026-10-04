-- What DirectorLink automates, for the installer in Composer (docs/SCHEDULES.md, "For installers"):
-- the Schedule Status and Last Automation properties, and the full list printed by the Composer
-- action "Print Schedules and Scenes" to the Lua output. Automation nobody can see is the hardest
-- thing to troubleshoot; these texts say what runs, when and why. English, like Composer.

local Scenes = require("src.core.scenes")
local Scheduler = require("src.core.scheduler")
local Schedules = require("src.core.schedules")

local View = {}

local DAYS = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" }

local function sameDays(days, list)
    if #days ~= #list then
        return false
    end
    for index, day in ipairs(list) do
        if days[index] ~= day then
            return false
        end
    end
    return true
end

function View.daysText(days)
    if sameDays(days, { 0, 1, 2, 3, 4, 5, 6 }) then
        return "every day"
    elseif sameDays(days, { 0, 1, 2, 3, 4 }) then
        return "Sun-Thu"
    elseif sameDays(days, { 5, 6 }) then
        return "Fri-Sat"
    end
    local names = {}
    for _, day in ipairs(days) do
        names[#names + 1] = DAYS[day + 1]
    end
    return table.concat(names, ",")
end

local function number(value)
    if value == math.floor(value) then
        return tostring(value)
    end
    return string.format("%.1f", value)
end

local SHABBAT_EVENTS = { candle_lighting = "candle lighting", havdalah = "havdalah" }

-- "Sun-Thu 06:45", "every day 30 min before sunset", "heat above 30C 12:00-20:00, once a day",
-- "30 min before candle lighting", "Sat: at havdalah".
function View.whenText(schedule)
    local trigger = schedule.trigger
    local days = View.daysText(schedule.days)
    if trigger.type == "time" then
        return days .. " " .. trigger.at
    elseif trigger.type == "sun" then
        local offset = trigger.offset or 0
        if offset == 0 then
            return days .. " at " .. trigger.event
        end
        return string.format("%s %d min %s %s", days, math.abs(offset), offset < 0 and "before" or "after", trigger.event)
    elseif trigger.type == "shabbat" then
        -- When Shabbat and holidays begin or end; the days only when not every day.
        local offset, event = trigger.offset or 0, SHABBAT_EVENTS[trigger.event] or tostring(trigger.event)
        local text = offset == 0 and ("at " .. event) or string.format("%d min %s %s", math.abs(offset), offset < 0 and "before" or "after", event)
        return days == "every day" and text or (days .. ": " .. text)
    end
    local text
    if trigger.kind == "heat" then
        text = "heat above " .. number(trigger.above) .. "C outside"
    elseif trigger.kind == "wind" then
        text = "wind above " .. number(trigger.above) .. " km/h"
    else
        text = "rain starts"
    end
    if days ~= "every day" then
        text = text .. ", " .. days
    end
    if trigger.from then
        text = text .. ", " .. trigger.from .. "-" .. trigger.to
    end
    if trigger.once_a_day ~= false then
        text = text .. ", once a day"
    end
    return text
end

local DURING_SHABBAT = { skip = "not on Shabbat and holidays", only = "only on Shabbat and holidays" }

-- "only if not raining and hotter than 28C", "not on Shabbat and holidays", or nil.
function View.conditionsText(schedule)
    local onlyIf = schedule.only_if or {}
    local parts = {}
    if onlyIf.not_raining then
        parts[#parts + 1] = "not raining"
    end
    if onlyIf.hotter_than then
        parts[#parts + 1] = "hotter than " .. number(onlyIf.hotter_than) .. "C"
    end
    if onlyIf.wind_below then
        parts[#parts + 1] = "wind below " .. number(onlyIf.wind_below) .. " km/h"
    end
    if onlyIf.rain_expected then
        parts[#parts + 1] = "rain expected today"
    end
    local texts = {}
    if #parts > 0 then
        texts[1] = "only if " .. table.concat(parts, " and ") .. (schedule.if_no_weather == "skip" and " (skipped without weather data)" or "")
    end
    texts[#texts + 1] = DURING_SHABBAT[schedule.during_shabbat or "run"]
    if #texts == 0 then
        return nil
    end
    return table.concat(texts, ", ")
end

-- Shabbat automation (ADR-037): Shabbat schedules, and those that run only on Shabbat and holidays.
-- They do not run while the Jewish calendar is off or has no location.
local function shabbatAutomation(schedule)
    return schedule.trigger.type == "shabbat" or schedule.during_shabbat == "only"
end

local function sceneName(sceneId)
    local scene = Scenes.find(sceneId)
    return scene and scene.name or ("a deleted scene " .. sceneId)
end

-- "today 06:45", "tomorrow 06:45", "Tue 29 Sep 06:45".
local function when(at, now)
    local day, today = os.date("*t", at), os.date("*t", now)
    local tomorrow = os.date("*t", os.time({ year = today.year, month = today.month, day = today.day + 1, hour = 12 }))
    local clock = os.date("%H:%M", at)
    if day.year == today.year and day.yday == today.yday then
        return "today " .. clock
    elseif day.year == tomorrow.year and day.yday == tomorrow.yday then
        return "tomorrow " .. clock
    end
    return os.date("%a %d %b ", at) .. clock
end

local CALENDAR_MISSING = { off = "Jewish Calendar is Off", no_location = "no location" }

-- The Schedule Status property: "3 on · next tomorrow 06:45 Good morning · 1 weather rule ·
-- 2 Shabbat schedules". `calendar`: the Jewish calendar (src/core/jewish_calendar.lua), or nil.
function View.scheduleStatus(now, paused, calendar)
    local total, on, weather, shabbat = 0, 0, 0, 0
    local nextAt, nextScene
    for _, schedule in ipairs(Schedules.records()) do
        total = total + 1
        if schedule.enabled ~= false then
            on = on + 1
            if schedule.trigger.type == "weather" then
                weather = weather + 1
            end
            if shabbatAutomation(schedule) then
                shabbat = shabbat + 1
            end
            local at = Scheduler.nextRun(schedule, now)
            if at and (not nextAt or at < nextAt) then
                nextAt, nextScene = at, schedule.scene_id
            end
        end
    end
    if total == 0 then
        return "None"
    end
    if paused then
        return string.format("Paused in Composer - %d schedule%s not running", total, total == 1 and " is" or "s are")
    end
    if on == 0 then
        return string.format("All %d off", total)
    end
    local parts = { on == total and (on .. " on") or (on .. " of " .. total .. " on") }
    if nextAt then
        parts[#parts + 1] = "next " .. when(nextAt, now) .. " " .. sceneName(nextScene)
    end
    if weather > 0 then
        parts[#parts + 1] = weather .. " weather rule" .. (weather == 1 and "" or "s")
    end
    if shabbat > 0 then
        local missing = CALENDAR_MISSING[calendar and calendar.status() or "off"]
        parts[#parts + 1] = shabbat .. " Shabbat schedule" .. (shabbat == 1 and "" or "s") .. (missing and (" not running (" .. missing .. ")") or "")
    end
    return table.concat(parts, " · ")
end

-- The Last Automation property: what DirectorLink ran, when, why and with what result.
-- `event`: { at, scene_id, schedule (or nil), key_name (or nil), weather (or nil), note (or nil:
-- "late" when it ran late after a restart), result, error }.
function View.lastAutomation(event)
    local why
    if event.schedule then
        local trigger = event.schedule.trigger
        if trigger.type == "weather" and event.weather then
            if trigger.kind == "heat" then
                why = "heat rule, " .. number(event.weather.temperature) .. "C outside"
            elseif trigger.kind == "wind" then
                why = "wind rule, " .. number(event.weather.wind_speed or 0) .. " km/h"
            else
                why = "rain rule, rain started"
            end
        else
            why = "schedule " .. View.whenText(event.schedule) .. (event.note == "late" and ", late after a restart" or "")
        end
    else
        why = "run from " .. tostring(event.key_name or "the app")
    end
    local result
    if event.error then
        result = "failed: " .. tostring(event.error)
    else
        local r = event.result or {}
        result = string.format("%d device%s", r.ran or 0, (r.ran or 0) == 1 and "" or "s")
        if (r.skipped or 0) > 0 then
            result = result .. string.format(", %d skipped", r.skipped)
        end
        if (r.failed or 0) > 0 then
            result = result .. string.format(", %d failed", r.failed)
        end
    end
    return string.format("%s %s · %s · %s", os.date("%d %b %H:%M", event.at), sceneName(event.scene_id), why, result)
end

local function stepText(step, registry)
    local target
    if step.device_ids then
        local names = {}
        for _, id in ipairs(step.device_ids) do
            local device = registry.getDevice(id)
            names[#names + 1] = (device and device.name or "missing") .. " (" .. id .. ")"
        end
        target = table.concat(names, ", ")
    else
        local room = step.room_id and (registry.rooms or {})[step.room_id]
        target = (step.type == "music" and "the Sonos music" or ("all " .. step.type)) .. " in "
            .. (step.room_id and ((room and room.name or "a removed room") .. " (" .. step.room_id .. ")") or "the whole home")
    end
    local set, action = step.set, nil
    if step.type == "lights" then
        action = (set.on == false or set.brightness == 0) and "off" or set.brightness and (set.brightness .. "%") or "on"
    elseif step.type == "climate" then
        local parts = {}
        if set.mode then
            parts[#parts + 1] = set.mode
        end
        if set.target_temperature then
            parts[#parts + 1] = number(set.target_temperature) .. "C"
        end
        if set.heat_setpoint then
            parts[#parts + 1] = "heat " .. number(set.heat_setpoint) .. "C"
        end
        if set.cool_setpoint then
            parts[#parts + 1] = "cool " .. number(set.cool_setpoint) .. "C"
        end
        if set.fan_speed then
            parts[#parts + 1] = "fan " .. set.fan_speed
        end
        action = table.concat(parts, " ")
    elseif step.type == "fans" then
        action = set.on == false and "off" or set.speed and ("speed " .. set.speed .. " of " .. Scenes.MAX_FAN_SPEED) or "on"
    elseif step.type == "blinds" then
        action = set.position .. "% open"
    elseif step.type == "music" then
        action = set.action
    elseif step.type == "refrigerators" then
        local parts = {}
        for _, feature in ipairs({ "power_cool", "power_freeze", "sabbath_mode", "ice_maker" }) do
            if set[feature] ~= nil then
                parts[#parts + 1] = feature:gsub("_", " ") .. (set[feature] and " on" or " off")
            end
        end
        action = table.concat(parts, ", ")
    else
        action = "pulse (skipped when a schedule runs it)"
    end
    return target .. " -> " .. action
end

-- Every schedule and scene, for the Lua output. `calendar`: the Jewish calendar, or nil.
function View.printout(now, paused, registry, calendar)
    local lines = {}
    local schedules = Schedules.records()
    lines[#lines + 1] = string.format("DirectorLink schedules: %d%s (controller time %s)", #schedules, paused and ", PAUSED in Composer (Schedules property)" or "", os.date("%Y-%m-%d %H:%M", now))
    lines[#lines + 1] = "Jewish calendar: " .. (calendar and calendar.statusText(now) or "Off")
    for _, schedule in ipairs(schedules) do
        local runtime = Schedules.runtime(schedule.id)
        local parts = { string.format("  [%s] %s -> %s", schedule.enabled == false and "off" or "on", View.whenText(schedule), sceneName(schedule.scene_id)) }
        local conditions = View.conditionsText(schedule)
        if conditions then
            parts[#parts + 1] = conditions
        end
        local nextAt = Scheduler.nextRun(schedule, now)
        if nextAt then
            parts[#parts + 1] = "next " .. when(nextAt, now)
        end
        local last = runtime.last_run
        if type(last) == "table" and last.at then
            local outcome = last.skipped_by and ("not run: " .. last.skipped_by) or last.error and ("failed: " .. last.error) or string.format("%d ran, %d skipped, %d failed", last.ran or 0, last.skipped or 0, last.failed or 0)
            if last.note == "late" then
                outcome = outcome .. ", late after a restart"
            end
            parts[#parts + 1] = "last " .. last.at .. " UTC (" .. outcome .. ")"
        end
        parts[#parts + 1] = "id " .. schedule.id
        lines[#lines + 1] = table.concat(parts, " · ")
    end
    local scenes = Scenes.list()
    lines[#lines + 1] = string.format("DirectorLink scenes: %d", #scenes)
    for _, scene in ipairs(scenes) do
        lines[#lines + 1] = string.format("  %s (id %s%s):", scene.name, scene.id, scene.show_on_home and ", on Home" or "")
        for index, step in ipairs(scene.steps) do
            lines[#lines + 1] = string.format("    %d. %s", index, stepText(step, registry))
        end
    end
    lines[#lines + 1] = "Scenes and schedules are made in the DirectorLink app, not in Composer programming."
    return lines
end

return View
