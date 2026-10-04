// Samsung refrigerators in the app (DirectorLink 1.7.0, ADR-049): the rules of
// app/js/refrigerators.js; a feature switched from the card (controls.js with session.js) against a
// fake controller under fake time — shown at once as waiting, confirmed once the refrigerator
// reports it (through Samsung's cloud, seconds later, or up to its driver's last read about 55 s
// after), put back with a word when it does not within 65 s or is refused, then shown if it confirms
// late, two at once; the card for members and viewers, offline, a door open, a model
// without some features; where refrigerators appear (rooms, favorites); the scene action; Hebrew.
//   node --test tests/app/

import assert from "node:assert/strict";
import test, { mock } from "node:test";

const HOST = "controller.invalid";
const KEY = "ak_test";
const stored = new Map();

// Just enough of a browser: the elements the views build (with their listeners, to press them),
// storage and frames.
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
    const event = { type, currentTarget: this, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
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
const backs = [];
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
globalThis.history = { state: { directorlinkInApp: true }, back: () => backs.push("back") };
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-10-02T15:00:00Z") });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 16);

// The fake controller: a DirectorLink that cannot seal (so requests carry the key), with these
// refrigerators. A PATCH is reported `lag` ms later, as the refrigerator confirms it through
// Samsung's cloud (never when `reports` is false); `refuse` answers PATCH with that problem instead.
// `hasRefrigerators`: /v1/refrigerators exists (1.7.0).
const controller = { fridges: [], calls: [], lag: 4000, reports: true, refuse: null, hasRefrigerators: true };

function answer(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname: path } = new URL(url);
  if (hostname !== HOST) throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  controller.calls.push({ at: Date.now(), method, path, body: init.body ? JSON.parse(init.body) : null });
  if (path === "/v1/sealed") return answer(404, { status: 404, code: "NOT_FOUND" });
  if (!init.headers?.Authorization) return answer(401, { status: 401, code: "UNAUTHORIZED" });
  if (path.startsWith("/v1/refrigerators") && !controller.hasRefrigerators) return answer(404, { status: 404, code: "NOT_FOUND", detail: "No route" });
  if (path === "/v1/refrigerators" && method === "GET") return answer(200, { items: controller.fridges.map((fridge) => ({ ...fridge })) });
  const one = path.match(/^\/v1\/refrigerators\/(\d+)$/);
  if (one) {
    const fridge = controller.fridges.find((item) => item.id === Number(one[1]));
    if (!fridge) return answer(404, { status: 404, code: "NOT_FOUND", detail: "Refrigerator not found" });
    if (method === "GET") return answer(200, { ...fridge });
    if (controller.refuse) return answer(controller.refuse.status, { status: controller.refuse.status, code: controller.refuse.code, detail: controller.refuse.detail });
    const change = JSON.parse(init.body);
    const before = { ...fridge };
    if (controller.reports) {
      setTimeout(() => {
        controller.fridges = controller.fridges.map((item) => (item.id === fridge.id ? { ...item, ...change } : item));
      }, controller.lag);
    }
    return answer(202, before);
  }
  if (path === "/v1/api-keys/current") return answer(200, { id: "0a1b2c3d", role: "admin" });
  if (method === "GET") return answer(200, { items: [] });
  return answer(404, { status: 404, code: "NOT_FOUND", detail: `no ${method} ${path}` });
};

const fridgeRules = await import("../../app/js/refrigerators.js");
const { CONFIRM_MS, FEATURES, LATE_MS, featuresOf, fridgeChangeConfirmed, fridgeFeatures, optimisticFridge, stepFeature, stepSet, zones } = fridgeRules;
const { state, ui, notify } = await import("../../app/js/state.js");
const controls = await import("../../app/js/controls.js");
const session = await import("../../app/js/session.js");
const { fridgeStateLabel, roomGroup, visibleRooms } = await import("../../app/js/model.js");
const { STEP_TYPES, copyHouse, stepAction, stepWhat } = await import("../../app/js/scenes.js");
const { setLanguage, t } = await import("../../app/js/i18n.js");
const { refrigeratorCard } = await import("../../app/js/components.js");
const { roomView } = await import("../../app/js/views/room.js");
const { favoritesPicker } = await import("../../app/js/views/home.js");
const { resetSceneEditor, sceneEditorView } = await import("../../app/js/views/scenes.js");

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

