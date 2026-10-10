// Joining from another device (ADR-053, docs/ACCOUNTS.md), and Paste invitation link.
//
// iOS gives an app added to the Home Screen its own storage, and opens every link in Safari: the
// link of Add my other device never reaches it. So a new device signed in to the account (that app,
// or any phone or computer) asks to join one of the account's homes from the Connect screen, and
// a device of the same account that already reaches the home (with an admin key; with any key
// since DirectorLink 1.9.0, as for Add my other device) sees the request while it is open. The new device shows a check code, which the
// person types there: only the same code (worked out on both from both keys) lets Approve make a
// for-me invitation at the controller, exactly as Add my other device does, and seal it to the new
// device (../device-join.js). The new device opens it and joins with it as with a link. The account
// service passes the keys and the sealed invitation on, and cannot open it.
//
// Join with an invitation (the Connect screen and Settings → Account; Paste invitation link before
// 1.12.0) takes a link that opened elsewhere, iOS's Safari above all: Paste reads it from the
// clipboard after a tap, or it is typed or pasted in the field, and the join page opens with it.

import { loadAccount } from "../account.js";
import { checkCode, codeText, commitmentOf, invitationFromText, keyPair, openInvitation, sealInvitation } from "../device-join.js";
import { h } from "../dom.js";
import { formatClock, formatDate, t } from "../i18n.js";
import { icon } from "../icons.js";
import {
  RemoteError,
  answerDeviceRequest,
  approveDeviceRequest,
  collectDeviceRequest,
  deleteDeviceRequest,
  getDeviceRequest,
  listAccountHomes,
  listDeviceRequests,
  parseInvitation,
  registerInvitation,
  savedRemote,
  showDeviceKey,
  startDeviceRequest,
} from "../remote.js";
import { api, clientName, errorText, whenConnected } from "../session.js";
import { can, notify, state, ui } from "../state.js";
import { deviceLimitOf, deviceLimitPanel } from "./device-limit.js";
import { useInvitation } from "./join.js";

// The new device's request, so that a reload carries on: { id, home, secret, approverKey,
// expiresAt }. The secret is its key pair's (hex), kept only while the request lasts.
const REQUEST_KEY = "directorlink.deviceJoin";
// The requests this device answers: { [id]: { secret, publicKey, commitment, expiresAt, tries } }.
const ANSWERS_KEY = "directorlink.deviceAnswers";
// While a request waits, the new device asks every 2 s; a device that reaches the home looks for
// requests every 60 s while it is shown (and at once when it comes to the front or connects), and
// every 2 s while it answers one.
const REQUEST_POLL_MS = 2000;
const LIST_POLL_MS = 60000;
const ANSWER_POLL_MS = 2000;
const LONGEST_POLL_MS = 60000;
// Wrong codes typed for one request before it is declined.
const CODE_TRIES = 3;
// A message after Approve or Decline stays this long.
const MESSAGE_MS = 10000;

// The account's homes are asked again this long after a failure.
const HOMES_RETRY_MS = 30000;

// The new device's side.
const joining = { homes: null, homesFor: null, home: null, busy: false, code: null, message: null };
// The side of a device that reaches the home. `typed`: the code being typed for each request, left
// out of the screen's signature (what is typed is never redrawn).
// `limit`: this device's user has five devices (1.9.0): the refusal, with their devices to remove one.
const approving = { home: null, items: [], codes: {}, mismatched: {}, typed: {}, busy: null, message: null, messageAt: 0, limit: null };
// Paste invitation link: the field, when the clipboard could not give a link. `text` is left out of
// the screen's signature: what is typed is never redrawn.
const paste = { open: null, text: "", message: null };

let requestTimer = null;
let requestFailures = 0;
let following = false;
let listTimer = null;
let listFailures = 0;
let watching = false;

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    // Blocked storage: the request lasts while this page is open.
  }
}

// The account service says it can (1.7.0); an older one is never asked.
function offered() {
  return state.account.status === "signed-in" && state.account.user?.device_requests === true;
}

// The device's own words for itself, which the other device shows: "Safari on iPhone", or for
// the app added to the Home Screen "DirectorLink app on iPhone" (clientName, since 1.12.0).
export function deviceLabel() {
  return clientName().slice(0, 48);
}

function go(hash) {
  if (window.location.hash === hash) {
    ui.tick += 1;
    notify();
  } else {
    window.location.hash = hash;
  }
}

