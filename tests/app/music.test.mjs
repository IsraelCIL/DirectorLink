// Sonos music in the app (app/js/music.js, app/js/views/music.js, ADR-044): nothing at all until
// an installer turns Sonos on (GET /v1/system features.sonos); then each Sonos room in its room,
// Home's "Music playing", and for admins the room of each Sonos room. Viewers see, members control.
// Home and an open room are read every 5 s, other screens not. English and Hebrew.
//   node --test tests/app/

import assert from "node:assert/strict";
import test from "node:test";

// Just enough of a browser for these modules: the elements the views build, storage and timers.
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.className = "";
    this.listeners = {};
    this.style = { setProperty() {} };
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  focus() {
    document.activeElement = this;
  }
  append(...children) {
    this.children.push(...children);
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join("");
  }
}
globalThis.Node = FakeNode;
globalThis.window = globalThis;
globalThis.location = { hostname: "app.directorlink.io", origin: "https://app.directorlink.io", href: "https://app.directorlink.io/", pathname: "/", search: "", hash: "" };
window.addEventListener = () => {};
window.removeEventListener = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Node", maxTouchPoints: 0, languages: ["en"], language: "en", onLine: true },
  configurable: true,
});
globalThis.document = {
  hidden: false,
  activeElement: null,
  documentElement: {},
  addEventListener() {},
  querySelector: () => null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeNode(), { textContent: String(text) }),
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
URL.createObjectURL = () => "blob:art";
URL.revokeObjectURL = () => {};

const { state } = await import("../../app/js/state.js");
const { setLanguage } = await import("../../app/js/i18n.js");
const { forgetKey } = await import("../../app/js/session.js");
const music = await import("../../app/js/music.js");
const views = await import("../../app/js/views/music.js");
const { visibleRooms, devicesInRoom, NO_ROOM } = await import("../../app/js/model.js");
const scenes = await import("../../app/js/scenes.js");
const { default: en } = await import("../../app/i18n/en.js");
const { default: he } = await import("../../app/i18n/he.js");

const KITCHEN = "RINCON_000E58A0000101400";
const LIVING = "RINCON_000E58A0000201400";
const BEDROOM = "RINCON_000E58A0000301400";
const TV = "RINCON_000E58A0000401400";

// A Sonos room as GET /v1/music lists it.
const room = (fields) => ({
  room_id: null,
  room_match: null,
  state: "paused",
  volume: 20,
  muted: false,
  now_playing: null,
  can_skip: false,
  reachable: true,
  updated_at: "2026-10-02T10:00:00Z",
  ...fields,
});
const group = (id, ...rooms) => ({ id, coordinator: false, rooms: rooms.map(([roomId, name]) => ({ id: roomId, name })) });
const track = { kind: "music", title: "Morning Light", artist: "The Example Band", album: "First Album", station: null, source: null, art_href: `/v1/music/${KITCHEN}/art`, art_key: "80ffc887" };
const radio = { kind: "radio", title: "Evening Song", artist: "The Example Band", album: null, station: "Example FM 99", source: null, art_href: `/v1/music/${BEDROOM}/art`, art_key: "a5c15407" };
const kitchenGroup = group(KITCHEN, [KITCHEN, "Kitchen"], [LIVING, "Living Room"]);
const kitchen = room({ id: KITCHEN, name: "Kitchen", room_id: 10, room_match: "name", state: "playing", volume: 30, now_playing: track, can_skip: true, group: { ...kitchenGroup, coordinator: true } });
const living = room({ id: LIVING, name: "Living Room", room_id: 11, room_match: "name", state: "playing", now_playing: track, can_skip: true, group: kitchenGroup });
const bedroom = room({ id: BEDROOM, name: "Bedroom", state: "playing", volume: 25, now_playing: radio, group: { ...group(BEDROOM, [BEDROOM, "Bedroom"]), coordinator: true } });
const tv = room({
  id: TV,
  name: "TV Room",
  volume: 40,
  now_playing: { kind: "connect", title: null, artist: null, album: null, station: null, source: "Spotify", art_href: null, art_key: null },
  group: { ...group(TV, [TV, "TV Room"]), coordinator: true },
});
const ON = { enabled: true, status: "ok", items: [bedroom, kitchen, living, tv] };

