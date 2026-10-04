// App state shared by every screen. Views read it and call notify() after changing it;
// the renderer redraws the current screen on the next animation frame.

export const state = {
  host: "",
  apiKey: "",
  // setup (no key: pair with a code) · connecting · connected · unreachable
  status: "setup",
  // How requests travel: "lan" (the home network) or "remote" (sealed, through the account).
  transport: "lan",
  // GET /v1/remote from the controller, for Settings → Account (null until asked).
  remoteInfo: null,
  // This person's profile (profile.js): null until read, and with drivers before 0.12.0.
  profile: null,
  // The home's scenes (scenes.js): null until read; scenesUnsupported with drivers before 0.13.0.
  scenes: null,
  scenesUnsupported: false,
  scenesError: null, // the first read failed: why (shown with Retry)
  // The home's schedules (schedules.js), like scenes; and the weather at home while Schedules is open.
  schedules: null,
  schedulesPaused: false, // the installer paused them all in Composer
  schedulesUnsupported: false,
  schedulesError: null,
  weather: null,
  // GET /v1/calendar (calendar.js): null until read, and while the Jewish calendar is off.
  calendar: null,
  notice: null, // { kind: "error" | "info" | "success", text } shown on the connect screen
  // The controller cannot pair without the code crossing the network (DirectorLink before 1.3.0,
  // or its lock failed its self-test): { host, reason: "older" | "lock" }, or null. The connect
  // screen warns while its address field holds that host, and only "Pair anyway" sends the code,
  // to that host (session.js, ADR-039).
  pairingUnprotected: null,
  loaded: false,
  system: null,
  rooms: [],
  devices: [],
  lights: [],
  thermostats: [],
  fans: [], // [] on drivers without /v1/fans (before 1.2.0)
  blinds: [],
  cameras: [],
  relays: [], // doors and gates; [] on drivers without /v1/relays
  doorbells: [], // DoorBird doorstations; [] on drivers without /v1/doorbells
  refrigerators: [], // Samsung refrigerators (1.7.0); [] on drivers without /v1/refrigerators
  alarm: null, // GET /v1/alarm (alarm.js): { enabled, partitions }, read-only; null when not shown
  music: null, // GET /v1/music (music.js): { enabled, status, items }, the Sonos rooms; null when not shown
  // This key's role (GET /v1/api-keys/current): viewer < member < doors < admin.
  // Drivers without roles answer 404 there; their keys can do everything, so "admin".
  role: null,
  lastUpdated: null,
  // Per device ("light:22"): short inline error after a failed command.
  errors: {},
  // Per device: a command is in flight, so polls must not overwrite the optimistic state.
  pending: {},
  // Brightness last sent to lights that do not report their level.
  sentBrightness: {},
  online: navigator.onLine,
  canInstall: false,
  offlineCopy: "checking",
  // The DirectorLink account (account.js): status unknown · loading · signed-in · signed-out ·
  // unavailable; notice is a sign-in outcome to show once (cancelled, expired, failed, …).
  account: { status: "unknown", user: null, notice: null, busy: false },
};

// UI-only state (not from the controller).
export const ui = {
  filter: null, // home summary filter: "lights" | "climate" | "blinds"
  // Home's Turn off all (turn-off.js): filter -> { stage: "confirm" | "running" | "done" | "partial" | "error", … }
  offRuns: {},
  editFavorites: false,
  roomDrafts: {}, // settings: room names being edited, "roomId:lang" -> text
  roomMessages: {}, // settings: per-room save result
  roomOrderMessage: null, // settings: the room order could not be saved
  sceneRuns: {}, // scene id -> { stage: "confirm" | "running" | "done" | "partial" | "error", text } after Run
  sceneEditor: null, // the scene being edited (views/scenes.js)
  sceneIdea: null, // an idea to start a new scene from
  scenesMessage: null, // scenes list: saved or deleted
  scheduleEditor: null, // the schedule being edited (views/schedules.js)
  cameFrom: null, // the screen before this one (app.js), so an editor can go back to its list
  schedulesMessage: null, // schedules list: saved, deleted or not switched
  calendarSettings: null, // Settings → Shabbat and holidays: the settings being changed (views/settings.js)
  drafts: {}, // form fields being typed: key -> text
  find: null, // Find my controller on the pairing screen (views/find.js): { stage, range, controllers }
  relayStage: {}, // door/gate Open button: relayId -> "confirm" | "sending" | "sent"
  doorbellStage: {}, // doorbell Open gate button: doorbellId -> "confirm" | "sending" | "sent"
  featuredCamera: null, // Cameras tab: id of the large picture
  dragging: false, // a slider thumb is held: redraws wait
  reordering: false, // Settings → Rooms: a room is being moved (views/settings.js): redraws wait
  tick: 0, // bumped by timers that need a redraw
};

const listeners = new Set();
let scheduled = false;

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notify() {
  if (scheduled) {
    return;
  }
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const listener of listeners) {
      listener();
    }
  });
}

export const KINDS = {
  light: { list: "lights", path: "/v1/lights" },
  thermostat: { list: "thermostats", path: "/v1/thermostats" },
  fan: { list: "fans", path: "/v1/fans" },
  blind: { list: "blinds", path: "/v1/blinds" },
  camera: { list: "cameras", path: "/v1/cameras" },
  relay: { list: "relays", path: "/v1/relays" },
  doorbell: { list: "doorbells", path: "/v1/doorbells" },
  refrigerator: { list: "refrigerators", path: "/v1/refrigerators" },
};

// Roles, lowest first. can("member") is true for member, doors and admin keys.
export const ROLES = ["viewer", "member", "doors", "admin"];

export function can(role) {
  const mine = ROLES.indexOf(state.role || "admin");
  // An unknown (newer) role gets the safe, read-only interface; the controller decides anyway.
  return mine >= 0 && mine >= ROLES.indexOf(role);
}

export function deviceKey(kind, id) {
  return `${kind}:${id}`;
}

export function findDevice(kind, id) {
  const list = state[KINDS[kind]?.list] || [];
  return list.find((item) => item.id === Number(id)) || null;
}

export function replaceDevice(kind, device) {
  const listName = KINDS[kind].list;
  state[listName] = state[listName].map((item) => (item.id === device.id ? device : item));
}

export function setError(key, text) {
  const stamp = Date.now();
  state.errors = { ...state.errors, [key]: { text, stamp } };
  notify();
  window.setTimeout(() => {
    if (state.errors[key]?.stamp === stamp) {
      const { [key]: _removed, ...rest } = state.errors;
      state.errors = rest;
      notify();
    }
  }, 8000);
}

export function clearError(key) {
  if (state.errors[key]) {
    const { [key]: _removed, ...rest } = state.errors;
    state.errors = rest;
  }
}
