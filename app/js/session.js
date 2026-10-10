// Connection to the controller: first-time access, reconnecting with the saved key, loading
// and refreshing device state. On the home network requests are sealed with this device's lock key
// (POST /v1/sealed, remote.js), so the API key never crosses the network; with a driver from before
// 1.0.0 they carry the key (api-client.js). Through the account they are sealed too (remote.js),
// when the home network cannot be reached and on iPhone and iPad.

import { loadAccount } from "./account.js";
import {
  ApiError,
  apiCall,
  apiImage,
  apiRequest,
  clearApiKey,
  normalizeHost,
  normalizePairingCode,
  saveApiKey,
  saveHost,
  savedApiKey,
  savedHost,
} from "../api-client.js";
import { notificationsOn, notifyRings, trackRings } from "./doorbells.js";
import { IS_IOS } from "./platform.js";
import { RemoteError, SealRefused, forgetRemote, lanCall, lanImage, remoteCall, remoteImage, savedRemote } from "./remote.js";
import { keyExchange, open, pairingLock } from "./lock.js";
import { pairWithCpace, unprotectedReason } from "./cpace.js";
import { t } from "./i18n.js";
import { KINDS, notify, state } from "./state.js";
import { inOwnScale } from "./temperature.js";

const POLL_MS = 10000;
// A refresh that fails is retried soon; only this many failures in a row mean "unreachable".
// One slow answer (a phone waking up, Wi-Fi busy with camera pictures) is not a disconnect.
const RETRY_MS = 2000;
const FAILURES_BEFORE_UNREACHABLE = 2;
let pollTimer = null;
// Run after connecting and with each rooms refresh (app.js: the profile).
const connectedHooks = [];

export function whenConnected(hook) {
  connectedHooks.push(hook);
}

function runConnectedHooks() {
  for (const hook of connectedHooks) {
    Promise.resolve()
      .then(hook)
      .catch((error) => console.warn("DirectorLink: after connecting", error));
  }
}
// Run when this browser's key is forgotten (controls.js: the shades it follows).
const forgottenHooks = [];

export function whenForgotten(hook) {
  forgottenHooks.push(hook);
}
// Settings → Forget key and Pair again revoke the key before this browser forgets it
// (revokeAndForget). The refreshes stop at once, and what was on its way (a refresh, a connect, a
// light's confirmation) stops at its next step without changing anything (`forgets`); a request
// asked for before is not sent if it has not been yet, nor sent once more (api). A request sent
// before that reaches the controller after the DELETE is answered 401: that was asked for, not a key
// that stopped working (handleUnauthorized).
let forgetting = false;
// Changes when forgetting the key starts and when it is forgotten (forgetKey).
let forgets = 0;

// The key to read with: "" once it is forgotten, and while it is being forgotten.
export function keyInUse() {
  return forgetting ? "" : state.apiKey;
}

// Work started with the key in use records this, and after each wait goes on only while it is the
// same: once the key is forgotten, or being forgotten, it stops there (controls.js).
export function keyGeneration() {
  return forgets;
}
let failedRefreshes = 0;
let connectRun = 0;

// This device can reach its home: over the home network, or through the account.
export function reachable() {
  return Boolean(state.apiKey && ((state.host && !IS_IOS) || savedRemote()));
}

// ---- sealing on the home network ------------------------------------------------------------

// What this device knows about sealing with its controller: { host, keyId, seals }. `keyId` names
// its key in sealed requests; `seals` says a sealed request there has worked (or the pairing was
// sealed). From then on the key is never sent to that controller in the clear: answers that
// would make it fall back (a 404 on GET /v1/sealed, UNKNOWN_KEY, …) are not signed, so anyone on
// the network could send them. Only a device that never sealed there falls back (drivers before
// 1.0.0).
const SEAL_KEY = "directorlink.seal";
const OLD_KEY_ID_KEY = "directorlink.keyId"; // development builds before 1.0.0
// What envelopes on the home network name as their home (driver: Remote.LAN_HOME).
const LAN_HOME = "lan";

function savedSeal() {
  try {
    const value = JSON.parse(localStorage.getItem(SEAL_KEY) || "null");
    return value && typeof value.host === "string" && /^[0-9a-f]{8}$/.test(value.keyId || "") ? value : null;
  } catch {
    return null;
  }
}

function rememberSeal(host, keyId, seals) {
  try {
    if (host && /^[0-9a-f]{8}$/.test(keyId || "")) localStorage.setItem(SEAL_KEY, JSON.stringify({ host, keyId, seals: Boolean(seals) }));
  } catch {
    // Blocked storage: the key id is asked for again at the next start.
  }
}

function forgetSeal() {
  try {
    localStorage.removeItem(SEAL_KEY);
    localStorage.removeItem(OLD_KEY_ID_KEY);
  } catch {
    // Nothing saved.
  }
}

// The record for the controller in use.
function sealHere() {
  const seal = savedSeal();
  return seal && seal.host === state.host ? seal : null;
}

function sealsHere() {
  return sealHere()?.seals === true;
}

