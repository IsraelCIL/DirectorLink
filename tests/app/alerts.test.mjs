// Alerts on this device (app/js/alerts.js, app/js/views/alerts.js, ADR-047, ADR-050): who sees the
// switch in Settings → Alerts (1.10.0; Settings → Controller before) and what its row on Settings'
// list says, what it says on each device, and what turning it on and off does:
// the permission (asked only here), the browser's push subscription with the account service's key,
// its registration with this device's key id, the controller told (DirectorLink 1.7.0) and each
// kind chosen there, the words and the alert key kept for the service worker, and the clean-up when
// the key is forgotten. Against a fake account service, a fake home behind it (sealed requests) and
// a fake browser push manager.
//   node --test tests/app/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deriveLock, open, seal } from "../../app/js/lock.js";

const HOME = "0123456789abcdef0123456789abcdef";
const KEY_ID = "0a1b2c3d";
// The account service's VAPID key, and an older one.
const PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
const OLD_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString("base64url");

// ---- just enough of a browser ------------------------------------------------------------------

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.style = { setProperty() {} };
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  append(...children) {
    this.children.push(...children);
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}

const stored = new Map();
globalThis.Node = FakeNode;
globalThis.window = globalThis;
window.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/#/settings/alerts", pathname: "/", search: "", hash: "#/settings/alerts" };
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {} });
window.isSecureContext = true;
window.PushManager = function PushManager() {};
globalThis.history = { state: null, replaceState() {} };
globalThis.document = {
  hidden: false,
  documentElement: {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeNode(), { textContent: String(text) }),
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  },
  configurable: true,
});

// The browser's notifications and push manager.
const browser = { permission: "default", answer: "granted", asked: 0, subscription: null, subscribed: [], unsubscribed: [], made: 0 };
globalThis.Notification = {
  get permission() {
    return browser.permission;
  },
  requestPermission: async () => {
    browser.asked += 1;
    browser.permission = browser.answer;
    return browser.permission;
  },
};
function subscription(key) {
  browser.made += 1;
  const endpoint = `https://fcm.googleapis.com/fcm/send/device-${browser.made}`;
  const made = {
    endpoint,
    options: { userVisibleOnly: true, applicationServerKey: Uint8Array.from(Buffer.from(key, "base64url")).buffer },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: `p256dh-${browser.made}`, auth: `auth-${browser.made}` } }),
    unsubscribe: async () => {
      browser.unsubscribed.push(endpoint);
      if (browser.subscription === made) browser.subscription = null;
      return true;
    },
  };
  return made;
}
const registration = {
  pushManager: {
    getSubscription: async () => browser.subscription,
    subscribe: async (options) => {
      browser.subscribed.push({ userVisibleOnly: options.userVisibleOnly, key: Buffer.from(options.applicationServerKey).toString("base64url") });
      browser.subscription = subscription(Buffer.from(options.applicationServerKey).toString("base64url"));
      return browser.subscription;
    },
  },
};
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140", maxTouchPoints: 0, languages: ["en"], language: "en", onLine: true, serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration, addEventListener() {} } },
  configurable: true,
});

// Cache Storage, where the words for the service worker are kept.
const cacheStorage = new Map();
globalThis.caches = {
  open: async (name) => {
    if (!cacheStorage.has(name)) cacheStorage.set(name, new Map());
    const entries = cacheStorage.get(name);
    return {
      put: async (path, response) => entries.set(path, await response.text()),
      match: async (path) => (entries.has(path) ? new Response(entries.get(path)) : undefined),
      delete: async (path) => entries.delete(path),
    };
  },
};
const savedTexts = () => JSON.parse(cacheStorage.get("directorlink-alerts")?.get("/alert-texts.json") ?? "null");
const savedAlertKey = () => JSON.parse(cacheStorage.get("directorlink-alerts")?.get("/alert-key.json") ?? "null");

