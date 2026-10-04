// Web Push for alerts (cloud/src/web-push.js, ADR-047), in Node: the message encryption against
// RFC 8291's test vector, the VAPID signature (RFC 8292), the settings check, which subscriptions
// are taken, and scripts/vapid_key.mjs.
//   node --test tests/cloud/web-push.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MESSAGE_BYTES, encryptPayload, sendPush, subscriptionKeys, validEndpoint, vapidAuthorization, vapidProblem } from "../../cloud/src/web-push.js";
import { decrypt, startFakePush, vapidVars } from "./fake-push.mjs";

const b = (text) => Buffer.from(text, "base64url");

// RFC 8291, Appendix A.
const VECTOR = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  encrypted: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

test("a message is encrypted exactly as RFC 8291's test vector", async () => {
  const asPublic = b(VECTOR.asPublic);
  const jwk = { kty: "EC", crv: "P-256", d: VECTOR.asPrivate, x: asPublic.subarray(1, 33).toString("base64url"), y: asPublic.subarray(33).toString("base64url") };
  const serverKeys = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
  // The vector has no padding.
  const body = await encryptPayload(b(VECTOR.plaintext).toString("utf8"), { p256dh: VECTOR.uaPublic, auth: VECTOR.auth }, { salt: b(VECTOR.salt), serverKeys, padTo: 0 });
  assert.equal(Buffer.from(body).toString("base64url"), Buffer.concat([b(VECTOR.header), b(VECTOR.encrypted)]).toString("base64url"));
});

test("every alert is padded to the same size, so its length does not say which it is", async () => {
  const push = await startFakePush();
  try {
    const browser = push.subscribe();
    const home = "0123456789abcdef0123456789abcdef";
    const at = "2026-10-03T05:00:00.000Z";
    const sizes = [];
    // The cloud's own alerts, and one the controller seals (ADR-050): every detail is padded to 496
    // bytes, 512 encrypted, 684 characters of base64.
    const sealed = { kind: "sealed", home, key: "0a1b2c3d", at, sealed: { iv: "A".repeat(22) + "==", ct: "A".repeat(684), mac: "A".repeat(43) + "=" } };
    for (const kind of ["offline", "schedule_failed", "sealed"]) {
      const message = JSON.stringify(kind === "sealed" ? sealed : { kind, home, at });
      const body = Buffer.from(await encryptPayload(message, browser.subscription.keys));
      // Header (salt 16, record size 4, key length 1, key 65), the padded record, the tag (16).
      assert.equal(body.length, 86 + MESSAGE_BYTES + 16, kind);
      assert.equal(body.readUInt32BE(16), 4096, "the record size is unchanged");
      assert.equal(decrypt(body, browser), message, "the browser takes the padding off (RFC 8188)");
      sizes.push(body.length);
    }
    assert.equal(new Set(sizes).size, 1, "one size for all");
    // A longer message is not cut: it is only not padded.
    const long = "x".repeat(MESSAGE_BYTES + 10);
    assert.equal(decrypt(Buffer.from(await encryptPayload(long, browser.subscription.keys)), browser), long);
  } finally {
    await push.close();
  }
});

test("each message has its own salt and server key, and only the browser opens it", async () => {
  const push = await startFakePush();
  try {
    const browser = push.subscribe();
    const message = JSON.stringify({ kind: "offline", home: "a".repeat(32), at: "2026-10-03T05:00:00.000Z" });
    const first = Buffer.from(await encryptPayload(message, browser.subscription.keys));
    const second = Buffer.from(await encryptPayload(message, browser.subscription.keys));
    assert.notEqual(first.subarray(0, 86).toString("hex"), second.subarray(0, 86).toString("hex"));
    assert.equal(decrypt(first, browser), message);
    assert.equal(decrypt(second, browser), message);
    assert.throws(() => decrypt(first, push.subscribe()), "another browser cannot open it");
  } finally {
    await push.close();
  }
});

