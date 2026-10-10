// A doorbell's own screen (1.11.0, ADR-078): #/doorbell/<id>, where its ring's notification opens the
// app (sw.js), also when the app was closed. Its live picture first, then a big "Open <door>" for each
// door or gate at it that this user may open (the door's own Open, with its two taps), the doorbell's
// own Open (a DoorBird's button), what happened last; for admins, the doors at it: the ones its
// controller's relay put there, and the ones they link (a gate on a KNX relay), with Remove.
// A member without door access sees the picture and no Open, as at the door itself.

import { cameraPicture, doorbellButton, doorbellEvents, doorbellStatus, emptyState, inlineError } from "../components.js";
import { prefetchPicture } from "../camera-feed.js";
import { cancelDoorbell } from "../controls.js";
import { h, name } from "../dom.js";
import { doorButtons, doorNote, doorsAt, doorsKnown, keptRingCamera, linkedIds, setLinkedDoors } from "../doorbell-doors.js";
import { doorbellCamera, ringIsActive, ringTime } from "../doorbells.js";
import { formatRelative, t } from "../i18n.js";
import { icon } from "../icons.js";
import { roomName } from "../model.js";
import { reachable } from "../session.js";
import { can, deviceKey, findDevice, notify, state, ui } from "../state.js";
import { isLoading, notReadyState, offlineBanner, pageHeader, staleBanner } from "./common.js";

// The picture's size on this screen (as the ring banner's).
const WIDTH = 640;

// Opened by a ring's notification before the doorbells are read: its picture is asked for at once,
// with the camera this device kept for it (js/doorbell-doors.js), ahead of everything else.
export async function enterDoorbell(id) {
  if (!reachable() || state.loaded) return;
  const camera = await keptRingCamera(id);
  if (!camera || state.loaded) return;
  ui.ringCamera = { doorbell: id, camera };
  notify();
  prefetchPicture(camera, WIDTH);
}

function picture(doorbell, openCamera) {
  const camera = doorbellCamera(doorbell);
  if (!camera) return null;
  return h(
    "button",
    {
      type: "button",
      class: "camera-open doorbell-picture",
      "aria-label": t("cameras.open", { name: camera.name }),
      dataset: { key: `doorbell:${doorbell.id}:screen-picture` },
      onclick: () => openCamera(camera),
    },
    cameraPicture(camera, WIDTH, { live: true })
  );
}

// The doorbell's own Open (a DoorBird's button), with Cancel while it waits for its second tap.
function ownOpen(doorbell) {
  const button = doorbellButton(doorbell, { large: true });
  if (!button) return [];
  return [
    button,
    ui.doorbellStage[doorbell.id] === "confirm"
      ? h("button", { type: "button", class: "button button-quiet", dataset: { key: `doorbell:${doorbell.id}:cancel:screen` }, onclick: () => cancelDoorbell(doorbell) }, t("common.cancel"))
      : null,
  ];
}

export function doorbellView(id, { openCamera }) {
  const doorbell = findDevice("doorbell", id);
  const header = pageHeader({ title: doorbell ? doorbell.name : t("doorbells.screenTitle"), back: "#/", titleDir: "auto" });
  const notReady = notReadyState();
  if (notReady) return [header, offlineBanner(), notReady];
  if (!state.loaded) {
    // The picture this device kept the camera of, at once; the rest once the doorbells are read.
    const kept = ui.ringCamera?.doorbell === id ? ui.ringCamera.camera : null;
    return [
      header,
      h(
        "section",
        { class: "doorbell-screen", "aria-busy": "true" },
        kept ? h("div", { class: "doorbell-picture" }, cameraPicture({ id: kept, name: t("doorbells.screenTitle") }, WIDTH, { live: true })) : h("div", { class: "skeleton skeleton-camera-large", "aria-hidden": "true" }),
        h("div", { class: "skeleton skeleton-chip doorbell-screen-skeleton", "aria-hidden": "true" }),
        h("p", { class: "visually-hidden", role: "status" }, isLoading() ? t("common.loading") : "")
      ),
    ];
  }
  if (!doorbell) {
    return [header, emptyState("bell", t("doorbells.notFoundTitle"), t("doorbells.notFoundText"), h("a", { class: "button button-primary", href: "#/" }, t("rooms.backHome")))];
  }
  const ringing = ringIsActive(doorbell);
  const actions = [...doorButtons(doorbell), ...ownOpen(doorbell)];
  return [
    header,
    offlineBanner(),
    staleBanner(),
    h(
      "section",
      { class: `doorbell-screen ${ringing ? "is-ringing" : ""}`.trim() },
      h(
        "p",
        { class: "doorbell-screen-meta" },
        ringing ? [h("strong", {}, t("doorbells.atTheDoor")), " · ", t("doorbells.rang", { time: formatRelative(ringTime(doorbell)) })] : doorbellStatus(doorbell),
        doorbell.room ? [" · ", name(roomName(doorbell.room))] : null
      ),
      picture(doorbell, openCamera),
      actions.length ? h("div", { class: "relay-actions doorbell-screen-actions" }, actions) : null,
      doorNote(doorbell) ? h("p", { class: "muted-note" }, doorNote(doorbell)) : null,
      inlineError(deviceKey("doorbell", doorbell.id)),
      ...openableErrors(doorbell),
      doorbellEvents(doorbell)
    ),
    can("admin") && doorsKnown(doorbell) ? linksCard(doorbell) : null,
  ];
}