// ---- what a screen holds -----------------------------------------------------------------------

function walk(nodes, visit) {
  for (const node of [nodes].flat(Infinity)) {
    if (!node) continue;
    visit(node);
    walk(node.children || [], visit);
  }
}
function find(nodes, check) {
  let found = null;
  walk(nodes, (node) => {
    if (!found && node instanceof FakeElement && check(node)) found = node;
  });
  return found;
}
const byKey = (nodes, key) => find(nodes, (node) => node.dataset.key === key);
const hasClass = (node, name) => typeof node.className === "string" && node.className.split(/\s+/).includes(name);
const allByClass = (nodes, name) => {
  const list = [];
  walk(nodes, (node) => node instanceof FakeElement && hasClass(node, name) && list.push(node));
  return list;
};
const byClass = (nodes, name) => allByClass(nodes, name)[0] || null;
const plain = (text) => String(text ?? "").replace(/[⁦-⁩]/g, "");
const textOf = (nodes) => plain([nodes].flat(Infinity).filter(Boolean).map((node) => node.textContent).join(" | "));
const pressed = (nodes, key) => byKey(nodes, key)?.attributes["aria-pressed"] === "true";

// The fake Director's refrigerator (driver/tests/c4mock.lua withRefrigerator) as the driver reports
// it with the refrigerator driver 1.0.0, and a one-door model whose driver says what it has.
const kitchen = { id: 10, name: "Kitchen" };
const fridge = {
  id: 141, name: "Refrigerator", room: kitchen, online: true,
  fridge_temperature: 3, fridge_setpoint: 3, freezer_temperature: -18, freezer_setpoint: -18,
  door_open: false, water_filter_usage: 40,
  power_cool: false, power_freeze: false, sabbath_mode: false, ice_maker: false,
  features: ["power_cool", "power_freeze", "sabbath_mode", "ice_maker"], features_reported: false,
};
const oneDoor = {
  id: 151, name: "Wine fridge", room: { id: 11, name: "Living Room" }, online: true,
  fridge_temperature: 6.5, fridge_setpoint: 7, freezer_temperature: null, freezer_setpoint: null,
  door_open: null, water_filter_usage: null,
  power_cool: true, power_freeze: null, sabbath_mode: false, ice_maker: null,
  features: ["power_cool", "sabbath_mode"], features_reported: true,
};

async function connect(fridges = [fridge], role = "admin") {
  session.forgetKey();
  await advance(100);
  Object.assign(controller, { calls: [], lag: 4000, reports: true, refuse: null, hasRefrigerators: true });
  controller.fridges = fridges.map((item) => ({ ...item }));
  Object.assign(state, {
    host: HOST,
    apiKey: KEY,
    role,
    status: "connected",
    loaded: true,
    rooms: [kitchen, { id: 11, name: "Living Room" }],
    lights: [],
    thermostats: [],
    fans: [],
    blinds: [],
    cameras: [],
    relays: [],
    doorbells: [],
    refrigerators: fridges.map((item) => ({ ...item })),
    devices: [],
    errors: {},
    system: { bridge: { version: "1.7.0" }, inventory: { refrigerators: fridges.length }, features: { refrigerators: true } },
  });
  notify();
  await advance(100);
}

const patches = () => controller.calls.filter((call) => call.method === "PATCH");
const reads = () => controller.calls.filter((call) => call.method === "GET" && /^\/v1\/refrigerators\/\d+$/.test(call.path));
const fridgeNow = (id = 141) => state.refrigerators.find((item) => item.id === id);

// ---- the rules ---------------------------------------------------------------------------------

