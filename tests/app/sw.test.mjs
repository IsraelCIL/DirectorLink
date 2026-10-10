// Tests app/sw.js offline behaviour with a fake network that serves the app like Cloudflare
// (/index.html -> /, and app/_redirects: /console.html and /console -> console.directorlink.io)
// and a fake Cache Storage.
//   node --test tests/app/

import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../app/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://app.directorlink.io";

const FILES = {
  "/": "<html>dashboard</html>",
  "/styles.css": "body{}",
  "/app.js": "app",
  "/api-client.js": "client",
  "/theme-boot.js": "boot",
  "/i18n/en.js": "en",
  "/i18n/he.js": "he",
  "/i18n/es.js": "es",
  "/i18n/it.js": "it",
  "/manifest.webmanifest": "{}",
  "/icons/icon.svg": "<svg/>",
  "/icons/icon-192.png": "png",
  "/icons/icon-512.png": "png",
};
// The app's ES modules (app/js/**) are precached too.
for (const [, path] of SOURCE.matchAll(/"(\/js\/[^"]+\.js)"/g)) FILES[path] = `module ${path}`;
const REDIRECTS = { "/index.html": "/" };
// app/_redirects: the API console moved to its own site.
const EXTERNAL = { "/console.html": "https://console.directorlink.io", "/console": "https://console.directorlink.io" };

// Node's Response cannot be constructed as "basic" or "redirected"; set them the way a browser
// would, and keep them on clones (browsers preserve them through clone()).
function withProps(response, props) {
  const clone = response.clone.bind(response);
  for (const [name, value] of Object.entries(props)) {
    Object.defineProperty(response, name, { value });
  }
  Object.defineProperty(response, "clone", { value: () => withProps(clone(), props) });
  return response;
}

// Serves FILES; follows redirects unless the request is a navigation (redirect: manual).
function makeNetwork() {
  const network = { online: true, hang: false, version: "", requests: [] };
  network.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN);
    const navigate = typeof input === "object" && input.mode === "navigate";
    network.requests.push(url.pathname);
    if (network.hang) return new Promise(() => {});
    if (!network.online) throw new TypeError("Failed to fetch");
    let path = url.pathname;
    let redirected = false;
    if (EXTERNAL[path]) {
      if (navigate) {
        return { type: "opaqueredirect", ok: false, status: 0, redirected: false, clone() { return this; } };
      }
      // A plain fetch follows the redirect to the other site (a CORS response, never "basic").
      return withProps(new Response("console site", { status: 200 }), { type: "cors", url: EXTERNAL[path], redirected: true });
    }
    if (REDIRECTS[path]) {
      if (navigate) {
        return { type: "opaqueredirect", ok: false, status: 0, redirected: false, clone() { return this; } };
      }
      path = REDIRECTS[path];
      redirected = true;
    }
    if (!(path in FILES)) {
      return withProps(new Response("not found", { status: 404 }), { type: "basic", url: ORIGIN + path });
    }
    return withProps(new Response(FILES[path] + network.version, { status: 200 }), {
      type: "basic",
      url: ORIGIN + path,
      redirected,
    });
  };
  return network;
}

function keyOf(request, options = {}) {
  const url = new URL(typeof request === "string" ? request : request.url, ORIGIN);
  return options.ignoreSearch ? url.pathname : url.pathname + url.search;
}

class FakeCache {
  entries = new Map();
  async put(request, response) {
    this.entries.set(keyOf(request), { response, body: await response.clone().text() });
  }
  async match(request, options) {
    const entry = this.entries.get(keyOf(request, options));
    return entry ? withProps(new Response(entry.body, { status: entry.response.status }), { redirected: entry.response.redirected }) : undefined;
  }
}

class FakeCacheStorage {
  stores = new Map();
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name) {
    return this.stores.delete(name);
  }
}

