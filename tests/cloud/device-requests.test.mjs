// Joining from another device (cloud/src/device-requests.js, ADR-053) end to end: the Worker under
// `wrangler dev`, a fake Google, and a fake controller that seals like the driver (lock.mjs). The
// two devices are two sessions of one account, with the app's own keys, check code and seal
// (app/js/device-join.js). A second Worker keeps requests for 2 seconds, to see them expire.
//   node --test tests/cloud/device-requests.test.mjs

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { checkCode, commitmentOf, keyPair, openInvitation, sealInvitation } from "../../app/js/device-join.js";
import { connectDriver, randomHex } from "../../scripts/relay_smoke.mjs";
import { googleVars, signInAs, startFakeGoogle } from "./fake-google.mjs";
import { invitationKey, lockKey, open, seal } from "./lock.mjs";
import { STARTUP_MS, startWorker } from "./worker.mjs";

const APP = "http://localhost:8080";
const TEST = { timeout: 60_000 };
const SHORT_SECONDS = 2;

let worker;
let shortWorker;
let google;
const drivers = [];

before(async () => {
  google = await startFakeGoogle();
  const vars = { ...googleVars(google, APP, "https://api.directorlink.test"), REQUEST_TIMEOUT_MS: 3000 };
  [worker, shortWorker] = await Promise.all([
    startWorker({ migrate: true, devVars: vars }),
    startWorker({ migrate: true, scheduled: true, devVars: { ...vars, DEVICE_REQUEST_SECONDS: SHORT_SECONDS } }),
  ]);
}, { timeout: 2 * STARTUP_MS + 10_000 });

after(async () => {
  await Promise.all([worker?.stop(), shortWorker?.stop()]);
  await google?.close();
});

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((connection) => connection.close()));
});

// A person of their own for each test: the limits count per account.
function person(name) {
  const tag = randomHex(4);
  return { sub: `google-${name}-${tag}`, email: `${name}-${tag}@example.com`, name };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// A controller at a new home: keys (id -> API key) and invitations (id -> secret) it knows.
async function home(on) {
  const state = { home: randomHex(16), keys: new Map(), invitations: new Map(), claimToken: randomHex(24), seen: [] };
  const connection = await connectDriver({ url: on.ws, home: state.home, pingIntervalMs: 0, silenceTimeoutMs: 0 });
  drivers.push(connection);
  state.connection = connection;
  connection.on("unknown", (text) => {
    const message = JSON.parse(text);
    state.seen.push(message);
    const reply = (fields) => connection.sendJson({ id: message.id, ...fields });
    if (message.type === "claim") {
      return reply({ type: "claim_result", ok: message.token === state.claimToken });
    }
    if (message.type === "e2e") {
      const apiKey = state.keys.get(message.envelope.key);
      const plaintext = apiKey ? open(lockKey(apiKey), message.envelope, "req") : null;
      if (!plaintext) return reply({ type: "e2e", code: apiKey ? "BAD_MAC" : "UNKNOWN_KEY" });
      const request = JSON.parse(plaintext);
      const answer = { id: request.id, ts: nowSeconds(), status: 200, content_type: "application/json", body: "{}" };
      return reply({ type: "e2e", envelope: seal(lockKey(apiKey), { home: state.home, key: message.envelope.key }, "res", JSON.stringify(answer)) });
    }
    if (message.type === "join") {
      const secret = state.invitations.get(message.invitation);
      const plaintext = secret ? open(invitationKey(secret), message.envelope, "req") : null;
      if (!plaintext) return reply({ type: "join_result", ok: false, code: secret ? "BAD_MAC" : "INVITATION_NOT_FOUND" });
      const request = JSON.parse(plaintext);
      state.invitations.delete(message.invitation);
      const id = randomHex(4);
      const key = `ak_${randomHex(24)}`;
      state.keys.set(id, key);
      const answer = { id: request.id, ts: nowSeconds(), status: 201, content_type: "application/json", body: JSON.stringify({ key, id, role: "admin" }) };
      return reply({ type: "join_result", ok: true, key_id: id, envelope: seal(invitationKey(secret), { home: state.home, key: message.invitation }, "res", JSON.stringify(answer)) });
    }
    return undefined;
  });
  return state;
}

async function call(on, method, path, { cookie, body, origin = APP } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${on.http}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON.
  }
  return { status: response.status, json, text, headers: response.headers };
}

