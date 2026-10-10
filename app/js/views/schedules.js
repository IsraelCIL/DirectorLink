// Schedules (#/schedules) and the schedule editor (#/schedule/new, #/schedule/<id>; admins), under
// the Scenes tab. A schedule runs a scene: at a time, at sunrise or sunset, when the weather turns
// (heat, wind, rain), or when Shabbat and holidays begin or end (with the Jewish calendar on in
// Composer), on chosen days; time, sun and Shabbat schedules may add "only if" weather conditions,
// and time, sun and weather schedules what to do on Shabbat and holidays. The controller runs them;
// the weather comes from Open-Meteo through it.

import { calendarOn, holyTimes, loadCalendar, noteCalendarOff, onOneLine, showCalendarSettings, upcomingTimes } from "../calendar.js";
import { emptyState, skeletonCards } from "../components.js";
import { h, iconButton, name } from "../dom.js";
import { formatClock, formatTemperature, t } from "../i18n.js";
import { icon } from "../icons.js";
import {
  ALL_DAYS,
  WEEKEND,
  WORK_DAYS,
  conditionText,
  dayAndTime,
  dayName,
  daysText,
  findSchedule,
  formatOffset,
  homeZone,
  loadSchedules,
  loadWeather,
  membersHaveNoSchedules,
  outside,
  outsideScale,
  sceneNameOf,
  scheduleIcon,
  schedulesWanted,
  statusText,
  weatherNow,
  whenText,
} from "../schedules.js";
import { loadScenes } from "../scenes.js";
import { api, errorText, noteForbidden, roleLabel } from "../session.js";
import { can, notify, state, ui } from "../state.js";
import { cooledTo, fromCelsius, thresholdToCelsius } from "../temperature.js";
import { isLoading, notReadyState, offlineBanner, pageHeader, staleBanner } from "./common.js";

const MAX_SCHEDULES = 50;
const MESSAGE_MS = 6000;
const WEATHER_MS = 5 * 60 * 1000;
const OFFSETS = [-60, -30, 0, 30, 60];
// Minutes before (negative) or after candle lighting and havdalah; the API takes -360 to 360.
const SHABBAT_OFFSETS = [-120, -60, -30, -15, 0, 15, 30, 60, 120];
const LIMITS = { heat: [15, 45, 1], wind: [10, 150, 5] };

// The thresholds the editor offers: 15-45 °C, or 59-113 °F in a °F home (1.10.2, ADR-076).
function limitsOf(kind) {
  return kind === "heat" && outsideScale() === "F" ? [59, 113, 1] : LIMITS[kind];
}
let weatherTimer = null;

function notice(message) {
  return message ? h("p", { class: `notice notice-${message.kind}`, role: message.kind === "error" ? "alert" : "status" }, message.text) : null;
}

function flash(text, kind = "success") {
  const stamp = Date.now();
  ui.schedulesMessage = { kind, text, stamp };
  window.setTimeout(() => {
    if (ui.schedulesMessage?.stamp === stamp) {
      ui.schedulesMessage = null;
      notify();
    }
  }, MESSAGE_MS);
}

// `from`: the screen the editor was opened from; back through the history only when that is where
// `hash` leads, else the editor is replaced by `hash`.
function leave(hash, from) {
  if (window.history.state?.directorlinkInApp && from === hash.replace(/^#\//, "").split("/")[0]) window.history.back();
  else window.location.replace(hash);
}

// Entering Schedules or the editor: the scenes to pick from, the weather now and the Shabbat times,
// and the weather every 5 minutes while it is open.
export function enterSchedules() {
  // Members never see schedules (1.8.0, ADR-054): nothing to load. Before this key's permissions
  // are known nothing is loaded either: once connected, app.js enters again (keepWeatherFresh).
  if (!schedulesWanted()) return;
  loadScenes();
  loadSchedules();
  loadWeather();
  loadCalendar();
  window.clearInterval(weatherTimer);
  weatherTimer = window.setInterval(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#/schedule")) {
      window.clearInterval(weatherTimer);
      weatherTimer = null;
    } else if (!document.hidden) {
      loadWeather();
    }
  }, WEATHER_MS);
}

// After connecting on Schedules: the same, unless it runs already.
export function keepWeatherFresh() {
  if (!weatherTimer) enterSchedules();
}

// Scenes | Schedules, at the top of both lists (Scenes alone for a member of a 1.8.0 home).
export function scenesNav(current) {
  if (membersHaveNoSchedules()) return null;
  return h(
    "nav",
    { class: "segments sub-nav", "aria-label": t("scenes.title"), style: { "grid-template-columns": "repeat(2, minmax(0, 1fr))" } },
    [
      ["scenes", "#/scenes", "scene"],
      ["schedules", "#/schedules", "clock"],
    ].map(([id, href, iconName]) =>
      h(
        "a",
        { class: `segment ${current === id ? "is-active" : ""}`, href, "aria-current": current === id ? "page" : null, dataset: { key: `sub-nav:${id}` } },
        icon(iconName),
        t(`${id}.title`)
      )
    )
  );
}

