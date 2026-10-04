// Automatic backups to the account (1.6.0, ADR-048; app/js/cloud-backup.js with
// views/cloud-backup.js): the backup password's key pair, made here, and the driver's sealed
// backups opened with the password (tests/vectors/cloud_backup.json, which the driver reproduces);
// and Settings → Controller → Backup → Automatic backups: setting the password (only the public key
// goes to the controller), Back up now, the backups in the account, restoring one through the same
// check and preview as a file, changing the password and turning them off. Against a fake
// controller and a fake account service under fake time, with just enough of a browser.
//   node --test tests/app/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";

const VECTORS = JSON.parse(readFileSync(new URL("../vectors/cloud_backup.json", import.meta.url), "utf8"));

// ---- just enough of a browser ----------------------------------------------------------------
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
  append(...children) {
    this.children.push(...children);
  }
  remove() {}
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.children = [Object.assign(new FakeNode(), { textContent: String(value) })];
  }
}
globalThis.Node = FakeNode;
globalThis.window = globalThis;
window.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/", pathname: "/", search: "", hash: "" };
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.document = {
  hidden: false,
  documentElement: {},
  body: new FakeElement("body"),
  addEventListener() {},
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
const stored = new Map();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
    clear: () => stored.clear(),
  },
  configurable: true,
});
let confirmAnswer = true;
const confirmed = [];
window.confirm = (text) => {
  confirmed.push(text);
  return confirmAnswer;
};
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-10-03T08:00:00Z") });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 16);

// ---- the fake controller and account service ----------------------------------------------------
const HOST = "controller.invalid";
const KEY = "ak_test_auto_backup_key";
const HOME = "c".repeat(32);
const PREVIEW = {
  backup: { created_at: "2026-10-03T00:27:00Z", driver_version: "1.6.0", format_version: 1, home: "בית Home" },
  origin: { another_home: false, reasons: [], home_now: "בית Home", controller: "same" },
  counts: { keys: 1, profiles: 1, scenes: 0, schedules: 0, room_names: 0, room_order: 0, sonos_rooms: 1, scene_links: 2 },
  left_out: { scenes: 0, steps: 0, schedules: 0, profiles: 0 },
  keys: { action: "kept", count: 1, in_backup: 1, items: [], replaced: null, yours: "kept", conflict: false, expired: 0, left_out: 0, over_limit: false, limit: 20 },
  remote: { action: "same", home_id: HOME, current_home_id: HOME, remote_access: true, old_controller: false },
  references: { by_id: 1, by_name: [], renamed: [], unmatched: [{ kind: "room", id: 11, name: "Lounge", room: null, now: null, used_in: [{ section: "sonos_rooms", name: "Lounge Amp" }] }], unmatched_count: 1 },
  composer: [],
};
// The controller's automatic backups, and the account's.
const controller = { calls: [], status: null, runs: 0, old: false, runRefusal: null };
// adminsOnly: the account refuses the list (ADMINS_ONLY) until this device's key is told to it
// through the account (a sealed request: checkedIn), or for good ("always").
const account = { calls: [], items: [], data: new Map(), damaged: false, adminsOnly: false, checkedIn: false };

const offStatus = () => ({ enabled: false, key: null, time: null, running: false, last: null, remote: { enabled: true, connected: true, linked: true } });
const system = (old) => ({
  driver: { version: old ? "1.5.0" : "1.6.0" },
  features: old ? { jewish_calendar: false, alarm_status: false, backup: true, sonos: false } : { jewish_calendar: false, alarm_status: false, backup: true, sonos: false, automatic_backup: true },
});

function answer(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname: path } = new URL(url);
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  if (hostname === "api.directorlink.io") {
    account.calls.push({ method, path, raw: init.body || "" });
    return handleAccount(method, path);
  }
  if (hostname !== HOST) throw new TypeError(`blocked: ${url}`);
  controller.calls.push({ method, path, body, raw: init.body || "" });
  return handleController(method, path, body);
};

