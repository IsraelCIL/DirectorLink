// On/off lights (1.10.2, ADR-077): a light the controller says does not dim (`dimmable` false, as a
// 1.10.2 driver says of a KNX switch, whose proxy also has a level of 0 or 100) is on and off only,
// everywhere: no slider in its room, "On" rather than a level on Home's favorites, no Dim in the
// scene editor unless a dimmer is picked too, and a command to dim it is answered plainly. A KNX
// dimmer whose level is not reported says so next to the level it was sent.
//   node --test tests/app/

import assert from "node:assert/strict";
import test from "node:test";

// Just enough of a browser for the views.
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
  set textContent(text) {
    this.children = [document.createTextNode(String(text))];
  }
  replaceChildren(...children) {
    this.children = children;
  }
}
globalThis.Node = FakeNode;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/", pathname: "/", search: "", hash: "", replace() {} };
globalThis.document = {
  hidden: false,
  documentElement: { dataset: {} },
  body: { append() {} },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: () => null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeNode(), { textContent: String(text) }),
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
const stored = new Map();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  },
  configurable: true,
});
globalThis.fetch = async () => {
  throw new TypeError("offline in this test");
};
globalThis.history = { state: { directorlinkInApp: true }, back() {} };

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage, t } = await import("../../app/js/i18n.js");
const { homeView } = await import("../../app/js/views/home.js");
const { roomView } = await import("../../app/js/views/room.js");
const { resetSceneEditor, sceneEditorView } = await import("../../app/js/views/scenes.js");
const { resultText, runPartial, sceneSummary, stepWhat } = await import("../../app/js/scenes.js");
const { outcomeText } = await import("../../app/js/views/history.js");
const { commandCatalog } = await import("../../app/js/commands.js");
const { parseCommand } = await import("../../app/js/command-parser.js");

function walk(nodes, visit) {
  for (const node of [nodes].flat(Infinity)) {
    if (!node) continue;
    visit(node);
    walk(node.children || [], visit);
  }
}
function keysOf(nodes) {
  const keys = [];
  walk(nodes, (node) => node.dataset?.key && keys.push(node.dataset.key));
  return keys;
}
const byKey = (nodes, key) => {
  let found = null;
  walk(nodes, (node) => {
    if (!found && node.dataset?.key === key) found = node;
  });
  return found;
};
// The device row (class "device") that holds the element with `key`.
function rowOf(nodes, key) {
  let found = null;
  const visit = (node, row) => {
    if (found || !node) return;
    if (Array.isArray(node)) return node.forEach((child) => visit(child, row));
    const here = node instanceof FakeElement && String(node.className || "").split(/\s+/).includes("device") ? node : row;
    if (node.dataset?.key === key) found = here;
    (node.children || []).forEach((child) => visit(child, here));
  };
  visit(nodes, null);
  return found;
}
const plain = (text) => text.replace(/[⁦-⁩]/g, "");
// The texts a screen shows, each on its own.
function leaves(nodes) {
  const list = [];
  walk(nodes, (node) => {
    if (!(node instanceof FakeElement) && node.textContent?.trim()) list.push(plain(node.textContent.trim()));
  });
  return list;
}

// ---- the home: a kitchen with a dimmer, a KNX switch and a KNX dimmer -------------------------

const ROOMS = [{ id: 10, name: "Kitchen", names: {} }];
const kitchen = { id: 10, name: "Kitchen" };
const LIGHTS = [
  { id: 20, name: "Island", room: kitchen, on: true, dimmable: true, brightness: 70, brightness_reported: true },
  // A KNX switch as a 1.10.2 driver gives it: no level, whatever its proxy's variable says.
  { id: 21, name: "Pendant", room: kitchen, on: true, dimmable: false, brightness: null, brightness_reported: false },
  { id: 22, name: "Strip", room: kitchen, on: true, dimmable: true, brightness: 40, brightness_reported: false },
];
const SCENE = "abcd1234";

