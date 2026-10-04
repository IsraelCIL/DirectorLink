// Homes and remote access for accounts (docs/ACCOUNTS.md): claiming a home, its members, invitations,
// and passing sealed requests to it. The cloud decides who may talk to which home and routes the
// envelopes; what is inside them it cannot read.
//
//   POST   /v1/homes/claim                          { home_id, claim_token }: the account owns the home
//   GET    /v1/homes                                the account's homes
//   GET    /v1/homes/{home_id}                      whether it is claimed, and by this account
//   POST   /v1/homes/{home_id}/e2e                  { envelope }: a sealed request, answered sealed
//   POST   /v1/homes/{home_id}/invitations          { invitation_id, email, expires_at }
//   GET    /v1/homes/{home_id}/members              who belongs to the home, with their key ids (the owner only)
//   DELETE /v1/homes/{home_id}/members/{user_id}    the owner removes someone; anyone may leave
//   POST   /v1/join                                 { home_id, invitation_id, envelope[, ask_owner] }: accept an invitation
//   GET    /v1/join/{home_id}/{invitation_id}       this account's request to join with it (another email)
//   DELETE /v1/join/{home_id}/{invitation_id}       withdraws that request
//   GET    /v1/homes/{home_id}/join-requests        requests waiting for the owner (the owner only)
//   POST   /v1/homes/{home_id}/join-requests/{id}   { decision: approve | refuse } (the owner only)
//   GET    /v1/homes/{home_id}/backups[/{id}], DELETE /v1/homes/{home_id}/backups   (backups.js)
//   GET, POST, DELETE /v1/homes/{home_id}/alerts    this browser's alerts (admins; alerts.js)
//   /v1/homes/{home_id}/device-requests[/...]       a new device joins by approval (device-requests.js)
//
// All need the session cookie; they answer CORS with credentials only for the app's origins, and
// refuse changes from any other origin.

import { appOrigins, currentUser } from "./accounts.js";
import { BACKUP_ROUTES } from "./backups.js";
import { handleHomeAlerts, homesChanged } from "./alerts.js";
import { DEVICE_REQUEST_ROUTES } from "./device-requests.js";
import { json, problem, randomHex, readText } from "./http.js";
import { PURGE_GRACE_MS, forgetInvitations } from "./invitations.js";
import { validKeyId } from "./member-keys.js";

const HOME_ID = /^[0-9a-f]{32}$/;
const SHORT_ID = /^[0-9a-f]{8}$/;
const USER_ID = /^[0-9a-f]{32}$/;
const CLAIM_TOKEN = /^[0-9a-f]{48}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The driver refuses sealed requests over 64 KiB (Remote.MAX_REQUEST_BYTES), i.e. 128 KiB of base64.
const MAX_REQUEST_CT = 128 * 1024;
const MAX_BODY_BYTES = MAX_REQUEST_CT + 4096;
const MAX_INVITATION_MS = 7 * 24 * 3600 * 1000;
// Controllers' clocks may run a little fast (the lock allows 2 minutes).
const INVITATION_SKEW_MS = 10 * 60 * 1000;
// The creator recorded for invitations the controller registered itself.
const HOME_CREATOR = "home";

// Pending invitations one account may have registered for one home (the controller allows 20).
const MAX_PENDING_PER_MEMBER = 20;
// Pending invitations a controller may have registered for its home (it keeps at most 20 itself).
const MAX_PENDING_PER_HOME = 20;
const SECRET_SHA256 = /^[0-9a-f]{64}$/;

// Requests to join with an invitation made for another email (ADR-041): a few open per invitation
// (waiting or approved; a refusal still stops the account it refused), and at most 20 waiting for a
// home's owner on invitations that can still be accepted.
const MAX_REQUESTS_PER_INVITATION = 5;
const MAX_WAITING_REQUESTS_PER_HOME = 20;
// Apple's Hide My Email: an address that says nothing about who it is.
const HIDDEN_EMAIL = /@privaterelay\.appleid\.com$/;
// An invitation that can still be accepted (a tombstone has no email).
const LIVE_INVITATION = "invitations.email <> '' AND invitations.accepted_by IS NULL AND invitations.expires_at > ?";

// The driver's codes (driver/src/cloud/remote.lua) as HTTP answers.
const CODES = {
  UNKNOWN_KEY: [403, "This device's key is not known to the home; it may have been revoked"],
  BAD_MAC: [400, "The home could not verify the sealed request"],
  BAD_ENVELOPE: [400, "The sealed request is malformed"],
  BAD_REQUEST: [400, "The sealed request is not a valid request"],
  STALE: [400, "The request's time is too far from the home's clock"],
  REPLAYED: [409, "This request was already received"],
  TOO_LARGE: [413, "The request is too large"],
  LOCK_UNAVAILABLE: [503, "The home cannot seal remote requests (its lock self-test failed)"],
  INVITATION_NOT_FOUND: [404, "The invitation was used, revoked or has expired"],
  INVALID_CLAIM: [403, "The claim token is wrong or has expired; get a new one at home"],
  KEY_LIMIT_REACHED: [409, "The home already has as many API keys as it allows"],
  INTERNAL: [502, "The home failed to answer"],
};

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

