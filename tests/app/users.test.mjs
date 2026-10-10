// Users and their devices (1.9.0, ADR-061; app/js/views/access.js with `features.users`,
// views/device-limit.js and the parts of Settings that use them): Settings → Users shows each user
// with their access, account and devices, and Remove where the controller says the caller may; a
// member sees only their own user; a sixth device is refused with "Remove a device first" and the
// list; an admin makes a pairing code for a user or a new one, and brings an account's devices
// together choosing whose access stays (the owner's stays, and only the owner confirms that one);
// a member adds their own other device in Settings → Account; the words are users, in English and
// Hebrew. Against a fake controller, with just enough of a browser.
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
const confirmed = [];
window.confirm = (text) => {
  confirmed.push(text);
  return true;
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.setTimeout = ((original) => (callback, delay, ...rest) => {
  const timer = original(callback, delay, ...rest);
  timer?.unref?.();
  return timer;
})(globalThis.setTimeout);

// ---- the fake controller --------------------------------------------------------------------------
const HOST = "controller.invalid";
const MEMBER = { role: "member", owner: false, all_rooms: false, rooms: [11], kinds: { light: true, climate: true, fan: true, blind: true, music: true, refrigerator: true }, cameras: true, doors: false, alarm: true, scenes: [] };
const ADMIN = { ...MEMBER, role: "admin", all_rooms: true, rooms: [], doors: true };
const controller = { calls: [], users: null, refuse: null };

function answer(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" } });
}

const device = (id, name, extra = {}) => ({ id, name, created_at: "2026-10-01T08:00:00Z", last_used_at: "2026-10-05T07:00:00Z", expires_at: null, current: false, accounts: 1, removable: true, ...extra });

globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname: path } = new URL(url);
  if (hostname !== HOST) throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  controller.calls.push({ method, path, body });
  if (path === "/v1/sealed") return answer(404, { status: 404, code: "NOT_FOUND" });
  if (controller.refuse && controller.refuse.method === method && controller.refuse.path === path) {
    const { status, problem } = controller.refuse;
    controller.refuse = null;
    return answer(status, problem);
  }
  if (method === "GET" && path === "/v1/users") return answer(200, controller.users);
  if (method === "GET" && path === "/v1/invitations") return answer(200, { items: [] });
  if (method === "POST" && path === "/v1/pairing-code") {
    return answer(201, { code: "1234 5678", expires_at: "2026-10-05T08:15:00Z", user: { id: body.profile_id ?? null, name: body.name ?? "Noa", role: body.role ?? "member" } });
  }
  if (method === "DELETE" && path === "/v1/pairing-code") return answer(204);
  if (method === "POST" && path === "/v1/users/merge") {
    const suggestion = controller.users.suggestions.find((item) => item.id === body.account);
    if (suggestion?.revision && body.revision !== suggestion.revision) return answer(409, { type: "about:blank", title: "Conflict", status: 409, code: "SUGGESTION_CHANGED", detail: "changed" });
    return answer(200, controller.users.items[0]);
  }
  if (method === "DELETE" && path.startsWith("/v1/api-keys/")) return answer(204);
  if (method === "POST" && path === "/v1/invitations") {
    return answer(201, { id: "1c2d3e4f", role: body.role, for_me: body.for_me === true, secret: "5e".repeat(32), home_id: "ab".repeat(16), expires_at: "2026-10-05T08:10:00Z", registered: true, email: body.email });
  }
  if (method === "GET") return answer(200, { items: [] });
  return answer(404, { status: 404, code: "NOT_FOUND", detail: `no ${method} ${path}` });
};

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const { accessView, resetAccess } = await import("../../app/js/views/access.js");
const { settingsView } = await import("../../app/js/views/settings.js");
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
const textOf = (nodes) => [nodes].flat(Infinity).filter(Boolean).map((node) => node.textContent).join(" | ");
async function press(nodes, key, event = {}) {
  const element = byKey(nodes, key);
  assert.ok(element, `${key} is on the screen: ${textOf(nodes).slice(0, 600)}`);
  for (const type of ["click", "change", "submit"]) {
    await Promise.all((element.listeners[type] || []).map((listener) => listener({ preventDefault() {}, target: element, currentTarget: element, ...event })));
  }
  await settle();
}
const calls = (method, path) => controller.calls.filter((call) => call.method === method && call.path === path);

