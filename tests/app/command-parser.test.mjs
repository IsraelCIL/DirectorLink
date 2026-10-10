// Say or type a command (1.9.0, ADR-063): app/js/command-parser.js, the words alone. A made-up home
// with English and Hebrew names; sentences in both languages, numbers in digits and words, Hebrew
// with and without its prefixes, plural and singular, typos, names in any order, two close
// matches (a question, never a guess), unknown names and words, and what it refuses.
//   node --test tests/app/

import assert from "node:assert/strict";
import test from "node:test";

import { fold, parseCommand } from "../../app/js/command-parser.js";
import { ES, IT } from "./command-homes.mjs";

const ROOMS = [
  { id: 1, names: ["Kitchen", "מטבח"] },
  { id: 2, names: ["Living room", "סלון"] },
  { id: 3, names: ["Kids room", "חדר ילדים"] },
  { id: 4, names: ["Porch", "מרפסת"] },
  { id: 5, names: ["Bedroom", "חדר שינה"] },
  { id: 6, names: ["Bedroom 2"] },
  { id: 7, names: ["Sara"] },
  { id: 8, names: ["Sarah"] },
  { id: 9, names: ["חדר של שני"] },
  { id: 10, names: ["Garden", "גינה"] },
  { id: 11, names: ["Parents", "חדר הורים"] },
];

const light = (id, name, room, fields = {}) => ({ kind: "light", id, name, room, dimmable: true, on: false, ...fields });
const thermostat = (id, name, room, fields = {}) => ({ kind: "thermostat", id, name, room, modes: ["off", "cool", "heat", "auto"], mode: "cool", dual: false, min: 16, max: 30, ...fields });
const DEVICES = [
  light(100, "Kitchen Island", 1, { on: true }),
  light(101, "Spots", 1, { on: true }),
  light(102, "Ceiling", 2),
  light(103, "Floor lamp", 2, { dimmable: false }),
  light(104, "Heater", 2, { dimmable: false }),
  light(105, "Spots", 2),
  light(106, "Porch light", 4, { dimmable: false }),
  light(107, "Light", 5),
  light(108, "Lamp", 5),
  light(109, "Bedside", 6),
  light(110, "Ceiling", 7),
  light(111, "Ceiling", 8),
  light(112, "מנורה", 9),
  light(113, "דוד שמש", 9, { dimmable: false }),
  light(114, "Reading", 11),
  light(115, "מנורת שולחן", 11),
  thermostat(200, "Living room AC", 2),
  thermostat(201, "מזגן", 3, { mode: "off", modes: ["off", "cool", "heat"] }),
  thermostat(202, "Bedroom AC", 5, { mode: "auto", dual: true }),
  thermostat(203, "Parents AC", 11, { mode: "off", dual: true }),
  { kind: "blind", id: 300, name: "Kitchen blind", room: 1, position: true },
  { kind: "blind", id: 301, name: "Window", room: 2, position: false },
  { kind: "blind", id: 302, name: "Shutter", room: 5, position: true },
  { kind: "fan", id: 400, name: "Ceiling fan", room: 3, on: false },
  { kind: "music", id: "RINCON_1", name: "Kitchen", room: 1 },
  { kind: "music", id: "RINCON_2", name: "Living Room", room: 2 },
  { kind: "relay", id: 500, name: "Main gate", room: 4, canOpen: true },
  { kind: "relay", id: 501, name: "Garden gate", room: 10, canOpen: true },
];
const SCENES = [
  { id: "aa000001", name: "Good night" },
  { id: "aa000002", name: "לילה טוב" },
  { id: "aa000003", name: "Movie time" },
];
const HOME = { rooms: ROOMS, devices: DEVICES, scenes: SCENES };

const parse = (text, catalog = HOME) => parseCommand(text, catalog);

// The action it would take, or a failure that says what came back.
function act(text, catalog = HOME) {
  const result = parse(text, catalog);
  assert.equal(result.status, "ok", `${text}: ${JSON.stringify(result)}`);
  return result.action;
}

function same(text, expected, catalog = HOME) {
  const action = act(text, catalog);
  for (const [field, value] of Object.entries(expected)) {
    const got = field === "ids" ? [...action.ids].sort() : action[field];
    assert.deepEqual(got, field === "ids" ? [...value].sort() : value, `${text}: ${field} ${JSON.stringify(action)}`);
  }
}

function problem(text, code, catalog = HOME) {
  const result = parse(text, catalog);
  assert.equal(result.status, "problem", `${text}: ${JSON.stringify(result)}`);
  assert.equal(result.problem, code, `${text}: ${JSON.stringify(result)}`);
  return result;
}

function asks(text, catalog = HOME) {
  const result = parse(text, catalog);
  assert.equal(result.status, "ask", `${text}: ${JSON.stringify(result)}`);
  return result;
}

function unknown(text, words, catalog = HOME) {
  const result = parse(text, catalog);
  assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
  if (words) assert.deepEqual(result.words, words, text);
}

// ---- lights ------------------------------------------------------------------------------------

test("a room's lights off, in any case and word order", () => {
  for (const text of ["kitchen lights off", "Kitchen Lights OFF", "turn off the kitchen lights", "turn off the lights in the kitchen", "lights off in the kitchen", "switch the kitchen lights off"]) {
    same(text, { type: "lights", room: 1, device: null, ids: [100, 101], change: { on: false } });
  }
});

test("a room's lights to a level: digits, a percent sign or word, number words", () => {
  for (const text of ["living room lights 30%", "living room lights 30 percent", "set the living room lights to 30", "living room lights thirty percent", "dim the living room lights to 30"]) {
    // The ceiling and the spots; not the floor lamp (no dimmer) nor the heater.
    same(text, { type: "lights", room: 2, ids: [102, 105], change: { brightness: 30 } });
  }
  same("living room lights twenty-five percent", { change: { brightness: 25 } });
  same("living room lights to one hundred percent", { change: { brightness: 100 } });
  same("kitchen lights to half", { change: { brightness: 50 } });
  // A word from one to nine is a number only with its unit; digits always are.
  same("kitchen lights five percent", { change: { brightness: 5 } });
  same("kitchen lights 5", { change: { brightness: 5 } });
  same("אורות במטבח חמישה אחוזים", { change: { brightness: 5 } });
  unknown("turn on one of the kitchen lights", ["one"]);
  unknown("תדליק שתי מנורות במטבח", ["שתי"]);
  same("kitchen lights 0%", { ids: [100, 101], change: { on: false } });
  problem("kitchen lights 150%", "range");
  problem("dim the kitchen lights", "needLevel");
  problem("kitchen lights", "needWhat");
});

test("a light by its name, with or without its room", () => {
  same("turn on the porch light", { type: "lights", room: null, device: { kind: "light", id: 106 }, ids: [106], change: { on: true } });
  same("turn the porch light on", { device: { kind: "light", id: 106 }, change: { on: true } });
  same("porch light off", { device: { kind: "light", id: 106 }, change: { on: false } });
  // "on" before a name is a preposition.
  same("turn off the light on the porch", { device: { kind: "light", id: 106 }, change: { on: false } });
  problem("porch light 30%", "cannotDim");
  same("turn on the island in the kitchen", { device: { kind: "light", id: 100 }, change: { on: true } });
});

test("heaters wired as lights are left as they are unless named: on, off, a level (1.10.0: off too)", () => {
  same("living room lights on", { room: 2, ids: [102, 103, 105], change: { on: true }, kept: [104] });
  same("turn on the heater", { device: { kind: "light", id: 104 }, change: { on: true } });
  assert.equal(act("turn on the heater").kept, undefined, "named: nothing left out");
  // Since 1.10.0 off leaves them too (ADR-066): a room's "lights off" turned off a heater kept by
  // Composer programming.
  same("living room lights off", { ids: [102, 103, 105], change: { on: false }, kept: [104] });
  same("turn off the heater", { device: { kind: "light", id: 104 }, change: { on: false } });
  same("living room lights 0%", { ids: [102, 103, 105], change: { on: false }, kept: [104] });
  same("הדליקו את האור בחדר של שני", { room: 9, ids: [112], change: { on: true }, kept: [113] });
  same("כבו את האור בחדר של שני", { room: 9, ids: [112], change: { on: false }, kept: [113] });
  same("kitchen lights off", { ids: [100, 101], change: { on: false } });
  assert.equal(act("kitchen lights off").kept, undefined, "no heater there");
});

test("a light named only by its kind is that light in its room; the plural is the room's lights", () => {
  same("bedroom light on", { device: { kind: "light", id: 107 }, ids: [107] });
  same("turn on the lamp in the bedroom", { device: { kind: "light", id: 108 }, ids: [108] });
  same("bedroom lights on", { room: 5, ids: [107, 108] });
});

test("the whole home: Turn off all for lights, AC and blinds, nothing else at once", () => {
  for (const text of ["turn off everything", "everything off", "all off", "turn everything off", "כבה הכל", "כבו הכול", "תכבו את כל הבית"]) {
    same(text, { type: "offAll", filters: ["lights", "climate"] });
  }
  same("turn off all the lights", { type: "offAll", filters: ["lights"] });
  same("lights off", { type: "offAll", filters: ["lights"] });
  same("כבו את כל האורות", { type: "offAll", filters: ["lights"] });
  same("turn off all the AC", { type: "offAll", filters: ["climate"] });
  same("close all blinds", { type: "offAll", filters: ["blinds"] });
  problem("lights on", "needRoom");
  problem("turn on all the lights", "needRoom");
  problem("open all the blinds", "needRoom");
  problem("turn off", "needRoom");
});

test("a room's All off", () => {
  same("kitchen off", { type: "roomOff", room: 1 });
  same("turn off everything in the living room", { type: "roomOff", room: 2 });
  same("כבו הכל בסלון", { type: "roomOff", room: 2 });
  problem("turn on the kitchen", "needWhat");
});

// ---- climate -----------------------------------------------------------------------------------

test("AC to a temperature, off, a mode", () => {
  same("living room AC to 23", { type: "climate", ids: [200], change: { temperature: 23 } });
  same("set the living room AC to 23.5 degrees", { ids: [200], change: { temperature: 23.5 } });
  same("living room AC twenty three", { change: { temperature: 23 } });
  same("living room AC 23 and a half", { change: { temperature: 23.5 } });
  same("living room temperature 22", { change: { temperature: 22 } });
  same("set the A/C in the living room to 22", { ids: [200], change: { temperature: 22 } });
  same("turn off the air conditioning in the living room", { ids: [200], change: { mode: "off" } });
  same("set the AC in the living room to twenty-two and a half", { change: { temperature: 22.5 } });
  same("הפעל מזגן בסלון על 24", { ids: [200], change: { temperature: 24 } });
  same("כבו את כל המזגנים", { type: "offAll", filters: ["climate"] });
  // 1.10.0: "חם יותר" with the AC said is a degree warmer (relative changes, below).
  same("מזגן בסלון חם יותר", { ids: [200], change: { temperatureBy: 1 } });
  same("AC off in the kids' room", { type: "climate", ids: [201], change: { mode: "off" } });
  same("turn off the heating in the kids room", { ids: [201], change: { mode: "off" } });
  same("cool the kids room to 22", { ids: [201], change: { mode: "cool", temperature: 22 } });
  same("living room heat 21", { ids: [200], change: { mode: "heat", temperature: 21 } });
  same("living room AC auto", { ids: [200], change: { mode: "auto" } });
  // A thermostat's own range; the unit is degrees, never percent.
  const range = problem("living room ac 40", "range");
  assert.deepEqual([range.min, range.max], [16, 30]);
  unknown("living room AC 23%");
});

