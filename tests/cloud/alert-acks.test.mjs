// Alerts the controller sends again after a lost connection are pushed once (1.10.1, ADR-073,
// cloud/src/alerts.js, cloud/src/home-relay.js, docs/RELAY.md): a `notify` with an id is answered
// `notify_result`; the same id again (the driver could not know it had arrived) is answered and not
// pushed; the ids outlive a restart of the home's object, at most 200 of them; the relay says it
// answers alerts (`relay_features`) only to a driver whose hello lists `alert_acks`; and a driver
// before 1.10.1 (no id) is handled as before. The Worker under `wrangler dev`, a fake Google, a fake
// push service and a fake controller.
//   node --test tests/cloud/alert-acks.test.mjs

import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { connectDriver, randomHex } from "../../scripts/relay_smoke.mjs";
import { startFakePush, vapidVars } from "./fake-push.mjs";
import { googleVars, signInAs, startFakeGoogle } from "./fake-google.mjs";
import { lockKey, open, seal } from "./lock.mjs";
import { STARTUP_MS, startWorker } from "./worker.mjs";

const APP = "http://localhost:8080";
const TEST = { timeout: 60_000 };
const DANA = { sub: "google-dana-acks", email: "dana-acks@example.com", name: "Dana" };
const FEATURES = ["scene_links", "alerts_gone", "users", "resend", "alert_acks"];
const OLD_FEATURES = ["scene_links", "alerts_gone", "users", "resend"]; // DirectorLink 1.10.0

let worker;
let google;
let push;
let dana;
const vapid = vapidVars();
const drivers = [];

before(async () => {
  google = await startFakeGoogle();
  push = await startFakePush();
  worker = await startWorker({
    migrate: true,
    devVars: { ...googleVars(google, APP, "https://api.directorlink.test"), ...vapid, PUSH_TEST_URL: push.url, REQUEST_TIMEOUT_MS: 3000 },
  });
  dana = await signInAs(worker.http, google, DANA, APP);
}, { timeout: STARTUP_MS + 10_000 });

after(async () => {
  await Promise.all(drivers.splice(0).map((connection) => connection.close().catch(() => {})));
  await worker?.stop();
  await google?.close();
  await push?.close();
});

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((connection) => connection.close().catch(() => {})));
  assert.deepEqual(push.errors().map((entry) => entry.error), [], "every push was signed and encrypted right");
});

// --- A fake controller -----------------------------------------------------------------------------

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function call(method, apiPath, { cookie = dana, body } = {}) {
  const headers = { Origin: APP };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${worker.http}${apiPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON.
  }
  return { status: response.status, json, text };
}

async function eventually(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// A home claimed by Dana with one admin key, which her account has used (a sealed request), and
// `browser`, registered with that key (unless `browser` is false). Each connection of its driver says
// hello with `features`; `connection.got` is what the relay sent it (claims and sealed requests
// answered as the controller does).
async function claimedHome({ features = FEATURES, browser = true } = {}) {
  const state = { home: randomHex(16), secret: randomHex(32), instance: randomHex(16), keyId: randomHex(4), apiKey: `ak_${randomHex(24)}`, claimToken: randomHex(24) };
  state.connect = async (helloFeatures = features) => {
    const connection = await connectDriver({ url: worker.ws, home: state.home, secret: state.secret, pingIntervalMs: 0, silenceTimeoutMs: 0, hello: false });
    drivers.push(connection);
    connection.got = [];
    connection.on("unknown", (text) => {
      const message = JSON.parse(text);
      connection.got.push(message);
      if (message.type === "claim") {
        connection.sendJson({ type: "claim_result", id: message.id, ok: message.token === state.claimToken });
      } else if (message.type === "e2e") {
        const lock = lockKey(state.apiKey);
        const request = JSON.parse(open(lock, message.envelope, "req"));
        const response = { id: request.id, ts: nowSeconds(), status: 200, content_type: "application/json", body: "{}" };
        connection.sendJson({ type: "e2e", id: message.id, envelope: seal(lock, { home: state.home, key: state.keyId }, "res", JSON.stringify(response)) });
      }
    });
    connection.sendJson({ type: "hello", home: state.home, version: "1.10.1", ping_s: 5, features: helloFeatures, instance: state.instance });
    connection.sendJson({ type: "keys", ids: [state.keyId], admins: [state.keyId] });
    state.connection = connection;
    await sleep(100);
    return connection;
  };
  await state.connect();
  const claimed = await call("POST", "/v1/homes/claim", { body: { home_id: state.home, claim_token: state.claimToken } });
  assert.equal(claimed.status, 200, claimed.text);
  const request = { id: randomHex(8), ts: nowSeconds(), method: "GET", path: "/v1/system", body: null };
  const envelope = seal(lockKey(state.apiKey), { home: state.home, key: state.keyId }, "req", JSON.stringify(request));
  assert.equal((await call("POST", `/v1/homes/${state.home}/e2e`, { body: { envelope } })).status, 200);
  if (browser) {
    state.browser = push.subscribe();
    await eventually(async () => {
      const registered = await call("POST", `/v1/homes/${state.home}/alerts`, { body: { ...state.browser.subscription, key_id: state.keyId } });
      return registered.status === 201;
    }, "the browser registered with Dana's key");
  }
  return state;
}

// A detail sealed to the home's key, as the controller seals it (ADR-050).
function sealedPart(state, detail = { v: 1, kind: "doorbell", name: "Front Gate" }) {
  const alertKey = createHmac("sha256", lockKey(state.apiKey)).update("DirectorLink alert v1").digest();
  const enc = createHmac("sha256", alertKey).update("enc").digest();
  const mac = createHmac("sha256", alertKey).update("mac").digest();
  const ivBytes = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", enc, ivBytes);
  const text = JSON.stringify(detail);
  const ct = Buffer.concat([cipher.update(text + " ".repeat(Math.max(0, 496 - Buffer.byteLength(text))), "utf8"), cipher.final()]).toString("base64");
  const iv = ivBytes.toString("base64");
  return { [state.keyId]: { iv, ct, mac: createHmac("sha256", mac).update(`alert v1|${state.home}|${state.keyId}|${iv}|${ct}`).digest("base64") } };
}

// The controller's alert: { type: "notify", at, for, brief, id?, resent? }.
function notifyMessage(state, fields = {}) {
  return { type: "notify", at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), for: sealedPart(state), brief: true, ...fields };
}