function driverProblem(code) {
  const [status, detail] = CODES[code] ?? [502, `The home refused the request (${code})`];
  return problem(status, CODES[code] ? code : "HOME_REFUSED", detail);
}

async function body(request) {
  try {
    const text = await readText(request, MAX_BODY_BYTES);
    if (text === null) {
      return null;
    }
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Only the envelope's own fields go on to the home.
function cleanEnvelope(envelope) {
  return { v: 1, home: envelope.home, key: envelope.key, iv: envelope.iv, ct: envelope.ct, mac: envelope.mac };
}

function validEnvelope(envelope, homeId, key) {
  return (
    envelope &&
    typeof envelope === "object" &&
    envelope.v === 1 &&
    envelope.home === homeId &&
    typeof envelope.key === "string" &&
    SHORT_ID.test(envelope.key) &&
    (key === undefined || envelope.key === key) &&
    typeof envelope.iv === "string" &&
    envelope.iv.length === 24 &&
    BASE64.test(envelope.iv) &&
    typeof envelope.ct === "string" &&
    envelope.ct.length > 0 &&
    envelope.ct.length <= MAX_REQUEST_CT &&
    BASE64.test(envelope.ct) &&
    typeof envelope.mac === "string" &&
    envelope.mac.length === 44 &&
    BASE64.test(envelope.mac)
  );
}

// Sends an e2e, join or claim message to the home's relay object and returns its reply (or a
// problem Response: offline, timeout, disconnected).
// `userId`: for e2e, the account sending it (the home's object records its key if accepted).
async function relay(env, homeId, message, userId) {
  const stub = env.HOME_RELAY.get(env.HOME_RELAY.idFromName(homeId));
  const response = await stub.fetch("https://home-relay/message", {
    method: "POST",
    headers: { "X-DirectorLink-Home": homeId, "content-type": "application/json", ...(userId ? { "X-DirectorLink-User": userId } : {}) },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    // A fetched Response's headers are read-only; the copy can take the CORS headers.
    return { response: new Response(response.body, response) };
  }
  return { reply: await response.json() };
}

async function homeStatus(env, homeId) {
  const stub = env.HOME_RELAY.get(env.HOME_RELAY.idFromName(homeId));
  const response = await stub.fetch("https://home-relay/status", { headers: { "X-DirectorLink-Home": homeId } });
  return response.ok ? response.json() : { connected: false };
}

async function member(env, homeId, userId) {
  return env.DB.prepare(
    "SELECT homes.owner_id AS owner_id, members.added_at AS added_at FROM members JOIN homes ON homes.id = members.home_id WHERE members.home_id = ? AND members.user_id = ?"
  )
    .bind(homeId, userId)
    .first();
}

async function claim(request, env, user) {
  const input = await body(request);
  if (!input || !HOME_ID.test(input.home_id ?? "") || !CLAIM_TOKEN.test(input.claim_token ?? "")) {
    return problem(400, "INVALID_REQUEST", "Send { home_id: 32 hex characters, claim_token: 48 hex characters } from your controller");
  }
  const homeId = input.home_id;
  const { reply, response } = await relay(env, homeId, { type: "claim", token: input.claim_token });
  if (response) {
    return response;
  }
  if (reply.ok !== true) {
    log("claim_refused", { home: homeId, user: user.id });
    return driverProblem(reply.code ?? "INVALID_CLAIM");
  }
  const now = iso();
  const existing = await env.DB.prepare("SELECT owner_id FROM homes WHERE id = ?").bind(homeId).first();
  const transferred = Boolean(existing && existing.owner_id !== user.id);
  const statements = [];
  if (!existing) {
    statements.push(env.DB.prepare("INSERT INTO homes (id, owner_id, claimed_at) VALUES (?, ?, ?)").bind(homeId, user.id, now));
  } else if (transferred) {
    // Whoever holds an admin key at home controls the home: the new owner starts with no one else,
    // and the others' browsers get no more of its alerts.
    statements.push(
      env.DB.prepare("DELETE FROM push_subscriptions WHERE home_id = ? AND user_id != ?").bind(homeId, user.id),
      env.DB.prepare("UPDATE homes SET owner_id = ?, claimed_at = ? WHERE id = ?").bind(user.id, now, homeId),
      env.DB.prepare("DELETE FROM members WHERE home_id = ? AND user_id != ?").bind(homeId, user.id),
      env.DB.prepare("DELETE FROM member_keys WHERE home_id = ? AND user_id != ?").bind(homeId, user.id),
      ...forgetInvitations(env, "home_id = ?", homeId)
    );
  }
  statements.push(env.DB.prepare("INSERT OR IGNORE INTO members (home_id, user_id, added_at) VALUES (?, ?, ?)").bind(homeId, user.id, now));
  const [first] = await env.DB.batch(statements);
  if (transferred && first.meta?.changes) {
    await homesChanged(env, [homeId]);
  }
  log("home_claimed", { home: homeId, user: user.id, transferred });
  return json({ home_id: homeId, owner: true, transferred });
}

// Whether a home is claimed, and whether by this account: the app asks before offering to link
// it, so that nobody takes a home from its owner without being told.
async function homeInfo(env, user, homeId) {
  const home = await env.DB.prepare("SELECT owner_id FROM homes WHERE id = ?").bind(homeId).first();
  const joined = home ? await member(env, homeId, user.id) : null;
  return json({ home_id: homeId, claimed: Boolean(home), owner: Boolean(home && home.owner_id === user.id), member: Boolean(joined) });
}

async function listHomes(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT homes.id AS id, homes.owner_id AS owner_id, members.added_at AS added_at FROM members JOIN homes ON homes.id = members.home_id WHERE members.user_id = ? ORDER BY members.added_at"
  )
    .bind(user.id)
    .all();
  const items = [];
  for (const row of results) {
    const status = await homeStatus(env, row.id);
    items.push({ home_id: row.id, owner: row.owner_id === user.id, added_at: row.added_at, connected: Boolean(status.connected) });
  }
  return json({ items });
}

async function e2e(request, env, user, homeId) {
  if (!(await member(env, homeId, user.id))) {
    return problem(403, "NOT_A_MEMBER", "This account does not belong to that home");
  }
  const input = await body(request);
  if (!input || !validEnvelope(input.envelope, homeId)) {
    return problem(400, "INVALID_ENVELOPE", "Send { envelope } sealed for this home (docs/ACCOUNTS.md)");
  }
  const { reply, response } = await relay(env, homeId, { type: "e2e", envelope: cleanEnvelope(input.envelope) }, user.id);
  if (response) {
    return response;
  }
  if (!reply.envelope) {
    log("e2e_refused", { home: homeId, user: user.id, code: reply.code ?? null });
    return driverProblem(reply.code ?? "INTERNAL");
  }
  return json({ envelope: reply.envelope });
}

// An invitation the controller registers itself (driver 1.0.0 and later, over its connection):
// { id, invitation_id, email, expires_at } -> { ok } or { ok: false, code }.
export async function registerHomeInvitation(env, homeId, data) {
  const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
  const expires = Date.parse(data?.expires_at ?? "");
  if (!SHORT_ID.test(data?.invitation_id ?? "") || !EMAIL.test(email) || email.length > 254 || !Number.isFinite(expires)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  if (expires <= Date.now() || expires > Date.now() + MAX_INVITATION_MS + INVITATION_SKEW_MS) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  // Invitations belong to a home an account has claimed; nobody could accept one otherwise.
  if (!(await env.DB.prepare("SELECT 1 AS found FROM homes WHERE id = ?").bind(homeId).first())) {
    return { ok: false, code: "NOT_CLAIMED" };
  }
  const now = iso();
  const statements = [
    env.DB.prepare("DELETE FROM invitations WHERE home_id = ? AND (expires_at < ? OR accepted_by IS NOT NULL)").bind(homeId, iso(Date.now() - PURGE_GRACE_MS)),
  ];
  // The controller's list of invitations still waiting there (with this one): those it revoked
  // meanwhile are forgotten, so they no longer count against the limit.
  const pending = Array.isArray(data.pending) ? data.pending : null;
  if (pending && pending.length > 0 && pending.length <= 50 && pending.every((id) => SHORT_ID.test(id ?? ""))) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM invitations WHERE home_id = ? AND created_by = ? AND accepted_by IS NULL AND id NOT IN (${pending.map(() => "?").join(", ")})`
      ).bind(homeId, HOME_CREATOR, ...pending)
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO invitations (home_id, id, email, expires_at, created_by) SELECT ?, ?, ?, ?, ? " +
        "WHERE (SELECT COUNT(*) FROM invitations WHERE home_id = ? AND created_by = ? AND accepted_by IS NULL AND expires_at > ?) < ? " +
        "ON CONFLICT (home_id, id) DO NOTHING"
    ).bind(homeId, data.invitation_id, email, iso(expires), HOME_CREATOR, homeId, HOME_CREATOR, now, MAX_PENDING_PER_HOME)
  );
  const results = await env.DB.batch(statements);
  const inserted = results[results.length - 1];
  if (!inserted.meta.changes) {
    const exists = await env.DB.prepare("SELECT 1 AS found FROM invitations WHERE home_id = ? AND id = ?").bind(homeId, data.invitation_id).first();
    return { ok: false, code: exists ? "INVITATION_EXISTS" : "INVITATION_LIMIT_REACHED" };
  }
  log("invitation_registered", { home: homeId, by: "home", invitation: data.invitation_id });
  return { ok: true };
}

// The controller gave up on an invitation it asked to register (no answer in time): the row goes,
// unless someone already accepted it.
export async function cancelHomeInvitation(env, homeId, data) {
  if (!SHORT_ID.test(data?.invitation_id ?? "")) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  await env.DB.prepare("DELETE FROM invitations WHERE home_id = ? AND id = ? AND created_by = ? AND accepted_by IS NULL")
    .bind(homeId, data.invitation_id, HOME_CREATOR)
    .run();
  log("invitation_cancelled", { home: homeId, by: "home", invitation: data.invitation_id });
  return { ok: true };
}

// The owner approves a new secret for the home's relay connection: its SHA-256, which the owner's
// app got from the controller on the home network (POST /v1/remote/secret there). From then on the
// relay accepts only the new secret, and the controller connects with it (docs/RELAY.md). Whoever
// holds a copy of the controller's data can connect as the home, but cannot do this.
async function replaceSecret(request, env, user, homeId) {
  const home = await env.DB.prepare("SELECT owner_id FROM homes WHERE id = ?").bind(homeId).first();
  if (!home || home.owner_id !== user.id) {
    return problem(403, "OWNER_ONLY", "Only the home's owner replaces its secret");
  }
  const input = await body(request);
  const hash = typeof input?.secret_sha256 === "string" ? input.secret_sha256.toLowerCase() : "";
  if (!SECRET_SHA256.test(hash)) {
    return problem(400, "INVALID_REQUEST", "Send { secret_sha256 } from your controller (POST /v1/remote/secret on the home network)");
  }
  const stub = env.HOME_RELAY.get(env.HOME_RELAY.idFromName(homeId));
  const response = await stub.fetch("https://home-relay/secret", {
    method: "POST",
    headers: { "X-DirectorLink-Home": homeId, "content-type": "application/json" },
    body: JSON.stringify({ secret_sha256: hash }),
  });
  if (!response.ok) {
    return new Response(response.body, response);
  }
  log("home_secret_approved", { home: homeId, user: user.id });
  return new Response(null, { status: 204 });
}

// Registered by the home's owner, for controllers before 1.0.0 (which do not register their
// invitations themselves). Other members may not: the cloud does not know their role.
async function registerInvitation(request, env, user, homeId) {
  if (!(await member(env, homeId, user.id))) {
    return problem(403, "NOT_A_MEMBER", "This account does not belong to that home");
  }
  const home = await env.DB.prepare("SELECT owner_id FROM homes WHERE id = ?").bind(homeId).first();
  if (!home || home.owner_id !== user.id) {
    return problem(403, "OWNER_ONLY", "Only the home's owner registers invitations here; the controller registers the others itself");
  }
  const input = await body(request);
  const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  const expires = Date.parse(input?.expires_at ?? "");
  if (!input || !SHORT_ID.test(input.invitation_id ?? "") || !EMAIL.test(email) || email.length > 254 || !Number.isFinite(expires)) {
    return problem(400, "INVALID_REQUEST", "Send { invitation_id: 8 hex characters, email, expires_at } for an invitation from your controller");
  }
  if (expires <= Date.now() || expires > Date.now() + MAX_INVITATION_MS + INVITATION_SKEW_MS) {
    return problem(400, "INVALID_REQUEST", "expires_at must be in the next 7 days");
  }
  // An invitation is bound to its email once: nobody, not even another member of the home, can
  // move it to another address. Each member has at most 20 pending here.
  const now = iso();
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM invitations WHERE home_id = ? AND (expires_at < ? OR accepted_by IS NOT NULL)").bind(homeId, iso(Date.now() - PURGE_GRACE_MS)),
    env.DB.prepare(
      "INSERT INTO invitations (home_id, id, email, expires_at, created_by) SELECT ?, ?, ?, ?, ? " +
        "WHERE (SELECT COUNT(*) FROM invitations WHERE home_id = ? AND created_by = ? AND accepted_by IS NULL AND expires_at > ?) < ? " +
        "ON CONFLICT (home_id, id) DO NOTHING"
    ).bind(homeId, input.invitation_id, email, iso(expires), user.id, homeId, user.id, now, MAX_PENDING_PER_MEMBER),
  ]);
  if (!inserted.meta.changes) {
    const exists = await env.DB.prepare("SELECT 1 AS found FROM invitations WHERE home_id = ? AND id = ?").bind(homeId, input.invitation_id).first();
    return exists
      ? problem(409, "INVITATION_EXISTS", "This invitation is already registered")
      : problem(429, "INVITATION_LIMIT_REACHED", `At most ${MAX_PENDING_PER_MEMBER} invitations may wait at a time; revoke some first`);
  }
  log("invitation_registered", { home: homeId, user: user.id, invitation: input.invitation_id });
  return json({ invitation_id: input.invitation_id, email, expires_at: iso(expires) }, 201);
}

// Six digits the person asking sees, and the owner too, next to the request: the owner approves only
// when the person they invited reads out the same code.
function confirmationCode() {
  const limit = 4294000000; // the largest multiple of 1,000,000 below 2^32: every code as likely
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) {
      return String(value % 1000000).padStart(6, "0");
    }
  }
}

function joinRequestAnswer(row, expiresAt) {
  return { status: row.status, code: row.code, requested_at: row.requested_at, decided_at: row.decided_at ?? null, expires_at: expiresAt };
}

function invitationNotFound() {
  return problem(404, "INVITATION_NOT_FOUND", "The invitation was used, revoked or has expired; ask for a new one");
}

function refusedJoin() {
  return problem(403, "REFUSED_BY_OWNER", "The home's owner did not let this account join with this invitation");
}

// The signed-in account's invitation is for another email: the account asks the home's owner. Only
// the invitation's id is needed here, not its secret, which the controller checks when the approved
// account joins (with a new envelope: the controller accepts one only within 2 minutes).
async function askOwner(env, user, homeId, invitationId, invitation) {
  const now = iso();
  const id = randomHex(16);
  const code = confirmationCode();
  const inserted = await env.DB.prepare(
    "INSERT INTO join_requests (id, home_id, invitation_id, user_id, code, status, requested_at) SELECT ?, ?, ?, ?, ?, 'pending', ? " +
      `WHERE EXISTS (SELECT 1 FROM invitations WHERE home_id = ? AND id = ? AND ${LIVE_INVITATION}) ` +
      "AND (SELECT COUNT(*) FROM join_requests WHERE home_id = ? AND invitation_id = ? AND status IN ('pending', 'approved')) < ? " +
      "AND (SELECT COUNT(*) FROM join_requests JOIN invitations ON invitations.home_id = join_requests.home_id AND invitations.id = join_requests.invitation_id " +
      `WHERE join_requests.home_id = ? AND join_requests.status = 'pending' AND ${LIVE_INVITATION}) < ? ` +
      "ON CONFLICT (home_id, invitation_id, user_id) DO NOTHING"
  )
    .bind(id, homeId, invitationId, user.id, code, now, homeId, invitationId, now, homeId, invitationId, MAX_REQUESTS_PER_INVITATION, homeId, now, MAX_WAITING_REQUESTS_PER_HOME)
    .run();
  if (!inserted.meta.changes) {
    const asked = await env.DB.prepare("SELECT code, status, requested_at, decided_at FROM join_requests WHERE home_id = ? AND invitation_id = ? AND user_id = ?")
      .bind(homeId, invitationId, user.id)
      .first();
    if (asked) {
      // The same account asking twice at once.
      return asked.status === "refused" ? refusedJoin() : json(joinRequestAnswer(asked, invitation.expires_at), 202);
    }
    if (!(await env.DB.prepare(`SELECT 1 AS found FROM invitations WHERE home_id = ? AND id = ? AND ${LIVE_INVITATION}`).bind(homeId, invitationId, now).first())) {
      return invitationNotFound();
    }
    return problem(429, "JOIN_REQUEST_LIMIT_REACHED", "Too many accounts are waiting for this home's owner; ask for an invitation to this account's email instead");
  }
  log("join_request_created", { home: homeId, user: user.id, invitation: invitationId, request: id });
  return json({ status: "pending", code, requested_at: now, decided_at: null, expires_at: invitation.expires_at }, 202);
}

async function join(request, env, user) {
  const input = await body(request);
  const homeId = input?.home_id;
  if (!input || !HOME_ID.test(homeId ?? "") || !SHORT_ID.test(input.invitation_id ?? "") || !validEnvelope(input.envelope, homeId, input.invitation_id)) {
    return problem(400, "INVALID_REQUEST", "Send { home_id, invitation_id, envelope } from the invitation link");
  }
  const invitation = await env.DB.prepare("SELECT email, expires_at, accepted_by FROM invitations WHERE home_id = ? AND id = ?")
    .bind(homeId, input.invitation_id)
    .first();
  if (!invitation || !invitation.email || invitation.accepted_by || invitation.expires_at < iso()) {
    return invitationNotFound();
  }
  // The account's email, or the email of one of its sign-ins (a Google address added to an account
  // made with Apple's Hide My Email, for instance).
  const mine =
    invitation.email === user.email ||
    Boolean(await env.DB.prepare("SELECT 1 AS found FROM identities WHERE user_id = ? AND email = ?").bind(user.id, invitation.email).first());
  // Another email: only with the approval of the home's owner (ADR-041).
  if (!mine) {
    const asked = await env.DB.prepare("SELECT code, status, requested_at, decided_at FROM join_requests WHERE home_id = ? AND invitation_id = ? AND user_id = ?")
      .bind(homeId, input.invitation_id, user.id)
      .first();
    if (!asked) {
      if (input.ask_owner === true) {
        return askOwner(env, user, homeId, input.invitation_id, invitation);
      }
      log("join_email_mismatch", { home: homeId, user: user.id, invitation: input.invitation_id });
      return problem(403, "EMAIL_MISMATCH", "This invitation is for another email address; sign in with that account, or ask for an invitation for this one");
    }
    if (asked.status === "refused") {
      return refusedJoin();
    }
    if (asked.status !== "approved") {
      return json(joinRequestAnswer(asked, invitation.expires_at), 202);
    }
  }
  const { reply, response } = await relay(env, homeId, { type: "join", invitation: input.invitation_id, envelope: cleanEnvelope(input.envelope) });
  if (response) {
    return response;
  }
  if (reply.ok !== true || !reply.envelope) {
    log("join_refused", { home: homeId, user: user.id, code: reply.code ?? null });
    return driverProblem(reply.code ?? "INTERNAL");
  }
  // The controller has made the key; membership follows only while the invitation is still
  // pending here (a change of owner meanwhile tombstones it) and, for another email, still
  // approved. The used invitation goes, with the requests to join with it. The sealed answer goes
  // back with whether this account is now a member; for another email only if it is: an account
  // the owner refused while the home made the key never gets it (the owner sees the new key in
  // People and devices, and can remove it).
  const decided = mine
    ? null
    : await env.DB.prepare("SELECT status FROM join_requests WHERE home_id = ? AND invitation_id = ? AND user_id = ?").bind(homeId, input.invitation_id, user.id).first();
  const now = iso();
  const pending =
    "EXISTS (SELECT 1 FROM invitations WHERE home_id = ? AND id = ? AND email = ? AND accepted_by IS NULL)" +
    (mine ? "" : " AND EXISTS (SELECT 1 FROM join_requests WHERE home_id = ? AND invitation_id = ? AND user_id = ? AND status = 'approved')");
  const allowed = [homeId, input.invitation_id, invitation.email, ...(mine ? [] : [homeId, input.invitation_id, user.id])];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO members (home_id, user_id, added_at) SELECT ?, ?, ? WHERE ${pending}`).bind(homeId, user.id, now, ...allowed),
        // The new key is this account's (revoking it at home ends the membership).
        ...(validKeyId(reply.key_id)
          ? [env.DB.prepare(`INSERT OR IGNORE INTO member_keys (home_id, key_id, user_id, added_at) SELECT ?, ?, ?, ? WHERE ${pending}`).bind(homeId, reply.key_id, user.id, now, ...allowed)]
          : []),
        env.DB.prepare("DELETE FROM join_requests WHERE home_id = ? AND invitation_id = ?").bind(homeId, input.invitation_id),
        env.DB.prepare("DELETE FROM invitations WHERE home_id = ? AND id = ? AND email = ? AND accepted_by IS NULL").bind(homeId, input.invitation_id, invitation.email),
      ]);
      break;
    } catch (error) {
      log("join_record_failed", { home: homeId, user: user.id, attempt, error: String(error?.message ?? error) });
    }
  }
  const joined = Boolean(await member(env, homeId, user.id).catch(() => null));
  if (!mine && !joined) {
    log("join_key_withheld", { home: homeId, user: user.id, invitation: input.invitation_id, request: decided?.status ?? null, key_id: validKeyId(reply.key_id) ? reply.key_id : null });
    return decided?.status === "refused" ? refusedJoin() : invitationNotFound();
  }
  log("invitation_accepted", { home: homeId, user: user.id, invitation: input.invitation_id, member: joined, approved: !mine });
  return json({ home_id: homeId, envelope: reply.envelope, member: joined });
}

