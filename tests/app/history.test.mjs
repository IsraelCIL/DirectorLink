// Settings → Controller → History (app/js/views/history.js, ADR-046): the link on the Controller
// page (admins), the page that lists GET /v1/activity newest first and by day, with an icon per kind,
// who and what in one line and how it went in plain words, the chips for the kinds, Load more, an
// older DirectorLink, the route for everyone else, and Hebrew.
//   node --test tests/app/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";

// What was given the keyboard (element.focus()).
const focused = [];
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
  dispatch(type) {
    const event = { type, currentTarget: this, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of this.listeners[type] || []) listener(event);
    return event;
  }
  append(...children) {
    this.children.push(...children);
  }
  focus(options) {
    focused.push({ key: this.dataset.key, options });
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.children = [Object.assign(new FakeNode(), { textContent: String(value) })];
  }
}
globalThis.Node = FakeNode;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/#/settings/history", pathname: "/", search: "", hash: "#/settings/history" };
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
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
globalThis.history = { state: null, back() {} };

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const { settingsView } = await import("../../app/js/views/settings.js");
const history = await import("../../app/js/views/history.js");

// What the screen holds.
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
function findAll(nodes, check) {
  const found = [];
  walk(nodes, (node) => node instanceof FakeElement && check(node) && found.push(node));
  return found;
}
const byKey = (nodes, key) => find(nodes, (node) => node.dataset.key === key);
const hasClass = (node, name) => typeof node.className === "string" && node.className.split(/\s+/).includes(name);
const byClass = (nodes, name) => findAll(nodes, (node) => hasClass(node, name));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const HOUR = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const dana = { type: "key", key_id: "a1b2c3d4", name: "Chrome on Windows", profile: "Dana" };

// One of each, as GET /v1/activity lists them, a minute apart.
const ENTRIES = [
  { id: 9, at: iso(NOW - 60 * 1000), kind: "scene", action: "run", who: dana, what: "Good night", outcome: "ran", counts: { ran: 12, skipped: 0, failed: 0 }, ids: { scene_id: "0badf00d" } },
  { id: 8, at: iso(NOW - 2 * 60 * 1000), kind: "door", action: "pulse", who: { type: "key", key_id: "b2c3d4e5", name: "Gate phone", remote: true }, what: "Main Door", room: "Entrance", ids: { device_id: 70, room_id: 99 } },
  {
    id: 7,
    at: iso(NOW - 3 * 60 * 1000),
    kind: "schedule",
    action: "run",
    who: { type: "schedule", schedule_id: "5c4ed01e", trigger: { type: "time", at: "06:45" }, days: [0, 1, 2, 3, 4, 5, 6] },
    what: "Morning AC",
    outcome: "skipped",
    reason: "shabbat",
    ids: { schedule_id: "5c4ed01e", scene_id: "0badf00d" },
  },
  { id: 6, at: iso(NOW - 4 * 60 * 1000), kind: "composer", action: "project", who: { type: "composer" }, changes: [{ change: "removed", type: "device", name: "UI Key - Status button", room: "סלון" }] },
  {
    id: 5,
    at: iso(NOW - 5 * 60 * 1000),
    kind: "composer",
    action: "project",
    who: { type: "composer" },
    changes: [
      { change: "renamed", type: "device", name: "Island", from: "Kitchen Island", room: "Kitchen" },
      { change: "moved", type: "device", name: "Kitchen Shutter", from: "Kitchen", room: "Living Room" },
    ],
    more: 3,
  },
  { id: 4, at: iso(NOW - 6 * 60 * 1000), kind: "schedule", action: "run", who: { type: "schedule", schedule_id: "5c4ed01f", trigger: { type: "sun", event: "sunset", offset: -30 }, days: [5, 6] }, what: "Porch", outcome: "failed", counts: { ran: 2, skipped: 0, failed: 1 } },
  { id: 3, at: iso(NOW - 7 * 60 * 1000), kind: "access", action: "role_changed", who: dana, what: "Kitchen tablet", from: "member", to: "doors" },
  { id: 2, at: iso(NOW - 8 * 60 * 1000), kind: "system", action: "remote_away", who: { type: "controller" }, seconds: 190 },
  { id: 1, at: iso(NOW - 9 * 60 * 1000), kind: "composer", action: "setting", who: { type: "composer" }, what: "Schedules", to: "Paused" },
];