function home(steps = []) {
  Object.assign(state, {
    host: "192.0.2.10",
    apiKey: "ak_test",
    transport: "lan",
    status: "connected",
    loaded: true,
    online: true,
    role: "admin",
    access: null,
    errors: {},
    pending: {},
    sentBrightness: {},
    rooms: structuredClone(ROOMS),
    lights: structuredClone(LIGHTS),
    thermostats: [],
    blinds: [],
    fans: [],
    cameras: [],
    relays: [],
    doorbells: [],
    refrigerators: [],
    devices: [],
    scenes: [{ id: SCENE, name: "Evening", icon: "moon", show_on_home: false, version: 1, steps: structuredClone(steps) }],
    scenesUnsupported: false,
    profile: { id: "p1", prefs: { hidden_rooms: [], favorites: ["light:21", "light:20", "light:22"] } },
    system: { bridge: { version: "1.10.2" }, features: { users: true } },
    account: { status: "signed-out", user: null, notice: null, busy: false },
    offlineCopy: "ready",
    canInstall: false,
    lastUpdated: new Date(),
  });
  ui.filter = null;
  resetSceneEditor();
}

const actions = { openCamera() {}, openFavoritesPicker() {}, navigate() {} };

test("in its room, a switch has its on/off switch and no slider; a dimmer has both", () => {
  home();
  const nodes = roomView(10, actions);
  const keys = keysOf(nodes);
  assert.ok(keys.includes("light:21:switch"), "the switch turns on and off");
  assert.ok(!keys.includes("light:21:level"), "no slider for a switch");
  assert.ok(keys.includes("light:20:level") && keys.includes("light:22:level"), "the dimmers have theirs");
  const pendant = leaves(rowOf(nodes, "light:21:switch"));
  assert.deepEqual(pendant, ["Pendant", "On"], "no level for a switch");
  assert.ok(leaves(rowOf(nodes, "light:20:switch")).includes("70%"));
  assert.ok(leaves(rowOf(nodes, "light:22:switch")).includes(`40% · ${t("lights.levelNotReported")}`), "a level not reported says so");
});

test("on Home's favorites, a switch says On, a dimmer its level", () => {
  home();
  const nodes = homeView(actions);
  assert.equal(plain(byKey(nodes, "light:21:tile").textContent), "PendantKitchenOn");
  assert.match(plain(byKey(nodes, "light:20:tile").textContent), /70%$/);
  // Off, a switch says Off.
  state.lights = state.lights.map((light) => (light.id === 21 ? { ...light, on: false } : light));
  assert.match(plain(byKey(homeView(actions), "light:21:tile").textContent), /Off$/);
});

test("the scene editor offers Dim only when a dimmer is picked; a switch's old level opens as On", () => {
  home([
    { type: "lights", room_id: 10, device_ids: [21], set: { on: true } },
    { type: "lights", room_id: 10, device_ids: [20, 21], set: { brightness: 40 } },
    // Saved while a 1.10.1 driver called the switch a dimmer.
    { type: "lights", room_id: 10, device_ids: [21], set: { brightness: 40 } },
  ]);
  let nodes = sceneEditorView(SCENE, false, actions, 0);
  assert.ok(byKey(nodes, "add-light:on") && byKey(nodes, "add-light:off"));
  assert.equal(byKey(nodes, "add-light:dim"), null, "a switch alone: on or off");
  assert.equal(byKey(nodes, "add-brightness"), null);

  resetSceneEditor();
  nodes = sceneEditorView(SCENE, false, actions, 1);
  assert.ok(byKey(nodes, "add-light:dim"), "with a dimmer picked, Dim");
  assert.equal(byKey(nodes, "add-light:dim").attributes["aria-pressed"], "true");

  resetSceneEditor();
  nodes = sceneEditorView(SCENE, false, actions, 2);
  assert.equal(byKey(nodes, "add-light:dim"), null);
  assert.equal(byKey(nodes, "add-light:on").attributes["aria-pressed"], "true", "a switch's old level is On");
});

test("a command to dim a switch is answered plainly, and dims only the dimmers of a room", async () => {
  home();
  const catalog = commandCatalog();
  const one = parseCommand("dim the pendant to 50%", catalog);
  assert.equal(one.status, "problem", JSON.stringify(one));
  assert.equal(one.problem, "cannotDim");
  const room = parseCommand("kitchen lights 30%", catalog);
  assert.notEqual(room.status, "problem", JSON.stringify(room));
  const ids = JSON.stringify(room);
  assert.match(ids, /\b20\b/);
  assert.match(ids, /\b22\b/);
  assert.doesNotMatch(ids, /\b21\b/, "the switch is left out of a level");
  assert.equal(t("command.problem.cannotDim", { name: "Pendant" }), "Pendant only turns on and off.");
  try {
    await setLanguage("he");
    assert.match(t("command.problem.cannotDim", { name: "Pendant" }), /^Pendant רק נדלק ונכבה\.$/);
  } finally {
    await setLanguage("en");
  }
});

