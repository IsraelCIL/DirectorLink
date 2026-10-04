// Scene links (1.7.0, ADR-051; app/js/scene-links.js with views/scene-links.js): the scene editor's
// section, the scene's link screen (#/scene/<id>/link: make, replace, remove, the secret once with
// Copy buttons, a QR code and the steps for iPhone Shortcuts, Android and an NFC tag), the list of
// linked scenes (#/links), the warnings before a change that would make a linked scene open doors
// or gates, a controller before 1.7.0, and the history's words. Against a fake controller, with
// just enough of a browser.
//   node --test tests/app/

import assert from "node:assert/strict";
import test from "node:test";

// ---- just enough of a browser ------------------------------------------------------------------
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
  append(...children) {
    this.children.push(...children);
  }
  // The QR code's canvas.
  getContext() {
    return { fillRect() {}, fillStyle: "" };
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}
globalThis.Node = FakeNode;
globalThis.window = globalThis;
globalThis.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/", pathname: "/", search: "", hash: "", replace() {} };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.history = { state: null, back() {} };
globalThis.document = {
  hidden: false,
  documentElement: {},
  body: new FakeElement("body"),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: () => null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeNode(), { textContent: String(text) }),
};
const clipboard = [];
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5, languages: ["en"], language: "en", onLine: true, clipboard: { writeText: async (text) => clipboard.push(text) } },
  configurable: true,
});
const stored = new Map();
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: (key) => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, String(value)), removeItem: (key) => stored.delete(key) },
  configurable: true,
});
let confirmAnswer = true;
const confirmed = [];
window.confirm = (text) => {
  confirmed.push(text);
  return confirmAnswer;
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

// ---- the fake controller --------------------------------------------------------------------------
const HOST = "controller.invalid";
const HOME = "ab".repeat(16);
const SCENE = "a1b2c3d4";
const GATE = "0f0f0f0f";
const SECRET = "c0ffee".repeat(6) + "beef";
const controller = { calls: [], links: [], remoteAccess: true, homeLinked: true, old: false, refuse: null, counter: 0 };

function answer(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" } });
}

globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname: path } = new URL(url);
  if (hostname !== HOST) throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  controller.calls.push({ method, path, body });
  if (path === "/v1/sealed") return answer(404, { status: 404, code: "NOT_FOUND" });
  if (path === "/v1/api-keys/current") return answer(200, { id: "0a1b2c3d", role: "admin" });
  if (method === "GET" && path === "/v1/scene-links") {
    if (controller.old) return answer(404, { status: 404, code: "NOT_FOUND" });
    return answer(200, { items: controller.links, remote_access: controller.remoteAccess, home_linked: controller.homeLinked });
  }
  const link = /^\/v1\/scenes\/([0-9a-f]{8})\/link$/.exec(path);
  if (link && method === "POST") {
    if (controller.refuse) return answer(409, { status: 409, code: controller.refuse, detail: "no" });
    controller.counter += 1;
    const replaced = controller.links.some((item) => item.scene_id === link[1]);
    const made = { scene_id: link[1], scene_name: "Arriving", link_id: `1234567${controller.counter}`, label: body?.label ?? null, created_at: "2026-10-03T08:00:00Z", last_used_at: null };
    controller.links = [...controller.links.filter((item) => item.scene_id !== link[1]), made];
    return answer(201, { ...made, home_id: HOME, secret: SECRET, url: `https://api.directorlink.io/run/${HOME}.${made.link_id}#${SECRET}`, replaced });
  }
  if (link && method === "DELETE") {
    controller.links = controller.links.filter((item) => item.scene_id !== link[1]);
    return answer(204);
  }
  if (method === "GET" && path === "/v1/api-keys") return answer(200, { items: controller.keys || [] });
  if (method === "PATCH" && path.startsWith("/v1/scenes/")) return answer(200, { ...state.scenes[0], ...body });
  if (method === "GET" && path === "/v1/scenes") return answer(200, { items: state.scenes });
  if (method === "GET") return answer(200, { items: [] });
  return answer(404, { status: 404, code: "NOT_FOUND", detail: `no ${method} ${path}` });
};

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const links = await import("../../app/js/scene-links.js");
const views = await import("../../app/js/views/scene-links.js");
const { resetSceneEditor, sceneEditorView, scenesView } = await import("../../app/js/views/scenes.js");
const { outcomeText } = await import("../../app/js/views/history.js");
const { default: en } = await import("../../app/i18n/en.js");
const { default: he } = await import("../../app/i18n/he.js");