function notLoaded(header) {
  if (state.schedules === null && state.schedulesError && !isLoading()) {
    return [
      header,
      emptyState(
        "wifiOff",
        t("schedules.loadFailed"),
        state.schedulesError,
        h("button", { type: "button", class: "button button-primary", dataset: { key: "schedules-retry" }, onclick: () => loadSchedules() }, icon("refresh"), t("common.retry"))
      ),
    ];
  }
  if (isLoading() || state.schedules === null || state.scenes === null) {
    return [header, h("div", { class: "scene-list", "aria-busy": "true" }, skeletonCards(3)), h("p", { class: "visually-hidden", role: "status" }, t("common.loading"))];
  }
  return null;
}

// ---- weather card --------------------------------------------------------------------------

// "Forecast for 14:20, updated today 08:00": since 1.10.0 (ADR-071) the weather is the hour for now
// of the forecast the controller read then; a 1.9.0 driver's measured weather says nothing.
function forecastLine(weather) {
  if (weather.source !== "forecast") return null;
  const moment = new Date(weather.forecast_for);
  if (Number.isNaN(moment.getTime()) || !weather.fetched_at) return null;
  return h("span", { class: "weather-more weather-source" }, t("schedules.weather.forecast", { time: formatClock(moment, homeZone()), when: dayAndTime(weather.fetched_at) }));
}

function weatherCard() {
  const weather = state.weather;
  if (!weather) return null;
  const sun = [
    weather.today?.sunrise ? t("schedules.weather.sunrise", { time: weather.today.sunrise }) : null,
    weather.today?.sunset ? t("schedules.weather.sunset", { time: weather.today.sunset }) : null,
  ].filter(Boolean);
  let body;
  if (weather.status === "ok" && weather.current) {
    const current = weather.current;
    const today = weather.today || {};
    const now = [
      formatTemperature(outside(current.temperature)),
      Number.isFinite(current.wind_speed) ? t("schedules.weather.wind", { value: Math.round(current.wind_speed) }) : null,
      current.raining ? t("schedules.now.raining") : t("schedules.now.dry"),
    ].filter(Boolean);
    const forecast = [
      Number.isFinite(today.min_temperature) && Number.isFinite(today.max_temperature)
        ? t("schedules.weather.range", { min: formatTemperature(outside(today.min_temperature)), max: formatTemperature(outside(today.max_temperature)) })
        : null,
      Number.isFinite(today.rain_chance) ? t("schedules.weather.rainChance", { value: Math.round(today.rain_chance) }) : null,
    ].filter(Boolean);
    body = [
      h("span", { class: "weather-now" }, now.join(" · ")),
      forecastLine(weather),
      h("span", { class: "weather-more" }, [t("schedules.weather.today"), forecast.join(", ")].filter(Boolean).join(" "), sun.length ? ` · ${sun.join(" · ")}` : ""),
    ];
  } else {
    body = [h("span", { class: "weather-more" }, t(`schedules.weather.${weather.status || "waiting"}`)), sun.length ? h("span", { class: "weather-more" }, sun.join(" · ")) : null];
  }
  return h(
    "section",
    { class: "card weather-card", "aria-label": t("schedules.weather.title") },
    h("span", { class: "scene-icon", "aria-hidden": "true" }, icon("sun")),
    h("div", { class: "scene-text" }, body, h("a", { class: "weather-credit", href: "https://open-meteo.com/", target: "_blank", rel: "noopener" }, t("schedules.weather.credit")))
  );
}

// ---- Shabbat and holiday times (the Jewish calendar) --------------------------------------------

// Under the weather, for everyone: the next Shabbat or holiday, or the one now, with its times.
// Admins can change how they are worked out (Settings → Shabbat and holidays).
function calendarCard(admin) {
  const times = calendarOn() ? holyTimes() : null;
  if (!times) return null;
  const change = admin
    ? h("a", { class: "calendar-change", href: "#/settings/calendar", dataset: { key: "calendar-change" }, onclick: showCalendarSettings }, t("calendar.times.change"))
    : null;
  return h(
    "section",
    { class: "card weather-card calendar-card", "aria-label": t("calendar.times.title") },
    h("span", { class: "scene-icon schedule-candles", "aria-hidden": "true" }, icon("candles")),
    h(
      "div",
      { class: "scene-text" },
      h("span", { class: "weather-now" }, times.title || t("calendar.times.title")),
      times.times ? h("span", { class: "weather-more calendar-times" }, times.times) : null,
      times.later ? h("span", { class: "weather-more calendar-later" }, times.later) : null,
      times.footnote || change ? h("span", { class: "weather-credit" }, times.footnote, times.footnote && change ? " · " : "", change) : null
    )
  );
}

// ---- the list ------------------------------------------------------------------------------

