// Direct HTTPS at home (1.12.0, ADR-082; app/js/direct.js, app/js/session.js, views/direct.js) on a
// computer or an Android phone: the controller's name over HTTPS first, then its address, then the
// account; the name remembered for the home and used before GET /v1/system is read, never once its
// certificate has expired; a request without an answer goes the next way, a command never twice;
// Chrome's Local Network Access refused leaves the device on the account; a new name is tried at
// once, and while away the look for the home network tries it first, briefly. Then Settings →
// Controller's card: the owner's switch and what it means, other admins read only, members nothing,
// every state's words and the refusals'. Against a fake controller (sealed at its name and at its
// address, tests/app/direct-home.mjs) and a fake account service, under fake time. iPhone and iPad:
// tests/app/direct-https-ios.test.mjs.
//   node --test tests/app/

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { CERT_END, HOME, HOST, KEY, KEY_ID, fakeHome, httpsStatus } from "./direct-home.mjs";
import { DIRECT_KEY, DIRECT_NAME, DIRECT_PORT, directRecord } from "./sealed-door.mjs";

// ---- just enough of a browser -------------------------------------------------------------------
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
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}
const stored = new Map();
globalThis.Node = FakeNode;
globalThis.window = globalThis;
window.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/#/settings/controller", pathname: "/", search: "", hash: "#/settings/controller" };
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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
// Chrome on a computer: the address on the home network works here (Local Network Access).
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36", maxTouchPoints: 0, languages: ["en"], language: "en", onLine: true },
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
    clear: () => stored.clear(),
  },
  configurable: true,
});
const NOW = Date.parse("2026-10-10T12:00:00Z");
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 16);

const { net, fetch } = fakeHome();
globalThis.fetch = fetch;

const { state, ui } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const session = await import("../../app/js/session.js");
const { saveRemote } = await import("../../app/js/remote.js");
const direct = await import("../../app/js/direct.js");
const { directCard, directStateText, POLL_MS } = await import("../../app/js/views/direct.js");
const { connectionText } = await import("../../app/js/views/settings.js");
const { default: en } = await import("../../app/i18n/en.js");
const dictionaries = {
  he: (await import("../../app/i18n/he.js")).default,
  es: (await import("../../app/i18n/es.js")).default,
  it: (await import("../../app/i18n/it.js")).default,
};
await setLanguage("en");

// ---- time and the network ---------------------------------------------------------------------------

// Lets fetch answers, promise chains and WebCrypto settle (each step of a sealed request waits for
// the thread pool, and so does a digest).
async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await crypto.subtle.digest("SHA-256", new Uint8Array(1));
  }
}

async function advance(ms, step = 100) {
  for (let done = 0; done < ms; done += step) {
    mock.timers.tick(Math.min(step, ms - done));
    await settle(4);
  }
  await settle();
}

// Waits (in fake time) until `done()`, at most `ms`.
async function until(done, ms = 30000) {
  for (let waited = 0; !done() && waited < ms; waited += 50) await advance(50, 50);
  await settle();
  return done();
}

// What `promise` gives, letting fake time run meanwhile (a read without an answer is sent again
// 400 ms later; a look gives up after 2.5 s).
async function finish(promise, ms = 30000) {
  let done = false;
  let value;
  let failure;
  promise.then(
    (result) => {
      done = true;
      value = result;
    },
    (error) => {
      done = true;
      failure = error;
    }
  );
  assert.ok(await until(() => done, ms), "it ends");
  if (failure) throw failure;
  return value;
}

const via = (way) => net.calls.filter((call) => call.startsWith(`${way} `));
// Given up after 2.5 s (fake time moves in steps of 50 ms here).
const briefly = (ms) => ms >= 2500 && ms <= 2600;
const commands = () => net.sent.filter((call) => call.method === "PATCH");

// This browser as it starts: its address, key and seal saved; `remembered`: the name GET /v1/system
// gave before (its certificate's end `notAfter`); `linked`: the home linked to the account. Then
// restoreSaved(), as the app's start.
async function start({ remembered = true, linked = true, notAfter = CERT_END, https = "ok", http = "ok", account = "ok", direct = { name: DIRECT_NAME, port: DIRECT_PORT, not_after: CERT_END } } = {}) {
  session.forgetKey();
  await advance(100);
  stored.clear();
  localStorage.setItem("directorlink.directorHost", HOST);
  localStorage.setItem("directorlink.apiKey", KEY);
  localStorage.setItem("directorlink.seal", JSON.stringify({ host: HOST, keyId: KEY_ID, seals: true }));
  if (linked) saveRemote({ home: HOME, keyId: KEY_ID });
  if (remembered) localStorage.setItem(DIRECT_KEY, directRecord({ notAfter, home: linked ? HOME : null }));
  Object.assign(net, { calls: [], sent: [], urls: [], gaveUp: [], https, http, account, direct, access: { role: "admin", owner: true }, status: httpsStatus(), put: null });
  ui.directHttps = null;
  session.restoreSaved();
}

