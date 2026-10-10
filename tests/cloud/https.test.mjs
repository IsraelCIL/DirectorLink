// Direct HTTPS in the Worker (1.12.0, ADR-082) end to end: the Worker under `wrangler dev`, a fake
// Google, a fake ACME server (Let's Encrypt), a fake Cloudflare DNS API and a fake controller (the
// relay protocol). A claimed home's controller asks for a certificate for its CSR and gets it tens of
// milliseconds later (the order runs from the object's alarm), with the name's A record at its LAN
// address; the same key's fresh certificate is given again without an order; one name a home; what
// the Worker refuses; the address followed; off deletes the record; the limits; Let's Encrypt's
// failures; and without the secrets, HTTPS_UNAVAILABLE and nothing else.
//   node --test tests/cloud/https.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { connectDriver, randomHex } from "../../scripts/relay_smoke.mjs";
import { readCertificate, pemBlocks } from "../../cloud/src/x509.js";
import { startFakeAcme } from "./fake-acme.mjs";
import { DNS_TOKEN, ZONE_ID, startFakeCloudflare } from "./fake-cloudflare.mjs";
import { googleVars, signInAs, startFakeGoogle } from "./fake-google.mjs";
import { STARTUP_MS, startWorker } from "./worker.mjs";
import { accountKeyLine, keyPair, makeRequest, pem, spkiOf } from "./x509-build.mjs";

const APP = "http://localhost:8080";
const TEST = { timeout: 60_000 };
const ACCOUNT_KEY = accountKeyLine();

let worker;
let bare;
let google;
let acme;
let cloudflare;
const drivers = [];

before(async () => {
  google = await startFakeGoogle();
  cloudflare = await startFakeCloudflare();
  acme = await startFakeAcme({ dns: cloudflare });
  const common = { ...googleVars(google, APP, "https://api.directorlink.test"), REQUEST_TIMEOUT_MS: 3000 };
  [worker, bare] = await Promise.all([
    startWorker({
      migrate: true,
      devVars: {
        ...common,
        DLHOME_DNS_TOKEN: DNS_TOKEN,
        DLHOME_ZONE_ID: ZONE_ID,
        DLHOME_DNS_API: cloudflare.api,
        ACME_DIRECTORY: acme.directory,
        ACME_ACCOUNT_KEY: ACCOUNT_KEY,
        HTTPS_DNS_WAIT_MS: 50,
        HTTPS_POLL_MS: 50,
        HTTPS_RETRY_MS: "50,50,50,50",
      },
    }),
    // No secrets: Direct HTTPS is off at the Worker.
    startWorker({ migrate: true, devVars: { ...common, DLHOME_ZONE_ID: ZONE_ID, ACME_DIRECTORY: acme.directory, DLHOME_DNS_API: cloudflare.api } }),
  ]);
}, { timeout: 2 * STARTUP_MS + 10_000 });

after(async () => {
  await Promise.all(drivers.splice(0).map((connection) => connection.close()));
  await worker?.stop();
  await bare?.stop();
  await acme?.close();
  await cloudflare?.close();
  await google?.close();
});

const sha256 = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

function newName() {
  const letters = "abcdefghijklmnopqrstuvwxyz234567";
  return `${Array.from({ length: 20 }, () => letters[Math.floor(Math.random() * 32)]).join("")}.dlhome.cc`;
}

// A controller (DirectorLink 1.12.0) at a home: it answers claims, keeps every message the relay sent.
async function controller(target = worker, state = { home: randomHex(16), secret: randomHex(32), claimToken: randomHex(24) }) {
  const connection = await connectDriver({ url: target.ws, home: state.home, secret: state.secret, pingIntervalMs: 0, silenceTimeoutMs: 0, hello: false });
  drivers.push(connection);
  state.connection = connection;
  state.received = [];
  connection.on("unknown", (text) => {
    const message = JSON.parse(text);
    state.received.push(message);
    if (message.type === "claim") {
      connection.sendJson({ type: "claim_result", id: message.id, ok: message.token === state.claimToken });
    }
  });
  connection.sendJson({ type: "hello", home: state.home, version: "1.12.0", ping_s: 5, features: ["scene_links", "alerts_gone", "users", "resend", "alert_acks"], instance: randomHex(16) });
  state.features = await waitFor(state, (message) => message.type === "relay_features");
  return state;
}

