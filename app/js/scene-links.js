// Scene links (ADR-051, docs/SCENES.md): a private link per scene for the phone's own automations
// (iPhone Shortcuts, Android automation apps, an NFC tag). Admins make, replace and remove them
// (views/scene-links.js); the controller keeps a hash of each secret and shows the secret once,
// in the answer that makes the link, so this module keeps it only in memory, only until the
// screen it was made on is left. A phone runs the scene through DirectorLink's account service:
// a POST to the link's address with the secret in the body (cloud/src/scene-links.js). Shown when
// GET /v1/system says the controller has them (features.scene_links, 1.7.0).

import { ACCOUNTS_API } from "./account.js";
import { t } from "./i18n.js";
import { api, errorText, noteForbidden, whenForgotten } from "./session.js";
import { can, notify, state, ui } from "./state.js";

// The list is read again when it is shown this long after it was read.
const FRESH_MS = 60000;

export const linksSupported = () => state.system?.features?.scene_links === true;

// ui.sceneLinks: { loaded, loading, at, error, items, remoteAccess, homeLinked, busy (scene id),
// message ({ sceneId, kind, text }), showing (the scenes whose new secret is on screen: the screen
// is drawn again when it goes) }. The secrets just made are in `made`, never in `ui`.
let made = {};
whenForgotten(() => {
  made = {};
  ui.sceneLinks = null;
});

export function linksState() {
  ui.sceneLinks ??= { loaded: false, loading: false, at: 0, error: null, items: [], remoteAccess: true, homeLinked: true, busy: null, message: null, showing: [] };
  return ui.sceneLinks;
}

// The links, for admins, read when shown and not read within FRESH_MS.
export function ensureLinks() {
  const links = linksState();
  if (linksSupported() && can("admin") && !links.loading && (!links.loaded || Date.now() - links.at > FRESH_MS)) loadLinks();
  return links;
}

export async function loadLinks() {
  const links = linksState();
  links.loading = true;
  try {
    const answer = await api("/v1/scene-links");
    Object.assign(links, {
      loaded: true,
      error: null,
      items: Array.isArray(answer?.items) ? answer.items : [],
      remoteAccess: answer?.remote_access !== false,
      homeLinked: answer?.home_linked !== false,
    });
  } catch (error) {
    noteForbidden(error);
    Object.assign(links, { loaded: true, error: errorText(error) });
  } finally {
    links.loading = false;
    links.at = Date.now();
    notify();
  }
}

export function linkOf(sceneId) {
  return linksState().items.find((item) => item.scene_id === sceneId) || null;
}

// The step types a linked scene may have, as the controller allows them (src/core/scene_links.lua):
// never doors and gates (`relays`), nor a type this app does not know.
const LINKABLE = new Set(["lights", "climate", "fans", "blinds", "music", "refrigerators"]);

// A scene whose steps a link may all run; any other has no link (it opens doors or gates).
export function linkable(steps) {
  return (steps || []).every((step) => LINKABLE.has(step?.type));
}

// The links the key `keyId` made: they stop when it is revoked (Access, Settings' Forget key).
export function linksMadeBy(items, keyId) {
  return keyId ? (items || []).filter((item) => item?.made_by === keyId).length : 0;
}

// What a phone calls: the address (POST, the secret in the body) and the whole link (a browser or
// an NFC tag: the secret after "#", which the browser never sends; the page there posts it).
export function linkAddress(link) {
  return `${ACCOUNTS_API}/run/${link.home_id}.${link.link_id}`;
}
export function linkUrl(link) {
  return `${linkAddress(link)}#${link.secret}`;
}

// The link just made for a scene, with its secret, while its screen is open.
export function madeLink(sceneId) {
  return made[sceneId] || null;
}

// Forgets the secrets shown (the screen is left, or Done).
export function forgetMade(sceneId) {
  if (sceneId) delete made[sceneId];
  else made = {};
  linksState().showing = Object.keys(made);
}

function say(sceneId, kind, text) {
  linksState().message = text ? { sceneId, kind, text } : null;
}

const CODES = { REMOTE_ACCESS_OFF: "remoteOff", HOME_NOT_LINKED: "notLinked", SCENE_OPENS_DOORS: "doors" };

function failureText(error) {
  return CODES[error?.code] ? t(`sceneLinks.errors.${CODES[error.code]}`) : errorText(error);
}

// Makes the scene's link (replacing the one it had); its secret is kept for this screen.
export async function makeLink(sceneId, label) {
  const links = linksState();
  links.busy = sceneId;
  say(sceneId, null, null);
  notify();
  try {
    const body = label && label.trim() ? { label: label.trim().slice(0, 64) } : {};
    const link = await api(`/v1/scenes/${sceneId}/link`, { method: "POST", body });
    made[sceneId] = link;
    links.showing = Object.keys(made);
    await loadLinks();
    return link;
  } catch (error) {
    noteForbidden(error);
    say(sceneId, "error", failureText(error));
    return null;
  } finally {
    links.busy = null;
    notify();
  }
}

export async function removeLink(sceneId) {
  const links = linksState();
  links.busy = sceneId;
  say(sceneId, null, null);
  notify();
  try {
    await api(`/v1/scenes/${sceneId}/link`, { method: "DELETE" });
  } catch (error) {
    // Removed already (on another device): the same outcome.
    if (error?.status !== 404) {
      noteForbidden(error);
      say(sceneId, "error", failureText(error));
      links.busy = null;
      notify();
      return false;
    }
  }
  forgetMade(sceneId);
  say(sceneId, "success", t("sceneLinks.removed"));
  links.busy = null;
  await loadLinks();
  return true;
}
