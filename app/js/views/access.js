// People and devices (#/access, admin keys): the home's API keys with their roles, the invitations
// waiting to be accepted, and, for the home's owner, the accounts that belong to the home with the
// devices each uses, and those asking to join with an invitation made for another email, which
// the owner approves or refuses (docs/ACCOUNTS.md, ADR-041). Devices and invitations come from the
// controller; people and requests from the account service, which never sees the keys, only their
// ids. With DirectorLink 1.8.0 (ADR-054) a role is a person's, admin or member, with what a member
// may see and do (views/permissions.js); with an older controller, one of four per device.
//
// With DirectorLink 1.9.0 (ADR-061, `features.users`) the screen is Settings → Users, from
// GET /v1/users: each user with their role and access, whether their devices have a Google or Apple
// account, and under them every device, when it was last used, and Remove where the controller says
// the caller may. Admins see every user, the suggestions to bring an account's devices together
// (DirectorLink's servers say which devices share an account; nothing is merged until an admin
// confirms it, the owner for the owner's user), and make a pairing code for a user, or a new one, to
// pair a device at home; a member sees only their own user and removes their other devices. A user
// has at most five devices: a sixth is refused with the list (views/device-limit.js). The owner can
// make another admin the owner (ADR-064).
//
// Since 1.12.0 (ADR-083, `features.user_names`): admins add a user in two steps, a name and their
// access, then how they connect: Send a link (the email of their Google or Apple account; anywhere;
// 7 days; once), or a pairing code (at home, no account). The new user gets that name and access
// when the link is accepted; the name stays on the controller. Every user renames their own
// devices and names themself (admins any); a device not used for 30 days says so next to Remove.

import { h } from "../dom.js";
import { formatDateTime, formatRelative, formatTime, formatUntil, t } from "../i18n.js";
import { icon } from "../icons.js";
import { qrCanvas } from "../qr.js";
import { decideJoinRequest, invitationLink, joinCodeText, listJoinRequests, listMembers, removeMember, savedRemote } from "../remote.js";
import { linksMadeBy, linksSupported } from "../scene-links.js";
import { api, errorText, roleLabel } from "../session.js";
import { can, notify, state, ui } from "../state.js";
import { loadScenes } from "../scenes.js";
import { notReadyState, offlineBanner, pageHeader } from "./common.js";
import { deviceLimitOf, deviceLimitPanel, lastUsed, staleDevice } from "./device-limit.js";
import { makeInvitation } from "./device-join.js";
import { accessBody, accessSummary, copyAccess, newMemberAccess, peopleSupported, permissionsEditor } from "./permissions.js";

const ROLES = ["viewer", "member", "doors", "admin"];
const REFRESH_MS = 30000;
let running = null;
let queued = null;
let refreshTimer = null;

function failure(error) {
  return { error: errorText(error) };
}

// The controller has users (1.9.0, ADR-061): GET /v1/users, members adding their own devices.
export function usersSupported() {
  return state.system?.features?.users === true;
}

// The controller names new users, and lets every user name themself and their devices (1.12.0).
export function namesSupported() {
  return state.system?.features?.user_names === true;
}

// Every device of the users listed, with the user it belongs to (for an invitation's maker).
function devicesOf(users) {
  return (Array.isArray(users?.items) ? users.items : []).flatMap((user) => (user.devices || []).map((device) => ({ ...device, profile_id: user.id })));
}

// Settings → Users (1.9.0): the users the caller sees; for admins also the invitations waiting, and
// for the home's owner the accounts that belong to the home and those asking to join.
async function fetchUsers(home, accountStatus) {
  const admin = can("admin");
  const signedIn = Boolean(home) && accountStatus === "signed-in";
  const [users, invitations, people, requests, links] = await Promise.all([
    api("/v1/users").then((answer) => answer, failure),
    admin ? api("/v1/invitations").then((answer) => answer?.items || [], failure) : Promise.resolve([]),
    admin && signedIn
      ? listMembers(home).then(
          (answer) => (answer?.items || []).map((person) => ({ ...person, key_ids: Array.isArray(person.key_ids) ? person.key_ids : [] })),
          (error) => (error?.code === "OWNER_ONLY" || error?.code === "NOT_A_MEMBER" ? null : failure(error))
        )
      : Promise.resolve(null),
    admin && signedIn
      ? listJoinRequests(home).then(
          (answer) => answer?.items || [],
          (error) => (["OWNER_ONLY", "NOT_A_MEMBER", "NOT_FOUND"].includes(error?.code) ? null : failure(error))
        )
      : Promise.resolve(null),
    admin && linksSupported() ? api("/v1/scene-links").then((answer) => answer?.items || [], () => null) : Promise.resolve(null),
  ]);
  ui.access = { ...(ui.access || {}), at: Date.now(), home, accountStatus, users, devices: users?.error ? users : devicesOf(users), invitations, people, requests, links, profiles: null };
  notify();
}

async function fetchAccess() {
  const home = savedRemote()?.home || state.remoteInfo?.home_id || null;
  const accountStatus = state.account.status;
  if (usersSupported()) {
    await fetchUsers(home, accountStatus);
    return;
  }
  const [devices, invitations, people, profiles, requests, links] = await Promise.all([
    api("/v1/api-keys").then((answer) => answer?.items || [], failure),
    // Drivers before 0.10.0 have no invitations.
    api("/v1/invitations").then((answer) => answer?.items || [], (error) => (error?.status === 404 || error?.status === 405 ? [] : failure(error))),
    // Only the home's owner sees who belongs to it.
    home && accountStatus === "signed-in"
      ? listMembers(home).then(
          (answer) => (answer?.items || []).map((person) => ({ ...person, key_ids: Array.isArray(person.key_ids) ? person.key_ids : [] })),
          (error) => (error?.code === "OWNER_ONLY" || error?.code === "NOT_A_MEMBER" ? null : failure(error))
        )
      : Promise.resolve(null),
    // The profiles (persons) keys belong to; drivers before 0.12.0 have none.
    api("/v1/profiles").then((answer) => answer?.items || [], () => null),
    // Only the home's owner answers requests to join (an account service before 1.3.0 has none).
    home && accountStatus === "signed-in"
      ? listJoinRequests(home).then(
          (answer) => answer?.items || [],
          (error) => (["OWNER_ONLY", "NOT_A_MEMBER", "NOT_FOUND"].includes(error?.code) ? null : failure(error))
        )
      : Promise.resolve(null),
    // Scene links (1.7.0) go with the key that made them: revoking one says how many stop.
    linksSupported() ? api("/v1/scene-links").then((answer) => answer?.items || [], () => null) : Promise.resolve(null),
  ]);
  ui.access = { ...(ui.access || {}), at: Date.now(), home, accountStatus, devices, invitations, people, profiles, requests, links };
  notify();
}

// Loads what the screen shows into ui.access. A load asked for while one runs starts again after
// it, so what comes back is never older than the request.
export function loadAccess() {
  if (running) {
    queued ??= running.then(() => {
      queued = null;
      return loadAccess();
    });
    return queued;
  }
  running = fetchAccess().finally(() => {
    running = null;
  });
  return running;
}

// Entering the screen: fresh data, no old message.
export function resetAccess() {
  ui.access = null;
}

// While the screen is open it reloads every 30 s, even when nothing else redraws it.
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    if (!window.location.hash.startsWith("#/access")) return;
    // In the background: try again later rather than stop.
    if (document.hidden) scheduleRefresh();
    else loadAccess();
  }, REFRESH_MS);
}

