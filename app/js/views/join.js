// #/join: accepting an invitation (docs/ACCOUNTS.md). The link's secret was taken out of the
// address as the page opened (app.js) and is kept for this tab only, so it survives the sign-in
// but is never sent to a server or left in the history. An invitation for another email waits for
// the home's owner to approve this account (ADR-041): the page shows a code to read out to them,
// asks every few seconds, and finishes by itself once they have.
//
// Since 1.12.0 (ADR-083): opened in a browser on iPhone or iPad (Safari, not the Home Screen app),
// the page first recommends joining in the Home Screen app, which has its own storage and gets
// alerts: copy the link, add DirectorLink to the Home Screen, open it there and paste the link in
// Join with an invitation. Joining here stays possible (Join here in Safari). Once joined, the home
// says in its sealed answer which user this device joined as, and the home's name: "You joined
// <home> as <user>." shows over the next screen. Neither is ever sent to DirectorLink's servers.

import { clearHost, saveApiKey } from "../../api-client.js";
import { loadAccount } from "../account.js";
import { h } from "../dom.js";
import { formatDateTime, t } from "../i18n.js";
import { icon } from "../icons.js";
import { inIosBrowser, isSafari } from "../home-screen.js";
import { RemoteError, acceptInvitation, checkJoinRequest, invitationLink, joinCodeText, parseInvitation, saveRemote, withdrawJoinRequest } from "../remote.js";
import { clientName, connect, errorText, forgetSealing } from "../session.js";
import { notify, state, ui } from "../state.js";
import { pageHeader, signInButtons } from "./common.js";
import { homeScreenSteps } from "./move.js";

const JOIN_KEY = "directorlink.join";
// The invitation this tab asked the home's owner about, so a reload carries on waiting.
const ASKED_KEY = "directorlink.joinAsked";
const POLL_MS = 5000;
// After failed asks (offline, or the server failing), the next one waits twice as long, up to this.
const LONGEST_POLL_MS = 60000;
let pollTimer = null;
let pollNavigate = null;
let pollFailures = 0;

export function storeInvitation(text) {
  try {
    sessionStorage.setItem(JOIN_KEY, text);
  } catch {
    // Blocked storage: the invitation cannot outlive this page.
  }
}

function storedInvitation() {
  try {
    return parseInvitation(sessionStorage.getItem(JOIN_KEY));
  } catch {
    return null;
  }
}

function clearInvitation() {
  try {
    sessionStorage.removeItem(JOIN_KEY);
    sessionStorage.removeItem(ASKED_KEY);
  } catch {
    // Nothing stored.
  }
}

function markAsked(key) {
  try {
    sessionStorage.setItem(ASKED_KEY, key);
  } catch {
    // Blocked storage: a reload shows Accept again, which carries on the same request.
  }
}

function asked(key) {
  try {
    return sessionStorage.getItem(ASKED_KEY) === key;
  } catch {
    return false;
  }
}

function joinError(error) {
  if (error instanceof RemoteError) {
    switch (error.code) {
      case "EMAIL_MISMATCH":
        // Apple's Hide My Email gives an address nobody invited.
        return /@privaterelay\.appleid\.com$/.test(state.account.user?.email || "")
          ? `${t("join.errors.emailMismatch")} ${t("join.errors.hiddenEmail")}`
          : t("join.errors.emailMismatch");
      case "INVITATION_NOT_FOUND":
      case "INVITATION_EXPIRED":
      case "JOIN_REFUSED":
        return t("join.errors.used");
      // The home's owner refused this account (ADR-041).
      case "REFUSED_BY_OWNER":
        return t("join.errors.refused");
      case "JOIN_REQUEST_LIMIT_REACHED":
        return t("join.errors.tooManyRequests");
      case "KEY_LIMIT_REACHED":
        return t("connect.errors.keyLimit");
      case "HOME_OFFLINE":
      case "HOME_TIMEOUT":
        return t("join.errors.homeOffline");
      case "NOT_SIGNED_IN":
        return t("join.errors.signIn");
      default:
        break;
    }
  }
  return errorText(error);
}

// The invitation this tab holds, as one string (a request waiting is for it).
function invitationKey(invitation) {
  return `${invitation.home}.${invitation.invitation}`;
}