// A sealed request the home accepts: the account is then known to use that key (member_keys).
async function useKey(on, cookie, state, keyId) {
  const apiKey = state.keys.get(keyId);
  const plaintext = JSON.stringify({ id: randomHex(8), ts: nowSeconds(), method: "GET", path: "/v1/system", body: null });
  const answered = await call(on, "POST", `/v1/homes/${state.home}/e2e`, { cookie, body: { envelope: seal(lockKey(apiKey), { home: state.home, key: keyId }, "req", plaintext) } });
  assert.equal(answered.status, 200, answered.text);
}

// The owner claims a new home with a key the controller knows; `used`: the cloud has seen the key.
async function claimedHome({ on = worker, owner = person("dana"), used = true } = {}) {
  const state = await home(on);
  const keyId = randomHex(4);
  state.keys.set(keyId, `ak_${randomHex(24)}`);
  const cookie = await signInAs(on.http, google, owner, APP);
  const claimed = await call(on, "POST", "/v1/homes/claim", { cookie, body: { home_id: state.home, claim_token: state.claimToken } });
  assert.equal(claimed.status, 200, claimed.text);
  if (used) await useKey(on, cookie, state, keyId);
  return { on, state, owner, cookie, keyId };
}

const requests = (state) => `/v1/homes/${state.home}/device-requests`;

// The new device asks: its key pair, and the request as the cloud answered it.
async function ask(on, cookie, state, label = "Home Screen app on iPhone") {
  const pair = await keyPair();
  const asked = await call(on, "POST", requests(state), { cookie, body: { label, commitment: await commitmentOf(pair.publicKey) } });
  return { pair, asked };
}

