// DirectorLink app: hash router, renderer and start-up. Screens live in js/views/.
//
// API calls made by the modules (see api/openapi.yaml): "/v1/system", "/v1/rooms", "/v1/devices",
// "/v1/lights", "/v1/thermostats", "/v1/fans", "/v1/blinds", "/v1/cameras", "/v1/relays", "/v1/scenes", "/v1/schedules",
// "/v1/weather", "/v1/calendar", "/v1/alarm" (read-only), "/v1/music" (Sonos), "/v1/auth/pair" —
// device changes use method: "PATCH" and are confirmed by re-reading.

import { providersStatus, signInProviders, startAccount } from "./js/account.js";
import { alarmSignature, startAlarm } from "./js/alarm.js";
import { alertsSignature } from "./js/alerts.js";
import { keepCalendar, loadCalendar } from "./js/calendar.js";
import { attachCameraImages, closeFullView, openFullView } from "./js/camera-feed.js";
import { ringNotice } from "./js/components.js";
import { h, iconButton, replaceKeeping } from "./js/dom.js";
import { notificationSupport, notificationsOn, ringingDoorbells } from "./js/doorbells.js";
import { currentLanguage, setLanguage, t } from "./js/i18n.js";
import { icon } from "./js/icons.js";
import { startPwa } from "./js/pwa.js";
import { joinView, storeInvitation } from "./js/views/join.js";
import { deviceJoinSignature, deviceRequestNotice, watchDeviceRequests } from "./js/views/device-join.js";
import { musicRouteChanged, musicSignature, startMusic } from "./js/music.js";
import { accessView, resetAccess } from "./js/views/access.js";
import { HISTORY_ROW_KEY, historyAllowed, historyView, resetHistory } from "./js/views/history.js";
import { savedRemote } from "./js/remote.js";
import { connect, reachable, restoreSaved, whenConnected } from "./js/session.js";
import { saveProfilePrefs, syncProfile } from "./js/profile.js";
import { loadScenes } from "./js/scenes.js";
import { loadSchedules } from "./js/schedules.js";
import { findDevice, state, subscribe, ui } from "./js/state.js";
import { applyTheme, palettePreference, setPalette, setTextSize, setTheme, textSizePreference, themePreference, watchSystemTheme } from "./js/theme.js";
import { camerasView } from "./js/views/cameras.js";
import { commandRouteChanged, commandSignature } from "./js/views/command.js";
import { climateView } from "./js/views/climate.js";
import { favoritesPicker, homeView } from "./js/views/home.js";
import { roomView } from "./js/views/room.js";
import { doorbellView, enterDoorbell } from "./js/views/doorbell.js";
import { resetSceneEditor, sceneEditorView, sceneReturnKey, scenesView } from "./js/views/scenes.js";
import { leaveSceneLink, sceneLinksView, sceneLinkView } from "./js/views/scene-links.js";
import { askLinkView, leaveAskLink, leaveOpenRequest, openRequestView } from "./js/views/ask-links.js";
import { enterSchedules, keepWeatherFresh, resetScheduleEditor, scheduleEditorView, schedulesView } from "./js/views/schedules.js";
import { SETTINGS_PAGES, resetCalendarSettings, settingsRowKey, settingsView } from "./js/views/settings.js";
import { checkUpdates, updatesSignature } from "./js/views/updates.js";

const view = document.querySelector("#view");
const tabbar = document.querySelector("#tabbar");
const TABS = [
  { name: "home", href: "#/", icon: "home" },
  { name: "scenes", href: "#/scenes", icon: "scene" },
  { name: "cameras", href: "#/cameras", icon: "camera" },
  { name: "climate", href: "#/climate", icon: "climate" },
  { name: "settings", href: "#/settings", icon: "settings" },
];

// ---- routing -------------------------------------------------------------------------------

