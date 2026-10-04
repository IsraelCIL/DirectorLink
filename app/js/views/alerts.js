// Settings → Controller: "Alerts on this device" (ADR-047, ADR-050, js/alerts.js), for anyone signed
// in to an account with DirectorLink 1.7.0 on the controller (admins only before), on a device linked
// to the home. Once on, a switch per kind this key may get: the controller says which (its role, and
// what the home has); admins also choose the servers' offline alert. On iPhone and iPad they work
// only in the app added to the Home Screen (iOS 16.4 or later): the card says so there.

import { ALERT_KINDS, alertsAllowed, alertsOn, alertsSupport, alertsUi, chooseAlert, controllerChooses, offlineAlertsOn, turnAlertsOff, turnAlertsOn } from "../alerts.js";
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { savedRemote } from "../remote.js";
import { can } from "../state.js";

// Why the switch cannot be used on this device, or null.
function obstacle(support, linked) {
  if (!linked) return t("alerts.settings.notLinked");
  switch (support) {
    case "homeScreen":
      return t("alerts.settings.homeScreen");
    case "iosVersion":
      return t("alerts.settings.iosVersion");
    case "denied":
      return t("alerts.settings.blocked");
    case "unsupported":
      return t("alerts.settings.unsupported");
    default:
      return null;
  }
}

// One kind's switch; busy while its change is saved.
function kindRow(kind, on) {
  const busy = alertsUi.saving === kind;
  const label = `alerts-kind-${kind}`;
  return h(
    "div",
    { class: "toggle-row alerts-toggle" },
    h("span", { class: "toggle-text" }, h("span", { id: label }, t(`alerts.settings.kinds.${kind}`))),
    h(
      "button",
      {
        type: "button",
        role: "switch",
        class: "switch",
        "aria-checked": String(on),
        "aria-labelledby": label,
        "aria-busy": busy ? "true" : null,
        "aria-disabled": alertsUi.saving ? "true" : null,
        dataset: { key: `alerts-kind:${kind}` },
        onclick: () => {
          if (!alertsUi.saving) chooseAlert(kind, !on);
        },
      },
      h("span", { class: "switch-thumb" })
    )
  );
}

// The kinds this device may choose: the offline alert for admins, then the controller's.
function kindsList() {
  const rows = [];
  if (can("admin")) rows.push(kindRow("offline", offlineAlertsOn()));
  const kinds = alertsUi.choices?.kinds || {};
  for (const kind of ALERT_KINDS) {
    if (typeof kinds[kind] === "boolean") rows.push(kindRow(kind, kinds[kind]));
  }
  if (!rows.length) return null;
  return h(
    "div",
    { class: "alerts-kinds", role: "group", "aria-labelledby": "alerts-kinds-title", dataset: { key: "alerts-kinds" } },
    h("h3", { class: "settings-subtitle", id: "alerts-kinds-title" }, t("alerts.settings.kindsTitle")),
    rows
  );
}

export function alertsPanel() {
  if (!alertsAllowed()) return null;
  const support = alertsSupport();
  const linked = Boolean(savedRemote());
  const on = alertsOn();
  const chooses = controllerChooses();
  const hint = obstacle(support, linked);
  // What the last tap led to, unless the hint already says it (the permission refused: blocked).
  const message = alertsUi.message ? t(`alerts.settings.${alertsUi.message.key}`) : null;
  // Off while it cannot be used or is busy, but focusable (aria-disabled): the keyboard stays on
  // it while it works, and its new state, or why it is off, is read on it.
  const off = Boolean(hint) || alertsUi.busy;
  return h(
    "section",
    { class: "card settings-card", id: "settings-alerts", "aria-labelledby": "settings-alerts-title" },
    h("h2", { class: "settings-title", id: "settings-alerts-title" }, icon("bell"), t("alerts.settings.title")),
    h(
      "div",
      { class: "toggle-row alerts-toggle" },
      h(
        "span",
        { class: "toggle-text" },
        h("span", { class: "toggle-title", id: "alerts-switch-label" }, t("alerts.settings.label")),
        h("span", { class: "field-help", id: "alerts-switch-help" }, t(chooses ? "alerts.settings.help" : "alerts.settings.helpAdmins"))
      ),
      h(
        "button",
        {
          type: "button",
          role: "switch",
          class: "switch",
          "aria-checked": String(on),
          "aria-labelledby": "alerts-switch-label",
          "aria-describedby": hint ? "alerts-switch-help alerts-hint" : "alerts-switch-help",
          "aria-busy": alertsUi.busy ? "true" : null,
          "aria-disabled": off ? "true" : null,
          dataset: { key: "alerts-switch" },
          onclick: () => {
            if (off) return;
            if (on) turnAlertsOff();
            else turnAlertsOn();
          },
        },
        h("span", { class: "switch-thumb" })
      )
    ),
    hint ? h("p", { class: "notice notice-info", id: "alerts-hint", role: message === hint ? "status" : null, dataset: { key: "alerts-hint" } }, hint) : null,
    message && message !== hint ? h("p", { class: `notice notice-${alertsUi.message.kind}`, role: "status", dataset: { key: "alerts-message" } }, message) : null,
    on && chooses && !hint ? kindsList() : null
  );
}
