// A doorbell's doors in the app (DirectorLink 1.11.0, ADR-078): a ring's notification opens the
// doorbell's own screen (#/doorbell/<id>) with its live picture and a big "Open <door>" for each door
// at it this user may open; Home's ring banner has the same button; the two taps open the door with
// its own Open (POST /v1/relays/{id}/pulse, once, saying which doorbell it came from); a member without
// door access sees the picture and no Open; an admin adds doors at the doorbell (a KNX relay) and
// removes them; the service worker gets the doors' names for its "Open <door>…" buttons, for this
// home and key only; History says "From the doorbell"; in English, Hebrew, Spanish and Italian.
//   node --test tests/app/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";

const HOST = "controller.invalid";
const KEY = "ak_test";
const HOME = "0123456789abcdef0123456789abcdef";
const stored = new Map();

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = "";
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
  dispatch(type, init = {}) {
    const event = { type, currentTarget: this, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init };
    for (const listener of this.listeners[type] || []) listener(event);
    return event;
  }
  append(...children) {
    this.children.push(...children);
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}
globalThis.Node = FakeNode;
globalThis.window = globalThis;
window.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/", pathname: "/", search: "", hash: "", replace: () => {} };
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.document = {
  hidden: false,
  documentElement: {},
  body: { append() {} },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeNode(), { textContent: String(text) }),
};
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Node", maxTouchPoints: 0, languages: ["en"], language: "en", onLine: true },
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
    clear: () => stored.clear(),
  },
  configurable: true,
});
// Cache Storage, where the app keeps what the service worker reads.
class FakeCache {
  entries = new Map();
  async put(path, response) {
    this.entries.set(path, await response.text());
  }
  async match(path) {
    return this.entries.has(path) ? new Response(this.entries.get(path)) : undefined;
  }
  async delete(path) {
    return this.entries.delete(path);
  }
}
const cacheStores = new Map();
globalThis.caches = {
  open: async (name) => {
    if (!cacheStores.has(name)) cacheStores.set(name, new FakeCache());
    return cacheStores.get(name);
  },
};
globalThis.history = { state: { directorlinkInApp: true }, back: () => {} };
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-10-10T08:00:30Z") });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 16);

// The fake controller, a DirectorLink that cannot seal (requests carry the key): what it was asked,
// with each body; `refuse`: the problem a pulse gets instead of 202.
const controller = { calls: [], refuse: null };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname: path } = new URL(url);
  if (hostname !== HOST) throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  controller.calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  if (path === "/v1/sealed") return reply(404, { status: 404, code: "NOT_FOUND" });
  if (!init.headers?.Authorization) return reply(401, { status: 401, code: "UNAUTHORIZED" });
  const pulse = path.match(/^\/v1\/relays\/(\d+)\/pulse$/);
  if (pulse && method === "POST") {
    if (controller.refuse) return reply(403, { status: 403, ...controller.refuse });
    return reply(202, RELAYS.find((item) => item.id === Number(pulse[1])));
  }
  const doors = path.match(/^\/v1\/doorbells\/(\d+)\/doors$/);
  if (doors && method === "PUT") {
    const ids = JSON.parse(init.body).door_ids;
    const automatic = ENTRANCE.doors.filter((item) => item.link === "automatic");
    return reply(200, { ...ENTRANCE, doors: [...automatic, ...ids.map((id) => ({ id, link: "manual", can_open: true }))] });
  }
  if (method === "GET") return reply(200, { items: [] });
  return reply(404, { status: 404, code: "NOT_FOUND", detail: `no ${method} ${path}` });
};

const { state, ui, notify } = await import("../../app/js/state.js");
const session = await import("../../app/js/session.js");
const { setLanguage, t } = await import("../../app/js/i18n.js");
const { doorbellBanner, doorbellCard } = await import("../../app/js/components.js");
const { doorbellView } = await import("../../app/js/views/doorbell.js");
const { ringDoors, RING_DOORS_PATH } = await import("../../app/js/doorbell-doors.js");
const { takeNotificationOpen } = await import("../../app/js/pwa.js");
const history = await import("../../app/js/views/history.js");

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms, step = 100) {
  for (let done = 0; done < ms; done += step) {
    mock.timers.tick(Math.min(step, ms - done));
    await settle();
  }
  await settle();
}