// { home, keyId, offset } once known; null with a controller that cannot seal (before 1.0.0, or
// its lock failed), for a device that never sealed there; undefined until looked at (after
// connecting, or when the home network is back). Requests that start together wait for the same
// look; `sealGeneration` changes with the key, so a look for the previous key never counts.
let lanSeal;
let lanSealLook = null;
let sealGeneration = 0;
// False once the controller did not know the key id linking saved (savedRemote): ask it instead.
let trustLinkedKeyId = true;

function resetSeal() {
  sealGeneration += 1;
  lanSeal = undefined;
  lanSealLook = null;
}

// A new key on this device (pairing, an invitation): what was known about the previous one goes.
export function forgetSealing() {
  forgetSeal();
  resetSeal();
  trustLinkedKeyId = true;
}

// A problem of the home-network connection that says nothing about the key: without a status, so
// it never wipes the key (401 handling) and a linked device goes through the account instead.
function notReachable(code) {
  return new ApiError(t(code === "MISDIRECTED_REQUEST" ? "errors.misdirected" : "errors.unreachable"), { code });
}

// Seconds the controller's clock is ahead of this device's, rounded down so that a request is
// never dated after the controller's clock (the driver would keep its id in storage).
function clockOffset(time) {
  return Math.floor(Number(time) - Date.now() / 1000) || 0;
}

// What sealing needs from this controller: its clock (GET /v1/sealed, without a key), and this
// device's key id (saved at pairing or linking; for a device paired before 1.0.0, asked for once).
async function setupLanSeal() {
  const generation = sealGeneration;
  const host = state.host;
  const known = sealHere();
  const seals = known?.seals === true;
  const result = await apiRequest(host, "/v1/sealed", { timeoutMs: 8000 });
  if (generation !== sealGeneration) return;
  if (!result.ok) {
    const code = result.data?.code;
    if (!seals && (result.status === 404 || result.status === 405 || code === "LOCK_UNAVAILABLE")) {
      // A driver before 1.0.0, or one that cannot seal: requests carry the key, as before.
      lanSeal = null;
      return;
    }
    throw notReachable(code === "MISDIRECTED_REQUEST" ? code : "SEALING_UNAVAILABLE");
  }
  let keyId = known?.keyId || (trustLinkedKeyId ? savedRemote()?.keyId : null) || null;
  if (!keyId && !seals) {
    const key = await apiCall(host, "/v1/api-keys/current", { apiKey: state.apiKey });
    if (generation !== sealGeneration) return;
    keyId = key?.id;
    rememberSeal(host, keyId, false);
  }
  if (!keyId) {
    lanSeal = null;
    return;
  }
  lanSeal = { home: LAN_HOME, keyId, offset: clockOffset(result.data?.time) };
}

// A refused sealed request (nothing ran), for a device that seals with this controller.
function refusal(error) {
  if (error.code === "UNKNOWN_KEY") {
    // The controller does not know this key: it was revoked, or DirectorLink was added again. A
    // linked device asks its home through the account before forgetting it (handleUnauthorized).
    return new ApiError(t("errors.keyRevoked"), { status: 401, code: "UNKNOWN_KEY" });
  }
  return notReachable(error.code);
}

// One request on the home network: sealed when the controller can open it, else with the key
// (only for a device that never sealed with this controller).
async function homeRequest(send, plain) {
  const generation = sealGeneration;
  if (lanSeal === undefined) {
    lanSealLook ??= setupLanSeal().finally(() => {
      if (generation === sealGeneration) lanSealLook = null;
    });
    await lanSealLook;
    // The key changed meanwhile (pairing, forgetting it): look again for the one in use now.
    if (generation !== sealGeneration) return homeRequest(send, plain);
  }
  const seal = lanSeal;
  if (!seal) {
    if (sealsHere()) throw notReachable("SEALING_UNAVAILABLE");
    return plain();
  }
  let answer;
  try {
    answer = await send(seal);
  } catch (error) {
    if (error instanceof RemoteError) {
      // The answer could not be verified: not the home's word, and perhaps not the home at all.
      throw notReachable(error.code);
    }
    if (!(error instanceof SealRefused)) throw error;
    if (error.code === "STALE" && Number.isFinite(error.time)) {
      // This device's clock is off: seal with the controller's, once.
      const again = { ...seal, offset: clockOffset(error.time) };
      if (lanSeal === seal) lanSeal = again;
      try {
        answer = await send(again);
      } catch (retry) {
        if (retry instanceof SealRefused) throw refusal(retry);
        if (retry instanceof RemoteError) throw notReachable(retry.code);
        throw retry;
      }
    } else if (sealsHere()) {
      throw refusal(error);
    } else {
      // Never sealed with this controller: a key it has no lock key for yet (it gets one when the
      // key is used once), or a key id it does not know. This request goes with the key.
      if (generation === sealGeneration) {
        if (error.code === "UNKNOWN_KEY") {
          forgetSeal();
          trustLinkedKeyId = false;
          lanSeal = undefined;
        } else {
          lanSeal = null;
        }
      }
      return plain();
    }
  }
  // It seals: from now on this device never sends its key to this controller in the clear.
  if (generation === sealGeneration && !sealsHere()) rememberSeal(state.host, seal.keyId, true);
  return answer;
}