// What the screens show from here, for app.js's signature.
export function deviceJoinSignature() {
  return [
    { ...joining, request: storedRequest()?.id ?? null },
    { ...approving, messageAt: undefined, typed: undefined },
    { open: paste.open, message: paste.message },
  ];
}

// ---- The new device ---------------------------------------------------------------------------

function storedRequest() {
  const value = read(REQUEST_KEY);
  if (
    !value ||
    !/^[0-9a-f]{32}$/.test(value.id) ||
    !/^[0-9a-f]{32}$/.test(value.home) ||
    !/^[0-9a-f]{64}$/.test(value.secret) ||
    !(Date.parse(value.expiresAt) > Date.now())
  ) {
    if (value) write(REQUEST_KEY, null);
    return null;
  }
  return value;
}

let pairCache = { secret: null, pair: null };
async function pairOf(secret) {
  if (pairCache.secret !== secret) pairCache = { secret, pair: await keyPair(secret) };
  return pairCache.pair;
}

// The request is over on this device: `ended` says why (ended.*), or `message` itself.
function endRequest(ended, message = null) {
  write(REQUEST_KEY, null);
  window.clearTimeout(requestTimer);
  requestTimer = null;
  joining.code = null;
  joining.busy = false;
  joining.message = ended ? { kind: "error", text: t(`deviceJoin.ended.${ended}`) } : message;
  notify();
}

function startError(error) {
  switch (error instanceof RemoteError ? error.code : null) {
    case "NO_APPROVER":
      return t("deviceJoin.errors.noApprover");
    case "DEVICE_REQUEST_LIMIT_REACHED":
      return t("deviceJoin.errors.tooMany");
    case "NOT_A_MEMBER":
      return t("deviceJoin.errors.notMember");
    case "NOT_SIGNED_IN":
      loadAccount();
      return t("deviceJoin.errors.signIn");
    case "NOT_FOUND":
      return t("deviceJoin.errors.unsupported");
    default:
      return errorText(error);
  }
}

async function loadHomes(userId) {
  joining.homesFor = userId;
  try {
    const answer = await listAccountHomes();
    joining.homes = (answer?.items || []).filter((home) => /^[0-9a-f]{32}$/.test(home.home_id));
  } catch {
    // Offline for now: asked again a little later.
    joining.homes = null;
    window.setTimeout(() => {
      if (joining.homesFor === userId && joining.homes === null) {
        joining.homesFor = null;
        notify();
      }
    }, HOMES_RETRY_MS);
  }
  notify();
}

async function startJoining(homeId) {
  if (joining.busy) return;
  joining.busy = true;
  joining.message = null;
  joining.code = null;
  notify();
  try {
    const pair = await keyPair();
    const request = await startDeviceRequest(homeId, deviceLabel(), await commitmentOf(pair.publicKey));
    pairCache = { secret: pair.secret, pair };
    write(REQUEST_KEY, { id: request.id, home: homeId, secret: pair.secret, approverKey: null, expiresAt: request.expires_at });
    requestFailures = 0;
    followSoon(REQUEST_POLL_MS);
  } catch (error) {
    joining.message = { kind: "error", text: startError(error) };
  } finally {
    joining.busy = false;
    notify();
  }
}

async function cancelJoining() {
  const saved = storedRequest();
  joining.busy = true;
  notify();
  if (saved) {
    await deleteDeviceRequest(saved.home, saved.id).catch(() => {});
  }
  endRequest(null, { kind: "info", text: t("deviceJoin.cancelled") });
}

// One look at a time: one asked for while another runs is left to it (it plans the next itself).
function followSoon(wait = REQUEST_POLL_MS) {
  if (requestTimer) return;
  requestTimer = window.setTimeout(() => {
    requestTimer = null;
    if (!storedRequest()) return;
    if (document.hidden) {
      followSoon(REQUEST_POLL_MS);
      return;
    }
    followRequest();
  }, wait);
}

// Asks how the request stands and takes the next step: once a device answered with its key, this
// device shows its own (the one it committed to) and the code; once approved, it collects the
// invitation, opens it and joins.
async function followRequest() {
  if (following) return;
  following = true;
  try {
    await followOnce();
  } finally {
    following = false;
  }
}

