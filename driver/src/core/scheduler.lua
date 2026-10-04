-- Runs the schedules (src/core/schedules.lua, docs/SCHEDULES.md) on the controller, once a minute,
-- in the controller's local time.
-- - Time and sun schedules run at their minute on their days (up to 5 minutes late, e.g. after a
--   restart), once; an "only if" is checked then, with the latest weather.
-- - Weather schedules run when the weather turns: hotter than the threshold, wind stronger than it,
--   or rain starting; on their days, within their hours, and (by default) at most once a day. They
--   run again only after it has cooled 2° below the threshold, the wind has dropped 10 km/h below
--   it, or it has been dry for an hour.
-- - Shabbat schedules (the Jewish calendar, ADR-037) run when a holy period begins (candle
--   lighting) or ends (havdalah), plus their offset, once per period. "during_shabbat" keeps a
--   time, sun or weather schedule away from holy time ("skip") or to it ("only"). While the
--   calendar is off or has no location no moment counts as holy: Shabbat schedules and "only" do
--   not run, and "skip" runs as usual.
-- - After a restart, the first minute also runs Shabbat schedules and "only" schedules whose moment
--   passed in the last 6 hours and did not run, late (a family keeping Shabbat cannot make up for
--   them by hand); the others keep their 5 minutes. What was due while the schedules were paused,
--   or while the calendar was off or had no location, is not caught up, not even by a later
--   restart; nor is anything when what the schedules ran could not be read.
-- A scheduled scene runs like one from a member's key: doors and gates in it are skipped.
-- The installer can pause them all in Composer (the Schedules property); each run is shown in the
-- Last Automation property (src/core/installer_view.lua). Each run, and each skip with its reason,
-- also goes into the history (ADR-046, src/core/activity.lua).

local Activity = require("src.core.activity")
local Clock = require("src.core.clock")
local Json = require("src.core.json")
local Log = require("src.core.log")
local Scenes = require("src.core.scenes")
local Schedules = require("src.core.schedules")
local Sun = require("src.core.sun")
local Weather = require("src.core.weather")

local Scheduler = {}

Scheduler.GRACE_MINUTES = 5
Scheduler.CATCH_UP_SECONDS = 6 * 3600
Scheduler.HEAT_REARM = 2
Scheduler.WIND_REARM = 10
Scheduler.DRY_SECONDS = 3600
Scheduler.RAIN_EXPECTED_CHANCE = 50

-- `firstTick`: the first minute after start, which catches up (CATCH_UP_SECONDS). `stopped`: Shabbat
-- automation could not run when last looked at (Scheduler.switchesChanged). `pausedSkips`: schedule id
-- -> the run the history says was skipped while paused (once a pause, until the schedules run again).
local state = { services = nil, timer = nil, firstTick = false, stopped = false, pausedSkips = {} }

-- The history: a schedule ran (`fields.counts`, `note`), failed or was skipped (`reason`), with its
-- scene by the name it has now, and its time and days as they are now.
local function remember(schedule, fields)
    local scene = Scenes.find(schedule.scene_id)
    fields.who = { type = "schedule", schedule_id = schedule.id, trigger = schedule.trigger, days = schedule.days }
    fields.what = scene and scene.name or nil
    fields.ids = { schedule_id = schedule.id, scene_id = schedule.scene_id }
    Activity.record("schedule", "run", fields)
end

-- The Jewish calendar service (src/core/jewish_calendar.lua), or nil.
local function calendarService()
    return state.services and state.services.calendar or nil
end

-- Whether Shabbat automation can run: the schedules are not paused, and the calendar is on and has
-- a location.
local function canRun()
    local services = state.services
    if not services or (services.paused and services.paused()) then
        return false
    end
    local calendar = calendarService()
    return calendar ~= nil and calendar.status() == "ok"
end

-- After a change of a Composer switch or of the location (main.lua), and every minute: once Shabbat
-- automation can run again after it could not (the schedules resumed, the calendar turned on or
-- given a location), what was due meanwhile stays missed, also after a restart.
function Scheduler.switchesChanged(now)
    local running = canRun()
    if running and state.stopped then
        Schedules.setCatchUpAfter(now or Clock.now())
    end
    state.stopped = not running
end

