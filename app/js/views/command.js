// Say or type a command (1.9.0, ADR-063; 1.10.0, ADR-066): the field under Home's header, and the same field in a
// dialog from the header of the other screens on wide screens, or with the "/" key. A microphone
// where the browser can turn speech into text (the Web Speech API: Chrome, Edge, Safari; not the
// iPhone's Home Screen app, where the keyboard's own microphone does it). What it understood, the
// result, the questions and the second taps come from js/commands.js.
//
// The field itself (its form, the words, the microphone and Go) is made once for each place and
// kept: a redraw of Home or of the dialog changes what is around it, never takes it out of the page
// while it is typed or dictated into (that would end the keyboard's composition, iOS dictation and
// the caret). app.js leaves it in place (dom.js replaceKeeping).

import { MAX_LENGTH } from "../command-parser.js";
import { cancelCommandPart, chooseOption, clearCommand, commandMessage, commandState, confirmCommand, submitCommand } from "../commands.js";
import { doorbellButton, relayButton } from "../components.js";
import { announce, h, iconButton, speakFrom } from "../dom.js";
import { currentLanguage, languageInfo, t } from "../i18n.js";
import { icon } from "../icons.js";
import { IS_IOS } from "../platform.js";
import { findScene, isolate, runScene } from "../scenes.js";
import { can, deviceKey, notify, state, subscribe, ui } from "../state.js";

// What is being typed, the same in every place's field (not in the renderer's signature, so typing
// redraws nothing).
let draft = "";
// The speech service while it listens, the field it listens for, and what it heard so far.
let listening = null;
let listeningFor = null;
let heard = "";
// A speech service stopped by closing the dialog or leaving Home: what it still says is not done,
// and the field gets back the words typed before it listened.
let abandoned = null;
let typedBefore = "";
// The browser refused its speech service (no Siri, a policy): the keyboard's microphone then.
let speechOff = false;
// The app's language the fields were last drawn in.
let fieldLanguage = null;

// ---- the microphone --------------------------------------------------------------------------

function recognitionClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function homeScreenApp() {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // No media queries here.
  }
  return navigator.standalone === true;
}

// The microphone button, where the browser listens. On iPhone and iPad the Home Screen app has the
// API but WebKit does not listen there: the keyboard's own microphone types into the field instead.
export function speechAvailable() {
  if (speechOff || !recognitionClass()) return false;
  return !(IS_IOS && homeScreenApp());
}

// Each place's field: { form, input, label, mic, go, output } (bar()).
const bars = new Map();

function setFields(text) {
  for (const parts of bars.values()) parts.input.value = text;
}

// The words gone from the field, for the next command.
function clearWords() {
  draft = "";
  setFields("");
}

const SPEECH_ERRORS = {
  "not-allowed": "blocked",
  "service-not-allowed": "unavailable",
  "no-speech": "noSpeech",
  "audio-capture": "noMicrophone",
  network: "network",
  "language-not-supported": "language",
};

function startListening(where) {
  const Recognition = recognitionClass();
  if (!Recognition || listening) return;
  readyToSpeak();
  let recognition;
  try {
    recognition = new Recognition();
  } catch {
    speechOff = true;
    commandMessage(t("command.speech.unavailable"), "error");
    return;
  }
  // The app's language (js/i18n.js LANGUAGES: he-IL, es-ES, it-IT, en-US).
  recognition.lang = languageInfo().speech;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;
  recognition.continuous = false;
  let finals = null;
  let failure = null;
  recognition.onresult = (event) => {
    if (recognition === abandoned) return;
    const results = Array.from(event.results || []);
    heard = results.map((result) => result[0]?.transcript || "").join("");
    // What it hears is in the field, to send or correct if listening stops before it is final.
    draft = heard;
    setFields(heard);
    const last = results[results.length - 1];
    if (last?.isFinal) {
      const before = results.slice(0, -1).map((result) => result[0]?.transcript || "").join("");
      finals = Array.from(last).map((alternative) => `${before}${alternative.transcript}`.trim());
    }
    notify();
  };
  recognition.onerror = (event) => {
    failure = event?.error || "failed";
  };
  recognition.onend = () => {
    if (listening === recognition) listening = null;
    // Closed or left while it listened: what it heard is not done, and nothing is said.
    if (recognition === abandoned) return void notify();
    heard = "";
    if (finals?.length) {
      draft = finals[0];
      setFields(draft);
      run(finals[0], finals.slice(1));
    } else if (failure && failure !== "aborted") {
      const reason = SPEECH_ERRORS[failure] || "failed";
      if (reason === "unavailable") speechOff = true;
      commandMessage(t(`command.speech.${reason}`), "error");
    } else {
      notify();
    }
  };
  listening = recognition;
  listeningFor = where;
  typedBefore = draft;
  clearCommand();
  try {
    recognition.start();
  } catch {
    listening = null;
    commandMessage(t("command.speech.failed"), "error");
  }
  notify();
}

