// Offline copy (service worker), online/offline notice and the install prompt.

import { notify, state } from "./state.js";

let installPrompt = null;

// A page that stays open (a wall tablet, a pinned tab) must not keep running an old version.
// Look for a new one every 30 minutes and whenever the app comes back to the front; when it has
// taken over, reload into it at once if the page is in the background, else after 30 s without a
// tap or key, so an action in progress (Open gate asks for a second tap) is never cut off.
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const IDLE_BEFORE_RELOAD_MS = 30 * 1000;
let lastInput = Date.now();

function reloadWhenIdle() {
  if (document.hidden || Date.now() - lastInput >= IDLE_BEFORE_RELOAD_MS) {
    window.location.reload();
    return;
  }
  window.setTimeout(reloadWhenIdle, 5000);
}

function watchForUpdates(registration) {
  const check = () => registration.update().catch(() => {});
  window.setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
  }
  // The first install also changes the controller; only a replaced one means a new version.
  let hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloading) {
      reloading = true;
      reloadWhenIdle();
    }
    hadController = true;
  });
}

async function refreshOfflineStatus() {
  if (!("caches" in window)) {
    state.offlineCopy = "unsupported";
  } else {
    const saved = await caches.match("/");
    state.offlineCopy = saved ? (navigator.onLine ? "ready" : "inUse") : navigator.onLine ? "saving" : "missing";
  }
  notify();
}

// Where a notification's tap leads (sw.js): the worker tells an open app, and also keeps it for a
// minute in Cache Storage (1.11.0, ADR-078), so that an app it opened, or one that was asleep when
// told (a Home Screen app on iPhone), still lands there: a ring's on its doorbell's screen. Taken
// once.
const OPEN_CACHE = "directorlink-alerts"; // js/alerts.js TEXTS_CACHE, sw.js ALERT_TEXTS_CACHE
const OPEN_PATH = "/notification-open.json";
const OPEN_FRESH_MS = 60 * 1000;

function openAt(url) {
  let target;
  try {
    target = new URL(url, window.location.href);
  } catch {
    return;
  }
  if (target.origin !== window.location.origin) return;
  const hash = target.hash || "#/";
  if (window.location.hash !== hash) window.location.hash = hash;
}

export async function takeNotificationOpen(now = Date.now()) {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(OPEN_CACHE);
    const saved = await cache.match(OPEN_PATH);
    if (!saved) return false;
    const value = await saved.json().catch(() => null);
    await cache.delete(OPEN_PATH);
    const at = Number(value?.at);
    if (typeof value?.url !== "string" || !Number.isFinite(at) || now - at > OPEN_FRESH_MS || at - now > OPEN_FRESH_MS) return false;
    openAt(value.url);
    return true;
  } catch {
    return false;
  }
}

export function startPwa() {
  if ("serviceWorker" in navigator) {
    // A notification was clicked: show where it leads (a ring: its doorbell's screen).
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "directorlink-open") {
        openAt(event.data.url);
        takeNotificationOpen();
      }
    });
    // Opened by a notification's tap, or back in front after one.
    takeNotificationOpen();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) takeNotificationOpen();
    });
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        watchForUpdates(registration);
        return navigator.serviceWorker.ready;
      })
      .then(refreshOfflineStatus)
      .catch(() => {
        state.offlineCopy = "failed";
        notify();
      });
  } else {
    state.offlineCopy = "unsupported";
  }

  const onlineChanged = () => {
    state.online = navigator.onLine;
    refreshOfflineStatus().catch(() => {});
    notify();
  };
  window.addEventListener("online", onlineChanged);
  window.addEventListener("offline", onlineChanged);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    state.canInstall = true;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    state.canInstall = false;
    notify();
  });
}

export async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  state.canInstall = false;
  notify();
}