async function connected(options) {
  await start(options);
  await finish(session.connect());
}

// ---- the name ---------------------------------------------------------------------------------------

test("a name as the driver makes it is used, at its port; anything else, or a certificate that has expired, is not", () => {
  const good = { name: DIRECT_NAME, port: DIRECT_PORT, not_after: CERT_END };
  assert.deepEqual(direct.directTarget(good), { name: DIRECT_NAME, port: 28443, notAfter: CERT_END, origin: `https://${DIRECT_NAME}:28443` });
  for (const [bad, why] of [
    [null, "no Direct HTTPS"],
    [{ ...good, name: "N4D5COPLBD7R7O43UEMP.dlhome.cc" }, "capitals"],
    [{ ...good, name: "n4d5coplbd7r7o43uem.dlhome.cc" }, "19 letters"],
    [{ ...good, name: "n4d5coplbd7r7o43ue18.dlhome.cc" }, "not base32"],
    [{ ...good, name: "n4d5coplbd7r7o43uemp.example.com" }, "another domain"],
    [{ ...good, name: "evil.n4d5coplbd7r7o43uemp.dlhome.cc" }, "a longer name"],
    [{ ...good, port: "https" }, "no port"],
    [{ ...good, port: 70000 }, "no such port"],
    [{ ...good, not_after: null }, "no end"],
    [{ ...good, not_after: "2026-10-10T11:59:59Z" }, "expired a second ago"],
  ]) {
    assert.equal(direct.directTarget(bad), null, why);
  }
  // Remembered for this home: another home's name is not this one's; null forgets it.
  stored.clear();
  assert.equal(direct.rememberDirect(good, HOME).origin, `https://${DIRECT_NAME}:28443`);
  assert.equal(JSON.parse(stored.get(DIRECT_KEY)).home, HOME);
  assert.ok(direct.savedDirect(HOME));
  assert.equal(direct.savedDirect("f".repeat(32)), null, "another home's");
  assert.equal(direct.rememberDirect(null, HOME), null);
  assert.equal(stored.has(DIRECT_KEY), false, "the controller stopped serving it: forgotten");
});

test("the name first: the one remembered is used before GET /v1/system is read, and the address is never asked", async () => {
  await start();
  assert.equal(state.transport, "lan");
  assert.equal(state.lanRoute, "https", "from the start, before anything is read");
  assert.deepEqual(session.homeRoutes(), ["https", "http"]);
  await finish(session.connect());
  assert.equal(state.status, "connected");
  assert.equal(net.calls[0], "https look", "the name's GET /v1/sealed comes first");
  assert.ok(net.calls.includes("https GET /v1/system"));
  assert.deepEqual(via("http"), [], "not the address");
  assert.deepEqual(via("account"), [], "not the account");
  assert.ok(net.urls.every((url) => url === `https://${DIRECT_NAME}:28443/v1/sealed`), net.urls.join(", "));
  assert.equal(connectionText(), "On the home network, direct (HTTPS)");
});

test("without an answer at the name, the address next, then the account; Local Network Access refused leaves it on the account", async () => {
  // The name gets no connection (a router that refuses such names): the address.
  await connected({ https: "refused" });
  assert.equal(state.status, "connected");
  assert.equal(state.lanRoute, "http");
  assert.deepEqual(net.calls.slice(0, 2), ["https look", "http look"]);
  assert.ok(net.calls.includes("http GET /v1/system"));
  assert.deepEqual(via("account"), []);
  assert.equal(connectionText(), "On the home network");

  // Neither (Chrome's Local Network Access refused: every local request fails): the account.
  await connected({ https: "refused", http: "refused" });
  assert.equal(state.status, "connected");
  assert.equal(state.transport, "remote");
  assert.ok(net.calls.indexOf("https look") < net.calls.indexOf("http look"));
  assert.ok(net.calls.includes("account GET /v1/system"), "reads are sent again through the account");
  assert.equal(connectionText(), "Through DirectorLink’s servers");

  // Not linked to an account: nowhere else to go.
  const quiet = mock.method(console, "error", () => {});
  await connected({ https: "refused", http: "refused", linked: false });
  quiet.mock.restore();
  assert.equal(state.status, "unreachable");
  assert.deepEqual(via("account"), []);
});