function walk(nodes, visit) {
  for (const node of [nodes].flat(Infinity)) {
    if (!node) continue;
    visit(node);
    walk(node.children || [], visit);
  }
}
function findAll(nodes, check) {
  const found = [];
  walk(nodes, (node) => node instanceof FakeElement && check(node) && found.push(node));
  return found;
}
const find = (nodes, check) => findAll(nodes, check)[0] || null;
const byKey = (nodes, key) => find(nodes, (node) => node.dataset.key === key);
const hasClass = (node, name) => typeof node.className === "string" && node.className.split(/\s+/).includes(name);
const byClass = (nodes, name) => find(nodes, (node) => hasClass(node, name));
const plain = (text) => String(text ?? "").replace(/[⁦-⁩]/g, "");
const posts = () => controller.calls.filter((call) => call.method !== "GET");

const kitchen = { id: 10, name: "Kitchen" };
const entrance = { id: 12, name: "Entrance" };
// As DirectorLink 1.11.0 lists them (driver/tests/c4mock.lua withDoorbellGate): the doorbell camera 68
// "Entrance", its gate 76 found on its driver's relay, and the KNX door 70 an admin added.
const RELAYS = [
  { id: 76, name: "Entrance Gate", room: entrance, state: null, state_reported: false, kind: "gate", door_state: null },
  { id: 70, name: "Main Door", room: kitchen, state: null, state_reported: true, kind: "relay", door_state: null },
  { id: 71, name: "Garden Gate", room: kitchen, state: null, state_reported: false, kind: "gate", door_state: "closed" },
];
const ENTRANCE = {
  id: 68,
  name: "Entrance",
  room: entrance,
  camera: { id: 68, snapshot_href: "/v1/cameras/68/snapshot" },
  can_open: false,
  connected: null,
  last_ring_at: "2026-10-10T08:00:00Z",
  last_motion_at: null,
  last_opened_at: null,
  last_access_at: null,
  events: [{ type: "doorbell", at: "2026-10-10T08:00:00Z" }],
  doors: [
    { id: 76, link: "automatic", can_open: true },
    { id: 70, link: "manual", can_open: true },
  ],
};

async function connect({ access = null, doorbell = ENTRANCE } = {}) {
  session.forgetKey();
  await advance(100);
  controller.calls = [];
  controller.refuse = null;
  Object.assign(state, {
    host: HOST,
    apiKey: KEY,
    role: "admin",
    access,
    status: "connected",
    loaded: true,
    rooms: [kitchen, entrance],
    lights: [],
    thermostats: [],
    fans: [],
    blinds: [],
    cameras: [],
    relays: RELAYS.map((item) => ({ ...item })),
    doorbells: [structuredClone(doorbell)],
    refrigerators: [],
    devices: [],
    errors: {},
    system: { bridge: { version: "1.11.0" }, inventory: { relays: 3, doorbells: 1 }, features: {} },
  });
  ui.relayStage = {};
  ui.doorbellStage = {};
  ui.doorbellLinks = null;
  notify();
  await advance(100);
}

const screen = () => doorbellView(68, { openCamera: () => {} });

test("a ring's screen: its live picture first, and Open <door> for each door this user may open", async () => {
  await setLanguage("en");
  await connect();
  const view = screen();
  assert.equal(plain(byClass(view, "page-title").textContent), "Entrance", "the doorbell's name");
  const picture = find(view, (node) => node.tagName === "IMG" && node.dataset.cameraId === "68");
  assert.ok(picture, "its camera's picture");
  assert.equal(picture.dataset.live, "1", "live, as on the banner");
  const section = byClass(view, "doorbell-screen");
  assert.ok(hasClass(section, "is-ringing"), "someone is at the door");
  assert.match(plain(byClass(view, "doorbell-screen-meta").textContent), /^Someone is at the door · Rang/);
  const gate = byKey(view, "doorbell:68:door:76:screen");
  assert.equal(plain(gate.textContent), "Open Entrance Gate");
  assert.equal(plain(byKey(view, "doorbell:68:door:70:screen").textContent), "Open Main Door");
  assert.equal(byKey(view, "doorbell:68:open"), null, "the doorbell itself opens nothing");
  assert.equal(byClass(view, "muted-note"), null, "no word about access");
});