-- Seconds from 1970 for a date and time read as UTC (no time zone involved).
local function asUtc(fields)
    local year, month = fields.year, fields.month
    if month <= 2 then
        year, month = year - 1, month + 12
    end
    local days = 365 * year + math.floor(year / 4) - math.floor(year / 100) + math.floor(year / 400) + math.floor((153 * (month - 3) + 2) / 5) + fields.day - 719469
    return days * 86400 + (fields.hour or 0) * 3600 + (fields.min or 0) * 60 + (fields.sec or 0)
end

-- The local date of `now`: weekday 0 (Sunday) to 6, minute of the day, and the offset from UTC.
function Scheduler.localTime(now)
    local fields = os.date("*t", now)
    return {
        year = fields.year,
        month = fields.month,
        day = fields.day,
        date = string.format("%04d-%02d-%02d", fields.year, fields.month, fields.day),
        weekday = fields.wday - 1,
        minute = fields.hour * 60 + fields.min,
        offset = math.floor((asUtc(fields) - now) / 60 + 0.5),
    }
end

-- The moment of `minute` on the local date of `info`.
local function epochAt(info, minute)
    return os.time({ year = info.year, month = info.month, day = info.day, hour = math.floor(minute / 60), min = minute % 60, sec = 0 })
end

local function hasDay(schedule, weekday)
    for _, day in ipairs(schedule.days) do
        if day == weekday then
            return true
        end
    end
    return false
end

-- Sunrise and sunset on the local date of `info` (minutes after midnight), or nil.
function Scheduler.sunTimes(info)
    local latitude, longitude = Weather.location()
    if not latitude then
        return nil
    end
    return Sun.times(info.year, info.month, info.day, latitude, longitude, info.offset)
end

-- The minute a time or sun schedule runs on the local date of `info`, or nil (no sunset that
-- day, no location, or an offset that crosses midnight).
function Scheduler.targetMinute(schedule, info)
    local trigger = schedule.trigger
    if trigger.type == "time" then
        return Schedules.minutes(trigger.at)
    end
    if trigger.type ~= "sun" then
        return nil
    end
    local sunrise, sunset = Scheduler.sunTimes(info)
    local base = trigger.event == "sunrise" and sunrise or sunset
    if not base then
        return nil
    end
    local minute = base + (trigger.offset or 0)
    if minute < 0 or minute >= 1440 then
        return nil
    end
    return minute
end

-- Whether a schedule may run at `at` as far as Shabbat and holidays go (holy time is from candle
-- lighting to havdalah), and why not: "shabbat" (skipped: holy time), "not_shabbat" (only then,
-- and it is not) or "calendar" (off, or no location: no moment counts as holy).
local function shabbatAllows(schedule, calendar, at)
    local mode = schedule.during_shabbat or "run"
    if mode == "run" then
        return true
    end
    local holy = calendar and calendar.holyAt(at)
    if holy == nil then
        return mode == "skip", "calendar"
    end
    if mode == "skip" then
        return not holy, "shabbat"
    end
    return holy, "not_shabbat"
end

-- The local date of a day number of the calendar, at noon.
local function localDate(calendar, rd)
    local year, month, day = calendar.civilDate(rd)
    return Scheduler.localTime(os.time({ year = year, month = month, day = day, hour = 12, min = 0, sec = 0 }))
end

-- A Shabbat schedule's moment in a period: its begin (candle lighting) or end (havdalah) plus the
-- offset, and the key it runs under, once per period. nil in a period that lacks a sunset
-- (`approximate`), even when this one time happens: a begin whose end never comes would leave the
-- home in Shabbat mode until the sun sets again, weeks later.
local function shabbatMoment(schedule, calendar, period)
    local trigger = schedule.trigger
    local base = trigger.event == "candle_lighting" and period.starts_at or period.ends_at
    if not base or period.approximate then
        return nil
    end
    return base + (trigger.offset or 0) * 60, "shabbat:" .. calendar.dateKey(period.first) .. ":" .. trigger.event
end

