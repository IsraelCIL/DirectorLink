// Settings' list and its pages (app/js/views/settings.js, 1.5.0): a row per page (Appearance and
// language too since 1.10.0: tests/app/appearance.test.mjs; Alerts since 1.10.0, its signed-in lines
// in tests/app/alerts.test.mjs), who sees which row, the line each row says, the update badge, the Rooms
// page with its admin parts and the Sonos rooms, Back to the list (and the row it focuses),
// Settings → Controller with Updates and Backup, the Home notice that opens Settings → Controller at
// the steps, and sign-in coming back to Settings → Account.
//   node --test tests/app/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Just enough of a browser for these modules: the elements the views build (with their listeners,
// to press them), storage and frames.
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
  // Runs the listeners of `type` with a minimal event; returns the event.
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
// The update steps' section, as document.getElementById finds it after a redraw.
const revealed = [];
const stepsSection = {
  scrollIntoView: (options) => revealed.push(["scroll", options]),
  focus: (options) => revealed.push(["focus", options]),
};
const assigned = [];
globalThis.Node = FakeNode;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.location = {
  hostname: "app.directorlink.io",
  origin: "https://app.directorlink.io",
  href: "https://app.directorlink.io/#/settings",
  pathname: "/",
  search: "",
  hash: "#/settings",
  assign: (url) => assigned.push(url),
};
globalThis.document = {
  hidden: false,
  documentElement: {},
  body: { append() {} },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: (id) => (id === "settings-update" ? stepsSection : null),
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeNode(), { textContent: String(text) }),
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
const stored = new Map([["directorlink.providers", JSON.stringify(["google", "apple"])]]);
globalThis.localStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
// Nothing here reaches a server (the sign-in providers are asked again in the background).
globalThis.fetch = async () => {
  throw new TypeError("offline in this test");
};
globalThis.history = { state: null, back: () => assigned.push("history.back") };

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const { SETTINGS_PAGES, settingsRowKey, settingsView } = await import("../../app/js/views/settings.js");
const { accessView } = await import("../../app/js/views/access.js");
const { updateBanner } = await import("../../app/js/views/updates.js");
const { APP_VERSION } = await import("../../app/js/version.js");

// ---- what a screen holds -----------------------------------------------------------------------

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
const textOf = (nodes) => [nodes].flat(Infinity).filter(Boolean).map((node) => node.textContent).join(" | ");
function find(nodes, test) {
  let found = null;
  walk(nodes, (node) => {
    if (!found && node instanceof FakeElement && test(node)) found = node;
  });
  return found;
}
const byKey = (nodes, key) => find(nodes, (node) => node.dataset.key === key);
const byClass = (nodes, name) => find(nodes, (node) => typeof node.className === "string" && node.className.split(/\s+/).includes(name));
const ids = (nodes) => {
  const list = [];
  walk(nodes, (node) => node.attributes?.id && list.push(node.attributes.id));
  return list;
};
// The cards of a page, in order (their ids).
const cards = (page) => (page[2].children || []).filter(Boolean).map((card) => card.attributes.id);
// The rows on Settings' list, in order.
const rows = (list = settingsView({})) => keysOf(list).filter((key) => key.startsWith("settings-row:"));
// What a row says under its title.
const rowStatus = (page, list = settingsView({})) => byClass(byKey(list, `settings-row:${page}`), "settings-row-status")?.textContent ?? null;

// ---- the home ----------------------------------------------------------------------------------

const ROOMS = [
  { id: 10, name: "Kitchen", names: {} },
  { id: 11, name: "Living room", names: { he: "סלון" } },
];
const HOUR = 3600 * 1000;
const RELEASES = "https://github.com/DirectorLink/DirectorLink/releases";
const release = (version) => ({
  version,
  name: `DirectorLink v${version}`,
  publishedAt: "2026-10-01T08:00:00.000Z",
  url: `${RELEASES}/tag/v${version}`,
  download: `${RELEASES}/download/v${version}/DirectorLink.c4z`,
  checksums: `${RELEASES}/download/v${version}/SHA256SUMS.txt`,
  locked: true,
});
// The last answer from GitHub, as js/updates.js keeps it (an hour ago).
function lastCheck(latest) {
  const now = Date.now();
  localStorage.setItem("directorlink.update", JSON.stringify({ checkedAt: now - HOUR, answeredAt: now - HOUR, release: latest }));
}

