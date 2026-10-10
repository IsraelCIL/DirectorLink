// Ask before opening (1.8.0, ADR-058; app/js/ask-links.js with views/ask-links.js): a door's link
// that asks its person (#/door/<id>/ask: make, replace, remove, the secret once, the steps for
// iPhone, Siri, Android and Google Assistant), the question an alert's tap opens
// (#/open/<door>/<request>/<until>: Open with this device's key and the request's id, Cancel sends
// nothing, an expired or answered request opens nothing), the door's row, the list on #/links, the
// history's words, and Siri and Google Assistant on a scene link's screen. Against a fake
// controller, with just enough of a browser.
//   node --test tests/app/

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { DIRECT_KEY, DIRECT_NAME, directRecord, sealedDoor } from "./sealed-door.mjs";

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
const GATE = 70;
const SECRET = "c0ffee".repeat(6) + "beef";
const REQUEST = "0123456789abcdef";
// pulse: what the controller answers a pulse that answers a request (null: 202).
const controller = { calls: [], links: [], remoteAccess: true, homeLinked: true, doorControl: true, refuse: null, pulse: null, counter: 0 };

function answer(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" } });
}

// The controller as it answers at its address (which an iPhone cannot use); the iPhone of these
// tests is at home with Direct HTTPS (1.12.0): its requests go to the controller's name, sealed
// (tests/app/sealed-door.mjs), and each is answered as here.
const plainFetch = async (url, init = {}) => {
  const { hostname, pathname: path } = new URL(url);
  if (hostname !== HOST) throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  controller.calls.push({ method, path, body });
  if (path === "/v1/sealed") return answer(404, { status: 404, code: "NOT_FOUND" });
  if (method === "GET" && path === "/v1/ask-links") {
    return answer(200, { items: controller.links, remote_access: controller.remoteAccess, home_linked: controller.homeLinked, door_control: controller.doorControl });
  }
  if (method === "POST" && path === "/v1/ask-links") {
    if (controller.refuse) return answer(controller.refuse === "DOOR_CONTROL_DISABLED" ? 403 : 409, { status: 409, code: controller.refuse, detail: "no" });
    controller.counter += 1;
    const replaced = controller.links.some((item) => item.relay_id === body.relay_id && item.this_device);
    const made = { link_id: `8765432${controller.counter}`, relay_id: body.relay_id, relay_name: "Main gate", room_id: 11, label: body.label ?? null, made_by: "0a1b2c3d", person: "Dana", this_device: true, created_at: "2026-10-03T08:00:00Z", last_used_at: null };
    controller.links = [...controller.links.filter((item) => !(item.relay_id === body.relay_id && item.this_device)), made];
    return answer(201, { ...made, home_id: HOME, secret: SECRET, url: `https://api.directorlink.io/run/${HOME}.${made.link_id}#${SECRET}`, replaced });
  }
  const removing = /^\/v1\/ask-links\/([0-9a-f]{8})$/.exec(path);
  if (removing && method === "DELETE") {
    controller.links = controller.links.filter((item) => item.link_id !== removing[1]);
    return answer(204);
  }
  if (method === "POST" && path === `/v1/relays/${GATE}/pulse`) {
    if (controller.pulse) return answer(controller.pulse === "DOOR_CONTROL_DISABLED" ? 403 : 409, { status: 409, code: controller.pulse, detail: "no" });
    return answer(202, { id: GATE, name: "Main gate", room: { id: 11, name: "Entrance" }, state: "closed" });
  }
  if (method === "GET") return answer(200, { items: [] });
  return answer(404, { status: 404, code: "NOT_FOUND", detail: `no ${method} ${path}` });
};
// What answers the sealed requests: a test may stand in for the controller (`answers.fetch`).
const answers = { fetch: plainFetch };
const door = sealedDoor({
  apiKey: "ak_test",
  keyId: "0a1b2c3d",
  respond: (method, path, body) => answers.fetch(`http://${HOST}:41999${path}`, { method, body: body === null || body === undefined ? undefined : JSON.stringify(body) }),
});
globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname } = new URL(url);
  if (hostname === DIRECT_NAME && pathname === "/v1/sealed") return door(init);
  return plainFetch(url, init);
};

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const asks = await import("../../app/js/ask-links.js");
const views = await import("../../app/js/views/ask-links.js");
const sceneViews = await import("../../app/js/views/scene-links.js");
const { relayRow } = await import("../../app/js/components.js");
const { outcomeText } = await import("../../app/js/views/history.js");
const { alertTexts } = await import("../../app/js/alerts.js");
const { default: en } = await import("../../app/i18n/en.js");
const { default: he } = await import("../../app/i18n/he.js");

