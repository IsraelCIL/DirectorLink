// Say or type a command (1.9.0, ADR-063; 1.10.0, ADR-066, ADR-068): what the app does with what
// js/command-parser.js understood, in the app's language (Spanish and Italian in their own words,
// English and Hebrew in any). The parser gets only what the controller lists for this user
// (state.js): their rooms, the devices they control, the scenes they may run, their Sonos rooms, and
// the doors and gates in their rooms (to open only with door access). Every action is the same call
// a tap makes (controls.js, music.js, scenes.js, turn-off.js), so the controller decides as for any
// tap; doors and gates, Turn off all and scenes that open doors keep their second tap. Up to five
// things said at once are each shown, then done (each second tap still its own); a change by a step
// ("brighter", "warmer", "louder", 1.11.0: "open the blinds a bit", "faster") is worked out here from
// where each device is. Lights named for heating are left as they are unless named (heaters.js),
// and it says so, as it says that a room's level leaves its switches as they are. The words never
// leave this device. views/command.js shows the field and what this module says.

import { parseCommand } from "./command-parser.js";
import { announce } from "./dom.js";
import { allOff, blindMove, setBlind, setFan, setLight, setStage, setThermostat, stopBlind } from "./controls.js";
import { currentLanguage, formatTemperature, t } from "./i18n.js";
import { isHeater } from "./heaters.js";
import { climateIsOn, fanIsOn, lastMode, lightIsOn, modeLabel, roomById, roomGroup, roomName } from "./model.js";
import { findMusic, musicAvailable, musicCommand, musicKey, musicRooms, setMusicLevels } from "./music.js";
import { fanSpeeds } from "./fans.js";
import { findScene, isolate, runScene, sceneOpensDoors } from "./scenes.js";
import { activeSetpoint, isDual, setpointGap, withSetpoint } from "./setpoints.js";
import { canSetPosition, shadeView } from "./shades.js";
import { can, deviceKey, findDevice, notify, state, ui } from "./state.js";
import { defaultRange, isSensor, roundIn, scaleOf } from "./temperature.js";
import { heaterNames, keptHeaters, offTargets, turnOffNow } from "./turn-off.js";

// A result stays this long ("Kitchen: lights off · Done"); a question or a problem until the next
// command. Turn off all's confirm waits this long for its tap.
const RESULT_MS = 8000;
const CONFIRM_MS = 10000;

// What the command area shows: null, or { stage, said, note, text, options, question, action,
// stamp }. stage: running · done · partial · error · ask · confirm (Turn off all) · door · scene (one
// that opens doors) · problem · unknown · message (from the microphone) · several (two to five
// things: `parts`, each { said, note, action, stage, text } with one of the first eight stages, or
// cancelled). `note`: the heaters left as they are, and a room's switches a level left (1.11.0).
let current = null;
let stamps = 0;

export function commandState() {
  // Said and answered before the app's language changed: its words and examples are in the other
  // language, which this one's commands do not understand. Gone (1.10.0).
  if (current && current.language !== currentLanguage()) current = null;
  return current;
}

// What a screen reader says of it (views/command.js shows it).
function spoken(shown) {
  if (shown.stage === "ask") return [shown.text, ...shown.labels].join(" ");
  if (shown.stage === "several") return shown.parts.map(spoken).join(". ");
  const hint = shown.stage === "door" ? t("relays.confirmHint") : shown.stage === "scene" ? t("scenes.confirmDoors") : "";
  return [shown.said, shown.note, shown.text, hint].filter(Boolean).join(". ");
}

function show(next) {
  stamps += 1;
  current = next ? { ...next, language: currentLanguage(), stamp: stamps } : null;
  if (current && current.stage !== "message") announce(spoken(current));
  notify();
  return current;
}

// After a run: the result, unless another command came meanwhile; a result goes after a while.
function settle(stamp, outcome) {
  if (current?.stamp !== stamp) return;
  current = { ...current, ...outcome };
  announce(outcome.text);
  notify();
  if (outcome.stage === "done") {
    window.setTimeout(() => {
      if (current?.stamp === stamp && current.stage === "done") show(null);
    }, RESULT_MS);
  }
}

export function clearCommand() {
  show(null);
}

// A line from the microphone: Listening…, or why it did not work.
export function commandMessage(text, kind = "info") {
  const shown = show({ stage: "message", text, kind });
  announce(text);
  return shown;
}

// ---- what the parser may name ---------------------------------------------------------------

