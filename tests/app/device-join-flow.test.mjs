// Joining from another device in the app (app/js/views/device-join.js, ADR-053): the new device's
// part on the Connect screen, a device that reaches the home seeing the request, both showing the
// same code, Approve making a for-me invitation at the controller (as Add my other device does) and
// sealing it, and the new device joining with it; Decline; an account service before 1.7.0; and
// Paste invitation link with and without the clipboard. The approving device types the code the new
// device shows (a wrong one approves nothing; three decline the request), asks only once its role is
// known, looks for requests every 60 s, and keeps the invitation when Approve's answer is lost but
// the cloud took it; a key saved another way withdraws the request. Both devices run in this one page, against
// a fake account service that keeps the requests as cloud/src/device-requests.js does and a fake
// controller behind it. Rendered into a small fake DOM, with timers under the test's control.
//   node --test tests/app/

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { beforeEach, mock } from "node:test";

import { deriveLock, invitationLock, open, seal } from "../../app/js/lock.js";

const HOME = "0123456789abcdef0123456789abcdef";
const KEY_ID = "0a1b2c3d";
const ADMIN_KEY = `ak_${"1".repeat(48)}`;
const EMAIL = "dana@example.com";

// ---- just enough of a browser ------------------------------------------------------------------

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
  focus() {}
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}