async function eventually(check, what) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("/v1/me says the account service takes requests from new devices", TEST, async () => {
  const cookie = await signInAs(worker.http, google, person("me"), APP);
  const me = await call(worker, "GET", "/v1/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.device_requests, true);
});

test("a new device of the account joins by approval; the sealed invitation is passed on untouched", TEST, async () => {
  const { state, owner, cookie: laptop } = await claimedHome();
  const phone = await signInAs(worker.http, google, owner, APP);
  const relayed = state.seen.length;

  const { pair: device, asked } = await ask(worker, phone, state, "  Home Screen app‮ on iPhone\n");
  assert.equal(asked.status, 201, asked.text);
  const id = asked.json.id;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(asked.json.status, "waiting");
  assert.equal(asked.json.label, "Home Screen app on iPhone", "control and direction marks are taken out");
  const lasts = Date.parse(asked.json.expires_at) - Date.parse(asked.json.created_at);
  assert.equal(lasts, 600_000, "a request lasts 10 minutes");

  // The laptop, signed in to the same account and holding a key at the home, sees it.
  const listed = await call(worker, "GET", requests(state), { cookie: laptop });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.items.length, 1);
  const item = listed.json.items[0];
  assert.equal(item.commitment, await commitmentOf(device.publicKey));
  assert.equal(item.approver_key, null);
  assert.equal(item.device_key, null);

  // The new device shows its key only once a device answered with its own.
  assert.equal((await call(worker, "POST", `${requests(state)}/${id}/key`, { cookie: phone, body: { device_key: device.publicKey } })).json.code, "NOT_ANSWERED");
  const approver = await keyPair();
  const answered = await call(worker, "POST", `${requests(state)}/${id}/answer`, { cookie: laptop, body: { approver_key: approver.publicKey } });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(answered.json.status, "answered");
  assert.equal((await call(worker, "POST", `${requests(state)}/${id}/answer`, { cookie: laptop, body: { approver_key: approver.publicKey } })).status, 200, "the same key again");
  const other = await keyPair();
  const second = await call(worker, "POST", `${requests(state)}/${id}/answer`, { cookie: laptop, body: { approver_key: other.publicKey } });
  assert.equal(second.status, 409);
  assert.equal(second.json.code, "ALREADY_ANSWERED");
  assert.equal((await call(worker, "POST", `${requests(state)}/${id}/approve`, { cookie: laptop, body: { sealed: "AAAA" } })).json.code, "NOT_READY");

  const seen = await call(worker, "GET", `${requests(state)}/${id}`, { cookie: phone });
  assert.equal(seen.json.approver_key, approver.publicKey);
  // Another key than the one committed to is refused.
  const swapped = await call(worker, "POST", `${requests(state)}/${id}/key`, { cookie: phone, body: { device_key: other.publicKey } });
  assert.equal(swapped.status, 400);
  assert.equal(swapped.json.code, "COMMITMENT_MISMATCH");
  const shown = await call(worker, "POST", `${requests(state)}/${id}/key`, { cookie: phone, body: { device_key: device.publicKey } });
  assert.equal(shown.status, 200, shown.text);
  assert.equal(shown.json.status, "checking");
  assert.equal((await call(worker, "POST", `${requests(state)}/${id}/collect`, { cookie: phone })).json.code, "NOT_APPROVED");

  // Both screens show the same code, each from what it got through the cloud.
  const onLaptop = (await call(worker, "GET", requests(state), { cookie: laptop })).json.items[0];
  assert.equal(await commitmentOf(onLaptop.device_key), item.commitment, "the laptop checks the key against the commitment it saw first");
  const laptopCode = await checkCode(id, approver.publicKey, onLaptop.device_key);
  const phoneCode = await checkCode(id, seen.json.approver_key, device.publicKey);
  assert.equal(laptopCode, phoneCode);
  assert.match(laptopCode, /^[0-9]{6}$/);

  // Approve: the invitation sealed to the phone.
  const invitation = `${state.home}.${randomHex(4)}.${randomBytes(32).toString("hex")}`;
  const sealed = await sealInvitation(approver, { requestId: id, home: state.home, deviceKey: onLaptop.device_key }, invitation);
  const approved = await call(worker, "POST", `${requests(state)}/${id}/approve`, { cookie: laptop, body: { sealed } });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.status, "approved");
  assert.equal((await call(worker, "POST", `${requests(state)}/${id}/approve`, { cookie: laptop, body: { sealed } })).json.code, "ALREADY_APPROVED");
  const waiting = await call(worker, "GET", `${requests(state)}/${id}`, { cookie: phone });
  assert.equal(waiting.json.status, "approved");
  assert.ok(!waiting.text.includes(sealed), "only collect gives the sealed invitation");

  const collected = await call(worker, "POST", `${requests(state)}/${id}/collect`, { cookie: phone });
  assert.equal(collected.status, 200, collected.text);
  assert.equal(collected.json.sealed, sealed, "the cloud passes the sealed value on as it came");
  assert.equal(collected.json.approver_key, approver.publicKey);
  assert.equal(await openInvitation(device, { requestId: id, home: state.home, approverKey: collected.json.approver_key }, collected.json.sealed), invitation);

  // Collected once: the request is gone.
  assert.equal((await call(worker, "POST", `${requests(state)}/${id}/collect`, { cookie: phone })).status, 404);
  assert.equal((await call(worker, "GET", `${requests(state)}/${id}`, { cookie: phone })).status, 404);
  assert.deepEqual((await call(worker, "GET", requests(state), { cookie: laptop })).json.items, []);
  assert.equal(state.seen.length, relayed, "nothing was sent to the home");
});

