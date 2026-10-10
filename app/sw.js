// Offline shell for the DirectorLink app.
// Same-origin GET requests are network-first with a short timeout and fall back to the cache,
// so the app still opens when the internet is down but the home LAN (and the controller) is up.
// Requests to the controller are cross-origin and are never intercepted.
// It also shows alerts (push), and opens the app where a notification's tap leads.

const CACHE_NAME = "directorlink-shell-v47";
const NETWORK_TIMEOUT_MS = 3000;

// Each page is stored under every path that serves it: Cloudflare redirects /index.html -> /,
// while a plain static server does not. (The API console is its own site, console.directorlink.io.)
const PAGES = [{ source: "/", paths: ["/", "/index.html"] }];

const ASSETS = [
  "/styles.css",
  "/theme-boot.js",
  "/app.js",
  "/api-client.js",
  "/js/account.js",
  "/js/alerts.js",
  "/js/views/alerts.js",
  "/js/alarm.js",
  "/js/music.js",
  "/js/views/music.js",
  "/js/backup.js",
  "/js/cloud-backup.js",
  "/js/views/cloud-backup.js",
  "/js/lock.js",
  "/js/cpace.js",
  "/js/device-join.js",
  "/js/views/device-join.js",
  "/js/direct.js",
  "/js/views/direct.js",
  "/js/platform.js",
  "/js/qr.js",
  "/js/remote.js",
  "/js/reorder.js",
  "/js/vendor/qrcodegen.js",
  "/js/views/join.js",
  "/js/home-screen.js",
  "/js/views/move.js",
  "/js/views/access.js",
  "/js/views/device-limit.js",
  "/js/views/permissions.js",
  "/js/views/scenes.js",
  "/js/scenes.js",
  "/js/views/scene-links.js",
  "/js/scene-links.js",
  "/js/views/ask-links.js",
  "/js/ask-links.js",
  "/js/views/schedules.js",
  "/js/schedules.js",
  "/js/calendar.js",
  "/js/profile.js",
  "/js/camera-feed.js",
  "/js/components.js",
  "/js/controls.js",
  "/js/dom.js",
  "/js/doorbells.js",
  "/js/doorbell-doors.js",
  "/js/views/doorbell.js",
  "/js/fans.js",
  "/js/refrigerators.js",
  "/js/favorites.js",
  "/js/find.js",
  "/js/i18n.js",
  "/js/icons.js",
  "/js/model.js",
  "/js/pwa.js",
  "/js/rings.js",
  "/js/session.js",
  "/js/setpoints.js",
  "/js/shades.js",
  "/js/state.js",
  "/js/temperature.js",
  "/js/theme.js",
  "/js/turn-off.js",
  "/js/updates.js",
  "/js/version.js",
  "/js/views/alarm.js",
  "/js/views/backup.js",
  "/js/views/cameras.js",
  "/js/views/climate.js",
  "/js/views/common.js",
  "/js/views/command.js",
  "/js/command-parser.js",
  "/js/commands.js",
  "/js/heaters.js",
  "/js/views/connect.js",
  "/js/views/find.js",
  "/js/views/history.js",
  "/js/views/home.js",
  "/js/views/room.js",
  "/js/views/settings.js",
  "/js/views/updates.js",
  // Languages (all of them: an update replaces this cache, and the app must still open offline in
  // the language it shows; check_app.py requires every language here).
  "/i18n/en.js",
  "/i18n/he.js",
  "/i18n/es.js",
  "/i18n/it.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Browsers refuse redirected responses for page loads, so store a plain copy instead.
async function storable(response) {
  if (!response.redirected) {
    return response;
  }
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchForCache(path) {
  const response = await fetch(path, { cache: "reload" });
  if (!response.ok) {
    throw new Error(`Could not cache ${path}: HTTP ${response.status}`);
  }
  return storable(response);
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all([
    ...PAGES.map(async (page) => {
      const response = await fetchForCache(page.source);
      await Promise.all(page.paths.map((path) => cache.put(path, response.clone())));
    }),
    ...ASSETS.map(async (path) => cache.put(path, await fetchForCache(path))),
  ]);
}

function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("network timeout")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function remember(key, response) {
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, await storable(response));
  }
}

