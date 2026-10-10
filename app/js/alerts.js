// Alerts on this device (ADR-047, ADR-050): notifications from DirectorLink's servers (Web Push), also
// when the app is closed. Switched on and off only from Settings → Alerts (on Settings → Controller
// before 1.10.0), which is also the only place that asks for permission.
//
// With DirectorLink 1.7.0 on the controller (features.alert_choices), every role may have them: the
// controller decides who gets what (a doorbell rang, a camera saw someone (1.8.0), a door or gate
// was opened, the refrigerator's door was left open, a schedule failed) by each key's role and its
// own choices, which this device keeps on the controller (GET and PUT /v1/alerts/choices), and
// sends each alert sealed to the keys it is for. The browser is registered with this device's key
// id; admins may also have the servers' own alert when the home is offline (`offline`), and (1.8.0)
// their push when a new device of their account asks to join (`device_requests`, on by default).
// For the service worker (sw.js) this keeps, in
// Cache Storage, the words in this device's language and this device's alert key, which opens what
// was sealed to it and nothing else: never the lock key or the API key. With an older controller,
// alerts are for admins only, and say only their kind and time (ADR-047). Tapping one opens the
// doorbell on Home, the camera's full view, the refrigerator's room, or Settings → Controller →
// History (sw.js).

import { ACCOUNTS_API } from "./account.js";
import { currentLanguage, languageInfo, t } from "./i18n.js";
import { deriveLock, toBase64 } from "./lock.js";
import { IS_IOS } from "./platform.js";
import { savedRemote } from "./remote.js";
import { api, checkInThroughAccount, keyInUse, whenForgotten } from "./session.js";
import { can, notify, state, subscribe } from "./state.js";

const ALERTS_KEY = "directorlink.alerts"; // { home, endpoint, keyId, offline, deviceRequests }: this browser gets that home's alerts
// { home, keyId }: this device's alerts went off (the browser dropped its subscription, or the
// permission) and that home's controller is still to be told (1.9.0, ADR-062): until then it would
// count this device as asked by an ask-to-open link.
const LOST_KEY = "directorlink.alerts.lost";
// Where the service worker finds the words and the alert key (sw.js uses the same names).
export const TEXTS_CACHE = "directorlink-alerts";
export const TEXTS_PATH = "/alert-texts.json";
export const KEY_PATH = "/alert-key.json";
// The alert key of a device: HMAC-SHA256(its lock key, ALERT_LABEL) (driver: src/cloud/alerts.lua).
export const ALERT_LABEL = "DirectorLink alert v1";
// What the controller alerts about, in the order Settings lists them; offline is the servers' own.
export const ALERT_KINDS = ["doorbell", "camera", "door_opened", "fridge_door", "schedule_failed"];
// What a camera alert can say it saw (the labels of DirectorLink's camera agreement, ADR-065, and
// the DirectorLink · Hikvision Camera driver's detections, ADR-056; since 1.11.0 the sounds a camera
// hears, ADR-080); anything else is "other".
export const CAMERA_DETECTIONS = [
  "person",
  "vehicle",
  "animal",
  "package",
  "license_plate",
  "face",
  "motion",
  "line_crossing",
  "intrusion",
  "region_entrance",
  "region_exiting",
  "tamper",
  "scene_change",
  "object_left",
  "object_removed",
  "alarm_input",
  "pir",
  "smoke_alarm",
  "co_alarm",
  "siren",
  "baby_crying",
  "speech",
  "barking",
  "burglar_alarm",
  "car_horn",
  "glass_break",
  "other",
];
const TIMEOUT_MS = 10000;

// What Settings shows: busy while switching; message: { kind, key } once done (the text is
// alerts.settings.<key>, in the language shown); choices: this key's choices on the controller
// ({ on, kinds }; null until read); saving: the kind being changed.
export const alertsUi = { busy: false, message: null, choices: null, saving: null };
// The registration was made again since the page opened (refreshAlerts), or just now.
let refreshed = false;
// The controller was asked for this key's choices (and told that alerts are on) since the page
// opened; when it was last tried, so that a controller out of reach is not asked at every redraw.
let choicesRead = false;
let choicesTried = 0;
const CHOICES_RETRY_MS = 60000;