test("features: the ones a refrigerator has, in a fixed order; all four when its driver does not say", () => {
  assert.deepEqual(FEATURES, ["power_cool", "power_freeze", "sabbath_mode", "ice_maker"]);
  assert.deepEqual(fridgeFeatures(fridge), FEATURES);
  assert.deepEqual(fridgeFeatures(oneDoor), ["power_cool", "sabbath_mode"]);
  assert.deepEqual(fridgeFeatures({ features: ["ice_maker", "power_cool", "something_new"] }), ["power_cool", "ice_maker"], "unknown ones left out");
  assert.deepEqual(fridgeFeatures({}), FEATURES);
  assert.deepEqual(featuresOf([oneDoor]), ["power_cool", "sabbath_mode"]);
  assert.deepEqual(featuresOf([oneDoor, { features: ["ice_maker"] }]), ["power_cool", "sabbath_mode", "ice_maker"]);
  assert.equal(fridgeChangeConfirmed(fridge, { sabbath_mode: false }), true);
  assert.equal(fridgeChangeConfirmed(fridge, { sabbath_mode: true, ice_maker: false }), false);
  assert.deepEqual(optimisticFridge(fridge, { sabbath_mode: true }).sabbath_mode, true);
  assert.deepEqual(zones(fridge), [{ zone: "fridge", temperature: 3, setpoint: 3 }, { zone: "freezer", temperature: -18, setpoint: -18 }]);
  assert.deepEqual(zones(oneDoor), [{ zone: "fridge", temperature: 6.5, setpoint: 7 }], "no freezer");
  assert.deepEqual(stepSet("sabbath_mode", true), { sabbath_mode: true });
  assert.deepEqual(stepFeature({ ice_maker: false, power_cool: true }), { feature: "power_cool", on: true }, "the first in order");
  assert.equal(stepFeature({ action: "pulse" }), null);
  assert.ok(CONFIRM_MS >= 60000, "longer than the refrigerator driver's last read, about 55 s after the command");
  assert.ok(LATE_MS >= 120000, "then up to its next poll, every 2 minutes by default");
});

// ---- commands ----------------------------------------------------------------------------------

test("a switch moves at once, says it waits, and holds once the refrigerator confirms", async () => {
  await connect();
  const tick = ui.tick;
  const sending = controls.setRefrigerator(fridgeNow(), { sabbath_mode: true });
  await settle();
  assert.equal(fridgeNow().sabbath_mode, true, "shown at once");
  // The screen is drawn again when the wait starts and ends: the device data alone may not change.
  assert.equal(ui.tick, tick + 1);
  assert.deepEqual(controls.changesOnTheirWay("refrigerator", 141), { sabbath_mode: true });
  assert.deepEqual(patches().map((call) => [call.path, call.body]), [["/v1/refrigerators/141", { sabbath_mode: true }]]);
  let card = refrigeratorCard(fridgeNow());
  assert.match(textOf(byClass(card, "fridge-feature-state")), /Turning on…/);
  assert.equal(byKey(card, "refrigerator:141:sabbath_mode").attributes["aria-checked"], "true");
  // A refresh meanwhile (every 10 s) keeps what was sent.
  await session.refreshDevices();
  assert.equal(fridgeNow().sabbath_mode, true);
  await advance(5000);
  await sending;
  assert.equal(fridgeNow().sabbath_mode, true);
  assert.deepEqual(controls.changesOnTheirWay("refrigerator", 141), {}, "no longer waiting");
  assert.equal(ui.tick, tick + 2, "drawn again without Turning on…, though the refrigerator reports what was shown");
  assert.equal(state.errors["refrigerator:141"], undefined);
  assert.ok(reads().length >= 2 && reads().length <= 3, `read every 2 s until it confirmed: ${reads().length}`);
  card = refrigeratorCard(fridgeNow());
  assert.doesNotMatch(textOf(card), /Turning/);
});

test("confirmed at the refrigerator driver's last read, about 55 s after: still waiting, then held", async () => {
  await connect();
  controller.lag = 55000;
  const sending = controls.setRefrigerator(fridgeNow(), { sabbath_mode: true });
  await settle();
  await advance(50000, 500);
  assert.equal(fridgeNow().sabbath_mode, true, "still waiting after 50 s");
  assert.deepEqual(controls.changesOnTheirWay("refrigerator", 141), { sabbath_mode: true });
  await advance(8000, 500);
  await sending;
  assert.equal(fridgeNow().sabbath_mode, true);
  assert.equal(state.errors["refrigerator:141"], undefined, "no word that it did not confirm");
  assert.deepEqual(controls.changesOnTheirWay("refrigerator", 141), {});
});