test("only the account's own devices see, answer, approve, collect or delete its requests", TEST, async () => {
  const { state, owner, cookie: dana } = await claimedHome();
  const phone = await signInAs(worker.http, google, owner, APP);
  const { asked } = await ask(worker, phone, state);
  const id = asked.json.id;

  // Avi belongs to the home and uses a key there, as another account.
  const avi = person("avi");
  const aviCookie = await signInAs(worker.http, google, avi, APP);
  const invitationId = randomHex(4);
  const secret = randomBytes(32).toString("hex");
  state.invitations.set(invitationId, secret);
  const registered = await call(worker, "POST", `/v1/homes/${state.home}/invitations`, { cookie: dana, body: { invitation_id: invitationId, email: avi.email, expires_at: new Date(Date.now() + 3600_000).toISOString() } });
  assert.equal(registered.status, 201, registered.text);
  const join = { id: randomHex(8), ts: nowSeconds(), method: "POST", path: "/v1/auth/join", body: { name: "Avi" } };
  const joined = await call(worker, "POST", "/v1/join", { cookie: aviCookie, body: { home_id: state.home, invitation_id: invitationId, envelope: seal(invitationKey(secret), { home: state.home, key: invitationId }, "req", JSON.stringify(join)) } });
  assert.equal(joined.status, 200, joined.text);

  const approver = await keyPair();
  assert.deepEqual((await call(worker, "GET", requests(state), { cookie: aviCookie })).json.items, [], "Avi sees none of Dana's requests");
  for (const [method, path, body] of [
    ["GET", `${requests(state)}/${id}`],
    ["POST", `${requests(state)}/${id}/answer`, { approver_key: approver.publicKey }],
    ["POST", `${requests(state)}/${id}/key`, { device_key: approver.publicKey }],
    ["POST", `${requests(state)}/${id}/approve`, { sealed: "AAAA" }],
    ["POST", `${requests(state)}/${id}/collect`],
    ["DELETE", `${requests(state)}/${id}`],
  ]) {
    const refused = await call(worker, method, path, { cookie: aviCookie, body });
    assert.equal(refused.status, 404, `${method} ${path}: ${refused.text}`);
  }
  assert.equal((await call(worker, "GET", `${requests(state)}/${id}`, { cookie: dana })).json.approver_key, null, "nothing changed");

  // An account outside the home, and no session.
  const noa = await signInAs(worker.http, google, person("noa"), APP);
  assert.equal((await call(worker, "GET", requests(state), { cookie: noa })).json.code, "NOT_A_MEMBER");
  assert.equal((await ask(worker, noa, state)).asked.json.code, "NOT_A_MEMBER");
  assert.equal((await call(worker, "GET", requests(state))).status, 401);
  const elsewhere = await call(worker, "POST", `${requests(state)}/${id}/answer`, { cookie: dana, body: { approver_key: approver.publicKey }, origin: "https://evil.example" });
  assert.equal(elsewhere.status, 403);
  assert.equal(elsewhere.json.code, "ORIGIN_NOT_ALLOWED");
  const preflight = await call(worker, "OPTIONS", `${requests(state)}/${id}/answer`, { origin: APP });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), APP);

  // The owner's own other session declines it.
  assert.equal((await call(worker, "DELETE", `${requests(state)}/${id}`, { cookie: dana })).status, 204);
  assert.equal((await call(worker, "GET", `${requests(state)}/${id}`, { cookie: phone })).status, 404);
});

test("the approving account must use a key at the home, an admin's when the controller names them", TEST, async () => {
  const { state, owner, cookie: dana, keyId } = await claimedHome({ used: false });
  const phone = await signInAs(worker.http, google, owner, APP);
  // No key of this account is known at the home yet: nobody could approve.
  const none = (await ask(worker, phone, state)).asked;
  assert.equal(none.status, 409);
  assert.equal(none.json.code, "NO_APPROVER");

  await useKey(worker, dana, state, keyId);
  const { asked } = await ask(worker, phone, state);
  assert.equal(asked.status, 201, asked.text);

  // The controller says which keys are admins': this account's is not. (A request the probe made
  // meanwhile is withdrawn at once.)
  const probe = async () => {
    const again = (await ask(worker, phone, state)).asked;
    if (again.status === 201) await call(worker, "DELETE", `${requests(state)}/${again.json.id}`, { cookie: phone });
    return again.status === 201 ? "asked" : again.json?.code;
  };
  const memberKey = randomHex(4);
  state.connection.sendJson({ type: "keys", ids: [keyId, memberKey], admins: [memberKey] });
  await eventually(async () => (await probe()) === "NO_APPROVER", "the admin list to count");
  state.connection.sendJson({ type: "keys", ids: [keyId, memberKey], admins: [keyId] });
  await eventually(async () => (await probe()) === "asked", "an admin key to count");

  // The account's key is revoked at home: it uses none there any more (the owner stays a member).
  state.connection.sendJson({ type: "keys", ids: [memberKey], admins: [memberKey] });
  const approver = await keyPair();
  await eventually(async () => (await call(worker, "POST", `${requests(state)}/${asked.json.id}/answer`, { cookie: dana, body: { approver_key: approver.publicKey } })).json?.code === "NO_KEY_AT_HOME", "the key to go");
  const approve = await call(worker, "POST", `${requests(state)}/${asked.json.id}/approve`, { cookie: dana, body: { sealed: "AAAA" } });
  assert.equal(approve.status, 403);
  assert.equal(approve.json.code, "NO_KEY_AT_HOME");
});

