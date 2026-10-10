// Direct HTTPS's parts (1.12.0, ADR-082) in Node, without the Worker: what the Worker reads of a
// certificate request and a certificate (cloud/src/x509.js), which requests and addresses it takes
// (https.js), the object's one alarm shared by the alerts and the orders (alarms.js), and the ACME
// client (acme.js) through a whole order against the fake ACME server and the fake Cloudflare zone.
//   node --test tests/cloud/https-parts.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { AcmeClient, AcmeError } from "../../cloud/src/acme.js";
import { Alarms } from "../../cloud/src/alarms.js";
import { checkRequest, privateAddress } from "../../cloud/src/https.js";
import { pem as pemOf, pemBlocks, readCertificate, readRequest } from "../../cloud/src/x509.js";
import { startFakeAcme } from "./fake-acme.mjs";
import { startFakeCloudflare } from "./fake-cloudflare.mjs";
import { accountKeyLine, keyPair, makeCertificate, makeRequest, pem, spkiOf } from "./x509-build.mjs";

const NAME = "abcdefghij234567klmn.dlhome.cc";
const DAY = 24 * 3600 * 1000;

let acme;
let cloudflare;

before(async () => {
  cloudflare = await startFakeCloudflare();
  acme = await startFakeAcme({ dns: cloudflare });
});

after(async () => {
  await acme?.close();
  await cloudflare?.close();
});

const sha256 = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

test("a request as Director makes it: the name as CN only, its P-256 key", () => {
  const keys = keyPair();
  const request = readRequest(makeRequest(NAME, keys));
  assert.deepEqual(request.names, [NAME]);
  assert.equal(request.otherNames, 0);
  assert.equal(request.key.type, "ec");
  assert.equal(request.key.curve, "P-256");
  assert.equal(request.key.bits, 256);
  assert.equal(sha256(request.key.spki), sha256(spkiOf(keys.publicKey)));
  // A subjectAltName too: its names count; another case is the same name.
  const both = readRequest(makeRequest(NAME.toUpperCase(), keys, { sans: [NAME, "other.dlhome.cc"] }));
  assert.deepEqual(both.names.sort(), [NAME, "other.dlhome.cc"].sort());
  const rsa = readRequest(makeRequest(NAME, keyPair("rsa", 2048)));
  assert.equal(rsa.key.type, "rsa");
  assert.equal(rsa.key.bits, 2048);
  assert.equal(readRequest(makeRequest(NAME, keyPair("P-384"))).key.curve !== "P-256", true);
  assert.equal(readRequest(Buffer.from("not der")), null);
});

test("a certificate: its names, issuer, validity and key", () => {
  const keys = keyPair();
  const issuer = { name: "YE1", ...keyPair() };
  const notBefore = new Date(Date.UTC(2026, 9, 10, 12, 0, 0));
  const notAfter = new Date(Date.UTC(2027, 0, 8, 12, 0, 0));
  const der = makeCertificate({ spki: spkiOf(keys.publicKey), names: [NAME], issuer, notBefore, notAfter });
  const leaf = readCertificate(der);
  assert.deepEqual(leaf.names, [NAME]);
  assert.equal(leaf.issuerCn, "YE1");
  assert.equal(leaf.notBefore, notBefore.getTime());
  assert.equal(leaf.notAfter, notAfter.getTime());
  assert.equal(sha256(leaf.key.spki), sha256(spkiOf(keys.publicKey)));
  // PEM both ways.
  const text = pemOf(der, "CERTIFICATE") + pem(der, "CERTIFICATE");
  const blocks = pemBlocks(text, "CERTIFICATE");
  assert.equal(blocks.length, 2);
  assert.deepEqual(Buffer.from(blocks[0]), Buffer.from(der));
  assert.equal(pemBlocks("-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----", "CERTIFICATE"), null);
});

test("the requests the Worker takes: one name, the home's, with a P-256 or RSA key of 2048 bits or more", async () => {
  const good = await checkRequest(pem(makeRequest(NAME, keyPair()), "CERTIFICATE REQUEST"), NAME);
  assert.equal(good.code, undefined);
  assert.match(good.spki, /^[0-9a-f]{64}$/);
  assert.equal((await checkRequest(pem(makeRequest(NAME, keyPair("rsa", 2048)), "CERTIFICATE REQUEST"), NAME)).code, undefined);
  const refused = [
    [pem(makeRequest(NAME, keyPair(), { sans: [NAME, "zzzzzzzzzzzzzzzzzzzz.dlhome.cc"] }), "CERTIFICATE REQUEST"), "INVALID_CSR"],
    [pem(makeRequest("zzzzzzzzzzzzzzzzzzzz.dlhome.cc", keyPair()), "CERTIFICATE REQUEST"), "INVALID_CSR"],
    [pem(makeRequest(NAME, keyPair("P-384")), "CERTIFICATE REQUEST"), "INVALID_CSR"],
    [pem(makeRequest(NAME, keyPair("rsa", 1024)), "CERTIFICATE REQUEST"), "INVALID_CSR"],
    [pem(makeRequest(NAME, keyPair()), "CERTIFICATE REQUEST").repeat(2), "INVALID_CSR"],
    ["hello", "INVALID_CSR"],
    [42, "INVALID_REQUEST"],
    ["x".repeat(9000), "INVALID_REQUEST"],
  ];
  for (const [text, code] of refused) {
    assert.equal((await checkRequest(text, NAME)).code, code, String(text).slice(0, 40));
  }
});

