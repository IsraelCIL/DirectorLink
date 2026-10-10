// Direct HTTPS at home (1.12.0, ADR-082). The controller can also serve its API over HTTPS, under a
// name of its own (20 random letters and digits under dlhome.cc) whose public DNS record is its
// address on the home network, with a real certificate. A secure page may call that, so iPhones and
// iPads reach their controller at home without DirectorLink's servers: WebKit blocks the plain
// http:// address (platform.js). Requests there are sealed exactly as on the home network
// (session.js, remote.js), so a name that leads elsewhere gets nothing it can open and nothing it
// says is believed.
//
// GET /v1/system says `direct_https` ({ name, port, not_after }) only while the controller serves
// it with a valid certificate; this device remembers it for its home (localStorage), so the next
// start tries it before anything is read. A name whose certificate has expired is not tried.
// No other browser dependencies than fetch, timers and storage: unit-tested in
// tests/app/direct-https.test.mjs.

import { ApiError, apiRequest } from "../api-client.js";

const DIRECT_KEY = "directorlink.directHttps"; // { home, name, port, notAfter }
// The names the driver makes (src/api/direct_https.lua): 20 base32 letters and digits.
const NAME = /^[a-z2-7]{20}\.dlhome\.cc$/;
// How long the look at the name waits, when connecting and while away: a name that leads nowhere
// on this network (away from home, a router that refuses such names) must not keep the app waiting.
export const DIRECT_PROBE_MS = 2500;
const READ_RETRY_DELAY_MS = 400;

// `direct_https` as GET /v1/system gives it, checked: { name, port, notAfter, origin }, or null for
// anything else, and for a certificate that has expired by this device's clock.
export function directTarget(value, now = Date.now()) {
  if (!value || typeof value !== "object") return null;
  const name = value.name;
  const port = Number(value.port);
  const notAfter = Date.parse(value.not_after ?? value.notAfter);
  if (typeof name !== "string" || !NAME.test(name)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Number.isFinite(notAfter) || notAfter <= now) return null;
  return { name, port, notAfter: new Date(notAfter).toISOString(), origin: `https://${name}:${port}` };
}

// The name remembered for `home` (the home this device is linked to, or null): another home's is
// not this one's.
export function savedDirect(home = null, now = Date.now()) {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(DIRECT_KEY) || "null");
  } catch {
    return null;
  }
  if (!stored || (stored.home && home && stored.home !== home)) return null;
  return directTarget(stored, now);
}

// What GET /v1/system said (`direct_https`, null or missing when the controller does not serve it):
// remembered for `home`, or forgotten. Returns the target now remembered, or null.
export function rememberDirect(value, home = null) {
  const target = directTarget(value);
  try {
    if (target) localStorage.setItem(DIRECT_KEY, JSON.stringify({ home: home || null, name: target.name, port: target.port, notAfter: target.notAfter }));
    else localStorage.removeItem(DIRECT_KEY);
  } catch {
    // Blocked storage: the name is used for this visit only (the next read gives it again).
  }
  return target;
}

export function forgetDirect() {
  try {
    localStorage.removeItem(DIRECT_KEY);
  } catch {
    // Nothing saved.
  }
}

async function send(origin, path, { method = "GET", body, timeoutMs = 8000, wanted } = {}) {
  if (wanted && !wanted()) {
    throw new ApiError("Not sent: no longer wanted", { code: "NOT_SENT" });
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // No API key ever goes here (only sealed requests, and GET /v1/sealed, which needs none). No
    // targetAddressSpace either: the name is public and resolves to the home network's address,
    // which Chromium's Local Network Access asks about when it connects (a refusal is a failed
    // request: the app goes on through the account).
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, ok: response.ok, data, text };
  } finally {
    window.clearTimeout(timer);
  }
}

// Like apiRequest (api-client.js), at `origin` (https://<name>:<port>): { status, ok, data, text }
// without throwing on HTTP errors. A read without an answer is sent once more, unless `retry` is
// false (a look at the name, which must be quick).
export async function directRequest(origin, path, options = {}) {
  if ((options.method || "GET") !== "GET" || options.retry === false) {
    return send(origin, path, options);
  }
  try {
    return await send(origin, path, options);
  } catch {
    await new Promise((resolve) => window.setTimeout(resolve, READ_RETRY_DELAY_MS));
    return send(origin, path, options);
  }
}

// A request on the home network, at `address`: an HTTPS origin (Direct HTTPS) or the controller's
// address on port 41999 (api-client.js).
export function homeNetworkRequest(address, path, options = {}) {
  return String(address).startsWith("https://") ? directRequest(address, path, options) : apiRequest(address, path, options);
}