async function followOnce() {
  const saved = storedRequest();
  if (!saved) return;
  let item;
  try {
    item = await getDeviceRequest(saved.home, saved.id);
  } catch (error) {
    if (error instanceof RemoteError && error.code === "NOT_FOUND") {
      endRequest("gone");
      return;
    }
    if (error instanceof RemoteError && error.code === "NOT_SIGNED_IN") {
      await loadAccount();
      if (state.account.status !== "signed-in") {
        endRequest(null, { kind: "error", text: t("deviceJoin.errors.signIn") });
        return;
      }
    }
    // Offline for a moment: asked again, less often each time.
    requestFailures += 1;
    followSoon(Math.min(REQUEST_POLL_MS * 2 ** requestFailures, LONGEST_POLL_MS));
    return;
  }
  requestFailures = 0;
  try {
    const pair = await pairOf(saved.secret);
    if (item.approver_key) {
      // The first key that came is the one: the code was made with it, so it must never change.
      if (!saved.approverKey) {
        saved.approverKey = item.approver_key;
        write(REQUEST_KEY, saved);
      } else if (saved.approverKey !== item.approver_key) {
        await deleteDeviceRequest(saved.home, saved.id).catch(() => {});
        endRequest("mismatch");
        return;
      }
      if (item.device_key && item.device_key !== pair.publicKey) {
        await deleteDeviceRequest(saved.home, saved.id).catch(() => {});
        endRequest("mismatch");
        return;
      }
      if (!item.device_key) {
        item = await showDeviceKey(saved.home, saved.id, pair.publicKey);
      }
      joining.code = await checkCode(saved.id, saved.approverKey, pair.publicKey);
      notify();
    }
    if (item.status === "approved") {
      await finishJoining(saved, pair);
      return;
    }
  } catch (error) {
    if (error instanceof RemoteError && error.code === "NOT_FOUND") {
      endRequest("gone");
      return;
    }
    // Collecting failed on the way: tried again at the next look.
    joining.busy = false;
    requestFailures += 1;
  }
  followSoon(requestFailures ? Math.min(REQUEST_POLL_MS * 2 ** requestFailures, LONGEST_POLL_MS) : REQUEST_POLL_MS);
}

async function finishJoining(saved, pair) {
  joining.busy = true;
  notify();
  const answer = await collectDeviceRequest(saved.home, saved.id);
  if (answer?.approver_key !== saved.approverKey) {
    endRequest("mismatch");
    return;
  }
  const text = await openInvitation(pair, { requestId: saved.id, home: saved.home, approverKey: saved.approverKey }, answer.sealed);
  const invitation = parseInvitation(text);
  if (!invitation || invitation.home !== saved.home) {
    endRequest("unreadable");
    return;
  }
  endRequest(null);
  // The join, exactly as with the link of Add my other device. A device that has a key by now (it
  // got one another way meanwhile) is asked first whether to replace it.
  useInvitation(text, go, { accept: !state.apiKey });
}

// A key was saved on this device another way (pairing, an invitation's link) while its request
// waited: it needs no other, so the request is withdrawn before anyone approves it.
async function withdrawForKey() {
  const saved = storedRequest();
  if (!saved || !state.apiKey) return;
  endRequest(null, { kind: "info", text: t("deviceJoin.keySaved") });
  await deleteDeviceRequest(saved.home, saved.id).catch(() => {});
}

function homePicker(homes) {
  if (homes.length < 2) return null;
  joining.home = homes.some((home) => home.home_id === joining.home) ? joining.home : homes[0].home_id;
  const select = h(
    "select",
    { id: "device-join-home", dataset: { key: "device-join-home" } },
    ...homes.map((home) =>
      h(
        "option",
        { value: home.home_id, selected: home.home_id === joining.home },
        t(home.owner ? "deviceJoin.homeOwned" : "deviceJoin.homeOption", { date: home.added_at ? formatDate(new Date(home.added_at)) : "" })
      )
    )
  );
  select.addEventListener("change", () => {
    joining.home = select.value;
  });
  return [h("label", { class: "field-label", for: "device-join-home" }, t("deviceJoin.homeLabel")), select];
}

function messageLine(message) {
  return message ? h("p", { class: `notice notice-${message.kind}`, role: message.kind === "error" ? "alert" : "status" }, message.text) : null;
}