// The Stop button: the service says the words it heard (and they are done).
function stopListening() {
  try {
    listening?.stop();
  } catch {
    listening = null;
    notify();
  }
}

// Closing the dialog or leaving Home while it listens: abort, so that nothing heard is done (stop
// would make the service say what it heard so far, and that would be done).
function abortListening() {
  const recognition = listening;
  if (!recognition) return;
  abandoned = recognition;
  listening = null;
  heard = "";
  draft = typedBefore;
  setFields(typedBefore);
  try {
    if (typeof recognition.abort === "function") recognition.abort();
    else recognition.stop();
  } catch {
    // Already ended.
  }
  notify();
}

// app.js, on every change of screen: away from Home, Home's microphone stops listening.
export function commandRouteChanged(route) {
  if (listening && listeningFor === "home" && route?.name !== "home") abortListening();
}

// ---- the field -----------------------------------------------------------------------------

function run(text, alternatives = []) {
  const shown = submitCommand(text, alternatives);
  // Understood: the field empties for the next one. Not understood: the words stay to correct.
  if (shown && !["ask", "problem", "unknown", "message"].includes(shown.stage)) clearWords();
}

// The microphone button of a place, kept too (its focus, and a press under way, stay over a
// redraw): Speak, or Stop while it listens.
function updateMic(parts, where) {
  const shown = speechAvailable();
  if (shown) {
    parts.micButton ||= iconButton("mic", t("command.speak"), {
      class: "command-mic",
      dataset: { key: `command-mic:${where}` },
      onclick: () => (listening ? stopListening() : startListening(where)),
    });
    const on = Boolean(listening);
    const label = on ? t("command.stopListening") : t("command.speak");
    const button = parts.micButton;
    button.className = `icon-button command-mic ${on ? "is-listening" : ""}`.trim();
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-pressed", String(on));
    if (parts.micIcon !== (on ? "stop" : "mic")) {
      parts.micIcon = on ? "stop" : "mic";
      button.replaceChildren(icon(parts.micIcon));
    }
  }
  if (parts.micShown !== shown) {
    parts.micShown = shown;
    parts.mic.replaceChildren(...(shown ? [parts.micButton] : []));
  }
}

