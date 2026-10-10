// History (#/settings/history, admins; ADR-046): what the controller did and noticed, newest first
// and by day: scenes and schedules run or skipped and why, doors and gates opened, keys and
// invitations, changes made in Composer, backups and driver updates. The controller keeps it (the
// newest 500 entries, 30 days at most; GET /v1/activity); this reads it a page at a time, with
// chips for the kinds, and the newest again every 30 s while it is open. Settings → Controller
// links to it, and so do the app's alert notifications.

import { announce, h, name } from "../dom.js";
import { currentLanguage, formatClock, formatDate, t } from "../i18n.js";
import { icon } from "../icons.js";
import { roomName } from "../model.js";
import { formatOffset, homeZone, whenText } from "../schedules.js";
import { api, errorText, noteForbidden, roleLabel } from "../session.js";
import { can, notify, state, ui } from "../state.js";
import { notReadyState, offlineBanner, pageHeader } from "./common.js";

export const HISTORY_HASH = "#/settings/history";
// The link on Settings → Controller; app.js focuses it when Back leads there from History.
export const HISTORY_ROW_KEY = "settings-history";
const PAGE = 50;
const REFRESH_MS = 30000;

// The chips, and the kinds of entries each one shows (null: all).
export const FILTERS = {
  all: null,
  automation: "scene,schedule",
  doors: "door",
  composer: "composer",
  access: "access",
};

const ICONS = { scene: "scene", door: "door", composer: "controller", access: "key" };
// A refrigerator door left open (1.7.0) is a door entry with the refrigerator's icon.
// An ask-to-open link's question (1.8.0) is a door entry with a bell; its links are access entries.
const ACTION_ICONS = { left_open: "fridge", asked: "bell", ask_link_created: "link", ask_link_replaced: "link", ask_link_removed: "link" };
const SYSTEM_ICONS = { backup: "archive", cloud_backup: "archive", restore: "archive", remote_away: "cloudOff", remote_update_required: "cloudOff", driver_updated: "download", driver_started: "refresh", driver_added: "plus" };

let generation = 0;
let refreshTimer = null;
let refreshing = false;
// The entry to give the keyboard to once drawn (after the last Load more).
let focusLanding = null;

// Admins only. Before this key's role is known (not connected yet) the page says why it waits.
export function historyAllowed() {
  return !state.role || can("admin");
}

// Entering the page: the newest entries, all kinds.
export function resetHistory() {
  generation += 1;
  ui.history = null;
  focusLanding = null;
  window.clearTimeout(refreshTimer);
  refreshTimer = null;
  // The live region screen readers hear the list's size from is in the page before it speaks.
  announce("");
}

function query(filter, before) {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (FILTERS[filter]) params.set("kind", FILTERS[filter]);
  if (before) params.set("before", String(before));
  return `/v1/activity?${params}`;
}

function failure(error) {
  // Made a member on another device: the role changes here at once (Settings drops the link).
  noteForbidden(error);
  // A DirectorLink before 1.6.0 keeps no history.
  return error?.status === 404 || error?.status === 405 ? { unsupported: true } : { error: errorText(error) };
}

// The first page for `filter`, instead of what was shown.
export async function loadHistory(filter = ui.history?.filter || "all") {
  const mine = ++generation;
  ui.history = { filter, items: ui.history?.filter === filter ? ui.history.items : [], next: null, busy: true, at: ui.history?.at || 0 };
  notify();
  let page;
  try {
    page = await api(query(filter));
  } catch (error) {
    if (mine !== generation) return;
    ui.history = { ...ui.history, ...failure(error), busy: false, at: Date.now() };
    notify();
    return;
  }
  if (mine !== generation) return;
  ui.history = { filter, items: Array.isArray(page?.items) ? page.items : [], next: page?.next_before ?? null, busy: false, at: Date.now() };
  notify();
  // The list is drawn anew: screen readers hear how much it shows.
  announce(shownText(ui.history));
}

function shownText(history) {
  if (!history.items.length) return t(history.filter === "all" ? "history.empty" : "history.emptyFiltered");
  return [t("history.shown", { count: history.items.length }), history.next ? "" : t("history.end")].filter(Boolean).join(" ");
}