// Lets fetch answers, promise chains and WebCrypto settle: every request is sealed, and each of its
// steps waits for the thread pool (a digest waits there too).
async function settle() {
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await crypto.subtle.digest("SHA-256", new Uint8Array(1));
  }
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

const RELAY = { id: GATE, name: "Main gate", room: { id: 11, name: "Entrance" }, state: "closed", state_reported: true };
const MINE = { link_id: "9a8b7c6d", relay_id: GATE, relay_name: "Main gate", room_id: 11, label: "Arriving home", made_by: "0a1b2c3d", person: "Dana", this_device: true, created_at: "2026-10-01T08:00:00Z", last_used_at: "2026-10-02T18:30:00Z" };
const THEIRS = { ...MINE, link_id: "1b2c3d4e", made_by: "0b0b0b0b", person: "Avi", label: null, this_device: false, last_used_at: null };

// Connected as `role` to a controller with ask links (`old`: a 1.7.0 one).
async function connect({ role = "admin", old = false, items = [], doorControl = true } = {}) {
  Object.assign(controller, { calls: [], links: structuredClone(items), remoteAccess: true, homeLinked: true, doorControl, refuse: null, pulse: null });
  confirmed.length = 0;
  confirmAnswer = true;
  clipboard.length = 0;
  // At home with Direct HTTPS, as the controller's GET /v1/system said; this device seals there.
  stored.set(DIRECT_KEY, directRecord());
  stored.set("directorlink.seal", JSON.stringify({ host: HOST, keyId: "0a1b2c3d", seals: true }));
  views.leaveAskLink();
  ui.askLinks = null;
  ui.openRequest = null;
  ui.sceneLinks = null;
  Object.assign(state, {
    host: HOST,
    apiKey: "ak_test",
    status: "connected",
    transport: "lan",
    lanRoute: "https",
    loaded: true,
    online: true,
    role,
    rooms: [{ id: 11, name: "Entrance" }],
    lights: [],
    thermostats: [],
    fans: [],
    blinds: [],
    relays: [structuredClone(RELAY)],
    system: { bridge: { version: old ? "1.7.0" : "1.8.0" }, features: old ? { scene_links: true } : { scene_links: true, ask_links: true } },
    scenes: [{ id: "a1b2c3d4", name: "Good night", icon: "moon", show_on_home: false, version: 1, steps: [{ type: "lights", room_id: null, device_ids: null, set: { on: false } }] }],
    scenesUnsupported: false,
  });
  views.askLinkView(GATE); // reads the list, as opening the screen does
  await settle();
}

// ---- the question ----------------------------------------------------------------------------------

test("the question an alert's tap opens: Open answers with this device's key, once", async () => {
  await setLanguage("en");
  await connect();
  const until = Date.now() + 120000;
  let nodes = views.openRequestView(GATE, REQUEST, until);
  assert.equal(textOf(byKey(nodes, "open-request-question")), "Open Main gate?");
  assert.match(textOf(nodes), /You can answer until \d{2}:\d{2}\./, "the time as the rest of the app shows it (24 h, no seconds)");
  assert.equal(byKey(nodes, "open-request-cancel").attributes.href, "#/", "Cancel goes Home");
  assert.equal(controller.calls.filter((call) => call.path.endsWith("/pulse")).length, 0, "nothing is sent before Open");
  await press(nodes, "open-request-open");
  assert.deepEqual(calls("POST", `/v1/relays/${GATE}/pulse`).map((call) => call.body), [{ request: REQUEST }], "an ordinary pulse with the request's id");
  nodes = views.openRequestView(GATE, REQUEST, until);
  assert.match(textOf(byKey(nodes, "open-request-opened")), /Main gate is opening/);
  assert.equal(byKey(nodes, "open-request-open"), null, "no second Open");
});

