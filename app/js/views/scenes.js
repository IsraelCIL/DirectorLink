// Scenes (#/scenes) and the scene editor (#/scene/new, #/scene/<id>; admins). The list runs a
// scene with one tap. The editor builds a scene from actions: where (a room or the whole home),
// what (lights, AC, fans, blinds, doors and gates, refrigerators, all of them or chosen ones; the
// Sonos music) and what to do;
// "Add an action" has its own address (#/scene/<id>/add), so Back returns to the editor; so has
// changing one (#/scene/<id>/edit/<index>, 1.6.0), the same screen filled in from the action.
// "Copy the house as it is now" makes the actions from the current state; "Try it now" runs them
// unsaved.

import { emptyState, skeletonCards, slider } from "../components.js";
import { h, iconButton, name } from "../dom.js";
import { formatNumber, formatTemperature, t } from "../i18n.js";
import { icon } from "../icons.js";
import { fanSpeeds } from "../fans.js";
import { FEATURE_ICONS, featuresOf, stepFeature, stepSet } from "../refrigerators.js";
import { blindStateLabel, deviceRoomId, fanLabel, fanSpeedLabel, fanStateLabel, fridgeStateLabel, modeLabel, roomById, roomName, shownBrightness, targetText } from "../model.js";
import {
  MAX_DEVICE_IDS,
  MAX_STEPS,
  SCENE_ICONS,
  STEP_ICONS,
  STEP_TYPES,
  copyHouse,
  currentSteps,
  devicesOfType,
  findScene,
  isolate,
  loadScenes,
  resultText,
  runScene,
  sceneSummary,
  stepAction,
  stepWhat,
  stepWhere,
} from "../scenes.js";
import { api, errorText, noteForbidden, refreshDevices, roleLabel } from "../session.js";
import { isDual, setpointGap, withSetpoint } from "../setpoints.js";
import { sceneBlindChoices } from "../shades.js";
import { can, notify, state, ui } from "../state.js";
import { isLoading, notReadyState, offlineBanner, pageHeader, staleBanner } from "./common.js";
import { scenesNav } from "./schedules.js";
import { confirmLinkLoss, deleteQuestion, doorLinkWarning, linksRow, sceneLinkSection } from "./scene-links.js";
import { linksSupported, loadLinks } from "../scene-links.js";

const MAX_SCENES = 50;
const MESSAGE_MS = 6000;
const MODE_ORDER = ["off", "cool", "heat", "auto"];

function notice(message) {
  return message ? h("p", { class: `notice notice-${message.kind}`, role: message.kind === "error" ? "alert" : "status" }, message.text) : null;
}

// A message on the scenes list (saved, deleted) that goes away by itself.
function flash(text) {
  const stamp = Date.now();
  ui.scenesMessage = { kind: "success", text, stamp };
  window.setTimeout(() => {
    if (ui.scenesMessage?.stamp === stamp) {
      ui.scenesMessage = null;
      notify();
    }
  }, MESSAGE_MS);
}