// Connected on the home network with a `role` key to a DirectorLink 1.4.1 that has backups and the
// Jewish calendar on; this person hides nothing; signed out.
function home(role = "admin") {
  Object.assign(state, {
    host: "192.0.2.10",
    apiKey: "ak_test",
    transport: "lan",
    status: "connected",
    loaded: true,
    online: true,
    role,
    rooms: structuredClone(ROOMS),
    profile: { id: "p1", prefs: { hidden_rooms: [] } },
    system: { bridge: { version: "1.4.1" }, features: { backup: true, jewish_calendar: true } },
    calendar: { enabled: true, settings: { holidays: "israel", israel: true, candle_lighting_minutes: 20, havdalah_minutes: 42, version: 1 } },
    account: { status: "signed-out", user: null, notice: null, busy: false },
    offlineCopy: "ready",
    canInstall: false,
    lastUpdated: new Date(),
  });
  ui.calendarSettings = null;
  lastCheck(release("1.4.1"));
}

function notConnected() {
  Object.assign(state, { host: "", apiKey: "", status: "setup", loaded: false, role: null, rooms: [], profile: null, system: null, calendar: null });
}

// ---- the list ----------------------------------------------------------------------------------

test("Settings' list: one row per page; admins see three more", () => {
  home("admin");
  const list = settingsView({});
  assert.equal(list[0].tagName, "HEADER");
  assert.equal(byKey(list, "back"), null, "the list has no Back");
  assert.deepEqual(rows(list), [
    "settings-row:controller",
    "settings-row:rooms",
    "settings-row:calendar",
    "settings-row:access",
    "settings-row:account",
    "settings-row:alerts",
    "settings-row:appearance",
    "settings-row:app",
    "settings-row:about",
  ]);
  const keys = keysOf(list);
  // Everything is on its own page, the language, theme and colours too (1.10.0).
  for (const key of ["palette-graphite", "theme-auto", "language-he", "room-show:10", "room-move:10", "room-name:10:en", "settings-host", "settings-pair-again", "settings-forget", "update-check-now", "calendar-save", "backup-download", "account-sign-in", "alerts-sign-in", "alerts-switch", "notifications-on"]) {
    assert.ok(!keys.includes(key), `${key} is not on the list`);
  }
  assert.deepEqual(ids(list).filter((id) => id.startsWith("settings-")), []);
  // Each row opens its page; People and devices is #/access, as before.
  const hrefs = rows(list).map((key) => byKey(list, key).attributes.href);
  assert.deepEqual(hrefs, ["#/settings/controller", "#/settings/rooms", "#/settings/calendar", "#/access", "#/settings/account", "#/settings/alerts", "#/settings/appearance", "#/settings/app", "#/settings/about"]);
  for (const href of hrefs.filter((value) => value.startsWith("#/settings/"))) assert.ok(SETTINGS_PAGES.includes(href.slice("#/settings/".length)), href);
  // A link with an icon, a title, a line and a chevron.
  const row = byKey(list, "settings-row:rooms");
  assert.equal(row.tagName, "A");
  assert.ok(byClass(row, "settings-row-icon"));
  assert.match(row.children.at(-1).attributes.class, /settings-row-chevron/);
  assert.match(row.children.at(-1).attributes.class, /icon-directional/, "it points the other way in Hebrew");
  assert.equal(byClass(row, "settings-row-title").textContent, "Rooms");
  assert.equal(find(list, (node) => node.tagName === "NAV").attributes["aria-label"], "Settings pages");
});

test("members and viewers: no Shabbat and holidays, no People and devices", () => {
  for (const role of ["member", "doors", "viewer"]) {
    home(role);
    assert.deepEqual(rows(), ["settings-row:controller", "settings-row:rooms", "settings-row:account", "settings-row:appearance", "settings-row:app", "settings-row:about"], role);
  }
  // An admin with the calendar off in Composer (or a driver before 1.2.0): no calendar row.
  home("admin");
  state.system.features.jewish_calendar = false;
  assert.ok(!rows().includes("settings-row:calendar"));
  assert.ok(rows().includes("settings-row:access"));
  // Not paired yet: the pages that work without a controller.
  notConnected();
  assert.deepEqual(rows(), ["settings-row:controller", "settings-row:rooms", "settings-row:account", "settings-row:appearance", "settings-row:app", "settings-row:about"]);
});