test("an AC that is off asks which mode; one with two setpoints in auto, which setpoint", () => {
  const mode = asks("AC on in the kids room");
  assert.equal(mode.question, "mode");
  assert.deepEqual(mode.options.map((option) => option.change), [{ mode: "cool" }, { mode: "heat" }]);
  const withTemperature = asks("kids room AC to 24");
  assert.deepEqual(withTemperature.options.map((option) => option.change), [{ mode: "cool", temperature: 24 }, { mode: "heat", temperature: 24 }]);
  const setpoint = asks("bedroom AC to 22");
  assert.equal(setpoint.question, "setpoint");
  assert.deepEqual(setpoint.options.map((option) => option.change), [{ setpoint: "cool", temperature: 22 }, { setpoint: "heat", temperature: 22 }]);
  problem("living room AC on", "alreadyOn");
  problem("kids room AC auto", "noMode");
  problem("turn on the AC", "needRoom");
});

// 1.10.0 (ADR-070): the controller says each thermostat's last mode (`last` in the catalog).
const withLast = (last) => ({ ...HOME, devices: HOME.devices.map((device) => (device.id in last ? { ...device, last: last[device.id] } : device)) });

test("an AC that is off turns on as it was when its last mode is known: no question", () => {
  const known = withLast({ 201: "heat", 203: "auto" });
  same("AC on in the kids room", { type: "climate", ids: [201], change: { asItWas: true } }, known);
  same("turn on the AC in the kids room", { ids: [201], change: { asItWas: true } }, known);
  same("הדלק את המזגן בחדר ילדים", { ids: [201], change: { asItWas: true } }, known);
  same("תדליקו את המזגן בחדר הילדים", { ids: [201], change: { asItWas: true } }, known);
  same("kids room AC to 24", { ids: [201], change: { asItWas: true, temperature: 24 } }, known);
  // A mode said is that mode; off is off.
  same("kids room AC cool", { ids: [201], change: { mode: "cool" } }, known);
  same("AC off in the kids' room", { ids: [201], change: { mode: "off" } }, known);
  // Heat and cool setpoints, last in auto: on as it was; with a temperature, which one is asked.
  same("turn on the parents AC", { ids: [203], change: { asItWas: true } }, known);
  assert.equal(asks("parents AC to 22", known).question, "mode");
  same("parents AC to 22", { ids: [203], change: { asItWas: true, temperature: 22 } }, withLast({ 203: "cool" }));
  problem("living room AC on", "alreadyOn", known);
  // Not known: asked, as before.
  assert.equal(asks("AC on in the kids room").question, "mode");
  assert.equal(asks("הדלק את המזגן בחדר ילדים").question, "mode");
});

// ---- blinds and fans ---------------------------------------------------------------------------

test("blinds open, close, to a position, stop", () => {
  same("open the kitchen blinds", { type: "blinds", room: 1, ids: [300], change: { position: 100 } });
  same("close the shades in the kitchen", { ids: [300], change: { position: 0 } });
  same("kitchen blinds 40%", { ids: [300], change: { position: 40 } });
  same("open the kitchen blinds halfway", { ids: [300], change: { position: 50 } });
  same("lower the kitchen blinds", { ids: [300], change: { position: 0 } });
  same("stop the blinds in the kitchen", { ids: [300], change: { stop: true } });
  same("open the window", { device: { kind: "blind", id: 301 }, change: { position: 100 } });
  // Open and close alone in a room are its blinds.
  same("open the kitchen", { type: "blinds", ids: [300], change: { position: 100 } });
  // The living room's window only opens and closes fully.
  problem("living room blinds 50%", "noPosition");
  problem("blinds open in the kids room", "none");
});

test("fans on and off", () => {
  same("kids room fan on", { type: "fans", ids: [400], change: { on: true } });
  same("turn off the ceiling fan", { device: { kind: "fan", id: 400 }, change: { on: false } });
});

// ---- scenes, music, doors ----------------------------------------------------------------------

test("a scene by its name, with or without a verb", () => {
  for (const text of ["run Good night", "good night", "Good Night!", "activate good night", "start the good night scene"]) same(text, { type: "scene", id: "aa000001" });
  same("start movie time", { type: "scene", id: "aa000003" });
  same("הפעל לילה טוב", { type: "scene", id: "aa000002" });
  same("הפעילו את הסצנה לילה טוב", { type: "scene", id: "aa000002" });
  // A scene the user may not run is not in their catalog.
  unknown("run party", ["party"]);
});

test("a scene whose name is a command is the scene", () => {
  const home = { ...HOME, scenes: [...SCENES, { id: "aa000009", name: "All off" }] };
  same("all off", { type: "scene", id: "aa000009" }, home);
  same("turn off everything", { type: "offAll" }, home);
});

test("music play, pause, next and volume in a room", () => {
  same("play music in the kitchen", { type: "music", ids: ["RINCON_1"], change: { action: "play" } });
  same("pause the music in the living room", { ids: ["RINCON_2"], change: { action: "pause" } });
  same("stop the music in the living room", { ids: ["RINCON_2"], change: { action: "pause" } });
  same("next song in the kitchen", { ids: ["RINCON_1"], change: { action: "next" } });
  same("kitchen volume 30", { ids: ["RINCON_1"], change: { volume: 30 } });
  same("volume 30 in the kitchen", { ids: ["RINCON_1"], change: { volume: 30 } });
  problem("play music in the porch", "none");
  problem("kitchen volume", "needLevel");
  const where = asks("play music");
  assert.deepEqual(where.options.map((option) => option.ids[0]), ["RINCON_1", "RINCON_2"]);
});

test("doors and gates: only open, only where the user may, one at a time", () => {
  same("open the main gate", { type: "door", device: { kind: "relay", id: 500 } });
  same("open the gate on the porch", { type: "door", device: { kind: "relay", id: 500 } });
  same("פתחו את השער במרפסת", { type: "door", device: { kind: "relay", id: 500 } });
  const which = asks("open the gate");
  assert.deepEqual(which.options.map((option) => option.device.id), [500, 501]);
  unknown("close the main gate");
  unknown("main gate on");
  const noDoors = { ...HOME, devices: DEVICES.map((device) => (device.kind === "relay" ? { ...device, canOpen: false } : device)) };
  problem("open the main gate", "noDoors", noDoors);
  problem("open the gate", "noDoors", noDoors);
});

// ---- Hebrew ------------------------------------------------------------------------------------

test("Hebrew: prefixes, plural and singular, imperatives for one or many", () => {
  // (1.10.0: "האורות במטבח כבויים" says how they are: a question.)
  for (const text of ["כבה את האורות במטבח", "כבו את האור במטבח", "תכבה אורות במטבח", "כיבוי אורות מטבח"]) {
    same(text, { type: "lights", room: 1, ids: [100, 101], change: { on: false } });
  }
  same("אור בסלון 40%", { room: 2, ids: [102, 105], change: { brightness: 40 } });
  same("תדליקו את האורות בסלון", { room: 2, change: { on: true } });
  same("אורות בסלון ל-30 אחוז", { change: { brightness: 30 } });
  same("מזגן בסלון 23", { type: "climate", ids: [200], change: { temperature: 23 } });
  same("מזגן בסלון לעשרים ושלוש", { change: { temperature: 23 } });
  same("מזגן בסלון עשרים ושלוש וחצי מעלות", { change: { temperature: 23.5 } });
  same("כבה מזגן בחדר הילדים", { ids: [201], change: { mode: "off" } });
  same("מזגן בחדר ילדים על קירור 22", { ids: [201], change: { mode: "cool", temperature: 22 } });
  same("פתח את התריסים במטבח", { type: "blinds", ids: [300], change: { position: 100 } });
  same("סגרו את התריס במטבח", { ids: [300], change: { position: 0 } });
  same("תריס במטבח חצי", { ids: [300], change: { position: 50 } });
  same("נגן מוזיקה במטבח", { type: "music", ids: ["RINCON_1"], change: { action: "play" } });
  same("עצרו את המוזיקה בסלון", { ids: ["RINCON_2"], change: { action: "pause" } });
  same("ווליום 30 במטבח", { ids: ["RINCON_1"], change: { volume: 30 } });
  same("השיר הבא במטבח", { ids: ["RINCON_1"], change: { action: "next" } });
  // Niqqud and the maqaf.
  same("כַּבֵּה אֶת הָאוֹר בַּמִּטְבָּח", { room: 1, change: { on: false } });
  same("אור בסלון ל־40", { room: 2, change: { brightness: 40 } });
});

test("Hebrew: a word that is also a number stays a word in a name", () => {
  // The room's דוד שמש is a heater, left as it is (1.10.0).
  same("כבו את האור בחדר של שני", { room: 9, ids: [112], change: { on: false } });
});

test("English names in a Hebrew sentence, and the other way", () => {
  same("כבה את האורות ב-Kitchen", { room: 1, change: { on: false } });
  same("living room AC off", { ids: [200], change: { mode: "off" } });
  same("סלון AC off", { ids: [200], change: { mode: "off" } });
});

// ---- forgiving, never guessing -------------------------------------------------------------------

test("small typos in names and command words", () => {
  same("kitchn lights off", { room: 1, change: { on: false } });
  same("ligths off in the kitchen", { room: 1, change: { on: false } });
  same("turn on the porch ligth", { device: { kind: "light", id: 106 } });
  same("livng room lights on", { room: 2 });
  // A typo in a word under six letters, with nothing else of the name said right, is asked.
  const short = asks("כבה את האורות במטבך");
  assert.equal(short.question, "partial");
  assert.deepEqual(short.options.map((option) => [option.room, option.change]), [[1, { on: false }]]);
});

