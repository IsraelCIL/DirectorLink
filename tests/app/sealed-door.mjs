// A fake controller's sealed door (POST /v1/sealed) for the app's tests: GET gives its clock; POST
// opens a request sealed with the device's lock key (app/js/remote.js), asks `respond(method, path,
// body)` for the answer (a Response, as a plain fake controller gives it) and seals that back. With
// Direct HTTPS (1.12.0, app/js/direct.js) this is the only way the app talks to its controller at
// the controller's name: an iPhone at home goes that way.

import { deriveLock, open, seal } from "../../app/js/lock.js";

// A Direct HTTPS name as the driver makes them, its port, and how app/js/direct.js keeps it.
export const DIRECT_NAME = "n4d5coplbd7r7o43uemp.dlhome.cc";
export const DIRECT_PORT = 28443;
export const DIRECT_KEY = "directorlink.directHttps";
export function directRecord({ name = DIRECT_NAME, port = DIRECT_PORT, notAfter = "2099-01-01T00:00:00.000Z", home = null } = {}) {
  return JSON.stringify({ home, name, port, notAfter });
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function sealedDoor({ apiKey, keyId, respond, now = () => Date.now() }) {
  return async (init = {}) => {
    const method = init.method || "GET";
    if (method === "GET") return json(200, { home: "lan", time: Math.floor(now() / 1000), window_seconds: 120 });
    const lock = await deriveLock(apiKey);
    const request = JSON.parse(await open(lock, JSON.parse(init.body).envelope, "req"));
    const response = await respond(request.method, request.path, request.body);
    const text = response.status === 204 ? "" : await response.text();
    const reply = { id: request.id, ts: Math.floor(now() / 1000), status: response.status, content_type: response.headers.get("Content-Type") || "application/json", body: text };
    return json(200, { envelope: await seal(lock, { home: "lan", key: keyId }, "res", JSON.stringify(reply)) });
  };
}
