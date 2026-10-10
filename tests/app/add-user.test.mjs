// Adding users and their devices (1.12.0, ADR-083; app/js/views/access.js, settings.js,
// device-limit.js): Settings → Users' Add a user, a name and their access first, then Send a link
// (with the user's name, to the email of their account) or a pairing code; a controller before
// 1.12.0 gets the link without the name, and the app says to rename them; Settings → Account no
// longer invites someone; every user renames their own devices and names themself; a device not
// used for 30 days says so next to Remove; "What's your name?" once, at the top of Settings; and the
// words in English, Hebrew, Spanish and Italian. Against a fake controller, with just enough of a
// browser.
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
  getContext() {
    return { fillRect() {}, fillStyle: "" };
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}
globalThis.Node = FakeNode;
globalThis.window = globalThis;
globalThis.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/#/access", pathname: "/", search: "", hash: "#/access", replace() {} };
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
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints: 0, languages: ["en"], language: "en", onLine: true },
  configurable: true,
});
const stored = new Map();
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: (key) => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, String(value)), removeItem: (key) => stored.delete(key) },
  configurable: true,
});
const prompts = [];
window.prompt = (text, value) => {
  prompts.push({ text, value });
  return prompts.answer ?? null;
};
window.confirm = () => true;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.setTimeout = ((original) => (callback, delay, ...rest) => {
  const timer = original(callback, delay, ...rest);
  timer?.unref?.();
  return timer;
})(globalThis.setTimeout);

// ---- the fake controller --------------------------------------------------------------------------
const HOST = "controller.invalid";
const HOME = "ab".repeat(16);
const MEMBER = { role: "member", owner: false, all_rooms: false, rooms: [11], kinds: { light: true, climate: true, fan: true, blind: true, music: true, refrigerator: true }, cameras: true, doors: false, alarm: true, scenes: [] };
const ADMIN = { ...MEMBER, role: "admin", all_rooms: true, rooms: [], doors: true };
const controller = { calls: [], users: null };
const DAY = 24 * 3600 * 1000;

function answer(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" } });
}

const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();
const device = (id, name, extra = {}) => ({ id, name, created_at: daysAgo(60), last_used_at: daysAgo(1), expires_at: null, current: false, accounts: 1, removable: true, ...extra });

globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname: path } = new URL(url);
  if (hostname !== HOST) throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  controller.calls.push({ method, path, body });
  if (path === "/v1/sealed") return answer(404, { status: 404, code: "NOT_FOUND" });
  if (method === "GET" && path === "/v1/users") return answer(200, controller.users);
  if (method === "GET" && path === "/v1/invitations") return answer(200, { items: controller.invitations || [] });
  if (method === "POST" && path === "/v1/pairing-code") {
    return answer(201, { code: "1234 5678", expires_at: new Date(Date.now() + 900_000).toISOString(), user: { id: body.profile_id ?? null, name: body.name ?? "Noa", role: body.role ?? "member" } });
  }
  if (method === "POST" && path === "/v1/invitations") {
    return answer(201, { id: "1c2d3e4f", role: body.role, for_me: body.for_me === true, name: body.name, secret: "5e".repeat(32), home_id: HOME, expires_at: new Date(Date.now() + 7 * DAY).toISOString(), registered: true, email: body.email });
  }
  if (method === "PATCH" && path.startsWith("/v1/api-keys/")) return answer(200, { id: path.split("/").pop(), name: body.name, role: "member" });
  if (method === "PATCH" && path === "/v1/profile") return answer(200, { id: "aaaa0001", name: body.name, created_at: daysAgo(30), version: 4, prefs: {}, name_from_device: false });
  if (method === "PATCH" && path.startsWith("/v1/profiles/")) return answer(200, { id: path.split("/").pop(), name: body.name });
  if (method === "GET") return answer(200, { items: [] });
  return answer(404, { status: 404, code: "NOT_FOUND", detail: `no ${method} ${path}` });
};

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage, formatDate } = await import("../../app/js/i18n.js");
const { accessView, resetAccess } = await import("../../app/js/views/access.js");
const { settingsView } = await import("../../app/js/views/settings.js");
const dictionaries = Object.fromEntries(await Promise.all(["en", "he", "es", "it"].map(async (code) => [code, (await import(`../../app/i18n/${code}.js`)).default])));

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
const textOf = (nodes) => [nodes].flat(Infinity).filter(Boolean).map((node) => node.textContent).join(" | ");
async function press(nodes, key, event = {}) {
  const element = byKey(nodes, key);
  assert.ok(element, `${key} is on the screen: ${textOf(nodes).slice(0, 600)}`);
  for (const type of ["click", "change", "submit"]) {
    await Promise.all((element.listeners[type] || []).map((listener) => listener({ preventDefault() {}, target: element, currentTarget: element, ...event })));
  }
  await settle();
}
function type(nodes, key, value) {
  const field = byKey(nodes, key);
  assert.ok(field, `${key} is on the screen`);
  field.value = value;
  for (const listener of field.listeners.input || []) listener();
}
const calls = (method, path) => controller.calls.filter((call) => call.method === method && call.path === path);