test("each row says in one line how things are", async () => {
  home("member");
  assert.equal(rowStatus("rooms"), "2 rooms");
  state.profile.prefs.hidden_rooms = [11];
  assert.equal(rowStatus("rooms"), "2 rooms, 1 hidden");
  state.rooms = [...state.rooms, { id: 12, name: "Office" }];
  state.profile.prefs.hidden_rooms = [10, 12];
  assert.equal(rowStatus("rooms"), "3 rooms, 2 hidden");
  assert.equal(rowStatus("controller"), "Connected · DirectorLink 1.4.1", "a member: the connection and the version");
  state.transport = "remote";
  assert.equal(rowStatus("controller"), "Connected · via account · DirectorLink 1.4.1");
  state.status = "unreachable";
  assert.equal(rowStatus("controller"), "Can’t reach home · DirectorLink 1.4.1");
  assert.equal(rowStatus("account"), "Not signed in");
  state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
  assert.equal(rowStatus("account"), "Signed in as dana@example.com");
  state.account = { status: "loading", user: null, notice: null, busy: false };
  assert.equal(rowStatus("account"), "Loading…");
  state.account = { status: "unavailable", user: null, notice: null, busy: false };
  assert.equal(rowStatus("account"), "Can’t reach the account service");
  assert.equal(rowStatus("app"), "Ready — opens without internet");
  state.canInstall = true;
  assert.equal(rowStatus("app"), "Can be installed");
  assert.equal(rowStatus("about"), `Version ${APP_VERSION} · open source`);

  home("admin");
  assert.equal(rowStatus("controller"), "Connected · Up to date", "an admin: whether DirectorLink is up to date");
  assert.equal(rowStatus("calendar"), "Candles 20 min · havdalah 42 min");
  state.calendar.settings = { ...state.calendar.settings, holidays: "auto", candle_lighting_minutes: 30 };
  assert.equal(rowStatus("calendar"), "Candles 30 min · havdalah 42 min");
  assert.equal(rowStatus("access"), "Devices, invitations and users");
  // A driver of no known version (dev): what it is, without Updates.
  state.system.bridge.version = "dev";
  assert.equal(rowStatus("controller"), "Connected · DirectorLink dev");

  notConnected();
  assert.equal(rowStatus("rooms"), "Connect to your controller first");
  assert.equal(rowStatus("controller"), "Not connected");

  await setLanguage("he");
  try {
    home("member");
    state.profile.prefs.hidden_rooms = [11];
    assert.equal(rowStatus("rooms"), "2 חדרים, אחד מוסתר");
    assert.equal(rowStatus("about"), `גרסה ${APP_VERSION} · קוד פתוח`);
    assert.equal(byClass(byKey(settingsView({}), "settings-row:rooms"), "settings-row-title").textContent, "חדרים");
  } finally {
    await setLanguage("en");
  }
});

test("a newer DirectorLink: the Controller row has a badge and says so, for admins only", async () => {
  home("admin");
  const badge = () => byClass(byKey(settingsView({}), "settings-row:controller"), "settings-row-badge");
  assert.equal(badge(), null, "up to date: no badge");
  lastCheck(release("1.5.0"));
  assert.equal(badge().textContent, "Update");
  // The line says it too: screen readers hear it once.
  assert.equal(badge().attributes["aria-hidden"], "true");
  assert.equal(rowStatus("controller"), "DirectorLink 1.5.0 is available");
  await setLanguage("he");
  try {
    assert.equal(badge().textContent, "עדכון");
    assert.equal(rowStatus("controller"), "גרסה 1.5.0 של DirectorLink זמינה");
  } finally {
    await setLanguage("en");
  }
  state.role = "member";
  assert.equal(badge(), null, "a member is not told");
  assert.equal(rowStatus("controller"), "Connected · DirectorLink 1.4.1");
});

