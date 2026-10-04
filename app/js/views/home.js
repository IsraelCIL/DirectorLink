// Home: the Hebrew date (with the Jewish calendar on), summary chips, the favorites strip and the
// room cards; a list a chip filters can turn off what it shows (turn-off.js).

import { calendarOn, homeLine } from "../calendar.js";
import { cameraPicture, doorbellBanner, emptyState, favoriteStar, relayButton, skeletonCards } from "../components.js";
import { blindMove, setFan, setLight } from "../controls.js";
import { h, iconButton, name } from "../dom.js";
import { ringIsActive, ringingDoorbells } from "../doorbells.js";
import { favoriteDevices, moveFavorite, toggleFavorite } from "../favorites.js";
import { formatRelative, formatTemperature, t } from "../i18n.js";
import { icon } from "../icons.js";
import {
  blindIsOpen,
  blindStateLabel,
  climateIsOn,
  deviceRoomId,
  fanIsOn,
  fanStateLabel,
  fridgeStateLabel,
  lightIsOn,
  matchesFilter,
  modeLabel,
  roomName,
  shownBrightness,
  summaryCounts,
  targetText,
  visibleRooms,
} from "../model.js";
import { installApp } from "../pwa.js";
import { runScene } from "../scenes.js";
import { isDual } from "../setpoints.js";
import { can, notify, state, ui } from "../state.js";
import { cancelTurnOff, offTargets, pressTurnOff, resetTurnOff } from "../turn-off.js";
import { connectScreen } from "./connect.js";
import { alarmSection } from "./alarm.js";
import { musicHomeSection } from "./music.js";
import { isLoading, offlineBanner, pageHeader, staleBanner, unreachableState } from "./common.js";
import { updateBanner } from "./updates.js";

export function homeView({ openCamera, openFavoritesPicker }) {
  const header = pageHeader({
    title: t("home.title"),
    actions: state.canInstall
      ? [iconButton("download", t("settings.app.install"), { class: "install-button", dataset: { key: "install-home" }, onclick: installApp })]
      : [],
  });
  if (state.status === "setup" || (!state.apiKey && state.status === "connecting")) {
    return [header, offlineBanner(), connectScreen()];
  }
  if (isLoading()) {
    return [
      header,
      h("div", { class: "summary", "aria-hidden": "true" }, skeletonCards(3, "skeleton-chip")),
      h("h2", { class: "section-title" }, t("home.rooms")),
      h("div", { class: "room-grid", "aria-busy": "true" }, skeletonCards(4)),
      h("p", { class: "visually-hidden", role: "status" }, t("common.loading")),
    ];
  }
  if (!state.loaded) {
    return [header, offlineBanner(), unreachableState()];
  }
  return [
    header,
    // Someone rang within the last 2 minutes: first thing on the screen.
    ringingDoorbells().map((doorbell) => doorbellBanner(doorbell, { openCamera })),
    offlineBanner(),
    staleBanner(),
    // Admins: a newer DirectorLink is out, until dismissed for that version.
    updateBanner(),
    calendarLine(),
    // Members and admins: the alarm, read-only, when the installer turned it on (ADR-038).
    alarmSection(),
    summaryChips(),
    // Sonos (1.5.0, ADR-044): what plays, one line per group.
    musicHomeSection(),
    scenesRow(),
    favoritesSection({ openCamera, openFavoritesPicker }),
    roomsSection(),
  ];
}

// ---- the Hebrew date -----------------------------------------------------------------------

// With the Jewish calendar on in Composer: today's Hebrew date (the next day's from sunset), its
// holidays and the week's reading.
function calendarLine() {
  const text = calendarOn() ? homeLine() : "";
  if (!text) return null;
  return h("p", { class: "calendar-line" }, icon("candles"), h("span", {}, text));
}

// ---- summary -------------------------------------------------------------------------------

