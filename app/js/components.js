// Building blocks shared by the screens: device controls, tiles, empty and loading states.

import { attachCameraImages } from "./camera-feed.js";
import {
  blindMove,
  cancelDoorbell,
  cancelRelay,
  nudgeTarget,
  nudgedChange,
  pressDoorbell,
  pressRelay,
  setBlind,
  changesOnTheirWay,
  setFan,
  setLight,
  setRefrigerator,
  setThermostat,
  stopBlind,
} from "./controls.js";
import { dismissRing, doorbellCamera, ringTime } from "./doorbells.js";
import { h, iconButton, name } from "./dom.js";
import { fanLevel, fanSpeeds, levelChange } from "./fans.js";
import { isFavorite, toggleFavorite } from "./favorites.js";
import { formatRelative, formatTemperature, t } from "./i18n.js";
import { icon } from "./icons.js";
import { blindStateLabel, climateIsOn, fanLabel, fanSpeedLabel, fanStateLabel, labelOr, modeLabel, roomName, shownBrightness } from "./model.js";
import { FEATURE_ICONS, fridgeFeatures, zones } from "./refrigerators.js";
import { isDual, shownSetpoints } from "./setpoints.js";
import { canSetPosition, canStop, shadeView } from "./shades.js";
import { can, deviceKey, notify, state, ui } from "./state.js";

// ---- generic -------------------------------------------------------------------------------

export function inlineError(key) {
  const error = state.errors[key];
  return error ? h("p", { class: "inline-error", role: "alert" }, error.text) : null;
}

export function emptyState(iconName, title, text, action) {
  return h(
    "div",
    { class: "empty" },
    h("span", { class: "empty-icon" }, icon(iconName)),
    h("h2", { class: "empty-title" }, title),
    text ? h("p", { class: "empty-text" }, text) : null,
    action || null
  );
}

export function skeletonCards(count, className = "skeleton-card") {
  return Array.from({ length: count }, () => h("div", { class: `skeleton ${className}`, "aria-hidden": "true" }));
}

export function sectionTitle(iconName, text, extra) {
  return h("div", { class: "section-head" }, h("h2", { class: "section-title" }, icon(iconName), text), extra || null);
}

export function favoriteStar(kind, device) {
  const on = isFavorite(kind, device.id);
  return h(
    "button",
    {
      type: "button",
      class: `icon-button star ${on ? "is-favorite" : ""}`,
      "aria-pressed": String(on),
      "aria-label": t(on ? "favorites.remove" : "favorites.add", { name: device.name }),
      title: t(on ? "favorites.remove" : "favorites.add", { name: device.name }),
      dataset: { key: `${kind}:${device.id}:star` },
      onclick: () => {
        toggleFavorite(kind, device.id);
        ui.tick += 1;
        notify();
      },
    },
    icon("star")
  );
}

// Range input with a visible value. The screen is not redrawn while the thumb is held.
export function slider({ label, value, min = 0, max = 100, step = 1, key, format, onCommit, disabled }) {
  const output = h("output", { class: "slider-value" }, format(value));
  const input = h("input", {
    type: "range",
    class: "slider",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    "aria-label": label,
    "aria-valuetext": format(value),
    disabled: Boolean(disabled),
    dataset: { key },
  });
  const fill = () => input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
  fill();
  input.addEventListener("input", () => {
    output.textContent = format(Number(input.value));
    input.setAttribute("aria-valuetext", format(Number(input.value)));
    fill();
  });
  input.addEventListener("pointerdown", () => {
    ui.dragging = true;
  });
  input.addEventListener("change", () => {
    ui.dragging = false;
    onCommit(Number(input.value));
  });
  return h("div", { class: "slider-row" }, input, output);
}

window.addEventListener("pointerup", () => {
  if (ui.dragging) {
    ui.dragging = false;
    notify();
  }
});
window.addEventListener("pointercancel", () => {
  ui.dragging = false;
});