async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function walk(nodes, visit) {
  for (const node of [nodes].flat(Infinity)) {
    if (!node) continue;
    visit(node);
    walk(node.children || [], visit);
  }
}
function byKey(nodes, key) {
  let found = null;
  walk(nodes, (node) => {
    if (!found && node.dataset?.key === key) found = node;
  });
  return found;
}
function byTag(nodes, tag) {
  const list = [];
  walk(nodes, (node) => node.tagName === tag && list.push(node));
  return list;
}
const plain = (text) => text.replace(/[⁦-⁩]/g, "");
const textOf = (nodes) => plain([nodes].flat(Infinity).filter(Boolean).map((node) => node.textContent).join(" | "));
async function press(nodes, key) {
  const element = byKey(nodes, key);
  assert.ok(element, `${key} is on the screen: ${textOf(nodes).slice(0, 300)}`);
  assert.equal(element.attributes.disabled, undefined, `${key} is disabled`);
  await Promise.all((element.listeners.click || []).map((listener) => listener({ preventDefault() {}, target: element })));
  await settle();
}
const calls = (method, path) => controller.calls.filter((call) => call.method === method && call.path === path);

const STEPS = [{ type: "lights", room_id: null, device_ids: null, set: { on: true } }];
const GATE_STEP = { type: "relays", room_id: null, device_ids: [501], set: { action: "pulse" } };

// Connected as `role` to a controller with scene links (or a 1.6.0 one: old), the list read.
async function connect({ role = "admin", old = false, items = [], remoteAccess = true, homeLinked = true } = {}) {
  Object.assign(controller, { calls: [], links: structuredClone(items), remoteAccess, homeLinked, old, refuse: null });
  confirmed.length = 0;
  confirmAnswer = true;
  clipboard.length = 0;
  views.leaveSceneLink();
  ui.sceneLinks = null;
  Object.assign(state, {
    host: HOST,
    apiKey: "ak_test",
    status: "connected",
    transport: "lan",
    loaded: true,
    online: true,
    role,
    rooms: [],
    lights: [{ id: 101, name: "Porch", room: null }],
    thermostats: [],
    fans: [],
    blinds: [],
    relays: [{ id: 501, name: "Gate", room: null }],
    system: { bridge: { version: old ? "1.6.0" : "1.7.0" }, features: old ? { automatic_backup: true } : { automatic_backup: true, scene_links: true } },
    scenes: [
      { id: SCENE, name: "Arriving", icon: "home", show_on_home: false, version: 2, steps: structuredClone(STEPS) },
      { id: GATE, name: "Open the gate", icon: "leave", show_on_home: false, version: 1, steps: [structuredClone(GATE_STEP)] },
    ],
    scenesUnsupported: false,
  });
  resetSceneEditor();
  views.sceneLinkView(SCENE); // reads the list, as opening a screen does
  await settle();
}

const LINKED = { scene_id: SCENE, scene_name: "Arriving", link_id: "9a8b7c6d", label: "Arriving home", created_at: "2026-10-01T08:00:00Z", last_used_at: "2026-10-02T18:30:00Z" };

test("the address and the link: the account service, the secret after #", () => {
  const made = { home_id: HOME, link_id: "12345678", secret: SECRET };
  assert.equal(links.linkAddress(made), `https://api.directorlink.io/run/${HOME}.12345678`);
  assert.equal(links.linkUrl(made), `https://api.directorlink.io/run/${HOME}.12345678#${SECRET}`);
  assert.equal(links.linkable(STEPS), true);
  assert.equal(links.linkable([...STEPS, GATE_STEP]), false);
  // Only the types a link may run (as the controller allows them): one this app does not know is
  // no more linkable than a gate.
  assert.equal(links.linkable([...STEPS, { type: "refrigerators" }, { type: "music" }, { type: "climate" }, { type: "fans" }, { type: "blinds" }]), true);
  assert.equal(links.linkable([...STEPS, { type: "garage_door" }]), false);
});