// Saving to the cache runs in the background so it never delays the response.
async function handlePage(event) {
  const request = event.request;
  const path = new URL(request.url).pathname;
  try {
    // A navigation fetch returns redirects unfollowed; the browser follows them itself.
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (!response.redirected) {
      event.waitUntil(remember(path, response.clone()));
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (
      (await cache.match(path, { ignoreSearch: true })) ||
      (await cache.match("/")) ||
      Response.error()
    );
  }
}

async function handleAsset(event) {
  const request = event.request;
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    event.waitUntil(remember(request, response.clone()));
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request, { ignoreSearch: true })) || Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME && key !== ALERT_TEXTS_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Alerts (ADR-047, ADR-050): a push from api.directorlink.io is encrypted for this browser. The
// servers' own alert says only what happened, at which home and when, { kind: "offline" |
// "schedule_failed", home, at }. What the controller alerts about it seals to this device's key, so
// that the servers cannot read it: { kind: "sealed", home, key, at, sealed: { iv, ct, mac } }; this
// opens it with the alert key js/alerts.js keeps here, and says what happened and where (a doorbell
// rang, a camera saw someone or something, a door or gate was opened and by whom, the refrigerator's
// door was left open, a schedule failed). The words are the app's, in its language (js/alerts.js
// keeps them here); English when there are none, and the general words when the detail is missing
// or does not open. Every push shows a notification (browsers revoke a subscription that does not).
// Tapping a doorbell's opens its own screen (1.11.0, ADR-078: its live picture and "Open <door>" for
// the doors at it this user may open; Home's banner before), a camera's its full view, a
// refrigerator's its room, any other the home's history. Where the browser shows a notification's
// buttons (Android, desktop Chrome and Edge; not iPhone), a ring also has "Open <door>…" for each such
// door (js/doorbell-doors.js keeps them here, by name, for this home and key): it opens the same
// screen, never the door. A tap is also kept here for a minute (OPEN_PATH), so that an app this
// opens, or one asleep when told, still lands where it leads (js/pwa.js). The servers' push of a new device asking to join (1.8.0),
// { kind: "device_request", home, at, request }, says only that, and opens the app, where the
// request shows under every screen's header. An ask-to-open link's request (1.8.0, ADR-058) asks
// "Open the main gate?": its tap opens the app's question (#/open/<door>/<request>/<until>), where
// only Open, with this device's own key, opens the door.
const ALERT_TEXTS_CACHE = "directorlink-alerts";
const ALERT_TEXTS_PATH = "/alert-texts.json";
const ALERT_KEY_PATH = "/alert-key.json";
const RING_DOORS_PATH = "/ring-doors.json";
const OPEN_PATH = "/notification-open.json";
// A ring's "Open <door>…" buttons, at most (browsers show one or two).
const MAX_RING_ACTIONS = 2;
const ALERT_TEXTS = {
  lang: "en",
  dir: "ltr",
  title: "DirectorLink",
  offline: "Your home – DirectorLink has not reached it since {time}. Check the home’s internet connection and the controller.",
  schedule_failed: "Your home – a schedule had a problem at {time}. Open the app to see what happened.",
  schedule_failed_named: "Your home – the schedule for {name} had a problem at {time}. Open the app to see what happened.",
  other: "Your home – something needs your attention. Open the app to see what happened.",
  doorbell_title: "Someone is at the door",
  doorbell: "{name} rang at {time}.",
  doorbell_open_door: "Open {name}…",
  door_opened: "{name} was opened by {who} at {time}.",
  door_opened_scene: "{name} was opened by {who}, with the scene {scene}, at {time}.",
  door_opened_control4: "{name} was opened in Control4 at {time}.",
  door_held: "{name} was held open by {who} at {time}.",
  who: "{person} ({device})",
  unknown_device: "a removed device",
  fridge_door: "{name} – the door has been open for at least {minutes} min ({time}).",
  fridge_door_now: "{name} – the door was left open ({time}).",
  device_request: "A new device asks to join your home. Open DirectorLink to approve or decline it.",
  open_request_title: "Open {name}?",
  open_request: "Your link “{via}” asked at {time}. Tap to answer.",
  open_request_unnamed: "Your link asked at {time}. Tap to answer.",
  camera_title: "Camera alert",
  camera: "{what} at {name} at {time}.",
  camera_person: "Person",
  camera_vehicle: "Vehicle",
  camera_animal: "Animal",
  camera_package: "Package",
  camera_license_plate: "License plate",
  camera_face: "Face",
  camera_motion: "Motion",
  camera_line_crossing: "Line crossed",
  camera_intrusion: "Intrusion",
  camera_region_entrance: "Someone entering",
  camera_region_exiting: "Someone leaving",
  camera_tamper: "Tampering",
  camera_scene_change: "View changed",
  camera_object_left: "Object left behind",
  camera_object_removed: "Object removed",
  camera_alarm_input: "Alarm input",
  camera_pir: "Motion (PIR)",
  camera_smoke_alarm: "Smoke alarm",
  camera_co_alarm: "CO alarm",
  camera_siren: "Siren",
  camera_baby_crying: "Baby crying",
  camera_speech: "Someone talking",
  camera_barking: "Dog barking",
  camera_burglar_alarm: "Burglar alarm",
  camera_car_horn: "Car horn",
  camera_glass_break: "Glass breaking",
  camera_other: "Alert",
};
const HISTORY_URL = "/#/settings/history";