// The user's own names, from what the controller lists for them: a room by its Control4 name and
// its name in every language of Settings → Rooms.
export function commandCatalog() {
  const control = can("member");
  const rooms = state.rooms.map((room) => ({ id: room.id, names: [room.name, ...Object.values(room.names && typeof room.names === "object" ? room.names : {})].filter((name) => typeof name === "string" && name) }));
  const devices = [];
  const add = (kind, list, fields) => {
    for (const device of list || []) devices.push({ kind, id: device.id, name: device.name, room: device.room?.id ?? null, ...fields(device) });
  };
  if (control) {
    add("light", state.lights, (light) => ({ dimmable: light.dimmable !== false, on: Boolean(light.on) }));
    // A temperature sensor (1.10.2) has nothing a command could set. Each in its own scale: in a
    // °F home "72" and "2 degrees warmer" are °F.
    add("thermostat", state.thermostats.filter((thermostat) => !isSensor(thermostat)), (thermostat) => ({
      scale: scaleOf(thermostat),
      modes: thermostat.modes || [],
      mode: thermostat.mode || null,
      // Its last mode, to turn it on as it was (1.10.0, ADR-070); null when not known.
      last: lastMode(thermostat),
      dual: isDual(thermostat),
      min: thermostat.target_temperature_min,
      max: thermostat.target_temperature_max,
    }));
    add("blind", state.blinds, (blind) => ({ position: canSetPosition(blind) }));
    // A fan's own speeds (1.11.0): none, it only turns on and off.
    add("fan", state.fans, (fan) => ({ on: Boolean(fan.on), speeds: fanSpeeds(fan) }));
    // A Sonos room is in the room it is shown in.
    if (musicAvailable()) add("music", musicRooms(), (item) => ({ room: item.room_id ?? null }));
  }
  // Doors and gates in their rooms; opening them needs door access (the parser says so).
  add("relay", state.relays, () => ({ canOpen: can("doors") }));
  add("doorbell", (state.doorbells || []).filter((doorbell) => doorbell.can_open), () => ({ canOpen: can("doors") }));
  const scenes = control ? (state.scenes || []).map((scene) => ({ id: scene.id, name: scene.name })) : [];
  return { rooms, devices, scenes };
}

// ---- words -----------------------------------------------------------------------------------

const LISTS = { light: "lights", thermostat: "thermostats", blind: "blinds", fan: "fans", relay: "relays", doorbell: "doorbells" };

function deviceOf(ref) {
  if (!ref) return null;
  if (ref.kind === "music") return findMusic(ref.id);
  return (state[LISTS[ref.kind]] || []).find((device) => device.id === ref.id) || null;
}

function deviceName(ref) {
  return deviceOf(ref)?.name || "";
}

function placeOf(device) {
  const roomId = device?.room_id ?? device?.room?.id;
  return roomId != null && roomById(roomId) ? roomName(roomById(roomId)) : "";
}

// "in the kitchen" in English, "במטבח" (or "ב-Kitchen") in Hebrew, for the examples.
function inRoom(name) {
  if (currentLanguage() === "he") return /^[א-ת]/.test(name) ? `ב${name}` : `ב-${isolate(name)}`;
  return name;
}

// What an action does, after "{what}: ": "lights off", "AC 23°", "open".
function doing(action) {
  const named = Boolean(action.device);
  const change = action.change || {};
  if (action.type === "lights") {
    const key = named ? "light" : "lights";
    if (change.on === false) return t(`command.do.${key}.off`);
    if (Number.isFinite(change.brightness)) return t(`command.do.${key}.level`, { percent: change.brightness });
    if (Number.isFinite(change.brightnessBy)) return t(`command.do.${key}.${change.brightnessBy > 0 ? "brighter" : "dimmer"}`, { percent: Math.abs(change.brightnessBy) });
    return t(`command.do.${key}.on`);
  }
  if (action.type === "climate") {
    const key = named ? "thermostat" : "climate";
    const temperature = Number.isFinite(change.temperature) ? formatTemperature(change.temperature) : null;
    if (Number.isFinite(change.temperatureBy)) {
      const way = change.temperatureBy > 0 ? "Warmer" : "Cooler";
      const degrees = formatTemperature(Math.abs(change.temperatureBy));
      return t(`command.do.${key}.${change.setpoint ? `${change.setpoint}${way}` : way.toLowerCase()}`, { degrees });
    }
    if (change.mode === "off") return t(`command.do.${key}.off`);
    if (change.asItWas) return temperature ? t(`command.do.${key}.asItWasTemperature`, { temperature }) : t(`command.do.${key}.asItWas`);
    if (change.setpoint) return t(`command.do.${key}.${change.setpoint}Setpoint`, { temperature });
    if (change.mode && temperature) return t(`command.do.${key}.modeTemperature`, { mode: modeLabel(change.mode), temperature });
    if (change.mode) return t(`command.do.${key}.mode`, { mode: modeLabel(change.mode) });
    return t(`command.do.${key}.temperature`, { temperature });
  }
  if (action.type === "blinds") {
    const key = named ? "blind" : "blinds";
    if (change.stop) return t(`command.do.${key}.stop`);
    if (Number.isFinite(change.positionBy)) return t(`command.do.${key}.${change.positionBy > 0 ? "opener" : "closer"}`, { percent: Math.abs(change.positionBy) });
    if (change.position === 100) return t(`command.do.${key}.open`);
    if (change.position === 0) return t(`command.do.${key}.close`);
    return t(`command.do.${key}.position`, { percent: change.position });
  }
  if (action.type === "fans") {
    const key = named ? "fan" : "fans";
    if (Number.isFinite(change.speedBy)) return t(`command.do.${key}.${change.speedBy > 0 ? "faster" : "slower"}`, { count: Math.abs(change.speedBy) });
    return t(`command.do.${key}.${change.on ? "on" : "off"}`);
  }
  if (action.type === "music") {
    if (Number.isFinite(change.volume)) return t("command.do.music.volume", { percent: change.volume });
    if (Number.isFinite(change.volumeBy)) return t(`command.do.music.${change.volumeBy > 0 ? "louder" : "quieter"}`, { percent: Math.abs(change.volumeBy) });
    return t(`command.do.music.${change.action}`);
  }
  if (action.type === "roomOff") return t("command.do.roomOff");
  if (action.type === "door") return t("command.do.door");
  return "";
}