test("revoking a key, or Forget key, says how many scene links stop with it", async () => {
  await setLanguage("en");
  const MINE = "0a1b2c3d"; // this device's key (the fake's /v1/api-keys/current)
  const HOUSEKEEPER = "0b0b0b0b";
  await connect({
    items: [
      { ...LINKED, made_by: HOUSEKEEPER },
      { ...LINKED, scene_id: "c3c3c3c3", link_id: "11112222", made_by: HOUSEKEEPER },
      { ...LINKED, scene_id: "d4d4d4d4", link_id: "33334444", made_by: MINE },
      { ...LINKED, scene_id: "e5e5e5e5", link_id: "55556666", made_by: null },
    ],
  });
  controller.keys = [
    { id: MINE, name: "This phone", role: "admin", current: true },
    { id: HOUSEKEEPER, name: "Housekeeper", role: "admin" },
    { id: "0c0c0c0c", name: "Tablet", role: "member" },
  ];
  // The Access screen's 30 s refresh is not waited for here.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...rest) => (ms >= 30000 ? 0 : realSetTimeout(callback, ms, ...rest));
  try {
    const { accessView, loadAccess, resetAccess } = await import("../../app/js/views/access.js");
    resetAccess();
    await loadAccess();
    confirmAnswer = false;
    await press(accessView(), `access-revoke-${HOUSEKEEPER}`);
    assert.equal(confirmed.at(-1), "Revoke the key of “Housekeeper”? That device loses access at once. The 2 scene links made on it stop working too.");
    await press(accessView(), "access-revoke-0c0c0c0c");
    assert.equal(confirmed.at(-1), "Revoke the key of “Tablet”? That device loses access at once.", "no links: nothing more");
    assert.equal(controller.calls.filter((call) => call.method === "DELETE").length, 0, "Cancel revokes nothing");

    // Forget access key on this device: its own links stop too.
    const { settingsView } = await import("../../app/js/views/settings.js");
    await press(settingsView({ page: "controller", navigate() {} }), "settings-forget");
    assert.match(confirmed.at(-1), /^Remove this device’s access\?.* The scene link made on this device stops working too\.$/);
    // A controller before 1.7.0 has no links: the questions are as before.
    await connect({ old: true });
    controller.keys = [{ id: MINE, name: "This phone", role: "admin", current: true }, { id: HOUSEKEEPER, name: "Housekeeper", role: "admin" }];
    resetAccess();
    await loadAccess();
    await press(accessView(), `access-revoke-${HOUSEKEEPER}`);
    assert.equal(confirmed.at(-1), "Revoke the key of “Housekeeper”? That device loses access at once.");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    confirmAnswer = true;
  }
});

test("a controller before 1.7.0 shows nothing of scene links; nor do keys that are not an admin's", async () => {
  await setLanguage("en");
  await connect({ old: true });
  assert.equal(calls("GET", "/v1/scene-links").length, 0, "never asked");
  assert.equal(byKey(sceneEditorView(SCENE, false, { navigate() {} }), "scene-link-section"), null);
  assert.equal(byKey(scenesView({ navigate() {} }), "scene-links-row"), null);
  assert.match(textOf(views.sceneLinkView(SCENE)), /need DirectorLink 1\.7\.0/);
  await connect({ role: "member" });
  assert.equal(byKey(scenesView({ navigate() {} }), "scene-links-row"), null);
  assert.equal(byKey(sceneEditorView(SCENE, false, { navigate() {} }), "scene-link-section"), null);
  assert.match(textOf(views.sceneLinkView(SCENE)), /Only admins make and remove scene links/);
});