// The next page, after the entries shown. Load more stays where it is (and keeps the keyboard)
// while it loads; when the last page came and it goes, the keyboard goes to the first entry that
// page brought.
export async function loadMore() {
  const current = ui.history;
  if (!current || current.busy || !current.next) return;
  const mine = generation;
  const focused = document.activeElement?.dataset?.key === "history-more";
  ui.history = { ...current, busy: true, moreError: null };
  notify();
  try {
    const page = await api(query(current.filter, current.next));
    if (mine !== generation) return;
    const known = new Set(current.items.map((item) => item.id));
    const items = [...current.items, ...(page?.items || []).filter((item) => !known.has(item.id))];
    const next = page?.next_before ?? null;
    const landing = focused && !next ? (items[current.items.length]?.id ?? null) : null;
    ui.history = { ...ui.history, items, next, busy: false, landing };
    focusLanding = landing;
    announce(shownText(ui.history));
  } catch (error) {
    if (mine !== generation) return;
    noteForbidden(error);
    ui.history = { ...ui.history, busy: false, moreError: errorText(error) };
  }
  notify();
}

// Every 30 s while open: what came since goes on top; the pages loaded stay.
async function refresh() {
  const current = ui.history;
  if (refreshing || !current || current.busy || current.error || current.unsupported) return;
  refreshing = true;
  const mine = generation;
  try {
    const page = await api(query(current.filter));
    if (mine !== generation || ui.history !== current) return;
    const newest = current.items[0]?.id || 0;
    const newer = (page?.items || []).filter((item) => item.id > newest);
    // More came than a page holds: start again from the newest.
    const whole = newer.length === (page?.items || []).length && page?.next_before;
    ui.history = whole
      ? { ...current, items: page.items, next: page.next_before, at: Date.now() }
      : { ...current, items: [...newer, ...current.items], at: Date.now() };
  } catch {
    // Kept as it was; the next one tries again.
    if (ui.history === current) ui.history = { ...current, at: Date.now() };
  } finally {
    refreshing = false;
  }
  notify();
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    if (!window.location.hash.startsWith(HISTORY_HASH)) return;
    if (document.hidden) scheduleRefresh();
    else refresh();
  }, REFRESH_MS);
}

// ---- words ------------------------------------------------------------------------------------

// A translation with a name from Control4 (or a person's) in it, kept apart: `dir="auto"`, so a
// Hebrew name reads right inside English and the other way round.
function withName(key, value, params = {}) {
  const marker = "\u0000";
  const text = t(key, { ...params, name: marker });
  const [before, after = ""] = text.split(marker);
  return [before, name(value || t("history.unnamed")), after];
}

// A name from Control4 (or a person's) inside a sentence, isolated (first-strong): "Gate Intercom"
// stays in one piece inside Hebrew, and a Hebrew name inside English.
const isolate = (text) => `\u2068${text ?? ""}\u2069`;

// Who did it, in the app's language, with the person's and the device's names isolated.
function who(entry) {
  const by = entry.who || {};
  if (by.type === "schedule") {
    const when = by.trigger ? whenText({ trigger: by.trigger, days: Array.isArray(by.days) ? by.days : [] }) : "";
    return when ? t("history.who.schedule", { when }) : t("history.who.scheduleGone");
  }
  if (by.type === "composer") return t("history.who.composer");
  // A door or gate opened without DirectorLink (1.7.0, ADR-050).
  if (by.type === "control4") return t("history.who.control4");
  // A scene's link, from a phone's automation (1.7.0, ADR-051), by the label an admin gave it.
  // A door's ask-before-opening link (1.8.0, ADR-058) asks, a scene's runs.
  if (by.type === "link") return by.name ? t("history.who.link", { name: isolate(by.name) }) : t(entry.kind === "door" ? "history.who.askLinkUnnamed" : "history.who.linkUnnamed");
  if (by.type !== "key") return t("history.who.controller");
  const device = by.name ? isolate(by.name) : t("history.who.unknownDevice");
  const text = by.profile && by.profile !== by.name ? t("history.who.person", { person: isolate(by.profile), device }) : device;
  return by.remote ? t("history.who.away", { who: text }) : text;
}

// A device and where it is: its room as the app names it now, else as the controller named it
// then; each isolated, in a sentence of the app's language.
function placed(entry, nameText) {
  const room = entry.ids?.room_id ? roomName({ id: entry.ids.room_id, name: entry.room }) : entry.room;
  return room ? t("history.inRoom", { name: isolate(nameText), room: isolate(room) }) : isolate(nameText);
}

