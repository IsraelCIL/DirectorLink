// Settings (#/settings): one row per page, each at #/settings/<page> with Back to the list:
// Controller (its facts, updates, backup, pairing), Rooms (shown, order, names and the Sonos rooms),
// Shabbat and holidays, Users (#/access, views/access.js), Account, Alerts (this device's, 1.10.0:
// views/alerts.js), Appearance and language (language, theme, colours and text size, 1.10.0), App
// and About. Since 1.12.0 (ADR-083) a user still named after a device is asked their name once, at
// the top of the list; Account no longer invites someone (Settings → Users → Add a user does), and
// a Safari tab on iPhone or iPad moves to the Home Screen app there (views/move.js).

import { deleteAccount, loadAccount, removeProvider, signIn, signInProviders, signOut } from "../account.js";
import { turnAlertsOff } from "../alerts.js";
import { calendarOn, loadCalendar, noteCalendarOff, takeCalendarReveal } from "../calendar.js";
import { IS_IOS } from "../platform.js";
import { qrCanvas } from "../qr.js";
import { approveHomeSecret, claimHome, homeStatus, invitationLink, saveRemote, savedRemote } from "../remote.js";
import { disableNotifications, enableNotifications, notificationSupport, notificationsOn } from "../doorbells.js";
import { h, iconButton, name } from "../dom.js";
import { LANGUAGES, formatDateTime, formatNumber, formatTime, languageInfo, languagePreference, t } from "../i18n.js";
import { icon } from "../icons.js";
import { hiddenRoomIds, roomName } from "../model.js";
import { setRoomHidden } from "../profile.js";
import { installApp } from "../pwa.js";
import { dropIndex, edgeScroll, keyTarget, moveItem, sameOrder, shiftOf, slotOffset } from "../reorder.js";
import { api, checkInThroughAccount, connect, errorText, noteForbidden, revokeAndForget, roleLabel, saveRoomNames, useHost } from "../session.js";
import { linksMadeBy, linksSupported } from "../scene-links.js";
import { PALETTES, TEXT_SIZES, THEMES, palettePreference, textSizePreference, themePreference } from "../theme.js";
import { can, notify, state, ui } from "../state.js";
import { alarmFact } from "./alarm.js";
import { alertsPage, alertsStatus } from "./alerts.js";
import { makeInvitation, pasteInvitationPanel } from "./device-join.js";
import { movePanel } from "./move.js";
import { deviceLimitOf, deviceLimitPanel } from "./device-limit.js";
import { accessBody, newMemberAccess, peopleSupported, permissionsEditor } from "./permissions.js";
import { loadScenes } from "../scenes.js";
import { backupPanel } from "./backup.js";
import { historyRow } from "./history.js";
import { notReadyState, offlineBanner, pageHeader, signInButtons } from "./common.js";
import { musicRoomsSection } from "./music.js";
import { chip, stepper } from "./schedules.js";
import { updateCheckButton, updateFact, updatePanel, updateSummary } from "./updates.js";
import { APP_VERSION } from "../version.js";

// The pages under Settings (#/settings/<page>); app.js routes them.
export const SETTINGS_PAGES = ["controller", "rooms", "calendar", "account", "alerts", "appearance", "app", "about"];

// `page`: one of SETTINGS_PAGES, or null for the main list.
export function settingsView({ page = null, onPalette, onTheme, onLanguage, onTextSize, navigate }) {
  switch (page) {
    case "controller":
      return subpage(t("settings.controller.title"), controllerSection(navigate), historyRow(), updatesSection(), backupPanel());
    case "rooms":
      return subpage(t("settings.rooms.title"), roomsSection(), roomNamesSection(), musicSection());
    case "calendar":
      return subpage(t("calendar.settings.title"), calendarSection() || calendarUnavailable());
    case "account":
      return subpage(t("settings.account.title"), accountSection());
    case "alerts":
      return subpage(t("alerts.settings.title"), alertsPage());
    case "appearance":
      return subpage(t("settings.appearance.title"), followsNote(), languageSection(onLanguage), appearanceSection(onPalette, onTheme), textSizeSection(onTextSize));
    case "app":
      return subpage(t("settings.app.title"), appSection());
    case "about":
      return subpage(t("settings.about.title"), aboutSection());
    default:
      return [
        pageHeader({ title: t("settings.title") }),
        offlineBanner(),
        h("div", { class: "settings" }, nameCard(), pageRows()),
        h("p", { class: "independent-note", dataset: { key: "settings-independent" } }, t("settings.about.independent")),
      ];
  }
}

// One of Settings' pages: Back leads to the list (or back in history, views/common.js). A long
// title (Shabbat and holidays) wraps rather than being cut.
function subpage(title, ...sections) {
  const header = pageHeader({ title, back: "#/settings" });
  header.className = `${header.className} settings-page-header`;
  return [header, offlineBanner(), h("div", { class: "settings" }, ...sections)];
}

// ---- What's your name? (1.12.0, ADR-083) ------------------------------------------------------

// The names the app gives a device (session.js clientName): a user called that was made by a
// device that joined or paired, before anyone named them.
const DEVICE_NAME = /^(?:(?:Safari|Chrome|Edge|Firefox|Opera|Samsung Internet|Browser|DirectorLink app|Home Screen app) on (?:iPhone|iPad|Android|Windows|ChromeOS|Mac|Linux)|[A-Za-z][A-Za-z ]{0,30} \(DirectorLink app\)|DirectorLink app|Invited device|Paired client)$/;

export function deviceLikeName(name) {
  return typeof name === "string" && DEVICE_NAME.test(name.trim());
}

const NAME_ASKED_KEY = "directorlink.nameAsked"; // { [profile id]: true }: asked once on this device

function nameAsked(profileId) {
  try {
    return JSON.parse(localStorage.getItem(NAME_ASKED_KEY) || "{}")?.[profileId] === true;
  } catch {
    return false;
  }
}

function markNameAsked(profileId) {
  try {
    const value = JSON.parse(localStorage.getItem(NAME_ASKED_KEY) || "{}") || {};
    value[profileId] = true;
    localStorage.setItem(NAME_ASKED_KEY, JSON.stringify(value));
  } catch {
    // Blocked storage: asked again on the next visit.
  }
  ui.nameCard = { ...(ui.nameCard || {}), closed: profileId };
}

// Their name is still a device's: the controller says so (`name_from_device`), or it reads like one.
function nameWanted() {
  const profile = state.profile;
  if (!state.loaded || !profile?.id || state.system?.features?.user_names !== true) return false;
  if (ui.nameCard?.closed === profile.id || nameAsked(profile.id)) return false;
  return profile.name_from_device === true || deviceLikeName(profile.name);
}

async function saveName(event) {
  event?.preventDefault?.();
  const card = ui.nameCard || {};
  const name = (card.draft || "").trim().slice(0, 64);
  const profileId = state.profile?.id;
  if (!name || !profileId || card.busy) {
    ui.nameCard = { ...card, message: name ? null : t("users.name.needed") };
    notify();
    return;
  }
  ui.nameCard = { ...card, busy: true, message: null };
  notify();
  try {
    const answer = await api("/v1/profile", { method: "PATCH", body: { name } });
    state.profile = answer && typeof answer === "object" ? { ...state.profile, ...answer, prefs: state.profile.prefs } : { ...state.profile, name };
    markNameAsked(profileId);
    ui.nameCard = { closed: profileId, saved: name };
  } catch (error) {
    ui.nameCard = { ...ui.nameCard, busy: false, message: errorText(error) };
  }
  notify();
}

// At the top of Settings, once on this device: a field, Save and Not now.
function nameCard() {
  if (ui.nameCard?.saved && ui.nameCard.closed === state.profile?.id) {
    return h(
      "p",
      { class: "notice notice-success", role: "status", dataset: { key: "name-saved" } },
      t("users.name.saved", { name: ui.nameCard.saved })
    );
  }
  if (!nameWanted()) return null;
  const card = (ui.nameCard ||= {});
  const input = h("input", { id: "name-card-name", type: "text", maxlength: "64", autocomplete: "name", dir: "auto", value: card.draft || "", dataset: { key: "name-card-name" } });
  input.addEventListener("input", () => {
    card.draft = input.value;
  });
  return h(
    "form",
    { class: "card settings-card name-card", novalidate: true, dataset: { key: "name-card" }, onsubmit: saveName },
    h("h2", { class: "settings-title" }, icon("user"), t("users.name.title")),
    h("p", { class: "field-help", dir: "auto" }, t("users.name.help", { name: state.profile.name })),
    h("label", { class: "field-label", for: "name-card-name" }, t("users.name.label")),
    input,
    card.message ? h("p", { class: "notice notice-error", role: "alert" }, card.message) : null,
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "submit", class: "button button-primary", disabled: Boolean(card.busy), dataset: { key: "name-card-save" } }, t("users.name.save")),
      h(
        "button",
        {
          type: "button",
          class: "button button-quiet",
          dataset: { key: "name-card-later" },
          onclick: () => {
            markNameAsked(state.profile.id);
            notify();
          },
        },
        t("users.name.later")
      )
    )
  );
}

// ---- the list of pages ------------------------------------------------------------------------

// The data-key of the row on Settings' list that opens `route` (a page of Settings, or People and
// devices): app.js focuses it when Back leads from there to the list. null for other screens.
export function settingsRowKey(route) {
  const page = route?.name === "access" ? "access" : route?.name === "settings" ? route.page : null;
  return page ? `settings-row:${page}` : null;
}

