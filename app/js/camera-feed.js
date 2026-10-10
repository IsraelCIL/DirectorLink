// Camera pictures, fetched as blobs with the API key (an <img src> cannot send it).
// Thumbnails on screen refresh about every 3 s; live pictures (data-live: the doorbell banner) and
// the full view about every second. Only tiles that are visible refresh, and nothing refreshes
// while the page is hidden.
//
// Several pictures are asked for at once (picturesAtOnce, 1.8.0, ADR-055): through the account each
// is a round trip to the home, so one after another a grid of 11 took 11 of them. Each tile shows
// its picture as soon as it arrives. A camera and size is asked for once however many tiles show it,
// and not again while its last picture is still on its way (waiting or being fetched), so nothing
// piles up on a slow connection.
//
// Markup: <div class="cam" data-state="loading|ok|busy|none"><img data-camera-id data-width [data-live]></div>

import { formatTime, t } from "./i18n.js";
import { handleUnauthorized, image } from "./session.js";
import { findDevice, state } from "./state.js";

// Through the account every picture is sealed and relayed, so it refreshes less often.
const remote = () => state.transport === "remote";
const GRID_REFRESH_MS = () => (remote() ? 10000 : 3000);
const FULL_REFRESH_MS = () => (remote() ? 3000 : 1000);
const LIVE_REFRESH_MS = () => (remote() ? 2000 : 1000);
// Pictures asked for at once. "directorlink.picturesAtOnce" (1 to 8) in this browser's storage
// overrides it, to compare (1: one after another, as before 1.8.0).
export const PICTURES_AT_ONCE = 4;
const AT_ONCE_KEY = "directorlink.picturesAtOnce";
const pictures = new Map(); // "cameraId:width" -> { url, at }
const visible = new WeakSet();
const observed = new Set();
// Pictures asked for and not here yet: "cameraId:width" -> a promise of its address (null when it
// was no longer wanted by the time its turn came); the ones not started yet, in order; how many are
// on their way.
const loading = new Map();
const waiting = [];
let fetching = 0;
// One loop each; a redraw while a loop waits for a picture must not start a second one.
let gridTimer = null;
let gridRunning = false;
let liveRunning = false;
let full = null; // { camera, image, status, timer }
// How long the last screen of tiles took to fill: { pictures, ms, atOnce, transport }.
let filling = null;
export let lastFill = null;

export function picturesAtOnce() {
  try {
    const chosen = Number(localStorage.getItem(AT_ONCE_KEY));
    if (Number.isInteger(chosen) && chosen >= 1 && chosen <= 8) return chosen;
  } catch {
    // Blocked storage: the default.
  }
  return PICTURES_AT_ONCE;
}

// A camera by id: from /v1/cameras, or a doorbell's own camera.
function cameraById(id) {
  const camera = findDevice("camera", id);
  if (camera) return camera;
  const doorbell = state.doorbells.find((item) => item.camera?.id === Number(id));
  return doorbell ? { id: doorbell.camera.id, name: doorbell.name, snapshot_href: doorbell.camera.snapshot_href } : null;
}

const observer =
  "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
      })
    : null;

async function fetchPicture(camera, width) {
  const blob = await image(`${camera.snapshot_href}?width=${width}`);
  const key = `${camera.id}:${width}`;
  const previous = pictures.get(key);
  const url = URL.createObjectURL(blob);
  pictures.set(key, { url, at: new Date() });
  // Revoke after the new picture had time to replace the old one everywhere.
  if (previous) window.setTimeout(() => URL.revokeObjectURL(previous.url), 2000);
  return url;
}

// Starts the pictures that may start: picturesAtOnce() on their way at most, the oldest first. One
// no longer wanted by the time its turn comes (the page hidden, the full view opened) is skipped.
function startWaiting() {
  while (fetching < picturesAtOnce() && waiting.length) {
    const job = waiting.shift();
    if (job.wanted && !job.wanted()) {
      loading.delete(job.key);
      job.resolve(null);
      continue;
    }
    fetching += 1;
    fetchPicture(job.camera, job.width)
      .then(job.resolve, job.reject)
      .finally(() => {
        fetching -= 1;
        loading.delete(job.key);
        startWaiting();
      });
  }
}