// The first message from the relay (since `from`, an index into received) that `match` takes.
async function waitFor(state, match, { from = 0, ms = 10_000 } = {}) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = state.received.slice(from).find(match);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(`no such message within ${ms} ms; got ${JSON.stringify(state.received.map((item) => item.type))}`);
}

async function call(method, apiPath, { cookie, body, target = worker } = {}) {
  const headers = { Origin: APP };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${target.http}${apiPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, text };
}

async function claimedController(target = worker) {
  const state = await controller(target);
  const tag = randomHex(4);
  const cookie = await signInAs(target.http, google, { sub: `google-${tag}`, email: `dana-${tag}@example.com`, name: "Dana" }, APP);
  const claimed = await call("POST", "/v1/homes/claim", { cookie, body: { home_id: state.home, claim_token: state.claimToken }, target });
  assert.equal(claimed.status, 200, claimed.text);
  return state;
}

// Sends `message` (with a new id) and waits for its answer of `type`.
async function ask(state, message, type) {
  const id = randomHex(8);
  const from = state.received.length;
  state.connection.sendJson({ ...message, id });
  return waitFor(state, (item) => item.type === type && item.id === id, { from });
}

// Asks for a certificate for a new P-256 key (or `keys`), for `name`.
async function askCertificate(state, name, { keys = keyPair(), ip = "192.168.1.201", csr } = {}) {
  const answer = await ask(state, { type: "https_certificate", name, ip, csr: csr ?? pem(makeRequest(name, keys), "CERTIFICATE REQUEST") }, "https_certificate_result");
  return { answer, keys };
}

// The final result of a pending request: the next https_certificate_result with that id.
async function result(state, id) {
  return waitFor(state, (item) => item.type === "https_certificate_result" && item.id === id && item.status !== "pending", { ms: 20_000 });
}

test("the relay says it issues certificates", TEST, async () => {
  const state = await controller();
  assert.deepEqual(state.features.features, ["alert_acks", "https"]);
});

test("a claimed home's controller gets its certificate, and the name's A record its address", TEST, async () => {
  const state = await claimedController();
  const name = newName();
  const ordersBefore = acme.log.orders;
  const { answer, keys } = await askCertificate(state, name);
  assert.deepEqual({ ok: answer.ok, status: answer.status }, { ok: true, status: "pending" }, JSON.stringify(answer));
  const issued = await result(state, answer.id);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(issued.status, "issued");
  assert.equal(issued.name, name);
  const leaf = readCertificate(pemBlocks(issued.certificate, "CERTIFICATE")[0]);
  assert.equal(sha256(leaf.key.spki), sha256(spkiOf(keys.publicKey)), "for the controller's own key");
  assert.deepEqual(leaf.names, [name]);
  assert.equal(new Date(leaf.notAfter).toISOString(), issued.not_after);
  const chain = pemBlocks(issued.chain, "CERTIFICATE");
  assert.equal(chain.length, 1, "its issuer");
  assert.equal(readCertificate(chain[0]).names.length, 0);
  assert.equal(acme.log.orders, ordersBefore + 1);
  // The A record: the controller's LAN address, DNS only; the challenge's TXT record is gone.
  const records = cloudflare.find(name, "A");
  assert.equal(records.length, 1);
  assert.deepEqual({ content: records[0].content, ttl: records[0].ttl, proxied: records[0].proxied }, { content: "192.168.1.201", ttl: 3600, proxied: false });
  assert.equal(cloudflare.find(`_acme-challenge.${name}`).length, 0);

  // Asked again with the same key (a reconnect, a restart): the same certificate at once, no order.
  const again = await askCertificate(state, name, { keys });
  assert.equal(again.answer.status, "issued");
  assert.equal(again.answer.certificate, issued.certificate);
  assert.equal(acme.log.orders, ordersBefore + 1);

  // A new address: the A record follows; the same again changes nothing.
  const moved = await ask(state, { type: "https", name, ip: "192.168.1.77" }, "https_result");
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(cloudflare.find(name, "A")[0].content, "192.168.1.77");
  const writes = cloudflare.calls.filter((item) => item.method !== "GET").length;
  assert.equal((await ask(state, { type: "https", name, ip: "192.168.1.77" }, "https_result")).ok, true);
  assert.equal(cloudflare.calls.filter((item) => item.method !== "GET").length, writes, "nothing written again");
  assert.equal((await ask(state, { type: "https", name, ip: "8.8.8.8" }, "https_result")).code, "ADDRESS_NEEDED");
  assert.equal(cloudflare.find(name, "A")[0].content, "192.168.1.77");

  // Turned off: the record goes.
  const off = await ask(state, { type: "https", name: null }, "https_result");
  assert.equal(off.ok, true);
  assert.equal(cloudflare.find(name, "A").length, 0);
  // On again, the same key: its certificate, and the record back.
  const back = await askCertificate(state, name, { keys });
  assert.equal(back.answer.status, "issued");
  assert.equal(cloudflare.find(name, "A")[0].content, "192.168.1.201");

  const output = worker.output();
  for (const event of ["https_certificate_requested", "https_certificate_issued", "https_dns_updated", "https_dns_deleted"]) {
    assert.match(output, new RegExp(`"event":"${event}"`), event);
  }
  for (const secret of ["PRIVATE KEY", "BEGIN CERTIFICATE", "192.168.1.201", "192.168.1.77", issued.certificate.split("\n")[1]]) {
    assert.ok(!output.includes(secret), `never in the Worker's log: ${secret.slice(0, 30)}`);
  }
});