function chip(label, { pressed, key, onclick, disabled }) {
  return h(
    "button",
    {
      type: "button",
      class: `chip ${pressed ? "is-active" : ""}`,
      "aria-pressed": String(Boolean(pressed)),
      dataset: { key },
      disabled: Boolean(disabled),
      onclick,
    },
    label
  );
}

// ---- lights --------------------------------------------------------------------------------

export function lightSwitch(light) {
  const label = t("lights.toggle", { name: light.name });
  return h(
    "button",
    {
      type: "button",
      role: "switch",
      class: "switch",
      "aria-checked": String(Boolean(light.on)),
      "aria-label": label,
      dataset: { key: `light:${light.id}:switch` },
      onclick: () => setLight(light, { on: !light.on }),
    },
    h("span", { class: "switch-thumb" })
  );
}

function lightStatus(light) {
  if (!light.on) return t("lights.off");
  if (!light.dimmable) return t("lights.on");
  const level = t("lights.level", { percent: shownBrightness(light) });
  return light.brightness_reported ? level : `${level} · ${t("lights.levelNotReported")}`;
}

export function lightRow(light, { showRoom = false } = {}) {
  const key = deviceKey("light", light.id);
  return h(
    "div",
    { class: `device light ${light.on ? "is-on" : ""}` },
    h(
      "div",
      { class: "device-main" },
      h("span", { class: "device-icon" }, icon("bulb")),
      h(
        "div",
        { class: "device-text" },
        name(light.name, "span", "device-name"),
        h("span", { class: "device-meta" }, showRoom ? [name(roomName(light.room)), " · "] : null, lightStatus(light))
      ),
      favoriteStar("light", light),
      // View-only keys (role viewer) see the state without controls.
      can("member") ? lightSwitch(light) : null
    ),
    light.dimmable && can("member")
      ? slider({
          label: t("lights.brightness", { name: light.name }),
          value: shownBrightness(light),
          key: `light:${light.id}:level`,
          format: (value) => t("common.percent", { percent: value }),
          onCommit: (value) => setLight(light, { brightness: value }),
        })
      : null,
    inlineError(key)
  );
}

// ---- climate -------------------------------------------------------------------------------

function climateStatus(thermostat) {
  const parts = [];
  if (!thermostat.online) parts.push(t("climate.offline"));
  if (Number.isFinite(thermostat.current_temperature)) {
    parts.push(t("climate.now", { temperature: formatTemperature(thermostat.current_temperature) }));
  }
  if (thermostat.activity && thermostat.activity !== "idle") {
    parts.push(labelOr(`climate.activity.${thermostat.activity}`, thermostat.activity));
  }
  return parts.join(" · ");
}

// Heat and cool setpoints of a thermostat that has both: one stepper per setpoint the mode uses
// (both in auto and off, stacked on phones), or their values for view-only keys.
const SETPOINT_TEXT = {
  heat_setpoint: { name: "heat", label: "climate.heatShort", target: "climate.heatTarget", lower: "climate.lowerHeat", raise: "climate.raiseHeat" },
  cool_setpoint: { name: "cool", label: "climate.coolShort", target: "climate.coolTarget", lower: "climate.lowerCool", raise: "climate.raiseCool" },
};

