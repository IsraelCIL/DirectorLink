// A new device joins by approval (ADR-053, docs/ACCOUNTS.md). A device signed in to the account,
// with no key for one of the account's homes (the iPhone's Home Screen app, which keeps its own
// storage and never receives an invitation link), asks; another device of the same account that
// holds a key there approves it, by making a for-me invitation at the controller and sealing it to
// the new device's public key. The cloud passes what the two devices exchange, for 10 minutes at
// most, and cannot open the invitation:
//
//   POST   /v1/homes/{home_id}/device-requests               { label, commitment }: the new device asks
//   GET    /v1/homes/{home_id}/device-requests               the account's open requests for the home
//   GET    /v1/homes/{home_id}/device-requests/{id}          one of them
//   POST   /v1/homes/{home_id}/device-requests/{id}/answer   { approver_key }: a device with a key takes it
//   POST   /v1/homes/{home_id}/device-requests/{id}/key      { device_key }: the new device shows its key
//   POST   /v1/homes/{home_id}/device-requests/{id}/approve  { sealed }: the invitation, sealed to it
//   POST   /v1/homes/{home_id}/device-requests/{id}/collect  the new device takes it; the request goes
//   DELETE /v1/homes/{home_id}/device-requests/{id}          declined, or withdrawn
//
// Only the account's own sessions see or change its requests. The new device sends a commitment
// to its public key first and the key itself only once the approving device's key is there, so
// whoever passes the keys on (this server too) cannot choose keys that give both screens the same
// check code: the code comes from both keys (app/js/device-join.js).

import { homeObject } from "./alerts.js";
import { json, problem, randomHex, readText, sha256Hex } from "./http.js";

// The label of the commitment, as app/js/device-join.js makes it.
export const COMMIT_LABEL = "DirectorLink device join v1|commit|";

const DEFAULT_SECONDS = 600;
const HOUR_MS = 3600 * 1000;
// Open requests one account may have, over all its homes, and requests it may start in an hour.
const MAX_OPEN_PER_ACCOUNT = 3;
const MAX_STARTS_PER_HOUR = 10;
const MAX_BODY_BYTES = 4096;
const MAX_LABEL = 48;
// The sealed invitation: base64 of a 12-byte IV and the AES-GCM ciphertext of a 106-character
// invitation with its tag (180 characters); room besides.
const MAX_SEALED = 512;
const COMMITMENT = /^[0-9a-f]{64}$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/; // 32 bytes, base64
const SEALED = /^[A-Za-z0-9+/]+={0,2}$/;
// Control characters, and the marks that turn text around (a label must read as it is).
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/g;

const COLUMNS = "id, home_id, label, commitment, approver_key, device_key, sealed, created_at, expires_at";

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

function lifetimeMs(env) {
  const value = Number(env.DEVICE_REQUEST_SECONDS);
  return Math.round((Number.isFinite(value) && value > 0 ? value : DEFAULT_SECONDS) * 1000);
}