const ROOMS = [
  { id: 10, name: "Kitchen", names: {}, hidden_from_members: false },
  { id: 11, name: "Living room", names: {}, hidden_from_members: false },
];

// The owner (Dana, two devices of one account in two users: 1.8.0 split them), and Noa, a member.
function homeUsers() {
  return {
    device_limit: 5,
    accounts_known: true,
    items: [
      { id: "aaaa0001", name: "Dana", created_at: "2026-09-01T08:00:00Z", you: true, access: { ...ADMIN, owner: true }, accounts: 1, devices: [device("0a1b2c3d", "Chrome on Windows", { current: true, removable: false })] },
      { id: "aaaa0002", name: "Chrome on iPhone", created_at: "2026-09-02T08:00:00Z", you: false, access: { ...ADMIN }, accounts: 1, devices: [device("0a1b2c3e", "Safari on iPhone")] },
      { id: "bbbb0003", name: "Noa", created_at: "2026-09-03T08:00:00Z", you: false, access: { ...MEMBER }, accounts: 0, devices: [device("0a1b2c3f", "Chrome on Android", { accounts: 0 }), device("0a1b2c40", "Noa's tablet", { accounts: 0, last_used_at: null })] },
    ],
    suggestions: [
      { id: "3f9a1c2e7b4d5a60", revision: "77aa77aa77aa77aa", owner: true, keep: "aaaa0001", may_confirm: true, users: [{ id: "aaaa0001", name: "Dana", role: "admin", owner: true, devices: ["0a1b2c3d"], devices_after: 2 }, { id: "aaaa0002", name: "Chrome on iPhone", role: "admin", owner: false, devices: ["0a1b2c3e"], devices_after: 2 }] },
    ],
  };
}

function connect({ access = { ...ADMIN, owner: true }, users = homeUsers(), features = { people_permissions: true, users: true } } = {}) {
  controller.calls = [];
  controller.users = users;
  controller.refuse = null;
  confirmed.length = 0;
  resetAccess();
  ui.inviteForm = false;
  ui.homeLimit = null;
  ui.homeInvitation = null;
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
    profile: { id: "aaaa0001", prefs: { hidden_rooms: [] } },
    scenes: [],
    system: { bridge: { version: "1.9.0" }, features },
    account: { status: "signed-out", user: null, notice: null, busy: false },
  });
}

async function open() {
  accessView({});
  await settle();
  return accessView({});
}