// The Connect screen, signed in (views/connect.js): Join from another device, or the request
// while it waits.
export function joinFromAnotherDevice() {
  if (!offered()) return null;
  const saved = storedRequest();
  if (saved) {
    if (!following) followSoon(0);
    return h(
      "div",
      { class: "device-join", id: "device-join", "aria-live": "polite" },
      h("h3", { class: "settings-subtitle" }, t("deviceJoin.waitingTitle")),
      joining.code
        ? [
            h("p", { class: "connect-text" }, t("deviceJoin.codeText")),
            h("p", { class: "join-code", dir: "ltr", dataset: { key: "device-join-code" }, "aria-label": t("deviceJoin.codeLabel", { code: joining.code.split("").join(" ") }) }, codeText(joining.code)),
          ]
        : [
            h("p", { class: "connect-text" }, t("deviceJoin.waiting", { email: state.account.user.email })),
            h("p", { class: "field-help", role: "status", dataset: { key: "device-join-status" } }, joining.busy ? t("deviceJoin.joining") : t("deviceJoin.waitingStatus")),
          ],
      joining.code && joining.busy ? h("p", { class: "field-help", role: "status" }, t("deviceJoin.joining")) : null,
      h("p", { class: "field-help" }, t("deviceJoin.lasts", { time: formatClock(new Date(saved.expiresAt)) })),
      h(
        "div",
        { class: "button-row" },
        h("button", { type: "button", class: "button button-secondary", dataset: { key: "device-join-cancel" }, disabled: joining.busy, onclick: cancelJoining }, t("deviceJoin.cancel"))
      )
    );
  }
  const userId = state.account.user?.id ?? null;
  if (joining.homesFor !== userId) {
    joining.homes = null;
    loadHomes(userId);
  }
  const homes = joining.homes || [];
  if (!homes.length) return messageLine(joining.message);
  return h(
    "div",
    { class: "device-join", id: "device-join" },
    h("h3", { class: "settings-subtitle" }, t("deviceJoin.title")),
    h("p", { class: "field-help" }, t("deviceJoin.help")),
    messageLine(joining.message),
    homePicker(homes),
    h(
      "button",
      {
        type: "button",
        class: "button button-primary button-wide",
        dataset: { key: "device-join-start" },
        disabled: joining.busy,
        onclick: () => startJoining(homes.length > 1 ? joining.home : homes[0].home_id),
      },
      icon("users"),
      joining.busy ? t("deviceJoin.starting") : t("deviceJoin.start")
    )
  );
}

// ---- A device that reaches the home -------------------------------------------------------------

// The same rule as Add my other device: signed in, linked to the home, with an admin key, once the
// key's role is known (Settings asks the same; before that can() takes it for an admin's). Since
// 1.9.0 (ADR-061, `features.users`) every user adds their own devices: any key of the account.
function mayApprove() {
  return offered() && Boolean(state.apiKey) && Boolean(savedRemote()?.home) && state.loaded && (can("admin") || state.system?.features?.users === true);
}

function answers() {
  const value = read(ANSWERS_KEY);
  return value && typeof value === "object" ? value : {};
}

function keepAnswers(value) {
  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(value).filter(([, answer]) => Date.parse(answer?.expiresAt) > now));
  write(ANSWERS_KEY, Object.keys(kept).length ? kept : null);
}

function mine(item) {
  const answer = answers()[item.id];
  return answer && item.approver_key && answer.publicKey === item.approver_key ? answer : null;
}

// An invitation from the controller (admin keys), registered with the account: for an email, or
// for this person's other device (`forSelf`: 10 minutes, and the new key joins this device's
// person). The controller registers it itself (1.0.0 and later); for an older one the home's owner
// does, from here. One the account did not take is revoked at home too. Settings' Add my other
// device, Add a user's Send a link and Move to the Home Screen app (1.12.0: `name`, the new user's,
// and `move`, ADR-083), and Approve here.
export async function makeInvitation({ forSelf, email, role, access, profileId, name, move }) {
  // Just under 7 days: the account refuses invitations longer than that.
  // For my other device, the new key joins my profile (drivers with profiles, 0.12.0 and later).
  const body = { role, expires_in: forSelf ? 600 : 7 * 24 * 3600 - 300 };
  if (forSelf && state.profile) body.for_me = true;
  if (forSelf && move) body.move = true;
  if (!forSelf && !profileId && name) body.name = name;
  // What the invited member may see and do (1.8.0, ADR-054).
  if (access) body.access = access;
  // Another device of an existing user (1.9.0, ADR-061: an admin invites their account).
  if (profileId && !forSelf) body.profile_id = profileId;
  let invitation = null;
  try {
    try {
      // The controller registers it with the account service itself (1.0.0 and later).
      invitation = await api("/v1/invitations", { method: "POST", body: { ...body, email } });
    } catch (error) {
      const field = error?.problem?.errors?.[0]?.field;
      if (error?.code !== "INVALID_FIELD" || field !== "email") throw error;
      // A driver before 1.0.0: the home's owner registers it from here.
      invitation = await api("/v1/invitations", { method: "POST", body });
      await registerInvitation(invitation.home_id, invitation, email);
    }
    return invitation;
  } catch (error) {
    revokeInvitation(invitation);
    throw error;
  }
}

