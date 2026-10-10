// Device commands. Every control updates the screen at once (optimistic), sends the PATCH
// (answered 202 with the last reported state), then re-reads the device until the controller
// confirms it. A failed command reverts the change and shows a short error on the device.
// Blinds follow their move instead, which takes far longer (see the blinds section). A refrigerator
// confirms through Samsung's cloud: it is read every 2 s for up to 65 s, then quietly every 5 s for
// 2 minutes more, so that a late confirmation still shows (refrigerators.js).

import { fanChangeConfirmed, optimisticFan } from "./fans.js";
import { isHeater } from "./heaters.js";
import { t } from "./i18n.js";
import {
  CONFIRM_MS as FRIDGE_CONFIRM_MS,
  CONFIRM_POLL_MS as FRIDGE_POLL_MS,
  LATE_MS as FRIDGE_LATE_MS,
  LATE_POLL_MS as FRIDGE_LATE_POLL_MS,
  fridgeChangeConfirmed,
  optimisticFridge,
} from "./refrigerators.js";
import { api, errorText, handleUnauthorized, keyGeneration, keyInUse, noteForbidden, whenForgotten } from "./session.js";
import { activeSetpoint, isDual, sameTemperature, withSetpoint } from "./setpoints.js";
import { MOVE_POLL_MS, REPORT_GAP_MS, afterMove, answered, followMove, followSettle, followsReport, startMove, startSettle } from "./shades.js";
import { KINDS, can, clearError, deviceKey, findDevice, notify, replaceDevice, setError, state, subscribe, ui } from "./state.js";
import { apiChange, defaultRange, inOwnScale, isSensor, roundIn, scaleOf, usualTarget } from "./temperature.js";

const CONFIRM_MS = 5000;
const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function setPending(key, on) {
  if (on) {
    state.pending = { ...state.pending, [key]: (state.pending[key] || 0) + 1 };
  } else {
    const count = (state.pending[key] || 1) - 1;
    const { [key]: _removed, ...rest } = state.pending;
    state.pending = count > 0 ? { ...rest, [key]: count } : rest;
  }
}

function lightChangeConfirmed(light, change) {
  if ("brightness" in change) {
    return Number.isFinite(light.brightness) && Math.abs(light.brightness - change.brightness) <= 3;
  }
  return light.on === change.on;
}

const TEMPERATURE_FIELDS = ["target_temperature", "heat_setpoint", "cool_setpoint"];

function thermostatChangeConfirmed(thermostat, change) {
  return Object.entries(change).every(([field, value]) =>
    TEMPERATURE_FIELDS.includes(field) ? sameTemperature(thermostat[field], value) : thermostat[field] === value
  );
}

const CONFIRMERS = {
  light: lightChangeConfirmed,
  thermostat: thermostatChangeConfirmed,
  fan: fanChangeConfirmed,
  refrigerator: fridgeChangeConfirmed,
};

// How long a kind takes to confirm, and how often it is read meanwhile.
const CONFIRM_TIMES = { refrigerator: { ms: FRIDGE_CONFIRM_MS, poll: FRIDGE_POLL_MS } };

// Changes on their way, per device ("refrigerator:141" -> [change, ...]): a refrigerator's take
// seconds, and one confirmed must not hide another still on its way.
const inFlight = new Map();

function othersOnTheirWay(kind, device, key, change) {
  return (inFlight.get(key) || []).filter((item) => item !== change).reduce((shown, other) => optimistic(kind, shown, other), device);
}

// What is on its way to device `id` of `kind`, as one change ({ sabbath_mode: true }); {} for none.
export function changesOnTheirWay(kind, id) {
  return Object.assign({}, ...(inFlight.get(deviceKey(kind, id)) || []));
}

// Re-reads the device until it reports the change (or 5 s pass). Returns the last state read, or
// null once the key is forgotten, or being forgotten, since `since` (session.js keyGeneration): then
// nothing more is read.
async function waitForConfirmation(kind, id, change, since = keyGeneration()) {
  const timing = CONFIRM_TIMES[kind] || { ms: CONFIRM_MS, poll: 600 };
  const deadline = Date.now() + timing.ms;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(timing.poll);
    if (since !== keyGeneration()) return null;
    last = await api(`${KINDS[kind].path}/${id}`);
    if (since !== keyGeneration()) return null;
    // A thermostat in its own scale, as the change is (temperature.js).
    if (kind === "thermostat") last = inOwnScale(last);
    if (CONFIRMERS[kind](last, change)) {
      return { device: last, confirmed: true };
    }
  }
  return { device: last, confirmed: false };
}