// `notifications`: what getNotifications finds (the notifications the app shows). `maxActions`: the
// buttons the browser shows on a notification (Android and desktop Chrome: 2; none on iPhone).
async function startWorker({ oldCaches = [], windows = [], opened = [], shown = [], notifications = [], maxActions } = {}) {
  const listeners = {};
  const network = makeNetwork();
  const storage = new FakeCacheStorage();
  for (const name of oldCaches) await storage.open(name);
  const self = {
    location: { origin: ORIGIN },
    // Notifications the worker shows: { title, options }.
    registration: {
      showNotification: async (title, options) => shown.push({ title, options }),
      getNotifications: async ({ tag } = {}) => notifications.filter((item) => !tag || item.tag === tag),
    },
    addEventListener: (type, listener) => (listeners[type] = listener),
    skipWaiting: async () => {},
    Notification: maxActions === undefined ? undefined : { maxActions },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => {
        opened.push(url);
      },
    },
  };
  const fastTimers = (callback, milliseconds) => setTimeout(callback, Math.min(milliseconds, 20));
  vm.runInNewContext(SOURCE, {
    self,
    caches: storage,
    fetch: network.fetch,
    Response,
    URL,
    // What opens the alerts sealed to this device (ADR-050).
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    atob,
    setTimeout: fastTimers,
    clearTimeout,
  });

  const lifecycle = async (type) => {
    let pending;
    listeners[type]({ waitUntil: (promise) => (pending = promise) });
    await pending;
  };
  await lifecycle("install");
  await lifecycle("activate");

  const request = async (path, { mode = "navigate", method = "GET", origin = ORIGIN } = {}) => {
    const background = [];
    let responded = null;
    listeners.fetch({
      request: { url: origin + path, method, mode },
      respondWith: (promise) => (responded = promise),
      waitUntil: (promise) => background.push(promise),
    });
    if (!responded) return null;
    const response = await responded;
    await Promise.all(background);
    return response;
  };
  const notificationClick = async (data, action = "") => {
    let pending;
    let closed = false;
    listeners.notificationclick({ action, notification: { data, close: () => (closed = true) }, waitUntil: (promise) => (pending = promise) });
    await pending;
    return closed;
  };
  // A push (ADR-047): `message` is what the browser decrypted (an object), or raw text.
  const push = async (message) => {
    let pending;
    const data = message === undefined ? null : { json: () => (typeof message === "string" ? JSON.parse(message) : message), text: () => String(message) };
    listeners.push({ data, waitUntil: (promise) => (pending = promise) });
    await pending;
  };
  // The browser replaced or dropped the push subscription (1.9.0).
  const subscriptionChange = async () => {
    let pending;
    listeners.pushsubscriptionchange({ oldSubscription: null, newSubscription: null, waitUntil: (promise) => (pending = promise) });
    await pending;
  };
  return { network, storage, request, notificationClick, push, subscriptionChange };
}

async function textOf(response) {
  return response && response.type !== "opaqueredirect" ? await response.text() : null;
}

test("install saves every page under each path, without redirects", async () => {
  const { storage } = await startWorker();
  const cache = await storage.open((await storage.keys())[0]);
  for (const [path, body] of [["/", "dashboard"], ["/index.html", "dashboard"]]) {
    const saved = await cache.match(path);
    assert.ok(saved, `${path} is cached`);
    assert.equal(saved.redirected, false, `${path} is stored without the redirect flag`);
    assert.match(await saved.text(), new RegExp(body));
  }
  for (const asset of ["/styles.css", "/app.js", "/api-client.js", "/theme-boot.js", "/js/views/home.js", "/js/doorbells.js", "/js/rings.js", "/js/shades.js", "/i18n/he.js", "/i18n/es.js", "/i18n/it.js", "/icons/icon-512.png"]) {
    assert.ok(await cache.match(asset), `${asset} is cached`);
  }
  // The API console moved to its own site (console.directorlink.io).
  for (const gone of ["/console", "/console.html", "/console.js", "/console.css"]) {
    assert.equal(await cache.match(gone), undefined, `${gone} is no longer cached`);
  }
});

test("activate removes caches from older versions", async () => {
  const { storage } = await startWorker({ oldCaches: ["directorlink-shell-v24", "directorlink-shell-v32", "directorlink-shell-v46"] });
  assert.deepEqual(await storage.keys(), ["directorlink-shell-v47"]);
});

test("online page loads come from the network and refresh the saved copy", async () => {
  const { network, request } = await startWorker();
  network.version = " v2";
  assert.equal(await textOf(await request("/")), "<html>dashboard</html> v2");
  network.online = false;
  assert.equal(await textOf(await request("/")), "<html>dashboard</html> v2", "the refreshed copy is used offline");
});

test("offline page loads are served from the saved copy", async () => {
  const { network, request } = await startWorker();
  network.online = false;
  assert.equal(await textOf(await request("/index.html")), "<html>dashboard</html>");
  assert.equal(await textOf(await request("/?from=home-screen")), "<html>dashboard</html>");
  assert.equal(await textOf(await request("/unknown-page")), "<html>dashboard</html>", "unknown pages fall back to the dashboard");
});

test("a slow network falls back to the saved copy", async () => {
  const { network, request } = await startWorker();
  network.hang = true;
  assert.equal(await textOf(await request("/")), "<html>dashboard</html>");
  assert.equal(await textOf(await request("/app.js", { mode: "cors" })), "app");
});

test("online redirects are left for the browser to follow", async () => {
  const { request } = await startWorker();
  const response = await request("/index.html");
  assert.equal(response.type, "opaqueredirect");
});

test("the old console address follows the redirect to console.directorlink.io and is never cached", async () => {
  const { network, storage, request } = await startWorker();
  for (const path of ["/console.html", "/console"]) {
    assert.equal((await request(path)).type, "opaqueredirect", `${path} is left to the browser's redirect`);
  }
  const cache = await storage.open((await storage.keys())[0]);
  for (const path of ["/console.html", "/console"]) {
    assert.equal(await cache.match(path), undefined, `${path} is not cached`);
  }
  network.online = false;
  assert.equal(await textOf(await request("/console.html")), "<html>dashboard</html>", "offline, the old address opens the app");
});

test("offline assets come from the cache; unknown ones fail cleanly", async () => {
  const { network, request } = await startWorker();
  network.online = false;
  assert.equal(await textOf(await request("/styles.css", { mode: "no-cors" })), "body{}");
  assert.equal((await request("/missing.js", { mode: "cors" })).type, "error");
});

