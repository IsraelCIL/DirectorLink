// Move to the Home Screen app (1.12.0, ADR-083; docs/ACCOUNTS.md): a Safari tab on iPhone or iPad
// that already joined gives its place to the app added to the Home Screen, which has its own
// storage and gets alerts. Settings → Account makes a move invitation for this same user (10
// minutes, once); the person copies its link, opens DirectorLink from the Home Screen and pastes it
// in Join with an invitation. The controller revokes this tab's key when the Home Screen app first
// uses its new one, so the user keeps as many devices. This tab then says it moved
// (views/connect.js shows it once the key is gone).

import { h } from "../dom.js";
import { formatClock, t } from "../i18n.js";
import { icon } from "../icons.js";
import { inIosBrowser, saveMove, savedMove } from "../home-screen.js";
import { invitationLink, savedRemote } from "../remote.js";
import { api, errorText, handleUnauthorized } from "../session.js";
import { notify, state } from "../state.js";
import { makeInvitation } from "./device-join.js";

// While the link waits, this tab asks every few seconds whether its key still works.
const WATCH_MS = 5000;

const moving = { busy: false, link: null, expiresAt: null, message: null };
let watchTimer = null;
let watching = false;

// What the screen shows from here, for app.js's signature.
export function moveSignature() {
  return [moving, savedMove()?.keyId ?? null];
}

// The controller can (1.12.0) and this is a Safari tab of a device that reaches its home through
// the account.
export function moveOffered() {
  return inIosBrowser() && Boolean(state.apiKey) && Boolean(savedRemote()) && state.account.status === "signed-in" && state.system?.features?.user_names === true;
}

function say(kind, text) {
  moving.message = text ? { kind, text } : null;
  notify();
}

// Asks whether this tab's key still works; once it is revoked, the session forgets it, and the
// Connect screen says it moved.
async function check() {
  if (!state.apiKey || !savedMove()) return;
  try {
    await api("/v1/api-keys/current");
  } catch (error) {
    if (error?.status === 401 || error?.code === "UNKNOWN_KEY") await handleUnauthorized(error);
  }
}

function watchSoon(wait = WATCH_MS) {
  window.clearTimeout(watchTimer);
  watchTimer = window.setTimeout(async () => {
    watchTimer = null;
    if (!moving.link || !state.apiKey) return;
    if (!document.hidden) await check();
    if (moving.link && state.apiKey && Date.parse(moving.expiresAt) > Date.now()) watchSoon();
  }, wait);
}

function watch() {
  if (watching) return;
  watching = true;
  // Back from the Home Screen app: asked at once.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && moving.link) check();
  });
}

async function start() {
  if (moving.busy) return;
  moving.busy = true;
  say(null, null);
  try {
    const invitation = await makeInvitation({ forSelf: true, move: true, email: state.account.user.email, role: state.role || "member" });
    moving.link = invitationLink(invitation.home_id, invitation);
    moving.expiresAt = invitation.expires_at;
    saveMove({ home: invitation.home_id, keyId: savedRemote()?.keyId, invitation: invitation.id, until: invitation.expires_at });
    watch();
    watchSoon();
  } catch (error) {
    say("error", errorText(error));
  } finally {
    moving.busy = false;
    notify();
  }
}

async function cancel() {
  const saved = savedMove();
  moving.link = null;
  moving.expiresAt = null;
  saveMove(null);
  window.clearTimeout(watchTimer);
  if (saved?.invitation) api(`/v1/invitations/${saved.invitation}`, { method: "DELETE" }).catch(() => {});
  say("info", t("move.cancelled"));
}

async function copy() {
  try {
    await navigator.clipboard.writeText(moving.link);
    say("success", t("move.copied"));
  } catch {
    say("error", t("settings.account.home.copyFailed"));
  }
}

// The three steps, as the join page shows them too (views/join.js).
export function homeScreenSteps(prefix, { email } = {}) {
  return h(
    "ol",
    { class: "home-screen-steps", dataset: { key: `${prefix}-steps` } },
    h("li", {}, t("move.step1")),
    h("li", {}, t("move.step2")),
    h("li", {}, email ? t("move.step3", { email }) : t("move.step3NoEmail"))
  );
}

// Settings → Account, on a Safari tab that joined.
export function movePanel() {
  // A move whose link ran out while this tab kept its key: nothing moved.
  const saved = savedMove();
  if (saved && state.apiKey && !(Date.parse(saved.until) > Date.now())) {
    saveMove(null);
    moving.link = null;
  }
  // A link of another key's (this tab moved, and has a key again) is not this one's.
  if (moving.link && (!savedMove() || savedMove().keyId !== savedRemote()?.keyId)) {
    moving.link = null;
    moving.message = null;
  }
  if (!moveOffered()) return null;
  const message = moving.message ? h("p", { class: `notice notice-${moving.message.kind}`, role: moving.message.kind === "error" ? "alert" : "status" }, moving.message.text) : null;
  if (!moving.link || !(Date.parse(moving.expiresAt) > Date.now())) {
    return h(
      "div",
      { class: "move-home-screen", dataset: { key: "move" } },
      h("h3", { class: "settings-subtitle" }, t("move.title")),
      h("p", { class: "field-help" }, t("move.help")),
      message,
      h(
        "div",
        { class: "button-row" },
        h("button", { type: "button", class: "button button-secondary", dataset: { key: "move-start" }, disabled: moving.busy, onclick: start }, icon("download"), moving.busy ? t("move.making") : t("move.button"))
      )
    );
  }
  return h(
    "div",
    { class: "move-home-screen", dataset: { key: "move" }, "aria-live": "polite" },
    h("h3", { class: "settings-subtitle" }, t("move.title")),
    homeScreenSteps("move", { email: state.account.user?.email }),
    h("input", { class: "invitation-link", type: "text", readonly: true, dir: "ltr", value: moving.link, "aria-label": t("settings.account.home.linkLabel"), onfocus: (event) => event.target.select() }),
    message,
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "button", class: "button button-primary", dataset: { key: "move-copy" }, onclick: copy }, icon("copy"), t("move.copy")),
      h("button", { type: "button", class: "button button-quiet", dataset: { key: "move-cancel" }, onclick: cancel }, t("common.cancel"))
    ),
    h("p", { class: "field-help", role: "status" }, t("move.waiting")),
    h("p", { class: "field-help" }, t("move.lasts", { time: formatClock(new Date(moving.expiresAt)) }))
  );
}

// On the Connect screen of a tab whose key went while it moved: it moved.
export function movedNotice() {
  if (state.apiKey || !savedMove()) return null;
  return h("p", { class: "notice notice-success", role: "status", dataset: { key: "moved" } }, t("move.moved"));
}
