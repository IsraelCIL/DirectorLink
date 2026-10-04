// Sealed requests (docs/ACCOUNTS.md): API requests sealed with this device's lock key. Through the
// account they go to api.directorlink.io, which passes them to the home without being able to read
// them (away from home, and always on iPhone and iPad). On the home network they go to the
// controller itself (POST /v1/sealed), so the API key never crosses the network after pairing.
// The answer comes back sealed either way.

import { ApiError, apiRequest } from "../api-client.js";
import { ACCOUNTS_API } from "./account.js";
import { deriveLock, fromBase64, invitationLock, open, seal } from "./lock.js";

const REMOTE_KEY = "directorlink.remote"; // { home, keyId }: this device's home and key id
const TIMEOUT_MS = 20000;

// A failure of the account service or the relay (not signed in, home offline, …). It never means
// the device's key is invalid, so it has no `status`: code that forgets the key on a 401 (the
// home's answer) must not forget it because the account's session expired.
export class RemoteError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function savedRemote() {
  try {
    const value = JSON.parse(localStorage.getItem(REMOTE_KEY) || "null");
    return value && /^[0-9a-f]{32}$/.test(value.home) && /^[0-9a-f]{8}$/.test(value.keyId) ? value : null;
  } catch {
    return null;
  }
}

export function saveRemote(value) {
  try {
    localStorage.setItem(REMOTE_KEY, JSON.stringify({ home: value.home, keyId: value.keyId }));
  } catch {
    // Blocked storage: remote access lasts for this visit.
  }
}

export function forgetRemote() {
  try {
    localStorage.removeItem(REMOTE_KEY);
  } catch {
    // Nothing saved.
  }
}

let cached = { secret: null, lock: null };
async function deviceLock(apiKey) {
  if (cached.secret !== apiKey) {
    cached = { secret: apiKey, lock: await deriveLock(apiKey) };
  }
  return cached.lock;
}

function requestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// `timeoutMs`: longer for what the home takes long to answer (a backup), 20 s otherwise.
async function send(method, path, body, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), Math.max(timeoutMs || 0, TIMEOUT_MS));
  let response;
  try {
    response = await fetch(`${ACCOUNTS_API}${path}`, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new RemoteError(error?.name === "AbortError" ? "TIMEOUT" : "UNREACHABLE", "DirectorLink's servers could not be reached");
  } finally {
    window.clearTimeout(timer);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RemoteError(data?.code || `HTTP_${response.status}`, data?.detail || `api.directorlink.io answered ${response.status}`, response.status);
  }
  return data;
}

function post(path, body, timeoutMs) {
  return send("POST", path, body, timeoutMs);
}

// The home's answer, opened: { status, contentType, text, bytes }.
async function openAnswer(lock, envelope, id) {
  const plaintext = await open(lock, envelope, "res");
  const answer = plaintext ? JSON.parse(plaintext) : null;
  if (!answer || answer.id !== id) {
    throw new RemoteError("BAD_ANSWER", "The answer from the home could not be verified");
  }
  return {
    status: answer.status,
    contentType: answer.content_type || "",
    text: typeof answer.body === "string" ? answer.body : "",
    bytes: typeof answer.body_base64 === "string" ? fromBase64(answer.body_base64) : null,
  };
}

// One sealed exchange for `target` ({ home, keyId, offset: seconds the controller's clock is
// ahead }): `deliver(envelope)` sends it and returns the answer's envelope, which is opened here.
async function sealedExchange(apiKey, target, path, { method = "GET", body } = {}, deliver) {
  const lock = await deviceLock(apiKey);
  const id = requestId();
  const ts = Math.floor(Date.now() / 1000) + (target.offset || 0);
  const plaintext = JSON.stringify({ id, ts, method, path, body: body ?? null });
  const envelope = await seal(lock, { home: target.home, key: target.keyId }, "req", plaintext);
  return openAnswer(lock, await deliver(envelope), id);
}

// Sends one API request through the account; returns the home's answer.
export async function remoteRequest(apiKey, path, options = {}) {
  const remote = savedRemote();
  if (!remote || !apiKey) {
    throw new RemoteError("NOT_SET_UP", "Remote access is not set up on this device");
  }
  return sealedExchange(apiKey, { home: remote.home, keyId: remote.keyId }, path, options, async (envelope) => {
    const reply = await post(`/v1/homes/${remote.home}/e2e`, { envelope }, options.timeoutMs);
    return reply.envelope;
  });
}

// ---- sealed on the home network --------------------------------------------------------------

// The controller refused a sealed request on the home network (POST /v1/sealed): `code` (STALE,
// UNKNOWN_KEY, …) and its clock (`time`, seconds), to seal the next one right. Nothing ran.
export class SealRefused extends Error {
  constructor(code, status, time) {
    super(`The controller refused the sealed request (${code})`);
    this.name = "SealRefused";
    this.code = code;
    this.httpStatus = status;
    this.time = time;
  }
}