// The home behind the account service (sealed requests, ADR-050), while `online`: this key's alert
// choices, as DirectorLink 1.7.0 keeps them; `fail`: it cannot save them.
const home = { online: false, fail: false, requests: [], choices: { on: false, kinds: { doorbell: true } } };
async function homeAnswer(body) {
  const lock = await deriveLock(state.apiKey);
  const envelope = JSON.parse(body).envelope;
  const request = JSON.parse(await open(lock, envelope, "req"));
  home.requests.push({ method: request.method, path: request.path, body: request.body });
  let status = 200;
  let answer = { id: envelope.key };
  if (request.path === "/v1/alerts/choices") {
    if (request.method === "PUT" && home.fail) {
      status = 503;
      answer = { status, code: "UNAVAILABLE" };
    } else {
      if (request.method === "PUT") {
        if (typeof request.body.on === "boolean") home.choices.on = request.body.on;
        for (const [kind, on] of Object.entries(request.body.kinds || {})) if (kind in home.choices.kinds) home.choices.kinds[kind] = on;
      }
      answer = structuredClone(home.choices);
    }
  }
  const sealed = { id: request.id, ts: Math.floor(Date.now() / 1000), status, content_type: "application/json", body: JSON.stringify(answer) };
  return { envelope: await seal(lock, { home: HOME, key: envelope.key }, "res", JSON.stringify(sealed)) };
}
const toHome = (method, path) => home.requests.filter((request) => request.method === method && request.path === path);

// The account service: every call, and what POST /alerts answers next.
const cloud = { calls: [], key: PUBLIC_KEY, posts: [], get: null };
globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname } = new URL(url);
  if (hostname !== "api.directorlink.io") throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  cloud.calls.push({ method, path: pathname, body: init.body ? JSON.parse(init.body) : null, credentials: init.credentials });
  const reply = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (pathname === `/v1/homes/${HOME}/alerts`) {
    if (method === "GET") return cloud.get ? reply(...cloud.get) : reply(200, { public_key: cloud.key });
    if (method === "POST") return reply(...(cloud.posts.shift() ?? [201, { alerts: true }]));
    if (method === "DELETE") return reply(204, null);
  }
  // A sealed request through the account (the device's key, told to the account service).
  if (pathname === `/v1/homes/${HOME}/e2e`) return home.online ? reply(200, await homeAnswer(init.body)) : reply(503, { code: "HOME_OFFLINE" });
  return reply(404, { code: "NOT_FOUND" });
};
const callsTo = (method) => cloud.calls.filter((call) => call.method === method && call.path === `/v1/homes/${HOME}/alerts`);

const { state, notify } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const { saveRemote } = await import("../../app/js/remote.js");
const session = await import("../../app/js/session.js");
const { alertKey, alertTexts, alertsUi, turnAlertsOff, turnAlertsOn } = await import("../../app/js/alerts.js");
const { alertsPage, alertsPanel, alertsStatus } = await import("../../app/js/views/alerts.js");

// ---- helpers -----------------------------------------------------------------------------------

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
function byKey(node, key) {
  let found = null;
  walk(node, (item) => {
    if (!found && item.dataset?.key === key) found = item;
  });
  return found;
}
const theSwitch = () => byKey(alertsPanel(), "alerts-switch");
const isOn = () => theSwitch().attributes["aria-checked"] === "true";
// Off, but focusable: aria-disabled, never disabled (the keyboard would be lost).
const isDisabled = () => {
  const attributes = theSwitch().attributes;
  assert.equal("disabled" in attributes, false, "kept focusable");
  return attributes["aria-disabled"] === "true";
};
const hint = () => byKey(alertsPanel(), "alerts-hint")?.textContent ?? null;
const shown = () => byKey(alertsPanel(), "alerts-message")?.textContent ?? null;