test("Cancel sends nothing; an expired or answered request opens nothing", async () => {
  await setLanguage("en");
  await connect();
  let nodes = views.openRequestView(GATE, REQUEST, Date.now() + 60000);
  await press(nodes, "open-request-cancel");
  assert.equal(controller.calls.filter((call) => call.path.endsWith("/pulse")).length, 0);

  // Over by this device's clock: no Open at all.
  nodes = views.openRequestView(GATE, "1111111111111111", Date.now() - 1000);
  assert.equal(byKey(nodes, "open-request-open"), null);
  assert.match(textOf(byKey(nodes, "open-request-expired")), /This question is over: nothing was opened/);
  assert.equal(byKey(nodes, "open-request-room").attributes.href, "#/room/11", "the door's room, to open it there");

  // Over by the controller's: it says so, and nothing opened.
  controller.pulse = "OPEN_REQUEST_EXPIRED";
  nodes = views.openRequestView(GATE, "2222222222222222", Date.now() + 60000);
  await press(nodes, "open-request-open");
  assert.match(textOf(views.openRequestView(GATE, "2222222222222222", Date.now() + 60000)), /This question is over/);
  controller.pulse = "OPEN_REQUEST_ANSWERED";
  await press(views.openRequestView(GATE, "3333333333333333", Date.now() + 60000), "open-request-open");
  assert.match(textOf(views.openRequestView(GATE, "3333333333333333", Date.now() + 60000)), /answered already/);
  // Door Control off: said, and Open stays for when it is on.
  controller.pulse = "DOOR_CONTROL_DISABLED";
  await press(views.openRequestView(GATE, "4444444444444444", Date.now() + 60000), "open-request-open");
  nodes = views.openRequestView(GATE, "4444444444444444", Date.now() + 60000);
  assert.match(textOf(byKey(nodes, "open-request-error")), /Door control is off/);
  assert.ok(byKey(nodes, "open-request-open"));
});

test("the question on a device that can't open doors, or for a door that is gone", async () => {
  await setLanguage("en");
  await connect({ role: "member" });
  let nodes = views.openRequestView(GATE, REQUEST, Date.now() + 60000);
  assert.ok(byKey(nodes, "open-request-no-access"));
  assert.equal(byKey(nodes, "open-request-open"), null);
  await connect();
  nodes = views.openRequestView(999, REQUEST, Date.now() + 60000);
  assert.ok(byKey(nodes, "open-request-no-door"));
});

test("the question in Hebrew", async () => {
  await setLanguage("he");
  try {
    await connect();
    const nodes = views.openRequestView(GATE, REQUEST, Date.now() + 60000);
    assert.equal(textOf(byKey(nodes, "open-request-question")), "לפתוח את Main gate?");
    assert.match(textOf(byKey(nodes, "open-request-open")), /פתיחה/);
    // The words the service worker shows, in the app's language.
    const texts = alertTexts();
    assert.equal(texts.open_request_title, "לפתוח את {name}?");
    assert.match(texts.open_request, /\{via\}.*\{time\}/);
  } finally {
    await setLanguage("en");
  }
  const texts = alertTexts();
  assert.equal(texts.open_request_title, "Open {name}?");
  assert.equal(texts.open_request, "Your link “{via}” asked at {time}. Tap to answer.");
  assert.equal(texts.open_request_unnamed, "Your link asked at {time}. Tap to answer.");
});

// ---- the door's link --------------------------------------------------------------------------------