test("what a request takes is checked", TEST, async () => {
  const { state, cookie } = await claimedHome();
  const pair = await keyPair();
  const commitment = await commitmentOf(pair.publicKey);
  for (const body of [
    { label: "", commitment },
    { label: "x".repeat(49), commitment },
    { label: "‏‪", commitment },
    { label: "Phone", commitment: "nothex" },
    { label: "Phone" },
    { label: 7, commitment },
  ]) {
    const refused = await call(worker, "POST", requests(state), { cookie, body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.json.code, "INVALID_REQUEST");
  }
  const asked = await call(worker, "POST", requests(state), { cookie, body: { label: "x".repeat(48), commitment } });
  assert.equal(asked.status, 201, asked.text);
  const id = asked.json.id;
  for (const key of ["", "AAAA", `${"A".repeat(43)}B=`, `${"A".repeat(44)}`, pair.publicKey.slice(0, -1)]) {
    assert.equal((await call(worker, "POST", `${requests(state)}/${id}/answer`, { cookie, body: { approver_key: key } })).status, 400, key);
  }
  const approver = await keyPair();
  assert.equal((await call(worker, "POST", `${requests(state)}/${id}/answer`, { cookie, body: { approver_key: approver.publicKey } })).status, 200);
  assert.equal((await call(worker, "POST", `${requests(state)}/${id}/key`, { cookie, body: { device_key: pair.publicKey } })).status, 200);
  for (const sealed of ["", "not base64!", "A".repeat(513), 12]) {
    const refused = await call(worker, "POST", `${requests(state)}/${id}/approve`, { cookie, body: { sealed } });
    assert.equal(refused.status, 400, String(sealed).slice(0, 20));
  }
  assert.equal((await call(worker, "GET", `${requests(state)}/${randomHex(16)}`, { cookie })).status, 404);
});

test("an account has at most 3 requests open and starts at most 10 an hour", TEST, async () => {
  const { state, owner } = await claimedHome();
  const phone = await signInAs(worker.http, google, owner, APP);
  const started = async () => (await ask(worker, phone, state)).asked;
  const open = [];
  for (let count = 1; count <= 3; count += 1) {
    const asked = await started();
    assert.equal(asked.status, 201, asked.text);
    open.push(asked.json.id);
  }
  const fourth = await started();
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.code, "DEVICE_REQUEST_LIMIT_REACHED");
  assert.match(fourth.json.detail, /at a time/);
  const withdraw = async () => {
    for (const id of open.splice(0)) assert.equal((await call(worker, "DELETE", `${requests(state)}/${id}`, { cookie: phone })).status, 204);
  };
  await withdraw();
  // Starts so far: 4. Six more fit in the hour, three at a time.
  for (let count = 5; count <= 10; count += 1) {
    if (open.length === 3) await withdraw();
    const asked = await started();
    assert.equal(asked.status, 201, `start ${count}: ${asked.text}`);
    open.push(asked.json.id);
  }
  await withdraw();
  const eleventh = await started();
  assert.equal(eleventh.status, 429);
  assert.match(eleventh.json.detail, /an hour/);
});