// The field of a place ("home", "dialog"), made the first time and then only brought up to date:
// its words in the language, the microphone and the answer below it (in slots of their own, so
// that the input itself never moves).
function bar(where) {
  let parts = bars.get(where);
  if (!parts) {
    const id = `command-input-${where}`;
    const input = h("input", {
      type: "text",
      id,
      class: "command-input",
      // One more than a command can have, so that a longer text pasted and cut short by the field
      // is never understood in part (command-parser.js).
      maxlength: String(MAX_LENGTH + 1),
      enterkeyhint: "go",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      dataset: { key: `command-input:${where}` },
      onfocus: readyToSpeak,
      oninput: (event) => {
        draft = event.target.value;
      },
      onkeydown: (event) => {
        if (event.key !== "Escape") return;
        if (draft) {
          clearWords();
          event.preventDefault?.();
        } else if (commandState()) {
          clearCommand();
          event.preventDefault?.();
        }
      },
    });
    input.value = draft;
    const label = h("label", { class: "visually-hidden", for: id });
    const mic = h("span", { class: "command-slot" });
    const go = iconButton("moveForward", t("command.go"), { type: "submit", class: "command-go", dataset: { key: `command-go:${where}` } });
    const form = h(
      "form",
      {
        class: "command-form",
        onsubmit: (event) => {
          event.preventDefault?.();
          run(draft);
        },
      },
      label,
      input,
      mic,
      go
    );
    parts = { form, input, label, mic, go, output: h("div", { class: "command-slot" }) };
    bars.set(where, parts);
  }
  const { input, label, go, output: below } = parts;
  // The app's language changed: the words in the field (and what it heard) were for the other
  // one, whose commands this language does not understand; the answer goes too (commands.js).
  if (fieldLanguage !== currentLanguage()) {
    if (fieldLanguage !== null) {
      abortListening();
      clearWords();
    }
    fieldLanguage = currentLanguage();
  }
  label.textContent = t("command.label");
  input.setAttribute("placeholder", !speechAvailable() && IS_IOS ? t("command.placeholderDictation") : t("command.placeholder"));
  go.setAttribute("aria-label", t("command.go"));
  go.setAttribute("title", t("command.go"));
  // The words of the other place's field (or put there by the app), unless this one is in use.
  if (document.activeElement !== input && input.value !== draft) input.value = draft;
  updateMic(parts, where);
  below.replaceChildren(...[output(where)].filter(Boolean));
  return parts;
}

// After a button of the answer is used it goes with the redraw: the field has the focus then.
function thenField(where, run) {
  return () => {
    run();
    bars.get(where)?.input.focus?.();
  };
}

function said(text) {
  return h("p", { class: "command-said", dir: "auto" }, text);
}

// A door or gate the command named: its own Open button, in its second tap already.
function doorControl(ref) {
  const list = ref.kind === "relay" ? state.relays : state.doorbells;
  const device = (list || []).find((item) => item.id === ref.id);
  if (!device) return null;
  const confirming = (ref.kind === "relay" ? ui.relayStage : ui.doorbellStage)[ref.id] === "confirm";
  const error = state.errors[deviceKey(ref.kind, ref.id)];
  return [
    h("div", { class: "command-actions" }, ref.kind === "relay" ? relayButton(device) : doorbellButton(device)),
    error ? h("p", { class: "command-result is-error", role: "alert" }, error.text) : confirming ? h("p", { class: "command-hint" }, t("relays.confirmHint")) : null,
  ];
}

// A scene that opens doors: its Run button, which asks for its second tap as on Scenes (`suffix`
// tells apart the parts of several things said).
function sceneControl(id, where, suffix = "") {
  const scene = findScene(id);
  if (!scene) return null;
  const run = ui.sceneRuns[scene.id];
  const label = run?.stage === "running" ? t("scenes.running") : run?.stage === "confirm" ? t("scenes.tapAgain") : t("scenes.run");
  return [
    h(
      "div",
      { class: "command-actions" },
      h(
        "button",
        {
          type: "button",
          class: `button button-primary button-small ${run?.stage === "confirm" ? "is-confirm" : ""}`,
          disabled: run?.stage === "running",
          "aria-label": t("scenes.runLabel", { name: scene.name }),
          dataset: { key: `command-scene:${where}${suffix}` },
          onclick: () => runScene(scene),
        },
        icon(run?.stage === "confirm" ? "door" : "scene"),
        h("span", {}, label)
      )
    ),
    run?.text && run.stage !== "running" ? h("p", { class: `command-result is-${run.stage === "done" ? "done" : run.stage === "confirm" ? "info" : "error"}` }, run.text) : null,
  ];
}

function examples(list, where) {
  return h(
    "div",
    { class: "command-examples" },
    h("span", { class: "command-examples-label" }, t("command.examples")),
    list.map((example, index) =>
      h(
        "button",
        {
          type: "button",
          class: "chip command-example",
          dir: "auto",
          dataset: { key: `command-example:${where}:${index}` },
          // Puts it in the field, to change or send.
          onclick: () => {
            draft = example;
            setFields(example);
            bars.get(where)?.input.focus?.();
          },
        },
        example
      )
    )
  );
}