-- When a schedule runs next (seconds from 1970), or nil: a time or sun schedule by its minute (not
-- in holy time with "skip", only then with "only"), a Shabbat schedule by the holy periods.
function Scheduler.nextRun(schedule, now)
    if schedule.enabled == false or schedule.trigger.type == "weather" then
        return nil
    end
    local calendar = calendarService()
    local mode = schedule.during_shabbat or "run"
    if schedule.trigger.type == "shabbat" or mode == "only" then
        if not calendar or calendar.status() ~= "ok" then
            return nil
        end
        local lastFired = Schedules.runtime(schedule.id).last_fired
        for _, period in ipairs(calendar.periodsBetween(now - 86400, now + 400 * 86400)) do
            if schedule.trigger.type == "shabbat" then
                local at, key = shabbatMoment(schedule, calendar, period)
                if at and at > now and key ~= lastFired and hasDay(schedule, os.date("*t", at).wday - 1) then
                    return at
                end
            else
                -- Each civil day of the period, the evening before it, and the night after it (far
                -- north in summer, havdalah may come after midnight), at the schedule's minute.
                for rd = period.first - 1, period.last + 1 do
                    local info = localDate(calendar, rd)
                    if hasDay(schedule, info.weekday) then
                        local minute = Scheduler.targetMinute(schedule, info)
                        local at = minute and epochAt(info, minute)
                        if at and at > now and calendar.holyAt(at) then
                            return at
                        end
                    end
                end
            end
        end
        return nil
    end
    local today = Scheduler.localTime(now)
    -- Three weeks for one that skips holy time: a weekly one may fall on holidays two weeks running.
    for add = 0, mode == "skip" and 20 or 7 do
        -- By calendar date, at noon, so a daylight saving change never skips or repeats a day.
        local info = Scheduler.localTime(os.time({ year = today.year, month = today.month, day = today.day + add, hour = 12, min = 0, sec = 0 }))
        if hasDay(schedule, info.weekday) then
            local minute = Scheduler.targetMinute(schedule, info)
            local at = minute and epochAt(info, minute)
            if at and at > now and shabbatAllows(schedule, calendar, at) then
                return at
            end
        end
    end
    return nil
end

-- True or false for a time or sun schedule's "only if" with this weather, or nil when it needs
-- weather and there is none.
function Scheduler.conditionsMet(schedule, weather)
    local onlyIf = schedule.only_if or {}
    if next(onlyIf) == nil then
        return true
    end
    if not weather then
        return nil
    end
    if onlyIf.not_raining and weather.raining then
        return false
    end
    if onlyIf.hotter_than and not (weather.temperature > onlyIf.hotter_than) then
        return false
    end
    if onlyIf.wind_below and not (weather.wind_speed and weather.wind_speed < onlyIf.wind_below) then
        return false
    end
    if onlyIf.rain_expected and not ((weather.today.rain_chance or 0) >= Scheduler.RAIN_EXPECTED_CHANCE) then
        return false
    end
    return true
end

local function inHours(trigger, minute)
    if not trigger.from then
        return true
    end
    local from, to = Schedules.minutes(trigger.from), Schedules.minutes(trigger.to)
    if from < to then
        return minute >= from and minute < to
    end
    -- Across midnight, e.g. 22:00 to 06:00.
    return minute >= from or minute < to
end

local function run(schedule, now, note, weather)
    local runtime = Schedules.runtime(schedule.id)
    local ok, result, failure = pcall(state.services.runScene, schedule.scene_id, { id = "schedule:" .. schedule.id, role = "member" })
    if not ok then
        result, failure = nil, "FAILED: " .. tostring(result)
    end
    local lastRun = { at = Clock.iso(now), note = note }
    if result then
        lastRun.ran, lastRun.skipped, lastRun.failed = result.ran, result.skipped, result.failed
    else
        lastRun.error = failure or "FAILED"
    end
    runtime.last_run = lastRun
    remember(schedule, {
        outcome = lastRun.error and "failed" or nil,
        reason = lastRun.error and (lastRun.error == "SCENE_NOT_FOUND" and "scene_gone" or "error") or nil,
        note = note,
        counts = result,
    })
    if state.services.onRun then
        pcall(state.services.onRun, { at = now, scene_id = schedule.scene_id, schedule = schedule, weather = weather, note = note, result = result, error = lastRun.error })
    end
    Log.info("schedules", "schedule ran", {
        schedule = schedule.id,
        scene = schedule.scene_id,
        note = note or Json.null,
        ran = lastRun.ran or 0,
        skipped = lastRun.skipped or 0,
        failed = lastRun.failed or 0,
        error = lastRun.error or Json.null,
    })
    -- A device refused, or the scene could not run: the home's admins are alerted (ADR-047), with
    -- the scene's name sealed to them (ADR-050).
    if state.services.onFailed and (lastRun.error or (lastRun.failed or 0) > 0) then
        local scene = Scenes.find(schedule.scene_id)
        pcall(state.services.onFailed, now, { what = scene and scene.name or nil })
    end