// The signed-in account's request to join with an invitation: the app asks every few seconds while
// the person waits. `expired`: the invitation ran out before the owner approved it.
async function myJoinRequest(env, user, homeId, invitationId) {
  const row = await env.DB.prepare(
    "SELECT join_requests.code AS code, join_requests.status AS status, join_requests.requested_at AS requested_at, join_requests.decided_at AS decided_at, " +
      "invitations.email AS email, invitations.accepted_by AS accepted_by, invitations.expires_at AS expires_at " +
      "FROM join_requests JOIN invitations ON invitations.home_id = join_requests.home_id AND invitations.id = join_requests.invitation_id " +
      "WHERE join_requests.home_id = ? AND join_requests.invitation_id = ? AND join_requests.user_id = ?"
  )
    .bind(homeId, invitationId, user.id)
    .first();
  if (!row) {
    const live = await env.DB.prepare(`SELECT 1 AS found FROM invitations WHERE home_id = ? AND id = ? AND ${LIVE_INVITATION}`).bind(homeId, invitationId, iso()).first();
    return live ? problem(404, "NOT_FOUND", "This account has not asked to join with this invitation") : invitationNotFound();
  }
  if (!row.email || row.accepted_by) {
    return invitationNotFound();
  }
  const status = row.status !== "refused" && row.expires_at < iso() ? "expired" : row.status;
  return json({ ...joinRequestAnswer(row, row.expires_at), status });
}