// A row that opens a page: its icon, title, one line of how things are, and a chevron. `badge`: a
// word that stands out (an update); the line says the same, so screen readers skip it.
function pageRow({ page, href = `#/settings/${page}`, iconName, title, status, badge = null }) {
  return h(
    "li",
    {},
    h(
      "a",
      { class: "settings-row", href, dataset: { key: `settings-row:${page}` } },
      h("span", { class: "settings-row-icon", "aria-hidden": "true" }, icon(iconName)),
      h(
        "span",
        { class: "settings-row-text" },
        h("span", { class: "settings-row-title" }, title, badge ? h("span", { class: "settings-row-badge", "aria-hidden": "true" }, badge) : null),
        status ? h("span", { class: "settings-row-status" }, status) : null
      ),
      icon("chevronForward", "settings-row-chevron")
    )
  );
}

// The home's pages, then the person's and the app's.
function pageRows() {
  return h(
    "nav",
    { class: "settings-pages", "aria-label": t("settings.rows.label") },
    h("ul", { class: "card settings-rows" }, controllerRow(), roomsRow(), calendarRow(), accessRow()),
    h("ul", { class: "card settings-rows" }, accountRow(), alertsRow(), appearanceRow(), appRow(), aboutRow())
  );
}

// The connection, then (admins) whether DirectorLink is up to date; a newer one has a badge.
function controllerRow() {
  const update = updateSummary();
  const connection = state.status === "connected" && state.transport === "remote" ? t("status.connectedRemote") : t(`status.${state.status}`);
  const version = state.system?.bridge?.version;
  const status = update?.available
    ? update.text
    : [connection, update ? update.text : version ? t("settings.rows.driverVersion", { version }) : null].filter(Boolean).join(" · ");
  return pageRow({ page: "controller", iconName: "controller", title: t("settings.controller.title"), status, badge: update?.available ? t("settings.rows.updateBadge") : null });
}

function roomsRow() {
  let status = t("settings.rows.roomsConnect");
  if (state.loaded && state.rooms.length) {
    const rooms = t("settings.rows.roomCount", { count: state.rooms.length });
    const hidden = state.profile ? state.rooms.filter((room) => hiddenRoomIds().has(room.id)).length : 0;
    status = hidden ? t("settings.rows.roomsHidden", { rooms, count: hidden }) : rooms;
  }
  return pageRow({ page: "rooms", iconName: "rooms", title: t("settings.rooms.title"), status });
}

// Admins, while the Jewish calendar is on in Composer (as its card, below): the minutes.
function calendarRow() {
  if (!state.loaded || !can("admin") || !calendarOn()) return null;
  const settings = state.calendar?.enabled ? state.calendar.settings : null;
  if (!settings) return null;
  const status = t("settings.rows.calendar", { candles: settings.candle_lighting_minutes, havdalah: settings.havdalah_minutes });
  return pageRow({ page: "calendar", iconName: "candles", title: t("calendar.settings.title"), status });
}

// Admins manage who has access: devices, invitations and, for the owner, accounts. Since 1.9.0
// (ADR-061, `features.users`) Settings → Users is everyone's: a member sees their own devices.
function usersSupported() {
  return state.system?.features?.users === true;
}

function accessRow() {
  if (!state.loaded || !(can("admin") || usersSupported())) return null;
  // While this device is not linked, People and devices finds the home in GET /v1/remote's answer,
  // which This home (Settings → Account) asks for a signed-in admin at home: asked here too, as it
  // was when Settings was one page.
  if (state.account.status === "signed-in" && !savedRemote() && !IS_IOS && state.status === "connected" && state.transport === "lan" && !state.remoteInfo) {
    loadRemoteInfo();
  }
  const status = usersSupported() ? (can("admin") ? t("settings.rows.users") : t("settings.rows.usersMine")) : t("settings.rows.access");
  return pageRow({ page: "access", href: "#/access", iconName: "users", title: usersSupported() ? t("users.title") : t("access.open"), status });
}

function accountRow() {
  const account = state.account;
  const status =
    account.status === "signed-in"
      ? t("settings.rows.signedIn", { email: account.user?.email || "" })
      : account.status === "unknown" || account.status === "loading"
        ? t("common.loading")
        : account.status === "unavailable"
          ? t("settings.rows.accountUnavailable")
          : t("settings.rows.signedOut");
  return pageRow({ page: "account", iconName: "user", title: t("settings.account.title"), status });
}

// Alerts on this device (1.10.0; a card on Controller before): for whoever may have them, whether
// they are on, or what they still need (signing in, the Home Screen on iPhone, …).
function alertsRow() {
  const status = alertsStatus();
  return status === null ? null : pageRow({ page: "alerts", iconName: "bell", title: t("alerts.settings.title"), status });
}

// The language shown (Auto: the one it found), the theme and the colours, and the text size when it
// is not the default.
function appearanceRow() {
  const size = textSizePreference();
  const status = [
    languageInfo().label,
    t(`settings.appearance.themes.${themePreference()}`),
    t(`palettes.${palettePreference()}`),
    size === "default" ? null : t(`settings.rows.textSize.${size}`),
  ]
    .filter(Boolean)
    .join(" · ");
  return pageRow({ page: "appearance", iconName: "palette", title: t("settings.appearance.title"), status });
}

// Whether it can be installed, else whether it opens without internet.
function appRow() {
  const status = state.canInstall ? t("settings.rows.canInstall") : t(`settings.app.offline.${state.offlineCopy}`);
  return pageRow({ page: "app", iconName: "download", title: t("settings.app.title"), status });
}

function aboutRow() {
  return pageRow({ page: "about", iconName: "info", title: t("settings.about.title"), status: t("settings.rows.about", { version: APP_VERSION }) });
}

function card(id, iconName, title, ...content) {
  return h(
    "section",
    { class: "card settings-card", id: `settings-${id}`, "aria-labelledby": `settings-${id}-title` },
    h("h2", { class: "settings-title", id: `settings-${id}-title` }, icon(iconName), title),
    ...content
  );
}

// A group of real radio buttons, drawn as segments or swatches. `legendHidden`: the card's title
// says it already (the legend is still read out).
function radioGroup({ legend, groupName, options, value, onChange, className = "segmented", legendHidden = false }) {
  return h(
    "fieldset",
    { class: `radio-group ${className}` },
    h("legend", { class: legendHidden ? "field-label visually-hidden" : "field-label" }, legend),
    h(
      "div",
      { class: "radio-options" },
      options.map((option) => {
        const id = `${groupName}-${option.value}`;
        return h(
          "div",
          { class: "radio-option" },
          h("input", {
            type: "radio",
            id,
            name: groupName,
            value: option.value,
            checked: option.value === value,
            dataset: { key: id },
            onchange: () => onChange(option.value),
          }),
          h(
            "label",
            { for: id },
            option.visual || null,
            // A language's own name, in its own direction (the choice still lines up with the others).
            h("span", { class: "radio-label", lang: option.lang, dir: option.dir }, option.label),
            option.help ? h("span", { class: "radio-help" }, option.help) : null
          )
        );
      })
    )
  );
}

// ---- appearance and language (1.10.0, ADR-067) -----------------------------------------------

// What follows this user to their other devices (their profile on the controller: js/profile.js)
// and what stays here.
function followsNote() {
  return h(
    "p",
    { class: "field-help settings-note", dataset: { key: "appearance-follows" } },
    state.profile ? t("settings.appearance.follows") : t("settings.appearance.followsLocal")
  );
}

function languageSection(onLanguage) {
  return card(
    "language",
    "globe",
    t("settings.language.title"),
    radioGroup({
      legend: t("settings.language.label"),
      groupName: "language",
      className: "radio-stack",
      value: languagePreference(),
      onChange: onLanguage,
      options: [
        // Auto says which language it found.
        { value: "auto", label: t("settings.language.auto"), help: languagePreference() === "auto" ? languageInfo().label : null },
        ...LANGUAGES.map((language) => ({ value: language.code, label: language.label, lang: language.code, dir: language.dir })),
      ],
    }),
    h("p", { class: "field-help" }, t("settings.language.autoHelp"))
  );
}

function appearanceSection(onPalette, onTheme) {
  return card(
    "appearance",
    "palette",
    t("settings.appearance.themeTitle"),
    radioGroup({
      legend: t("settings.appearance.theme"),
      groupName: "theme",
      value: themePreference(),
      onChange: onTheme,
      options: THEMES.map((theme) => ({
        value: theme,
        label: t(`settings.appearance.themes.${theme}`),
        visual: icon(theme === "light" ? "sun" : theme === "dark" ? "moon" : "auto"),
      })),
    }),
    h("p", { class: "field-help" }, t("settings.appearance.autoHelp")),
    radioGroup({
      legend: t("settings.appearance.palette"),
      groupName: "palette",
      className: "swatches",
      value: palettePreference(),
      onChange: onPalette,
      options: PALETTES.map((palette) => ({
        value: palette,
        label: t(`palettes.${palette}`),
        visual: h(
          "span",
          { class: "swatch", dataset: { swatch: palette }, "aria-hidden": "true" },
          h("span", { class: "swatch-a" }),
          h("span", { class: "swatch-b" }),
          h("span", { class: "swatch-c" })
        ),
      })),
    })
  );
}

