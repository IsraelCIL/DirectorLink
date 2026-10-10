// What a member's app asks the controller (1.10.3): nothing the controller keeps for admins. The
// whole app (app/app.js) runs against a fake DirectorLink 1.10.2 that answers every route of
// driver/src/api/routes.lua as the driver does, with 403 FORBIDDEN for an admins' route to a
// member's key. A member goes across Home, a room, Scenes (and a kept link to Schedules), Cameras,
// Climate, every Settings page, Users and History, also before their permissions are known and with
// the minute's refresh: not one request to an admins' route, so not one 403 (schedules were asked
// for after connecting and every minute until 1.10.3). An admin's app asks as before, and so do the
// members of a controller before 1.8.0 (whose members could read schedules).
//   node --test tests/app/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ---- the routes, as the driver has them ----------------------------------------------------------

const ROUTES = [...readFileSync(new URL("../../driver/src/api/routes.lua", import.meta.url), "utf8").matchAll(/method = "(\w+)", path = "([^"]+)"[^}]*?(?:role = "(\w+)")?\s*}/g)].map(
  ([, method, path, role]) => ({ method, path, role: role || null, pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`) })
);
const routeOf = (method, path) => ROUTES.find((route) => route.method === method && route.pattern.test(path)) || null;
const adminsOnly = (call) => routeOf(call.method, call.path)?.role === "admin";

// ---- just enough of a browser for the whole app ------------------------------------------------

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text) {
    this.replaceChildren(document.createTextNode(text));
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
}
class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.data = String(text);
  }
  get textContent() {
    return this.data;
  }
  set textContent(text) {
    this.data = String(text);
  }
}
const adopt = (parent, node) => {
  const child = node instanceof FakeNode ? node : new FakeText(node);
  child.parentNode?.removeChild(child);
  child.parentNode = parent;
  return child;
};
// One compound selector ("details[data-key]", "#view", ".page-title", "a[data-tab]"): of a list
// of selectors or a descendant one, the last part is enough here.
function matches(element, selector) {
  const last = selector.split(",").map((part) => part.trim().split(/\s+/).pop());
  return last.some((part) => {
    const tag = /^[a-z][a-z0-9-]*/i.exec(part)?.[0];
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    for (const [, id] of part.matchAll(/#([\w-]+)/g)) if (element.attributes.id !== id) return false;
    for (const [, name] of part.matchAll(/\.([\w-]+)/g)) if (!String(element.className).split(/\s+/).includes(name)) return false;
    for (const [, attribute, value] of part.matchAll(/\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g)) {
      const data = attribute.startsWith("data-") ? element.dataset[attribute.slice(5).replace(/-(\w)/g, (_, letter) => letter.toUpperCase())] : undefined;
      const actual = data ?? element.attributes[attribute];
      if (actual === undefined || (value !== undefined && actual !== value)) return false;
    }
    return true;
  });
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty() {}, removeProperty() {} };
    const classes = () => String(this.className).split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...names) => (this.className = [...new Set([...classes(), ...names])].join(" ")),
      remove: (...names) => (this.className = classes().filter((name) => !names.includes(name)).join(" ")),
      toggle: (name, on = !classes().includes(name)) => (on ? this.classList.add(name) : this.classList.remove(name), on),
      contains: (name) => classes().includes(name),
    };
  }
  get children() {
    return this.childNodes.filter((child) => child instanceof FakeElement);
  }
  get id() {
    return this.attributes.id || "";
  }
  append(...nodes) {
    for (const node of nodes) this.childNodes.push(adopt(this, node));
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  prepend(...nodes) {
    this.childNodes.unshift(...nodes.map((node) => adopt(this, node)));
  }
  insertBefore(node, before) {
    const child = adopt(this, node);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return node;
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    for (const node of nodes) parent.insertBefore(node, this);
    parent.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  toggleAttribute(name, on = !(name in this.attributes)) {
    if (on) this.attributes[name] = "";
    else delete this.attributes[name];
    return on;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== listener);
  }
  dispatchEvent() {
    return true;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  closest(selector) {
    for (let current = this; current instanceof FakeElement; current = current.parentNode) if (matches(current, selector)) return current;
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (matches(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  getElementsByTagName(tag) {
    return this.querySelectorAll(tag);
  }
  focus() {
    document.activeElement = this;
  }
  blur() {}
  click() {}
  scrollIntoView() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  showModal() {
    this.open = true;
  }
  show() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  getContext() {
    return null;
  }
}

const windowListeners = {};
globalThis.Node = FakeNode;
globalThis.HTMLElement = FakeElement;
globalThis.window = globalThis;
globalThis.addEventListener = (type, listener) => (windowListeners[type] ||= []).push(listener);
globalThis.removeEventListener = (type, listener) => {
  windowListeners[type] = (windowListeners[type] || []).filter((item) => item !== listener);
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
globalThis.scrollTo = () => {};
globalThis.isSecureContext = true;

// The address: a new hash is a hashchange, as in a browser.
let hash = "#/scenes";
globalThis.location = {
  hostname: "app.directorlink.io",
  origin: "https://app.directorlink.io",
  pathname: "/",
  search: "",
  get hash() {
    return hash;
  },
  set hash(value) {
    const next = String(value).startsWith("#") ? String(value) : `#${value}`;
    if (next === hash) return;
    hash = next;
    for (const listener of windowListeners.hashchange || []) listener({ type: "hashchange" });
  },
  get href() {
    return `https://app.directorlink.io/${hash}`;
  },
  replace(url) {
    this.hash = new URL(url, this.href).hash;
  },
  assign(url) {
    this.hash = new URL(url, this.href).hash;
  },
  reload() {},
};
globalThis.history = { state: null, replaceState() {}, pushState() {}, back() {} };