function setpointSteppers(thermostat, controls) {
  const fields = shownSetpoints(thermostat);
  if (!fields.length) return null;
  if (!controls) {
    // One value (heat or cool mode) is named for that setpoint, the pair for both.
    const label = fields.length > 1 ? t("climate.setpoints") : t(SETPOINT_TEXT[fields[0]].target, { name: thermostat.name });
    return h(
      "div",
      { class: `stepper stepper-readonly ${fields.length > 1 ? "stepper-readonly-pair" : ""}`, role: "group", "aria-label": label },
      fields.map((field) =>
        h(
          "div",
          { class: "stepper-value" },
          h("span", { class: "stepper-number" }, formatTemperature(thermostat[field])),
          h("span", { class: "stepper-label" }, t(SETPOINT_TEXT[field].label))
        )
      )
    );
  }
  const steppers = fields.map((field) => {
    const text = SETPOINT_TEXT[field];
    const keyFor = (direction) => `thermostat:${thermostat.id}:${text.name}:${direction}`;
    return h(
      "div",
      { class: "stepper", role: "group", "aria-label": t(text.target, { name: thermostat.name }) },
      iconButton("minus", t(text.lower), {
        class: "stepper-button",
        dataset: { key: keyFor("down") },
        // At the limit, or the other setpoint has no room to move.
        disabled: !nudgedChange(thermostat, -1, field),
        onclick: () => nudgeTarget(thermostat, -1, field),
      }),
      h(
        "div",
        { class: "stepper-value" },
        h("output", { class: "stepper-number", "aria-live": "polite" }, formatTemperature(thermostat[field])),
        h("span", { class: "stepper-label" }, t(text.label))
      ),
      iconButton("plus", t(text.raise), {
        class: "stepper-button",
        dataset: { key: keyFor("up") },
        disabled: !nudgedChange(thermostat, 1, field),
        onclick: () => nudgeTarget(thermostat, 1, field),
      })
    );
  });
  return steppers.length > 1 ? h("div", { class: "stepper-pair", role: "group", "aria-label": t("climate.setpoints") }, steppers) : steppers[0];
}

export function thermostatCard(thermostat, { showRoom = false } = {}) {
  const key = deviceKey("thermostat", thermostat.id);
  const target = thermostat.target_temperature;
  const min = thermostat.target_temperature_min;
  const max = thermostat.target_temperature_max;
  const active = climateIsOn(thermostat);
  const controls = can("member");
  const modes = controls ? thermostat.modes || [] : [];
  const fans = controls ? thermostat.fan_speeds || [] : [];
  const fanNote = !controls && thermostat.fan_speed ? ` · ${t("climate.fan")} ${fanLabel(thermostat.fan_speed)}` : "";
  return h(
    "div",
    { class: `device climate ${active ? "is-cool" : ""}` },
    h(
      "div",
      { class: "device-main" },
      h("span", { class: "device-icon" }, icon("climate")),
      h(
        "div",
        { class: "device-text" },
        name(thermostat.name, "span", "device-name"),
        h(
          "span",
          { class: "device-meta" },
          showRoom ? [name(roomName(thermostat.room)), " · "] : null,
          modeLabel(thermostat.mode),
          climateStatus(thermostat) ? ` · ${climateStatus(thermostat)}` : "",
          fanNote
        )
      ),
      favoriteStar("thermostat", thermostat)
    ),
    isDual(thermostat)
      ? setpointSteppers(thermostat, controls)
      : !controls
      ? h(
          "div",
          { class: "stepper stepper-readonly" },
          h(
            "div",
            { class: "stepper-value" },
            h("span", { class: "stepper-number" }, formatTemperature(target)),
            h("span", { class: "stepper-label" }, t("climate.targetShort"))
          )
        )
      : h(
      "div",
      { class: "stepper", role: "group", "aria-label": t("climate.target", { name: thermostat.name }) },
      iconButton("minus", t("climate.lower"), {
        class: "stepper-button",
        dataset: { key: `thermostat:${thermostat.id}:down` },
        disabled: Number.isFinite(target) && target <= min,
        onclick: () => nudgeTarget(thermostat, -1),
      }),
      h(
        "div",
        { class: "stepper-value" },
        h("output", { class: "stepper-number", "aria-live": "polite" }, formatTemperature(target)),
        h("span", { class: "stepper-label" }, t("climate.targetShort"))
      ),
      iconButton("plus", t("climate.raise"), {
        class: "stepper-button",
        dataset: { key: `thermostat:${thermostat.id}:up` },
        disabled: Number.isFinite(target) && target >= max,
        onclick: () => nudgeTarget(thermostat, 1),
      })
    ),
    modes.length
      ? h(
          "div",
          { class: "chip-row", role: "group", "aria-label": t("climate.mode") },
          modes.map((mode) =>
            chip(modeLabel(mode), {
              pressed: thermostat.mode === mode,
              key: `thermostat:${thermostat.id}:mode:${mode}`,
              onclick: () => thermostat.mode !== mode && setThermostat(thermostat, { mode }),
            })
          )
        )
      : null,
    fans.length
      ? h(
          "div",
          { class: "chip-row chip-row-fan", role: "group", "aria-label": t("climate.fan") },
          h("span", { class: "chip-row-label" }, icon("fan"), t("climate.fan")),
          fans.map((speed) =>
            chip(fanLabel(speed), {
              pressed: thermostat.fan_speed === speed,
              key: `thermostat:${thermostat.id}:fan:${speed}`,
              onclick: () => thermostat.fan_speed !== speed && setThermostat(thermostat, { fan_speed: speed }),
            })
          )
        )
      : null,
    inlineError(key)
  );
}