function changeText(change) {
  const room = change.type === "room";
  const named = change.room && !room ? t("history.inRoom", { name: isolate(change.name), room: isolate(change.room) }) : isolate(change.name);
  switch (change.change) {
    case "removed":
      return t(room ? "history.change.roomRemoved" : "history.change.removed", { name: named });
    case "added":
      return t(room ? "history.change.roomAdded" : "history.change.added", { name: named });
    case "renamed":
      return t(room ? "history.change.roomRenamed" : "history.change.renamed", { from: isolate(change.from), name: isolate(change.name) });
    case "moved":
      return t("history.change.moved", { name: isolate(change.name), from: isolate(change.from || t("rooms.noRoom")), room: isolate(change.room || t("rooms.noRoom")) });
    default:
      return change.name || "";
  }
}

function date(iso) {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "" : formatDate(parsed);
}

// What happened, as the first line says it.
function title(entry) {
  const what = entry.what;
  switch (`${entry.kind}.${entry.action}`) {
    case "scene.run":
      return withName("history.scene.run", what);
    case "scene.off":
      return t(`history.scene.off.${["lights", "climate", "blinds"].includes(entry.note) ? entry.note : "lights"}`);
    case "schedule.run":
      return withName(`history.schedule.${entry.outcome === "skipped" ? "skipped" : entry.outcome === "failed" ? "failed" : "ran"}`, what || t("history.sceneGone"));
    case "door.pulse":
    case "door.hold":
    case "door.release":
    case "door.doorbell":
    case "door.left_open":
    case "door.asked":
      return t(`history.door.${entry.action}`, { name: placed(entry, what || t("history.unnamed")) });
    case "access.paired":
    case "access.created":
    case "access.joined":
      return withName(`history.access.${entry.action}`, what, { role: roleLabel(entry.to) });
    case "access.role_changed":
      return withName("history.access.role_changed", what, { from: roleLabel(entry.from), to: roleLabel(entry.to) });
    case "access.revoked":
    case "access.forgotten":
    case "access.expired":
    // A member's access changed, a room hidden from or shown to members (1.8.0, ADR-054).
    case "access.permissions_changed":
    case "access.room_hidden":
    case "access.room_shown":
      return withName(`history.access.${entry.action}`, what);
    case "access.all_revoked":
      return t("history.access.all_revoked", { count: entry.count ?? 0 });
    case "access.link_created":
    case "access.link_replaced":
    case "access.link_removed":
      return withName(`history.access.${entry.action}`, what || t("history.sceneGone"));
    case "access.ask_link_created":
    case "access.ask_link_replaced":
    case "access.ask_link_removed":
      return t(`history.access.${entry.action}`, { name: placed(entry, what || t("history.unnamed")) });
    case "access.links_removed":
      return entry.outcome === "failed" ? t("history.access.links_not_removed") : t("history.access.links_removed", { count: entry.count ?? 0 });
    // Users and their devices (1.9.0, ADR-061).
    case "access.pairing_code":
    case "access.merge_suggested":
      return withName(`history.access.${entry.action}`, what);
    case "access.users_merged":
      // Always an admin's (or the owner's) confirmation: nothing is merged by itself.
      return withName("history.access.users_merged", what, { from: entry.from || "", count: entry.count ?? 1 });
    // The owner made another admin the owner (1.9.0, ADR-064).
    case "access.owner_changed":
      return withName("history.access.owner_changed", what, { from: isolate(entry.from) });
    case "composer.project": {
      const changes = entry.changes || [];
      const count = changes.length + (entry.more || 0);
      return count === 1 ? changeText(changes[0]) : t("history.composer.project", { count });
    }
    case "composer.setting":
      return t("history.composer.setting", { setting: isolate(what), value: isolate(entry.to) });
    case "system.backup":
      return t("history.system.backup");
    case "system.cloud_backup":
      return t(entry.outcome === "failed" ? "history.system.cloudBackupFailed" : "history.system.cloudBackup");
    case "system.restore":
      return entry.from ? t("history.system.restoreFrom", { date: date(entry.from) }) : t("history.system.restore");
    case "system.remote_away":
      return t("history.system.remote_away", { duration: formatOffset(Math.max(1, Math.round((entry.seconds || 0) / 60))) });
    case "system.driver_updated":
      return entry.from && entry.from !== entry.to
        ? t("history.system.updatedFrom", { from: entry.from, to: entry.to || "" })
        : t("history.system.updated", { to: entry.to || "" });
    case "system.driver_started":
      return t("history.system.started");
    // 1.8.0 (ADR-059): the account service no longer takes this version for remote access.
    case "system.remote_update_required":
      return entry.to ? t("history.system.updateRequiredTo", { to: entry.to }) : t("history.system.updateRequired");
    case "system.driver_added":
      return t("history.system.added");
    default:
      return t("history.other");
  }
}