// The controller: GET /v1/music answers `answers.list` (or per room_id), commands answer what
// `answers` says. It does not seal (a driver before 1.0.0): how requests travel does not matter
// here. Returns what the app sent.
function controller(answers = {}) {
  const sent = [];
  globalThis.fetch = async (url, options = {}) => {
    const address = new URL(url);
    const method = options.method || "GET";
    sent.push({ line: `${method} ${address.pathname}${address.search}`, body: options.body ? JSON.parse(options.body) : null });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (address.pathname === "/v1/sealed") return reply(404, { code: "NOT_FOUND" });
    if (address.pathname === "/v1/music") {
      const roomId = address.searchParams.get("room_id");
      const answer = roomId ? { ...ON, items: ON.items.filter((item) => item.room_id === Number(roomId)) } : answers.list || ON;
      return reply(200, answer);
    }
    if (address.pathname.endsWith("/favorites")) {
      if (answers.favoritesFail) return reply(answers.favoritesFail.status, { status: answers.favoritesFail.status, code: answers.favoritesFail.code, detail: "refused" });
      return reply(200, {
        items: [
          { id: "10", title: "Example FM 99", description: "TuneIn Station", playable: true },
          { id: "1", title: "Discover Sonos Radio", description: "Sonos Radio", playable: false },
        ],
      });
    }
    if (address.pathname.endsWith("/art")) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "Content-Type": "image/png" } });
    if (answers.fail) return reply(answers.fail.status, { status: answers.fail.status, code: answers.fail.code, detail: "refused" });
    const id = decodeURIComponent(address.pathname.split("/")[3] || "");
    const item = ON.items.find((entry) => entry.id === id);
    if (method === "PATCH") return reply(200, { ...item, ...JSON.parse(options.body) });
    if (method === "PUT") return reply(200, { ...item, room_id: JSON.parse(options.body).room_id, room_match: JSON.parse(options.body).room_id ? "admin" : null });
    if (address.pathname.endsWith("/pause")) return reply(200, { ...item, state: "paused" });
    if (address.pathname.endsWith("/play")) return reply(200, { ...item, state: "playing" });
    return reply(200, item);
  };
  return sent;
}
const lines = (sent) => sent.map((entry) => entry.line);

// Connected, with this role and Sonos as Composer has it.
function home({ role = "admin", sonos = true, features = true, hidden = [], groups = false } = {}) {
  state.host = "192.0.2.10";
  state.apiKey = "ak_test";
  state.transport = "lan";
  state.status = "connected";
  state.loaded = true;
  state.role = role;
  state.system = features ? { bridge: { version: groups ? "1.8.0" : "1.5.0" }, features: groups ? { sonos, sonos_groups: true } : { sonos } } : { bridge: { version: "1.4.0" } };
  state.rooms = [
    { id: 11, name: "Living Room" },
    { id: 10, name: "Kitchen" },
  ];
  state.profile = { prefs: { hidden_rooms: hidden } };
  state.music = null;
  state.errors = {};
}

// Every element in a tree, depth first.
function all(node) {
  if (!(node instanceof FakeElement)) return [];
  return [node, ...node.children.flatMap(all)];
}
const byKey = (root, key) => all(root).find((element) => element.dataset.key === key);
// h() sets "disabled" as an attribute on these fake elements.
const disabled = (element) => "disabled" in element.attributes;
const byClass = (root, name) => all(root).filter((element) => element.className.split(/\s+/).includes(name));
const iso = (text) => `⁨${text}⁩`;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("while Sonos is off nothing is asked and nothing is shown", async () => {
  for (const setup of [{ sonos: false }, { features: false }]) {
    home(setup);
    const sent = controller();
    await music.loadMusic();
    assert.deepEqual(lines(sent).filter((line) => line.includes("/v1/music")), [], JSON.stringify(setup));
    state.music = ON; // even with an answer at hand
    assert.equal(views.musicHomeSection(), null);
    assert.equal(views.musicRoomsSection(), null);
    assert.deepEqual(devicesInRoom(10).music, []);
  }
});

test("Home lists what plays, one line per group, in the home's room order; paused rooms are not there", async () => {
  home();
  controller();
  await music.loadMusic();
  const groups = views.playingGroups();
  assert.deepEqual(
    groups.map((item) => item.id),
    [KITCHEN, BEDROOM],
    "Kitchen leads its group (Living Room comes first in the room order, Kitchen stands for it); Bedroom has no room and comes last"
  );
  const section = views.musicHomeSection();
  const text = section.textContent;
  for (const words of ["Music playing", "Kitchen + Living Room", "Morning Light · The Example Band · First Album", "Bedroom", "Example FM 99 · The Example Band – Evening Song"]) {
    assert.ok(text.includes(words), `"${words}" in ${text}`);
  }
  assert.ok(!text.includes("TV Room"), "paused: not on Home");
  // A room hidden for this person is not shown; a group with a room still shown is.
  home({ hidden: [10] });
  controller();
  await music.loadMusic();
  assert.deepEqual(views.playingGroups().map((item) => item.id), [LIVING, BEDROOM]);
  home({ hidden: [10, 11] });
  controller();
  await music.loadMusic();
  assert.deepEqual(views.playingGroups().map((item) => item.id), [BEDROOM]);
});

test("a room with only a Sonos is a room to show; unmatched Sonos rooms go under No room", async () => {
  home();
  controller({ list: { ...ON, items: [kitchen, bedroom] } });
  await music.loadMusic();
  state.lights = state.thermostats = state.fans = state.blinds = state.cameras = state.relays = state.doorbells = state.devices = [];
  const rooms = visibleRooms();
  assert.deepEqual(rooms.map((entry) => entry.room.id), [10, NO_ROOM]);
  assert.deepEqual(rooms[0].group.music.map((item) => item.id), [KITCHEN]);
  assert.deepEqual(rooms[1].group.music.map((item) => item.id), [BEDROOM]);
});