// `wanted`: as for apiRequest (api-client.js), asked before each send.
function lanDelivery(host, timeoutMs, wanted) {
  return async (envelope) => {
    const result = await apiRequest(host, "/v1/sealed", { method: "POST", body: { envelope }, timeoutMs, wanted });
    if (result.ok && result.data?.envelope) return result.data.envelope;
    throw new SealRefused(result.data?.code || `HTTP_${result.status}`, result.status, Number(result.data?.time));
  };
}

// A read that got no answer is sealed again (a new id) and sent once more, as apiRequest does for
// plain reads (api-client.js): one lost request must not make the controller look unreachable.
// Refusals and writes are never repeated.
const READ_RETRY_DELAY_MS = 400;

async function lanExchange(host, apiKey, target, path, options, timeoutMs) {
  const deliver = lanDelivery(host, timeoutMs, options.wanted);
  try {
    return await sealedExchange(apiKey, target, path, options, deliver);
  } catch (error) {
    if ((options.method || "GET") !== "GET" || error instanceof SealRefused || error instanceof RemoteError) throw error;
    await new Promise((resolve) => window.setTimeout(resolve, READ_RETRY_DELAY_MS));
    return sealedExchange(apiKey, target, path, options, deliver);
  }
}

// Like apiCall, sealed, on the home network.
export async function lanCall(host, apiKey, target, path, options = {}) {
  return answerData(await lanExchange(host, apiKey, target, path, options, options.timeoutMs || 8000));
}

// A camera picture, sealed, on the home network.
export async function lanImage(host, apiKey, target, path) {
  return answerBlob(await lanExchange(host, apiKey, target, path, {}, 12000));
}

// The home's refusal, from its sealed answer: `sealed` marks it as the home's own word (a 401 there
// means the key really was revoked).
function homeError(answer, problem) {
  const error = new ApiError(problem?.detail || problem?.title || `DirectorLink returned HTTP ${answer.status}`, {
    status: answer.status,
    code: problem?.code,
    problem,
  });
  error.sealed = true;
  return error;
}

// A sealed answer's data (JSON or text), or ApiError for the home's non-2xx answers.
function answerData(answer) {
  let data = null;
  if (answer.text) {
    try {
      data = JSON.parse(answer.text);
    } catch {
      data = answer.text;
    }
  }
  if (answer.status < 200 || answer.status > 299) {
    throw homeError(answer, data && typeof data === "object" ? data : null);
  }
  return data;
}

// Like apiCall (api-client.js): the data, or ApiError for the home's non-2xx answers.
export async function remoteCall(apiKey, path, options = {}) {
  return answerData(await remoteRequest(apiKey, path, options));
}

// A camera picture through the account, as a Blob.
export async function remoteImage(apiKey, path) {
  return answerBlob(await remoteRequest(apiKey, path));
}

// A sealed answer's picture, as a Blob.
function answerBlob(answer) {
  if (answer.status < 200 || answer.status > 299 || !answer.bytes) {
    let problem = null;
    try {
      problem = JSON.parse(answer.text);
    } catch {
      problem = null;
    }
    throw homeError(answer, problem);
  }
  return new Blob([answer.bytes], { type: answer.contentType || "image/jpeg" });
}

// The account's homes: { items: [{ home_id, owner, added_at, connected }] }.
export function listAccountHomes() {
  return send("GET", "/v1/homes");
}

// The home's automatic backups in the account (ADR-048): { items: [{ id, created_at, size,
// key_id }] }, for its admins (ADMINS_ONLY otherwise); one with its sealed text; and deleting them.
export function listHomeBackups(homeId) {
  return send("GET", `/v1/homes/${homeId}/backups`);
}

export function getHomeBackup(homeId, backupId) {
  return send("GET", `/v1/homes/${homeId}/backups/${backupId}`, undefined, 60000);
}

export function deleteHomeBackups(homeId) {
  return send("DELETE", `/v1/homes/${homeId}/backups`);
}

// The home's accounts, each with the key ids it uses (the owner only; OWNER_ONLY otherwise).
export function listMembers(homeId) {
  return send("GET", `/v1/homes/${homeId}/members`);
}

export function removeMember(homeId, userId) {
  return send("DELETE", `/v1/homes/${homeId}/members/${userId}`);
}

// Whether the home is claimed, and whether by the signed-in account: { claimed, owner, member }.
export function homeStatus(homeId) {
  return send("GET", `/v1/homes/${homeId}`);
}

// Claims the home for the signed-in account with a token from the controller (POST /v1/remote/claim);
// { transferred: true } when it belonged to another account until now.
export function claimHome(homeId, claimToken) {
  return post("/v1/homes/claim", { home_id: homeId, claim_token: claimToken });
}

// The owner approves the new secret the controller made (POST /v1/remote/secret, at home): from
// then on the relay accepts only it (docs/RELAY.md).
export function approveHomeSecret(homeId, secretSha256) {
  return post(`/v1/homes/${homeId}/secret`, { secret_sha256: secretSha256 });
}