// ---- fans ----------------------------------------------------------------------------------

export function fanSwitch(fan) {
  return h(
    "button",
    {
      type: "button",
      role: "switch",
      class: "switch",
      "aria-checked": String(Boolean(fan.on)),
      "aria-label": t("fans.toggle", { name: fan.name }),
      dataset: { key: `fan:${fan.id}:switch` },
      onclick: () => setFan(fan, { on: !fan.on }),
    },
    h("span", { class: "switch-thumb" })
  );
}

// On and off, and the speed: Off, Low, Medium, Medium High, High. View-only keys see the state.
export function fanRow(fan, { showRoom = false } = {}) {
  const key = deviceKey("fan", fan.id);
  const level = fanLevel(fan);
  const controls = can("member");
  return h(
    "div",
    { class: `device fan ${fan.on ? "is-on" : ""}` },
    h(
      "div",
      { class: "device-main" },
      h("span", { class: "device-icon" }, icon("fan")),
      h(
        "div",
        { class: "device-text" },
        name(fan.name, "span", "device-name"),
        h("span", { class: "device-meta" }, showRoom ? [name(roomName(fan.room)), " · "] : null, fanStateLabel(fan))
      ),
      favoriteStar("fan", fan),
      controls ? fanSwitch(fan) : null
    ),
    controls
      ? h(
          "div",
          { class: "chip-row chip-row-speed", role: "group", "aria-label": t("fans.speedOf", { name: fan.name }) },
          h("span", { class: "chip-row-label" }, t("fans.speed")),
          [0, ...fanSpeeds(fan)].map((speed) =>
            chip(speed === 0 ? t("fans.off") : fanSpeedLabel(speed), {
              pressed: level === speed,
              key: `fan:${fan.id}:speed:${speed}`,
              onclick: () => level !== speed && setFan(fan, levelChange(speed)),
            })
          )
        )
      : null,
    inlineError(key)
  );
}

// ---- refrigerators ---------------------------------------------------------------------------

// Fridge and freezer: the temperature each reports, and what it is set to.
function fridgeZones(fridge) {
  const items = zones(fridge);
  if (!items.length) return null;
  return h(
    "div",
    { class: "fridge-zones" },
    items.map((item) =>
      h(
        "div",
        { class: `fridge-zone fridge-zone-${item.zone}` },
        h("span", { class: "fridge-zone-name" }, t(`refrigerators.${item.zone}`)),
        h("span", { class: "fridge-zone-temperature" }, item.temperature !== null ? formatTemperature(item.temperature) : "–"),
        item.setpoint !== null ? h("span", { class: "fridge-zone-setpoint" }, t("refrigerators.setTo", { temperature: formatTemperature(item.setpoint) })) : null
      )
    )
  );
}