// This device's text size: each choice is written at the size it gives.
function textSizeSection(onTextSize) {
  return card(
    "text-size",
    "textSize",
    t("settings.appearance.textSize"),
    radioGroup({
      legend: t("settings.appearance.textSize"),
      legendHidden: true,
      groupName: "text-size",
      className: "radio-stack text-sizes",
      value: textSizePreference(),
      onChange: onTextSize,
      options: TEXT_SIZES.map((size) => ({
        value: size,
        label: h("span", { class: "text-size-sample", dataset: { size } }, t(`settings.appearance.textSizes.${size}`)),
      })),
    }),
    h("p", { class: "field-help" }, t("settings.appearance.textSizeHelp"))
  );
}

// ---- rooms ---------------------------------------------------------------------------------

// Settings → Rooms: which rooms this person sees and (admins) the home's order; then the rooms'
// names; then Music.
function roomsSection() {
  if (!state.loaded || !state.rooms.length) {
    return card("rooms", "rooms", t("settings.rooms.listTitle"), h("p", { class: "muted-note" }, t("settings.rooms.connectFirst")));
  }
  const admin = can("admin");
  const personal = Boolean(state.profile);
  const hidden = hiddenRoomIds();
  // Made now, so that it is on the page before the first room moves.
  if (admin) orderStatus();
  return card(
    "rooms",
    "rooms",
    t("settings.rooms.listTitle"),
    h("p", { class: "field-help" }, personal ? (admin ? t("settings.rooms.orderHelpAdmin") : t("settings.rooms.orderHelp")) : t("settings.rooms.updateForHiding")),
    // Rooms hidden from every member (1.8.0, ADR-054).
    admin && peopleSupported() ? h("p", { class: "field-help" }, t("settings.rooms.membersHelp")) : null,
    admin ? h("p", { class: "visually-hidden", id: "room-order-keys" }, t("settings.rooms.moveKeys")) : null,
    ui.roomOrderMessage ? h("p", { class: `notice notice-${ui.roomOrderMessage.kind}`, role: "alert" }, ui.roomOrderMessage.text) : null,
    h("ul", { class: "room-order-list" }, state.rooms.map((room, index) => roomRow(room, index, hidden, { admin, personal })))
  );
}

function roomNamesSection() {
  if (!state.loaded || !state.rooms.length) return null;
  return card(
    "room-names",
    "edit",
    t("settings.rooms.namesTitle"),
    // Renaming rooms (PATCH /v1/rooms/{id}) needs an admin key.
    can("admin")
      ? [h("p", { class: "field-help" }, t("settings.rooms.help")), h("div", { class: "room-editor-list" }, state.rooms.map(roomEditor))]
      : h("p", { class: "notice notice-info" }, t("settings.rooms.askAdmin", { role: roleLabel(state.role) }))
  );
}

// ---- Music ---------------------------------------------------------------------------------

// The Rooms page ends with the Sonos rooms and the Control4 room each is shown in (admins, when
// Sonos is on: views/music.js, ADR-044); null otherwise.
function musicSection() {
  return musicRoomsSection();
}

// One room: shown or hidden for this person, and (admins) moved for everyone: dragged by its handle
// or moved with the keyboard, or one place at a time with the arrows. The arrows at the ends stay
// focusable (aria-disabled), so focus stays with a room moved to the top or the bottom.
function roomRow(room, index, hidden, { admin, personal }) {
  const id = `room-show-${room.id}`;
  const shown = !hidden.has(room.id);
  return h(
    "li",
    { class: "room-order-row", dataset: { key: `room-row:${room.id}` } },
    personal
      ? h("input", { type: "checkbox", id, checked: shown, dataset: { key: `room-show:${room.id}` }, onchange: (event) => setRoomHidden(room.id, !event.target.checked) })
      : null,
    h(
      "label",
      { class: "room-order-name", for: personal ? id : null },
      name(roomName(room), "span"),
      shown ? null : h("span", { class: "room-order-hidden" }, t("settings.rooms.hiddenForYou")),
      room.hidden_from_members ? h("span", { class: "room-order-hidden", dataset: { key: `room-members-hidden:${room.id}` } }, t("settings.rooms.hiddenFromMembers")) : null
    ),
    admin && peopleSupported() ? membersToggle(room) : null,
    admin
      ? h(
          "span",
          { class: "room-order-moves" },
          iconButton("arrowUp", t("settings.rooms.moveUp", { name: roomName(room) }), {
            class: "room-order-step",
            "aria-disabled": index === 0 ? "true" : null,
            dataset: { key: `room-up:${room.id}` },
            onclick: () => moveRoom(index, -1),
          }),
          iconButton("arrowDown", t("settings.rooms.moveDown", { name: roomName(room) }), {
            class: "room-order-step",
            "aria-disabled": index === state.rooms.length - 1 ? "true" : null,
            dataset: { key: `room-down:${room.id}` },
            onclick: () => moveRoom(index, 1),
          }),
          iconButton("grip", t("settings.rooms.move", { name: roomName(room) }), {
            class: "room-order-handle",
            "aria-describedby": "room-order-keys",
            dataset: { key: `room-move:${room.id}` },
            onpointerdown: pressHandle,
            onpointermove: movePointer,
            onpointerup: releasePointer,
            onpointercancel: cancelPointer,
            onkeydown: handleKey,
            onblur: leaveHandle,
            // Touch: once the room is lifted, the finger moves it instead of scrolling the page, and
            // holding it does not open a menu.
            ontouchmove: (event) => {
              if (moving?.handle === event.currentTarget) event.preventDefault();
            },
            oncontextmenu: (event) => {
              if (moving || holding) event.preventDefault();
            },
          })
        )
      : null
  );
}

// Hidden from every member, or not (1.8.0, ADR-054): PATCH /v1/rooms/{id}, for admins. Members never
// see such a room or its devices; admins see it, marked.
const membersSaving = new Set();

function membersToggle(room) {
  const hidden = room.hidden_from_members === true;
  return h(
    "button",
    {
      type: "button",
      class: "button button-small button-quiet room-members",
      "aria-pressed": String(hidden),
      disabled: membersSaving.has(room.id),
      title: t(hidden ? "settings.rooms.showToMembersFor" : "settings.rooms.hideFromMembersFor", { name: roomName(room) }),
      dataset: { key: `room-members:${room.id}` },
      onclick: () => setHiddenFromMembers(room, !hidden),
    },
    t(hidden ? "settings.rooms.showToMembers" : "settings.rooms.hideFromMembers")
  );
}

async function setHiddenFromMembers(room, hidden) {
  membersSaving.add(room.id);
  ui.roomOrderMessage = null;
  notify();
  try {
    const answer = await api(`/v1/rooms/${room.id}`, { method: "PATCH", body: { hidden_from_members: hidden } });
    state.rooms = state.rooms.map((item) => (item.id === room.id ? { ...item, hidden_from_members: answer?.hidden_from_members === true } : item));
  } catch (error) {
    noteForbidden(error);
    ui.roomOrderMessage = { kind: "error", text: errorText(error) };
  } finally {
    membersSaving.delete(room.id);
    notify();
  }
}

// Why the room order was not saved. Drivers before 0.12.0 have no room order (404, 405), and 1.0.0
// refuses PUT in the sealed requests the app sends at home and away (400 BAD_REQUEST, "Remote
// requests are GET, POST, PATCH or DELETE on /v1/..."): both need a newer DirectorLink.
export function roomOrderErrorText(error) {
  const older = error?.status === 404 || error?.status === 405 || (error?.status === 400 && error?.code === "BAD_REQUEST");
  return older ? t("settings.rooms.updateDriverOrder") : errorText(error);
}

// The home's room order, for everyone (PUT /v1/rooms/order). `rooms` shows at once and goes in one
// request; moves made while one is on its way go together in the next. When the controller refuses,
// the order it last had comes back.
let orderSave = null; // { saved: the order the controller has, next: the order still to send }

export async function saveRoomOrder(rooms) {
  const before = state.rooms;
  state.rooms = rooms;
  ui.roomOrderMessage = null;
  notify();
  if (orderSave) {
    orderSave.next = rooms;
    return;
  }
  const save = { saved: before, next: rooms };
  orderSave = save;
  try {
    while (save.next) {
      const sent = save.next;
      save.next = null;
      const answer = await api("/v1/rooms/order", { method: "PUT", body: { room_ids: sent.map((room) => room.id) } });
      save.saved = Array.isArray(answer?.items) ? answer.items : sent;
    }
    state.rooms = save.saved;
  } catch (error) {
    state.rooms = save.saved;
    ui.roomOrderMessage = { kind: "error", text: roomOrderErrorText(error) };
  } finally {
    orderSave = null;
  }
  notify();
}

// The arrows: one place up or down.
function moveRoom(index, offset) {
  const target = index + offset;
  if (moving || target < 0 || target >= state.rooms.length) return;
  saveRoomOrder(moveItem(state.rooms, index, target));
}

// ---- moving a room by its handle: dragged, or with the keyboard ---------------------------------

// Touch and pen: the handle is held this long, moving less than HOLD_SLOP pixels, before the room
// lifts; a swipe that starts on it scrolls the page.
const HOLD_MS = 250;
const HOLD_SLOP = 10;
// The room gliding into its place when it is let go (at once with reduced motion).
const SETTLE_MS = 150;