// ---- a level for a room or the whole home (ADR-077, 2026-10-09) -------------------------------
// A driver that says `scene_levels_dimmers_only` sends a level for a room or the whole home to its
// dimmers only; the switches there stay as they are (the owner's heaters and door lock are KNX
// switches). The editor says so, the action's words name the dimmers, and a run that left switches
// as they are is done, not partly done.

const press = (nodes, key) => {
  const element = byKey(nodes, key);
  assert.ok(element, `${key} is on the screen`);
  element.dispatch("click");
};
const noteOf = (nodes) => plain(byKey(nodes, "add-dimmers-only")?.textContent || "");
const addSummary = (nodes) => leaves(nodes).find((text) => text.startsWith("Adds:")) || "";
const add = () => sceneEditorView(SCENE, true, actions);
const ONLY_DIMMERS = "Only dimmers get a percentage; switches stay as they are.";
const levelsForDimmers = () => {
  state.system = { bridge: { version: "1.10.3" }, features: { users: true, scene_levels_dimmers_only: true } };
};

test("a level for a room or the whole home says that only dimmers get it", async () => {
  home();
  levelsForDimmers();
  let nodes = add();
  assert.ok(byKey(nodes, "add-room:home") && byKey(nodes, "add-kind:lights"));
  assert.equal(byKey(nodes, "add-dimmers-only"), null, "Off: nothing to say");
  press(nodes, "add-light:dim");
  nodes = add();
  assert.equal(noteOf(nodes), ONLY_DIMMERS, "the whole home");
  assert.equal(addSummary(nodes), "Adds: All dimmers (Whole home): 50%");
  press(nodes, "add-room:10");
  nodes = add();
  press(nodes, "add-light:dim");
  nodes = add();
  assert.equal(noteOf(nodes), ONLY_DIMMERS, "the kitchen");
  // Its lights picked one by one: the switch among them gets the level, so it turns on.
  press(nodes, "add-choose");
  nodes = add();
  byKey(nodes, "pick:20").dispatch("change", { target: { checked: true } });
  byKey(nodes, "pick:21").dispatch("change", { target: { checked: true } });
  nodes = add();
  assert.equal(byKey(nodes, "add-dimmers-only"), null, "named lights: a switch turns on");
  // All of them picked is the room again: switches stay as they are.
  byKey(nodes, "pick:22").dispatch("change", { target: { checked: true } });
  nodes = add();
  assert.equal(noteOf(nodes), ONLY_DIMMERS);
  press(nodes, "add-light:on");
  nodes = add();
  assert.equal(byKey(nodes, "add-dimmers-only"), null, "On turns every light on");
  press(nodes, "add-light:dim");

  try {
    await setLanguage("he");
    assert.equal(noteOf(add()), "רק אורות עם עמעום מקבלים אחוז; אורות שרק נדלקים ונכבים נשארים כמו שהם.");
    await setLanguage("es");
    assert.match(noteOf(add()), /^Solo las luces regulables reciben un porcentaje/);
    await setLanguage("it");
    assert.match(noteOf(add()), /^Solo le luci dimmerabili ricevono una percentuale/);
  } finally {
    await setLanguage("en");
  }

  // Without switches there, nothing to say.
  state.lights = state.lights.map((light) => ({ ...light, dimmable: true }));
  assert.equal(byKey(add(), "add-dimmers-only"), null);
  // A driver that turns them on (1.10.2 and before) says nothing of it either.
  home();
  nodes = add();
  press(nodes, "add-light:dim");
  nodes = add();
  assert.equal(byKey(nodes, "add-dimmers-only"), null);
  assert.equal(addSummary(nodes), "Adds: All lights (Whole home): 50%");
});