function summaryChips() {
  const counts = summaryCounts();
  const chips = [];
  const add = (filter, iconName, label, active) =>
    chips.push(
      h(
        "button",
        {
          type: "button",
          class: `summary-chip summary-${filter} ${active ? "has-on" : ""} ${ui.filter === filter ? "is-active" : ""}`,
          "aria-pressed": String(ui.filter === filter),
          dataset: { key: `filter:${filter}` },
          onclick: () => {
            ui.filter = ui.filter === filter ? null : filter;
            resetTurnOff();
            notify();
          },
        },
        icon(iconName),
        h("span", {}, label)
      )
    );
  if (state.lights.length) {
    add("lights", "bulb", counts.lightsOn ? t("home.lightsOn", { count: counts.lightsOn }) : t("home.lightsAllOff"), counts.lightsOn > 0);
  }
  if (state.thermostats.length) {
    add("climate", "climate", counts.climateOn ? t("home.climateOn", { count: counts.climateOn }) : t("home.climateAllOff"), counts.climateOn > 0);
  }
  if (state.blinds.length) {
    add("blinds", "blinds", counts.blindsOpen ? t("home.blindsOpen", { count: counts.blindsOpen }) : t("home.blindsAllClosed"), counts.blindsOpen > 0);
  }
  if (!chips.length) return null;
  return h("div", { class: "summary", role: "group", "aria-label": t("home.filterLabel") }, chips);
}

// ---- scenes shown on Home ------------------------------------------------------------------

function scenesRow() {
  const scenes = (state.scenes || []).filter((scene) => scene.show_on_home);
  if (!scenes.length || !can("member")) return null;
  return h(
    "section",
    { class: "home-section", "aria-labelledby": "home-scenes-title" },
    h(
      "div",
      { class: "section-head" },
      h("h2", { id: "home-scenes-title", class: "section-title" }, icon("scene"), t("scenes.homeTitle")),
      h("a", { class: "button button-quiet button-small", href: "#/scenes", dataset: { key: "home-scenes-all" } }, t("scenes.allLink"))
    ),
    h("div", { class: "home-scenes" }, scenes.map(sceneButton))
  );
}

function sceneButton(scene) {
  const run = ui.sceneRuns[scene.id];
  const ran = run && (run.stage === "done" || run.stage === "partial");
  return h(
    "button",
    {
      type: "button",
      class: `scene-chip ${run ? `is-${run.stage}` : ""}`,
      title: t("scenes.runLabel", { name: scene.name }),
      disabled: run?.stage === "running",
      dataset: { key: `home-scene:${scene.id}` },
      onclick: () => runScene(scene),
    },
    h("span", { class: "scene-chip-icon", "aria-hidden": "true" }, icon(ran ? "check" : run?.stage === "confirm" ? "door" : scene.icon || "bulb")),
    h(
      "span",
      { class: "scene-chip-text" },
      name(scene.name, "span", "scene-chip-name"),
      run ? h("span", { class: "scene-chip-state", role: "status" }, run.stage === "running" ? t("scenes.running") : run.stage === "confirm" ? t("scenes.tapAgain") : run.text) : null
    )
  );
}

// ---- favorites -----------------------------------------------------------------------------