// The room being moved: its handle, row and list, where each row is (tops and heights, without the
// shifts) and the place it is shown at (`to`). `pointerId` is null when it moves with the keyboard.
let moving = null;
let holding = null; // touch and pen: { handle, pointerId, x, y, lastY, timer } until the room lifts

// The moving room's name and a place in the list, for the announcements.
const placeText = (index) => ({ name: roomName(moving.rooms[moving.from]), position: index + 1, count: moving.rows.length });

function lift(handle, pointer = null) {
  const row = handle.closest(".room-order-row");
  const list = row?.parentElement;
  const rows = list ? [...list.children] : [];
  const from = rows.indexOf(row);
  if (from < 0 || rows.length !== state.rooms.length) return;
  const tops = rows.map((item) => item.offsetTop);
  const heights = rows.map((item) => item.offsetHeight);
  const listTop = list.getBoundingClientRect().top;
  moving = {
    handle,
    row,
    list,
    rows,
    rooms: state.rooms,
    from,
    to: from,
    tops,
    heights,
    middles: tops.map((top, index) => top + heights[index] / 2),
    pointerId: pointer ? pointer.pointerId : null,
    // Where the pointer holds the room, from the top of the list, and where the list was then.
    grabbed: pointer ? pointer.clientY - listTop : 0,
    listTop,
    y: pointer ? pointer.clientY : 0,
    frame: pointer ? requestAnimationFrame(autoScroll) : 0,
    timer: 0,
    settling: false,
    placed: false,
  };
  ui.reordering = true;
  list.classList.add("is-sorting");
  row.classList.add("is-moving");
  if (pointer) row.classList.add("is-following");
  document.addEventListener("keydown", escapeKey);
  window.addEventListener("blur", cancelMove);
  // Before app.js redraws the new screen.
  window.addEventListener("hashchange", cancelMove, true);
  announce(t("settings.rooms.lifted", placeText(from)));
}

// Shows the moving room at `to`: the rooms in between make room for it.
function place(to) {
  const { rows, row, from, heights } = moving;
  if (to === moving.to) return;
  moving.to = to;
  rows.forEach((item, index) => {
    const shift = shiftOf(index, from, to);
    if (item !== row) item.style.transform = shift ? `translateY(${shift * heights[from]}px)` : "";
  });
  announce(t("settings.rooms.position", placeText(to)));
}

// The pointer at `y` (in the viewport): the room follows it, within the list.
function follow(y) {
  const { list, row, from, tops, heights } = moving;
  const last = tops.length - 1;
  moving.y = y;
  moving.listTop = list.getBoundingClientRect().top;
  const offset = Math.min(
    Math.max(y - moving.listTop - moving.grabbed, tops[0] - tops[from]),
    tops[last] + heights[last] - tops[from] - heights[from]
  );
  row.style.transform = `translateY(${offset}px)`;
  place(dropIndex(moving.middles, from, tops[from] + offset, tops[from] + heights[from] + offset));
}

// Where the screen ends: above the tab bar on phones (on wide screens it is a rail at the side).
function visibleBottom() {
  const bar = document.querySelector("#tabbar")?.getBoundingClientRect();
  return bar && bar.top > window.innerHeight / 2 ? bar.top : window.innerHeight;
}

// While dragged near the top or the bottom of the screen, the page scrolls as far as the list goes
// on past it. The room stays under the pointer when the page scrolls otherwise too (a mouse wheel).
function autoScroll() {
  if (!moving) return;
  moving.frame = requestAnimationFrame(autoScroll);
  const bottom = visibleBottom();
  const box = moving.list.getBoundingClientRect();
  const step = edgeScroll(moving.y, 0, bottom);
  const by = step < 0 ? Math.max(step, Math.min(0, box.top)) : Math.min(step, Math.max(0, box.bottom - bottom));
  if (Math.abs(by) >= 1) window.scrollBy(0, by);
  if (Math.abs(by) >= 1 || box.top !== moving.listTop) follow(moving.y);
}

// Keyboard: the moving room stays on screen.
function reveal() {
  const { list, from, to, tops, heights } = moving;
  const top = list.getBoundingClientRect().top + tops[from] + slotOffset(heights, from, to);
  const bottom = visibleBottom();
  if (top < 0) window.scrollBy(0, top - 8);
  else if (top + heights[from] > bottom) window.scrollBy(0, top + heights[from] - bottom + 8);
}

// Let go: the room glides into its place and the new order is saved (nothing when it is where it
// was). Redraws wait until it is there.
function drop() {
  const { row, rooms, from, to, heights } = moving;
  const order = moveItem(rooms, from, to);
  cancelAnimationFrame(moving.frame);
  moving.settling = true;
  moving.placed = !sameOrder(order, rooms);
  row.classList.remove("is-following");
  row.style.transform = moving.placed ? `translateY(${slotOffset(heights, from, to)}px)` : "";
  announce(t("settings.rooms.dropped", placeText(to)));
  if (moving.placed) saveRoomOrder(order);
  if (moving.pointerId === null || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    finish(moving.placed);
  } else {
    moving.timer = window.setTimeout(() => finish(moving.placed), SETTLE_MS);
  }
}

// Escape, a cancelled touch, leaving the screen: the room goes back to where it was.
function cancelMove() {
  if (!moving) return;
  if (moving.settling) {
    finish(moving.placed);
    return;
  }
  announce(t("settings.rooms.cancelled", placeText(moving.from)));
  finish(false);
}

// The move is over and redraws go on. `placed`: the rows stay as they are until the redraw draws the
// new order; otherwise they glide back.
function finish(placed) {
  const { list, rows, row, frame, timer } = moving;
  cancelAnimationFrame(frame);
  window.clearTimeout(timer);
  moving = null;
  ui.reordering = false;
  document.removeEventListener("keydown", escapeKey);
  window.removeEventListener("blur", cancelMove);
  window.removeEventListener("hashchange", cancelMove, true);
  if (!placed) {
    row.classList.remove("is-moving", "is-following");
    for (const item of rows) item.style.transform = "";
    window.setTimeout(() => {
      if (moving?.list !== list) list.classList.remove("is-sorting");
    }, SETTLE_MS);
  }
  notify();
}

function pressHandle(event) {
  if (moving || holding || !event.isPrimary || event.button !== 0) return;
  const handle = event.currentTarget;
  if (event.pointerType === "mouse") {
    event.preventDefault(); // no text selection while the room is dragged
    handle.setPointerCapture(event.pointerId);
    lift(handle, event);
    return;
  }
  // Touch and pen: held first, so that a swipe that starts on the handle still scrolls the page.
  holding = {
    handle,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    lastY: event.clientY,
    timer: window.setTimeout(() => {
      const held = holding;
      holding = null;
      if (!held.handle.isConnected) return;
      try {
        held.handle.setPointerCapture(held.pointerId);
      } catch {
        return; // the finger is gone
      }
      lift(held.handle, { pointerId: held.pointerId, clientY: held.lastY });
    }, HOLD_MS),
  };
}

function stopHolding() {
  window.clearTimeout(holding.timer);
  holding = null;
}

const dragging = (event) => moving && !moving.settling && moving.pointerId === event.pointerId;

function movePointer(event) {
  if (holding?.pointerId === event.pointerId) {
    holding.lastY = event.clientY;
    // Moved first: scrolling, not a drag.
    if (Math.hypot(event.clientX - holding.x, event.clientY - holding.y) > HOLD_SLOP) stopHolding();
  } else if (dragging(event)) {
    follow(event.clientY);
  }
}

function releasePointer(event) {
  if (holding?.pointerId === event.pointerId) stopHolding();
  else if (dragging(event)) drop();
}

function cancelPointer(event) {
  if (holding?.pointerId === event.pointerId) stopHolding();
  else if (dragging(event)) cancelMove();
}

function escapeKey(event) {
  if (event.key === "Escape" && moving && !moving.settling) {
    event.preventDefault();
    cancelMove();
  }
}

// Keyboard: Space or Enter picks the room up and puts it down, the arrows (Home, End) move it.
function handleKey(event) {
  const handle = event.currentTarget;
  if (moving && (moving.pointerId !== null || moving.settling)) return;
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    if (event.repeat) return;
    if (!moving) lift(handle);
    else if (moving.handle === handle) drop();
    return;
  }
  const to = moving?.handle === handle ? keyTarget(moving.to, event.key, moving.rows.length) : null;
  if (to === null) return;
  event.preventDefault();
  place(to);
  moving.row.style.transform = `translateY(${slotOffset(moving.heights, moving.from, to)}px)`;
  reveal();
}

// Keyboard: focus going elsewhere puts the room back.
function leaveHandle(event) {
  if (moving?.handle === event.currentTarget && moving.pointerId === null) cancelMove();
}

// Screen readers hear where the moving room is: one polite region, outside the view so that
// redraws keep it; its text goes after a while.
let liveRegion = null;
let liveTimer = 0;

function orderStatus() {
  if (!liveRegion) {
    liveRegion = h("p", { class: "visually-hidden", role: "status" });
    document.body.append(liveRegion);
  }
  return liveRegion;
}

function announce(text) {
  orderStatus().textContent = text;
  window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => {
    liveRegion.textContent = "";
  }, 10000);
}

