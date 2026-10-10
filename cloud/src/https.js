// Direct HTTPS (1.12.0, ADR-082): the home's Durable Object gets the controller a certificate for its
// own name under dlhome.cc from Let's Encrypt, and keeps the name's A record at the controller's LAN
// address, so that iPhones and iPads reach the controller over HTTPS at home (docs/RELAY.md).
//
// The controller asks over its connection:
//   {"type":"https_certificate","id","name","csr","ip"}  a certificate for its CSR, the A record at ip
//       -> {"type":"https_certificate_result","id","ok":true,"status":"pending"}, then (tens of seconds
//          later, to the id of its newest request) {"…_result","id","ok":true,"status":"issued","name",
//          "certificate","chain","not_after"} or {"…_result","id","ok":false,"code","retry_s"?};
//          "issued" at once while this home's certificate for that key is fresh
//   {"type":"https","id","name","ip"}  its address changed (or a new connection): the A record follows
//   {"type":"https","id","name":null}  turned off: the A record goes
//       -> {"type":"https_result","id","ok":true} or {"…","ok":false,"code"}
//
// One name a home: the first request it is allowed binds the name to the home in D1 (`https_names`,
// migrations/0011), because a name is public (Certificate Transparency logs) and no other home may
// take it; the object keeps a copy. A CSR for another name, for several names or another kind of
// name, with a key that is not P-256 or RSA of 2048 bits or more, or a name that is not
// `<20 base32>.dlhome.cc`, is refused. Only private IPv4 addresses go in the A record (DNS only, TTL
// 3600). At most 3 new orders a home a day and 5 a week (Let's Encrypt: 5 certificates a week for one
// name), and 45 new names a week in all (Let's Encrypt: 50 new certificates a week for dlhome.cc;
// renewals are not counted there).
//
// The order runs in steps from the object's alarm (alarms.js), never inside a request: a new order,
// the dns-01 challenge's TXT record (Cloudflare's API), about 20 s for it to be seen, the challenge's
// answer, polling, the finalize with the controller's CSR, polling, the certificate; the TXT record
// goes, the A record is written, and the controller is sent its certificate. A step that fails for a
// moment (the network, a 5xx, a bad nonce) is tried again (5 s, 15 s, 30 s, 60 s), at most 5 times;
// the order gives up after 10 minutes.
//
// Settings: DLHOME_DNS_TOKEN (a secret: a Cloudflare API token that may edit DNS of dlhome.cc only),
// ACME_ACCOUNT_KEY (a secret: acme.js), DLHOME_ZONE_ID (a var: dlhome.cc's zone), ACME_DIRECTORY (a
// var, acme.js). Without the secrets and the zone every request is answered HTTPS_UNAVAILABLE and
// nothing else changes. Tests only: DLHOME_DNS_API (a fake Cloudflare API), HTTPS_DNS_WAIT_MS,
// HTTPS_POLL_MS, HTTPS_RETRY_MS.
//
// Its storage:
//   https      { name, ip, dns: { ip } (the A record as last written), cert: { certificate, chain,
//              not_before, not_after, spki, issuer_cn }, orders: [ms…] (the last week's), kid }
//   https_job  the order in progress: { home, step, name, csr, spki, ip, request, renewal, order,
//              authz, challenge, finalize, certificate_url, txt, tries, polls, started }
//
// Logs: https_certificate_requested, https_certificate_issued (name, not_after),
// https_certificate_failed (code), https_dns_updated, https_dns_deleted, https_refused (code),
// https_step_retried; never a key, a CSR, a certificate's text or an address.

import { AcmeClient, AcmeError, DEFAULT_DIRECTORY } from "./acme.js";
import { base64url } from "./http.js";
import { hex, pem, pemBlocks, readCertificate, readRequest } from "./x509.js";

export const HTTPS_FEATURE = "https";
export const DOMAIN = "dlhome.cc";
export const NAME = /^[a-z2-7]{20}\.dlhome\.cc$/;
const ORDERS_PER_DAY = 3;
const ORDERS_PER_WEEK = 5;
const NEW_NAMES_PER_WEEK = 45;
const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;
const JOB_MS = 10 * 60 * 1000;
const STEP_TRIES = 5;
const RETRY_MS = [5000, 15000, 30000, 60000];
const MAX_POLLS = 60;
const MAX_CSR_CHARS = 8192;
const MIN_RSA_BITS = 2048;
const A_TTL = 3600;
const TXT_TTL = 60;
const DEFAULT_DNS_API = "https://api.cloudflare.com/client/v4";

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function httpsConfigured(env) {
  return Boolean(env.DLHOME_DNS_TOKEN && env.ACME_ACCOUNT_KEY && env.DLHOME_ZONE_ID);
}