function handleAccount(method, path) {
  if (method === "GET" && path === "/v1/homes") return answer(200, { items: [{ home_id: HOME, owner: true, added_at: "2026-09-01T00:00:00Z", connected: true }] });
  if (method === "POST" && path === `/v1/homes/${HOME}/e2e`) {
    account.checkedIn = true;
    return answer(503, { status: 503, code: "HOME_OFFLINE" });
  }
  if (method === "GET" && path === `/v1/homes/${HOME}/backups`) {
    if (account.adminsOnly === "always" || (account.adminsOnly && !account.checkedIn)) return answer(403, { status: 403, code: "ADMINS_ONLY" });
    return answer(200, { items: account.items, keep: 7, max_bytes: 5000000 });
  }
  const one = new RegExp(`^/v1/homes/${HOME}/backups/([0-9a-f]{32})$`).exec(path);
  if (method === "GET" && one) {
    const item = account.items.find((entry) => entry.id === one[1]);
    if (item && account.damaged) return answer(500, { status: 500, code: "BACKUP_DAMAGED" });
    return item ? answer(200, { ...item, data: account.data.get(item.id) }) : answer(404, { status: 404, code: "NOT_FOUND" });
  }
  if (method === "DELETE" && path === `/v1/homes/${HOME}/backups`) {
    account.items = [];
    return answer(204);
  }
  return answer(404, { status: 404, code: "NOT_FOUND" });
}

function handleController(method, path, body) {
  if (path === "/v1/sealed") return answer(404, { status: 404, code: "NOT_FOUND" });
  if (path === "/v1/api-keys/current") return answer(200, { id: "0a1b2c3d", role: "admin" });
  if (method === "GET" && path === "/v1/system") return answer(200, system(controller.old));
  if (path === "/v1/backup/automatic") {
    if (method === "GET") return answer(200, controller.status);
    if (method === "PUT") {
      const keyId = Buffer.from(body.public_key, "base64").subarray(0, 8).toString("hex");
      controller.status = { ...controller.status, enabled: true, time: "03:27", key: { key_id: keyId, ...body, set_at: "2026-10-03T08:00:00Z" } };
      return answer(200, controller.status);
    }
    if (method === "DELETE") {
      controller.status = { ...controller.status, enabled: false, key: null, time: null };
      return answer(204);
    }
  }
  if (method === "POST" && path === "/v1/backup/automatic/run") {
    if (controller.runRefusal) return answer(409, { status: 409, code: controller.runRefusal, detail: "no" });
    controller.runs += 1;
    controller.status = { ...controller.status, running: true };
    return answer(202, { started: true, status: controller.status });
  }
  if (method === "POST" && path === "/v1/restore/parts") return answer(200, { upload: "0123456789abcdef", received: 1, count: body.count, complete: true });
  if (method === "POST" && path === "/v1/restore") return answer(200, { dry_run: body.dry_run !== false, restore: PREVIEW });
  if (method === "GET") return answer(200, { items: [] });
  return answer(404, { status: 404, code: "NOT_FOUND", detail: `no ${method} ${path}` });
}