function roomEditor(room) {
  const names = room.names && typeof room.names === "object" ? room.names : {};
  const message = ui.roomMessages[room.id];
  const inputs = LANGUAGES.map((language) => {
    const key = `${room.id}:${language.code}`;
    const id = `room-name-${room.id}-${language.code}`;
    const input = h("input", {
      id,
      type: "text",
      maxlength: "64",
      lang: language.code,
      dir: "auto",
      autocomplete: "off",
      placeholder: room.name,
      value: ui.roomDrafts[key] ?? names[language.code] ?? "",
      dataset: { key: `room-name:${key}` },
    });
    input.addEventListener("input", () => {
      ui.roomDrafts[key] = input.value;
    });
    return h("div", { class: "field" }, h("label", { class: "field-label", for: id }, language.label), input);
  });

  const save = async (event) => {
    event.preventDefault();
    const next = {};
    for (const language of LANGUAGES) {
      const key = `${room.id}:${language.code}`;
      next[language.code] = String(ui.roomDrafts[key] ?? names[language.code] ?? "").trim();
    }
    ui.roomMessages[room.id] = { kind: "info", text: t("common.saving") };
    notify();
    try {
      await saveRoomNames(room.id, next);
      for (const language of LANGUAGES) delete ui.roomDrafts[`${room.id}:${language.code}`];
      ui.roomMessages[room.id] = { kind: "success", text: t("settings.rooms.saved") };
    } catch (error) {
      ui.roomMessages[room.id] = {
        kind: "error",
        text: error?.status === 404 || error?.status === 405 ? t("settings.rooms.updateDriver") : errorText(error),
      };
    }
    notify();
  };

  return h(
    "details",
    { class: "room-editor", dataset: { key: `room-editor:${room.id}` } },
    h("summary", {}, name(roomName(room), "span", "room-editor-name"), h("span", { class: "room-editor-original", dir: "auto" }, room.name)),
    h(
      "form",
      { class: "room-editor-form", onsubmit: save },
      inputs,
      h(
        "div",
        { class: "button-row" },
        h("button", { type: "submit", class: "button button-primary button-small", dataset: { key: `room-save:${room.id}` } }, t("common.save")),
        message ? h("p", { class: `notice notice-${message.kind}`, role: message.kind === "error" ? "alert" : "status" }, message.text) : null
      )
    )
  );
}

// ---- Shabbat and holidays (the Jewish calendar) --------------------------------------------

// Admins, with the Jewish calendar on in Composer: how the controller works out the times
// (PATCH /v1/calendar/settings). The minutes are the family's custom, not the installer's.
const CANDLE_PRESETS = [18, 20, 30, 40];
const HAVDALAH_PRESETS = [42, 50, 72];
const CALENDAR_MESSAGE_MS = 6000;

// Entering Settings (app.js): the settings as the controller has them.
export function resetCalendarSettings() {
  ui.calendarSettings = null;
}

// What the card shows: the settings being changed, or else the controller's, so that a change made
// on another device shows up. A message stays either way.
function calendarDraft(settings) {
  const draft = ui.calendarSettings;
  if (draft && (draft.dirty || draft.busy)) return draft;
  ui.calendarSettings = {
    holidays: settings.holidays,
    candles: settings.candle_lighting_minutes,
    havdalah: settings.havdalah_minutes,
    version: settings.version,
    dirty: false,
    busy: false,
    message: draft?.message || null,
  };
  return ui.calendarSettings;
}

function calendarMessage(draft, kind, text, extra = {}) {
  const stamp = Date.now();
  draft.message = { kind, text, stamp, ...extra };
  if (kind !== "success") return;
  window.setTimeout(() => {
    if (ui.calendarSettings?.message?.stamp === stamp) {
      ui.calendarSettings.message = null;
      notify();
    }
  }, CALENDAR_MESSAGE_MS);
}

async function saveCalendarSettings(draft) {
  draft.busy = true;
  draft.message = null;
  notify();
  try {
    const settings = await api("/v1/calendar/settings", {
      method: "PATCH",
      body: { holidays: draft.holidays, candle_lighting_minutes: draft.candles, havdalah_minutes: draft.havdalah, version: draft.version },
    });
    if (settings && typeof settings === "object" && state.calendar) state.calendar = { ...state.calendar, settings };
    draft.dirty = false;
    calendarMessage(draft, "success", t("calendar.settings.saved"));
    // The times move with the minutes, and the holidays with Israel or abroad.
    loadCalendar();
  } catch (error) {
    noteForbidden(error);
    if (error?.code === "VERSION_CONFLICT") {
      // Changed on another device meanwhile: shown as it is now, to be changed again.
      draft.dirty = false;
      calendarMessage(draft, "error", t("calendar.settings.conflict"));
      loadCalendar();
    } else {
      // Turned off in Composer meanwhile: the card goes, and says so while this screen is open.
      calendarMessage(draft, "error", errorText(error), { off: noteCalendarOff(error) });
    }
  }
  draft.busy = false;
  notify();
}

// Candle lighting or havdalah: minutes before or after sunset, with the customs most kept as chips.
function minutesField(draft, kind, [min, max], presets, change) {
  const value = draft[kind];
  const set = (next) => change(() => { draft[kind] = next; });
  const minutes = (count) => t("calendar.settings.minutes", { value: count });
  return h(
    "div",
    { class: "calendar-minutes" },
    h("p", { class: "field-label" }, t(`calendar.settings.${kind}`)),
    stepper({ value, format: formatNumber, label: t(`calendar.settings.${kind}Label`), key: `calendar-${kind}`, min, max, step: 1, onChange: set }),
    h("div", { class: "chip-row" }, presets.map((preset) => chip(minutes(preset), value === preset, `calendar-${kind}:${preset}`, () => set(preset))))
  );
}

function calendarSection() {
  if (!state.loaded || !can("admin")) return null;
  if (!calendarOn()) {
    const message = ui.calendarSettings?.message;
    return message?.off ? card("calendar", "candles", t("calendar.settings.cardTitle"), h("p", { class: "notice notice-error", role: "alert" }, message.text)) : null;
  }
  const settings = state.calendar?.enabled ? state.calendar.settings : null;
  if (!settings) return null;
  const draft = calendarDraft(settings);
  const change = (update) => {
    update();
    draft.dirty = true;
    draft.message = null;
    notify();
  };
  // Automatic says what the home's location gave, when it is what the controller uses now.
  const autoHelp = settings.holidays === "auto" ? t(`calendar.settings.autoIs.${settings.israel ? "israel" : "abroad"}`) : t("calendar.settings.autoHelp");
  const section = card(
    "calendar",
    "candles",
    t("calendar.settings.cardTitle"),
    radioGroup({
      legend: t("calendar.settings.holidays"),
      groupName: "calendar-holidays",
      className: "radio-stack",
      value: draft.holidays,
      onChange: (value) => change(() => { draft.holidays = value; }),
      options: [
        { value: "auto", label: t("calendar.settings.auto"), help: autoHelp },
        { value: "israel", label: t("calendar.settings.israel"), help: t("calendar.settings.israelHelp") },
        { value: "abroad", label: t("calendar.settings.abroad"), help: t("calendar.settings.abroadHelp") },
      ],
    }),
    minutesField(draft, "candles", [0, 90], CANDLE_PRESETS, change),
    minutesField(draft, "havdalah", [20, 90], HAVDALAH_PRESETS, change),
    draft.message ? h("p", { class: `notice notice-${draft.message.kind}`, role: draft.message.kind === "error" ? "alert" : "status" }, draft.message.text) : null,
    h(
      "div",
      { class: "button-row" },
      h(
        "button",
        { type: "button", class: "button button-primary", disabled: draft.busy || !draft.dirty, dataset: { key: "calendar-save" }, onclick: () => saveCalendarSettings(draft) },
        icon("check"),
        draft.busy ? t("common.saving") : t("calendar.settings.save")
      )
    ),
    h("p", { class: "field-help" }, t("calendar.settings.disclaimer"))
  );
  // Schedules → Change leads here: the card takes the focus once app.js has focused the title.
  section.setAttribute("tabindex", "-1");
  section.dataset.key = "settings-calendar";
  if (takeCalendarReveal()) {
    window.setTimeout(() => {
      const element = document.getElementById("settings-calendar");
      element?.scrollIntoView({ block: "start" });
      element?.focus({ preventScroll: true });
    }, 0);
  }
  return section;
}

// Settings → Shabbat and holidays for anyone else (a link kept from an admin device), or with the
// calendar off: why there is nothing to change.
function calendarUnavailable() {
  if (!state.loaded) return notReadyState() || h("p", { class: "field-help", role: "status" }, t("common.loading"));
  return h("p", { class: "notice notice-info" }, t("calendar.settings.unavailable"));
}

// ---- controller ----------------------------------------------------------------------------

// " The 2 scene links made on this device stop working too." for Forget and Pair again, when this
// admin key made scene links (they go with it, ADR-051); "" otherwise, or when that is not known.
async function ownLinksNote() {
  if (!linksSupported() || !can("admin") || state.status !== "connected") return "";
  try {
    const [me, links] = await Promise.all([api("/v1/api-keys/current"), api("/v1/scene-links")]);
    const count = linksMadeBy(links?.items, me?.id);
    return count ? ` ${t("settings.controller.forgetLinks", { count })}` : "";
  } catch {
    return "";
  }
}

