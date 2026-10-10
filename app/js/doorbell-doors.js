// The doors and gates at a doorbell (1.11.0, ADR-078): the gate whose controller is on the doorbell's
// own relay (found by the controller), and the doors an admin linked. When it rings, its screen
// (views/doorbell.js) and Home's banner show a big "Open <door>" for each that this user may open:
// the door's own Open, with its two taps (controls.js pressRelay), never the doorbell's. A driver
// before 1.11.0 sends no `doors`: nothing of this shows.
//
// For the service worker (sw.js), while this device has alerts on, this keeps in Cache Storage
// (next to the alerts' words and key, js/alerts.js) which doors each doorbell has that this user may
// open, by name, and its camera: a ring's notification then offers "Open <door>…" where the browser
// shows buttons (it opens the doorbell's screen, never the door), and the screen asks for the
// picture at once. Nothing of it leaves the device; the sealed alert is unchanged.

import { alertsHome, TEXTS_CACHE } from "./alerts.js";
import { cancelRelay, pressRelay } from "./controls.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";
import { icon } from "./icons.js";
import { api, errorText, handleUnauthorized, noteForbidden, whenForgotten } from "./session.js";
import { can, findDevice, notify, replaceDevice, state, subscribe, ui } from "./state.js";

export const RING_DOORS_PATH = "/ring-doors.json";
// The doors one doorbell's notification names, at most (browsers show two buttons, some one).
export const MAX_ACTIONS = 2;

const isolate = (text) => `⁨${text ?? ""}⁩`;

// Whether the controller says which doors are at its doorbells (DirectorLink 1.11.0).
export function doorsKnown(doorbell) {
  return Array.isArray(doorbell?.doors);
}

// The doors at `doorbell` that this app shows: { id, link, can_open, door } (the door as /v1/relays
// lists it), in the controller's order.
export function doorsAt(doorbell) {
  if (!doorsKnown(doorbell)) return [];
  return doorbell.doors.map((item) => ({ ...item, door: findDevice("relay", item.id) })).filter((item) => item.door);
}

// The ones this user may open now (their permissions, the door's room, Door Control: the controller
// says it per door).
export function openableDoors(doorbell) {
  if (!can("doors")) return [];
  return doorsAt(doorbell).filter((item) => item.can_open === true);
}

// What to say when the doorbell has a door (or its own button) and this user may open none of it:
// that opening needs door access; or, for a user with doors and gates whom the controller still
// lets open none (Door Control off in Composer), that. Null otherwise.
export function doorNote(doorbell) {
  if (openableDoors(doorbell).length) return null;
  if (!can("doors")) return doorbell?.can_open || doorsAt(doorbell).length ? t("doorbells.noAccess") : null;
  return !doorbell?.can_open && doorsAt(doorbell).length ? t("errors.doorsDisabled") : null;
}

function doorButtonLabel(door) {
  const stage = ui.relayStage[door.id];
  if (stage === "confirm") return t("relays.confirm");
  if (stage === "sending") return t("relays.opening");
  if (stage === "sent") return t("relays.sent");
  return t("doorbells.openDoor", { name: isolate(door.name) });
}

// "Open Entrance Gate": the first tap asks for a second ("Tap again to open"), the second opens it,
// as the door's own row does; `place` keeps the screen's and the banner's buttons apart.
export function doorButton(doorbell, door, { place = "screen" } = {}) {
  const stage = ui.relayStage[door.id] || "";
  return h(
    "button",
    {
      type: "button",
      class: `relay-button relay-button-large doorbell-door ${stage ? `is-${stage}` : ""}`.trim(),
      "aria-label": stage ? `${doorButtonLabel(door)} — ${door.name}` : doorButtonLabel(door),
      dataset: { key: `doorbell:${doorbell.id}:door:${door.id}:${place}` },
      disabled: stage === "sending",
      onclick: (event) => {
        event.stopPropagation();
        pressRelay(door, { doorbell });
      },
    },
    icon(stage === "sent" ? "check" : "door"),
    h("span", {}, doorButtonLabel(door))
  );
}