end

-- Sets `runtime.armed` from the reading: false while the weather still is past its threshold
-- after running, true again once it has turned back.
local function rearm(trigger, runtime, weather, now)
    if trigger.kind == "heat" then
        if weather.temperature < trigger.above - Scheduler.HEAT_REARM then
            runtime.armed = true
        end
    elseif trigger.kind == "wind" then
        if weather.wind_speed and weather.wind_speed < trigger.above - Scheduler.WIND_REARM then
            runtime.armed = true
        end
    else
        if weather.raining then
            runtime.dry_since = nil
        else
            runtime.dry_since = runtime.dry_since or now
            if now - runtime.dry_since >= Scheduler.DRY_SECONDS then
                runtime.armed = true
            end
        end
    end
end

local function weatherActive(trigger, weather)
    if trigger.kind == "heat" then
        return weather.temperature >= trigger.above
    elseif trigger.kind == "wind" then
        return weather.wind_speed ~= nil and weather.wind_speed >= trigger.above
    end
    return weather.raining == true
end

-- The day before `info` (its noon), for times just before midnight and night-time hours.
local function dayBefore(info)
    return Scheduler.localTime(os.time({ year = info.year, month = info.month, day = info.day - 1, hour = 12, min = 0, sec = 0 }))
end

-- Whether a run whose moment is `at` is due at `now`, and whether it is late: at most GRACE_MINUTES
-- after it, or, in the first minute after a restart, CATCH_UP_SECONDS for a moment not before
-- `catchUp` (Schedules.catchUpAfter; nil: no catch-up now).
local function dueAt(at, now, catchUp)
    if now < at then
        return false, false
    end
    if now < at + Scheduler.GRACE_MINUTES * 60 then
        return true, false
    end
    return catchUp ~= nil and at >= catchUp and now < at + Scheduler.CATCH_UP_SECONDS, true
end

-- A time or sun schedule due at `now`: its run today, or yesterday's just before midnight (dueAt).
-- Returns the key of that run, its moment, and whether it is late (past the grace time).
local function dueRun(schedule, info, now, catchUp)
    for _, day in ipairs({ info, dayBefore(info) }) do
        if hasDay(schedule, day.weekday) then
            local minute = Scheduler.targetMinute(schedule, day)
            -- On the day clocks go forward, a time that does not exist runs when it would have.
            local at = minute and epochAt(day, minute)
            if at then
                local due, late = dueAt(at, now, catchUp)
                if due then
                    return day.date .. "@" .. minute, at, late
                end
            end
        end
    end
    return nil
end

-- A Shabbat schedule due at `now` (dueAt): when a holy period began or ended, plus the offset, on
-- one of its days (the local weekday of that moment). Returns the key of that run (the period's
-- first holy date and the event, so it runs once per period whatever changes), its moment, and
-- whether it is late.
local function dueShabbat(schedule, calendar, now, catchUp)
    if not calendar or calendar.status() ~= "ok" then
        return nil
    end
    for _, period in ipairs(calendar.periodsBetween(now - 2 * 86400, now + 86400)) do
        local at, key = shabbatMoment(schedule, calendar, period)
        if at and hasDay(schedule, os.date("*t", at).wday - 1) then
            local due, late = dueAt(at, now, catchUp)
            if due then
                return key, at, late
            end
        end
    end
    return nil
end