function favoritesSection({ openCamera, openFavoritesPicker }) {
  const items = favoriteDevices();
  const editing = ui.editFavorites;
  const hasDevices =
    state.lights.length + state.thermostats.length + state.fans.length + state.blinds.length + state.cameras.length + state.relays.length + state.doorbells.length + state.refrigerators.length > 0;
  if (!hasDevices) return null;

  const toggleEdit = h(
    "button",
    {
      type: "button",
      class: "button button-quiet button-small",
      "aria-pressed": String(editing),
      dataset: { key: "favorites-edit" },
      onclick: () => {
        ui.editFavorites = !editing;
        notify();
      },
    },
    icon(editing ? "check" : "edit"),
    editing ? t("common.done") : t("common.edit")
  );

  let body;
  if (!items.length && !editing) {
    body = h(
      "div",
      { class: "favorites-empty" },
      icon("star"),
      h("p", {}, t("favorites.emptyText")),
      h(
        "button",
        { type: "button", class: "button button-secondary button-small", dataset: { key: "favorites-add-empty" }, onclick: openFavoritesPicker },
        icon("plus"),
        t("favorites.addDevices")
      )
    );
  } else {
    const tiles = items.map((item, index) => favoriteTile(item, { editing, index, count: items.length, openCamera }));
    if (editing) {
      tiles.push(
        h(
          "button",
          { type: "button", class: "fav-tile fav-add", dataset: { key: "favorites-add" }, onclick: openFavoritesPicker },
          icon("plus"),
          h("span", {}, t("favorites.addDevices"))
        )
      );
    }
    body = h("div", { class: `favorites ${editing ? "is-editing" : ""}`, role: "list" }, tiles.map((tile) => h("div", { role: "listitem", class: "fav-item" }, tile)));
  }

  return h(
    "section",
    { class: "home-section", "aria-labelledby": "favorites-title" },
    h("div", { class: "section-head" }, h("h2", { id: "favorites-title", class: "section-title" }, icon("star"), t("favorites.title")), toggleEdit),
    body
  );
}

function favoriteTile({ entry, kind, device }, { editing, index, count, openCamera }) {
  const room = device.room ? name(roomName(device.room), "span", "fav-room") : null;
  let content;
  let stateClass = "";
  if (kind === "light") {
    stateClass = device.on ? "is-on" : "";
    content = [
      h("span", { class: "fav-icon" }, icon("bulb")),
      name(device.name, "span", "fav-name"),
      room,
      h("span", { class: "fav-state" }, device.on ? (device.dimmable ? t("lights.level", { percent: shownBrightness(device) }) : t("lights.on")) : t("lights.off")),
    ];
  } else if (kind === "thermostat") {
    stateClass = climateIsOn(device) ? "is-cool" : "";
    const parts = [
      Number.isFinite(device.current_temperature) ? formatTemperature(device.current_temperature) : null,
      climateIsOn(device) ? `${modeLabel(device.mode)} ${targetText(device)}` : modeLabel(device.mode),
    ].filter(Boolean);
    content = [
      h("span", { class: "fav-icon" }, icon("climate")),
      name(device.name, "span", "fav-name"),
      room,
      isDual(device)
        ? // "21.7° · Auto 20°–24.4°" is wider than a phone tile: the parts go on two lines rather
          // than cut the range off.
          h(
            "span",
            { class: "fav-state fav-state-parts" },
            parts.map((part, index) => [index ? " " : null, h("span", {}, index < parts.length - 1 ? `${part}\u00a0·` : part)])
          )
        : h("span", { class: "fav-state" }, parts.join(" · ")),
    ];
  } else if (kind === "fan") {
    stateClass = device.on ? "is-on" : "";
    content = [h("span", { class: "fav-icon" }, icon("fan")), name(device.name, "span", "fav-name"), room, h("span", { class: "fav-state" }, fanStateLabel(device))];
  } else if (kind === "blind") {
    stateClass = blindIsOpen(device) ? "is-open" : "";
    content = [h("span", { class: "fav-icon" }, icon("blinds")), name(device.name, "span", "fav-name"), room, h("span", { class: "fav-state" }, blindStateLabel(device, blindMove(device.id)))];
  } else if (kind === "refrigerator") {
    // The door open stands out, like a ring; offline says so.
    stateClass = device.door_open === true ? "is-door-open" : "";
    content = [h("span", { class: "fav-icon" }, icon("fridge")), name(device.name, "span", "fav-name"), room, h("span", { class: "fav-state" }, fridgeStateLabel(device))];
  } else if (kind === "camera") {
    content = [cameraPicture(device, 320), h("span", { class: "fav-caption" }, name(device.name, "span", "fav-name"))];
    stateClass = "fav-camera";
  } else if (kind === "relay") {
    content = [h("span", { class: "fav-icon" }, icon("door")), name(device.name, "span", "fav-name"), room];
    stateClass = "fav-relay";
  } else if (kind === "doorbell") {
    stateClass = ringIsActive(device) ? "is-ringing" : "";
    content = [
      h("span", { class: "fav-icon" }, icon("bell")),
      name(device.name, "span", "fav-name"),
      room,
      h(
        "span",
        { class: "fav-state" },
        device.last_ring_at ? t("doorbells.lastRing", { time: formatRelative(device.last_ring_at) }) : t("doorbells.noRings")
      ),
    ];
  }

  if (editing) {
    return h(
      "div",
      { class: `fav-tile ${stateClass} is-editing` },
      h("div", { class: "fav-body" }, content),
      h(
        "div",
        { class: "fav-edit" },
        iconButton("moveBack", t("favorites.moveEarlier", { name: device.name }), {
          dataset: { key: `${entry}:earlier` },
          disabled: index === 0,
          onclick: () => {
            moveFavorite(entry, -1);
            ui.tick += 1;
            notify();
          },
        }),
        iconButton("close", t("favorites.remove", { name: device.name }), {
          class: "danger",
          dataset: { key: `${entry}:remove` },
          onclick: () => {
            toggleFavorite(kind, device.id);
            ui.tick += 1;
            notify();
          },
        }),
        iconButton("moveForward", t("favorites.moveLater", { name: device.name }), {
          dataset: { key: `${entry}:later` },
          disabled: index === count - 1,
          onclick: () => {
            moveFavorite(entry, 1);
            ui.tick += 1;
            notify();
          },
        })
      )
    );
  }

  // Lights and fans switch on and off with a tap on their tile.
  if ((kind === "light" || kind === "fan") && can("member")) {
    return h(
      "button",
      {
        type: "button",
        class: `fav-tile ${stateClass}`,
        "aria-pressed": String(Boolean(device.on)),
        dataset: { key: `${entry}:tile` },
        onclick: () => (kind === "fan" ? setFan : setLight)(device, { on: !device.on }),
      },
      content,
      state.errors[entry] ? h("span", { class: "fav-error", role: "alert" }, state.errors[entry].text) : null
    );
  }
  if (kind === "camera") {
    return h(
      "button",
      { type: "button", class: `fav-tile ${stateClass}`, "aria-label": t("cameras.open", { name: device.name }), dataset: { key: `${entry}:tile` }, onclick: () => openCamera(device) },
      content
    );
  }
  if (kind === "relay") {
    return h(
      "div",
      { class: `fav-tile ${stateClass}` },
      content,
      relayButton(device, { compact: true }),
      state.errors[entry] ? h("span", { class: "fav-error", role: "alert" }, state.errors[entry].text) : null
    );
  }
  return h("a", { class: `fav-tile ${stateClass}`, href: `#/room/${deviceRoomId(device)}`, dataset: { key: `${entry}:tile` } }, content);
}