// What the user sees it understood: "Kitchen: lights off", "Porch light: on", "Run Good night",
// "Turn off everything". `withRoom`: a device's room too, to tell apart the options of a question.
export function describe(action, { withRoom = false } = {}) {
  if (action.type === "scene") return t("command.runScene", { name: isolate(findScene(action.id)?.name || "") });
  if (action.type === "offAll") {
    // "Turn off everything", "Turn off all lights", and with blinds said too, each of them.
    const everything = action.filters.includes("lights") && action.filters.includes("climate");
    const named = everything ? ["everything", ...action.filters.filter((filter) => filter === "blinds")] : action.filters;
    return named.map((filter) => t(`command.off.${filter}`)).join(" · ");
  }
  let what = "";
  if (action.device) {
    const device = deviceOf(action.device);
    what = deviceName(action.device);
    const place = withRoom ? placeOf(device) : "";
    if (place && place !== what) what = t("command.inPlace", { name: isolate(what), room: isolate(place) });
  } else if (action.room != null) {
    what = roomById(action.room) ? roomName(roomById(action.room)) : "";
  }
  return t("command.said", { what: isolate(what), action: doing(action) });
}

// Examples by this user's own names: a room with lights, a room with AC, a scene.
export function commandExamples() {
  const roomWith = (list) => {
    const id = (list || []).map((device) => device.room?.id).find((roomId) => roomId != null && roomById(roomId));
    return id != null ? roomName(roomById(id)) : null;
  };
  const lights = can("member") ? roomWith(state.lights) : null;
  const climate = can("member") ? roomWith(state.thermostats.filter((thermostat) => !isSensor(thermostat))) : null;
  const scene = can("member") ? (state.scenes || [])[0]?.name : null;
  return [
    lights ? t("command.example.lights", { room: lights, inRoom: inRoom(lights) }) : t("command.example.lightsDefault"),
    climate ? t("command.example.climate", { room: climate, inRoom: inRoom(climate) }) : t("command.example.climateDefault"),
    scene ? t("command.example.scene", { name: scene }) : t("command.example.sceneDefault"),
  ];
}

// The words for what the parser could not do.
function problemText(result) {
  const named = result.device ? deviceName(result.device) : "";
  const room = result.room != null && roomById(result.room) ? roomName(roomById(result.room)) : "";
  const examples = commandExamples();
  switch (result.problem) {
    case "needRoom":
      return t("command.problem.needRoom", { example: examples[result.kind === "climate" ? 1 : 0] });
    case "needWhat":
      return t("command.problem.needWhat", { example: examples[result.kind === "climate" ? 1 : 0] });
    case "needLevel":
      return t(`command.problem.needLevel.${result.kind === "music" ? "music" : "light"}`);
    case "none":
      return room ? t(`command.problem.none.${result.kind}`, { room: isolate(room) }) : t(`command.problem.noneHome.${result.kind}`);
    case "range":
      if (result.unit === "percent") return t("command.problem.rangePercent");
      return t("command.problem.range", { name: isolate(named), min: formatTemperature(result.min), max: formatTemperature(result.max) });
    case "cannotDim":
      return named ? t("command.problem.cannotDim", { name: isolate(named) }) : t("command.problem.cannotDimRoom", { room: isolate(room) });
    case "noPosition":
      return named ? t("command.problem.noPosition", { name: isolate(named) }) : t("command.problem.noPositionRoom", { room: isolate(room) });
    case "noSpeeds":
      return named ? t("command.problem.noSpeeds", { name: isolate(named) }) : t("command.problem.noSpeedsRoom", { room: isolate(room) });
    case "noMode":
      return result.mode ? t("command.problem.noMode", { name: isolate(named || room), mode: modeLabel(result.mode) }) : t("command.problem.noModes", { name: isolate(named || room) });
    case "alreadyOn":
      return named ? t("command.problem.alreadyOn", { name: isolate(named) }) : t("command.problem.alreadyOnRoom", { room: isolate(room) });
    case "noDoors":
      return t("command.problem.noDoors");
    case "oneAtATime":
      return t("command.problem.oneAtATime");
    case "question":
      return t("command.problem.question", { example: examples[0] });
    case "heatersOnly":
      return room ? t("command.problem.heatersOnly", { room: isolate(room) }) : t("command.problem.heatersOnlyHome");
    case "isOff":
      return named ? t("command.problem.isOff", { name: isolate(named) }) : t("command.problem.isOffRoom", { room: isolate(room) });
    case "step":
      return t("command.problem.step", { max: formatTemperature(result.max) });
    case "overlap": {
      const what = result.scene ? findScene(result.scene)?.name : named;
      return what ? t("command.problem.overlap", { name: isolate(what) }) : t("command.problem.overlapSame");
    }
    case "oneDoor":
      return t("command.problem.oneDoor");
    case "tooManyParts":
      return t("command.problem.tooManyParts", { count: result.max });
    case "partAsks":
      // A part that would ask: its question and what it could be, to say again more exactly.
      return `${t(`command.ask.${result.question}`)} ${result.options.map((option) => describe(option, { withRoom: true })).join(", ")}.`;
    default:
      return t("command.problem.tooMany");
  }
}

