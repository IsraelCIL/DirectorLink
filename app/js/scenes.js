// Scenes (docs/SCENES.md): the home's one-tap actions, kept on the controller. Everyone sees them,
// members run them, admins make and change them (views/scenes.js). A step sets devices of one
// type: the ones it names, or all of them in a room or the whole home. Doors and gates only get
// a pulse, what their Open button does. A music step (1.5.0) pauses or stops the Sonos music in a
// room or the whole home; since 1.8.0 (ADR-057) it also resumes it, sets the volume, or plays a
// Sonos favorite in a room, with other rooms grouped with it. A refrigerators step (1.7.0) switches
// refrigerator features on or off.

import { sceneSet } from "./fans.js";
import { formatTemperature, formatTemperatureRange, t } from "./i18n.js";
import { deviceRoomId, fanLabel, fanSpeedLabel, lastMode, modeLabel, musicDevices, roomById, roomName, shownBrightness } from "./model.js";
import { api, errorText, noteForbidden, refreshDevices } from "./session.js";
import { isDual } from "./setpoints.js";
import { FEATURES as FRIDGE_FEATURES } from "./refrigerators.js";
import { scenePosition } from "./shades.js";
import { can, notify, state, ui } from "./state.js";
import { fromCelsius, inScale, isSensor, projectScale } from "./temperature.js";

export const SCENE_ICONS = ["bulb", "moon", "sun", "leave", "movie", "climate", "blinds", "home"];
export const STEP_TYPES = ["lights", "climate", "fans", "blinds", "relays", "music", "refrigerators"];
export const STEP_ICONS = { lights: "bulb", climate: "climate", fans: "fan", blinds: "blinds", relays: "door", music: "music", refrigerators: "fridge" };
export const MAX_STEPS = 40;
export const MAX_DEVICE_IDS = 100;
// The temperatures a scene step takes (driver/src/core/scenes.lua), in °C.
export const SCENE_MIN_TEMPERATURE = 5;
export const SCENE_MAX_TEMPERATURE = 40;
const LISTS = { lights: "lights", climate: "thermostats", fans: "fans", blinds: "blinds", relays: "relays", refrigerators: "refrigerators" };
const RESULT_MS = 4000;
const CONFIRM_MS = 5000;

export function devicesOfType(type) {
  // Sonos rooms, in the room they are shown in (none while Sonos is off).
  if (type === "music") return musicDevices();
  // A temperature sensor (1.10.2) has nothing a scene could set.
  if (type === "climate") return state.thermostats.filter((thermostat) => !isSensor(thermostat));
  return state[LISTS[type]] || [];
}

// A name inside a sentence in the other direction (a Control4 name in Hebrew, or the reverse).
export function isolate(text) {
  return `⁨${text}⁩`;
}

// After connecting and every minute: the home's scenes. Drivers before 0.13.0 have none.
export async function loadScenes() {
  try {
    const answer = await api("/v1/scenes");
    state.scenes = Array.isArray(answer?.items) ? answer.items : [];
    state.scenesUnsupported = false;
    state.scenesError = null;
  } catch (error) {
    if (error?.status === 404 || error?.status === 405) {
      state.scenes = [];
      state.scenesUnsupported = true;
    } else if (state.scenes === null) {
      // Nothing to show yet: say why, with Retry. Later failures keep the last list.
      state.scenesError = errorText(error);
    }
  }
  notify();
}

export function findScene(id) {
  return (state.scenes || []).find((scene) => scene.id === id) || null;
}

// The controller remembers each thermostat's last mode, and a climate step turns each AC on as it
// was (`mode: "on"`, 1.10.0, ADR-070).
export const lastModeSupported = () => state.system?.features?.climate_last_mode === true;

// The ACs among `thermostats` that On, as it was leaves off for now: the controller doesn't know
// their last mode yet (`last_mode` in GET /v1/thermostats), or knows one it can't set them to (Dry
// from the AC's own remote). Each comes back once it has been on in one of its modes.
export function notSeenOn(thermostats) {
  return lastModeSupported() ? thermostats.filter((thermostat) => !lastMode(thermostat)) : [];
}

// The ACs a scene's On, as it was actions would leave off now, each once.
export function sceneNotSeenOn(scene) {
  const found = new Map();
  for (const step of scene.steps || []) {
    if (step.type === "climate" && step.set?.mode === "on") for (const thermostat of notSeenOn(stepDevices(step))) found.set(thermostat.id, thermostat);
  }
  return [...found.values()];
}