test("a command whose answer was lost at the name is not sent again, not at the address, not through the account; the next press goes the next way", async () => {
  await connected();
  assert.equal(state.lanRoute, "https");
  net.https = "lost";
  const error = await finish(session.api("/v1/lights/1", { method: "PATCH", body: { on: true } })).catch((failure) => failure);
  assert.ok(error instanceof Error, "the press says it could not reach the home");
  assert.equal(error.status, undefined);
  await settle();
  assert.deepEqual(commands().map((call) => call.via), ["https"], "it reached the home once, and was not sent again");
  assert.equal(state.lanRoute, "http", "the address is next");
  // Pressing again sends it the next way.
  assert.deepEqual(await finish(session.api("/v1/lights/1", { method: "PATCH", body: { on: true } })), { id: 1, name: "Island", on: true });
  assert.deepEqual(commands().map((call) => call.via), ["https", "http"]);

  // A read is sent again, the next way.
  await connected();
  net.https = "lost";
  net.calls = [];
  assert.deepEqual(await finish(session.api("/v1/lights")), { items: [] });
  assert.deepEqual(net.calls, ["https GET /v1/lights", "https GET /v1/lights", "http look", "http GET /v1/lights"], "once more at the name (a lost read), then at the address");
});

test("an expired name is not tried, and one that expires is left", async () => {
  // Remembered, but its certificate ended yesterday (and the controller serves none now).
  await start({ notAfter: "2026-10-09T12:00:00.000Z", direct: null });
  assert.deepEqual(session.homeRoutes(), ["http"]);
  assert.equal(state.lanRoute, "http");
  await finish(session.connect());
  assert.equal(state.status, "connected");
  assert.deepEqual(via("https"), [], "never asked");
  // With a new certificate GET /v1/system gives the name again: then it is used.
  await start({ notAfter: "2026-10-09T12:00:00.000Z" });
  await finish(session.connect());
  assert.equal(net.calls[0], "http look", "not before GET /v1/system said so");
  assert.ok(await until(() => state.lanRoute === "https"));

  // In use while its certificate ends: the next request goes to the address.
  const soon = new Date(Date.now() + 60000).toISOString();
  await connected({ notAfter: soon, direct: { name: DIRECT_NAME, port: DIRECT_PORT, not_after: soon } });
  session.stopPolling();
  assert.equal(state.lanRoute, "https");
  await advance(61000, 1000);
  net.calls = [];
  await finish(session.api("/v1/lights"));
  assert.deepEqual(via("https"), []);
  assert.ok(net.calls.includes("http GET /v1/lights"));
  assert.equal(state.lanRoute, "http");
});

test("GET /v1/system's direct_https: remembered for the home and tried at once; gone, the address again; a DirectorLink before 1.12.0 has none", async () => {
  await connected({ remembered: false });
  assert.ok(net.calls.includes("http GET /v1/system"));
  const record = JSON.parse(stored.get(DIRECT_KEY));
  assert.deepEqual(record, { home: HOME, name: DIRECT_NAME, port: DIRECT_PORT, notAfter: CERT_END });
  assert.ok(await until(() => state.lanRoute === "https"), "the new name is tried at once, and used");
  assert.equal(state.transport, "lan");
  net.calls = [];
  await finish(session.api("/v1/lights"));
  assert.deepEqual(net.calls, ["https GET /v1/lights"], "sealed as the look found it");

  // Turned off (or its certificate gone): forgotten, and the address again.
  net.direct = null;
  await finish(session.refreshRooms());
  await settle();
  assert.equal(stored.has(DIRECT_KEY), false);
  assert.equal(state.lanRoute, "http");
  net.calls = [];
  await finish(session.api("/v1/lights"));
  assert.deepEqual(via("https"), []);

  // An older DirectorLink: no field, nothing remembered.
  await connected({ remembered: true });
  net.direct = undefined;
  await finish(session.refreshRooms());
  assert.equal(stored.has(DIRECT_KEY), false);
  assert.equal(state.lanRoute, "http");
});

