// Settings → Controller → Backup (admins; ADR-042, docs/BACKUP.md): download everything
// DirectorLink keeps as a file locked with a password, and restore from one. The file is opened
// here, the controller checks it without changing anything, and only once the admin has seen what
// it holds and confirmed is everything replaced. A DirectorLink before 1.4.0 has no backups: the
// panel shows only when GET /v1/system says the controller has them (features.backup). Automatic
// backups to the account (1.6.0, ADR-048) are a section of it (views/cloud-backup.js), restored
// through the same check and preview.

import { BackupFileError, FILE_EXTENSION, MAX_FILE_BYTES, MIN_PASSWORD, checkBackup, decryptBackup, makeBackup, passwordStrength, readHeader, restoreBackup } from "../backup.js";
import { h, name } from "../dom.js";
import { formatDateTime, t } from "../i18n.js";
import { icon } from "../icons.js";
import { saveRemote, savedRemote } from "../remote.js";
import { connect, errorText, roleLabel, whenForgotten } from "../session.js";
import { can, notify, state, ui } from "../state.js";
import { automaticSection } from "./cloud-backup.js";

// What is typed and chosen: the passwords, the file and the opened backup stay in this module,
// never in storage or in `ui` (the redraw signature), and go when the panel closes. The file input
// is kept as it is across redraws, so that it still shows the file chosen.
let secrets = {};
let fileInput = null;

function forgetSecrets() {
  secrets = { password: "", confirm: "", open: "", file: null, document: null, upload: null };
  fileInput = null;
}
forgetSecrets();
// This device's key forgotten (Forget, Pair again, a revoked key): nothing of a backup stays.
whenForgotten(() => {
  forgetSecrets();
  ui.backup = { stage: null };
});

// ui.backup: { stage: null | "download" | "restore" | "preview" | "done", busy, message, fileName,
// header, preview, result, relinked, replaces (the backup's key this device is), moveRemote }.
function panel() {
  ui.backup ??= { stage: null };
  return ui.backup;
}

function show(stage, extra = {}) {
  ui.backup = { stage, ...extra };
  notify();
}

function close(message = null) {
  forgetSecrets();
  show(null, message ? { message } : {});
}

function say(kind, text) {
  panel().message = { kind, text };
  notify();
}

export function backupError(error) {
  if (error instanceof BackupFileError) {
    return t({ WRONG_PASSWORD: "backup.errors.wrongPassword", NEWER_FILE: "backup.errors.newerFile", TOO_LARGE: "backup.errors.fileTooLarge" }[error.code] || "backup.errors.notABackup");
  }
  const key = {
    BACKUP_TOO_NEW: "backup.errors.tooNew",
    BACKUP_INVALID: "backup.errors.invalid",
    PROJECT_NOT_READY: "backup.errors.notReady",
    RESTORE_FAILED: "backup.errors.failed",
    BACKUP_TOO_LARGE: "backup.errors.tooLarge",
    SEALED_REQUEST_REQUIRED: "backup.errors.sealed",
    UPLOAD_NOT_FOUND: "backup.errors.uploadGone",
    KEYS_KEPT: "backup.errors.keysKept",
    LAST_ADMIN: "backup.errors.lastAdmin",
    UNAVAILABLE: "backup.errors.unavailable",
  }[error?.code];
  if (key) return t(key);
  // A DirectorLink before 1.4.0 has no backup routes.
  if (error?.status === 404 || error?.status === 405) return t("backup.errors.updateDriver");
  return errorText(error);
}

function field(id, label, ...content) {
  return h("div", { class: "field" }, h("label", { class: "field-label", for: id }, label), ...content);
}

// The typed value is set as the input's value, never as its value attribute: the page's HTML
// never holds a password.
function passwordInput(id, value, autocomplete, onInput) {
  const input = h("input", {
    id,
    type: "password",
    autocomplete,
    autocapitalize: "off",
    spellcheck: "false",
    minlength: String(MIN_PASSWORD),
    dataset: { key: id },
    oninput: (event) => onInput(event.target.value),
  });
  input.value = value;
  return input;
}