// "Not seen on yet: Living room AC, Bedroom AC — turn each on once, or they stay off"; null for none.
export function notSeenOnText(thermostats) {
  if (!thermostats.length) return null;
  return t("scenes.notSeenOn", { count: thermostats.length, names: thermostats.map((thermostat) => isolate(thermostat.name)).join(", ") });
}

// A level for a room or the whole home goes to its dimmers only, and the switches there stay as
// they are (ADR-077, 2026-10-09: a KNX switch may be a heater or a door lock). A lights step named
// by its devices still turns a switch on. Drivers before say nothing of it, and turn them on.
export const levelsForDimmersOnly = () => state.system?.features?.scene_levels_dimmers_only === true;

export function dimmersOnly(step) {
  return levelsForDimmersOnly() && step.type === "lights" && !Array.isArray(step.device_ids) && Number.isFinite(step.set?.brightness) && step.set.brightness > 0;
}

export function sceneOpensDoors(scene) {
  return (scene.steps || []).some((step) => step.type === "relays");
}

// ---- describing steps ----------------------------------------------------------------------

// The devices a step works on now: the ones it names that still exist, or all in its room.
export function stepDevices(step) {
  const list = devicesOfType(step.type);
  if (Array.isArray(step.device_ids)) {
    return step.device_ids.map((id) => list.find((device) => device.id === id)).filter(Boolean);
  }
  return list.filter((device) => step.room_id == null || deviceRoomId(device) === step.room_id);
}

// A member's step that also works on rooms or devices they don't see (1.8.0, ADR-054: `elsewhere`;
// the controller leaves those out of room_id and device_ids): nothing of theirs is named in it.
function onlyElsewhere(step) {
  return step.elsewhere === true && !(Array.isArray(step.device_ids) && step.device_ids.length);
}

export function stepWhat(step) {
  if (onlyElsewhere(step)) return t(`scenes.elsewhere.${step.type}`);
  if (!Array.isArray(step.device_ids)) return dimmersOnly(step) ? t("scenes.allDimmers") : t(`scenes.all.${step.type}`);
  let what = t(`scenes.count.${step.type}`, { count: step.device_ids.length });
  if (step.device_ids.length === 1) {
    const device = devicesOfType(step.type).find((item) => item.id === step.device_ids[0]);
    if (device) what = device.name;
  }
  return step.elsewhere ? t("scenes.alsoElsewhere", { what: isolate(what) }) : what;
}

export function stepWhere(step) {
  if (step.room_id != null) {
    const room = roomById(step.room_id);
    return room ? roomName(room) : t("scenes.roomGone");
  }
  if (onlyElsewhere(step)) return t("scenes.otherRooms");
  if (step.elsewhere) {
    const rooms = new Set(stepDevices(step).map(deviceRoomId));
    const room = rooms.size === 1 ? roomById([...rooms][0]) : null;
    return room ? t("scenes.andOtherRooms", { room: isolate(roomName(room)) }) : t("scenes.severalRooms");
  }
  if (!Array.isArray(step.device_ids)) return t("scenes.wholeHome");
  const rooms = new Set(stepDevices(step).map(deviceRoomId));
  if (rooms.size === 1) {
    const room = roomById([...rooms][0]);
    return room ? roomName(room) : "";
  }
  return t("scenes.severalRooms");
}

// A step's temperature (°C as kept) in the project's scale (1.10.2): whole °F in a °F home.
const shown = (celsius) => fromCelsius(celsius, projectScale(state.system));

// "20°–24°", "Heat 20°" or "Cool 24°" for a step's heat and cool setpoints (just "20°" when the
// step's mode already says which); null without them.
function setpointsText(set) {
  const heat = Number.isFinite(set.heat_setpoint) ? shown(set.heat_setpoint) : null;
  const cool = Number.isFinite(set.cool_setpoint) ? shown(set.cool_setpoint) : null;
  if (heat !== null && cool !== null) return formatTemperatureRange(heat, cool);
  if (heat !== null) return set.mode === "heat" ? formatTemperature(heat) : `${t("climate.heatShort")} ${formatTemperature(heat)}`;
  if (cool !== null) return set.mode === "cool" ? formatTemperature(cool) : `${t("climate.coolShort")} ${formatTemperature(cool)}`;
  return null;
}

