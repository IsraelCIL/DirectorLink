// "Remove a device first" (DirectorLink 1.9.0, ADR-061): a user has at most five devices, and every
// way of adding one (Add my other device, approving a device that asks to join, a pairing code for
// a user, moving a device, bringing an account's devices together) is refused with
// 409 USER_DEVICE_LIMIT. For a caller who sees that user the problem lists their devices, with when
// each was last used and whether the caller may remove it: this panel shows that list, with
// Remove where the controller says the caller may.

import { h } from "../dom.js";
import { formatDate, formatRelative, t } from "../i18n.js";

// The problem of a refusal for a user who has five devices, or null.
export function deviceLimitOf(error) {
  return error?.code === "USER_DEVICE_LIMIT" && error.problem && typeof error.problem === "object" ? error.problem : null;
}

// A device not used for this long is worth a look (1.12.0, ADR-083): "Not used since 3 Aug", or
// "Never used" when it never was and was added that long ago, next to its Remove.
const STALE_MS = 30 * 24 * 3600 * 1000;

// "since" (last used more than 30 days ago), "never" (never used, added more than 30 days ago), or
// null.
export function staleDevice(device, now = Date.now()) {
  const used = Date.parse(device?.last_used_at || "");
  if (Number.isFinite(used)) return now - used > STALE_MS ? "since" : null;
  const made = Date.parse(device?.created_at || "");
  return Number.isFinite(made) && now - made > STALE_MS ? "never" : null;
}

// When a device was last used, as Settings → Users and this list say it.
export function lastUsed(device, now = Date.now()) {
  switch (staleDevice(device, now)) {
    case "since":
      return t("users.device.notUsedSince", { date: formatDate(new Date(device.last_used_at)) });
    case "never":
      return t("users.device.neverUsed");
    default:
      return device.last_used_at ? t("access.lastUsed", { time: formatRelative(device.last_used_at, now) }) : t("access.neverUsed");
  }
}

// `problem`: the refusal's body. `remove(device)`: removes a device (DELETE /v1/api-keys/{id});
// `busy`: while something is being done. `key`: keeps its data-keys apart from another panel's.
export function deviceLimitPanel(problem, { remove, busy = false, key = "limit", dismiss } = {}) {
  if (!problem) return null;
  const name = problem.user?.name || "";
  const limit = Number(problem.limit) || 5;
  const devices = Array.isArray(problem.devices) ? problem.devices : null;
  return h(
    "div",
    { class: "notice notice-error device-limit", role: "alert", dataset: { key } },
    h("p", { class: "device-limit-title" }, name ? t("users.limit.title", { name, count: limit }) : t("users.limit.titleNoName", { count: limit })),
    devices
      ? h(
          "ul",
          { class: "access-list device-limit-list" },
          devices.map((device) =>
            h(
              "li",
              { class: "access-item", dataset: { key: `${key}-device-${device.id}` } },
              h(
                "div",
                { class: "access-main" },
                h("span", { class: "access-name", dir: "auto" }, device.name, device.current ? h("span", { class: "access-badge" }, t("access.thisDevice")) : null),
                h("span", { class: `access-sub${staleDevice(device) ? " access-stale" : ""}` }, lastUsed(device))
              ),
              device.removable && remove
                ? h(
                    "div",
                    { class: "access-actions" },
                    h(
                      "button",
                      { type: "button", class: "button button-small button-danger", disabled: busy, "aria-label": t("users.removeDeviceFor", { name: device.name }), dataset: { key: `${key}-remove-${device.id}` }, onclick: () => remove(device) },
                      t("users.removeDevice")
                    )
                  )
                : null
            )
          )
        )
      : h("p", { class: "field-help" }, t("users.limit.askOnDevice")),
    devices && !devices.some((device) => device.removable) ? h("p", { class: "field-help" }, t("users.limit.askAdmin")) : null,
    dismiss ? h("div", { class: "button-row" }, h("button", { type: "button", class: "button button-quiet", dataset: { key: `${key}-dismiss` }, onclick: dismiss }, t("common.done"))) : null
  );
}