// Control4's own Sonos drivers in the project (1.11.0, ADR-080): while DirectorLink plays Sonos, its
// driver says their proxies are part of Music (`part_of_music` in /v1/devices), and a room does not
// list them among the devices the app cannot control, next to the same speakers in Music. With
// Sonos off, or a driver before 1.11.0 (which says nothing of it), they are listed as before.
test("Control4's own Sonos players are no other devices of a room while Sonos plays here", async () => {
  home();
  controller();
  await music.loadMusic();
  state.lights = state.thermostats = state.fans = state.blinds = state.cameras = state.relays = state.doorbells = state.refrigerators = [];
  const kitchenRoom = { id: 10, name: "Kitchen" };
  const device = (id, name, partOfMusic) => ({ id, name, type: "other", room: kitchenRoom, supported: false, href: null, part_of: null, part_of_music: partOfMusic });
  const listed = [device(84, "Sonos Network", true), device(85, "Kitchen Sonos", true), device(40, "Front Door", false)];
  const others = () => devicesInRoom(10).others.map((item) => item.name);
  state.devices = listed.map((item) => ({ ...item }));
  assert.deepEqual(others(), ["Front Door"]);
  assert.deepEqual(devicesInRoom(10).music.map((item) => item.id), [KITCHEN], "the speakers, in Music");

  state.devices = listed.map(({ part_of_music: _music, ...item }) => item);
  assert.deepEqual(others(), ["Sonos Network", "Kitchen Sonos", "Front Door"], "a driver before 1.11.0");

  state.devices = listed.map((item) => ({ ...item }));
  home({ sonos: false });
  assert.deepEqual(others(), ["Sonos Network", "Kitchen Sonos", "Front Door"], "Sonos off, before the devices are read again");
});

test("Home and an open room are read every 5 s, other screens not, and nothing once the key is forgotten", async (t) => {
  home();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = controller();
  const reads = () => lines(sent).filter((line) => line.startsWith("GET /v1/music"));
  await music.startMusic({ name: "home" });
  t.mock.timers.tick(0);
  await settle();
  assert.deepEqual(reads(), ["GET /v1/music"]);
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(reads(), ["GET /v1/music", "GET /v1/music"]);
  // A room: only it, every 5 s; what is known of the other rooms stays.
  music.musicRouteChanged({ name: "room", id: 10 });
  t.mock.timers.tick(0);
  await settle();
  assert.equal(reads().at(-1), "GET /v1/music?room_id=10");
  assert.equal(state.music.items.length, 4, "the other Sonos rooms are kept");
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(reads().at(-1), "GET /v1/music?room_id=10");
  const count = reads().length;
  music.musicRouteChanged({ name: "scenes" });
  t.mock.timers.tick(30000);
  await settle();
  assert.equal(reads().length, count, "not read on another screen");
  music.musicRouteChanged({ name: "home" });
  t.mock.timers.tick(0);
  await settle();
  assert.equal(reads().length, count + 1);
  forgetKey();
  t.mock.timers.tick(30000);
  await settle();
  assert.equal(reads().length, count + 1, "nothing once the key is forgotten");
  assert.equal(state.music, null, "nothing of it stays");
});

test("Home and a room are redrawn only when what they show changes, not at every read", async () => {
  home();
  controller();
  await music.loadMusic();
  const before = JSON.stringify(music.musicSignature());
  // The next read: every room read again (updated_at), and the search for players said again.
  const reread = (item) => ({ ...item, updated_at: "2026-10-02T10:00:05Z" });
  controller({ list: { ...ON, status: "searching", items: ON.items.map(reread) } });
  await music.loadMusic();
  assert.equal(music.findMusic(KITCHEN).updated_at, "2026-10-02T10:00:05Z");
  assert.equal(JSON.stringify(music.musicSignature()), before, "nothing shown changed: no redraw");
  // A new song is.
  const next = (item) => (item.id === KITCHEN ? { ...reread(item), now_playing: { ...track, title: "Next Song" } } : reread(item));
  controller({ list: { ...ON, items: ON.items.map(next) } });
  await music.loadMusic();
  assert.notEqual(JSON.stringify(music.musicSignature()), before);
});

test("play and pause work on the group at once on screen, and come back if the speaker refuses", async () => {
  home();
  controller();
  await music.loadMusic();
  let sent = controller();
  const pausing = music.musicCommand(music.findMusic(LIVING), "pause");
  assert.deepEqual(
    state.music.items.filter((item) => item.group.id === KITCHEN).map((item) => item.state),
    ["paused", "paused"],
    "both rooms of the group show it at once"
  );
  assert.equal(await pausing, true);
  assert.deepEqual(lines(sent), [`POST /v1/music/${LIVING}/pause`]);
  sent = controller({ fail: { status: 502, code: "PLAYER_UNREACHABLE" } });
  assert.equal(await music.musicCommand(music.findMusic(KITCHEN), "play"), false);
  assert.equal(music.findMusic(KITCHEN).state, "paused", "back as it was");
  assert.equal(state.errors[`music:${KITCHEN}`].text, "The speaker didn’t answer");
  controller({ fail: { status: 409, code: "ACTION_NOT_POSSIBLE" } });
  await music.musicCommand(music.findMusic(BEDROOM), "next");
  assert.equal(state.errors[`music:${BEDROOM}`].text, "The speaker can’t do that now");
});