// A refrigerator that did not confirm in time may still do so (its driver sees the change at its
// next poll): read quietly for a while longer, and once it reports the change, show it and take back
// the word that it did not confirm. Stops when the key is forgotten, or being forgotten.
async function followLateConfirmation(kind, id, change, since) {
  const key = deviceKey(kind, id);
  const said = state.errors[key]?.stamp;
  const deadline = Date.now() + FRIDGE_LATE_MS;
  while (Date.now() < deadline) {
    await sleep(FRIDGE_LATE_POLL_MS);
    if (since !== keyGeneration()) return;
    let device;
    try {
      device = await api(`${KINDS[kind].path}/${id}`);
    } catch {
      continue;
    }
    if (since !== keyGeneration()) return;
    if (CONFIRMERS[kind](device, change)) {
      replaceDevice(kind, othersOnTheirWay(kind, device, key, change));
      if (said !== undefined && state.errors[key]?.stamp === said) clearError(key);
      notify();
      return;
    }
  }
}

// Lights keep the name the tests look for.
export function waitForLightConfirmation(lightId, change) {
  return waitForConfirmation("light", lightId, change);
}

// The device as the screen shows it right after `change` was sent (also turn-off.js).
export function optimistic(kind, device, change) {
  if (kind === "light") {
    if ("brightness" in change) {
      return { ...device, brightness: change.brightness, on: change.brightness > 0 };
    }
    return { ...device, on: change.on, brightness: change.on ? device.brightness : device.dimmable ? 0 : null };
  }
  if (kind === "fan") return optimisticFan(device, change);
  if (kind === "refrigerator") return optimisticFridge(device, change);
  const next = { ...device, ...change };
  // With heat and cool setpoints, the target is the setpoint of the mode (a new mode, or new setpoints).
  if (kind === "thermostat" && isDual(next)) next.target_temperature = activeSetpoint(next);
  return next;
}

// before: the device as it was before the first of a series of quick changes (e.g. + + +).
export async function sendChange(kind, id, change, { before } = {}) {
  const key = deviceKey(kind, id);
  const current = findDevice(kind, id);
  if (!current || !can("member")) return;
  const original = before || current;
  const needsConfirmation = !(kind === "light" && "brightness" in change && !current.brightness_reported);

  if (kind === "light" && "brightness" in change) {
    state.sentBrightness = { ...state.sentBrightness, [id]: change.brightness };
  }
  replaceDevice(kind, optimistic(kind, current, change));
  clearError(key);
  setPending(key, true);
  inFlight.set(key, [...(inFlight.get(key) || []), change]);
  // A refrigerator's card says what is on its way, which the device data alone does not show.
  if (kind === "refrigerator") ui.tick += 1;
  notify();

  // Once the key is forgotten, or being forgotten, nothing more is read and the device is left as
  // it is.
  const since = keyGeneration();
  try {
    // A °F thermostat's temperatures go as °F, exactly as chosen (temperature.js).
    const body = kind === "thermostat" ? apiChange(current, change) : change;
    const answer = await api(`${KINDS[kind].path}/${id}`, { method: "PATCH", body });
    if (since !== keyGeneration()) return;
    if (needsConfirmation) {
      const confirmation = await waitForConfirmation(kind, id, change, since);
      if (!confirmation) return;
      const { device, confirmed } = confirmation;
      if (device && confirmed) {
        replaceDevice(kind, othersOnTheirWay(kind, device, key, change));
      } else if (kind === "refrigerator" && device) {
        // Its driver changes a feature only once the refrigerator confirms: what it reports is so.
        replaceDevice(kind, othersOnTheirWay(kind, device, key, change));
        setError(key, t("refrigerators.notConfirmed"));
        followLateConfirmation(kind, id, change, since);
      } else if (!confirmed) {
        // Sent, but not reported back yet: keep what was sent and say so.
        setError(key, t("errors.notConfirmed"));
      }
    } else if (answer && typeof answer === "object" && answer.id === id) {
      replaceDevice(kind, { ...answer, brightness: change.brightness, on: change.brightness > 0 });
    }
  } catch (error) {
    if (since !== keyGeneration()) return;
    if (error?.status === 401) {
      handleUnauthorized(error);
      return;
    }
    noteForbidden(error);
    const now = findDevice(kind, id);
    if (now) {
      const reverted = { ...now };
      for (const field of Object.keys(optimistic(kind, original, change))) {
        reverted[field] = original[field];
      }
      replaceDevice(kind, reverted);
    }
    if (kind === "light" && "brightness" in change) {
      const { [id]: _removed, ...rest } = state.sentBrightness;
      state.sentBrightness = rest;
    }
    setError(key, errorText(error) || t("errors.commandFailed"));
  } finally {
    const left = (inFlight.get(key) || []).filter((item) => item !== change);
    if (left.length) inFlight.set(key, left);
    else inFlight.delete(key);
    if (kind === "refrigerator") ui.tick += 1;
    setPending(key, false);
    notify();
  }
}