function revokeInvitation(invitation) {
  if (invitation?.id) api(`/v1/invitations/${invitation.id}`, { method: "DELETE" }).catch(() => {});
}

function say(kind, text) {
  const at = Date.now();
  approving.message = { kind, text };
  approving.messageAt = at;
  window.setTimeout(() => {
    if (approving.messageAt !== at) return;
    approving.message = null;
    notify();
  }, MESSAGE_MS);
}

async function refreshRequests() {
  const home = savedRemote()?.home;
  if (!mayApprove() || !home) {
    if (approving.items.length || approving.message) {
      approving.items = [];
      approving.message = null;
      notify();
    }
    return;
  }
  try {
    const answer = await listDeviceRequests(home);
    approving.home = home;
    approving.items = Array.isArray(answer?.items) ? answer.items.filter((item) => item.home_id === home) : [];
    listFailures = 0;
  } catch (error) {
    listFailures += 1;
    // Not a member any more (the request list is the account's): nothing to show.
    if (error instanceof RemoteError && error.code === "NOT_A_MEMBER") approving.items = [];
    notify();
    return;
  }
  for (const item of approving.items) {
    const answer = mine(item);
    if (!answer || !item.device_key || approving.mismatched[item.id]) continue;
    const known = approving.codes[item.id];
    // The new device's key must be the one it committed to before it saw this device's key, and
    // stay the one the code was made with: Approve seals to that key only.
    if (known ? known.deviceKey !== item.device_key : (await commitmentOf(item.device_key)) !== answer.commitment) {
      approving.mismatched[item.id] = true;
      delete approving.codes[item.id];
    } else if (!known) {
      approving.codes[item.id] = { code: await checkCode(item.id, answer.publicKey, item.device_key), deviceKey: item.device_key };
    }
  }
  const listed = new Set(approving.items.map((item) => item.id));
  for (const id of Object.keys(approving.codes)) if (!listed.has(id)) delete approving.codes[id];
  for (const id of Object.keys(approving.mismatched)) if (!listed.has(id)) delete approving.mismatched[id];
  // Read again: Show code may have kept one meanwhile.
  keepAnswers(Object.fromEntries(Object.entries(answers()).filter(([id]) => listed.has(id))));
  notify();
}

function listSoon(wait) {
  window.clearTimeout(listTimer);
  listTimer = window.setTimeout(async () => {
    listTimer = null;
    if (!document.hidden) await refreshRequests().catch(() => {});
    listSoon(nextListWait());
  }, wait);
}

// Quicker while this device answers a request whose new device has not shown its key yet.
function nextListWait() {
  if (listFailures) return Math.min(LIST_POLL_MS * 2 ** listFailures, 4 * LONGEST_POLL_MS);
  return approving.items.some((item) => mine(item) && (!item.device_key || item.status === "approved")) ? ANSWER_POLL_MS : LIST_POLL_MS;
}

let lastLook = 0;
function lookNow() {
  if (document.hidden || Date.now() - lastLook < 2000) return;
  lastLook = Date.now();
  listSoon(0);
}

// From the start (app.js): looks for requests while the app is shown, and at once when it comes to
// the front. Nothing is asked while this device could not approve.
export function watchDeviceRequests() {
  if (watching) return;
  watching = true;
  document.addEventListener("visibilitychange", lookNow);
  window.addEventListener("focus", lookNow);
  listSoon(3000);
  // Once connected (its role is known), at once; a request of this device's own goes, as it has a
  // key now.
  whenConnected(() => {
    withdrawForKey();
    lastLook = 0;
    lookNow();
  });
  // A request this device asked for before a reload carries on.
  if (storedRequest()) followSoon(0);
}