test("play and pause are one button, so it keeps the focus; on Home, Pause leaves the keyboard on the section", async () => {
  home({ role: "member" });
  controller();
  await music.loadMusic();
  // app.js restoreUi puts focus back on the element with the same data-key after a redraw.
  const playing = byKey(views.musicCard(music.findMusic(KITCHEN)), `music:${KITCHEN}:main`);
  assert.equal(playing.attributes["aria-label"], "Pause in Kitchen");
  const paused = byKey(views.musicCard({ ...music.findMusic(KITCHEN), state: "paused" }), `music:${KITCHEN}:main`);
  assert.equal(paused.attributes["aria-label"], "Play in Kitchen");
  const section = views.musicHomeSection();
  assert.equal(byKey(section, "home-music-title").attributes.tabindex, "-1", "the section's title takes focus");
  // Pause on Home takes the group's line away: the keyboard goes to the section's title while
  // another group plays, then to the page's title.
  const focused = [];
  document.querySelector = (selector) => ({ focus: () => focused.push(selector) });
  try {
    controller();
    byKey(section, `music:${KITCHEN}:main:home`).listeners.click({});
    assert.deepEqual(views.playingGroups().map((item) => item.id), [BEDROOM]);
    assert.deepEqual(focused, ["#home-music-title"]);
    await settle();
    byKey(views.musicHomeSection(), `music:${BEDROOM}:main:home`).listeners.click({});
    assert.equal(views.musicHomeSection(), null, "nothing plays");
    assert.deepEqual(focused, ["#home-music-title", ".page-title"]);
    await settle();
  } finally {
    document.querySelector = () => null;
  }
  // In Hebrew, the group and its Play button do not sound the same.
  await setLanguage("he");
  try {
    const card = views.musicCard(music.findMusic(KITCHEN));
    const group = byClass(card, "music-controls")[0].getAttribute("aria-label");
    const play = byKey(card, `music:${KITCHEN}:main`).attributes["aria-label"];
    assert.equal(play, "ניגון: Kitchen");
    assert.notEqual(group, play);
  } finally {
    await setLanguage("en");
  }
});

test("volume and mute are each room's own", async () => {
  home();
  controller();
  await music.loadMusic();
  const sent = controller();
  await music.setMusicLevels(music.findMusic(LIVING), { volume: 35 });
  assert.deepEqual(sent.map((entry) => [entry.line, entry.body]), [[`PATCH /v1/music/${LIVING}`, { volume: 35 }]]);
  assert.equal(music.findMusic(LIVING).volume, 35);
  assert.equal(music.findMusic(KITCHEN).volume, 30, "the other room of the group keeps its own");
  await music.setMusicLevels(music.findMusic(KITCHEN), { muted: true });
  assert.equal(music.findMusic(KITCHEN).muted, true);
});

test("viewers see what plays and its volume, and nothing to press", async () => {
  home({ role: "viewer" });
  controller();
  await music.loadMusic();
  const card = views.musicCard(music.findMusic(KITCHEN));
  assert.ok(card.textContent.includes("Morning Light"));
  assert.ok(card.textContent.includes("Volume 30%"));
  assert.equal(byClass(card, "music-controls").length, 0);
  assert.equal(byClass(card, "music-volume").length, 0);
  const sent = controller();
  await music.musicCommand(music.findMusic(KITCHEN), "pause");
  await music.setMusicLevels(music.findMusic(KITCHEN), { volume: 5 });
  await music.placeMusicRoom(music.findMusic(BEDROOM), 10);
  assert.deepEqual(lines(sent), [], "nothing is sent for a viewer");
  assert.equal(views.musicRoomsSection(), null, "the Sonos rooms are an admin's");
  assert.equal(views.musicHomeSection().textContent.includes("Morning Light"), true);
  assert.equal(byClass(views.musicHomeSection(), "music-controls").length, 0);
});

test("a member's card: what plays, the group, controls left to right, the volume", async () => {
  home({ role: "member" });
  controller();
  await music.loadMusic();
  const card = views.musicCard(music.findMusic(KITCHEN));
  const text = card.textContent;
  assert.ok(text.startsWith(`KitchenMorning LightThe Example Band · First AlbumPlaying · With ${iso("Living Room")}`), text);
  const controls = byClass(card, "music-controls")[0];
  assert.equal(controls.getAttribute("dir"), "ltr", "playback controls are not mirrored in Hebrew");
  assert.deepEqual(
    all(controls).filter((element) => element.tagName === "BUTTON").map((button) => button.attributes["aria-label"]),
    ["Previous", "Pause in Kitchen", "Next"]
  );
  assert.ok(byKey(card, `music:${KITCHEN}:volume`), "a volume slider");
  // The radio cannot skip; a player that does not answer has its controls off.
  const radioCard = views.musicCard(music.findMusic(BEDROOM));
  assert.equal(disabled(byKey(radioCard, `music:${BEDROOM}:next`)), true);
  assert.equal(disabled(byKey(radioCard, `music:${BEDROOM}:main`)), false);
  const offline = views.musicCard({ ...music.findMusic(BEDROOM), reachable: false });
  assert.ok(offline.textContent.includes("Not answering"));
  assert.equal(disabled(byKey(offline, `music:${BEDROOM}:main`)), true);
});