test("not confirmed within 65 s: back to what the refrigerator reports, and it says so", async () => {
  await connect();
  controller.reports = false;
  const sending = controls.setRefrigerator(fridgeNow(), { power_freeze: true });
  await settle();
  assert.equal(fridgeNow().power_freeze, true);
  await advance(60000, 500);
  assert.equal(fridgeNow().power_freeze, true, "still waiting after 60 s");
  assert.deepEqual(controls.changesOnTheirWay("refrigerator", 141), { power_freeze: true });
  await advance(7000, 500);
  await sending;
  assert.equal(fridgeNow().power_freeze, false, "as the refrigerator reports it");
  assert.equal(state.errors["refrigerator:141"]?.text, "The refrigerator didn’t confirm this. It may be offline; try again.");
  assert.ok(reads().length >= 31 && reads().length <= 34, `every 2 s: ${reads().length}`);
  assert.match(textOf(refrigeratorCard(fridgeNow())), /didn’t confirm/);
  // Then it reads quietly, every 5 s for 2 minutes, and stops.
  const before = reads().length;
  await advance(LATE_MS + 10000, 1000);
  assert.ok(reads().length - before >= 23 && reads().length - before <= 25, `every 5 s: ${reads().length - before}`);
  assert.equal(fridgeNow().power_freeze, false);
  const after = reads().length;
  await advance(30000, 1000);
  assert.equal(reads().length, after, "no more reads");
});

test("confirmed after the message: the change shows, and the word that it did not confirm goes", async () => {
  await connect();
  controller.lag = 69000;
  const sending = controls.setRefrigerator(fridgeNow(), { ice_maker: true });
  await settle();
  await advance(67000, 500);
  await sending;
  assert.equal(fridgeNow().ice_maker, false);
  assert.match(state.errors["refrigerator:141"]?.text ?? "", /didn’t confirm/);
  await advance(5000, 500);
  assert.equal(fridgeNow().ice_maker, true, "shown once the refrigerator reports it");
  assert.equal(state.errors["refrigerator:141"], undefined, "and no longer said not confirmed");
  assert.doesNotMatch(textOf(refrigeratorCard(fridgeNow())), /didn’t confirm/);
});

test("two features at once: the one confirmed first does not hide the other", async () => {
  await connect();
  const first = controls.setRefrigerator(fridgeNow(), { sabbath_mode: true });
  await advance(1000);
  controller.lag = 8000;
  const second = controls.setRefrigerator(fridgeNow(), { ice_maker: true });
  await settle();
  await advance(5000);
  await first;
  assert.equal(fridgeNow().sabbath_mode, true, "confirmed");
  assert.equal(fridgeNow().ice_maker, true, "still shown as sent while it waits");
  assert.deepEqual(controls.changesOnTheirWay("refrigerator", 141), { ice_maker: true });
  await advance(6000);
  await second;
  assert.equal(fridgeNow().ice_maker, true);
  assert.deepEqual(controls.changesOnTheirWay("refrigerator", 141), {});
});

test("refused by the controller: put back at once, with the reason", async () => {
  await connect([oneDoor]);
  controller.refuse = { status: 409, code: "FEATURE_NOT_SUPPORTED", detail: "This refrigerator has no Ice Maker" };
  await controls.setRefrigerator(fridgeNow(151), { power_cool: false });
  assert.equal(fridgeNow(151).power_cool, true, "put back");
  assert.ok(state.errors["refrigerator:151"]?.text, "a short error on the card");
  assert.deepEqual(controls.changesOnTheirWay("refrigerator", 151), {});
});

test("viewers see the state and send nothing", async () => {
  await connect([fridge], "viewer");
  await controls.setRefrigerator(fridgeNow(), { sabbath_mode: true });
  assert.equal(patches().length, 0);
  const card = refrigeratorCard(fridgeNow());
  assert.equal(allByClass(card, "switch").length, 0, "no switches");
  assert.deepEqual(allByClass(card, "fridge-feature-state").map((node) => plain(node.textContent)), ["Off", "Off", "Off", "Off"]);
});

test("the refresh reads the refrigerators in a home that has some, and none from an older driver", async () => {
  await connect();
  controller.fridges[0] = { ...controller.fridges[0], door_open: true, fridge_temperature: 5 };
  assert.equal(await session.refreshDevices(), true);
  assert.equal(fridgeNow().door_open, true);
  assert.ok(controller.calls.some((call) => call.path === "/v1/refrigerators"));
  // A home without refrigerators (or a driver before 1.7.0) is not asked.
  await connect([]);
  state.system = { bridge: { version: "1.6.0" }, inventory: {} };
  await session.refreshDevices();
  assert.ok(!controller.calls.some((call) => call.path === "/v1/refrigerators"));
});