test("a door's row leads to its link for keys that may open it, with a controller that has them", async () => {
  await setLanguage("en");
  await connect();
  assert.equal(byKey(relayRow(state.relays[0]), `relay:${GATE}:ask`).attributes.href, `#/door/${GATE}/ask`);
  await connect({ role: "member" });
  assert.equal(byKey(relayRow(state.relays[0]), `relay:${GATE}:ask`), null);
  assert.match(textOf(views.askLinkView(GATE)), /Only someone who may open Main gate can make its link/);
  await connect({ old: true });
  assert.equal(byKey(relayRow(state.relays[0]), `relay:${GATE}:ask`), null);
  assert.match(textOf(views.askLinkView(GATE)), /needs DirectorLink 1\.8\.0/);
  assert.equal(calls("GET", "/v1/ask-links").length, 0, "a 1.7.0 controller is never asked");
});

test("making a door's link shows its secret once, with the steps for iPhone, Siri, Android and Google Assistant", async () => {
  await setLanguage("en");
  await connect();
  let nodes = views.askLinkView(GATE);
  assert.match(textOf(nodes), /asks you before Main gate opens/);
  assert.match(textOf(nodes), /whoever gets hold of it can only make your phone ask/);
  assert.ok(byKey(nodes, "ask-link-alerts"), "the question comes as an alert: this device has them off");
  // It leads to Settings → Alerts (1.10.0; Settings → Controller before).
  const alertsLink = byKey(nodes, "ask-link-alerts").children.find((child) => child.tagName === "A");
  assert.equal(alertsLink.attributes.href, "#/settings/alerts");
  assert.equal(alertsLink.textContent, "Alerts on this device");
  byKey(nodes, "ask-link-label").listeners.input[0]({ target: { value: " Arriving home " } });
  await press(nodes, "ask-link-make");
  assert.deepEqual(calls("POST", "/v1/ask-links").at(-1).body, { relay_id: GATE, label: "Arriving home" });
  nodes = views.askLinkView(GATE);
  assert.match(textOf(byKey(nodes, "ask-link-made")), /shown only this once/);
  assert.match(textOf(byKey(nodes, "ask-link-iphone")), /Arrive.*Get Contents of URL.*POST.*JSON.*secret.*Run Immediately.*Open Main gate\?/s);
  assert.match(textOf(byKey(nodes, "ask-link-siri")), /“Open Main gate”.*Hey Siri, Open Main gate.*only your Open opens the door/s);
  assert.match(textOf(byKey(nodes, "ask-link-google")), /HTTP Shortcuts.*“Open Main gate”.*Google Assistant.*routine/s);
  // A run that asked nobody shows nothing by itself: an optional last step shows its answer.
  assert.match(textOf(byKey(nodes, "ask-link-iphone")), /Run Immediately.*Optional.*Show Notification.*Contents of URL/s);
  assert.match(textOf(byKey(nodes, "ask-link-siri")), /Hey Siri, Open Main gate.*Optional.*Show Result.*Contents of URL/s);
  await setLanguage("he");
  assert.match(textOf(byKey(views.askLinkView(GATE), "ask-link-iphone")), /לא חובה.*„הצג עדכון” \(Show Notification\)/s);
  assert.match(textOf(byKey(views.askLinkView(GATE), "ask-link-siri")), /„הצג תוצאה” \(Show Result\)/);
  await setLanguage("en");
  nodes = views.askLinkView(GATE);
  assert.ok(byKey(nodes, "ask-link-android"));
  await press(nodes, "ask-link-iphone-address");
  await press(views.askLinkView(GATE), "ask-link-iphone-secret");
  assert.deepEqual(clipboard, [`https://api.directorlink.io/run/${HOME}.87654321`, SECRET]);
  assert.equal(JSON.stringify(ui.askLinks).includes(SECRET), false, "the secret is not kept in the app's state");
  assert.deepEqual(ui.askLinks.showing, [GATE]);
  await press(views.askLinkView(GATE), "ask-link-done");
  assert.deepEqual(ui.askLinks.showing, []);
  nodes = views.askLinkView(GATE);
  assert.equal(byKey(nodes, "ask-link-made"), null, "Done forgets it");
  assert.match(textOf(byKey(nodes, "ask-link-facts")), /Arriving home/);
  assert.match(textOf(byKey(nodes, "ask-link-voice")), /Hey Siri, Open Main gate/);
  assert.ok(!textOf(nodes).includes(SECRET));
});

