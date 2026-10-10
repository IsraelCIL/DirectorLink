// iPhone and iPad join in the Home Screen app (1.12.0, ADR-083; app/js/views/join.js, move.js,
// device-join.js, home-screen.js, and session.js's clientName): an invitation's link opened in
// Safari recommends the Home Screen app first (copy the link, add DirectorLink to the Home Screen,
// paste it there in Join with an invitation), and joins here only when asked; the joined device
// says whom it joined as, from the home's sealed answer; a Safari tab that joined moves its place to
// the Home Screen app with a move invitation, and says it moved once its key is gone; and devices
// are named so that Safari and the Home Screen app tell apart. Against a fake account service and a
// fake controller behind it, in a small fake DOM.
//   node --test tests/app/

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { beforeEach, mock } from "node:test";

import { deriveLock, invitationLock, open, seal } from "../../app/js/lock.js";

const HOME = "0123456789abcdef0123456789abcdef";
const KEY_ID = "0a1b2c3d";
const SAFARI_KEY = `ak_${"1".repeat(48)}`;
const NEW_KEY = `ak_${"2".repeat(48)}`;
const EMAIL = "dana@example.com";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

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
  focus() {}
  getContext() {
    return { fillRect() {}, fillStyle: "" };
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}

const documentListeners = {};
globalThis.Node = FakeNode;
globalThis.window = globalThis;
window.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", pathname: "/", search: "", hash: "#/" };
window.addEventListener = () => {};
window.removeEventListener = () => {};
let standalone = false;
window.matchMedia = (query) => ({ matches: standalone && query.includes("standalone"), addEventListener() {}, removeEventListener() {} });
globalThis.history = { state: null, replaceState() {} };
globalThis.document = {
  hidden: false,
  documentElement: {},
  body: {},
  addEventListener: (type, listener) => (documentListeners[type] ||= []).push(listener),
  removeEventListener() {},
  querySelector: () => null,
  getElementById: () => null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeNode(), { textContent: String(text) }),
};
const clipboard = { written: null, text: null };
Object.defineProperty(globalThis, "navigator", {
  value: {
    userAgent: SAFARI,
    maxTouchPoints: 5,
    languages: ["en"],
    language: "en",
    onLine: true,
    clipboard: {
      writeText: async (text) => {
        clipboard.written = text;
      },
      readText: async () => clipboard.text ?? "",
    },
  },
  configurable: true,
});
const storage = () => {
  const stored = new Map();
  return {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  };
};
Object.defineProperty(globalThis, "localStorage", { value: storage(), configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
window.confirm = () => true;
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
beforeEach(async () => {
  const until = Date.now() + 100;
  while (Date.now() < until) {
    mock.timers.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

// ---- the account service and the controller behind it ------------------------------------------

const cloud = { calls: [], invitations: new Map(), revoked: false, joinAnswer: null, deleted: [] };
const ok = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status, code) => ok({ status, code, detail: code }, status);

// The Safari tab's requests, sealed with its key; once revoked, the account service says the home
// does not know it (UNKNOWN_KEY), as the relay does.
async function controller(envelope) {
  if (cloud.revoked) return null;
  const lock = await deriveLock(SAFARI_KEY);
  const plaintext = await open(lock, envelope, "req");
  if (!plaintext) return undefined;
  const request = JSON.parse(plaintext);
  let status = 200;
  let body = { items: [] };
  if (request.method === "POST" && request.path === "/v1/invitations") {
    const id = randomBytes(4).toString("hex");
    const secret = randomBytes(32).toString("hex");
    cloud.invitations.set(id, { secret, body: request.body });
    status = 201;
    body = { id, secret, role: request.body.role, for_me: true, move: request.body.move, home_id: HOME, expires_at: new Date(Date.now() + request.body.expires_in * 1000).toISOString(), registered: true, email: request.body.email };
  } else if (request.method === "DELETE" && request.path.startsWith("/v1/invitations/")) {
    cloud.deleted.push(request.path.split("/").pop());
    status = 204;
  } else if (request.path === "/v1/api-keys/current") {
    body = { id: KEY_ID, name: "Safari on iPhone", role: "member", profile_id: "p1" };
  }
  const answer = { id: request.id, ts: Math.floor(Date.now() / 1000), status, content_type: "application/json", body: status === 204 ? "" : JSON.stringify(body) };
  return { envelope: await seal(lock, { home: HOME, key: KEY_ID }, "res", JSON.stringify(answer)) };
}

async function join(input) {
  const invitation = cloud.invitations.get(input.invitation_id);
  if (!invitation) return problem(404, "INVITATION_NOT_FOUND");
  const lock = await invitationLock(invitation.secret);
  const request = JSON.parse(await open(lock, input.envelope, "req"));
  cloud.invitations.delete(input.invitation_id);
  cloud.joined = { invitation: input.invitation_id, name: request.body.name };
  const body = cloud.joinAnswer ?? { key: NEW_KEY, id: "0e0e0e0e", name: request.body.name, role: "member", user: { id: "p2", name: "Dana" }, home_name: "Cohen Home" };
  const answer = { id: request.id, ts: Math.floor(Date.now() / 1000), status: 201, content_type: "application/json", body: JSON.stringify(body) };
  return ok({ home_id: HOME, envelope: await seal(lock, { home: HOME, key: input.invitation_id }, "res", JSON.stringify(answer)), member: true });
}

globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname } = new URL(url);
  if (hostname !== "api.directorlink.io") throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  const input = init.body ? JSON.parse(init.body) : null;
  cloud.calls.push({ method, path: pathname, body: input });
  if (pathname === `/v1/homes/${HOME}/e2e`) {
    const answer = await controller(input.envelope);
    if (answer === null) return problem(403, "UNKNOWN_KEY");
    return answer ? ok(answer) : problem(503, "HOME_OFFLINE");
  }
  if (pathname === "/v1/join") return join(input);
  if (pathname === "/v1/homes") return ok({ items: [] });
  return problem(404, "NOT_FOUND");
};

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const { saveRemote } = await import("../../app/js/remote.js");
const { clientName } = await import("../../app/js/session.js");
const { joinView, joinedNotice } = await import("../../app/js/views/join.js");
const { movePanel, movedNotice } = await import("../../app/js/views/move.js");
const { settingsView } = await import("../../app/js/views/settings.js");
const { connectScreen } = await import("../../app/js/views/connect.js");
const { deviceLabel } = await import("../../app/js/views/device-join.js");

// ---- helpers -----------------------------------------------------------------------------------

function walk(node, visit) {
  for (const item of [node].flat(Infinity)) {
    if (!item) continue;
    visit(item);
    walk(item.children || [], visit);
  }
}
function byKey(node, key) {
  let found = null;
  walk(node, (item) => {
    if (!found && item.dataset?.key === key) found = item;
  });
  return found;
}
const textOf = (nodes) => [nodes].flat(Infinity).filter(Boolean).map((node) => node.textContent).join(" | ");
function click(element) {
  assert.ok(element, "the button is there");
  for (const listener of element.listeners.click || []) listener({ type: "click", preventDefault() {} });
}
async function until(check, what) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    mock.timers.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const signedIn = () => {
  state.account = { status: "signed-in", user: { id: "u1", email: EMAIL }, notice: null, busy: false };
};
const TOKEN = () => {
  const id = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("hex");
  cloud.invitations.set(id, { secret, body: { role: "member" } });
  return `${HOME}.${id}.${secret}`;
};

// The Safari tab that joined: its key, linked to the home through the account, a member.
function safariTab({ names = true } = {}) {
  Object.assign(state, {
    apiKey: SAFARI_KEY,
    host: "",
    role: "member",
    loaded: true,
    status: "connected",
    transport: "remote",
    profile: { id: "p1", name: "Dana", prefs: {} },
    system: { bridge: { version: "1.12.0" }, features: { users: true, people_permissions: true, user_names: names } },
  });
  localStorage.setItem("directorlink.apiKey", SAFARI_KEY);
  saveRemote({ home: HOME, keyId: KEY_ID });
  signedIn();
}

setLanguage("en");

// ---- device names ------------------------------------------------------------------------------

test("Safari and the Home Screen app have names that tell them apart", () => {
  const cases = [
    [SAFARI, 5, false, "Safari on iPhone"],
    [SAFARI, 5, true, "DirectorLink app on iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", 5, false, "Safari on iPad"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", 5, true, "DirectorLink app on iPad"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36", 5, false, "Samsung Internet on Android"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36", 5, true, "DirectorLink app on Android"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36", 0, false, "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36", 0, true, "DirectorLink app on Windows"],
  ];
  for (const [agent, touch, installed, name] of cases) {
    navigator.userAgent = agent;
    navigator.maxTouchPoints = touch;
    standalone = installed;
    assert.equal(clientName(), name, `${agent} ${installed ? "installed" : "in the browser"}`);
    assert.equal(deviceLabel(), name, "the label a device that asks to join shows");
  }
  navigator.userAgent = SAFARI;
  navigator.maxTouchPoints = 5;
  standalone = false;
});

// ---- the join page ------------------------------------------------------------------------------

test("in Safari the join page recommends the Home Screen app, and joins here only when asked", async () => {
  standalone = false;
  signedIn();
  Object.assign(state, { apiKey: "", loaded: false });
  const token = TOKEN();
  sessionStorage.setItem("directorlink.join", token);
  ui.joinHere = false;
  ui.joinWait = null;
  let page = joinView({ navigate: () => {} });
  const advice = byKey(page, "join-home-screen");
  assert.ok(advice, "the Home Screen app first");
  assert.match(textOf(advice), /Join in the Home Screen app/);
  assert.match(textOf(byKey(advice, "join-steps")), /Tap Copy link\..*Tap Share, then Add to Home Screen\..*Open DirectorLink from your Home Screen, sign in, tap Join with an invitation and paste the link\./);
  assert.equal(byKey(page, "join-accept"), null, "no Accept before choosing Safari");
  click(byKey(page, "join-copy"));
  await until(() => clipboard.written, "the link copied");
  assert.equal(clipboard.written, `https://app.directorlink.io/#/join/${token}`);
  page = joinView({ navigate: () => {} });
  assert.match(textOf(page), /Link copied\. Now open DirectorLink from your Home Screen\./);
  assert.equal(textOf(byKey(page, "join-here")), "Join here in Safari");
  click(byKey(page, "join-here"));
  assert.ok(byKey(joinView({ navigate: () => {} }), "join-accept"), "Accept, in Safari");
  // Another browser on iPhone says so.
  ui.joinHere = false;
  navigator.userAgent = SAFARI.replace("Version/18.0", "CriOS/129.0");
  assert.equal(textOf(byKey(joinView({ navigate: () => {} }), "join-here")), "Join here in this browser");
  navigator.userAgent = SAFARI;
  // The Home Screen app joins at once.
  standalone = true;
  ui.joinHere = false;
  page = joinView({ navigate: () => {} });
  assert.equal(byKey(page, "join-home-screen"), null);
  assert.ok(byKey(page, "join-accept"));
  standalone = false;
  sessionStorage.removeItem("directorlink.join");
});

test("the joined device says whom it joined as, from the home's sealed answer", async () => {
  standalone = true;
  signedIn();
  Object.assign(state, { apiKey: "", loaded: false, status: "setup" });
  const token = TOKEN();
  sessionStorage.setItem("directorlink.join", token);
  ui.joinWait = null;
  ui.joined = null;
  cloud.joinAnswer = null;
  click(byKey(joinView({ navigate: () => {} }), "join-accept"));
  await until(() => state.apiKey === NEW_KEY, "the new key");
  assert.equal(cloud.joined.name, "DirectorLink app on iPhone", "the Home Screen app names itself");
  const notice = joinedNotice();
  assert.equal(textOf(byKey(notice, "joined")).replace("Done", ""), "You joined Cohen Home as Dana.");
  click(byKey(notice, "joined-done"));
  assert.equal(joinedNotice(), null);
  // A controller before 1.12.0 says neither: nothing is said.
  const again = TOKEN();
  sessionStorage.setItem("directorlink.join", again);
  state.apiKey = "";
  cloud.joinAnswer = { key: `ak_${"3".repeat(48)}`, id: "0f0f0f0f", role: "member" };
  click(byKey(joinView({ navigate: () => {} }), "join-accept"));
  await until(() => state.apiKey === `ak_${"3".repeat(48)}`, "the key");
  assert.equal(joinedNotice(), null);
  cloud.joinAnswer = null;
  standalone = false;
});

// ---- Move to the Home Screen app ---------------------------------------------------------------

test("Move to the Home Screen app: a move invitation, its steps, and Moved once the key is gone", async () => {
  standalone = false;
  cloud.revoked = false;
  safariTab();
  localStorage.removeItem("directorlink.move");
  const account = settingsView({ page: "account" });
  const panel = byKey(account, "move");
  assert.ok(panel, "on Settings → Account");
  assert.match(textOf(panel), /In the app on your Home Screen, alerts work/);
  click(byKey(panel, "move-start"));
  await until(() => byKey(movePanel(), "move-copy"), "the link");
  const made = cloud.calls.map((call) => call).filter((call) => call.path.endsWith("/e2e"));
  assert.ok(made.length >= 1);
  const [[id, invitation]] = [...cloud.invitations.entries()].slice(-1);
  assert.deepEqual(invitation.body, { role: "member", expires_in: 600, for_me: true, move: true, email: EMAIL });
  const shown = movePanel();
  assert.match(textOf(byKey(shown, "move-steps")), /sign in as dana@example\.com, tap Join with an invitation and paste the link/);
  assert.match(textOf(shown), /The link works once, until/);
  click(byKey(shown, "move-copy"));
  await until(() => clipboard.written?.includes(id), "copied");
  assert.equal(clipboard.written, `https://app.directorlink.io/#/join/${HOME}.${id}.${invitation.secret}`);
  assert.equal(JSON.parse(localStorage.getItem("directorlink.move")).invitation, id);
  // The Home Screen app joined and used its key: the controller revoked this tab's. Back in Safari,
  // the tab asks, forgets its key, and says it moved.
  cloud.revoked = true;
  for (const listener of documentListeners.visibilitychange || []) listener();
  await until(() => !state.apiKey, "the key forgotten");
  const notice = movedNotice();
  assert.equal(textOf(notice), "Moved to the Home Screen app. Open DirectorLink from your Home Screen.");
  assert.ok(byKey(connectScreen(), "moved"), "on the Connect screen");
  cloud.revoked = false;
});

test("a move can be cancelled, and is offered only to a Safari tab of a 1.12.0 controller", async () => {
  standalone = false;
  cloud.revoked = false;
  safariTab();
  localStorage.removeItem("directorlink.move");
  click(byKey(movePanel(), "move-start"));
  await until(() => byKey(movePanel(), "move-cancel"), "the link");
  const id = JSON.parse(localStorage.getItem("directorlink.move")).invitation;
  click(byKey(movePanel(), "move-cancel"));
  await until(() => cloud.deleted.includes(id), "the invitation revoked");
  assert.equal(localStorage.getItem("directorlink.move"), null);
  assert.match(textOf(movePanel()), /The move was cancelled\. This tab keeps working\./);
  assert.equal(movedNotice(), null, "this tab has its key");
  // The Home Screen app, and a controller before 1.12.0, are not offered it.
  standalone = true;
  assert.equal(movePanel(), null);
  standalone = false;
  safariTab({ names: false });
  assert.equal(movePanel(), null);
});