-- While the schedules are paused in Composer: the history says which time, sun and Shabbat schedules
-- did not run because of it, once a schedule for the pause, when its first run comes due (and not one
-- that would not have run anyway, on Shabbat). The pause itself is an entry too (a Composer setting),
-- and two weeks away with many daily schedules would otherwise push everything else out of the
-- history (ADR-046). Nothing is remembered as done: resumed within its 5 minutes, it still runs.
local function notePaused(now)
    local calendar = calendarService()
    local info = Scheduler.localTime(now)
    for _, schedule in ipairs(Schedules.records()) do
        if schedule.enabled ~= false and schedule.trigger.type ~= "weather" then
            local key, at
            if schedule.trigger.type == "shabbat" then
                key, at = dueShabbat(schedule, calendar, now, nil)
            else
                key, at = dueRun(schedule, info, now, nil)
            end
            if key and key ~= Schedules.runtime(schedule.id).last_fired and state.pausedSkips[schedule.id] == nil
                and (schedule.updated_epoch or 0) <= at and shabbatAllows(schedule, calendar, at) then
                state.pausedSkips[schedule.id] = key
                remember(schedule, { outcome = "skipped", reason = "paused" })
            end
        end
    end
end

-- One pass over the schedules for the minute of `now`. Returns how many ran. While paused in
-- Composer nothing runs and nothing is remembered as done.
function Scheduler.tick(now)
    now = now or Clock.now()
    local firstTick = state.firstTick
    state.firstTick = false
    if state.services and state.services.onTick then
        pcall(state.services.onTick, now)
    end
    Scheduler.switchesChanged(now)
    -- Only the first minute after start catches up, also when it finds the schedules paused, and
    -- only what came due after they could last run: what was due while paused, or while the
    -- calendar was off or had no location, never runs afterwards.
    local catchUp = firstTick and (Schedules.catchUpAfter() or 0) or nil
    if state.services and state.services.paused and state.services.paused() then
        notePaused(now)
        return 0
    end
    -- Running again: the next pause is listed again.
    if next(state.pausedSkips) then
        state.pausedSkips = {}
    end
    local calendar = calendarService()
    local info = Scheduler.localTime(now)
    local records = Schedules.records()
    local needsWeather = false
    for _, schedule in ipairs(records) do
        if schedule.enabled ~= false and Schedules.usesWeather(schedule) then
            needsWeather = true
        end
    end
    Weather.tick(needsWeather, now)
    local weather = Weather.current(now)
    -- A reading on its way (just after a restart): conditions wait for it, within the grace time.
    local weatherComing = not weather and Weather.pending()
    local ran, changed, due = 0, false, {}
    for _, schedule in ipairs(records) do
        local runtime = Schedules.runtime(schedule.id)
        local trigger = schedule.trigger
        if schedule.enabled == false then
            -- Nothing.
        elseif trigger.type == "weather" then
            if weather then
                local armedBefore, drySince = runtime.armed, runtime.dry_since
                if runtime.armed == nil then
                    runtime.armed = true
                end
                rearm(trigger, runtime, weather, now)
                -- Hours across midnight (22:00 to 06:00) belong to the day they started.
                local day = info
                if trigger.from and Schedules.minutes(trigger.from) > Schedules.minutes(trigger.to) and info.minute < Schedules.minutes(trigger.to) then
                    day = dayBefore(info)
                end
                local onceDone = trigger.once_a_day ~= false and runtime.fired_day == day.date
                -- Held back in holy time ("skip"), a rule stays armed: it runs after havdalah if
                -- the weather still passes.
                if runtime.armed and weatherActive(trigger, weather) and hasDay(schedule, day.weekday) and inHours(trigger, info.minute) and not onceDone and shabbatAllows(schedule, calendar, now) then
                    runtime.armed = false
                    runtime.dry_since = nil
                    runtime.fired_day = day.date
                    run(schedule, now, trigger.kind, weather)
                    ran = ran + 1
                end
                changed = changed or runtime.armed ~= armedBefore or runtime.dry_since ~= drySince
            end
        else
            local key, at, late
            if trigger.type == "shabbat" then
                key, at, late = dueShabbat(schedule, calendar, now, catchUp)
            else
                key, at, late = dueRun(schedule, info, now, schedule.during_shabbat == "only" and catchUp or nil)
            end
            local waitForWeather = key and weatherComing and next(schedule.only_if or {}) ~= nil and now < at + (Scheduler.GRACE_MINUTES - 1) * 60
            if key and runtime.last_fired ~= key and not waitForWeather then
                runtime.last_fired = key
                changed = true
                -- Changed after its time: it starts with the next one.
                if (schedule.updated_epoch or 0) <= at then
                    -- Holy time at the schedule's moment, not now: 17:59 checked at 18:01 is 17:59.
                    local allowed, why = shabbatAllows(schedule, calendar, at)
                    local met = allowed and Scheduler.conditionsMet(schedule, weather)
                    if not allowed then
                        -- "only" outside holy time, or without the calendar, is like a day not in
                        -- its days: nothing to say.
                        if why == "shabbat" then
                            runtime.last_run = { at = Clock.iso(now), skipped_by = "shabbat" }
                            Log.info("schedules", "schedule skipped: Shabbat or a holiday", { schedule = schedule.id })
                            remember(schedule, { outcome = "skipped", reason = "shabbat" })
                        elseif why == "calendar" then
                            -- Only on Shabbat, and the calendar is off or has no location: the
                            -- history says so (the schedule cannot run while it is).
                            remember(schedule, { outcome = "skipped", reason = "calendar_off" })
                        end
                    elseif met == nil then
                        if schedule.if_no_weather ~= "skip" then
                            due[#due + 1] = { schedule = schedule, at = at, note = late and "late" or "no_weather" }
                        else
                            runtime.last_run = { at = Clock.iso(now), skipped_by = "no_weather" }
                            remember(schedule, { outcome = "skipped", reason = "no_weather" })
                        end
                    elseif met then
                        due[#due + 1] = { schedule = schedule, at = at, note = late and "late" or nil }
                    else
                        runtime.last_run = { at = Clock.iso(now), skipped_by = "only_if" }
                        Log.info("schedules", "schedule skipped: its conditions were not met", { schedule = schedule.id })
                        remember(schedule, { outcome = "skipped", reason = "only_if" })
                    end
                end
            end
        end
    end
    -- In the order they were due: after a restart, what is caught up runs oldest first.
    table.sort(due, function(a, b)
        if a.at ~= b.at then
            return a.at < b.at
        end
        return a.schedule.id < b.schedule.id
    end)
    for _, item in ipairs(due) do
        if item.note == "late" then
            Log.info("schedules", "schedule caught up after a restart", { schedule = item.schedule.id, due_at = Clock.iso(item.at) })
        end
        run(item.schedule, now, item.note)
        ran = ran + 1
    end
    if ran > 0 or changed then
        Schedules.saveRuntime()
    end
    return ran
end

local function scheduleNext()
    local now = Clock.now()
    -- A second after the next minute starts.
    local delay = (60 - now % 60 + 1) * 1000
    local ok, timer = pcall(function()
        return C4:SetTimer(delay, function()
            state.timer = nil
            local ran, err = pcall(Scheduler.tick)
            if not ran then
                Log.error("schedules", "the scheduler failed", { error = tostring(err) })
            end
            scheduleNext()
        end)
    end)
    state.timer = ok and timer or nil
end

-- `services.runScene(sceneId, caller)` runs a saved scene and returns its result;
-- `services.calendar` is the Jewish calendar (src/core/jewish_calendar.lua);
-- `services.onFailed(at, { what })`, if any, is told of each run that failed (a device refused, or
-- an error), with its scene's name.
function Scheduler.start(services)
    state.services = services
    state.firstTick = true
    -- As the Composer switches are now (not the location, in case it is read a moment late): only
    -- a change from here on stops the catch-up.
    local calendar = calendarService()
    state.stopped = (services.paused ~= nil and services.paused()) or calendar == nil or calendar.status() == "off"
    Scheduler.stop()
    local now = Clock.now()
    local info = Scheduler.localTime(now)
    local ok, zone = pcall(function()
        return C4:GetTimeZone()
    end)
    Log.info("schedules", "scheduler started", {
        local_time = os.date("%Y-%m-%d %H:%M", now),
        utc_offset_minutes = info.offset,
        timezone = ok and zone or Json.null,
        schedules = #Schedules.records(),
    })
    scheduleNext()
end

function Scheduler.stop()
    if state.timer then
        pcall(function()
            state.timer:Cancel()
        end)
        state.timer = nil
    end
end

return Scheduler