// Why a scene link went without an admin removing it (1.7.0), besides its scene's deletion; since
// 1.8.0 also no_access, its maker's person no longer an admin (ADR-054).
const LINK_REASONS = ["doors", "other_home", "new_identity", "key_gone", "keys_revoked"];

// Ask before opening (1.8.0): why nobody was asked, and why a link went by itself.
const ASK_REASONS = ["nobody", "doors_off", "not_sent"];
const ASK_LINK_REASONS = ["key_gone", "no_access", "door_gone", "other_home"];

// Why a backup to the account was not made (GET /v1/activity's reasons for cloud_backup).
const BACKUP_REASONS =["remote_off", "account_unreachable", "not_linked", "too_large", "limit", "account_full", "stopped"];

// How it went, in plain words: what ran, what was skipped and why, what failed. "" when there is
// nothing to add.
export function outcomeText(entry) {
  const counts = entry.counts;
  // Scene links (1.7.0): why one went without an admin removing it, and its label.
  if (entry.kind === "access" && /^links?_/.test(entry.action || "")) {
    const reason =
      entry.reason === "scene_gone"
        ? t("history.linkGone")
        : entry.reason === "no_access"
          ? t("history.reason.not_admin")
          : LINK_REASONS.includes(entry.reason)
            ? t(`history.reason.${entry.reason}`)
            : null;
    // Remove All Scene Links that the controller could not save: the links still work.
    const failed = entry.outcome === "failed" ? t("history.reason.not_saved") : null;
    return [failed, reason, entry.note ? t("history.linkLabel", { label: isolate(entry.note) }) : null].filter(Boolean).join(" · ");
  }
  // Ask before opening (1.8.0, ADR-058): asked on how many devices, or why nobody was.
  if (entry.kind === "door" && entry.action === "asked") {
    return ASK_REASONS.includes(entry.reason) ? t(`history.reason.${entry.reason}`) : t("history.counts.asked", { count: entry.count ?? 0 });
  }
  if (entry.kind === "access" && /^ask_link_/.test(entry.action || "")) {
    const reason = ASK_LINK_REASONS.includes(entry.reason) ? t(`history.reason.${entry.reason}`) : null;
    return [reason, entry.note ? t("history.linkLabel", { label: isolate(entry.note) }) : null].filter(Boolean).join(" · ");
  }
  if (entry.kind === "schedule" && entry.outcome === "skipped") {
    return t(`history.reason.${["shabbat", "paused", "calendar_off", "only_if", "no_weather"].includes(entry.reason) ? entry.reason : "other"}`);
  }
  if (entry.kind === "system" && entry.action === "cloud_backup" && entry.outcome === "failed") {
    // Back up now refused for today: the account still takes the nightly backup.
    const key = entry.reason === "limit" && entry.who?.type === "key" ? "limitNow" : BACKUP_REASONS.includes(entry.reason) ? entry.reason : "backupError";
    const reason = t(`history.reason.${key}`);
    // Only a night's backup that is tried again that night says so.
    return entry.note === "retry" ? `${reason} · ${t("history.note.retry")}` : reason;
  }
  if (entry.outcome === "failed" && !counts?.failed) {
    return t(entry.reason === "scene_gone" ? "history.reason.scene_gone" : "history.reason.error");
  }
  const parts = [];
  if (counts) {
    const total = (counts.ran || 0) + (counts.skipped || 0) + (counts.failed || 0);
    // Switches a level for a room or the whole home left as they are, as meant: said apart from
    // the skipped (ADR-077, 2026-10-09).
    const switches = counts.on_off_only || 0;
    const skipped = (counts.skipped || 0) - switches;
    if (counts.failed) parts.push(t("history.counts.failed", { count: counts.failed, total }));
    else if (counts.ran) parts.push(t("history.counts.ran", { count: counts.ran }));
    if (skipped > 0) parts.push(t("history.counts.skipped", { count: skipped }));
    // ACs a scene left off, their last mode not known yet (1.10.0, ADR-070).
    if (counts.no_last_mode) parts.push(t("history.counts.noLastMode", { count: counts.no_last_mode }));
    if (switches > 0) parts.push(t("history.counts.switchesLeft", { count: switches }));
    if (!total) parts.push(t("history.counts.none"));
  }
  if (entry.kind === "schedule" && entry.note === "late") parts.push(t("history.note.late"));
  if (entry.kind === "schedule" && entry.note === "no_weather") parts.push(t("history.note.noWeather"));
  if (entry.via) parts.push(t("history.via", { scene: isolate(entry.via) }));
  // A door opened in answer to an ask-to-open link (1.8.0).
  if (entry.kind === "door" && entry.ids?.link_id) parts.push(entry.note ? t("history.answered", { label: isolate(entry.note) }) : t("history.answeredUnnamed"));
  // Opened from a doorbell's ring screen or banner (1.11.0, ADR-078).
  else if (entry.kind === "door" && entry.ids?.doorbell_id && entry.note) parts.push(t("history.fromDoorbell", { name: isolate(entry.note) }));
  return parts.join(" · ");
}