test("the editor's section: make a link, or what the link is; never for a scene with doors or gates", async () => {
  await setLanguage("en");
  await connect();
  let nodes = sceneEditorView(SCENE, false, { navigate() {} });
  const open = byKey(nodes, "scene-link-open");
  assert.equal(open.attributes.href, `#/scene/${SCENE}/link`);
  assert.match(textOf(open), /Make a link/);
  resetSceneEditor();
  nodes = sceneEditorView(GATE, false, { navigate() {} });
  assert.equal(byKey(nodes, "scene-link-open"), null);
  assert.match(textOf(byKey(nodes, "scene-link-section")), /opens doors or gates, so it can’t have a link/);

  // Unsaved changes: leaving for the link's screen asks first.
  ui.sceneEditor.dirty = true;
  nodes = sceneEditorView(GATE, false, { navigate() {} });
  resetSceneEditor();
  nodes = sceneEditorView(SCENE, false, { navigate() {} });
  ui.sceneEditor.dirty = true;
  confirmAnswer = false;
  let event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  byKey(nodes, "scene-link-open").listeners.click[0](event);
  assert.equal(event.defaultPrevented, true, "Cancel stays in the editor");
  assert.match(confirmed.at(-1), /Leave without saving/);
  confirmAnswer = true;
  event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  byKey(nodes, "scene-link-open").listeners.click[0](event);
  assert.equal(event.defaultPrevented, false);

  await connect({ items: [LINKED] });
  nodes = sceneEditorView(SCENE, false, { navigate() {} });
  assert.match(textOf(byKey(nodes, "scene-link-section")), /“Arriving home” · made .* · last ran /);
  assert.match(textOf(byKey(nodes, "scene-link-open")), /Link and how to use it/);
  // Rows on the Scenes list, and the list of linked scenes.
  assert.match(textOf(byKey(scenesView({ navigate() {} }), "scene-links-row")), /1 scene has a link/);
  const list = views.sceneLinksView();
  assert.equal(byKey(list, `scene-links-item:${SCENE}`).attributes.href, `#/scene/${SCENE}/link`);
  assert.match(textOf(list), /Remove All Scene Links/);
});

test("a door step in a linked scene: a warning, and a question before saving removes the link", async () => {
  await setLanguage("en");
  await connect({ items: [LINKED] });
  sceneEditorView(SCENE, false, { navigate() {} });
  const draft = ui.sceneEditor;
  // Add an action: doors and gates, in this linked scene.
  assert.ok(byKey(views.doorLinkWarning(draft), "scene-link-doors-warning"));
  draft.steps = [...draft.steps, structuredClone(GATE_STEP)];
  draft.stepsChanged = true;
  draft.dirty = true;
  let nodes = sceneEditorView(SCENE, false, { navigate() {} });
  assert.match(textOf(byKey(nodes, "scene-link-doors-warning")), /saving removes the link/);
  confirmAnswer = false;
  await press(nodes, "scene-save");
  assert.equal(confirmed.length, 1);
  assert.match(confirmed[0], /saving removes its link/);
  assert.equal(calls("PATCH", `/v1/scenes/${SCENE}`).length, 0, "Cancel: nothing saved");
  confirmAnswer = true;
  nodes = sceneEditorView(SCENE, false, { navigate() {} });
  const before = calls("GET", "/v1/scene-links").length;
  await press(nodes, "scene-save");
  assert.equal(calls("PATCH", `/v1/scenes/${SCENE}`).length, 1);
  assert.ok(calls("GET", "/v1/scene-links").length > before, "the links are read again");
  // Without a link, no question.
  await connect();
  sceneEditorView(SCENE, false, { navigate() {} });
  ui.sceneEditor.steps = [...ui.sceneEditor.steps, structuredClone(GATE_STEP)];
  ui.sceneEditor.stepsChanged = true;
  assert.equal(views.confirmLinkLoss(ui.sceneEditor, ui.sceneEditor.steps), true);
  assert.equal(confirmed.length, 0);
  // Deleting a linked scene says its link goes too.
  await connect({ items: [LINKED] });
  sceneEditorView(SCENE, false, { navigate() {} });
  assert.match(views.deleteQuestion(ui.sceneEditor), /Its link for automations stops working too/);
});