function controllerSection(navigate) {
  const hostInput = h("input", {
    id: "settings-host",
    type: "text",
    inputmode: "url",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "192.168.1.50",
    value: ui.drafts.settingsHost ?? state.host,
    dataset: { key: "settings-host" },
  });
  hostInput.addEventListener("input", () => {
    ui.drafts.settingsHost = hostInput.value;
  });

  const submit = async (event) => {
    event.preventDefault();
    try {
      const previous = state.host;
      const host = useHost(hostInput.value);
      delete ui.drafts.settingsHost;
      ui.controllerMessage = null;
      // A device that joined with an invitation keeps its key for its home's first address.
      if ((previous && host !== previous) || !state.apiKey) {
        // A new controller needs its own key: pair with a code from its Composer project.
        state.notice = { kind: "info", text: t("connect.pairNew") };
        navigate("#/");
      } else {
        await connect();
      }
    } catch (error) {
      ui.controllerMessage = { kind: "error", text: errorText(error) };
      notify();
    }
  };

  const system = state.system;
  const rows = [
    [t("settings.controller.status"), t(`status.${state.status}`)],
    state.role ? [t("settings.controller.access"), roleLabel(state.access?.role || state.role)] : null,
    state.lastUpdated && state.loaded ? [t("settings.controller.updated"), formatTime(state.lastUpdated)] : null,
    system?.controller?.model ? [t("settings.controller.model"), system.controller.model] : null,
    system?.controller?.os_version ? [t("settings.controller.os"), system.controller.os_version] : null,
    system?.inventory
      ? [
          t("settings.controller.inventory"),
          [
            t("settings.controller.inventoryValue", {
              rooms: system.inventory.rooms ?? 0,
              devices: system.inventory.devices ?? 0,
              supported: system.inventory.supported_devices ?? 0,
            }),
            // Drivers with fans (1.2.0), doorbells (0.9.2) and refrigerators (1.7.0) count them too.
            system.inventory.fans ? t("settings.controller.inventoryFans", { count: system.inventory.fans }) : null,
            system.inventory.doorbells ? t("settings.controller.inventoryDoorbells", { count: system.inventory.doorbells }) : null,
            system.inventory.refrigerators ? t("settings.controller.inventoryRefrigerators", { count: system.inventory.refrigerators }) : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ]
      : null,
    // Members and admins: the alarm, read-only, when the installer turned it on (ADR-038).
    alarmFact(),
  ].filter(Boolean);

  return card(
    "controller",
    "controller",
    t("settings.controller.connection"),
    // iPhone and iPad cannot use the home-network connection (docs/ACCOUNTS.md).
    IS_IOS
      ? null
      : h(
          "form",
          { class: "inline-form", onsubmit: submit },
          h("label", { class: "field-label", for: "settings-host" }, t("connect.hostLabel")),
          h(
            "div",
            { class: "input-row" },
            hostInput,
            h("button", { type: "submit", class: "button button-primary", dataset: { key: "settings-host-save" } }, t("settings.controller.connect"))
          ),
          h("p", { class: "field-help" }, t("connect.hostHelp"))
        ),
    ui.controllerMessage ? h("p", { class: `notice notice-${ui.controllerMessage.kind}`, role: "alert" }, ui.controllerMessage.text) : null,
    facts(rows),
    state.role && !can("member") ? h("p", { class: "notice notice-info" }, t("roles.viewOnly")) : null,
    state.status === "unreachable" && state.notice ? h("p", { class: "notice notice-error" }, state.notice.text) : null,
    h(
      "div",
      { class: "button-row" },
      state.status === "unreachable"
        ? h("button", { type: "button", class: "button button-secondary", dataset: { key: "settings-retry" }, onclick: () => connect() }, icon("refresh"), t("common.retry"))
        : null,
      state.apiKey
        ? h(
            "button",
            {
              type: "button",
              class: "button button-secondary",
              dataset: { key: "settings-pair-again" },
              onclick: async () => {
                if (!window.confirm(t("settings.controller.pairAgainConfirm") + (await ownLinksNote()))) return;
                await revokeAndForget();
                state.notice = { kind: "info", text: t("connect.pairNew") };
                navigate("#/");
              },
            },
            icon("key"),
            t("settings.controller.pairAgain")
          )
        : null,
      state.apiKey
        ? h(
            "button",
            {
              type: "button",
              class: "button button-danger",
              dataset: { key: "settings-forget" },
              onclick: async () => {
                if (!window.confirm(t("settings.controller.forgetConfirm") + (await ownLinksNote()))) return;
                await revokeAndForget();
                state.notice = { kind: "info", text: t("settings.controller.forgotten") };
                navigate("#/");
              },
            },
            t("settings.controller.forget")
          )
        : null
    )
  );
}

function facts(rows) {
  return h(
    "dl",
    { class: "facts" },
    rows.map(([label, value]) => h("div", { class: "fact" }, h("dt", {}, label), h("dd", { dir: "auto" }, value)))
  );
}

// Settings → Controller, under the controller: the app's and DirectorLink's versions and, for
// admins, whether a newer DirectorLink is out, Check now and how to update (views/updates.js).
// Admins then find Backup under it: everything DirectorLink keeps, as a file locked with a
// password (ADR-042, views/backup.js).
function updatesSection() {
  const version = state.system?.bridge?.version;
  return card(
    "updates",
    "refresh",
    t("updates.label"),
    facts([[t("settings.controller.appVersion"), APP_VERSION], version ? [t("settings.controller.bridgeVersion"), version] : null, updateFact()].filter(Boolean)),
    updateCheckButton(),
    updatePanel()
  );
}

// ---- account -------------------------------------------------------------------------------

// ---- This home: linking it to the account, adding devices, inviting (docs/ACCOUNTS.md) --------

let remoteInfoLoading = false;
let remoteInfoAt = 0;
function loadRemoteInfo() {
  if (remoteInfoLoading) return;
  remoteInfoLoading = true;
  remoteInfoAt = Date.now();
  api("/v1/remote")
    .then((info) => {
      state.remoteInfo = info;
    })
    .catch((error) => {
      state.remoteInfo = { enabled: false, lock: false, missing: error?.status === 404 || error?.status === 405 };
    })
    .finally(() => {
      remoteInfoLoading = false;
      notify();
    });
}

async function linkHome() {
  ui.homeBusy = true;
  ui.homeMessage = null;
  notify();
  try {
    // The home is asked again: the address may have changed since the card was drawn.
    const info = await api("/v1/remote");
    state.remoteInfo = info;
    const homeId = info?.home_id;
    // Already this account's home (another device linked it): this device only needs its key id.
    // Another account's: linking takes it over, so ask first.
    const known = homeId ? await homeStatus(homeId) : null;
    let linked = homeId;
    let transferred = false;
    if (!known?.owner && !known?.member) {
      if (known?.claimed && !window.confirm(t("settings.account.home.takeOverConfirm"))) {
        return;
      }
      const claim = await api("/v1/remote/claim", { method: "POST" });
      if (homeId && claim.home_id !== homeId) {
        throw new Error("The controller changed while linking");
      }
      transferred = Boolean((await claimHome(claim.home_id, claim.claim_token))?.transferred);
      linked = claim.home_id;
    }
    const me = await api("/v1/api-keys/current");
    saveRemote({ home: linked, keyId: me.id });
    // The account service learns this device's key now, not only after its first remote use.
    checkInThroughAccount(true);
    ui.homeMessage = { kind: "success", text: transferred ? t("settings.account.home.takenOver") : t("settings.account.home.linkedNow") };
  } catch (error) {
    ui.homeMessage = { kind: "error", text: error?.code === "REMOTE_ACCESS_OFF" ? t("settings.account.home.turnOn") : errorText(error) };
  } finally {
    ui.homeBusy = false;
    notify();
  }
}

// The owner replaces the secret the controller connects to the relay with (docs/RELAY.md): the
// controller makes it and gives only its hash, here on the home network; the account service
// then accepts only the new one. Someone with a copy of the controller's data cannot do this.
async function replaceHomeSecret() {
  const linked = savedRemote();
  if (!linked || !window.confirm(t("settings.account.home.secretConfirm"))) return;
  ui.homeBusy = true;
  ui.homeMessage = null;
  notify();
  try {
    const prepared = await api("/v1/remote/secret", { method: "POST" });
    if (prepared?.home_id !== linked.home) {
      throw new Error("The controller at this address is not this home's");
    }
    await approveHomeSecret(linked.home, prepared.secret_sha256);
    ui.homeMessage = { kind: "success", text: t("settings.account.home.secretReplaced") };
  } catch (error) {
    ui.homeMessage = { kind: "error", text: error?.code === "OWNER_ONLY" ? t("settings.account.home.secretOwnerOnly") : errorText(error) };
  } finally {
    ui.homeBusy = false;
    notify();
  }
}

function secretPanel() {
  return [
    h("p", { class: "field-help" }, t("settings.account.home.secretHelp")),
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "button", class: "button button-secondary", dataset: { key: "replace-secret" }, disabled: Boolean(ui.homeBusy), onclick: replaceHomeSecret }, t("settings.account.home.secret"))
    ),
  ];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The person an invitation makes (1.8.0, ADR-054): an admin, or a member and what they may do.
function inviteAccess() {
  ui.inviteAccess ??= newMemberAccess();
  return ui.inviteAccess;
}