test("replace and remove ask first; what a link needs is said", async () => {
  await setLanguage("en");
  await connect({ items: [MINE] });
  confirmAnswer = false;
  await press(views.askLinkView(GATE), "ask-link-remove");
  assert.equal(calls("DELETE", `/v1/ask-links/${MINE.link_id}`).length, 0, "Cancel removes nothing");
  confirmAnswer = true;
  await press(views.askLinkView(GATE), "ask-link-remove");
  assert.equal(calls("DELETE", `/v1/ask-links/${MINE.link_id}`).length, 1);
  assert.match(textOf(byKey(views.askLinkView(GATE), "ask-link-message")), /The link was removed/);
  assert.ok(byKey(views.askLinkView(GATE), "ask-link-make"));

  await connect({ doorControl: false });
  const nodes = views.askLinkView(GATE);
  assert.match(textOf(byKey(nodes, "ask-link-doors-off")), /Door control is off in Composer/);
  assert.equal(byKey(nodes, "ask-link-make").attributes.disabled, "");
  await connect();
  controller.refuse = "FORBIDDEN";
  await press(views.askLinkView(GATE), "ask-link-make");
  assert.match(textOf(byKey(views.askLinkView(GATE), "ask-link-message")), /may not open this door/);
});

test("the list of links: an admin sees everyone's, and removes another person's after a question", async () => {
  await setLanguage("en");
  await connect({ items: [MINE, THEIRS] });
  let nodes = sceneViews.sceneLinksView();
  const section = byKey(nodes, "ask-links-section");
  assert.match(textOf(section), /Ask before opening/);
  assert.equal(byKey(section, `ask-links-item:${MINE.link_id}`).attributes.href, `#/door/${GATE}/ask`, "this device's: its screen");
  assert.match(textOf(byKey(section, `ask-links-item:${THEIRS.link_id}`)), /Main gate.*asks Avi.*never ran/s);
  confirmAnswer = false;
  await press(nodes, `ask-links-remove:${THEIRS.link_id}`);
  assert.equal(confirmed.at(-1), "Remove the link of Avi for Main gate? It stops working at once.");
  assert.equal(calls("DELETE", `/v1/ask-links/${THEIRS.link_id}`).length, 0);
  confirmAnswer = true;
  await press(nodes, `ask-links-remove:${THEIRS.link_id}`);
  assert.equal(calls("DELETE", `/v1/ask-links/${THEIRS.link_id}`).length, 1);
  nodes = sceneViews.sceneLinksView();
  assert.equal(byKey(nodes, `ask-links-item:${THEIRS.link_id}`), null);
  assert.match(textOf(byKey(nodes, "ask-links-message")), /The link was removed/);
});

// ---- the links of a user's other devices (1.9.0, ADR-062) ---------------------------------------------