test("away from home, the name first, given 2.5 s; then the account; once a minute the name is looked for, and used when it answers", async () => {
  await start({ https: "hang", http: "refused" });
  const began = Date.now();
  const connecting = session.connect();
  await advance(2400);
  assert.deepEqual(via("account"), [], "still waiting for the name");
  assert.ok(await until(() => state.status === "connected"));
  await connecting;
  assert.equal(state.transport, "remote");
  const firstAccount = net.calls.findIndex((call) => call.startsWith("account "));
  assert.ok(firstAccount > 0);
  assert.ok(Date.now() - began < 4000, `${Date.now() - began} ms: the name's look is brief, and not repeated`);
  assert.equal(net.calls.filter((call) => call === "https look").length, 1);
  assert.deepEqual(net.gaveUp.map(briefly), [true], "the name's look gives up after 2.5 s");

  // Back home: within a minute the name is looked for and, sealed, proves it is this home.
  net.https = "ok";
  net.calls = [];
  session.startPolling();
  assert.ok(await until(() => state.transport === "lan", 70000));
  session.stopPolling();
  assert.equal(state.lanRoute, "https");
  assert.deepEqual(net.calls.filter((call) => call.startsWith("https")).slice(0, 2), ["https look", "https GET /v1/api-keys/current"]);
  net.calls = [];
  await finish(session.api("/v1/lights"));
  assert.deepEqual(net.calls, ["https GET /v1/lights"]);
});

test("at home on the address, the name is looked for once a minute, and used when it answers", async () => {
  await connected({ https: "refused" });
  assert.equal(state.lanRoute, "http");
  net.https = "ok";
  session.startPolling();
  assert.ok(await until(() => state.lanRoute === "https", 70000));
  session.stopPolling();
  assert.equal(state.transport, "lan");
});

test("after a minute with nothing better to look for, the look still works: a name that comes later is tried at once, and the address comes back after a drop", async () => {
  // At home on the address, no name, for more than a minute: the minute's look has nothing to try.
  await connected({ remembered: false, direct: null });
  assert.equal(state.lanRoute, "http");
  await advance(70000, 1000);
  // The owner turns it on: GET /v1/system gives the name, and it is tried at once.
  net.direct = { name: DIRECT_NAME, port: DIRECT_PORT, not_after: CERT_END };
  net.calls = [];
  await finish(session.readSystem());
  assert.ok(await until(() => state.lanRoute === "https", 5000), "tried at once, not a minute later");
  assert.ok(net.calls.includes("https look"));
  session.stopPolling();

  // Without Direct HTTPS, as before 1.12.0: a minute at home, the network drops, the account; back
  // within a minute once the address answers again.
  await connected({ remembered: false, direct: null });
  await advance(70000, 1000);
  net.http = "refused";
  assert.ok(await until(() => state.transport === "remote", 30000));
  net.http = "ok";
  assert.ok(await until(() => state.transport === "lan", 70000), "the home network again");
  assert.equal(state.lanRoute, "http");
  session.stopPolling();
});

test("a sealed answer at the name makes the address strict too: the key never goes there in the clear", async () => {
  await start();
  localStorage.setItem("directorlink.seal", JSON.stringify({ host: HOST, keyId: KEY_ID, seals: false }));
  await finish(session.connect());
  session.stopPolling();
  assert.equal(state.lanRoute, "https");
  assert.deepEqual(JSON.parse(stored.get("directorlink.seal")), { host: HOST, keyId: KEY_ID, seals: true });
});

test("Forget key revokes the key the next way when the name gives no answer", async () => {
  await connected();
  net.https = "refused";
  await finish(session.revokeAndForget());
  assert.deepEqual(
    net.sent.filter((call) => call.method === "DELETE").map((call) => `${call.via} ${call.path}`),
    ["http /v1/api-keys/current"]
  );
  assert.equal(stored.has(DIRECT_KEY), false, "the name goes with the key");
});

// ---- Settings → Controller → Direct connection at home ------------------------------------------------

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
const textOf = (nodes) => [nodes].flat(Infinity).filter(Boolean).map((node) => node.textContent).join(" | ").replace(/[⁦-⁩]/g, "");
async function press(nodes, key) {
  const element = byKey(nodes, key);
  assert.ok(element, `${key} is on the card: ${textOf(nodes)}`);
  for (const listener of element.listeners.click || []) listener({ preventDefault() {}, target: element });
  await settle();
}