test("controller requests and non-GET requests are never intercepted", async () => {
  const { request } = await startWorker();
  assert.equal(await request("/v1/lights", { mode: "cors", origin: "http://192.168.1.10:41999" }), null);
  assert.equal(await request("/v1/lights", { mode: "cors", method: "PATCH" }), null);
});

test("a doorbell notification click brings the open app to Home, or opens it", async () => {
  const focused = [];
  const messages = [];
  const opened = [];
  const windows = [
    { url: "https://elsewhere.example/", focus: async () => focused.push("elsewhere"), postMessage: () => {} },
    { url: `${ORIGIN}/#/settings`, focus: async () => focused.push("app"), postMessage: (message) => messages.push(message) },
  ];
  const { notificationClick } = await startWorker({ windows, opened });
  assert.equal(await notificationClick({ url: "/#/" }), true, "the notification is closed");
  assert.deepEqual(focused, ["app"]);
  // The message comes from the worker's realm: copy it before comparing.
  assert.deepEqual(messages.map((message) => ({ ...message })), [{ type: "directorlink-open", url: `${ORIGIN}/#/` }]);
  windows.length = 0;
  await notificationClick({ url: "/#/" });
  assert.deepEqual(opened, [`${ORIGIN}/#/`], "with no window left, the app is opened");
});

// Alerts (ADR-047): a push holds only { kind, home, at }; the words are the app's, kept by
// js/alerts.js in its language. Every push shows a notification, which opens the home's history.
const HOME = "0123456789abcdef0123456789abcdef";
const AT = "2026-10-03T05:00:00.000Z";
// The alert's time as the worker shows it, on this machine's clock.
const clock = (lang) => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(AT));

test("a pushed alert shows a notification in the app's words, with its time, and opens the history", async () => {
  const shown = [];
  const opened = [];
  const { storage, push, notificationClick } = await startWorker({ shown, opened });
  const texts = await storage.open("directorlink-alerts");
  await texts.put("/alert-texts.json", new Response(JSON.stringify({
    lang: "he",
    dir: "rtl",
    title: "DirectorLink",
    offline: "הבית שלכם – ל-DirectorLink אין קשר אליו מאז {time}.",
    schedule_failed: "הבית שלכם – תזמון נתקל בבעיה ב-{time}.",
    other: "הבית שלכם – משהו דורש את תשומת לבכם.",
  })));
  await push({ kind: "schedule_failed", home: HOME, at: AT });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, "DirectorLink");
  assert.equal(shown[0].options.body, `הבית שלכם – תזמון נתקל בבעיה ב-${clock("he")}.`);
  assert.equal(shown[0].options.lang, "he");
  assert.equal(shown[0].options.dir, "rtl");
  assert.equal(shown[0].options.tag, `alert-schedule_failed-${HOME}`);

  await notificationClick(shown[0].options.data);
  assert.deepEqual(opened, [`${ORIGIN}/#/settings/history`], "tapping it opens Settings → Controller → History");
});

test("without the app's words an alert is in English, and an unreadable push still shows one", async () => {
  const shown = [];
  const { push } = await startWorker({ shown });
  await push({ kind: "offline", home: HOME, at: AT });
  assert.equal(shown[0].options.body, `Your home – DirectorLink has not reached it since ${clock("en")}. Check the home’s internet connection and the controller.`);
  await push("not json");
  await push(undefined);
  await push({ kind: "door_opened", home: "x", at: AT });
  assert.deepEqual(shown.slice(1).map((item) => item.options.body), Array(3).fill("Your home – something needs your attention. Open the app to see what happened."));
  assert.deepEqual(shown.slice(1).map((item) => item.options.tag), Array(3).fill("alert-other-"));
});

// 1.8.0 (ADR-053 as amended by ADR-059): the account service's push when a new device of this
// account asks to join says only that; tapping it opens the app, where the request is shown.
test("a new device asking to join shows the app's words and opens the app", async () => {
  const shown = [];
  const opened = [];
  const { storage, push, notificationClick } = await startWorker({ shown, opened });
  await push({ kind: "device_request", home: HOME, at: AT, request: "ab".repeat(16) });
  assert.equal(shown[0].title, "DirectorLink");
  assert.equal(shown[0].options.body, "A new device asks to join your home. Open DirectorLink to approve or decline it.", "English without the app's words");
  assert.equal(shown[0].options.tag, `device-request-${HOME}`, "one per home: a newer request replaces it");
  const texts = await storage.open("directorlink-alerts");
  await texts.put("/alert-texts.json", new Response(JSON.stringify({ lang: "he", dir: "rtl", title: "DirectorLink", device_request: "מכשיר חדש מבקש להצטרף לבית שלכם." })));
  await push({ kind: "device_request", home: HOME, at: AT, request: "cd".repeat(16) });
  assert.equal(shown[1].options.body, "מכשיר חדש מבקש להצטרף לבית שלכם.");
  assert.equal(shown[1].options.dir, "rtl");
  await notificationClick(shown[1].options.data);
  assert.deepEqual(opened, [`${ORIGIN}/#/`], "the app, where the request shows under the header");
});

test("a new version keeps the alerts' words", async () => {
  const { storage } = await startWorker({ oldCaches: ["directorlink-shell-v24", "directorlink-alerts"] });
  assert.deepEqual((await storage.keys()).sort(), ["directorlink-alerts", /CACHE_NAME = "([^"]+)"/.exec(SOURCE)[1]]);
});