const html = new FakeElement("html");
const body = new FakeElement("body");
html.append(body);
const skip = new FakeElement("a");
skip.className = "skip-link";
const tabbar = new FakeElement("nav");
tabbar.setAttribute("id", "tabbar");
const viewElement = new FakeElement("div");
viewElement.setAttribute("id", "view");
body.append(skip, tabbar, viewElement);
const documentListeners = {};
globalThis.document = {
  hidden: false,
  visibilityState: "visible",
  documentElement: html,
  body,
  head: new FakeElement("head"),
  activeElement: null,
  title: "",
  addEventListener: (type, listener) => (documentListeners[type] ||= []).push(listener),
  removeEventListener() {},
  hasFocus: () => true,
  querySelector: (selector) => html.querySelector(selector),
  querySelectorAll: (selector) => html.querySelectorAll(selector),
  getElementById: (id) => html.querySelector(`#${id}`),
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
};
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Linux; Android 14)", maxTouchPoints: 5, languages: ["en"], language: "en", onLine: true },
  configurable: true,
});
const stored = new Map([
  ["directorlink.directorHost", "192.0.2.10"],
  ["directorlink.apiKey", "ak_member_phone"],
  ["directorlink.lang", "en"],
]);
const storage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: { getItem: () => null, setItem() {}, removeItem() {} }, configurable: true });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (timer) => clearTimeout(timer);
// The app's own timers (polls every 10 s, the weather every 5 minutes) do not keep the test alive;
// the test's own do (settle), or Node 22 ends a test still waiting.
const wait = globalThis.setTimeout;
for (const name of ["setTimeout", "setInterval"]) {
  const original = globalThis[name];
  globalThis[name] = (callback, delay, ...rest) => {
    const timer = original(callback, delay, ...rest);
    timer?.unref?.();
    return timer;
  };
}

// ---- the controller: DirectorLink 1.10.2, as the driver answers -------------------------------