async function createInvitation({ forSelf }) {
  const email = forSelf ? state.account.user.email : (ui.drafts["invite-email"] || "").trim();
  const people = !forSelf && peopleSupported();
  const role = forSelf ? state.role || "admin" : people ? inviteAccess().role : ui.drafts["invite-role"] || "member";
  const access = people && role === "member" ? accessBody(inviteAccess()) : undefined;
  if (!EMAIL.test(email)) {
    ui.homeMessage = { kind: "error", text: t("settings.account.home.badEmail") };
    notify();
    return;
  }
  ui.homeBusy = true;
  ui.homeMessage = null;
  notify();
  ui.homeLimit = null;
  try {
    // The same invitation as a device approving another of this account makes (ADR-053).
    const invitation = await makeInvitation({ forSelf, email, role, access });
    ui.homeInvitation = { link: invitationLink(invitation.home_id, invitation), expiresAt: invitation.expires_at, forSelf, email };
    ui.inviteForm = false;
    ui.inviteAccess = null;
  } catch (error) {
    // Five devices already (1.9.0): which to remove first.
    ui.homeLimit = deviceLimitOf(error);
    ui.homeMessage = ui.homeLimit ? null : { kind: "error", text: errorText(error) };
  } finally {
    ui.homeBusy = false;
    notify();
  }
}

function draftField(key, fallback, props) {
  const input = h("input", { ...props, value: ui.drafts[key] ?? fallback, dataset: { key } });
  input.addEventListener("input", () => {
    ui.drafts[key] = input.value;
  });
  return input;
}

function invitationResult(invitation) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invitation.link);
      ui.homeMessage = { kind: "success", text: t("settings.account.home.copied") };
    } catch {
      ui.homeMessage = { kind: "error", text: t("settings.account.home.copyFailed") };
    }
    notify();
  };
  return h(
    "div",
    { class: "invitation" },
    h("p", {}, invitation.forSelf ? t("settings.account.home.scanHelp") : t("settings.account.home.sendHelp", { email: invitation.email })),
    qrCanvas(invitation.link, { label: t("settings.account.home.qrLabel") }),
    h("input", { class: "invitation-link", type: "text", readonly: true, dir: "ltr", value: invitation.link, "aria-label": t("settings.account.home.linkLabel"), onfocus: (event) => event.target.select() }),
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "button", class: "button button-primary", dataset: { key: "invitation-copy" }, onclick: copy }, t("settings.account.home.copy")),
      navigator.share
        ? h("button", { type: "button", class: "button button-secondary", dataset: { key: "invitation-share" }, onclick: () => navigator.share({ title: "DirectorLink", url: invitation.link }).catch(() => {}) }, t("settings.account.home.share"))
        : null,
      h("button", { type: "button", class: "button button-quiet", dataset: { key: "invitation-done" }, onclick: () => { ui.homeInvitation = null; ui.homeMessage = null; notify(); } }, t("common.done"))
    ),
    h("p", { class: "field-help" }, t("settings.account.home.expires", { time: formatDateTime(new Date(invitation.expiresAt)) }))
  );
}

// A device removed from the "Remove a device first" list; then Add my other device again.
async function removeForRoom(device) {
  if (ui.homeBusy || !window.confirm(t("access.revokeConfirm", { name: device.name }))) return;
  ui.homeBusy = true;
  notify();
  try {
    await api(`/v1/api-keys/${device.id}`, { method: "DELETE" });
    ui.homeLimit = null;
    ui.homeMessage = { kind: "success", text: t("users.limit.removed", { name: device.name }) };
  } catch (error) {
    ui.homeMessage = { kind: "error", text: errorText(error) };
  } finally {
    ui.homeBusy = false;
    notify();
  }
}

function invitePanel() {
  if (ui.homeInvitation) {
    return invitationResult(ui.homeInvitation);
  }
  if (ui.homeLimit) {
    return deviceLimitPanel(ui.homeLimit, { remove: removeForRoom, busy: Boolean(ui.homeBusy), key: "home-limit", dismiss: () => { ui.homeLimit = null; notify(); } });
  }
  if (ui.inviteForm) {
    // 1.8.0: an admin, or a member and what they may do (views/permissions.js); older controllers
    // have four roles per device.
    const people = peopleSupported();
    let role = null;
    if (!people) {
      const roles = ["viewer", "member", "doors", "admin"];
      role = h("select", { id: "invite-role", dataset: { key: "invite-role" } }, ...roles.map((value) => h("option", { value, selected: (ui.drafts["invite-role"] || "member") === value }, roleLabel(value))));
      role.addEventListener("change", () => {
        ui.drafts["invite-role"] = role.value;
      });
    } else if (state.scenes === null) {
      loadScenes();
    }
    return h(
      "form",
      { class: "invite-form", novalidate: true, onsubmit: (event) => { event.preventDefault(); createInvitation({ forSelf: false }); } },
      h("label", { class: "field-label", for: "invite-email" }, t("settings.account.home.email")),
      draftField("invite-email", "", { id: "invite-email", type: "email", autocomplete: "off", dir: "ltr", placeholder: "name@example.com" }),
      people ? h("div", { class: "perm-editor", dataset: { key: "invite-access" } }, permissionsEditor(inviteAccess(), { prefix: "invite", changed: notify })) : null,
      people ? null : h("label", { class: "field-label", for: "invite-role" }, t("settings.account.home.role")),
      role,
      h("p", { class: "field-help" }, t("settings.account.home.inviteHelp")),
      h(
        "div",
        { class: "button-row" },
        h("button", { type: "submit", class: "button button-primary", dataset: { key: "invite-create" }, disabled: Boolean(ui.homeBusy) }, t("settings.account.home.create")),
        h("button", { type: "button", class: "button button-quiet", onclick: () => { ui.inviteForm = false; ui.inviteAccess = null; notify(); } }, t("common.cancel"))
      )
    );
  }
  // A member (1.9.0) adds their own other device; only admins invite others, since 1.9.0 in
  // Settings → Users (Add a user, 1.12.0): Account keeps Invite someone for older controllers only.
  const admin = can("admin");
  const inviteHere = admin && !usersSupported();
  return [
    h("p", { class: "field-help" }, inviteHere ? t("settings.account.home.addHelp") : admin ? t("settings.account.home.addHelpUsers") : t("settings.account.home.addOwnHelp")),
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "button", class: "button button-secondary", dataset: { key: "add-device" }, disabled: Boolean(ui.homeBusy), onclick: () => createInvitation({ forSelf: true }) }, icon("plus"), t("settings.account.home.addDevice")),
      inviteHere
        ? h("button", { type: "button", class: "button button-secondary", dataset: { key: "invite" }, disabled: Boolean(ui.homeBusy), onclick: () => { ui.inviteForm = true; notify(); } }, icon("user"), t("settings.account.home.invite"))
        : null
    ),
  ];
}

// The controller's word that the account service no longer takes its version (GET /v1/remote's
// update_required, 1.8.0, ADR-059): remote access stays down until DirectorLink is updated. Through
// the account the app hears it as HOME_UPDATE_REQUIRED; at home only the controller can say it.
function updateRequiredNotice(info) {
  if (info?.update_required !== true) return null;
  const to = typeof info.minimum_version === "string" && /^\d+\.\d+\.\d+$/.test(info.minimum_version) ? info.minimum_version : null;
  return h("p", { class: "notice notice-error", id: "account-home-update", role: "status" }, to ? t("settings.account.home.updateRequiredTo", { to }) : t("settings.account.home.updateRequired"));
}

function homeSection() {
  const linked = savedRemote();
  const content = [];
  const atHome = state.status === "connected" && state.transport === "lan";
  if (linked) {
    content.push(h("p", { class: "field-help", id: "account-home-linked" }, t("settings.account.home.linked")));
    // At home the controller says whether its remote access stopped for an update (asked again
    // when shown a minute later: it may have been updated meanwhile).
    if (atHome) {
      if (!state.remoteInfo || Date.now() - remoteInfoAt > 60000) loadRemoteInfo();
      content.push(updateRequiredNotice(state.remoteInfo));
    }
    if (can("admin") || usersSupported()) content.push(invitePanel());
    // A Safari tab on iPhone or iPad moves to the Home Screen app (1.12.0).
    content.push(movePanel());
    // On the home network only: the controller refuses it through the account.
    if (can("admin") && !ui.homeInvitation && !ui.inviteForm && state.status === "connected" && state.transport === "lan") content.push(...secretPanel());
  } else if (IS_IOS) {
    content.push(h("p", { class: "field-help" }, t("settings.account.home.iosJoin")));
  } else if (state.status !== "connected" || state.transport !== "lan") {
    content.push(h("p", { class: "field-help" }, t("settings.account.home.connectFirst")));
  } else if (!can("admin")) {
    content.push(h("p", { class: "field-help" }, t("settings.account.home.askAdmin")));
  } else {
    const info = state.remoteInfo;
    if (!info) {
      loadRemoteInfo();
      content.push(h("p", { class: "field-help", role: "status" }, t("common.loading")));
    } else if (info.missing) {
      content.push(h("p", { class: "notice notice-info" }, t("settings.account.home.updateDriver")));
    } else if (!info.enabled) {
      content.push(
        h("p", { class: "notice notice-info" }, t("settings.account.home.turnOn")),
        h("div", { class: "button-row" }, h("button", { type: "button", class: "button button-secondary", onclick: () => { state.remoteInfo = null; notify(); } }, icon("refresh"), t("common.retry")))
      );
    } else if (!info.lock) {
      content.push(h("p", { class: "notice notice-error" }, t("settings.account.home.noLock")));
    } else if (info.update_required === true) {
      // Linking goes through remote access, which is down until DirectorLink is updated.
      content.push(updateRequiredNotice(info));
    } else {
      content.push(
        h("p", { class: "field-help" }, t("settings.account.home.linkHelp")),
        h("div", { class: "button-row" }, h("button", { type: "button", class: "button button-primary", dataset: { key: "link-home" }, disabled: Boolean(ui.homeBusy), onclick: linkHome }, t("settings.account.home.link")))
      );
    }
  }
  const message = ui.homeMessage ? h("p", { class: `notice notice-${ui.homeMessage.kind}`, role: "status" }, ui.homeMessage.text) : null;
  return h("div", { class: "account-home", id: "account-home" }, h("h3", { class: "settings-subtitle" }, t("settings.account.home.title")), message, ...content);
}

