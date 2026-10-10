// A home for the Direct HTTPS tests (1.12.0): its controller at its name over HTTPS and at its
// address, both sealed (tests/app/sealed-door.mjs), and the account service's relay. Each way can be
// up ("ok"), refuse the connection ("refused": away from home, or Chrome's Local Network Access
// refused), get no answer until the app gives up ("hang"), or lose the answer of a request that
// arrived ("lost"). `net.calls` lists what reached the home and which way: "https look" and
// "http look" (GET /v1/sealed), "https GET /v1/system", "http PATCH /v1/lights/1", "account GET
// /v1/lights"; `net.sent` the same with their bodies; `net.urls` every URL fetched at home;
// `net.gaveUp` how long the app waited for each request that got no answer ("hang"), in ms.

import { deriveLock, open, seal } from "../../app/js/lock.js";
import { DIRECT_NAME, DIRECT_PORT, sealedDoor } from "./sealed-door.mjs";

export const HOST = "192.168.1.201";
export const KEY = "ak_test";
export const KEY_ID = "0a1b2c3d";
export const HOME = "0123456789abcdef0123456789abcdef";
export const CERT_END = "2027-01-08T12:00:00.000Z";

export function json(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// GET /v1/https as the driver answers it (ADR-082): on, with its certificate.
export function httpsStatus(changes = {}) {
  return {
    allowed: true,
    enabled: true,
    remote: true,
    name: DIRECT_NAME,
    port: DIRECT_PORT,
    state: "listening",
    certificate: { not_after: CERT_END, issuer_cn: "E7" },
    error: null,
    ...changes,
  };
}

export function fakeHome() {
  const net = {
    calls: [],
    sent: [],
    urls: [],
    gaveUp: [],
    https: "ok",
    http: "ok",
    account: "ok",
    // GET /v1/system's direct_https; undefined: a DirectorLink before 1.12.0 (no field).
    direct: { name: DIRECT_NAME, port: DIRECT_PORT, not_after: CERT_END },
    // This key's access (GET /v1/api-keys/current).
    access: { role: "admin", owner: true },
    status: httpsStatus(),
    // PUT /v1/https: [status, body], or null to change `status` as the driver does.
    put: null,
  };

  function home(method, path, body) {
    if (path === "/v1/system") {
      const system = { bridge: { version: "1.12.0" }, features: {}, inventory: { rooms: 1, devices: 1, supported_devices: 1 } };
      if (net.direct !== undefined) system.direct_https = net.direct;
      return [200, system];
    }
    if (path === "/v1/api-keys/current") return [200, { id: KEY_ID, role: "admin", access: net.access }];
    if (path === "/v1/https" && method === "GET") return [200, net.status];
    if (path === "/v1/https" && method === "PUT") {
      if (net.put) return net.put;
      net.status = { ...net.status, enabled: body.enabled, state: body.enabled ? "requesting" : "off", certificate: body.enabled ? net.status.certificate : null };
      return [200, net.status];
    }
    if (path === "/v1/lights/1" && method === "PATCH") return [200, { id: 1, name: "Island", on: Boolean(body?.on) }];
    if (method === "GET") return [200, { items: [] }];
    return [404, { status: 404, code: "NOT_FOUND" }];
  }

  const respond = (via) => async (method, path, body) => {
    net.calls.push(`${via} ${method} ${path}`);
    net.sent.push({ via, method, path, body });
    const [status, answer] = home(method, path, body);
    return json(status, answer);
  };
  const doors = { https: sealedDoor({ apiKey: KEY, keyId: KEY_ID, respond: respond("https") }), http: sealedDoor({ apiKey: KEY, keyId: KEY_ID, respond: respond("http") }) };

  async function account(path, init) {
    if (net.account !== "ok") throw new TypeError("Failed to fetch");
    if (path !== `/v1/homes/${HOME}/e2e`) return json(404, { code: "NOT_FOUND" });
    const lock = await deriveLock(KEY);
    const request = JSON.parse(await open(lock, JSON.parse(init.body).envelope, "req"));
    net.calls.push(`account ${request.method} ${request.path}`);
    net.sent.push({ via: "account", method: request.method, path: request.path, body: request.body });
    const [status, body] = home(request.method, request.path, request.body);
    const reply = { id: request.id, ts: Math.floor(Date.now() / 1000), status, content_type: "application/json", body: body === null ? "" : JSON.stringify(body) };
    return json(200, { envelope: await seal(lock, { home: HOME, key: KEY_ID }, "res", JSON.stringify(reply)) });
  }

  // A request that gets no answer: it ends when the app gives up (its AbortController).
  const unanswered = (init) =>
    new Promise((_resolve, reject) => {
      const sent = Date.now();
      const stop = () => {
        net.gaveUp.push(Date.now() - sent);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (init.signal?.aborted) stop();
      init.signal?.addEventListener("abort", stop);
    });

  async function fetch(url, init = {}) {
    const { hostname, pathname } = new URL(url);
    if (hostname === "api.directorlink.io") return account(pathname, init);
    const via = hostname === DIRECT_NAME ? "https" : hostname === HOST ? "http" : null;
    if (!via) throw new TypeError(`blocked: ${url}`);
    net.urls.push(url);
    if (pathname !== "/v1/sealed") throw new TypeError(`not sealed: ${url}`);
    const method = init.method || "GET";
    const mode = net[via];
    if (method === "GET") net.calls.push(`${via} look`);
    if (mode === "refused") throw new TypeError("Failed to fetch");
    if (mode === "hang") return unanswered(init);
    const reply = await doors[via](init);
    if (mode === "lost" && method === "POST") throw new TypeError("Failed to fetch");
    return reply;
  }

  return { net, fetch };
}