export function stepAction(step) {
  const set = step.set || {};
  if (step.type === "lights") {
    if (set.on === false || set.brightness === 0) return t("scenes.do.off");
    if (Number.isFinite(set.brightness)) return t("scenes.do.dimTo", { percent: set.brightness });
    return t("scenes.do.on");
  }
  if (step.type === "climate") {
    if (set.mode === "off") return t("scenes.do.off");
    // Each AC in its last mode, its temperature and fan as they were (1.10.0).
    if (set.mode === "on") return t("scenes.do.onAsItWas");
    return [
      set.mode ? modeLabel(set.mode) : null,
      Number.isFinite(set.target_temperature) ? formatTemperature(shown(set.target_temperature)) : setpointsText(set),
      set.fan_speed ? t("scenes.do.fan", { speed: fanLabel(set.fan_speed) }) : null,
    ]
      .filter(Boolean)
      .join(", ");
  }
  if (step.type === "fans") {
    if (set.on === false) return t("scenes.do.off");
    if (Number.isInteger(set.speed)) return t("scenes.do.speed", { speed: fanSpeedLabel(set.speed) });
    return t("scenes.do.on");
  }
  if (step.type === "blinds") {
    if (set.position >= 100) return t("scenes.do.open");
    if (set.position <= 0) return t("scenes.do.close");
    return t("scenes.do.position", { percent: set.position });
  }
  if (step.type === "music") return musicAction(set);
  if (step.type === "refrigerators") {
    return FRIDGE_FEATURES.filter((feature) => typeof set[feature] === "boolean")
      .map((feature) => t(set[feature] ? "scenes.do.featureOn" : "scenes.do.featureOff", { feature: t(`refrigerators.features.${feature}`) }))
      .join(", ");
  }
  return t("scenes.do.pulse");
}

// What a music step does: "Pause", "Volume 20%", "Play “Example FM” at 30% · with Kitchen".
export function musicAction(set) {
  if (set.action === "stop") return t("scenes.do.stopMusic");
  if (set.action === "resume") return t("scenes.do.resumeMusic");
  if (set.action === "volume") return t("scenes.do.musicVolume", { percent: set.volume });
  if (set.action === "play_favorite") {
    const title = isolate(set.favorite?.title || t("scenes.do.aFavorite"));
    const play = Number.isFinite(set.volume) ? t("scenes.do.playFavoriteAt", { name: title, percent: set.volume }) : t("scenes.do.playFavorite", { name: title });
    const rooms = (set.with_room_ids || []).map((id) => roomById(id)).map((room) => (room ? roomName(room) : t("scenes.roomGone")));
    return rooms.length ? `${play} · ${t("scenes.do.withRooms", { rooms: rooms.map(isolate).join(", ") })}` : play;
  }
  return t("scenes.do.pauseMusic");
}

// "All lights: Off · Parents: Cool, 24° · +2 more"
export function sceneSummary(scene) {
  const steps = scene.steps || [];
  if (!steps.length) return t("scenes.noSteps");
  const parts = steps.slice(0, 3).map((step) => {
    const inRoom = dimmersOnly(step) ? "scenes.inRoomDimmers" : `scenes.inRoom.${step.type}`;
    const what = step.room_id != null && !Array.isArray(step.device_ids) ? t(inRoom, { room: isolate(stepWhere(step)) }) : stepWhat(step);
    return `${isolate(what)}: ${stepAction(step)}`;
  });
  if (steps.length > 3) parts.push(t("scenes.more", { count: steps.length - 3 }));
  return parts.join(" · ");
}

// Steps as the controller accepts them now: devices and rooms that are no longer in the project
// are taken out (a step with none left goes). `changed` says whether anything was.
export function currentSteps(steps) {
  const kept = [];
  let changed = false;
  for (let step of steps) {
    if (step.room_id != null && !roomById(step.room_id)) {
      changed = true;
      continue;
    }
    // The rooms a favorite plays in besides the step's own (1.8.0).
    const others = step.set?.with_room_ids;
    if (Array.isArray(others) && others.some((id) => !roomById(id))) {
      changed = true;
      const rooms = others.filter((id) => roomById(id));
      const { with_room_ids: _gone, ...set } = step.set;
      step = { ...step, set: rooms.length ? { ...set, with_room_ids: rooms } : set };
    }
    if (Array.isArray(step.device_ids)) {
      const known = new Set(devicesOfType(step.type).map((device) => device.id));
      const ids = step.device_ids.filter((id) => known.has(id));
      if (ids.length !== step.device_ids.length) changed = true;
      if (ids.length) kept.push({ ...step, device_ids: ids });
    } else {
      kept.push(step);
    }
  }
  return { steps: kept, changed };
}

// ---- running -------------------------------------------------------------------------------