test("a signed-in admin at home, not linked yet: the list asks GET /v1/remote, for People and devices", async () => {
  const asked = [];
  const offline = globalThis.fetch;
  // A controller that does not seal (as before 1.0.0), with Remote Access on.
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/v1/sealed") return reply(404, { code: "NOT_FOUND" });
    if (path === "/v1/remote") return reply(200, { enabled: true, lock: true, home_id: "0123456789abcdef" });
    return reply(404, { code: "NOT_FOUND" });
  };
  try {
    // A member, or signed out: nothing is asked.
    home("member");
    state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
    state.remoteInfo = null;
    settingsView({});
    home("admin");
    settingsView({});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(asked, []);
    // As when Settings was one page (This home asked it): People and devices then finds the home.
    state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
    settingsView({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(asked.includes("/v1/remote"), asked.join(", "));
    assert.equal(state.remoteInfo?.home_id, "0123456789abcdef");
  } finally {
    globalThis.fetch = offline;
    state.remoteInfo = null;
  }
});

test("at home, This home says Update DirectorLink when the account service turned the controller's version away", async () => {
  const offline = globalThis.fetch;
  let remote = { enabled: true, connected: false, lock: true, home_id: "0123456789abcdef0123456789abcdef", update_required: true, minimum_version: "1.9.0" };
  const asked = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/v1/sealed") return reply(404, { code: "NOT_FOUND" });
    if (path === "/v1/remote") return reply(200, remote);
    return reply(404, { code: "NOT_FOUND" });
  };
  const notice = (page) => find(page, (node) => node.attributes.id === "account-home-update");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  try {
    // Not linked yet: the notice in place of Link this home (linking goes through remote access).
    home("admin");
    state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
    state.remoteInfo = null;
    settingsView({ page: "account" });
    await settle();
    let page = settingsView({ page: "account" });
    assert.equal(notice(page)?.textContent, "Update DirectorLink to 1.9.0 or later: the version on your controller can no longer connect to remote access, so your home can’t be reached away from it. Update it in Composer; at home the app works as before.");
    assert.equal(byKey(page, "link-home"), null);

    // Linked, a member too: the controller is asked, and says so; without a minimum, the plain words.
    localStorage.setItem("directorlink.remote", JSON.stringify({ home: remote.home_id, keyId: "0123abcd" }));
    home("member");
    state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
    state.remoteInfo = null;
    remote = { ...remote, minimum_version: null };
    asked.length = 0;
    settingsView({ page: "account" });
    await settle();
    assert.ok(asked.includes("/v1/remote"), asked.join(", "));
    page = settingsView({ page: "account" });
    assert.match(notice(page)?.textContent ?? "", /^Update DirectorLink: the version on your controller can no longer connect/);
    await setLanguage("he");
    try {
      assert.match(notice(settingsView({ page: "account" }))?.textContent ?? "", /^עדכנו את DirectorLink:/);
    } finally {
      await setLanguage("en");
    }

    // Updated (or a driver before 1.8.0, which does not say): no notice.
    remote = { enabled: true, connected: true, lock: true, home_id: remote.home_id };
    state.remoteInfo = null;
    settingsView({ page: "account" });
    await settle();
    assert.equal(notice(settingsView({ page: "account" })), null);
    // Through the account the controller is not asked (the account service says it there).
    state.transport = "remote";
    state.remoteInfo = null;
    asked.length = 0;
    settingsView({ page: "account" });
    await settle();
    assert.ok(!asked.includes("/v1/remote"), asked.join(", "));
  } finally {
    globalThis.fetch = offline;
    localStorage.removeItem("directorlink.remote");
    state.remoteInfo = null;
  }
});

// ---- the pages ---------------------------------------------------------------------------------

test("every page opens with its title and Back to Settings' list", () => {
  home("admin");
  const titles = { controller: "Controller", rooms: "Rooms", calendar: "Shabbat and holidays", account: "Account", alerts: "Alerts", appearance: "Appearance and language", app: "App", about: "About" };
  assert.deepEqual(Object.keys(titles).sort(), [...SETTINGS_PAGES].sort());
  for (const page of SETTINGS_PAGES) {
    const view = settingsView({ page });
    const back = byKey(view, "back");
    assert.equal(back?.attributes.href, "#/settings", `${page}: Back leads to the list`);
    assert.equal(byClass(view, "page-title").textContent, titles[page]);
    // Opening a page focuses its title (app.js); a redraw puts focus back by data-key, there and on
    // the connection chip.
    assert.equal(byClass(view, "page-title").dataset.key, "page-title");
    assert.equal(byClass(view, "status-chip").dataset.key, "status-chip");
    assert.equal(rows(view).length, 0, `${page}: no rows`);
  }
  // People and devices too (not loaded here, so that it does not start its 30 s refresh).
  state.loaded = false;
  assert.equal(byKey(accessView(), "back").attributes.href, "#/settings");
});