// Alerts sealed to this device (ADR-050): { kind: "sealed", home, key, at, sealed }, opened with the
// alert key js/alerts.js keeps for the worker (tests/vectors/alert.json: the driver seals the same).
const VECTORS = JSON.parse(readFileSync(new URL("../vectors/alert.json", import.meta.url), "utf8"));
const ALERT_KEY = Buffer.from(VECTORS.device.alert_key_hex, "hex");

// A detail sealed as the driver seals it, with Node's crypto.
function sealDetail(detail, { home = VECTORS.home, key = VECTORS.key } = {}) {
  const hmac = (secret, data) => createHmac("sha256", secret).update(data).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", hmac(ALERT_KEY, "enc"), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(detail), "utf8"), cipher.final()]).toString("base64");
  const ivText = iv.toString("base64");
  return { iv: ivText, ct, mac: hmac(hmac(ALERT_KEY, "mac"), `alert v1|${home}|${key}|${ivText}|${ct}`).toString("base64") };
}

async function keepAlertKey(storage, value = { home: VECTORS.home, key: VECTORS.key, alert_key: ALERT_KEY.toString("base64") }) {
  await (await storage.open("directorlink-alerts")).put("/alert-key.json", new Response(JSON.stringify(value)));
}

const sealedPush = (sealed, fields = {}) => ({ kind: "sealed", home: VECTORS.home, key: VECTORS.key, at: AT, sealed, ...fields });
const sealedClock = (at, lang = "en") => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
const GENERAL = "Your home – something needs your attention. Open the app to see what happened.";

test("the shared vectors are what Node's crypto makes", () => {
  const hmac = (secret, data) => createHmac("sha256", secret).update(data).digest();
  const lock = hmac(Buffer.from(VECTORS.device.api_key, "utf8"), "DirectorLink e2e v1");
  assert.equal(lock.toString("hex"), VECTORS.device.lock_key_hex);
  assert.equal(hmac(lock, "DirectorLink alert v1").toString("hex"), VECTORS.device.alert_key_hex);
  assert.equal(hmac(ALERT_KEY, "enc").toString("hex"), VECTORS.device.enc_key_hex);
  assert.equal(hmac(ALERT_KEY, "mac").toString("hex"), VECTORS.device.mac_key_hex);
  for (const detail of VECTORS.details) {
    const cipher = createCipheriv("aes-256-cbc", hmac(ALERT_KEY, "enc"), Buffer.from(detail.iv_hex, "hex"));
    const ct = Buffer.concat([cipher.update(detail.plaintext, "utf8"), cipher.final()]).toString("base64");
    const iv = Buffer.from(detail.iv_hex, "hex").toString("base64");
    const mac = hmac(hmac(ALERT_KEY, "mac"), `alert v1|${VECTORS.home}|${VECTORS.key}|${iv}|${ct}`).toString("base64");
    assert.deepEqual({ iv, ct, mac }, detail.sealed, detail.name);
  }
});

test("a sealed alert opens with this device's alert key and says what happened, in the app's words", async () => {
  const shown = [];
  const opened = [];
  const { storage, push, notificationClick } = await startWorker({ shown, opened });
  await keepAlertKey(storage);
  const [ring, door] = VECTORS.details;

  await push(sealedPush(ring.sealed));
  assert.equal(shown[0].title, "Someone is at the door");
  assert.equal(shown[0].options.body, `שער הכניסה rang at ${sealedClock("2026-10-03T05:00:00Z")}.`, "the doorbell's name, and the ring's time");
  assert.equal(shown[0].options.tag, "doorbell-93", "the tag of the app's own ring notification");
  assert.equal(shown[0].options.renotify, true);
  assert.equal(shown[0].options.data.ring, "2026-10-03T05:00:00Z");
  await notificationClick(shown[0].options.data);
  assert.deepEqual(opened, [`${ORIGIN}/#/doorbell/93`], "a ring opens its doorbell's screen (1.11.0)");

  await push(sealedPush(door.sealed));
  assert.equal(shown[1].title, "DirectorLink");
  assert.equal(shown[1].options.body, `Main Door was opened by Dana (Dana's iPhone), with the scene Good night, at ${sealedClock("2026-10-03T05:01:00Z")}.`);
  assert.equal(shown[1].options.tag, "door-70");
  assert.equal(shown[1].options.data.url, "/#/settings/history");

  const at = "2026-10-03T06:30:00Z";
  for (const [detail, body, tag, url] of [
    [{ kind: "door_opened", action: "pulse", id: 70, name: "Main Door", who: { type: "control4" } }, `Main Door was opened in Control4 at ${sealedClock(at)}.`, "door-70", "/#/settings/history"],
    [{ kind: "door_opened", action: "hold", id: 70, name: "Main Door", who: { type: "key", name: "Kids phone", profile: "Kids phone" } }, `Main Door was held open by Kids phone at ${sealedClock(at)}.`, "door-70", "/#/settings/history"],
    [{ kind: "door_opened", action: "doorbell", id: 93, name: "Front Gate", who: { type: "key" } }, `Front Gate was opened by a removed device at ${sealedClock(at)}.`, "door-93", "/#/settings/history"],
    [{ kind: "fridge_door", id: 500, name: "Refrigerator", room_id: 10, minutes: 5 }, `Refrigerator – the door has been open for at least 5 min (${sealedClock(at)}).`, "fridge-500", "/#/room/10"],
    [{ kind: "fridge_door", id: 500, name: "Refrigerator" }, `Refrigerator – the door was left open (${sealedClock(at)}).`, "fridge-500", "/#/"],
    [{ kind: "schedule_failed", name: "Morning blinds" }, `Your home – the schedule for Morning blinds had a problem at ${sealedClock(at)}. Open the app to see what happened.`, `alert-schedule_failed-${VECTORS.home}`, "/#/settings/history"],
    [{ kind: "schedule_failed" }, `Your home – a schedule had a problem at ${sealedClock(at)}. Open the app to see what happened.`, `alert-schedule_failed-${VECTORS.home}`, "/#/settings/history"],
    [{ kind: "sprinklers", name: "Garden" }, GENERAL, `alert-other-${VECTORS.home}`, "/#/settings/history"],
  ]) {
    await push(sealedPush(sealDetail({ v: 1, at, ...detail })));
    const last = shown.at(-1);
    assert.equal(last.options.body, body, detail.kind);
    assert.equal(last.options.tag, tag, detail.kind);
    assert.equal(last.options.data.url, url, detail.kind);
  }
});