function buttons(...children) {
  return h("div", { class: "button-row" }, ...children);
}

function cancelButton() {
  return h("button", { type: "button", class: "button button-quiet", dataset: { key: "backup-cancel" }, disabled: Boolean(panel().busy), onclick: () => close() }, t("backup.cancel"));
}

// ---- Download ----------------------------------------------------------------------------------

function strengthText(password) {
  return password ? `${t("backup.downloadForm.strengthLabel")}: ${t(`backup.downloadForm.strength.${passwordStrength(password)}`)}` : "";
}

// Saves the file through the browser's download.
function saveFile(text, fileName) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const link = h("a", { href: url, download: fileName, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function download(event) {
  event.preventDefault();
  const current = panel();
  if (current.busy) return;
  if (secrets.password.length < MIN_PASSWORD) return say("error", t("backup.downloadForm.tooShort", { count: MIN_PASSWORD }));
  if (secrets.password !== secrets.confirm) return say("error", t("backup.downloadForm.mismatch"));
  current.busy = true;
  current.message = { kind: "info", text: t("backup.downloadForm.working") };
  notify();
  try {
    const { text, fileName } = await makeBackup(secrets.password);
    saveFile(text, fileName);
    close({ kind: "success", text: t("backup.downloadForm.saved", { name: fileName }) });
  } catch (error) {
    current.busy = false;
    if (ui.backup === current) say("error", backupError(error));
  }
}

function downloadForm(current) {
  const strength = h("p", { class: "field-help", id: "backup-strength", "aria-live": "polite" }, strengthText(secrets.password));
  return h(
    "form",
    { class: "backup-form", onsubmit: download, novalidate: true },
    h("p", { class: "notice notice-info" }, t("backup.downloadForm.warning")),
    field(
      "backup-password",
      t("backup.downloadForm.password"),
      passwordInput("backup-password", secrets.password, "new-password", (value) => {
        secrets.password = value;
        strength.textContent = strengthText(value);
      }),
      h("p", { class: "field-help" }, t("backup.downloadForm.hint", { count: MIN_PASSWORD })),
      strength
    ),
    field(
      "backup-confirm",
      t("backup.downloadForm.confirm"),
      passwordInput("backup-confirm", secrets.confirm, "new-password", (value) => {
        secrets.confirm = value;
      })
    ),
    buttons(
      h("button", { type: "submit", class: "button button-primary", dataset: { key: "backup-download-submit" }, disabled: Boolean(current.busy) }, icon("download"), t("backup.downloadForm.submit")),
      cancelButton()
    )
  );
}

// ---- Restore: the file and its password ----------------------------------------------------------

async function chooseFile(event) {
  const chosen = event.target.files?.[0];
  const current = panel();
  secrets.file = null;
  current.header = null;
  current.fileName = null;
  current.message = null;
  if (chosen) {
    try {
      // Not read at all when larger than any backup can be.
      if (Number(chosen.size) > MAX_FILE_BYTES) throw new BackupFileError("TOO_LARGE");
      const text = await chosen.text();
      const header = readHeader(text);
      secrets.file = text;
      current.fileName = chosen.name;
      current.header = { home: header.home ?? null, created_at: header.created_at ?? null };
    } catch (error) {
      current.message = { kind: "error", text: backupError(error) };
    }
  }
  notify();
}

function fileField() {
  fileInput ??= h("input", { id: "backup-file", type: "file", accept: `${FILE_EXTENSION},application/octet-stream,application/json`, dataset: { key: "backup-file" }, onchange: chooseFile });
  return fileInput;
}

async function open(event) {
  event.preventDefault();
  const current = panel();
  if (current.busy) return;
  if (!secrets.file) return say("error", t("backup.restoreForm.chooseFile"));
  if (!secrets.open) return say("error", t("backup.restoreForm.typePassword"));
  current.busy = true;
  current.message = { kind: "info", text: t("backup.restoreForm.opening") };
  notify();
  try {
    const { document } = await decryptBackup(secrets.file, secrets.open);
    say("info", t("backup.restoreForm.checking"));
    const { upload, preview } = await checkBackup(document);
    secrets.document = document;
    secrets.upload = upload;
    secrets.file = null;
    secrets.open = "";
    fileInput = null;
    show("preview", { preview, fileName: current.fileName, replaces: "", moveRemote: false });
  } catch (error) {
    current.busy = false;
    if (ui.backup === current) say("error", backupError(error));
  }
}

function madeText(home, createdAt) {
  const date = createdAt && Number.isFinite(Date.parse(createdAt)) ? formatDateTime(new Date(createdAt)) : "—";
  return { home: home || t("backup.unnamedHome"), date };
}

function restoreForm(current) {
  const said = current.header ? madeText(current.header.home, current.header.created_at) : null;
  return h(
    "form",
    { class: "backup-form", onsubmit: open, novalidate: true },
    h("p", { class: "field-help" }, t("backup.restoreForm.intro")),
    field(
      "backup-file",
      t("backup.restoreForm.file"),
      fileField(),
      said
        ? h("p", { class: "field-help", dataset: { key: "backup-file-says" } }, name(current.fileName || ""), " · ", t("backup.restoreForm.fileSays", said))
        : null
    ),
    field(
      "backup-open-password",
      t("backup.restoreForm.password"),
      passwordInput("backup-open-password", secrets.open, "current-password", (value) => {
        secrets.open = value;
      })
    ),
    buttons(
      h("button", { type: "submit", class: "button button-primary", dataset: { key: "backup-open-submit" }, disabled: Boolean(current.busy) }, t("backup.restoreForm.submit")),
      cancelButton()
    )
  );
}

// ---- What the backup holds, and restoring it -------------------------------------------------------

function kindText(kind) {
  const key = `backup.kinds.${kind}`;
  const text = t(key);
  return text === key ? String(kind) : text;
}

function whereText(use) {
  if (use.section === "scenes") return t("backup.where.scene", { name: use.name || "" });
  if (use.section === "sonos_rooms") return t("backup.where.sonosRoom", { name: use.name || "" });
  // The doors an admin added to a doorbell (1.11.0, ADR-078).
  if (use.section === "doorbell_doors") return t("backup.where.doorbellDoors", { name: use.name || "" });
  if (use.section === "profiles") return t("backup.where.profile", { name: use.name || "" });
  // A member's rooms, or the rooms hidden from members (1.8.0, ADR-054).
  if (use.section === "people") return use.name ? t("backup.where.personRooms", { name: use.name }) : t("backup.where.hiddenRooms");
  return t(`backup.where.${use.section === "room_order" ? "roomOrder" : "roomNames"}`);
}

function referenceLine(item, extra) {
  const place = item.room ? ` (${item.room})` : "";
  return h("li", { dir: "auto" }, `${kindText(item.kind)} `, name(`${item.name || `#${item.id}`}${place}`), extra ? ` — ${extra}` : "");
}

// A door or gate whose id is another one now is left out, not moved: what it is now, then where
// the backup used it.
function unmatchedText(item) {
  const uses = (item.used_in || []).map(whereText).join(", ");
  return [item.now ? t("backup.preview.nowNamed", { name: item.now }) : "", uses].filter(Boolean).join("; ");
}

function remoteNote(remote) {
  if (remote.action === "restore") return t(remote.remote_access ? "backup.preview.remoteRestore" : "backup.preview.remoteOff");
  if (remote.action === "kept") return t("backup.preview.remoteKept");
  if (remote.action === "none") return t("backup.preview.remoteNone");
  return t("backup.preview.remoteSame");
}

// What the preview and the result both say: counts, notes, keys, references, Composer.
function summary(preview, { result = false } = {}) {
  const counts = preview.counts || {};
  const keys = preview.keys || {};
  const remote = preview.remote || {};
  const references = preview.references || {};
  const leftOut = preview.left_out || {};
  const kept = keys.action === "kept";
  const notes = [
    kept ? t("backup.preview.keysKept") : t("backup.preview.yoursAdded"),
    kept ? null : t("backup.preview.othersPair"),
    keys.replaced ? t("backup.preview.replaced", { name: keys.replaced.name }) : null,
    keys.conflict ? t("backup.preview.conflict") : null,
    keys.expired ? t("backup.preview.expired", { count: keys.expired }) : null,
    keys.left_out ? t("backup.preview.leftOutKeys", { count: keys.left_out }) : null,
    keys.over_limit ? t("backup.preview.overLimit", { count: keys.limit }) : null,
    remoteNote(remote),
    t("backup.preview.schedulesFresh"),
    t("backup.preview.invitations"),
    leftOut.steps ? t("backup.preview.leftOutSteps", { count: leftOut.steps }) : null,
    leftOut.schedules ? t("backup.preview.leftOutSchedules", { count: leftOut.schedules }) : null,
    leftOut.scenes || leftOut.profiles ? t("backup.preview.leftOutOther", { count: (leftOut.scenes || 0) + (leftOut.profiles || 0) }) : null,
  ].filter(Boolean);
  const rows = [
    ["scenes", counts.scenes],
    ["schedules", counts.schedules],
    ["keys", counts.keys],
    ["profiles", counts.profiles],
    ["roomNames", counts.room_names],
    ["roomOrder", counts.room_order],
    // A backup before 1.6.0 has no Sonos rooms (null): the choices made here stay.
    ...(Number.isInteger(counts.sonos_rooms) ? [["sonosRooms", counts.sonos_rooms]] : []),
    // Scene links (1.7.0): only from a controller that has them.
    ...(Number.isInteger(counts.scene_links) ? [["sceneLinks", counts.scene_links]] : []),
    // Doors added to doorbells (1.11.0): only from a backup that has them.
    ...(Number.isInteger(counts.doorbell_doors) ? [["doorbellDoors", counts.doorbell_doors]] : []),
  ];
  const back = Array.isArray(keys.items) ? keys.items : [];
  const unmatched = references.unmatched || [];
  const byName = references.by_name || [];
  const renamed = references.renamed || [];
  const composer = preview.composer || [];
  return [
    remote.old_controller
      ? h("p", { class: "notice notice-error", role: result ? "status" : null, dataset: { key: result ? "backup-result-old-controller" : "backup-old-controller" } }, t("backup.preview.oldController"))
      : null,
    h(
      "dl",
      { class: "facts", dataset: { key: result ? "backup-result-counts" : "backup-preview-counts" } },
      rows.map(([key, value]) => h("div", { class: "fact" }, h("dt", {}, t(`backup.preview.${key}`)), h("dd", {}, String(value ?? 0))))
    ),
    h("ul", { class: "backup-notes" }, notes.map((note) => h("li", {}, note))),
    back.length
      ? h(
          "div",
          { class: "backup-references", dataset: { key: "backup-keys" } },
          h("h4", { class: "backup-heading" }, t("backup.preview.keysBack")),
          h("ul", {}, back.map((item) => h("li", { dir: "auto" }, name(item.name), ` — ${roleLabel(item.role)}`)))
        )
      : null,
    byName.length
      ? h("div", { class: "backup-references" }, h("h4", { class: "backup-heading" }, t("backup.preview.byName")), h("ul", {}, byName.map((item) => referenceLine(item))))
      : null,
    renamed.length
      ? h(
          "div",
          { class: "backup-references", dataset: { key: "backup-renamed" } },
          h("h4", { class: "backup-heading" }, t("backup.preview.renamed")),
          h("ul", {}, renamed.map((item) => h("li", { dir: "auto" }, `${kindText(item.kind)} `, name(item.name), " → ", name(item.now))))
        )
      : null,
    unmatched.length
      ? h(
          "div",
          { class: "backup-references", dataset: { key: "backup-unmatched" } },
          h("h4", { class: "backup-heading" }, t("backup.preview.unmatched")),
          h(
            "ul",
            {},
            unmatched.map((item) => referenceLine(item, unmatchedText(item))),
            references.unmatched_count > unmatched.length ? h("li", {}, t("backup.preview.more", { count: references.unmatched_count - unmatched.length })) : null
          )
        )
      : null,
    composer.length
      ? h(
          "div",
          { class: "backup-composer", dataset: { key: "backup-composer" } },
          h("h4", { class: "backup-heading" }, t("backup.preview.composerTitle")),
          h("p", { class: "field-help" }, t("backup.preview.composerHelp")),
          h(
            "dl",
            { class: "facts" },
            composer.map((item) =>
              h(
                "div",
                { class: "fact" },
                h("dt", { dir: "ltr" }, item.name),
                h("dd", { dir: "auto" }, `${t("backup.preview.composerBackup")}: ${item.backup ?? "—"} · ${t("backup.preview.composerNow")}: ${item.current ?? "—"}`)
              )
            )
          )
        )
      : null,
  ];
}

// The backup looks like another home's: said first, with why (ADR-042).
function anotherHomeNotice(preview) {
  const origin = preview.origin || {};
  if (!origin.another_home) return null;
  const home = preview.backup?.home || t("backup.unnamedHome");
  const reasons = (origin.reasons || []).map((reason) => t(`backup.preview.anotherReasons.${reason}`, { home, now: origin.home_now || t("backup.unnamedHome") }));
  return h(
    "div",
    { class: "notice notice-error", role: "alert", dataset: { key: "backup-another-home" } },
    h("p", {}, t("backup.preview.anotherHome", { home })),
    h("ul", {}, reasons.map((reason) => h("li", {}, reason))),
    h("p", {}, t("backup.preview.anotherHomeEnd"))
  );
}

// "This device is …": in the reinstall case, the backup's key this device had before, so that it
// takes that key's place (its favorites and role) and no old key is left on no device.
function thisDeviceField(current, keys) {
  const items = Array.isArray(keys.items) ? keys.items : [];
  if (keys.action !== "restore" || !items.length) return null;
  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label", for: "backup-this-device" }, t("backup.preview.thisDevice")),
    h(
      "select",
      {
        id: "backup-this-device",
        dataset: { key: "backup-this-device" },
        onchange: (event) => {
          current.replaces = event.target.value;
          notify();
        },
      },
      h("option", { value: "", selected: !current.replaces }, t("backup.preview.thisDeviceNone")),
      items.map((item) => h("option", { value: item.id, selected: current.replaces === item.id }, `${item.name} (${roleLabel(item.role)})`))
    ),
    h("p", { class: "field-help" }, t("backup.preview.thisDeviceHelp"))
  );
}

// Another home's remote access moves here only when asked.
function moveRemoteField(current, remote) {
  if (remote.action !== "kept") return null;
  return h(
    "div",
    { class: "toggle-row backup-move-remote" },
    h("input", {
      id: "backup-move-remote",
      type: "checkbox",
      checked: Boolean(current.moveRemote),
      dataset: { key: "backup-move-remote" },
      onchange: (event) => {
        current.moveRemote = Boolean(event.target.checked);
        notify();
      },
    }),
    h("label", { for: "backup-move-remote", class: "field-help" }, t("backup.preview.moveRemote"))
  );
}

async function replaceEverything() {
  const current = panel();
  if (current.busy || !secrets.document) return;
  const preview = current.preview || {};
  const home = preview.backup?.home || t("backup.unnamedHome");
  if (!window.confirm(t(preview.origin?.another_home ? "backup.preview.confirmAnother" : "backup.preview.confirm", { home }))) return;
  current.busy = true;
  current.message = { kind: "info", text: t("backup.preview.restoring") };
  notify();
  try {
    const answer = await restoreBackup(secrets.document, secrets.upload, { replacesKey: current.replaces || undefined, moveRemote: current.moveRemote === true });
    const result = answer?.restore || current.preview;
    // The home is now the backup's (remote access, ADR-042): a device linked to the one before
    // goes through the account to this one from now on.
    const linked = savedRemote();
    const relinked = Boolean(result?.remote?.action === "restore" && result.remote.home_id && linked && linked.home !== result.remote.home_id);
    if (relinked) saveRemote({ home: result.remote.home_id, keyId: linked.keyId });
    forgetSecrets();
    show("done", { result, relinked, restoredAt: answer?.restored_at || null });
    // Scenes, schedules, profiles and room names are the backup's now.
    connect();
  } catch (error) {
    current.busy = false;
    if (ui.backup === current) say("error", backupError(error));
  }
}

function previewPanel(current) {
  const preview = current.preview || {};
  const made = madeText(preview.backup?.home, preview.backup?.created_at);
  const keys = preview.keys || {};
  return h(
    "div",
    { class: "backup-preview", dataset: { key: "backup-preview" } },
    h("h4", { class: "backup-heading" }, t("backup.preview.title")),
    anotherHomeNotice(preview),
    h("p", {}, t("backup.preview.made", { ...made, version: preview.backup?.driver_version || "—" })),
    ...summary(preview),
    thisDeviceField(current, keys),
    moveRemoteField(current, preview.remote || {}),
    h("p", { class: "notice notice-error" }, t(keys.action === "kept" ? "backup.preview.warningKept" : "backup.preview.warning")),
    buttons(
      h(
        "button",
        { type: "button", class: "button button-danger", dataset: { key: "backup-replace" }, disabled: Boolean(current.busy), onclick: replaceEverything },
        t("backup.preview.replace")
      ),
      cancelButton()
    )
  );
}

function donePanel(current) {
  const result = current.result || {};
  const made = madeText(result.backup?.home, result.backup?.created_at);
  return h(
    "div",
    { class: "backup-preview", dataset: { key: "backup-done" } },
    h("p", { class: "notice notice-success", role: "status" }, t("backup.done.text", made)),
    current.relinked ? h("p", { class: "field-help" }, t("backup.done.relinked")) : null,
    ...summary(result, { result: true }),
    buttons(h("button", { type: "button", class: "button button-secondary", dataset: { key: "backup-done-ok" }, onclick: () => close() }, t("backup.done.ok")))
  );
}

// A backup opened from the account (views/cloud-backup.js): the controller checks it, and it is
// shown as a file's would be.
async function checkDocument(document) {
  const { upload, preview } = await checkBackup(document);
  forgetSecrets();
  secrets.document = document;
  secrets.upload = upload;
  show("preview", { preview, fileName: null, replaces: "", moveRemote: false });
}

// Whether this controller's DirectorLink has backups: GET /v1/system says so from 1.4.0; an older
// one does not (and would answer 404).
const hasBackups = () => state.system?.features?.backup === true;

// Settings → Controller's Backup card: for admins, once connected, with a DirectorLink that has
// backups.
export function backupPanel() {
  if (!state.loaded || !can("admin") || !hasBackups()) return null;
  const current = panel();
  const content = {
    download: downloadForm,
    restore: restoreForm,
    preview: previewPanel,
    done: donePanel,
  }[current.stage];
  return h(
    "section",
    { class: "card settings-card backup", id: "settings-backup", "aria-labelledby": "settings-backup-title" },
    h("h2", { class: "settings-title", id: "settings-backup-title" }, icon("archive"), t("backup.title")),
    current.stage ? null : h("p", { class: "field-help" }, t("backup.intro")),
    current.message
      ? h("p", { class: `notice notice-${current.message.kind}`, role: current.message.kind === "error" ? "alert" : "status", dataset: { key: "backup-message" } }, current.message.text)
      : null,
    content
      ? content(current)
      : buttons(
          h("button", { type: "button", class: "button button-secondary", dataset: { key: "backup-download" }, onclick: () => (forgetSecrets(), show("download")) }, icon("download"), t("backup.download")),
          h("button", { type: "button", class: "button button-secondary", dataset: { key: "backup-restore" }, onclick: () => (forgetSecrets(), show("restore")) }, icon("refresh"), t("backup.restore"))
        ),
    current.stage ? null : automaticSection({ check: checkDocument, errorOf: backupError })
  );
}