async function act(item, work) {
  if (approving.busy) return;
  approving.busy = item.id;
  approving.message = null;
  approving.limit = null;
  notify();
  try {
    await work();
  } finally {
    approving.busy = null;
    notify();
    listSoon(0);
  }
}

// Show code: this device takes the request, with a key pair of its own.
function showCode(item) {
  return act(item, async () => {
    try {
      const pair = await keyPair();
      // The commitment as it was before this device's key went out.
      const kept = answers();
      kept[item.id] = { secret: pair.secret, publicKey: pair.publicKey, commitment: item.commitment, expiresAt: item.expires_at };
      keepAnswers(kept);
      await answerDeviceRequest(approving.home, item.id, pair.publicKey);
    } catch (error) {
      say("error", error instanceof RemoteError && error.code === "ALREADY_ANSWERED" ? t("deviceJoin.request.elsewhere") : errorText(error));
    }
  });
}

// The code typed for a request, as digits.
const typedCode = (id) => String(approving.typed[id] || "").replace(/\D/g, "");

// A wrong code typed: approved is nothing, and after CODE_TRIES the request is declined (whoever
// asked must start again, on their own screen).
async function wrongCode(item, answer) {
  const tries = (answer.tries || 0) + 1;
  approving.typed[item.id] = "";
  const kept = answers();
  if (kept[item.id]) {
    kept[item.id].tries = tries;
    keepAnswers(kept);
  }
  if (tries < CODE_TRIES) {
    say("error", t("deviceJoin.request.wrongCode", { label: item.label }));
    return;
  }
  await deleteDeviceRequest(approving.home, item.id).catch(() => {});
  approving.items = approving.items.filter((other) => other.id !== item.id);
  say("error", t("deviceJoin.request.wrongCodeDeclined", { label: item.label }));
}

// The cloud did not answer Approve (no connection, a timeout, an error of its own): the request
// says whether it took the sealed invitation. True when it did (approved, or collected since);
// false when it still waits; null when that cannot be told now.
async function approvalArrived(home, id) {
  try {
    return (await getDeviceRequest(home, id)).status === "approved";
  } catch (error) {
    return error instanceof RemoteError && error.code === "NOT_FOUND" ? true : null;
  }
}

function approve(item) {
  const answer = mine(item);
  if (!answer || !approving.codes[item.id]) return Promise.resolve();
  return act(item, async () => {
    // The person types the code the new device shows: a tap alone approves nothing.
    if (typedCode(item.id) !== approving.codes[item.id].code) {
      await wrongCode(item, answer);
      return;
    }
    let invitation = null;
    let sent = false;
    try {
      const home = approving.home;
      invitation = await makeInvitation({ forSelf: true, email: state.account.user.email, role: state.role || "admin" });
      if (invitation.home_id !== home) throw new Error(t("deviceJoin.request.otherHome"));
      const pair = await keyPair(answer.secret);
      // Sealed to the key the code was made with, whatever the list says now.
      const verified = approving.codes[item.id];
      if (!verified) throw new Error(t("deviceJoin.request.mismatch"));
      const { deviceKey } = verified;
      const sealed = await sealInvitation(pair, { requestId: item.id, home, deviceKey }, `${invitation.home_id}.${invitation.id}.${invitation.secret}`);
      sent = true;
      await approveDeviceRequest(home, item.id, sealed);
      approving.typed[item.id] = "";
      say("success", t("deviceJoin.request.approved", { label: item.label }));
    } catch (error) {
      // The cloud refused it (gone, approved elsewhere): nobody can use it, and it goes at home too.
      // Without an answer it may have arrived: the request says so first.
      const refused = error instanceof RemoteError && error.httpStatus >= 400 && error.httpStatus < 500;
      const arrived = sent && !refused ? await approvalArrived(approving.home, item.id) : false;
      if (arrived === false) revokeInvitation(invitation);
      if (arrived === true) {
        approving.typed[item.id] = "";
        say("success", t("deviceJoin.request.approved", { label: item.label }));
      } else if (arrived === null) {
        // Left as it is: it lasts 10 minutes, and the new device may have it already.
        say("error", t("deviceJoin.request.unsure", { label: item.label }));
      } else if (deviceLimitOf(error)) {
        // Five devices already (1.9.0): "Remove a device first", with the list.
        approving.limit = deviceLimitOf(error);
      } else {
        say("error", error instanceof RemoteError && error.code === "NOT_FOUND" ? t("deviceJoin.request.gone") : errorText(error));
      }
    }
  });
}