// `explain(error)`: the action's own words for a refusal, when it has some.
async function act(work, done, explain = null) {
  ui.access = { ...(ui.access || {}), busy: true, message: null, limit: null };
  notify();
  let message;
  let limit = null;
  try {
    await work();
    message = done ? { kind: "success", text: done } : null;
  } catch (error) {
    // A user with five devices (1.9.0): the list, with Remove, instead of a sentence.
    limit = deviceLimitOf(error);
    message = limit ? null : { kind: "error", text: explain?.(error) || problemText(error) };
  }
  // The screen may have been left and opened again meanwhile (resetAccess).
  ui.access = { ...(ui.access || {}), busy: false, message, limit };
  await loadAccess();
}

// The controller's refusals about people (ADR-054), in the app's words.
function problemText(error) {
  switch (error?.code) {
    case "LAST_ADMIN":
      return peopleSupported() ? t("access.lastAdminPerson") : t("access.lastAdmin");
    case "OWNER_PROTECTED":
      return t("access.ownerProtected");
    case "OWNER_STAYS_ADMIN":
      return t("access.ownerStaysAdmin");
    case "INVALID_FIELD":
      // Bringing the owner's devices together keeps the owner's user (1.9.0).
      return error.problem?.errors?.[0]?.field === "keep" ? t("users.suggestion.ownerKeeps") : errorText(error);
    default:
      return errorText(error);
  }
}

// ---- people (1.8.0) ------------------------------------------------------------------------

// Opens a person's role and permissions to change (the scenes are needed to choose some).
function editPerson(profile) {
  ui.access = { ...ui.access, editing: { id: profile.id, draft: copyAccess(profile.access) }, message: null };
  if (state.scenes === null) loadScenes();
  notify();
}

function stopEditing() {
  ui.access = { ...ui.access, editing: null };
  notify();
}

// Saves what the editor holds; making an admin a member, or a member an admin, is asked first.
function savePerson(profile) {
  const draft = ui.access.editing?.draft;
  if (!draft || ui.access.busy) return;
  const wasAdmin = profile.access?.role === "admin";
  if (wasAdmin && draft.role === "member" && !window.confirm(t("access.makeMemberConfirm", { name: profile.name }))) return;
  if (!wasAdmin && draft.role === "admin" && !window.confirm(t("access.makeAdminConfirm", { name: profile.name }))) return;
  act(async () => {
    await api(`/v1/profiles/${profile.id}/access`, { method: "PATCH", body: accessBody(draft) });
    ui.access = { ...ui.access, editing: null };
  }, t("access.personSaved", { name: profile.name }));
}

// One person: their role, what a member may do, their devices; Edit opens the editor below.
function personRow(profile, devices) {
  const access = profile.access || {};
  const editing = ui.access.editing?.id === profile.id ? ui.access.editing : null;
  const theirs = devices.filter((device) => device.profile_id === profile.id);
  const mine = theirs.some((device) => device.current);
  const busy = Boolean(ui.access.busy);
  return h(
    "li",
    { class: "access-item access-person-item", dataset: { key: `access-profile-${profile.id}` } },
    h(
      "div",
      { class: "access-main" },
      h(
        "span",
        { class: "access-name", dir: "auto" },
        profile.name,
        access.owner ? h("span", { class: "access-badge" }, t("access.owner")) : null,
        mine ? h("span", { class: "access-badge" }, t("access.you")) : null
      ),
      h("span", { class: "access-sub", dataset: { key: `access-profile-role-${profile.id}` } }, access.role === "admin" ? roleLabel("admin") : `${roleLabel("member")} · ${accessSummary(access)}`),
      h("span", { class: "access-sub", dir: "auto" }, theirs.length ? theirs.map((device) => device.name).join(", ") : t("access.noDevices"))
    ),
    h(
      "div",
      { class: "access-actions" },
      access.owner
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "button button-small button-secondary",
              disabled: busy,
              "aria-expanded": String(Boolean(editing)),
              "aria-label": t("access.editFor", { name: profile.name }),
              dataset: { key: `access-edit-${profile.id}` },
              onclick: () => (editing ? stopEditing() : editPerson(profile)),
            },
            editing ? t("common.cancel") : t("access.edit")
          ),
      h(
        "button",
        { type: "button", class: "button button-small button-quiet", "aria-label": t("access.renameFor", { name: profile.name }), dataset: { key: `access-rename-profile-${profile.id}` }, onclick: () => renamePerson(profile) },
        t("access.rename")
      )
    ),
    editing
      ? h(
          "div",
          { class: "perm-editor", dataset: { key: `access-editor-${profile.id}` } },
          permissionsEditor(editing.draft, { prefix: `perm-${profile.id}`, changed: notify }),
          h(
            "div",
            { class: "button-row" },
            h("button", { type: "button", class: "button button-primary", disabled: busy, dataset: { key: `access-save-${profile.id}` }, onclick: () => savePerson(profile) }, t("access.save")),
            h("button", { type: "button", class: "button button-quiet", onclick: stopEditing }, t("common.cancel"))
          )
        )
      : null
  );
}

// " The 2 scene links made on it stop working too." after a question, when keys that made scene
// links are revoked (ADR-051); "" otherwise.
function linksNote(key, keyIds) {
  const count = keyIds.reduce((sum, id) => sum + linksMadeBy(ui.access.links, id), 0);
  return count ? ` ${t(key, { count })}` : "";
}

// Revoking a key: it stops working at home and away at once, and the scene links made with it; an
// account whose last key it was leaves the home (the controller tells the account service).
function revokeDevice(device) {
  if (ui.access.busy || !window.confirm(t("access.revokeConfirm", { name: device.name }) + linksNote("access.revokeLinks", [device.id]))) return;
  act(() => api(`/v1/api-keys/${device.id}`, { method: "DELETE" }), t("access.revoked", { name: device.name }));
}

// Asked first: a keyboard's arrow keys change a select at once. Demoting an admin also revokes the
// invitations that key made.
function changeRole(device, role, select) {
  const question = device.role === "admin" && role !== "admin" ? "access.roleConfirmAdmin" : "access.roleConfirm";
  if (ui.access.busy || !window.confirm(t(question, { name: device.name, role: roleLabel(role) }))) {
    select.value = device.role;
    return;
  }
  act(() => api(`/v1/api-keys/${device.id}`, { method: "PATCH", body: { role } }), t("access.roleChanged", { name: device.name, role: roleLabel(role) }));
}

// Moves a device to another person's profile: it then shares their language and favorites (and,
// with 1.8.0, has their access).
function movePerson(device, profile, select) {
  const question = peopleSupported() ? "access.moveConfirmAccess" : "access.moveConfirm";
  if (ui.access.busy || !window.confirm(t(question, { device: device.name, person: profile.name }))) {
    select.value = device.profile_id || "";
    return;
  }
  act(() => api(`/v1/api-keys/${device.id}`, { method: "PATCH", body: { profile_id: profile.id } }), t("access.moved", { device: device.name, person: profile.name }));
}

function renamePerson(profile) {
  const name = window.prompt(t("access.renamePrompt"), profile.name);
  if (!name || !name.trim() || name.trim() === profile.name) return;
  const value = name.trim().slice(0, 64);
  // One's own user (1.12.0): any user names themself; admins rename anyone.
  const own = profile.you === true && namesSupported();
  act(async () => {
    const answer = own
      ? await api("/v1/profile", { method: "PATCH", body: { name: value } })
      : await api(`/v1/profiles/${profile.id}`, { method: "PATCH", body: { name: value } });
    if (profile.you && state.profile) state.profile = own && answer && typeof answer === "object" ? { ...state.profile, ...answer, prefs: state.profile.prefs } : { ...state.profile, name: value };
  }, t("access.renamed", { name: value }));
}

// A device renamed by its user, or an admin (1.12.0 for a member; admins could before).
function renameDevice(device) {
  if (ui.access.busy) return;
  const name = window.prompt(t("users.device.renamePrompt"), device.name);
  if (!name || !name.trim() || name.trim() === device.name) return;
  const value = name.trim().slice(0, 64);
  act(() => api(`/v1/api-keys/${device.id}`, { method: "PATCH", body: { name: value } }), t("users.device.renamed", { name: value }));
}