// The card as it is once read: connected at home as `access`, the controller's GET /v1/https `status`.
async function card({ access = { role: "admin", owner: true }, status = httpsStatus() } = {}) {
  await connected();
  net.access = access;
  net.status = status;
  state.access = access;
  ui.directHttps = null;
  directCard();
  await until(() => ui.directHttps?.status || ui.directHttps?.failed);
  return directCard();
}

test("every state in words: off, getting a certificate, on until its date, what went wrong, and Composer's", () => {
  assert.equal(directStateText({ state: "off" }), "Off");
  assert.equal(directStateText({ state: "requesting" }), "Getting a certificate…");
  assert.equal(directStateText({ state: "listening", certificate: { not_after: CERT_END } }), "On until Jan 8, 2027");
  assert.equal(directStateText({ state: "listening", certificate: null }), "On");
  assert.equal(directStateText({ state: "error", error: "DNS challenge failed" }), "Didn’t work: DNS challenge failed");
  assert.equal(directStateText({ state: "error", error: null }), "Didn’t work");
  assert.equal(directStateText({ state: "not_allowed" }), "Not allowed in Composer");
});

test("the owner: what it means before it is on, the switch, and the state while the controller gets its certificate", async () => {
  let nodes = await card({ status: httpsStatus({ enabled: false, state: "off", certificate: null }) });
  const explanation = textOf(byKey(nodes, "direct-explanation"));
  assert.match(explanation, /every device, iPhones and iPads too, reaches your controller directly on your home network: faster, and without DirectorLink’s servers/);
  assert.match(explanation, /a random name under dlhome\.cc that points to its address inside your home network, which only devices at home can reach/);
  assert.match(explanation, /listed publicly in certificate logs, and DirectorLink’s servers learn the name and that address/);
  assert.match(explanation, /Chrome may ask to reach devices on your local network: allow it/);
  const toggle = byKey(nodes, "direct-switch");
  assert.equal(toggle.attributes.role, "switch");
  assert.equal(toggle.attributes["aria-checked"], "false");
  assert.equal(toggle.attributes["aria-disabled"], undefined);
  assert.equal(textOf(byKey(nodes, "direct-state")), "Status: Off");
  assert.deepEqual(net.sent.filter((call) => call.method === "PUT"), [], "nothing changes before the owner turns it on");

  // On: PUT {"enabled": true}; the controller gets its certificate, asked every 3 s.
  await press(nodes, "direct-switch");
  await until(() => !ui.directHttps.busy);
  assert.deepEqual(net.sent.filter((call) => call.method === "PUT").map((call) => call.body), [{ enabled: true }]);
  nodes = directCard();
  assert.equal(textOf(byKey(nodes, "direct-state")), "Status: Getting a certificate…");
  assert.equal(byKey(nodes, "direct-switch").attributes["aria-checked"], "true");
  assert.equal(byKey(nodes, "direct-explanation"), null, "said before it was on");
  const reads = () => net.sent.filter((call) => call.method === "GET" && call.path === "/v1/https").length;
  const before = reads();
  await advance(POLL_MS);
  assert.equal(reads(), before + 1, "asked again while it gets its certificate");
  net.status = httpsStatus();
  net.calls = [];
  await advance(POLL_MS);
  assert.ok(await until(() => net.calls.some((call) => call.endsWith("GET /v1/system"))), "then this device reads GET /v1/system again, to go the new way");
  assert.equal(textOf(byKey(directCard(), "direct-state")), "Status: On until Jan 8, 2027");
  const after = reads();
  await advance(POLL_MS * 3);
  assert.equal(reads(), after, "no more asking once it is on");

  // Off again: PUT {"enabled": false}.
  await press(directCard(), "direct-switch");
  await until(() => !ui.directHttps.busy);
  assert.deepEqual(net.sent.filter((call) => call.method === "PUT").at(-1).body, { enabled: false });
  assert.equal(textOf(byKey(directCard(), "direct-state")), "Status: Off");
});