export function schedulesView() {
  const header = pageHeader({ title: t("schedules.title") });
  const notReady = notReadyState();
  if (notReady) return [header, offlineBanner(), notReady];
  if (membersHaveNoSchedules()) return [header, emptyState("clock", t("schedules.title"), t("schedules.adminsOnly"))];
  const waiting = notLoaded(header);
  if (waiting) return waiting;
  if (state.schedulesUnsupported) return [header, scenesNav("schedules"), emptyState("clock", t("schedules.title"), t("schedules.updateDriver"))];
  const admin = can("admin");
  const schedules = state.schedules;
  return [
    header,
    offlineBanner(),
    staleBanner(),
    scenesNav("schedules"),
    notice(ui.schedulesMessage),
    state.schedulesPaused ? h("p", { class: "notice notice-info", role: "status" }, t("schedules.paused")) : null,
    h("p", { class: "muted-note scene-intro" }, admin ? t("schedules.helpAdmin") : t("schedules.help")),
    weatherCard(),
    calendarCard(admin),
    schedules.length
      ? h("ul", { class: "scene-list" }, schedules.map((schedule) => h("li", {}, scheduleCard(schedule, admin))))
      : emptyState("clock", t("schedules.emptyTitle"), admin ? t("schedules.emptyText") : t("schedules.emptyTextMember")),
    admin
      ? schedules.length >= MAX_SCHEDULES
        ? h("p", { class: "notice notice-info" }, t("schedules.limit"))
        : !(state.scenes || []).length
          ? h("p", { class: "notice notice-info" }, t("schedules.needScene"), " ", h("a", { href: "#/scene/new" }, t("scenes.newScene")))
          : h("div", { class: "home-section scene-new" }, h("a", { class: "button button-primary", href: "#/schedule/new", dataset: { key: "schedule-new" } }, icon("plus"), t("schedules.newSchedule")))
      : null,
  ];
}

async function setEnabled(schedule, enabled) {
  state.schedules = state.schedules.map((item) => (item.id === schedule.id ? { ...item, enabled } : item));
  ui.schedulesMessage = null;
  notify();
  try {
    await api(`/v1/schedules/${schedule.id}`, { method: "PATCH", body: { enabled } });
  } catch (error) {
    noteForbidden(error);
    flash(errorText(error), "error");
  }
  await loadSchedules();
}

function scheduleCard(schedule, admin) {
  const when = whenText(schedule);
  const condition = conditionText(schedule);
  const status = statusText(schedule);
  return h(
    "div",
    { class: `card scene-card schedule-card ${schedule.enabled === false ? "is-off" : ""}` },
    h("span", { class: `scene-icon schedule-icon schedule-${scheduleIcon(schedule)}`, "aria-hidden": "true" }, icon(scheduleIcon(schedule))),
    h(
      "div",
      { class: "scene-text" },
      admin ? h("a", { class: "scene-name", href: `#/schedule/${schedule.id}`, dataset: { key: `schedule-edit:${schedule.id}` } }, when) : h("span", { class: "scene-name" }, when),
      h("span", { class: "scene-summary" }, t("schedules.runs", { scene: `⁨${sceneNameOf(schedule)}⁩` })),
      condition ? h("span", { class: "scene-summary" }, condition) : null,
      status ? h("span", { class: "scene-result" }, status) : null
    ),
    admin
      ? h(
          "button",
          {
            type: "button",
            role: "switch",
            class: "switch",
            "aria-checked": String(schedule.enabled !== false),
            "aria-label": t("schedules.switchLabel", { when }),
            dataset: { key: `schedule-on:${schedule.id}` },
            onclick: () => setEnabled(schedule, schedule.enabled === false),
          },
          h("span", { class: "switch-thumb" })
        )
      : null
  );
}

// ---- the editor ----------------------------------------------------------------------------

export function resetScheduleEditor() {
  ui.scheduleEditor = null;
}