// ---- the card ----------------------------------------------------------------------------------

test("the card: temperatures and setpoints, the door, the water filter, four switches", async () => {
  await connect();
  const card = refrigeratorCard(fridgeNow());
  assert.equal(plain(byClass(card, "device-name").textContent), "Refrigerator");
  assert.equal(plain(byClass(card, "device-meta").textContent), "Door closed");
  const zonesShown = allByClass(card, "fridge-zone").map((node) => plain(node.textContent));
  assert.deepEqual(zonesShown, ["Fridge3°set to 3°", "Freezer-18°set to -18°"]);
  assert.equal(plain(byClass(card, "fridge-filter").textContent), "Water filter 40% used");
  const switches = allByClass(card, "switch");
  assert.deepEqual(switches.map((node) => node.attributes["aria-label"]), [
    "Power Cool, Refrigerator",
    "Power Freeze, Refrigerator",
    "Sabbath mode, Refrigerator",
    "Ice maker, Refrigerator",
  ]);
  assert.ok(byKey(card, "refrigerator:141:star"), "a favorite star");
  // A tap sends the change.
  byKey(card, "refrigerator:141:ice_maker").dispatch("click");
  await settle();
  assert.deepEqual(patches().at(-1).body, { ice_maker: true });
  await advance(5000);
});

test("the door open and offline stand out; a one-door model shows what it has", async () => {
  await connect([{ ...fridge, door_open: true }, { ...oneDoor, online: false }]);
  let card = refrigeratorCard(fridgeNow());
  assert.ok(hasClass(card, "is-door-open"));
  assert.equal(plain(byClass(card, "device-meta").textContent), "Door open");
  assert.equal(fridgeStateLabel(fridgeNow()), "Door open");
  card = refrigeratorCard(fridgeNow(151));
  assert.ok(hasClass(card, "is-offline"));
  assert.equal(plain(byClass(card, "device-meta").textContent), "Offline");
  assert.match(textOf(byClass(card, "fridge-note")), /last values it reported/);
  assert.equal(allByClass(card, "fridge-zone").length, 1, "no freezer");
  assert.equal(byClass(card, "fridge-filter"), null, "no water filter");
  assert.equal(allByClass(card, "fridge-feature").length, 2, "Power Cool and Sabbath mode only");
  assert.equal(fridgeStateLabel(fridgeNow(151)), "Offline");
  assert.equal(plain(fridgeStateLabel({ ...fridge, door_open: false })), "3° · -18°", "the temperatures when all is well");
});

test("refrigerators have their room's section, Home's favorites and the room's badge", async () => {
  await connect([fridge, oneDoor]);
  assert.deepEqual(roomGroup(10).refrigerators.map((item) => item.id), [141]);
  assert.deepEqual(visibleRooms().map((entry) => entry.room.id), [10, 11], "a room with only a refrigerator is listed");
  const room = roomView(10, { openCamera() {} });
  const section = byClass(room, "section-refrigerators");
  assert.ok(section, "its own section");
  assert.match(textOf(section), /Refrigerators/);
  const picker = favoritesPicker();
  assert.match(textOf(picker), /Refrigerators/);
  assert.ok(byKey(picker, "refrigerator:141:star"));
});

// ---- scenes ------------------------------------------------------------------------------------