const MEMBER = {
  role: "member",
  owner: false,
  all_rooms: false,
  rooms: [11],
  kinds: { light: true, climate: true, fan: true, blind: true, music: true, refrigerator: true },
  cameras: true,
  doors: true,
  alarm: false,
  scenes: [5],
};
const ADMIN = { role: "admin", owner: true, all_rooms: true, rooms: [], kinds: {}, cameras: true, doors: true, alarm: true, scenes: [] };
const FEATURES = {
  jewish_calendar: true,
  alarm_status: false,
  backup: true,
  sonos: false,
  automatic_backup: true,
  alert_choices: true,
  scene_links: true,
  refrigerators: true,
  people_permissions: true,
  sonos_groups: true,
  ask_links: true,
  camera_alerts: true,
  users: true,
  climate_last_mode: true,
};

const controller = {
  calls: [],
  // The key's user: a member of a 1.10.2 home (`access`), and `features` as GET /v1/system says.
  access: MEMBER,
  role: "member",
  features: FEATURES,
  version: "1.10.2",
  // Until released, GET /v1/api-keys/current waits (the permissions are not known yet).
  hold: null,
};

const ROOMS = [
  { id: 10, name: "Kitchen", names: {}, hidden_from_members: false },
  { id: 11, name: "Living room", names: {}, hidden_from_members: false },
];
const light = (id, roomId) => ({ id, name: `Light ${id}`, room: { id: roomId, name: ROOMS.find((room) => room.id === roomId).name }, state: { on: false, level: 0 }, dimmable: true });
const answers = {
  "/v1/rooms": () => ({ items: ROOMS }),
  "/v1/lights": () => ({ items: controller.access?.role === "member" ? [light(22, 11)] : [light(21, 10), light(22, 11)] }),
  "/v1/thermostats": () => ({
    items: [{ id: 31, name: "AC", room: { id: 11, name: "Living room" }, state: { mode: "cool", setpoint: 24, temperature: 25, scale: "C" }, scale: "C", modes: ["off", "cool", "heat"] }],
  }),
  "/v1/scenes": () => ({ items: [{ id: 5, name: "Evening", steps: [{ type: "lights", device_ids: [22], on: true }], version: 1 }] }),
  "/v1/schedules": () => ({ items: [], paused: false }),
  "/v1/weather": () => ({ status: "ok", current: { temperature: 21, wind_speed: 8, raining: false }, today: { sunrise: "06:30", sunset: "18:10" } }),
  "/v1/calendar": () => ({ enabled: true, status: "ok", settings: { holidays: "auto", israel: true, candle_lighting_minutes: 20, havdalah_minutes: 42, version: 1 } }),
  "/v1/profile": () => ({ id: "bbbb0002", name: "Noa", prefs: {}, version: 1 }),
  "/v1/remote": () => ({ enabled: false, linked: false }),
  "/v1/alerts/choices": () => ({ kinds: {}, on: false }),
  "/v1/users": () => ({
    items: [{ id: "bbbb0002", name: "Noa", role: controller.access?.role || controller.role, devices: [{ id: "0a1b2c3e", name: "Noa's phone", current: true, role: controller.role }] }],
  }),
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" } });
}

globalThis.fetch = async (url, init = {}) => {
  const address = new URL(url);
  // Nothing here reaches the account service, GitHub or anything else.
  if (address.hostname !== "192.0.2.10") throw new TypeError(`offline in this test: ${address.hostname}`);
  const method = init.method || "GET";
  const path = address.pathname;
  // A controller that does not seal (requests carry the key): how they travel does not matter here.
  if (path === "/v1/sealed") return reply(404, { status: 404, code: "NOT_FOUND" });
  const route = routeOf(method, path);
  const call = { method, path, status: 200 };
  controller.calls.push(call);
  if (!route) {
    call.status = 404;
    return reply(404, { status: 404, code: "NOT_FOUND", detail: `no ${method} ${path}` });
  }
  // Before 1.8.0 every key read schedules (their routes' role was "viewer").
  const older = controller.version === "1.7.0" && method === "GET" && route.path.startsWith("/v1/schedules");
  if (route.role === "admin" && controller.role !== "admin" && !older) {
    call.status = 403;
    return reply(403, { status: 403, code: "FORBIDDEN", detail: "Not allowed for this key", role: controller.role });
  }
  if (path === "/v1/system") {
    return reply(200, { bridge: { version: controller.version }, features: controller.features, inventory: {}, location: { timezone: "Asia/Jerusalem" } });
  }
  if (path === "/v1/api-keys/current") {
    await controller.hold;
    const key = { id: "0a1b2c3e", name: "Noa's phone", role: controller.role, current: true, profile_id: "bbbb0002" };
    return reply(200, controller.access ? { ...key, access: controller.access } : key);
  }
  if (method === "GET") return reply(200, answers[path] ? answers[path]() : { items: [] });
  return reply(200, {});
};