// Every kind of trigger keeps its own choices, so switching between them loses nothing.
export function draftFor(key) {
  if (ui.scheduleEditor?.key === key) return ui.scheduleEditor;
  const existing = key === "new" ? null : findSchedule(key);
  if (key !== "new" && !existing) return null;
  const trigger = existing?.trigger || {};
  const onlyIf = existing?.only_if || {};
  const shabbat = trigger.type === "shabbat";
  // Thresholds in the home's scale; in °F the °C kept stays as it is until its number is changed.
  const scale = outsideScale();
  ui.scheduleEditor = {
    key,
    id: existing?.id || null,
    version: existing?.version || null,
    enabled: existing ? existing.enabled !== false : true,
    scene_id: existing?.scene_id || (state.scenes || [])[0]?.id || null,
    type: trigger.type || "time",
    at: trigger.type === "time" ? trigger.at : "07:00",
    event: trigger.type === "sun" ? trigger.event : "sunset",
    offset: trigger.type === "sun" ? trigger.offset || 0 : 0,
    kind: trigger.type === "weather" ? trigger.kind : "heat",
    heat: trigger.kind === "heat" ? fromCelsius(trigger.above, scale) : fromCelsius(30, scale),
    heatKept: trigger.kind === "heat" ? trigger.above : null,
    wind: trigger.kind === "wind" ? trigger.above : 40,
    hours: Boolean(trigger.from),
    from: trigger.from || "08:00",
    to: trigger.to || "20:00",
    once: trigger.once_a_day !== false,
    shabbatEvent: shabbat && trigger.event === "havdalah" ? "havdalah" : "candle_lighting",
    shabbatOffset: shabbat ? trigger.offset || 0 : -30,
    // A Shabbat trigger's days are not shown: it keeps the ones it has, and a new one (or one made
    // from another kind) gets all seven. The other kinds keep theirs meanwhile.
    shabbatDays: shabbat ? [...existing.days] : [...ALL_DAYS],
    during: ["skip", "only"].includes(existing?.during_shabbat) ? existing.during_shabbat : "run",
    days: existing ? [...existing.days] : [...ALL_DAYS],
    notRaining: Boolean(onlyIf.not_raining),
    hot: Number.isFinite(onlyIf.hotter_than),
    hotterThan: fromCelsius(Number.isFinite(onlyIf.hotter_than) ? onlyIf.hotter_than : 28, scale),
    hotterThanKept: Number.isFinite(onlyIf.hotter_than) ? onlyIf.hotter_than : null,
    calm: Number.isFinite(onlyIf.wind_below),
    windBelow: Number.isFinite(onlyIf.wind_below) ? onlyIf.wind_below : 40,
    rainExpected: Boolean(onlyIf.rain_expected),
    ifNoWeather: existing?.if_no_weather || "run",
    busy: false,
    message: null,
    dirty: false,
    cameFrom: ui.cameFrom,
  };
  return ui.scheduleEditor;
}

const draftDays = (draft) => (draft.type === "shabbat" ? draft.shabbatDays : draft.days);

// A heat threshold as the schedule keeps it, in °C (1.10.2): in °F so that it counts from the whole
// °F shown (temperature.js thresholdToCelsius), within what the controller takes (15-45 °C).
function heatThreshold(draft) {
  return inLimits(thresholdToCelsius(draft.heat, outsideScale(), draft.heatKept));
}

function inLimits(celsius) {
  const [min, max] = LIMITS.heat;
  return Math.min(max, Math.max(min, celsius));
}

// The schedule the choices describe, as the API takes it. during_shabbat goes only with the Jewish
// calendar on: drivers before 1.2.0 refuse fields they do not know. A Shabbat trigger sends "run",
// which clears the condition of the kind it was made from.
export function scheduleBody(draft) {
  let trigger;
  if (draft.type === "time") trigger = { type: "time", at: draft.at };
  else if (draft.type === "sun") trigger = { type: "sun", event: draft.event, offset: draft.offset };
  else if (draft.type === "shabbat") trigger = { type: "shabbat", event: draft.shabbatEvent, offset: draft.shabbatOffset };
  else {
    trigger = { type: "weather", kind: draft.kind, once_a_day: draft.once };
    if (draft.kind === "heat") trigger.above = heatThreshold(draft);
    else if (draft.kind !== "rain") trigger.above = draft[draft.kind];
    if (draft.hours) Object.assign(trigger, { from: draft.from, to: draft.to });
  }
  const onlyIf = {};
  if (draft.type !== "weather") {
    if (draft.notRaining) onlyIf.not_raining = true;
    if (draft.hot) onlyIf.hotter_than = inLimits(thresholdToCelsius(draft.hotterThan, outsideScale(), draft.hotterThanKept));
    if (draft.calm) onlyIf.wind_below = draft.windBelow;
    if (draft.rainExpected) onlyIf.rain_expected = true;
  }
  const body = { enabled: draft.enabled, scene_id: draft.scene_id, trigger, days: [...draftDays(draft)].sort((a, b) => a - b), only_if: onlyIf, if_no_weather: draft.ifNoWeather };
  if (calendarOn()) body.during_shabbat = draft.type === "shabbat" ? "run" : draft.during;
  return body;
}

function change(draft, update) {
  update();
  draft.dirty = true;
  draft.message = null;
  notify();
}

export function chip(label, active, key, onclick) {
  return h("button", { type: "button", class: `chip ${active ? "is-active" : ""}`, "aria-pressed": String(active), dataset: { key }, onclick }, name(label, "span"));
}

// `className` lays the options out (styles.css); without it they share one row.
function segments(options, value, key, onPick, className = "") {
  return h(
    "div",
    { class: `segments ${className}`.trim(), role: "group", style: className ? undefined : { "grid-template-columns": `repeat(${options.length}, minmax(0, 1fr))` } },
    options.map(([option, label, iconName]) =>
      h(
        "button",
        { type: "button", class: `segment ${value === option ? "is-active" : ""}`, "aria-pressed": String(value === option), dataset: { key: `${key}:${option}` }, onclick: () => onPick(option) },
        iconName ? icon(iconName) : null,
        label
      )
    )
  );
}