test("a name one letter from another is asked, not done: Dana for Dina, בנים for בנות", () => {
  const girls = { rooms: [{ id: 7, names: ["חדר בנות"] }, { id: 3, names: ["Dina"] }], devices: [light(1, "תאורה", 7, { on: true }), light(3, "Ceiling", 3, { on: true })], scenes: [] };
  for (const text of ["תכבה את האור בחדר בנים", "תכבה את האור בבנים", "turn off the lights in Dana's room", "turn off dana"]) {
    const result = asks(text, girls);
    assert.equal(result.partial, true, text);
  }
  // Both rooms there: each is itself (the other plural is not the same name).
  const both = { ...girls, rooms: [...girls.rooms, { id: 6, names: ["חדר בנים"] }], devices: [...girls.devices, light(2, "תאורה", 6, { on: true })] };
  same("תכבה את האור בחדר בנים", { room: 6, ids: [2] }, both);
  same("תכבה את האור בחדר בנות", { room: 7, ids: [1] }, both);
  same("turn off dina", { type: "roomOff", room: 3 }, both);
});

test("two names that match as well ask which one", () => {
  const spots = asks("spots on");
  assert.equal(spots.question, "which");
  assert.deepEqual(spots.options.map((option) => option.device.id).sort(), [101, 105]);
  same("kitchen spots on", { device: { kind: "light", id: 101 } });
  // One letter from Sara and from Sarah: a question.
  const close = asks("sarh ceiling on");
  assert.deepEqual(close.options.map((option) => option.device.id).sort(), [110, 111]);
  // Said exactly, Sara is Sara.
  same("sara ceiling on", { device: { kind: "light", id: 110 } });
  // Bedroom is the bedroom, not Bedroom 2; Bedroom 2 is said with its number.
  same("bedroom lights off", { room: 5 });
  same("bedroom 2 lights off", { room: 6, ids: [109] });
  same("bedroom two lights off", { room: 6 });
});

test("part of a name is asked, never done", () => {
  const island = asks("island on");
  assert.equal(island.partial, true);
  assert.deepEqual(island.options.map((option) => option.device.id), [100]);
  // Part of a name and a typo too: not understood.
  unknown("islnd on", ["islnd"]);
});

test("words it does not know, names that are not there, two things at once", () => {
  unknown("frobnicate the kitchen", ["frobnicate"]);
  unknown("make me a sandwich", ["sandwich"]);
  unknown("garage lights off", ["garage"]);
  unknown("תעשה לי קפה", ["קפה"]);
  unknown("", []);
  unknown("   ", []);
  unknown("kitchen lights on and off");
  problem("turn off the lights in the kitchen and the living room", "oneAtATime");
  // 1.10.0: two parts, the second ("blinds off") not understood: nothing is done.
  const blinds = parse("kitchen lights and blinds off");
  assert.deepEqual([blinds.status, blinds.part], ["unknown", "blinds off"]);
});

test("a viewer's catalog has nothing to control", () => {
  const viewer = { rooms: ROOMS, devices: [], scenes: [] };
  problem("kitchen lights off", "none", viewer);
  unknown("run party", ["party"], viewer);
});

test("every sentence in the app's README is understood", async () => {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(new URL("../../app/README.md", import.meta.url), "utf-8");
  const section = readme.slice(readme.indexOf("## Say or type a command"), readme.indexOf("## Turn off all"));
  const rows = section.split("\n").filter((line) => line.startsWith("| *"));
  // The columns: English and Hebrew, Spanish (1.10.0, ADR-068), Italian; each in its language and
  // its home.
  for (const [column, language, catalog] of [[1, "en", HOME], [2, "es", ES], [3, "it", IT]]) {
    const sentences = rows.flatMap((row) => [...row.split("|")[column].matchAll(/\*([^*]+)\*/g)].map((match) => match[1]));
    assert.ok(sentences.length >= 25, `${language}: ${sentences.length} sentences`);
    for (const sentence of sentences) {
      const result = parseCommand(sentence, catalog, { language });
      // "פתחו את השער" asks which: this home has two gates.
      assert.ok(result.status === "ok" || result.status === "ask", `${language}: ${sentence}: ${JSON.stringify(result)}`);
    }
  }
});

test("a name's own letters: a word said is not another name with its first letters taken off", () => {
  // "בני" (Beni) is not "שני", "מרים" (Miriam) not "הורים", "חן" not "שולחן".
  unknown("הדלק את האור בחדר של בני", ["בני"]);
  unknown("כבה את האור בחדר של מרים", ["מרים"]);
  unknown("כבה את חן", ["חן"]);
  // A name's article may be left out, and a word said keeps its prefixes off.
  same("כבה את האור בחדר ההורים", { room: 11, change: { on: false } });
  same("כבו את מנורת השולחן", { device: { kind: "light", id: 115 }, change: { on: false } });
  // Two prefixes at most, and a command word of three letters or more under them: "בבוקר" is not
  // "קר" (cool).
  unknown("תפעיל את המזגן בסלון בבוקר");
  unknown("כבה את המזגן בסלון בבוקר");
});

test("not a command: don't, a question, a time, a typo of two letters in a command word", () => {
  unknown("אל תכבה את האור במטבח");
  unknown("אל תפתחו את השער במרפסת");
  unknown("don't turn off the kitchen lights");
  unknown("do not open the main gate");
  problem("is the porch light on", "question");
  problem("are the lights on in the kitchen", "question");
  problem("האם האור במטבח דולק", "question");
  unknown("turn on the kitchen lights at 7 pm");
  unknown("turn off the living room AC in 10 minutes");
  unknown("כבה את האור במטבח בעוד 10 דקות");
  same("deactivate the kitchen lights", { room: 1, change: { on: false } });
  unknown("deactivate good night");
  unknown("inactivate the kitchen lights");
});

test("a question mark makes it a question, even without a question word", () => {
  // Hebrew asks yes or no with the words of a command; dictation writes "?" for a rising voice.
  for (const text of ["האור במטבח כבוי?", "האורות במטבח דולקים?", "התריסים במטבח פתוחים?", "kitchen lights off?", "good night?", "open the main gate?", "המזגן בסלון על 23?", "האור במטבח כבוי؟", "kitchen lights off？"]) {
    problem(text, "question");
  }
  same("good night!", { type: "scene", id: "aa000001" });
});

test("a time or a change by an amount is never a level, a position, a volume or a temperature", () => {
  for (const text of [
    "turn on the kitchen lights at 7",
    "turn on the kitchen lights in 5",
    "open the kitchen blinds at 7",
    "kitchen volume for 5",
    "set the living room AC at 23",
    "תדליק את האור במטבח ב-7",
    "תדליק את האור במטבח ב7",
    "תדליק את האור במטבח ב 7",
    "תדליק את האור במטבח בשבע",
    "תדליק את האור במטבח בעשר",
    "תפתח את התריסים במטבח ב-7",
    "תדליק את האור במטבח עד 7",
    "תדליק את האור במטבח מ-7",
    "תוריד את האור במטבח ב-20%",
    "תוריד את האור במטבח ב-20 אחוז",
    "תדליק את האור במטבח ב-20%",
    "kitchen lights 20% less",
    "kitchen lights by 20%",
    "kitchen lights more",
    "תעלה את התריס במטבח ב-20%",
    "תוריד את המזגן בסלון ב-7",
    "make the kitchen lights brighter at 7",
    "תגביר את האור במטבח ב-7",
    "תדליק את האור במטבח בעוד 10 דקות",
    "תדליק את האור במטבח בעוד 10",
    "turn on the kitchen lights after 7",
  ]) {
    const result = parse(text);
    assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
    assert.equal(result.refusal, "time", `${text}: ${JSON.stringify(result)}`);
  }
  // A level says so: a percent, a unit, "to", ל, על, or the number alone after the name.
  same("kitchen lights 30", { change: { brightness: 30 } });
  same("kitchen lights to 30", { change: { brightness: 30 } });
  same("turn on the kitchen lights at 50%", { change: { brightness: 50 } });
  same("set the living room AC at 23 degrees", { change: { temperature: 23 } });
  same("אורות במטבח ל-30", { change: { brightness: 30 } });
  same("אורות במטבח על 30 אחוז", { change: { brightness: 30 } });
  same("תפתח את התריס במטבח עד חצי", { type: "blinds", change: { position: 50 } });
  same("תפתח את התריס במטבח עד 40%", { type: "blinds", change: { position: 40 } });
  // A number in a name is the name's ("Bedroom 2"), and a number word in a name stays a word.
  same("turn off the lights in bedroom 2", { room: 6 });
  same("תכבה את האור בשני", { room: 9, ids: [112] });
});

test("hot and cold are how the user feels, not a mode; with the AC said after על, to or on, they are", () => {
  for (const text of ["חם לי בסלון", "חם לי בחדר שינה", "קר לי בסלון", "it's cold in the bedroom", "cold in the bedroom", "warm in the living room", "I'm hot in the living room", "קר לי, תדליק את המזגן בסלון על חם", "it's freezing in the bedroom, turn on the AC"]) {
    const result = parse(text);
    assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
    assert.equal(result.refusal, "feel", `${text}: ${JSON.stringify(result)}`);
  }
  same("תדליק את המזגן בסלון על קר", { type: "climate", ids: [200], change: { mode: "cool" } });
  same("מזגן בסלון על חם 24", { ids: [200], change: { mode: "heat", temperature: 24 } });
  same("set the living room AC to warm", { ids: [200], change: { mode: "heat" } });
  same("turn the living room AC on cold", { ids: [200], change: { mode: "cool" } });
  // Not without the AC said (by a word or by its name).
  unknown("set the kids room to cold");
  same("set the living room AC to cold", { ids: [200], change: { mode: "cool" } });
  // The modes' own words stay modes anywhere.
  same("cool the kids room to 22", { ids: [201], change: { mode: "cool", temperature: 22 } });
  same("מזגן בחדר ילדים קירור", { ids: [201], change: { mode: "cool" } });
});

test("heaters by their usual names stay off when a room's lights go on; lights that only sound warm do not", () => {
  const heaters = ["Heater", "Water heater", "Boiler", "Heat lamp", "Hot water", "Floor heat", "Floor heating", "Underfloor", "Immersion", "Geyser", "Towel rail", "Towel warmer", "Towels", "Radiator", "Infrared", "Heated floor", "Hot tub", "Sauna", "דוד", "דוד הורים", "בוילר", "מקרן חום", "מים חמים", "חימום רצפה", "החימום", "תנור", "מפזר חום", "מחמם מגבות", "מחממת", "רדיאטור", "קומקום", "דוד שמש", "הסקה", "חימום תת רצפתי", "תנור אינפרא", "דודים"];
  for (const name of heaters) {
    const bathroom = { rooms: [{ id: 1, names: ["Bathroom", "מקלחת"] }], scenes: [], devices: [light(1, "Mirror", 1), light(2, name, 1, { dimmable: false })] };
    same("turn on the bathroom lights", { ids: [1] }, bathroom);
    same("תדליקו את האורות במקלחת", { ids: [1] }, bathroom);
  }
  for (const name of ["Warm white", "אור חם", "תאורת חומה", "Hotel sign", "Water feature", "מים"]) {
    const bathroom = { rooms: [{ id: 1, names: ["Bathroom"] }], scenes: [], devices: [light(1, "Mirror", 1), light(2, name, 1, { dimmable: false })] };
    same("turn on the bathroom lights", { ids: [1, 2] }, bathroom);
  }
});