// The person asking changes their mind (a refusal stays: it is the owner's answer).
async function withdrawJoinRequest(env, user, homeId, invitationId) {
  const { meta } = await env.DB.prepare("DELETE FROM join_requests WHERE home_id = ? AND invitation_id = ? AND user_id = ? AND status <> 'refused'")
    .bind(homeId, invitationId, user.id)
    .run();
  if (!meta.changes) {
    return problem(404, "NOT_FOUND", "This account has no request to withdraw for this invitation");
  }
  log("join_request_withdrawn", { home: homeId, user: user.id, invitation: invitationId });
  return new Response(null, { status: 204 });
}

async function ownerOnly(env, user, homeId) {
  const home = await env.DB.prepare("SELECT owner_id FROM homes WHERE id = ?").bind(homeId).first();
  return home && home.owner_id === user.id ? null : problem(403, "OWNER_ONLY", "Only the home's owner sees and answers requests to join it");
}

// What the owner needs to tell the person they invited from a stranger with their link: who the
// account says it is (nobody checks the name), how it signs in, its email unless Apple hides it,
// how old it is, when it asked, for which invitation, and the code to compare.
async function listJoinRequests(env, user, homeId) {
  const refused = await ownerOnly(env, user, homeId);
  if (refused) {
    return refused;
  }
  const [{ results }, { results: identities }] = await env.DB.batch([
    env.DB.prepare(
      "SELECT join_requests.id AS id, join_requests.user_id AS user_id, join_requests.code AS code, join_requests.status AS status, " +
        "join_requests.requested_at AS requested_at, join_requests.decided_at AS decided_at, join_requests.invitation_id AS invitation_id, " +
        "invitations.email AS invitation_email, invitations.expires_at AS expires_at, users.name AS name, users.email AS email, users.created_at AS account_created_at " +
        "FROM join_requests JOIN invitations ON invitations.home_id = join_requests.home_id AND invitations.id = join_requests.invitation_id " +
        "JOIN users ON users.id = join_requests.user_id " +
        `WHERE join_requests.home_id = ? AND join_requests.status IN ('pending', 'approved') AND ${LIVE_INVITATION} ORDER BY join_requests.requested_at`
    ).bind(homeId, iso()),
    env.DB.prepare("SELECT user_id, provider FROM identities WHERE user_id IN (SELECT user_id FROM join_requests WHERE home_id = ?) ORDER BY created_at").bind(homeId),
  ]);
  return json({
    items: results.map((row) => {
      const hidden = HIDDEN_EMAIL.test(row.email ?? "");
      return {
        id: row.id,
        user_id: row.user_id,
        name: row.name ?? null,
        email: hidden ? null : row.email,
        email_hidden: hidden,
        providers: identities.filter((identity) => identity.user_id === row.user_id).map((identity) => identity.provider),
        account_created_at: row.account_created_at,
        requested_at: row.requested_at,
        status: row.status,
        decided_at: row.decided_at ?? null,
        code: row.code,
        invitation: { id: row.invitation_id, email: row.invitation_email, expires_at: row.expires_at },
      };
    }),
  });
}