const { state } = await import("../../app/js/state.js");
const { refreshRooms } = await import("../../app/js/session.js");

// Lets the app answer, draw (each frame is a timer) and follow up: rounds of a timer and the
// promises and I/O that follow it.
async function settle() {
  for (let round = 0; round < 12; round += 1) {
    await new Promise((resolve) => wait(resolve, 0));
    for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
  }
}
async function go(where) {
  location.hash = where;
  await settle();
}
const asked = (method, path) => controller.calls.filter((call) => call.method === method && call.path === path).length;
const refused = () => controller.calls.filter((call) => call.status === 403 || adminsOnly(call)).map((call) => `${call.method} ${call.path} (${call.status})`);
const keysShown = () => viewElement.querySelectorAll("[data-key]").map((element) => element.dataset.key);

// Everywhere a user goes: Home, a room, Scenes and Schedules (a member gets there only through a
// link kept from before), Cameras, Climate, Settings with each of its pages, Users and History
// (a notification may open it), and back Home.
const EVERYWHERE = [
  "#/",
  "#/room/11",
  "#/scenes",
  "#/schedules",
  "#/schedule/new",
  "#/scenes",
  "#/cameras",
  "#/climate",
  "#/settings",
  "#/settings/controller",
  "#/settings/rooms",
  "#/settings/calendar",
  "#/settings/account",
  "#/settings/alerts",
  "#/settings/appearance",
  "#/settings/app",
  "#/settings/about",
  "#/access",
  "#/settings/history",
  "#/",
];

// ---- a member ------------------------------------------------------------------------------------

test("a member's app asks nothing admins' while it connects, even on Schedules", { timeout: 60000 }, async () => {
  // The admins' reads, as the driver's routes say (so that "none of them" means something).
  for (const path of ["/v1/schedules", "/v1/scene-links", "/v1/invitations", "/v1/api-keys", "/v1/profiles", "/v1/activity", "/v1/backup/automatic"]) {
    assert.ok(adminsOnly({ method: "GET", path }), path);
  }
  assert.equal(adminsOnly({ method: "GET", path: "/v1/weather" }), false);
  let release;
  controller.hold = new Promise((resolve) => {
    release = resolve;
  });
  // The app starts on Scenes; the permissions are not known yet when Schedules is opened.
  try {
    await import("../../app/app.js");
    await settle();
    assert.equal(state.loaded, false, "still connecting");
    await go("#/schedules");
    assert.equal(asked("GET", "/v1/schedules"), 0, "schedules wait for the permissions");
    assert.equal(asked("GET", "/v1/weather"), 0, "so does the weather");
  } finally {
    release();
    controller.hold = null;
  }
  await settle();
  assert.equal(state.status, "connected");
  assert.equal(state.access?.role, "member");
  assert.deepEqual(refused(), [], "no request a member's key is refused");
  assert.equal(asked("GET", "/v1/schedules"), 0, "not after connecting either");
  assert.equal(asked("GET", "/v1/weather"), 0);
  assert.match(viewElement.textContent, /Schedules are set by the home’s admins\./);
});