export function setLight(light, change) {
  return sendChange("light", light.id, change);
}

// {"on": true | false} or {"speed": 1-4} (fans.js levelChange).
export function setFan(fan, change) {
  return sendChange("fan", fan.id, change);
}

// {"sabbath_mode": true}: a refrigerator's feature on or off (refrigerators.js).
export function setRefrigerator(fridge, change) {
  return sendChange("refrigerator", fridge.id, change);
}

// Target temperature − / +: the screen follows every tap; the command goes out once the
// taps stop, so five quick taps send one PATCH.
const nudges = new Map();

// What one tap on − / + changes: { field: value }, plus the other setpoint when a heat or cool
// setpoint pushes it to keep the thermostat's gap; null when the tap changes nothing (at a limit).
// `shown`: the thermostat with the values the taps so far have reached.
export function nudgedChange(shown, delta, field = "target_temperature") {
  // A sensor has nothing to set (1.10.2).
  if (isSensor(shown)) return null;
  const from = shown[field];
  const base = Number.isFinite(from)
    ? from
    : Number.isFinite(shown.current_temperature)
      ? Math.round(shown.current_temperature)
      : usualTarget(scaleOf(shown));
  const value = clampTarget(shown, base + delta);
  if (value === from) return null;
  if (field === "target_temperature") return { target_temperature: value };
  const both = withSetpoint(shown, field, value);
  if (!both) return null;
  const change = { [field]: value };
  const other = field === "heat_setpoint" ? "cool_setpoint" : "heat_setpoint";
  if (Number.isFinite(both[other]) && both[other] !== shown[other]) change[other] = both[other];
  return change;
}

// field: "target_temperature", or "heat_setpoint" / "cool_setpoint" on a thermostat with both.
export function nudgeTarget(thermostat, delta, field = "target_temperature") {
  const id = thermostat.id;
  const current = findDevice("thermostat", id);
  if (!current || !can("member")) return;
  let entry = nudges.get(id);
  const first = !entry;
  if (first) {
    entry = { before: { ...current }, timer: null, change: {} };
  }
  // During a series of taps, from the values they have reached: a confirmation of another change
  // (fan, mode) may have put the controller's older values back on screen meanwhile.
  const change = nudgedChange({ ...current, ...entry.change }, delta, field);
  if (!change) {
    return;
  }
  entry.change = { ...entry.change, ...change };
  replaceDevice("thermostat", optimistic("thermostat", current, entry.change));
  if (first) {
    setPending(deviceKey("thermostat", id), true);
  }
  notify();
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(async () => {
    nudges.delete(id);
    const latest = findDevice("thermostat", id);
    setPending(deviceKey("thermostat", id), false);
    if (latest) {
      // One PATCH with everything the taps changed, e.g. { heat_setpoint, cool_setpoint } after a push.
      await sendChange("thermostat", id, entry.change, { before: entry.before });
    }
  }, 700);
  nudges.set(id, entry);
}