// Lights named for heating that a command leaves as they are where it would have changed them
// (ADR-066): "The heater “דוד הורים” is left as it is.", or "". `named`: the lights another part
// of the sentence changes ("…ואת דוד הורים"), never said to be left.
function heaterNote(action, named = new Set()) {
  let heaters = [];
  if (action.type === "lights" && action.kept?.length) {
    const change = action.change || {};
    const changes = (light) => (change.on === false ? lightIsOn(light) : change.on === true ? !lightIsOn(light) : light.dimmable !== false);
    heaters = action.kept.map((id) => findDevice("light", id)).filter((light) => light && changes(light));
  } else if (action.type === "roomOff") {
    heaters = roomGroup(action.room).lights.filter((light) => lightIsOn(light) && isHeater(light));
  } else if (action.type === "offAll" && action.filters.includes("lights")) {
    heaters = keptHeaters("lights");
  }
  heaters = heaters.filter((light) => !named.has(light.id));
  return heaters.length ? t("command.heatersLeft", { count: heaters.length, names: heaterNames(heaters) }) : "";
}

// What a command says under what it understood: the heaters it leaves as they are, and that a
// room's level or step goes to its dimmers only, its switches left as they are (1.10.3's rule, said
// since 1.11.0), unless another part of the sentence switches them.
function noteOf(action, named = new Set()) {
  const switches = action.type === "lights" ? (action.onOff || []).filter((id) => !named.has(id)) : [];
  return [heaterNote(action, named), switches.length ? t("command.switchesLeft") : ""].filter(Boolean).join(" ");
}

// ---- running ---------------------------------------------------------------------------------

// What a series of device commands did, from the errors they left (controls.js shows each on its
// device too).
function outcome(keys, started) {
  const errors = keys.map((key) => state.errors[key]).filter((error) => error && error.stamp >= started);
  if (!errors.length) return { stage: "done", text: t("command.result.done") };
  const failed = errors.filter((error) => error.text !== t("errors.notConfirmed"));
  if (!failed.length) return { stage: "partial", text: t("command.result.notConfirmed") };
  if (failed.length === keys.length) return { stage: "error", text: t("command.result.failed", { error: failed[0].text }) };
  return { stage: "partial", text: t("command.result.someFailed", { count: failed.length, total: keys.length, error: failed[0].text }) };
}

const NOTHING = () => ({ stage: "done", text: t("command.result.nothing") });

// A thermostat's PATCH for a change the parser made: a target temperature, or with heat and cool
// setpoints the one of its mode (or the one named), the other kept apart (setpoints.js). On as it
// was (1.10.0, ADR-070): one that is off goes back to its last mode, one that is on keeps its own.
// null when there is nothing to send; { refused } (why, in words) when it cannot be done so.
export function thermostatPlan(thermostat, change) {
  if (change.mode === "off" && !climateIsOn(thermostat)) return null;
  let mode = change.mode || null;
  if (change.asItWas && !climateIsOn(thermostat)) {
    mode = lastMode(thermostat);
    if (!mode) return { refused: t("command.problem.noLastMode", { name: isolate(thermostat.name || "") }) };
  }
  const patch = {};
  if (mode) patch.mode = mode;
  if (Number.isFinite(change.temperature)) {
    if (isDual(thermostat)) {
      const current = mode || thermostat.mode;
      const field = change.setpoint ? `${change.setpoint}_setpoint` : current === "heat" ? "heat_setpoint" : current === "cool" ? "cool_setpoint" : null;
      const name = isolate(thermostat.name || "");
      // In auto (it changed since the words were understood): which setpoint is not said.
      if (!field) return { refused: t("command.problem.setpointWhich", { name }) };
      const both = withSetpoint(thermostat, field, change.temperature);
      if (!both) {
        const [low, high] = defaultRange(scaleOf(thermostat), true);
        const min = Number.isFinite(thermostat.target_temperature_min) ? thermostat.target_temperature_min : low;
        const max = Number.isFinite(thermostat.target_temperature_max) ? thermostat.target_temperature_max : high;
        const range = { name, min: formatTemperature(min), max: formatTemperature(max) };
        if (change.temperature < min || change.temperature > max) return { refused: t("command.problem.range", range) };
        // The other setpoint would have to leave the range to stay apart.
        return { refused: t("command.problem.setpointGap", { ...range, temperature: formatTemperature(change.temperature), gap: formatTemperature(setpointGap(thermostat)) }) };
      }
      patch[field] = both[field];
      const other = field === "heat_setpoint" ? "cool_setpoint" : "heat_setpoint";
      if (Number.isFinite(both[other]) && both[other] !== thermostat[other]) patch[other] = both[other];
    } else {
      patch.target_temperature = change.temperature;
    }
  }
  return Object.keys(patch).length ? { patch } : null;
}