const ROOMS = [
  { id: 10, name: "Kitchen", names: {}, hidden_from_members: false },
  { id: 11, name: "Living room", names: {}, hidden_from_members: false },
];

function homeUsers() {
  return {
    device_limit: 5,
    accounts_known: true,
    items: [
      { id: "aaaa0001", name: "Chrome on Windows", created_at: daysAgo(90), you: true, access: { ...ADMIN, owner: true }, accounts: 1, devices: [device("0a1b2c3d", "Chrome on Windows", { current: true, removable: false })] },
      {
        id: "bbbb0003",
        name: "Ort",
        created_at: daysAgo(90),
        you: false,
        access: { ...MEMBER },
        accounts: 1,
        devices: [
          device("0a1b2c3f", "Samsung Internet on Android", { last_used_at: "2026-08-30T08:00:00Z" }),
          device("0a1b2c40", "Ort's tablet", { last_used_at: null, created_at: daysAgo(45) }),
          device("0a1b2c41", "Ort's new phone", { last_used_at: null, created_at: daysAgo(2) }),
        ],
      },
    ],
    suggestions: [],
  };
}

function connect({ access = { ...ADMIN, owner: true }, users = homeUsers(), features = { people_permissions: true, users: true, user_names: true }, linked = true, profile = { id: "aaaa0001", name: "Dana", name_from_device: false, prefs: {} } } = {}) {
  controller.calls = [];
  controller.users = users;
  prompts.length = 0;
  prompts.answer = null;
  resetAccess();
  ui.inviteForm = false;
  ui.homeInvitation = null;
  ui.nameCard = null;
  if (linked) stored.set("directorlink.remote", JSON.stringify({ home: HOME, keyId: "0a1b2c3d" }));
  else stored.delete("directorlink.remote");
  Object.assign(state, {
    host: HOST,
    apiKey: "ak_test",
    status: "connected",
    transport: "lan",
    loaded: true,
    online: true,
    role: access.role === "admin" ? "admin" : "member",
    access,
    rooms: structuredClone(ROOMS),
    profile,
    scenes: [],
    system: { bridge: { version: "1.12.0" }, features },
    account: { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false },
  });
}

async function open() {
  accessView({});
  await settle();
  return accessView({});
}

// Step 1: the name (required) and their access; step 2: how they connect.
async function addUser(name, { member = true } = {}) {
  await press(await open(), "users-add-open");
  let view = accessView({});
  assert.match(textOf(byKey(view, "users-add")), /Add a user.*Name/);
  await press(view, "users-add");
  assert.match(textOf(accessView({})), /Give the new user a name\./, "a name is needed");
  type(accessView({}), "users-add-name", name);
  if (member) {
    byKey(accessView({}), "users-add-all-rooms").listeners.change[0]({ target: { checked: false } });
    byKey(accessView({}), "users-add-room-10").listeners.change[0]({ target: { checked: true } });
  } else {
    byKey(accessView({}), "users-add-role:admin").listeners.change[0]({ target: { checked: true } });
  }
  await press(accessView({}), "users-add");
  view = accessView({});
  assert.match(textOf(byKey(view, "users-add")), new RegExp(`How will ${name} connect\\?`));
  return view;
}