test("a sealed alert's words follow the app's language", async () => {
  const shown = [];
  const { storage, push } = await startWorker({ shown });
  await keepAlertKey(storage);
  await (await storage.open("directorlink-alerts")).put("/alert-texts.json", new Response(JSON.stringify({
    lang: "he",
    dir: "rtl",
    title: "DirectorLink",
    doorbell_title: "מישהו בדלת",
    doorbell: "צלצול ב-{name} ב-{time}.",
    door_opened_control4: "פתיחה של {name} דרך Control4 ב-{time}.",
  })));
  await push(sealedPush(VECTORS.details[0].sealed));
  assert.equal(shown[0].title, "מישהו בדלת");
  assert.equal(shown[0].options.body, `צלצול ב-שער הכניסה ב-${sealedClock("2026-10-03T05:00:00Z", "he")}.`);
  assert.equal(shown[0].options.dir, "rtl");
  await push(sealedPush(sealDetail({ v: 1, kind: "door_opened", at: AT, id: 70, name: "Main Door", who: { type: "control4" } })));
  assert.equal(shown[1].options.body, `פתיחה של Main Door דרך Control4 ב-${sealedClock(AT, "he")}.`);
});

test("a sealed alert in Spanish and Italian: the app's words, its time in that language (1.10.0)", async () => {
  for (const code of ["es", "it"]) {
    const { default: words } = await import(`../../app/i18n/${code}.js`);
    const shown = [];
    const { storage, push } = await startWorker({ shown });
    await keepAlertKey(storage);
    await (await storage.open("directorlink-alerts")).put("/alert-texts.json", new Response(JSON.stringify({
      lang: code,
      dir: "ltr",
      title: "DirectorLink",
      doorbell_title: words.doorbells.notificationTitle,
      doorbell: words.alerts.doorbell,
    })));
    await push(sealedPush(VECTORS.details[0].sealed));
    assert.equal(shown[0].title, code === "es" ? "Hay alguien en la puerta" : "C’è qualcuno alla porta");
    const time = sealedClock("2026-10-03T05:00:00Z", code);
    assert.equal(shown[0].options.body, code === "es" ? `שער הכניסה sonó a las ${time}.` : `שער הכניסה ha suonato alle ${time}.`);
    assert.equal(shown[0].options.lang, code);
    assert.equal(shown[0].options.dir, "ltr");
  }
});

test("a sealed alert this device cannot open shows the general words", async () => {
  const shown = [];
  const { storage, push } = await startWorker({ shown });
  const [ring] = VECTORS.details;
  await push(sealedPush(ring.sealed));
  await keepAlertKey(storage);
  const changed = ring.sealed.mac.startsWith("A") ? `B${ring.sealed.mac.slice(1)}` : `A${ring.sealed.mac.slice(1)}`;
  await push(sealedPush({ ...ring.sealed, mac: changed }));
  await push(sealedPush(ring.sealed, { key: "0badc0de" }));
  await push(sealedPush(ring.sealed, { home: "ffeeddccbbaa99887766554433221100" }));
  await push(sealedPush({ iv: "x", ct: "y", mac: "z" }));
  await push(sealedPush(sealDetail({ v: 1, kind: "doorbell", at: AT, id: 93 })));
  await keepAlertKey(storage, { home: VECTORS.home, key: VECTORS.key, alert_key: Buffer.alloc(32, 1).toString("base64") });
  await push(sealedPush(ring.sealed));
  assert.deepEqual(
    shown.map((item) => item.options.body),
    Array(7).fill(GENERAL),
    "no key kept, a changed MAC, another key, another home, nothing sealed, a doorbell without a name, another device's key"
  );
  assert.deepEqual(shown.map((item) => item.options.data.url), Array(7).fill("/#/settings/history"));
});