function revokeInvitation(invitation) {
  if (ui.access.busy || !window.confirm(t("access.revokeInvitationConfirm"))) return;
  act(() => api(`/v1/invitations/${invitation.id}`, { method: "DELETE" }), t("access.invitationRevoked"));
}

// Removing a person: their devices' keys are revoked at home first (never this device's: a shared
// device may be listed under them), then the account leaves the home. Revoking their last key
// usually ends the membership by itself, so "not a member any more" is the expected answer.
function removePerson(person, devices) {
  const name = person.name || person.email;
  // Without the controller's keys, their devices cannot be revoked: then nothing is done.
  if (!Array.isArray(ui.access.devices)) {
    ui.access = { ...ui.access, message: { kind: "error", text: t("access.devicesUnknown") } };
    notify();
    return;
  }
  const current = devices.find((device) => device.current)?.id;
  const keys = person.key_ids.filter((id) => id !== current && devices.some((device) => device.id === id));
  const question = (keys.length ? t("access.removeConfirm", { name, count: keys.length }) : t("access.removeConfirmUnknown", { name })) + linksNote("access.removeLinks", keys);
  if (ui.access.busy || !window.confirm(question)) return;
  act(async () => {
    for (const id of keys) {
      await api(`/v1/api-keys/${id}`, { method: "DELETE" }).catch((error) => {
        if (error?.status !== 404) throw error;
      });
    }
    await removeMember(ui.access.home, person.user_id).catch((error) => {
      if (error?.code !== "NOT_FOUND") throw error;
    });
  }, t("access.removed", { name }));
}

// The owner lets an account join with an invitation made for another email, or refuses it. The
// code shown to the person asking is the proof: someone else with the link sees another one.
function answerRequest(request, decision) {
  const name = request.name || request.email || t("access.requestNoName");
  const code = joinCodeText(request.code);
  const question = decision === "approve" ? t("access.approveConfirm", { name, code }) : t("access.refuseConfirm", { name });
  if (ui.access.busy || !window.confirm(question)) return;
  act(() => decideJoinRequest(ui.access.home, request.id, decision), decision === "approve" ? t("access.approvedDone", { name }) : t("access.refusedDone", { name }));
}

// Everything the owner has to tell the person they invited from someone else holding the link:
// the name (not checked by anyone), the email or that Apple hides it, how the account signs in and
// how new it is, when it asked, for which invitation, and the code to compare.
function requestRow(request, invitations, devices) {
  const name = request.name || t("access.requestNoName");
  const busy = Boolean(ui.access.busy);
  const atHome = invitations.find((invitation) => invitation.id === request.invitation.id);
  // The controller's list was read and the invitation is not in it: revoked (or used) at home.
  const gone = Array.isArray(ui.access.invitations) && !atHome;
  const maker = atHome ? devices.find((device) => device.id === atHome.created_by)?.name : null;
  const providers = (request.providers || []).map((provider) => t(`settings.account.provider.${provider}`)).join(", ");
  const facts = [
    request.email_hidden ? t("access.emailHidden") : request.email,
    providers ? t("access.signsInWith", { providers }) : null,
    t("access.accountMade", { time: formatRelative(request.account_created_at) }),
    t("access.asked", { time: formatRelative(request.requested_at) }),
  ];
  const invitation = [
    t("access.requestFor", { email: request.invitation.email }),
    atHome ? roleLabel(atHome.role) : null,
    maker ? t("access.madeBy", { name: maker }) : null,
    t("access.expires", { time: formatDateTime(new Date(request.invitation.expires_at)) }),
  ];
  return h(
    "li",
    { class: "access-item access-request", dataset: { key: `access-request-${request.id}` } },
    h(
      "div",
      { class: "access-main" },
      h("span", { class: "access-name", dir: "auto" }, name, request.status === "approved" ? h("span", { class: "access-badge" }, t("access.approvedBadge")) : null),
      h("span", { class: "access-sub", dir: "auto" }, facts.filter(Boolean).join(" · ")),
      h("span", { class: "access-sub", dir: "auto" }, invitation.filter(Boolean).join(" · ")),
      h("span", { class: "access-code" }, t("access.requestCode"), " ", h("strong", { dir: "ltr", dataset: { key: `access-request-code-${request.id}` } }, joinCodeText(request.code))),
      gone ? h("span", { class: "access-sub" }, t("access.requestInvitationGone")) : null,
      request.status === "approved" ? h("span", { class: "access-sub" }, t("access.approvedWaiting")) : null
    ),
    h(
      "div",
      { class: "access-actions" },
      request.status === "pending"
        ? h(
            "button",
            { type: "button", class: "button button-small button-primary", disabled: busy || gone, "aria-label": t("access.approveFor", { name }), dataset: { key: `access-approve-${request.id}` }, onclick: () => answerRequest(request, "approve") },
            t("access.approve")
          )
        : null,
      h(
        "button",
        { type: "button", class: "button button-small button-danger", disabled: busy, "aria-label": t("access.refuseFor", { name }), dataset: { key: `access-refuse-${request.id}` }, onclick: () => answerRequest(request, "refuse") },
        request.status === "approved" ? t("access.withdrawApproval") : t("access.refuse")
      )
    )
  );
}

function section(id, title, help, content) {
  return h(
    "section",
    { class: "card settings-card", id: `access-${id}`, "aria-labelledby": `access-${id}-title` },
    h("h2", { class: "settings-title", id: `access-${id}-title` }, icon(id === "people" || id === "persons" || id === "requests" ? "user" : id === "devices" ? "key" : "plus"), title),
    help ? h("p", { class: "field-help" }, help) : null,
    content
  );
}

function problemNote(value) {
  return value && !Array.isArray(value) && value.error ? h("p", { class: "notice notice-error", role: "status" }, value.error) : null;
}

// A key that expires (ADR-040: the API console's lasts a day).
export function expiry(device, now = Date.now()) {
  if (!device.expires_at) return null;
  return Date.parse(device.expires_at) > now ? t("access.keyExpires", { time: formatUntil(device.expires_at, now) }) : t("access.keyExpired");
}

// The person (profile) a device belongs to, and a way to move it to another one.
function personPicker(device, profiles) {
  if (!profiles?.length) return null;
  const current = profiles.find((profile) => profile.id === device.profile_id);
  const select = h(
    "select",
    { class: "access-role", "aria-label": t("access.personFor", { name: device.name }), dataset: { key: `access-person-${device.id}` } },
    ...profiles.map((profile) => h("option", { value: profile.id, selected: profile.id === device.profile_id }, profile.name))
  );
  select.addEventListener("change", () => {
    const target = profiles.find((profile) => profile.id === select.value);
    if (target) movePerson(device, target, select);
  });
  return h(
    "span",
    { class: "access-person" },
    h("span", { class: "access-sub" }, t("access.person")),
    select,
    current
      ? h("button", { type: "button", class: "button button-small button-quiet", "aria-label": t("access.renameFor", { name: current.name }), dataset: { key: `access-rename-${device.id}` }, onclick: () => renamePerson(current) }, t("access.rename"))
      : null
  );
}