async function body(request) {
  try {
    const text = await readText(request, MAX_BODY_BYTES);
    const value = text === null ? null : JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function cleanLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  return label && [...label].length <= MAX_LABEL ? label : null;
}

// What both devices see. Never the sealed invitation: only `collect` gives it, once.
function view(row) {
  const status = row.sealed ? "approved" : row.device_key ? "checking" : row.approver_key ? "answered" : "waiting";
  return {
    id: row.id,
    home_id: row.home_id,
    label: row.label,
    status,
    commitment: row.commitment,
    approver_key: row.approver_key ?? null,
    device_key: row.device_key ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

const notFound = () => problem(404, "NOT_FOUND", "No such request: it was declined, withdrawn, used, or it expired");

async function isMember(env, homeId, userId) {
  return Boolean(await env.DB.prepare("SELECT 1 AS found FROM members WHERE home_id = ? AND user_id = ?").bind(homeId, userId).first());
}

function notMember() {
  return problem(403, "NOT_A_MEMBER", "This account does not belong to that home");
}

// The key ids this account uses at the home, as far as the cloud has seen (member_keys).
async function keysAtHome(env, homeId, userId) {
  const { results } = await env.DB.prepare("SELECT key_id FROM member_keys WHERE home_id = ? AND user_id = ?").bind(homeId, userId).all();
  return results.map((row) => row.key_id);
}

// Whether one of the account's devices could approve: it holds a key at the home, an admin key
// when the controller names its admins (only admins make invitations there). A controller before
// 1.6.0 names none, and a home's object that cannot be asked says nothing: any key passes then.
async function approverExists(env, homeId, userId) {
  const keys = await keysAtHome(env, homeId, userId);
  if (!keys.length) return false;
  let admins = null;
  try {
    const answer = await homeObject(env, homeId, { op: "admins" });
    admins = Array.isArray(answer?.admins) ? new Set(answer.admins) : null;
  } catch (error) {
    log("device_request_roles_unknown", { home: homeId, error: String(error?.message ?? error) });
  }
  return admins === null || keys.some((key) => admins.has(key));
}

// The approving device's side: the account uses a key at the home (it holds one on some device;
// the controller still decides, when it is asked for the invitation, whether that key may).
async function approverRefused(env, homeId, userId) {
  if (!(await isMember(env, homeId, userId))) return notMember();
  if ((await keysAtHome(env, homeId, userId)).length) return null;
  return problem(403, "NO_KEY_AT_HOME", "This account uses no key at this home: approve from a device that does");
}

// The request, if it is this account's, for this home, and has not expired (an expired one goes).
async function findRequest(env, user, homeId, id) {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM device_requests WHERE id = ? AND home_id = ? AND user_id = ?`).bind(id, homeId, user.id).first();
  if (row && row.expires_at <= iso()) {
    await env.DB.prepare("DELETE FROM device_requests WHERE id = ?").bind(id).run();
    return null;
  }
  return row;
}

async function startRequest(request, env, user, homeId) {
  if (!(await isMember(env, homeId, user.id))) return notMember();
  const input = await body(request);
  const label = cleanLabel(input?.label);
  if (!label || typeof input?.commitment !== "string" || !COMMITMENT.test(input.commitment)) {
    return problem(400, "INVALID_REQUEST", `Send { label: up to ${MAX_LABEL} characters, commitment: 64 hex characters }`);
  }
  if (!(await approverExists(env, homeId, user.id))) {
    log("device_request_refused", { home: homeId, user: user.id, why: "no_approver" });
    return problem(409, "NO_APPROVER", "No device of this account holds an admin key at this home, so none could approve: ask an admin of the home for an invitation");
  }
  const now = Date.now();
  // The hour's starts, counted before the open requests are: an attempt is a start.
  const started = await env.DB.prepare(
    "INSERT INTO device_request_starts (user_id, window_start, count) VALUES (?1, ?2, 1) ON CONFLICT (user_id) DO UPDATE SET " +
      "count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END, window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END " +
      "RETURNING count"
  )
    .bind(user.id, iso(now), iso(now - HOUR_MS))
    .first();
  if ((started?.count ?? 0) > MAX_STARTS_PER_HOUR) {
    log("device_request_refused", { home: homeId, user: user.id, why: "hourly_limit" });
    return problem(429, "DEVICE_REQUEST_LIMIT_REACHED", `At most ${MAX_STARTS_PER_HOUR} requests an hour; try again later`);
  }
  const row = {
    id: randomHex(16),
    home_id: homeId,
    label,
    commitment: input.commitment,
    approver_key: null,
    device_key: null,
    sealed: null,
    created_at: iso(now),
    expires_at: iso(now + lifetimeMs(env)),
  };
  const inserted = await env.DB.prepare(
    "INSERT INTO device_requests (id, home_id, user_id, label, commitment, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? " +
      "WHERE (SELECT COUNT(*) FROM device_requests WHERE user_id = ? AND expires_at > ?) < ?"
  )
    .bind(row.id, homeId, user.id, label, row.commitment, row.created_at, row.expires_at, user.id, row.created_at, MAX_OPEN_PER_ACCOUNT)
    .run();
  if (!inserted.meta.changes) {
    log("device_request_refused", { home: homeId, user: user.id, why: "open_limit" });
    return problem(429, "DEVICE_REQUEST_LIMIT_REACHED", `At most ${MAX_OPEN_PER_ACCOUNT} requests may wait at a time; withdraw one, or wait 10 minutes`);
  }
  log("device_request_created", { home: homeId, user: user.id, request: row.id });
  return json(view(row), 201);
}

async function listRequests(env, user, homeId) {
  if (!(await isMember(env, homeId, user.id))) return notMember();
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM device_requests WHERE home_id = ? AND user_id = ? ORDER BY created_at`).bind(homeId, user.id).all();
  const now = iso();
  const expired = results.filter((row) => row.expires_at <= now).map((row) => row.id);
  // Polled while the app is open: a write only when something has expired.
  if (expired.length) {
    await env.DB.prepare(`DELETE FROM device_requests WHERE id IN (${expired.map(() => "?").join(", ")})`).bind(...expired).run();
  }
  return json({ items: results.filter((row) => row.expires_at > now).map(view) });
}

async function getRequest(env, user, homeId, id) {
  const row = await findRequest(env, user, homeId, id);
  return row ? json(view(row)) : notFound();
}

// A device with a key at the home takes the request: from now on only it can show the code. The
// same key again is fine (its answer was lost).
async function answerRequest(request, env, user, homeId, id) {
  const refused = await approverRefused(env, homeId, user.id);
  if (refused) return refused;
  const input = await body(request);
  if (typeof input?.approver_key !== "string" || !PUBLIC_KEY.test(input.approver_key)) {
    return problem(400, "INVALID_REQUEST", "Send { approver_key: an X25519 public key, base64 }");
  }
  const row = await env.DB.prepare(
    `UPDATE device_requests SET approver_key = ?1 WHERE id = ?2 AND home_id = ?3 AND user_id = ?4 AND expires_at > ?5 AND (approver_key IS NULL OR approver_key = ?1) RETURNING ${COLUMNS}`
  )
    .bind(input.approver_key, id, homeId, user.id, iso())
    .first();
  if (!row) {
    return (await findRequest(env, user, homeId, id)) ? problem(409, "ALREADY_ANSWERED", "Another device of this account is answering this request") : notFound();
  }
  log("device_request_answered", { home: homeId, user: user.id, request: id });
  return json(view(row));
}

// The new device shows its key, which must be the one it committed to, once a device answered.
async function showKey(request, env, user, homeId, id) {
  const input = await body(request);
  if (typeof input?.device_key !== "string" || !PUBLIC_KEY.test(input.device_key)) {
    return problem(400, "INVALID_REQUEST", "Send { device_key: an X25519 public key, base64 }");
  }
  const found = await findRequest(env, user, homeId, id);
  if (!found) return notFound();
  if (!found.approver_key) {
    return problem(409, "NOT_ANSWERED", "No device has answered this request yet");
  }
  if ((await sha256Hex(COMMIT_LABEL + input.device_key)) !== found.commitment) {
    return problem(400, "COMMITMENT_MISMATCH", "This is not the key the request committed to");
  }
  const row = await env.DB.prepare(
    `UPDATE device_requests SET device_key = ?1 WHERE id = ?2 AND user_id = ?3 AND (device_key IS NULL OR device_key = ?1) RETURNING ${COLUMNS}`
  )
    .bind(input.device_key, id, user.id)
    .first();
  return row ? json(view(row)) : notFound();
}

// The approving device's answer: the invitation, sealed to the new device's key. Passed on as it
// came; this server cannot open it.
async function approveRequest(request, env, user, homeId, id) {
  const refused = await approverRefused(env, homeId, user.id);
  if (refused) return refused;
  const input = await body(request);
  if (typeof input?.sealed !== "string" || input.sealed.length > MAX_SEALED || !SEALED.test(input.sealed)) {
    return problem(400, "INVALID_REQUEST", "Send { sealed: the invitation sealed to the new device, base64 }");
  }
  const row = await env.DB.prepare(
    `UPDATE device_requests SET sealed = ?1 WHERE id = ?2 AND home_id = ?3 AND user_id = ?4 AND expires_at > ?5 AND device_key IS NOT NULL AND sealed IS NULL RETURNING ${COLUMNS}`
  )
    .bind(input.sealed, id, homeId, user.id, iso())
    .first();
  if (!row) {
    const found = await findRequest(env, user, homeId, id);
    if (!found) return notFound();
    return found.sealed ? problem(409, "ALREADY_APPROVED", "This request was approved already") : problem(409, "NOT_READY", "The new device has not shown its key yet");
  }
  log("device_request_approved", { home: homeId, user: user.id, request: id });
  return json(view(row));
}

// The new device takes the sealed invitation, once: the request goes with it.
async function collectRequest(env, user, homeId, id) {
  const row = await env.DB.prepare(
    "DELETE FROM device_requests WHERE id = ? AND home_id = ? AND user_id = ? AND expires_at > ? AND sealed IS NOT NULL RETURNING sealed, approver_key"
  )
    .bind(id, homeId, user.id, iso())
    .first();
  if (!row) {
    return (await findRequest(env, user, homeId, id)) ? problem(409, "NOT_APPROVED", "This request has not been approved yet") : notFound();
  }
  log("device_request_collected", { home: homeId, user: user.id, request: id });
  return json({ sealed: row.sealed, approver_key: row.approver_key });
}

// Declined by a device of the account, or withdrawn by the new one.
async function deleteRequest(env, user, homeId, id) {
  const { meta } = await env.DB.prepare("DELETE FROM device_requests WHERE id = ? AND home_id = ? AND user_id = ?").bind(id, homeId, user.id).run();
  if (!meta.changes) return notFound();
  log("device_request_deleted", { home: homeId, user: user.id, request: id });
  return new Response(null, { status: 204 });
}

const ONE = /^\/v1\/homes\/([0-9a-f]{32})\/device-requests\/([0-9a-f]{32})/;

export const DEVICE_REQUEST_ROUTES = [
  [/^\/v1\/homes\/([0-9a-f]{32})\/device-requests$/, { GET: (r, env, user, m) => listRequests(env, user, m[1]), POST: (r, env, user, m) => startRequest(r, env, user, m[1]) }],
  [new RegExp(`${ONE.source}$`), { GET: (r, env, user, m) => getRequest(env, user, m[1], m[2]), DELETE: (r, env, user, m) => deleteRequest(env, user, m[1], m[2]) }],
  [new RegExp(`${ONE.source}/answer$`), { POST: (r, env, user, m) => answerRequest(r, env, user, m[1], m[2]) }],
  [new RegExp(`${ONE.source}/key$`), { POST: (r, env, user, m) => showKey(r, env, user, m[1], m[2]) }],
  [new RegExp(`${ONE.source}/approve$`), { POST: (r, env, user, m) => approveRequest(r, env, user, m[1], m[2]) }],
  [new RegExp(`${ONE.source}/collect$`), { POST: (r, env, user, m) => collectRequest(env, user, m[1], m[2]) }],
];

// Daily (cron): requests past their 10 minutes that nobody read again, and old hourly counts.
export async function purgeDeviceRequests(env) {
  const now = Date.now();
  const [requests, starts] = await env.DB.batch([
    env.DB.prepare("DELETE FROM device_requests WHERE expires_at <= ?").bind(iso(now)),
    env.DB.prepare("DELETE FROM device_request_starts WHERE window_start <= ?").bind(iso(now - HOUR_MS)),
  ]);
  log("device_requests_purged", { count: requests.meta?.changes ?? 0, starts: starts.meta?.changes ?? 0 });
}