test("Settings → Users: each user with their access and account, their devices under them, Remove where allowed", async () => {
  connect();
  setLanguage("en");
  stored.set("directorlink.remote", JSON.stringify({ home: "ab".repeat(16), keyId: "0a1b2c3d" }));
  const view = await open();
  stored.delete("directorlink.remote");
  assert.equal(calls("GET", "/v1/users").length, 1);
  assert.equal(calls("GET", "/v1/api-keys").length, 0, "the users' answer has the devices");
  assert.match(textOf(byKey(view, "access-profile-aaaa0001")), /Dana.*Owner.*You.*Admin/);
  const noa = byKey(view, "access-profile-bbbb0003");
  assert.match(textOf(noa), /Member · 1 room/);
  assert.equal(textOf(byKey(view, "users-account-bbbb0003")), "No Google or Apple account: home network only");
  assert.equal(textOf(byKey(view, "users-account-aaaa0002")), "Google or Apple account");
  assert.match(textOf(byKey(view, "access-device-0a1b2c3f")), /Chrome on Android.*used/);
  assert.match(textOf(byKey(view, "access-device-0a1b2c40")), /not used yet/);
  assert.equal(byKey(view, "access-revoke-0a1b2c3d"), null, "this device: forgotten elsewhere, not removed here");
  assert.ok(byKey(view, "users-invite-bbbb0003"), "a user without an account can be invited");
  assert.equal(byKey(view, "users-invite-aaaa0002"), null);
  assert.doesNotMatch(textOf(view), /\bPeople\b|\bperson\b/, "users, never people");
  // Removing Noa's tablet: asked, then the key goes.
  await press(view, "access-revoke-0a1b2c40");
  assert.match(confirmed.at(-1), /Revoke the key of “Noa's tablet”/);
  assert.equal(calls("DELETE", "/v1/api-keys/0a1b2c40").length, 1);
});

test("a user's only device: removing it says the user goes with it", async () => {
  connect();
  setLanguage("en");
  await press(await open(), "access-revoke-0a1b2c3e");
  assert.match(confirmed.at(-1), /only device of Chrome on iPhone: Chrome on iPhone and their access go with it/);
});

test("a member sees only their own user, removes their other device, and is told how to add one", async () => {
  const mine = {
    device_limit: 5,
    accounts_known: true,
    items: [{ id: "bbbb0003", name: "Noa", created_at: "2026-09-03T08:00:00Z", you: true, access: { ...MEMBER }, accounts: 0, devices: [device("0a1b2c3f", "Chrome on Android", { current: true, removable: false, accounts: 0 }), device("0a1b2c40", "Noa's tablet", { accounts: 0 })] }],
    suggestions: [],
  };
  connect({ access: { ...MEMBER }, users: mine });
  setLanguage("en");
  const view = await open();
  assert.equal(calls("GET", "/v1/invitations").length, 0, "invitations are the admins'");
  assert.match(textOf(view), /Your devices/);
  assert.equal(byKey(view, "access-edit-bbbb0003"), null, "a member changes no access");
  assert.equal(byKey(view, "users-pair-bbbb0003"), null);
  assert.equal(byKey(view, "users-add-open"), null);
  assert.match(textOf(view), /Add my other device in Settings → Account/);
  assert.match(textOf(view), /ask an admin to invite your Google or Apple account/);
  await press(view, "access-revoke-0a1b2c40");
  assert.equal(calls("DELETE", "/v1/api-keys/0a1b2c40").length, 1);
  // The Settings row is theirs too.
  const settings = settingsView({});
  assert.ok(byKey(settings, "settings-row:access"), "Users is on the list for a member");
  assert.match(textOf(byKey(settings, "settings-row:access")), /Users.*Your devices/);
});

test("a sixth device: Remove a device first, with the list and Remove where allowed", async () => {
  connect();
  setLanguage("en");
  const view = await open();
  controller.refuse = {
    method: "POST",
    path: "/v1/pairing-code",
    status: 409,
    problem: {
      type: "about:blank", title: "Conflict", status: 409, code: "USER_DEVICE_LIMIT", detail: "Noa already has 5 devices: remove one of them first",
      limit: 5, user: { id: "bbbb0003", name: "Noa" },
      devices: [device("0a1b2c3f", "Chrome on Android"), device("0a1b2c41", "Old phone", { last_used_at: "2026-01-01T08:00:00Z" }), device("0a1b2c42", "Not mine", { removable: false })],
    },
  };
  await press(view, "users-pair-bbbb0003");
  const limited = accessView({});
  const panel = byKey(limited, "users-limit");
  assert.ok(panel, "the list instead of a sentence");
  assert.match(textOf(panel), /Noa already has 5 devices\. Remove one first:/);
  assert.ok(byKey(panel, "users-limit-remove-0a1b2c41"));
  assert.equal(byKey(panel, "users-limit-remove-0a1b2c42"), null, "only where the controller says the caller may");
  await press(limited, "users-limit-remove-0a1b2c41");
  assert.equal(calls("DELETE", "/v1/api-keys/0a1b2c41").length, 1);
  assert.match(textOf(accessView({})), /“Old phone” was removed\. Try again now\./);
  assert.equal(byKey(accessView({}), "users-limit"), null);
});

test("a pairing code for a user, and for a new user with a name and access", async () => {
  connect();
  setLanguage("en");
  await press(await open(), "users-pair-bbbb0003");
  assert.deepEqual(calls("POST", "/v1/pairing-code")[0].body, { profile_id: "bbbb0003" });
  let view = accessView({});
  assert.equal(textOf(byKey(view, "users-pairing-code")), "1234 5678");
  assert.match(textOf(byKey(view, "users-pairing")), /Pairing code for Noa.*joins this user/);
  await press(view, "users-pairing-close");
  assert.equal(calls("DELETE", "/v1/pairing-code").length, 1);
  assert.equal(byKey(accessView({}), "users-pairing"), null);
  // A new user (1.12.0: Add a user, a name and access, then the pairing code).
  await press(accessView({}), "users-add-open");
  view = accessView({});
  const name = byKey(view, "users-add-name");
  name.value = "Kitchen tablet";
  name.listeners.input[0]();
  byKey(view, "users-add-all-rooms").listeners.change[0]({ target: { checked: false } });
  byKey(accessView({}), "users-add-room-10").listeners.change[0]({ target: { checked: true } });
  await press(accessView({}), "users-add");
  await press(accessView({}), "users-add-code");
  const body = calls("POST", "/v1/pairing-code")[1].body;
  assert.equal(body.name, "Kitchen tablet");
  assert.equal(body.role, "member");
  assert.equal(body.all_rooms, false);
  assert.deepEqual(body.rooms, [10]);
  assert.match(textOf(byKey(accessView({}), "users-pairing")), /Pairing code for Kitchen tablet/);
});

test("devices of one account: the owner's access stays, and only the owner confirms", async () => {
  connect();
  setLanguage("en");
  let view = await open();
  const suggestion = byKey(view, "users-suggestion-3f9a1c2e7b4d5a60");
  assert.match(textOf(suggestion), /Dana, Chrome on iPhone: the same account, DirectorLink’s servers say/, "the servers' word, not a fact");
  assert.match(textOf(suggestion), /the owner’s access stays/);
  assert.equal(textOf(byKey(suggestion, "users-keep-role-3f9a1c2e7b4d5a60:aaaa0001")), "Owner");
  assert.equal(textOf(byKey(suggestion, "users-keep-role-3f9a1c2e7b4d5a60:aaaa0002")), "Admin");
  assert.ok("disabled" in byKey(suggestion, "users-keep-3f9a1c2e7b4d5a60:aaaa0002").attributes, "the owner's user stays");
  await press(view, "users-merge-3f9a1c2e7b4d5a60");
  assert.match(confirmed.at(-1), /one user with the access of Dana \(Admin\)\?/);
  assert.match(confirmed.at(-1), /then have Dana’s access, language, theme and favorites/, "what the moved devices take");
  assert.deepEqual(calls("POST", "/v1/users/merge")[0].body, { account: "3f9a1c2e7b4d5a60", keep: "aaaa0001", revision: "77aa77aa77aa77aa" }, "with what was shown");
  // Another admin, on the owner's other device of 1.8.0: who may confirm it, and where.
  const users = homeUsers();
  users.items[0].you = false;
  users.items[1].you = true;
  users.suggestions[0].may_confirm = false;
  connect({ access: { ...ADMIN }, users });
  view = await open();
  assert.equal(byKey(view, "users-merge-3f9a1c2e7b4d5a60"), null);
  assert.match(textOf(byKey(view, "users-suggestion-who-3f9a1c2e7b4d5a60")), /Only the home’s owner, Dana, can confirm this, on one of their devices: Chrome on Windows\./);
});

test("devices of one account between two members: the admin chooses whose access stays", async () => {
  const users = homeUsers();
  users.suggestions = [{ id: "1111222233334444", revision: "1234123412341234", owner: false, keep: null, may_confirm: true, users: [{ id: "bbbb0003", name: "Noa", role: "member", owner: false, devices: ["0a1b2c3f"], devices_after: 3 }, { id: "aaaa0002", name: "Chrome on iPhone", role: "member", owner: false, devices: ["0a1b2c3e"], devices_after: 7 }] }];
  connect({ users });
  setLanguage("en");
  const view = await open();
  assert.match(textOf(byKey(view, "users-suggestion-1111222233334444")), /Together 7 devices, at most 5/);
  assert.ok("disabled" in byKey(view, "users-merge-1111222233334444").attributes, "neither has less: nothing chosen yet");
  assert.match(textOf(byKey(view, "users-suggestion-choose-1111222233334444")), /neither has less than the other/);
  await press(view, "users-keep-1111222233334444:aaaa0002");
  assert.ok("disabled" in byKey(accessView({}), "users-merge-1111222233334444").attributes, "seven devices: remove some first");
  await press(accessView({}), "users-keep-1111222233334444:bbbb0003");
  await press(accessView({}), "users-merge-1111222233334444");
  assert.deepEqual(calls("POST", "/v1/users/merge").at(-1).body, { account: "1111222233334444", keep: "bbbb0003", revision: "1234123412341234" });
});

// The users review of 1.9.0 (finding 4): the suggestion says each user's role and offers the user
// with less access, never the admin over a member; the confirmation says what a device becomes.
test("an admin and a member of one account: the member's access is offered, and the confirm says so", async () => {
  const users = homeUsers();
  users.suggestions = [{ id: "5555666677778888", revision: "abcdabcdabcdabcd", owner: false, keep: "bbbb0003", may_confirm: true, users: [{ id: "aaaa0002", name: "Mum's iPad", role: "admin", owner: false, devices: ["0a1b2c3e"], devices_after: 2 }, { id: "bbbb0003", name: "Kid's phone", role: "member", owner: false, devices: ["0a1b2c3f"], devices_after: 3 }] }];
  connect({ users });
  setLanguage("en");
  const view = await open();
  assert.ok("checked" in byKey(view, "users-keep-5555666677778888:bbbb0003").attributes, "the member's access, offered");
  assert.ok(!("checked" in byKey(view, "users-keep-5555666677778888:aaaa0002").attributes), "never the admin's by default");
  assert.equal(textOf(byKey(view, "users-keep-role-5555666677778888:aaaa0002")), "Admin");
  assert.equal(textOf(byKey(view, "users-keep-role-5555666677778888:bbbb0003")), "Member");
  await press(view, "users-merge-5555666677778888");
  assert.match(confirmed.at(-1), /with the access of Kid's phone \(Member\)/);
  assert.match(confirmed.at(-1), /Their admin devices then have a member’s access, and the invitations those devices made are revoked\./);
  // Choosing the admin's: the confirm says the member's devices become an admin's.
  await press(accessView({}), "users-keep-5555666677778888:aaaa0002");
  await press(accessView({}), "users-merge-5555666677778888");
  assert.match(confirmed.at(-1), /The devices of Kid's phone become an admin’s: they can then do everything\./);
});

// The users review of 1.9.0 (finding 1): what the controller changed since the screen was drawn is
// not confirmed: it says so, and the screen is read again.
test("a suggestion that changed since it was shown is not confirmed", async () => {
  connect();
  setLanguage("en");
  const view = await open();
  controller.users.suggestions[0].revision = "0000111100001111";
  const before = calls("GET", "/v1/users").length;
  await press(view, "users-merge-3f9a1c2e7b4d5a60");
  assert.match(textOf(accessView({})), /These devices or their users changed since you looked, so nothing was moved/);
  assert.ok(calls("GET", "/v1/users").length > before, "read again");
});

test("an admin invites the account of a user paired at home: the invitation is for that user", async () => {
  connect();
  setLanguage("en");
  stored.set("directorlink.remote", JSON.stringify({ home: "ab".repeat(16), keyId: "0a1b2c3d" }));
  let view = await open();
  await press(view, "users-invite-bbbb0003");
  view = accessView({});
  const email = byKey(view, "users-invite-email-bbbb0003");
  email.value = "noa@example.com";
  email.listeners.input[0]();
  let form = null;
  walk(byKey(accessView({}), "access-profile-bbbb0003"), (node) => {
    if (!form && node.tagName === "FORM") form = node;
  });
  await Promise.all(form.listeners.submit.map((listener) => listener({ preventDefault() {} })));
  await settle();
  const sent = calls("POST", "/v1/invitations").at(-1).body;
  assert.equal(sent.profile_id, "bbbb0003");
  assert.equal(sent.email, "noa@example.com");
  assert.equal(sent.for_me, undefined);
  assert.match(textOf(byKey(accessView({}), "users-invitation-bbbb0003")), /Send this link to noa@example\.com\. The device that opens it joins Noa/);
  stored.delete("directorlink.remote");
});

test("a member adds their own other device in Settings → Account, and only that", async () => {
  connect({ access: { ...MEMBER } });
  setLanguage("en");
  stored.set("directorlink.remote", JSON.stringify({ home: "ab".repeat(16), keyId: "0a1b2c3f" }));
  state.account = { status: "signed-in", user: { email: "noa@example.com", providers: ["google"] }, notice: null, busy: false };
  let page = settingsView({ page: "account" });
  assert.ok(byKey(page, "add-device"), "Add my other device, for a member too");
  assert.equal(byKey(page, "invite"), null, "inviting others stays the admins'");
  // Five already: which to remove first.
  controller.refuse = {
    method: "POST",
    path: "/v1/invitations",
    status: 409,
    problem: { type: "about:blank", title: "Conflict", status: 409, code: "USER_DEVICE_LIMIT", limit: 5, user: { id: "bbbb0003", name: "Noa" }, devices: [device("0a1b2c40", "Noa's tablet")] },
  };
  await press(page, "add-device");
  page = settingsView({ page: "account" });
  assert.match(textOf(byKey(page, "home-limit")), /Noa already has 5 devices/);
  await press(page, "home-limit-remove-0a1b2c40");
  assert.equal(calls("DELETE", "/v1/api-keys/0a1b2c40").length, 1);
  await press(settingsView({ page: "account" }), "add-device");
  const sent = calls("POST", "/v1/invitations").at(-1).body;
  assert.equal(sent.for_me, true);
  stored.delete("directorlink.remote");
});

// The users review of 1.9.0 (finding 3): a member's other device joins only with the account this
// device already uses at the home; another email is refused, in the app's words.
test("a member's other device with another account is refused in the app's words", async () => {
  connect({ access: { ...MEMBER } });
  setLanguage("en");
  stored.set("directorlink.remote", JSON.stringify({ home: "ab".repeat(16), keyId: "0a1b2c3f" }));
  state.account = { status: "signed-in", user: { email: "noa@example.com", providers: ["google"] }, notice: null, busy: false };
  controller.refuse = {
    method: "POST",
    path: "/v1/invitations",
    status: 403,
    problem: { type: "about:blank", title: "Forbidden", status: 403, code: "ACCOUNT_NOT_OF_DEVICE", detail: "the controller's English" },
  };
  await press(settingsView({ page: "account" }), "add-device");
  assert.match(textOf(settingsView({ page: "account" })), /Your other device can join only with the Google or Apple account this device already uses for this home/);
  stored.delete("directorlink.remote");
});

test("with a controller before 1.9.0 the screen stays People and devices, for admins only", async () => {
  connect({ features: { people_permissions: true } });
  setLanguage("en");
  await open();
  assert.equal(calls("GET", "/v1/users").length, 0);
  assert.equal(calls("GET", "/v1/api-keys").length, 1);
  connect({ access: { ...MEMBER }, features: { people_permissions: true } });
  assert.equal(byKey(settingsView({}), "settings-row:access"), null, "a member of a 1.8.0 controller has no Users row");
});

test("every word of users is there in English and Hebrew, and neither says people", () => {
  const keys = (value, prefix = "") =>
    Object.entries(value).flatMap(([key, item]) => (item && typeof item === "object" && !("one" in item || "other" in item) ? keys(item, `${prefix}${key}.`) : [`${prefix}${key}`]));
  assert.deepEqual(keys(he.users).sort(), keys(en.users).sort());
  for (const key of ["users", "usersMine"]) {
    assert.ok(en.settings.rows[key] && he.settings.rows[key], key);
  }
  for (const key of ["pairing_code", "users_merged", "merge_suggested"]) {
    assert.ok(en.history.access[key] && he.history.access[key], key);
  }
  assert.equal(en.history.access.users_merged_auto, undefined, "nothing is merged by itself");
  // What people read: the strings, without their {placeholders}.
  const words = (...blocks) => blocks.flatMap((block) => (typeof block === "string" ? [block] : words(...Object.values(block)))).join(" ").replace(/\{\w+\}/g, "");
  assert.doesNotMatch(words(en.users, en.access, en.perm), /\bpeople\b|\bperson\b/i);
  assert.doesNotMatch(words(he.users, he.access, he.perm), /אנשים|אדם/);
});