test("a member's app never asks for what only admins may read, anywhere or with the minute's refresh", { timeout: 60000 }, async () => {
  controller.calls = [];
  for (const where of EVERYWHERE) {
    await go(where);
    assert.deepEqual(refused(), [], `on ${where}`);
  }
  // Once a minute the rooms are read again, and what follows connecting runs again.
  await refreshRooms();
  await settle();
  await refreshRooms();
  await settle();
  assert.deepEqual(refused(), [], "with the minute's refresh");
  assert.equal(asked("GET", "/v1/schedules"), 0);
  assert.ok(asked("GET", "/v1/rooms") >= 2, "the refreshes did run");
  assert.ok(asked("GET", "/v1/scenes") >= 1, "the member's scenes are read");
  assert.ok(asked("GET", "/v1/users") >= 1, "Users was read (their own user)");
  // A link kept from an admin's device says so, and does not load forever.
  await go("#/schedule/new");
  assert.match(viewElement.textContent, /Schedules are set by the home’s admins\./);
  assert.equal(viewElement.querySelector("[aria-busy]"), null, "not loading");
  // Scenes alone: no Schedules beside them.
  await go("#/scenes");
  assert.ok(keysShown().includes("scene-run:5"), "the member's scene is there");
  assert.equal(keysShown().includes("sub-nav:schedules"), false, "no Schedules for a member");
  assert.equal(asked("GET", "/v1/schedules"), 0);
});

// ---- an admin, and an older controller's member ------------------------------------------------

test("an admin's app asks as before: schedules after connecting and each minute, the weather on Schedules", { timeout: 60000 }, async () => {
  // The owner made this user an admin: the minute's refresh reads the permissions again.
  Object.assign(controller, { access: ADMIN, role: "admin", calls: [] });
  await go("#/");
  await refreshRooms();
  await settle();
  assert.equal(state.access?.role, "admin");
  assert.equal(asked("GET", "/v1/schedules"), 1, "with the refresh, as before");
  await refreshRooms();
  await settle();
  assert.equal(asked("GET", "/v1/schedules"), 2, "and with the next one");
  controller.calls = [];
  await go("#/scenes");
  assert.ok(keysShown().includes("sub-nav:schedules"), "Scenes | Schedules");
  await go("#/schedules");
  assert.equal(asked("GET", "/v1/schedules"), 1, "Schedules reads them");
  assert.equal(asked("GET", "/v1/weather"), 1, "and the weather");
  assert.ok(keysShown().includes("schedule-new"), "an admin makes schedules");
  await go("#/scenes");
  assert.ok(asked("GET", "/v1/scene-links") >= 1, "scene links, for admins");
  await go("#/access");
  assert.ok(asked("GET", "/v1/invitations") >= 1, "invitations waiting, for admins");
  await go("#/settings/history");
  assert.ok(controller.calls.some((call) => call.path === "/v1/activity"), "History");
  assert.deepEqual(
    controller.calls.filter((call) => call.status === 403),
    [],
    "nothing refused"
  );
});

test("a member of a controller before 1.8.0 still reads schedules, as such members could", { timeout: 60000 }, async () => {
  const { people_permissions: _people, users: _users, ...older } = FEATURES;
  Object.assign(controller, { access: null, role: "member", features: older, version: "1.7.0", calls: [] });
  await go("#/");
  await refreshRooms();
  await settle();
  assert.equal(state.access, null);
  assert.equal(state.role, "member");
  assert.equal(asked("GET", "/v1/schedules"), 1, "asked, as before");
  await go("#/scenes");
  assert.ok(keysShown().includes("sub-nav:schedules"), "Scenes | Schedules");
  await go("#/schedules");
  assert.equal(asked("GET", "/v1/weather"), 1, "the weather on Schedules");
  assert.doesNotMatch(viewElement.textContent, /set by the home’s admins/);
  assert.deepEqual(
    controller.calls.filter((call) => call.status === 403),
    [],
    "nothing refused"
  );
});