test("making a link shows its secret once, with Copy buttons, a QR code and the steps", async () => {
  await setLanguage("en");
  await connect();
  let nodes = views.sceneLinkView(SCENE);
  assert.match(textOf(nodes), /iPhone Shortcuts/);
  byKey(nodes, "scene-link-label").listeners.input[0]({ target: { value: "  Arriving home " } });
  await press(nodes, "scene-link-make");
  assert.deepEqual(calls("POST", `/v1/scenes/${SCENE}/link`).at(-1).body, { label: "Arriving home" });
  nodes = views.sceneLinkView(SCENE);
  const url = `https://api.directorlink.io/run/${HOME}.12345671#${SECRET}`;
  assert.equal(byKey(nodes, "scene-link-url").attributes.value ?? byKey(nodes, "scene-link-url").value, url);
  assert.match(textOf(byKey(nodes, "scene-link-made")), /shown only this once/);
  assert.equal(byTag(nodes, "CANVAS").length, 1, "a QR code");
  assert.ok(byKey(nodes, "scene-link-iphone") && byKey(nodes, "scene-link-android") && byKey(nodes, "scene-link-nfc"));
  assert.equal(byKey(nodes, "scene-link-iphone").attributes.open, "", "on an iPhone, its steps are open");
  assert.match(textOf(byKey(nodes, "scene-link-iphone")), /Get Contents of URL.*POST.*JSON.*secret/s);
  assert.match(textOf(byKey(nodes, "scene-link-android")), /POST.*form field named “secret”/s);
  await press(nodes, "scene-link-iphone-address");
  await press(views.sceneLinkView(SCENE), "scene-link-iphone-secret");
  await press(views.sceneLinkView(SCENE), "scene-link-copy-url");
  assert.deepEqual(clipboard, [`https://api.directorlink.io/run/${HOME}.12345671`, SECRET, url], "the address without the secret, the secret, the whole link");
  assert.match(textOf(byKey(views.sceneLinkView(SCENE), "scene-link-copy-url")), /Copied/);
  assert.equal(JSON.stringify(ui.sceneLinks).includes(SECRET), false, "the secret is not kept in the app's state");
  assert.equal(JSON.stringify([...stored.values()]).includes(SECRET), false, "nor in storage");
  // The app's state says a secret is on screen (so Done draws the screen again), never the secret.
  assert.deepEqual(ui.sceneLinks.showing, [SCENE]);
  await press(views.sceneLinkView(SCENE), "scene-link-done");
  assert.deepEqual(ui.sceneLinks.showing, []);
  assert.equal(byKey(views.sceneLinkView(SCENE), "scene-link-url"), null, "Done forgets it");

  // Leaving the screen forgets it too: then only what the link is, and Replace and Remove.
  await press(views.sceneLinkView(SCENE), "scene-link-replace");
  assert.deepEqual(ui.sceneLinks.showing, [SCENE]);
  views.leaveSceneLink();
  assert.deepEqual(ui.sceneLinks.showing, []);
  nodes = views.sceneLinkView(SCENE);
  assert.equal(byKey(nodes, "scene-link-url"), null);
  assert.ok(!textOf(nodes).includes(SECRET));
  assert.match(textOf(byKey(nodes, "scene-link-facts")), /Arriving home/, "a replaced link keeps its label");
  assert.equal(byKey(nodes, "scene-link-label").value ?? byKey(nodes, "scene-link-label").attributes.value, "Arriving home");
  assert.match(textOf(nodes), /Replace the link: the old one stops working at once/);
});

test("replace and remove ask first; Cancel changes nothing", async () => {
  await setLanguage("en");
  await connect({ items: [LINKED] });
  let nodes = views.sceneLinkView(SCENE);
  confirmAnswer = false;
  await press(nodes, "scene-link-replace");
  await press(nodes, "scene-link-remove");
  assert.equal(calls("POST", `/v1/scenes/${SCENE}/link`).length + calls("DELETE", `/v1/scenes/${SCENE}/link`).length, 0);
  assert.equal(confirmed.length, 2);
  confirmAnswer = true;
  await press(nodes, "scene-link-replace");
  nodes = views.sceneLinkView(SCENE);
  assert.match(textOf(byKey(nodes, "scene-link-made")), /the old one no longer works/);
  views.leaveSceneLink();
  await press(views.sceneLinkView(SCENE), "scene-link-remove");
  assert.equal(calls("DELETE", `/v1/scenes/${SCENE}/link`).length, 1);
  nodes = views.sceneLinkView(SCENE);
  assert.match(textOf(byKey(nodes, "scene-link-message")), /The link was removed/);
  assert.ok(byKey(nodes, "scene-link-make"), "and a new one can be made");
});