test("Back: in-app history goes back; the list then focuses the row that opened the page", () => {
  home("admin");
  const back = byKey(settingsView({ page: "rooms" }), "back");
  // Opened inside the app: the browser goes back (the list as it was).
  globalThis.history.state = { directorlinkInApp: true };
  assigned.length = 0;
  assert.ok(back.dispatch("click").defaultPrevented);
  assert.deepEqual(assigned, ["history.back"]);
  // Opened from a link (a bookmark, the Home screen): the link leads to the list.
  globalThis.history.state = null;
  assigned.length = 0;
  assert.ok(!back.dispatch("click").defaultPrevented);
  assert.deepEqual(assigned, []);
  // app.js focuses this row when the list follows one of its pages.
  const list = settingsView({});
  for (const page of SETTINGS_PAGES.filter((name) => name !== "calendar" || rows(list).includes("settings-row:calendar"))) {
    const key = settingsRowKey({ name: "settings", page, tab: "settings" });
    assert.ok(byKey(list, key), `${page}: ${key} is on the list`);
  }
  assert.equal(settingsRowKey({ name: "access", tab: "settings" }), "settings-row:access");
  assert.ok(byKey(list, "settings-row:access"));
  assert.equal(settingsRowKey({ name: "settings", page: null }), null, "the list itself: its title");
  assert.equal(settingsRowKey({ name: "home", tab: "home" }), null);
});

test("Settings → Rooms: show or hide for everyone; the order and the names for admins", () => {
  home("member");
  let page = settingsView({ page: "rooms" });
  assert.deepEqual(cards(page), ["settings-rooms", "settings-room-names"]);
  let keys = keysOf(page);
  for (const room of ROOMS) {
    assert.ok(keys.includes(`room-show:${room.id}`), "each person hides rooms for themselves");
    for (const admin of [`room-move:${room.id}`, `room-up:${room.id}`, `room-down:${room.id}`, `room-editor:${room.id}`, `room-name:${room.id}:en`, `room-save:${room.id}`]) {
      assert.ok(!keys.includes(admin), `not for a member: ${admin}`);
    }
  }
  assert.match(textOf(page), /Only an admin can rename rooms\. This device has Member access/);
  assert.match(textOf(page), /The order is the same for everyone in the home\./);

  home("admin");
  page = settingsView({ page: "rooms" });
  keys = keysOf(page);
  for (const room of ROOMS) {
    for (const key of [`room-show:${room.id}`, `room-move:${room.id}`, `room-up:${room.id}`, `room-down:${room.id}`, `room-editor:${room.id}`, `room-name:${room.id}:en`, `room-name:${room.id}:he`, `room-save:${room.id}`]) {
      assert.ok(keys.includes(key), key);
    }
  }
  assert.match(textOf(page), /drag a room by its handle/);
  assert.equal(byKey(page, "room-up:10").attributes["aria-disabled"], "true", "the first room's Up stays focusable");
  assert.equal(byKey(page, "room-move:10").attributes["aria-describedby"], "room-order-keys");
  assert.ok(ids(page).includes("room-order-keys"));
  assert.equal(byKey(page, "room-name:11:he").attributes.value, "סלון", "the names in every language");

  // A driver before 0.12.0 (no profiles): nothing to hide; it says to update.
  state.profile = null;
  page = settingsView({ page: "rooms" });
  assert.ok(!keysOf(page).some((key) => key.startsWith("room-show:")));
  assert.match(textOf(page), /Update DirectorLink on your controller to hide rooms/);

  notConnected();
  page = settingsView({ page: "rooms" });
  assert.deepEqual(cards(page), ["settings-rooms"]);
  assert.match(textOf(page), /Connect to your controller to rename rooms\./);
});

