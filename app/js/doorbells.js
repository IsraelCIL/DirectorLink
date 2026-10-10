// Doorbells (DoorBird): noticing rings, the "Someone is at the door" banner, and browser
// notifications while the app is open. The ring rules themselves are in rings.js.

import { t } from "./i18n.js";
import { ringIsRecent } from "./rings.js";
import { can, findDevice, notify, state } from "./state.js";

const DISMISSED_PREFIX = "directorlink.doorbellDismissed.";
const NOTIFY_KEY = "directorlink.doorbellNotifications";

// Per doorbell: the last_ring_at this page knows, and when it first saw it change
// (null for the value that was already there when the page loaded).
const seen = new Map();

function read(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice lasts for this visit only.
  }
}

function dismissedRings() {
  try {
    const value = JSON.parse(read(DISMISSED_PREFIX + (state.host || "default"), "{}"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

// Whether last_ring_at `value` is a ring after `known` (the one this page knows): a later time. One
// that goes back (DirectorLink restarted and took an older time from the doorbell's driver) is not.
function rangSince(value, known) {
  if (!value || value === known) return false;
  const before = Date.parse(known);
  if (!Number.isFinite(before)) return true;
  return Date.parse(value) > before;
}

// Called with every fresh /v1/doorbells list. Returns the doorbells that rang since the last
// look (a later last_ring_at), which is what a notification is for.
export function trackRings(doorbells) {
  const now = Date.now();
  const rang = [];
  for (const doorbell of doorbells) {
    const known = seen.get(doorbell.id);
    if (!known) {
      seen.set(doorbell.id, { value: doorbell.last_ring_at, noticedAt: null });
    } else if (rangSince(doorbell.last_ring_at, known.value)) {
      seen.set(doorbell.id, { value: doorbell.last_ring_at, noticedAt: now });
      rang.push(doorbell);
    }
  }
  return rang;
}

export function ringIsActive(doorbell, now = Date.now()) {
  if (!doorbell?.last_ring_at) return false;
  if (dismissedRings()[doorbell.id] === doorbell.last_ring_at) return false;
  const known = seen.get(doorbell.id);
  const noticedAt = known && known.value === doorbell.last_ring_at ? known.noticedAt : null;
  return ringIsRecent(doorbell.last_ring_at, { now, noticedAt });
}

// When the ring happened, for "Rang 1 minute ago": when this page saw it arrive if it did (so a
// controller clock that is off does not matter), else the controller's time.
export function ringTime(doorbell) {
  const known = seen.get(doorbell?.id);
  if (known && known.value === doorbell.last_ring_at && Number.isFinite(known.noticedAt)) return known.noticedAt;
  return Date.parse(doorbell?.last_ring_at);
}

// Doorbells someone is standing at: rang within the last 2 minutes and not dismissed.
export function ringingDoorbells() {
  return state.doorbells.filter((doorbell) => ringIsActive(doorbell));
}

// Dismiss hides the banner for this ring only; the next ring shows it again.
export function dismissRing(doorbell) {
  const dismissed = dismissedRings();
  const ids = new Set(state.doorbells.map((item) => String(item.id)));
  const kept = Object.fromEntries(Object.entries(dismissed).filter(([id]) => ids.has(id)));
  kept[doorbell.id] = doorbell.last_ring_at;
  write(DISMISSED_PREFIX + (state.host || "default"), JSON.stringify(kept));
  notify();
}

// The doorbell's camera as a camera object (from /v1/cameras when it is there).
export function doorbellCamera(doorbell) {
  if (!doorbell?.camera) return null;
  const camera = state.cameras.find((item) => item.id === doorbell.camera.id);
  return camera || { id: doorbell.camera.id, name: doorbell.name, room: doorbell.room, snapshot_href: doorbell.camera.snapshot_href };
}

// ---- notifications (Settings → App → Doorbell notifications) -------------------------------

export function notificationSupport() {
  if (!("Notification" in window) || !window.isSecureContext) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

export function notificationsOn() {
  return notificationSupport() === "granted" && read(NOTIFY_KEY, "off") === "on";
}

// Only ever asked from the Settings button, never on its own.
export async function enableNotifications() {
  if (notificationSupport() === "unsupported") return "unsupported";
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  write(NOTIFY_KEY, permission === "granted" ? "on" : "off");
  notify();
  return permission;
}

export function disableNotifications() {
  write(NOTIFY_KEY, "off");
  notify();
}

// Where the browser shows a notification's buttons: "Open <door>…" for each door at the doorbell this
// user may open (1.11.0, ADR-078; as sw.js does for the alert). Each opens the doorbell's screen.
function ringActions(doorbell) {
  const most = Math.min(Number(globalThis.Notification?.maxActions) || 0, 2);
  if (most < 1 || !can("doors") || !Array.isArray(doorbell.doors)) return [];
  return doorbell.doors
    .filter((item) => item.can_open === true)
    .map((item) => findDevice("relay", item.id))
    .filter(Boolean)
    .slice(0, most)
    .map((door) => ({ action: `door-${door.id}`, title: t("alerts.openDoorAction", { name: door.name }) }));
}

// A notification for each ring while the app is open but not in front (the banner shows it
// otherwise). With the app closed, the controller's alert says it (Web Push, ADR-050, sw.js), with
// the same tag; a ring that alert shows already is not shown again. Its tap opens the doorbell's
// screen (1.11.0).
export async function notifyRings(doorbells) {
  if (!doorbells.length || !notificationsOn()) return;
  if (!document.hidden && document.hasFocus()) return;
  for (const doorbell of doorbells) {
    const title = t("doorbells.notificationTitle");
    const options = {
      body: t("doorbells.notificationBody", { name: doorbell.name }),
      tag: `doorbell-${doorbell.id}`,
      renotify: true,
      icon: "/icons/icon-192.png",
      data: { url: `/#/doorbell/${doorbell.id}`, ring: doorbell.last_ring_at },
    };
    const actions = ringActions(doorbell);
    try {
      // Installed apps and Android need the service worker to show notifications.
      const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (registration?.showNotification) {
        const shown = registration.getNotifications ? await registration.getNotifications({ tag: options.tag }).catch(() => []) : [];
        if (!shown.some((item) => item.data?.ring === doorbell.last_ring_at)) await registration.showNotification(title, actions.length ? { ...options, actions } : options);
        continue;
      }
      const notification = new Notification(title, options);
      notification.onclick = () => {
        window.focus();
        window.location.hash = `#/doorbell/${doorbell.id}`;
        notification.close();
      };
    } catch (error) {
      console.warn("DirectorLink could not show a doorbell notification", error);
    }
  }
}
