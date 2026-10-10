// The Home Screen app on iPhone and iPad (1.12.0, ADR-083). iOS gives the app added to the Home
// Screen its own storage, apart from Safari's, and opens every link in Safari: a device that joins
// in Safari has a key the Home Screen app does not, and two keys when both join. Alerts work only in
// the Home Screen app. So an invitation's link opened in Safari first recommends joining there
// (views/join.js), and a Safari tab that already joined moves its place to it (views/move.js).

import { IS_IOS } from "./platform.js";

// This page runs as the app added to the Home Screen (or installed elsewhere).
export function standalone() {
  try {
    if (window.matchMedia?.("(display-mode: standalone)")?.matches === true) return true;
  } catch {
    // An old browser without matchMedia.
  }
  return navigator.standalone === true;
}

// A browser's tab on iPhone or iPad, not the Home Screen app.
export function inIosBrowser() {
  return IS_IOS && !standalone();
}

// Safari itself, not another iOS browser (Chrome, Firefox, Edge on iOS name themselves).
export function isSafari() {
  const agent = navigator.userAgent || "";
  return /Safari\//.test(agent) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(agent);
}

// The move this tab started (views/move.js): { home, keyId, invitation, until }. Kept until a day
// after its invitation's end, so that a Safari tab opened again later still says it moved.
const MOVE_KEY = "directorlink.move";
const MOVE_KEPT_MS = 24 * 3600 * 1000;

export function savedMove(now = Date.now()) {
  try {
    const value = JSON.parse(localStorage.getItem(MOVE_KEY) || "null");
    if (!value || !/^[0-9a-f]{8}$/.test(value.keyId || "") || !(Date.parse(value.until) + MOVE_KEPT_MS > now)) {
      if (value) localStorage.removeItem(MOVE_KEY);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function saveMove(value) {
  try {
    if (value) localStorage.setItem(MOVE_KEY, JSON.stringify(value));
    else localStorage.removeItem(MOVE_KEY);
  } catch {
    // Blocked storage: the tab says it moved only while it stays open.
  }
}