// From the "Remove a device first" list: removed, then Approve again.
function removeForRoom(device) {
  if (approving.busy || !window.confirm(t("access.revokeConfirm", { name: device.name }))) return;
  approving.busy = "limit";
  notify();
  api(`/v1/api-keys/${device.id}`, { method: "DELETE" })
    .then(
      () => {
        approving.limit = null;
        say("success", t("users.limit.removed", { name: device.name }));
      },
      (error) => say("error", errorText(error))
    )
    .finally(() => {
      approving.busy = null;
      notify();
    });
}

function decline(item) {
  return act(item, async () => {
    try {
      await deleteDeviceRequest(approving.home, item.id);
      say("info", t("deviceJoin.request.declined", { label: item.label }));
    } catch (error) {
      if (!(error instanceof RemoteError && error.code === "NOT_FOUND")) say("error", errorText(error));
    }
    approving.items = approving.items.filter((other) => other.id !== item.id);
  });
}

function requestRow(item) {
  const busy = Boolean(approving.busy);
  const answer = mine(item);
  const code = approving.codes[item.id]?.code;
  const declineButton = h(
    "button",
    { type: "button", class: "button button-secondary button-small", dataset: { key: `device-request-decline-${item.id}` }, disabled: busy, onclick: () => decline(item) },
    t("deviceJoin.request.decline")
  );
  let text;
  let detail = null;
  let actions = [declineButton];
  if (item.status === "approved") {
    text = t("deviceJoin.request.finishing", { label: item.label });
    actions = [];
  } else if (item.approver_key && !answer) {
    text = t("deviceJoin.request.asks", { label: item.label });
    detail = t("deviceJoin.request.elsewhere");
  } else if (!answer) {
    text = t("deviceJoin.request.asks", { label: item.label });
    detail = t("deviceJoin.request.askedAt", { time: formatClock(new Date(item.created_at)) });
    actions = [
      h(
        "button",
        { type: "button", class: "button button-primary button-small", dataset: { key: `device-request-show-${item.id}` }, disabled: busy, onclick: () => showCode(item) },
        t("deviceJoin.request.showCode")
      ),
      declineButton,
    ];
  } else if (approving.mismatched[item.id]) {
    text = t("deviceJoin.request.mismatch");
  } else if (!code) {
    text = t("deviceJoin.request.waitingKey", { label: item.label });
  } else {
    // This device's code is not shown: the person types the one the new device shows, so that
    // Approve cannot be tapped without looking at the device that asks.
    return h(
      "li",
      { class: "device-request-item", dataset: { key: `device-request-${item.id}` } },
      codeForm(item, busy, declineButton)
    );
  }
  return h(
    "li",
    { class: "device-request-item", dataset: { key: `device-request-${item.id}` } },
    h("p", { class: "device-request-text", dir: "auto" }, text),
    detail ? h("p", { class: "field-help" }, detail) : null,
    actions.length ? h("div", { class: "button-row" }, ...actions) : null
  );
}

// Type the code {label} shows, and Approve (or Enter); Decline.
function codeForm(item, busy, declineButton) {
  const id = `device-request-code-${item.id}`;
  const field = h("input", {
    id,
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    maxlength: "7",
    dir: "ltr",
    class: "code-input",
    value: approving.typed[item.id] || "",
    placeholder: "000 000",
    dataset: { key: id },
  });
  field.addEventListener("input", () => {
    approving.typed[item.id] = field.value;
  });
  return h(
    "form",
    {
      class: "device-request-form",
      novalidate: true,
      dataset: { key: `device-request-form-${item.id}` },
      onsubmit: (event) => {
        event.preventDefault();
        approve(item);
      },
    },
    h("label", { class: "device-request-text", for: id, dir: "auto" }, t("deviceJoin.request.typeCode", { label: item.label })),
    field,
    h(
      "div",
      { class: "button-row" },
      h(
        "button",
        { type: "submit", class: "button button-primary button-small", dataset: { key: `device-request-approve-${item.id}` }, disabled: busy },
        approving.busy === item.id ? t("deviceJoin.request.approving") : t("deviceJoin.request.approve")
      ),
      declineButton
    )
  );
}