function section(title, ...content) {
  return h("section", { class: "card scene-section" }, h("h2", { class: "add-title" }, title), ...content);
}

// `label` goes under the number; `name`, when the label only goes on from it ("30°", "or hotter"),
// says what − and + change, for screen readers ("Lower temperature").
export function stepper({ value, format, label, name = label, key, min, max, step, onChange }) {
  return h(
    "div",
    { class: "stepper", role: "group", "aria-label": name },
    iconButton("minus", t("schedules.editor.less", { what: name }), { class: "stepper-button", disabled: value <= min, dataset: { key: `${key}-down` }, onclick: () => onChange(Math.max(min, value - step)) }),
    h("div", { class: "stepper-value" }, h("output", { class: "stepper-number", "aria-live": "polite" }, format(value)), h("span", { class: "stepper-label" }, label)),
    iconButton("plus", t("schedules.editor.more", { what: name }), { class: "stepper-button", disabled: value >= max, dataset: { key: `${key}-up` }, onclick: () => onChange(Math.min(max, value + step)) })
  );
}

function toggle(label, on, key, onChange, help) {
  const id = `toggle-${key}`;
  return h(
    "div",
    { class: "toggle-row schedule-toggle" },
    h("span", { class: "toggle-text" }, h("span", { class: "toggle-title", id }, label), help ? h("span", { class: "field-help" }, help) : null),
    h("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(on), "aria-labelledby": id, dataset: { key }, onclick: () => onChange(!on) }, h("span", { class: "switch-thumb" }))
  );
}

// The value is kept as it is typed (browsers report each finished part) without redrawing the
// screen, which would rebuild the field: the times are not in the screen's signature (app.js).
// Only the sentence that sums up the schedule is brought up to date.
function timeInput(draft, value, key, label, onChange) {
  return h("input", {
    type: "time",
    class: "time-input",
    value,
    "aria-label": label,
    required: true,
    dataset: { key },
    onchange: (event) => {
      if (/^\d{2}:\d{2}$/.test(event.target.value)) {
        onChange(event.target.value);
        draft.dirty = true;
        const summary = document.querySelector(".schedule-summary .add-summary");
        if (summary) summary.textContent = sentence(draft);
      }
    },
  });
}

function sceneSection(draft) {
  const scenes = state.scenes || [];
  return section(
    t("schedules.editor.run"),
    scenes.length
      ? h("div", { class: "chip-row" }, scenes.map((scene) => chip(scene.name, draft.scene_id === scene.id, `schedule-scene:${scene.id}`, () => change(draft, () => { draft.scene_id = scene.id; }))))
      : h("p", { class: "notice notice-info" }, t("schedules.needScene"))
  );
}

function offsetLabel(offset) {
  if (!offset) return t("schedules.editor.exactly");
  return t(offset < 0 ? "schedules.editor.offsetBefore" : "schedules.editor.offsetAfter", { offset: formatOffset(offset) });
}

// When Shabbat and holidays begin (candle lighting) or end (havdalah), with the next times, and
// minutes before or after. An offset set through the API is one more chip.
function shabbatChoices(draft) {
  const next = upcomingTimes();
  const offsets = SHABBAT_OFFSETS.includes(draft.shabbatOffset) ? SHABBAT_OFFSETS : [...SHABBAT_OFFSETS, draft.shabbatOffset].sort((a, b) => a - b);
  return [
    state.calendar?.status === "no_location" ? h("p", { class: "notice notice-info" }, t("calendar.times.noLocation")) : null,
    segments(
      [
        ["candle_lighting", next.candle_lighting ? t("schedules.editor.candleLightingAt", { time: onOneLine(dayAndTime(next.candle_lighting)) }) : t("schedules.editor.candleLighting")],
        ["havdalah", next.havdalah ? t("schedules.editor.havdalahAt", { time: onOneLine(dayAndTime(next.havdalah)) }) : t("schedules.editor.havdalah")],
      ],
      draft.shabbatEvent,
      "schedule-shabbat-event",
      (value) => change(draft, () => { draft.shabbatEvent = value; }),
      "segments-events"
    ),
    h(
      "div",
      { class: "chip-row" },
      offsets.map((offset) => chip(offsetLabel(offset), draft.shabbatOffset === offset, `schedule-shabbat-offset:${offset}`, () => change(draft, () => { draft.shabbatOffset = offset; })))
    ),
    h("p", { class: "field-help" }, t("schedules.editor.shabbatHelp")),
  ];
}

function whenSection(draft) {
  const weather = state.weather;
  const kinds = [
    ["time", t("schedules.editor.atTime"), "clock"],
    ["sun", t("schedules.editor.sun"), "sun"],
    ["weather", t("schedules.editor.weather"), "climate"],
  ];
  // Shabbat and holidays, with the Jewish calendar on in Composer.
  if (calendarOn()) kinds.push(["shabbat", t("schedules.editor.shabbat"), "candles"]);
  const parts = [
    segments(kinds, draft.type, "schedule-type", (value) => change(draft, () => { draft.type = value; }), kinds.length > 3 ? "segments-four" : ""),
  ];
  if (draft.type === "shabbat") {
    parts.push(...shabbatChoices(draft));
  } else if (draft.type === "time") {
    parts.push(h("label", { class: "field schedule-field" }, h("span", { class: "field-label" }, t("schedules.editor.time")), timeInput(draft, draft.at, "schedule-at", t("schedules.editor.time"), (value) => { draft.at = value; })));
  } else if (draft.type === "sun") {
    const today = weather?.today || {};
    parts.push(
      segments(
        [
          ["sunrise", today.sunrise ? t("schedules.editor.sunriseAt", { time: today.sunrise }) : t("schedules.editor.sunrise")],
          ["sunset", today.sunset ? t("schedules.editor.sunsetAt", { time: today.sunset }) : t("schedules.editor.sunset")],
        ],
        draft.event,
        "schedule-event",
        (value) => change(draft, () => { draft.event = value; })
      ),
      h(
        "div",
        { class: "chip-row" },
        OFFSETS.map((offset) =>
          chip(
            offset === 0 ? t("schedules.editor.exactly") : t(offset < 0 ? "schedules.editor.minutesBefore" : "schedules.editor.minutesAfter", { minutes: Math.abs(offset) }),
            draft.offset === offset,
            `schedule-offset:${offset}`,
            () => change(draft, () => { draft.offset = offset; })
          )
        )
      )
    );
  } else {
    parts.push(
      h(
        "div",
        { class: "kind-grid" },
        [
          ["heat", "climate"],
          ["rain", "rain"],
          ["wind", "wind"],
        ].map(([kind, iconName]) =>
          h(
            "button",
            { type: "button", class: `kind-choice ${draft.kind === kind ? "is-active" : ""}`, "aria-pressed": String(draft.kind === kind), dataset: { key: `schedule-kind:${kind}` }, onclick: () => change(draft, () => { draft.kind = kind; }) },
            icon(iconName),
            h("span", { class: "kind-name" }, t(`schedules.editor.kinds.${kind}`)),
            h("span", { class: "kind-count" }, weatherNow(kind))
          )
        )
      )
    );
    if (draft.kind !== "rain") {
      const [min, max, step] = limitsOf(draft.kind);
      parts.push(
        stepper({
          value: draft[draft.kind],
          format: (value) => (draft.kind === "heat" ? formatTemperature(value) : t("schedules.kmh", { value })),
          // "30°" and "or hotter": the threshold itself counts (1.10.1, ADR-074).
          label: t(`schedules.editor.above.${draft.kind}`),
          name: t(`schedules.editor.threshold.${draft.kind}`),
          key: "schedule-above",
          min,
          max,
          step,
          onChange: (value) => change(draft, () => { draft[draft.kind] = value; }),
        })
      );
    }
    parts.push(
      h("p", { class: "field-help" }, t(`schedules.editor.again.${draft.kind}`, { value: draft.kind === "heat" ? formatTemperature(cooledTo(heatThreshold(draft), 2, outsideScale())) : draft.wind - 10 })),
      toggle(t("schedules.editor.onlyBetween"), draft.hours, "schedule-hours", (on) => change(draft, () => { draft.hours = on; })),
      draft.hours
        ? h(
            "div",
            { class: "input-row schedule-hours" },
            timeInput(draft, draft.from, "schedule-from", t("schedules.editor.from"), (value) => { draft.from = value; }),
            h("span", { class: "muted-note" }, "–"),
            timeInput(draft, draft.to, "schedule-to", t("schedules.editor.to"), (value) => { draft.to = value; })
          )
        : null,
      toggle(t("schedules.onceADay"), draft.once, "schedule-once", (on) => change(draft, () => { draft.once = on; }))
    );
  }
  return section(t("schedules.editor.when"), ...parts);
}

function daysSection(draft) {
  const has = (day) => draft.days.includes(day);
  const setDays = (days) => change(draft, () => { draft.days = [...days]; });
  return section(
    t("schedules.editor.days"),
    h(
      "div",
      { class: "day-row", role: "group", "aria-label": t("schedules.editor.days") },
      ALL_DAYS.map((day) =>
        h(
          "button",
          {
            type: "button",
            class: `day-chip ${has(day) ? "is-active" : ""}`,
            "aria-pressed": String(has(day)),
            "aria-label": dayName(day, "long"),
            title: dayName(day, "long"),
            dataset: { key: `schedule-day:${day}` },
            onclick: () => setDays(has(day) ? draft.days.filter((other) => other !== day) : [...draft.days, day]),
          },
          dayName(day, "narrow")
        )
      )
    ),
    h(
      "div",
      { class: "chip-row" },
      chip(t("schedules.days.every"), draft.days.length === 7, "schedule-days:all", () => setDays(ALL_DAYS)),
      chip(t("schedules.days.range", { from: dayName(0), to: dayName(4) }), daysText(draft.days) === daysText(WORK_DAYS) && draft.days.length === 5, "schedule-days:work", () => setDays(WORK_DAYS)),
      chip(t("schedules.days.range", { from: dayName(5), to: dayName(6) }), daysText(draft.days) === daysText(WEEKEND) && draft.days.length === 2, "schedule-days:weekend", () => setDays(WEEKEND))
    ),
    duringChoices(draft)
  );
}

// Time, sun and weather schedules on Shabbat and holidays, from candle lighting to havdalah: with
// the Jewish calendar on in Composer. Set while it was on, the choice is kept, and said what it
// does while it is off.
function duringChoices(draft) {
  if (!calendarOn()) {
    return draft.during === "run" ? null : h("p", { class: "notice notice-info" }, t(`schedules.editor.duringOff.${draft.during}`));
  }
  return [
    h("p", { class: "field-label" }, t("schedules.editor.duringShabbat")),
    segments(
      [
        ["run", t("schedules.editor.duringRun")],
        ["skip", t("schedules.editor.duringSkip")],
        ["only", t("schedules.editor.duringOnly")],
      ],
      draft.during,
      "schedule-during",
      (value) => change(draft, () => { draft.during = value; }),
      "segments-stack"
    ),
    h("p", { class: "field-help" }, t("schedules.editor.duringHelp")),
  ];
}

function onlyIfSection(draft) {
  if (draft.type === "weather") return null;
  const any = draft.notRaining || draft.hot || draft.calm || draft.rainExpected;
  return section(
    // A Shabbat trigger has no days to choose: this is the third section then.
    t(draft.type === "shabbat" ? "schedules.editor.onlyIfShabbat" : "schedules.editor.onlyIf"),
    toggle(t("schedules.editor.notRaining"), draft.notRaining, "schedule-if-dry", (on) => change(draft, () => { draft.notRaining = on; })),
    toggle(t("schedules.editor.hotterThan"), draft.hot, "schedule-if-hot", (on) => change(draft, () => { draft.hot = on; })),
    draft.hot
      ? stepper({ value: draft.hotterThan, format: formatTemperature, label: t("schedules.editor.outside"), name: t("schedules.editor.threshold.heat"), key: "schedule-hot", min: limitsOf("heat")[0], max: limitsOf("heat")[1], step: 1, onChange: (value) => change(draft, () => { draft.hotterThan = value; }) })
      : null,
    toggle(t("schedules.editor.windBelow"), draft.calm, "schedule-if-calm", (on) => change(draft, () => { draft.calm = on; })),
    draft.calm
      ? stepper({ value: draft.windBelow, format: (value) => t("schedules.kmh", { value }), label: t("schedules.editor.wind"), name: t("schedules.editor.threshold.wind"), key: "schedule-calm", min: 10, max: 150, step: 5, onChange: (value) => change(draft, () => { draft.windBelow = value; }) })
      : null,
    toggle(t("schedules.editor.rainExpected"), draft.rainExpected, "schedule-if-rain", (on) => change(draft, () => { draft.rainExpected = on; }), t("schedules.editor.rainExpectedHelp")),
    any
      ? [
          h("p", { class: "field-label" }, t("schedules.editor.noWeather")),
          segments(
            [
              ["run", t("schedules.editor.runAnyway")],
              ["skip", t("schedules.editor.skip")],
            ],
            draft.ifNoWeather,
            "schedule-no-weather",
            (value) => change(draft, () => { draft.ifNoWeather = value; })
          ),
        ]
      : null
  );
}

// The whole schedule in one sentence, as it will run.
function sentence(draft) {
  if (!draftDays(draft).length) return t("schedules.editor.pickDay");
  const body = scheduleBody(draft);
  const scene = (state.scenes || []).find((item) => item.id === draft.scene_id);
  if (!scene) return t("schedules.needScene");
  const parts = [whenText(body), t("schedules.runs", { scene: `⁨${scene.name}⁩` })];
  const condition = conditionText(body);
  if (condition) parts.push(condition);
  return parts.join(" · ");
}

export function scheduleEditorView(key) {
  const title = key === "new" ? t("schedules.editor.newTitle") : t("schedules.editor.editTitle");
  const draft0 = ui.scheduleEditor?.key === key ? ui.scheduleEditor : null;
  const header = pageHeader({
    title,
    back: "#/schedules",
    onBack: (event) => {
      if (draft0?.dirty && !window.confirm(t("schedules.editor.discard"))) event.preventDefault();
    },
  });
  const notReady = notReadyState();
  if (notReady) return [header, offlineBanner(), notReady];
  // A member (a link kept from an admin's device): as on the list, never asked for, never loading.
  if (membersHaveNoSchedules()) return [header, emptyState("clock", title, t("schedules.adminsOnly"))];
  const waiting = notLoaded(header);
  if (waiting) return waiting;
  if (state.schedulesUnsupported) return [header, emptyState("clock", title, t("schedules.updateDriver"))];
  if (!can("admin")) return [header, h("p", { class: "notice notice-info" }, t("schedules.editor.adminOnly", { role: roleLabel(state.role) }))];
  const draft = draftFor(key);
  if (!draft) return [header, emptyState("clock", t("schedules.editor.notFound"), "", h("a", { class: "button button-primary", href: "#/schedules" }, t("schedules.title")))];
  if (!calendarOn()) {
    const existing = draft.id ? findSchedule(draft.id) : null;
    if (existing?.trigger?.type === "shabbat") return [header, offlineBanner(), staleBanner(), calendarOffEditor(existing, draft)];
    // Made a Shabbat schedule here, and the calendar was turned off meanwhile: back to its own kind
    // (a time, for a new one).
    if (draft.type === "shabbat") draft.type = existing?.trigger?.type || "time";
  }
  return [
    header,
    offlineBanner(),
    staleBanner(),
    h(
      "div",
      { class: "scene-editor" },
      sceneSection(draft),
      whenSection(draft),
      // A Shabbat trigger runs when the period begins or ends, whatever the weekday.
      draft.type === "shabbat" ? null : daysSection(draft),
      onlyIfSection(draft),
      h(
        "section",
        { class: "card scene-section schedule-summary" },
        h("p", { class: "add-summary", role: "status" }, sentence(draft)),
        toggle(t("schedules.editor.on"), draft.enabled, "schedule-enabled", (on) => change(draft, () => { draft.enabled = on; }))
      ),
      notice(draft.message),
      h(
        "div",
        { class: "scene-actions" },
        h(
          "button",
          { type: "button", class: "button button-primary", disabled: draft.busy || !draftDays(draft).length || !draft.scene_id, dataset: { key: "schedule-save" }, onclick: () => saveDraft(draft) },
          icon("check"),
          draft.busy ? t("common.saving") : t("schedules.editor.save")
        ),
        draft.id ? deleteButton(draft) : null
      )
    ),
  ];
}

function deleteButton(draft) {
  return h("button", { type: "button", class: "button button-danger", disabled: draft.busy, dataset: { key: "schedule-delete" }, onclick: () => deleteDraft(draft) }, t("schedules.editor.delete"));
}

// A Shabbat schedule while the Jewish calendar is off in Composer: it is kept but does not run, and
// it can only be switched on or off (at once, as in the list) or deleted.
function calendarOffEditor(schedule, draft) {
  return h(
    "div",
    { class: "scene-editor" },
    notice(ui.schedulesMessage),
    h(
      "section",
      { class: "card scene-section schedule-summary" },
      h("p", { class: "add-summary" }, [whenText(schedule), t("schedules.runs", { scene: `⁨${sceneNameOf(schedule)}⁩` })].join(" · ")),
      h("p", { class: "notice notice-info" }, t("schedules.editor.calendarOff")),
      toggle(t("schedules.editor.on"), schedule.enabled !== false, "schedule-enabled", (on) => setEnabled(schedule, on))
    ),
    notice(draft.message),
    h("div", { class: "scene-actions" }, deleteButton(draft))
  );
}

async function saveDraft(draft) {
  if (draft.type === "weather" && draft.hours && draft.from === draft.to) {
    draft.message = { kind: "error", text: t("schedules.editor.sameHours") };
    notify();
    return;
  }
  draft.busy = true;
  draft.message = null;
  notify();
  const body = scheduleBody(draft);
  try {
    if (draft.id) await api(`/v1/schedules/${draft.id}`, { method: "PATCH", body: { ...body, version: draft.version } });
    else await api("/v1/schedules", { method: "POST", body });
    draft.busy = false;
    draft.dirty = false;
    flash(t("schedules.saved"));
    await loadSchedules();
    leave("#/schedules", draft.cameFrom);
    return;
  } catch (error) {
    noteForbidden(error);
    // The calendar was turned off in Composer meanwhile: its choices go (errorText says why).
    noteCalendarOff(error);
    const codes = { VERSION_CONFLICT: "conflict", SCHEDULE_LIMIT_REACHED: "limit" };
    draft.message = { kind: "error", text: codes[error?.code] ? t(`schedules.editor.${codes[error.code]}`) : errorText(error) };
  }
  draft.busy = false;
  notify();
}

async function deleteDraft(draft) {
  if (draft.busy || !window.confirm(t("schedules.editor.deleteConfirm"))) return;
  draft.busy = true;
  notify();
  try {
    await api(`/v1/schedules/${draft.id}`, { method: "DELETE" });
  } catch (error) {
    if (error?.status !== 404) {
      noteForbidden(error);
      draft.busy = false;
      draft.message = { kind: "error", text: errorText(error) };
      notify();
      return;
    }
  }
  draft.busy = false;
  draft.dirty = false;
  flash(t("schedules.deleted"));
  await loadSchedules();
  leave("#/schedules", draft.cameFrom);
}