test("a scene action: which refrigerator, which feature, on or off", async () => {
  await connect([fridge, oneDoor]);
  assert.ok(STEP_TYPES.includes("refrigerators"));
  assert.equal(stepAction({ type: "refrigerators", set: { sabbath_mode: true } }), "Sabbath mode on");
  assert.equal(stepAction({ type: "refrigerators", set: { power_cool: false, ice_maker: true } }), "Power Cool off, Ice maker on");
  assert.equal(stepWhat({ type: "refrigerators", device_ids: null }), "All refrigerators");
  assert.equal(stepWhat({ type: "refrigerators", device_ids: [141] }), "Refrigerator");
  assert.equal(copyHouse().steps.some((step) => step.type === "refrigerators"), false, "Copy the house leaves them as they are");

  state.scenes = [{ id: "abcd1234", name: "Shabbat", icon: "moon", show_on_home: false, version: 1, steps: [{ type: "refrigerators", room_id: null, device_ids: [151], set: { sabbath_mode: true } }] }];
  resetSceneEditor();
  const actions = { navigate() {} };
  sceneEditorView("abcd1234", false, actions);
  // Add an action: the kind is offered, its features are the ones these refrigerators have.
  let nodes = sceneEditorView("abcd1234", true, actions);
  byKey(nodes, "add-room:11").dispatch("click");
  nodes = sceneEditorView("abcd1234", true, actions);
  byKey(nodes, "add-kind:refrigerators").dispatch("click");
  nodes = sceneEditorView("abcd1234", true, actions);
  assert.ok(pressed(nodes, "add-kind:refrigerators"));
  assert.ok(byKey(nodes, "add-fridge-feature:power_cool") && byKey(nodes, "add-fridge-feature:sabbath_mode"));
  assert.equal(byKey(nodes, "add-fridge-feature:ice_maker"), null, "the wine fridge has no ice maker");
  assert.ok(pressed(nodes, "add-fridge-feature:sabbath_mode"), "Sabbath mode first");
  assert.ok(pressed(nodes, "add-fridge-on:on"));
  byKey(nodes, "add-fridge-feature:power_cool").dispatch("click");
  nodes = sceneEditorView("abcd1234", true, actions);
  byKey(nodes, "add-fridge-on:off").dispatch("click");
  nodes = sceneEditorView("abcd1234", true, actions);
  assert.equal(plain(byClass(nodes, "add-summary").textContent), "Adds: All refrigerators (Living Room): Power Cool off");
  byKey(nodes, "add-confirm").dispatch("click");
  assert.deepEqual(ui.sceneEditor.steps.at(-1), { type: "refrigerators", room_id: 11, device_ids: null, set: { power_cool: false } });

  // Changing the first action: filled in from it.
  nodes = sceneEditorView("abcd1234", false, actions, 0);
  assert.ok(pressed(nodes, "add-kind:refrigerators") && pressed(nodes, "add-fridge-feature:sabbath_mode") && pressed(nodes, "add-fridge-on:on"));
  byKey(nodes, "add-fridge-on:off").dispatch("click");
  nodes = sceneEditorView("abcd1234", false, actions, 0);
  byKey(nodes, "add-confirm").dispatch("click");
  assert.deepEqual(ui.sceneEditor.steps[0].set, { sabbath_mode: false });
});

// ---- Hebrew ------------------------------------------------------------------------------------

test("in Hebrew", async () => {
  await setLanguage("he");
  try {
    await connect();
    const card = refrigeratorCard(fridgeNow());
    assert.deepEqual(allByClass(card, "fridge-feature-name").map((node) => node.textContent), ["קירור מהיר", "הקפאה מהירה", "מצב שבת", "מכונת קרח"]);
    assert.equal(plain(byClass(card, "device-meta").textContent), "הדלת סגורה");
    assert.equal(stepAction({ type: "refrigerators", set: { sabbath_mode: true } }), "הפעלת מצב שבת");
    assert.equal(stepAction({ type: "refrigerators", set: { ice_maker: false } }), "כיבוי מכונת קרח");
    assert.equal(t("scenes.add.kinds.refrigerators"), "מקררים");
  } finally {
    await setLanguage("en");
  }
});

test("every refrigerator string is in both languages", async () => {
  const { default: en } = await import("../../app/i18n/en.js");
  const { default: he } = await import("../../app/i18n/he.js");
  const keys = (node, prefix = "") =>
    Object.entries(node).flatMap(([key, value]) => (value && typeof value === "object" && !("other" in value) ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
  assert.deepEqual(keys(he.refrigerators).sort(), keys(en.refrigerators).sort());
  for (const path of ["sections.refrigerators", "rooms.fridgeDoorOpen", "scenes.add.kinds.refrigerators", "scenes.add.feature", "scenes.add.switchOn", "scenes.add.switchOff", "scenes.add.fridgeNote", "scenes.all.refrigerators", "scenes.inRoom.refrigerators", "scenes.count.refrigerators", "scenes.do.featureOn", "scenes.do.featureOff", "history.door.left_open", "settings.controller.inventoryRefrigerators", "backup.kinds.refrigerator"]) {
    const value = (dictionary) => path.split(".").reduce((node, part) => node?.[part], dictionary);
    assert.ok(value(en), `en ${path}`);
    assert.ok(value(he), `he ${path}`);
  }
});