// `owners`: key id → the accounts that use it, or null when this view cannot know (not the owner).
// With 1.8.0 a device has its person's role (set under People), so it has no role of its own.
function deviceRow(device, owners, profiles) {
  const busy = Boolean(ui.access.busy);
  const users = owners ? owners.get(device.id) || [] : null;
  const account = users === null ? null : users.length ? users.map((person) => person.name || person.email).join(", ") : t("access.noAccount");
  const role = peopleSupported() ? null : h(
    "select",
    { class: "access-role", "aria-label": t("access.roleFor", { name: device.name }), disabled: device.current, dataset: { key: `access-role-${device.id}` } },
    ...ROLES.map((value) => h("option", { value, selected: value === device.role }, roleLabel(value)))
  );
  role?.addEventListener("change", () => changeRole(device, role.value, role));
  return h(
    "li",
    { class: "access-item", dataset: { key: `access-device-${device.id}` } },
    h(
      "div",
      { class: "access-main" },
      h("span", { class: "access-name", dir: "auto" }, device.name, device.current ? h("span", { class: "access-badge" }, t("access.thisDevice")) : null),
      h("span", { class: "access-sub", dir: "auto" }, [account, lastUsed(device), expiry(device)].filter(Boolean).join(" · ")),
      personPicker(device, profiles)
    ),
    h(
      "div",
      { class: "access-actions" },
      role,
      device.current
        ? null
        : h(
            "button",
            { type: "button", class: "button button-small button-danger", disabled: busy, "aria-label": t("access.revokeFor", { name: device.name }), dataset: { key: `access-revoke-${device.id}` }, onclick: () => revokeDevice(device) },
            t("access.revoke")
          )
    )
  );
}

function accountRow(person, devices) {
  const name = person.name || person.email;
  const names = person.key_ids.map((id) => devices.find((device) => device.id === id)?.name).filter(Boolean);
  return h(
    "li",
    { class: "access-item", dataset: { key: `access-person-${person.user_id}` } },
    h(
      "div",
      { class: "access-main" },
      h("span", { class: "access-name", dir: "auto" }, name, person.owner ? h("span", { class: "access-badge" }, t("access.owner")) : null),
      h("span", { class: "access-sub", dir: "auto" }, [person.name ? person.email : null, names.length ? names.join(", ") : t("access.noDevices")].filter(Boolean).join(" · "))
    ),
    person.owner
      ? null
      : h(
          "div",
          { class: "access-actions" },
          h(
            "button",
            { type: "button", class: "button button-small button-danger", disabled: Boolean(ui.access.busy), "aria-label": t("access.removeFor", { name }), dataset: { key: `access-remove-${person.user_id}` }, onclick: () => removePerson(person, devices) },
            t("access.remove")
          )
        )
  );
}

function invitationRow(invitation, devices) {
  const maker = devices.find((device) => device.id === invitation.created_by)?.name;
  // With 1.8.0, the person it makes: an admin, or a member and what they may do.
  const role = invitation.access
    ? invitation.access.role === "admin"
      ? roleLabel("admin")
      : `${roleLabel("member")} · ${accessSummary(invitation.access)}`
    : roleLabel(invitation.role);
  return h(
    "li",
    { class: "access-item", dataset: { key: `access-invitation-${invitation.id}` } },
    h(
      "div",
      { class: "access-main" },
      // The new user's name (1.12.0), when the admin gave one.
      h("span", { class: "access-name", dir: "auto" }, invitation.name ? `${invitation.name} · ${role}` : role),
      h("span", { class: "access-sub", dir: "auto" }, [t("access.expires", { time: formatDateTime(new Date(invitation.expires_at)) }), maker ? t("access.madeBy", { name: maker }) : null].filter(Boolean).join(" · "))
    ),
    h(
      "div",
      { class: "access-actions" },
      h(
        "button",
        { type: "button", class: "button button-small button-secondary", disabled: Boolean(ui.access.busy), "aria-label": t("access.revokeInvitationFor", { role }), dataset: { key: `access-revoke-invitation-${invitation.id}` }, onclick: () => revokeInvitation(invitation) },
        t("access.revokeInvitation")
      )
    )
  );
}

// ---- users (1.9.0, ADR-061) ---------------------------------------------------------------------

// Removing a device: at home and away at once; the user goes with their last one.
function removeDevice(device, user) {
  if (ui.access.busy) return;
  const last = user && (user.devices || []).length === 1;
  const question = (last ? t("users.removeLastConfirm", { name: device.name, user: user.name }) : t("access.revokeConfirm", { name: device.name })) + linksNote("access.revokeLinks", [device.id]);
  if (!window.confirm(question)) return;
  act(() => api(`/v1/api-keys/${device.id}`, { method: "DELETE" }), t("access.revoked", { name: device.name }));
}

// From the "Remove a device first" list: removed, then the person tries again.
function removeFromLimit(device) {
  if (ui.access.busy || !window.confirm(t("access.revokeConfirm", { name: device.name }))) return;
  act(() => api(`/v1/api-keys/${device.id}`, { method: "DELETE" }), t("users.limit.removed", { name: device.name }));
}

// A pairing code for a user (or a new user): the device that pairs with it at home joins them.
function makePairingCode(body, forName) {
  if (ui.access.busy) return;
  act(async () => {
    const code = await api("/v1/pairing-code", { method: "POST", body });
    ui.access = { ...ui.access, pairing: { ...code, forName, at: Date.now() }, adding: null };
  }, null);
}

function closePairingCode() {
  act(async () => {
    await api("/v1/pairing-code", { method: "DELETE" }).catch((error) => {
      if (error?.status !== 404) throw error;
    });
    ui.access = { ...ui.access, pairing: null };
  }, t("users.pairing.closed"));
}

function pairingPanel() {
  const pairing = ui.access.pairing;
  if (!pairing) return null;
  const until = pairing.expires_at ? formatTime(new Date(pairing.expires_at)) : "";
  return h(
    "div",
    { class: "card settings-card pairing-panel", dataset: { key: "users-pairing" } },
    h("h2", { class: "settings-title" }, icon("key"), t("users.pairing.title", { name: pairing.user?.name || pairing.forName || "" })),
    h("p", { class: "pairing-code", dir: "ltr", dataset: { key: "users-pairing-code" } }, pairing.code),
    h("p", { class: "field-help" }, t("users.pairing.help", { time: until })),
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "button", class: "button button-secondary", dataset: { key: "users-pairing-close" }, disabled: Boolean(ui.access.busy), onclick: closePairingCode }, t("users.pairing.close")),
      h("button", { type: "button", class: "button button-quiet", onclick: () => { ui.access = { ...ui.access, pairing: null }; notify(); } }, t("common.done"))
    )
  );
}

// Add a user (1.12.0, ADR-083): first a name and their access; then how they connect, a link to the
// email of their Google or Apple account, or a pairing code at home. Both make a user of that name.
function openAddUser() {
  ui.access = { ...ui.access, adding: { step: 1, name: "", email: "", access: newMemberAccess() }, added: null, message: null };
  if (state.scenes === null) loadScenes();
  notify();
}

function closeAddUser() {
  ui.access = { ...ui.access, adding: null };
  notify();
}

function addUserNext(event) {
  event?.preventDefault?.();
  const draft = ui.access.adding;
  const name = (draft.name || "").trim();
  if (!name) {
    ui.access = { ...ui.access, message: { kind: "error", text: t("users.add.nameNeeded") } };
    notify();
    return;
  }
  ui.access = { ...ui.access, adding: { ...draft, name: name.slice(0, 64), step: 2 }, message: null };
  notify();
}

// Send a link: an invitation for a new user of that name and access, for their account's email.
function addUserLink(event) {
  event?.preventDefault?.();
  const draft = ui.access.adding;
  const email = (draft.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    ui.access = { ...ui.access, message: { kind: "error", text: t("settings.account.home.badEmail") } };
    notify();
    return;
  }
  const role = draft.access.role === "admin" ? "admin" : "member";
  const named = namesSupported();
  act(async () => {
    const invitation = await makeInvitation({ forSelf: false, email, role, access: role === "member" ? accessBody(draft.access) : undefined, name: named ? draft.name : undefined });
    ui.access = { ...ui.access, adding: null, added: { name: draft.name, email, named, link: invitationLink(invitation.home_id, invitation), expiresAt: invitation.expires_at } };
  }, null);
}