// Under every screen's header, on a device that may approve: the requests of the account's new
// devices for this home.
export function deviceRequestNotice() {
  if (!mayApprove() || approving.home !== savedRemote()?.home || (!approving.items.length && !approving.message && !approving.limit)) return null;
  return h(
    "section",
    { class: "card device-request", "aria-labelledby": "device-request-title", dataset: { key: "device-request" } },
    h("h2", { class: "device-request-title", id: "device-request-title" }, icon("users"), t("deviceJoin.request.title")),
    messageLine(approving.message),
    deviceLimitPanel(approving.limit, {
      remove: removeForRoom,
      busy: Boolean(approving.busy),
      key: "device-request-limit",
      dismiss: () => {
        approving.limit = null;
        notify();
      },
    }),
    approving.items.length ? h("ul", { class: "device-request-list" }, ...approving.items.map(requestRow)) : null
  );
}

// ---- Paste invitation link ----------------------------------------------------------------------

function useText(text) {
  const invitation = invitationFromText(text);
  if (!invitation) return false;
  paste.open = null;
  paste.text = "";
  paste.message = null;
  useInvitation(invitation, go);
  return true;
}

// Paste: the clipboard, read only after this tap (iOS shows its own Paste button, other browsers
// may ask). Where it cannot be read (refused, or a browser without it), or holds no link, the field
// takes it.
async function pasteFromClipboard(key) {
  let text = null;
  try {
    if (navigator.clipboard?.readText) text = await navigator.clipboard.readText();
  } catch {
    text = null;
  }
  if (useText(text)) return;
  paste.open = key;
  paste.message = text && text.trim() ? t("deviceJoin.paste.notALink") : t("deviceJoin.paste.typeIt");
  notify();
  window.requestAnimationFrame(() => document.querySelector(`[data-key="${key}-paste-text"]`)?.focus());
}

function openPanel(key) {
  paste.open = key;
  paste.message = null;
  notify();
}

// `key`: where it is (connect, account), so that the field comes back where it was opened. Join
// with an invitation opens the panel: Paste, and the field.
export function pasteInvitationPanel({ key }) {
  if (paste.open !== key) {
    return h(
      "div",
      { class: "paste-invitation" },
      h(
        "div",
        { class: "button-row" },
        h("button", { type: "button", class: "button button-secondary", dataset: { key: `${key}-paste` }, onclick: () => openPanel(key) }, icon("key"), t("deviceJoin.paste.button"))
      )
    );
  }
  const button = h(
    "button",
    { type: "button", class: "button button-primary", dataset: { key: `${key}-paste-clipboard` }, onclick: () => pasteFromClipboard(key) },
    icon("copy"),
    t("deviceJoin.paste.paste")
  );
  const field = h("input", {
    id: `${key}-paste-text`,
    type: "text",
    inputmode: "url",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    dir: "ltr",
    value: paste.text,
    placeholder: "https://app.directorlink.io/#/join/…",
    "aria-describedby": `${key}-paste-help`,
    dataset: { key: `${key}-paste-text` },
  });
  field.addEventListener("input", () => {
    paste.text = field.value;
  });
  return h(
    "form",
    {
      class: "paste-invitation",
      novalidate: true,
      dataset: { key: `${key}-paste-panel` },
      onsubmit: (event) => {
        event.preventDefault();
        if (useText(paste.text)) return;
        paste.message = t("deviceJoin.paste.notALink");
        notify();
      },
    },
    h("h3", { class: "settings-subtitle" }, t("deviceJoin.paste.button")),
    h("p", { class: "field-help" }, t("deviceJoin.paste.intro")),
    h("div", { class: "button-row" }, button),
    h("label", { class: "field-label", for: `${key}-paste-text` }, t("deviceJoin.paste.label")),
    field,
    h("p", { class: "field-help", id: `${key}-paste-help` }, t("deviceJoin.paste.help")),
    paste.message ? h("p", { class: "notice notice-error", role: "alert" }, paste.message) : null,
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "submit", class: "button button-secondary", dataset: { key: `${key}-paste-join` } }, t("deviceJoin.paste.join")),
      h(
        "button",
        {
          type: "button",
          class: "button button-quiet",
          onclick: () => {
            paste.open = null;
            paste.message = null;
            notify();
          },
        },
        t("common.cancel")
      )
    )
  );
}