// The controller: GET /v1/activity answers from `items` by kind, before and limit, as the driver
// does. It does not seal (as before 1.0.0): how requests travel does not matter here.
function controller({ items = ENTRIES, missing = false } = {}) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const address = new URL(url);
    asked.push(`${address.pathname}${address.search}`);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (address.pathname !== "/v1/activity" || missing) return reply(404, { status: 404, code: "NOT_FOUND" });
    const kinds = address.searchParams.get("kind")?.split(",");
    const before = Number(address.searchParams.get("before")) || Infinity;
    const limit = Number(address.searchParams.get("limit")) || 50;
    const matching = items.filter((item) => item.id < before && (!kinds || kinds.includes(item.kind)));
    const page = matching.slice(0, limit);
    return reply(200, { items: page, next_before: matching.length > limit ? page.at(-1).id : null });
  };
  return asked;
}

function home(role = "admin") {
  Object.assign(state, {
    host: "192.0.2.10",
    apiKey: "ak_test",
    transport: "lan",
    status: "connected",
    loaded: true,
    online: true,
    role,
    rooms: [{ id: 99, name: "Entrance", names: { he: "כניסה" } }],
    system: { bridge: { version: "1.6.0" }, features: { backup: true }, location: { timezone: "Asia/Jerusalem" } },
    account: { status: "signed-out", user: null, notice: null, busy: false },
  });
}

// Opens the page as app.js does (a fresh visit), and draws it once the controller answered.
async function open() {
  history.resetHistory();
  history.historyView();
  await settle();
  return history.historyView();
}

const items = (view) => byClass(view, "history-item");
// The text without the isolates around names (U+2066 to U+2069).
const plain = (text) => text?.replace(/[\u2066-\u2069]/g, "");
const line = (item) => plain(byClass(item, "history-line")[0]?.textContent);
const outcome = (item) => plain(byClass(item, "history-outcome")[0]?.textContent || "");

test("Settings → Controller links to History, for admins only", () => {
  home("admin");
  const page = settingsView({ page: "controller" });
  const link = byKey(page, history.HISTORY_ROW_KEY);
  assert.equal(link?.attributes.href, "#/settings/history");
  assert.match(link.textContent, /History/);
  assert.match(link.textContent, /Scenes, schedules, doors and changes in Composer/);
  for (const role of ["viewer", "member", "doors"]) {
    home(role);
    assert.equal(byKey(settingsView({ page: "controller" }), history.HISTORY_ROW_KEY), null, role);
  }
  // Not on Settings' list itself.
  home("admin");
  assert.equal(byKey(settingsView({}), history.HISTORY_ROW_KEY), null);
});

test("the route: admins get the page; anyone else Settings' list (a notification may open it)", () => {
  home("admin");
  assert.equal(history.historyAllowed(), true);
  home("member");
  assert.equal(history.historyAllowed(), false);
  state.role = null;
  assert.equal(history.historyAllowed(), true, "not known yet: the page waits for the controller");
  const app = readFileSync(new URL("../../app/app.js", import.meta.url), "utf8");
  assert.match(app, /parts\[0\] === "settings" && parts\[1\] === "history"[\s\S]*?return \{ name: "history", tab: "settings" \}/);
  assert.match(app, /case "history":\s*if \(historyAllowed\(\)\) return historyView\(actions\);\s*\/\/ falls through[^\n]*\n\s*case "settings":/);
  // Settings' list is what settingsView draws without a page.
  home("admin");
  assert.ok(byKey(settingsView({ page: undefined }), "settings-row:controller"));
  const sw = readFileSync(new URL("../../app/sw.js", import.meta.url), "utf8");
  assert.ok(sw.includes('"/js/views/history.js"'), "in the offline shell");
});

