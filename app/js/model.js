// Derived data: room names in the chosen language, devices grouped by room, what is "on".

import { SPEED_NAMES } from "./fans.js";
import { currentLanguage, formatTemperature, formatTemperatureRange, t } from "./i18n.js";
import { zones } from "./refrigerators.js";
import { isDual } from "./setpoints.js";
import { movingText, shadeView } from "./shades.js";
import { state } from "./state.js";
import { projectScale } from "./temperature.js";

// Devices without a room are collected under this id.
export const NO_ROOM = 0;

export function roomById(id) {
  return state.rooms.find((room) => room.id === Number(id)) || null;
}

// names: { en: "Living room", he: "סלון" } from Settings → Rooms; falls back to the Control4 name.
export function roomName(roomOrRef) {
  if (!roomOrRef) {
    return t("rooms.noRoom");
  }
  const room = roomById(roomOrRef.id) || roomOrRef;
  const localized = room.names && typeof room.names === "object" ? room.names[currentLanguage()] : "";
  return localized || room.name || t("rooms.unnamed", { id: room.id });
}

export function deviceRoomId(device) {
  return device?.room?.id ?? NO_ROOM;
}

export function lightIsOn(light) {
  return Boolean(light.on);
}

export function climateIsOn(thermostat) {
  return Boolean(thermostat.mode) && thermostat.mode !== "off";
}

// The mode a thermostat that is off goes back to "as it was" (1.10.0, ADR-070): its last mode that
// was not off, as the controller remembers it (`last_mode`), when it is one the thermostat can be
// set to; null when not known (a driver before 1.10.0 says none).
export function lastMode(thermostat) {
  const mode = thermostat?.last_mode;
  return typeof mode === "string" && mode !== "off" && (thermostat.modes || []).includes(mode) ? mode : null;
}

export function fanIsOn(fan) {
  return Boolean(fan.on);
}

// "Medium High": a fan speed's name (1 low to 4 high).
export function fanSpeedLabel(speed) {
  const key = SPEED_NAMES[speed - 1];
  return key ? t(`fans.speeds.${key}`) : t("fans.speedNumber", { speed });
}

// "Off", "On · Medium", or "On" while the fan reports no speed.
export function fanStateLabel(fan) {
  if (!fan.on) return t("fans.off");
  return Number.isInteger(fan.speed) ? t("fans.onAt", { speed: fanSpeedLabel(fan.speed) }) : t("fans.on");
}

// "3° · −18°": a refrigerator's fridge and freezer temperatures, the ones it reports.
export function fridgeTemperatures(fridge) {
  return zones(fridge, projectScale(state.system))
    .filter((zone) => zone.temperature !== null)
    .map((zone) => formatTemperature(zone.temperature))
    .join(" · ");
}

// A door or gate in a line (1.10.0, ADR-069): what it is, a Relay Door, Gate or Garage Door
// Controller's kind ("Gate"), else "Door or gate", and open or closed when the controller's contact
// says ("Gate · Closed"). A driver before 1.10.0 sends neither.
const RELAY_KINDS = ["door", "gate", "garage_door"];
const DOOR_STATES = ["open", "closed", "partly_open"];

export function relayLabel(relay) {
  const kind = RELAY_KINDS.includes(relay?.kind) ? relay.kind : null;
  if (!kind) return t("relays.hint");
  const door = DOOR_STATES.includes(relay.door_state) ? t(`relays.states.${kind}.${relay.door_state}`) : "";
  return door ? `${t(`relays.kinds.${kind}`)} · ${door}` : t(`relays.kinds.${kind}`);
}

export function relayIsOpen(relay) {
  return relay?.door_state === "open" || relay?.door_state === "partly_open";
}

// A refrigerator in a line: offline, its door open, or its temperatures (and the door closed).
export function fridgeStateLabel(fridge) {
  if (!fridge.online) return t("refrigerators.offline");
  if (fridge.door_open === true) return t("refrigerators.doorOpen");
  return fridgeTemperatures(fridge) || (fridge.door_open === false ? t("refrigerators.doorClosed") : "");
}

export function blindIsOpen(blind) {
  return Number.isFinite(blind.position) && blind.position > 0;
}

// Sonos rooms (music.js, 1.5.0) as devices of the room they are shown in; none while Sonos is off.
export function musicDevices() {
  if (state.system?.features?.sonos !== true || !state.music?.enabled) return [];
  return state.music.items.map((item) => ({ ...item, room: item.room_id != null ? { id: item.room_id } : null }));
}

// The ids of what this app shows: its devices, and the alarm's partitions while Home shows them.
function shownIds() {
  const lists = [state.lights, state.thermostats, state.fans, state.blinds, state.cameras, state.relays, state.doorbells, state.refrigerators];
  const ids = new Set(lists.flatMap((list) => (list || []).map((device) => device.id)));
  if (state.alarm?.enabled === true) for (const partition of state.alarm.partitions || []) ids.add(partition.id);
  return ids;
}

// A device this app cannot control, unless it is shown already: part of a device shown (1.10.1,
// `part_of`: a door controller's button shown as the KNX relay it drives, a DoorBird's button), an
// alarm partition shown on Home, or (1.11.0, ADR-080, `part_of_music`) a proxy of Control4's own
// Sonos driver while DirectorLink plays those players itself (Music). A driver before 1.10.1 says no
// `part_of`, one before 1.11.0 no `part_of_music`.
export function otherDevices(roomId) {
  const id = Number(roomId);
  const shown = shownIds();
  const music = state.system?.features?.sonos === true;
  return state.devices.filter(
    (device) =>
      !device.supported &&
      deviceRoomId(device) === id &&
      !shown.has(device.id) &&
      !(device.part_of != null && shown.has(device.part_of)) &&
      !(music && device.part_of_music === true)
  );
}