test("Settings → Rooms ends with the Sonos rooms, for admins when Sonos is on", () => {
  const sonos = {
    enabled: true,
    status: "ok",
    items: [
      { id: "RINCON_1", name: "Kitchen", room_id: 10, room_match: "name" },
      { id: "RINCON_2", name: "Patio", room_id: null, room_match: null },
    ],
  };
  home("admin");
  state.music = sonos;
  assert.deepEqual(cards(settingsView({ page: "rooms" })), ["settings-rooms", "settings-room-names"], "Sonos is off in Composer");

  state.system.features.sonos = true;
  let page = settingsView({ page: "rooms" });
  assert.deepEqual(cards(page), ["settings-rooms", "settings-room-names", "settings-music"]);
  const card = page[2].children.at(-1);
  assert.equal(card.attributes["aria-labelledby"], "settings-music-title");
  assert.ok(ids(card).includes("settings-music-title"));
  assert.match(textOf(card), /Sonos rooms/);
  assert.match(textOf(card), /1 Sonos room isn’t in a room yet\./);
  assert.ok(byKey(card, "music:RINCON_2:place"), "an admin picks its room");

  home("member");
  state.system.features.sonos = true;
  state.music = sonos;
  assert.deepEqual(cards(settingsView({ page: "rooms" })), ["settings-rooms", "settings-room-names"], "an admin's");
  state.music = null;
});

test("Settings → Controller: the controller, then Updates, then Backup for admins", () => {
  home("admin");
  let page = settingsView({ page: "controller", navigate() {} });
  // History (1.6.0, ADR-046) is a link to its own page, after the controller's card.
  assert.deepEqual(cards(page), ["settings-controller", "settings-history", "settings-updates", "settings-backup"]);
  let keys = keysOf(page);
  for (const key of ["settings-host", "settings-host-save", "settings-pair-again", "settings-forget", "update-check-now", "backup-download", "backup-restore"]) assert.ok(keys.includes(key), key);
  const labels = (card) => {
    const list = [];
    walk(card, (node) => node.tagName === "DT" && list.push(node.textContent));
    return list;
  };
  // Which way this device reaches its home (1.12.0): here the home network, at its address.
  assert.deepEqual(labels(page[2].children[0]), ["Status", "This device", "Access", "Last update"]);
  assert.match(textOf(page[2].children[0]), /This deviceOn the home network(?!,)/);
  assert.deepEqual(labels(page[2].children[2]), ["App version", "DirectorLink version", "Updates"]);
  assert.match(textOf(page[2].children[2]), new RegExp(`App version${APP_VERSION.replace(/\./g, "\\.")}`));
  // People and devices has its own row now.
  assert.ok(!keys.includes("settings-access"));

  home("member");
  page = settingsView({ page: "controller", navigate() {} });
  assert.deepEqual(cards(page), ["settings-controller", "settings-updates"]);
  keys = keysOf(page);
  assert.ok(!keys.includes("update-check-now") && !keys.includes("backup-download"), "members: no Check now, no Backup");
  assert.ok(keys.includes("settings-pair-again") && keys.includes("settings-forget"));
  assert.deepEqual(labels(page[2].children[1]), ["App version", "DirectorLink version"]);

  home("viewer");
  page = settingsView({ page: "controller", navigate() {} });
  assert.match(textOf(page), /View only: this device can see the home but not control it\./);
});