test("a member sees the links of all their devices for a door, and removes the one on a lost phone", async () => {
  await setLanguage("en");
  const mine = { ...MINE, person: "Avi", device: "Avi's tablet", this_user: true };
  const lost = { ...MINE, link_id: "2c3d4e5f", made_by: "0c0c0c0c", person: "Avi", device: "Avi's old phone", label: "Arriving home", this_device: false, this_user: true, last_used_at: null };
  // A member given doors and gates (1.8.0, ADR-054).
  state.access = { role: "member", doors: true };
  try {
    await connect({ role: "member", items: [mine, lost] });
    let nodes = views.askLinkView(GATE);
    assert.match(textOf(byKey(nodes, "ask-link-facts")), /Arriving home/, "this device's link, as before");
    const others = byKey(nodes, "ask-link-others");
    assert.ok(others, "the other devices' links are on the door's screen");
    assert.match(textOf(others), /On your other devices.*Each of your devices has its own link for this door.*Avi's old phone.*“Arriving home”.*never ran/s);
    assert.equal(byKey(others, `ask-link-other:${mine.link_id}`), null, "not this device's again");

    confirmAnswer = false;
    await press(nodes, `ask-link-other-remove:${lost.link_id}`);
    assert.equal(confirmed.at(-1), "Remove the link on Avi's old phone for Main gate? It stops working at once.");
    assert.equal(calls("DELETE", `/v1/ask-links/${lost.link_id}`).length, 0, "Cancel removes nothing");
    confirmAnswer = true;
    await press(nodes, `ask-link-other-remove:${lost.link_id}`);
    assert.equal(calls("DELETE", `/v1/ask-links/${lost.link_id}`).length, 1);
    nodes = views.askLinkView(GATE);
    assert.match(textOf(byKey(nodes, "ask-link-message")), /The link was removed/);
    assert.equal(byKey(nodes, "ask-link-others"), null, "none left");
    assert.ok(byKey(nodes, "ask-link-facts"), "this device's stays");

    // Without a link on this device, the others still show beside Make.
    await connect({ role: "member", items: [lost] });
    nodes = views.askLinkView(GATE);
    assert.ok(byKey(nodes, "ask-link-make"));
    assert.ok(byKey(nodes, `ask-link-other-remove:${lost.link_id}`));

    // A 1.8.0 controller says neither the device nor whose: a member's list is all theirs.
    const { device: _device, this_user: _mine, ...older } = lost;
    await connect({ role: "member", items: [older] });
    assert.match(textOf(byKey(views.askLinkView(GATE), "ask-link-others")), /Another device of yours/);

    // In Hebrew.
    await setLanguage("he");
    assert.match(textOf(byKey(views.askLinkView(GATE), "ask-link-others")), /במכשירים האחרים שלכם.*מכשיר אחר שלכם/s);
  } finally {
    await setLanguage("en");
    state.access = null;
  }
});

test("on a door's screen an admin sees their own devices' other links; the list shows each link's device", async () => {
  await setLanguage("en");
  const ipad = { ...MINE, link_id: "3d4e5f6a", made_by: "0d0d0d0d", device: "Dana's iPad", this_device: false, this_user: true };
  const avis = { ...THEIRS, device: "Avi's phone", this_user: false };
  await connect({ items: [{ ...MINE, device: "Dana's iPhone", this_user: true }, ipad, avis] });
  const others = byKey(views.askLinkView(GATE), "ask-link-others");
  assert.ok(byKey(others, `ask-link-other:${ipad.link_id}`), "her iPad's");
  assert.equal(byKey(others, `ask-link-other:${avis.link_id}`), null, "not another user's: those are in the list");
  const section = byKey(sceneViews.sceneLinksView(), "ask-links-section");
  assert.match(textOf(byKey(section, `ask-links-item:${avis.link_id}`)), /Main gate.*asks Avi.*on Avi's phone.*never ran/s);
  assert.match(textOf(byKey(section, `ask-links-item:${ipad.link_id}`)), /on Dana's iPad/);
});

// ---- Siri and Google Assistant on a scene's link ------------------------------------------------------

test("a scene link's screen says how to run it by voice, in English and Hebrew", async () => {
  await setLanguage("en");
  await connect();
  const SCENE = "a1b2c3d4";
  // A new link: Siri and Google Assistant, named like the scene.
  const { makeLink } = await import("../../app/js/scene-links.js");
  const realFetch = answers.fetch;
  answers.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === `/v1/scenes/${SCENE}/link` && init.method === "POST") {
      return answer(201, { scene_id: SCENE, scene_name: "Good night", link_id: "12345678", label: null, made_by: "0a1b2c3d", created_at: "2026-10-03T08:00:00Z", last_used_at: null, home_id: HOME, secret: SECRET, url: `https://api.directorlink.io/run/${HOME}.12345678#${SECRET}`, replaced: false });
    }
    if (pathname === "/v1/scene-links") return answer(200, { items: [], remote_access: true, home_linked: true });
    return realFetch(url, init);
  };
  try {
    await makeLink(SCENE, "");
    let nodes = sceneViews.sceneLinkView(SCENE);
    assert.match(textOf(byKey(nodes, "scene-link-siri")), /name it like the scene: “Good night”.*Say “Hey Siri, Good night”/s);
    assert.doesNotMatch(textOf(byKey(nodes, "scene-link-siri")), /Show Result/, "only an ask link's steps have it");
    assert.equal(byKey(nodes, "scene-link-siri").attributes.open, "", "open on an iPhone");
    assert.match(textOf(byKey(nodes, "scene-link-google")), /HTTP Shortcuts, Tasker or MacroDroid.*“Good night”.*Google Assistant.*Routines.*“Good night”/s);
    await setLanguage("he");
    nodes = sceneViews.sceneLinkView(SCENE);
    assert.match(textOf(byKey(nodes, "scene-link-siri")), /„Good night”.*היי Siri, Good night/s);
    assert.match(textOf(byKey(nodes, "scene-link-google")), /Google Assistant/);
  } finally {
    answers.fetch = realFetch;
    sceneViews.leaveSceneLink();
    await setLanguage("en");
  }
});

// ---- History -----------------------------------------------------------------------------------------

test("the history: asked, nobody asked and why, the opening that answered, and the links", async () => {
  await setLanguage("en");
  assert.equal(plain(outcomeText({ kind: "door", action: "asked", count: 2, who: { type: "link", name: "Arriving home" } })), "Asked on 2 devices");
  assert.equal(plain(outcomeText({ kind: "door", action: "asked", count: 0, reason: "nobody", outcome: "skipped" })), "Nobody was asked: no device of theirs has alerts on");
  assert.equal(plain(outcomeText({ kind: "door", action: "asked", count: 0, reason: "doors_off", outcome: "skipped" })), "Nobody was asked: door control was off in Composer");
  assert.equal(plain(outcomeText({ kind: "door", action: "pulse", note: "Arriving home", ids: { device_id: 70, link_id: "9a8b7c6d" } })), "Answering the link “Arriving home”");
  assert.equal(plain(outcomeText({ kind: "door", action: "pulse", ids: { device_id: 70 } })), "", "an ordinary opening");
  assert.equal(plain(outcomeText({ kind: "access", action: "ask_link_removed", reason: "no_access", note: "Arriving home" })), "Its user may no longer open the door · Link “Arriving home”");
  assert.equal(plain(outcomeText({ kind: "access", action: "ask_link_removed", reason: "key_gone" })), "The key that made it was removed or expired");
  for (const key of ["ask_link_created", "ask_link_replaced", "ask_link_removed"]) assert.ok(en.history.access[key] && he.history.access[key], key);
  assert.ok(en.history.door.asked && he.history.door.asked);
});

test("every string is in both languages", () => {
  const keys = (node, prefix = "") =>
    Object.entries(node).flatMap(([key, value]) => (value && typeof value === "object" && !("other" in value) ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
  assert.deepEqual(keys(he.askLinks).sort(), keys(en.askLinks).sort());
  assert.deepEqual(keys(he.openRequest).sort(), keys(en.openRequest).sort());
  assert.deepEqual(keys(he.sceneLinks).sort(), keys(en.sceneLinks).sort());
  for (const key of ["openRequestTitle", "openRequest", "openRequestUnnamed"]) assert.ok(en.alerts[key] && he.alerts[key], key);
  assert.equal(asks.requestOver(Date.now() + 1000), false);
  assert.equal(asks.requestOver(Date.now() - 1), true);
  assert.equal(asks.requestOver(Number.NaN), true);
});

// The question's wait for its end does not keep the tests running.
after(() => views.leaveOpenRequest());