test("the two taps open the door with its own Open, once, saying it came from the doorbell", async () => {
  await setLanguage("en");
  await connect();
  byKey(screen(), "doorbell:68:door:76:screen").dispatch("click");
  await settle();
  assert.equal(ui.relayStage[76], "confirm", "the first tap asks for a second");
  assert.equal(plain(byKey(screen(), "doorbell:68:door:76:screen").textContent), "Tap again to open");
  assert.ok(byKey(screen(), "doorbell:68:door:76:cancel:screen"), "and can be cancelled");
  assert.deepEqual(posts(), [], "nothing sent yet");
  byKey(screen(), "doorbell:68:door:76:screen").dispatch("click");
  await advance(200);
  assert.deepEqual(posts(), [{ method: "POST", path: "/v1/relays/76/pulse", body: { doorbell: 68 } }], "the door's own Open, once");
  assert.equal(ui.relayStage[76], "sent");
  assert.equal(plain(byKey(screen(), "doorbell:68:door:76:screen").textContent), "Sent");
  // The door's own row is the same door: it says it too.
  assert.equal(ui.relayStage[76], "sent");

  // Refused by the controller (Door Control off): said under the buttons.
  await connect();
  controller.refuse = { code: "DOOR_CONTROL_DISABLED", detail: "Door control is off" };
  byKey(screen(), "doorbell:68:door:70:screen").dispatch("click");
  await settle();
  byKey(screen(), "doorbell:68:door:70:screen").dispatch("click");
  await advance(200);
  assert.ok(state.errors["relay:70"], "the door's error");
  assert.ok(find(screen(), (node) => hasClass(node, "inline-error") && node.textContent === state.errors["relay:70"].text));
});

test("Home's ring banner has the same Open <door>, with the same two taps", async () => {
  await setLanguage("en");
  await connect();
  let banner = doorbellBanner(state.doorbells[0], { openCamera: () => {} });
  const gate = byKey(banner, "doorbell:68:door:76:banner");
  assert.equal(plain(gate.textContent), "Open Entrance Gate");
  assert.ok(byKey(banner, "doorbell:68:dismiss"), "Dismiss stays");
  gate.dispatch("click");
  await settle();
  banner = doorbellBanner(state.doorbells[0], { openCamera: () => {} });
  assert.equal(plain(byKey(banner, "doorbell:68:door:76:banner").textContent), "Tap again to open");
  byKey(banner, "doorbell:68:door:76:banner").dispatch("click");
  await advance(200);
  assert.deepEqual(posts(), [{ method: "POST", path: "/v1/relays/76/pulse", body: { doorbell: 68 } }]);
});

test("without door access the picture shows and no Open, as at the door itself", async () => {
  await setLanguage("en");
  // A member without doors and gates.
  await connect({ access: { role: "member", doors: false, cameras: true } });
  let view = screen();
  assert.ok(find(view, (node) => node.tagName === "IMG" && node.dataset.cameraId === "68"), "the picture");
  assert.equal(byKey(view, "doorbell:68:door:76:screen"), null, "no Open");
  assert.equal(plain(byClass(view, "muted-note").textContent), "Opening the gate needs door access.");
  let banner = doorbellBanner(state.doorbells[0], { openCamera: () => {} });
  assert.equal(byKey(banner, "doorbell:68:door:76:banner"), null);
  assert.equal(byClass(banner, "ring-note").textContent, "Opening the gate needs door access.");
  assert.equal(byClass(view, "doorbell-links"), null, "no admin's links");

  // With doors, but the controller lets them open none (Door Control off in Composer): no Open, and why.
  await connect({ access: { role: "member", doors: true, cameras: true }, doorbell: { ...ENTRANCE, doors: [{ id: 76, link: "automatic", can_open: false }] } });
  view = screen();
  assert.equal(byKey(view, "doorbell:68:door:76:screen"), null);
  assert.equal(plain(byClass(view, "muted-note").textContent), "Door control is off. Turn on Door Control in Composer (DirectorLink properties).");
  banner = doorbellBanner(state.doorbells[0], { openCamera: () => {} });
  assert.equal(byKey(banner, "doorbell:68:door:76:banner"), null);
  assert.deepEqual(posts(), []);
});

