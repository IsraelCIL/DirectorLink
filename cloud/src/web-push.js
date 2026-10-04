// Web Push (RFC 8030) for alerts (ADR-047, alerts.js): the message is encrypted for the browser
// (RFC 8291, aes128gcm) and the request is signed with DirectorLink's VAPID key (RFC 8292), all
// with WebCrypto. Only the browser that subscribed can read a message; the push service (Google,
// Mozilla, Apple, Microsoft) carries it without being able to.
//
// Settings: VAPID_PUBLIC_KEY (a var: the key pair's public key, base64url of its 65 bytes, which the
// app subscribes with), VAPID_PRIVATE_KEY (a secret: the private key as a JWK, made by
// scripts/vapid_key.mjs), and optionally VAPID_SUBJECT (a contact, by default the website).

import { base64url, fromBase64url } from "./http.js";

const encoder = new TextEncoder();
const DEFAULT_SUBJECT = "https://directorlink.io";
// The JWT may be valid for 24 hours at most (RFC 8292); a request uses a fresh one.
const JWT_SECONDS = 12 * 3600;
// One aes128gcm record (RFC 8188) holds the whole message.
const RECORD_SIZE = 4096;
// Every message is padded to this many bytes (with its delimiter), so that its size does not tell
// the push service which alert it is: the cloud's own alerts are about 100 bytes of JSON, one sealed
// by the controller (ADR-050) about 900 (every detail is padded to 496 bytes, 512 sealed, 684 in
// base64, with its IV, MAC, key id, home id and time). Web Push takes some 3,990.
export const MESSAGE_BYTES = 1024;
const SEND_TIMEOUT_MS = 10000;

// The push services browsers use: an alert is only ever sent to one of them.
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function vapidConfigured(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

// Why the VAPID settings do not work, or null when they do.
export async function vapidProblem(env) {
  if (!vapidConfigured(env)) {
    return "VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is not set";
  }
  try {
    await vapidKeys(env);
    return null;
  } catch (error) {
    return error.message;
  }
}

// Whether `endpoint` is a push service's https address (or the tests' fake one, PUSH_TEST_URL).
export function validEndpoint(env, endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048) {
    return false;
  }
  if (env.PUSH_TEST_URL && endpoint.startsWith(`${env.PUSH_TEST_URL}/`)) {
    return true;
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  // HTTPS's own port only (URL drops an explicit :443).
  return url.protocol === "https:" && url.port === "" && !url.username && !url.password && PUSH_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
}

// The browser's keys of a subscription ({ p256dh, auth }, base64url), or null when they are not
// a P-256 public key and a 16-byte secret.
export async function subscriptionKeys(keys) {
  try {
    const publicKey = fromBase64url(keys?.p256dh ?? "");
    const auth = fromBase64url(keys?.auth ?? "");
    if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16) {
      return null;
    }
    await crypto.subtle.importKey("raw", publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return { p256dh: base64url(publicKey), auth: base64url(auth) };
  } catch {
    return null;
  }
}

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

async function hmac(key, data) {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}

// RFC 8291: `plaintext` (a string) encrypted for the subscription's keys, as the aes128gcm body
// (RFC 8188): salt, record size, the server's one-time public key, then one record. `salt` and
// `serverKeys` (an ECDH P-256 key pair) are made for each message; the tests pass the RFC's.
// `padTo`: the record's length before encryption (the message, its delimiter, then zeros); 0 pads
// nothing, as the RFC's test vector.
export async function encryptPayload(plaintext, keys, { salt = crypto.getRandomValues(new Uint8Array(16)), serverKeys, padTo = MESSAGE_BYTES } = {}) {
  const uaPublic = fromBase64url(keys.p256dh);
  const authSecret = fromBase64url(keys.auth);
  const pair = serverKeys ?? (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, pair.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(encoder.encode("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(encoder.encode("Content-Encoding: nonce\0"), [1]))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // The last (and only) record: the message, the delimiter 2, then zeros up to `padTo` (RFC 8188
  // section 2).
  const message = encoder.encode(plaintext);
  const record = concat(message, [2], new Uint8Array(Math.max(0, padTo - message.length - 1)));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));
  const recordSize = [(RECORD_SIZE >>> 24) & 255, (RECORD_SIZE >>> 16) & 255, (RECORD_SIZE >>> 8) & 255, RECORD_SIZE & 255];
  return concat(salt, recordSize, [asPublic.length], asPublic, ciphertext);
}

// The VAPID key pair from the settings, checked once: the private key (a JWK) must belong to the
// public key the app subscribes with, or no browser could receive what it signs.
let cachedVapid = null;

async function vapidKeys(env) {
  if (cachedVapid?.source === env.VAPID_PRIVATE_KEY && cachedVapid.publicKey === env.VAPID_PUBLIC_KEY) {
    return cachedVapid;
  }
  let jwk;
  try {
    jwk = JSON.parse(env.VAPID_PRIVATE_KEY);
  } catch {
    throw new Error("VAPID_PRIVATE_KEY is not a JWK (make it with scripts/vapid_key.mjs)");
  }
  if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("VAPID_PRIVATE_KEY is not a P-256 private key as a JWK");
  }
  const publicKey = base64url(concat([4], fromBase64url(jwk.x), fromBase64url(jwk.y)));
  if (publicKey !== env.VAPID_PUBLIC_KEY) {
    throw new Error("VAPID_PUBLIC_KEY is not the public key of VAPID_PRIVATE_KEY");
  }
  const signingKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  cachedVapid = { source: env.VAPID_PRIVATE_KEY, publicKey, signingKey };
  return cachedVapid;
}

// RFC 8292: `Authorization: vapid t=<JWT>, k=<public key>` for a request to `endpoint`. The JWT is
// ES256-signed, for the push service's origin, valid for 12 hours, with a contact (`sub`).
export async function vapidAuthorization(env, endpoint, now = Date.now()) {
  const { publicKey, signingKey } = await vapidKeys(env);
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + JWT_SECONDS, sub: env.VAPID_SUBJECT || DEFAULT_SUBJECT }))
  );
  // WebCrypto's ECDSA signature is r || s, as JWS wants it.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${publicKey}`;
}

// Sends `message` (an object, sent as JSON) to one subscription ({ endpoint, p256dh, auth }).
// Returns the push service's HTTP status, or 0 when it could not be reached. `ttl`: how long the
// service keeps it for a browser that is offline, in seconds. A redirect is not followed (its 3xx
// status is returned): the message goes only to the address that was checked (validEndpoint).
// Settings that do not work (vapidKeys) throw.
export async function sendPush(env, subscription, message, { ttl }) {
  const authorization = await vapidAuthorization(env, subscription.endpoint);
  const body = await encryptPayload(JSON.stringify(message), subscription);
  try {
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        TTL: String(ttl),
        Urgency: "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch {
    return 0;
  }
}