test("entries newest first, a section a day, an icon per kind, who and what in one line, how it went", async () => {
  home("admin");
  const asked = controller();
  const view = await open();
  assert.ok(asked.includes("/v1/activity?limit=50"), asked.join(" "));
  assert.equal(find(view, (node) => hasClass(node, "page-title")).textContent, "History");
  assert.equal(byKey(view, "back").attributes.href, "#/settings/controller");
  const rows = items(view);
  assert.equal(rows.length, ENTRIES.length);
  assert.deepEqual(rows.map((row) => row.dataset.key), ENTRIES.map((entry) => `history-${entry.id}`), "newest first");
  // One day here (all within the last 10 minutes), with its heading.
  const days = byClass(view, "history-day");
  assert.ok(days.length >= 1 && days.length <= 2);
  assert.match(byClass(days[0], "history-day-title")[0].textContent, /^(Today|Yesterday)$/);
  assert.equal(days[0].attributes["aria-labelledby"], byClass(days[0], "history-day-title")[0].attributes.id);

  assert.equal(line(rows[0]), "Ran the scene Good night, Dana · Chrome on Windows");
  assert.equal(outcome(rows[0]), "Ran on 12 devices");
  assert.ok(hasClass(rows[0], "is-ok"));
  assert.ok(byClass(rows[0], "history-icon-scene").length);
  assert.equal(line(rows[1]), "Opened Main Door (Entrance), Gate phone, away from home");
  assert.equal(line(rows[2]), "Didn’t run Morning AC, Schedule: Every day at 06:45");
  assert.equal(outcome(rows[2]), "Not run: it skips Shabbat and holidays", "skipped, and why, in plain words");
  assert.ok(hasClass(rows[2], "is-skipped"));
  assert.equal(line(rows[3]), "Removed UI Key - Status button (סלון), Composer", "one change: in the line itself");
  assert.ok(byClass(rows[3], "history-title")[0].textContent.includes("\u2068UI Key - Status button\u2069 (\u2068סלון\u2069)"), "the name and the room isolated");
  assert.equal(line(rows[4]), "5 changes in the project, Composer");
  assert.deepEqual(byClass(rows[4], "history-changes")[0].children.map((item) => plain(item.textContent)), [
    "Renamed Kitchen Island to Island",
    "Moved Kitchen Shutter from Kitchen to Living Room",
    "and 3 more",
  ]);
  assert.equal(line(rows[5]), "Couldn’t run Porch, Schedule: Fri–Sat, 30 min before sunset", "the schedule as Schedules says it");
  assert.equal(outcome(rows[5]), "1 of 3 devices didn’t respond");
  assert.ok(hasClass(rows[5], "is-failed"));
  assert.equal(line(rows[6]), "Changed Kitchen tablet from Member to Member + doors, Dana · Chrome on Windows");
  assert.equal(line(rows[7]), "Remote access was down for 3 min, DirectorLink");
  assert.equal(line(rows[8]), "Schedules set to Paused, Composer");
  // Names from Control4 keep their own direction; the time is the home's.
  assert.equal(byClass(rows[1], "history-title")[0].textContent, "Opened \u2068Main Door\u2069 (\u2068Entrance\u2069)", "the door's name and its room isolated");
  assert.ok(find(rows[0], (node) => node.tagName === "SPAN" && node.attributes.dir === "auto" && node.textContent === "Good night"), "the scene's name keeps its own direction");
  const time = find(rows[0], (node) => node.tagName === "TIME");
  assert.equal(time.attributes.datetime, ENTRIES[0].at);
  assert.match(time.textContent, /^\d\d:\d\d$/);
  assert.equal(find(rows[0], (node) => hasClass(node, "history-icon")).attributes["aria-hidden"], "true");
  assert.match(byClass(view, "history-status")[0].textContent, /That’s everything from the last 30 days/);
});