test("one name a home: another home may not take it, and the home keeps its own", TEST, async () => {
  const first = await claimedController();
  const name = newName();
  const { answer } = await askCertificate(first, name);
  assert.equal(answer.status, "pending");
  await result(first, answer.id);
  const other = await claimedController();
  const taken = (await askCertificate(other, name)).answer;
  assert.deepEqual({ ok: taken.ok, code: taken.code }, { ok: false, code: "NAME_TAKEN" });
  const second = newName();
  const mismatch = (await askCertificate(first, second)).answer;
  assert.deepEqual({ ok: mismatch.ok, code: mismatch.code, name: mismatch.name }, { ok: false, code: "NAME_MISMATCH", name });
  assert.equal((await ask(first, { type: "https", name: second, ip: "192.168.1.5" }, "https_result")).code, "NAME_MISMATCH");
  assert.equal(cloudflare.find(second, "A").length, 0);
});

test("what the Worker refuses", TEST, async () => {
  const unclaimed = await controller();
  assert.equal((await askCertificate(unclaimed, newName())).answer.code, "NOT_CLAIMED");
  assert.equal((await ask(unclaimed, { type: "https", name: newName(), ip: "10.0.0.2" }, "https_result")).code, "NOT_CLAIMED");

  const state = await claimedController();
  const name = newName();
  const refused = async (options, code) => {
    const { answer } = await askCertificate(state, options.name ?? name, options);
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.equal(answer.code, code, JSON.stringify(options).slice(0, 80));
  };
  await refused({ csr: pem(makeRequest(name, keyPair(), { sans: [name, newName()] }), "CERTIFICATE REQUEST") }, "INVALID_CSR");
  await refused({ csr: pem(makeRequest(newName(), keyPair()), "CERTIFICATE REQUEST") }, "INVALID_CSR");
  await refused({ keys: keyPair("P-384") }, "INVALID_CSR");
  await refused({ keys: keyPair("rsa", 1024) }, "INVALID_CSR");
  await refused({ csr: "not a request" }, "INVALID_CSR");
  await refused({ name: "home.dlhome.cc", csr: pem(makeRequest("home.dlhome.cc", keyPair()), "CERTIFICATE REQUEST") }, "INVALID_REQUEST");
  await refused({ name: "abcdefghijabcdefghij.example.com", csr: pem(makeRequest("abcdefghijabcdefghij.example.com", keyPair()), "CERTIFICATE REQUEST") }, "INVALID_REQUEST");
  await refused({ ip: "8.8.8.8" }, "ADDRESS_NEEDED");
  await refused({ ip: "fd00::5" }, "ADDRESS_NEEDED");
  assert.equal(cloudflare.find(name).length, 0, "nothing written");
  // An RSA key of 2048 bits is taken.
  const rsa = await askCertificate(state, name, { keys: keyPair("rsa", 2048) });
  assert.equal(rsa.answer.status, "pending", JSON.stringify(rsa.answer));
  assert.equal((await result(state, rsa.answer.id)).status, "issued");
});

