// Direct HTTPS at home on iPhone and iPad (1.12.0, ADR-082; app/js/direct.js, app/js/session.js):
// WebKit blocks the controller's plain http:// address from this HTTPS page, so until 1.12.0 an
// iPhone always went through the account. With the controller's name remembered it goes there
// first, sealed as on the home network, and never to the address; it can reach its home with a name
// and a key; a name whose certificate has expired is not tried; without an answer it goes through
// the account, reads sent again and a command never twice; through the account it looks for the
// name once a minute, briefly, and comes back to it. Its own process: the app reads whether it runs
// on iOS once. Computers and Android: tests/app/direct-https.test.mjs.
//   node --test tests/app/

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { CERT_END, HOME, HOST, KEY, KEY_ID, fakeHome } from "./direct-home.mjs";
import { DIRECT_KEY, DIRECT_NAME, DIRECT_PORT, directRecord } from "./sealed-door.mjs";

const stored = new Map();
globalThis.window = globalThis;
window.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", pathname: "/", search: "", hash: "" };
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.document = { hidden: false, addEventListener: () => {}, documentElement: {}, querySelector: () => null };
// Safari on an iPhone.
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", maxTouchPoints: 5, languages: ["en"], language: "en", onLine: true },
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
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-10-10T12:00:00Z") });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 16);

const { net, fetch } = fakeHome();
globalThis.fetch = fetch;

const { state } = await import("../../app/js/state.js");
const session = await import("../../app/js/session.js");
const { IS_IOS } = await import("../../app/js/platform.js");
const { saveRemote } = await import("../../app/js/remote.js");

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

async function until(done, ms = 30000) {
  for (let waited = 0; !done() && waited < ms; waited += 50) await advance(50, 50);
  await settle();
  return done();
}

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

// The iPhone as it starts: its key (joined through the account: `linked`), the name GET /v1/system
// gave before (`remembered`, its certificate's end `notAfter`) and, to show it is never used, an
// address saved when someone typed it once.
async function start({ remembered = true, linked = true, notAfter = CERT_END, https = "ok", direct = { name: DIRECT_NAME, port: DIRECT_PORT, not_after: CERT_END } } = {}) {
  session.forgetKey();
  await advance(100);
  stored.clear();
  localStorage.setItem("directorlink.directorHost", HOST);
  localStorage.setItem("directorlink.apiKey", KEY);
  if (linked) saveRemote({ home: HOME, keyId: KEY_ID });
  if (remembered) localStorage.setItem(DIRECT_KEY, directRecord({ notAfter, home: linked ? HOME : null }));
  Object.assign(net, { calls: [], sent: [], urls: [], gaveUp: [], https, http: "ok", account: "ok", direct });
  session.restoreSaved();
}

test("an iPhone at home goes to its controller's name, sealed, and never to the address", async () => {
  assert.equal(IS_IOS, true);
  await start();
  assert.equal(state.transport, "lan");
  assert.equal(state.lanRoute, "https");
  assert.deepEqual(session.homeRoutes(), ["https"], "never the plain address on iOS");
  await finish(session.connect());
  assert.equal(state.status, "connected");
  assert.equal(net.calls[0], "https look");
  assert.ok(net.calls.includes("https GET /v1/system"));
  assert.ok(net.calls.includes("https GET /v1/lights"));
  assert.deepEqual(via("http"), []);
  assert.deepEqual(via("account"), [], "not through DirectorLink's servers");
  // Sealed with the key id it joined with: no API key ever crosses the network.
  assert.ok(net.urls.every((url) => url === `https://${DIRECT_NAME}:28443/v1/sealed`));
});

test("an iPhone can reach its home with a name and a key; with an expired name only through the account", async () => {
  await start({ linked: false });
  assert.equal(session.reachable(), true, "the name and the key are enough");
  assert.equal(state.status, "connecting");
  await start({ linked: false, notAfter: "2026-10-01T00:00:00.000Z" });
  assert.equal(session.reachable(), false, "an expired name is no way home");
  assert.equal(state.status, "setup");
  // Linked: the account, and the name is never tried.
  await start({ notAfter: "2026-10-01T00:00:00.000Z", direct: null });
  assert.equal(state.transport, "remote");
  await finish(session.connect());
  assert.equal(state.status, "connected");
  assert.deepEqual(via("https"), []);
  assert.ok(net.calls.includes("account GET /v1/system"));
});

test("away from home (or the name refused): the account, reads sent again; a command whose answer was lost is never sent twice", async () => {
  await start({ https: "refused" });
  await finish(session.connect());
  assert.equal(state.status, "connected");
  assert.equal(state.transport, "remote");
  assert.deepEqual(net.calls.slice(0, 1), ["https look"]);
  assert.ok(net.calls.includes("account GET /v1/system"));
  assert.deepEqual(via("http"), []);

  await start();
  await finish(session.connect());
  session.stopPolling();
  assert.equal(state.lanRoute, "https");
  net.https = "lost";
  const error = await finish(session.api("/v1/lights/1", { method: "PATCH", body: { on: false } })).catch((failure) => failure);
  assert.ok(error instanceof Error);
  assert.deepEqual(net.sent.filter((call) => call.method === "PATCH").map((call) => call.via), ["https"], "not sent again through the account");
  assert.equal(state.transport, "remote");
  await finish(session.api("/v1/lights/1", { method: "PATCH", body: { on: false } }));
  assert.deepEqual(net.sent.filter((call) => call.method === "PATCH").map((call) => call.via), ["https", "account"], "the next press goes through the account");
});

test("through the account, the name is looked for once a minute, 2.5 s at most, and used once it answers", async () => {
  await start({ https: "hang" });
  await finish(session.connect());
  assert.equal(state.transport, "remote");
  assert.deepEqual(net.gaveUp.map(briefly), [true], "starting away from home, the name is given 2.5 s, once");
  net.calls = [];
  net.gaveUp = [];
  // Still away: each look gives up after 2.5 s, once a minute.
  for (let minute = 0; minute < 2; minute += 1) {
    assert.ok(await until(() => net.calls.includes("https look"), 70000), "looked for");
    const looked = Date.now();
    await until(() => net.calls.some((call) => call.startsWith("account ") && Date.now() > looked), 10000);
    await advance(3000);
    assert.equal(state.transport, "remote");
    assert.equal(net.calls.filter((call) => call === "https look").length, 1, "not repeated");
    assert.deepEqual(net.gaveUp.map(briefly), [true], "given up after 2.5 s");
    net.calls = [];
    net.gaveUp = [];
  }
  // Home again.
  net.https = "ok";
  assert.ok(await until(() => state.transport === "lan", 70000));
  session.stopPolling();
  assert.equal(state.lanRoute, "https");
  net.calls = [];
  await finish(session.api("/v1/lights"));
  assert.deepEqual(net.calls, ["https GET /v1/lights"]);
});

test("a name GET /v1/system gives through the account is tried at once", async () => {
  await start({ remembered: false });
  assert.equal(state.transport, "remote");
  await finish(session.connect());
  session.stopPolling();
  assert.deepEqual(JSON.parse(stored.get(DIRECT_KEY)), { home: HOME, name: DIRECT_NAME, port: DIRECT_PORT, notAfter: CERT_END });
  assert.ok(await until(() => state.transport === "lan"));
  assert.equal(state.lanRoute, "https");
  assert.deepEqual(via("http"), []);
});