// The owner approves (the account may then join with the invitation, once) or refuses. Either can
// be changed while the invitation lasts and nobody has used it.
async function decideJoinRequest(request, env, user, homeId, requestId) {
  const refused = await ownerOnly(env, user, homeId);
  if (refused) {
    return refused;
  }
  const input = await body(request);
  if (input?.decision !== "approve" && input?.decision !== "refuse") {
    return problem(400, "INVALID_REQUEST", 'Send { "decision": "approve" } or { "decision": "refuse" }');
  }
  const status = input.decision === "approve" ? "approved" : "refused";
  const now = iso();
  const row = await env.DB.prepare(
    "UPDATE join_requests SET status = ?, decided_at = ? WHERE id = ? AND home_id = ? " +
      `AND EXISTS (SELECT 1 FROM invitations WHERE invitations.home_id = join_requests.home_id AND invitations.id = join_requests.invitation_id AND ${LIVE_INVITATION}) ` +
      "RETURNING user_id, invitation_id"
  )
    .bind(status, now, requestId, homeId, now)
    .first();
  if (!row) {
    return problem(404, "NOT_FOUND", "No such request is waiting: its invitation may have been used, revoked or expired");
  }
  log("join_request_decided", { home: homeId, user: user.id, requester: row.user_id, invitation: row.invitation_id, status });
  return json({ id: requestId, status, decided_at: now });
}