test("the only light a user has, when it is a heater, is not 'the light' (1.10.0: nor to turn off)", () => {
  const kids = { rooms: [{ id: 5, names: ["חדר ילדים"] }], scenes: [], devices: [light(1, "דוד ילדים", 5, { dimmable: false })] };
  problem("תדליק את האור", "heatersOnly", kids);
  problem("turn on the light", "heatersOnly", kids);
  same("תדליק את דוד ילדים", { device: { kind: "light", id: 1 }, change: { on: true } }, kids);
  problem("תכבה את האור", "heatersOnly", kids);
  problem("תכבו את האורות בחדר ילדים", "heatersOnly", kids);
  same("תכבה את דוד ילדים", { device: { kind: "light", id: 1 }, change: { on: false } }, kids);
  // With another light: that light is "the light".
  const two = { ...kids, devices: [...kids.devices, light(2, "תאורה", 5)] };
  same("תדליק את האור", { ids: [2], device: { kind: "light", id: 2 }, change: { on: true } }, two);
});

test("Hebrew: spellings with one vowel letter more or less, and the app's own words", () => {
  const home = {
    rooms: [{ id: 1, names: ["חניה"] }, { id: 2, names: ["חנייה אחורית"] }, { id: 3, names: ["גינה"] }, { id: 4, names: ["כניסה"] }, { id: 5, names: ["סלון"] }],
    devices: [light(1, "תאורה", 1), light(2, "תאורה", 2), light(3, "תאורה", 3), light(4, "תאורה", 4), light(5, "ספוטים", 5), { kind: "relay", id: 9, name: "שער חניה", room: 1, canOpen: true }],
    scenes: [{ id: "s1", name: "לילה טוב" }, { id: "s2", name: "שבת" }],
  };
  same("תדליק את האור בחנייה", { room: 1, ids: [1] }, home);
  same("תדליק את האור בחניה האחורית", { room: 2, ids: [2] }, home);
  same("תדליק את האור בכנסה", { room: 4, ids: [4] }, home);
  same("תפתח את שער החנייה", { type: "door", device: { kind: "relay", id: 9 } }, home);
  // From three letters only a typo: asked, never done (גנה, but also דנה for דינה).
  const garden = asks("תדליק את האור בגנה", home);
  assert.equal(garden.partial, true);
  assert.deepEqual(garden.options.map((option) => option.room), [3]);
  // Mode, מצב, סצנת, בכל, Celsius.
  same("set the living room AC to cool mode", { type: "climate", ids: [200], change: { mode: "cool" } });
  same("תעביר את המזגן בסלון למצב קירור", { ids: [200], change: { mode: "cool" } });
  same("מזגן בסלון במצב חימום", { ids: [200], change: { mode: "heat" } });
  same("תפעיל את סצנת לילה טוב", { type: "scene", id: "aa000002" });
  same("תפעיל את מצב שבת", { type: "scene", id: "s2" }, home);
  same("תכבה את האור בכל הבית", { type: "offAll", filters: ["lights"] });
  for (const text of ["מזגן בסלון 23°C", "living room AC 23 °C", "living room AC 23C", "מזגן בסלון 23º", "מזגן בסלון 23℃", "מזגן בסלון 23 מעלות צלזיוס", "living room AC 23 celsius"]) {
    same(text, { ids: [200], change: { temperature: 23 } });
  }
});

test("the AC of a room with floor heating: an AC word or a cool mode is its AC", () => {
  const home = {
    rooms: [{ id: 1, names: ["Living room", "סלון"] }, { id: 2, names: ["Bathroom", "מקלחת"] }],
    scenes: [],
    devices: [
      thermostat(30, "Split", 1, { modes: ["off", "heat", "cool", "auto"], mode: "cool" }),
      thermostat(32, "Floor heating", 1, { modes: ["off", "heat"], mode: "heat", min: 5, max: 32 }),
      thermostat(33, "Bathroom floor", 2, { modes: ["off", "heat"], mode: "heat", min: 5, max: 32 }),
    ],
  };
  same("cool the living room", { type: "climate", ids: [30], change: { mode: "cool" } }, home);
  same("מזגן בסלון על קירור", { ids: [30], change: { mode: "cool" } }, home);
  same("מזגן בסלון 23", { ids: [30], change: { temperature: 23 } }, home);
  same("living room AC cool 22", { ids: [30], change: { mode: "cool", temperature: 22 } }, home);
  same("turn off the AC in the living room", { ids: [30], change: { mode: "off" } }, home);
  // Not an AC word: every thermostat of the room.
  same("living room temperature 22", { ids: [30, 32], change: { temperature: 22 } }, home);
  same("heat the living room", { ids: [30, 32], change: { mode: "heat" } }, home);
  // No AC there.
  problem("מזגן במקלחת 23", "none", home);
  problem("cool the bathroom", "noMode", home);
});

test("don't and times are refusals the speech service's other guesses cannot override", () => {
  assert.equal(parse("אל תכבה את האור במטבח").refusal, "not");
  assert.equal(parse("don't turn off the kitchen lights").refusal, "not");
  assert.equal(parse("תדליק את האור במטבח מחר").refusal, "time");
  assert.equal(parse("frobnicate the kitchen").refusal, undefined);
  // In a name, such a word is the name's.
  const morning = { ...HOME, scenes: [...SCENES, { id: "aa000010", name: "Good morning" }] };
  same("run good morning", { type: "scene", id: "aa000010" }, morning);
});

test("a long text is not a command, and quickly", () => {
  const started = performance.now();
  unknown(`turn off the kitchen lights ${"x".repeat(400 * 1024)}`, []);
  unknown("turn off the kitchen lights ".repeat(8), []);
  assert.ok(performance.now() - started < 50, "at once");
  same(`turn off the kitchen lights${" ".repeat(150)}`, { room: 1 });
});

test("a minus sign is kept, and out of range", () => {
  problem("kitchen blinds -40%", "range");
  problem("living room ac -18", "range");
  same("מזגן בסלון ל-23", { change: { temperature: 23 } });
});

test("auto with a temperature on an AC with heat and cool setpoints asks which setpoint; one that is off, heat or cool", () => {
  const auto = asks("bedroom ac auto 22");
  assert.equal(auto.question, "setpoint");
  assert.deepEqual(auto.options.map((option) => option.change), [{ mode: "auto", setpoint: "cool", temperature: 22 }, { mode: "auto", setpoint: "heat", temperature: 22 }]);
  const off = asks("parents AC to 22");
  assert.deepEqual(off.options.map((option) => option.change), [{ mode: "cool", temperature: 22 }, { mode: "heat", temperature: 22 }]);
  const on = asks("parents AC on");
  assert.deepEqual(on.options.map((option) => option.change.mode), ["cool", "heat", "auto"], "without a temperature, every mode");
});

test("folding: case, accents, niqqud and Hebrew final letters", () => {
  assert.equal(fold("Café"), "cafe");
  assert.equal(fold("סָלוֹן"), "סלונ");
  assert.equal(fold("מטבך"), "מטבכ");
});

test("fast enough for a phone in a home with 111 lights", () => {
  const rooms = Array.from({ length: 40 }, (_value, index) => ({ id: index + 1, names: [`Room ${index + 1}`, `חדר ${index + 1}`] }));
  const devices = [
    ...Array.from({ length: 111 }, (_value, index) => light(1000 + index, `Light ${index} spot`, (index % 40) + 1)),
    ...Array.from({ length: 22 }, (_value, index) => thermostat(2000 + index, `AC ${index}`, (index % 40) + 1)),
    ...Array.from({ length: 15 }, (_value, index) => ({ kind: "blind", id: 3000 + index, name: `Shade ${index}`, room: (index % 40) + 1, position: true })),
  ];
  const big = { rooms, devices, scenes: Array.from({ length: 30 }, (_value, index) => ({ id: `s${index}`, name: `Scene number ${index}` })) };
  const started = performance.now();
  for (let round = 0; round < 20; round += 1) {
    parseCommand("turn off the lights in room 12", big);
    parseCommand("מזגן בחדר 7 לעשרים ושלוש", big);
    parseCommand("open the shades in room 3", big);
  }
  // A long name of words said many times does not slow it down.
  const long = { ...big, scenes: [...big.scenes, { id: "s98", name: "the night of the day of the week of the month of the year" }, { id: "s99", name: "the of the of the of the of the of the of" }] };
  parseCommand("run the night of the day of the week of the month of the year of the the the of of of", long);
  parseCommand(Array.from({ length: 28 }, (_value, index) => (index % 2 ? "of" : "the")).join(" "), long);
  const each = (performance.now() - started) / 62;
  assert.ok(each < 50, `${each.toFixed(1)} ms a command`);
  same("turn off the lights in room 12", { room: 12, change: { on: false } }, big);
});

// ---- 1.10.0 (ADR-066): two or three things at once, changes by a step, heaters ---------------------

// A home named the way an Israeli family names theirs (Hebrew rooms, KNX heaters wired as lights
// and kept by Composer programming, gates on relays), as the 1.9.0 review probed: made up.
const IL_ROOMS = [
  { id: 1, names: ["סלון"] },
  { id: 2, names: ["מטבח"] },
  { id: 3, names: ["חדר שינה"] },
  { id: 4, names: ["חדר הורים"] },
  { id: 5, names: ["חדר ילדים"] },
  { id: 9, names: ["חניה"] },
  { id: 10, names: ["כניסה"] },
  { id: 14, names: ["מקלחת הורים"] },
  { id: 15, names: ["חדר ורד"] },
];
const IL_DEVICES = [
  light(1000, "ספוטים", 1, { on: true }), light(1001, "נברשת", 1), light(1002, "תאורה ראשית", 1), light(1003, "פסי לד", 1, { dimmable: false }),
  light(1004, "אי תלוי", 2, { dimmable: false, on: true }), light(1005, "ספוטים", 2, { on: true }), light(1006, "תאורה מעל כיור", 2),
  light(1007, "מנורה", 3), light(1008, "ספוטים", 3),
  light(1009, "ספוטים", 4, { on: true }), light(1010, "דוד הורים", 4, { dimmable: false, on: true }), light(1011, "מנורת לילה", 4),
  light(1012, "תאורה", 5), light(1013, "דוד ילדים", 5, { dimmable: false }),
  light(1014, "תאורה", 14), light(1015, "חימום רצפה", 14, { dimmable: false, on: true }), light(1016, "מחמם מגבות", 14, { dimmable: false }),
  light(1017, "תאורת חניה", 9, { dimmable: false }), light(1018, "תאורה", 15),
  thermostat(2000, "מזגן סלון", 1, { mode: "cool", modes: ["off", "cool", "heat", "auto", "fan"] }), thermostat(2001, "מזגן", 3, { mode: "cool" }),
  thermostat(2002, "מזגן הורים", 4, { mode: "off" }), thermostat(2003, "VRF", 5, { mode: "auto", dual: true }),
  { kind: "blind", id: 3000, name: "תריס", room: 1, position: true }, { kind: "blind", id: 3001, name: "תריס מטבח", room: 2, position: true },
  { kind: "relay", id: 4000, name: "שער חניה", room: 9, canOpen: true }, { kind: "relay", id: 4001, name: "דלת כניסה", room: 10, canOpen: true },
  { kind: "music", id: "RINCON_A", name: "Living Room", room: 1 }, { kind: "music", id: "RINCON_B", name: "Kitchen", room: 2 },
];
const IL_SCENES = [{ id: "s1", name: "לילה טוב" }, { id: "s5", name: "סרט ומוזיקה" }];
const IL = { rooms: IL_ROOMS, devices: IL_DEVICES, scenes: IL_SCENES };