// An invitation that reached this device without its link (ADR-053): pasted (Paste invitation
// link), or sealed by another device of the account, which approved this one. It is kept as a
// link's is and the join page opens; `accept`: accepted at once (the new device asked to join, and
// has no key to replace).
export function useInvitation(text, navigate, { accept: now = false } = {}) {
  storeInvitation(text);
  ui.joinWait = null;
  ui.joinMessage = null;
  ui.joinChecked = null;
  ui.joinConfirmed = false;
  ui.joinCopied = null;
  ui.joinHere = false;
  navigate("#/join");
  // Accepted from memory even where this tab cannot keep it.
  const invitation = storedInvitation() || parseInvitation(text);
  if (now && invitation) accept(invitation, navigate, { confirmed: true });
}

// `confirmed`: this device's key may be replaced without asking again (asked at the first tap).
async function accept(invitation, navigate, { confirmed = false } = {}) {
  // This device already has a key (its home, or another): the invitation's key replaces it.
  if (state.apiKey && !confirmed && !ui.joinConfirmed && !window.confirm(t("join.replaceConfirm"))) {
    return;
  }
  ui.joinConfirmed = true;
  ui.joinBusy = true;
  ui.joinMessage = null;
  notify();
  try {
    const key = await acceptInvitation(invitation, clientName());
    if (key.waiting) {
      // Another email: the home's owner decides; this page asks again every few seconds.
      ui.joinWait = { ...key.waiting, for: invitationKey(invitation) };
      markAsked(invitationKey(invitation));
      schedulePoll(navigate);
      return;
    }
    ui.joinWait = null;
    if (!key.member) {
      // The home made the key but the account could not be added: it could not be used from here.
      clearInvitation();
      ui.joinMessage = t("join.errors.notRecorded");
      return;
    }
    saveApiKey(key.key);
    // What was known about the previous key (its id, whether it sealed) goes with it.
    forgetSealing();
    saveRemote({ home: invitation.home, keyId: key.id });
    // The saved address may be another controller's; the new key starts through the account and
    // the address can be entered again in Settings.
    clearHost();
    state.host = "";
    state.apiKey = key.key;
    state.role = null;
    state.loaded = false;
    state.remoteInfo = null;
    state.transport = "remote";
    state.status = "connecting";
    clearInvitation();
    // Whom this device joined as, from the home's sealed answer (1.12.0): said over the next screen.
    ui.joined = typeof key.user?.name === "string" && key.user.name ? { user: key.user.name.slice(0, 64), home: typeof key.home_name === "string" ? key.home_name.slice(0, 64) : "" } : null;
    navigate("#/");
    connect();
  } catch (error) {
    if (error instanceof RemoteError && error.code === "REFUSED_BY_OWNER") {
      ui.joinWait = { ...(ui.joinWait || {}), status: "refused", for: invitationKey(invitation) };
    }
    ui.joinMessage = joinError(error);
  } finally {
    ui.joinBusy = false;
    notify();
  }
}

// What the owner decided, asked every few seconds while this page is open and in view.
function schedulePoll(navigate) {
  pollNavigate = navigate;
  if (pollTimer) return;
  const wait = Math.min(POLL_MS * 2 ** pollFailures, LONGEST_POLL_MS);
  pollTimer = window.setTimeout(async () => {
    pollTimer = null;
    const invitation = storedInvitation();
    if (!window.location.hash.startsWith("#/join") || !invitation || state.account.status !== "signed-in" || ui.joinWait?.status !== "pending" || ui.joinWait.for !== invitationKey(invitation)) return;
    if (document.hidden) {
      schedulePoll(pollNavigate);
      return;
    }
    await followRequest(invitation, pollNavigate);
  }, wait);
}