// The PATCH alone: null when there is nothing to send or it cannot be sent.
export function thermostatChange(thermostat, change) {
  return thermostatPlan(thermostat, change)?.patch || null;
}

// ---- a change by a step (1.10.0, ADR-066) ------------------------------------------------------

// A light's level a step from where it is, from 1 to 100: a light that is off goes to the step when
// brighter and stays off when dimmer (dimmer never turns one off). null: nothing changes.
export function steppedLevel(light, by) {
  if (!lightIsOn(light)) return by > 0 ? Math.min(100, by) : null;
  const from = Number.isFinite(light.brightness) && light.brightness > 0 ? light.brightness : 100;
  const level = Math.min(100, Math.max(1, Math.round(from + by)));
  return level === from ? null : level;
}

// A thermostat's setpoint a step from where it is (the one of its mode, or the one named with heat
// and cool setpoints), within its range: the change for thermostatPlan; null when it is off (no
// setpoint to move); { refused } when it is at the end of its range or its setpoint is not known.
export function steppedTemperature(thermostat, change) {
  if (!climateIsOn(thermostat)) return null;
  const by = change.temperatureBy;
  const name = isolate(thermostat.name || "");
  const dual = isDual(thermostat);
  const from = dual ? (change.setpoint ? thermostat[`${change.setpoint}_setpoint`] : activeSetpoint(thermostat)) : thermostat.target_temperature;
  if (!Number.isFinite(from)) return { refused: dual && !change.setpoint ? t("command.problem.setpointWhich", { name }) : t("command.problem.noSetpoint", { name }) };
  // In the thermostat's own scale (1.10.2): whole °F in °F.
  const scale = scaleOf(thermostat);
  const [low, high] = defaultRange(scale, dual);
  const min = Number.isFinite(thermostat.target_temperature_min) ? thermostat.target_temperature_min : low;
  const max = Number.isFinite(thermostat.target_temperature_max) ? thermostat.target_temperature_max : high;
  if (by > 0 && from >= max) return { refused: t("command.problem.atHighest", { name, temperature: formatTemperature(from) }) };
  if (by < 0 && from <= min) return { refused: t("command.problem.atLowest", { name, temperature: formatTemperature(from) }) };
  const temperature = Math.min(max, Math.max(min, roundIn(from + by, scale)));
  return change.setpoint ? { setpoint: change.setpoint, temperature } : { temperature };
}

// A Sonos room's volume a step from where it is, from 0 to 100; null when it is not known or
// nothing changes.
export function steppedVolume(item, by) {
  if (!Number.isFinite(item?.volume)) return null;
  const volume = Math.min(100, Math.max(0, Math.round(item.volume + by)));
  return volume === item.volume ? null : volume;
}

// A blind's position a step from where it is (1.11.0, ADR-079), from 0 (closed) to 100 (open):
// from where it is going while it moves, else from where it reports it is. null: nothing changes;
// { refused } when where it is isn't known (never a guess).
export function steppedPosition(blind, by) {
  const name = isolate(blind.name || "");
  if (!canSetPosition(blind)) return { refused: t("command.problem.noPosition", { name }) };
  const view = shadeView(blind, blindMove(blind.id));
  const reported = blind.position_reported !== false && Number.isFinite(blind.position) ? blind.position : null;
  // Moving to where it isn't said: not known either.
  const from = view.moving ? (Number.isFinite(view.target) ? view.target : null) : reported;
  if (from === null) return { refused: t("command.problem.noBlindPosition", { name }) };
  const position = Math.min(100, Math.max(0, Math.round(from + by)));
  return position === Math.round(from) ? null : { position };
}

// A fan's speed a step from where it is, along its own speeds (1.11.0, ADR-079): one that is off
// goes to its lowest speed (or as many up as said) when faster and stays off when slower (slower
// never turns one off). null: nothing changes; { refused } when it lists no speeds or doesn't say
// which one it runs at.
export function steppedSpeed(fan, by) {
  const speeds = fanSpeeds(fan);
  const name = isolate(fan.name || "");
  if (!speeds.length) return { refused: t("command.problem.noSpeeds", { name }) };
  if (!fan.on) return by > 0 ? { speed: speeds[Math.min(by, speeds.length) - 1] } : null;
  if (!Number.isInteger(fan.speed)) return { refused: t("command.problem.speedUnknown", { name }) };
  // The speeds above it when faster, below it when slower (its own, even one it doesn't list).
  const way = by > 0 ? speeds.filter((speed) => speed > fan.speed) : speeds.filter((speed) => speed < fan.speed).reverse();
  return way.length ? { speed: way[Math.min(Math.abs(by), way.length) - 1] } : null;
}

