// A fake of Cloudflare's DNS API (one zone's dns_records) for the Direct HTTPS tests (ADR-082): what
// the Worker writes for dlhome.cc, the A records and the dns-01 challenges' TXT records, checked as
// Cloudflare would (a Bearer token for the zone). The fake ACME server reads the TXT records here.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { freePort } from "./worker.mjs";

export const ZONE_ID = "38e18e06ad8a2a72c765f33d6abb3db2";
export const DNS_TOKEN = "test-dns-token";

export async function startFakeCloudflare() {
  const records = new Map();
  const calls = [];
  // failNext: how many of the next requests answer 500.
  const state = { failNext: 0 };
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const prefix = `/client/v4/zones/${ZONE_ID}/dns_records`;

  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const answer = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const address = new URL(request.url, url);
    calls.push({ method: request.method, path: address.pathname, query: address.search, body: text ? JSON.parse(text) : null });
    if (request.headers.authorization !== `Bearer ${DNS_TOKEN}`) {
      return answer(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null });
    }
    if (!address.pathname.startsWith(prefix)) {
      return answer(404, { success: false, errors: [{ code: 7003, message: "Could not route" }], result: null });
    }
    if (state.failNext > 0) {
      state.failNext -= 1;
      return answer(500, { success: false, errors: [{ code: 10001, message: "Internal error" }], result: null });
    }
    const id = address.pathname.slice(prefix.length + 1) || null;
    if (request.method === "GET" && !id) {
      const type = address.searchParams.get("type");
      const name = address.searchParams.get("name");
      const result = [...records.values()].filter((record) => (!type || record.type === type) && (!name || record.name === name));
      return answer(200, { success: true, errors: [], result });
    }
    if (request.method === "POST" && !id) {
      const body = JSON.parse(text);
      const record = { id: randomBytes(16).toString("hex"), type: body.type, name: body.name, content: body.content, ttl: body.ttl ?? 1, proxied: body.proxied ?? false };
      records.set(record.id, record);
      return answer(200, { success: true, errors: [], result: record });
    }
    const existing = id ? records.get(id) : null;
    if (!existing) {
      return answer(404, { success: false, errors: [{ code: 81044, message: "Record does not exist" }], result: null });
    }
    if (request.method === "PATCH") {
      Object.assign(existing, JSON.parse(text));
      return answer(200, { success: true, errors: [], result: existing });
    }
    if (request.method === "DELETE") {
      records.delete(id);
      return answer(200, { success: true, errors: [], result: { id } });
    }
    return answer(405, { success: false, errors: [{ code: 10000, message: "Method not allowed" }], result: null });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url,
    api: `${url}/client/v4`,
    records,
    calls,
    state,
    // The records of `name` (and `type`), as the zone has them now.
    find: (recordName, type) => [...records.values()].filter((record) => record.name === recordName && (!type || record.type === type)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