// ---- rooms ---------------------------------------------------------------------------------

function roomStatus(group) {
  const parts = [];
  if (group.lights.length) {
    const on = group.lights.filter(lightIsOn).length;
    parts.push(on ? t("rooms.lightsOnOf", { on, count: group.lights.length }) : t("rooms.lightsOff", { count: group.lights.length }));
  }
  for (const thermostat of group.thermostats) {
    parts.push(
      climateIsOn(thermostat)
        ? t("rooms.climateOn", { mode: modeLabel(thermostat.mode), temperature: targetText(thermostat) })
        : t("rooms.climateOff")
    );
  }
  if (group.fans.length) {
    const on = group.fans.filter(fanIsOn).length;
    parts.push(on ? t("rooms.fansOnOf", { on, count: group.fans.length }) : t("rooms.fansOff", { count: group.fans.length }));
  }
  if (group.blinds.length) {
    const open = group.blinds.filter(blindIsOpen).length;
    parts.push(
      group.blinds.length === 1
        ? blindStateLabel(group.blinds[0], blindMove(group.blinds[0].id))
        : open
          ? t("rooms.blindsOpen", { count: open })
          : t("rooms.blindsClosed")
    );
  }
  if (group.cameras.length) parts.push(t("rooms.cameras", { count: group.cameras.length }));
  if (group.relays.length) parts.push(t("rooms.relays", { count: group.relays.length }));
  if (group.doorbells.length) parts.push(t("rooms.doorbells", { count: group.doorbells.length }));
  // A refrigerator says so only when its door is open.
  if (group.refrigerators?.some((fridge) => fridge.door_open === true)) parts.push(t("rooms.fridgeDoorOpen"));
  if (group.music.some((item) => item.state === "playing")) parts.push(t("rooms.musicPlaying"));
  return parts.join(" · ");
}

