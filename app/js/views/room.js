// Room screen: every device in one room, grouped by kind. Empty sections are hidden.

import {
  blindRow,
  cameraTile,
  doorbellCard,
  emptyState,
  fanRow,
  lightRow,
  refrigeratorCard,
  relayRow,
  sectionTitle,
  skeletonCards,
  thermostatCard,
} from "../components.js";
import { allOff } from "../controls.js";
import { h, name } from "../dom.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { NO_ROOM, climateIsOn, fanIsOn, lightIsOn, roomById, roomGroup, roomName } from "../model.js";
import { can } from "../state.js";
import { isLoading, notReadyState, offlineBanner, pageHeader, staleBanner } from "./common.js";
import { musicCards } from "./music.js";

export function roomView(roomId, { openCamera }) {
  const id = Number(roomId);
  const notReady = notReadyState();
  if (notReady || isLoading()) {
    return [
      pageHeader({ title: t("rooms.title"), back: "#/" }),
      notReady || h("div", { class: "section-stack", "aria-busy": "true" }, skeletonCards(3)),
    ];
  }
  const room = id === NO_ROOM ? { id: NO_ROOM, name: t("rooms.noRoom") } : roomById(id);
  if (!room) {
    return [
      pageHeader({ title: t("rooms.title"), back: "#/" }),
      emptyState("rooms", t("rooms.notFoundTitle"), t("rooms.notFoundText"), h("a", { class: "button button-primary", href: "#/" }, t("rooms.backHome"))),
    ];
  }

  const group = roomGroup(id);
  const anythingOn = group.lights.some(lightIsOn) || group.thermostats.some(climateIsOn) || group.fans.some(fanIsOn);
  // With fans (1.2.0), All off turns them off too.
  const allOffHint = group.fans.length ? t("rooms.allOffHintFans") : t("rooms.allOffHint");
  const actions = [];
  if ((group.lights.length || group.thermostats.length || group.fans.length) && can("member")) {
    actions.push(
      h(
        "button",
        {
          type: "button",
          class: "button button-secondary button-small",
          disabled: !anythingOn,
          title: allOffHint,
          "aria-describedby": "all-off-hint",
          dataset: { key: "all-off" },
          onclick: () => allOff(group),
        },
        icon("power"),
        t("rooms.allOff")
      ),
      h("span", { id: "all-off-hint", class: "visually-hidden" }, allOffHint)
    );
  }

  const sections = [];
  if (group.lights.length) {
    sections.push(section("lights", "bulb", t("sections.lights"), group.lights.map((light) => lightRow(light))));
  }
  if (group.thermostats.length) {
    sections.push(section("climate", "climate", t("sections.climate"), group.thermostats.map((item) => thermostatCard(item))));
  }
  // Fans, on drivers that have /v1/fans (1.2.0).
  if (group.fans.length) {
    sections.push(section("fans", "fan", t("sections.fans"), group.fans.map((fan) => fanRow(fan))));
  }
  if (group.blinds.length) {
    sections.push(section("blinds", "blinds", t("sections.blinds"), group.blinds.map((blind) => blindRow(blind))));
  }
  // Samsung refrigerators, on drivers that have /v1/refrigerators (1.7.0).
  if (group.refrigerators?.length) {
    sections.push(section("refrigerators", "fridge", t("sections.refrigerators"), group.refrigerators.map((fridge) => refrigeratorCard(fridge))));
  }
  // Doorbells (DoorBird), on drivers that have /v1/doorbells; their camera shows here, not twice.
  if (group.doorbells.length) {
    sections.push(section("doorbells", "bell", t("sections.doorbells"), group.doorbells.map((doorbell) => doorbellCard(doorbell, { openCamera }))));
  }
  // Sonos rooms shown here (1.5.0, ADR-044), with an installer's Sonos On.
  if (group.music.length) {
    sections.push(section("music", "music", t("sections.music"), musicCards(group.music)));
  }
  // Doors and gates (relays), on drivers that have /v1/relays.
  if (group.relays.length) {
    sections.push(section("relays", "door", t("sections.relays"), group.relays.map((relay) => relayRow(relay))));
  }
  const doorbellCameras = new Set(group.doorbells.map((doorbell) => doorbell.camera?.id).filter(Boolean));
  const cameras = group.cameras.filter((camera) => !doorbellCameras.has(camera.id));
  if (cameras.length) {
    sections.push(
      section(
        "cameras",
        "camera",
        t("sections.cameras"),
        h("div", { class: "camera-grid" }, cameras.map((camera) => cameraTile(camera, { width: 320, onOpen: openCamera, showRoom: false })))
      )
    );
  }
  if (group.others.length) {
    sections.push(
      h(
        "details",
        { class: "others", dataset: { key: `others:${id}` } },
        h("summary", {}, t("rooms.otherDevices", { count: group.others.length })),
        h("p", { class: "muted-note" }, t("rooms.otherDevicesHint")),
        h("ul", { class: "others-list" }, group.others.map((device) => h("li", {}, name(device.name))))
      )
    );
  }

  return [
    pageHeader({ title: roomName(room), back: "#/", titleDir: "auto" }),
    actions.length ? h("div", { class: "toolbar" }, actions) : null,
    // View-only keys: the state is shown, the controls are not.
    !can("member") && (group.lights.length || group.thermostats.length || group.fans.length || group.blinds.length || group.refrigerators?.length)
      ? h("p", { class: "view-only-hint" }, icon("info"), h("span", {}, t("roles.viewOnlyHint")))
      : null,
    offlineBanner(),
    staleBanner(),
    sections.length
      ? h("div", { class: "room-sections" }, sections)
      : emptyState("rooms", t("rooms.emptyTitle"), t("rooms.emptyText")),
  ];
}

function section(kind, iconName, title, content) {
  return h("section", { class: `room-section section-${kind}` }, sectionTitle(iconName, title), h("div", { class: "device-list" }, content));
}