test("automatic backups to the account: made, or not and why", () => {
  const entry = (fields) => ({ id: 1, at: new Date().toISOString(), kind: "system", action: "cloud_backup", who: { type: "controller" }, ...fields });
  assert.equal(history.outcomeText(entry({ outcome: "ran" })), "");
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "remote_off" })), "Remote Access is off in Composer");
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "not_linked" })), "The home isn’t linked to an account");
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "too_large" })), "The backup is larger than the account keeps");
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "stopped" })), "Stopped: automatic backups were turned off or their password changed");
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "account_full" })), "No room in your account (25 MB for all your homes)");
  // The account's limit of backups a day: Back up now leaves the nightly backup its own.
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "limit" })), "Backed up too often today");
  assert.equal(
    history.outcomeText(entry({ outcome: "failed", reason: "limit", who: { type: "key", name: "Kitchen tablet" } })),
    "Backed up too often today; the nightly backup still runs"
  );
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "error" })), "Something went wrong; DirectorLink’s log says what");
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "SOMETHING_NEW" })), "Something went wrong; DirectorLink’s log says what");
  // "It tries again later" only when the controller says it will: a night's backup, before 06:00.
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "account_unreachable", note: "retry" })), "The account couldn’t be reached · It tries again later");
  assert.equal(history.outcomeText(entry({ outcome: "failed", reason: "account_unreachable" })), "The account couldn’t be reached");
  const backUpNow = entry({ outcome: "failed", reason: "account_unreachable", who: { type: "key", name: "Kitchen tablet" } });
  assert.doesNotMatch(history.outcomeText(backUpNow), /again/);
});

test("days: today, yesterday, then the date, in the home's time zone", () => {
  home("admin");
  const now = new Date("2026-10-03T09:00:00Z"); // 12:00 in Israel
  const days = history.groupByDay(
    [
      { id: 3, at: "2026-10-03T05:00:00Z" },
      { id: 2, at: "2026-10-02T20:59:00Z" }, // 23:59 on Friday in Israel
      { id: 1, at: "2026-10-01T22:30:00Z" }, // 01:30 on Friday in Israel
      { id: 0, at: "2026-09-30T10:00:00Z" },
    ],
    now
  );
  const wednesday = new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem" }).format(new Date("2026-09-30T10:00:00Z"));
  assert.deepEqual(days.map((day) => [day.title, day.items.map((item) => item.id)]), [
    ["Today", [3]],
    ["Yesterday", [2, 1]],
    [wednesday, [0]],
  ]);
});

test("chips ask for their kinds; Load more for the entries before the last one shown", async () => {
  home("admin");
  const many = Array.from({ length: 120 }, (_, index) => ({ ...ENTRIES[index % 2 ? 1 : 0], id: 120 - index, at: iso(NOW - index * 60 * 1000) }));
  const asked = controller({ items: many });
  let view = await open();
  assert.equal(items(view).length, 50);
  const chips = find(view, (node) => hasClass(node, "history-filters"));
  assert.equal(chips.attributes.role, "group");
  assert.equal(chips.attributes["aria-label"], "Show");
  assert.deepEqual(chips.children.map((chip) => chip.textContent), ["All", "Scenes and schedules", "Doors", "Changes in Composer", "Access"]);
  assert.equal(byKey(view, "history-filter:all").attributes["aria-pressed"], "true");

  byKey(view, "history-more").dispatch("click");
  await settle();
  view = history.historyView();
  assert.equal(items(view).length, 100);
  assert.ok(asked.includes("/v1/activity?limit=50&before=71"), asked.join(" "));
  byKey(view, "history-more").dispatch("click");
  await settle();
  view = history.historyView();
  assert.equal(items(view).length, 120);
  assert.equal(byKey(view, "history-more"), null, "nothing more");

  byKey(view, "history-filter:doors").dispatch("click");
  await settle();
  view = history.historyView();
  assert.ok(asked.includes("/v1/activity?limit=50&kind=door"));
  assert.equal(byKey(view, "history-filter:doors").attributes["aria-pressed"], "true");
  assert.ok(items(view).every((row) => byClass(row, "history-icon-door").length));
  byKey(view, "history-filter:automation").dispatch("click");
  await settle();
  assert.ok(asked.includes("/v1/activity?limit=50&kind=scene%2Cschedule"));
  byKey(history.historyView(), "history-filter:composer").dispatch("click");
  await settle();
  view = history.historyView();
  assert.ok(asked.includes("/v1/activity?limit=50&kind=composer"));
  assert.equal(items(view).length, 0);
  assert.match(byClass(view, "history-status")[0].textContent, /Nothing of this kind in the last 30 days/);
});