test("a ring's notification lands on the doorbell's screen, also when the app was closed", async () => {
  await setLanguage("en");
  const app = readFileSync(new URL("../../app/app.js", import.meta.url), "utf8");
  assert.match(app, /parts\[0\] === "doorbell" && \/\^\\d\+\$\/\.test\(parts\[1\] \|\| ""\)\) \{\s*return \{ name: "doorbell", id: Number\(parts\[1\]\), tab: "home" \};/);
  assert.match(app, /case "doorbell":\s*return doorbellView\(route\.id, actions\);/);
  const sw = readFileSync(new URL("../../app/sw.js", import.meta.url), "utf8");
  assert.ok(sw.includes('url: id ? `/#/doorbell/${id}` : "/#/"'), "the ring's tap");
  for (const module of ['"/js/doorbell-doors.js"', '"/js/views/doorbell.js"']) assert.ok(sw.includes(module), `${module} in the offline shell`);

  // The worker kept the tap: an app opened on its start page (or asleep when told) goes there.
  window.location.hash = "#/";
  const alerts = await caches.open("directorlink-alerts");
  await alerts.put("/notification-open.json", new Response(JSON.stringify({ url: "https://app.directorlink.io/#/doorbell/68", at: Date.now() - 5000 })));
  assert.equal(await takeNotificationOpen(), true);
  assert.equal(window.location.hash, "#/doorbell/68");
  assert.equal(await alerts.match("/notification-open.json"), undefined, "taken once");
  // One older than a minute, or another site's, is not followed.
  window.location.hash = "#/";
  await alerts.put("/notification-open.json", new Response(JSON.stringify({ url: "https://app.directorlink.io/#/doorbell/68", at: Date.now() - 120000 })));
  assert.equal(await takeNotificationOpen(), false);
  await alerts.put("/notification-open.json", new Response(JSON.stringify({ url: "https://elsewhere.example/#/doorbell/68", at: Date.now() })));
  await takeNotificationOpen();
  assert.equal(window.location.hash, "#/");

  // Before the doorbells are read, the screen waits with its picture's place, then shows Open.
  state.loaded = false;
  state.status = "connecting";
  assert.equal(byKey(screen(), "doorbell:68:door:76:screen"), null);
  ui.ringCamera = { doorbell: 68, camera: 68 };
  assert.ok(find(screen(), (node) => node.tagName === "IMG" && node.dataset.cameraId === "68" && node.dataset.live === "1"), "the kept camera's picture at once");
  await connect();
  assert.ok(byKey(screen(), "doorbell:68:door:76:screen"));
});

test("an admin adds a door at the doorbell and removes it; the gate on its relay stays", async () => {
  await setLanguage("en");
  await connect({ doorbell: { ...ENTRANCE, doors: [{ id: 76, link: "automatic", can_open: true }] } });
  let view = screen();
  const card = byClass(view, "doorbell-links");
  assert.ok(card, "the doorbell's doors, for admins");
  assert.match(plain(card.textContent), /Entrance Gate.*On the doorbell’s relay/);
  assert.equal(byKey(view, "doorbell:68:unlink:76"), null, "found by its relay: no Remove");
  const choice = byKey(view, "doorbell:68:link-choice");
  assert.deepEqual(choice.children.map((option) => option.attributes.value), ["70", "71"], "the other doors and gates");
  choice.value = "71";
  choice.dispatch("change");
  byKey(screen(), "doorbell:68:link").dispatch("click");
  await advance(200);
  assert.deepEqual(posts(), [{ method: "PUT", path: "/v1/doorbells/68/doors", body: { door_ids: [71] } }]);
  view = screen();
  assert.equal(plain(byKey(view, "doorbell:68:door:71:screen").textContent), "Open Garden Gate", "its Open at once");
  assert.match(plain(byClass(view, "doorbell-links").textContent), /Garden Gate.*Added here/);
  controller.calls = [];
  byKey(view, "doorbell:68:unlink:71").dispatch("click");
  await advance(200);
  assert.deepEqual(posts(), [{ method: "PUT", path: "/v1/doorbells/68/doors", body: { door_ids: [] } }]);
  assert.equal(byKey(screen(), "doorbell:68:door:71:screen"), null);
  // The room's card leads to the screen.
  assert.equal(byKey(doorbellCard(state.doorbells[0], {}), "doorbell:68:screen").attributes.href, "#/doorbell/68");
});