function roomCard({ room, group }) {
  const lightsOn = group.lights.some(lightIsOn);
  const climateOn = group.thermostats.some(climateIsOn);
  const fansOn = group.fans.some(fanIsOn);
  const blindsOpen = group.blinds.some(blindIsOpen);
  const badges = [
    group.lights.length ? h("span", { class: `badge ${lightsOn ? "badge-on" : ""}` }, icon("bulb")) : null,
    group.thermostats.length ? h("span", { class: `badge ${climateOn ? "badge-cool" : ""}` }, icon("climate")) : null,
    group.fans.length ? h("span", { class: `badge ${fansOn ? "badge-on" : ""}` }, icon("fan")) : null,
    group.blinds.length ? h("span", { class: `badge ${blindsOpen ? "badge-open" : ""}` }, icon("blinds")) : null,
    group.cameras.length ? h("span", { class: "badge" }, icon("camera")) : null,
    group.relays.length ? h("span", { class: "badge" }, icon("door")) : null,
    group.doorbells.length ? h("span", { class: `badge ${group.doorbells.some((doorbell) => ringIsActive(doorbell)) ? "badge-ring" : ""}` }, icon("bell")) : null,
    group.refrigerators?.length ? h("span", { class: `badge ${group.refrigerators.some((fridge) => fridge.door_open === true) ? "badge-ring" : ""}` }, icon("fridge")) : null,
    group.music.length ? h("span", { class: `badge ${group.music.some((item) => item.state === "playing") ? "badge-on" : ""}` }, icon("music")) : null,
  ];
  return h(
    "a",
    { class: `room-card ${lightsOn ? "is-on" : ""}`, href: `#/room/${room.id}`, dataset: { key: `room:${room.id}` } },
    h("span", { class: "room-card-top" }, h("span", { class: "badges", "aria-hidden": "true" }, badges), icon("chevronForward", "room-chevron")),
    name(roomName(room), "span", "room-name"),
    h("span", { class: "room-status" }, roomStatus(group))
  );
}

function roomsSection() {
  const rooms = visibleRooms();
  if (!rooms.length) {
    return emptyState("rooms", t("home.noDevicesTitle"), t("home.noDevicesText"));
  }
  const shown = rooms.filter((entry) => matchesFilter(entry.group, ui.filter));
  const filter = ui.filter;
  const run = filter ? ui.offRuns[filter] : null;
  const count = filter ? offTargets(filter).length : 0;
  // While the second tap is awaited, Cancel stands where Show all was.
  const confirming = run?.stage === "confirm" && count > 0 && can("member");
  return h(
    "section",
    { class: "home-section", "aria-labelledby": "rooms-title" },
    h(
      "div",
      { class: `section-head ${filter ? "is-filtered" : ""}` },
      h("h2", { id: "rooms-title", class: "section-title" }, icon("rooms"), filter ? t(`home.filtered.${filter}`) : t("home.rooms")),
      filter
        ? h(
            "div",
            { class: "filter-actions" },
            turnOffControls(filter, run, count),
            confirming
              ? null
              : h(
                  "button",
                  { type: "button", class: "button button-quiet button-small", dataset: { key: "filter-clear" }, onclick: () => { ui.filter = null; resetTurnOff(); notify(); } },
                  icon("close"),
                  t("home.showAll")
                )
          )
        : null
    ),
    filter ? turnOffNote(filter, run) : null,
    shown.length
      ? h("div", { class: "room-grid" }, shown.map(roomCard))
      : h("p", { class: "muted-note" }, t("home.noMatch"))
  );
}