// Two or three actions, each checked like `same`.
function several(text, expected, catalog = HOME) {
  const result = parse(text, catalog);
  assert.equal(result.status, "ok", `${text}: ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.actions), `${text}: one action, not several: ${JSON.stringify(result)}`);
  assert.equal(result.actions.length, expected.length, `${text}: ${JSON.stringify(result.actions)}`);
  expected.forEach((fields, index) => {
    for (const [field, value] of Object.entries(fields)) {
      const got = field === "ids" ? [...result.actions[index][field]].sort() : result.actions[index][field];
      assert.deepEqual(got, field === "ids" ? [...value].sort() : value, `${text}, part ${index + 1}: ${field} ${JSON.stringify(result.actions[index])}`);
    }
  });
  return result;
}

// Not done: which part, and why.
function part(text, words, status, catalog = HOME) {
  const result = parse(text, catalog);
  assert.equal(result.status, status, `${text}: ${JSON.stringify(result)}`);
  assert.equal(result.part, words, `${text}: ${JSON.stringify(result)}`);
  return result;
}

test("two things in one sentence, in English: the room said once counts for the next part", () => {
  several("kitchen lights off and close the blinds", [{ type: "lights", room: 1, ids: [100, 101], change: { on: false } }, { type: "blinds", room: 1, ids: [300], change: { position: 0 } }]);
  several("turn off the living room lights and set the AC to 23", [{ type: "lights", room: 2, ids: [102, 103, 105], change: { on: false }, kept: [104] }, { type: "climate", ids: [200], change: { temperature: 23 } }]);
  several("turn the porch light on and the kitchen lights off", [{ device: { kind: "light", id: 106 }, change: { on: true } }, { room: 1, change: { on: false } }]);
  several("kitchen lights off, then play music", [{ room: 1 }, { type: "music", ids: ["RINCON_1"], change: { action: "play" } }]);
  // A word of the room in a device's name is the room said.
  several("turn on the kitchen island and close the blinds", [{ device: { kind: "light", id: 100 } }, { type: "blinds", ids: [300] }]);
  // The verb said once: "and the AC" is turned off too.
  several("turn off the living room lights and the AC", [{ room: 2, change: { on: false } }, { type: "climate", ids: [200], change: { mode: "off" } }]);
  // And the room said after both, when they share the verb.
  several("turn off the lights and the AC in the living room", [{ type: "lights", room: 2 }, { type: "climate", ids: [200], change: { mode: "off" } }]);
  // A scene's name as the second thing.
  several("close the kitchen blinds and good night", [{ type: "blinds", ids: [300] }, { type: "scene", id: "aa000001" }]);
});

test("two or three things in Hebrew: ו starts a new thing only before a verb or a device", () => {
  several("כבו את האור במטבח ותסגרו את התריסים", [{ type: "lights", room: 1, change: { on: false } }, { type: "blinds", room: 1, ids: [300], change: { position: 0 } }]);
  several("כבו את האורות בסלון ומזגן על 23", [{ type: "lights", room: 2, change: { on: false } }, { type: "climate", ids: [200], change: { temperature: 23 } }]);
  several("כבו את האורות בסלון והמזגן", [{ room: 2 }, { type: "climate", ids: [200], change: { mode: "off" } }]);
  several("כבו את האורות והמזגן בסלון", [{ type: "lights", room: 2 }, { type: "climate", ids: [200], change: { mode: "off" } }]);
  several("כבו את האור במטבח, תסגרו את התריסים ותנגנו מוזיקה", [{ type: "lights" }, { type: "blinds" }, { type: "music", ids: ["RINCON_1"] }]);
  several("תדליקו את הספוטים ואת הנברשת בסלון", [{ ids: [1000], change: { on: true } }, { ids: [1001], change: { on: true } }], IL);
  several("פתחו את שער החניה ותדליקו את האור בחניה", [{ type: "door", device: { kind: "relay", id: 4000 } }, { type: "lights", ids: [1017], change: { on: true } }], IL);
  several("תפעילו לילה טוב ותסגרו את התריס בסלון", [{ type: "scene", id: "s1" }, { type: "blinds", ids: [3000] }], IL);
  // ו inside a name, or a word that is itself a word for a device: no new thing.
  same("תדליק את האור בחדר ורד", { room: 15, ids: [1018] }, IL);
  same("תפעיל סרט ומוזיקה", { type: "scene", id: "s5" }, IL);
  same("סגרו את הוילון במטבח", { type: "blinds", ids: [300] });
  // ו before a room only: two rooms at once, as in 1.9.0.
  problem("כבו את האור בסלון ובמטבח", "oneAtATime");
});

test("several things: not inside a name, not a room or a verb alone", () => {
  const rock = { ...HOME, scenes: [...SCENES, { id: "aa000004", name: "Rock and roll" }] };
  same("run rock and roll", { type: "scene", id: "aa000004" }, rock);
  // A room alone before a comma is where, not a thing: "Kitchen, lights off".
  same("Kitchen, lights off", { room: 1, ids: [100, 101], change: { on: false } });
  // "On and off", "and turn it off": one thing that contradicts itself, not understood.
  unknown("kitchen lights on and off");
  unknown("turn on the kitchen lights and turn it off");
  problem("turn off the lights in the kitchen and the living room", "oneAtATime");
  // Numbers keep their "and": "twenty-two and a half".
  same("set the AC in the living room to twenty-two and a half", { change: { temperature: 22.5 } });
});

test("several things are all or nothing: a part not understood, asked, refused or impossible says which, and nothing is done", () => {
  const garage = part("kitchen lights off and close the garage door", "close the garage door", "unknown");
  assert.deepEqual(garage.words, ["garage"]);
  // A part that cannot be done as said.
  assert.equal(part("kitchen lights off and play music in the porch", "play music in the porch", "problem").problem, "none");
  // Don't, a time, a feeling: refused, whatever the other parts say.
  for (const [text, words, refusal] of [
    ["kitchen lights off and don't close the blinds", undefined, "not"],
    ["כבו את האור במטבח ואל תסגרו את התריסים", undefined, "not"],
    ["kitchen lights off and close the blinds tomorrow", "close the blinds tomorrow", "time"],
    ["כבו את האור במטבח ותסגרו את התריסים בעוד 10 דקות", "תסגרו את התריסים בעוד 10 דקות", "time"],
    ["I'm cold, turn on the living room AC", "Im cold", "feel"],
    ["חם לי, תדליק את המזגן בסלון", "חם לי", "feel"],
  ]) {
    const result = parse(text);
    assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
    assert.equal(result.refusal, refusal, `${text}: ${JSON.stringify(result)}`);
    assert.equal(result.part, words, `${text}: ${JSON.stringify(result)}`);
  }
  // A question mark: a question, all of it.
  problem("kitchen lights off and close the blinds?", "question");
  // The whole home without "all" while another part names a room: which room, never a guess.
  const room = part("turn off the lights and close the kitchen blinds", "turn off the lights", "problem");
  assert.equal(room.problem, "needRoom");
  several("turn off all the lights and close the kitchen blinds", [{ type: "offAll", filters: ["lights"] }, { type: "blinds", room: 1 }]);
});

test("a part that would ask names its options, and nothing is done", () => {
  const spots = part("turn on the spots and close the kitchen blinds", "turn on the spots", "problem");
  assert.equal(spots.problem, "partAsks");
  assert.equal(spots.question, "which");
  assert.deepEqual(spots.options.map((option) => option.device.id).sort(), [101, 105]);
  // An AC that is off asks its mode.
  const mode = part("turn on the kids room fan and the AC", "the AC", "problem");
  assert.equal(mode.question, "mode");
});

test("several things: at most five (three until 1.11.0), one door, never the same device twice; Turn off all said twice is one", () => {
  const six = problem("kitchen lights off and close the blinds and play music and run good night and turn on the porch light and open the main gate", "tooManyParts");
  assert.equal(six.max, 5);
  problem("open the main gate and the garden gate", "oneDoor");
  // A door with another thing: the door (its second tap still waiting) and the other.
  several("open the main gate and turn on the porch light", [{ type: "door", device: { kind: "relay", id: 500 } }, { type: "lights", ids: [106] }]);
  // The island is a kitchen light: two parts change it.
  const island = problem("turn off the kitchen lights and turn on the kitchen island", "overlap");
  assert.deepEqual(island.device, { kind: "light", id: 100 });
  problem("turn off everything in the kitchen and turn on the kitchen spots", "overlap");
  problem("kitchen lights off and kitchen lights off", "overlap");
  // The room's All off and its blinds: not the same devices.
  several("kitchen off and close the blinds", [{ type: "roomOff", room: 1 }, { type: "blinds", room: 1 }]);
  // Turn off everything and close the blinds: one Turn off all, one confirm.
  same("turn off everything and close the blinds", { type: "offAll", filters: ["lights", "climate", "blinds"] });
  same("כבו הכל ותסגרו את כל התריסים", { type: "offAll", filters: ["lights", "climate", "blinds"] });
});

test("lights brighter and dimmer: only with their words, 20 points or the amount said", () => {
  for (const text of ["make the living room lights brighter", "living room lights brighter", "living room lights a bit brighter", "more light in the living room", "brighten the living room lights", "increase the living room lights", "תגביר את האור בסלון", "יותר אור בסלון", "קצת יותר אור בסלון", "תגבירו את האורות בסלון"]) {
    // The ceiling and the spots: not the floor lamp (no dimmer) nor the heater.
    same(text, { type: "lights", room: 2, ids: [102, 105], change: { brightnessBy: 20 }, kept: [104] });
  }
  for (const text of ["living room lights dimmer", "make the living room darker", "less light in the living room", "dim the living room lights a bit", "dim the living room lights a little", "תנמיך את האור בסלון", "פחות אור בסלון", "תעמעם קצת את האור בסלון", "decrease the living room lights"]) {
    same(text, { type: "lights", room: 2, ids: [102, 105], change: { brightnessBy: -20 } });
  }
  for (const [text, by] of [
    ["living room lights brighter by 30%", 30],
    ["living room lights 30% brighter", 30],
    ["make the living room lights dimmer by thirty percent", -30],
    ["dim the living room lights by 10%", -10],
    ["תגביר את האור בסלון ב-30%", 30],
    ["תנמיך את האור בסלון ב-10 אחוז", -10],
    ["תנמיך את האור בסלון בעשרים אחוז", -20],
  ]) {
    same(text, { ids: [102, 105], change: { brightnessBy: by } });
  }
  same("kitchen island brighter", { device: { kind: "light", id: 100 }, change: { brightnessBy: 20 } });
  problem("porch light brighter", "cannotDim");
  problem("living room lights brighter by 150%", "range");
  problem("brighter", "needRoom");
  // "Dim" alone is still a level to say; "brighter" with a level is that level (1.11.0: a step to
  // a level; until then not understood).
  problem("dim the living room lights", "needLevel");
  same("living room lights brighter to 30%", { ids: [102, 105], change: { brightness: 30 } });
});

test("bare more, less and by stay refusals; a time stays a time", () => {
  for (const text of ["kitchen lights more", "the kitchen lights less", "kitchen lights by 20%", "תדליק את האור במטבח ב-20%", "תוריד את האור במטבח ב-20%", "kitchen lights 20% less", "living room lights brighter by 30", "living room lights brighter at 7", "make the living room lights brighter in 10 minutes", "תגביר את האור בסלון ב-7", "תגביר את האור בסלון בשבע", "תעלה את המזגן בסלון ב-7", "living room AC warmer tomorrow", "תדליק את האור במטבח מ-20%", "kitchen volume more"]) {
    const result = parse(text);
    assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
    assert.equal(result.refusal, "time", `${text}: ${JSON.stringify(result)}`);
  }
});

test("the AC warmer and cooler: a degree, or the degrees said; with the AC said", () => {
  for (const text of ["living room AC warmer", "make the living room AC warmer", "make the living room warmer", "living room temperature warmer", "תעלה את המזגן בסלון", "יותר חם במזגן בסלון", "המזגן בסלון חם יותר", "פחות קר במזגן בסלון"]) {
    same(text, { type: "climate", ids: [200], change: { temperatureBy: 1 } });
  }
  for (const text of ["living room AC cooler", "make the living room colder", "תוריד את המזגן בסלון", "יותר קר במזגן בסלון", "מזגן בסלון קר יותר"]) {
    same(text, { type: "climate", ids: [200], change: { temperatureBy: -1 } });
  }
  for (const [text, by] of [
    ["living room AC 2 degrees warmer", 2],
    ["living room AC warmer by 2 degrees", 2],
    ["living room AC cooler by 1.5°", -1.5],
    ["תעלה את המזגן בסלון ב-2 מעלות", 2],
    ["תוריד את המזגן בסלון בשתי מעלות", -2],
    ["תוריד את המזגן בסלון ב-3°", -3],
  ]) {
    same(text, { ids: [200], change: { temperatureBy: by } });
  }
  // Not said of the AC: since 1.11.0 the room's one thermostat (until then refused as how it may be).
  // "Turn up the AC" is not clear in English.
  same("warmer in the living room", { ids: [200], change: { temperatureBy: 1 } });
  same("יותר חם בסלון", { ids: [200], change: { temperatureBy: 1 } });
  unknown("turn up the living room AC");
  unknown("increase the living room AC");
  // An AC that is off has no setpoint to move; one in auto with two setpoints: which.
  problem("kids room AC warmer", "isOff");
  const setpoint = asks("bedroom AC warmer");
  assert.equal(setpoint.question, "setpoint");
  assert.deepEqual(setpoint.options.map((option) => option.change), [{ setpoint: "cool", temperatureBy: 1 }, { setpoint: "heat", temperatureBy: 1 }]);
  const step = problem("living room AC warmer by 20 degrees", "step");
  assert.equal(step.max, 10);
  unknown("living room AC warmer by 20%");
  // A temperature with it is that temperature (1.11.0: a step to a level); a mode, not understood.
  same("living room AC warmer to 24", { ids: [200], change: { temperature: 24 } });
  unknown("living room AC warmer on cool");
});

test("feelings never act, a comparative included", () => {
  for (const text of ["I'm colder", "I feel warmer in the living room", "make it warmer for me in the living room", "יותר חם לי בסלון", "קר לי יותר", "חם לי", "it's colder in the bedroom, turn on the AC"]) {
    const result = parse(text);
    assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
    assert.equal(result.refusal, "feel", `${text}: ${JSON.stringify(result)}`);
  }
});

test("music louder and quieter: 10 points, in a Sonos room", () => {
  for (const text of ["kitchen music louder", "louder in the kitchen", "turn up the music in the kitchen", "kitchen volume up", "raise the volume in the kitchen", "תגביר את המוזיקה במטבח", "תעלה את הווליום במטבח", "תגבירו את העוצמה במטבח"]) {
    same(text, { type: "music", ids: ["RINCON_1"], change: { volumeBy: 10 } });
  }
  for (const text of ["kitchen music quieter", "turn the music down in the kitchen", "lower the volume in the kitchen", "תנמיך את המוזיקה במטבח", "תורידו את הווליום במטבח"]) {
    same(text, { type: "music", ids: ["RINCON_1"], change: { volumeBy: -10 } });
  }
  same("kitchen music louder by 20%", { change: { volumeBy: 20 } });
  // Which Sonos room, when none is said.
  assert.deepEqual(asks("louder").options.map((option) => option.ids[0]), ["RINCON_1", "RINCON_2"]);
});

test("heaters (KNX lights named for heating, kept by Composer programming) are left alone by every \"lights\" command; named, they are switched", () => {
  // The parents' room and bathroom: "lights off" leaves דוד הורים on (1.9.0 turned it off).
  same("כבו את האור בחדר הורים", { room: 4, ids: [1009, 1011], change: { on: false }, kept: [1010] }, IL);
  same("כבו את האורות במקלחת הורים", { room: 14, ids: [1014], change: { on: false }, kept: [1015, 1016] }, IL);
  same("תדליקו את האורות במקלחת הורים", { room: 14, ids: [1014], change: { on: true }, kept: [1015, 1016] }, IL);
  same("אורות במקלחת הורים 40%", { room: 14, ids: [1014], change: { brightness: 40 } }, IL);
  same("תגביר את האור במקלחת הורים", { room: 14, ids: [1014], change: { brightnessBy: 20 } }, IL);
  same("תכבה את דוד הורים", { device: { kind: "light", id: 1010 }, ids: [1010], change: { on: false } }, IL);
  same("תדליק את חימום הרצפה", { device: { kind: "light", id: 1015 }, change: { on: true } }, IL);
  // Two heaters named the same way: which one.
  assert.deepEqual(asks("תדליק את הדוד", IL).options.map((option) => option.device.id).sort(), [1010, 1013]);
  // The whole home's lights off is Turn off all (which leaves the heaters, as Home's button).
  same("כבו את כל האורות", { type: "offAll", filters: ["lights"] }, IL);
  // A room's All off is the room's (which leaves the heaters, as the room's button).
  same("כבו הכל בחדר הורים", { type: "roomOff", room: 4 }, IL);
});

test("the Hebrew home: sentences of 1.9.0 keep their meaning", () => {
  same("כבו את האורות בסלון", { room: 1, ids: [1000, 1001, 1002, 1003] }, IL);
  same("מזגן בסלון 23", { ids: [2000], change: { temperature: 23 } }, IL);
  same("פתחו את שער החניה", { type: "door", device: { kind: "relay", id: 4000 } }, IL);
  same("הפעילו לילה טוב", { type: "scene", id: "s1" }, IL);
  unknown("אל תפתחו את שער החניה", undefined, IL);
  problem("האור בסלון דולק?", "question", IL);
});

// ---- 1.10.0 review: rooms said in a name, a room word alone, states, night, sentences ------------

// The owner's parents' room: a light named with the Entrance's name ("רחצה ספוטים כניסה"), a bed
// light, and an AC in the Entrance.
const OWNER = {
  ...IL,
  devices: [...IL.devices, light(1020, "רחצה ספוטים כניסה", 4, { on: true }), light(1021, "מיטה ימין", 4), thermostat(2004, "מזגן כניסה", 10)],
};

// Not done: refused as "not", "time" or "feel", whatever else was said.
function refused(text, refusal, catalog = HOME) {
  const result = parse(text, catalog);
  assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
  assert.equal(result.refusal, refusal, `${text}: ${JSON.stringify(result)}`);
  return result;
}

test("a room's name inside a device's name in another room is not the room said, and never carried to the next part", () => {
  same("תכבה את רחצה ספוטים כניסה", { device: { kind: "light", id: 1020 }, change: { on: false } }, OWNER);
  // Never the Entrance's AC or lights: which room?
  for (const [text, words] of [
    ["תכבה את רחצה ספוטים כניסה ואת המזגן", "המזגן"],
    ["תכבה את רחצה ספוטים כניסה ותדליק את האור", "תדליק את האור"],
  ]) {
    assert.equal(problem(text, "needRoom", OWNER).part, words, text);
  }
  // Nor the Entrance's door: which one.
  const door = parse("תכבה את רחצה ספוטים כניסה ותפתח את הדלת", OWNER);
  assert.deepEqual([door.status, door.problem, door.question], ["problem", "partAsks", "which"], JSON.stringify(door));
  // As for a light whose name has no room's.
  problem("תכבה את מיטה ימין ותדליק את האור", "needRoom", OWNER);
  // A device in the room its name says still says it ("the kitchen island").
  several("turn on the kitchen island and close the blinds", [{ device: { kind: "light", id: 100 } }, { type: "blinds", ids: [300] }]);
});

test("Hebrew: a state without its \"?\" is a question, as in Spanish and Italian; the imperative acts", () => {
  for (const text of ["האור בחדר הורים דלוק", "שער חניה פתוח", "התריסים סגורים", "המזגן בסלון כבוי", "האורות במטבח כבויים", "התריס בסלון פתוח", "המנורות בסלון דולקות"]) {
    problem(text, "question", OWNER);
  }
  same("תפתח את שער החניה", { type: "door", device: { kind: "relay", id: 4000 } }, OWNER);
  same("כבו את האור", { type: "offAll", filters: ["lights"] }, OWNER);
  same("כבו את האור בסלון", { type: "lights", room: 1, change: { on: false } }, OWNER);
  // "סגור" is also the imperative ("סגור את התריס"): it acts.
  same("סגור את התריס בסלון", { type: "blinds", ids: [3000], change: { position: 0 } }, OWNER);
});

test("a room word alone (\"the room\", \"בחדר\") asks which room; never the whole home's Turn off all", () => {
  for (const text of ["turn off the lights in the room", "turn off everything in the room", "close the blinds in the room", "תכבו את האור בחדר", "תכבו הכל בחדר"]) {
    problem(text, "needRoom");
  }
  // In every room: the whole home, after its confirm.
  same("turn off the lights in every room", { type: "offAll", filters: ["lights"] });
  same("כבו את האורות בכל החדרים", { type: "offAll", filters: ["lights"] });
  // A room said with it is that room; a name with the word is that name.
  same("turn off the lights in the living room", { room: 2 });
  const quiet = { ...HOME, scenes: [...SCENES, { id: "aa000013", name: "Quiet room" }, { id: "aa000014", name: "חדר שקט" }] };
  same("run quiet room", { type: "scene", id: "aa000013" }, quiet);
  same("הפעילו חדר שקט", { type: "scene", id: "aa000014" }, quiet);
  same("kids room fan on", { type: "fans", ids: [400] });
});

test("a numbered room said with its room word is the room, not a light of that number elsewhere", () => {
  const rooms = (words) => ({
    rooms: [{ id: 1, names: [words.living] }, { id: 2, names: [`${words.room} 1`] }, { id: 3, names: [`${words.room} 2`] }, { id: 4, names: [words.kitchen] }],
    devices: [light(1, words.ceiling, 1), light(2, `${words.lamp} 2`, 4), light(3, words.ceiling, 2), light(4, words.ceiling, 3)],
    scenes: [],
  });
  const en = rooms({ living: "Living room", room: "Room", kitchen: "Kitchen", ceiling: "Ceiling", lamp: "Lamp" });
  const he = rooms({ living: "סלון", room: "חדר", kitchen: "מטבח", ceiling: "תקרה", lamp: "מנורה" });
  same("turn on the light in room 2", { type: "lights", room: 3, ids: [4], change: { on: true } }, en);
  same("turn on the lamp in room 2", { room: 3, ids: [4] }, en);
  same("תדליק את האור בחדר 2", { type: "lights", room: 3, ids: [4], change: { on: true } }, he);
  // The light said by its own name, or its number alone, is that light.
  same("turn on lamp 2", { device: { kind: "light", id: 2 } }, en);
  same("תדליק את מנורה 2", { device: { kind: "light", id: 2 } }, he);
});

test("night is a time; a name with a time word is that name only said whole", () => {
  for (const text of ["turn off the kitchen lights at night", "כבו את האור במטבח בלילה", "תכבו את האור בסלון הלילה"]) refused(text, "time");
  same("good night", { type: "scene", id: "aa000001" });
  same("לילה טוב", { type: "scene", id: "s1" }, OWNER);
  same("תדליקו את מנורת הלילה", { device: { kind: "light", id: 1011 }, change: { on: true } }, OWNER);
  // A scene named "Morning": its name alone is the scene; inside another command, a time.
  const morning = { ...HOME, scenes: [...SCENES, { id: "aa000011", name: "Morning" }] };
  same("run morning", { type: "scene", id: "aa000011" }, morning);
  refused("turn off the kitchen lights in the morning", "time", morning);
  // "Don't" in a scene's name: only said whole.
  const disturb = { ...HOME, scenes: [...SCENES, { id: "aa000012", name: "Do not disturb" }] };
  same("run do not disturb", { type: "scene", id: "aa000012" }, disturb);
  refused("do not turn off the kitchen lights", "not", disturb);
});

test("a change by an amount without its unit is refused in English and Hebrew too, never a level", () => {
  for (const text of ["turn up the kitchen music by 10", "kitchen lights brighter by 30", "תגבירו את המוזיקה במטבח ב-10", "תגביר את האור בסלון ב-20"]) refused(text, "time");
});

test("\"the heating\" alone asks which room: the AC, floor heating or a heater wired as a light", () => {
  problem("תכבה את החימום", "needRoom", OWNER);
  problem("turn off the heating", "needRoom");
  // With "all": the whole home's Turn off all, after its confirm (heaters wired as lights stay).
  same("כבו את כל החימום", { type: "offAll", filters: ["climate"] }, OWNER);
  same("turn off all the heating", { type: "offAll", filters: ["climate"] });
});

test("dictation's periods: one at the end parts nothing; one between sentences parts two things, all or nothing", () => {
  same("Kitchen lights off.", { room: 1, change: { on: false } });
  same("Kitchen lights off!", { room: 1, change: { on: false } });
  several("Kitchen lights off. Close the blinds.", [{ type: "lights", room: 1 }, { type: "blinds", ids: [300], change: { position: 0 } }]);
  several("כבו את האור במטבח. תסגרו את התריסים.", [{ type: "lights", room: 1 }, { type: "blinds", ids: [300] }]);
  refused("Kitchen lights off. Don't close the blinds.", "not");
  // A part is named without its period.
  assert.equal(parse("Kitchen lights off. Close the garage door.").part, "Close the garage door");
  // A room alone before it is where, as with a comma.
  same("Kitchen. Lights off.", { room: 1, change: { on: false } });
  // "p.m." is a time, a decimal point a number.
  refused("turn on the kitchen lights at 7 p.m.", "time");
  same("set the living room AC to 23.5.", { change: { temperature: 23.5 } });
});

// ---- 1.11.0 (ADR-079): five things at once, steps for blinds and fans, a step to a level, warmer
// without the AC ------------------------------------------------------------------------------------

// The kitchen with a fan and an AC too, for five things in one room.
const KITCHEN = { ...HOME, devices: [...DEVICES, { kind: "fan", id: 401, name: "Fan", room: 1, on: false }, thermostat(204, "Kitchen AC", 1)] };

test("five things in one sentence (1.11.0): the room said once counts for every part after it; all or nothing", () => {
  several("kitchen lights off, close the blinds, play music, turn on the porch light and set the living room AC to 23", [
    { type: "lights", room: 1, change: { on: false } },
    { type: "blinds", room: 1, ids: [300], change: { position: 0 } },
    { type: "music", ids: ["RINCON_1"], change: { action: "play" } },
    { device: { kind: "light", id: 106 }, change: { on: true } },
    { type: "climate", ids: [200], change: { temperature: 23 } },
  ]);
  // The kitchen, said once, for the four parts after it.
  several("turn off the kitchen lights, close the blinds, play music, turn on the fan and set the AC to 22", [
    { type: "lights", room: 1 },
    { type: "blinds", room: 1, ids: [300] },
    { type: "music", room: 1, ids: ["RINCON_1"] },
    { type: "fans", ids: [401], change: { on: true } },
    { type: "climate", ids: [204], change: { temperature: 22 } },
  ], KITCHEN);
  several("כבו את האור במטבח, תסגרו את התריסים, תנגנו מוזיקה, תדליקו את האור במרפסת ותפעילו את המזגן בסלון על 23", [
    { type: "lights", room: 1, change: { on: false } },
    { type: "blinds", room: 1, ids: [300] },
    { type: "music", ids: ["RINCON_1"] },
    { type: "lights", room: 4, ids: [106], change: { on: true } },
    { type: "climate", ids: [200], change: { temperature: 23 } },
  ]);
  several("כבו את האור במטבח ותסגרו את התריסים ותנגנו מוזיקה ותדליקו את המאוורר ותכוונו את המזגן ל-22", [{ room: 1 }, { room: 1 }, { room: 1 }, { type: "fans", ids: [401] }, { type: "climate", ids: [204] }], KITCHEN);
  // The fifth part not understood, refused or impossible: nothing is done, and it says which.
  assert.deepEqual(part("kitchen lights off, close the blinds, play music, turn on the porch light and close the garage door", "close the garage door", "unknown").words, ["garage"]);
  assert.equal(part("kitchen lights off, close the blinds, play music, turn on the porch light and open the main gate at 7", "open the main gate at 7", "unknown").refusal, "time");
  refused("kitchen lights off, close the blinds, play music, turn on the porch light and don't run good night", "not");
  assert.equal(part("kitchen lights off, close the blinds, play music, turn on the porch light and play music in the porch", "play music in the porch", "problem").problem, "none");
  // Still one door or gate, never the same device twice; a "?" makes it all a question.
  problem("kitchen lights off, close the blinds, play music, open the main gate and open the garden gate", "oneDoor");
  problem("kitchen lights off, close the blinds, play music, turn on the porch light and turn on the kitchen island", "overlap");
  problem("kitchen lights off, close the blinds, play music, turn on the porch light and run good night?", "question");
});

test("blinds a step (1.11.0): open or close a bit, a little more, by 20%, 20% more; from where each one is", () => {
  for (const text of ["open the kitchen blinds a bit", "open the kitchen blinds a little", "open the kitchen shades slightly", "raise the kitchen blinds a bit", "open the kitchen blinds more", "open the kitchen blinds a little more", "open the kitchen a bit", "תפתח קצת את התריס במטבח", "תפתחו טיפה את התריסים במטבח", "תרים קצת את התריס במטבח", "תפתח עוד קצת את התריס במטבח", "תפתח יותר את התריס במטבח"]) {
    same(text, { type: "blinds", room: 1, ids: [300], change: { positionBy: 20 } });
  }
  for (const text of ["close the kitchen shutters a little more", "close the kitchen blinds a bit", "lower the kitchen blinds a little", "תסגרו קצת את התריסים במטבח", "תוריד טיפה את התריס במטבח", "תסגור את התריס במטבח עוד קצת"]) {
    same(text, { type: "blinds", room: 1, ids: [300], change: { positionBy: -20 } });
  }
  for (const [text, by] of [
    ["raise the kitchen blinds by 20%", 20],
    ["open the kitchen blinds by 30%", 30],
    ["open the kitchen blinds 10% more", 10],
    ["close the kitchen blinds by thirty percent", -30],
    ["lower the kitchen blinds by 15%", -15],
    ["תפתח את התריס במטבח ב-20% יותר", 20],
  ]) {
    same(text, { ids: [300], change: { positionBy: by } });
  }
  // A blind by its name; one that only opens and closes fully has no step.
  same("open the shutter in the bedroom a bit", { device: { kind: "blind", id: 302 }, change: { positionBy: 20 } });
  problem("open the window a bit", "noPosition");
  problem("open the living room blinds a bit", "noPosition");
  // Several rooms: which room (never every blind of the home).
  problem("open the blinds a bit", "needRoom");
  // A position is still a position: "to", a number alone, half.
  same("open the kitchen blinds 40%", { change: { position: 40 } });
  same("raise the kitchen blinds to 40%", { change: { position: 40 } });
  same("close the kitchen blinds halfway", { change: { position: 50 } });
  // "ב-20%" is "at" as often as "by": with the blind's own verb it is not clear (a step's own word
  // makes it one: "ב-20% יותר"). "Less" is not clear either. A step needs its unit.
  refused("תעלה את התריס במטבח ב-20%", "time");
  refused("תפתח את התריס במטבח ב-20%", "time");
  refused("open the kitchen blinds less", "time");
  refused("open the kitchen blinds by 20", "time");
  problem("open the kitchen blinds by 150%", "range");
  // A part with no verb takes the step's verb with its "a bit"; a step by an amount lends none, so
  // the shutter is never opened fully on a guess.
  several("open the kitchen blinds a bit and the shutter in the bedroom", [{ ids: [300], change: { positionBy: 20 } }, { ids: [302], change: { positionBy: 20 } }]);
  several("תפתחו קצת את התריס במטבח ואת התריס בחדר שינה", [{ ids: [300], change: { positionBy: 20 } }, { ids: [302], change: { positionBy: 20 } }]);
  assert.equal(part("open the kitchen blinds by 20% and the shutter in the bedroom", "the shutter in the bedroom", "problem").problem, "needWhat");
  refused("close the kitchen blinds a bit and the lights", "time");
});

test("five things at once stay quick in a home with 111 lights (1.11.0)", () => {
  const rooms = Array.from({ length: 40 }, (_value, index) => ({ id: index + 1, names: [`Room ${index + 1}`, `חדר ${index + 1}`] }));
  const devices = [
    ...Array.from({ length: 111 }, (_value, index) => light(1000 + index, `Light ${index} spot`, (index % 40) + 1)),
    ...Array.from({ length: 22 }, (_value, index) => thermostat(2000 + index, `AC ${index}`, (index % 40) + 1)),
    ...Array.from({ length: 15 }, (_value, index) => ({ kind: "blind", id: 3000 + index, name: `Shade ${index}`, room: (index % 40) + 1, position: true })),
  ];
  const big = { rooms, devices, scenes: Array.from({ length: 30 }, (_value, index) => ({ id: `s${index}`, name: `Scene number ${index}` })) };
  const sentence = "turn off the lights in room 12, open the shades in room 3 a bit, turn on the lights in room 20, close the shades in room 5 and run scene number 4";
  const started = performance.now();
  for (let round = 0; round < 10; round += 1) parseCommand(sentence, big);
  const each = (performance.now() - started) / 10;
  assert.ok(each < 100, `${each.toFixed(1)} ms a command`);
  several(sentence, [{ room: 12, change: { on: false } }, { room: 3, change: { positionBy: 20 } }, { room: 20, change: { on: true } }, { room: 5, change: { position: 0 } }, { type: "scene", id: "s4" }], big);
});

test("blinds a step never opens a door or a gate, nor makes Turn off all (1.11.0)", () => {
  for (const text of ["open the main gate a bit", "open the gate a little", "open the main gate by 20%", "open the main gate 20% more", "open the main gate more", "תפתח קצת את השער", "תפתחו קצת את השער במרפסת"]) {
    refused(text, "time");
  }
  // "Close the blinds" is Turn off all; "a bit" is not.
  same("close the blinds", { type: "offAll", filters: ["blinds"] });
  problem("close the blinds a bit", "needRoom");
  problem("close all the blinds a bit", "needRoom");
});

test("fans faster and slower (1.11.0): one of each fan's own speeds, or the speeds said", () => {
  for (const text of ["kids room fan faster", "make the ceiling fan faster", "turn the fan up", "turn up the fan in the kids room", "speed up the ceiling fan", "fan speed up", "kids room fan one speed up", "turn the fan up a bit", "increase the fan speed", "faster in the kids room", "תגביר את המאוורר", "תעלה את המאוורר בחדר ילדים", "מאוורר בחדר ילדים מהר יותר", "יותר מהר את המאוורר", "תגביר את המהירות של המאוורר"]) {
    same(text, { type: "fans", ids: [400], change: { speedBy: 1 } });
  }
  for (const text of ["kids room fan slower", "turn the fan down", "turn down the ceiling fan", "decrease the fan speed", "תנמיך את המאוורר", "תוריד את המאוורר בחדר ילדים", "המאוורר לאט יותר"]) {
    same(text, { type: "fans", ids: [400], change: { speedBy: -1 } });
  }
  same("kids room fan two speeds faster", { change: { speedBy: 2 } });
  same("kids room fan faster by 2 speeds", { change: { speedBy: 2 } });
  // At most four speeds; a number alone is not a speed.
  unknown("kids room fan faster by 5 speeds");
  unknown("kids room fan speed 3");
  unknown("kids room fan faster by 20%");
  // A fan that lists no speeds only turns on and off.
  const plain = { ...HOME, devices: DEVICES.map((device) => (device.kind === "fan" ? { ...device, speeds: [] } : device)) };
  problem("kids room fan faster", "noSpeeds", plain);
  same("kids room fan on", { change: { on: true } }, plain);
  // Faster without a fan in the room.
  problem("faster in the kitchen", "none");
});

test("a step to a level (1.11.0): half, a quarter, three quarters, and a step's word with \"to\"", () => {
  same("set the living room lights to half", { ids: [102, 105], change: { brightness: 50 } });
  same("dim the kitchen lights to a quarter", { ids: [100, 101], change: { brightness: 25 } });
  same("kitchen lights to three quarters", { change: { brightness: 75 } });
  same("kitchen blinds halfway", { type: "blinds", change: { position: 50 } });
  same("kitchen blinds to a quarter", { type: "blinds", change: { position: 25 } });
  same("אורות בסלון לרבע", { ids: [102, 105], change: { brightness: 25 } });
  same("האור בסלון לשלושה רבעים", { change: { brightness: 75 } });
  same("תפתח את התריס במטבח לחצי", { type: "blinds", change: { position: 50 } });
  for (const [text, change] of [
    ["kitchen lights brighter to 80%", { brightness: 80 }],
    ["brighten the kitchen lights to 80%", { brightness: 80 }],
    ["תגביר את האור במטבח ל-80%", { brightness: 80 }],
    ["make the living room AC warmer to 24", { temperature: 24 }],
    ["kitchen music louder to 40", { volume: 40 }],
  ]) {
    same(text, { change });
  }
  // A step's word for another kind with a level: not understood.
  unknown("kitchen lights warmer to 24");
  // A quarter at a time stays a time.
  refused("turn on the kitchen lights at a quarter to seven", "time");
  refused("kitchen lights at a quarter", "time");
  refused("תדליק את האור במטבח ברבע", "time");
  refused("תדליק את האור במטבח בעוד רבע שעה", "time");
  // A quarter in a name stays the name's.
  same("turn on the lights in the guest quarters", { room: 12 }, { ...HOME, rooms: [...ROOMS, { id: 12, names: ["Guest quarters"] }], devices: [...DEVICES, light(116, "Lamp", 12)] });
});

test("a room's level and step go to its dimmers only and say which switches stay as they are (1.10.3's rule)", () => {
  // The living room: the ceiling and the spots dim; the floor lamp only turns on and off; the heater
  // is left as it is.
  for (const [text, change] of [
    ["living room lights to half", { brightness: 50 }],
    ["living room lights 30%", { brightness: 30 }],
    ["living room lights brighter", { brightnessBy: 20 }],
    ["living room lights brighter to 80%", { brightness: 80 }],
  ]) {
    same(text, { ids: [102, 105], change, onOff: [103], kept: [104] });
  }
  // On, off and 0% go to every light (the heater still left); a light named is not "the room's".
  for (const text of ["living room lights on", "living room lights off", "living room lights 0%"]) {
    assert.equal(act(text).onOff, undefined, text);
  }
  assert.equal(act("kitchen lights 40%").onOff, undefined, "only dimmers there");
  same("אורות בסלון 50%", { ids: [1000, 1001, 1002], change: { brightness: 50 }, onOff: [1003] }, IL);
});

test("warmer or cooler without the AC said (1.11.0): the room's one thermostat; with more, which one", () => {
  for (const text of ["warmer in the living room", "living room warmer", "a bit warmer in the living room", "יותר חם בסלון", "חם יותר בסלון", "קצת יותר חם בסלון", "פחות קר בסלון"]) {
    same(text, { type: "climate", room: 2, ids: [200], change: { temperatureBy: 1 } });
  }
  for (const text of ["cooler in the living room", "colder in the living room", "יותר קר בסלון", "קר יותר בסלון"]) {
    same(text, { type: "climate", room: 2, ids: [200], change: { temperatureBy: -1 } });
  }
  same("2 degrees warmer in the living room", { change: { temperatureBy: 2 } });
  same("יותר קר בחדר שינה", { ids: [2001], change: { temperatureBy: -1 } }, IL);
  // The one thermostat there is off, or in auto with two setpoints: as with the AC said.
  problem("warmer in the kids room", "isOff");
  assert.equal(asks("warmer in the bedroom").question, "setpoint");
  // A room with an AC and floor heating: which one.
  const floor = { ...HOME, devices: [...DEVICES, thermostat(205, "Floor heating", 2, { modes: ["off", "heat"], mode: "heat" })] };
  const which = asks("warmer in the living room", floor);
  assert.equal(which.question, "which");
  assert.deepEqual(which.options.map((option) => [option.ids[0], option.change]), [[200, { temperatureBy: 1 }], [205, { temperatureBy: 1 }]]);
  assert.equal(asks("יותר חם בסלון", floor).question, "which");
  // With the AC said, as before: the room's ACs (not its floor heating).
  same("living room AC warmer", { ids: [200], change: { temperatureBy: 1 } }, floor);
  // The whole home: its one thermostat, else which room.
  const one = { ...HOME, devices: DEVICES.filter((device) => device.kind !== "thermostat" || device.id === 200) };
  same("warmer", { ids: [200], change: { temperatureBy: 1 } }, one);
  same("יותר קר", { ids: [200], change: { temperatureBy: -1 } }, one);
  problem("warmer", "needRoom");
  // A thermostat named by its own words.
  same("VRF warmer", { ids: [2003] }, { ...IL, devices: IL.devices.map((device) => (device.id === 2003 ? { ...device, mode: "heat", dual: false } : device)) });
  // A room without one.
  problem("warmer in the kitchen", "none");
});

test("warmer or cooler without the AC said: how it is or how one feels still does nothing (1.11.0)", () => {
  for (const text of ["it's warmer in the living room", "it's getting colder in the living room", "warmer here", "too warm in the living room", "colder outside", "I'm warmer in the living room", "make it warmer for me in the living room", "יותר חם לי בסלון", "נהיה חם בסלון", "נעשה קר בסלון", "יותר קר פה", "קר יותר כאן", "יותר חם בחוץ", "חם בסלון", "קר לי"]) {
    refused(text, "feel");
  }
  for (const text of ["warmer in the living room tomorrow", "warmer in the living room at 7", "יותר חם בסלון בעוד 10 דקות"]) refused(text, "time");
  refused("don't make it warmer in the living room", "not");
  problem("warmer in the living room?", "question");
});