test("the owner: Composer first, then Remote Access and the home linked; the controller's refusals in words", async () => {
  let nodes = await card({ status: httpsStatus({ allowed: false, enabled: false, state: "not_allowed", certificate: null }) });
  assert.equal(byKey(nodes, "direct-switch"), null, "nothing to switch until the installer allows it");
  assert.equal(textOf(byKey(nodes, "direct-composer")), "Your installer has to allow it first: in Composer, set DirectorLink’s Direct HTTPS property to Allowed.");
  assert.equal(textOf(byKey(nodes, "direct-state")), "Status: Not allowed in Composer");

  nodes = await card({ status: httpsStatus({ remote: false, enabled: false, state: "off", certificate: null }) });
  assert.equal(byKey(nodes, "direct-switch").attributes["aria-disabled"], "true", "it can't be turned on yet");
  assert.match(textOf(byKey(nodes, "direct-remote")), /^It needs Remote Access on in Composer, and this home linked to your account\. Link it in Settings → Account$/);
  assert.equal(byKey(nodes, "direct-account").attributes.href, "#/settings/account");
  await press(nodes, "direct-switch");
  assert.deepEqual(net.sent.filter((call) => call.method === "PUT"), [], "nothing is sent");

  // The controller refuses (things changed since the card was read).
  for (const [status, code, text] of [
    [409, "HTTPS_NOT_ALLOWED", "Your installer has to allow it first: in Composer, set DirectorLink’s Direct HTTPS property to Allowed."],
    [409, "REMOTE_ACCESS_NEEDED", "It needs Remote Access on in Composer, and this home linked to your account."],
    [403, "FORBIDDEN", "Only the home’s owner can turn it on or off."],
  ]) {
    nodes = await card({ status: httpsStatus({ enabled: false, state: "off", certificate: null }) });
    net.put = [status, { status, code, detail: "refused" }];
    await press(nodes, "direct-switch");
    await until(() => !ui.directHttps.busy);
    assert.equal(textOf(byKey(directCard(), "direct-message")), text, code);
  }
});

test("other admins see how it is, without the switch; members see nothing; nor does anyone with an older DirectorLink", async () => {
  let nodes = await card({ access: { role: "admin", owner: false } });
  assert.equal(byKey(nodes, "direct-switch"), null);
  assert.equal(byKey(nodes, "direct-explanation"), null);
  assert.equal(textOf(byKey(nodes, "direct-state")), "Status: On until Jan 8, 2027");
  assert.equal(textOf(byKey(nodes, "direct-owner-only")), "Only the home’s owner can turn it on or off.");
  nodes = await card({ access: { role: "admin", owner: false }, status: httpsStatus({ allowed: false, enabled: false, state: "not_allowed", certificate: null }) });
  assert.ok(byKey(nodes, "direct-composer"), "the installer's part, for the admin who may be the installer");

  await card({ access: { role: "member", owner: false } });
  state.access = { role: "member", owner: false };
  assert.equal(directCard(), null);

  state.access = { role: "admin", owner: true };
  delete state.system.direct_https;
  assert.equal(directCard(), null, "a DirectorLink before 1.12.0");
});

test("Forget key while the card waits for the certificate: nothing more is asked but the revoke", async () => {
  await card({ status: httpsStatus({ enabled: true, state: "requesting", certificate: null }) });
  // The name takes the revoke and never answers: 4 s, then the address.
  net.https = "swallowed";
  net.sent = [];
  await finish(session.revokeAndForget());
  assert.deepEqual(
    net.sent.map((call) => `${call.via} ${call.method} ${call.path}`),
    ["https DELETE /v1/api-keys/current", "http DELETE /v1/api-keys/current"],
    "the card's look at the certificate (every 3 s) is not sent while the key is being forgotten"
  );
  await advance(POLL_MS * 3);
  assert.deepEqual(net.sent.length, 2, "nor after");
  assert.equal(ui.directHttps, null);
});

test("the card's words in Hebrew, Spanish and Italian", () => {
  const keys = (node, prefix = "") => Object.entries(node).flatMap(([key, value]) => (typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
  for (const [code, dictionary] of Object.entries(dictionaries)) {
    assert.deepEqual(keys(dictionary.directHttps), keys(en.directHttps), code);
    assert.deepEqual(keys(dictionary.settings.controller.via), keys(en.settings.controller.via), code);
    assert.equal(typeof dictionary.settings.controller.thisDevice, "string", code);
    assert.match(dictionary.directHttps.how, /dlhome\.cc/, code);
    assert.match(dictionary.directHttps.notAllowed, /Direct HTTPS.*Allowed/, code);
    assert.match(dictionary.directHttps.state.listening, /\{date\}/, code);
    assert.match(dictionary.directHttps.state.error, /\{error\}/, code);
  }
  assert.match(dictionaries.he.directHttps.how, /יומני התעודות/);
});