// Heaters a command left as they are (ADR-066).
function note(now) {
  return now.note ? h("p", { class: "command-note", dir: "auto" }, now.note) : null;
}

// Turn off all's confirm, with its counts: Turn off (or Close) and Cancel.
function confirmControl(now, where, { confirm, cancel, suffix = "" }) {
  const blinds = now.action.filters.length === 1 && now.action.filters[0] === "blinds";
  return [
    h("p", { class: "command-result" }, now.text),
    h(
      "div",
      { class: "command-actions" },
      h(
        "button",
        { type: "button", class: "button button-primary button-small", dataset: { key: `command-confirm:${where}${suffix}` }, onclick: thenField(where, confirm) },
        icon(blinds ? "blinds" : "power"),
        h("span", {}, t(blinds ? "command.off.close" : "command.off.confirm"))
      ),
      h("button", { type: "button", class: "button button-quiet button-small", dataset: { key: `command-cancel:${where}${suffix}` }, onclick: thenField(where, cancel) }, t("common.cancel"))
    ),
  ];
}

// One of two to five things said: what it understood, then its result or its second tap.
function partBody(part, where, index) {
  const suffix = `:${index}`;
  const result = (stage, text) => h("p", { class: `command-result is-${stage}` }, icon(stage === "done" ? "check" : "info"), h("span", {}, text));
  let below;
  switch (part.stage) {
    case "running":
      below = h("p", { class: "command-result is-running" }, t("command.result.running"));
      break;
    case "confirm":
      below = confirmControl(part, where, { confirm: () => confirmCommand(index), cancel: () => cancelCommandPart(index), suffix });
      break;
    case "door":
      below = doorControl(part.action.device);
      break;
    case "scene":
      below = sceneControl(part.action.id, where, suffix);
      break;
    case "cancelled":
      below = h("p", { class: "command-result" }, part.text);
      break;
    default:
      below = result(part.stage, part.text);
  }
  return h("div", { class: "command-part", dataset: { key: `command-part:${where}${suffix}` } }, said(part.said), note(part), below);
}

function body(now, where) {
  switch (now.stage) {
    case "running":
      return [said(now.said), note(now), h("p", { class: "command-result is-running" }, t("command.result.running"))];
    case "done":
    case "partial":
    case "error":
      return [now.said ? said(now.said) : null, note(now), h("p", { class: `command-result is-${now.stage}` }, icon(now.stage === "done" ? "check" : "info"), h("span", {}, now.text))];
    case "several":
      return now.parts.map((part, index) => partBody(part, where, index));
    case "ask":
      return [
        h("p", { class: "command-question", id: `command-question-${where}` }, now.text),
        h(
          "div",
          { class: "command-options", role: "group", "aria-labelledby": `command-question-${where}` },
          now.labels.map((label, index) =>
            h(
              "button",
              {
                type: "button",
                class: "button button-secondary button-small command-option",
                dataset: { key: `command-option:${where}:${index}` },
                // Chosen: the words asked about go, for the next command.
                onclick: thenField(where, () => {
                  if (chooseOption(index)) clearWords();
                }),
              },
              h("span", { dir: "auto" }, label)
            )
          )
        ),
      ];
    case "confirm":
      return [said(now.said), note(now), confirmControl(now, where, { confirm: () => confirmCommand(), cancel: clearCommand })];
    case "door":
      return [said(now.said), doorControl(now.action.device)];
    case "scene":
      return [said(now.said), sceneControl(now.action.id, where)];
    default:
      return [
        h("p", { class: `command-result is-${now.stage === "unknown" || now.kind === "error" ? "error" : "info"}` }, now.text),
        now.examples ? examples(now.examples, where) : null,
      ];
  }
}

