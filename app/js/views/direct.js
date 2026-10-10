// Settings → Controller → Direct connection at home (1.12.0, ADR-082; js/direct.js). The home's
// owner decides, never DirectorLink by itself: turned on, the controller gets a random name under
// dlhome.cc that points to its address on the home network, and a certificate for it, so every
// device, iPhones and iPads included, reaches it directly at home. Before it is on, the card says
// what that means (the name in public certificate logs; DirectorLink's servers learn the name and
// the address). The installer allows it first in Composer (Direct HTTPS → Allowed), and it needs
// Remote Access with the home linked. Other admins see how it is; members see nothing. While the
// controller gets its certificate the card asks it again every few seconds; once it serves the
// name, this device reads GET /v1/system again, so it goes that way (session.js).
//
// GET /v1/https (admins): { allowed, enabled, remote, name, port, state, certificate, error };
// PUT /v1/https { enabled } (the owner only): the same answer, or 403, 409 HTTPS_NOT_ALLOWED,
// 409 REMOTE_ACCESS_NEEDED.

import { h } from "../dom.js";
import { formatDate, t } from "../i18n.js";
import { icon } from "../icons.js";
import { api, errorText, keyGeneration, keyInUse, readSystem, whenForgotten } from "../session.js";
import { can, notify, state, ui } from "../state.js";

// While the controller gets its certificate it is asked how it goes this often, this many times
// (5 minutes).
export const POLL_MS = 3000;
const POLL_TIMES = 100;
// What the card shows is read again when it is drawn this long after.
const FRESH_MS = 60000;

let loading = null;
let polling = null;
whenForgotten(() => {
  loading = null;
  polling = null;
  ui.directHttps = null;
});

// ui.directHttps: { status (GET /v1/https), at, loading, failed (why it could not be read),
// missing (an older DirectorLink), busy (a change on its way), message }.
function section() {
  ui.directHttps ??= {};
  return ui.directHttps;
}

// The controller has Direct HTTPS (1.12.0): its GET /v1/system says `direct_https`, null or not.
export function directSupported() {
  return Boolean(state.system && typeof state.system === "object" && Object.hasOwn(state.system, "direct_https"));
}

// This device's user is the home's owner (1.8.0, ADR-054: `access.owner`).
function isOwner() {
  return state.access?.owner === true;
}

export function loadDirect() {
  // Nothing is asked while the key is being forgotten (Forget key, Pair again).
  if (!keyInUse()) return Promise.resolve();
  if (loading) return loading;
  const since = keyGeneration();
  section().loading = true;
  const read = (async () => {
    try {
      const status = await api("/v1/https");
      if (since !== keyGeneration()) return;
      Object.assign(section(), { status: status && typeof status === "object" ? status : null, failed: null, missing: false, at: Date.now() });
      if (status?.state === "requesting") watch();
    } catch (error) {
      if (since !== keyGeneration()) return;
      Object.assign(section(), { failed: errorText(error), missing: error?.status === 404 || error?.status === 405, at: Date.now() });
    } finally {
      if (loading === read) loading = null;
      if (since === keyGeneration()) {
        section().loading = false;
        notify();
      }
    }
  })();
  loading = read;
  return read;
}

// Asks the controller until it has its certificate (or gave up), then reads GET /v1/system again:
// this device then goes the new way.
function watch() {
  if (polling) return;
  const token = {};
  polling = token;
  let times = 0;
  const next = () =>
    window.setTimeout(async () => {
      if (polling !== token) return;
      if (!keyInUse()) {
        polling = null;
        return;
      }
      times += 1;
      await loadDirect();
      if (polling !== token) return;
      if (section().status?.state === "requesting" && times < POLL_TIMES) {
        next();
        return;
      }
      polling = null;
      if (section().status?.state === "listening") readSystem().catch(() => {});
    }, POLL_MS);
  next();
}

// Why the owner's change was refused, or did not get through.
function changeError(error) {
  if (error?.code === "HTTPS_NOT_ALLOWED") return t("directHttps.notAllowed");
  if (error?.code === "REMOTE_ACCESS_NEEDED") return t("directHttps.remoteNeeded");
  if (error?.status === 403) return t("directHttps.ownerOnly");
  return errorText(error);
}

async function setEnabled(enabled) {
  const current = section();
  if (current.busy || !keyInUse()) return;
  const since = keyGeneration();
  current.busy = true;
  current.message = null;
  notify();
  try {
    const status = await api("/v1/https", { method: "PUT", body: { enabled } });
    if (since !== keyGeneration()) return;
    Object.assign(section(), { status: status && typeof status === "object" ? status : section().status, failed: null, at: Date.now() });
    if (status?.state === "requesting") watch();
    // On or off: this device learns the name, or that it is gone, and goes the way there is now.
    else readSystem().catch(() => {});
  } catch (error) {
    if (since !== keyGeneration()) return;
    section().message = { kind: "error", text: changeError(error) };
    // Without an answer it may have changed anyway: how it is now.
    if (!error?.status) loadDirect();
  } finally {
    if (since === keyGeneration()) {
      section().busy = false;
      notify();
    }
  }
}