const { state, ui, notify } = await import("../../app/js/state.js");
const session = await import("../../app/js/session.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const cpace = await import("../../app/js/cpace.js");
const cloud = await import("../../app/js/cloud-backup.js");
const { backupPanel } = await import("../../app/js/views/backup.js");
const { sizeText } = await import("../../app/js/views/cloud-backup.js");
const { saveRemote } = await import("../../app/js/remote.js");

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms, step = 250) {
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
function byKey(nodes, key) {
  let found = null;
  walk(nodes, (node) => {
    if (!found && node.dataset?.key === key) found = node;
  });
  return found;
}
const text = (node) => (node ? node.textContent : "");
const panelText = () => text(backupPanel());

async function fire(key, type, event = {}) {
  const element = byKey(backupPanel(), key);
  assert.ok(element, `no ${key} in the panel: ${panelText().slice(0, 300)}`);
  assert.equal(element.attributes.disabled, undefined, `${key} is disabled`);
  await Promise.all((element.listeners[type] || []).map((listener) => listener({ preventDefault() {}, stopPropagation() {}, ...event })));
  await settle();
}
const click = (key) => fire(key, "click");
const typeInto = (key, value) => fire(key, "input", { target: { value } });
async function submit(buttonKey) {
  let form = null;
  walk(backupPanel(), (node) => {
    if (!form && node.tagName === "FORM" && byKey(node, buttonKey)) form = node;
  });
  assert.ok(form, `no form with ${buttonKey}`);
  await Promise.all((form.listeners.submit || []).map((listener) => listener({ preventDefault() {} })));
  await settle();
}
const message = () => text(byKey(backupPanel(), "auto-backup-message"));

async function connect({ old = false, signedIn = true } = {}) {
  session.forgetKey();
  await advance(20000, 500);
  Object.assign(controller, { calls: [], status: offStatus(), runs: 0, old, runRefusal: null });
  Object.assign(account, { calls: [], items: [], data: new Map(), damaged: false, adminsOnly: false, checkedIn: false });
  confirmed.length = 0;
  confirmAnswer = true;
  Object.assign(state, { host: HOST, apiKey: KEY, role: "admin", status: "connected", loaded: true, system: system(old), notice: null, errors: {}, pending: {}, rooms: [], lights: [], thermostats: [], blinds: [], fans: [], cameras: [], relays: [], doorbells: [], devices: [], scenes: [] });
  state.account = { status: signedIn ? "signed-in" : "signed-out", user: signedIn ? { email: "dana@example.com", providers: ["google"] } : null, notice: null, busy: false };
  ui.backup = { stage: null };
  ui.autoBackup = null;
  notify();
  backupPanel();
  await advance(100);
}

const requests = (method, path) => controller.calls.filter((call) => call.method === method && call.path === path);

// ---- The key and the seal ---------------------------------------------------------------------------

test("the backup password makes the vectors' key, and opens the driver's sealed backup", async () => {
  const { key, seal } = VECTORS;
  const made = await cloud.makeBackupKey(key.password, { salt: Buffer.from(key.salt, "base64"), iterations: key.iterations });
  assert.deepEqual(made.body, { public_key: key.public_key, salt: key.salt, iterations: key.iterations, kdf: "PBKDF2-SHA-256" }, "only the public key, the salt and the iterations");
  assert.equal(made.keyId, key.key_id);
  const text = JSON.stringify(seal.sealed);
  const document = await cloud.openCloudBackup(text, key.password);
  assert.deepEqual(document, JSON.parse(seal.plaintext), "Hebrew included");
  // Where WebCrypto has no X25519, the ladder does the same.
  cpace.useLadder(true);
  try {
    assert.deepEqual(await cloud.openCloudBackup(text, key.password), document);
  } finally {
    cpace.useLadder(false);
  }
});

test("a wrong password, or a changed backup, does not open; nor does what is not one", async () => {
  const { key, seal } = VECTORS;
  const variant = (change) => {
    const copy = structuredClone(seal.sealed);
    change(copy);
    return JSON.stringify(copy);
  };
  await assert.rejects(cloud.openCloudBackup(JSON.stringify(seal.sealed), `${key.password}!`), { code: "WRONG_PASSWORD" });
  const ct = Buffer.from(seal.sealed.ct, "base64");
  ct[3] ^= 1;
  await assert.rejects(cloud.openCloudBackup(variant((copy) => (copy.ct = ct.toString("base64"))), key.password), { code: "WRONG_PASSWORD" });
  await assert.rejects(cloud.openCloudBackup(variant((copy) => (copy.key_id = "0".repeat(16))), key.password), { code: "WRONG_PASSWORD" }, "the MAC covers how to open it");
  await assert.rejects(cloud.openCloudBackup(variant((copy) => (copy.iterations = 1001)), key.password), { code: "WRONG_PASSWORD" });
  await assert.rejects(cloud.openCloudBackup(variant((copy) => (copy.version = 2)), key.password), { code: "NEWER_FILE" });
  await assert.rejects(cloud.openCloudBackup(variant((copy) => (copy.iterations = 1e9)), key.password), { code: "NOT_A_BACKUP" }, "not minutes of work");
  await assert.rejects(cloud.openCloudBackup(variant((copy) => (copy.cipher = "AES-128-ECB")), key.password), { code: "NOT_A_BACKUP" });
  await assert.rejects(cloud.openCloudBackup(variant((copy) => (copy.epk = Buffer.alloc(32).toString("base64"))), key.password), { code: "NOT_A_BACKUP" }, "a point of low order");
  await assert.rejects(cloud.openCloudBackup("not json", key.password), { code: "NOT_A_BACKUP" });
  await assert.rejects(cloud.openCloudBackup(JSON.stringify({ format: "directorlink-backup-file" }), key.password), { code: "NOT_A_BACKUP" });
});

// ---- Settings → Controller → Backup → Automatic backups ----------------------------------------------

test("the section shows with a 1.6.0 controller, and asks to sign in first", async () => {
  await setLanguage("en");
  await connect({ old: true });
  assert.equal(byKey(backupPanel(), "auto-backup"), null, "a DirectorLink before 1.6.0 has none");
  await connect({ signedIn: false });
  assert.ok(text(byKey(backupPanel(), "auto-backup-sign-in")).includes("Sign in"));
  assert.equal(requests("GET", "/v1/backup/automatic").length, 0);
  await connect();
  assert.ok(byKey(backupPanel(), "auto-backup-off"));
  assert.ok(text(byKey(backupPanel(), `auto-backup-list-${HOME}`)).includes("No backups in your account yet."));
});

test("setting the backup password sends the controller only its public key, then backs up", async () => {
  await connect();
  await click("auto-backup-set");
  assert.ok(panelText().includes("If you lose this password, these backups cannot be opened"), "said plainly before it is set");
  await typeInto("auto-backup-password", "short");
  await submit("auto-backup-save");
  assert.equal(message(), "Use at least 10 characters.");
  await typeInto("auto-backup-password", "lemon tree 42 bike");
  assert.ok(text(byKey(backupPanel(), "auto-backup-strength")).includes("strong"));
  await typeInto("auto-backup-confirm", "lemon tree 42 bikes");
  await submit("auto-backup-save");
  assert.equal(message(), "The two passwords are not the same.");
  assert.equal(requests("PUT", "/v1/backup/automatic").length, 0);
  await typeInto("auto-backup-confirm", "lemon tree 42 bike");
  await submit("auto-backup-save");
  const [put] = requests("PUT", "/v1/backup/automatic");
  assert.ok(put, "set");
  assert.deepEqual(Object.keys(put.body).sort(), ["iterations", "kdf", "public_key", "salt"]);
  assert.equal(put.body.iterations, 600000, "as many iterations as a backup file's");
  assert.equal(Buffer.from(put.body.public_key, "base64").length, 32);
  assert.equal(Buffer.from(put.body.salt, "base64").length, 16);
  for (const call of [...controller.calls, ...account.calls]) assert.ok(!call.raw.includes("lemon tree"), "the password never leaves the browser");
  // The same password and salt make the same key: the controller has what opens nothing.
  const again = await cloud.makeBackupKey("lemon tree 42 bike", { salt: Buffer.from(put.body.salt, "base64") });
  assert.equal(again.body.public_key, put.body.public_key);
  assert.equal(requests("POST", "/v1/backup/automatic/run").length, 1, "the first backup at once");
  assert.equal(message(), "Backup password set. The first backup is on its way.");

  // The controller makes it; the app asks until it is done, then reads the account's list.
  account.items = [{ id: "d".repeat(32), created_at: "2026-10-03T08:00:04Z", size: 174000, key_id: again.keyId }];
  controller.status = { ...controller.status, running: false, last: { at: "2026-10-03T08:00:04Z", ok: true, size: 174000, code: null, why: "now" } };
  await advance(3500);
  assert.equal(message(), "Backed up to your account.");
  assert.ok(text(byKey(backupPanel(), "auto-backup-on")).includes("about 03:27"));
  assert.ok(text(byKey(backupPanel(), "auto-backup-last")).includes("174 KB"));
  const item = text(byKey(backupPanel(), `auto-backup-item-${"d".repeat(32)}`));
  assert.ok(item.includes("174 KB") && !item.includes("earlier password"), item);
});

test("Back up now says why it cannot, and a backup that failed says why", async () => {
  await connect();
  controller.status = { ...offStatus(), enabled: true, time: "04:12", key: { key_id: "1".repeat(16) }, last: { at: "2026-10-03T01:12:00Z", ok: false, size: null, code: "NOT_CLAIMED", why: "daily" } };
  ui.autoBackup = null;
  backupPanel();
  await advance(100);
  assert.ok(text(byKey(backupPanel(), "auto-backup-last")).includes("not linked to an account"));
  controller.runRefusal = "REMOTE_OFFLINE";
  await click("auto-backup-now");
  assert.ok(message().includes("not connected to DirectorLink’s servers"));
  assert.ok(!message().includes("tries again"), "Back up now is not tried again");
});

test("why the last backup was not made: the account's limits, a stop, and a retry only at night", async () => {
  await connect();
  const lastLine = async (code, why) => {
    controller.status = { ...offStatus(), enabled: true, time: "04:12", key: { key_id: "1".repeat(16) }, last: { at: "2026-10-03T01:12:00Z", ok: false, size: null, code, why } };
    ui.autoBackup = null;
    backupPanel();
    await advance(100);
    return text(byKey(backupPanel(), "auto-backup-last"));
  };
  assert.match(await lastLine("BACKUP_LIMIT", "now"), /was not made: backed up too often today\. You can back up again tomorrow; the nightly backup still runs\.$/);
  assert.match(await lastLine("ACCOUNT_BACKUPS_FULL", "daily"), /was not made: no room in your account for this backup \(25 MB for all your homes together\)\. Delete another home’s backups, or download a backup file instead\.$/);
  assert.match(await lastLine("KEY_CHANGED", "now"), /was not made: it was stopped when the backup password changed\.$/);
  assert.match(await lastLine("AUTOMATIC_BACKUP_OFF", "daily"), /was not made: it was stopped when automatic backups were turned off\.$/);
  // Only the nightly backup is tried again.
  assert.match(await lastLine("REMOTE_OFFLINE", "daily"), /not connected to DirectorLink’s servers\. It tries again\.$/);
  assert.match(await lastLine("REMOTE_OFFLINE", "now"), /not connected to DirectorLink’s servers\.$/);
  // After Back up now, as the controller tells how it went.
  controller.status = { ...offStatus(), enabled: true, time: "04:12", key: { key_id: "1".repeat(16) } };
  ui.autoBackup = null;
  backupPanel();
  await advance(100);
  await click("auto-backup-now");
  controller.status = { ...controller.status, running: false, last: { at: "2026-10-03T08:00:04Z", ok: false, size: null, code: "BACKUP_LIMIT", why: "now" } };
  await advance(3500);
  assert.equal(message(), "The backup was not made: backed up too often today. You can back up again tomorrow; the nightly backup still runs.");
  await setLanguage("he");
  try {
    assert.match(await lastLine("KEY_CHANGED", "now"), /לא נעשה: הוא נעצר כי סיסמת הגיבוי שונתה\.$/);
    assert.match(await lastLine("REMOTE_OFFLINE", "now"), /DirectorLink\.$/);
    assert.match(await lastLine("REMOTE_OFFLINE", "daily"), /DirectorLink\. הוא ינסה שוב\.$/);
  } finally {
    await setLanguage("en");
  }
});

test("the account's backups of this device's home: its key told to the account and asked again, or said why not", async () => {
  await connect();
  saveRemote({ home: HOME, keyId: "0a1b2c3d" });
  try {
    account.items = [{ id: "9".repeat(32), created_at: "2026-10-03T00:27:00Z", size: 2000, key_id: "1".repeat(16) }];
    account.adminsOnly = true;
    const listed = () => account.calls.filter((call) => call.method === "GET" && call.path === `/v1/homes/${HOME}/backups`).length;
    const before = listed();
    ui.autoBackup = null;
    backupPanel();
    // The sealed request is made with WebCrypto, in real time.
    const read = async () => {
      for (let index = 0; index < 20000 && !ui.autoBackup?.loaded; index += 1) await new Promise((resolve) => setImmediate(resolve));
      await advance(100);
    };
    await read();
    assert.ok(account.checkedIn, "a sealed request through the account in between");
    assert.equal(listed() - before, 2, "asked once more");
    assert.ok(byKey(backupPanel(), `auto-backup-item-${"9".repeat(32)}`), "then listed");

    // Refused still: said, not hidden.
    account.adminsOnly = "always";
    ui.autoBackup = null;
    backupPanel();
    await read();
    assert.equal(text(byKey(backupPanel(), "auto-backup-admins-only")), "Only the home’s admins see its backups in the account.");
    assert.equal(byKey(backupPanel(), `auto-backup-delete-${HOME}`), null);
  } finally {
    localStorage.removeItem("directorlink.remote");
  }
});

test("a backup in the account is opened with its password and goes to the same check and preview", async () => {
  await connect();
  const { key, seal } = VECTORS;
  const id = "e".repeat(32);
  controller.status = { ...offStatus(), enabled: true, time: "03:27", key: { key_id: "f".repeat(16) } };
  account.items = [{ id, created_at: "2026-10-03T00:27:30Z", size: JSON.stringify(seal.sealed).length, key_id: key.key_id }];
  account.data.set(id, JSON.stringify(seal.sealed));
  ui.autoBackup = null;
  backupPanel();
  await advance(100);
  assert.ok(text(byKey(backupPanel(), `auto-backup-item-${id}`)).includes("earlier password"), "made with another backup password");
  await click(`auto-backup-restore-${id}`);
  assert.ok(panelText().includes("type the password it was made with"));
  await typeInto("auto-backup-open", "not the password");
  await submit("auto-backup-open-submit");
  assert.equal(message(), "Wrong password. Type the backup password this backup was made with.");
  assert.equal(requests("POST", "/v1/restore").length, 0, "nothing goes to the controller");
  await typeInto("auto-backup-open", key.password);
  await submit("auto-backup-open-submit");
  // The controller checks it, as a file's backup.
  const parts = requests("POST", "/v1/restore/parts");
  assert.deepEqual(JSON.parse(parts.map((call) => call.body.text).join("")), JSON.parse(seal.plaintext));
  assert.equal(requests("POST", "/v1/restore")[0].body.dry_run, undefined, "a check");
  assert.equal(ui.backup.stage, "preview");
  const preview = panelText();
  assert.ok(preview.includes("Sonos players with a room chosen"), "the Sonos rooms are in the preview");
  assert.ok(preview.includes("Scenes with a link for automations2"), "and the scene links (1.7.0)");
  assert.ok(preview.includes("the Sonos player “Lounge Amp”"), "and where a room that is gone was used");
  assert.ok(byKey(backupPanel(), "backup-replace"));
  for (const call of [...controller.calls, ...account.calls]) assert.ok(!call.raw.includes(key.password), "the password never leaves the browser");
});

test("a backup gone from the account since the list was read says so, and the list is read again", async () => {
  await connect();
  const { key, seal } = VECTORS;
  const [older, newer] = ["7".repeat(32), "8".repeat(32)];
  controller.status = { ...offStatus(), enabled: true, time: "03:27", key: { key_id: key.key_id } };
  account.items = [
    { id: newer, created_at: "2026-10-03T00:27:30Z", size: 100, key_id: key.key_id },
    { id: older, created_at: "2026-09-26T00:27:30Z", size: 100, key_id: key.key_id },
  ];
  account.data.set(newer, JSON.stringify(seal.sealed));
  ui.autoBackup = null;
  backupPanel();
  await advance(100);
  await click(`auto-backup-restore-${older}`);
  // The nightly backup pushed the oldest out meanwhile.
  account.items = account.items.slice(0, 1);
  const lists = () => account.calls.filter((call) => call.method === "GET" && call.path === `/v1/homes/${HOME}/backups`).length;
  const before = lists();
  await typeInto("auto-backup-open", key.password);
  await submit("auto-backup-open-submit");
  assert.equal(message(), "That backup is no longer in your account: a newer one may have replaced it. Choose one from the list.");
  assert.ok(!message().includes("Try again"));
  assert.equal(byKey(backupPanel(), "auto-backup-open"), null, "its form is closed");
  assert.equal(lists(), before + 1, "the list is read again");
  assert.equal(byKey(backupPanel(), `auto-backup-item-${older}`), null);
  assert.ok(byKey(backupPanel(), `auto-backup-item-${newer}`));
  assert.equal(requests("POST", "/v1/restore").length, 0);

  // Not whole in the account: said, and another one can be chosen.
  account.damaged = true;
  await click(`auto-backup-restore-${newer}`);
  await typeInto("auto-backup-open", key.password);
  await submit("auto-backup-open-submit");
  assert.equal(message(), "That backup is not whole in your account. Choose another one.");
  assert.ok(byKey(backupPanel(), `auto-backup-restore-${newer}`));
});

test("changing the password says older backups keep theirs; turning off asks first and keeps the account's", async () => {
  await connect();
  controller.status = { ...offStatus(), enabled: true, time: "03:27", key: { key_id: "1".repeat(16) } };
  account.items = [{ id: "a".repeat(32), created_at: "2026-10-02T00:27:00Z", size: 2000, key_id: "1".repeat(16) }];
  ui.autoBackup = null;
  backupPanel();
  await advance(100);
  await click("auto-backup-change");
  assert.ok(text(byKey(backupPanel(), "auto-backup-older")).includes("Backups made before keep their old password"));
  await click("auto-backup-cancel");
  confirmAnswer = false;
  await click("auto-backup-off-button");
  assert.equal(requests("DELETE", "/v1/backup/automatic").length, 0, "not without a yes");
  assert.ok(confirmed.at(-1).includes("stay until you delete them"));
  confirmAnswer = true;
  await click("auto-backup-off-button");
  assert.equal(requests("DELETE", "/v1/backup/automatic").length, 1);
  assert.ok(byKey(backupPanel(), "auto-backup-off"));
  assert.ok(byKey(backupPanel(), `auto-backup-item-${"a".repeat(32)}`), "the account's backups stay");
  await click(`auto-backup-delete-${HOME}`);
  assert.ok(confirmed.at(-1).includes("cannot be undone"));
  assert.equal(account.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.ok(text(byKey(backupPanel(), `auto-backup-list-${HOME}`)).includes("No backups in your account yet."));
});

test("a backup's size reads in KB or MB, and its password by the key's first bytes", async () => {
  await setLanguage("en");
  assert.equal(sizeText(400), "1 KB");
  assert.equal(sizeText(174000), "174 KB");
  assert.equal(sizeText(2_400_000), "2.4 MB");
  await setLanguage("he");
  assert.equal(sizeText(174000), "174 ק״ב");
  await setLanguage("en");
  assert.equal(cloud.keyIdOf(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), "0102030405060708");
});