// Each device's request (`plan` gives a function that sends it, null for nothing to change, or
// { refused } with why it cannot be done), then what they did.
async function changeEach(kind, ids, plan) {
  const started = Date.now();
  const keys = [];
  const sent = [];
  const refused = [];
  for (const id of ids) {
    const device = findDevice(kind, id);
    const send = device ? plan(device) : null;
    if (!send) continue;
    if (send.refused) {
      refused.push(send.refused);
      continue;
    }
    keys.push(deviceKey(kind, id));
    sent.push(send());
  }
  if (!sent.length) return refused.length ? { stage: "error", text: refused[0] } : NOTHING();
  await Promise.all(sent);
  const result = outcome(keys, started);
  if (!refused.length || result.stage !== "done") return result;
  return { stage: "partial", text: t("command.result.someFailed", { count: refused.length, total: keys.length + refused.length, error: refused[0] }) };
}

async function runMusic(action) {
  const items = action.ids.map((id) => findMusic(id)).filter(Boolean);
  if (!items.length) return NOTHING();
  const started = Date.now();
  if (Number.isFinite(action.change.volumeBy)) {
    // Louder or quieter: each room's own volume, a step from where it is.
    const sends = items.map((item) => [item, steppedVolume(item, action.change.volumeBy)]).filter(([, volume]) => volume !== null);
    if (!sends.length) return NOTHING();
    await Promise.all(sends.map(([item, volume]) => setMusicLevels(item, { volume })));
    return outcome(sends.map(([item]) => musicKey(item)), started);
  }
  let sent = items;
  if (!Number.isFinite(action.change.volume)) {
    // Play, pause and next act on a room's group: once a group.
    const groups = new Set();
    sent = items.filter((item) => {
      const group = item.group?.id || item.id;
      if (groups.has(group)) return false;
      groups.add(group);
      return true;
    });
  }
  await Promise.all(sent.map((item) => (Number.isFinite(action.change.volume) ? setMusicLevels(item, { volume: action.change.volume }) : musicCommand(item, action.change.action))));
  return outcome(sent.map(musicKey), started);
}

async function runRoomOff(roomId) {
  const group = roomGroup(roomId);
  const keys = [
    // The room's All off (controls.js) leaves lights named for heating as they are (ADR-066).
    ...group.lights.filter((light) => lightIsOn(light) && !isHeater(light)).map((light) => deviceKey("light", light.id)),
    ...(group.fans || []).filter(fanIsOn).map((fan) => deviceKey("fan", fan.id)),
    ...group.thermostats.filter((thermostat) => climateIsOn(thermostat) && (thermostat.modes || []).includes("off")).map((thermostat) => deviceKey("thermostat", thermostat.id)),
  ];
  if (!keys.length) return NOTHING();
  const started = Date.now();
  await allOff(group);
  return outcome(keys, started);
}

// Runs an action the user asked for (the parser's, or an option they chose).
async function perform(action) {
  switch (action.type) {
    case "lights":
      return changeEach("light", action.ids, (light) => {
        if (Number.isFinite(action.change.brightnessBy)) {
          const level = steppedLevel(light, action.change.brightnessBy);
          return level === null ? null : () => setLight(light, { brightness: level });
        }
        if ("on" in action.change && Boolean(light.on) === action.change.on) return null;
        return () => setLight(light, action.change);
      });
    case "climate":
      return changeEach("thermostat", action.ids, (thermostat) => {
        const change = Number.isFinite(action.change.temperatureBy) ? steppedTemperature(thermostat, action.change) : action.change;
        if (!change || change.refused) return change;
        const plan = thermostatPlan(thermostat, change);
        return plan?.patch ? () => setThermostat(thermostat, plan.patch) : plan;
      });
    case "blinds":
      return changeEach("blind", action.ids, (blind) => {
        if (Number.isFinite(action.change.positionBy)) {
          const step = steppedPosition(blind, action.change.positionBy);
          return !step || step.refused ? step : () => setBlind(blind, step.position);
        }
        return action.change.stop ? () => stopBlind(blind) : () => setBlind(blind, action.change.position);
      });
    case "fans":
      return changeEach("fan", action.ids, (fan) => {
        if (Number.isFinite(action.change.speedBy)) {
          const step = steppedSpeed(fan, action.change.speedBy);
          return !step || step.refused ? step : () => setFan(fan, { speed: step.speed });
        }
        return Boolean(fan.on) === action.change.on ? null : () => setFan(fan, action.change);
      });
    case "music":
      return runMusic(action);
    case "roomOff":
      return runRoomOff(action.room);
    default:
      return { stage: "error", text: t("command.result.failed", { error: "" }) };
  }
}