test("what plays, in words", () => {
  assert.deepEqual(views.nowPlayingText(kitchen), { title: "Morning Light", detail: "The Example Band · First Album" });
  assert.deepEqual(views.nowPlayingText(bedroom), { title: "Example FM 99", detail: "The Example Band – Evening Song" });
  assert.deepEqual(views.nowPlayingText(tv), { title: "Spotify", detail: "" });
  assert.deepEqual(views.nowPlayingText({ now_playing: { ...tv.now_playing, title: "A Song", artist: "Someone" } }), { title: "A Song", detail: `Someone · on ${iso("Spotify")}` });
  assert.deepEqual(views.nowPlayingText({ now_playing: { kind: "tv" } }), { title: "TV", detail: "" });
  assert.deepEqual(views.nowPlayingText({ now_playing: { kind: "radio", station: null, title: null } }), { title: "Radio", detail: "" });
  assert.deepEqual(views.nowPlayingText({ now_playing: null }), { title: "Nothing playing", detail: "" });
  assert.equal(views.musicStateText({ state: "transitioning" }), "Starting…");
  assert.equal(views.musicStateText({ state: "weird" }), "Not read yet");
});

test("favorites: listed when opened, the ones only Sonos starts greyed out and never sent", async () => {
  home({ role: "member" });
  controller();
  await music.loadMusic();
  let sent = controller();
  await music.loadFavorites(music.findMusic(KITCHEN));
  assert.deepEqual(lines(sent), [`GET /v1/music/${KITCHEN}/favorites`]);
  const card = views.musicCard(music.findMusic(KITCHEN));
  assert.equal(disabled(byKey(card, `music:${KITCHEN}:favorite:10`)), false);
  assert.equal(disabled(byKey(card, `music:${KITCHEN}:favorite:1`)), true);
  assert.ok(card.textContent.includes("Greyed-out favorites can only be started in the Sonos app."));
  sent = controller();
  const [station, shortcut] = music.musicFavorites(music.findMusic(KITCHEN)).items;
  assert.equal(await music.playFavorite(music.findMusic(KITCHEN), shortcut), false);
  assert.deepEqual(lines(sent), []);
  await music.playFavorite(music.findMusic(KITCHEN), station);
  assert.deepEqual(lines(sent), [`POST /v1/music/${KITCHEN}/favorites/10/play`]);
});

test("favorites that fail: asked once when opened, not again when a redraw opens the panel again; Retry asks again", async () => {
  forgetKey();
  home({ role: "member" });
  controller();
  await music.loadMusic();
  const sent = controller({ favoritesFail: { status: 502, code: "PLAYER_UNREACHABLE" } });
  const asked = () => lines(sent).filter((line) => line.endsWith("/favorites")).length;
  const panel = () => byKey(views.musicCard(music.findMusic(KITCHEN)), `music:${KITCHEN}:favorites`);
  const title = (details) => byKey(details, `music:${KITCHEN}:favorites:title`);
  // The person opens it: the click on its title comes before it opens, then it toggles.
  let details = panel();
  title(details).listeners.click({});
  details.open = true;
  details.listeners.toggle({ target: details });
  await settle();
  assert.equal(asked(), 1);
  // Every redraw builds the panel again and app.js opens it again, which fires toggle.
  for (let redraw = 0; redraw < 5; redraw++) {
    details = panel();
    details.open = true;
    details.listeners.toggle({ target: details });
    await settle();
  }
  assert.equal(asked(), 1, "not asked again by redraws");
  // The error stays on screen, with Retry.
  details = panel();
  assert.ok(details.textContent.includes("The speaker didn’t answer"), details.textContent);
  byKey(details, `music:${KITCHEN}:favorites:retry`).listeners.click({});
  assert.equal(document.activeElement, title(details), "while they load, the keyboard waits on the panel's title");
  await settle();
  assert.equal(asked(), 2);
  // A click that closes it asks nothing; opening it again asks again.
  details = panel();
  details.open = true;
  title(details).listeners.click({});
  await settle();
  assert.equal(asked(), 2);
  controller();
  details.open = false;
  title(details).listeners.click({});
  await settle();
  assert.equal(music.musicFavorites(music.findMusic(KITCHEN)).stage, "ready");
  // Opened some other way (find in page) and never loaded: loaded once.
  const living = controller();
  const other = byKey(views.musicCard(music.findMusic(LIVING)), `music:${LIVING}:favorites`);
  other.open = true;
  other.listeners.toggle({ target: other });
  await settle();
  assert.deepEqual(lines(living), [`GET /v1/music/${LIVING}/favorites`]);
});

test("album art comes through the controller, once per picture", async () => {
  home();
  controller();
  await music.loadMusic();
  const sent = controller();
  // A picture not seen yet (the cards above showed Kitchen's).
  const playing = { ...track, art_key: "0a0b0c0d" };
  const first = { ...music.findMusic(KITCHEN), now_playing: playing };
  assert.equal(music.musicArt(first), null, "fetched first");
  await settle();
  assert.equal(music.musicArt(first), "blob:art");
  assert.equal(music.musicArt({ ...music.findMusic(LIVING), now_playing: playing }), "blob:art", "the same picture for the group");
  assert.deepEqual(lines(sent), [`GET /v1/music/${KITCHEN}/art`]);
  assert.equal(music.musicArt(music.findMusic(TV)), null, "no picture");
});