// Pairing code: as New user at home was (1.9.0), with the name and access of step 1.
function addUserCode() {
  const draft = ui.access.adding;
  makePairingCode({ name: draft.name, ...accessBody(draft.access) }, draft.name);
}

function addUserPanel() {
  const draft = ui.access.adding;
  if (!draft) return null;
  const busy = Boolean(ui.access.busy);
  const cancel = h("button", { type: "button", class: "button button-quiet", dataset: { key: "users-add-cancel" }, onclick: closeAddUser }, t("common.cancel"));
  if (draft.step !== 2) {
    const input = h("input", { id: "users-add-name", type: "text", maxlength: "64", value: draft.name || "", autocomplete: "off", dir: "auto", required: true, dataset: { key: "users-add-name" } });
    input.addEventListener("input", () => {
      draft.name = input.value;
    });
    return h(
      "form",
      { class: "card settings-card invite-form add-user", novalidate: true, dataset: { key: "users-add" }, onsubmit: addUserNext },
      h("h2", { class: "settings-title" }, icon("plus"), t("users.add.title")),
      h("label", { class: "field-label", for: "users-add-name" }, t("users.add.name")),
      input,
      h("div", { class: "perm-editor" }, permissionsEditor(draft.access, { prefix: "users-add", changed: notify })),
      h(
        "div",
        { class: "button-row" },
        h("button", { type: "submit", class: "button button-primary", disabled: busy, dataset: { key: "users-add-next" } }, t("users.add.next")),
        cancel
      )
    );
  }
  const linked = Boolean(ui.access.home);
  const email = h("input", { id: "users-add-email", type: "email", autocomplete: "off", dir: "ltr", placeholder: "name@example.com", value: draft.email || "", dataset: { key: "users-add-email" } });
  email.addEventListener("input", () => {
    draft.email = email.value;
  });
  return h(
    "div",
    { class: "card settings-card invite-form add-user", dataset: { key: "users-add" } },
    h("h2", { class: "settings-title", dir: "auto" }, icon("plus"), t("users.add.how", { name: draft.name })),
    h("p", { class: "field-help", dataset: { key: "users-add-summary" } }, draft.access.role === "admin" ? roleLabel("admin") : `${roleLabel("member")} · ${accessSummary(draft.access)}`),
    h(
      "form",
      { class: "add-user-choice", novalidate: true, dataset: { key: "users-add-link-form" }, onsubmit: addUserLink },
      h("h3", { class: "settings-subtitle" }, t("users.add.link")),
      h("p", { class: "field-help" }, t("users.add.linkHelp")),
      linked
        ? [
            h("label", { class: "field-label", for: "users-add-email" }, t("settings.account.home.email")),
            email,
            h("div", { class: "button-row" }, h("button", { type: "submit", class: "button button-primary", disabled: busy, dataset: { key: "users-add-link" } }, t("users.add.createLink"))),
          ]
        : h("p", { class: "notice notice-info", dataset: { key: "users-add-unlinked" } }, t("users.add.linkNeedsAccount"))
    ),
    h(
      "div",
      { class: "add-user-choice" },
      h("h3", { class: "settings-subtitle" }, t("users.add.code")),
      h("p", { class: "field-help" }, t("users.add.codeHelp")),
      h("div", { class: "button-row" }, h("button", { type: "button", class: "button button-secondary", disabled: busy, dataset: { key: "users-add-code" }, onclick: addUserCode }, t("users.add.makeCode")))
    ),
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "button", class: "button button-quiet", dataset: { key: "users-add-back" }, onclick: () => { ui.access = { ...ui.access, adding: { ...draft, step: 1 } }; notify(); } }, t("users.add.back")),
      cancel
    )
  );
}

// The link made by Send a link, to share with them.
function addedPanel() {
  const added = ui.access.added;
  if (!added) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(added.link);
      ui.access = { ...ui.access, message: { kind: "success", text: t("settings.account.home.copied") } };
    } catch {
      ui.access = { ...ui.access, message: { kind: "error", text: t("settings.account.home.copyFailed") } };
    }
    notify();
  };
  return h(
    "div",
    { class: "card settings-card invitation", dataset: { key: "users-added" } },
    h("h2", { class: "settings-title", dir: "auto" }, icon("plus"), t("users.add.linkFor", { name: added.name })),
    h("p", { dir: "auto" }, added.named ? t("users.add.sent", { email: added.email, name: added.name }) : t("users.add.sentUnnamed", { email: added.email, name: added.name })),
    qrCanvas(added.link, { label: t("settings.account.home.qrLabel") }),
    h("input", { class: "invitation-link", type: "text", readonly: true, dir: "ltr", value: added.link, "aria-label": t("settings.account.home.linkLabel"), onfocus: (event) => event.target.select() }),
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "button", class: "button button-primary", dataset: { key: "users-added-copy" }, onclick: copy }, t("settings.account.home.copy")),
      navigator.share
        ? h("button", { type: "button", class: "button button-secondary", onclick: () => navigator.share({ title: "DirectorLink", url: added.link }).catch(() => {}) }, t("settings.account.home.share"))
        : null,
      h("button", { type: "button", class: "button button-quiet", dataset: { key: "users-added-done" }, onclick: () => { ui.access = { ...ui.access, added: null, message: null }; notify(); } }, t("common.done"))
    ),
    h("p", { class: "field-help" }, t("settings.account.home.expires", { time: formatDateTime(new Date(added.expiresAt)) }))
  );
}

// An admin invites another device of a user by email (their Google or Apple account): a link.
function inviteToUser(user) {
  const email = (ui.access.inviting?.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    ui.access = { ...ui.access, message: { kind: "error", text: t("settings.account.home.badEmail") } };
    notify();
    return;
  }
  act(async () => {
    const invitation = await makeInvitation({ forSelf: false, email, role: user.access?.role === "admin" ? "admin" : "member", profileId: user.id });
    ui.access = { ...ui.access, inviting: { user: user.id, email, link: invitationLink(invitation.home_id, invitation), expiresAt: invitation.expires_at } };
  }, null);
}

function invitePanel(user) {
  const inviting = ui.access.inviting;
  if (!inviting || inviting.user !== user.id) return null;
  if (inviting.link) {
    return h(
      "div",
      { class: "invitation", dataset: { key: `users-invitation-${user.id}` } },
      h("p", {}, t("users.invite.send", { email: inviting.email, name: user.name })),
      qrCanvas(inviting.link, { label: t("settings.account.home.qrLabel") }),
      h("input", { class: "invitation-link", type: "text", readonly: true, dir: "ltr", value: inviting.link, "aria-label": t("settings.account.home.linkLabel"), onfocus: (event) => event.target.select() }),
      h("p", { class: "field-help" }, t("settings.account.home.expires", { time: formatDateTime(new Date(inviting.expiresAt)) })),
      h("div", { class: "button-row" }, h("button", { type: "button", class: "button button-quiet", onclick: () => { ui.access = { ...ui.access, inviting: null }; notify(); } }, t("common.done")))
    );
  }
  const input = h("input", { type: "email", autocomplete: "off", dir: "ltr", placeholder: "name@example.com", value: inviting.email || "", "aria-label": t("settings.account.home.email"), dataset: { key: `users-invite-email-${user.id}` } });
  input.addEventListener("input", () => {
    inviting.email = input.value;
  });
  return h(
    "form",
    { class: "invite-form", novalidate: true, onsubmit: (event) => { event.preventDefault(); inviteToUser(user); } },
    h("p", { class: "field-help" }, t("users.invite.help", { name: user.name })),
    input,
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "submit", class: "button button-primary", disabled: Boolean(ui.access.busy), dataset: { key: `users-invite-send-${user.id}` } }, t("settings.account.home.create")),
      h("button", { type: "button", class: "button button-quiet", onclick: () => { ui.access = { ...ui.access, inviting: null }; notify(); } }, t("common.cancel"))
    )
  );
}