// One feature: its name, a switch (members and above; the state for viewers), and while a change
// is on its way to the refrigerator, that it is waiting for it.
function fridgeFeatureRow(fridge, feature, coming, controls) {
  const label = t(`refrigerators.features.${feature}`);
  const on = fridge[feature] === true;
  const waiting = feature in coming;
  return h(
    "li",
    { class: `fridge-feature ${on ? "is-on" : ""}` },
    h("span", { class: "fridge-feature-icon" }, icon(FEATURE_ICONS[feature])),
    h(
      "span",
      { class: "fridge-feature-text" },
      h("span", { class: "fridge-feature-name" }, label),
      waiting
        ? h("span", { class: "fridge-feature-state is-waiting", role: "status" }, t(coming[feature] ? "refrigerators.turningOn" : "refrigerators.turningOff"))
        : !controls
          ? h("span", { class: "fridge-feature-state" }, on ? t("refrigerators.on") : t("refrigerators.off"))
          : null
    ),
    controls
      ? h(
          "button",
          {
            type: "button",
            role: "switch",
            class: "switch",
            "aria-checked": String(on),
            "aria-label": t("refrigerators.toggle", { feature: label, name: fridge.name }),
            dataset: { key: `refrigerator:${fridge.id}:${feature}` },
            onclick: () => setRefrigerator(fridge, { [feature]: !on }),
          },
          h("span", { class: "switch-thumb" })
        )
      : null
  );
}

// A Samsung refrigerator (1.7.0): offline or the door open under its name, the fridge's and the
// freezer's temperatures, the water filter, and its features. A feature changes once the
// refrigerator confirms it through Samsung's cloud: the switch moves at once and says it waits.
export function refrigeratorCard(fridge, { showRoom = false } = {}) {
  const key = deviceKey("refrigerator", fridge.id);
  const controls = can("member");
  const coming = changesOnTheirWay("refrigerator", fridge.id);
  const status = [
    fridge.online ? null : t("refrigerators.offline"),
    fridge.door_open === true ? t("refrigerators.doorOpen") : fridge.door_open === false ? t("refrigerators.doorClosed") : null,
  ].filter(Boolean);
  const features = fridgeFeatures(fridge);
  return h(
    "div",
    { class: `device fridge ${fridge.door_open === true ? "is-door-open" : ""} ${fridge.online ? "" : "is-offline"}`.trim() },
    h(
      "div",
      { class: "device-main" },
      h("span", { class: "device-icon" }, icon("fridge")),
      h(
        "div",
        { class: "device-text" },
        name(fridge.name, "span", "device-name"),
        h("span", { class: "device-meta" }, showRoom ? [name(roomName(fridge.room)), status.length ? " · " : null] : null, status.join(" · "))
      ),
      favoriteStar("refrigerator", fridge)
    ),
    fridge.online ? null : h("p", { class: "fridge-note" }, t("refrigerators.offlineHint")),
    fridgeZones(fridge),
    Number.isFinite(fridge.water_filter_usage)
      ? h("p", { class: "fridge-filter" }, icon("drop"), t("refrigerators.waterFilter", { percent: Math.round(fridge.water_filter_usage) }))
      : null,
    features.length ? h("ul", { class: "fridge-features", "aria-label": t("refrigerators.featuresOf", { name: fridge.name }) }, features.map((feature) => fridgeFeatureRow(fridge, feature, coming, controls))) : null,
    inlineError(key)
  );
}

// ---- blinds --------------------------------------------------------------------------------