// The picture of `camera` at `width`: the one already asked for while it has not come, or a new
// request. `first`: ahead of the others waiting (the full view, the doorbell banner). Resolves to its
// address, or null when it was no longer `wanted()` by its turn.
function picture(camera, width, { first = false, wanted = null } = {}) {
  const key = `${camera.id}:${width}`;
  if (loading.has(key)) return loading.get(key);
  const promise = new Promise((resolve, reject) => {
    const job = { key, camera, width, wanted, resolve, reject };
    if (first) waiting.unshift(job);
    else waiting.push(job);
  });
  loading.set(key, promise);
  startWaiting();
  return promise;
}

// A picture asked for before the cameras are read (1.11.0, ADR-078: a doorbell's screen opened by its
// ring's notification, views/doorbell.js): first in line, and every tile of it shows it as it comes.
export function prefetchPicture(cameraId, width) {
  const id = Number(cameraId);
  if (!Number.isInteger(id) || id < 1) return Promise.resolve(null);
  const key = `${id}:${width}`;
  return picture({ id, snapshot_href: `/v1/cameras/${id}/snapshot` }, width, { first: true })
    .then((url) => {
      if (url) for (const image of tilesOf(key)) image.src = url;
      return url;
    })
    .catch(() => null);
}

function bestPicture(cameraId, width) {
  const exact = pictures.get(`${cameraId}:${width}`);
  if (exact) return exact;
  let best = null;
  for (const [key, value] of pictures) {
    const [id, size] = key.split(":").map(Number);
    if (id === Number(cameraId) && (!best || size > best.size)) best = { ...value, size };
  }
  return best;
}

function setTileState(image, tileState) {
  const tile = image.closest(".cam");
  if (tile && tile.dataset.state !== tileState) tile.dataset.state = tileState;
}

// Call after every render: shows the last picture at once and watches visibility.
// A picture the browser cannot decode counts as "No picture".
function watchDecoding(image) {
  if (image.dataset.watched) return;
  image.dataset.watched = "1";
  image.addEventListener("error", () => setTileState(image, "none"));
  image.addEventListener("load", () => setTileState(image, "ok"));
}

export function attachCameraImages(root) {
  for (const image of root.querySelectorAll("img[data-camera-id]")) {
    watchDecoding(image);
    const picture = bestPicture(image.dataset.cameraId, Number(image.dataset.width));
    if (picture) {
      image.src = picture.url;
    }
    if (observer && !observed.has(image)) {
      observer.observe(image);
      observed.add(image);
    }
  }
  forgetRemoved();
  scheduleGrid(picturesPending(root) ? 400 : GRID_REFRESH_MS());
  if (!liveRunning && root.querySelector("img[data-camera-id][data-live]")) {
    liveRunning = true;
    window.setTimeout(refreshLive, 250);
  }
}

function scheduleGrid(delay) {
  if (gridRunning || gridTimer) return;
  gridTimer = window.setTimeout(refreshGrid, delay);
}

// Images replaced by a redraw are no longer watched.
function forgetRemoved() {
  for (const image of observed) {
    if (!image.isConnected) {
      observer.unobserve(image);
      observed.delete(image);
    }
  }
}

function picturesPending(root) {
  return [...root.querySelectorAll("img[data-camera-id]")].some((image) => !image.getAttribute("src"));
}

function isVisible(image) {
  return image.isConnected && (!observer || visible.has(image));
}

// The tiles on the page now that show `key` ("cameraId:width"): a redraw while its picture was on
// its way made new ones.
function tilesOf(key) {
  const [id, width] = key.split(":");
  return [...document.querySelectorAll(`img[data-camera-id="${id}"][data-width="${width}"]`)].filter((image) => !image.closest("dialog"));
}

// Each picture as soon as it comes; one request per camera and size, however many tiles show it.
// Resolves to false when the key was refused (the device was signed out), else true.
async function refreshImages(images, stillWanted, { first = false } = {}) {
  const keys = new Set();
  for (const image of images.filter(isVisible)) {
    keys.add(`${image.dataset.cameraId}:${image.dataset.width}`);
  }
  let refused = null;
  await Promise.all(
    [...keys].map(async (key) => {
      const [id, width] = key.split(":").map(Number);
      const camera = cameraById(id);
      if (!camera || !stillWanted()) return;
      try {
        const url = await picture(camera, width, { first, wanted: stillWanted });
        if (!url) return;
        for (const image of tilesOf(key)) {
          image.src = url;
        }
        noteFilled();
      } catch (error) {
        if (error?.status === 401) {
          refused = refused || error;
          return;
        }
        for (const image of tilesOf(key)) {
          // 503: the camera proxy is busy; keep the last picture and try again next round.
          if (error?.status !== 503) setTileState(image, "none");
          else if (!image.getAttribute("src")) setTileState(image, "busy");
        }
      }
    })
  );
  if (refused) {
    handleUnauthorized(refused);
    return false;
  }
  return true;
}