// The switches a run left as they are, a level for a room or the whole home being for dimmers
// (ADR-077): the controller counts them all (`on_off_only`), its problems name at most 50.
export function switchesLeft(result) {
  if (Number.isInteger(result?.on_off_only)) return result.on_off_only;
  return (result?.problems || []).filter((problem) => problem.code === "ON_OFF_ONLY").length;
}

// Whether a run left out something it was meant to do: a device failed or was skipped, or ran with
// a setting left out. Switches a level left as they are were not meant to be set.
export function runPartial(result) {
  const problems = result.problems || [];
  return result.failed > 0 || result.skipped - switchesLeft(result) > 0 || problems.some((problem) => problem.code !== "ON_OFF_ONLY");
}

// What a run did, in one line (the controller says why devices were skipped).
export function resultText(result) {
  const switches = switchesLeft(result);
  const problems = (result.problems || []).filter((problem) => problem.code !== "ON_OFF_ONLY");
  const skipped = result.skipped - switches;
  if (result.failed > 0) return t("scenes.result.failed", { count: result.failed });
  if (skipped > 0) {
    // A music step's (device_id 0) FORBIDDEN is a Sonos room this person may not control (1.8.0).
    const codes = new Set(
      problems.filter((problem) => problem.outcome !== "partial").map((problem) => (problem.code === "FORBIDDEN" && problem.device_id === 0 ? "MUSIC_FORBIDDEN" : problem.code))
    );
    if (codes.size === 1 && codes.has("FORBIDDEN")) return t("scenes.result.doors");
    if (codes.size === 1 && codes.has("MUSIC_FORBIDDEN")) return t("scenes.result.musicForbidden");
    if (codes.size === 1 && codes.has("FAVORITE_GONE")) return t("scenes.result.favoriteGone");
    if (codes.size === 1 && codes.has("FAVORITE_NOT_PLAYABLE")) return t("scenes.result.favoriteNotPlayable");
    if (codes.size === 1 && codes.has("DOOR_CONTROL_DISABLED")) return t("scenes.result.doorControl");
    // Music steps (1.5.0): the controller says why the music was left as it was.
    if (codes.size === 1 && codes.has("SONOS_OFF")) return t("scenes.result.sonosOff");
    if (codes.size === 1 && codes.has("NO_PLAYERS")) return t("scenes.result.noPlayers");
    if (codes.size === 1 && codes.has("NO_SONOS_ROOM")) return t("scenes.result.noSonosRoom");
    // ACs left off: their last mode is not known yet (1.10.0).
    if (codes.size === 1 && codes.has("NO_LAST_MODE")) return t("scenes.result.noLastMode", { count: skipped });
    return t("scenes.result.skipped", { count: skipped });
  }
  if (problems.length) return t("scenes.result.partial");
  // Only dimmers got the level: the switches there stayed as they were, as meant.
  if (switches > 0) return t("scenes.result.switchesLeft", { count: switches });
  return t("scenes.result.done");
}

function setRun(id, value) {
  ui.sceneRuns = { ...ui.sceneRuns, [id]: value };
  notify();
}

function clearRunLater(id, stamp, delay) {
  window.setTimeout(() => {
    if (ui.sceneRuns[id]?.stamp === stamp) {
      const { [id]: _done, ...rest } = ui.sceneRuns;
      ui.sceneRuns = rest;
      notify();
    }
  }, delay);
}

// Runs a saved scene; the button shows what happened for a few seconds, then the devices' new
// state is read. A scene that opens doors or gates asks for a second tap, like their Open button;
// with 1.8.0 (ADR-054) for everyone who may run it, since it runs in full.
export async function runScene(scene) {
  const current = ui.sceneRuns[scene.id];
  if (current?.stage === "running") return;
  if (sceneOpensDoors(scene) && (can("doors") || state.access) && current?.stage !== "confirm") {
    const stamp = Date.now();
    setRun(scene.id, { stage: "confirm", text: t("scenes.confirmDoors"), stamp });
    clearRunLater(scene.id, stamp, CONFIRM_MS);
    return;
  }
  setRun(scene.id, { stage: "running" });
  let outcome;
  try {
    const result = await api(`/v1/scenes/${scene.id}/run`, { method: "POST" });
    outcome = { stage: runPartial(result) ? "partial" : "done", text: resultText(result) };
  } catch (error) {
    noteForbidden(error);
    outcome = { stage: "error", text: t("scenes.result.error", { error: errorText(error) }) };
  }
  const stamp = Date.now();
  setRun(scene.id, { ...outcome, stamp });
  window.setTimeout(() => refreshDevices(), 1500);
  clearRunLater(scene.id, stamp, RESULT_MS);
}