// Within the thermostat's range, in what it is set in: 0.5 °C, or whole °F (1.10.2).
export function clampTarget(thermostat, value) {
  const scale = scaleOf(thermostat);
  const [low, high] = defaultRange(scale, false);
  const min = Number.isFinite(thermostat.target_temperature_min) ? thermostat.target_temperature_min : low;
  const max = Number.isFinite(thermostat.target_temperature_max) ? thermostat.target_temperature_max : high;
  return Math.min(max, Math.max(min, roundIn(value, scale)));
}

export function setThermostat(thermostat, change) {
  return sendChange("thermostat", thermostat.id, change);
}

// ---- blinds -------------------------------------------------------------------------------------
// A shade takes 10 to 70 seconds to get where it was sent, and the controller may report the
// position it left until it stops. After a command the app shows where the shade goes (shades.js),
// reads the blinds every 2 s while one moves (also one someone else set moving, for as long as a
// move takes), and shows the reported position once it has stopped, reading a few seconds more.

const moves = new Map(); // blind id -> the move the app expects (shades.js startMove)
const settling = new Map(); // blind id -> the reads after Stop or a move (shades.js startSettle)
const reportsMotion = new Set(); // blinds seen reporting moving: their stops can be believed
const movingSince = new Map(); // blind id -> since when it reports moving, without a break
const lastCommand = new Map(); // blind id -> number of the last command sent to it
let movePoll = null;
let lastBlinds = null; // the list of blinds last followed (every read brings a new one), and when
let lastBlindsAt = 0;

// What the app expects of blind `id`, for shades.js shadeView: its move, or the reads after Stop.
export function blindMove(id) {
  return moves.get(Number(id)) || settling.get(Number(id)) || null;
}

// A move starting or ending changes the screen without new data from the controller: ui.tick
// makes the next render draw it.
function setMove(id, move) {
  const had = moves.has(id);
  if (move) moves.set(id, move);
  else moves.delete(id);
  if (move || had) ui.tick += 1;
}

function setSettle(id, settle) {
  const had = settling.has(id);
  if (settle) settling.set(id, settle);
  else settling.delete(id);
  if (settle || had) ui.tick += 1;
}

// Every read of the blinds takes each move along (or ends it). `readAt`: when the read started, for
// the reads made here; a report is taken over a command only from a read after its answer. A move
// of a shade that left the list (removed in Composer) ends. After a gap in the reads, the time the
// shades have been reported moving starts over (REPORT_GAP_MS).
function followBlinds(now = Date.now(), readAt = null) {
  if (state.blinds !== lastBlinds) {
    if (now - lastBlindsAt >= REPORT_GAP_MS) movingSince.clear();
    lastBlinds = state.blinds;
    lastBlindsAt = now;
  }
  const listed = new Map(state.blinds.map((blind) => [blind.id, blind]));
  for (const blind of state.blinds) {
    if (blind.moving !== true) {
      movingSince.delete(blind.id);
    } else {
      reportsMotion.add(blind.id);
      if (!movingSince.has(blind.id)) movingSince.set(blind.id, now);
    }
  }
  for (const id of movingSince.keys()) {
    if (!listed.has(id)) movingSince.delete(id);
  }
  for (const [id, move] of moves) {
    const blind = listed.get(id);
    const next = blind ? followMove(move, blind, now, readAt) : null;
    if (next === move) continue;
    setMove(id, next);
    if (!next && blind) setSettle(id, afterMove(move, now));
  }
  for (const [id, settle] of settling) {
    const blind = listed.get(id);
    const next = blind ? followSettle(settle, blind, now, readAt) : null;
    if (next !== settle) setSettle(id, next);
  }
}

function blindsMoving(now = Date.now()) {
  return moves.size > 0 || settling.size > 0 || state.blinds.some((blind) => followsReport(blind, movingSince.get(blind.id), now));
}

function scheduleMovePoll() {
  if (movePoll || !keyInUse() || state.status !== "connected" || document.hidden || !blindsMoving()) return;
  movePoll = window.setTimeout(async () => {
    // The key may have been forgotten since (or is being forgotten), or the connection lost.
    if (!keyInUse() || state.status !== "connected") {
      movePoll = null;
      return;
    }
    const readAt = Date.now();
    let read = false;
    try {
      const list = await api(KINDS.blind.path);
      if (Array.isArray(list?.items)) {
        state.blinds = list.items;
        read = true;
      }
    } catch (error) {
      if (error?.status === 401) handleUnauthorized(error);
      // Otherwise the next read, or the refresh every 10 s, catches up.
    } finally {
      movePoll = null;
      followBlinds(Date.now(), read ? readAt : null);
      notify();
      scheduleMovePoll();
    }
  }, MOVE_POLL_MS);
}