// Leaves an editor screen for `hash`: back through the history when the app came from there, so
// Back afterwards does not reopen what was just left.
// `from`: the screen the editor was opened from; back through the history only when that is where
// `hash` leads, else the editor is replaced by `hash`.
function leave(hash, from) {
  if (window.history.state?.directorlinkInApp && from === hash.replace(/^#\//, "").split("/")[0]) window.history.back();
  else window.location.replace(hash);
}

// Not ready: loading, or the first read failed (then with Retry).
function notLoaded(header) {
  if (state.scenes === null && state.scenesError && !isLoading()) {
    return [
      header,
      emptyState(
        "wifiOff",
        t("scenes.loadFailed"),
        state.scenesError,
        h("button", { type: "button", class: "button button-primary", dataset: { key: "scenes-retry" }, onclick: () => loadScenes() }, icon("refresh"), t("common.retry"))
      ),
    ];
  }
  if (isLoading() || state.scenes === null) {
    return [header, h("div", { class: "scene-list", "aria-busy": "true" }, skeletonCards(3)), h("p", { class: "visually-hidden", role: "status" }, t("common.loading"))];
  }
  return null;
}

// ---- the list ------------------------------------------------------------------------------

export function scenesView({ navigate }) {
  const header = pageHeader({ title: t("scenes.title") });
  const notReady = notReadyState();
  if (notReady) return [header, offlineBanner(), notReady];
  const waiting = notLoaded(header);
  if (waiting) return waiting;
  if (state.scenesUnsupported) return [header, emptyState("scene", t("scenes.title"), t("scenes.updateDriver"))];
  const admin = can("admin");
  const scenes = state.scenes;
  return [
    header,
    offlineBanner(),
    staleBanner(),
    scenesNav("scenes"),
    notice(ui.scenesMessage),
    h("p", { class: "muted-note scene-intro" }, admin ? t("scenes.helpAdmin") : t("scenes.help")),
    can("member") ? null : h("p", { class: "notice notice-info" }, t("scenes.viewOnly", { role: roleLabel(state.role) })),
    scenes.length
      ? h("ul", { class: "scene-list" }, scenes.map((scene) => h("li", {}, sceneCard(scene, admin))))
      : emptyState("scene", t("scenes.emptyTitle"), admin ? t("scenes.emptyText") : t("scenes.emptyTextMember")),
    admin ? newScene(navigate, scenes.length) : null,
    // Links for the phone's own automations (ADR-051).
    admin ? linksRow() : null,
  ];
}

function runButton(scene) {
  const run = ui.sceneRuns[scene.id];
  const ran = run && (run.stage === "done" || run.stage === "partial");
  let label = t("scenes.run");
  if (run?.stage === "running") label = t("scenes.running");
  else if (run?.stage === "confirm") label = t("scenes.tapAgain");
  else if (ran) label = t("scenes.result.short");
  return h(
    "button",
    {
      type: "button",
      class: `button ${ran ? "button-secondary" : "button-primary"} scene-run`,
      title: t("scenes.runLabel", { name: scene.name }),
      disabled: run?.stage === "running",
      dataset: { key: `scene-run:${scene.id}` },
      onclick: () => runScene(scene),
    },
    icon(ran ? "check" : run?.stage === "confirm" ? "door" : "play"),
    label
  );
}

function sceneCard(scene, admin) {
  const run = ui.sceneRuns[scene.id];
  return h(
    "div",
    { class: `card scene-card ${run ? `is-${run.stage}` : ""}` },
    h("span", { class: "scene-icon", "aria-hidden": "true" }, icon(scene.icon || "bulb")),
    h(
      "div",
      { class: "scene-text" },
      admin
        ? h("a", { class: "scene-name", href: `#/scene/${scene.id}`, dir: "auto", title: t("scenes.editLabel", { name: scene.name }), dataset: { key: `scene-edit:${scene.id}` } }, scene.name)
        : name(scene.name, "span", "scene-name"),
      h("span", { class: "scene-summary" }, sceneSummary(scene)),
      // A plain "Done" is on the button already.
      run?.text && run.stage !== "done" ? h("span", { class: `scene-result scene-result-${run.stage}`, role: "status" }, run.text) : null
    ),
    can("member") ? runButton(scene) : null
  );
}

// Ready-made starting points: they open the editor filled in, nothing is saved until Save.
function sceneIdeas() {
  const has = { lights: state.lights.length > 0, climate: state.thermostats.length > 0, fans: state.fans.length > 0, blinds: state.blinds.length > 0 };
  const step = (type, set) => has[type] && { type, room_id: null, device_ids: null, set };
  return [
    { id: "allOff", icon: "home", steps: [step("lights", { on: false }), step("climate", { mode: "off" }), step("fans", { on: false })] },
    { id: "goodNight", icon: "moon", steps: [step("lights", { on: false }), step("blinds", { position: 0 })] },
    { id: "goodMorning", icon: "sun", steps: [step("blinds", { position: 100 })] },
    { id: "leaving", icon: "leave", steps: [step("lights", { on: false }), step("climate", { mode: "off" }), step("fans", { on: false }), step("blinds", { position: 0 })] },
    { id: "cool", icon: "climate", steps: [step("climate", { mode: "cool", target_temperature: 24 })] },
  ]
    .map((idea) => ({ ...idea, steps: idea.steps.filter(Boolean) }))
    .filter((idea) => idea.steps.length);
}

function newScene(navigate, count) {
  const ideas = sceneIdeas();
  const full = count >= MAX_SCENES;
  return h(
    "section",
    { class: "home-section scene-new" },
    full
      ? h("p", { class: "notice notice-info" }, t("scenes.editor.limit"))
      : h(
          "a",
          { class: "button button-primary", href: "#/scene/new", dataset: { key: "scene-new" }, onclick: () => { ui.sceneIdea = null; } },
          icon("plus"),
          t("scenes.newScene")
        ),
    !full && ideas.length
      ? [
          h("h2", { class: "section-title" }, t("scenes.ideas")),
          h(
            "div",
            { class: "chip-row" },
            ideas.map((idea) =>
              h(
                "button",
                {
                  type: "button",
                  class: "chip",
                  dataset: { key: `scene-idea:${idea.id}` },
                  onclick: () => {
                    ui.sceneIdea = idea;
                    navigate("#/scene/new");
                  },
                },
                t(`scenes.idea.${idea.id}`)
              )
            )
          ),
        ]
      : null
  );
}

// ---- the editor ----------------------------------------------------------------------------

// Opening the editor starts from the saved scene (or an idea) again.
export function resetSceneEditor() {
  ui.sceneEditor = null;
}

// `dirty`: something changed (Back asks first); `stepsChanged`: the steps are sent with Save.
function draftFor(key) {
  if (ui.sceneEditor?.key === key) return ui.sceneEditor;
  const base = { key, adding: null, busy: false, message: null, dirty: false, cameFrom: ui.cameFrom };
  if (key === "new") {
    const idea = ui.sceneIdea;
    ui.sceneIdea = null;
    ui.sceneEditor = {
      ...base,
      id: null,
      version: null,
      name: idea ? t(`scenes.idea.${idea.id}`) : "",
      icon: idea?.icon || "bulb",
      show_on_home: false,
      steps: idea ? idea.steps : [],
      stepsChanged: true,
    };
    return ui.sceneEditor;
  }
  const scene = findScene(key);
  if (!scene) return null;
  ui.sceneEditor = {
    ...base,
    id: scene.id,
    version: scene.version,
    name: scene.name,
    icon: scene.icon || "bulb",
    show_on_home: Boolean(scene.show_on_home),
    steps: JSON.parse(JSON.stringify(scene.steps || [])),
    stepsChanged: false,
  };
  return ui.sceneEditor;
}

function changeSteps(draft, steps) {
  draft.steps = steps;
  draft.stepsChanged = true;
  draft.dirty = true;
  notify();
}

// `adding`: the Add an action screen; `editing`: the index of the action being changed, or null.
export function sceneEditorView(key, adding, { navigate }, editing = null) {
  const title = key === "new" ? t("scenes.editor.newTitle") : t("scenes.editor.editTitle");
  const draft0 = ui.sceneEditor?.key === key ? ui.sceneEditor : null;
  const header = pageHeader({
    title,
    back: "#/scenes",
    // Back from a changed scene asks first.
    onBack: (event) => {
      if (draft0?.dirty && !window.confirm(t("scenes.editor.discard"))) event.preventDefault();
    },
  });
  const notReady = notReadyState();
  if (notReady) return [header, offlineBanner(), notReady];
  const waiting = notLoaded(header);
  if (waiting) return waiting;
  if (state.scenesUnsupported) return [header, emptyState("scene", title, t("scenes.updateDriver"))];
  if (!can("admin")) return [header, h("p", { class: "notice notice-info" }, t("scenes.editor.adminOnly", { role: roleLabel(state.role) }))];
  const draft = draftFor(key);
  if (!draft) {
    return [header, emptyState("scene", t("scenes.editor.notFound"), "", h("a", { class: "button button-primary", href: "#/scenes" }, t("scenes.title")))];
  }
  if (adding || editing != null) {
    const screen = adding ? "add" : `edit:${editing}`;
    if (draft.adding?.screen !== screen) draft.adding = adding ? newAdding() : editAdding(draft.steps, editing);
    if (!draft.adding) {
      return [
        pageHeader({ title: t("scenes.edit.title"), back: `#/scene/${key}` }),
        emptyState("scene", t("scenes.edit.notFound"), "", h("a", { class: "button button-primary", href: `#/scene/${key}` }, t("common.back"))),
      ];
    }
    return addActionView(draft);
  }
  draft.adding = null;
  return [
    draft0 ? header : pageHeader({ title, back: "#/scenes" }),
    offlineBanner(),
    staleBanner(),
    h(
      "div",
      { class: "scene-editor" },
      nameSection(draft),
      stepsSection(draft, navigate),
      copySection(draft),
      homeToggle(draft),
      sceneLinkSection(draft),
      notice(draft.message),
      editorActions(draft)
    ),
  ];
}

function nameSection(draft) {
  return h(
    "section",
    { class: "card scene-section" },
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label", for: "scene-name" }, t("scenes.editor.name")),
      h("input", {
        id: "scene-name",
        type: "text",
        maxlength: "64",
        value: draft.name,
        placeholder: t("scenes.editor.namePlaceholder"),
        dir: "auto",
        autocomplete: "off",
        dataset: { key: "scene-name" },
        // Not redrawn while typing: the name is left out of the screen's signature (app.js).
        oninput: (event) => {
          draft.name = event.target.value;
          draft.dirty = true;
        },
      })
    ),
    h(
      "div",
      { class: "scene-icons", role: "group", "aria-label": t("scenes.editor.icon") },
      SCENE_ICONS.map((iconName) =>
        h(
          "button",
          {
            type: "button",
            class: `scene-icon-choice ${draft.icon === iconName ? "is-active" : ""}`,
            "aria-pressed": String(draft.icon === iconName),
            "aria-label": t(`scenes.editor.icons.${iconName}`),
            title: t(`scenes.editor.icons.${iconName}`),
            dataset: { key: `scene-icon:${iconName}` },
            onclick: () => {
              draft.icon = iconName;
              draft.dirty = true;
              notify();
            },
          },
          icon(iconName)
        )
      )
    )
  );
}

function stepsSection(draft, navigate) {
  const count = draft.steps.length;
  return h(
    "section",
    { class: "card scene-section" },
    h(
      "div",
      { class: "section-head" },
      h("h2", { class: "section-title" }, t("scenes.editor.steps")),
      h("span", { class: "muted-note" }, t("scenes.editor.count", { count }))
    ),
    count ? h("ol", { class: "step-list" }, draft.steps.map((step, index) => stepRow(draft, step, index, navigate))) : null,
    h(
      "button",
      {
        type: "button",
        class: "button button-secondary button-wide",
        disabled: count >= MAX_STEPS,
        dataset: { key: "scene-add" },
        onclick: () => {
          draft.message = null;
          navigate(`#/scene/${draft.key}/add`);
        },
      },
      icon("plus"),
      t("scenes.editor.add")
    )
  );
}

// An action: tapping its text or Edit changes it (the Edit button is the one keyboards and screen
// readers use, so a row is not read out twice).
function stepRow(draft, step, index, navigate) {
  const what = stepWhat(step);
  const move = (offset) => {
    const steps = [...draft.steps];
    [steps[index], steps[index + offset]] = [steps[index + offset], steps[index]];
    changeSteps(draft, steps);
  };
  const edit = () => {
    draft.message = null;
    navigate(`#/scene/${draft.key}/edit/${index}`);
  };
  return h(
    "li",
    { class: "step-row" },
    h("span", { class: `step-icon step-${step.type}`, "aria-hidden": "true" }, icon(STEP_ICONS[step.type])),
    h(
      "span",
      { class: "step-text step-open", onclick: edit },
      name(what, "span", "step-what"),
      h("span", { class: "step-where" }, name(stepWhere(step), "span"), step.type === "relays" ? h("span", {}, ` · ${t("scenes.editor.needsDoors")}`) : null)
    ),
    h("span", { class: "step-action step-open", onclick: edit }, stepAction(step)),
    h(
      "span",
      { class: "step-tools" },
      iconButton("arrowUp", t("scenes.editor.moveUp", { what }), { disabled: index === 0, dataset: { key: `step-up:${index}` }, onclick: () => move(-1) }),
      iconButton("arrowDown", t("scenes.editor.moveDown", { what }), { disabled: index === draft.steps.length - 1, dataset: { key: `step-down:${index}` }, onclick: () => move(1) }),
      iconButton("edit", t("scenes.editor.editStep", { what }), { dataset: { key: `step-edit:${index}` }, onclick: edit }),
      iconButton("close", t("scenes.editor.remove", { what }), {
        class: "danger",
        dataset: { key: `step-remove:${index}` },
        onclick: () => changeSteps(draft, draft.steps.filter((_, other) => other !== index)),
      })
    )
  );
}

function copySection(draft) {
  return h(
    "section",
    { class: "scene-copy" },
    h("p", { class: "field-help" }, t("scenes.editor.copyHelp")),
    h(
      "button",
      {
        type: "button",
        class: "button button-secondary",
        dataset: { key: "scene-copy" },
        onclick: () => {
          if (draft.steps.length && !window.confirm(t("scenes.editor.copyConfirm", { count: draft.steps.length }))) return;
          const { steps, left } = copyHouse();
          draft.message = {
            kind: !steps.length ? "info" : left ? "error" : "success",
            text: left ? t("scenes.editor.copiedSome", { count: steps.length, left }) : t("scenes.editor.copied", { count: steps.length }),
          };
          changeSteps(draft, steps);
        },
      },
      icon("copy"),
      t("scenes.editor.copy")
    )
  );
}

function homeToggle(draft) {
  return h(
    "div",
    { class: "card scene-section toggle-row" },
    h(
      "span",
      { class: "toggle-text" },
      h("span", { class: "toggle-title", id: "scene-home-label" }, t("scenes.editor.showOnHome")),
      h("span", { class: "field-help" }, t("scenes.editor.showOnHomeHelp"))
    ),
    h(
      "button",
      {
        type: "button",
        role: "switch",
        class: "switch",
        "aria-checked": String(draft.show_on_home),
        "aria-labelledby": "scene-home-label",
        dataset: { key: "scene-home" },
        onclick: () => {
          draft.show_on_home = !draft.show_on_home;
          draft.dirty = true;
          notify();
        },
      },
      h("span", { class: "switch-thumb" })
    )
  );
}

function editorActions(draft) {
  return h(
    "div",
    { class: "scene-actions" },
    h(
      "button",
      { type: "button", class: "button button-secondary", disabled: draft.busy || !draft.steps.length, dataset: { key: "scene-try" }, onclick: () => tryDraft(draft) },
      icon("play"),
      t("scenes.editor.try")
    ),
    h(
      "button",
      { type: "button", class: "button button-primary", disabled: draft.busy, dataset: { key: "scene-save" }, onclick: () => saveDraft(draft) },
      icon("check"),
      draft.busy ? t("common.saving") : t("scenes.editor.save")
    ),
    draft.id
      ? h(
          "button",
          { type: "button", class: "button button-danger", disabled: draft.busy, dataset: { key: "scene-delete" }, onclick: () => deleteDraft(draft) },
          t("scenes.editor.delete")
        )
      : null
  );
}

async function tryDraft(draft) {
  const { steps } = currentSteps(draft.steps);
  if (!steps.length) {
    draft.message = { kind: "error", text: t("scenes.editor.needSteps") };
    notify();
    return;
  }
  draft.busy = true;
  draft.message = null;
  notify();
  try {
    const result = await api("/v1/scenes/try", { method: "POST", body: { steps } });
    const plain = !result.failed && !result.skipped && !(result.problems || []).length;
    draft.message = { kind: result.failed ? "error" : plain ? "success" : "info", text: plain ? t("scenes.editor.tried") : resultText(result) };
    window.setTimeout(() => refreshDevices(), 1500);
  } catch (error) {
    noteForbidden(error);
    draft.message = { kind: "error", text: errorText(error) };
  }
  draft.busy = false;
  notify();
}

async function saveDraft(draft) {
  const sceneName = draft.name.trim();
  // The steps are sent when they changed (a new scene always), without devices that are gone.
  const sending = !draft.id || draft.stepsChanged ? currentSteps(draft.steps) : null;
  const problem = !sceneName ? "needName" : !(sending ? sending.steps : draft.steps).length ? "needSteps" : null;
  if (problem) {
    draft.message = { kind: "error", text: t(`scenes.editor.${problem}`) };
    notify();
    if (problem === "needName") document.querySelector("#scene-name")?.focus();
    return;
  }
  // A linked scene that would open doors or gates loses its link (ADR-051): asked first.
  if (!confirmLinkLoss(draft, sending ? sending.steps : draft.steps)) return;
  draft.busy = true;
  draft.message = null;
  notify();
  const body = { name: sceneName.slice(0, 64), icon: draft.icon, show_on_home: draft.show_on_home };
  if (sending) body.steps = sending.steps;
  try {
    if (draft.id) await api(`/v1/scenes/${draft.id}`, { method: "PATCH", body: { ...body, version: draft.version } });
    else await api("/v1/scenes", { method: "POST", body });
    draft.busy = false;
    draft.dirty = false;
    flash(sending?.changed ? t("scenes.savedPruned", { name: sceneName }) : t("scenes.saved", { name: sceneName }));
    if (linksSupported() && can("admin")) loadLinks();
    await loadScenes();
    leave("#/scenes", draft.cameFrom);
    return;
  } catch (error) {
    noteForbidden(error);
    const codes = { VERSION_CONFLICT: "conflict", SCENE_LIMIT_REACHED: "limit" };
    draft.message = { kind: "error", text: codes[error?.code] ? t(`scenes.editor.${codes[error.code]}`) : errorText(error) };
  }
  draft.busy = false;
  notify();
}

async function deleteDraft(draft) {
  if (draft.busy || !window.confirm(deleteQuestion(draft))) return;
  draft.busy = true;
  notify();
  try {
    await api(`/v1/scenes/${draft.id}`, { method: "DELETE" });
  } catch (error) {
    // Already deleted on another device: the same outcome.
    if (error?.status !== 404) {
      noteForbidden(error);
      draft.busy = false;
      draft.message = { kind: "error", text: error?.code === "SCENE_IN_USE" ? t("scenes.editor.inUse") : errorText(error) };
      notify();
      return;
    }
  }
  draft.busy = false;
  draft.dirty = false;
  flash(t("scenes.deleted", { name: draft.name }));
  if (linksSupported() && can("admin")) loadLinks();
  await loadScenes();
  leave("#/scenes", draft.cameFrom);
}

// ---- adding an action ----------------------------------------------------------------------

function newAdding() {
  // `fan`: the AC's fan speed; `fanDo` and `fanSpeed`: what fans do (off, on or a speed, 1-4).
  // `screen`: the screen these choices belong to ("add", or "edit:<index>"). `fridgeFeature` and
  // `fridgeOn`: which refrigerator feature, on or off.
  return { screen: "add", editing: null, room: null, type: null, choose: false, picked: [], light: "off", brightness: 50, mode: null, temperature: 24, heat: 20, cool: 24, fan: null, fanDo: "off", fanSpeed: 2, blind: "close", position: 50, music: "pause", fridgeFeature: "sabbath_mode", fridgeOn: true };
}

// The choices that make the setting of each kind of action; the others say where and which devices.
const SETTING_CHOICES = {
  lights: ["light", "brightness"],
  climate: ["mode", "temperature", "heat", "cool", "fan"],
  fans: ["fanDo", "fanSpeed"],
  blinds: ["blind", "position"],
  relays: [],
  music: ["music"],
  refrigerators: ["fridgeFeature", "fridgeOn"],
};

function settingOf(adding) {
  return JSON.stringify((SETTING_CHOICES[adding.type] || []).map((choice) => adding[choice]));
}

// A step's setting, the same whatever order the controller sent its fields in.
function setKey(set) {
  return JSON.stringify(Object.keys(set || {}).sort().map((field) => [field, set[field]]));
}

function samePart(a, b) {
  return a.type === b.type && (a.room_id ?? null) === (b.room_id ?? null) && Array.isArray(a.device_ids) && Array.isArray(b.device_ids) && setKey(a.set) === setKey(b.set);
}

// The actions one choice became: more than 100 devices are kept as several actions in a row, with
// the same type, room and setting, each but the last naming 100 devices. They are changed together.
function splitRun(steps, index) {
  const step = steps[index];
  if (!Array.isArray(step.device_ids)) return { start: index, count: 1 };
  let start = index;
  while (start > 0 && samePart(steps[start - 1], step) && steps[start - 1].device_ids.length === MAX_DEVICE_IDS) start -= 1;
  let end = index;
  while (end + 1 < steps.length && steps[end].device_ids.length === MAX_DEVICE_IDS && samePart(steps[end + 1], step)) end += 1;
  return { start, count: end - start + 1 };
}

// Changing the action at `index` (#/scene/<id>/edit/<index>): the Add an action choices, filled in
// from it. `editing` keeps what it was: where it is in the scene, its devices (some may be gone
// from the project) and its setting. null when the scene has no such action.
function editAdding(steps, index) {
  const step = steps[index];
  if (!step || !STEP_TYPES.includes(step.type)) return null;
  const { start, count } = splitRun(steps, index);
  const ids = Array.isArray(step.device_ids) ? unique(steps.slice(start, start + count).flatMap((part) => part.device_ids)) : null;
  const set = step.set || {};
  const adding = { ...newAdding(), screen: `edit:${index}`, type: step.type, room: step.room_id ?? null, choose: Boolean(ids), picked: ids ? [...ids] : [] };
  if (step.type === "lights") {
    if (set.on === false || set.brightness === 0) adding.light = "off";
    else if (Number.isFinite(set.brightness)) Object.assign(adding, { light: "dim", brightness: Math.max(1, Math.min(100, Math.round(set.brightness))) });
    else adding.light = "on";
  } else if (step.type === "climate") {
    const target = Number.isFinite(set.target_temperature) ? set.target_temperature : set.mode === "heat" ? set.heat_setpoint : set.mode === "cool" ? set.cool_setpoint : null;
    adding.mode = set.mode ?? null;
    if (Number.isFinite(target)) adding.temperature = target;
    if (Number.isFinite(set.heat_setpoint)) adding.heat = set.heat_setpoint;
    if (Number.isFinite(set.cool_setpoint)) adding.cool = set.cool_setpoint;
    adding.fan = set.fan_speed ?? null;
  } else if (step.type === "fans") {
    if (set.on === false) adding.fanDo = "off";
    else if (Number.isInteger(set.speed)) Object.assign(adding, { fanDo: "speed", fanSpeed: set.speed });
    else adding.fanDo = "on";
  } else if (step.type === "blinds") {
    const position = Number.isFinite(set.position) ? set.position : 0;
    if (position >= 100) adding.blind = "open";
    else if (position <= 0) adding.blind = "close";
    else Object.assign(adding, { blind: "set", position: Math.round(position) });
  } else if (step.type === "music") {
    adding.music = set.action === "stop" ? "stop" : "pause";
  } else if (step.type === "refrigerators") {
    // A step the API made with several features shows its first; it stays as it was unless changed.
    const first = stepFeature(set);
    if (first) Object.assign(adding, { fridgeFeature: first.feature, fridgeOn: first.on });
  }
  // `setting`: the setting choices as first shown (settingOf), filled in then.
  adding.editing = { index, start, count, type: step.type, room: adding.room, ids: ids || [], set, setting: null, steps: steps.slice(start, start + count) };
  return adding;
}

// While an action is being changed its setting stays as it was saved until a setting choice is
// changed: it may hold what these choices do not show (a copied AC with no mode, both setpoints of
// a copied thermostat, a speed these fans no longer have).
function keptSet(adding) {
  const editing = adding.editing;
  return editing && adding.type === editing.type && editing.setting === settingOf(adding) ? editing.set : null;
}

function sameSteps(a, b) {
  const plain = (step) => JSON.stringify([step.type, step.room_id ?? null, step.device_ids ?? null, setKey(step.set)]);
  return a.length === b.length && a.every((step, index) => plain(step) === plain(b[index]));
}

// The data-key app.js focuses when the editor opens again after adding or changing an action, or
// cancelling that: the action's Edit button (the first, when it became several), or Add an action.
export function sceneReturnKey(previous, route) {
  if (route?.name !== "scene" || route.adding || route.editing != null || previous?.name !== "scene" || previous.id !== route.id) return null;
  const draft = ui.sceneEditor;
  const saved = draft?.returnFocus;
  if (draft) draft.returnFocus = null;
  if (previous.editing != null) return saved || `step-edit:${previous.editing}`;
  return previous.adding ? "scene-add" : null;
}

// Devices of `type` in `room` (null: the whole home).
function scopeDevices(type, room) {
  return devicesOfType(type).filter((device) => room == null || deviceRoomId(device) === room);
}

function roomsWithDevices() {
  return state.rooms.filter((room) => STEP_TYPES.some((type) => scopeDevices(type, room.id).length));
}

function choiceChip(label, active, key, onclick) {
  return h("button", { type: "button", class: `chip ${active ? "is-active" : ""}`, "aria-pressed": String(active), dataset: { key }, onclick }, name(label, "span"));
}

function segments(options, value, key, onPick) {
  return h(
    "div",
    { class: "segments", role: "group", style: { "grid-template-columns": `repeat(${options.length}, minmax(0, 1fr))` } },
    options.map(([option, label]) =>
      h(
        "button",
        {
          type: "button",
          class: `segment ${value === option ? "is-active" : ""}`,
          "aria-pressed": String(value === option),
          dataset: { key: `${key}:${option}` },
          onclick: () => {
            onPick(option);
            notify();
          },
        },
        label
      )
    )
  );
}

function addSection(title, ...content) {
  return h("section", { class: "card scene-section" }, h("h2", { class: "add-title" }, title), ...content);
}

function unique(values) {
  return [...new Set(values)];
}

// What the AC choices offer for these thermostats: their modes, temperature range and fan speeds.
// `dual`: some have heat and cool setpoints, which Auto then sets, kept at least `gap` apart (the
// largest gap any of them needs).
function climateChoices(devices) {
  const offered = unique(devices.flatMap((device) => device.modes || []));
  const duals = devices.filter(isDual);
  return {
    modes: MODE_ORDER.filter((mode) => mode === "off" || offered.includes(mode)),
    min: Math.min(...devices.map((device) => (Number.isFinite(device.target_temperature_min) ? device.target_temperature_min : 16))),
    max: Math.max(...devices.map((device) => (Number.isFinite(device.target_temperature_max) ? device.target_temperature_max : 32))),
    fans: unique(devices.flatMap((device) => device.fan_speeds || [])),
    dual: duals.length > 0,
    gap: Math.max(0.5, ...duals.map(setpointGap)),
  };
}

// The Heat and Cool choices as a thermostat, so their steppers follow the same push rule as a
// thermostat card (setpoints.js).
function setpointChoices(adding, { min, max, gap }) {
  return { heat_setpoint: adding.heat, cool_setpoint: adding.cool, target_temperature_min: min, target_temperature_max: max, setpoint_deadband: gap };
}

// Keeps the choices possible for the devices picked now (e.g. no Dim for on/off lights, no position
// for shades that only open and close), before the steps are built from them. Nothing to go by
// when none of the devices is in the project any more (an action being changed).
function settle(adding, devices) {
  if (!devices.length) return;
  if (adding.type === "lights" && adding.light === "dim" && !devices.some((device) => device.dimmable)) adding.light = "on";
  if (adding.type === "blinds" && !sceneBlindChoices(devices).includes(adding.blind)) adding.blind = adding.position >= 50 ? "open" : "close";
  if (adding.type === "refrigerators") {
    const features = featuresOf(devices);
    if (features.length && !features.includes(adding.fridgeFeature)) adding.fridgeFeature = features.includes("sabbath_mode") ? "sabbath_mode" : features[0];
  }
  if (adding.type === "climate") {
    const { modes, min, max, fans, dual, gap } = climateChoices(devices);
    if (!modes.includes(adding.mode)) adding.mode = modes.includes("cool") ? "cool" : modes[modes.length - 1];
    adding.temperature = Math.min(max, Math.max(min, adding.temperature));
    if (!fans.includes(adding.fan)) adding.fan = null;
    if (dual) {
      // Heat and cool inside the range and at least `gap` apart: cool goes up, and heat down when
      // cool is at the top.
      adding.heat = Math.min(max, Math.max(min, adding.heat));
      adding.cool = Math.min(max, Math.max(min, adding.cool));
      if (adding.cool < adding.heat + gap) {
        adding.cool = Math.min(max, adding.heat + gap);
        adding.heat = Math.min(adding.heat, adding.cool - gap);
      }
    }
  }
}

// The setting the choices describe, for `targets` (the devices it goes to).
function chosenSet(adding, targets) {
  if (adding.type === "lights") return adding.light === "off" ? { on: false } : adding.light === "on" ? { on: true } : { brightness: adding.brightness };
  if (adding.type === "climate") {
    let set;
    if (adding.mode === "off") set = { mode: "off" };
    else if (adding.mode === "auto" && targets.some(isDual)) set = { mode: "auto", heat_setpoint: adding.heat, cool_setpoint: adding.cool };
    else set = { mode: adding.mode, target_temperature: adding.temperature };
    if (adding.mode !== "off" && adding.fan) set.fan_speed = adding.fan;
    return set;
  }
  if (adding.type === "fans") return adding.fanDo === "off" ? { on: false } : adding.fanDo === "on" ? { on: true } : { speed: adding.fanSpeed };
  if (adding.type === "blinds") return { position: adding.blind === "open" ? 100 : adding.blind === "close" ? 0 : adding.position };
  if (adding.type === "music") return { action: adding.music };
  if (adding.type === "refrigerators") return stepSet(adding.fridgeFeature, adding.fridgeOn);
  return { action: "pulse" };
}

// The devices an action being changed named, picked as they were, in its own place and kind: it
// keeps naming them, even when they are every one of the kind there now (copied from the house,
// or the other door removed since).
function namedAsBefore(adding, picked) {
  const editing = adding.editing;
  if (!editing?.ids.length || !adding.choose || adding.type !== editing.type || adding.room !== editing.room) return false;
  return picked.length === editing.ids.length && editing.ids.every((id) => picked.includes(id));
}

// The steps the choices describe: one, or several when more than 100 devices are picked; none
// while chosen devices are wanted and none is picked. All of them picked is "all" (so devices
// added to the room later are included), except for doors and gates, which open only the ones
// picked, and an action being changed whose devices are picked as they were. Auto on thermostats
// with heat and cool setpoints sets both setpoints instead of a target. `others`: ids an action
// being changed names that are not among `devices` (moved to another room, or gone from the
// project); ticked, they stay in it.
function buildSteps(adding, devices, others = []) {
  const here = [...devices.map((device) => device.id), ...others];
  // An action being changed keeps the order it named its devices in; new ones come after.
  const picked = unique([...(adding.editing?.ids || []), ...here]).filter((id) => here.includes(id) && adding.picked.includes(id));
  if (adding.choose && !picked.length) return [];
  const asBefore = namedAsBefore(adding, picked);
  // Nothing changed: the action exactly as it was (all its parts, when it was split).
  if (asBefore && keptSet(adding)) return [...adding.editing.steps];
  const elsewhere = devicesOfType(adding.type).filter((device) => others.includes(device.id));
  const set = keptSet(adding) ?? chosenSet(adding, adding.choose ? [...devices, ...elsewhere].filter((device) => picked.includes(device.id)) : devices);
  // Music names no devices: the Sonos rooms in the room, or the whole home.
  if (adding.type === "music") return [{ type: "music", room_id: adding.room, device_ids: null, set }];
  const everyOne = adding.type !== "relays" && !asBefore && picked.length === devices.length && !others.some((id) => picked.includes(id));
  if (!adding.choose || everyOne) return [{ type: adding.type, room_id: adding.room, device_ids: null, set }];
  const steps = [];
  for (let start = 0; start < picked.length; start += MAX_DEVICE_IDS) {
    steps.push({ type: adding.type, room_id: adding.room, device_ids: picked.slice(start, start + MAX_DEVICE_IDS), set });
  }
  return steps;
}

function nowText(type, device) {
  if (type === "lights") return device.on ? (device.dimmable ? t("lights.level", { percent: shownBrightness(device) }) : t("lights.on")) : t("lights.off");
  if (type === "climate") {
    // The target (or the heat and cool range in auto) when there is one.
    const target = device.mode === "off" ? null : targetText(device);
    return [modeLabel(device.mode), target !== formatTemperature(null) ? target : null].filter(Boolean).join(" ");
  }
  if (type === "fans") return fanStateLabel(device);
  if (type === "blinds") return blindStateLabel(device);
  if (type === "refrigerators") return fridgeStateLabel(device);
  return "";
}

// All the devices of the kind here, or chosen ones. An action being changed also lists the devices
// it names that are elsewhere now, or gone from the project (`others`), so they leave it only when
// unticked.
function whichDevices(adding, devices, where, others = []) {
  if (adding.type === "music") return null;
  if (devices.length + others.length < 2 && !(adding.editing && adding.choose)) return null;
  const kind = t(`scenes.add.kinds.${adding.type}`);
  if (!adding.choose) {
    return h(
      "div",
      { class: "which-row" },
      h("span", {}, h("span", { class: "which-label" }, t("scenes.add.which", { kind })), " ", t("scenes.add.allIn", { count: devices.length, where: isolate(where) })),
      h(
        "button",
        {
          type: "button",
          class: "button button-secondary button-small",
          dataset: { key: "add-choose" },
          onclick: () => {
            // An action being changed, in its own place: the devices it named, ticked again.
            resetPicks(adding);
            adding.choose = true;
            notify();
          },
        },
        t("scenes.add.choose")
      )
    );
  }
  const listed = [...devices.map((device) => device.id), ...others];
  const all = listed.every((id) => adding.picked.includes(id));
  const known = devicesOfType(adding.type);
  const item = (deviceId, device) => {
    const id = `pick-${deviceId}`;
    // Elsewhere now: its room. Gone from the project: said so, with its Control4 id.
    const here = devices.includes(device);
    const meta = device
      ? [adding.room == null || !here ? isolate(roomName(device.room)) : null, nowText(adding.type, device)].filter(Boolean).join(" · ")
      : t("scenes.edit.goneMeta", { id: String(deviceId) });
    return h(
      "li",
      { class: `pick-item ${device ? "" : "is-gone"}`.trim() },
      h("input", {
        type: "checkbox",
        id,
        checked: adding.picked.includes(deviceId),
        dataset: { key: `pick:${deviceId}` },
        onchange: (event) => {
          adding.picked = event.target.checked ? [...adding.picked, deviceId] : adding.picked.filter((other) => other !== deviceId);
          notify();
        },
      }),
      h(
        "label",
        { for: id, class: "pick-label" },
        device ? name(device.name, "span", "device-name") : h("span", { class: "device-name" }, t("scenes.edit.goneDevice")),
        meta ? h("span", { class: "device-meta" }, meta) : null
      )
    );
  };
  return h(
    "div",
    { class: "pick-panel" },
    h(
      "div",
      { class: "which-row" },
      h("span", {}, t("scenes.add.picked", { picked: listed.filter((id) => adding.picked.includes(id)).length, count: listed.length })),
      h(
        "button",
        {
          type: "button",
          class: "button button-quiet button-small",
          dataset: { key: "add-pick-all" },
          onclick: () => {
            adding.picked = all ? [] : listed;
            notify();
          },
        },
        all ? t("scenes.add.pickNone") : t("scenes.add.pickAll", { count: listed.length })
      )
    ),
    h(
      "ul",
      { class: "pick-list" },
      devices.map((device) => item(device.id, device)),
      others.map((id) => item(id, known.find((device) => device.id === id) || null))
    ),
    h("p", { class: "field-help" }, t("scenes.add.pickHelp")),
    devices.length
      ? h(
          "button",
          {
            type: "button",
            class: "button button-quiet button-small",
            dataset: { key: "add-use-all" },
            onclick: () => {
              adding.choose = false;
              adding.picked = [];
              notify();
            },
          },
          t("scenes.add.useAll", { count: devices.length })
        )
      : null
  );
}

// What to do. When none of an action's devices is in the project any more (it is being changed),
// that is said instead, and its setting stays as it was; music names no devices.
function doSection(adding, devices) {
  if (devices.length || adding.type === "music") return doControls(adding, devices);
  const gone = h("p", { class: "notice notice-info" }, t("scenes.edit.noDevices"));
  return adding.type === "relays" ? [gone, doControls(adding, devices)] : gone;
}

function doControls(adding, devices) {
  if (adding.type === "lights") {
    const dimmable = devices.some((device) => device.dimmable);
    return [
      segments([["off", t("scenes.do.off")], ["on", t("scenes.do.on")], ...(dimmable ? [["dim", t("scenes.add.dim")]] : [])], adding.light, "add-light", (value) => {
        adding.light = value;
      }),
      adding.light === "dim"
        ? slider({
            label: t("scenes.add.brightness"),
            value: adding.brightness,
            min: 1,
            max: 100,
            key: "add-brightness",
            format: (value) => t("common.percent", { percent: value }),
            onCommit: (value) => {
              adding.brightness = value;
              notify();
            },
          })
        : null,
    ];
  }
  if (adding.type === "climate") {
    const choices = climateChoices(devices);
    const { modes, min, max, fans } = choices;
    const parts = [segments(modes.map((mode) => [mode, modeLabel(mode)]), adding.mode, "add-mode", (value) => { adding.mode = value; })];
    if (adding.mode === "auto" && choices.dual) {
      parts.push(setpointSteppers(adding, choices), h("p", { class: "field-help" }, t("scenes.add.gap", { gap: formatTemperature(choices.gap) })));
    } else if (adding.mode !== "off") {
      const nudge = (delta) => {
        adding.temperature = Math.min(max, Math.max(min, adding.temperature + delta));
        notify();
      };
      parts.push(
        h(
          "div",
          { class: "stepper", role: "group", "aria-label": t("scenes.add.temperature") },
          iconButton("minus", t("climate.lower"), { class: "stepper-button", disabled: adding.temperature <= min, dataset: { key: "add-temp-down" }, onclick: () => nudge(-1) }),
          h(
            "div",
            { class: "stepper-value" },
            h("output", { class: "stepper-number", "aria-live": "polite" }, formatTemperature(adding.temperature)),
            h("span", { class: "stepper-label" }, t("climate.targetShort"))
          ),
          iconButton("plus", t("climate.raise"), { class: "stepper-button", disabled: adding.temperature >= max, dataset: { key: "add-temp-up" }, onclick: () => nudge(1) })
        )
      );
    }
    if (adding.mode !== "off") {
      if (fans.length) {
        parts.push(
          h(
            "div",
            { class: "chip-row", role: "group", "aria-label": t("climate.fan") },
            h("span", { class: "chip-row-label" }, icon("fan"), t("climate.fan")),
            [null, ...fans].map((speed) =>
              choiceChip(speed ? fanLabel(speed) : t("scenes.add.fanKeep"), adding.fan === speed, `add-fan:${speed || "keep"}`, () => {
                adding.fan = speed;
                notify();
              })
            )
          )
        );
      }
    }
    return parts;
  }
  if (adding.type === "fans") {
    // On goes to the speed each fan chooses; Speed sets them all to one.
    const speeds = unique(devices.flatMap(fanSpeeds)).sort((a, b) => a - b);
    return [
      segments([["off", t("scenes.do.off")], ["on", t("scenes.do.on")], ["speed", t("scenes.add.speed")]], adding.fanDo, "add-fan-do", (value) => {
        adding.fanDo = value;
      }),
      adding.fanDo === "speed"
        ? h(
            "div",
            { class: "chip-row", role: "group", "aria-label": t("scenes.add.speed") },
            speeds.map((speed) =>
              choiceChip(fanSpeedLabel(speed), adding.fanSpeed === speed, `add-fan-speed:${speed}`, () => {
                adding.fanSpeed = speed;
                notify();
              })
            )
          )
        : null,
    ];
  }
  if (adding.type === "blinds") {
    // Set position only when one of these shades can go to a position.
    const choices = sceneBlindChoices(devices);
    const options = [["open", t("scenes.do.open")], ["close", t("scenes.do.close")], ["set", t("scenes.add.position")]];
    return [
      segments(options.filter(([value]) => choices.includes(value)), adding.blind, "add-blind", (value) => {
        adding.blind = value;
      }),
      adding.blind === "set"
        ? slider({
            label: t("scenes.add.position"),
            value: adding.position,
            min: 1,
            max: 99,
            key: "add-position",
            format: (value) => t("blinds.percentOpen", { percent: value }),
            onCommit: (value) => {
              adding.position = value;
              notify();
            },
          })
        : null,
    ];
  }
  if (adding.type === "refrigerators") {
    // Which feature (the ones these refrigerators have), then on or off.
    const features = featuresOf(devices.length ? devices : devicesOfType("refrigerators"));
    return [
      h(
        "div",
        { class: "chip-row", role: "group", "aria-label": t("scenes.add.feature") },
        features.map((feature) =>
          h(
            "button",
            {
              type: "button",
              class: `chip chip-with-icon ${adding.fridgeFeature === feature ? "is-active" : ""}`,
              "aria-pressed": String(adding.fridgeFeature === feature),
              dataset: { key: `add-fridge-feature:${feature}` },
              onclick: () => {
                adding.fridgeFeature = feature;
                notify();
              },
            },
            icon(FEATURE_ICONS[feature]),
            h("span", {}, t(`refrigerators.features.${feature}`))
          )
        )
      ),
      segments([["on", t("scenes.add.switchOn")], ["off", t("scenes.add.switchOff")]], adding.fridgeOn ? "on" : "off", "add-fridge-on", (value) => {
        adding.fridgeOn = value === "on";
      }),
      h("p", { class: "field-help" }, t("scenes.add.fridgeNote")),
    ];
  }
  if (adding.type === "music") {
    return [
      segments([["pause", t("scenes.do.pauseMusic")], ["stop", t("scenes.do.stopMusic")]], adding.music, "add-music", (value) => {
        adding.music = value;
      }),
      h("p", { class: "field-help" }, t("scenes.add.musicNote")),
    ];
  }
  // Doors and gates: only what their Open button does. A linked scene would lose its link.
  return [h("p", { class: "notice notice-info" }, t("scenes.add.doorsNote")), doorLinkWarning(ui.sceneEditor)];
}

// Auto on thermostats with heat and cool setpoints: a Heat and a Cool stepper. Each pushes the
// other to keep the gap; a button is off when the other one has no room left.
function setpointSteppers(adding, choices) {
  const stepper = (field, which, label, lower, raise) => {
    const next = (delta) => withSetpoint(setpointChoices(adding, choices), field, adding[which] + delta);
    const nudge = (delta) => {
      const both = next(delta);
      if (!both) return;
      adding.heat = both.heat_setpoint;
      adding.cool = both.cool_setpoint;
      notify();
    };
    return h(
      "div",
      { class: "stepper", role: "group", "aria-label": t(label) },
      iconButton("minus", t(lower), { class: "stepper-button", disabled: !next(-1), dataset: { key: `add-${which}-down` }, onclick: () => nudge(-1) }),
      h(
        "div",
        { class: "stepper-value" },
        h("output", { class: "stepper-number", "aria-live": "polite" }, formatTemperature(adding[which])),
        h("span", { class: "stepper-label" }, t(label))
      ),
      iconButton("plus", t(raise), { class: "stepper-button", disabled: !next(1), dataset: { key: `add-${which}-up` }, onclick: () => nudge(1) })
    );
  };
  return h(
    "div",
    { class: "stepper-pair", role: "group", "aria-label": t("climate.setpoints") },
    stepper("heat_setpoint", "heat", "climate.heatShort", "climate.lowerHeat", "climate.raiseHeat"),
    stepper("cool_setpoint", "cool", "climate.coolShort", "climate.lowerCool", "climate.raiseCool")
  );
}

// A new place or kind starts with all its devices; back at the place and kind of the action being
// changed, with the devices it named.
function resetPicks(adding) {
  const editing = adding.editing;
  const own = Boolean(editing) && adding.room === editing.room && adding.type === editing.type;
  adding.choose = own && editing.ids.length > 0;
  adding.picked = own ? [...editing.ids] : [];
}

// Add an action, or change one (`adding.editing`): the same screen, where the changed action takes
// the place of the one it was (several when it now names more than 100 devices).
function addActionView(draft) {
  const adding = draft.adding;
  const editing = adding.editing;
  // A changed action keeps its kind in its own place even with none of its devices left there.
  const own = (type) => Boolean(editing) && type === editing.type && adding.room === editing.room;
  const available = STEP_TYPES.filter((type) => scopeDevices(type, adding.room).length || own(type));
  if (!available.includes(adding.type)) {
    adding.type = available[0] || null;
    resetPicks(adding);
  }
  const room = adding.room == null ? null : roomById(adding.room);
  const where = adding.room == null ? t("scenes.wholeHome") : room ? roomName(room) : t("scenes.roomGone");
  const devices = adding.type ? scopeDevices(adding.type, adding.room) : [];
  const others = own(adding.type) ? editing.ids.filter((id) => !devices.some((device) => device.id === id)) : [];
  // What the setting choices offer: the devices it goes to (its devices moved to another room
  // count), else all here.
  const elsewhere = devicesOfType(adding.type).filter((device) => others.includes(device.id));
  const targets = adding.choose ? [...devices, ...elsewhere].filter((device) => adding.picked.includes(device.id)) : devices;
  const choices = targets.length ? targets : devices.length ? devices : elsewhere;
  settle(adding, choices);
  if (editing) editing.setting ??= settingOf(adding);
  const steps = adding.type ? buildSteps(adding, devices, others) : [];
  const kept = draft.steps.length - (editing ? editing.count : 0);
  const fits = kept + steps.length <= MAX_STEPS;
  const shown = steps.length > 1 ? { ...steps[0], device_ids: steps.flatMap((step) => step.device_ids) } : steps[0];
  const back = () => leave(`#/scene/${draft.key}`, "scene");
  const pickRoom = (id) => () => {
    if (adding.room === id) return;
    adding.room = id;
    resetPicks(adding);
    notify();
  };
  // The room of the action being changed, when it has no devices now or is gone from the project.
  const rooms = roomsWithDevices();
  const ownRoom = editing && editing.room != null && !rooms.some((item) => item.id === editing.room) ? editing.room : null;
  const summary = shown ? `${isolate(stepWhat(shown))} (${isolate(stepWhere(shown))}): ${stepAction(shown)}` : "";
  return [
    pageHeader({ title: editing ? t("scenes.edit.title") : t("scenes.add.title"), back: `#/scene/${draft.key}` }),
    h(
      "div",
      { class: "scene-editor" },
      addSection(
        t("scenes.add.where"),
        h(
          "div",
          { class: "chip-row" },
          choiceChip(t("scenes.wholeHome"), adding.room == null, "add-room:home", pickRoom(null)),
          rooms.map((item) => choiceChip(roomName(item), adding.room === item.id, `add-room:${item.id}`, pickRoom(item.id))),
          ownRoom != null ? choiceChip(roomById(ownRoom) ? roomName(roomById(ownRoom)) : t("scenes.roomGone"), adding.room === ownRoom, `add-room:${ownRoom}`, pickRoom(ownRoom)) : null
        ),
        adding.room != null && !room ? h("p", { class: "notice notice-info" }, t("scenes.edit.roomGone")) : null
      ),
      available.length
        ? addSection(
            t("scenes.add.what"),
            h(
              "div",
              { class: "kind-grid" },
              available.map((type) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: `kind-choice ${adding.type === type ? "is-active" : ""}`,
                    "aria-pressed": String(adding.type === type),
                    dataset: { key: `add-kind:${type}` },
                    onclick: () => {
                      if (adding.type === type) return;
                      adding.type = type;
                      resetPicks(adding);
                      notify();
                    },
                  },
                  icon(STEP_ICONS[type]),
                  h("span", { class: "kind-name" }, t(`scenes.add.kinds.${type}`)),
                  h("span", { class: "kind-count" }, formatNumber(scopeDevices(type, adding.room).length))
                )
              )
            ),
            editing && editing.count > 1 ? h("p", { class: "field-help" }, t("scenes.edit.joined", { count: editing.count })) : null,
            whichDevices(adding, devices, where, others)
          )
        : h("p", { class: "muted-note" }, t("scenes.add.nothingHere")),
      adding.type ? addSection(t("scenes.add.do"), doSection(adding, choices)) : null,
      h(
        "div",
        { class: "card scene-section add-foot" },
        h(
          "p",
          { class: "add-summary", role: "status" },
          shown ? (fits ? t(editing ? "scenes.edit.becomes" : "scenes.add.adds", { summary }) : t("scenes.add.tooMany")) : t("scenes.add.pickOne")
        ),
        steps.length > 1 && fits ? h("p", { class: "field-help" }, t("scenes.add.parts", { count: steps.length })) : null,
        h(
          "div",
          { class: "scene-actions" },
          h("button", { type: "button", class: "button button-secondary", dataset: { key: "add-cancel" }, onclick: back }, t("common.cancel")),
          h(
            "button",
            {
              type: "button",
              class: "button button-primary",
              disabled: !steps.length || !fits,
              dataset: { key: "add-confirm" },
              onclick: () => {
                // Built again from the choices as they are at the tap.
                settle(adding, choices);
                const chosen = buildSteps(adding, devices, others);
                if (!chosen.length || kept + chosen.length > MAX_STEPS) return;
                draft.adding = null;
                if (!editing) changeSteps(draft, [...draft.steps, ...chosen]);
                else {
                  // In its place; the editor then focuses it (sceneReturnKey). Unchanged, the scene is too.
                  draft.returnFocus = `step-edit:${editing.start}`;
                  if (!sameSteps(chosen, editing.steps)) {
                    changeSteps(draft, [...draft.steps.slice(0, editing.start), ...chosen, ...draft.steps.slice(editing.start + editing.count)]);
                  }
                }
                back();
              },
            },
            icon(editing ? "check" : "plus"),
            editing ? t("scenes.edit.save") : t("scenes.add.addButton")
          )
        )
      )
    ),
  ];
}