function useTransport(transport) {
  if (state.transport !== transport) {
    state.transport = transport;
    notify();
  }
}

// A request that got no answer on the home network goes through the account from then on, when
// this device has it; HTTP answers from the home are final.
function viaRemote(error) {
  return !error?.status && !(error instanceof RemoteError) && savedRemote() && state.apiKey;
}

export async function api(path, options = {}) {
  if (state.transport === "remote") {
    return remoteCall(state.apiKey, path, options);
  }
  // Once the key is forgotten, or being forgotten, nothing of this request is sent any more: not
  // after the look at sealing, not once more (api-client.js), not through the account.
  const since = forgets;
  const request = { ...options, wanted: () => since === forgets };
  try {
    return await homeRequest(
      (seal) => lanCall(state.host, state.apiKey, seal, path, request),
      () => apiCall(state.host, path, { apiKey: state.apiKey, ...request })
    );
  } catch (error) {
    if (!viaRemote(error) || since !== forgets) throw error;
    useTransport("remote");
    // Only reads are sent again: a command may have reached the home before its answer was lost,
    // and must not run twice. Pressing again sends it through the account.
    if ((options.method || "GET") !== "GET") throw error;
    return remoteCall(state.apiKey, path, options);
  }
}

// A camera picture, over whichever connection is in use.
export async function image(path) {
  if (state.transport === "remote") {
    return remoteImage(state.apiKey, path);
  }
  try {
    return await homeRequest(
      (seal) => lanImage(state.host, state.apiKey, seal, path),
      () => apiImage(state.host, path, { apiKey: state.apiKey })
    );
  } catch (error) {
    if (!viaRemote(error)) throw error;
    useTransport("remote");
    return remoteImage(state.apiKey, path);
  }
}

const CHECK_IN_KEY = "directorlink.checkIn"; // { home, at }: this device's last sealed request
const CHECK_IN_MS = 24 * 3600 * 1000;

// A device linked to its home through the account sends one sealed request a day, even when it
// only uses the home network: the account service learns which key this account uses, so that
// revoking it at home also ends the membership (docs/ACCOUNTS.md). `force`: right away (linking).
// Returns true once the home answered, false when it could not be reached, null when not sent.
export async function checkInThroughAccount(force = false) {
  const remote = savedRemote();
  if (!remote || !state.apiKey || state.account.status !== "signed-in") return null;
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem(CHECK_IN_KEY) || "null");
  } catch {
    last = null;
  }
  if (!force && last?.home === remote.home && Date.now() - Number(last.at) < CHECK_IN_MS) return null;
  try {
    await remoteCall(state.apiKey, "/v1/api-keys/current");
    localStorage.setItem(CHECK_IN_KEY, JSON.stringify({ home: remote.home, at: Date.now() }));
    return true;
  } catch {
    // Tried again at the next check.
    return false;
  }
}

// Away from home, look once a minute whether the home network is back; it is faster. Only this
// home's controller counts, and only a request sealed with this device's key proves it: another
// network may have a device at the same address, and nothing unsealed is trusted. The key is never
// sent to find out, and whatever answers, it is kept. (With a driver before 1.0.0 the app stays with
// the account until it starts again.)
async function tryHomeNetwork() {
  const remote = savedRemote();
  if (state.transport !== "remote" || IS_IOS || !state.host || !remote || !state.apiKey) return;
  const generation = sealGeneration;
  const since = forgets;
  const wanted = () => since === forgets;
  try {
    const result = await apiRequest(state.host, "/v1/sealed", { timeoutMs: 2500, wanted });
    if (!result.ok || since !== forgets) return;
    const seal = { home: LAN_HOME, keyId: sealHere()?.keyId || remote.keyId, offset: clockOffset(result.data?.time) };
    // A read without an answer is sent once more (remote.js), but not once the key is forgotten.
    await lanCall(state.host, state.apiKey, seal, "/v1/api-keys/current", { timeoutMs: 2500, wanted });
    if (generation !== sealGeneration || state.transport !== "remote") return;
    rememberSeal(state.host, seal.keyId, true);
    lanSeal = seal;
    useTransport("lan");
  } catch {
    // Still away.
  }
}