test("album art: every picture on the screen stays, however many; the others go beyond 12", async () => {
  forgetKey();
  home();
  controller();
  await music.loadMusic();
  const sent = controller();
  const fetched = () => lines(sent).filter((line) => line.endsWith("/art")).length;
  let made = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:${++made}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    const playingArt = (prefix, count) =>
      Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, state: "playing", now_playing: { ...track, art_href: `/v1/music/${prefix}${i}/art`, art_key: `${prefix}${i}` } }));
    // 15 Sonos rooms on one screen (Home's Music playing, or No room): each redraw asks for each.
    const many = playingArt("many", 15);
    for (let redraw = 0; redraw < 5; redraw++) {
      many.forEach((item) => music.musicArt(item));
      await settle();
    }
    assert.equal(fetched(), 15, "each picture once");
    assert.ok(many.every((item) => music.musicArt(item)), "all 15 shown");
    assert.deepEqual(revoked, []);
    // Another screen with 3: of those no longer shown, the 12 newest stay.
    await settle();
    playingArt("few", 3).forEach((item) => music.musicArt(item));
    await settle();
    assert.equal(fetched(), 18);
    assert.deepEqual(revoked, ["blob:1", "blob:2", "blob:3"], "the oldest three go");
  } finally {
    URL.createObjectURL = () => "blob:art";
    URL.revokeObjectURL = () => {};
  }
});

test("admins pick the room of a Sonos room whose name matches none", async () => {
  home();
  controller();
  await music.loadMusic();
  const section = views.musicRoomsSection();
  const text = section.textContent;
  assert.ok(text.includes("Sonos rooms") && text.includes("2 Sonos rooms aren’t in a room yet."), text);
  const rows = byClass(section, "music-room");
  assert.deepEqual(
    rows.map((row) => row.className),
    ["device music-room is-unplaced", "device music-room is-unplaced", "device music-room", "device music-room"],
    "the unmatched first"
  );
  const select = byKey(section, `music:${BEDROOM}:place`);
  assert.deepEqual(
    select.children.map((option) => [option.attributes.value, option.textContent]),
    [["", "Not in a room"], ["11", "Living Room"], ["10", "Kitchen"]]
  );
  assert.equal(byKey(section, `music:${KITCHEN}:place`).children[0].textContent, "Same name: Kitchen");
  const sent = controller();
  select.listeners.change({ target: { value: "11" } });
  await settle();
  assert.deepEqual(sent.map((entry) => [entry.line, entry.body]), [[`PUT /v1/music/${BEDROOM}/room`, { room_id: 11 }]]);
  assert.equal(music.findMusic(BEDROOM).room_id, 11);
  byKey(views.musicRoomsSection(), `music:${BEDROOM}:place`).listeners.change({ target: { value: "" } });
  await settle();
  assert.deepEqual(sent.at(-1).body, { room_id: null }, "back to its name");
});

test("after an admin's pick, the first choice says where it goes back to: the room of the same name, or none", async () => {
  home();
  state.rooms = [
    { id: 11, name: "Living Room" },
    { id: 10, name: "Kitchen" },
    { id: 12, name: "Master Bedroom", names: { he: "חדר שינה" } },
  ];
  // Picked by an admin; null (PUT /v1/music/{id}/room) matches them by name again, as the driver
  // does: without regard to case or spaces, and with the rooms' names in other languages.
  const picked = (id, name) => room({ id, name, room_id: 11, room_match: "admin" });
  state.music = { enabled: true, status: "ok", items: [picked(KITCHEN, "kitchen"), picked(LIVING, "Master  bedroom"), picked(BEDROOM, "חדר שינה"), picked(TV, "TV Room")] };
  const first = (id) => byKey(views.musicRoomsSection(), `music:${id}:place`).children[0];
  assert.deepEqual([first(KITCHEN).attributes.value, first(KITCHEN).textContent], ["", "Same name: Kitchen"]);
  assert.equal("selected" in first(KITCHEN).attributes, false, "the admin's pick is the one selected");
  assert.equal(first(LIVING).textContent, "Same name: Master Bedroom");
  assert.equal(first(BEDROOM).textContent, "Same name: Master Bedroom");
  assert.equal(first(TV).textContent, "Not in a room", "no room has its name");
  // Two rooms of that name: the driver matches neither.
  state.rooms.push({ id: 13, name: "KITCHEN" });
  assert.equal(first(KITCHEN).textContent, "Not in a room");
  // Matched by its name: the driver's room.
  state.music = { ...state.music, items: [room({ id: KITCHEN, name: "Kitchen", room_id: 10, room_match: "name" })] };
  assert.equal(first(KITCHEN).textContent, "Same name: Kitchen");
  await setLanguage("he");
  try {
    state.music = { ...state.music, items: [picked(BEDROOM, "חדר שינה")] };
    assert.equal(first(BEDROOM).textContent, "אותו שם: חדר שינה");
  } finally {
    await setLanguage("en");
  }
});

test("a scene step pauses or stops the music in a room or the whole home", async () => {
  home();
  controller();
  await music.loadMusic();
  assert.ok(scenes.STEP_TYPES.includes("music"));
  assert.equal(scenes.STEP_ICONS.music, "music");
  assert.deepEqual(scenes.devicesOfType("music").map((item) => item.id), [BEDROOM, KITCHEN, LIVING, TV]);
  const pause = { type: "music", room_id: 10, device_ids: null, set: { action: "pause" } };
  const stop = { type: "music", room_id: null, device_ids: null, set: { action: "stop" } };
  assert.equal(scenes.stepAction(pause), "Pause");
  assert.equal(scenes.stepAction(stop), "Stop");
  assert.equal(scenes.sceneSummary({ steps: [pause, stop] }), `${iso(`${iso("Kitchen")} music`)}: Pause · ${iso("Music")}: Stop`);
  assert.deepEqual(scenes.stepDevices(pause).map((item) => item.id), [KITCHEN]);
});