test("Settings → Alerts (1.10.0): a page of its own, its row before Appearance and language, for whoever may have them", async (context) => {
  // This browser has no push: its row and page say so first, signed in or not (1.10.0).
  home("admin");
  assert.equal(rowStatus("alerts"), "This browser can’t show alerts");
  assert.equal(byKey(settingsView({ page: "alerts" }), "alerts-hint").textContent, "This browser can’t show alerts.");
  assert.equal(byKey(settingsView({ page: "alerts" }), "alerts-sign-in"), null, "no sign-in that could not help");
  // A browser with push (and notifications, on a secure page) from here on.
  Object.assign(window, { isSecureContext: true, PushManager: function PushManager() {}, Notification: { permission: "default" } });
  Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
  context.after(() => {
    delete window.PushManager;
    delete window.Notification;
    delete navigator.serviceWorker;
  });
  // An admin: alerts with any controller (admins only before 1.7.0); signed out, the line says so.
  home("admin");
  let list = settingsView({});
  const second = rows(list).slice(-5);
  assert.deepEqual(second, ["settings-row:account", "settings-row:alerts", "settings-row:appearance", "settings-row:app", "settings-row:about"]);
  const row = byKey(list, "settings-row:alerts");
  assert.equal(row.attributes.href, "#/settings/alerts");
  assert.equal(byClass(row, "settings-row-title").textContent, "Alerts");
  assert.ok(byClass(row, "settings-row-icon").children.length, "its icon: the bell");
  assert.equal(rowStatus("alerts", list), "Sign in to get alerts");
  state.account = { status: "loading", user: null, notice: null, busy: false };
  assert.equal(rowStatus("alerts"), "Loading…");
  state.account = { status: "unavailable", user: null, notice: null, busy: false };
  assert.equal(rowStatus("alerts"), "Can’t reach the account service");
  // Signed in, on a device not linked to the home yet (the switch's own lines: alerts.test.mjs).
  state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
  assert.equal(rowStatus("alerts"), "Link this device to your account first");

  // A member: only with a controller that lets every key choose (DirectorLink 1.7.0), as the card.
  home("member");
  assert.ok(!rows().includes("settings-row:alerts"), "a member of a controller before 1.7.0 gets no alerts");
  state.system.features.alert_choices = true;
  assert.ok(rows().includes("settings-row:alerts"));
  assert.equal(rowStatus("alerts"), "Sign in to get alerts");
  home("viewer");
  state.system.features.alert_choices = true;
  assert.ok(rows().includes("settings-row:alerts"), "and a viewer");
  // Not paired yet: no key to have alerts with.
  notConnected();
  assert.ok(!rows().includes("settings-row:alerts"));

  // The page, signed out: alerts come through the account; signing in comes back to it.
  home("member");
  state.system.features.alert_choices = true;
  let page = settingsView({ page: "alerts" });
  assert.equal(byClass(page, "page-title").textContent, "Alerts");
  assert.equal(byKey(page, "back").attributes.href, "#/settings");
  assert.deepEqual(cards(page), ["settings-alerts"]);
  assert.equal(find(page, (node) => node.attributes.id === "settings-alerts-title").textContent, "On this device");
  assert.match(textOf(page), /Alerts come through your DirectorLink account: sign in, then switch them on for this device\./);
  assert.equal(byKey(page, "alerts-switch"), null, "no switch before signing in");
  assigned.length = 0;
  byKey(page, "alerts-sign-in").dispatch("click");
  byKey(page, "alerts-sign-in-apple").dispatch("click");
  assert.equal(assigned.length, 2);
  for (const url of assigned) assert.equal(new URL(url).searchParams.get("return_to"), "https://app.directorlink.io/#/settings/alerts");
  // A sign-in that came back without working says so here, where it began.
  state.account = { status: "signed-out", user: null, notice: "cancelled", busy: false };
  assert.match(textOf(settingsView({ page: "alerts" })), /Sign-in was cancelled\./);
  state.account = { status: "unavailable", user: null, notice: null, busy: false };
  page = settingsView({ page: "alerts" });
  assert.match(textOf(page), /Can’t reach DirectorLink’s account service right now\./);
  assert.ok(byKey(page, "alerts-account-retry"));
  // Signed in: the switch, as it was on Settings → Controller.
  state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
  page = settingsView({ page: "alerts" });
  assert.ok(byKey(page, "alerts-switch"));
  assert.equal(byKey(page, "alerts-sign-in"), null);
  assert.match(textOf(page), /Alerts on this device/);
  // Settings → Controller no longer has it.
  home("admin");
  state.system.features.alert_choices = true;
  state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
  page = settingsView({ page: "controller", navigate() {} });
  assert.ok(!cards(page).includes("settings-alerts"));
  assert.equal(byKey(page, "alerts-switch"), null);
  assert.ok(!textOf(page).includes("Alerts on this device"));

  // Opened by its address by someone who may not have them: why; before connecting, what every
  // page says then.
  home("member");
  page = settingsView({ page: "alerts" });
  assert.equal(byKey(page, "alerts-admins").textContent, "Only the home’s admins get alerts.");
  notConnected();
  assert.match(textOf(settingsView({ page: "alerts" })), /Not connected yet/);

  // Back from the page focuses its row (app.js).
  home("admin");
  assert.equal(settingsRowKey({ name: "settings", page: "alerts", tab: "settings" }), "settings-row:alerts");

  await setLanguage("he");
  try {
    list = settingsView({});
    assert.equal(byClass(byKey(list, "settings-row:alerts"), "settings-row-title").textContent, "התראות");
    assert.equal(rowStatus("alerts", list), "התחברו כדי לקבל התראות");
    assert.equal(byClass(settingsView({ page: "alerts" }), "page-title").textContent, "התראות");
  } finally {
    await setLanguage("en");
  }
});