function iconOf(entry) {
  if (entry.kind === "schedule") {
    const trigger = entry.who?.trigger || {};
    if (trigger.type === "sun") return "sun";
    if (trigger.type === "shabbat") return "candles";
    if (trigger.type === "weather") return { heat: "climate", wind: "wind", rain: "rain" }[trigger.kind] || "clock";
    return "clock";
  }
  if (entry.kind === "system") return SYSTEM_ICONS[entry.action] || "info";
  return ACTION_ICONS[entry.action] || ICONS[entry.kind] || "info";
}

// ---- the page ----------------------------------------------------------------------------------

// The day an entry belongs to, in the home's time zone: "2026-10-03".
function dayKey(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

function dayTitle(date, key, now, timeZone) {
  if (key === dayKey(now, timeZone)) return t("history.today");
  if (key === dayKey(new Date(now.getTime() - 86400000), timeZone)) return t("history.yesterday");
  const options = { weekday: "long", day: "numeric", month: "long", timeZone };
  try {
    return new Intl.DateTimeFormat(currentLanguage(), options).format(date);
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat(currentLanguage(), options).format(date);
  }
}

// The entries, a section a day, newest first.
export function groupByDay(items, now = new Date()) {
  const timeZone = homeZone();
  const days = [];
  for (const item of items) {
    const at = new Date(item.at);
    if (Number.isNaN(at.getTime())) continue;
    const key = dayKey(at, timeZone);
    let day = days.at(-1);
    if (!day || day.key !== key) {
      day = { key, title: dayTitle(at, key, now, timeZone), items: [] };
      days.push(day);
    }
    day.items.push(item);
  }
  return days;
}

// `landing`: the entry the keyboard went to after the last Load more (it can take the focus).
function entryRow(entry, landing) {
  const outcome = outcomeText(entry);
  const at = new Date(entry.at);
  const changes = entry.kind === "composer" && entry.action === "project" && (entry.changes || []).length + (entry.more || 0) > 1 ? entry.changes : null;
  const tone = entry.outcome === "failed" ? "failed" : entry.outcome === "skipped" ? "skipped" : "ok";
  return h(
    "li",
    { class: `history-item is-${tone}`, tabindex: entry.id === landing ? "-1" : null, dataset: { key: `history-${entry.id}` } },
    h("span", { class: `history-icon history-icon-${entry.kind}`, "aria-hidden": "true" }, icon(iconOf(entry))),
    h(
      "div",
      { class: "history-main" },
      h(
        "p",
        { class: "history-line" },
        h("span", { class: "history-title" }, title(entry)),
        h("span", { class: "visually-hidden" }, ", "),
        h("span", { class: "history-who" }, who(entry))
      ),
      outcome ? h("p", { class: `history-outcome is-${tone}` }, tone === "ok" ? null : icon(tone === "failed" ? "close" : "minus"), h("span", {}, outcome)) : null,
      changes
        ? h(
            "ul",
            { class: "history-changes" },
            changes.map((change) => h("li", { dir: "auto" }, changeText(change))),
            entry.more ? h("li", {}, t("history.composer.more", { count: entry.more })) : null
          )
        : null
    ),
    h("time", { class: "history-time", datetime: entry.at }, formatClock(at, homeZone()))
  );
}

function filterChips(current) {
  return h(
    "div",
    { class: "history-filters", role: "group", "aria-label": t("history.filters.label") },
    Object.keys(FILTERS).map((filter) =>
      h(
        "button",
        {
          type: "button",
          class: `chip ${filter === current ? "is-active" : ""}`.trim(),
          "aria-pressed": String(filter === current),
          dataset: { key: `history-filter:${filter}` },
          onclick: () => {
            if (filter !== current) loadHistory(filter);
          },
        },
        t(`history.filters.${filter}`)
      )
    )
  );
}

// The link on Settings → Controller (admins).
export function historyRow() {
  if (!state.loaded || !can("admin")) return null;
  return h(
    "nav",
    { class: "history-link", id: "settings-history", "aria-label": t("history.title") },
    h(
      "ul",
      { class: "card settings-rows" },
      h(
        "li",
        {},
        h(
          "a",
          { class: "settings-row", href: HISTORY_HASH, dataset: { key: HISTORY_ROW_KEY } },
          h("span", { class: "settings-row-icon", "aria-hidden": "true" }, icon("history")),
          h("span", { class: "settings-row-text" }, h("span", { class: "settings-row-title" }, t("history.title")), h("span", { class: "settings-row-status" }, t("history.rowStatus"))),
          icon("chevronForward", "settings-row-chevron")
        )
      )
    )
  );
}

export function historyView() {
  const header = pageHeader({ title: t("history.title"), back: "#/settings/controller" });
  if (!state.loaded) {
    return [header, notReadyState() || h("div", { class: "history" }, h("p", { class: "field-help", role: "status" }, t("common.loading")))];
  }
  const current = ui.history;
  if (!current) {
    loadHistory("all");
  } else if (!current.busy && Date.now() - current.at > REFRESH_MS) {
    refresh();
  }
  scheduleRefresh();
  const history = ui.history || { filter: "all", items: [], busy: true };
  if (history.unsupported) {
    return [header, offlineBanner(), h("div", { class: "history" }, h("p", { class: "notice notice-info" }, t("history.updateDriver")))];
  }
  const days = groupByDay(history.items || []);
  if (focusLanding != null) {
    // Once app.js has drawn the page (the entry keeps it over later redraws: data-key).
    const key = `history-${focusLanding}`;
    focusLanding = null;
    window.setTimeout(() => document.querySelector(`[data-key="${key}"]`)?.focus({ preventScroll: true }), 0);
  }
  const status = history.busy
    ? t("common.loading")
    : history.error
      ? null
      : !history.items?.length
        ? t(history.filter === "all" ? "history.empty" : "history.emptyFiltered")
        : !history.next
          ? t("history.end")
          : "";
  return [
    header,
    offlineBanner(),
    h(
      "div",
      { class: "history" },
      h("p", { class: "field-help history-help" }, t("history.help")),
      filterChips(history.filter),
      history.error
        ? h(
            "div",
            { class: "notice notice-error", role: "alert" },
            h("span", {}, t("history.loadFailed"), " — ", history.error),
            " ",
            h("button", { type: "button", class: "button button-small", dataset: { key: "history-retry" }, onclick: () => loadHistory(history.filter) }, t("common.retry"))
          )
        : null,
      days.map((day) =>
        h(
          "section",
          { class: "history-day", "aria-labelledby": `history-day-${day.key}` },
          h("h2", { class: "history-day-title", id: `history-day-${day.key}` }, day.title),
          h("ul", { class: "card history-list" }, day.items.map((entry) => entryRow(entry, history.landing)))
        )
      ),
      history.moreError ? h("p", { class: "notice notice-error", role: "alert" }, history.moreError) : null,
      history.next && !history.error
        ? h(
            "div",
            { class: "history-more" },
            // While it loads it looks off and does nothing, but keeps the keyboard (aria-disabled).
            h(
              "button",
              { type: "button", class: "button button-secondary", "aria-disabled": history.busy ? "true" : null, dataset: { key: "history-more" }, onclick: () => loadMore() },
              t("history.loadMore")
            )
          )
        : null,
      h("p", { class: "field-help history-status" }, status || "")
    ),
  ];
}
