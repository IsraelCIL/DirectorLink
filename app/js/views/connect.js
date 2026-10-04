// First-time setup on Home: the controller address and the pairing code from Composer
// (DirectorLink → Actions → New Pairing Code). A code lasts 15 minutes and works once. Below it,
// signing in with Google (account.js), which will reach the home from anywhere (docs/ACCOUNTS.md);
// signed in, joining from another device of the account (ADR-053); and Paste invitation link.

import { formatPairingCode, normalizeHost } from "../../api-client.js";
import { IS_IOS } from "../platform.js";
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { pairWithCode } from "../session.js";
import { signInButtons } from "./common.js";
import { joinFromAnotherDevice, pasteInvitationPanel } from "./device-join.js";
import { addressChanged, findController } from "./find.js";
import { notify, state, ui } from "../state.js";

// `onInput` runs after the draft is kept.
function draftInput(key, fallback, props, onInput) {
  const input = h("input", { ...props, value: ui.drafts[key] ?? fallback, dataset: { key } });
  input.addEventListener("input", () => {
    ui.drafts[key] = input.value;
    onInput?.();
  });
  return input;
}

function notice() {
  if (!state.notice) return null;
  return h(
    "p",
    { class: `notice notice-${state.notice.kind}`, role: state.notice.kind === "error" ? "alert" : "status" },
    state.notice.text
  );
}

// The controller cannot pair without the code crossing the network (ADR-039): it runs DirectorLink
// before 1.3.0 ("older"), or its lock failed its self-test ("lock"). Nothing was sent. Only Pair
// anyway sends it, the old way, and only to the controller the warning is about.
function unprotectedWarning(code) {
  const warned = state.pairingUnprotected;
  if (!warned || warned.host !== normalizeHost(ui.drafts.host ?? state.host)) return null;
  return h(
    "div",
    { class: "notice notice-error connect-unprotected", role: "alert", id: "pairing-unprotected" },
    h("p", {}, t(`connect.unprotected.${warned.reason === "lock" ? "lock" : "older"}`)),
    h(
      "div",
      { class: "button-row" },
      h(
        "button",
        {
          type: "button",
          class: "button button-danger button-small",
          dataset: { key: "pair-anyway" },
          onclick: async () => {
            await pairWithCode(warned.host, code.value, { anyway: true });
            if (state.apiKey) ui.drafts.pairingCode = "";
          },
        },
        t("connect.unprotected.pairAnyway")
      ),
      h(
        "button",
        {
          type: "button",
          class: "button button-secondary button-small",
          dataset: { key: "pair-cancel" },
          onclick: () => {
            state.pairingUnprotected = null;
            notify();
          },
        },
        t("connect.unprotected.cancel")
      )
    )
  );
}

// Shows the code as "1234 5678" while it is typed or pasted (with or without the space or a
// dash), keeping the caret after the same digit.
export function formatCodeField(input) {
  const caretDigits = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, "").length;
  const formatted = formatPairingCode(input.value);
  if (formatted !== input.value) {
    input.value = formatted;
    const caret = Math.min(formatted.length, caretDigits > 4 ? caretDigits + 1 : caretDigits);
    try {
      input.setSelectionRange(caret, caret);
    } catch {
      // Not focused.
    }
  }
  return formatted;
}

// The account option under the pairing form: signed in, or a button to sign in with Google.
// On iPhone and iPad there is no form above it, so no "or".
function accountOption({ divider = true } = {}) {
  const account = state.account;
  if (account.status === "unknown" || account.status === "loading") {
    return null;
  }
  if (account.status === "signed-in") {
    return h(
      "div",
      { class: "connect-account" },
      h("p", { class: "connect-signed-in", id: "connect-account-email" }, icon("user"), t("connect.signedInAs", { email: account.user.email })),
      // On iPhone and iPad there is no pairing here: the iOS text above says what to do.
      IS_IOS ? null : h("p", { class: "field-help" }, t("connect.signedInHelp")),
      joinFromAnotherDevice()
    );
  }
  const outcome = account.notice && account.notice !== "deleted" && account.notice !== "deleteFailed" ? account.notice : null;
  return h(
    "div",
    { class: "connect-account" },
    divider ? h("p", { class: "connect-or" }, h("span", {}, t("connect.or"))) : null,
    outcome ? h("p", { class: "notice notice-error", role: "status" }, t(`settings.account.notice.${outcome}`)) : null,
    signInButtons({ hash: "#/", key: "connect-sign-in", style: "button-secondary", size: "button-wide" }),
    h("p", { class: "field-help" }, t("connect.signInHelp"))
  );
}

// On iPhone and iPad pairing over the home network can only fail (platform.js).

function iosCard() {
  return h(
    "div",
    { class: "connect" },
    h(
      "section",
      { class: "card connect-card", "aria-labelledby": "connect-title" },
      h("span", { class: "connect-icon" }, icon("key")),
      h("h2", { id: "connect-title", class: "connect-title" }, t("connect.title")),
      h("p", { class: "notice notice-info", id: "connect-ios" }, t("connect.iosText")),
      h("p", { class: "connect-text" }, t("connect.iosHow")),
      accountOption({ divider: false }),
      pasteInvitationPanel({ key: "connect" })
    )
  );
}

export function connectScreen() {
  if (IS_IOS) {
    return iosCard();
  }
  const host = draftInput(
    "host",
    state.host,
    {
      id: "controller-host",
      type: "text",
      inputmode: "url",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      dir: "ltr",
      placeholder: "192.168.1.50",
      "aria-describedby": "controller-host-help",
      required: true,
    },
    () => addressChanged(host.value)
  );
  const code = draftInput("pairingCode", "", {
    id: "pairing-code",
    class: "code-input",
    type: "text",
    inputmode: "numeric",
    autocomplete: "one-time-code",
    autocapitalize: "off",
    spellcheck: "false",
    dir: "ltr",
    placeholder: "1234 5678",
    "aria-describedby": "pairing-code-help",
    required: true,
  });
  code.addEventListener("input", () => {
    ui.drafts.pairingCode = formatCodeField(code);
  });
  const busy = state.status === "connecting";

  const form = h(
    "form",
    {
      class: "connect-form",
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        await pairWithCode(host.value, code.value);
        // A code works once: once it bought a key, it is of no use in the field.
        if (state.apiKey) ui.drafts.pairingCode = "";
      },
    },
    h("label", { class: "field-label", for: "controller-host" }, t("connect.hostLabel")),
    host,
    h("p", { id: "controller-host-help", class: "field-help" }, t("connect.hostHelp")),
    findController({ busy }),
    h("label", { class: "field-label", for: "pairing-code" }, t("connect.codeLabel")),
    code,
    h("p", { id: "pairing-code-help", class: "field-help" }, t("connect.codeHelp")),
    notice(),
    unprotectedWarning(code),
    h(
      "button",
      { type: "submit", class: "button button-primary button-wide", disabled: busy, dataset: { key: "pair" } },
      busy ? t("status.connecting") : t("connect.pair")
    )
  );

  return h(
    "div",
    { class: "connect" },
    h(
      "section",
      { class: "card connect-card", "aria-labelledby": "connect-title" },
      h("span", { class: "connect-icon" }, icon("key")),
      h("h2", { id: "connect-title", class: "connect-title" }, t("connect.title")),
      h("p", { class: "connect-text" }, t("connect.intro")),
      form,
      accountOption(),
      pasteInvitationPanel({ key: "connect" })
    ),
    h("p", { class: "connect-footnote" }, t("connect.lanNote"))
  );
}