test("only Settings → Controller is redrawn by every poll (its Last update), so the other pages keep focus", () => {
  home("admin");
  // The only page that shows when the controller was last read.
  for (const page of SETTINGS_PAGES) {
    const shown = textOf(settingsView({ page, navigate() {} })).includes("Last update");
    assert.equal(shown, page === "controller", page);
  }
  assert.ok(!textOf(settingsView({})).includes("Last update"), "nor the list");
  // app.js redraws when its signature changes: state.lastUpdated, new at every poll, counts on
  // that page only.
  const app = readFileSync(new URL("../../app/app.js", import.meta.url), "utf8");
  const signature = app.slice(app.indexOf("function signature()"), app.indexOf("function screen()"));
  const lines = signature.split("\n").filter((line) => line.includes("state.lastUpdated"));
  assert.deepEqual(
    lines.map((line) => line.trim()),
    ['route.name === "settings" && route.page === "controller" ? state.lastUpdated?.getTime() : 0,']
  );
});

test("the Home notice opens Settings → Controller at the steps", async () => {
  home("admin");
  lastCheck(release("1.5.0"));
  const link = byClass(updateBanner(), "banner-update-link");
  assert.equal(link.attributes.href, "#/settings/controller");
  // Opened in another tab: nothing to bring into view here.
  link.dispatch("click", { ctrlKey: true });
  settingsView({ page: "controller", navigate() {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(revealed, []);
  // Followed: the list (if drawn first) leaves the steps for the page, which brings them into view.
  link.dispatch("click", {});
  settingsView({});
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(revealed, [], "not on the list");
  const page = settingsView({ page: "controller", navigate() {} });
  assert.ok(ids(page).includes("settings-update"), "the steps are on the page");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(revealed, [["scroll", { block: "center" }], ["focus", { preventScroll: true }]]);
  // Once.
  revealed.length = 0;
  settingsView({ page: "controller", navigate() {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(revealed, []);
});

test("Settings → Account, App and About keep their cards; signing in comes back to Account", () => {
  home("member");
  let page = settingsView({ page: "account" });
  assert.deepEqual(cards(page), ["settings-account"]);
  assigned.length = 0;
  byKey(page, "account-sign-in").dispatch("click");
  byKey(page, "account-sign-in-apple").dispatch("click");
  assert.equal(assigned.length, 2);
  for (const url of assigned) {
    assert.equal(new URL(url).searchParams.get("return_to"), "https://app.directorlink.io/#/settings/account");
  }
  // Signed in: adding Apple comes back here too.
  state.account = { status: "signed-in", user: { email: "dana@example.com", providers: ["google"] }, notice: null, busy: false };
  assigned.length = 0;
  byKey(settingsView({ page: "account" }), "account-add-apple").dispatch("click");
  assert.equal(new URL(assigned[0]).searchParams.get("return_to"), "https://app.directorlink.io/#/settings/account");
  assert.equal(new URL(assigned[0]).searchParams.get("link"), "1");

  state.canInstall = true;
  page = settingsView({ page: "app" });
  assert.deepEqual(cards(page), ["settings-app"]);
  assert.ok(ids(page).includes("offline-status") && keysOf(page).includes("install"));
  page = settingsView({ page: "about" });
  assert.deepEqual(cards(page), ["settings-about"]);
  assert.ok(find(page, (node) => node.attributes.href === "https://github.directorlink.io"));
});