function remembered() {
  try {
    const value = JSON.parse(localStorage.getItem(ALERTS_KEY) || "null");
    return value && /^[0-9a-f]{32}$/.test(value.home) && typeof value.endpoint === "string" ? value : null;
  } catch {
    return null;
  }
}

// The home and key id this browser gets alerts for (sealed to that key), or null while alerts are off
// here: what the ring's doors kept for the service worker are about (js/doorbell-doors.js, 1.11.0).
export function alertsHome() {
  const saved = remembered();
  return saved && /^[0-9a-f]{8}$/.test(saved.keyId || "") ? { home: saved.home, keyId: saved.keyId } : null;
}

function remember(value) {
  try {
    if (value) {
      const kept = { home: value.home, endpoint: value.endpoint, keyId: value.keyId, offline: value.offline !== false, deviceRequests: value.deviceRequests !== false };
      localStorage.setItem(ALERTS_KEY, JSON.stringify(kept));
    }
    else localStorage.removeItem(ALERTS_KEY);
  } catch {
    // Blocked storage: the switch shows off next time; the alerts still come.
  }
}

function lostNote() {
  try {
    const value = JSON.parse(localStorage.getItem(LOST_KEY) || "null");
    return value && /^[0-9a-f]{32}$/.test(value.home) ? value : null;
  } catch {
    return null;
  }
}

function noteLost(value) {
  try {
    if (value) localStorage.setItem(LOST_KEY, JSON.stringify({ home: value.home, keyId: value.keyId || null }));
    else localStorage.removeItem(LOST_KEY);
  } catch {
    // Blocked storage: the account service tells the controller (ADR-062).
  }
}

// Opened from the Home Screen (or installed on a computer or Android).
function installed() {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // No media queries here.
  }
  return navigator.standalone === true;
}

// "ok"; "denied" (notifications are blocked for the site); on iPhone and iPad "homeScreen" (only the
// app added to the Home Screen gets them, iOS 16.4 or later) or "iosVersion" (added, but an older
// iOS); else "unsupported".
export function alertsSupport() {
  const push = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
  if (!push) {
    if (!IS_IOS) return "unsupported";
    return installed() ? "iosVersion" : "homeScreen";
  }
  return Notification.permission === "denied" ? "denied" : "ok";
}

// The controller seals its alerts to each key and lets every key choose (DirectorLink 1.7.0).
export function controllerChooses() {
  return state.system?.features?.alert_choices === true;
}

// Whose key may have alerts, once signed in to an account: anyone's, when the controller chooses;
// else admins'. Settings shows its Alerts row to them (1.10.0).
export function alertsForKey() {
  return Boolean(state.role) && (controllerChooses() || can("admin"));
}

// Who may switch alerts on: anyone signed in with a key, when the controller chooses; else admins.
export function alertsAllowed() {
  return alertsForKey() && state.account.status === "signed-in";
}

// Whether this browser gets the alerts of the home this device is linked to.
export function alertsOn() {
  const saved = remembered();
  return Boolean(saved && saved.home === savedRemote()?.home && alertsSupport() === "ok" && Notification.permission === "granted");
}

// Whether this browser wants the servers' offline alert (admins).
export function offlineAlertsOn() {
  return remembered()?.offline !== false;
}

// Whether this browser wants the servers' push when a new device of this account asks to join
// (admins; 1.8.0, on by default).
export function deviceRequestAlertsOn() {
  return remembered()?.deviceRequests !== false;
}

// What Settings → Alerts and its row show of it, for app.js's redraws.
export function alertsSignature() {
  return [alertsOn(), alertsSupport(), alertsUi.busy, alertsUi.message, alertsUi.choices, alertsUi.saving, offlineAlertsOn(), deviceRequestAlertsOn()];
}