const pushed = (state) => push.messagesFor(state.browser).filter((message) => message.kind === "sealed");
const results = (connection, id) => connection.got.filter((message) => message.type === "notify_result" && (id === undefined || message.id === id));

// The Worker's log lines (JSON) for this home: [{ event, … }].
function logged(home) {
  return worker
    .output()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line.slice(line.indexOf("{")));
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.home === home);
}

// --- Tests ------------------------------------------------------------------------------------------

test("a driver that keeps its alerts hears that the relay answers them; one before 1.10.1 does not", TEST, async () => {
  const state = await claimedHome({ browser: false });
  const [features] = await eventually(async () => {
    const found = state.connection.got.filter((message) => message.type === "relay_features");
    return found.length ? found : null;
  }, "relay_features");
  // Since 1.12.0 also that it issues Direct HTTPS certificates (ADR-082, https.test.mjs).
  assert.deepEqual(features.features, ["alert_acks", "https"]);
  assert.match(features.id, /^[0-9a-f-]{36}$/, "an id, as every message the relay sends");
  assert.equal(state.connection.got[0].type, "relay_features", "before anything else the hello lets the relay send");

  const old = await claimedHome({ features: OLD_FEATURES, browser: false });
  await sleep(500);
  assert.deepEqual(old.connection.got.filter((message) => message.type === "relay_features"), [], "never to a driver that does not list it");
});

// The 21:01 case for alerts: the doorbell's ring went into a connection that had died, or arrived and
// only its answer was lost. Either way the driver sends it again after the reconnect: what the relay
// never had is pushed then, what it had is answered and not pushed twice.
test("an alert sent again after a lost connection is pushed once", TEST, async () => {
  const state = await claimedHome();
  const ring = notifyMessage(state, { id: randomHex(8) });
  state.connection.sendJson(ring);
  const [answer] = await eventually(async () => {
    const found = results(state.connection, ring.id);
    return found.length ? found : null;
  }, "the answer to the ring");
  assert.deepEqual(answer, { type: "notify_result", id: ring.id, ok: true });
  await eventually(async () => pushed(state).length === 1, "the push");
  assert.deepEqual(pushed(state)[0].sealed, ring.for[state.keyId]);

  // Cut before the answer reached the driver: it sends the ring again on its next connection.
  state.connection.destroy();
  await sleep(200);
  const second = await state.connect();
  second.sendJson({ ...ring, resent: 1 });
  await eventually(async () => results(second, ring.id).length === 1, "the answer to the ring sent again");
  assert.equal(results(second, ring.id)[0].ok, true);
  await sleep(1000);
  assert.equal(pushed(state).length, 1, "not pushed twice");
  assert.ok(logged(state.home).some((entry) => entry.event === "notify_again" && entry.resent === 1), "logged as sent again");

  // An alert that went into the dead connection, which the relay never had: pushed now, once.
  const camera = notifyMessage(state, { id: randomHex(8), brief: undefined, resent: 1, for: sealedPart(state, { v: 1, kind: "camera", name: "Garden" }) });
  second.sendJson(camera);
  await eventually(async () => pushed(state).length === 2, "the alert the relay never had");
  assert.deepEqual(pushed(state)[1].sealed, camera.for[state.keyId]);
  await eventually(async () => results(second, camera.id).length === 1, "its answer");
  const line = await eventually(async () => logged(state.home).find((entry) => entry.event === "notify_sent" && entry.resent === 1), "its log line");
  assert.doesNotMatch(JSON.stringify(line), /Garden|camera|"ct"|"iv"|"mac"/, "never what it is about, nor the sealed part");
  assert.ok(!worker.output().includes(ring.id), "the ids are not logged");

  // One that is not sealed parts for key ids: answered, not pushed.
  const broken = { ...notifyMessage(state, { id: randomHex(8) }), for: {} };
  second.sendJson(broken);
  await eventually(async () => results(second, broken.id).length === 1, "the answer to the broken one");
  assert.deepEqual(results(second, broken.id)[0], { type: "notify_result", id: broken.id, ok: false, code: "INVALID_REQUEST" });
  await sleep(300);
  assert.equal(pushed(state).length, 2);
});