// Turn off all's counts for its confirm ("3 lights on, 1 AC on"), or null when nothing is on.
function offCounts(action) {
  const counts = action.filters.map((filter) => [filter, offTargets(filter).length]).filter(([, count]) => count > 0);
  return counts.length ? counts.map(([filter, count]) => t(`command.off.count.${filter}`, { count })).join(", ") : null;
}

const offNothing = (action) => t(action.filters.length === 1 && action.filters[0] === "blinds" ? "command.off.nothingOpen" : "command.off.nothing");

// A scene run by a command, and what it did (one run from Home's button meanwhile included).
function sceneOutcome(scene) {
  return runScene(scene).then(
    () =>
      new Promise((resolve) => {
        const check = () => {
          const result = ui.sceneRuns[scene.id];
          if (result?.stage === "running") return void window.setTimeout(check, 250);
          resolve(result ? { stage: result.stage === "done" ? "done" : result.stage === "partial" ? "partial" : "error", text: result.text } : NOTHING());
        };
        check();
      })
  );
}

// The door's own Open button in its second tap: the command is its first tap, as everywhere.
function firstTap(device) {
  const map = device.kind === "relay" ? "relayStage" : "doorbellStage";
  const stage = ui[map][device.id];
  if (stage !== "confirm" && stage !== "sending") setStage(map, device.id, "confirm", 5000);
}

// Shows what it understood, then does it (or asks for the second tap), then shows the result.
export function act(action) {
  const said = describe(action);
  const note = noteOf(action);
  if (action.type === "door") {
    // The command is the first tap: the door's own button asks for the second, as everywhere.
    firstTap(action.device);
    return show({ stage: "door", said, action });
  }
  if (action.type === "scene") {
    const scene = findScene(action.id);
    if (!scene) return show({ stage: "error", said, text: t("command.result.failed", { error: "" }) });
    const run = ui.sceneRuns[scene.id];
    if (sceneOpensDoors(scene) && (can("doors") || state.access)) {
      // Its first tap (runScene asks for a second); never a second one from the words alone.
      if (run?.stage !== "confirm" && run?.stage !== "running") runScene(scene);
      return show({ stage: "scene", said, action });
    }
    // Said again while it runs: the run on its way is the one shown.
    if (run?.stage === "running" && current?.stage === "running" && current.action?.id === scene.id) return current;
    const shown = show({ stage: "running", said, action });
    const done = () => {
      if (current?.stamp !== shown.stamp) return;
      const result = ui.sceneRuns[scene.id];
      // Run from elsewhere (Home's button) and still on its way: its result is waited for.
      if (result?.stage === "running") return void window.setTimeout(done, 250);
      settle(shown.stamp, result ? { stage: result.stage === "done" ? "done" : result.stage === "partial" ? "partial" : "error", text: result.text } : NOTHING());
    };
    runScene(scene).then(done);
    return shown;
  }
  if (action.type === "offAll") {
    const text = offCounts(action);
    if (!text) return show({ stage: "done", said, note, text: offNothing(action) });
    const shown = show({ stage: "confirm", said, note, text, action });
    window.setTimeout(() => {
      if (current?.stamp === shown.stamp && current.stage === "confirm") show(null);
    }, CONFIRM_MS);
    return shown;
  }
  const shown = show({ stage: "running", said, note, action });
  perform(action).then(
    (result) => settle(shown.stamp, result),
    () => settle(shown.stamp, { stage: "error", text: t("command.result.failed", { error: "" }) })
  );
  return shown;
}

// ---- two to five things at once (1.10.0, ADR-066; five since 1.11.0, ADR-079) ---------------------

// A part's stage when it is over: then, all of them over, the whole goes after a while.
const OVER = new Set(["done", "cancelled"]);

function whenOver(stamp) {
  if (!current?.parts?.every((part) => OVER.has(part.stage))) return;
  window.setTimeout(() => {
    if (current?.stamp === stamp && current.parts.every((part) => OVER.has(part.stage))) show(null);
  }, RESULT_MS);
}

// One part's result, unless another command came meanwhile.
function settlePart(stamp, index, outcome) {
  if (current?.stamp !== stamp || current.stage !== "several" || !current.parts[index]) return;
  const parts = current.parts.map((part, at) => (at === index ? { ...part, ...outcome } : part));
  current = { ...current, parts };
  if (outcome.text) announce([parts[index].said, outcome.text].join(". "));
  notify();
  whenOver(stamp);
}