const windowListeners = {};
globalThis.Node = FakeNode;
globalThis.window = globalThis;
window.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", pathname: "/", search: "", hash: "#/" };
window.addEventListener = (type, listener) => (windowListeners[type] ||= []).push(listener);
window.removeEventListener = () => {};
let standalone = false;
window.matchMedia = (query) => ({ matches: standalone && query.includes("standalone"), addEventListener() {}, removeEventListener() {} });
globalThis.history = { state: null, replaceState() {} };
globalThis.document = {
  hidden: false,
  documentElement: {},
  body: {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: () => null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeNode(), { textContent: String(text) }),
};
const clipboard = { text: null, refuse: false, read: 0 };
Object.defineProperty(globalThis, "navigator", {
  value: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    maxTouchPoints: 5,
    languages: ["en"],
    language: "en",
    onLine: true,
    clipboard: {
      readText: async () => {
        clipboard.read += 1;
        if (clipboard.refuse) throw Object.assign(new Error("Not allowed"), { name: "NotAllowedError" });
        return clipboard.text ?? "";
      },
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
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
// The tests share one page. Before each, what the last one left running (an answer on its way,
// WebCrypto work, a timer set for now) has a moment to finish, so that it lands in its own test.
beforeEach(async () => {
  const until = Date.now() + 200;
  while (Date.now() < until) {
    mock.timers.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

// ---- the account service and the controller behind it ------------------------------------------

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const cloud = {
  offers: true, // GET /v1/me's device_requests (an account service before 1.7.0 has none)
  refuseStart: null, // a problem code the next start gets
  swapKey: null, // a key the account service shows in place of the new device's (a dishonest one)
  requests: new Map(),
  calls: [],
  invitations: new Map(), // made at the controller: id -> { secret, body }
  revoked: 0, // invitations revoked at the controller
  dropApproveAnswer: false, // Approve reaches the cloud, but its answer is lost on the way back
  joined: [],
};
const ok = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status, code) => ok({ status, code, detail: code }, status);
function view(item) {
  const { sealed, ...rest } = item;
  return { ...rest, status: sealed ? "approved" : item.device_key ? "checking" : item.approver_key ? "answered" : "waiting" };
}

async function controller(envelope) {
  const lock = await deriveLock(ADMIN_KEY);
  const plaintext = await open(lock, envelope, "req");
  // The new device, once joined, connects: this controller has gone quiet for it.
  if (!plaintext) return null;
  const request = JSON.parse(plaintext);
  let status = 200;
  let body = {};
  if (request.method === "POST" && request.path === "/v1/invitations") {
    const id = randomBytes(4).toString("hex");
    const secret = randomBytes(32).toString("hex");
    cloud.invitations.set(id, { secret, body: request.body });
    status = 201;
    body = { id, secret, role: request.body.role, home_id: HOME, expires_at: new Date(Date.now() + request.body.expires_in * 1000).toISOString(), registered: true, email: request.body.email };
  }
  if (request.method === "DELETE" && request.path.startsWith("/v1/invitations/")) {
    cloud.revoked += 1;
    cloud.invitations.delete(request.path.split("/").pop());
    status = 204;
  }
  const answer = { id: request.id, ts: Math.floor(Date.now() / 1000), status, content_type: "application/json", body: JSON.stringify(body) };
  return { envelope: await seal(lock, { home: HOME, key: KEY_ID }, "res", JSON.stringify(answer)) };
}

async function join(input) {
  const invitation = cloud.invitations.get(input.invitation_id);
  if (!invitation) return problem(404, "INVITATION_NOT_FOUND");
  const lock = await invitationLock(invitation.secret);
  const request = JSON.parse(await open(lock, input.envelope, "req"));
  cloud.invitations.delete(input.invitation_id);
  cloud.joined.push({ invitation: input.invitation_id, name: request.body.name });
  const answer = { id: request.id, ts: Math.floor(Date.now() / 1000), status: 201, content_type: "application/json", body: JSON.stringify({ key: `ak_${"2".repeat(48)}`, id: "0e0e0e0e", role: "admin" }) };
  return ok({ home_id: HOME, envelope: await seal(lock, { home: HOME, key: input.invitation_id }, "res", JSON.stringify(answer)), member: true });
}

globalThis.fetch = async (url, init = {}) => {
  const { hostname, pathname } = new URL(url);
  if (hostname !== "api.directorlink.io") throw new TypeError(`blocked: ${url}`);
  const method = init.method || "GET";
  const input = init.body ? JSON.parse(init.body) : null;
  cloud.calls.push({ method, path: pathname, body: input });
  if (pathname === "/v1/homes" && method === "GET") return ok({ items: [{ home_id: HOME, owner: true, added_at: "2026-09-28T10:00:00.000Z", connected: true }] });
  if (pathname === `/v1/homes/${HOME}/e2e`) {
    const answer = await controller(input.envelope);
    return answer ? ok(answer) : problem(503, "HOME_OFFLINE");
  }
  if (pathname === "/v1/join") return join(input);
  const base = `/v1/homes/${HOME}/device-requests`;
  if (!pathname.startsWith(base)) return problem(404, "NOT_FOUND");
  if (!cloud.offers) return problem(404, "NOT_FOUND");
  if (pathname === base && method === "POST") {
    if (cloud.refuseStart) return problem(409, cloud.refuseStart);
    const id = randomBytes(16).toString("hex");
    const item = { id, home_id: HOME, label: input.label, commitment: input.commitment, approver_key: null, device_key: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() };
    cloud.requests.set(id, item);
    return ok(view(item), 201);
  }
  // A dishonest account service shows the approving device its own key in the new device's place.
  if (pathname === base) return ok({ items: [...cloud.requests.values()].map((item) => ({ ...view(item), device_key: item.device_key && cloud.swapKey ? cloud.swapKey : item.device_key })) });
  const [, id, action] = pathname.slice(base.length).split("/");
  const item = cloud.requests.get(id);
  if (!item) return problem(404, "NOT_FOUND");
  if (!action && method === "GET") return ok(view(item));
  if (!action && method === "DELETE") {
    cloud.requests.delete(id);
    return ok(null, 204);
  }
  if (action === "answer") {
    if (item.approver_key && item.approver_key !== input.approver_key) return problem(409, "ALREADY_ANSWERED");
    item.approver_key = input.approver_key;
    return ok(view(item));
  }
  if (action === "key") {
    if (!item.approver_key) return problem(409, "NOT_ANSWERED");
    if (sha256(`DirectorLink device join v1|commit|${input.device_key}`) !== item.commitment) return problem(400, "COMMITMENT_MISMATCH");
    item.device_key = input.device_key;
    return ok(view(item));
  }
  if (action === "approve") {
    item.sealed = input.sealed;
    if (cloud.dropApproveAnswer) throw new TypeError("network connection lost");
    return ok(view(item));
  }
  if (action === "collect") {
    if (!item.sealed) return problem(409, "NOT_APPROVED");
    cloud.requests.delete(id);
    return ok({ sealed: item.sealed, approver_key: item.approver_key });
  }
  return problem(404, "NOT_FOUND");
};

const { state, ui } = await import("../../app/js/state.js");
const { saveRemote } = await import("../../app/js/remote.js");
const { deviceRequestNotice, joinFromAnotherDevice, pasteInvitationPanel, watchDeviceRequests } = await import("../../app/js/views/device-join.js");
const { joinView } = await import("../../app/js/views/join.js");

// ---- helpers -----------------------------------------------------------------------------------

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
function byKey(node, key) {
  let found = null;
  walk(node, (item) => {
    if (!found && item.dataset?.key === key) found = item;
  });
  return found;
}
function byKeyStart(node, prefix) {
  let found = null;
  walk(node, (item) => {
    if (!found && item.dataset?.key?.startsWith(prefix)) found = item;
  });
  return found;
}
// The element when it can be pressed: not disabled (the approving device disables its buttons
// while one of its actions finishes, and ignores a press then).
const enabled = (element) => (element && !("disabled" in element.attributes) ? element : null);

function click(element) {
  assert.ok(element, "the button is there");
  for (const listener of element.listeners.click || []) listener({ type: "click", preventDefault() {} });
}

// Lets the page's requests, its WebCrypto work and what follows them run (real time, not timers),
// and the timers it sets for "now" (a list or a look asked for at once), without moving the clock.
async function until(check, what) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    mock.timers.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// Ticks the page's timers by `ms` until `check` holds: a timer the page sets after a tick (it was
// still busy, say with its WebCrypto work, on a slow or loaded machine) fires at the next one.
async function untilTicking(ms, check, what) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await tick(ms);
    if (await check()) return;
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function tick(ms) {
  mock.timers.tick(ms);
  for (let index = 0; index < 50; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const signedIn = (offers = true) => {
  state.account = { status: "signed-in", user: { id: "u1", email: EMAIL, device_requests: offers || undefined }, notice: null, busy: false };
};

// The device that reaches the home: an admin key, linked to the home, through the account.
function approverDevice() {
  Object.assign(state, { apiKey: ADMIN_KEY, role: "admin", loaded: true, status: "connected", transport: "remote", profile: { id: "p1" } });
  saveRemote({ home: HOME, keyId: KEY_ID });
}

// Types `code` in the request's field on the approving device and submits it (Approve, or Enter).
async function typeCode(request, code) {
  await until(() => enabled(byKey(deviceRequestNotice(), `device-request-approve-${request.id}`)), "Approve enabled");
  const notice = deviceRequestNotice();
  const field = byKey(notice, `device-request-code-${request.id}`);
  assert.ok(field, "the field for the code");
  field.value = code;
  for (const listener of field.listeners.input) listener();
  for (const listener of byKey(notice, `device-request-form-${request.id}`).listeners.submit) listener({ preventDefault() {} });
}

// The new device asks, the approving device shows the code field: returns the request and the code
// the new device shows.
async function untilCodeAsked() {
  signedIn(true);
  state.apiKey = "";
  joinFromAnotherDevice();
  await until(() => byKey(joinFromAnotherDevice(), "device-join-start"), "the account's homes");
  click(byKey(joinFromAnotherDevice(), "device-join-start"));
  await until(() => cloud.requests.size === 1, "the request");
  const [request] = [...cloud.requests.values()];
  approverDevice();
  await untilTicking(60000, () => enabled(byKey(deviceRequestNotice(), `device-request-show-${request.id}`)), "the request on the other device");
  click(byKey(deviceRequestNotice(), `device-request-show-${request.id}`));
  await until(() => request.approver_key, "the other device's key");
  await untilTicking(2000, () => request.device_key && byKey(joinFromAnotherDevice(), "device-join-code"), "the new device's code");
  const code = byKey(joinFromAnotherDevice(), "device-join-code").textContent.replace(/\D/g, "");
  await untilTicking(2000, () => byKey(deviceRequestNotice(), `device-request-code-${request.id}`), "the field on the other device");
  return { request, code };
}

const devicePaths = () => cloud.calls.filter((call) => call.path.includes("/device-requests"));

// ---- tests -------------------------------------------------------------------------------------

test("an account service before 1.7.0: no Join from another device, and nothing asked", async () => {
  signedIn(false);
  approverDevice();
  assert.equal(joinFromAnotherDevice(), null);
  watchDeviceRequests();
  for (const listener of windowListeners.focus || []) listener();
  await tick(60000);
  assert.equal(devicePaths().length, 0);
  assert.equal(deviceRequestNotice(), null);
});

test("the new device asks and shows a code, the other types it, Approve seals a for-me invitation, and the new device joins", async () => {
  signedIn(true);
  cloud.calls.length = 0;
  standalone = true;
  // The new device (the Home Screen app): the account's home is listed, then Join from another device.
  joinFromAnotherDevice();
  await until(() => byKey(joinFromAnotherDevice(), "device-join-start"), "the account's homes");
  click(byKey(joinFromAnotherDevice(), "device-join-start"));
  await until(() => cloud.requests.size === 1, "the request");
  const [request] = [...cloud.requests.values()];
  assert.equal(request.label, "Home Screen app on iPhone");
  assert.match(request.commitment, /^[0-9a-f]{64}$/);
  const waiting = joinFromAnotherDevice();
  assert.match(waiting.textContent, /Open DirectorLink on a device you already use, signed in as dana@example\.com/);
  assert.equal(byKey(waiting, "device-join-code"), null, "no code before the other device answers");

  // The device that reaches the home sees it at its next look (every 60 s while it is shown).
  approverDevice();
  await untilTicking(60000, () => deviceRequestNotice(), "the request on the other device");
  assert.match(deviceRequestNotice().textContent, /Home Screen app on iPhone wants to join your home/);
  assert.match(deviceRequestNotice().textContent, /Didn’t ask\? Decline it and sign out everywhere in Settings → Account\./);
  click(byKey(deviceRequestNotice(), `device-request-show-${request.id}`));
  await until(() => request.approver_key, "the other device's key");

  // The new device shows its key (the one it committed to) and its code; the other device asks for
  // it, and does not show its own.
  await untilTicking(2000, () => request.device_key && byKey(joinFromAnotherDevice(), "device-join-code"), "the new device's code");
  await untilTicking(2000, () => byKey(deviceRequestNotice(), `device-request-code-${request.id}`), "the other device's field");
  const onNew = byKey(joinFromAnotherDevice(), "device-join-code").textContent;
  assert.match(onNew, /^[0-9]{3} [0-9]{3}$/);
  assert.match(joinFromAnotherDevice().textContent, /Type this code on your other device/);
  assert.match(deviceRequestNotice().textContent, /Type the code that Home Screen app on iPhone shows/);
  assert.ok(!deviceRequestNotice().textContent.includes(onNew), "the approving device never shows the code itself");

  // The code typed (as shown, with its space), then Approve: a for-me invitation at the controller,
  // as Add my other device makes it.
  await typeCode(request, onNew);
  await until(() => request.sealed, "the sealed invitation");
  const [[invitationId, made]] = [...cloud.invitations.entries()];
  assert.deepEqual(made.body, { role: "admin", expires_in: 600, for_me: true, email: EMAIL });
  assert.ok(!request.sealed.includes(made.secret) && !request.sealed.includes(invitationId), "the account service never sees the invitation");
  assert.ok(!JSON.stringify(cloud.calls.filter((call) => call.path.includes("device-requests"))).includes(made.secret));
  await until(() => /Approved/.test(deviceRequestNotice()?.textContent || ""), "Approved on the other device");

  // The new device collects it, opens it and joins with it.
  state.apiKey = "";
  await untilTicking(2000, () => cloud.joined.length === 1, "the join");
  assert.equal(cloud.joined[0].invitation, invitationId);
  await until(() => localStorage.getItem("directorlink.apiKey") || state.apiKey === `ak_${"2".repeat(48)}`, "the new key");
  assert.equal(state.apiKey, `ak_${"2".repeat(48)}`);
  assert.equal(cloud.requests.size, 0, "collected once, the request is gone");
  assert.equal(localStorage.getItem("directorlink.deviceJoin"), null, "nothing of the request is kept");
  standalone = false;
});

test("Decline on the other device ends the request on the new one", async () => {
  signedIn(true);
  state.apiKey = "";
  click(byKey(joinFromAnotherDevice(), "device-join-start"));
  await until(() => cloud.requests.size === 1, "the request");
  const [request] = [...cloud.requests.values()];
  approverDevice();
  await untilTicking(60000, () => enabled(byKey(deviceRequestNotice(), `device-request-decline-${request.id}`)), "the request on the other device");
  await until(() => enabled(byKey(deviceRequestNotice(), `device-request-decline-${request.id}`)), "Decline enabled");
  click(byKey(deviceRequestNotice(), `device-request-decline-${request.id}`));
  await until(() => cloud.requests.size === 0, "declined");
  await untilTicking(2000, () => /declined, or the request ran out/.test(joinFromAnotherDevice()?.textContent || ""), "the new device to say so");
  assert.equal(localStorage.getItem("directorlink.deviceJoin"), null);
});

test("keys swapped on the way stop both devices: no code to approve, and the new device gives up", async () => {
  const { keyPair } = await import("../../app/js/device-join.js");
  signedIn(true);
  state.apiKey = "";
  cloud.swapKey = (await keyPair()).publicKey;
  click(byKey(joinFromAnotherDevice(), "device-join-start"));
  await until(() => cloud.requests.size === 1, "the request");
  const [request] = [...cloud.requests.values()];
  approverDevice();
  await untilTicking(60000, () => enabled(byKey(deviceRequestNotice(), `device-request-show-${request.id}`)), "the request on the other device");
  click(byKey(deviceRequestNotice(), `device-request-show-${request.id}`));
  await until(() => request.approver_key, "the other device's key");
  await untilTicking(2000, () => request.device_key, "the new device's key");
  await untilTicking(2000, () => /doesn’t match what it sent first/.test(deviceRequestNotice()?.textContent || ""), "the other device to refuse it");
  assert.equal(byKey(deviceRequestNotice(), `device-request-approve-${request.id}`), null, "no Approve");
  assert.equal(byKey(deviceRequestNotice(), `device-request-code-${request.id}`), null, "no code");
  // The approving key changes after the new device showed its own: it stops and withdraws.
  request.approver_key = (await keyPair()).publicKey;
  state.apiKey = "";
  await untilTicking(2000, () => /changed on its way/.test(joinFromAnotherDevice()?.textContent || ""), "the new device to stop");
  assert.equal(cloud.requests.size, 0, "withdrawn");
  cloud.swapKey = null;
});

test("a key swapped after the code was shown takes the code and Approve away", async () => {
  const { keyPair } = await import("../../app/js/device-join.js");
  signedIn(true);
  state.apiKey = "";
  click(byKey(joinFromAnotherDevice(), "device-join-start"));
  await until(() => cloud.requests.size === 1, "the request");
  const [request] = [...cloud.requests.values()];
  approverDevice();
  await untilTicking(60000, () => enabled(byKey(deviceRequestNotice(), `device-request-show-${request.id}`)), "the request on the other device");
  click(byKey(deviceRequestNotice(), `device-request-show-${request.id}`));
  await until(() => request.approver_key, "the other device's key");
  await untilTicking(2000, () => request.device_key, "the new device's key");
  await untilTicking(2000, () => enabled(byKey(deviceRequestNotice(), `device-request-approve-${request.id}`)), "Approve with the code");
  // Now the account service shows another key in the new device's place.
  cloud.swapKey = (await keyPair()).publicKey;
  await untilTicking(60000, () => /doesn’t match what it sent first/.test(deviceRequestNotice()?.textContent || ""), "the other device to refuse it");
  assert.equal(byKey(deviceRequestNotice(), `device-request-approve-${request.id}`), null, "no Approve");
  assert.equal(request.sealed, undefined, "nothing sealed");
  cloud.swapKey = null;
  await until(() => enabled(byKey(deviceRequestNotice(), `device-request-decline-${request.id}`)), "Decline enabled");
  click(byKey(deviceRequestNotice(), `device-request-decline-${request.id}`));
  await until(() => cloud.requests.size === 0, "declined");
  await untilTicking(2000, () => !byKey(joinFromAnotherDevice(), "device-join-cancel"), "the new device to stop");
});

test("a wrong code approves nothing; three wrong codes decline the request", async () => {
  const { request, code } = await untilCodeAsked();
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  await typeCode(request, wrong);
  await until(() => /That isn’t the code .* shows/.test(deviceRequestNotice()?.textContent || ""), "said so");
  assert.equal(request.sealed, undefined, "nothing sealed");
  assert.equal(cloud.invitations.size, 0, "no invitation made");
  assert.ok(cloud.requests.has(request.id), "the request still waits");
  await typeCode(request, "");
  await until(() => /That isn’t the code/.test(deviceRequestNotice()?.textContent || ""), "an empty field neither");
  await typeCode(request, wrong);
  await until(() => /three times, so the request was declined\. Didn’t ask\? Sign out everywhere/.test(deviceRequestNotice()?.textContent || ""), "declined after the third");
  assert.equal(cloud.requests.has(request.id), false, "declined");
  assert.equal(cloud.invitations.size, 0);
  state.apiKey = "";
  await untilTicking(2000, () => /declined, or the request ran out/.test(joinFromAnotherDevice()?.textContent || ""), "the new device stops");
});

test("a device whose role is not known yet asks nothing and offers nothing", async () => {
  signedIn(true);
  state.apiKey = "";
  click(byKey(joinFromAnotherDevice(), "device-join-start"));
  await until(() => cloud.requests.size === 1, "the request");
  const [request] = [...cloud.requests.values()];
  // A member key still connecting (or its home offline): can() would take it for an admin's.
  Object.assign(state, { apiKey: `ak_${"3".repeat(48)}`, role: null, loaded: false, status: "connecting", transport: "remote" });
  saveRemote({ home: HOME, keyId: "0c0c0c0c" });
  const before = cloud.calls.filter((call) => call.method === "GET" && call.path === `/v1/homes/${HOME}/device-requests`).length;
  for (const listener of windowListeners.focus || []) listener();
  await tick(60000);
  assert.equal(deviceRequestNotice(), null, "no Show code");
  assert.equal(cloud.calls.filter((call) => call.method === "GET" && call.path === `/v1/homes/${HOME}/device-requests`).length, before, "nothing asked");
  assert.equal(request.approver_key, null);
  // Known to be an admin: then it looks.
  approverDevice();
  await untilTicking(60000, () => enabled(byKey(deviceRequestNotice(), `device-request-show-${request.id}`)), "the request");
  await until(() => enabled(byKey(deviceRequestNotice(), `device-request-decline-${request.id}`)), "Decline enabled");
  click(byKey(deviceRequestNotice(), `device-request-decline-${request.id}`));
  await until(() => cloud.requests.size === 0, "declined");
  state.apiKey = "";
  await tick(2000);
});

test("a device that reaches the home looks every 60 s, every 2 s only while it answers", async () => {
  signedIn(true);
  approverDevice();
  cloud.requests.clear();
  await tick(60000);
  const lists = () => cloud.calls.filter((call) => call.method === "GET" && call.path === `/v1/homes/${HOME}/device-requests`).length;
  const before = lists();
  for (let minute = 0; minute < 3; minute += 1) {
    await tick(30000);
    await tick(30000);
  }
  assert.equal(lists() - before, 3, "three looks in three minutes, not twelve");
});

test("a key saved another way while the request waits withdraws the request", async () => {
  const { connect, stopPolling } = await import("../../app/js/session.js");
  signedIn(true);
  state.apiKey = "";
  joinFromAnotherDevice();
  click(byKey(joinFromAnotherDevice(), "device-join-start"));
  await until(() => cloud.requests.size === 1, "the request");
  // This device paired at home, or joined with a link: it has a key, and connects with it.
  approverDevice();
  const connected = connect();
  await until(() => cloud.requests.size === 0, "withdrawn");
  await connected;
  stopPolling();
  assert.equal(localStorage.getItem("directorlink.deviceJoin"), null);
  state.apiKey = "";
  assert.match(joinFromAnotherDevice()?.textContent || "", /has an access key now, so its request to join was withdrawn/);
});

test("a device that got a key while its request was approved is asked before it is replaced", async () => {
  const { request, code } = await untilCodeAsked();
  await typeCode(request, code);
  await until(() => request.sealed, "the sealed invitation");
  // Meanwhile this device got a key of its own (and the hook missed it): the join page asks first.
  const own = `ak_${"4".repeat(48)}`;
  state.apiKey = own;
  const joinedBefore = cloud.joined.length;
  await untilTicking(2000, () => !cloud.requests.has(request.id) && window.location.hash === "#/join", "collected, and the join page open");
  for (let index = 0; index < 20; index += 1) await tick(100);
  assert.equal(cloud.joined.length, joinedBefore, "not joined without asking");
  assert.equal(state.apiKey, own, "its key stays");
  sessionStorage.removeItem("directorlink.join");
  window.location.hash = "#/";
});

test("Approve whose answer is lost keeps the invitation the cloud took; a refusal revokes it", async () => {
  // A definite refusal (the request is gone): the invitation goes at home too.
  let { request, code } = await untilCodeAsked();
  cloud.revoked = 0;
  cloud.requests.delete(request.id);
  await typeCode(request, code);
  await until(() => cloud.revoked === 1, "revoked at home");
  assert.match(deviceRequestNotice()?.textContent || "", /withdrawn or ran out/);
  state.apiKey = "";
  await tick(2000);

  // No answer, but the cloud took it: the request says so, and the invitation stays.
  ({ request, code } = await untilCodeAsked());
  cloud.revoked = 0;
  cloud.dropApproveAnswer = true;
  const invitations = cloud.invitations.size;
  await typeCode(request, code);
  await until(() => request.sealed, "the cloud took it");
  await until(() => /Approved\./.test(deviceRequestNotice()?.textContent || ""), "Approved, as the request says");
  cloud.dropApproveAnswer = false;
  assert.equal(cloud.revoked, 0, "not revoked at home");
  assert.equal(cloud.invitations.size, invitations + 1, "the invitation waits at home");
  // The new device joins with it.
  const joinedBefore = cloud.joined.length;
  state.apiKey = "";
  await untilTicking(2000, () => cloud.joined.length === joinedBefore + 1, "the join");
});

test("an account with no device that could approve is told what to do instead", async () => {
  signedIn(true);
  cloud.refuseStart = "NO_APPROVER";
  click(byKey(joinFromAnotherDevice(), "device-join-start"));
  await until(() => /admin access to the home/.test(joinFromAnotherDevice().textContent), "the explanation");
  assert.equal(cloud.requests.size, 0);
  cloud.refuseStart = null;
});

test("Paste invitation link: from the clipboard, else from a field", async () => {
  const token = `${HOME}.89abcdef.${"cd".repeat(32)}`;
  const opened = () => sessionStorage.getItem("directorlink.join");
  // The clipboard holds a whole link: the join page opens with it.
  clipboard.text = `Join my home: https://app.directorlink.io/#/join/${token}`;
  window.location.hash = "#/";
  click(byKey(pasteInvitationPanel({ key: "connect" }), "connect-paste"));
  await until(() => opened() === token, "the invitation kept");
  assert.equal(window.location.hash, "#/join");
  assert.equal(byKey(pasteInvitationPanel({ key: "connect" }), "connect-paste-text"), null, "no field needed");
  sessionStorage.removeItem("directorlink.join");

  // Refused (or a browser without it): a field, without an error.
  clipboard.refuse = true;
  click(byKey(pasteInvitationPanel({ key: "account" }), "account-paste"));
  await until(() => byKey(pasteInvitationPanel({ key: "account" }), "account-paste-text"), "the field");
  const form = pasteInvitationPanel({ key: "account" });
  assert.doesNotMatch(form.textContent, /isn’t an invitation link/);
  assert.equal(byKey(pasteInvitationPanel({ key: "connect" }), "connect-paste-text"), null, "only where it was asked for");
  // Something else typed: said so; the token alone: joins.
  const field = byKey(form, "account-paste-text");
  field.value = "hello";
  for (const listener of field.listeners.input) listener();
  for (const listener of form.listeners.submit) listener({ preventDefault() {} });
  assert.match(pasteInvitationPanel({ key: "account" }).textContent, /isn’t an invitation link/);
  field.value = token;
  for (const listener of field.listeners.input) listener();
  for (const listener of form.listeners.submit) listener({ preventDefault() {} });
  assert.equal(opened(), token);
  sessionStorage.removeItem("directorlink.join");

  // The clipboard holds other text: the field, with the reason.
  clipboard.refuse = false;
  clipboard.text = "1234 5678";
  click(byKey(pasteInvitationPanel({ key: "connect" }), "connect-paste"));
  await until(() => /isn’t an invitation link/.test(pasteInvitationPanel({ key: "connect" }).textContent), "the reason");
  assert.equal(opened(), null);

  // No clipboard at all.
  const reader = navigator.clipboard;
  navigator.clipboard = undefined;
  const before = clipboard.read;
  click(byKeyStart(pasteInvitationPanel({ key: "account" }), "account-paste"));
  await until(() => byKey(pasteInvitationPanel({ key: "account" }), "account-paste-text"), "the field");
  assert.equal(clipboard.read, before);
  navigator.clipboard = reader;

  // The join page shows the pasted invitation as it would a link's.
  sessionStorage.setItem("directorlink.join", token);
  state.account = { status: "signed-in", user: { email: EMAIL }, notice: null, busy: false };
  ui.joinWait = null;
  const page = joinView({ navigate: () => {} });
  assert.ok(byKey(page[1], "join-accept"), "Accept invitation");
});