test("only private IPv4 addresses go in the A record", () => {
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.201"]) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.1.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "192.168.1", "192.168.1.256", "", null]) {
    assert.equal(privateAddress(ip), false, String(ip));
  }
});

// Durable Object storage, as far as alarms.js uses it.
function fakeStorage() {
  const data = new Map();
  return {
    data,
    alarm: null,
    async get(key) {
      if (Array.isArray(key)) return new Map(key.filter((item) => data.has(item)).map((item) => [item, data.get(item)]));
      return data.get(key);
    },
    async put(key, value) {
      if (typeof key === "object") {
        for (const [name, item] of Object.entries(key)) data.set(name, item);
      } else {
        data.set(key, value);
      }
    },
    async delete(key) {
      for (const item of Array.isArray(key) ? key : [key]) data.delete(item);
    },
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(at) {
      this.alarm = at;
    },
    async deleteAlarm() {
      this.alarm = null;
    },
  };
}

test("one alarm for the alerts and the orders: the earliest, and each runs when due", async () => {
  const storage = fakeStorage();
  const alarms = new Alarms(storage);
  // An object whose alarm was set before 1.12.0: the alerts'.
  storage.alarm = 1000;
  assert.deepEqual(await alarms.due(1000), ["alerts"]);
  const alerts = alarms.storageFor("alerts");
  await alerts.setAlarm(5000);
  await alarms.set("https", 3000);
  assert.equal(storage.alarm, 3000);
  assert.equal(await alerts.getAlarm(), 5000, "the alerts see their own");
  await alerts.put("alerts_on", true);
  assert.equal(await alerts.get("alerts_on"), true, "the rest is the storage's");
  assert.deepEqual(await alarms.due(3000), ["https"]);
  await alarms.arm();
  assert.equal(storage.alarm, 5000);
  await alerts.deleteAlarm();
  assert.equal(storage.alarm, null);
  assert.equal(await alerts.getAlarm(), null);
  await alarms.set("https", 7000);
  await alerts.setAlarm(new Date(6000));
  assert.equal(storage.alarm, 6000);
  assert.deepEqual(await alarms.due(9000), ["alerts", "https"]);
  assert.deepEqual(await alarms.due(9000), []);
});

test("the ACME client through a whole order: account, dns-01, finalize, certificate", async () => {
  const client = new AcmeClient({ directoryUrl: acme.directory, accountKey: accountKeyLine() });
  acme.faults.badNonce = 1; // its first signed request: tried again with a fresh nonce
  const { url, order } = await client.newOrder(NAME);
  assert.match(client.kid, /\/acct\/\d+$/);
  assert.equal(order.status, "pending");
  assert.match(url, /\/order\/\d+$/);
  const authz = await client.get(order.authorizations[0]);
  const challenge = authz.challenges.find((item) => item.type === "dns-01");
  // Its TXT record, where the fake ACME server looks.
  cloudflare.records.set("txt-1", { id: "txt-1", type: "TXT", name: `_acme-challenge.${NAME}`, content: `"${await client.dnsValue(challenge.token)}"`, ttl: 60, proxied: false });
  await client.respond(challenge.url);
  assert.equal((await client.get(order.authorizations[0])).status, "valid");
  const keys = keyPair();
  const csr = Buffer.from(makeRequest(NAME, keys)).toString("base64url");
  const finalized = await client.finalize(order.finalize, csr);
  assert.equal(finalized.status, "valid");
  const chain = await client.download(finalized.certificate);
  const blocks = pemBlocks(chain, "CERTIFICATE");
  assert.equal(blocks.length, 2, "the leaf and its issuer");
  const leaf = readCertificate(blocks[0]);
  assert.deepEqual(leaf.names, [NAME]);
  assert.equal(sha256(leaf.key.spki), sha256(spkiOf(keys.publicKey)));
  assert.equal(leaf.issuerCn, "YE1");
  assert.ok(leaf.notAfter - leaf.notBefore > 80 * DAY);
  cloudflare.records.delete("txt-1");

  // The same key again: the same account, found by its key.
  const again = new AcmeClient({ directoryUrl: acme.directory, accountKey: client.accountKeyPem });
  await again.account();
  assert.equal(again.kid, client.kid);

  // A wrong TXT record: the authorization is invalid, with why.
  const { order: other } = await client.newOrder(NAME);
  const otherChallenge = (await client.get(other.authorizations[0])).challenges.find((item) => item.type === "dns-01");
  await client.respond(otherChallenge.url);
  const failed = await client.get(other.authorizations[0]);
  assert.equal(failed.status, "invalid");
  assert.match(failed.challenges.find((item) => item.type === "dns-01").error.type, /unauthorized$/);

  // A rate limit: its type and Retry-After.
  acme.faults.rateLimited = true;
  await assert.rejects(client.newOrder(NAME), (error) => error instanceof AcmeError && error.kind === "rateLimited" && error.retryAfter === 3600 && !error.transient);
  acme.faults.rateLimited = false;
  // A server error is worth trying again; a key that is not one is not.
  acme.faults.serverError = 1;
  await assert.rejects(client.newOrder(NAME), (error) => error instanceof AcmeError && error.transient);
  await assert.rejects(new AcmeClient({ directoryUrl: acme.directory, accountKey: "nonsense" }).account(), (error) => error instanceof AcmeError && error.kind === "accountKey");
  await assert.rejects(new AcmeClient({ directoryUrl: "http://127.0.0.1:1/directory", accountKey: client.accountKeyPem }).account(), (error) => error.transient);
});