async function alertTexts() {
  try {
    const saved = await (await caches.open(ALERT_TEXTS_CACHE)).match(ALERT_TEXTS_PATH);
    const texts = saved ? await saved.json() : null;
    if (texts && typeof texts === "object") return { ...ALERT_TEXTS, ...texts };
  } catch {
    // English, then.
  }
  return ALERT_TEXTS;
}

// The alert's time on this device's clock, 24-hour.
function alertTime(at, lang) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  } catch {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
}

function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, name) => (values[name] === undefined || values[name] === null ? "" : String(values[name])));
}

function bytesOf(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacOf(rawKey, text) {
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

// What the controller sealed to this device (the same as driver/src/cloud/alerts.lua seals it,
// tests/vectors/alert.json): the detail, or null when it is not for this device's key at this home,
// or does not open. The MAC is checked before anything is decrypted.
async function openSealed(alert) {
  try {
    const saved = await (await caches.open(ALERT_TEXTS_CACHE)).match(ALERT_KEY_PATH);
    const own = saved ? await saved.json() : null;
    const sealed = alert.sealed || {};
    if (!own || own.home !== alert.home || own.key !== alert.key || typeof own.alert_key !== "string") return null;
    const alertKey = bytesOf(own.alert_key);
    const [enc, mac] = await Promise.all([hmacOf(alertKey, "enc"), hmacOf(alertKey, "mac")]);
    const macKey = await crypto.subtle.importKey("raw", mac, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`alert v1|${alert.home}|${alert.key}|${sealed.iv}|${sealed.ct}`);
    if (!(await crypto.subtle.verify("HMAC", macKey, bytesOf(sealed.mac), signed))) return null;
    const encKey = await crypto.subtle.importKey("raw", enc, { name: "AES-CBC" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-CBC", iv: bytesOf(sealed.iv) }, encKey, bytesOf(sealed.ct));
    const detail = JSON.parse(new TextDecoder().decode(plaintext));
    return detail && typeof detail === "object" && typeof detail.kind === "string" ? detail : null;
  } catch {
    return null;
  }
}

const text = (value) => (typeof value === "string" && value.trim() ? value : null);

// Who opened a door, as the history says it: the person and the device.
function whoText(who, texts) {
  const device = text(who?.name) || texts.unknown_device;
  const person = text(who?.profile);
  return person && person !== device ? fill(texts.who, { person, device }) : device;
}

// The notification for a detail: { title, body, tag, url, ring }, or null for a kind this app does
// not know (a newer controller's), which gets the general words.
function sealedNotice(detail, texts, home) {
  const time = alertTime(detail.at, texts.lang);
  const name = text(detail.name);
  const id = Number.isInteger(detail.id) ? detail.id : 0;
  switch (detail.kind) {
    case "doorbell":
      if (!name) return null;
      // The same tag as the app's own notification of a ring (js/doorbells.js): one per doorbell. Its
      // tap opens the doorbell's screen (1.11.0).
      return { title: texts.doorbell_title, body: fill(texts.doorbell, { name, time }), tag: `doorbell-${id}`, url: id ? `/#/doorbell/${id}` : "/#/", ring: text(detail.at), doorbell: id };
    case "door_opened": {
      if (!name) return null;
      const by = detail.who || {};
      const template = by.type === "control4" ? texts.door_opened_control4 : detail.action === "hold" ? texts.door_held : text(detail.via) ? texts.door_opened_scene : texts.door_opened;
      return { title: texts.title, body: fill(template, { name, who: whoText(by, texts), scene: text(detail.via), time }), tag: `door-${id}`, url: HISTORY_URL };
    }
    case "camera": {
      // A camera's alert (ADR-056, ADR-065): what it saw, in the app's words.
      if (!name) return null;
      const what = /^[a-z_]+$/.test(detail.what ?? "") && typeof texts[`camera_${detail.what}`] === "string" ? texts[`camera_${detail.what}`] : texts.camera_other;
      // A smoke or CO alarm (1.11.0, ADR-080) keeps a notification of its own: the camera's next
      // alert (a motion) does not take its place.
      const tag = detail.what === "smoke_alarm" || detail.what === "co_alarm" ? `camera-${id}-${detail.what}` : `camera-${id}`;
      return { title: texts.camera_title, body: fill(texts.camera, { what, name, time }), tag, url: id ? `/#/cameras/${id}` : "/#/cameras" };
    }
    case "fridge_door": {
      if (!name) return null;
      const minutes = Number.isInteger(detail.minutes) && detail.minutes > 0 ? detail.minutes : null;
      const room = Number.isInteger(detail.room_id) && detail.room_id > 0 ? detail.room_id : null;
      return { title: texts.title, body: fill(minutes ? texts.fridge_door : texts.fridge_door_now, { name, minutes, time }), tag: `fridge-${id}`, url: room ? `/#/room/${room}` : "/#/" };
    }
    case "schedule_failed":
      return { title: texts.title, body: fill(name ? texts.schedule_failed_named : texts.schedule_failed, { name, time }), tag: `alert-schedule_failed-${home}`, url: HISTORY_URL };
    case "open_request": {
      // An ask-to-open link asks this person (ADR-058). The question lasts `seconds` from now on this
      // device's clock (the push service keeps it a minute at most); the controller decides anyway.
      const request = typeof detail.request === "string" && /^[0-9a-f]{16}$/.test(detail.request) ? detail.request : null;
      if (!name || !id || !request) return null;
      const seconds = Number.isInteger(detail.seconds) ? Math.min(Math.max(detail.seconds, 1), 600) : 120;
      const until = Date.now() + seconds * 1000;
      const via = text(detail.via);
      return {
        title: fill(texts.open_request_title, { name }),
        body: fill(via ? texts.open_request : texts.open_request_unnamed, { via, time }),
        tag: `open-${id}`,
        url: `/#/open/${id}/${request}/${until}`,
      };
    }
    default:
      return null;
  }
}

// Whether the app is open in front: it shows a ring on its own banner then.
async function appInFront() {
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    return windows.some((item) => item.focused === true && item.visibilityState === "visible");
  } catch {
    return false;
  }
}

// A ring's buttons, where the browser shows them: "Open <door>…" for each door at the doorbell this
// user may open, as the app kept them for this home and key (js/doorbell-doors.js). Each opens the
// doorbell's screen (its tap's address), where Open asks for its two taps; none opens a door.
async function ringActions(alert, doorbellId, texts) {
  const most = Math.min(Number(self.Notification?.maxActions) || 0, MAX_RING_ACTIONS);
  if (most < 1 || !doorbellId) return [];
  try {
    const saved = await (await caches.open(ALERT_TEXTS_CACHE)).match(RING_DOORS_PATH);
    const kept = saved ? await saved.json() : null;
    if (!kept || kept.home !== alert.home || kept.key !== alert.key) return [];
    const doors = kept.doorbells?.[doorbellId]?.doors;
    return (Array.isArray(doors) ? doors : [])
      .filter((door) => Number.isInteger(door?.id) && text(door.name))
      .slice(0, most)
      .map((door) => ({ action: `door-${door.id}`, title: fill(texts.doorbell_open_door, { name: door.name }) }));
  } catch {
    return [];
  }
}

async function showNotice(notice, texts) {
  const options = { body: notice.body, tag: notice.tag, renotify: true, lang: texts.lang, dir: texts.dir, icon: "/icons/icon-192.png", data: { url: notice.url } };
  if (notice.actions?.length) options.actions = notice.actions;
  if (notice.ring) {
    // A ring this device already shows (the app noticed it first), or one the app shows on its
    // banner now: the notification is still shown, as every push must be, but quietly, in place
    // of the other (the same tag).
    options.data.ring = notice.ring;
    const shown = self.registration.getNotifications ? await self.registration.getNotifications({ tag: notice.tag }).catch(() => []) : [];
    if (shown.some((item) => item.data?.ring === notice.ring) || (await appInFront())) {
      options.renotify = false;
      options.silent = true;
    }
  }
  await self.registration.showNotification(notice.title, options);
}

async function showAlert(data) {
  let alert = null;
  try {
    alert = data ? data.json() : null;
  } catch {
    alert = null;
  }
  const texts = await alertTexts();
  const home = /^[0-9a-f]{32}$/.test(alert?.home ?? "") ? alert.home : "";
  if (alert?.kind === "sealed") {
    try {
      const detail = await openSealed(alert);
      const notice = detail && sealedNotice(detail, texts, home);
      if (notice) {
        if (notice.doorbell) notice.actions = await ringActions(alert, notice.doorbell, texts);
        await showNotice(notice, texts);
        return;
      }
    } catch {
      // The general words, below.
    }
  }
  if (alert?.kind === "device_request") {
    // One notification per home: a newer request replaces the one before. The app opens on Home,
    // and looks for requests at once as it comes to the front.
    await self.registration.showNotification(texts.title, {
      body: texts.device_request,
      tag: `device-request-${home}`,
      renotify: true,
      lang: texts.lang,
      dir: texts.dir,
      icon: "/icons/icon-192.png",
      data: { url: "/#/" },
    });
    return;
  }
  const kind = alert?.kind === "offline" || alert?.kind === "schedule_failed" ? alert.kind : "other";
  await self.registration.showNotification(texts.title, {
    body: fill(texts[kind], { time: kind === "other" ? "" : alertTime(alert.at, texts.lang) }),
    tag: `alert-${kind}-${home}`,
    renotify: true,
    lang: texts.lang,
    dir: texts.dir,
    icon: "/icons/icon-192.png",
    data: { url: HISTORY_URL },
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(showAlert(event.data));
});

// The browser replaced or dropped this device's push subscription (1.9.0, ADR-062). The worker has
// no key to tell anyone: an open app registers again, or shows alerts off and tells the controller
// (js/alerts.js); a closed one does it at its next start.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) client.postMessage({ type: "directorlink-push-changed" });
      }
    })
  );
});

// Where a tap leads, kept a minute for the app (js/pwa.js takes it once): an app this opens, or one
// asleep when told, still lands there.
async function keepOpen(url) {
  try {
    const cache = await caches.open(ALERT_TEXTS_CACHE);
    await cache.put(OPEN_PATH, new Response(JSON.stringify({ url, at: Date.now() }), { headers: { "content-type": "application/json" } }));
  } catch {
    // The message and the address still say it.
  }
}

// A notification's tap, or one of its buttons (a ring's "Open <door>…": the same screen): bring the
// app to the front where it says (a doorbell's: its screen), or open it there when no window is left.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/#/", self.location.origin).href;
  event.waitUntil(
    keepOpen(url)
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((windows) => {
        const client = windows.find((item) => new URL(item.url).origin === self.location.origin);
        if (client) {
          client.postMessage({ type: "directorlink-open", url });
          return client.focus();
        }
        return self.clients.openWindow(url);
      })
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);

  // Never intercept controller/LAN requests. The service worker only owns directorlink.io assets.
  if (requestUrl.origin !== self.location.origin || request.method !== "GET") {
    return;
  }

  event.respondWith(request.mode === "navigate" ? handlePage(event) : handleAsset(event));
});