// Reads made elsewhere (the refresh every 10 s, a page coming back into view) count too: a shade
// someone else set moving is then read every 2 s until it stops.
subscribe(() => {
  followBlinds();
  scheduleMovePoll();
});

// This browser's key is forgotten (Settings, or a revoked key): nothing is followed any more.
whenForgotten(() => {
  window.clearTimeout(movePoll);
  movePoll = null;
  moves.clear();
  settling.clear();
  reportsMotion.clear();
  movingSince.clear();
  lastCommand.clear();
});

function blindErrorText(error) {
  if (error?.code === "POSITION_NOT_SUPPORTED") return t("blinds.positionNotSupported");
  if (error?.code === "STOP_NOT_SUPPORTED") return t("blinds.stopNotSupported");
  return errorText(error) || t("errors.commandFailed");
}

// The command's answer is the shade as last reported, from before it heard of the command.
function useAnswer(id, answer) {
  if (answer && typeof answer === "object" && answer.id === id) replaceDevice("blind", answer);
}

// Sends a command to blind `id`. When it fails, `undo` puts the move back as it was, unless a newer
// command to the same blind was sent meanwhile; when it is answered, `done(now)` marks the time.
async function blindCommand(id, path, options, undo, done) {
  const key = deviceKey("blind", id);
  const number = (lastCommand.get(id) || 0) + 1;
  lastCommand.set(id, number);
  try {
    useAnswer(id, await api(path, options));
    if (lastCommand.get(id) === number) done(Date.now());
  } catch (error) {
    if (lastCommand.get(id) === number) undo();
    if (error?.status === 401) {
      handleUnauthorized(error);
      return;
    }
    noteForbidden(error);
    setError(key, blindErrorText(error));
    // The shade's setup changed since the app read it: read it again for the right controls.
    if (error?.status === 409) {
      api(`${KINDS.blind.path}/${id}`).then(
        (fresh) => {
          useAnswer(id, fresh);
          notify();
        },
        () => {}
      );
    }
  } finally {
    notify();
    scheduleMovePoll();
  }
}

export function setBlind(blind, position) {
  const current = findDevice("blind", blind.id);
  if (!current || !can("member")) return Promise.resolve();
  const id = current.id;
  const previous = moves.get(id) || null;
  setMove(id, startMove(current, position, Date.now(), reportsMotion.has(id)));
  setSettle(id, null);
  clearError(deviceKey("blind", id));
  notify();
  return blindCommand(
    id,
    `${KINDS.blind.path}/${id}`,
    { method: "PATCH", body: { position } },
    () => setMove(id, previous),
    (now) => moves.has(id) && setMove(id, answered(moves.get(id), now))
  );
}

// Blinds sent to `position` by one request for them all (Home's Close all, turn-off.js): each is
// followed as after its own command. Returns what to call once the answer is in, with the ids of
// the blinds that did not take it: their moves are put back as they were.
export function sendingBlinds(blinds, position) {
  const now = Date.now();
  const sent = [];
  for (const blind of blinds) {
    const current = findDevice("blind", blind.id);
    if (!current || !can("member")) continue;
    const id = current.id;
    const number = (lastCommand.get(id) || 0) + 1;
    lastCommand.set(id, number);
    sent.push({ id, number, previous: moves.get(id) || null });
    setMove(id, startMove(current, position, now, reportsMotion.has(id)));
    setSettle(id, null);
    clearError(deviceKey("blind", id));
  }
  notify();
  return (refused = new Set()) => {
    const answeredAt = Date.now();
    for (const { id, number, previous } of sent) {
      // A newer command to the same blind was sent meanwhile: it has the say.
      if (lastCommand.get(id) !== number) continue;
      if (refused.has(id)) setMove(id, previous);
      else if (moves.has(id)) setMove(id, answered(moves.get(id), answeredAt));
    }
    notify();
    scheduleMovePoll();
  };
}