test("a scene run says why its music was skipped", async () => {
  const run = (code) => ({ ran: 0, failed: 0, skipped: 1, problems: [{ step: 0, device_id: 0, outcome: "skipped", code, detail: "" }] });
  assert.equal(scenes.resultText(run("SONOS_OFF")), "Done — the music was skipped: Sonos is off in Composer");
  assert.equal(scenes.resultText(run("NO_PLAYERS")), "Done — the music was skipped: no Sonos speakers have been found yet");
  assert.equal(scenes.resultText(run("NO_SONOS_ROOM")), "Done — the music was skipped: there’s no Sonos speaker in that room");
  const mixed = { ran: 0, failed: 0, skipped: 2, problems: [run("SONOS_OFF").problems[0], { ...run("FORBIDDEN").problems[0], device_id: 5 }] };
  assert.equal(scenes.resultText(mixed), "Done — 2 devices were skipped", "different reasons: the count");
  await setLanguage("he");
  try {
    assert.equal(scenes.resultText(run("NO_SONOS_ROOM")), "בוצע — המוזיקה דולגה: אין רמקול Sonos בחדר הזה");
  } finally {
    await setLanguage("en");
  }
});

test("in Hebrew", async () => {
  home({ role: "member" });
  controller();
  await music.loadMusic();
  await setLanguage("he");
  try {
    assert.equal(views.musicStateText(kitchen), "מתנגן");
    assert.equal(views.musicStateText({ ...kitchen, state: "paused" }), "מושהה");
    assert.equal(views.musicStateText({ ...kitchen, reachable: false }), "לא עונה");
    const card = views.musicCard(music.findMusic(KITCHEN));
    assert.ok(card.textContent.includes(`מתנגן · יחד עם ${iso("Living Room")}`), card.textContent);
    assert.equal(byClass(card, "music-controls")[0].getAttribute("dir"), "ltr");
    assert.ok(views.musicHomeSection().textContent.startsWith("מוזיקה מתנגנת"));
    assert.equal(scenes.stepAction({ type: "music", set: { action: "pause" } }), "השהיה");
    home();
    controller();
    await music.loadMusic();
    assert.ok(views.musicRoomsSection().textContent.includes("2 חדרי Sonos עדיין לא משויכים לחדר."));
  } finally {
    await setLanguage("en");
  }
  // Every English text has its Hebrew one.
  const keys = (node, prefix = "") =>
    Object.entries(node).flatMap(([key, value]) => (value && typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
  assert.deepEqual(keys(en.music).filter((key) => !keys(he.music).includes(key)), []);
  for (const path of ["sections.music", "rooms.musicPlaying", "scenes.all.music", "scenes.inRoom.music", "scenes.do.pauseMusic", "scenes.do.stopMusic", "scenes.add.kinds.music", "scenes.add.musicNote"]) {
    const value = path.split(".").reduce((node, key) => node?.[key], he);
    assert.equal(typeof value, "string", path);
  }
});

// ---- groups (1.8.0, ADR-057) ---------------------------------------------------------------

// The fixtures with the groups' volumes a 1.8.0 driver gives: Kitchen 30 and Living Room 20.
const GROUPED = {
  ...ON,
  items: ON.items.map((item) => ({ ...item, group: { ...item.group, volume: item.group.id === KITCHEN ? 25 : item.volume } })),
};

test("a group of rooms has one card: one now-playing, a slider for the group and one per room, Leave group", async () => {
  home({ role: "member", groups: true });
  controller({ list: GROUPED });
  await music.loadMusic();
  const cards = views.musicCards([music.findMusic(KITCHEN), music.findMusic(LIVING)]);
  assert.equal(cards.length, 1, "Kitchen and Living Room in one room's screen: one card");
  const card = cards[0];
  assert.ok(card.className.includes("music-group"));
  const text = card.textContent;
  assert.ok(text.startsWith("Kitchen + Living RoomMorning LightThe Example Band · First AlbumPlaying"), text);
  assert.equal(text.split("Morning Light").length, 2, "what plays, once");
  assert.ok(byKey(card, `music:${KITCHEN}:group-volume`), "a slider for the group");
  assert.equal(byKey(card, `music:${KITCHEN}:group-volume`).attributes.value, "25");
  assert.ok(byKey(card, `music:${KITCHEN}:volume`) && byKey(card, `music:${LIVING}:volume`), "one per room");
  assert.ok(byKey(card, `music:${KITCHEN}:leave`) && byKey(card, `music:${LIVING}:leave`));
  assert.equal(byKey(card, `music:${LIVING}:leave`).attributes["aria-label"], "Take Living Room out of the group");
  // Living Room's screen shows the same card.
  assert.equal(views.musicCards([music.findMusic(LIVING)])[0].textContent, text);
  // A room on its own keeps its own card.
  assert.ok(!views.musicCard(music.findMusic(TV)).className.includes("music-group"));
});

test("a driver before 1.8.0 groups nothing: the cards are as they were", async () => {
  home({ role: "member" });
  controller();
  await music.loadMusic();
  assert.equal(views.musicCards([music.findMusic(KITCHEN), music.findMusic(LIVING)]).length, 2);
  const card = views.musicCard(music.findMusic(KITCHEN));
  assert.ok(!card.className.includes("music-group"));
  assert.equal(byKey(card, `music:${KITCHEN}:more`), undefined, "no Play in more rooms");
  assert.equal(byKey(views.musicCard(music.findMusic(TV)), `music:${TV}:here`), undefined, "no Play here too");
});

test("Leave group, the group's volume, Play in more rooms and Play here too send what the controller takes", async () => {
  home({ role: "member", groups: true });
  controller({ list: GROUPED });
  await music.loadMusic();
  let sent = controller({ list: GROUPED });
  const card = views.musicCard(music.findMusic(KITCHEN));
  byKey(card, `music:${LIVING}:leave`).listeners.click({});
  await settle();
  assert.deepEqual(lines(sent), [`DELETE /v1/music/${LIVING}/group`, "GET /v1/music"], "then every room is read again");
  sent = controller({ list: GROUPED });
  await music.setGroupVolume(music.findMusic(KITCHEN), 40);
  assert.deepEqual(sent.map((entry) => [entry.line, entry.body]), [[`PATCH /v1/music/${KITCHEN}/group`, { volume: 40 }], ["GET /v1/music", null]]);
  // On the playing group: the other rooms, each joins it with a tap.
  const more = byKey(card, `music:${KITCHEN}:more`);
  assert.ok(more, "Play in more rooms");
  assert.ok(more.textContent.startsWith("Play in more rooms"));
  assert.deepEqual(
    all(more).filter((element) => element.tagName === "BUTTON").map((button) => button.dataset.key),
    [`music:${KITCHEN}:more:${BEDROOM}`, `music:${KITCHEN}:more:${TV}`]
  );
  sent = controller({ list: GROUPED });
  byKey(more, `music:${KITCHEN}:more:${TV}`).listeners.click({});
  await settle();
  assert.deepEqual(sent.map((entry) => [entry.line, entry.body]), [[`POST /v1/music/${TV}/group`, { with: KITCHEN }], ["GET /v1/music", null]]);
  // A room that plays nothing: what plays elsewhere, each with a tap plays here too.
  const here = byKey(views.musicCard(music.findMusic(TV)), `music:${TV}:here`);
  assert.ok(here.textContent.startsWith("Play here too"), here.textContent);
  assert.ok(here.textContent.includes("Kitchen + Living Room"));
  sent = controller({ list: GROUPED });
  byKey(here, `music:${TV}:here:${BEDROOM}`).listeners.click({});
  await settle();
  assert.deepEqual(sent.map((entry) => [entry.line, entry.body]), [[`POST /v1/music/${TV}/group`, { with: BEDROOM }], ["GET /v1/music", null]]);
  // Refused: said on the room's card, nothing else changes.
  controller({ list: GROUPED, fail: { status: 403, code: "FORBIDDEN" } });
  assert.equal(await music.leaveGroup(music.findMusic(LIVING)), false);
  assert.ok(state.errors[`music:${LIVING}`]);
});

test("viewers see the group and each room's volume, and nothing to press", async () => {
  home({ role: "viewer", groups: true });
  controller({ list: GROUPED });
  await music.loadMusic();
  const card = views.musicCard(music.findMusic(LIVING));
  assert.ok(card.textContent.includes("Kitchen + Living Room"));
  assert.ok(card.textContent.includes("Volume 25%"), "the group's");
  assert.ok(card.textContent.includes("Volume 20%"), "Living Room's own");
  assert.equal(all(card).filter((element) => element.tagName === "BUTTON" || element.tagName === "INPUT").length - all(byClass(card, "music-favorites")[0]).filter((element) => element.tagName === "BUTTON").length, 0);
  const sent = controller();
  assert.equal(await music.joinGroup(music.findMusic(TV), music.findMusic(KITCHEN)), false);
  assert.equal(await music.setGroupVolume(music.findMusic(KITCHEN), 5), false);
  assert.deepEqual(lines(sent), []);
});

test("the groups in Hebrew", async () => {
  home({ role: "member", groups: true });
  controller({ list: GROUPED });
  await music.loadMusic();
  await setLanguage("he");
  try {
    const card = views.musicCard(music.findMusic(KITCHEN));
    assert.ok(card.textContent.includes("עוצמת הקבוצה"));
    assert.ok(card.textContent.includes("יציאה מהקבוצה"));
    assert.ok(byKey(card, `music:${KITCHEN}:more`).textContent.startsWith("השמעה בחדרים נוספים"));
    assert.ok(byKey(views.musicCard(music.findMusic(TV)), `music:${TV}:here`).textContent.startsWith("השמעה גם כאן"));
  } finally {
    await setLanguage("en");
  }
});

test("a room grouped with rooms elsewhere is read with all of them, so its card shows each room as it is", async (t) => {
  home({ groups: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = controller({ list: GROUPED });
  const reads = () => lines(sent).filter((line) => line.startsWith("GET /v1/music"));
  await music.startMusic({ name: "room", id: 10 });
  t.mock.timers.tick(0);
  await settle();
  assert.equal(reads().at(-1), "GET /v1/music", "the kitchen plays with the living room");
  // The TV Room's screen (no room: its own), on its own.
  music.musicRouteChanged({ name: "room", id: 12 });
  t.mock.timers.tick(0);
  await settle();
  assert.equal(reads().at(-1), "GET /v1/music?room_id=12");
  music.musicRouteChanged({ name: "scenes" });
});