test("Add a user: a name and their access, then a link that names them", async () => {
  connect();
  setLanguage("en");
  let view = await addUser("Dana");
  assert.match(textOf(byKey(view, "users-add-summary")), /Member · 1 room/);
  assert.match(textOf(view), /Send a link.*Google or Apple account.*7 days/);
  assert.match(textOf(view), /Pairing code.*no account needed/);
  // Back keeps what was chosen.
  await press(view, "users-add-back");
  assert.equal(byKey(accessView({}), "users-add-name").attributes.value ?? byKey(accessView({}), "users-add-name").value, "Dana");
  await press(accessView({}), "users-add");
  view = accessView({});
  await press(view, "users-add-link-form");
  assert.match(textOf(accessView({})), /Enter the email address they sign in with/);
  type(accessView({}), "users-add-email", "dana@example.com");
  await press(accessView({}), "users-add-link-form");
  const [sent] = calls("POST", "/v1/invitations");
  assert.equal(sent.body.name, "Dana", "the new user's name goes to the controller");
  assert.equal(sent.body.email, "dana@example.com");
  assert.equal(sent.body.role, "member");
  assert.deepEqual(sent.body.rooms ?? sent.body.access?.rooms, [10]);
  assert.equal(sent.body.for_me, undefined);
  assert.ok(sent.body.expires_in > 6 * 24 * 3600, "7 days");
  view = accessView({});
  assert.equal(byKey(view, "users-add"), null, "the steps are done");
  const added = byKey(view, "users-added");
  assert.match(textOf(added), /A link for Dana/);
  assert.match(textOf(added), /Send this link to dana@example\.com\. It works once, for 7 days, when they sign in with that email, and they join as Dana\./);
  let link = null;
  walk(added, (node) => {
    if (node.tagName === "INPUT" && /invitation-link/.test(node.className)) link = node;
  });
  assert.match(link.value ?? link.attributes.value, /^https:\/\/app\.directorlink\.io\/#\/join\/abababababababababababababababab\.1c2d3e4f\.(5e){32}$/);
  await press(view, "users-added-done");
  assert.equal(byKey(accessView({}), "users-added"), null);
});

test("Add a user: a pairing code for them at home, with the same name and access", async () => {
  connect();
  setLanguage("en");
  const view = await addUser("Grandma", { member: false });
  assert.match(textOf(byKey(view, "users-add-summary")), /Admin/);
  await press(view, "users-add-code");
  const [made] = calls("POST", "/v1/pairing-code");
  assert.equal(made.body.name, "Grandma");
  assert.equal(made.body.role, "admin");
  assert.match(textOf(byKey(accessView({}), "users-pairing")), /Pairing code for Grandma/);
  assert.equal(byKey(accessView({}), "users-add"), null);
});

test("Add a user: a home not linked to an account offers only the pairing code", async () => {
  connect({ linked: false });
  setLanguage("en");
  const view = await addUser("Noa");
  assert.equal(byKey(view, "users-add-link"), null);
  assert.match(textOf(byKey(view, "users-add-unlinked")), /needs this home linked to your account/);
  assert.ok(byKey(view, "users-add-code"));
});

test("Add a user with a controller before 1.12.0: the link without the name, and the app says to rename them", async () => {
  connect({ features: { people_permissions: true, users: true } });
  setLanguage("en");
  await addUser("Dana");
  type(accessView({}), "users-add-email", "dana@example.com");
  await press(accessView({}), "users-add-link-form");
  const [sent] = calls("POST", "/v1/invitations");
  assert.equal(sent.body.name, undefined, "a 1.11 controller would refuse the field");
  assert.match(textOf(byKey(accessView({}), "users-added")), /names them after their device: rename them to Dana once they joined/);
});

test("Settings → Account adds my other device only; Invite someone stays for controllers before 1.9.0", () => {
  connect();
  setLanguage("en");
  let page = settingsView({ page: "account" });
  assert.ok(byKey(page, "add-device"));
  assert.equal(byKey(page, "invite"), null, "an admin adds a user in Settings → Users");
  assert.match(textOf(page), /To add someone else: Settings → Users → Add a user\./);
  connect({ features: { people_permissions: true } });
  page = settingsView({ page: "account" });
  assert.ok(byKey(page, "invite"), "no Settings → Users there");
});

test("devices are renamed by their user and by admins; a user names themself", async () => {
  connect();
  setLanguage("en");
  prompts.answer = "Ort's phone";
  await press(await open(), "access-rename-device-0a1b2c3f");
  assert.equal(prompts.at(-1).text, "Name of this device");
  assert.equal(prompts.at(-1).value, "Samsung Internet on Android");
  assert.deepEqual(calls("PATCH", "/v1/api-keys/0a1b2c3f")[0].body, { name: "Ort's phone" });
  assert.match(textOf(accessView({})), /Renamed to Ort's phone\./);
  // A member: their own devices, and their own name (PATCH /v1/profile).
  const mine = { device_limit: 5, accounts_known: true, suggestions: [], items: [{ ...homeUsers().items[1], you: true }] };
  mine.items[0].devices[0].current = true;
  connect({ access: { ...MEMBER }, users: mine, profile: { id: "bbbb0003", name: "Ort", prefs: {} } });
  let view = await open();
  assert.ok(byKey(view, "access-rename-device-0a1b2c40"), "their own other device");
  assert.ok(byKey(view, "access-rename-device-0a1b2c3f"), "this device too");
  assert.equal(byKey(view, "access-edit-bbbb0003"), null, "access stays the admins'");
  prompts.answer = "Ort Cohen";
  await press(view, "access-rename-profile-bbbb0003");
  assert.deepEqual(calls("PATCH", "/v1/profile")[0].body, { name: "Ort Cohen" });
  assert.equal(calls("PATCH", "/v1/profiles/bbbb0003").length, 0);
  assert.equal(state.profile.name, "Ort Cohen", "this device knows its user's new name");
  // A controller before 1.12.0: a member renames nothing.
  connect({ access: { ...MEMBER }, users: mine, features: { people_permissions: true, users: true } });
  view = await open();
  assert.equal(byKey(view, "access-rename-device-0a1b2c40"), null);
  assert.equal(byKey(view, "access-rename-profile-bbbb0003"), null);
});

test("a device not used for 30 days says since when, or that it never was, next to Remove", async () => {
  connect();
  setLanguage("en");
  const view = await open();
  const old = byKey(view, "access-used-0a1b2c3f");
  assert.equal(textOf(old), `not used since ${formatDate(new Date("2026-08-30T08:00:00Z"))}`);
  assert.match(old.className, /access-stale/);
  assert.ok(byKey(view, "access-revoke-0a1b2c3f"), "Remove next to it");
  assert.equal(textOf(byKey(view, "access-used-0a1b2c40")), "never used", "added 45 days ago, never used");
  assert.equal(textOf(byKey(view, "access-used-0a1b2c41")), "not used yet", "added 2 days ago");
  assert.doesNotMatch(byKey(view, "access-used-0a1b2c41").className, /access-stale/);
  assert.match(textOf(byKey(view, "access-used-0a1b2c3d")), /^used /);
});

test("What's your name? once, at the top of Settings: Save, or Not now", async () => {
  // Named after this device, as the controller says.
  connect({ profile: { id: "aaaa0001", name: "Chrome on Windows", name_from_device: true, prefs: {} } });
  setLanguage("en");
  stored.delete("directorlink.nameAsked");
  let page = settingsView({});
  const card = byKey(page, "name-card");
  assert.ok(card, "asked");
  assert.match(textOf(card), /What’s your name\?.*Right now it says “Chrome on Windows”/);
  type(page, "name-card-name", "  Israel ");
  await press(page, "name-card");
  assert.deepEqual(calls("PATCH", "/v1/profile")[0].body, { name: "Israel" });
  assert.equal(state.profile.name, "Israel");
  page = settingsView({});
  assert.equal(byKey(page, "name-card"), null);
  assert.match(textOf(byKey(page, "name-saved")), /Thanks, Israel\./);
  // Asked once on this device: a name like a device's, then Not now.
  stored.delete("directorlink.nameAsked");
  connect({ profile: { id: "bbbb0003", name: "Samsung Internet on Android", prefs: {} } });
  page = settingsView({});
  assert.ok(byKey(page, "name-card"), "a name like the app's device names");
  await press(page, "name-card-later");
  assert.equal(byKey(settingsView({}), "name-card"), null);
  ui.nameCard = null;
  assert.equal(byKey(settingsView({}), "name-card"), null, "not again on this device");
  // A user with a name, and a controller before 1.12.0, are not asked.
  stored.delete("directorlink.nameAsked");
  connect({ profile: { id: "cccc0004", name: "Dana", name_from_device: false, prefs: {} } });
  assert.equal(byKey(settingsView({}), "name-card"), null);
  connect({ profile: { id: "cccc0004", name: "Chrome on Windows", prefs: {} }, features: { people_permissions: true, users: true } });
  assert.equal(byKey(settingsView({}), "name-card"), null);
});

test("the invitations list says whom an invitation is for", async () => {
  connect();
  setLanguage("en");
  controller.invitations = [{ id: "1c2d3e4f", role: "member", name: "Dana", access: { ...MEMBER }, created_at: daysAgo(1), expires_at: new Date(Date.now() + 6 * DAY).toISOString(), created_by: "0a1b2c3d", for_me: false }];
  const view = await open();
  assert.match(textOf(byKey(view, "access-invitation-1c2d3e4f")), /^Dana · Member/);
  controller.invitations = null;
});

test("every new word is there in English, Hebrew, Spanish and Italian", () => {
  const keys = (value, prefix = "") =>
    Object.entries(value).flatMap(([key, item]) => (item && typeof item === "object" && !("one" in item || "other" in item) ? keys(item, `${prefix}${key}.`) : [`${prefix}${key}`]));
  const pick = (dictionary) => ({ add: dictionary.users.add, device: dictionary.users.device, name: dictionary.users.name, move: dictionary.move, homeScreen: dictionary.join.homeScreen, paste: dictionary.deviceJoin.paste });
  const english = keys(pick(dictionaries.en)).sort();
  for (const code of ["he", "es", "it"]) {
    assert.deepEqual(keys(pick(dictionaries[code])).sort(), english, code);
    for (const [key, value] of Object.entries({ joined: dictionaries[code].join.joined, moved: dictionaries[code].history.access.moved, addHelpUsers: dictionaries[code].settings.account.home.addHelpUsers })) {
      assert.ok(typeof value === "string" && value.length > 3, `${code} ${key}`);
      assert.notEqual(value, { joined: dictionaries.en.join.joined, moved: dictionaries.en.history.access.moved, addHelpUsers: dictionaries.en.settings.account.home.addHelpUsers }[key], `${code} ${key} is translated`);
    }
  }
  assert.match(dictionaries.he.users.add.open, /[֐-׿]/, "Hebrew");
  assert.equal(dictionaries.en.users.newUser, undefined, "New user at home is Add a user now");
  // Users, never people.
  const words = (...blocks) => blocks.flatMap((block) => (typeof block === "string" ? [block] : words(...Object.values(block)))).join(" ").replace(/\{\w+\}/g, "");
  assert.doesNotMatch(words(dictionaries.en.users, dictionaries.en.move), /\bpeople\b|\bperson\b/i);
});