// Asks the account server about this account's request, and does what its answer says.
async function followRequest(invitation, navigate) {
  let result;
  try {
    result = await checkJoinRequest(invitation);
  } catch (error) {
    // The account's session ended meanwhile (signed out everywhere, the account deleted, or Apple
    // said so): nothing is asked any more; the page offers to sign in again.
    if (error instanceof RemoteError && error.code === "NOT_SIGNED_IN") {
      await loadAccount();
      // Still signed in after all: asked again, later.
      if (state.account.status === "signed-in" && ui.joinWait?.status === "pending") {
        pollFailures += 1;
        schedulePoll(navigate);
      } else {
        pollFailures = 0;
      }
      notify();
      return;
    }
    // Offline for a moment, or the server failing: ask again later, less often each time.
    pollFailures += 1;
    if (ui.joinWait?.status === "pending") schedulePoll(navigate);
    return;
  }
  pollFailures = 0;
  const key = invitationKey(invitation);
  switch (result.outcome) {
    case "wait":
      ui.joinWait = { ...result.request, for: key };
      schedulePoll(navigate);
      break;
    case "finish":
      ui.joinWait = { ...result.request, for: key };
      // Approved: accepted at once, unless this device's key would be replaced without having
      // asked (the page was opened again); then the person taps Finish joining.
      if (!state.apiKey || ui.joinConfirmed) {
        notify();
        await accept(invitation, navigate, { confirmed: true });
        return;
      }
      break;
    case "refused":
    case "expired":
      ui.joinWait = { ...result.request, for: key };
      ui.joinMessage = null;
      break;
    case "gone":
      ui.joinWait = null;
      ui.joinMessage = t("join.errors.used");
      break;
    default:
      ui.joinWait = null;
  }
  notify();
}

async function withdraw(invitation) {
  ui.joinBusy = true;
  notify();
  try {
    await withdrawJoinRequest(invitation);
    ui.joinWait = null;
    ui.joinMessage = t("join.withdrawn");
  } catch (error) {
    // Already gone (the owner's answer came first, or the invitation was used): nothing to withdraw.
    if (error instanceof RemoteError && error.code === "NOT_FOUND") {
      ui.joinWait = null;
      ui.joinMessage = null;
    } else {
      ui.joinMessage = joinError(error);
    }
  } finally {
    ui.joinBusy = false;
    notify();
  }
}

// While the owner decides, and after: the code to read out, and what happens next.
function waitingContent(invitation, navigate) {
  const wait = ui.joinWait;
  const message = ui.joinMessage ? h("p", { class: "notice notice-error", role: "alert" }, ui.joinMessage) : null;
  if (wait.status === "refused") {
    return [h("p", { class: "notice notice-error", role: "status", dataset: { key: "join-refused" } }, t("join.errors.refused"))];
  }
  if (wait.status === "expired") {
    return [h("p", { class: "notice notice-error", role: "status", dataset: { key: "join-expired" } }, t("join.errors.expiredWaiting"))];
  }
  if (wait.status === "approved") {
    return [
      h("p", { class: "notice notice-success", role: "status" }, t("join.approved")),
      message,
      h(
        "button",
        { type: "button", class: "button button-primary button-wide", dataset: { key: "join-finish" }, disabled: Boolean(ui.joinBusy), onclick: () => accept(invitation, navigate) },
        ui.joinBusy ? t("join.accepting") : t("join.finish")
      ),
    ];
  }
  schedulePoll(navigate);
  return [
    h("h3", { class: "settings-subtitle" }, t("join.waitingTitle")),
    h("p", { class: "connect-text" }, t("join.waitingText")),
    h("p", { class: "join-code", dir: "ltr", dataset: { key: "join-code" }, "aria-label": t("join.codeLabel", { code: String(wait.code || "").split("").join(" ") }) }, joinCodeText(wait.code)),
    h("p", { class: "field-help" }, t("join.waitingHelp", { time: wait.expires_at ? formatDateTime(new Date(wait.expires_at)) : "" })),
    message,
    h(
      "button",
      { type: "button", class: "button button-secondary button-wide", dataset: { key: "join-withdraw" }, disabled: Boolean(ui.joinBusy), onclick: () => withdraw(invitation) },
      t("join.withdraw")
    ),
  ];
}

// "You joined Cohen Home as Dana.", once, over the screen after joining; dismissed with Done.
export function joinedNotice() {
  const joined = ui.joined;
  if (!joined) return null;
  return h(
    "section",
    { class: "card joined-notice", role: "status", dataset: { key: "joined" } },
    h("p", { class: "notice notice-success", dir: "auto" }, joined.home ? t("join.joined", { home: joined.home, name: joined.user }) : t("join.joinedNoHome", { name: joined.user })),
    h(
      "div",
      { class: "button-row" },
      h(
        "button",
        {
          type: "button",
          class: "button button-quiet button-small",
          dataset: { key: "joined-done" },
          onclick: () => {
            ui.joined = null;
            notify();
          },
        },
        t("common.done")
      )
    )
  );
}