// A shade that only opens and closes fully has no slider, and one that cannot stop no Stop. While
// it moves, the line under its name says where to and the slider stays on the target.
export function blindRow(blind, { showRoom = false } = {}) {
  const key = deviceKey("blind", blind.id);
  const known = Number.isFinite(blind.position);
  const move = blindMove(blind.id);
  const view = shadeView(blind, move);
  const stops = canStop(blind);
  const button = (label, iconName, action, keyName) =>
    h(
      "button",
      {
        type: "button",
        class: "segment",
        dataset: { key: `blind:${blind.id}:${keyName}` },
        onclick: action,
      },
      icon(iconName),
      h("span", {}, label)
    );
  return h(
    "div",
    { class: `device blind ${known && blind.position > 0 ? "is-open" : ""} ${view.moving ? "is-moving" : ""}` },
    h(
      "div",
      { class: "device-main" },
      h("span", { class: "device-icon" }, icon("blinds")),
      h(
        "div",
        { class: "device-text" },
        name(blind.name, "span", "device-name"),
        h("span", { class: "device-meta" }, showRoom ? [name(roomName(blind.room)), " · "] : null, blindStateLabel(blind, move))
      ),
      favoriteStar("blind", blind)
    ),
    can("member")
      ? h(
          "div",
          { class: `segments ${stops ? "" : "segments-two"}`, role: "group", "aria-label": blind.name },
          button(t("blinds.close"), "arrowDown", () => setBlind(blind, 0), "close"),
          stops ? button(t("blinds.stop"), "stop", () => stopBlind(blind), "stop") : null,
          button(t("blinds.openAction"), "arrowUp", () => setBlind(blind, 100), "open")
        )
      : null,
    can("member") && canSetPosition(blind)
      ? slider({
          label: t("blinds.position", { name: blind.name }),
          value: view.slider,
          key: `blind:${blind.id}:position`,
          format: (value) => t("blinds.percentOpen", { percent: value }),
          onCommit: (value) => setBlind(blind, value),
        })
      : null,
    inlineError(key)
  );
}

// ---- doors and gates -----------------------------------------------------------------------

function relayButtonLabel(relay) {
  const stage = ui.relayStage[relay.id];
  if (stage === "confirm") return t("relays.confirm");
  if (stage === "sending") return t("relays.opening");
  if (stage === "sent") return t("relays.sent");
  return t("relays.open");
}

// Opening doors and gates needs the doors role (or admin); null otherwise.
export function relayButton(relay, { compact = false } = {}) {
  if (!can("doors")) return null;
  const stage = ui.relayStage[relay.id] || "";
  return h(
    "button",
    {
      type: "button",
      class: `relay-button ${compact ? "relay-button-compact" : ""} ${stage ? `is-${stage}` : ""}`,
      "aria-label": `${relayButtonLabel(relay)} — ${relay.name}`,
      dataset: { key: `relay:${relay.id}:open` },
      disabled: stage === "sending",
      onclick: (event) => {
        event.stopPropagation();
        pressRelay(relay);
      },
    },
    icon(stage === "sent" ? "check" : "door"),
    h("span", {}, relayButtonLabel(relay))
  );
}

export function relayRow(relay, { showRoom = false } = {}) {
  const key = deviceKey("relay", relay.id);
  const confirming = ui.relayStage[relay.id] === "confirm";
  return h(
    "div",
    { class: "device relay" },
    h(
      "div",
      { class: "device-main" },
      h("span", { class: "device-icon" }, icon("door")),
      h(
        "div",
        { class: "device-text" },
        name(relay.name, "span", "device-name"),
        h(
          "span",
          { class: "device-meta" },
          showRoom ? [name(roomName(relay.room)), " · "] : null,
          !can("doors") ? t("relays.noAccess") : confirming ? t("relays.confirmHint") : t("relays.hint")
        )
      ),
      favoriteStar("relay", relay)
    ),
    can("doors")
      ? h(
      "div",
      { class: "relay-actions" },
      relayButton(relay),
      confirming
        ? h(
            "button",
            { type: "button", class: "button button-quiet", dataset: { key: `relay:${relay.id}:cancel` }, onclick: () => cancelRelay(relay) },
            t("common.cancel")
          )
        : null
    )
      : null,
    inlineError(key)
  );
}

// ---- cameras -------------------------------------------------------------------------------