test("an action with a level for a room or the whole home names the dimmers", () => {
  home();
  const room = { type: "lights", room_id: 10, device_ids: null, set: { brightness: 50 } };
  const everywhere = { type: "lights", room_id: null, device_ids: null, set: { brightness: 30 } };
  const named = { type: "lights", room_id: 10, device_ids: [20, 21], set: { brightness: 50 } };
  const off = { type: "lights", room_id: null, device_ids: null, set: { brightness: 0 } };
  assert.equal(stepWhat(everywhere), "All lights", "a driver that turns switches on too");
  levelsForDimmers();
  assert.equal(stepWhat(everywhere), "All dimmers");
  assert.equal(stepWhat(room), "All dimmers");
  assert.equal(stepWhat(off), "All lights", "off turns every light off");
  assert.equal(stepWhat({ ...everywhere, set: { on: true } }), "All lights");
  assert.equal(plain(sceneSummary({ steps: [room, everywhere, named] })), "Kitchen dimmers: 50% · All dimmers: 30% · 2 lights: 50%");
});

test("a run that left switches as they are is done; anything else left out still says so", async () => {
  const switches = (count, others = []) => ({
    ran: 2,
    skipped: count + others.filter((problem) => problem.outcome === "skipped").length,
    failed: 0,
    on_off_only: count,
    problems: [...others, ...Array.from({ length: Math.min(count, 50 - others.length) }, (_, index) => ({ step: 1, device_id: 300 + index, outcome: "skipped", code: "ON_OFF_ONLY", detail: "This light only turns on and off" }))],
  });
  assert.equal(resultText(switches(1)), "Done — only dimmers get a percentage; 1 switch stayed as it was");
  assert.equal(resultText(switches(107)), "Done — only dimmers get a percentage; 107 switches stayed as they were", "all of them, not the 50 listed");
  assert.equal(runPartial(switches(107)), false, "done, not partly");
  const door = { step: 2, device_id: 70, outcome: "skipped", code: "DOOR_CONTROL_DISABLED", detail: "Door control is off" };
  assert.equal(resultText(switches(3, [door])), "Done — doors and gates were skipped: Door Control is off in Composer");
  assert.equal(runPartial(switches(3, [door])), true);
  const ac = { step: 2, device_id: 30, outcome: "skipped", code: "MODE_NOT_SUPPORTED", detail: "No auto" };
  assert.equal(resultText(switches(61, [ac])), "Done — 1 device was skipped", "the switches are not counted as skipped");
  const partial = { step: 2, device_id: 41, outcome: "partial", code: "NOT_SUPPORTED", detail: "No speed 4" };
  assert.equal(resultText(switches(2, [partial])), "Done — one setting isn’t available on every device");
  assert.equal(runPartial(switches(2, [partial])), true);
  // A driver that counts them only in its problems.
  const { on_off_only: _count, ...counted } = switches(2);
  assert.equal(resultText(counted), "Done — only dimmers get a percentage; 2 switches stayed as they were");
  assert.equal(runPartial({ ran: 3, skipped: 0, failed: 0, problems: [] }), false);
  assert.equal(runPartial({ ran: 3, skipped: 1, failed: 0, problems: [door] }), true);
  try {
    await setLanguage("he");
    assert.equal(resultText(switches(2)), "בוצע — רק אורות עם עמעום מקבלים אחוז; 2 אורות שרק נדלקים ונכבים נשארו כמו שהיו");
  } finally {
    await setLanguage("en");
  }
});

test("History says the switches a level left as they are apart from what was skipped", async () => {
  const run = (counts) => ({ kind: "scene", action: "run", outcome: "ran", what: "Evening", counts });
  assert.equal(outcomeText(run({ ran: 4, skipped: 107, failed: 0, on_off_only: 107 })), "Ran on 4 devices · 107 switches left as they were");
  assert.equal(outcomeText(run({ ran: 1, skipped: 2, failed: 0, on_off_only: 1 })), "Ran on 1 device · 1 skipped · 1 switch left as it was");
  assert.equal(outcomeText(run({ ran: 1, skipped: 1, failed: 0 })), "Ran on 1 device · 1 skipped", "a driver that does not say it");
  try {
    await setLanguage("he");
    assert.match(outcomeText(run({ ran: 4, skipped: 3, failed: 0, on_off_only: 3 })), /3 אורות שרק נדלקים ונכבים נשארו כמו שהיו$/);
  } finally {
    await setLanguage("en");
  }
});