test("requests expire: they are gone when read, stop counting, and the daily clean-up runs", TEST, async () => {
  const { state, owner, cookie: laptop } = await claimedHome({ on: shortWorker });
  const phone = await signInAs(shortWorker.http, google, owner, APP);
  const ids = [];
  for (let count = 0; count < 3; count += 1) {
    const { asked } = await ask(shortWorker, phone, state);
    assert.equal(asked.status, 201, asked.text);
    ids.push(asked.json.id);
  }
  assert.equal((await call(shortWorker, "GET", requests(state), { cookie: laptop })).json.items.length, 3);
  await sleep(SHORT_SECONDS * 1000 + 500);
  assert.deepEqual((await call(shortWorker, "GET", requests(state), { cookie: laptop })).json.items, []);
  assert.equal((await call(shortWorker, "GET", `${requests(state)}/${ids[0]}`, { cookie: phone })).status, 404);
  const approver = await keyPair();
  assert.equal((await call(shortWorker, "POST", `${requests(state)}/${ids[1]}/answer`, { cookie: laptop, body: { approver_key: approver.publicKey } })).status, 404);
  assert.equal((await call(shortWorker, "POST", `${requests(state)}/${ids[2]}/collect`, { cookie: phone })).status, 404);
  // Expired requests no longer count against the 3 open.
  const { asked } = await ask(shortWorker, phone, state);
  assert.equal(asked.status, 201, asked.text);
  await sleep(SHORT_SECONDS * 1000 + 500);
  const cron = await fetch(`${shortWorker.http}/__scheduled`);
  assert.equal(cron.status, 200);
  await eventually(() => /device_requests_purged/.test(shortWorker.output()), "the daily clean-up's log line");
});

test("signing out everywhere, and leaving the home, end the account's requests", TEST, async () => {
  const { state, owner } = await claimedHome();
  const phone = await signInAs(worker.http, google, owner, APP);
  const { asked } = await ask(worker, phone, state);
  assert.equal(asked.status, 201, asked.text);
  assert.equal((await call(worker, "POST", "/auth/logout?everywhere=1", { cookie: phone })).status, 204);
  const again = await signInAs(worker.http, google, owner, APP);
  assert.equal((await call(worker, "GET", `${requests(state)}/${asked.json.id}`, { cookie: again })).status, 404);

  // Avi, a member with a key, asks from a new device, then leaves the home.
  const avi = person("avi");
  const aviCookie = await signInAs(worker.http, google, avi, APP);
  const joinAs = async () => {
    const invitationId = randomHex(4);
    const secret = randomBytes(32).toString("hex");
    state.invitations.set(invitationId, secret);
    const registered = await call(worker, "POST", `/v1/homes/${state.home}/invitations`, { cookie: again, body: { invitation_id: invitationId, email: avi.email, expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    assert.equal(registered.status, 201, registered.text);
    const join = { id: randomHex(8), ts: nowSeconds(), method: "POST", path: "/v1/auth/join", body: { name: "Avi" } };
    const joined = await call(worker, "POST", "/v1/join", { cookie: aviCookie, body: { home_id: state.home, invitation_id: invitationId, envelope: seal(invitationKey(secret), { home: state.home, key: invitationId }, "req", JSON.stringify(join)) } });
    assert.equal(joined.status, 200, joined.text);
  };
  await joinAs();
  const aviPhone = await signInAs(worker.http, google, avi, APP);
  const aviAsked = (await ask(worker, aviPhone, state)).asked;
  assert.equal(aviAsked.status, 201, aviAsked.text);
  const me = await call(worker, "GET", "/v1/me", { cookie: aviCookie });
  assert.equal((await call(worker, "DELETE", `/v1/homes/${state.home}/members/${me.json.id}`, { cookie: aviCookie })).status, 204);
  await joinAs();
  assert.equal((await call(worker, "GET", `${requests(state)}/${aviAsked.json.id}`, { cookie: aviPhone })).status, 404, "the request went with the membership");
});