// A camera picture. width: the snapshot size to request (320 thumbnails, 640 large).
// live: refreshed about every second while on screen (the doorbell banner).
export function cameraPicture(camera, width, { live = false } = {}) {
  return h(
    "div",
    { class: "cam", dataset: { state: "loading" } },
    h("img", {
      alt: t("cameras.pictureOf", { name: camera.name }),
      dataset: { cameraId: String(camera.id), width: String(width), ...(live ? { live: "1" } : {}) },
      decoding: "async",
    }),
    h("span", { class: "cam-placeholder cam-loading", "aria-hidden": "true" }),
    h("span", { class: "cam-placeholder cam-none" }, icon("noPicture"), h("span", {}, t("cameras.noPicture"))),
    h("span", { class: "cam-placeholder cam-busy" }, icon("refresh"), h("span", {}, t("cameras.busy")))
  );
}

export function cameraTile(camera, { width = 320, onOpen, showRoom = true, large = false } = {}) {
  return h(
    "div",
    { class: `camera-tile ${large ? "camera-tile-large" : ""}` },
    h(
      "button",
      {
        type: "button",
        class: "camera-open",
        "aria-label": t("cameras.open", { name: camera.name }),
        dataset: { key: `camera:${camera.id}:open${large ? ":large" : ""}` },
        onclick: () => onOpen(camera),
      },
      cameraPicture(camera, width),
      h(
        "span",
        { class: "camera-caption" },
        name(camera.name, "span", "camera-name"),
        showRoom && camera.room ? name(roomName(camera.room), "span", "camera-room") : null
      )
    ),
    favoriteStar("camera", camera)
  );
}

// ---- doorbells -----------------------------------------------------------------------------

function doorbellButtonLabel(doorbell) {
  const stage = ui.doorbellStage[doorbell.id];
  if (stage === "confirm") return t("doorbells.confirm");
  if (stage === "sending") return t("relays.opening");
  if (stage === "sent") return t("relays.sent");
  return t("doorbells.open");
}

// Opening the gate at a doorbell needs the doors role and a doorbell that can do it.
export function doorbellButton(doorbell, { compact = false, large = false } = {}) {
  if (!can("doors") || !doorbell.can_open) return null;
  const stage = ui.doorbellStage[doorbell.id] || "";
  return h(
    "button",
    {
      type: "button",
      class: `relay-button ${compact ? "relay-button-compact" : ""} ${large ? "relay-button-large" : ""} ${stage ? `is-${stage}` : ""}`,
      "aria-label": `${doorbellButtonLabel(doorbell)} — ${doorbell.name}`,
      dataset: { key: `doorbell:${doorbell.id}:open${large ? ":banner" : ""}` },
      disabled: stage === "sending",
      onclick: (event) => {
        event.stopPropagation();
        pressDoorbell(doorbell);
      },
    },
    icon(stage === "sent" ? "check" : "door"),
    h("span", {}, doorbellButtonLabel(doorbell))
  );
}

function doorbellActions(doorbell, { large = false, extra = null } = {}) {
  const confirming = ui.doorbellStage[doorbell.id] === "confirm";
  const button = doorbellButton(doorbell, { large });
  if (!button && !extra) return null;
  return h(
    "div",
    { class: "relay-actions" },
    button,
    confirming
      ? h(
          "button",
          {
            type: "button",
            class: "button button-quiet",
            dataset: { key: `doorbell:${doorbell.id}:cancel${large ? ":banner" : ""}` },
            onclick: () => cancelDoorbell(doorbell),
          },
          t("common.cancel")
        )
      : null,
    extra
  );
}

// "Last ring: 3 minutes ago · Motion: 1 hour ago", with "Not responding" first when the
// doorbell reported a communication failure.
export function doorbellStatus(doorbell) {
  const parts = [];
  if (doorbell.connected === false) parts.push(t("doorbells.offline"));
  parts.push(doorbell.last_ring_at ? t("doorbells.lastRing", { time: formatRelative(doorbell.last_ring_at) }) : t("doorbells.noRings"));
  if (doorbell.last_motion_at) parts.push(t("doorbells.lastMotion", { time: formatRelative(doorbell.last_motion_at) }));
  return parts.join(" · ");
}