test("at most three orders a home a day", TEST, async () => {
  const state = await claimedController();
  const name = newName();
  for (let index = 0; index < 3; index += 1) {
    const { answer } = await askCertificate(state, name);
    assert.equal(answer.status, "pending", JSON.stringify(answer));
    assert.equal((await result(state, answer.id)).status, "issued");
  }
  const limited = (await askCertificate(state, name)).answer;
  assert.equal(limited.code, "RATE_LIMITED");
  assert.ok(limited.retry_s > 23 * 3600 && limited.retry_s <= 24 * 3600, String(limited.retry_s));
});

test("Let's Encrypt's failures: tried again for a moment, refused for good, rate limited", TEST, async () => {
  const state = await claimedController();
  const name = newName();
  // A bad nonce and a 500 on the way: the steps go again.
  acme.faults.badNonce = 1;
  acme.faults.serverError = 1;
  acme.faults.processing = 1;
  const first = (await askCertificate(state, name)).answer;
  assert.equal((await result(state, first.id)).status, "issued");
  acme.faults.processing = 0;
  assert.match(worker.output(), /"event":"https_step_retried"/);

  // The challenge fails: refused, the TXT record gone.
  acme.faults.failChallenge = true;
  const failing = (await askCertificate(state, name)).answer;
  const failed = await result(state, failing.id);
  acme.faults.failChallenge = false;
  assert.deepEqual({ ok: failed.ok, code: failed.code }, { ok: false, code: "ACME_FAILED" });
  assert.equal(cloudflare.find(`_acme-challenge.${name}`).length, 0);
  assert.match(worker.output(), /"event":"https_certificate_failed"/);

  // Let's Encrypt's own limit: its Retry-After.
  const limitedHome = await claimedController();
  acme.faults.rateLimited = true;
  const asked = (await askCertificate(limitedHome, newName())).answer;
  const limited = await result(limitedHome, asked.id);
  acme.faults.rateLimited = false;
  assert.deepEqual({ ok: limited.ok, code: limited.code, retry_s: limited.retry_s }, { ok: false, code: "RATE_LIMITED", retry_s: 3600 });

  // Cloudflare fails for good: DNS_FAILED.
  const dnsHome = await claimedController();
  cloudflare.state.failNext = 50;
  const dnsAsked = (await askCertificate(dnsHome, newName())).answer;
  const dnsFailed = await result(dnsHome, dnsAsked.id);
  cloudflare.state.failNext = 0;
  assert.equal(dnsFailed.code, "DNS_FAILED");
});

test("a controller away when its certificate is issued gets it when it asks again", TEST, async () => {
  const state = await claimedController();
  const name = newName();
  const keys = keyPair();
  acme.faults.processing = 3;
  const first = (await askCertificate(state, name, { keys })).answer;
  assert.equal(first.status, "pending");
  await state.connection.close();
  acme.faults.processing = 0;
  await sleep(1500);
  const back = await controller(worker, { home: state.home, secret: state.secret, claimToken: state.claimToken });
  const again = (await askCertificate(back, name, { keys })).answer;
  assert.equal(again.status, "issued", JSON.stringify(again));
});

test("without its secrets the Worker answers HTTPS_UNAVAILABLE and does nothing else", TEST, async () => {
  const state = await claimedController(bare);
  assert.deepEqual(state.features.features, ["alert_acks", "https"]);
  const name = newName();
  const before = cloudflare.calls.length;
  const ordersBefore = acme.log.orders;
  assert.equal((await askCertificate(state, name)).answer.code, "HTTPS_UNAVAILABLE");
  assert.equal((await ask(state, { type: "https", name, ip: "192.168.1.5" }, "https_result")).code, "HTTPS_UNAVAILABLE");
  assert.equal((await ask(state, { type: "https", name: null }, "https_result")).code, "HTTPS_UNAVAILABLE");
  assert.equal(cloudflare.calls.length, before);
  assert.equal(acme.log.orders, ordersBefore);
});