// A camera of the DirectorLink · Hikvision drivers (1.8.0, ADR-056): what it saw, where, and its
// tap opens that camera's full view.
test("a camera's alert says what it saw at which camera, in the app's words, and opens that camera", async () => {
  const shown = [];
  const opened = [];
  const { storage, push, notificationClick } = await startWorker({ shown, opened });
  await keepAlertKey(storage);
  const at = "2026-10-03T19:14:00Z";
  for (const [what, body] of [
    ["person", `Person at Garden at ${sealedClock(at)}.`],
    ["vehicle", `Vehicle at Garden at ${sealedClock(at)}.`],
    // DirectorLink's camera agreement's labels (1.10.0, ADR-065).
    ["animal", `Animal at Garden at ${sealedClock(at)}.`],
    ["package", `Package at Garden at ${sealedClock(at)}.`],
    ["license_plate", `License plate at Garden at ${sealedClock(at)}.`],
    ["line_crossing", `Line crossed at Garden at ${sealedClock(at)}.`],
    ["intrusion", `Intrusion at Garden at ${sealedClock(at)}.`],
    ["region_entrance", `Someone entering at Garden at ${sealedClock(at)}.`],
    ["tamper", `Tampering at Garden at ${sealedClock(at)}.`],
    ["other", `Alert at Garden at ${sealedClock(at)}.`],
    ["something_newer", `Alert at Garden at ${sealedClock(at)}.`],
    ["constructor", `Alert at Garden at ${sealedClock(at)}.`],
    [undefined, `Alert at Garden at ${sealedClock(at)}.`],
  ]) {
    await push(sealedPush(sealDetail({ v: 1, kind: "camera", at, id: 65, name: "Garden", room: "Living Room", room_id: 11, what })));
    const last = shown.at(-1);
    assert.equal(last.title, "Camera alert", String(what));
    assert.equal(last.options.body, body, String(what));
    assert.equal(last.options.tag, "camera-65", "one notification a camera");
    assert.equal(last.options.renotify, true);
    assert.equal(last.options.data.url, "/#/cameras/65");
  }
  await notificationClick(shown[0].options.data);
  assert.deepEqual(opened, [`${ORIGIN}/#/cameras/65`], "the camera's full view");

  // Without a name it is the general words.
  await push(sealedPush(sealDetail({ v: 1, kind: "camera", at, id: 65, what: "person" })));
  assert.equal(shown.at(-1).options.body, GENERAL);

  // In Hebrew, with the app's words.
  await (await storage.open("directorlink-alerts")).put("/alert-texts.json", new Response(JSON.stringify({
    lang: "he",
    dir: "rtl",
    camera_title: "התראת מצלמה",
    camera: "{what} ב-{name} ב-{time}.",
    camera_person: "אדם",
    camera_other: "התראה",
  })));
  await push(sealedPush(sealDetail({ v: 1, kind: "camera", at, id: 66, name: "שער אחורי", what: "person" })));
  assert.equal(shown.at(-1).title, "התראת מצלמה");
  assert.equal(shown.at(-1).options.body, `אדם ב-שער אחורי ב-${sealedClock(at, "he")}.`);
  assert.equal(shown.at(-1).options.dir, "rtl");
  assert.equal(shown.at(-1).options.tag, "camera-66");
});

// The sounds a camera hears (1.11.0, ADR-080): said in the worker's own English when the app gave
// no words, in the app's words otherwise; a smoke or CO alarm keeps a notification of its own, so
// that the camera's next alert does not take its place.
test("a camera's smoke alarm is said by name and keeps its own notification; other sounds by name too", async () => {
  const shown = [];
  const { storage, push } = await startWorker({ shown });
  await keepAlertKey(storage);
  const at = "2026-10-03T18:14:00Z";
  const clock = sealedClock(at);
  for (const [what, body, tag] of [
    ["smoke_alarm", `Smoke alarm at Garden at ${clock}.`, "camera-65-smoke_alarm"],
    ["co_alarm", `CO alarm at Garden at ${clock}.`, "camera-65-co_alarm"],
    ["siren", `Siren at Garden at ${clock}.`, "camera-65"],
    ["baby_crying", `Baby crying at Garden at ${clock}.`, "camera-65"],
    ["speech", `Someone talking at Garden at ${clock}.`, "camera-65"],
    ["barking", `Dog barking at Garden at ${clock}.`, "camera-65"],
    ["burglar_alarm", `Burglar alarm at Garden at ${clock}.`, "camera-65"],
    ["car_horn", `Car horn at Garden at ${clock}.`, "camera-65"],
    ["glass_break", `Glass breaking at Garden at ${clock}.`, "camera-65"],
    ["motion", `Motion at Garden at ${clock}.`, "camera-65"],
  ]) {
    await push(sealedPush(sealDetail({ v: 1, kind: "camera", at, id: 65, name: "Garden", room: "Living Room", room_id: 11, what })));
    assert.equal(shown.at(-1).options.body, body, what);
    assert.equal(shown.at(-1).options.tag, tag, what);
    assert.equal(shown.at(-1).options.data.url, "/#/cameras/65", what);
  }

  // In every language, with the app's words.
  for (const code of ["he", "es", "it"]) {
    const { default: words } = await import(`../../app/i18n/${code}.js`);
    await (await storage.open("directorlink-alerts")).put("/alert-texts.json", new Response(JSON.stringify({
      lang: code,
      dir: code === "he" ? "rtl" : "ltr",
      camera_title: words.alerts.cameraTitle,
      camera: words.alerts.camera,
      camera_smoke_alarm: words.alerts.cameraSaw.smoke_alarm,
      camera_other: words.alerts.cameraSaw.other,
    })));
    const name = code === "he" ? "גינה" : "Jardín";
    await push(sealedPush(sealDetail({ v: 1, kind: "camera", at, id: 66, name, what: "smoke_alarm" })));
    const time = sealedClock(at, code);
    const expected = { he: `גלאי עשן ב-גינה ב-${time}.`, es: `Alarma de humo en Jardín a las ${time}.`, it: `Allarme fumo presso Jardín alle ${time}.` }[code];
    assert.equal(shown.at(-1).options.body, expected, code);
    assert.equal(shown.at(-1).options.tag, "camera-66-smoke_alarm", code);
  }
});