async function listMembers(env, user, homeId) {
  const row = await member(env, homeId, user.id);
  if (!row || row.owner_id !== user.id) {
    return problem(403, "OWNER_ONLY", "Only the home's owner sees its members");
  }
  const [{ results }, { results: keys }] = await env.DB.batch([
    env.DB.prepare(
      "SELECT users.id AS id, users.email AS email, users.name AS name, members.added_at AS added_at FROM members JOIN users ON users.id = members.user_id WHERE members.home_id = ? ORDER BY members.added_at"
    ).bind(homeId),
    env.DB.prepare("SELECT user_id, key_id FROM member_keys WHERE home_id = ? ORDER BY added_at").bind(homeId),
  ]);
  return json({
    items: results.map((r) => ({
      user_id: r.id,
      email: r.email,
      name: r.name,
      owner: r.id === user.id,
      added_at: r.added_at,
      key_ids: keys.filter((key) => key.user_id === r.id).map((key) => key.key_id),
    })),
  });
}

async function removeMember(env, user, homeId, userId) {
  const row = await member(env, homeId, user.id);
  if (!row) {
    return problem(403, "NOT_A_MEMBER", "This account does not belong to that home");
  }
  const self = userId === user.id;
  if (!self && row.owner_id !== user.id) {
    return problem(403, "OWNER_ONLY", "Only the home's owner removes others");
  }
  if (self && row.owner_id === user.id) {
    return problem(409, "OWNER_CANNOT_LEAVE", "The owner stays; another account can claim the home at home instead");
  }
  // Its browsers' subscriptions go with the membership.
  const [alerts, { meta }] = await env.DB.batch([
    env.DB.prepare("DELETE FROM push_subscriptions WHERE home_id = ? AND user_id = ?").bind(homeId, userId),
    env.DB.prepare("DELETE FROM members WHERE home_id = ? AND user_id = ?").bind(homeId, userId),
    env.DB.prepare("DELETE FROM member_keys WHERE home_id = ? AND user_id = ?").bind(homeId, userId),
  ]);
  if (alerts.meta?.changes) {
    await homesChanged(env, [homeId]);
  }
  if (!meta.changes) {
    return problem(404, "NOT_FOUND", "That account does not belong to the home");
  }
  log("member_removed", { home: homeId, user: user.id, removed: userId });
  return new Response(null, { status: 204 });
}