// The new key's name, e.g. "Chrome on Windows" or "Safari on iPhone" (the API console lists it).
export function clientName() {
  const agent = navigator.userAgent || "";
  const brands = (navigator.userAgentData?.brands || []).map((item) => item.brand);
  const browser =
    brands.find((brand) => /Edge|Opera|Samsung/i.test(brand))?.replace(/^Microsoft /, "") ||
    (/Edg\//.test(agent) ? "Edge" : null) ||
    (/OPR\//.test(agent) ? "Opera" : null) ||
    (/SamsungBrowser\//.test(agent) ? "Samsung Internet" : null) ||
    (/Firefox\/|FxiOS\//.test(agent) ? "Firefox" : null) ||
    (/Chrome\/|CriOS\//.test(agent) ? "Chrome" : null) ||
    (/Safari\//.test(agent) ? "Safari" : null) ||
    "Browser";
  const platform = navigator.userAgentData?.platform || "";
  const system =
    (/iPhone/.test(agent) && "iPhone") ||
    ((/iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) && "iPad") ||
    ((/Android/.test(agent) || platform === "Android") && "Android") ||
    ((/Windows/.test(agent) || platform === "Windows") && "Windows") ||
    ((/CrOS/.test(agent) || platform === "Chrome OS") && "ChromeOS") ||
    ((/Mac OS X|Macintosh/.test(agent) || platform === "macOS") && "Mac") ||
    ((/Linux/.test(agent) || platform === "Linux") && "Linux") ||
    "";
  // The app added to the Home Screen (or installed) is not its browser (1.12.0, ADR-083): on an
  // iPad, Safari and the Home Screen app are two devices, and their names tell them apart.
  let installed = false;
  try {
    installed = navigator.standalone === true || window.matchMedia?.("(display-mode: standalone)")?.matches === true;
  } catch {
    installed = false;
  }
  if (installed) return (system ? `DirectorLink app on ${system}` : "DirectorLink app").slice(0, 64);
  return (system ? `${browser} on ${system}` : `${browser} (DirectorLink app)`).slice(0, 64);
}

export function restoreSaved() {
  state.host = savedHost();
  state.apiKey = savedApiKey();
  state.transport = (IS_IOS || !state.host) && savedRemote() ? "remote" : "lan";
  state.status = reachable() ? "connecting" : "setup";
}

// Validates and stores the controller address. A different controller needs a new key; a device
// that joined with an invitation (no address yet) keeps its key for its home's address.
export function useHost(value) {
  const host = normalizeHost(value);
  if (!host) {
    throw new ApiError(t("connect.invalidHost"), { code: "INVALID_HOST" });
  }
  if (state.host && host !== state.host && state.apiKey) {
    forgetKey();
  }
  if (host !== state.host) {
    state.remoteInfo = null;
  }
  saveHost(host);
  state.host = host;
  return host;
}

export function forgetKey() {
  forgets += 1;
  connectRun += 1;
  clearApiKey();
  forgetSealing();
  forgetRemote();
  state.transport = "lan";
  state.remoteInfo = null;
  stopPolling();
  state.apiKey = "";
  state.role = null;
  state.status = "setup";
  state.loaded = false;
  for (const hook of forgottenHooks) hook();
}

// Pairing failures (POST /v1/auth/pair) as RFC 9457 problem codes.
function pairingError(error, pairing) {
  switch (error?.code) {
    case "INVALID_FIELD":
    case "INVALID_REQUEST":
      return pairing ? t("connect.errors.invalidCode") : null;
    case "PAIRING_CODE_INVALID": {
      const left = Number(error.problem?.attempts_remaining);
      return Number.isFinite(left) && left > 0 ? t("connect.errors.wrongCode", { count: left }) : t("connect.errors.wrongCodeNoCount");
    }
    case "PAIRING_NOT_ACTIVE":
      return t("connect.errors.notActive");
    case "PAIRING_CODE_EXPIRED":
      return t("connect.errors.expired");
    case "PAIRING_RATE_LIMITED": {
      // Exact only when the driver says how long (problem body, or an exposed Retry-After).
      const seconds = Number(error.problem?.retry_after) || error.retryAfter;
      return seconds ? t("connect.errors.rateLimited", { seconds, count: seconds }) : t("connect.errors.rateLimitedMinute");
    }
    case "KEY_LIMIT_REACHED":
      return t("connect.errors.keyLimit");
    case "PAIRING_UNAVAILABLE":
      return t("connect.errors.unavailable");
    // Pairing with CPace (cpace.js): the exchange was left open too long, or the answers did not
    // come from a controller that knows the code.
    case "PAIRING_SESSION_EXPIRED":
      return t("connect.errors.sessionExpired");
    case "PAIRING_NOT_CONFIRMED":
      return t("connect.errors.notConfirmed");
    default:
      return null;
  }
}

// Problems of the account connection (remote.js), which never mean the key is invalid.
function remoteErrorText(error) {
  switch (error.code) {
    case "UNREACHABLE":
    case "TIMEOUT":
      return t("errors.remote.unreachable");
    case "NOT_SIGNED_IN":
      return t("errors.remote.signIn");
    case "HOME_OFFLINE":
    case "HOME_TIMEOUT":
    case "HOME_DISCONNECTED":
      return t("errors.remote.homeOffline");
    // The controller's DirectorLink is older than the account service takes (1.8.0, ADR-059).
    case "HOME_UPDATE_REQUIRED":
      return t("errors.remote.updateRequired");
    case "NOT_A_MEMBER":
      return t("errors.remote.notMember");
    case "UNKNOWN_KEY":
      return t("errors.remote.unknownKey");
    case "LOCK_UNAVAILABLE":
      return t("errors.remote.lock");
    case "STALE":
      return t("errors.remote.clock");
    case "INVALID_CLAIM":
      return t("errors.remote.invalidClaim");
    case "KEY_LIMIT_REACHED":
      return t("connect.errors.keyLimit");
    case "INVITATION_LIMIT_REACHED":
      return t("errors.invitationLimit");
    case "OWNER_ONLY":
      return t("errors.remote.ownerOnly");
    // A join into a user who has five devices (1.9.0, ADR-061).
    case "USER_DEVICE_LIMIT":
      return t("users.limit.joinRefused");
    default:
      // The cloud's own text is not shown: it is in English only, and not the app's to trust.
      return t("errors.remote.failed", { code: String(error.code || "UNKNOWN").slice(0, 40) });
  }
}

// `pairing`: the error of POST /v1/auth/pair, where a refused field is the code.
function describeError(error, pairing = false) {
  if (error instanceof RemoteError) {
    return remoteErrorText(error);
  }
  if (error?.status === 401) {
    return t("errors.keyRevoked");
  }
  const pairingText = pairingError(error, pairing);
  if (pairingText) {
    return pairingText;
  }
  // 403 FORBIDDEN: this key's role is too low; DOOR_CONTROL_DISABLED: the Composer switch is off.
  if (error?.code === "DOOR_CONTROL_DISABLED") {
    return t("errors.doorsDisabled");
  }
  // 409 HOLD_NOT_ALLOWED: a Relay Door or Gate Controller set to hold its relay (1.10.0, ADR-069).
  if (error?.code === "HOLD_NOT_ALLOWED") {
    return t("errors.holdNotAllowed");
  }
  // 409 JEWISH_CALENDAR_OFF: the installer turned the Jewish calendar off in Composer (calendar.js).
  if (error?.code === "JEWISH_CALENDAR_OFF") {
    return t("errors.calendarOff");
  }
  if (error?.code === "FORBIDDEN") {
    return t("errors.forbidden", { role: roleLabel(error.problem?.role || state.role) });
  }
  if (error?.code === "INVALID_HOST") {
    return error.message;
  }
  if (error?.code === "MISDIRECTED_REQUEST") {
    return t("errors.misdirected");
  }
  if (error?.code === "SEALING_UNAVAILABLE") {
    return t("errors.sealing");
  }
  if (error?.code === "INVITATION_LIMIT_REACHED") {
    return t("errors.invitationLimit");
  }
  // A member's other device joins only with an account this device already uses at the home
  // (1.9.0, ADR-061), which DirectorLink's servers check.
  if (error?.code === "ACCOUNT_NOT_OF_DEVICE") {
    return t("users.account.notThisDevice");
  }
  if (error?.code === "FOR_KEY_UNSUPPORTED") {
    return t("users.account.serversOld");
  }
  // A user has at most five devices (1.9.0, ADR-061); views/device-limit.js lists them where it can.
  if (error?.code === "USER_DEVICE_LIMIT") {
    const name = error.problem?.user?.name;
    return name ? t("users.limit.text", { name, count: Number(error.problem?.limit) || 5 }) : t("users.limit.joinRefused");
  }
  if (error?.name === "AbortError") {
    return t("errors.timeout");
  }
  if (error instanceof ApiError && error.status) {
    return error.message;
  }
  return t("errors.unreachable");
}

export function errorText(error) {
  return describeError(error);
}

// A connection problem to show. Problems of the account connection say why (signed out, home
// offline, …); an ended session is looked up again, so the app offers to sign in.
function connectionNotice(error) {
  const remote = error instanceof RemoteError;
  if (remote && error.code === "NOT_SIGNED_IN" && state.account.status === "signed-in") {
    loadAccount();
  }
  return { kind: "error", text: describeError(error), remote };
}

function forgetRevokedKey() {
  forgetKey();
  state.notice = { kind: "error", text: t("errors.keyRevoked") };
  notify();
}

// Any request answered 401: the key was revoked or DirectorLink was re-added. Start over. A 401 on
// the home network, for a device linked to its home through the account, is checked with the home
// first: another controller at the same address (another network) must not wipe this home's key.
// A request that was on its way while the key was forgotten (or is being forgotten) changes nothing.
let checkingKey = null;
export function handleUnauthorized(error) {
  const key = keyInUse();
  if (!key) return Promise.resolve();
  if (error?.sealed || !savedRemote()) {
    forgetRevokedKey();
    return Promise.resolve();
  }
  if (!checkingKey) {
    checkingKey = (async () => {
      try {
        await remoteCall(key, "/v1/api-keys/current");
        if (keyInUse() !== key) return;
        // The key works at home: the controller that refused it is another one.
        useTransport("remote");
        connect();
      } catch (failure) {
        if ((failure?.status === 401 || failure?.code === "UNKNOWN_KEY") && keyInUse() === key) {
          forgetRevokedKey();
        }
        // Otherwise the home cannot be asked now: the key is kept.
      } finally {
        checkingKey = null;
      }
    })();
  }
  return checkingKey;
}

// Resources newer drivers add (doors and gates, doorbells): an older driver answers 404, so
// show none.
// Other failures give `fallback` (for doorbells: the last list, so a hiccup keeps the banner).
async function optionalList(path, fallback = []) {
  try {
    return (await api(path))?.items || [];
  } catch (error) {
    if (error?.status === 401) throw error;
    return error?.status === 404 || error?.status === 405 ? [] : fallback;
  }
}

export function roleLabel(role) {
  const key = `roles.${role || "admin"}`;
  const label = t(key);
  return label === key ? String(role) : label;
}

// Drivers before API key roles have no /v1/api-keys/current: their keys can do everything.
// With 1.8.0 it also says what this person may do (`access`, ADR-054), kept in state.access.
async function loadRole() {
  try {
    const key = await api("/v1/api-keys/current");
    state.access = key?.access && typeof key.access === "object" ? key.access : null;
    return typeof key?.role === "string" ? key.role : "admin";
  } catch (error) {
    if (error?.status === 404 || error?.status === 405) {
      state.access = null;
      return "admin";
    }
    throw error;
  }
}

// A 403 FORBIDDEN names the key's current role (it may have been changed in Composer).
export function noteForbidden(error) {
  const role = error?.code === "FORBIDDEN" ? error.problem?.role : null;
  if (typeof role === "string" && role !== state.role) {
    state.role = role;
    notify();
  }
}

async function loadAll() {
  const [system, rooms, lights, thermostats, blinds, cameras, devices, relays, doorbells, role, fans, refrigerators] = await Promise.all([
    api("/v1/system"),
    api("/v1/rooms"),
    api("/v1/lights"),
    api("/v1/thermostats"),
    api("/v1/blinds"),
    api("/v1/cameras"),
    api("/v1/devices").catch(() => ({ items: [] })),
    optionalList("/v1/relays"),
    optionalList("/v1/doorbells"),
    loadRole(),
    optionalList("/v1/fans"),
    optionalList("/v1/refrigerators"),
  ]);
  state.system = system;
  state.rooms = rooms?.items || [];
  state.lights = lights?.items || [];
  // Each in its own scale, °F or °C (1.10.2, temperature.js).
  state.thermostats = (thermostats?.items || []).map(inOwnScale);
  state.fans = fans;
  state.refrigerators = refrigerators;
  state.blinds = blinds?.items || [];
  state.cameras = cameras?.items || [];
  state.devices = devices?.items || [];
  state.relays = relays;
  useDoorbells(doorbells);
  state.role = role;
  state.lastUpdated = new Date();
  state.loaded = true;
}

// Every doorbell list goes through here: new rings are noticed (banner, notification).
function useDoorbells(doorbells) {
  state.doorbells = doorbells;
  notifyRings(trackRings(doorbells));
}

// Doorbells only: what a page in the background still polls when doorbell notifications are on.
export async function refreshDoorbells() {
  if (!reachable()) return false;
  const since = forgets;
  try {
    const doorbells = await optionalList("/v1/doorbells", state.doorbells);
    if (since !== forgets) return false;
    useDoorbells(doorbells);
    notify();
    return true;
  } catch (error) {
    if (error?.status === 401 && since === forgets) handleUnauthorized(error);
    return false;
  }
}

// Every device of the project, for the devices a room has that the app cannot control: they change
// with the project in Composer (which the driver picks up by itself), so with the rooms, once a minute.
async function refreshDeviceList() {
  const since = forgets;
  try {
    const devices = await api("/v1/devices");
    if (since !== forgets) return;
    if (Array.isArray(devices?.items)) state.devices = devices.items;
    notify();
  } catch {
    // The next device refresh reports connection problems.
  }
}

// Connects with the saved key. Used on start (automatic reconnect) and by Retry. A connect that
// another one replaced, or whose key was forgotten meanwhile, ends without changing anything.
export async function connect() {
  if (forgetting) return false;
  if (!reachable()) {
    state.status = "setup";
    notify();
    return false;
  }
  const run = ++connectRun;
  const since = forgets;
  state.status = "connecting";
  // Sealing is looked at again: the driver may have been updated.
  resetSeal();
  notify();
  try {
    await loadAll();
    if (run !== connectRun || since !== forgets) return false;
    state.status = "connected";
    state.notice = null;
    startPolling();
    runConnectedHooks();
    return true;
  } catch (error) {
    if (run !== connectRun || since !== forgets) return false;
    if (error?.status === 401) {
      handleUnauthorized(error);
      return false;
    }
    console.error("DirectorLink connection failed", error);
    state.notice = connectionNotice(error);
    // The next attempt tries the home network first again.
    if (state.transport === "remote" && !IS_IOS && state.host) {
      state.transport = "lan";
    }
    state.status = "unreachable";
    scheduleRetry();
    return false;
  } finally {
    notify();
  }
}

// The old way, only after the warning (pairWithCode): the code is sent, with a key exchange
// (X25519) so that at least the new key is not readable on the network. Browsers without X25519,
// drivers before 1.0.0 (which refuse the field) and controllers that cannot seal (they refuse it
// too) pair without it. Returns { created, sealed }.
async function pairSealed(host, code) {
  const exchange = await keyExchange();
  const request = (body) => apiCall(host, "/v1/auth/pair", { method: "POST", body });
  const plain = { pairing_code: code, name: clientName() };
  if (!exchange) return { created: await request(plain), sealed: false };
  let answer;
  try {
    answer = await request({ ...plain, exchange: { public_key: exchange.publicKey } });
  } catch (error) {
    const field = error?.problem?.errors?.[0]?.field;
    if (error?.code === "INVALID_FIELD" && field === "exchange") return { created: await request(plain), sealed: false };
    throw error;
  }
  if (!answer?.sealed) return { created: answer, sealed: false };
  const lock = await pairingLock(await exchange.shared(answer.exchange.public_key), code, exchange.publicKey, answer.exchange.public_key);
  const plaintext = await open(lock, answer.sealed, "res");
  if (!plaintext) throw new ApiError(t("errors.noKey"), { code: "PAIRING_NO_KEY" });
  return { created: JSON.parse(plaintext), sealed: true };
}

// The only way to get a first key: the pairing code created in Composer (DirectorLink →
// Actions → New Pairing Code). It lasts 15 minutes, works once and gives an admin key.
// The code is never sent (CPace, cpace.js, ADR-039). A controller that cannot pair that way
// (DirectorLink before 1.3.0, or its lock failed its self-test) learns nothing about the code: the
// connect screen warns that it would travel unprotected, and only `anyway` (its "Pair anyway")
// sends it the old way.
export async function pairWithCode(hostValue, pairingCode, { anyway = false } = {}) {
  const code = normalizePairingCode(pairingCode);
  state.pairingUnprotected = null;
  if (!code) {
    state.notice = { kind: "error", text: t("connect.errors.invalidCode") };
    notify();
    return false;
  }
  try {
    const host = useHost(hostValue);
    state.status = "connecting";
    state.notice = null;
    notify();
    let paired;
    try {
      paired = anyway
        ? await pairSealed(host, code)
        : { created: await pairWithCpace((body) => apiCall(host, "/v1/auth/pair", { method: "POST", body }), { code, name: clientName() }), sealed: true };
    } catch (error) {
      if (error?.code !== "CPACE_UNSUPPORTED") throw error;
      state.status = "setup";
      state.pairingUnprotected = { host, reason: unprotectedReason(error) };
      notify();
      return false;
    }
    const { created, sealed } = paired;
    if (!created?.key) {
      throw new ApiError(t("errors.noKey"), { code: "PAIRING_NO_KEY" });
    }
    saveApiKey(created.key);
    state.apiKey = created.key;
    // A sealed pairing means this controller seals: the key never goes to it in the clear.
    forgetSealing();
    rememberSeal(host, created.id, sealed);
    // Remote access belonged to the previous key: link the home again for this one.
    forgetRemote();
    state.transport = "lan";
    state.remoteInfo = null;
    return connect();
  } catch (error) {
    state.status = "setup";
    state.notice = { kind: "error", text: describeError(error, true) };
    notify();
    return false;
  }
}

// Device state, every 10 s while the page is visible. Devices with a command in flight keep
// their optimistic state until the command is confirmed. Once the key is forgotten, or being
// forgotten, a refresh on its way changes nothing.
export async function refreshDevices() {
  if (!keyInUse() || !reachable()) return false;
  const since = forgets;
  try {
    // Fans (1.2.0) and refrigerators (1.7.0) only in a home that has some: older drivers have none.
    const fans = state.fans.length > 0 || state.system?.inventory?.fans > 0;
    const refrigerators = state.refrigerators.length > 0 || state.system?.inventory?.refrigerators > 0;
    const kinds = ["light", "thermostat", "blind", ...(fans ? ["fan"] : []), ...(refrigerators ? ["refrigerator"] : [])];
    const optional = { fan: true, refrigerator: true };
    const [doorbells, ...results] = await Promise.all([
      optionalList("/v1/doorbells", state.doorbells),
      ...kinds.map((kind) =>
        optional[kind] ? optionalList(KINDS[kind].path, state[KINDS[kind].list]).then((items) => ({ items })) : api(KINDS[kind].path)
      ),
    ]);
    if (since !== forgets) return false;
    useDoorbells(doorbells);
    kinds.forEach((kind, index) => {
      const listName = KINDS[kind].list;
      const items = results[index]?.items || [];
      const fresh = kind === "thermostat" ? items.map(inOwnScale) : items;
      state[listName] = fresh.map((device) => {
        const pending = state.pending[`${kind}:${device.id}`];
        return pending ? state[listName].find((item) => item.id === device.id) || device : device;
      });
    });
    state.lastUpdated = new Date();
    failedRefreshes = 0;
    if (state.status !== "connected") {
      state.status = "connected";
      state.notice = null;
    }
  } catch (error) {
    if (since !== forgets) return false;
    if (error?.status === 401) {
      handleUnauthorized(error);
      return false;
    }
    failedRefreshes += 1;
    state.lastError = { at: new Date(), text: describeError(error) };
    console.warn(`DirectorLink refresh failed (${failedRefreshes} in a row)`, error);
    if (failedRefreshes < FAILURES_BEFORE_UNREACHABLE) {
      return false;
    }
    state.status = "unreachable";
    state.notice = connectionNotice(error);
  }
  notify();
  return failedRefreshes === 0;
}

// Rooms and cameras change rarely (renames, new devices); refreshed now and then. So is the
// driver's version: Update Driver in Composer reloads DirectorLink without the app reconnecting.
export async function refreshRooms() {
  const since = forgets;
  try {
    const [system, rooms, cameras, relays, role] = await Promise.all([
      api("/v1/system").catch(() => state.system),
      api("/v1/rooms"),
      api("/v1/cameras"),
      optionalList("/v1/relays"),
      loadRole().catch(() => state.role),
    ]);
    if (since !== forgets) return;
    state.system = system || state.system;
    state.rooms = rooms?.items || state.rooms;
    state.cameras = cameras?.items || state.cameras;
    state.relays = relays;
    state.role = role;
    notify();
    runConnectedHooks();
  } catch {
    // The next device refresh reports connection problems.
  }
}

let pollCount = 0;

function schedulePoll(delay = POLL_MS) {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(poll, delay);
}

async function poll() {
  pollTimer = null;
  if (!keyInUse()) return;
  // Once the key is forgotten, or being forgotten, this poll stops where it waits.
  const since = forgets;
  // In the background only doorbells are polled, and only for their notifications.
  if (document.hidden && state.loaded && notificationsOn()) {
    await refreshDoorbells();
    if (since !== forgets) return;
  }
  if (!document.hidden) {
    if (!state.loaded) {
      await connect();
      return;
    }
    const ok = await refreshDevices();
    if (since !== forgets) return;
    pollCount += 1;
    if (pollCount % 6 === 0) await tryHomeNetwork();
    if (since !== forgets) return;
    if (ok && pollCount % 6 === 1) checkInThroughAccount();
    if (ok && pollCount % 6 === 0 && state.status === "connected") {
      await Promise.all([refreshRooms(), refreshDeviceList()]);
      if (since !== forgets) return;
    }
    // After a failure, try again soon instead of waiting a whole interval.
    if (!ok && keyInUse()) {
      schedulePoll(RETRY_MS);
      return;
    }
  }
  if (keyInUse()) schedulePoll();
}

export function startPolling() {
  schedulePoll();
}

export function stopPolling() {
  window.clearTimeout(pollTimer);
  pollTimer = null;
}

function scheduleRetry() {
  if (state.apiKey) schedulePoll(POLL_MS);
}

// Back on the page: refresh at once instead of waiting for the next tick.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && keyInUse() && (state.status === "connected" || state.status === "unreachable")) {
    if (state.loaded) {
      refreshDevices().then(() => keyInUse() && schedulePoll());
    } else {
      connect();
    }
  }
});

// Settings → Controller → Forget key: revokes this browser's key on the controller when it can
// be reached (so the key stops working everywhere), then removes it from this browser. The
// refreshes stop first, and what was on its way stops at its next step (`forgets`).
export async function revokeAndForget() {
  forgetting = true;
  forgets += 1;
  stopPolling();
  if (reachable()) {
    try {
      // Any key may revoke itself (drivers with API key roles). Without an answer on the home
      // network it is revoked through the account (revoking twice changes nothing).
      await api("/v1/api-keys/current", { method: "DELETE", timeoutMs: 4000 }).catch((error) => {
        if (error?.status || error instanceof RemoteError || !savedRemote()) throw error;
        return remoteCall(state.apiKey, "/v1/api-keys/current", { method: "DELETE" });
      });
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) {
        // Older driver: find this key in the list and revoke it (every key was admin there).
        try {
          const keys = await api("/v1/api-keys", { timeoutMs: 4000 });
          const mine = keys?.items?.find((item) => item.current);
          if (mine) {
            await api(`/v1/api-keys/${mine.id}`, { method: "DELETE", timeoutMs: 4000 });
          }
        } catch {
          // Unreachable or not allowed: forgetting it here is still what was asked.
        }
      }
      // Otherwise unreachable or already revoked: forget it here anyway.
    }
  }
  forgetting = false;
  forgetKey();
  notify();
}

// Room names per language (PATCH /v1/rooms/{id}). Older drivers answer 404/405.
export async function saveRoomNames(roomId, names) {
  const room = await api(`/v1/rooms/${roomId}`, { method: "PATCH", body: { names } });
  state.rooms = state.rooms.map((item) =>
    item.id === Number(roomId) ? { ...item, ...(room && typeof room === "object" ? room : {}), names: room?.names || Object.fromEntries(Object.entries(names).filter(([, value]) => value)) } : item
  );
  notify();
  return room;
}