test("a ring the app already shows, or shows on its banner now, is shown again quietly", async () => {
  const shown = [];
  const [ring] = VECTORS.details;
  // The app showed this ring itself (js/doorbells.js), with the same tag.
  const notifications = [{ tag: "doorbell-93", data: { url: "/#/", ring: "2026-10-03T05:00:00Z" } }];
  const windows = [];
  const { storage, push } = await startWorker({ shown, notifications, windows });
  await keepAlertKey(storage);
  await push(sealedPush(ring.sealed));
  assert.equal(shown.length, 1, "every push shows a notification");
  assert.equal(shown[0].options.silent, true);
  assert.equal(shown[0].options.renotify, false, "in place of the app's, without a sound");

  // Another ring: it alerts.
  notifications.length = 0;
  await push(sealedPush(sealDetail({ v: 1, kind: "doorbell", at: "2026-10-03T05:03:00Z", id: 93, name: "Front Gate" })));
  assert.equal(shown[1].options.renotify, true);
  assert.equal(shown[1].options.silent, undefined);

  // The app is open in front: its banner shows the ring.
  windows.push({ url: `${ORIGIN}/#/`, focused: true, visibilityState: "visible", focus: async () => {}, postMessage: () => {} });
  await push(sealedPush(sealDetail({ v: 1, kind: "doorbell", at: "2026-10-03T05:05:00Z", id: 93, name: "Front Gate" })));
  assert.equal(shown[2].options.silent, true);
});

// Ask before opening (1.8.0, ADR-058): the question an ask-to-open link sends its person. Its tap
// opens the app's question (#/open/<door>/<request>/<until>), lasting as long as the controller said
// from when it came; only Open there, with the device's own key, opens the door.
test("an ask-to-open link's question opens the app's question, for as long as it lasts", async () => {
  const shown = [];
  const opened = [];
  const { storage, push, notificationClick } = await startWorker({ shown, opened });
  await keepAlertKey(storage);
  const at = "2026-10-03T07:15:00Z";
  const question = { v: 1, kind: "open_request", at, id: 70, name: "Main gate", room: "Entrance", room_id: 11, request: "0123456789abcdef", seconds: 120, via: "Arriving home" };
  const before = Date.now();
  await push(sealedPush(sealDetail(question)));
  const after = Date.now();
  const last = shown.at(-1);
  assert.equal(last.title, "Open Main gate?");
  assert.equal(last.options.body, `Your link “Arriving home” asked at ${sealedClock(at)}. Tap to answer.`);
  assert.equal(last.options.tag, "open-70", "a newer question about the door takes its place");
  const match = /^\/#\/open\/70\/0123456789abcdef\/(\d+)$/.exec(last.options.data.url);
  assert.ok(match, last.options.data.url);
  const until = Number(match[1]);
  assert.ok(until >= before + 120000 && until <= after + 120000, "two minutes from when it came, on this device's clock");
  await notificationClick(last.options.data);
  assert.equal(opened.at(-1), `${ORIGIN}${last.options.data.url}`);

  // Without a label; and one without a request, door or name is no question: the general words.
  await push(sealedPush(sealDetail({ ...question, via: undefined })));
  assert.equal(shown.at(-1).options.body, `Your link asked at ${sealedClock(at)}. Tap to answer.`);
  for (const broken of [{ request: undefined }, { request: "not a request" }, { id: undefined }, { name: undefined }]) {
    await push(sealedPush(sealDetail({ ...question, ...broken })));
    assert.equal(shown.at(-1).options.body, GENERAL, JSON.stringify(broken));
  }
});

// 1.9.0 (ADR-062): the worker cannot tell the controller (it has no key); it tells the open app,
// which registers again or shows alerts off and tells the controller (js/alerts.js).
test("a push subscription the browser replaced or dropped is told to the open app", async () => {
  const messages = [];
  const windows = [
    { url: "https://elsewhere.example/", postMessage: () => messages.push("elsewhere") },
    { url: `${ORIGIN}/#/`, postMessage: (message) => messages.push({ ...message }) },
  ];
  const { subscriptionChange } = await startWorker({ windows });
  await subscriptionChange();
  assert.deepEqual(messages, [{ type: "directorlink-push-changed" }], "only the app's windows");
  windows.length = 0;
  await subscriptionChange();
  assert.equal(messages.length, 1, "no window: the app does it at its next start");
});