const ROUTES = [
  [/^\/v1\/homes\/claim$/, { POST: (r, env, user) => claim(r, env, user) }],
  [/^\/v1\/homes$/, { GET: (r, env, user) => listHomes(env, user) }],
  [/^\/v1\/homes\/([0-9a-f]{32})$/, { GET: (r, env, user, m) => homeInfo(env, user, m[1]) }],
  [/^\/v1\/homes\/([0-9a-f]{32})\/e2e$/, { POST: (r, env, user, m) => e2e(r, env, user, m[1]) }],
  [/^\/v1\/homes\/([0-9a-f]{32})\/invitations$/, { POST: (r, env, user, m) => registerInvitation(r, env, user, m[1]) }],
  [/^\/v1\/homes\/([0-9a-f]{32})\/secret$/, { POST: (r, env, user, m) => replaceSecret(r, env, user, m[1]) }],
  [/^\/v1\/homes\/([0-9a-f]{32})\/members$/, { GET: (r, env, user, m) => listMembers(env, user, m[1]) }],
  [/^\/v1\/homes\/([0-9a-f]{32})\/members\/([0-9a-f]{32})$/, { DELETE: (r, env, user, m) => removeMember(env, user, m[1], m[2]) }],
  [/^\/v1\/join$/, { POST: (r, env, user) => join(r, env, user) }],
  [/^\/v1\/join\/([0-9a-f]{32})\/([0-9a-f]{8})$/, { GET: (r, env, user, m) => myJoinRequest(env, user, m[1], m[2]), DELETE: (r, env, user, m) => withdrawJoinRequest(env, user, m[1], m[2]) }],
  [/^\/v1\/homes\/([0-9a-f]{32})\/join-requests$/, { GET: (r, env, user, m) => listJoinRequests(env, user, m[1]) }],
  [/^\/v1\/homes\/([0-9a-f]{32})\/join-requests\/([0-9a-f]{32})$/, { POST: (r, env, user, m) => decideJoinRequest(r, env, user, m[1], m[2]) }],
  ...BACKUP_ROUTES,
  // A new device joins by approval from another device of the account (ADR-053).
  ...DEVICE_REQUEST_ROUTES,
  // Alerts on admins' devices (ADR-047, alerts.js).
  [/^\/v1\/homes\/([0-9a-f]{32})\/alerts$/, Object.fromEntries(["GET", "POST", "DELETE"].map((method) => [method, (r, env, user, m) => handleHomeAlerts(r, env, user, m[1])]))],
];