// The accounts of a user, as the app may show them: the owner sees the accounts' emails (the
// account service lists them for the owner only); this device's own account; else how many.
function accountLine(user, list) {
  if (!list?.accounts_known) return null;
  if (!user.accounts) return t("users.account.none");
  const people = Array.isArray(ui.access.people) ? ui.access.people : null;
  const ids = new Set((user.devices || []).map((device) => device.id));
  if (people) {
    const names = people.filter((person) => person.key_ids.some((id) => ids.has(id))).map((person) => person.email || person.name).filter(Boolean);
    if (names.length) return names.join(", ");
  }
  const current = (user.devices || []).find((device) => device.current);
  if (current?.accounts === 1 && user.accounts === 1 && state.account.status === "signed-in" && state.account.user?.email) return state.account.user.email;
  return t("users.account.some", { count: user.accounts });
}

// A device, under its user: when it was last used (30 days or more: "Not used since …", 1.12.0),
// Rename (its user, and admins), and Remove where the controller says the caller may; for admins,
// the user it belongs to (moving it gives it that user's access).
function userDeviceRow(device, user, users) {
  const busy = Boolean(ui.access.busy);
  const renamable = can("admin") || namesSupported();
  let picker = null;
  if (can("admin") && users.length > 1 && !user.access?.owner) {
    const select = h(
      "select",
      { class: "access-role", "aria-label": t("access.personFor", { name: device.name }), dataset: { key: `access-person-${device.id}` } },
      ...users.map((other) => h("option", { value: other.id, selected: other.id === user.id }, other.name))
    );
    select.addEventListener("change", () => {
      const target = users.find((other) => other.id === select.value);
      if (target) movePerson({ ...device, profile_id: user.id }, target, select);
    });
    picker = h("span", { class: "access-person" }, h("span", { class: "access-sub" }, t("access.person")), select);
  }
  return h(
    "li",
    { class: "access-item access-device", dataset: { key: `access-device-${device.id}` } },
    h(
      "div",
      { class: "access-main" },
      h("span", { class: "access-name", dir: "auto" }, device.name, device.current ? h("span", { class: "access-badge" }, t("access.thisDevice")) : null),
      h("span", { class: `access-sub${staleDevice(device) ? " access-stale" : ""}`, dir: "auto", dataset: { key: `access-used-${device.id}` } }, [lastUsed(device), expiry(device), device.accounts > 1 ? t("users.account.shared", { count: device.accounts }) : null].filter(Boolean).join(" · ")),
      picker
    ),
    device.removable || renamable
      ? h(
          "div",
          { class: "access-actions" },
          renamable
            ? h(
                "button",
                { type: "button", class: "button button-small button-quiet", disabled: busy, "aria-label": t("users.device.renameFor", { name: device.name }), dataset: { key: `access-rename-device-${device.id}` }, onclick: () => renameDevice(device) },
                t("access.rename")
              )
            : null,
          device.removable
            ? h(
                "button",
                { type: "button", class: "button button-small button-danger", disabled: busy, "aria-label": t("users.removeDeviceFor", { name: device.name }), dataset: { key: `access-revoke-${device.id}` }, onclick: () => removeDevice(device, user) },
                t("users.removeDevice")
              )
            : null
        )
      : null
  );
}

// One user: their role and access, their account, and their devices.
function userRow(user, list) {
  const access = user.access || {};
  const admin = can("admin");
  const editing = ui.access.editing?.id === user.id ? ui.access.editing : null;
  const busy = Boolean(ui.access.busy);
  const full = (user.devices || []).length >= (list.device_limit || 5);
  const linked = Boolean(ui.access.home);
  // This device is the owner's (1.9.0, ADR-064).
  const iOwn = (list.items || []).some((item) => item.you && item.access?.owner);
  const actions = admin
    ? [
        access.owner
          ? null
          : h(
              "button",
              { type: "button", class: "button button-small button-secondary", disabled: busy, "aria-expanded": String(Boolean(editing)), "aria-label": t("access.editFor", { name: user.name }), dataset: { key: `access-edit-${user.id}` }, onclick: () => (editing ? stopEditing() : editPerson(user)) },
              editing ? t("common.cancel") : t("access.edit")
            ),
        h("button", { type: "button", class: "button button-small button-quiet", "aria-label": t("access.renameFor", { name: user.name }), dataset: { key: `access-rename-profile-${user.id}` }, onclick: () => renamePerson(user) }, t("access.rename")),
        access.owner && !user.you
          ? null
          : h(
              "button",
              { type: "button", class: "button button-small button-quiet", disabled: busy || full, "aria-label": t("users.pairFor", { name: user.name }), dataset: { key: `users-pair-${user.id}` }, onclick: () => makePairingCode({ profile_id: user.id }, user.name) },
              t("users.pair")
            ),
        linked && !user.accounts && !(access.owner && !user.you)
          ? h(
              "button",
              { type: "button", class: "button button-small button-quiet", disabled: busy || full, "aria-label": t("users.invite.for", { name: user.name }), dataset: { key: `users-invite-${user.id}` }, onclick: () => { ui.access = { ...ui.access, inviting: { user: user.id, email: "" } }; notify(); } },
              t("users.invite.button")
            )
          : null,
        // Only the owner hands the home over, and only to another admin (ADR-064).
        iOwn && !user.you && access.role === "admin" && !access.owner
          ? h(
              "button",
              { type: "button", class: "button button-small button-quiet", disabled: busy, dataset: { key: `users-make-owner-${user.id}` }, onclick: () => makeOwner(user) },
              t("users.owner.make", { name: user.name })
            )
          : null,
      ]
    : user.you && namesSupported()
      ? [h("button", { type: "button", class: "button button-small button-quiet", "aria-label": t("access.renameFor", { name: user.name }), dataset: { key: `access-rename-profile-${user.id}` }, onclick: () => renamePerson(user) }, t("access.rename"))]
      : [];
  const users = Array.isArray(list.items) ? list.items : [];
  return h(
    "li",
    { class: "access-item access-person-item", dataset: { key: `access-profile-${user.id}` } },
    h(
      "div",
      { class: "access-main" },
      h("span", { class: "access-name", dir: "auto" }, user.name, access.owner ? h("span", { class: "access-badge" }, t("access.owner")) : null, user.you ? h("span", { class: "access-badge" }, t("access.you")) : null),
      h("span", { class: "access-sub", dataset: { key: `access-profile-role-${user.id}` } }, access.role === "admin" ? roleLabel("admin") : `${roleLabel("member")} · ${accessSummary(access)}`),
      (() => {
        const line = accountLine(user, list);
        return line ? h("span", { class: "access-sub", dir: "auto", dataset: { key: `users-account-${user.id}` } }, line) : null;
      })(),
      full ? h("span", { class: "access-sub", dataset: { key: `users-full-${user.id}` } }, t("users.full", { count: list.device_limit || 5 })) : null,
      user.you && access.owner && admin && (list.items || []).length > 1 ? h("span", { class: "field-help", dataset: { key: `users-owner-help-${user.id}` } }, t("users.owner.help")) : null
    ),
    actions.some(Boolean) ? h("div", { class: "access-actions" }, ...actions) : null,
    editing
      ? h(
          "div",
          { class: "perm-editor", dataset: { key: `access-editor-${user.id}` } },
          permissionsEditor(editing.draft, { prefix: `perm-${user.id}`, changed: notify }),
          h(
            "div",
            { class: "button-row" },
            h("button", { type: "button", class: "button button-primary", disabled: busy, dataset: { key: `access-save-${user.id}` }, onclick: () => savePerson(user) }, t("access.save")),
            h("button", { type: "button", class: "button button-quiet", onclick: stopEditing }, t("common.cancel"))
          )
        )
      : null,
    invitePanel(user),
    h("ul", { class: "access-list access-devices", "aria-label": t("users.devicesOf", { name: user.name }) }, (user.devices || []).map((device) => userDeviceRow(device, user, users))),
    user.you && !admin && !user.accounts && list.accounts_known ? h("p", { class: "field-help" }, t("users.account.askAdmin")) : null
  );
}

