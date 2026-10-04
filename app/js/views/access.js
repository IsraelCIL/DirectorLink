// People and devices (#/access, admin keys): the home's API keys with their roles, the invitations
// waiting to be accepted, and, for the home's owner, the accounts that belong to the home with the
// devices each uses, and those asking to join with an invitation made for another email, which
// the owner approves or refuses (docs/ACCOUNTS.md, ADR-041). Devices and invitations come from the
// controller; people and requests from the account service, which never sees the keys, only their
// ids.

import { h } from "../dom.js";
import { formatDateTime, formatRelative, formatUntil, t } from "../i18n.js";
import { icon } from "../icons.js";
import { decideJoinRequest, joinCodeText, listJoinRequests, listMembers, removeMember, savedRemote } from "../remote.js";
import { linksMadeBy, linksSupported } from "../scene-links.js";
import { api, errorText, roleLabel } from "../session.js";
import { can, notify, state, ui } from "../state.js";
import { notReadyState, offlineBanner, pageHeader } from "./common.js";

const ROLES = ["viewer", "member", "doors", "admin"];
const REFRESH_MS = 30000;
let running = null;
let queued = null;
let refreshTimer = null;

function failure(error) {
  return { error: errorText(error) };
}

async function fetchAccess() {
  const home = savedRemote()?.home || state.remoteInfo?.home_id || null;
  const accountStatus = state.account.status;
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

async function act(work, done) {
  ui.access = { ...(ui.access || {}), busy: true, message: null };
  notify();
  let message;
  try {
    await work();
    message = { kind: "success", text: done };
  } catch (error) {
    message = { kind: "error", text: error?.code === "LAST_ADMIN" ? t("access.lastAdmin") : errorText(error) };
  }
  // The screen may have been left and opened again meanwhile (resetAccess).
  ui.access = { ...(ui.access || {}), busy: false, message };
  await loadAccess();
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

// Moves a device to another person's profile: it then shares their language and favorites.
function movePerson(device, profile, select) {
  if (ui.access.busy || !window.confirm(t("access.moveConfirm", { device: device.name, person: profile.name }))) {
    select.value = device.profile_id || "";
    return;
  }
  act(() => api(`/v1/api-keys/${device.id}`, { method: "PATCH", body: { profile_id: profile.id } }), t("access.moved", { device: device.name, person: profile.name }));
}

function renamePerson(profile) {
  const name = window.prompt(t("access.renamePrompt"), profile.name);
  if (!name || !name.trim() || name.trim() === profile.name) return;
  act(() => api(`/v1/profiles/${profile.id}`, { method: "PATCH", body: { name: name.trim().slice(0, 64) } }), t("access.renamed", { name: name.trim() }));
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
    h("h2", { class: "settings-title", id: `access-${id}-title` }, icon(id === "people" || id === "requests" ? "user" : id === "devices" ? "key" : "plus"), title),
    help ? h("p", { class: "field-help" }, help) : null,
    content
  );
}

function problemNote(value) {
  return value && !Array.isArray(value) && value.error ? h("p", { class: "notice notice-error", role: "status" }, value.error) : null;
}

function lastUsed(device) {
  return device.last_used_at ? t("access.lastUsed", { time: formatRelative(device.last_used_at) }) : t("access.neverUsed");
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
function deviceRow(device, owners, profiles) {
  const busy = Boolean(ui.access.busy);
  const users = owners ? owners.get(device.id) || [] : null;
  const account = users === null ? null : users.length ? users.map((person) => person.name || person.email).join(", ") : t("access.noAccount");
  const role = h(
    "select",
    { class: "access-role", "aria-label": t("access.roleFor", { name: device.name }), disabled: device.current, dataset: { key: `access-role-${device.id}` } },
    ...ROLES.map((value) => h("option", { value, selected: value === device.role }, roleLabel(value)))
  );
  role.addEventListener("change", () => changeRole(device, role.value, role));
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

function personRow(person, devices) {
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
  const role = roleLabel(invitation.role);
  return h(
    "li",
    { class: "access-item", dataset: { key: `access-invitation-${invitation.id}` } },
    h(
      "div",
      { class: "access-main" },
      h("span", { class: "access-name" }, role),
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

export function accessView() {
  const header = pageHeader({ title: t("access.title"), back: "#/settings" });
  if (!state.loaded) {
    return [header, notReadyState()];
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
      people
        ? section("people", t("access.people"), t("access.peopleHelp"), h("ul", { class: "access-list" }, people.map((person) => personRow(person, devices))))
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