// The home's object may be evicted from memory while the driver reconnects (its sockets hibernate),
// or restarted by a deploy: the ids it handled are in its storage, so a ring sent again after that is
// still pushed once.
test("the ids it handled outlive a restart of the home's object", { timeout: 120_000 }, async () => {
  const state = await claimedHome();
  const ring = notifyMessage(state, { id: randomHex(8) });
  state.connection.sendJson(ring);
  await eventually(async () => pushed(state).length === 1 && results(state.connection, ring.id).length === 1, "the push and its answer");

  appendFileSync(path.join(worker.dir, "src", "index.js"), `\n// reloaded by the tests ${Date.now()}\n`);
  await Promise.race([state.connection.closed, sleep(60_000)]);
  await eventually(async () => {
    try {
      return (await fetch(`${worker.http}/health`)).ok;
    } catch {
      return false;
    }
  }, "the relay to answer again", 60_000);
  const again = await state.connect();
  again.sendJson({ ...ring, resent: 1 });
  await eventually(async () => results(again, ring.id).length === 1, "the answer to the ring sent again", 20_000);
  await sleep(1000);
  assert.equal(pushed(state).length, 1, "not pushed twice after the restart");

  const next = notifyMessage(state, { id: randomHex(8) });
  again.sendJson(next);
  await eventually(async () => pushed(state).length === 2, "a new alert, pushed");
});

// At most 200 ids are kept (a driver sends at most 60 alerts an hour): the newest is still known,
// the oldest is not (beyond the hour's 60, nothing more is pushed anyway).
test("at most 200 ids are kept, the newest", TEST, async () => {
  const state = await claimedHome({ browser: false });
  const ids = Array.from({ length: 201 }, () => randomHex(8));
  for (const id of ids) {
    state.connection.sendJson(notifyMessage(state, { id }));
  }
  await eventually(async () => results(state.connection).length === 201, "every answer", 20_000);
  await sleep(500); // the last ones' pushes and limits, which follow their answers
  const notifyEvents = () => logged(state.home).filter((entry) => entry.event.startsWith("notify_")).map((entry) => entry.event);
  state.connection.sendJson(notifyMessage(state, { id: ids[200], resent: 1 }));
  await eventually(async () => notifyEvents().at(-1) === "notify_again", "the newest, known");
  state.connection.sendJson(notifyMessage(state, { id: ids[0], resent: 1 }));
  await eventually(async () => results(state.connection, ids[0]).length === 2, "the oldest, answered again");
  await eventually(async () => notifyEvents().at(-1) === "notify_limited", "the oldest, forgotten: new to the relay, over the hour's limit");
});

test("a driver before 1.10.1 is handled as before: no ids, no answers", TEST, async () => {
  const state = await claimedHome({ features: OLD_FEATURES });
  const ring = notifyMessage(state);
  state.connection.sendJson(ring);
  await eventually(async () => pushed(state).length === 1, "the push");
  // The same alert twice, without an id: twice, as before (a 1.10.0 driver never sends one again).
  state.connection.sendJson(ring);
  await eventually(async () => pushed(state).length === 2, "the second push");
  await sleep(300);
  assert.deepEqual(results(state.connection), [], "nothing answered");
  assert.deepEqual(state.connection.got.filter((message) => message.type === "relay_features"), []);
});