// The Google or Apple account the home's account would move to when `user` is made the owner, as
// this device can tell: the accounts the owner sees (the account service lists them for the owner)
// that use the user's devices of one account. Its email, or null when it cannot tell or there is
// more than one (the controller then refuses, naming the devices).
function ownerAccountEmail(user) {
  const people = Array.isArray(ui.access.people) ? ui.access.people : null;
  if (!people) return null;
  const single = new Set((user.devices || []).filter((device) => device.accounts === 1).map((device) => device.id));
  const emails = [...new Set(people.filter((person) => person.key_ids.some((id) => single.has(id))).map((person) => person.email).filter(Boolean))];
  return emails.length === 1 ? emails[0] : null;
}

// The controller's and the account service's refusals of a hand-over, in the app's words.
function ownerRefusal(error, user) {
  const name = error?.problem?.user?.name || user.name;
  const devices = Array.isArray(error?.problem?.device_names) ? error.problem.device_names.join(", ") : "";
  switch (error?.code) {
    case "OWNER_NEEDS_ACCOUNT":
      return t("users.owner.needsAccount", { name });
    case "OWNER_ACCOUNT_UNCLEAR":
      return t("users.owner.accountUnclear", { name, devices });
    case "OWNER_ACCOUNT_SHARED":
      return t("users.owner.accountShared", { name, devices });
    case "NOT_AN_ADMIN":
      return t("users.owner.notAdmin", { name });
    case "OWNER_ONLY":
      return t("users.owner.ownerOnly");
    case "ALREADY_OWNER":
      return t("users.owner.already", { name });
    case "REMOTE_ACCESS_OFF":
      return t("users.owner.remoteOff");
    case "REMOTE_OFFLINE":
      return t("users.owner.offline");
    case "REMOTE_TIMEOUT":
      return t("users.owner.noAnswer", { name });
    case "UNAVAILABLE":
      return t("users.owner.unavailable");
    default:
      // The app gave up waiting (the controller waits 10 s for DirectorLink's servers).
      if (error?.name === "AbortError" || error?.code === "TIMEOUT") return t("users.owner.noAnswer", { name });
      if (error?.status >= 500 || error?.status === 409) return t("users.owner.failed", { code: String(error.code || error.status).slice(0, 40) });
      return null;
  }
}

// The owner makes another admin the home's owner (1.9.0, ADR-064), asked first with what changes
// (and, in a home linked to an account, which account becomes the home's): the controller decides,
// and the account service moves the home's account on its word. The controller waits up to 10 s for
// it, so the app waits 15 s.
function makeOwner(user) {
  if (ui.access.busy) return;
  const list = ui.access.users && !ui.access.users.error ? ui.access.users : null;
  const email = ownerAccountEmail(user);
  const text =
    list?.linked === false
      ? t("users.owner.confirmHome", { name: user.name })
      : t("users.owner.confirm", { name: user.name, account: email ? t("users.owner.accountEmail", { email }) : t("users.owner.accountTheirs") });
  if (!window.confirm(text)) return;
  act(
    () => api("/v1/users/owner", { method: "POST", body: { profile_id: user.id }, timeoutMs: 15000 }),
    t("users.owner.done", { name: user.name }),
    (error) => ownerRefusal(error, user)
  );
}

// A user of a suggestion with their role, as the list of users has it when the controller's
// suggestion does not say (a build before its `role`).
function suggestionUser(user, users) {
  const listed = users.find((item) => item.id === user.id);
  const role = user.role || (listed?.access?.role === "admin" ? "admin" : "member");
  return { ...user, role, owner: user.owner ?? Boolean(listed?.access?.owner) };
}

// "DirectorLink's servers say these devices use the same account: make them one user?", with whose
// access stays: asked first, saying whose access, language, theme and favorites the moved devices
// then have, and what an admin's device becomes. Sent with the suggestion's revision: when the
// devices or their users changed since the screen was drawn, the controller moves nothing.
function confirmMerge(suggestion, keep) {
  const kept = suggestion.users.find((user) => user.id === keep);
  if (!kept || ui.access.busy) return;
  const moving = suggestion.users.filter((user) => user.id !== keep);
  const others = moving.map((user) => user.name).join(", ");
  const role = roleLabel(kept.role === "admin" ? "admin" : "member");
  const lines = [t("users.suggestion.confirm", { name: kept.name, others, role })];
  if (moving.some((user) => user.role === "admin") && kept.role !== "admin") lines.push(t("users.suggestion.confirmLess", { name: kept.name }));
  if (moving.some((user) => user.role !== "admin") && kept.role === "admin") lines.push(t("users.suggestion.confirmMore", { others }));
  if (!window.confirm(lines.join(" "))) return;
  const body = { account: suggestion.id, keep };
  if (suggestion.revision) body.revision = suggestion.revision;
  act(
    () => api("/v1/users/merge", { method: "POST", body }),
    t("users.suggestion.done", { name: kept.name }),
    (error) => (error?.code === "SUGGESTION_CHANGED" ? t("users.suggestion.changed") : null)
  );
}

function suggestionRow(suggestion, list) {
  const users = Array.isArray(list.items) ? list.items : [];
  const ownerUser = users.find((user) => user.access?.owner);
  const owner = ownerUser?.id;
  const people = suggestion.users.map((user) => suggestionUser(user, users));
  const shown = { ...suggestion, users: people };
  // Offered: the controller's choice (the owner's, else the user with less access), never an admin
  // over a member by default; none when neither is clearly less: the admin chooses.
  const offered = suggestion.keep !== undefined ? suggestion.keep : suggestion.owner && owner ? owner : null;
  const chosen = ui.access.keep?.[suggestion.id] || offered || null;
  const busy = Boolean(ui.access.busy);
  const limit = list.device_limit || 5;
  const deviceName = (id) => users.flatMap((user) => user.devices || []).find((device) => device.id === id)?.name || id;
  const choice = (user) => {
    const ownersOnly = suggestion.owner && owner && user.id !== owner;
    return h(
      "label",
      { class: `perm-role ${chosen === user.id ? "is-active" : ""}`.trim() },
      h("input", {
        type: "radio",
        name: `users-keep-${suggestion.id}`,
        value: user.id,
        checked: chosen === user.id,
        disabled: ownersOnly || !suggestion.may_confirm,
        dataset: { key: `users-keep-${suggestion.id}:${user.id}` },
        onchange: () => {
          ui.access = { ...ui.access, keep: { ...(ui.access.keep || {}), [suggestion.id]: user.id } };
          notify();
        },
      }),
      h(
        "span",
        { class: "toggle-text" },
        h(
          "span",
          { class: "toggle-title", dir: "auto" },
          t("users.suggestion.keep", { name: user.name }),
          h("span", { class: "access-badge", dataset: { key: `users-keep-role-${suggestion.id}:${user.id}` } }, user.owner ? t("access.owner") : roleLabel(user.role === "admin" ? "admin" : "member"))
        ),
        h("span", { class: "field-help", dir: "auto" }, user.devices.map(deviceName).join(", ")),
        user.devices_after > limit ? h("span", { class: "field-help" }, t("users.suggestion.tooMany", { count: user.devices_after, limit })) : null
      )
    );
  };
  const tooMany = people.find((user) => user.id === chosen)?.devices_after > limit;
  // Who may confirm it, when this device may not: the owner, on one of their devices.
  const ownerDevices = (ownerUser?.devices || []).map((device) => device.name).join(", ");
  const waitsForOwner = suggestion.owner && ownerUser && !ownerUser.you;
  return h(
    "li",
    { class: "access-item access-suggestion", dataset: { key: `users-suggestion-${suggestion.id}` } },
    h(
      "div",
      { class: "access-main" },
      h("span", { class: "access-name", dir: "auto" }, t("users.suggestion.title", { names: people.map((user) => user.name).join(", ") })),
      h("span", { class: "access-sub" }, suggestion.owner ? t("users.suggestion.ownerHelp") : t("users.suggestion.help")),
      h("fieldset", { class: "perm-roles" }, h("legend", { class: "settings-subtitle" }, t("users.suggestion.whose")), people.map(choice)),
      suggestion.may_confirm
        ? chosen
          ? null
          : h("p", { class: "field-help", dataset: { key: `users-suggestion-choose-${suggestion.id}` } }, t("users.suggestion.choose"))
        : h(
            "p",
            { class: "field-help", dataset: { key: `users-suggestion-who-${suggestion.id}` } },
            waitsForOwner ? t("users.suggestion.ownerConfirmsOn", { name: ownerUser.name, devices: ownerDevices || ownerUser.name }) : t("users.suggestion.ownerConfirms")
          )
    ),
    suggestion.may_confirm
      ? h(
          "div",
          { class: "access-actions" },
          h("button", { type: "button", class: "button button-small button-primary", disabled: busy || tooMany || !chosen, dataset: { key: `users-merge-${suggestion.id}` }, onclick: () => confirmMerge(shown, chosen) }, t("users.suggestion.merge"))
        )
      : null
  );
}