// A door's error (HOLD_NOT_ALLOWED, Door Control off) shows under its button, as in its room.
function openableErrors(doorbell) {
  return doorsAt(doorbell).map((item) => inlineError(deviceKey("relay", item.id)));
}

// ---- an admin's links ------------------------------------------------------------------------------

function linksCard(doorbell) {
  const links = ui.doorbellLinks?.id === doorbell.id ? ui.doorbellLinks : { busy: false, message: null };
  const at = doorsAt(doorbell);
  const shown = new Set(at.map((item) => item.id));
  const others = state.relays.filter((relay) => !shown.has(relay.id));
  const manual = linkedIds(doorbell);
  const choice = others.some((relay) => relay.id === links.choice) ? links.choice : others[0]?.id;
  const select = others.length
    ? h(
        "select",
        { id: "doorbell-link-choice", dataset: { key: `doorbell:${doorbell.id}:link-choice` }, disabled: links.busy },
        others.map((relay) => h("option", { value: String(relay.id), selected: relay.id === choice }, relay.room ? `${relay.name} · ${roomName(relay.room)}` : relay.name))
      )
    : null;
  select?.addEventListener("change", () => {
    ui.doorbellLinks = { ...links, id: doorbell.id, choice: Number(select.value) };
  });
  return h(
    "section",
    { class: "card settings-card doorbell-links", dataset: { key: `doorbell:${doorbell.id}:links` } },
    h("h2", { class: "settings-title" }, icon("door"), t("doorbells.links.title")),
    h("p", { class: "field-help" }, t("doorbells.links.help")),
    at.length
      ? h(
          "ul",
          { class: "doorbell-link-list" },
          at.map((item) =>
            h(
              "li",
              { class: "doorbell-link" },
              h(
                "span",
                { class: "doorbell-link-text" },
                name(item.door.name, "span", "doorbell-link-name"),
                h("span", { class: "field-help" }, item.link === "automatic" ? t("doorbells.links.automatic") : t("doorbells.links.manual"))
              ),
              item.link === "manual"
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "button button-quiet button-small",
                      "aria-label": t("doorbells.links.removeLabel", { name: item.door.name }),
                      dataset: { key: `doorbell:${doorbell.id}:unlink:${item.id}` },
                      disabled: links.busy,
                      onclick: () => setLinkedDoors(doorbell, manual.filter((id) => id !== item.id)),
                    },
                    t("doorbells.links.remove")
                  )
                : null
            )
          )
        )
      : h("p", { class: "muted-note" }, t("doorbells.links.none")),
    select
      ? h(
          "div",
          { class: "doorbell-link-add" },
          h("label", { class: "field-label", for: "doorbell-link-choice" }, t("doorbells.links.add")),
          h(
            "div",
            { class: "input-row" },
            select,
            h(
              "button",
              {
                type: "button",
                class: "button button-secondary",
                dataset: { key: `doorbell:${doorbell.id}:link` },
                disabled: links.busy,
                onclick: () => {
                  const id = Number(select.value || choice);
                  if (Number.isInteger(id) && id > 0) setLinkedDoors(doorbell, [...manual, id]);
                },
              },
              icon("plus"),
              t("doorbells.links.addButton")
            )
          )
        )
      : null,
    links.message ? h("p", { class: "notice notice-error", role: "status" }, links.message) : null
  );
}