function cors(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !appOrigins(env).includes(origin)) {
    return null;
  }
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
}

// Answers the routes above; null for any other path.
export async function handleHomes(request, env) {
  const path = new URL(request.url).pathname;
  let route = null;
  let match = null;
  for (const [pattern, methods] of ROUTES) {
    match = pattern.exec(path);
    if (match) {
      route = methods;
      break;
    }
  }
  if (!route) {
    return path.startsWith("/v1/homes") ? problem(404, "NOT_FOUND", `${path} is not a DirectorLink endpoint`) : null;
  }
  const headers = cors(request, env);
  const withCors = (response) => {
    for (const [name, value] of Object.entries(headers ?? {})) {
      response.headers.set(name, value);
    }
    return response;
  };
  if (request.method === "OPTIONS") {
    if (!headers) {
      return problem(403, "ORIGIN_NOT_ALLOWED", "Only the DirectorLink app may call this");
    }
    return new Response(null, {
      status: 204,
      headers: { ...headers, "Access-Control-Allow-Methods": Object.keys(route).join(", "), "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" },
    });
  }
  const handler = route[request.method];
  if (!handler) {
    return withCors(problem(405, "METHOD_NOT_ALLOWED", `Only ${Object.keys(route).join(", ")} is allowed here`, { Allow: Object.keys(route).join(", ") }));
  }
  if (request.method !== "GET" && !headers) {
    return problem(403, "ORIGIN_NOT_ALLOWED", "Only the DirectorLink app may call this");
  }
  const user = await currentUser(request, env);
  if (!user) {
    return withCors(problem(401, "NOT_SIGNED_IN", "Sign in first"));
  }
  return withCors(await handler(request, env, user, match));
}