test("a driver before 1.11.0 says nothing of doors: nothing new shows", async () => {
  await setLanguage("en");
  const older = { ...ENTRANCE };
  delete older.doors;
  await connect({ doorbell: older });
  const view = screen();
  assert.equal(findAll(view, (node) => hasClass(node, "doorbell-door")).length, 0);
  assert.equal(byClass(view, "doorbell-links"), null);
  assert.equal(byClass(view, "muted-note"), null);
  assert.equal(byKey(doorbellCard(state.doorbells[0], {}), "doorbell:68:screen"), null);
  assert.equal(byKey(doorbellBanner(state.doorbells[0], {}), "doorbell:68:door:76:banner"), null);
});

test("the service worker gets the doors this user may open, by name, for this home and key only", async () => {
  await setLanguage("en");
  stored.delete("directorlink.alerts");
  await connect();
  assert.equal(ringDoors(), null, "alerts off here: nothing kept");
  stored.set("directorlink.alerts", JSON.stringify({ home: HOME, endpoint: "https://push.example/1", keyId: "0a1b2c3d" }));
  assert.deepEqual(ringDoors(), {
    home: HOME,
    key: "0a1b2c3d",
    doorbells: { 68: { camera: 68, doors: [{ id: 76, name: "Entrance Gate" }, { id: 70, name: "Main Door" }] } },
  });
  notify();
  await advance(100);
  const kept = await (await caches.open("directorlink-alerts")).match(RING_DOORS_PATH);
  assert.deepEqual(JSON.parse(await kept.text()).doorbells[68].doors.map((door) => door.id), [76, 70]);
  // A member without doors: the camera only, no door named.
  await connect({ access: { role: "member", doors: false, cameras: true } });
  stored.set("directorlink.alerts", JSON.stringify({ home: HOME, endpoint: "https://push.example/1", keyId: "0a1b2c3d" }));
  assert.deepEqual(ringDoors().doorbells[68], { camera: 68, doors: [] });
  stored.delete("directorlink.alerts");
});

test("History says an opening came from the doorbell", async () => {
  const entry = { id: 1, at: "2026-10-10T08:00:40Z", kind: "door", action: "pulse", who: { type: "key", name: "Owner's iPhone" }, what: "Entrance Gate", note: "Entrance", ids: { device_id: 76, doorbell_id: 68 } };
  const expected = { en: "From the doorbell Entrance", he: "מהאינטרקום Entrance", es: "Desde el timbre Entrance", it: "Dal campanello Entrance" };
  for (const [language, text] of Object.entries(expected)) {
    await setLanguage(language);
    assert.equal(plain(history.outcomeText(entry)), text, language);
  }
  await setLanguage("en");
  assert.equal(history.outcomeText({ ...entry, ids: { device_id: 76 }, note: undefined }), "", "an opening of its own");
});

test("its words in English, Hebrew, Spanish and Italian", async () => {
  const expected = {
    en: ["Open Entrance Gate", "Doorbell screen", "Doors and gates at this doorbell", "Open {name}…"],
    he: ["פתיחת Entrance Gate", "מסך האינטרקום", "דלתות ושערים באינטרקום הזה", "פתיחת {name}…"],
    es: ["Abrir Entrance Gate", "Pantalla del timbre", "Puertas y portones de este timbre", "Abrir {name}…"],
    it: ["Apri Entrance Gate", "Schermata del campanello", "Porte e cancelli di questo campanello", "Apri {name}…"],
  };
  for (const [language, [open, link, title, action]] of Object.entries(expected)) {
    await setLanguage(language);
    await connect();
    const view = screen();
    assert.equal(plain(byKey(view, "doorbell:68:door:76:screen").textContent), open, language);
    assert.equal(plain(byKey(doorbellCard(state.doorbells[0], {}), "doorbell:68:screen").textContent), link, language);
    assert.equal(plain(byClass(view, "doorbell-links").children[0].textContent), title, language);
    assert.equal(t("alerts.openDoorAction"), action, language);
  }
  await setLanguage("en");
});