test("while open, what came since goes on top and the pages loaded stay", async () => {
  home("admin");
  const many = Array.from({ length: 60 }, (_, index) => ({ ...ENTRIES[0], id: 60 - index, at: iso(NOW - (index + 1) * 60 * 1000) }));
  const asked = controller({ items: many });
  let view = await open();
  byKey(view, "history-more").dispatch("click");
  await settle();
  assert.equal(items(history.historyView()).length, 60);
  many.unshift({ ...ENTRIES[1], id: 61, at: iso(NOW) });
  // 30 s later (the page's timer, or a redraw after it).
  ui.history = { ...ui.history, at: Date.now() - 31000 };
  const before = asked.length;
  history.historyView();
  history.historyView();
  await settle();
  assert.equal(asked.slice(before).filter((path) => path === "/v1/activity?limit=50").length, 1, "one read, however often it is drawn");
  view = history.historyView();
  const rows = items(view);
  assert.equal(rows.length, 61, "the new one on top, the 60 shown kept");
  assert.equal(rows[0].dataset.key, "history-61");
  assert.equal(byKey(view, "history-more"), null);
});

test("an older DirectorLink keeps no history: the page says to update it", async () => {
  home("admin");
  controller({ missing: true });
  const view = await open();
  assert.match(find(view, (node) => hasClass(node, "notice")).textContent, /History needs DirectorLink 1\.6\.0 or newer/);
  assert.equal(items(view).length, 0);
});

test("a failed read says so, with Retry", async () => {
  home("admin");
  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  history.resetHistory();
  history.historyView();
  // A read that got no answer is tried once more (api-client.js), for the probe and the request.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const view = history.historyView();
  const alert = find(view, (node) => node.attributes.role === "alert");
  assert.match(alert.textContent, /Couldn’t load the history/);
  assert.ok(byKey(view, "history-retry"));
});

test("a Hebrew name in the English page keeps its place: who, a door and its room, the scene it ran through", async () => {
  home("admin");
  const daily = { type: "schedule", schedule_id: "5c4ed01e", trigger: { type: "time", at: "07:00" }, days: [0, 1, 2, 3, 4, 5, 6] };
  controller({
    items: [
      { id: 2, at: iso(NOW - 60 * 1000), kind: "door", action: "pulse", who: { type: "key", key_id: "c3d4e5f6", name: "iPhone", profile: "דנה", remote: true }, what: "שער", room: "Garden", ids: { device_id: 71 } },
      { id: 1, at: iso(NOW - 2 * 60 * 1000), kind: "schedule", action: "run", who: daily, what: "Morning", outcome: "ran", counts: { ran: 3, skipped: 0, failed: 0 }, via: "יציאה (2)" },
    ],
  });
  const rows = items(await open());
  const who = byClass(rows[0], "history-who")[0];
  assert.equal(who.attributes.dir, undefined, "the line is in the page's language, not the first name's");
  assert.equal(who.textContent, "\u2068דנה\u2069 · \u2068iPhone\u2069, away from home");
  assert.equal(byClass(rows[0], "history-title")[0].textContent, "Opened \u2068שער\u2069 (\u2068Garden\u2069)");
  assert.equal(byClass(rows[1], "history-outcome")[0].textContent, "Ran on 3 devices · by the scene \u2068יציאה (2)\u2069");
});