async function settle() {
  for (let index = 0; index < 100 && alertsUi.busy; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function press() {
  for (const listener of theSwitch().listeners.click) listener({ type: "click" });
  await settle();
}

// An admin on a device linked to the home, signed in.
function admin() {
  Object.assign(state, { apiKey: "ak_test", role: "admin", status: "connected", account: { status: "signed-in", user: { id: "u1" }, notice: null, busy: false } });
  saveRemote({ home: HOME, keyId: KEY_ID });
}

// ---- tests (in order: the first start registers again once) ------------------------------------

test("at start, a device with alerts on registers again, with a new subscription when the service's key changed", async () => {
  admin();
  browser.permission = "granted";
  browser.subscription = subscription(OLD_KEY);
  const old = browser.subscription.endpoint;
  localStorage.setItem("directorlink.alerts", JSON.stringify({ home: HOME, endpoint: old }));
  notify();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(browser.unsubscribed, [old], "the subscription made with the old key goes");
  assert.deepEqual(browser.subscribed, [{ userVisibleOnly: true, key: PUBLIC_KEY }]);
  const [post] = callsTo("POST");
  assert.equal(post.body.endpoint, browser.subscription.endpoint);
  assert.equal(post.credentials, "include");
  assert.deepEqual(callsTo("DELETE").map((call) => call.body), [{ endpoint: old }], "the old one is unregistered");
  assert.equal(JSON.parse(localStorage.getItem("directorlink.alerts")).endpoint, browser.subscription.endpoint);
  assert.equal(isOn(), true);
  assert.equal(savedTexts().lang, "en");
});

test("the card is for admins signed in to an account", () => {
  admin();
  assert.ok(alertsPanel());
  state.role = "member";
  assert.equal(alertsPanel(), null, "members");
  state.role = "admin";
  state.account = { status: "signed-out", user: null };
  assert.equal(alertsPanel(), null, "signed out");
  admin();
  localStorage.removeItem("directorlink.remote");
  assert.equal(isDisabled(), true, "a device not linked to the home");
  assert.match(hint(), /Link this device to your account/);
});

test("on: permission asked once, a subscription with the service's key, registered; off: unregistered and dropped", async () => {
  admin();
  await turnAlertsOff();
  cloud.calls.length = 0;
  browser.permission = "default";
  browser.subscribed.length = 0;
  assert.equal(isOn(), false);
  assert.equal(isDisabled(), false);
  assert.equal(hint(), null);

  await press();
  assert.equal(browser.asked, 1, "the permission is asked from the switch");
  assert.deepEqual(browser.subscribed, [{ userVisibleOnly: true, key: PUBLIC_KEY }]);
  const [post] = callsTo("POST");
  assert.deepEqual(post.body, { endpoint: browser.subscription.endpoint, keys: { p256dh: `p256dh-${browser.made}`, auth: `auth-${browser.made}` }, key_id: KEY_ID, offline: true, device_requests: true }, "with this device's key; a new device of this account asking to join is on by default");
  assert.equal(isOn(), true);
  assert.equal(shown(), "Alerts are on for this device.");
  const texts = savedTexts();
  assert.deepEqual(
    { lang: texts.lang, dir: texts.dir, title: texts.title, offline: texts.offline, schedule_failed: texts.schedule_failed, other: texts.other },
    {
      lang: "en",
      dir: "ltr",
      title: "DirectorLink",
      offline: "Your home – DirectorLink has not reached it since {time}. Check the home’s internet connection and the controller.",
      schedule_failed: "Your home – a schedule had a problem at {time}. Open the app to see what happened.",
      other: "Your home – something needs your attention. Open the app to see what happened.",
    }
  );
  assert.equal(texts.door_opened, "{name} was opened by {who} at {time}.");
  assert.equal(texts.doorbell_title, "Someone is at the door");
  assert.equal(savedAlertKey().key, KEY_ID, "the alert key of this device's key, for the worker");

  const endpoint = browser.subscription.endpoint;
  await press();
  assert.deepEqual(callsTo("DELETE").map((call) => call.body), [{ endpoint }]);
  assert.ok(browser.unsubscribed.includes(endpoint), "the browser drops its subscription");
  assert.equal(browser.subscription, null);
  assert.equal(isOn(), false);
  assert.equal(browser.asked, 1);
  assert.equal(savedAlertKey(), null, "the alert key goes too");
});

test("the words for the service worker follow the app's language", async () => {
  admin();
  await turnAlertsOn();
  await setLanguage("he");
  notify();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(savedTexts().lang, "he");
  assert.equal(savedTexts().dir, "rtl");
  assert.match(savedTexts().schedule_failed, /^הבית שלכם – תזמון נתקל בבעיה ב-\{time\}/);
  await setLanguage("en");
  notify();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(savedTexts().lang, "en");
  await turnAlertsOff();
});

test("refused: the permission, an account that is not an admin, a controller that has not said", async () => {
  admin();
  cloud.calls.length = 0;
  browser.permission = "default";
  browser.answer = "denied";
  await press();
  assert.equal(isOn(), false);
  assert.equal(callsTo("POST").length, 0, "nothing registered without permission");
  assert.equal(isDisabled(), true, "blocked: the switch cannot be used");
  assert.match(hint(), /blocked/);
  assert.equal(shown(), null, "said once, not twice");
  assert.equal(byKey(alertsPanel(), "alerts-hint").attributes.role, "status", "as the answer to the tap");
  assert.equal(theSwitch().attributes["aria-describedby"], "alerts-switch-help alerts-hint", "read on the switch");
  // Pressed again (it keeps the keyboard): nothing asked.
  const asked = browser.asked;
  await press();
  assert.equal(browser.asked, asked);
  // The prompt closed without an answer: said, as nothing else says it.
  browser.permission = "default";
  browser.answer = "default";
  await press();
  assert.equal(hint(), null);
  assert.match(shown(), /blocked/);

  browser.permission = "granted";
  browser.answer = "granted";
  cloud.calls.length = 0;
  // Not an admin as far as the account service knows: the device's key is told to it through the
  // account (a sealed request), and it is asked once more.
  home.online = true;
  cloud.posts.push([403, { code: "ADMIN_ONLY" }], [403, { code: "ADMIN_ONLY" }]);
  await press();
  home.online = false;
  assert.equal(callsTo("POST").length, 2);
  assert.ok(cloud.calls.some((call) => call.path.endsWith("/e2e")), "a sealed request through the account in between");
  assert.equal(isOn(), false);
  assert.equal(shown(), "Only the home’s admins get alerts.");
  assert.equal(browser.subscription, null, "the subscription is not kept");

  cloud.posts.push([409, { code: "ROLES_UNKNOWN" }]);
  await press();
  assert.match(shown(), /DirectorLink 1\.6\.0 or later on the controller/);
  cloud.get = [503, { code: "ALERTS_NOT_CONFIGURED" }];
  await press();
  assert.equal(shown(), "Alerts aren’t available yet. Try again later.");
  cloud.get = null;
  assert.equal(isOn(), false);
});

test("while it works the switch keeps the keyboard: off to the eye and to a second press, not disabled", async () => {
  admin();
  await turnAlertsOff();
  browser.permission = "granted";
  cloud.calls.length = 0;
  let answer;
  cloud.get = null;
  const realFetch = globalThis.fetch;
  // The account service answers when told to.
  globalThis.fetch = (url, init) => new Promise((resolve) => (answer = () => resolve(realFetch(url, init))));
  try {
    for (const listener of theSwitch().listeners.click) listener({ type: "click" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(alertsUi.busy, true);
    const busy = theSwitch();
    assert.equal(busy.attributes["aria-disabled"], "true");
    assert.equal(busy.attributes["aria-busy"], "true");
    assert.equal("disabled" in busy.attributes, false, "still focusable");
    for (const listener of busy.listeners.click) listener({ type: "click" });
    globalThis.fetch = realFetch;
    answer();
    await settle();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(callsTo("GET").length, 1, "pressed while busy: nothing more");
  assert.equal(isOn(), true);
  assert.equal(isDisabled(), false);
  await turnAlertsOff();
});

test("a browser that cannot receive pushes says so", () => {
  admin();
  const push = window.PushManager;
  delete window.PushManager;
  try {
    assert.equal(isDisabled(), true);
    assert.equal(hint(), "This browser can’t show alerts.");
  } finally {
    window.PushManager = push;
  }
});

test("a forgotten key ends this device's alerts", async () => {
  admin();
  await turnAlertsOn();
  assert.equal(isOn(), true);
  const endpoint = browser.subscription.endpoint;
  cloud.calls.length = 0;
  session.forgetKey();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(callsTo("DELETE").map((call) => call.body), [{ endpoint }]);
  assert.equal(browser.subscription, null);
  assert.equal(localStorage.getItem("directorlink.alerts"), null);
});

// ---- DirectorLink 1.7.0: alerts sealed to each key, chosen per kind (ADR-050) --------------------

const VECTORS = JSON.parse(readFileSync(new URL("../vectors/alert.json", import.meta.url), "utf8"));
const kindSwitch = (kind) => byKey(alertsPanel(), `alerts-kind:${kind}`);
async function pressKind(kind) {
  for (const listener of kindSwitch(kind).listeners.click) listener({ type: "click" });
  for (let index = 0; index < 100 && alertsUi.saving; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// A device with `role`, its home's controller DirectorLink 1.7.0, reached through the account.
function withChoices(role, kinds = { doorbell: true }) {
  admin();
  Object.assign(state, { role, transport: "remote", system: { features: { alert_choices: true } } });
  Object.assign(home, { online: true, fail: false, requests: [], choices: { on: false, kinds } });
  cloud.calls.length = 0;
  browser.permission = "granted";
  browser.answer = "granted";
}

test("the alert key is the one the driver seals to (tests/vectors/alert.json)", async () => {
  const key = await alertKey(VECTORS.device.api_key);
  assert.equal(Buffer.from(key).toString("hex"), VECTORS.device.alert_key_hex);
});

test("with DirectorLink 1.7.0 every role may switch alerts on: registered with its key, the controller told, a switch per kind", async () => {
  await turnAlertsOff();
  withChoices("member", { doorbell: true, fridge_door: true });
  assert.ok(alertsPanel(), "a member sees the card");
  state.role = "viewer";
  assert.ok(alertsPanel(), "and a viewer");
  state.role = "member";
  assert.match(alertsPanel().textContent, /sealed for this device/);

  await press();
  assert.equal(isOn(), true);
  assert.equal(callsTo("POST")[0].body.key_id, KEY_ID);
  assert.deepEqual(toHome("PUT", "/v1/alerts/choices").map((request) => request.body), [{ on: true }], "the controller is told");
  assert.equal(home.choices.on, true);
  assert.deepEqual(savedAlertKey().home, HOME);

  // A switch per kind the controller offers this key; no offline alert for a member.
  assert.equal(kindSwitch("offline"), null);
  assert.equal(kindSwitch("door_opened"), null, "not for its role");
  assert.equal(kindSwitch("doorbell").attributes["aria-checked"], "true");
  await pressKind("doorbell");
  assert.deepEqual(toHome("PUT", "/v1/alerts/choices").at(-1).body, { kinds: { doorbell: false } });
  assert.equal(kindSwitch("doorbell").attributes["aria-checked"], "false");
  assert.equal(kindSwitch("fridge_door").attributes["aria-checked"], "true");

  // Off: the account service forgets the browser, the controller is told, the alert key goes.
  await press();
  assert.equal(isOn(), false);
  assert.deepEqual(toHome("PUT", "/v1/alerts/choices").at(-1).body, { on: false });
  assert.equal(callsTo("DELETE").length, 1);
  assert.equal(savedAlertKey(), null);
  assert.equal(kindSwitch("doorbell"), null, "no kinds while off");
});

test("an admin also chooses the servers' offline alert, kept with the browser's registration", async () => {
  await turnAlertsOff();
  withChoices("admin", { doorbell: true, door_opened: false, schedule_failed: true });
  await press();
  assert.equal(isOn(), true);
  assert.equal(kindSwitch("offline").attributes["aria-checked"], "true");
  assert.equal(kindSwitch("door_opened").attributes["aria-checked"], "false", "doors opened are off until chosen");
  cloud.calls.length = 0;
  await pressKind("offline");
  assert.equal(callsTo("POST")[0].body.offline, false, "registered again, without the offline alert");
  assert.equal(kindSwitch("offline").attributes["aria-checked"], "false");
  assert.equal(toHome("PUT", "/v1/alerts/choices").length, 1, "the controller has nothing to do with it");
  await pressKind("door_opened");
  assert.deepEqual(home.choices.kinds, { doorbell: true, door_opened: true, schedule_failed: true });
  await turnAlertsOff();
});

test("an admin chooses the push of a new device asking to join, kept with the browser's registration (1.8.0)", async () => {
  await turnAlertsOff();
  withChoices("admin", { doorbell: true });
  await press();
  assert.equal(callsTo("POST").at(-1).body.device_requests, true, "on by default");
  assert.equal(kindSwitch("device_requests").attributes["aria-checked"], "true");
  assert.match(byKey(alertsPanel(), "alerts-kinds").textContent, /A new device of mine asks to join/);
  cloud.calls.length = 0;
  await pressKind("device_requests");
  assert.deepEqual(
    callsTo("POST").map((call) => [call.body.offline, call.body.device_requests]),
    [[true, false]],
    "registered again without it, the offline alert as it was"
  );
  assert.equal(kindSwitch("device_requests").attributes["aria-checked"], "false");
  assert.equal(toHome("PUT", "/v1/alerts/choices").length, 1, "the controller has nothing to do with it");
  // Kept: the next start registers with it off, and the offline choice beside it.
  await pressKind("offline");
  assert.deepEqual(callsTo("POST").at(-1).body.device_requests, false);
  assert.equal(JSON.parse(localStorage.getItem("directorlink.alerts")).deviceRequests, false);
  // A member has no such switch with a 1.8.0 controller: only admins approve there; since 1.9.0
  // (`features.users`, ADR-061) every user approves their own account's new device, and has it.
  state.role = "member";
  assert.equal(kindSwitch("device_requests"), null);
  const system = state.system;
  state.system = { ...(system || {}), features: { ...(system?.features || {}), users: true } };
  assert.ok(kindSwitch("device_requests"), "a member's switch with users");
  assert.equal(kindSwitch("offline"), null, "the home offline stays the admins'");
  state.system = system;
  state.role = "admin";
  assert.equal(savedTexts().device_request, "A new device asks to join your home. Open DirectorLink to approve or decline it.");
  await turnAlertsOff();
});

test("Settings' Alerts row says how alerts are on this device, and its page holds the switch (1.10.0)", async () => {
  await turnAlertsOff();
  const status = () => alertsStatus();
  // Signed in, linked, allowed by the browser: off until switched on.
  withChoices("admin", { doorbell: true, door_opened: false, schedule_failed: true });
  assert.equal(status(), "Off");
  assert.ok(byKey(alertsPage(), "alerts-switch"), "the page holds the switch");
  // What it still needs, as the card's hint says it.
  browser.permission = "denied";
  assert.equal(status(), "Notifications are blocked");
  browser.permission = "granted";
  const push = window.PushManager;
  delete window.PushManager;
  try {
    assert.equal(status(), "This browser can’t show alerts");
  } finally {
    window.PushManager = push;
  }
  const remote = localStorage.getItem("directorlink.remote");
  localStorage.removeItem("directorlink.remote");
  assert.equal(status(), "Link this device to your account first");
  localStorage.setItem("directorlink.remote", remote);
  // On: how many of the kinds this key may choose are on (the servers' two for an admin, then the
  // controller's), once the controller has said which.
  await press();
  assert.equal(isOn(), true);
  assert.equal(status(), "On · 4 of 5 kinds");
  await pressKind("door_opened");
  assert.equal(status(), "On · 5 of 5 kinds");
  await setLanguage("he");
  try {
    assert.equal(status(), "פעילות · 5 מתוך 5 סוגים");
  } finally {
    await setLanguage("en");
  }
  // Not known yet (a start, before the controller is read): on, without a count.
  const choices = alertsUi.choices;
  alertsUi.choices = null;
  assert.equal(status(), "On");
  alertsUi.choices = choices;
  // A controller before 1.7.0: an admin's alerts, without kinds.
  const system = state.system;
  state.system = { features: {} };
  assert.equal(status(), "On");
  state.role = "member";
  assert.equal(status(), null, "a member of such a controller: no row");
  state.system = system;
  state.role = "admin";
  // Signed out with alerts on: signing out turns them off (settings.js), but a session that ended
  // (30 days) or a cookie cleared does not, and this browser keeps getting them. The row and the
  // page say so, and the switch's Off works without the account.
  state.account = { status: "signed-out", user: null, notice: null, busy: false };
  assert.equal(status(), "On · sign in again to change them");
  let page = alertsPage();
  const offSwitch = byKey(page, "alerts-switch");
  assert.equal(offSwitch.attributes["aria-checked"], "true");
  assert.equal(offSwitch.attributes["aria-disabled"], undefined, "Off can be used");
  assert.equal(offSwitch.attributes["aria-describedby"], "alerts-switch-help alerts-hint");
  assert.equal(byKey(page, "alerts-hint").textContent, "Alerts are on; sign in again to change them.");
  assert.ok(byKey(page, "alerts-sign-in-choose"), "it offers to sign in (Sign in, until the account service has said how)");
  assert.equal(byKey(page, "alerts-kinds"), null, "the kinds wait for the account");
  await setLanguage("he");
  try {
    assert.equal(status(), "פעילות · התחברו שוב כדי לשנות");
    assert.equal(byKey(alertsPage(), "alerts-hint").textContent, "ההתראות פעילות; התחברו שוב כדי לשנות אותן.");
  } finally {
    await setLanguage("en");
  }
  // The account service out of reach, or not asked yet: on, as far as this device knows.
  state.account = { status: "unavailable", user: null, notice: null, busy: false };
  assert.equal(status(), "On");
  assert.equal(byKey(alertsPage(), "alerts-switch").attributes["aria-checked"], "true");
  assert.ok(byKey(alertsPage(), "alerts-account-retry"));
  state.account = { status: "loading", user: null, notice: null, busy: false };
  assert.equal(status(), "On");
  state.account = { status: "signed-out", user: null, notice: null, busy: false };
  const deletes = callsTo("DELETE").length;
  for (const listener of offSwitch.listeners.click) listener({ type: "click" });
  await settle();
  assert.equal(callsTo("DELETE").length, deletes + 1, "the account service is asked to forget this browser");
  assert.equal(browser.subscription, null, "and the browser drops its subscription");
  assert.equal(status(), "Sign in to get alerts");
  page = alertsPage();
  assert.equal(byKey(page, "alerts-switch"), null);
  assert.equal(byKey(page, "alerts-message").textContent, "Alerts are off for this device.");
  assert.ok(byKey(page, "alerts-sign-in-choose"));
  // Signed out, what this browser lacks comes first: signing in would not help.
  browser.permission = "denied";
  assert.equal(status(), "Notifications are blocked");
  assert.match(byKey(alertsPage(), "alerts-hint").textContent, /^Notifications are blocked for DirectorLink\./);
  assert.ok(byKey(alertsPage(), "alerts-sign-in-choose"), "allowed again, they come through the account");
  browser.permission = "granted";
  delete window.PushManager;
  try {
    assert.equal(status(), "This browser can’t show alerts");
    page = alertsPage();
    assert.equal(byKey(page, "alerts-hint").textContent, "This browser can’t show alerts.");
    assert.equal(byKey(page, "alerts-sign-in-choose"), null, "no sign-in that could not help");
  } finally {
    window.PushManager = push;
  }
  admin();
  alertsUi.message = null;
  await turnAlertsOff();
  assert.equal(status(), "Off");
});

test("a controller that cannot be told leaves alerts off; a change it cannot save says so", async () => {
  await turnAlertsOff();
  withChoices("member");
  home.fail = true;
  await press();
  assert.equal(isOn(), false, "nothing it seals would come");
  assert.equal(callsTo("DELETE").length, 1, "the browser is unregistered again");
  assert.equal(browser.subscription, null);
  assert.equal(shown(), "Alerts could not be switched on. Check the connection and try again.");

  home.fail = false;
  await press();
  assert.equal(isOn(), true);
  home.fail = true;
  await pressKind("doorbell");
  assert.equal(shown(), "Couldn’t save that. Check the connection and try again.");
  assert.equal(kindSwitch("doorbell").attributes["aria-checked"], "true", "as it was");
  home.fail = false;
  await turnAlertsOff();
});

test("an account that has not used its key at the home yet uses it once through the account, then registers", async () => {
  await turnAlertsOff();
  withChoices("member");
  cloud.posts.push([403, { code: "KEY_NOT_LINKED" }]);
  await press();
  assert.equal(callsTo("POST").length, 2);
  assert.ok(toHome("GET", "/v1/api-keys/current").length >= 1, "a sealed request through the account in between");
  assert.equal(isOn(), true);
  await turnAlertsOff();
});

test("when that request cannot reach the home, it says the home could not be reached, not that the device is not linked", async () => {
  await turnAlertsOff();
  withChoices("member");
  home.online = false;
  cloud.posts.push([403, { code: "KEY_NOT_LINKED" }]);
  await press();
  assert.equal(isOn(), false);
  assert.equal(callsTo("POST").length, 1, "not registered again in vain");
  assert.equal(shown(), "Your home couldn’t be reached to confirm this device. Check that it’s online, then try again.");
  assert.equal(browser.subscription, null, "the subscription goes again");
  home.online = true;
});

test("a controller that does not know this device has alerts on is told: switched on by an app before 1.7.0, or restored", async () => {
  await turnAlertsOff();
  withChoices("admin", { doorbell: true, door_opened: false, schedule_failed: true });
  // A new start of the page: nothing read from the controller yet.
  await press();
  await turnAlertsOff({ quiet: true });
  home.choices.on = false;
  home.requests.length = 0;
  // As the app before 1.7.0 left it: no key id, and the controller knows nothing of it.
  browser.subscription = subscription(PUBLIC_KEY);
  localStorage.setItem("directorlink.alerts", JSON.stringify({ home: HOME, endpoint: browser.subscription.endpoint }));
  notify();
  // Until the controller is told and the switches show it (a fixed wait was too short on a busy
  // machine), at most 5 s.
  const told = () => toHome("PUT", "/v1/alerts/choices").length > 0 && isOn() && kindSwitch("schedule_failed");
  for (let waited = 0; waited < 5000 && !told(); waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(toHome("GET", "/v1/alerts/choices").length, 1);
  assert.deepEqual(toHome("PUT", "/v1/alerts/choices").map((request) => request.body), [{ on: true }]);
  assert.equal(home.choices.on, true);
  assert.equal(isOn(), true);
  assert.equal(kindSwitch("schedule_failed").attributes["aria-checked"], "true");
  await turnAlertsOff();
});

// ---- DirectorLink 1.8.0: camera alerts (ADR-056) ------------------------------------------------

test("camera alerts are offered only with a controller that has them, off until chosen, saying what they are", async () => {
  await turnAlertsOff();
  withChoices("viewer", { doorbell: true, camera: false });
  await press();
  assert.equal(isOn(), true);
  assert.equal(kindSwitch("camera"), null, "a controller that does not say it has them (features.camera_alerts)");
  state.system = { features: { alert_choices: true, camera_alerts: true } };
  assert.equal(kindSwitch("camera").attributes["aria-checked"], "false", "off until chosen");
  assert.equal(kindSwitch("camera").attributes["aria-describedby"], "alerts-kind-camera-help");
  assert.match(alertsPanel().textContent, /A camera sees a person, a vehicle or a line crossed/);
  assert.match(alertsPanel().textContent, /cameras can be busy/);
  await pressKind("camera");
  assert.deepEqual(toHome("PUT", "/v1/alerts/choices").at(-1).body, { kinds: { camera: true } });
  assert.equal(kindSwitch("camera").attributes["aria-checked"], "true");
  // The service worker gets the words for every detection the controller may name.
  const texts = savedTexts();
  assert.equal(texts.camera_title, "Camera alert");
  assert.equal(texts.camera, "{what} at {name} at {time}.");
  assert.equal(texts.camera_line_crossing, "Line crossed");
  await turnAlertsOff();
});

test("the app gives the service worker a word for every camera detection the worker knows, in every language", async () => {
  const worker = readFileSync(new URL("../../app/sw.js", import.meta.url), "utf8");
  const known = [...worker.matchAll(/^\s+(camera(?:_[a-z_]+)?):/gm)].map((match) => match[1]).sort();
  assert.ok(known.includes("camera_person") && known.includes("camera_other") && known.includes("camera_title"));
  for (const language of ["en", "es", "it", "he"]) {
    await setLanguage(language);
    const texts = alertTexts();
    assert.equal(texts.lang, language);
    const given = Object.keys(texts).filter((name) => name.startsWith("camera")).sort();
    assert.deepEqual(given, known, language);
    for (const name of given) assert.ok(texts[name] && !texts[name].startsWith("alerts."), `${language}: ${name}`);
    assert.match(texts.camera, /\{what\}.*\{name\}.*\{time\}/, language);
  }
  assert.equal(alertTexts().camera_person, "אדם");
  await setLanguage("en");
});

// DirectorLink's camera agreement (1.10.0, ADR-065): an animal, a package and a license plate are
// said in the app's words, in English and Hebrew.
test("the camera agreement's new labels have their words for the service worker", async () => {
  assert.equal(alertTexts().camera_animal, "Animal");
  assert.equal(alertTexts().camera_package, "Package");
  assert.equal(alertTexts().camera_license_plate, "License plate");
  await setLanguage("he");
  assert.equal(alertTexts().camera_animal, "בעל חיים");
  assert.equal(alertTexts().camera_package, "חבילה");
  assert.equal(alertTexts().camera_license_plate, "לוחית רישוי");
  await setLanguage("en");
});

// The sounds a camera hears (1.11.0, ADR-080: the DirectorLink · UniFi Protect driver's labels) are
// said in the app's words in every language, as "{what} at {name} at {time}." reads them.
test("the sounds a camera hears have their words for the service worker, in every language", async () => {
  const { t } = await import("../../app/js/i18n.js");
  const words = {
    en: ["Smoke alarm", "CO alarm", "Siren", "Baby crying", "Someone talking", "Dog barking", "Burglar alarm", "Car horn", "Glass breaking"],
    he: ["גלאי עשן", "גלאי פחמן חד-חמצני", "סירנה", "בכי תינוק", "דיבור", "נביחות", "אזעקת פריצה", "צופר רכב", "שבירת זכוכית"],
    es: ["Alarma de humo", "Alarma de CO", "Sirena", "Bebé llorando", "Alguien hablando", "Perro ladrando", "Alarma antirrobo", "Claxon", "Rotura de cristal"],
    it: ["Allarme fumo", "Allarme CO", "Sirena", "Bambino che piange", "Qualcuno parla", "Cane che abbaia", "Allarme antifurto", "Clacson", "Vetro rotto"],
  };
  const sounds = ["smoke_alarm", "co_alarm", "siren", "baby_crying", "speech", "barking", "burglar_alarm", "car_horn", "glass_break"];
  const sentence = { en: "Smoke alarm at Garden at 21:14.", he: "גלאי עשן ב-גינה ב-21:14.", es: "Alarma de humo en Garden a las 21:14.", it: "Allarme fumo presso Garden alle 21:14." };
  for (const language of ["en", "he", "es", "it"]) {
    await setLanguage(language);
    const texts = alertTexts();
    assert.deepEqual(sounds.map((what) => texts[`camera_${what}`]), words[language], language);
    const name = language === "he" ? "גינה" : "Garden";
    assert.equal(texts.camera.replace("{what}", texts.camera_smoke_alarm).replace("{name}", name).replace("{time}", "21:14"), sentence[language], language);
    // Settings → Alerts says a smoke or CO alarm is not held back by the camera's minute.
    assert.match(t("alerts.settings.cameraHelp"), { en: /smoke or CO alarm/, he: /גלאי עשן או פחמן חד-חמצני/, es: /alarma de humo o de CO/, it: /allarme fumo o CO/ }[language], language);
  }
  await setLanguage("en");
});