function parseRoute() {
  const parts = (window.location.hash.replace(/^#/, "") || "/").split("/").filter(Boolean);
  // An invitation link: keep its secret for this tab and take it out of the address at once.
  if (parts[0] === "join") {
    if (parts[1]) {
      storeInvitation(parts[1]);
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#/join`);
    }
    return { name: "join", tab: "settings" };
  }
  if (parts[0] === "room" && /^\d+$/.test(parts[1] || "")) {
    return { name: "room", id: Number(parts[1]), tab: "home" };
  }
  // A doorbell's screen (1.11.0, ADR-078): where its ring's notification opens the app.
  if (parts[0] === "doorbell" && /^\d+$/.test(parts[1] || "")) {
    return { name: "doorbell", id: Number(parts[1]), tab: "home" };
  }
  // A scene's link for the phone's own automations, and the list of them (ADR-051).
  if (parts[0] === "scene" && /^[0-9a-f]{8}$/.test(parts[1] || "") && parts[2] === "link") {
    return { name: "sceneLink", id: parts[1], tab: "scenes" };
  }
  if (parts[0] === "links") {
    return { name: "sceneLinks", tab: "scenes" };
  }
  // Ask before opening (ADR-058): a door's link, and the question an alert's tap opens.
  if (parts[0] === "door" && /^\d+$/.test(parts[1] || "") && parts[2] === "ask") {
    return { name: "askLink", id: Number(parts[1]), tab: "home" };
  }
  if (parts[0] === "open" && /^\d+$/.test(parts[1] || "") && /^[0-9a-f]{16}$/.test(parts[2] || "") && /^\d+$/.test(parts[3] || "")) {
    return { name: "openRequest", id: Number(parts[1]), request: parts[2], until: Number(parts[3]), tab: "home" };
  }
  if (parts[0] === "scene" && /^(new|[0-9a-f]{8})$/.test(parts[1] || "")) {
    const editing = parts[2] === "edit" && /^\d+$/.test(parts[3] || "") ? Number(parts[3]) : null;
    return { name: "scene", id: parts[1], adding: parts[2] === "add", editing, tab: "scenes" };
  }
  if (parts[0] === "schedule" && /^(new|[0-9a-f]{8})$/.test(parts[1] || "")) {
    return { name: "schedule", id: parts[1], tab: "scenes" };
  }
  if (parts[0] === "schedules") {
    return { name: "schedules", tab: "scenes" };
  }
  // A camera alert's tap (sw.js, ADR-056): Cameras, with that camera's full view.
  if (parts[0] === "cameras" && /^\d+$/.test(parts[1] || "")) {
    return { name: "cameras", tab: "cameras", camera: Number(parts[1]) };
  }
  if (["scenes", "cameras", "climate"].includes(parts[0])) {
    return { name: parts[0], tab: parts[0] };
  }
  // Settings → Controller → History (ADR-046); alert notifications open it too.
  if (parts[0] === "settings" && parts[1] === "history") {
    return { name: "history", tab: "settings" };
  }
  // Settings' list, or one of its pages (#/settings/rooms); an unknown page is the list.
  if (parts[0] === "settings") {
    return { name: "settings", page: SETTINGS_PAGES.includes(parts[1]) ? parts[1] : null, tab: "settings" };
  }
  if (parts[0] === "access") {
    return { name: "access", tab: "settings" };
  }
  return { name: "home", tab: "home" };
}

let route = parseRoute();

export function navigate(hash) {
  if (window.location.hash === hash || (hash === "#/" && !window.location.hash)) {
    render(true);
  } else {
    window.location.hash = hash;
  }
}

window.addEventListener("hashchange", () => {
  // Entries reached inside the app: the Back button can use history.back().
  window.history.replaceState({ directorlinkInApp: true }, "");
  const previous = route;
  route = parseRoute();
  ui.cameFrom = previous.name;
  // People and devices loads fresh each time it is opened; a scene opens as it was saved.
  if (route.name === "access" && previous.name !== "access") resetAccess();
  if (route.name === "history" && previous.name !== "history") resetHistory();
  if (route.name === "scene" && (previous.name !== "scene" || previous.id !== route.id)) resetSceneEditor();
  if (route.name === "schedule" && (previous.name !== "schedule" || previous.id !== route.id)) resetScheduleEditor();
  // A new link's secret is shown only on its screen, until it is left.
  if (previous.name === "sceneLink" && (route.name !== "sceneLink" || route.id !== previous.id)) leaveSceneLink();
  if (previous.name === "askLink" && (route.name !== "askLink" || route.id !== previous.id)) leaveAskLink();
  if (previous.name === "openRequest" && route.name !== "openRequest") leaveOpenRequest();
  // Shabbat and holidays opens with the controller's settings.
  if (route.page === "calendar" && previous.page !== "calendar") resetCalendarSettings();
  // The weather is read while Schedules is open.
  if ((route.name === "schedules" || route.name === "schedule") && previous.name !== "schedules" && previous.name !== "schedule") enterSchedules();
  // The Hebrew date on Home (Schedules reads the calendar too).
  if (route.name === "home" && previous.name !== "home") loadCalendar();
  // A ring's screen opened before the doorbells are read: its picture at once.
  if (route.name === "doorbell" && (previous.name !== "doorbell" || previous.id !== route.id)) enterDoorbell(route.id);
  // Sonos: Home and a room are read every 5 s while shown.
  musicRouteChanged(route);
  // Say or type a command: away from Home, Home's microphone stops, and nothing it heard is done.
  commandRouteChanged(route);
  closeFullView();
  render(true);
  window.scrollTo(0, 0);
  // Back on Settings' list from one of its pages, the row that opened it has the focus (from
  // History, its link on the Controller page; in the scene editor, the action just changed);
  // otherwise the new screen's heading, for keyboard and screen-reader users.
  const rowKey =
    route.name === "settings" && !route.page
      ? settingsRowKey(previous)
      : route.page === "controller" && previous.name === "history"
        ? HISTORY_ROW_KEY
        : sceneReturnKey(previous, route);
  const row = rowKey ? [...view.querySelectorAll("[data-key]")].find((item) => item.dataset.key === rowKey && !item.disabled) : null;
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
  } else {
    view.querySelector(".page-title")?.focus({ preventScroll: true });
  }
});

// ---- dialogs -------------------------------------------------------------------------------

const cameraDialog = h("dialog", { id: "camera-dialog", class: "dialog camera-dialog", "aria-labelledby": "camera-dialog-title" });
const pickerDialog = h("dialog", { id: "favorites-dialog", class: "dialog picker-dialog", "aria-labelledby": "favorites-dialog-title" });
let cameraParts = null;
let pickerBody = null;

function buildDialogs() {
  const title = h("h2", { id: "camera-dialog-title", class: "dialog-title", dir: "auto" });
  const image = h("img", { id: "camera-dialog-image", alt: "" });
  const status = h("p", { id: "camera-dialog-status", class: "dialog-status", role: "status" });
  cameraParts = { titleElement: title, image, status };
  cameraDialog.replaceChildren(
    h("div", { class: "dialog-head" }, title, iconButton("close", t("common.close"), { onclick: closeFullView })),
    h(
      "div",
      { class: "cam cam-full", dataset: { state: "loading" } },
      image,
      h("span", { class: "cam-placeholder cam-loading", "aria-hidden": "true" }),
      h("span", { class: "cam-placeholder cam-none" }, icon("noPicture"), h("span", {}, t("cameras.noPicture"))),
      h("span", { class: "cam-placeholder cam-busy" }, icon("refresh"), h("span", {}, t("cameras.busy")))
    ),
    status
  );

  pickerBody = h("div", { class: "picker" });
  pickerDialog.replaceChildren(
    h(
      "div",
      { class: "dialog-head" },
      h("h2", { id: "favorites-dialog-title", class: "dialog-title" }, t("favorites.pickerTitle")),
      iconButton("close", t("common.close"), { onclick: () => pickerDialog.close() })
    ),
    h("p", { class: "field-help" }, t("favorites.pickerHelp")),
    pickerBody,
    h("div", { class: "dialog-foot" }, h("button", { type: "button", class: "button button-primary button-wide", onclick: () => pickerDialog.close() }, t("common.done")))
  );
}

cameraDialog.addEventListener("close", closeFullView);
// A tap on the backdrop closes a dialog.
for (const dialog of [cameraDialog, pickerDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
pickerDialog.addEventListener("close", () => render(true));
document.body.append(cameraDialog, pickerDialog);

function openCamera(camera) {
  openFullView(cameraDialog, camera, cameraParts);
}

// #/cameras/<id>: once the cameras are read, that camera's full view, and the address becomes
// #/cameras (Back does not open it again). A camera this device does not have shows Cameras.
function openRouteCamera() {
  if (!route.camera || !state.loaded) return;
  const camera = findDevice("camera", route.camera);
  route = { name: "cameras", tab: "cameras" };
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#/cameras`);
  if (!camera) return;
  ui.featuredCamera = camera.id;
  openCamera(camera);
}

function openFavoritesPicker() {
  pickerBody.replaceChildren(...favoritesPicker());
  pickerDialog.showModal();
}

// ---- rendering -----------------------------------------------------------------------------

let lastSignature = "";

// Everything a screen shows. Unchanged data means no redraw, so polling every 10 s does not
// disturb focus, screen readers or text being typed.
function signature() {
  return JSON.stringify([
    route,
    currentLanguage(),
    palettePreference(),
    themePreference(),
    textSizePreference(),
    state.status,
    state.notice,
    // The pairing screen's warning (Cancel only clears it).
    state.pairingUnprotected,
    state.loaded,
    state.system,
    // A newer DirectorLink release, and the one dismissed on Home (kept in localStorage).
    updatesSignature(),
    state.rooms,
    state.lights,
    state.thermostats,
    state.fans,
    state.blinds,
    state.cameras,
    state.relays,
    state.doorbells,
    state.refrigerators,
    // The alarm (read-only), and the seconds an entry or exit delay has left.
    alarmSignature(),
    // The Sonos rooms, their pictures and favorites (js/music.js).
    musicSignature(),
    // Rings stop being recent, and "3 minutes ago" moves on, without new data.
    ringingDoorbells().map((doorbell) => doorbell.id),
    state.doorbells.length ? Math.floor(Date.now() / 60000) : 0,
    state.role,
    // What this person may do (1.8.0, ADR-054).
    state.access,
    state.account,
    // The sign-ins the account server has set up (account.js), once asked.
    signInProviders(),
    providersStatus(),
    // Remote access (remote.js): the connection in use (at home: the Direct HTTPS name or the
    // address, 1.12.0), the controller's answer, and whether this device is linked (kept in
    // localStorage, so it is read here).
    state.transport,
    state.lanRoute,
    state.remoteInfo,
    savedRemote(),
    // Alerts on this device (js/alerts.js): on, possible, being switched, what it said.
    alertsSignature(),
    // Joining from another device (ADR-053): this device's request, or the account's new devices'.
    deviceJoinSignature(),
    // Say or type a command (ADR-063): what it understood, asks or did, and the microphone.
    commandSignature(),
    state.devices,
    state.sentBrightness,
    Object.fromEntries(Object.entries(state.errors).map(([key, value]) => [key, value.text])),
    state.online,
    state.canInstall,
    state.offlineCopy,
    ui.filter,
    ui.find,
    ui.offRuns,
    ui.editFavorites,
    ui.relayStage,
    ui.doorbellStage,
    // A doorbell's screen (1.11.0): an admin linking doors, its picture asked for early.
    route.name === "doorbell" ? [ui.doorbellLinks, ui.ringCamera] : 0,
    ui.tick,
    ui.roomMessages,
    ui.controllerMessage,
    ui.featuredCamera,
    ui.homeBusy,
    ui.homeMessage,
    ui.homeInvitation,
    ui.inviteForm,
    ui.inviteAccess,
    ui.joinBusy,
    ui.joinMessage,
    ui.joinWait,
    state.profile,
    ui.roomOrderMessage,
    state.scenes,
    state.scenesUnsupported,
    ui.sceneRuns,
    ui.scenesMessage,
    state.schedules,
    state.schedulesPaused,
    state.schedulesUnsupported,
    state.weather,
    state.calendar,
    ui.schedulesMessage,
    // Times being typed are left out: the editor does not rebuild a time field while it is used.
    route.name === "schedule" ? { ...ui.scheduleEditor, at: undefined, from: undefined, to: undefined } : 0,
    // "Ran today", "next: tomorrow" move on with the day.
    route.name === "schedules" ? Math.floor(Date.now() / 60000) : 0,
    // The scene's name is typed into a field: it is left out, so typing is never redrawn.
    route.name === "scene" ? { ...ui.sceneEditor, name: undefined } : 0,
    // Scene links (views/scene-links.js): on the scenes, a scene and its link (labels being typed
    // are kept outside `ui`).
    ["scenes", "scene", "sceneLink", "sceneLinks"].includes(route.name) ? ui.sceneLinks : 0,
    // Ask before opening (views/ask-links.js): a door's link, the list, and the question.
    ["askLink", "sceneLinks", "openRequest"].includes(route.name) ? [ui.askLinks, ui.openRequest] : 0,
    route.name === "access" ? ui.access : 0,
    route.name === "history" ? ui.history : 0,
    route.name === "settings" ? ui.calendarSettings : 0,
    // Settings → Controller → Backup (its passwords and file are not in `ui`: views/backup.js).
    route.name === "settings" ? ui.backup : 0,
    // Its automatic backups to the account (passwords in views/cloud-backup.js, not in `ui`).
    route.name === "settings" ? ui.autoBackup : 0,
    // Direct connection at home (1.12.0, views/direct.js).
    route.name === "settings" ? ui.directHttps : 0,
    // "Last update", on Settings → Controller only: the other pages are not redrawn by every poll.
    route.name === "settings" && route.page === "controller" ? state.lastUpdated?.getTime() : 0,
    route.name === "settings" ? [notificationSupport(), notificationsOn()] : 0,
  ]);
}

function screen() {
  const actions = { openCamera, openFavoritesPicker, navigate };
  switch (route.name) {
    case "room":
      return roomView(route.id, actions);
    case "doorbell":
      return doorbellView(route.id, actions);
    case "scenes":
      return scenesView(actions);
    case "schedules":
      return schedulesView(actions);
    case "schedule":
      return scheduleEditorView(route.id, actions);
    case "scene":
      return sceneEditorView(route.id, route.adding, actions, route.editing);
    case "sceneLink":
      return sceneLinkView(route.id, actions);
    case "sceneLinks":
      return sceneLinksView(actions);
    case "askLink":
      return askLinkView(route.id, actions);
    case "openRequest":
      return openRequestView(route.id, route.request, route.until);
    case "cameras":
      return camerasView(actions);
    case "climate":
      return climateView(actions);
    case "join":
      return joinView(actions);
    case "access":
      return accessView(actions);
    case "history":
      if (historyAllowed()) return historyView(actions);
    // falls through: anyone but an admin (a notification may open it) gets Settings' list.
    case "settings":
      return settingsView({
        page: route.page,
        navigate,
        onPalette: (palette) => {
          setPalette(palette);
          saveProfilePrefs({ palette });
          render(true);
        },
        onTheme: (theme) => {
          setTheme(theme);
          saveProfilePrefs({ theme });
          render(true);
        },
        onLanguage: async (language) => {
          await setLanguage(language);
          saveProfilePrefs({ language });
          applyLanguage();
        },
        // This device only (ADR-067): not in the profile.
        onTextSize: (size) => {
          setTextSize(size);
          render(true);
        },
      });
    default:
      return homeView(actions);
  }
}

// Keeps focus, the caret and open <details> across a redraw (elements carry data-key).
function captureUi() {
  const active = document.activeElement;
  const key = view.contains(active) ? active?.dataset?.key : null;
  let selection = null;
  if (key && typeof active.selectionStart === "number") {
    try {
      selection = [active.selectionStart, active.selectionEnd];
    } catch {
      selection = null;
    }
  }
  const open = new Set([...view.querySelectorAll("details[data-key]")].filter((item) => item.open).map((item) => item.dataset.key));
  return { key, selection, open };
}

function restoreUi({ key, selection, open }) {
  for (const details of view.querySelectorAll("details[data-key]")) {
    if (open.has(details.dataset.key)) details.open = true;
  }
  if (!key) return;
  const target = [...view.querySelectorAll("[data-key]")].find((item) => item.dataset.key === key);
  // Still focused (Home's command field stays in the page): nothing to restore, and nothing that
  // could end the keyboard's composition.
  if (target && !target.disabled && target !== document.activeElement) {
    target.focus({ preventScroll: true });
    if (selection && typeof target.setSelectionRange === "function") {
      try {
        target.setSelectionRange(selection[0], selection[1]);
      } catch {
        // Not a text field.
      }
    }
  }
}

function render(force = false) {
  if (ui.dragging || ui.reordering) return; // redrawn when the slider or the room is let go
  const current = signature();
  if (!force && current === lastSignature) return;
  lastSignature = current;

  const saved = captureUi();
  const content = [screen()].flat(Infinity).filter(Boolean);
  // Away from Home, a ring still shows: one line under the header that leads to the banner (not on
  // the doorbell's own screen, which shows it).
  if (route.name !== "home" && route.name !== "doorbell" && state.apiKey) {
    const notice = ringNotice(ringingDoorbells());
    if (notice) content.splice(1, 0, notice);
  }
  // A new device of the account asks to join this home (ADR-053): under the header, on every screen.
  const request = deviceRequestNotice();
  if (request) content.splice(1, 0, request);
  // What stays the same element (Home's command field) stays in the page.
  replaceKeeping(view, content);
  restoreUi(saved);
  attachCameraImages(view);
  openRouteCamera();
  updateTabbar();
  if (pickerDialog.open) {
    pickerBody.replaceChildren(...favoritesPicker());
  }
  document.title = route.name === "home" ? "DirectorLink" : `${view.querySelector(".page-title")?.textContent || ""} · DirectorLink`;
}

function updateTabbar() {
  for (const link of tabbar.querySelectorAll("a[data-tab]")) {
    if (link.dataset.tab === route.tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function buildTabbar() {
  tabbar.setAttribute("aria-label", t("nav.label"));
  tabbar.replaceChildren(
    h("span", { class: "rail-brand", "aria-hidden": "true" }, h("img", { src: "/icons/icon.svg", alt: "", width: "36", height: "36" })),
    ...TABS.map((tab) =>
      h("a", { href: tab.href, class: "tab", dataset: { tab: tab.name } }, icon(tab.icon), h("span", { class: "tab-label" }, t(`nav.${tab.name}`)))
    )
  );
  updateTabbar();
}

function applyLanguage() {
  document.querySelector(".skip-link").textContent = t("nav.skip");
  buildTabbar();
  buildDialogs();
  render(true);
}

// ---- start ---------------------------------------------------------------------------------

subscribe(() => render());
// The person's profile: language, theme and palette from their other devices apply here too.
whenConnected(() => syncProfile(applyLanguage));
// The home's scenes, for the Scenes tab and the ones shown on Home.
whenConnected(loadScenes);
whenConnected(loadSchedules);
// Members and admins: the alarm, read-only, when the installer turned it on; then every 10 s.
whenConnected(startAlarm);
// The Jewish calendar, while it is on in Composer: read now, then every 10 minutes (js/calendar.js).
whenConnected(keepCalendar);
// Sonos, while an installer turned it on: every room now, then the screen shown every 5 s.
whenConnected(() => startMusic(route));
// Admins: whether a newer DirectorLink is out (GitHub, at most every 12 hours; js/updates.js).
whenConnected(checkUpdates);
// Opened on Schedules (a reload): the weather once connected.
whenConnected(() => {
  if (route.name === "schedules" || route.name === "schedule") keepWeatherFresh();
});
watchSystemTheme(() => render(true));
window.addEventListener("pointerup", () => window.setTimeout(() => render(), 0));

async function start() {
  applyTheme();
  await setLanguage();
  restoreSaved();
  applyLanguage();
  startPwa();
  startAccount();
  watchDeviceRequests();
  // The host and API key are kept in this browser, so a reload reconnects without pairing again.
  if (reachable()) {
    // Opened on a doorbell's screen (a ring's notification): its picture is asked for with the rest.
    if (route.name === "doorbell") enterDoorbell(route.id);
    connect();
  }
}

start();