test("the VAPID header is an ES256 JWT for the push service's origin, signed with the configured key", async () => {
  const env = vapidVars();
  const now = Date.parse("2026-10-03T08:00:00Z");
  const header = await vapidAuthorization(env, "https://fcm.googleapis.com/fcm/send/abc:def", now);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(\S+)$/.exec(header);
  assert.ok(match, header);
  assert.equal(match[4], env.VAPID_PUBLIC_KEY);
  assert.deepEqual(JSON.parse(b(match[1]).toString()), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(b(match[2]).toString()), { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://directorlink.io" });
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
  assert.equal(verify("sha256", Buffer.from(`${match[1]}.${match[2]}`), { key, dsaEncoding: "ieee-p1363" }, b(match[3])), true);
});

test("VAPID settings that do not belong together are reported, not used", async () => {
  const good = vapidVars();
  assert.equal(await vapidProblem(good), null);
  assert.match(await vapidProblem({}), /not set/);
  assert.match(await vapidProblem({ ...good, VAPID_PUBLIC_KEY: vapidVars().VAPID_PUBLIC_KEY }), /not the public key/);
  assert.match(await vapidProblem({ ...good, VAPID_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----" }), /not a JWK/);
});

test("only push services' https addresses are taken, with a P-256 key and a 16-byte secret", async () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/QGx",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ]) {
    assert.equal(validEndpoint({}, endpoint), true, endpoint);
  }
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/x",
    "https://example.com/push",
    "https://fcm.googleapis.com.example.com/x",
    "https://user:pass@fcm.googleapis.com/x",
    "https://192.168.1.10/push",
    // Only HTTPS's own port.
    "https://fcm.googleapis.com:8443/fcm/send/x",
    "https://fcm.googleapis.com:22/x",
    "https://web.push.apple.com:80/QGx",
    "not a url",
    `https://fcm.googleapis.com/${"x".repeat(2100)}`,
    42,
  ]) {
    assert.equal(validEndpoint({}, endpoint), false, String(endpoint));
  }
  assert.equal(validEndpoint({}, "https://fcm.googleapis.com:443/fcm/send/x"), true, "443 is HTTPS's own port");
  assert.equal(validEndpoint({ PUSH_TEST_URL: "http://127.0.0.1:9" }, "http://127.0.0.1:9/push/a"), true, "the tests' fake service");

  const push = await startFakePush();
  try {
    const { keys } = push.subscribe().subscription;
    assert.deepEqual(await subscriptionKeys(keys), keys);
    assert.equal(await subscriptionKeys({ ...keys, auth: b64(Buffer.alloc(8)) }), null);
    assert.equal(await subscriptionKeys({ ...keys, p256dh: b64(Buffer.alloc(65, 4)) }), null, "not a point on the curve");
    assert.equal(await subscriptionKeys({ p256dh: keys.p256dh }), null);
    assert.equal(await subscriptionKeys(null), null);
  } finally {
    await push.close();
  }
});

test("a push service's redirect is not followed: the message goes only to the address that was checked", async () => {
  const push = await startFakePush();
  try {
    const target = push.subscribe();
    const redirecting = push.subscribe({ status: 307, location: target.subscription.endpoint });
    const subscription = { endpoint: redirecting.subscription.endpoint, ...redirecting.subscription.keys };
    const status = await sendPush(vapidVars(), subscription, { kind: "offline", home: "a".repeat(32), at: new Date().toISOString() }, { ttl: 60 });
    assert.equal(status, 307);
    assert.equal(push.received.filter((entry) => entry.id === target.id).length, 0, "nothing was sent where it pointed");
    assert.equal(push.received.filter((entry) => entry.id === redirecting.id).length, 1);
  } finally {
    await push.close();
  }
});

function b64(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

test("scripts/vapid_key.mjs pipes the private key out and shows only the public key", async () => {
  const script = fileURLToPath(new URL("../../scripts/vapid_key.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const jwk = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(jwk).sort(), ["crv", "d", "kty", "x", "y"]);
  const publicKey = /VAPID_PUBLIC_KEY[^:]*: ([A-Za-z0-9_-]+)/.exec(run.stderr)?.[1];
  assert.ok(publicKey, run.stderr);
  assert.doesNotMatch(run.stderr, new RegExp(jwk.d), "the private key is never shown");
  assert.equal(await vapidProblem({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: run.stdout }), null, "the two belong together");
});