// The words the service worker shows, in this device's language. {time} and the names are filled in
// there.
export function alertTexts() {
  const home = t("alerts.yourHome");
  return {
    lang: currentLanguage(),
    dir: languageInfo().dir,
    title: t("alerts.title"),
    offline: t("alerts.offline", { home }),
    schedule_failed: t("alerts.scheduleFailed", { home }),
    schedule_failed_named: t("alerts.scheduleFailedNamed", { home }),
    other: t("alerts.other", { home }),
    doorbell_title: t("doorbells.notificationTitle"),
    doorbell: t("alerts.doorbell"),
    // A ring's button where the browser shows them (1.11.0, ADR-078): it opens the doorbell's screen.
    doorbell_open_door: t("alerts.openDoorAction"),
    door_opened: t("alerts.doorOpened"),
    door_opened_scene: t("alerts.doorOpenedScene"),
    door_opened_control4: t("alerts.doorOpenedControl4"),
    door_held: t("alerts.doorHeld"),
    who: t("alerts.who"),
    unknown_device: t("history.who.unknownDevice"),
    fridge_door: t("alerts.fridgeDoor"),
    fridge_door_now: t("alerts.fridgeDoorNow"),
    device_request: t("alerts.deviceRequest"),
    // Ask before opening (1.8.0, ADR-058): the question an ask-to-open link sends its person.
    open_request_title: t("alerts.openRequestTitle"),
    open_request: t("alerts.openRequest"),
    open_request_unnamed: t("alerts.openRequestUnnamed"),
    camera_title: t("alerts.cameraTitle"),
    camera: t("alerts.camera"),
    ...Object.fromEntries(CAMERA_DETECTIONS.map((what) => [`camera_${what}`, t(`alerts.cameraSaw.${what}`)])),
  };
}

async function saveTexts() {
  try {
    const cache = await caches.open(TEXTS_CACHE);
    await cache.put(TEXTS_PATH, new Response(JSON.stringify(alertTexts()), { headers: { "content-type": "application/json" } }));
  } catch {
    // The service worker then uses English.
  }
}

function hexBytes(hex) {
  return Uint8Array.from(hex.match(/../g) || [], (pair) => parseInt(pair, 16));
}

// This device's alert key (32 bytes) from its API key: HMAC-SHA256(lock key, ALERT_LABEL).
export async function alertKey(apiKey) {
  const lock = await deriveLock(apiKey);
  const key = await crypto.subtle.importKey("raw", hexBytes(lock.lockHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ALERT_LABEL)));
}

// Keeps the alert key of this device's key for the service worker (or drops it: `keyId` null).
async function saveAlertKey(home, keyId) {
  try {
    const cache = await caches.open(TEXTS_CACHE);
    if (!keyId || !state.apiKey) {
      await cache.delete(KEY_PATH);
      return;
    }
    const value = { home, key: keyId, alert_key: toBase64(await alertKey(state.apiKey)) };
    await cache.put(KEY_PATH, new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
  } catch {
    // The service worker then shows what was sealed in general words.
  }
}

function withTimeout(promise) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
  });
  return Promise.race([promise, late]).finally(() => window.clearTimeout(timer));
}