// The sign-ins the account server has set up that this account does not have yet.
function addableProviders(account) {
  return (signInProviders() || []).filter((provider) => Array.isArray(account.user.providers) && !account.user.providers.includes(provider));
}

// Signing in is optional: it is for using the home away from the home network, and for inviting
// family (docs/ACCOUNTS.md). Google and Apple show their own pages; this card only shows the result.
function accountSection() {
  const account = state.account;
  const notice = account.notice
    ? h("p", { class: `notice ${["deleted", "linked", "removed", "signedOutEverywhere"].includes(account.notice) ? "notice-success" : "notice-error"}`, role: "status" }, t(`settings.account.notice.${account.notice}`))
    : null;
  let body;
  if (account.status === "signed-in") {
    body = [
      h(
        "dl",
        { class: "facts" },
        h("div", { class: "fact" }, h("dt", {}, t("settings.account.signedInAs")), h("dd", { id: "account-email" }, account.user.email)),
        account.user.name ? h("div", { class: "fact" }, h("dt", {}, t("settings.account.name")), h("dd", {}, account.user.name)) : null,
        Array.isArray(account.user.providers) && account.user.providers.length
          ? h("div", { class: "fact" }, h("dt", {}, t("settings.account.providers")), h("dd", { id: "account-providers" }, account.user.providers.map((provider) => t(`settings.account.provider.${provider}`)).join(" · ")))
          : null
      ),
      h(
        "div",
        { class: "button-row" },
        h("button", { type: "button", class: "button button-secondary", dataset: { key: "account-sign-out" }, disabled: account.busy, onclick: () => turnAlertsOff({ quiet: true }).finally(() => signOut()) }, t("settings.account.signOut")),
        h(
          "button",
          {
            type: "button",
            class: "button button-secondary",
            dataset: { key: "account-sign-out-everywhere" },
            disabled: account.busy,
            onclick: () => {
              if (window.confirm(t("settings.account.signOutEverywhereConfirm"))) turnAlertsOff({ quiet: true }).finally(() => signOut({ everywhere: true }));
            },
          },
          t("settings.account.signOutEverywhere")
        ),
        // Signing in with another provider gives another account; adding it here, while signed in,
        // makes both sign in to this one. Only those the account server has set up.
        // Apple's button keeps one of Apple's own titles (Continue with Apple), explained below.
        ...addableProviders(account).map((provider) =>
          provider === "apple"
            ? h(
                "button",
                { type: "button", class: "button button-apple", dataset: { key: "account-add-apple" }, "aria-describedby": "account-add-apple-help", disabled: account.busy, onclick: () => signIn("#/settings/account", provider, { link: true }) },
                icon("apple"),
                t("connect.continueApple")
              )
            : h(
                "button",
                { type: "button", class: "button button-secondary", dataset: { key: `account-add-${provider}` }, disabled: account.busy, onclick: () => signIn("#/settings/account", provider, { link: true }) },
                icon("user"),
                t("settings.account.addProvider", { provider: t(`settings.account.provider.${provider}`) })
              )
        ),
        // With two, either may go (the last one stays).
        ...(Array.isArray(account.user.providers) && account.user.providers.length > 1
          ? account.user.providers.map((provider) =>
              h(
                "button",
                {
                  type: "button",
                  class: "button button-quiet",
                  dataset: { key: `account-remove-${provider}` },
                  disabled: account.busy,
                  onclick: () => {
                    const label = t(`settings.account.provider.${provider}`);
                    if (window.confirm(t("settings.account.removeProviderConfirm", { provider: label }))) removeProvider(provider);
                  },
                },
                t("settings.account.removeProvider", { provider: t(`settings.account.provider.${provider}`) })
              )
            )
          : []),
        h(
          "button",
          {
            type: "button",
            class: "button button-danger",
            dataset: { key: "account-delete" },
            disabled: account.busy,
            onclick: () => {
              if (window.confirm(t("settings.account.deleteConfirm"))) turnAlertsOff({ quiet: true }).finally(() => deleteAccount());
            },
          },
          t("settings.account.delete")
        )
      ),
      addableProviders(account).includes("apple") ? h("p", { class: "field-help", id: "account-add-apple-help" }, t("settings.account.addAppleHelp")) : null,
      homeSection(),
    ];
  } else if (account.status === "unknown" || account.status === "loading") {
    body = [h("p", { class: "field-help", role: "status" }, t("common.loading"))];
  } else {
    body = [
      h("p", { class: "field-help" }, t("settings.account.intro")),
      account.status === "unavailable" ? h("p", { class: "notice notice-error", role: "status" }, t("settings.account.unavailable")) : null,
      h(
        "div",
        { class: "button-row" },
        // Side by side and the same size (Apple's no smaller than Google's).
        h("div", { class: "sign-in-buttons" }, signInButtons({ hash: "#/settings/account", key: "account-sign-in" })),
        account.status === "unavailable"
          ? h("button", { type: "button", class: "button button-secondary", dataset: { key: "account-retry" }, onclick: loadAccount }, icon("refresh"), t("common.retry"))
          : null
      ),
    ];
  }
  return card(
    "account",
    "user",
    t("settings.account.cardTitle"),
    notice,
    ...body,
    // An invitation link that opened elsewhere (iOS opens links in Safari, not the Home Screen app).
    pasteInvitationPanel({ key: "account" }),
    h("p", { class: "field-help" }, h("a", { href: "https://directorlink.io/privacy", target: "_blank", rel: "noopener" }, t("settings.account.privacy")))
  );
}

// ---- app and about -------------------------------------------------------------------------

// Doorbell notifications: asked for only from this button, shown only while the app is open.
function doorbellNotifications() {
  if (!state.doorbells.length) return null;
  const support = notificationSupport();
  const on = notificationsOn();
  const status =
    support === "unsupported"
      ? t("settings.app.notifications.unsupported")
      : support === "denied"
        ? t("settings.app.notifications.blocked")
        : on
          ? t("settings.app.notifications.on")
          : t("settings.app.notifications.off");
  const button =
    support === "unsupported" || support === "denied"
      ? null
      : on
        ? h("button", { type: "button", class: "button button-secondary", dataset: { key: "notifications-off" }, onclick: disableNotifications }, t("settings.app.notifications.turnOff"))
        : h(
            "button",
            { type: "button", class: "button button-secondary", dataset: { key: "notifications-on" }, onclick: () => enableNotifications() },
            icon("bell"),
            t("settings.app.notifications.turnOn")
          );
  return [
    h("dl", { class: "facts" }, h("div", { class: "fact" }, h("dt", {}, t("settings.app.notifications.label")), h("dd", { id: "doorbell-notifications" }, status))),
    h("p", { class: "field-help" }, t("settings.app.notifications.help")),
    button ? h("div", { class: "button-row" }, button) : null,
  ];
}

function appSection() {
  return card(
    "app",
    "download",
    t("settings.app.cardTitle"),
    h(
      "dl",
      { class: "facts" },
      h("div", { class: "fact" }, h("dt", {}, t("settings.app.offlineCopy")), h("dd", { id: "offline-status" }, t(`settings.app.offline.${state.offlineCopy}`))),
      h("div", { class: "fact" }, h("dt", {}, t("settings.app.secure")), h("dd", {}, window.isSecureContext ? t("settings.app.secureYes") : t("settings.app.secureNo")))
    ),
    h("p", { class: "field-help" }, t("settings.app.offlineHelp")),
    h(
      "div",
      { class: "button-row" },
      state.canInstall
        ? h("button", { id: "install-button", type: "button", class: "button button-primary", dataset: { key: "install" }, onclick: installApp }, icon("download"), t("settings.app.install"))
        : null,
      h("a", { class: "button button-secondary", href: consoleUrl(), target: "_blank", rel: "noopener" }, icon("terminal"), t("settings.app.console"), icon("external"))
    ),
    doorbellNotifications()
  );
}

// The API console is its own site; a local copy of the app opens a local console
// (python -m http.server 8081 --bind 127.0.0.1 --directory console).
function consoleUrl() {
  return /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) ? "http://127.0.0.1:8081" : "https://console.directorlink.io";
}

function aboutSection() {
  return card(
    "about",
    "info",
    t("settings.about.cardTitle"),
    h("p", { class: "about-slogan" }, t("settings.about.slogan")),
    h("p", {}, t("settings.about.text")),
    h("p", { class: "about-independent" }, t("settings.about.independent")),
    h(
      "div",
      { class: "button-row" },
      h("a", { class: "button button-quiet", href: "https://github.directorlink.io", rel: "noreferrer", target: "_blank" }, t("settings.about.source"), icon("external"))
    )
  );
}