// On iPhone and iPad, in a browser: join in the Home Screen app instead (1.12.0, ADR-083).
function homeScreenAdvice(invitation) {
  const link = invitationLink(invitation.home, { id: invitation.invitation, secret: invitation.secret });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      ui.joinCopied = "copied";
    } catch {
      ui.joinCopied = "failed";
    }
    notify();
  };
  return h(
    "div",
    { class: "join-home-screen", dataset: { key: "join-home-screen" } },
    h("h3", { class: "settings-subtitle" }, t("join.homeScreen.title")),
    h("p", { class: "connect-text" }, t("join.homeScreen.text")),
    homeScreenSteps("join"),
    ui.joinCopied === "failed"
      ? h("input", { class: "invitation-link", type: "text", readonly: true, dir: "ltr", value: link, "aria-label": t("settings.account.home.linkLabel"), onfocus: (event) => event.target.select() })
      : null,
    ui.joinCopied
      ? h("p", { class: `notice ${ui.joinCopied === "copied" ? "notice-success" : "notice-error"}`, role: "status" }, ui.joinCopied === "copied" ? t("join.homeScreen.copied") : t("settings.account.home.copyFailed"))
      : null,
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "button", class: "button button-primary button-wide", dataset: { key: "join-copy" }, onclick: copy }, icon("copy"), t("move.copy"))
    ),
    h(
      "div",
      { class: "button-row" },
      h(
        "button",
        {
          type: "button",
          class: "button button-quiet button-wide",
          dataset: { key: "join-here" },
          onclick: () => {
            ui.joinHere = true;
            notify();
          },
        },
        isSafari() ? t("join.homeScreen.here") : t("join.homeScreen.hereBrowser")
      )
    )
  );
}

export function joinView({ navigate }) {
  const invitation = storedInvitation();
  const account = state.account;
  const content = [];
  const waiting = invitation && ui.joinWait && ui.joinWait.for === invitationKey(invitation);
  if (!invitation) {
    content.push(h("p", { class: "connect-text" }, t("join.missing")));
  } else if (inIosBrowser() && !ui.joinHere && !waiting && !asked(invitationKey(invitation))) {
    // In Safari on iPhone or iPad: the Home Screen app first; here only when chosen.
    content.push(h("p", { class: "connect-text" }, t("join.intro")), homeScreenAdvice(invitation));
  } else if (account.status === "unknown" || account.status === "loading") {
    content.push(h("p", { class: "field-help", role: "status" }, t("common.loading")));
  } else if (account.status !== "signed-in") {
    content.push(
      h("p", { class: "connect-text" }, t("join.intro")),
      h("p", { class: "field-help" }, t("join.signInFirst")),
      // Opening an invitation is choosing to sign in: the sign-ins are asked for at once.
      signInButtons({ hash: "#/join", key: "join-sign-in", size: "button-wide", ask: true })
    );
  } else if (ui.joinWait && ui.joinWait.for === invitationKey(invitation)) {
    content.push(h("p", { class: "connect-signed-in" }, icon("user"), t("join.as", { email: account.user.email })), ...waitingContent(invitation, navigate));
  } else {
    // Reloaded while it waited: the request carries on.
    if (ui.joinChecked !== invitationKey(invitation) && asked(invitationKey(invitation))) {
      ui.joinChecked = invitationKey(invitation);
      followRequest(invitation, navigate);
    }
    content.push(
      h("p", { class: "connect-text" }, t("join.intro")),
      h("p", { class: "connect-signed-in" }, icon("user"), t("join.as", { email: account.user.email })),
      ui.joinMessage ? h("p", { class: "notice notice-error", role: "alert" }, ui.joinMessage) : null,
      h(
        "button",
        { type: "button", class: "button button-primary button-wide", dataset: { key: "join-accept" }, disabled: Boolean(ui.joinBusy), onclick: () => accept(invitation, navigate) },
        ui.joinBusy ? t("join.accepting") : t("join.accept")
      )
    );
  }
  return [
    pageHeader({ title: t("join.title") }),
    h(
      "div",
      { class: "connect" },
      h(
        "section",
        { class: "card connect-card", "aria-labelledby": "join-title" },
        h("span", { class: "connect-icon" }, icon("key")),
        h("h2", { id: "join-title", class: "connect-title" }, t("join.heading")),
        ...content
      )
    ),
  ];
}