// ---- turn off all (turn-off.js) ------------------------------------------------------------

// Members and above, while something in the list is on or open: "Turn off all 7", then "Tap again
// to turn off 7" with Cancel, "Turning off…" and "Done". Viewers get none of it.
function turnOffControls(filter, run, count) {
  if (!can("member")) return null;
  const stage = run?.stage;
  if (stage === "done") {
    return h("span", { class: "turn-off-state is-done", role: "status" }, icon("check"), t("home.off.done"));
  }
  const iconName = filter === "blinds" ? "blinds" : "power";
  if (stage === "running") {
    return h(
      "button",
      { type: "button", class: "button button-secondary button-small turn-off-button", disabled: true, dataset: { key: "turn-off" } },
      icon(iconName),
      h("span", { role: "status" }, t(`home.off.running.${filter}`))
    );
  }
  if (!count) return null;
  const confirming = stage === "confirm";
  const hint = confirming ? t("relays.confirmHint") : t(`home.off.hint.${filter}`);
  return [
    h(
      "button",
      {
        type: "button",
        class: `button button-secondary button-small turn-off-button ${confirming ? "is-confirm" : ""}`,
        title: hint,
        "aria-describedby": "turn-off-hint",
        dataset: { key: "turn-off" },
        onclick: () => pressTurnOff(filter),
      },
      icon(iconName),
      h("span", {}, confirming ? t(`home.off.confirm.${filter}`, { count }) : t(`home.off.button.${filter}`, { count }))
    ),
    h("span", { id: "turn-off-hint", class: "visually-hidden" }, hint),
    confirming
      ? h("button", { type: "button", class: "button button-quiet button-small", dataset: { key: "turn-off-cancel" }, onclick: () => cancelTurnOff(filter) }, t("common.cancel"))
      : null,
  ];
}

// What did not turn off, by name and room, or why nothing did.
function turnOffNote(filter, run) {
  if (run?.stage === "error") {
    return h("p", { class: "notice notice-error turn-off-note", role: "alert" }, run.text);
  }
  if (run?.stage !== "partial") return null;
  return h(
    "div",
    { class: "notice notice-error turn-off-note", role: "alert" },
    h("p", {}, t(`home.off.failed.${filter}`, { count: run.count })),
    h(
      "ul",
      { class: "turn-off-failed" },
      run.failed.map((device) => h("li", {}, name(device.name, "span", "turn-off-device"), " · ", name(roomName(device.room), "span", "turn-off-room"))),
      run.more > 0 ? h("li", {}, t("scenes.more", { count: run.more })) : null
    )
  );
}

// Favorites picker (dialog body): every device with a star.
export function favoritesPicker() {
  const groups = [
    ["lights", "light", "bulb"],
    ["climate", "thermostat", "climate"],
    ["fans", "fan", "fan"],
    ["blinds", "blind", "blinds"],
    ["relays", "relay", "door"],
    ["doorbells", "doorbell", "bell"],
    ["refrigerators", "refrigerator", "fridge"],
    ["cameras", "camera", "camera"],
  ];
  const lists = {
    light: state.lights,
    thermostat: state.thermostats,
    fan: state.fans,
    blind: state.blinds,
    relay: state.relays,
    doorbell: state.doorbells,
    refrigerator: state.refrigerators,
    camera: state.cameras,
  };
  return groups
    .filter(([, kind]) => lists[kind].length)
    .map(([section, kind, iconName]) =>
      h(
        "section",
        { class: "picker-group" },
        h("h3", { class: "picker-title" }, icon(iconName), t(`sections.${section}`)),
        h(
          "ul",
          { class: "picker-list" },
          lists[kind].map((device) =>
            h(
              "li",
              { class: "picker-item" },
              h("span", { class: "picker-text" }, name(device.name, "span", "device-name"), name(roomName(device.room), "span", "device-meta")),
              favoriteStar(kind, device)
            )
          )
        )
      )
    );
}