// ---- copying the house ---------------------------------------------------------------------

// A temperature a thermostat reports, as a scene step keeps it: within what scene steps take and
// the thermostat's own range, as brightness and positions are kept within theirs. A setpoint set on
// the thermostat itself can be lower (40 °F is 4.4 °C), and one such value made the controller
// refuse the whole scene.
function copiedTemperature(thermostat, value) {
  const min = Number.isFinite(thermostat.target_temperature_min) ? Math.max(SCENE_MIN_TEMPERATURE, thermostat.target_temperature_min) : SCENE_MIN_TEMPERATURE;
  const max = Number.isFinite(thermostat.target_temperature_max) ? Math.min(SCENE_MAX_TEMPERATURE, thermostat.target_temperature_max) : SCENE_MAX_TEMPERATURE;
  if (min > max) return Math.max(SCENE_MIN_TEMPERATURE, Math.min(SCENE_MAX_TEMPERATURE, value));
  return Math.max(min, Math.min(max, value));
}

// The setpoints a thermostat in auto has now, as a scene step keeps them (the controller takes
// cool only above heat, which the values kept in range must still be).
function autoSetpoints(thermostat) {
  const heat = Number.isFinite(thermostat.heat_setpoint) ? copiedTemperature(thermostat, thermostat.heat_setpoint) : null;
  const cool = Number.isFinite(thermostat.cool_setpoint) ? copiedTemperature(thermostat, thermostat.cool_setpoint) : null;
  if (heat !== null && cool !== null) return cool > heat ? { heat_setpoint: heat, cool_setpoint: cool } : {};
  if (heat !== null) return { heat_setpoint: heat };
  if (cool !== null) return { cool_setpoint: cool };
  return {};
}

// Steps that put every light, AC, fan and blind back the way they are now. Devices set alike
// share a step (at most 100 devices each); doors and gates are left out. `left`: steps that did
// not fit in a scene. A thermostat with heat and cool setpoints keeps both in auto; in heat or
// cool its target is the setpoint of that mode. Temperatures stay within what a scene step takes.
export function copyHouse() {
  const groups = new Map();
  const add = (type, set, id) => {
    const key = `${type}:${JSON.stringify(set)}`;
    if (!groups.has(key)) groups.set(key, { type, room_id: null, device_ids: [], set });
    groups.get(key).device_ids.push(id);
  };
  for (const light of state.lights) {
    if (!light.on) add("lights", { on: false }, light.id);
    else if (light.dimmable && Number.isFinite(shownBrightness(light))) add("lights", { brightness: Math.max(1, Math.min(100, Math.round(shownBrightness(light)))) }, light.id);
    else add("lights", { on: true }, light.id);
  }
  // Each in °C, as a scene step keeps it (1.10.2: the whole °F of a °F one as °C to 0.1).
  for (const thermostat of state.thermostats.filter((item) => !isSensor(item)).map((item) => inScale(item, "C"))) {
    const set = {};
    if (thermostat.mode && (thermostat.modes || []).includes(thermostat.mode)) set.mode = thermostat.mode;
    if (set.mode !== "off") {
      if (isDual(thermostat) && thermostat.mode === "auto") Object.assign(set, autoSetpoints(thermostat));
      else if (Number.isFinite(thermostat.target_temperature)) set.target_temperature = copiedTemperature(thermostat, thermostat.target_temperature);
      if (thermostat.fan_speed && (thermostat.fan_speeds || []).includes(thermostat.fan_speed)) set.fan_speed = thermostat.fan_speed;
    }
    if (Object.keys(set).length) add("climate", set, thermostat.id);
  }
  // A fan off, at its speed, or on when it reports no speed (fans.js).
  for (const fan of state.fans) {
    add("fans", sceneSet(fan), fan.id);
  }
  for (const blind of state.blinds) {
    // A shade that only opens and closes fully gets 0 or 100, the nearer (shades.js).
    const position = scenePosition(blind);
    if (position !== null) add("blinds", { position }, blind.id);
  }
  const steps = [];
  for (const group of groups.values()) {
    for (let start = 0; start < group.device_ids.length; start += MAX_DEVICE_IDS) {
      steps.push({ ...group, device_ids: group.device_ids.slice(start, start + MAX_DEVICE_IDS) });
    }
  }
  return { steps: steps.slice(0, MAX_STEPS), left: Math.max(0, steps.length - MAX_STEPS) };
}