// How it is, in words: Off, Getting a certificate…, On until <date>, Didn't work: <why>, or (the
// installer did not allow it) Not allowed in Composer.
export function directStateText(status) {
  switch (status?.state) {
    case "not_allowed":
      return t("directHttps.state.notAllowed");
    case "requesting":
      return t("directHttps.state.requesting");
    case "listening": {
      const until = Date.parse(status.certificate?.not_after);
      return Number.isFinite(until) ? t("directHttps.state.listening", { date: formatDate(new Date(until)) }) : t("directHttps.state.on");
    }
    case "error":
      return typeof status.error === "string" && status.error ? t("directHttps.state.error", { error: status.error }) : t("directHttps.state.errorUnknown");
    default:
      return t("directHttps.state.off");
  }
}

function stateLine(status) {
  return h(
    "p",
    { class: "field-help", id: "direct-state", role: "status", dataset: { key: "direct-state" } },
    t("directHttps.stateLabel"),
    " ",
    h("span", { dir: "auto" }, directStateText(status))
  );
}

// The owner's switch. Off while it cannot be turned on (Composer, Remote Access) or a change is on
// its way, but focusable (aria-disabled), as Alerts' switch.
function ownerSwitch(on, off) {
  return h(
    "div",
    { class: "toggle-row" },
    h("span", { class: "toggle-text" }, h("span", { class: "toggle-title", id: "direct-switch-label" }, t("directHttps.label"))),
    h(
      "button",
      {
        type: "button",
        role: "switch",
        class: "switch",
        "aria-checked": String(on),
        "aria-labelledby": "direct-switch-label",
        "aria-describedby": "direct-state",
        "aria-busy": section().busy ? "true" : null,
        "aria-disabled": off ? "true" : null,
        dataset: { key: "direct-switch" },
        onclick: () => {
          if (!off) setEnabled(!on);
        },
      },
      h("span", { class: "switch-thumb" })
    )
  );
}

// What turning it on means, said before it is on.
function explanation() {
  return h(
    "div",
    { class: "direct-explanation", dataset: { key: "direct-explanation" } },
    h("p", { class: "field-help" }, t("directHttps.intro")),
    h("p", { class: "field-help" }, t("directHttps.how")),
    h("p", { class: "field-help" }, t("directHttps.chrome"))
  );
}

function remoteNotice() {
  return h(
    "p",
    { class: "notice notice-info", dataset: { key: "direct-remote" } },
    t("directHttps.remoteNeeded"),
    " ",
    h("a", { href: "#/settings/account", dataset: { key: "direct-account" } }, t("directHttps.remoteLink"))
  );
}

function body(current) {
  const status = current.status;
  if (!status) {
    if (current.failed) {
      return [
        h("p", { class: "notice notice-error", role: "alert", dataset: { key: "direct-failed" } }, current.failed),
        h("div", { class: "button-row" }, h("button", { type: "button", class: "button button-secondary", dataset: { key: "direct-retry" }, onclick: () => loadDirect() }, icon("refresh"), t("common.retry"))),
      ];
    }
    return h("p", { class: "field-help", role: "status" }, t("common.loading"));
  }
  const allowed = status.allowed === true && status.state !== "not_allowed";
  const enabled = status.enabled === true;
  const remote = status.remote === true;
  const message = current.message ? h("p", { class: `notice notice-${current.message.kind}`, role: "alert", dataset: { key: "direct-message" } }, current.message.text) : null;
  if (!isOwner()) {
    // Other admins: how it is, and who decides.
    return [
      stateLine(status),
      allowed ? null : h("p", { class: "notice notice-info", dataset: { key: "direct-composer" } }, t("directHttps.notAllowed")),
      h("p", { class: "field-help", dataset: { key: "direct-owner-only" } }, t("directHttps.ownerOnly")),
    ];
  }
  if (!allowed) {
    return [stateLine(status), h("p", { class: "notice notice-info", dataset: { key: "direct-composer" } }, t("directHttps.notAllowed")), message];
  }
  // Turning it on needs Remote Access and the home linked; once on, the switch still turns it off.
  const canTurnOn = remote;
  return [
    enabled ? null : explanation(),
    ownerSwitch(enabled, Boolean(current.busy) || (!enabled && !canTurnOn)),
    stateLine(status),
    remote ? null : remoteNotice(),
    message,
  ];
}

// The card, for admins, with a DirectorLink that has Direct HTTPS; null otherwise (members, older
// controllers, before connecting).
export function directCard() {
  if (!state.loaded || !can("admin") || !directSupported()) return null;
  const current = section();
  if (current.missing) return null;
  const stale = current.status && Date.now() - (current.at || 0) > FRESH_MS;
  if (!loading && !polling && !current.busy && ((!current.status && !current.failed) || stale)) loadDirect();
  return h(
    "section",
    { class: "card settings-card", id: "settings-direct", "aria-labelledby": "settings-direct-title" },
    h("h2", { class: "settings-title", id: "settings-direct-title" }, icon("home"), t("directHttps.title")),
    body(section())
  );
}