// A doorbell's ring and its doors (1.11.0, ADR-078): its tap opens the doorbell's own screen, also when
// the app was closed (opened there, and the tap kept a minute for an app that opens elsewhere or was
// asleep, js/pwa.js); where the browser shows buttons, "Open <door>…" for each door at it this user may
// open, as the app kept them for this home and key, opening the same screen, never the door.
async function keepRingDoors(storage, value) {
  await (await storage.open("directorlink-alerts")).put("/ring-doors.json", new Response(JSON.stringify(value)));
}

const ENTRANCE_RING = { v: 1, kind: "doorbell", at: "2026-10-10T08:00:00Z", id: 763, name: "DoorBird", room: "Entrance", room_id: 12 };
const RING_DOORS = { home: VECTORS.home, key: VECTORS.key, doorbells: { 763: { camera: 763, doors: [{ id: 531, name: "שער כניסה" }, { id: 70, name: "Main Door" }, { id: 71, name: "Garden Gate" }] } } };

test("a ring's tap opens its doorbell's screen, and is kept for the app it opens", async () => {
  const shown = [];
  const opened = [];
  const windows = [];
  const { storage, push, notificationClick } = await startWorker({ shown, opened, windows });
  await keepAlertKey(storage);
  await push(sealedPush(sealDetail(ENTRANCE_RING)));
  assert.equal(shown[0].options.data.url, "/#/doorbell/763");
  assert.equal(shown[0].options.actions, undefined, "no buttons where the browser shows none (iPhone)");

  const before = Date.now();
  await notificationClick(shown[0].options.data);
  assert.deepEqual(opened, [`${ORIGIN}/#/doorbell/763`], "the closed app opens on the doorbell's screen");
  const kept = await (await (await storage.open("directorlink-alerts")).match("/notification-open.json")).json();
  assert.equal(kept.url, `${ORIGIN}/#/doorbell/763`, "kept for an app that opens on its start page, or was asleep");
  assert.ok(kept.at >= before && kept.at <= Date.now());

  // The app is open: it is told, and brought to the front.
  const messages = [];
  windows.push({ url: `${ORIGIN}/#/settings`, focus: async () => {}, postMessage: (message) => messages.push({ ...message }) });
  await notificationClick(shown[0].options.data);
  assert.deepEqual(messages, [{ type: "directorlink-open", url: `${ORIGIN}/#/doorbell/763` }]);
  assert.equal(opened.length, 1);

  // A ring without its doorbell's id still opens Home.
  await push(sealedPush(sealDetail({ ...ENTRANCE_RING, id: undefined })));
  assert.equal(shown.at(-1).options.data.url, "/#/");
});

test("where the browser shows buttons, a ring offers Open <door>… for its doors, which opens the same screen", async () => {
  const shown = [];
  const opened = [];
  const { storage, push, notificationClick } = await startWorker({ shown, opened, maxActions: 2 });
  await keepAlertKey(storage);
  // Without the doors the app keeps: no buttons.
  await push(sealedPush(sealDetail(ENTRANCE_RING)));
  assert.equal(shown.at(-1).options.actions, undefined);

  await keepRingDoors(storage, RING_DOORS);
  await push(sealedPush(sealDetail(ENTRANCE_RING)));
  assert.deepEqual(
    shown.at(-1).options.actions.map((action) => ({ ...action })),
    [
      { action: "door-531", title: "Open שער כניסה…" },
      { action: "door-70", title: "Open Main Door…" },
    ],
    "two at most, in the doorbell's order"
  );
  // In the app's language.
  await (await storage.open("directorlink-alerts")).put("/alert-texts.json", new Response(JSON.stringify({ lang: "he", dir: "rtl", doorbell_open_door: "פתיחת {name}…" })));
  await push(sealedPush(sealDetail(ENTRANCE_RING)));
  assert.equal(shown.at(-1).options.actions[0].title, "פתיחת שער כניסה…");

  // A button opens the doorbell's screen, as the tap does: it never opens the door itself.
  await notificationClick(shown.at(-1).options.data, "door-531");
  assert.deepEqual(opened, [`${ORIGIN}/#/doorbell/763`]);

  // Another doorbell, another key's or another home's doors: no buttons.
  await push(sealedPush(sealDetail({ ...ENTRANCE_RING, id: 93 })));
  assert.equal(shown.at(-1).options.actions, undefined);
  await keepRingDoors(storage, { ...RING_DOORS, key: "ffffffff" });
  await push(sealedPush(sealDetail(ENTRANCE_RING)));
  assert.equal(shown.at(-1).options.actions, undefined);
  await keepRingDoors(storage, { ...RING_DOORS, home: "f".repeat(32) });
  await push(sealedPush(sealDetail(ENTRANCE_RING)));
  assert.equal(shown.at(-1).options.actions, undefined);

  // One button where the browser shows one.
  const one = [];
  const worker = await startWorker({ shown: one, maxActions: 1 });
  await keepAlertKey(worker.storage);
  await keepRingDoors(worker.storage, RING_DOORS);
  await worker.push(sealedPush(sealDetail(ENTRANCE_RING)));
  assert.deepEqual(one[0].options.actions.map((action) => action.action), ["door-531"]);
});