function usersView(header) {
  const access = ui.access;
  // First visit, 30 s old, or the account changed (it may finish loading after the controller).
  if (!running && (!access?.at || Date.now() - access.at > REFRESH_MS || access.accountStatus !== state.account.status)) {
    loadAccess();
  }
  scheduleRefresh();
  if (!access?.at) {
    return [header, h("div", { class: "settings" }, h("p", { class: "field-help", role: "status" }, t("common.loading")))];
  }
  const admin = can("admin");
  const list = access.users && !access.users.error ? access.users : null;
  const devices = Array.isArray(access.devices) ? access.devices : [];
  const invitations = Array.isArray(access.invitations) ? access.invitations : [];
  const requests = Array.isArray(access.requests) ? access.requests : [];
  const people = Array.isArray(access.people) ? access.people : null;
  const suggestions = list?.suggestions || [];
  return [
    header,
    offlineBanner(),
    h(
      "div",
      { class: "settings" },
      access.message ? h("p", { class: `notice notice-${access.message.kind}`, role: access.message.kind === "error" ? "alert" : "status" }, access.message.text) : null,
      deviceLimitPanel(access.limit, { remove: removeFromLimit, busy: Boolean(access.busy), key: "users-limit", dismiss: () => { ui.access = { ...ui.access, limit: null }; notify(); } }),
      pairingPanel(),
      addedPanel(),
      requests.length
        ? section("requests", t("access.requests"), t("access.requestsHelp"), h("ul", { class: "access-list" }, requests.map((request) => requestRow(request, invitations, devices))))
        : problemNote(access.requests),
      suggestions.length
        ? section("suggestions", t("users.suggestion.section"), t("users.suggestion.sectionHelp"), h("ul", { class: "access-list" }, suggestions.map((suggestion) => suggestionRow(suggestion, list))))
        : null,
      admin ? addUserPanel() : null,
      section(
        "persons",
        admin ? t("users.section") : t("users.sectionMine"),
        admin ? t("users.help", { count: list?.device_limit || 5 }) : t("users.helpMember", { count: list?.device_limit || 5 }),
        problemNote(access.users) ||
          h(
            "div",
            {},
            h("ul", { class: "access-list" }, (list?.items || []).map((user) => userRow(user, list))),
            admin && !access.adding
              ? h(
                  "div",
                  { class: "button-row" },
                  h("button", { type: "button", class: "button button-primary", dataset: { key: "users-add-open" }, disabled: Boolean(access.busy), onclick: openAddUser }, icon("plus"), t("users.add.open"))
                )
              : null,
            admin ? null : h("p", { class: "field-help" }, t("users.addOwnHelp"))
          )
      ),
      admin
        ? section(
            "invitations",
            t("access.invitations"),
            invitations.length ? null : t("access.noInvitations"),
            problemNote(access.invitations) || (invitations.length ? h("ul", { class: "access-list" }, invitations.map((invitation) => invitationRow(invitation, devices))) : null)
          )
        : null,
      people ? section("people", t("access.accounts"), t("access.peopleHelp"), h("ul", { class: "access-list" }, people.map((person) => accountRow(person, devices)))) : null
    ),
  ];
}

export function accessView() {
  const header = pageHeader({ title: usersSupported() ? t("users.title") : t("access.title"), back: "#/settings" });
  if (!state.loaded) {
    return [header, notReadyState()];
  }
  // Settings → Users (1.9.0): every user sees their own; admins every user.
  if (usersSupported()) {
    return usersView(header);
  }
  if (!can("admin")) {
    return [header, h("div", { class: "settings" }, h("p", { class: "notice notice-info" }, t("access.adminOnly", { role: roleLabel(state.role) })))];
  }
  const access = ui.access;
  // First visit, 30 s old, or the account changed (it may finish loading after the controller).
  if (!running && (!access?.at || Date.now() - access.at > REFRESH_MS || access.accountStatus !== state.account.status)) {
    loadAccess();
  }
  scheduleRefresh();
  if (!access?.at) {
    return [header, h("div", { class: "settings" }, h("p", { class: "field-help", role: "status" }, t("common.loading")))];
  }
  const devices = Array.isArray(access.devices) ? access.devices : [];
  const people = Array.isArray(access.people) ? access.people : null;
  // Which accounts use which key (the owner's view only).
  let owners = null;
  if (people) {
    owners = new Map();
    for (const person of people) {
      for (const id of person.key_ids) owners.set(id, [...(owners.get(id) || []), person]);
    }
  }
  const invitations = Array.isArray(access.invitations) ? access.invitations : [];
  const requests = Array.isArray(access.requests) ? access.requests : [];
  return [
    header,
    offlineBanner(),
    h(
      "div",
      { class: "settings" },
      access.message ? h("p", { class: `notice notice-${access.message.kind}`, role: access.message.kind === "error" ? "alert" : "status" }, access.message.text) : null,
      // Shown first, and only when someone is asking.
      requests.length
        ? section("requests", t("access.requests"), t("access.requestsHelp"), h("ul", { class: "access-list" }, requests.map((request) => requestRow(request, invitations, devices))))
        : problemNote(access.requests),
      // The controller's people, their roles and permissions (1.8.0, ADR-054).
      peopleSupported() && Array.isArray(access.profiles)
        ? section("persons", t("access.persons"), t("access.personsHelp"), h("ul", { class: "access-list" }, access.profiles.map((profile) => personRow(profile, devices))))
        : null,
      people
        ? section("people", peopleSupported() ? t("access.accounts") : t("access.people"), t("access.peopleHelp"), h("ul", { class: "access-list" }, people.map((person) => accountRow(person, devices))))
        : access.home && state.account.status === "signed-in"
          ? problemNote(access.people) || h("p", { class: "field-help" }, t("access.ownerOnly"))
          : null,
      section(
        "devices",
        t("access.devices"),
        t("access.devicesHelp"),
        problemNote(access.devices) || h("ul", { class: "access-list" }, devices.map((device) => deviceRow(device, owners, Array.isArray(access.profiles) ? access.profiles : null)))
      ),
      section(
        "invitations",
        t("access.invitations"),
        invitations.length ? null : t("access.noInvitations"),
        problemNote(access.invitations) || (invitations.length ? h("ul", { class: "access-list" }, invitations.map((invitation) => invitationRow(invitation, devices))) : null)
      )
    ),
  ];
}