// How long a screen of new tiles took until every one had a picture (lastFill; the console says it,
// to compare at home and through the account).
function startFilling(images) {
  const empty = images.filter((image) => isVisible(image) && !image.getAttribute("src")).length;
  if (empty && !filling) filling = { started: performance.now(), pictures: empty };
}

function noteFilled() {
  if (!filling) return;
  const shown = [...document.querySelectorAll("img[data-camera-id]")].filter((image) => !image.closest("dialog") && isVisible(image));
  if (shown.some((image) => !image.getAttribute("src"))) return;
  lastFill = { pictures: filling.pictures, ms: Math.round(performance.now() - filling.started), atOnce: picturesAtOnce(), transport: state.transport };
  filling = null;
  console.info(`DirectorLink: ${lastFill.pictures} camera pictures in ${lastFill.ms} ms, ${lastFill.atOnce} at once (${lastFill.transport || "home"})`);
}

const canRefresh = () => !document.hidden && !full && state.apiKey && state.status === "connected";

// Live pictures (the doorbell banner), about every second while one is on screen.
async function refreshLive() {
  const images = [...document.querySelectorAll("img[data-camera-id][data-live]")].filter((image) => !image.closest("dialog"));
  if (!images.length || (canRefresh() && !(await refreshImages(images, canRefresh, { first: true })))) {
    liveRunning = false;
    return;
  }
  window.setTimeout(refreshLive, LIVE_REFRESH_MS());
}

// The tiles, a round at a time. A round waits for its pictures, but at most one refresh interval:
// a slow camera does not hold the others back, and is not asked again while its picture is still
// on its way.
async function refreshGrid() {
  gridTimer = null;
  const images = [...document.querySelectorAll("img[data-camera-id]:not([data-live])")].filter((image) => !image.closest("dialog"));
  if (!images.length) return;
  gridRunning = true;
  try {
    if (canRefresh()) {
      startFilling(images);
      let timer = null;
      const longest = new Promise((resolve) => {
        timer = window.setTimeout(() => resolve(true), GRID_REFRESH_MS());
      });
      const done = await Promise.race([refreshImages(images, canRefresh), longest]);
      window.clearTimeout(timer);
      if (!done) return;
    }
  } finally {
    gridRunning = false;
  }
  scheduleGrid(GRID_REFRESH_MS());
}

// Full view in a <dialog>; the picture size follows the screen.
export function openFullView(dialog, camera, { titleElement, image, status }) {
  closeFullView();
  titleElement.textContent = camera.name;
  image.alt = t("cameras.pictureOf", { name: camera.name });
  watchDecoding(image);
  image.removeAttribute("src");
  const cached = bestPicture(camera.id, 1280);
  if (cached) image.src = cached.url;
  status.textContent = t("common.loading");
  setTileState(image, "loading");
  const width = window.innerWidth * (window.devicePixelRatio || 1) > 1400 ? 1920 : 1280;
  full = { camera, image, status, dialog, width, timer: null };
  if (!dialog.open) dialog.showModal();
  refreshFull();
}

async function refreshFull() {
  if (!full) return;
  const current = full;
  current.timer = null;
  if (!document.hidden) {
    try {
      const url = await picture(current.camera, current.width, { first: true });
      if (full !== current) return;
      if (url) {
        current.image.src = url;
        current.status.textContent = t("cameras.updated", { time: formatTime(new Date()) });
      }
    } catch (error) {
      if (full !== current) return;
      if (error?.status === 401) {
        closeFullView();
        handleUnauthorized(error);
        return;
      }
      if (error?.status === 503) {
        current.status.textContent = t("cameras.busy");
      } else {
        current.status.textContent = t("cameras.noPicture");
        if (!current.image.getAttribute("src")) setTileState(current.image, "none");
      }
    }
  }
  if (full === current) current.timer = window.setTimeout(refreshFull, FULL_REFRESH_MS());
}

export function closeFullView() {
  if (!full) return;
  window.clearTimeout(full.timer);
  const dialog = full.dialog;
  full = null;
  if (dialog.open) dialog.close();
  scheduleGrid(300);
}

export function fullViewCamera() {
  return full?.camera || null;
}