test("what a link needs is said, and Make waits for it", async () => {
  await setLanguage("en");
  await connect({ remoteAccess: false });
  let nodes = views.sceneLinkView(SCENE);
  assert.match(textOf(byKey(nodes, "scene-link-remote-off")), /turn on Remote Access in Composer/);
  assert.equal(byKey(nodes, "scene-link-make").attributes.disabled, "");
  await connect({ homeLinked: false });
  nodes = views.sceneLinkView(SCENE);
  assert.match(textOf(byKey(nodes, "scene-link-not-linked")), /link it to your account first/);
  assert.equal(byKey(nodes, "scene-link-make").attributes.disabled, "");
  // A door scene: no link; the controller's refusals in words.
  await connect();
  assert.match(textOf(views.sceneLinkView(GATE)), /opens doors or gates, so it can’t have a link/);
  assert.equal(byKey(views.sceneLinkView(GATE), "scene-link-make"), null);
  controller.refuse = "HOME_NOT_LINKED";
  await press(views.sceneLinkView(SCENE), "scene-link-make");
  assert.match(textOf(byKey(views.sceneLinkView(SCENE), "scene-link-message")), /haven’t accepted this home yet/);
});

test("the history names a link's runs and why a link went", async () => {
  await setLanguage("en");
  const { historyView } = await import("../../app/js/views/history.js");
  assert.ok(historyView);
  assert.equal(plain(outcomeText({ kind: "access", action: "link_removed", reason: "doors", note: "NFC" })), "The scene now opens doors or gates · Link “NFC”");
  assert.equal(plain(outcomeText({ kind: "access", action: "link_removed", reason: "scene_gone" })), "The scene was deleted");
  assert.equal(plain(outcomeText({ kind: "access", action: "links_removed", reason: "new_identity", count: 2 })), "Reset Remote Identity, in Composer");
  assert.equal(plain(outcomeText({ kind: "access", action: "link_created", note: "Siri" })), "Link “Siri”");
  // A link goes with the key that made it, and with Revoke All API Keys.
  assert.equal(plain(outcomeText({ kind: "access", action: "link_removed", reason: "key_gone", note: "Cleaning done" })), "The key that made it was removed or expired · Link “Cleaning done”");
  assert.equal(plain(outcomeText({ kind: "access", action: "links_removed", reason: "keys_revoked", count: 3 })), "Revoke All API Keys, in Composer");
  // Remove All Scene Links that the controller could not save: said so, and that they still work.
  const failed = { id: 7, at: "2026-10-04T10:00:00Z", kind: "access", action: "links_removed", outcome: "failed", count: 2, who: { type: "composer" } };
  assert.equal(plain(outcomeText(failed)), "The controller couldn’t save it: the links still work");
  assert.ok(en.history.access.links_not_removed && he.history.access.links_not_removed);
  for (const reason of ["key_gone", "keys_revoked", "not_saved"]) assert.ok(en.history.reason[reason] && he.history.reason[reason], reason);
});

test("every string is in both languages", () => {
  const keys = (node, prefix = "") =>
    Object.entries(node).flatMap(([key, value]) => (value && typeof value === "object" && !("other" in value) ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
  assert.deepEqual(keys(he.sceneLinks).sort(), keys(en.sceneLinks).sort());
  for (const key of ["link_created", "link_replaced", "link_removed", "links_removed"]) {
    assert.ok(en.history.access[key] && he.history.access[key], key);
  }
  assert.ok(en.history.who.link && he.history.who.link && en.history.who.linkUnnamed && he.history.who.linkUnnamed);
});