// Each door this user may open, and Cancel while one waits for its second tap.
export function doorButtons(doorbell, { place = "screen" } = {}) {
  const doors = openableDoors(doorbell).map((item) => item.door);
  if (!doors.length) return [];
  const waiting = doors.find((door) => ui.relayStage[door.id] === "confirm");
  return [
    ...doors.map((door) => doorButton(doorbell, door, { place })),
    waiting
      ? h(
          "button",
          { type: "button", class: "button button-quiet", dataset: { key: `doorbell:${doorbell.id}:door:${waiting.id}:cancel:${place}` }, onclick: () => cancelRelay(waiting) },
          t("common.cancel")
        )
      : null,
  ];
}

// ---- an admin links doors (the doorbell's screen) -----------------------------------------------

// The doors an admin linked (the controller found the others itself).
export function linkedIds(doorbell) {
  return (doorbell?.doors || []).filter((item) => item.link === "manual").map((item) => item.id);
}

// PUT /v1/doorbells/{id}/doors with the doors linked from now on; the answer is the doorbell.
export async function setLinkedDoors(doorbell, ids) {
  ui.doorbellLinks = { id: doorbell.id, busy: true, message: null };
  notify();
  try {
    const updated = await api(`/v1/doorbells/${doorbell.id}/doors`, { method: "PUT", body: { door_ids: ids } });
    if (updated && typeof updated === "object" && updated.id === doorbell.id) replaceDevice("doorbell", updated);
    ui.doorbellLinks = { id: doorbell.id, busy: false, message: null };
  } catch (error) {
    if (error?.status === 401) {
      handleUnauthorized(error);
      return;
    }
    noteForbidden(error);
    ui.doorbellLinks = { id: doorbell.id, busy: false, message: errorText(error) };
  }
  notify();
}

// ---- for the service worker ----------------------------------------------------------------------

// { home, key, doorbells: { "<id>": { camera, doors: [{ id, name }] } } } while this device has alerts
// on; null otherwise.
export function ringDoors() {
  const home = alertsHome();
  if (!home || !state.loaded) return null;
  const doorbells = {};
  for (const doorbell of state.doorbells) {
    const doors = openableDoors(doorbell).map((item) => ({ id: item.door.id, name: item.door.name }));
    const camera = Number.isInteger(doorbell.camera?.id) ? doorbell.camera.id : null;
    if (doors.length || camera) doorbells[doorbell.id] = { camera, doors };
  }
  return { home: home.home, key: home.keyId, doorbells };
}

let written = null;

async function saveRingDoors(value) {
  const text = value ? JSON.stringify(value) : "";
  if (text === written) return;
  written = text;
  try {
    const cache = await caches.open(TEXTS_CACHE);
    if (value) await cache.put(RING_DOORS_PATH, new Response(text, { headers: { "content-type": "application/json" } }));
    else await cache.delete(RING_DOORS_PATH);
  } catch {
    // No Cache Storage: the notification has no button, and the screen waits for the doorbells.
    written = null;
  }
}

// The doorbell's camera as this device last kept it (the ring's screen opened by a notification asks
// for its picture before the doorbells are read), or null.
export async function keptRingCamera(doorbellId) {
  try {
    const saved = await (await caches.open(TEXTS_CACHE)).match(RING_DOORS_PATH);
    const value = saved ? await saved.json() : null;
    const home = alertsHome();
    if (!value || !home || value.home !== home.home || value.key !== home.keyId) return null;
    const camera = value.doorbells?.[doorbellId]?.camera;
    return Number.isInteger(camera) && camera > 0 ? camera : null;
  } catch {
    return null;
  }
}

if (typeof caches !== "undefined") {
  subscribe(() => {
    const value = ringDoors();
    // Kept until alerts go off or the key is forgotten; a hiccup (not loaded) changes nothing.
    if (value || !alertsHome()) saveRingDoors(value);
  });
  whenForgotten(() => saveRingDoors(null));
}