// GET, POST or DELETE /v1/homes/{home}/alerts at the account service: { status, data }.
async function cloud(method, home, body) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${ACCOUNTS_API}/v1/homes/${home}/alerts`, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  } finally {
    window.clearTimeout(timer);
  }
}

function keyBytes(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function sameKey(buffer, bytes) {
  const current = buffer ? new Uint8Array(buffer) : null;
  return Boolean(current && current.length === bytes.length && current.every((value, index) => value === bytes[index]));
}

// This browser's push subscription for `publicKey` (the account service's VAPID key): the one it
// has, or a new one (also when the service's key was replaced).
async function browserSubscription(registration, publicKey) {
  const bytes = keyBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, bytes)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  return subscription || registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
}

// Registers the subscription with this device's key (the account service checks that this account
// uses it at the home), whether it wants the offline alert, and whether a new device of this account
// asking to join (1.8.0; the account service pushes it to admin keys' browsers only).
function register(home, subscription, keyId, offline = true, deviceRequests = true) {
  const { endpoint, keys } = subscription.toJSON();
  return cloud("POST", home, { endpoint, keys, key_id: keyId, offline, device_requests: deviceRequests });
}

// Registered; when the account service did not know yet that this account uses the key (it
// learns it from a request sealed through the account), after one such request, again. When that
// request did not reach the home (offline, Remote Access off), the refusal says so (`unreachable`).
async function registered(home, subscription, keyId, offline, deviceRequests) {
  let result = await register(home, subscription, keyId, offline, deviceRequests);
  if (result.status === 403 && (result.data?.code === "KEY_NOT_LINKED" || result.data?.code === "ADMIN_ONLY")) {
    if ((await checkInThroughAccount(true)) === false) return { ...result, unreachable: true };
    result = await register(home, subscription, keyId, offline, deviceRequests);
  }
  return result;
}

function refusal(result) {
  if (result?.unreachable) return "unreachable";
  switch (result?.data?.code) {
    case "ADMIN_ONLY":
      return "adminOnly";
    case "ROLES_UNKNOWN":
      return "needsUpdate";
    case "ALERTS_NOT_CONFIGURED":
      return "notAvailable";
    case "NOT_SIGNED_IN":
      return "signIn";
    case "NOT_A_MEMBER":
    case "KEY_NOT_LINKED":
      return "notLinked";
    default:
      return "failed";
  }
}

function finish(kind, key) {
  alertsUi.busy = false;
  alertsUi.message = key ? { kind, key } : null;
  notify();
}

// Tells the controller that this device's alerts are on or off (DirectorLink 1.7.0); its choices
// come back. Throws when it could not. One after another, so that the last said is the last heard.
let telling = Promise.resolve();
function tellController(on) {
  const told = telling.then(() => api("/v1/alerts/choices", { method: "PUT", body: { on } }));
  telling = told.catch(() => null);
  return told.then((choices) => {
    alertsUi.choices = choices;
    choicesRead = true;
    return choices;
  });
}

// Tells the controller that this device's alerts are off, while this device has its key there and
// is linked to that home. When it cannot be told now (its system is not read yet, or it is out of
// reach), it is told once it can (tellLost; 1.9.0, ADR-062): until then it would count this device
// as asked by an ask-to-open link.
async function tellOff(home, keyId) {
  if (!keyInUse() || !home || home !== savedRemote()?.home) return;
  if (state.system && !controllerChooses()) return; // a controller before 1.7.0 keeps no "on"
  if (controllerChooses()) {
    try {
      await tellController(false);
      noteLost(null);
      return;
    } catch {
      // Told once it can be.
    }
  }
  noteLost({ home, keyId });
}

// What tellOff could not tell (lostNote), once this device reaches the controller with the same
// key; tried again a minute later. Alerts on again, another home or another key end it.
let lostTried = 0;
let lostTelling = false;
async function tellLost() {
  const note = lostNote();
  if (!note || lostTelling || alertsUi.busy) return;
  const remote = savedRemote();
  if (remembered()?.home === note.home || remote?.home !== note.home || (note.keyId && remote.keyId !== note.keyId)) {
    noteLost(null);
    return;
  }
  if (!keyInUse() || !state.system || !state.role || state.status !== "connected" || Date.now() - lostTried < CHOICES_RETRY_MS) return;
  if (!controllerChooses()) {
    noteLost(null);
    return;
  }
  lostTelling = true;
  lostTried = Date.now();
  try {
    await tellController(false);
    noteLost(null);
  } catch (error) {
    // Refused by the controller itself (its key is gone, say): nothing left to tell. Out of reach,
    // or the account's own refusal: a minute later.
    if (error?.sealed && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) noteLost(null);
  } finally {
    lostTelling = false;
  }
  notify();
}

// This browser lost its subscription, or may no longer have it: the switch shows off, the account
// service forgets it (and tells the controller too, ADR-062), and so does this device (tellOff).
async function lose(saved, keyId) {
  await cloud("DELETE", saved.home, { endpoint: saved.endpoint }).catch(() => null);
  remember(null);
  await saveAlertKey(null, null);
  await tellOff(saved.home, keyId);
}

// The switch, turned on: permission (asked only here), this browser's subscription, registered
// with the account service for the home this device is linked to, and the controller told.
export async function turnAlertsOn() {
  const remote = savedRemote();
  if (alertsUi.busy || !remote || alertsSupport() !== "ok") return;
  alertsUi.busy = true;
  alertsUi.message = null;
  notify();
  try {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") {
      finish("error", "blocked");
      return;
    }
    const key = await cloud("GET", remote.home);
    if (key.status !== 200 || typeof key.data?.public_key !== "string") {
      finish("error", refusal(key));
      return;
    }
    const registration = await withTimeout(navigator.serviceWorker.ready);
    const subscription = await browserSubscription(registration, key.data.public_key);
    const result = await registered(remote.home, subscription, remote.keyId, true, true);
    if (result.status !== 201) {
      await subscription.unsubscribe().catch(() => {});
      finish("error", refusal(result));
      return;
    }
    if (controllerChooses()) {
      try {
        await tellController(true);
      } catch {
        // Without the controller nothing it seals would come: not on, then.
        await cloud("DELETE", remote.home, { endpoint: subscription.endpoint }).catch(() => null);
        await subscription.unsubscribe().catch(() => {});
        finish("error", "failed");
        return;
      }
    }
    remember({ home: remote.home, endpoint: subscription.endpoint, keyId: remote.keyId, offline: true, deviceRequests: true });
    noteLost(null);
    await Promise.all([saveTexts(), saveAlertKey(remote.home, remote.keyId)]);
    refreshed = true;
    finish("success", "turnedOn");
  } catch {
    finish("error", "failed");
  }
}

// The switch, turned off; also when this device signs out, forgets its key or is linked to another
// home, or the browser no longer lets it have them (`quiet`: nothing to say). The account service
// forgets this browser, and the browser drops its subscription, so nothing arrives even if the first
// could not be reached; the controller is told, while this device still has its key there, so that
// it seals nothing more for it (since 1.9.0 also later, when it cannot be told now: tellOff).
export async function turnAlertsOff({ quiet = false } = {}) {
  const saved = remembered();
  if (quiet ? !saved : alertsUi.busy) return;
  if (!quiet) {
    alertsUi.busy = true;
    alertsUi.message = null;
    notify();
  }
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const subscription = await registration?.pushManager?.getSubscription();
    const endpoint = subscription?.endpoint || saved?.endpoint;
    if (saved && endpoint) await cloud("DELETE", saved.home, { endpoint }).catch(() => null);
    await subscription?.unsubscribe();
  } catch {
    // Unsubscribed or not, the switch is off: the account service drops a browser its push
    // service no longer knows.
  }
  remember(null);
  await saveAlertKey(null, null);
  await tellOff(saved?.home, saved?.keyId || savedRemote()?.keyId);
  if (quiet) {
    alertsUi.choices = null;
    choicesRead = false;
    notify();
  } else finish("info", "turnedOff");
}

// A kind switched on or off on Settings: the controller keeps it (`offline` and `device_requests`:
// the account service, with this browser's registration).
export async function chooseAlert(kind, on) {
  const saved = remembered();
  if (!saved || alertsUi.saving) return;
  alertsUi.saving = kind;
  alertsUi.message = null;
  notify();
  try {
    if (kind === "offline" || kind === "device_requests") {
      const registration = await withTimeout(navigator.serviceWorker.ready);
      const subscription = await registration.pushManager.getSubscription();
      const offline = kind === "offline" ? on : saved.offline !== false;
      const deviceRequests = kind === "device_requests" ? on : saved.deviceRequests !== false;
      const result = subscription ? await registered(saved.home, subscription, saved.keyId || savedRemote()?.keyId, offline, deviceRequests) : { status: 0 };
      if (result.status !== 201) throw new Error("not registered");
      remember({ ...saved, offline, deviceRequests });
    } else {
      alertsUi.choices = await api("/v1/alerts/choices", { method: "PUT", body: { kinds: { [kind]: on } } });
    }
  } catch {
    alertsUi.message = { kind: "error", key: "choicesFailed" };
  }
  alertsUi.saving = null;
  notify();
}

// This key's choices, from the controller; and, if it does not know that this device has alerts on
// (an app before 1.7.0 switched them on, a restored controller), it is told.
async function readChoices() {
  choicesRead = true;
  choicesTried = Date.now();
  try {
    const choices = await api("/v1/alerts/choices");
    // Alerts that went meanwhile (lose) are not said to be on again.
    alertsUi.choices = choices?.on || !remembered() ? choices : await tellController(true);
  } catch {
    choicesRead = false; // asked again a minute later
  }
  notify();
}

// Once per start, signed in: the registration is made again (the browser may have a new
// subscription, the account service a new key), or ended when this device may no longer have it.
async function refreshAlerts() {
  const saved = remembered();
  if (!saved) return;
  const remote = savedRemote();
  if (saved.home !== remote?.home || alertsSupport() !== "ok" || Notification.permission !== "granted") {
    await turnAlertsOff({ quiet: true });
    return;
  }
  try {
    const key = await cloud("GET", saved.home);
    if (key.status === 403) {
      await turnAlertsOff({ quiet: true });
      return;
    }
    if (key.status !== 200 || typeof key.data?.public_key !== "string") return; // asked again next time
    const registration = await withTimeout(navigator.serviceWorker.ready);
    let subscription;
    try {
      subscription = await browserSubscription(registration, key.data.public_key);
    } catch {
      // The browser dropped it and will not make another without a tap: the switch shows off, and
      // the controller is told (1.9.0).
      await lose(saved, remote.keyId);
      notify();
      return;
    }
    const result = await registered(saved.home, subscription, remote.keyId, saved.offline !== false, saved.deviceRequests !== false);
    if (result.status === 201) {
      if (subscription.endpoint !== saved.endpoint) {
        await cloud("DELETE", saved.home, { endpoint: saved.endpoint }).catch(() => null);
      }
      remember({ ...saved, endpoint: subscription.endpoint, keyId: remote.keyId });
      await Promise.all([saveTexts(), saveAlertKey(saved.home, remote.keyId)]);
    } else if (result.status === 403 || result.status === 409) {
      await subscription.unsubscribe().catch(() => {});
      await lose(saved, remote.keyId);
      alertsUi.message = { kind: "info", key: refusal(result) };
    }
  } catch {
    // Offline, or the push service is: next time.
  }
  notify();
}

// The words follow the app's language; the registration is renewed once signed in, and the
// controller's choices read once it says it has them.
let textsLanguage = null;
subscribe(() => {
  if (lostNote()) tellLost();
  if (!remembered()) return;
  if (textsLanguage !== currentLanguage()) {
    textsLanguage = currentLanguage();
    saveTexts();
  }
  if (!refreshed && state.account.status === "signed-in") {
    refreshed = true;
    refreshAlerts();
  }
  if (!choicesRead && controllerChooses() && state.role && state.status === "connected" && Date.now() - choicesTried > CHOICES_RETRY_MS) {
    readChoices();
  }
});

// A forgotten key ends this device's alerts (it may belong to someone else next).
whenForgotten(() => {
  noteLost(null);
  return turnAlertsOff({ quiet: true });
});

// The browser replaced or dropped its push subscription (sw.js, pushsubscriptionchange; 1.9.0): the
// registration is made again, or the switch shows off and the controller is told.
try {
  navigator.serviceWorker?.addEventListener?.("message", (event) => {
    if (event.data?.type !== "directorlink-push-changed" || !remembered()) return;
    refreshed = false;
    notify();
  });
} catch {
  // No service worker here: nothing to hear.
}