export function devicesInRoom(roomId) {
  const id = Number(roomId);
  const pick = (list) => list.filter((device) => deviceRoomId(device) === id);
  return {
    lights: pick(state.lights),
    thermostats: pick(state.thermostats),
    fans: pick(state.fans),
    blinds: pick(state.blinds),
    cameras: pick(state.cameras),
    relays: pick(state.relays),
    doorbells: pick(state.doorbells),
    refrigerators: pick(state.refrigerators || []),
    music: pick(musicDevices()),
    // Devices this app cannot control, and does not show otherwise.
    others: otherDevices(id),
  };
}

function controllableCount(group) {
  return (
    group.lights.length +
    group.thermostats.length +
    group.fans.length +
    group.blinds.length +
    group.cameras.length +
    group.relays.length +
    group.doorbells.length +
    (group.refrigerators?.length || 0) +
    (group.music?.length || 0)
  );
}

// The rooms this person hides from their lists (their profile, profile.js).
export function hiddenRoomIds() {
  return new Set((state.profile?.prefs?.hidden_rooms || []).map(Number));
}

// Rooms that have something to control, in the home's order, without the ones this person hides,
// plus "No room" when needed.
export function visibleRooms() {
  const hidden = hiddenRoomIds();
  const rooms = state.rooms
    .filter((room) => !hidden.has(room.id))
    .map((room) => ({ room, group: devicesInRoom(room.id) }))
    .filter((entry) => controllableCount(entry.group) > 0);
  const known = new Set(state.rooms.map((room) => room.id));
  const orphan = (device) => !known.has(deviceRoomId(device));
  const orphans = {
    lights: state.lights.filter(orphan),
    thermostats: state.thermostats.filter(orphan),
    fans: state.fans.filter(orphan),
    blinds: state.blinds.filter(orphan),
    cameras: state.cameras.filter(orphan),
    relays: state.relays.filter(orphan),
    doorbells: state.doorbells.filter(orphan),
    refrigerators: (state.refrigerators || []).filter(orphan),
    // A Sonos room whose name matches no room, until an admin picks one.
    music: musicDevices().filter(orphan),
    others: [],
  };
  if (controllableCount(orphans) > 0) {
    rooms.push({ room: { id: NO_ROOM, name: t("rooms.noRoom") }, group: orphans });
  }
  return rooms;
}

export function roomGroup(roomId) {
  const id = Number(roomId);
  if (id === NO_ROOM) {
    return visibleRooms().find((entry) => entry.room.id === NO_ROOM)?.group || devicesInRoom(NO_ROOM);
  }
  return devicesInRoom(id);
}

export function summaryCounts() {
  return {
    lightsOn: state.lights.filter(lightIsOn).length,
    climateOn: state.thermostats.filter(climateIsOn).length,
    blindsOpen: state.blinds.filter(blindIsOpen).length,
  };
}

export function matchesFilter(group, filter) {
  if (filter === "lights") return group.lights.some(lightIsOn);
  if (filter === "climate") return group.thermostats.some(climateIsOn);
  if (filter === "blinds") return group.blinds.some(blindIsOpen);
  return true;
}

// A translated label, or the value itself when the controller reports something unexpected.
export function labelOr(key, value) {
  const label = t(key);
  return label === key ? String(value).charAt(0).toUpperCase() + String(value).slice(1) : label;
}

export function modeLabel(mode) {
  return mode ? labelOr(`climate.modes.${mode}`, mode) : t("climate.modeUnknown");
}

export function fanLabel(speed) {
  return labelOr(`climate.fans.${speed}`, speed);
}

// A temperature sensor's reading in a line (1.10.2): "73° · 30%", "—" when it reports none.
export function sensorText(thermostat) {
  const parts = [formatTemperature(thermostat.current_temperature)];
  if (Number.isFinite(thermostat.humidity)) parts.push(t("common.percent", { percent: Math.round(thermostat.humidity) }));
  return parts.join(" · ");
}

// The temperature a thermostat works to, for tiles and summaries: "24°", or "20°–24°" for a
// thermostat with heat and cool setpoints in auto (or off), which has no single target then.
export function targetText(thermostat) {
  if (isDual(thermostat) && thermostat.mode !== "heat" && thermostat.mode !== "cool") {
    const { heat_setpoint: heat, cool_setpoint: cool } = thermostat;
    if (Number.isFinite(heat) && Number.isFinite(cool)) return formatTemperatureRange(heat, cool);
    // Only one of them reported (or the thermostat has only one).
    if (Number.isFinite(heat) || Number.isFinite(cool)) return formatTemperature(Number.isFinite(heat) ? heat : cool);
  }
  return formatTemperature(thermostat.target_temperature);
}

// "Opening… to 53%" while the shade moves (it says so, or `move`: a command the app sent, from
// controls.js blindMove); otherwise where it is, or that its position is not known.
export function blindStateLabel(blind, move = null) {
  const view = shadeView(blind, move);
  if (view.moving) {
    const text = movingText(view);
    return t(text.key, { percent: text.percent });
  }
  if (!Number.isFinite(blind.position)) {
    return t("blinds.unknown");
  }
  if (blind.position === 0) return t("blinds.closed");
  if (blind.position === 100) return t("blinds.open");
  return t("blinds.percentOpen", { percent: blind.position });
}

// Brightness to show: reported level, or what was last sent to a light that does not report it.
export function shownBrightness(light) {
  const sent = state.sentBrightness[light.id];
  if (!light.brightness_reported && Number.isFinite(sent)) {
    return sent;
  }
  if (Number.isFinite(light.brightness)) {
    return light.brightness;
  }
  return light.on ? 100 : 0;
}