// It stops where it is: the app shows the shade as stopped, then where it reports it stopped, and
// reads it for a few seconds.
export function stopBlind(blind) {
  if (!can("member")) return Promise.resolve();
  const id = blind.id;
  const move = moves.get(id) || null;
  const settle = settling.get(id) || null;
  setMove(id, null);
  setSettle(id, startSettle(Date.now(), true));
  clearError(deviceKey("blind", id));
  notify();
  return blindCommand(
    id,
    `${KINDS.blind.path}/${id}/stop`,
    { method: "POST" },
    () => {
      setSettle(id, settle);
      setMove(id, move);
    },
    (now) => settling.has(id) && setSettle(id, answered(settling.get(id), now))
  );
}

// Room "All off": lights, air conditioning and fans off; lights named for heating stay as they are.
export function allOff(group) {
  const commands = [];
  for (const light of group.lights) {
    // Lights named for heating are left as they are: only their own switch changes them (ADR-066).
    if (light.on && !isHeater(light)) commands.push(setLight(light, { on: false }));
  }
  for (const fan of group.fans || []) {
    if (fan.on) commands.push(setFan(fan, { on: false }));
  }
  for (const thermostat of group.thermostats) {
    if (thermostat.mode && thermostat.mode !== "off" && thermostat.modes.includes("off")) {
      commands.push(setThermostat(thermostat, { mode: "off" }));
    }
  }
  return Promise.all(commands);
}

// Doors and gates, and the gate at a doorbell: the Open button asks for a second tap within a
// few seconds, then sends the command and shows "Opening…" / "Sent". Relays pulse
// (POST /v1/relays/{id}/pulse); doorbells press their button (POST /v1/doorbells/{id}/open).
// Home's Turn off all asks for its second tap the same way (turn-off.js).
const stageTimers = new Map();

// ui[map][id] = stage (null takes it out), taken out again after `clearAfter` ms when given.
export function setStage(map, id, stage, clearAfter) {
  const timerKey = `${map}:${id}`;
  window.clearTimeout(stageTimers.get(timerKey));
  if (stage) {
    ui[map] = { ...ui[map], [id]: stage };
  } else {
    const { [id]: _removed, ...rest } = ui[map];
    ui[map] = rest;
  }
  if (clearAfter) {
    stageTimers.set(timerKey, window.setTimeout(() => setStage(map, id, null), clearAfter));
  }
  notify();
}

async function pressOpen({ map, kind, id, path, body, onDone }) {
  const stage = ui[map][id];
  if (stage === "sending" || !can("doors")) {
    return;
  }
  if (stage !== "confirm") {
    clearError(deviceKey(kind, id));
    setStage(map, id, "confirm", 5000);
    return;
  }
  setStage(map, id, "sending");
  try {
    const result = await api(path, body ? { method: "POST", body } : { method: "POST" });
    if (onDone) onDone(result);
    setStage(map, id, "sent", 3000);
  } catch (error) {
    if (error?.status === 401) {
      handleUnauthorized(error);
      return;
    }
    setStage(map, id, null);
    noteForbidden(error);
    setError(deviceKey(kind, id), errorText(error));
  }
}

export function cancelRelay(relay) {
  setStage("relayStage", relay.id, null);
}

// `doorbell`: opened from that doorbell's ring screen or banner (1.11.0, ADR-078): the door's own
// Open all the same, which History says came from the doorbell.
export function pressRelay(relay, { doorbell = null } = {}) {
  const body = Number.isInteger(doorbell?.id) ? { doorbell: doorbell.id } : undefined;
  return pressOpen({ map: "relayStage", kind: "relay", id: relay.id, path: `/v1/relays/${relay.id}/pulse`, body });
}

export function cancelDoorbell(doorbell) {
  setStage("doorbellStage", doorbell.id, null);
}

// The 202 answer is the doorbell as last reported.
export function pressDoorbell(doorbell) {
  return pressOpen({
    map: "doorbellStage",
    kind: "doorbell",
    id: doorbell.id,
    path: `/v1/doorbells/${doorbell.id}/open`,
    onDone: (updated) => {
      if (updated && typeof updated === "object" && updated.id === doorbell.id) replaceDevice("doorbell", updated);
    },
  });
}