test("Load more keeps the keyboard while it loads; after the last page, the first entry it brought has it", async () => {
  home("admin");
  const many = Array.from({ length: 70 }, (_, index) => ({ ...ENTRIES[0], id: 70 - index, at: iso(NOW - index * 60 * 1000) }));
  const asked = controller({ items: many });
  let drawn = await open();
  document.querySelector = (selector) => byKey(drawn, /data-key="([^"]+)"/.exec(selector)?.[1]);
  focused.length = 0;
  try {
    document.activeElement = byKey(drawn, "history-more");
    document.activeElement.dispatch("click");
    drawn = history.historyView();
    const button = byKey(drawn, "history-more");
    assert.equal(button.attributes["aria-disabled"], "true", "looks off while it loads");
    assert.equal("disabled" in button.attributes, false, "and stays focusable");
    button.dispatch("click");
    await settle();
    assert.equal(asked.filter((path) => path.includes("before=")).length, 1, "pressed again: nothing more asked");
    drawn = history.historyView();
    assert.equal(items(drawn).length, 70);
    assert.equal(byKey(drawn, "history-more"), null, "nothing more: Load more goes");
    await settle();
    assert.deepEqual(focused, [{ key: "history-20", options: { preventScroll: true } }], "the first entry the last page brought");
    assert.equal(byKey(drawn, "history-20").attributes.tabindex, "-1");
    assert.equal(byKey(drawn, "history-21").attributes.tabindex, undefined);
    history.historyView();
    await settle();
    assert.equal(focused.length, 1, "once");
  } finally {
    document.querySelector = () => null;
    delete document.activeElement;
  }
});

test("made a member on another device: the role changes at once, and Settings no longer links to History", async () => {
  const forbidden = () => new Response(JSON.stringify({ status: 403, code: "FORBIDDEN", detail: "This API key has the member role", role: "member", required_role: "admin" }), { status: 403, headers: { "Content-Type": "application/json" } });
  home("admin");
  globalThis.fetch = async () => forbidden();
  await open();
  assert.equal(state.role, "member");
  assert.equal(history.historyAllowed(), false, "app.js draws Settings instead");
  assert.equal(byKey(settingsView({ page: "controller" }), history.HISTORY_ROW_KEY), null);

  // The same when it happens on Load more.
  home("admin");
  const many = Array.from({ length: 60 }, (_, index) => ({ ...ENTRIES[0], id: 60 - index, at: iso(NOW - index * 60 * 1000) }));
  controller({ items: many });
  const view = await open();
  globalThis.fetch = async () => forbidden();
  byKey(view, "history-more").dispatch("click");
  await settle();
  assert.equal(state.role, "member");
});