// A private IPv4 address: 10/8, 172.16/12, 192.168/16.
export function privateAddress(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(typeof ip === "string" ? ip : "");
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// What the controller's CSR asks for, read: { der, spki (SHA-256 hex of its public key) } or
// { code } when it may not be asked for that name.
export async function checkRequest(csrText, name) {
  if (typeof csrText !== "string" || csrText.length > MAX_CSR_CHARS) return { code: "INVALID_REQUEST" };
  const blocks = pemBlocks(csrText, "CERTIFICATE REQUEST");
  const der = blocks?.length === 1 ? blocks[0] : null;
  const request = der ? readRequest(der) : null;
  if (!request) return { code: "INVALID_CSR", why: "not one certificate request" };
  if (request.otherNames > 0 || request.names.length !== 1 || request.names[0] !== name) {
    return { code: "INVALID_CSR", why: "it must name the home's name, and nothing else" };
  }
  const { key } = request;
  const goodKey = (key.type === "ec" && key.curve === "P-256" && key.bits === 256) || (key.type === "rsa" && key.bits >= MIN_RSA_BITS);
  if (!goodKey) return { code: "INVALID_CSR", why: "its key must be P-256, or RSA of 2048 bits or more" };
  const spki = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", key.spki)));
  return { der, spki };
}

// A certificate still worth giving: more than a third of its lifetime left.
function fresh(cert, now = Date.now()) {
  if (!cert) return false;
  const from = Date.parse(cert.not_before);
  const to = Date.parse(cert.not_after);
  return Number.isFinite(from) && Number.isFinite(to) && to - now > (to - from) / 3;
}

// ---- Cloudflare's DNS API (the zone dlhome.cc) -------------------------------------------------------

export class DnsError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }

  get transient() {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

async function dns(env, method, path, body) {
  const base = (env.DLHOME_DNS_API || DEFAULT_DNS_API).replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${base}/zones/${encodeURIComponent(env.DLHOME_ZONE_ID)}/dns_records${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.DLHOME_DNS_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
  } catch (error) {
    throw new DnsError(`Cloudflare's API could not be reached: ${error?.message ?? error}`);
  }
  let answer = null;
  try {
    answer = await response.json();
  } catch {
    // Not JSON.
  }
  if (!response.ok || answer?.success !== true) {
    const errors = Array.isArray(answer?.errors) ? answer.errors.map((item) => item?.code).join(",") : "";
    throw new DnsError(`Cloudflare's API answered ${response.status}${errors ? ` (${errors})` : ""}`, response.status);
  }
  return answer.result;
}

async function records(env, type, name) {
  const result = await dns(env, "GET", `?${new URLSearchParams({ type, name, per_page: "100" })}`);
  return Array.isArray(result) ? result.filter((record) => record?.type === type && record?.name === name) : [];
}

// The name's A record at `ip` (DNS only): written when there is none or it differs; any other A
// record of the name goes. Returns whether anything changed.
export async function setAddress(env, name, ip) {
  const found = await records(env, "A", name);
  const wanted = { type: "A", name, content: ip, ttl: A_TTL, proxied: false };
  const keep = found.find((record) => record.content === ip && record.proxied === false && record.ttl === A_TTL);
  let changed = false;
  if (!keep) {
    if (found.length) {
      await dns(env, "PATCH", `/${encodeURIComponent(found[0].id)}`, wanted);
    } else {
      await dns(env, "POST", "", wanted);
    }
    changed = true;
  }
  const kept = keep ?? found[0];
  for (const record of found) {
    if (record !== kept) {
      await dns(env, "DELETE", `/${encodeURIComponent(record.id)}`);
      changed = true;
    }
  }
  return changed;
}

// Every A and TXT record of the name (and its challenge's) goes. Returns how many went.
export async function deleteName(env, name) {
  let count = 0;
  for (const [type, recordName] of [["A", name], ["TXT", `_acme-challenge.${name}`]]) {
    for (const record of await records(env, type, recordName)) {
      await dns(env, "DELETE", `/${encodeURIComponent(record.id)}`);
      count += 1;
    }
  }
  return count;
}

async function addChallenge(env, name, value) {
  const record = await dns(env, "POST", "", { type: "TXT", name: `_acme-challenge.${name}`, content: `"${value}"`, ttl: TXT_TTL, proxied: false });
  return record?.id ?? null;
}

async function removeChallenge(env, job) {
  if (!job?.txt) return;
  try {
    await dns(env, "DELETE", `/${encodeURIComponent(job.txt)}`);
  } catch (error) {
    // A TXT record left behind does no harm; the next order's own goes the same way.
    log("https_dns_failed", { home: job.home, name: job.name, what: "challenge", error: error.message });
  }
  job.txt = null;
}

// ---- the home's object ----------------------------------------------------------------------------

export class HomeHttps {
  // `relay`: the HomeRelay object (its storage, env, alarms and driver socket).
  constructor(relay) {
    this.relay = relay;
  }

  get storage() {
    return this.relay.ctx.storage;
  }

  get env() {
    return this.relay.env;
  }

  async record() {
    return (await this.storage.get("https")) ?? {};
  }

  async save(record) {
    await this.storage.put("https", record);
  }

  // A message from the controller (`https`, `https_certificate`): its answer.
  async handle(data, homeId) {
    const type = data?.type === "https" ? "https_result" : "https_certificate_result";
    const id = typeof data?.id === "string" && data.id.length <= 64 ? data.id : null;
    let answer;
    try {
      answer = await (data?.type === "https" ? this.address(data, homeId) : this.certificate(data, homeId, id));
    } catch (error) {
      log("https_failed", { home: homeId, type: data?.type, error: String(error?.message ?? error) });
      answer = { ok: false, code: error instanceof DnsError ? "DNS_FAILED" : "INTERNAL" };
    }
    if (answer.ok === false) {
      log("https_refused", { home: homeId, type: data?.type, code: answer.code, why: answer.why });
      delete answer.why;
    }
    return { type, id, ...answer };
  }

  // The home's name: the one bound to it, or `name` bound now. { ok } or { ok: false, code, name? }.
  async bind(homeId, name, record) {
    if (record.name) {
      return record.name === name ? { ok: true } : { ok: false, code: "NAME_MISMATCH", name: record.name };
    }
    const db = this.env.DB;
    await db.prepare("INSERT OR IGNORE INTO https_names (name, home_id, created_at) VALUES (?1, ?2, ?3)").bind(name, homeId, new Date().toISOString()).run();
    const rows = (await db.prepare("SELECT name, home_id FROM https_names WHERE name = ?1 OR home_id = ?2").bind(name, homeId).all()).results ?? [];
    const own = rows.find((row) => row.home_id === homeId);
    if (own) {
      record.name = own.name;
      await this.save(record);
      return own.name === name ? { ok: true } : { ok: false, code: "NAME_MISMATCH", name: own.name };
    }
    return { ok: false, code: "NAME_TAKEN" };
  }

  async claimed(homeId) {
    return Boolean(await this.env.DB.prepare("SELECT 1 AS found FROM homes WHERE id = ?").bind(homeId).first());
  }

  // `https`: the controller's address (the A record follows while it has a certificate), or off.
  async address(data, homeId) {
    if (!httpsConfigured(this.env)) return { ok: false, code: "HTTPS_UNAVAILABLE" };
    const record = await this.record();
    if (data.name === null) {
      await this.cancelJob();
      if (record.name) {
        const count = await deleteName(this.env, record.name);
        log("https_dns_deleted", { home: homeId, name: record.name, records: count });
      }
      record.ip = null;
      record.dns = null;
      await this.save(record);
      return { ok: true };
    }
    if (typeof data.name !== "string" || !NAME.test(data.name)) return { ok: false, code: "INVALID_REQUEST" };
    if (!privateAddress(data.ip)) return { ok: false, code: "ADDRESS_NEEDED" };
    if (!record.name && !(await this.claimed(homeId))) return { ok: false, code: "NOT_CLAIMED" };
    const bound = await this.bind(homeId, data.name, record);
    if (!bound.ok) return bound;
    record.ip = data.ip;
    await this.save(record);
    if (record.cert && Date.parse(record.cert.not_after) > Date.now()) {
      await this.writeAddress(homeId, record);
    }
    return { ok: true };
  }

  // The A record at the home's address, unless it was written so already.
  async writeAddress(homeId, record) {
    if (!record.name || !privateAddress(record.ip) || record.dns?.ip === record.ip) return;
    const changed = await setAddress(this.env, record.name, record.ip);
    record.dns = { ip: record.ip };
    await this.save(record);
    if (changed) log("https_dns_updated", { home: homeId, name: record.name });
  }

  // `https_certificate`: the answer now; a new order runs from the alarm.
  async certificate(data, homeId, id) {
    if (!httpsConfigured(this.env)) return { ok: false, code: "HTTPS_UNAVAILABLE" };
    if (!id || typeof data.name !== "string" || !NAME.test(data.name)) return { ok: false, code: "INVALID_REQUEST" };
    if (!privateAddress(data.ip)) return { ok: false, code: "ADDRESS_NEEDED" };
    const csr = await checkRequest(data.csr, data.name);
    if (csr.code) return { ok: false, code: csr.code, why: csr.why };
    if (!(await this.claimed(homeId))) return { ok: false, code: "NOT_CLAIMED" };
    const record = await this.record();
    const bound = await this.bind(homeId, data.name, record);
    if (!bound.ok) return bound;
    record.ip = data.ip;
    await this.save(record);
    // While the home has a certificate, the A record follows the address the request gives.
    if (record.cert && Date.parse(record.cert.not_after) > Date.now()) {
      try {
        await this.writeAddress(homeId, record);
      } catch (error) {
        log("https_dns_failed", { home: homeId, name: record.name, what: "address", error: error.message });
      }
    }

    // This key's certificate, still fresh: given again.
    if (record.cert?.spki === csr.spki && fresh(record.cert)) {
      return { ok: true, status: "issued", ...this.certificateFields(record) };
    }
    // Its order is running: the result goes to this request. One the alarm lost long ago gives way.
    let job = await this.storage.get("https_job");
    if (job && Date.now() - job.started > JOB_MS + 60000) {
      await this.cancelJob();
      job = null;
    }
    if (job && job.spki === csr.spki && job.name === data.name) {
      job.request = id;
      job.ip = data.ip;
      await this.storage.put("https_job", job);
      return { ok: true, status: "pending" };
    }
    // Another key's order gives way.
    if (job) await this.cancelJob();

    const now = Date.now();
    const orders = (record.orders ?? []).filter((at) => now - at < WEEK_MS && at <= now);
    const today = orders.filter((at) => now - at < DAY_MS);
    if (today.length >= ORDERS_PER_DAY || orders.length >= ORDERS_PER_WEEK) {
      const until = today.length >= ORDERS_PER_DAY ? today[0] + DAY_MS : orders[0] + WEEK_MS;
      return { ok: false, code: "RATE_LIMITED", retry_s: Math.max(60, Math.ceil((until - now) / 1000)), why: "this home's orders" };
    }
    const issuedBefore = await this.env.DB.prepare("SELECT issued_at FROM https_names WHERE name = ?").bind(data.name).first();
    if (!issuedBefore?.issued_at) {
      const since = new Date(now - WEEK_MS).toISOString();
      const count = (await this.env.DB.prepare("SELECT COUNT(*) AS count FROM https_names WHERE issued_at >= ?").bind(since).first())?.count ?? 0;
      if (count >= NEW_NAMES_PER_WEEK) {
        return { ok: false, code: "RATE_LIMITED", retry_s: 6 * 3600, why: "new names this week" };
      }
    }
    record.orders = [...orders, now];
    await this.save(record);
    const renewal = Boolean(record.cert);
    await this.storage.put("https_job", {
      home: homeId,
      step: "order",
      name: data.name,
      csr: base64url(csr.der),
      spki: csr.spki,
      ip: data.ip,
      request: id,
      renewal,
      tries: 0,
      polls: 0,
      started: now,
    });
    await this.relay.alarms.set("https", now);
    log("https_certificate_requested", { home: homeId, name: data.name, renewal });
    return { ok: true, status: "pending" };
  }

  certificateFields(record) {
    return { name: record.name, certificate: record.cert.certificate, chain: record.cert.chain, not_after: record.cert.not_after };
  }

  async cancelJob() {
    const job = await this.storage.get("https_job");
    if (!job) return;
    await removeChallenge(this.env, job);
    await this.storage.delete("https_job");
    await this.relay.alarms.clear("https");
  }

  async client(record) {
    const acme = new AcmeClient({ directoryUrl: this.env.ACME_DIRECTORY || DEFAULT_DIRECTORY, accountKey: this.env.ACME_ACCOUNT_KEY, kid: record.kid ?? null });
    return acme;
  }

  // The alarm: the order's next steps, until one has to wait.
  async alarm() {
    let job = await this.storage.get("https_job");
    if (!job) return;
    const record = await this.record();
    const acme = await this.client(record);
    for (let steps = 0; steps < 8 && job; steps += 1) {
      if (Date.now() - job.started > JOB_MS) {
        await this.fail(job, "ACME_FAILED", null, "the order took longer than 10 minutes");
        return;
      }
      let wait;
      try {
        wait = await this.step(job, acme);
      } catch (error) {
        await this.stepFailed(job, error);
        return;
      }
      if (acme.kid && acme.kid !== record.kid) {
        const latest = await this.record();
        latest.kid = acme.kid;
        await this.save(latest);
        record.kid = acme.kid;
      }
      job = await this.storage.get("https_job");
      if (!job) return; // done (issued) or given up
      if (wait > 0) {
        job.tries = 0;
        await this.storage.put("https_job", job);
        await this.relay.alarms.set("https", Date.now() + wait);
        return;
      }
      job.tries = 0;
    }
    if (job) {
      await this.storage.put("https_job", job);
      await this.relay.alarms.set("https", Date.now());
    }
  }

  pollMs(answer) {
    const asked = Number(answer?.retryAfter) * 1000;
    const base = number(this.env.HTTPS_POLL_MS, 3000);
    return Number.isFinite(asked) && asked > base ? Math.min(asked, 60000) : base;
  }

  // One step of `job` (changed in place and kept); the wait before the next (ms), 0 at once.
  async step(job, acme) {
    const save = () => this.storage.put("https_job", job);
    switch (job.step) {
      case "order": {
        const { url, order } = await acme.newOrder(job.name);
        job.order = url;
        job.finalize = order.finalize;
        job.authz = Array.isArray(order.authorizations) ? order.authorizations[0] : null;
        job.step = order.status === "valid" ? "download" : order.status === "ready" ? "finalize" : "challenge";
        job.certificate_url = order.certificate ?? null;
        if (order.status === "invalid" || (!job.authz && job.step === "challenge")) throw new AcmeError("orderInvalid", "the new order is invalid");
        await save();
        return 0;
      }
      case "challenge": {
        const authz = await acme.get(job.authz);
        if (authz.status === "valid") {
          job.step = "finalize";
          await save();
          return 0;
        }
        const challenge = Array.isArray(authz.challenges) ? authz.challenges.find((item) => item?.type === "dns-01") : null;
        if (authz.status !== "pending" || !challenge?.url || typeof challenge.token !== "string") {
          throw new AcmeError("authorizationInvalid", `the authorization is ${authz.status} or has no dns-01 challenge`);
        }
        job.challenge = challenge.url;
        await removeChallenge(this.env, job);
        job.txt = await addChallenge(this.env, job.name, await acme.dnsValue(challenge.token));
        job.step = "respond";
        await save();
        return number(this.env.HTTPS_DNS_WAIT_MS, 20000);
      }
      case "respond": {
        await acme.respond(job.challenge);
        job.step = "validating";
        job.polls = 0;
        await save();
        return number(this.env.HTTPS_POLL_MS, 3000);
      }
      case "validating": {
        const authz = await acme.get(job.authz);
        if (authz.status === "valid") {
          job.step = "finalize";
          await save();
          return 0;
        }
        if (authz.status === "invalid") {
          const problem = (authz.challenges ?? []).find((item) => item?.type === "dns-01")?.error;
          throw new AcmeError(problem?.type ?? "authorizationInvalid", problem?.detail ?? "the challenge failed");
        }
        return this.poll(job, authz, save);
      }
      case "finalize": {
        const order = await acme.finalize(job.finalize, job.csr);
        return this.afterOrder(job, order, save);
      }
      case "processing": {
        const order = await acme.get(job.order);
        return this.afterOrder(job, order, save);
      }
      case "download": {
        const chain = await acme.download(job.certificate_url);
        await this.issued(job, chain);
        return 0;
      }
      default:
        throw new AcmeError("internal", `unknown step ${job.step}`);
    }
  }

  async poll(job, answer, save) {
    job.polls = (job.polls ?? 0) + 1;
    if (job.polls > MAX_POLLS) throw new AcmeError("timeout", `still ${answer.status} after ${MAX_POLLS} looks`);
    await save();
    return this.pollMs(answer);
  }

  async afterOrder(job, order, save) {
    if (order.status === "valid" && order.certificate) {
      job.certificate_url = order.certificate;
      job.step = "download";
      await save();
      return 0;
    }
    if (order.status === "invalid") throw new AcmeError(order.error?.type ?? "orderInvalid", order.error?.detail ?? "the order is invalid");
    if (job.step !== "processing") {
      job.step = "processing";
      job.polls = 0;
    }
    return this.poll(job, order, save);
  }

  // A step failed: tried again a little later when it may work then, else the order fails.
  async stepFailed(job, error) {
    const transient = (error instanceof AcmeError || error instanceof DnsError) && error.transient;
    if (transient && (job.tries ?? 0) + 1 < STEP_TRIES) {
      job.tries = (job.tries ?? 0) + 1;
      await this.storage.put("https_job", job);
      const custom = String(this.env.HTTPS_RETRY_MS ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isFinite(value) && value >= 0);
      const delays = custom.length ? custom : RETRY_MS;
      await this.relay.alarms.set("https", Date.now() + delays[Math.min(job.tries, delays.length) - 1]);
      log("https_step_retried", { home: job.home, name: job.name, step: job.step, tries: job.tries, error: String(error.message).slice(0, 200) });
      return;
    }
    if (error instanceof DnsError) {
      await this.fail(job, "DNS_FAILED", null, error.message);
    } else if (error instanceof AcmeError && error.kind === "rateLimited") {
      await this.fail(job, "RATE_LIMITED", error.retryAfter ?? 3600, error.detail);
    } else if (error instanceof AcmeError && error.kind === "badCSR") {
      await this.fail(job, "INVALID_CSR", null, error.detail);
    } else {
      await this.fail(job, "ACME_FAILED", null, String(error?.message ?? error));
    }
  }

  // Let's Encrypt gave the certificate and its chain (PEM): kept, the A record written, the TXT
  // record gone, and the controller told.
  async issued(job, chainText) {
    const blocks = pemBlocks(chainText, "CERTIFICATE") ?? [];
    const leaf = blocks.length ? readCertificate(blocks[0]) : null;
    const spki = leaf ? hex(new Uint8Array(await crypto.subtle.digest("SHA-256", leaf.key.spki))) : null;
    if (!leaf || spki !== job.spki || !leaf.names.includes(job.name) || blocks.length < 2) {
      await this.fail(job, "ACME_FAILED", null, "the certificate is not for the request, or has no chain");
      return;
    }
    const record = await this.record();
    record.cert = {
      certificate: pem(blocks[0], "CERTIFICATE"),
      chain: blocks.slice(1).map((der) => pem(der, "CERTIFICATE")).join(""),
      not_before: new Date(leaf.notBefore).toISOString(),
      not_after: new Date(leaf.notAfter).toISOString(),
      spki,
      issuer_cn: leaf.issuerCn,
    };
    record.ip = record.ip ?? job.ip;
    await this.save(record);
    await this.storage.delete("https_job");
    await this.relay.alarms.clear("https");
    await removeChallenge(this.env, job);
    try {
      await this.env.DB.prepare("UPDATE https_names SET issued_at = COALESCE(issued_at, ?1) WHERE name = ?2").bind(new Date().toISOString(), job.name).run();
    } catch (error) {
      log("https_failed", { home: job.home, what: "issued_at", error: String(error?.message ?? error) });
    }
    try {
      record.dns = null; // a new certificate: the record is checked again
      await this.writeAddress(job.home, record);
    } catch (error) {
      log("https_dns_failed", { home: job.home, name: job.name, what: "address", error: error.message });
    }
    log("https_certificate_issued", { home: job.home, name: job.name, not_after: record.cert.not_after, renewal: Boolean(job.renewal) });
    this.tell({ type: "https_certificate_result", id: job.request, ok: true, status: "issued", ...this.certificateFields(record) });
  }

  // The order failed: the TXT record goes, and the controller is told (`retry_s` when known).
  async fail(job, code, retrySeconds, why) {
    await removeChallenge(this.env, job);
    await this.storage.delete("https_job");
    await this.relay.alarms.clear("https");
    log("https_certificate_failed", { home: job.home, name: job.name, code, step: job.step, why: String(why ?? "").slice(0, 300) });
    this.tell({ type: "https_certificate_result", id: job.request, ok: false, code, ...(retrySeconds ? { retry_s: retrySeconds } : {}) });
  }

  // To the controller's connection, when it is there and heard; otherwise it asks again when it
  // comes back, and is answered from what is kept.
  tell(message) {
    const ws = this.relay.heardDriverSocket();
    if (ws) this.relay.reply(ws, message);
  }
}