// Every part is shown at once with what it understood; each is then done as a tap would, a door's,
// a scene's that opens doors and Turn off all's second tap waiting for the user (the others are
// not held back by them).
export function actAll(actions) {
  const runs = [];
  // The lights each part changes, so that another part's note never says one is left as it is.
  const others = (index) => new Set(actions.flatMap((other, at) => (at !== index && other.type === "lights" ? other.ids : [])));
  const parts = actions.map((action, index) => {
    const part = { said: describe(action), note: noteOf(action, others(index)), action, stage: "running", text: "" };
    if (action.type === "door") {
      firstTap(action.device);
      return { ...part, stage: "door" };
    }
    if (action.type === "scene") {
      const scene = findScene(action.id);
      if (!scene) return { ...part, stage: "error", text: t("command.result.failed", { error: "" }) };
      if (sceneOpensDoors(scene) && (can("doors") || state.access)) {
        const run = ui.sceneRuns[scene.id];
        if (run?.stage !== "confirm" && run?.stage !== "running") runScene(scene);
        return { ...part, stage: "scene" };
      }
      runs.push([index, () => sceneOutcome(scene)]);
      return part;
    }
    if (action.type === "offAll") {
      const text = offCounts(action);
      return text ? { ...part, stage: "confirm", text } : { ...part, stage: "done", text: offNothing(action) };
    }
    runs.push([index, () => perform(action)]);
    return part;
  });
  const shown = show({ stage: "several", said: parts.map((part) => part.said).join(" · "), parts });
  const { stamp } = shown;
  for (const [index, run] of runs) {
    run().then(
      (result) => settlePart(stamp, index, result),
      () => settlePart(stamp, index, { stage: "error", text: t("command.result.failed", { error: "" }) })
    );
  }
  if (parts.some((part) => part.stage === "confirm")) {
    // Turn off all's confirm waits as long as alone, then is not done.
    window.setTimeout(() => {
      (current?.stamp === stamp ? current.parts : []).forEach((part, index) => {
        if (part.stage === "confirm") settlePart(stamp, index, { stage: "cancelled", text: t("command.result.notDone") });
      });
    }, CONFIRM_MS);
  }
  whenOver(stamp);
  return current;
}

// Turn off all for a command, and what it did.
async function turnOffAll(action) {
  await Promise.all(action.filters.map((filter) => turnOffNow(filter)));
  const runs = action.filters.map((filter) => [filter, ui.offRuns[filter]]).filter(([, run]) => run);
  const failed = runs.find(([, run]) => run.stage === "error" || run.stage === "partial");
  if (!failed) return { stage: "done", text: t("command.result.done") };
  const [filter, run] = failed;
  return { stage: "partial", text: run.stage === "error" ? run.text : t(`home.off.failed.${filter}`, { count: run.count }).replace(/:$/, ".") };
}

// Turn off all's second tap, from the command's confirm (`index`: that part of several).
export async function confirmCommand(index = null) {
  if (current?.stage === "several") {
    const part = current.parts[index];
    if (part?.stage !== "confirm") return;
    const { stamp } = current;
    settlePart(stamp, index, { stage: "running", text: "" });
    settlePart(stamp, index, await turnOffAll(part.action));
    return;
  }
  if (current?.stage !== "confirm") return;
  const { stamp, action } = current;
  current = { ...current, stage: "running" };
  notify();
  settle(stamp, await turnOffAll(action));
}

// Cancel on one part's confirm: that part is not done; the others stay as they are.
export function cancelCommandPart(index) {
  if (current?.stage === "several" && current.parts[index]?.stage === "confirm") settlePart(current.stamp, index, { stage: "cancelled", text: t("command.result.cancelled") });
}

// One of a question's options, chosen; true when there was one.
export function chooseOption(index) {
  const option = current?.stage === "ask" ? current.options[index] : null;
  if (option) act(option);
  return Boolean(option);
}

// The words typed or heard (with the speech service's other guesses, the likeliest first):
// understood, asked about, or not understood. Returns what it shows.
export function submitCommand(text, alternatives = []) {
  const said = [text, ...alternatives].map((item) => String(item || "").trim()).filter(Boolean);
  if (!said.length) return show(null);
  if (!can("member")) return show({ stage: "problem", text: t("command.problem.viewOnly") });
  const catalog = commandCatalog();
  const language = currentLanguage();
  const results = said.map((item) => parseCommand(item, catalog, { language }));
  // The likeliest words decide, a question, a problem or a refusal included ("don't", a time: the
  // service's next guess may have left that word out); its other guesses only when it did not
  // understand them at all, and then the likeliest of them that says anything.
  const result = results.find((item) => item.status !== "unknown" || item.refusal) || results[0];
  if (result.status === "ok") return result.actions ? actAll(result.actions) : act(result.action);
  if (result.status === "ask") {
    const withRoom = result.question === "which" || result.question === "partial";
    return show({
      stage: "ask",
      question: result.question,
      text: t(`command.ask.${result.question}`),
      options: result.options,
      labels: result.options.map((option) => describe(option, { withRoom })),
    });
  }
  // A part of several said that is not understood, asks or cannot be done: which one; nothing was.
  const inPart = (words) => (result.part ? t("command.part", { part: isolate(result.part), text: words }) : words);
  if (result.status === "problem") return show({ stage: "problem", text: inPart(problemText(result)) });
  const words = result.words.length ? t("command.unknown", { words: isolate(result.words.join(" ")) }) : t("command.unknownAny");
  return show({ stage: "unknown", text: inPart(words), examples: commandExamples() });
}