function output(where) {
  if (listening) {
    return h(
      "div",
      { class: "command-output is-listening" },
      h(
        "div",
        { class: "command-body" },
        h("p", { class: "command-said" }, icon("mic"), h("span", { dir: "auto" }, heard ? t("command.hearing", { words: isolate(heard) }) : t("command.listening"))),
        h("p", { class: "command-note" }, t("command.speechNote"))
      )
    );
  }
  const now = commandState();
  if (!now) return null;
  return h(
    "div",
    { class: `command-output is-${now.stage}` },
    h("div", { class: "command-body" }, body(now, where)),
    now.stage === "running" || now.parts?.some((part) => part.stage === "running") ? null : iconButton("close", t("command.dismiss"), { class: "command-dismiss", dataset: { key: `command-dismiss:${where}` }, onclick: thenField(where, clearCommand) })
  );
}

// For the renderer's signature (app.js): what the command area shows.
export function commandSignature() {
  return [commandState(), Boolean(listening), heard, speechOff];
}

function allowed() {
  return Boolean(state.apiKey) && state.loaded && can("member");
}

let spoken = false;

// The live region that says what a command understood (dom.js), made as the field is used, before
// there is anything to say.
function readyToSpeak() {
  if (spoken) return;
  spoken = true;
  announce("");
}

// Home: under the header, for everyone who controls something. The same section each time.
let homeSection = null;

export function commandBar() {
  if (!allowed()) return null;
  const { form, output: below } = bar("home");
  homeSection ||= h("section", { class: "command" }, form, below);
  homeSection.setAttribute("aria-label", t("command.label"));
  return homeSection;
}

// ---- from the other screens ----------------------------------------------------------------

// The dialog, made once: its head, the field, the answer, and its own live region (a modal dialog
// makes the rest of the page inert, the app's live region too).
let dialog = null;
let dialogParts = null;
let dialogDrawn = "";

function drawDialog(force = false) {
  const now = JSON.stringify([commandSignature(), currentLanguage(), ui.relayStage, ui.doorbellStage, ui.sceneRuns, Object.keys(state.errors)]);
  if (!force && now === dialogDrawn) return;
  dialogDrawn = now;
  const active = document.activeElement;
  const key = active && dialog.contains(active) && active !== bars.get("dialog")?.input ? active.dataset?.key : null;
  dialogParts.title.textContent = t("command.title");
  dialogParts.close.setAttribute("aria-label", t("common.close"));
  dialogParts.close.setAttribute("title", t("common.close"));
  bar("dialog");
  // A button of the answer had the focus: the same button, redrawn.
  const target = key ? [...dialog.querySelectorAll("[data-key]")].find((item) => item.dataset.key === key && !item.disabled) : null;
  if (target && target !== document.activeElement) target.focus({ preventScroll: true });
}

export function openCommandDialog() {
  if (!allowed()) return;
  if (!dialog) {
    const { form, output: below } = bar("dialog");
    const title = h("h2", { id: "command-dialog-title", class: "dialog-title" });
    const close = iconButton("close", t("common.close"), { onclick: () => dialog.close() });
    const live = h("p", { class: "visually-hidden", role: "status" });
    dialogParts = { title, close, live };
    dialog = h("dialog", { id: "command-dialog", class: "dialog command-dialog", "aria-labelledby": "command-dialog-title" }, h("div", { class: "dialog-head" }, title, close), form, below, live);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    // Closed while listening: nothing heard is done. The page's live region speaks again.
    dialog.addEventListener("close", () => {
      abortListening();
      speakFrom(null);
    });
    document.body.append(dialog);
    subscribe(() => {
      if (dialog.open) drawDialog();
    });
  }
  drawDialog(true);
  if (!dialog.open) dialog.showModal();
  speakFrom(dialogParts.live);
  bars.get("dialog").input.focus();
}

// A screen's header: the way to the dialog, on screens wide enough for it (styles.css).
export function commandButton() {
  if (!allowed()) return null;
  return iconButton("say", t("command.open"), { class: "command-open", dataset: { key: "command-open" }, onclick: openCommandDialog });
}

// "/" anywhere but in a field: Home's field, or the dialog.
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
  const target = event.target;
  if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
  if (!allowed() || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  const home = document.querySelector("#command-input-home");
  if (home) home.focus();
  else openCommandDialog();
});