test("in Hebrew", async () => {
  await setLanguage("he");
  try {
    home("admin");
    controller();
    const view = await open();
    const rows = items(view);
    assert.equal(find(view, (node) => hasClass(node, "page-title")).textContent, "היסטוריה");
    assert.equal(line(rows[0]), "הפעלת הסצנה Good night, Dana · Chrome on Windows");
    assert.equal(line(rows[1]), "פתיחת Main Door (כניסה), Gate phone, מחוץ לבית", "the room as the app names it in Hebrew");
    assert.equal(outcome(rows[2]), "לא הופעל: מדלג על שבתות וחגים");
    assert.equal(line(rows[3]), "הסרת UI Key - Status button (סלון), Composer");
    assert.equal(line(rows[4]), "5 שינויים בפרויקט, Composer");
    assert.equal(line(rows[6]), "שינוי ההרשאה של Kitchen tablet מ„חבר בית” ל„חבר בית + דלתות”, Dana · Chrome on Windows");
    assert.equal(line(rows[7]), "הגישה מרחוק נותקה למשך 3 דק׳, DirectorLink");
    // A duration in words, without a hyphen before it; Load more in full.
    controller({ items: Array.from({ length: 60 }, (_, index) => ({ ...ENTRIES[7], id: 60 - index, at: iso(NOW - index * 60 * 1000), seconds: 5400 })) });
    const more = await open();
    assert.equal(line(items(more)[0]), "הגישה מרחוק נותקה למשך שעה וחצי, DirectorLink");
    assert.equal(byKey(more, "history-more").textContent, "טעינת עוד");
    assert.deepEqual(find(view, (node) => hasClass(node, "history-filters")).children.map((chip) => chip.textContent), ["הכול", "סצנות ותזמונים", "דלתות", "שינויים ב-Composer", "גישה"]);
    home("admin");
    assert.match(byKey(settingsView({ page: "controller" }), history.HISTORY_ROW_KEY).textContent, /היסטוריה/);
  } finally {
    await setLanguage("en");
  }
});

test("a door or gate opened without DirectorLink is said to be Control4's (ADR-050)", async () => {
  home("admin");
  controller({ items: [{ id: 1, at: iso(NOW - 60 * 1000), kind: "door", action: "pulse", who: { type: "control4" }, what: "Main Door", room: "Entrance", ids: { device_id: 70, room_id: 99 } }] });
  const rows = items(await open());
  assert.equal(line(rows[0]), "Opened Main Door (Entrance), In Control4");
});

// A refrigerator door left open (1.7.0, ADR-049): a door entry DirectorLink noticed, with the
// refrigerator's icon, its name and its room.
test("a refrigerator door left open is listed under Doors, in both languages", async () => {
  const leftOpen = { id: 1, at: iso(NOW - 60 * 1000), kind: "door", action: "left_open", who: { type: "controller" }, what: "Refrigerator", room: "Entrance", ids: { device_id: 141, room_id: 99 } };
  home("admin");
  const asked = controller({ items: [leftOpen] });
  let view = await open();
  let row = items(view)[0];
  assert.equal(line(row), "The door of Refrigerator (Entrance) was left open, DirectorLink");
  assert.equal(outcome(row), "");
  assert.match(find(row, (node) => node.tagName === "SVG")?.innerHTML || "", /rect x="5.5" y="2.5"/, "the refrigerator's icon");
  byKey(view, "history-filter:doors").dispatch("click");
  await settle();
  assert.ok(asked.includes("/v1/activity?limit=50&kind=door"), asked.join(" "));
  assert.equal(items(history.historyView()).length, 1);
  await setLanguage("he");
  try {
    view = await open();
    row = items(view)[0];
    assert.equal(line(row), "הדלת של Refrigerator (כניסה) נשארה פתוחה, DirectorLink");
  } finally {
    await setLanguage("en");
  }
});

test("every string the page uses is in both languages", async () => {
  const { default: en } = await import("../../app/i18n/en.js");
  const { default: he } = await import("../../app/i18n/he.js");
  const keys = (node, prefix = "") =>
    Object.entries(node).flatMap(([key, value]) =>
      value && typeof value === "object" && !("other" in value) ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]
    );
  assert.deepEqual(keys(he.history).sort(), keys(en.history).sort());
  // The reasons and actions the API documents have words.
  const spec = readFileSync(new URL("../../api/openapi.yaml", import.meta.url), "utf8");
  const reasons = spec.match(/enum: \[(shabbat, paused[^\]]*)\]/)[1].split(", ");
  for (const reason of reasons) assert.ok(en.history.reason[reason], reason);
});

// The page's 30 s refresh does not keep the test running.
after(() => history.resetHistory());