export function registerInvitation(homeId, invitation, email) {
  return post(`/v1/homes/${homeId}/invitations`, { invitation_id: invitation.id, email, expires_at: invitation.expires_at });
}

// Accepts an invitation (link: #/join/<home>.<invitation>.<secret>); returns the new key, with
// `member`: whether the account now belongs to the home. When the invitation is for another email,
// the home's owner is asked to approve this account (ADR-041): then { waiting } (the request:
// status, code, expires_at), and the app asks again once the owner has approved it. The secret
// never leaves this device; each attempt seals a new request with it.
export async function acceptInvitation({ home, invitation, secret }, name) {
  const lock = await invitationLock(secret);
  const id = requestId();
  const plaintext = JSON.stringify({ id, ts: Math.floor(Date.now() / 1000), method: "POST", path: "/v1/auth/join", body: { name } });
  const envelope = await seal(lock, { home, key: invitation }, "req", plaintext);
  const reply = await post("/v1/join", { home_id: home, invitation_id: invitation, envelope, ask_owner: true });
  if (!reply?.envelope && typeof reply?.status === "string") {
    return { waiting: reply };
  }
  const answer = await openAnswer(lock, reply.envelope, id);
  if (answer.status !== 201) {
    let problem = null;
    try {
      problem = JSON.parse(answer.text);
    } catch {
      problem = null;
    }
    throw new RemoteError(problem?.code || "JOIN_REFUSED", problem?.detail || `The home refused the invitation (${answer.status})`);
  }
  return { ...JSON.parse(answer.text), member: reply.member !== false };
}

// This account's request to join with an invitation for another email, while the owner decides:
// { outcome, request }. `outcome`: "wait" (pending), "finish" (approved: accept it again),
// "refused", "expired" (the invitation ran out first), "gone" (used, revoked or expired) or "none"
// (no request, e.g. withdrawn). A network failure throws: the app asks again later.
export async function checkJoinRequest({ home, invitation }) {
  let request;
  try {
    request = await send("GET", `/v1/join/${home}/${invitation}`);
  } catch (error) {
    if (error instanceof RemoteError && error.code === "INVITATION_NOT_FOUND") return { outcome: "gone", request: null };
    if (error instanceof RemoteError && error.code === "NOT_FOUND") return { outcome: "none", request: null };
    throw error;
  }
  const outcome = { pending: "wait", approved: "finish", refused: "refused", expired: "expired" }[request?.status] || "wait";
  return { outcome, request };
}

// A request's code as it is shown, "123 456" (left to right in both languages).
export function joinCodeText(code) {
  return /^[0-9]{6}$/.test(code || "") ? `${code.slice(0, 3)} ${code.slice(3)}` : "";
}

export function withdrawJoinRequest({ home, invitation }) {
  return send("DELETE", `/v1/join/${home}/${invitation}`);
}

// The owner's view: accounts asking to join the home with an invitation for another email.
export function listJoinRequests(homeId) {
  return send("GET", `/v1/homes/${homeId}/join-requests`);
}

// `decision`: "approve" or "refuse".
export function decideJoinRequest(homeId, requestId, decision) {
  return post(`/v1/homes/${homeId}/join-requests/${requestId}`, { decision });
}

// Joining from another device (ADR-053, views/device-join.js): requests of this account to join
// one of its homes, which another device of the account approves. Each answers the request as
// both devices see it: { id, home_id, label, status, commitment, approver_key, device_key,
// created_at, expires_at }; the sealed invitation only once, to `collect`.
const deviceRequests = (homeId) => `/v1/homes/${homeId}/device-requests`;

export const startDeviceRequest = (homeId, label, commitment) => post(deviceRequests(homeId), { label, commitment });
export const listDeviceRequests = (homeId) => send("GET", deviceRequests(homeId));
export const getDeviceRequest = (homeId, id) => send("GET", `${deviceRequests(homeId)}/${id}`);
export const answerDeviceRequest = (homeId, id, approverKey) => post(`${deviceRequests(homeId)}/${id}/answer`, { approver_key: approverKey });
export const showDeviceKey = (homeId, id, deviceKey) => post(`${deviceRequests(homeId)}/${id}/key`, { device_key: deviceKey });
export const approveDeviceRequest = (homeId, id, sealed) => post(`${deviceRequests(homeId)}/${id}/approve`, { sealed });
export const collectDeviceRequest = (homeId, id) => post(`${deviceRequests(homeId)}/${id}/collect`);
export const deleteDeviceRequest = (homeId, id) => send("DELETE", `${deviceRequests(homeId)}/${id}`);

// The invitation link a person or device opens. Everything after "#" stays in the browser.
export function invitationLink(homeId, invitation) {
  return `${window.location.origin}/#/join/${homeId}.${invitation.id}.${invitation.secret}`;
}

export function parseInvitation(text) {
  const match = /^([0-9a-f]{32})\.([0-9a-f]{8})\.([0-9a-f]{64})$/.exec(text || "");
  return match ? { home: match[1], invitation: match[2], secret: match[3] } : null;
}