// The last few events, newest first: "Doorbell · 3 minutes ago".
export function doorbellEvents(doorbell, limit = 5) {
  const events = (Array.isArray(doorbell.events) ? doorbell.events : []).slice(0, limit);
  if (!events.length) return null;
  return h(
    "ul",
    { class: "doorbell-events", "aria-label": t("doorbells.eventsLabel", { name: doorbell.name }) },
    events.map((event) =>
      h(
        "li",
        { class: `doorbell-event event-${event.type}` },
        h("span", { class: "doorbell-event-type" }, labelOr(`doorbells.events.${event.type}`, event.type)),
        h("span", { class: "doorbell-event-time" }, formatRelative(event.at))
      )
    )
  );
}

function doorbellPicture(doorbell, { width, live = false, openCamera }) {
  const camera = doorbellCamera(doorbell);
  if (!camera) return null;
  const picture = cameraPicture(camera, width, { live });
  if (!openCamera) return picture;
  return h(
    "button",
    {
      type: "button",
      class: "camera-open doorbell-picture",
      "aria-label": t("cameras.open", { name: camera.name }),
      dataset: { key: `doorbell:${doorbell.id}:picture${live ? ":live" : ""}` },
      onclick: () => openCamera(camera),
    },
    picture
  );
}

// Room screen: the doorbell, its picture, what happened last, and Open gate.
export function doorbellCard(doorbell, { openCamera } = {}) {
  return h(
    "div",
    { class: `device doorbell ${doorbell.connected === false ? "is-offline" : ""}` },
    h(
      "div",
      { class: "device-main" },
      h("span", { class: "device-icon" }, icon("bell")),
      h("div", { class: "device-text" }, name(doorbell.name, "span", "device-name"), h("span", { class: "device-meta" }, doorbellStatus(doorbell))),
      favoriteStar("doorbell", doorbell)
    ),
    doorbellPicture(doorbell, { width: 640, openCamera }),
    doorbellActions(doorbell),
    doorbellEvents(doorbell),
    inlineError(deviceKey("doorbell", doorbell.id))
  );
}

// Home: "Someone is at the door" while a ring is recent — live picture, Open gate, Dismiss.
export function doorbellBanner(doorbell, { openCamera } = {}) {
  const titleId = `ring-${doorbell.id}-title`;
  const dismiss = h(
    "button",
    { type: "button", class: "button button-secondary", dataset: { key: `doorbell:${doorbell.id}:dismiss` }, onclick: () => dismissRing(doorbell) },
    t("doorbells.dismiss")
  );
  return h(
    "section",
    { class: "ring-banner", role: "alert", "aria-labelledby": titleId },
    h(
      "div",
      { class: "ring-head" },
      h("span", { class: "ring-icon", "aria-hidden": "true" }, icon("bell")),
      h(
        "div",
        { class: "ring-text" },
        h("h2", { id: titleId, class: "ring-title" }, t("doorbells.atTheDoor"), " — ", name(doorbell.name, "span", "ring-name")),
        h(
          "p",
          { class: "ring-meta" },
          doorbell.room ? [name(roomName(doorbell.room)), " · "] : null,
          t("doorbells.rang", { time: formatRelative(ringTime(doorbell)) })
        )
      )
    ),
    doorbellPicture(doorbell, { width: 640, live: true, openCamera }),
    doorbellActions(doorbell, { large: true, extra: dismiss }),
    doorbell.can_open && !can("doors") ? h("p", { class: "ring-note" }, t("doorbells.noAccess")) : null,
    inlineError(deviceKey("doorbell", doorbell.id))
  );
}

// Other screens: one line that leads to the banner on Home.
export function ringNotice(doorbells) {
  if (!doorbells.length) return null;
  return h(
    "a",
    { class: "banner banner-ring", href: "#/", role: "alert", dataset: { key: "ring-notice" } },
    icon("bell"),
    h("span", {}, t("doorbells.atTheDoor"), " — ", doorbells.map((doorbell) => doorbell.name).join(", ")),
    h("span", { class: "banner-action" }, t("doorbells.show"))
  );
}

export { attachCameraImages };
