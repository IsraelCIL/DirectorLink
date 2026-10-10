// Say or type a command in Spanish and Italian (1.10.0, ADR-068): app/js/command-parser.js with
// the app in Spanish or Italian. Homes named as a Spanish and an Italian family name theirs
// (tests/app/command-homes.mjs); everything English and Hebrew do: lights, the AC, blinds, fans,
// scenes, music, a room's All off, Turn off all, doors, two or three things at once and changes by
// a step; their grammar (articles and contractions, every imperative, pronouns on the verb, accents
// or not, number words); each rule that keeps it safe, in each language (a question, a time,
// "don't", a feeling, a bare "more", never a guess); heaters left as they are; and which words a
// sentence is read with (the app's language first, then English and Hebrew, never one language's
// words for another's).
//   node --test tests/app/

import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "../../app/js/command-parser.js";
import { ES, IT } from "./command-homes.mjs";

// The parser's answers in one language, in one home, each checked as in command-parser.test.mjs.
function speaker(language, home) {
  const parse = (text, catalog = home) => parseCommand(text, catalog, { language });
  const check = (text, fields, action) => {
    for (const [field, value] of Object.entries(fields)) {
      const got = field === "ids" ? [...action[field]].sort() : action[field];
      assert.deepEqual(got, field === "ids" ? [...value].sort() : value, `${text}: ${field} ${JSON.stringify(action)}`);
    }
  };
  return {
    parse,
    same(text, fields, catalog) {
      const result = parse(text, catalog);
      assert.equal(result.status, "ok", `${text}: ${JSON.stringify(result)}`);
      assert.ok(result.action, `${text}: several, not one: ${JSON.stringify(result)}`);
      check(text, fields, result.action);
      return result.action;
    },
    several(text, list, catalog) {
      const result = parse(text, catalog);
      assert.equal(result.status, "ok", `${text}: ${JSON.stringify(result)}`);
      assert.equal(result.actions?.length, list.length, `${text}: ${JSON.stringify(result)}`);
      list.forEach((fields, index) => check(`${text}, part ${index + 1}`, fields, result.actions[index]));
      return result;
    },
    problem(text, code, catalog) {
      const result = parse(text, catalog);
      assert.equal(result.status, "problem", `${text}: ${JSON.stringify(result)}`);
      assert.equal(result.problem, code, `${text}: ${JSON.stringify(result)}`);
      return result;
    },
    asks(text, catalog) {
      const result = parse(text, catalog);
      assert.equal(result.status, "ask", `${text}: ${JSON.stringify(result)}`);
      return result;
    },
    unknown(text, words, catalog) {
      const result = parse(text, catalog);
      assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
      assert.equal(result.refusal, undefined, `${text}: ${JSON.stringify(result)}`);
      if (words) assert.deepEqual(result.words, words, text);
      return result;
    },
    // Not a command, whatever else it says: "not", "time" or "feel".
    refused(text, refusal, catalog) {
      const result = parse(text, catalog);
      assert.equal(result.status, "unknown", `${text}: ${JSON.stringify(result)}`);
      assert.equal(result.refusal, refusal, `${text}: ${JSON.stringify(result)}`);
      return result;
    },
  };
}

const es = speaker("es", ES);
const it = speaker("it", IT);

// ---- Spanish ---------------------------------------------------------------------------------

test("Spanish: a room's lights off and on, in every form of the verb, with or without accents", () => {
  for (const text of [
    "apaga las luces de la cocina", "APAGA LAS LUCES DE LA COCINA", "apague las luces de la cocina", "apagad las luces de la cocina", "apaguen las luces de la cocina",
    "apagar las luces de la cocina", "apagá las luces de la cocina", "apaga la luz de la cocina", "desconecta las luces de la cocina", "las luces de la cocina, apágalas", "luces de la cocina, apagalas",
  ]) {
    es.same(text, { type: "lights", room: 2, device: null, ids: [103, 104], change: { on: false } });
  }
  for (const text of ["enciende las luces del salón", "enciende la luz del salon", "encienda la luz del salón", "encended las luces del salón", "enciendan las luces del salón", "prende la luz del salón", "prendé la luz del salón", "encender las luces en el salón", "luces del salón, enciéndelas"]) {
    es.same(text, { type: "lights", room: 1, ids: [100, 101, 102], change: { on: true } });
  }
});

test("Spanish: a level, in digits or words, with por ciento, al, a la mitad", () => {
  for (const text of ["luces del salón al 30%", "pon las luces del salón al 30 por ciento", "pon la luz del salón a treinta por ciento", "luces del salón 30", "luces del salon al treinta porciento"]) {
    // The ceiling and the floor lamp: not the LED strip, which only switches.
    es.same(text, { type: "lights", room: 1, ids: [100, 101], change: { brightness: 30 } });
  }
  es.same("pon la luz del salón a la mitad", { change: { brightness: 50 } });
  es.same("luces del salón al cien por cien", { change: { brightness: 100 } });
  es.same("luces del salón al treinta y cinco por ciento", { change: { brightness: 35 } });
  es.same("luces del salón a cinco por ciento", { change: { brightness: 5 } });
  es.same("luces del salón al 0%", { ids: [100, 101, 102], change: { on: false } });
  es.problem("luz del salón al 150%", "range");
  es.problem("atenúa las luces del salón", "needLevel");
  es.problem("tira LED al 30%", "cannotDim");
  // A number word from one to nine needs its unit: "dos luces" are two lights.
  es.unknown("enciende dos luces del salón", ["dos"]);
});

test("Spanish: a light by its name, with or without its room; two of one name ask which", () => {
  es.same("enciende la lámpara de pie", { type: "lights", device: { kind: "light", id: 101 }, ids: [101], change: { on: true } });
  es.same("apaga la tira LED", { device: { kind: "light", id: 102 }, change: { on: false } });
  es.same("apaga la luz de la isla", { device: { kind: "light", id: 103 }, change: { on: false } });
  es.same("apaga las luces del techo del salón", { device: { kind: "light", id: 100 } });
  assert.deepEqual(es.asks("apaga las luces del techo").options.map((option) => option.device.id).sort(), [100, 106]);
  es.problem("enciende la luz", "needRoom");
});

test("Spanish: heaters wired as lights are left as they are by the room's lights; named, they are switched", () => {
  es.same("apaga las luces de la habitación de los niños", { room: 4, ids: [107], change: { on: false }, kept: [108] });
  es.same("apaga las luces del baño principal", { room: 7, ids: [111], change: { on: false }, kept: [109, 110] });
  es.same("enciende las luces del baño principal", { room: 7, ids: [111], change: { on: true }, kept: [109, 110] });
  es.same("sube la luz del baño principal", { room: 7, ids: [111], change: { brightnessBy: 20 } });
  es.same("apaga el termo de los niños", { device: { kind: "light", id: 108 }, ids: [108], change: { on: false } });
  es.same("enciende el toallero", { device: { kind: "light", id: 109 }, change: { on: true } });
  es.same("enciende el suelo radiante", { device: { kind: "light", id: 110 }, change: { on: true } });
  // Part of its name: asked.
  assert.equal(es.asks("apaga el termo").partial, true);
  es.same("apaga todas las luces", { type: "offAll", filters: ["lights"] });
});

test("Spanish: the AC to a temperature, off, to a mode; one that is off asks the mode", () => {
  for (const text of ["pon el aire del salón a 23", "aire acondicionado del salón a 23 grados", "pon el aire del salón a veintitrés grados", "pon el aire acondicionado del salón a 23 °C", "aire del salon a veintitres"]) {
    es.same(text, { type: "climate", ids: [200], change: { temperature: 23 } });
  }
  for (const text of ["pon el aire del salón a veintitrés y medio", "aire del salón a 23,5", "aire del salón a 23 y medio"]) {
    es.same(text, { ids: [200], change: { temperature: 23.5 } });
  }
  es.same("pon el aire del salón a veintiocho", { change: { temperature: 28 } });
  es.problem("pon el aire del salón a treinta y uno", "range");
  for (const text of ["apaga el aire del salón", "apaga el aire acondicionado del salón", "desactiva el clima del salón"]) {
    es.same(text, { ids: [200], change: { mode: "off" } });
  }
  for (const text of ["pon el aire del salón en frío", "aire del salón en modo frío", "enfría el salón", "pon el aire del salón en refrigeración"]) {
    es.same(text, { ids: [200], change: { mode: "cool" } });
  }
  es.same("pon el aire del salón en calor a 22", { ids: [200], change: { mode: "heat", temperature: 22 } });
  es.same("pon el aire del salón en automático", { ids: [200], change: { mode: "auto" } });
  assert.equal(es.asks("enciende el clima del dormitorio principal").question, "mode");
  assert.equal(es.asks("aire de los niños a 22").question, "setpoint");
  es.problem("enciende el aire de los niños", "alreadyOn");
  // Its last mode known (1.10.0, ADR-070): on as it was, no question.
  const known = { ...ES, devices: ES.devices.map((device) => (device.id === 201 ? { ...device, last: "cool" } : device)) };
  es.same("enciende el clima del dormitorio principal", { ids: [201], change: { asItWas: true } }, known);
  es.same("clima del dormitorio principal a 23", { ids: [201], change: { asItWas: true, temperature: 23 } }, known);
});

test("Spanish: the AC warmer and cooler, with the AC or the temperature said", () => {
  for (const text of ["sube la temperatura del salón", "aire del salón más caliente", "pon el aire del salón más caliente", "sube un poco la temperatura del salón", "haz el salón más caliente", "aire del salón menos frío"]) {
    es.same(text, { type: "climate", ids: [200], change: { temperatureBy: 1 } });
  }
  for (const text of ["baja la temperatura del salón", "pon el aire del salón más frío", "aire acondicionado del salón más fresco"]) {
    es.same(text, { type: "climate", ids: [200], change: { temperatureBy: -1 } });
  }
  for (const [text, by] of [
    ["baja el aire del salón dos grados", -2],
    ["sube el aire del salón en 2 grados", 2],
    ["baja la temperatura del salón un grado", -1],
    ["sube el aire del salón 1,5 grados", 1.5],
    ["pon el aire del salón dos grados más caliente", 2],
  ]) {
    es.same(text, { ids: [200], change: { temperatureBy: by } });
  }
  // The AC alone up or down: more cooling, or warmer? Not clear, as in English.
  es.unknown("sube el aire del salón");
  es.unknown("baja el aire del salón");
  es.refused("sube un poco el aire del salón", "time");
  es.problem("aire del dormitorio principal más caliente", "isOff");
  es.problem("baja el aire del salón quince grados", "step");
  // A temperature is said with "a": "baja el aire a 22" is 22°, never a step of 22.
  es.same("baja el aire del salón a 22", { ids: [200], change: { temperature: 22 } });
});

test("Spanish: blinds, an awning that only opens and closes, fans", () => {
  es.same("abre las persianas de la cocina", { type: "blinds", room: 2, ids: [301], change: { position: 100 } });
  es.same("cierra la persiana del salón", { type: "blinds", ids: [300], change: { position: 0 } });
  es.same("persiana del salón, ciérrala", { ids: [300], change: { position: 0 } });
  es.same("sube la persiana del salón", { ids: [300], change: { position: 100 } });
  es.same("baja la persiana del salón", { ids: [300], change: { position: 0 } });
  es.same("persiana del salón al 40%", { ids: [300], change: { position: 40 } });
  es.same("sube la persiana del salón hasta el 60%", { ids: [300], change: { position: 60 } });
  for (const text of ["para la persiana del salón", "detén las persianas del salón", "detened la persiana del salón"]) es.same(text, { ids: [300], change: { stop: true } });
  es.same("abre el toldo de la terraza", { ids: [302], change: { position: 100 } });
  es.problem("toldo de la terraza al 50%", "noPosition");
  es.same("enciende el ventilador del dormitorio principal", { type: "fans", ids: [400], change: { on: true } });
  es.same("apaga el ventilador", { type: "fans", ids: [400], change: { on: false } });
});

test("Spanish: scenes, and music in a Sonos room", () => {
  for (const [text, id] of [["activa Buenas noches", "es000001"], ["buenas noches", "es000001"], ["ejecuta la escena Cine", "es000002"], ["pon la escena cine", "es000002"], ["activa salir de casa", "es000003"]]) {
    es.same(text, { type: "scene", id });
  }
  for (const [text, change] of [
    ["pon música en la cocina", { action: "play" }],
    ["reproduce música en la cocina", { action: "play" }],
    ["pausa la música en la cocina", { action: "pause" }],
    ["para la música de la cocina", { action: "pause" }],
    ["pon en pausa la música de la cocina", { action: "pause" }],
    ["siguiente canción en la cocina", { action: "next" }],
    ["salta la canción de la cocina", { action: "next" }],
    ["volumen de la cocina a 30", { volume: 30 }],
    ["pon el volumen de la cocina al 30%", { volume: 30 }],
  ]) {
    es.same(text, { type: "music", ids: ["RINCON_ES2"], change });
  }
  for (const text of ["sube la música en la cocina", "sube el volumen de la cocina", "más volumen en la cocina", "pon la música más alta en la cocina", "aumenta el volumen de la cocina", "sube un poco la música de la cocina"]) {
    es.same(text, { type: "music", ids: ["RINCON_ES2"], change: { volumeBy: 10 } });
  }
  for (const text of ["baja el volumen de la cocina", "baja la música en la cocina", "menos volumen en la cocina", "pon la música más baja en la cocina", "disminuye el volumen de la cocina"]) {
    es.same(text, { type: "music", ids: ["RINCON_ES2"], change: { volumeBy: -10 } });
  }
  es.same("sube el volumen de la cocina un 20%", { change: { volumeBy: 20 } });
});

test("Spanish: brighter and dimmer, with their own words", () => {
  for (const text of ["sube la luz del salón", "sube las luces del salón", "más luz en el salón", "aumenta la luz del salón", "más brillo en el salón", "pon la luz del salón más clara", "sube un poco la luz del salón"]) {
    es.same(text, { type: "lights", room: 1, ids: [100, 101], change: { brightnessBy: 20 } });
  }
  for (const text of ["baja la luz del salón", "baja un poco la luz del salón", "menos luz en el salón", "atenúa un poco las luces del salón", "pon la luz del salón más oscura", "disminuye la luz del salón", "reduce la luz del salón"]) {
    es.same(text, { type: "lights", room: 1, ids: [100, 101], change: { brightnessBy: -20 } });
  }
  for (const [text, by] of [["sube la luz del salón un 30%", 30], ["baja la luz del salón un 10 por ciento", -10], ["atenúa las luces del salón un 20%", -20], ["sube la luz del salón en un 25%", 25]]) {
    es.same(text, { ids: [100, 101], change: { brightnessBy: by } });
  }
  // To a level, as said with "al".
  es.same("sube la luz del salón al 80%", { ids: [100, 101], change: { brightness: 80 } });
  es.problem("sube la tira LED", "cannotDim");
});

test("Spanish: a room's All off, Turn off all, doors and gates", () => {
  for (const text of ["apaga la cocina", "apaga todo en la cocina", "apágalo todo en la cocina"]) es.same(text, { type: "roomOff", room: 2 });
  for (const text of ["apaga todo", "apágalo todo", "apaga toda la casa"]) es.same(text, { type: "offAll", filters: ["lights", "climate"] });
  es.same("apaga las luces de toda la casa", { type: "offAll", filters: ["lights"] });
  es.same("apaga todos los aires", { type: "offAll", filters: ["climate"] });
  es.same("cierra todas las persianas", { type: "offAll", filters: ["blinds"] });
  es.same("abre la puerta del garaje", { type: "door", device: { kind: "relay", id: 500 } });
  es.same("abre la puerta principal", { type: "door", device: { kind: "relay", id: 501 } });
  es.same("abre el garaje", { type: "door", device: { kind: "relay", id: 500 } });
  es.problem("abre la puerta del garaje y la puerta principal", "oneDoor");
  // Doors only open.
  es.unknown("cierra la puerta del garaje");
});

test("Spanish: two or three things in one sentence, the room said once; all or nothing", () => {
  es.several("apaga las luces de la cocina y cierra las persianas", [{ type: "lights", room: 2, ids: [103, 104], change: { on: false } }, { type: "blinds", room: 2, ids: [301], change: { position: 0 } }]);
  es.several("apaga la luz del salón y pon el aire a 23", [{ type: "lights", room: 1, change: { on: false } }, { type: "climate", ids: [200], change: { temperature: 23 } }]);
  es.several("apaga las luces y el aire del salón", [{ type: "lights", room: 1 }, { type: "climate", ids: [200], change: { mode: "off" } }]);
  es.several("apaga las luces de la cocina, cierra las persianas y pon música", [{ type: "lights" }, { type: "blinds", ids: [301] }, { type: "music", ids: ["RINCON_ES2"], change: { action: "play" } }]);
  for (const text of ["apaga la luz de la cocina y luego cierra la persiana", "apaga la luz de la cocina y después cierra la persiana", "apaga la luz de la cocina e cierra la persiana"]) {
    es.several(text, [{ type: "lights", room: 2 }, { type: "blinds", ids: [301], change: { position: 0 } }]);
  }
  es.several("abre la puerta del garaje y enciende las luces de la terraza", [{ type: "door", device: { kind: "relay", id: 500 } }, { type: "lights", ids: [112], change: { on: true } }]);
  es.same("apaga todo y cierra las persianas", { type: "offAll", filters: ["lights", "climate", "blinds"] });
  // "Y" inside a number or a name is not a second thing.
  es.same("pon el aire del salón a veintidós y medio", { change: { temperature: 22.5 } });
  es.same("activa rock y pop", { type: "scene", id: "es000009" }, { ...ES, scenes: [...ES.scenes, { id: "es000009", name: "Rock y pop" }] });
  // All or nothing: the part not understood, refused or impossible says which.
  assert.equal(es.parse("apaga las luces de la cocina y cierra la puerta del garaje").part, "cierra la puerta del garaje");
  for (const [text, refusal] of [
    ["apaga las luces de la cocina y no cierres las persianas", "not"],
    ["apaga las luces de la cocina y cierra las persianas a las 10", "time"],
    ["tengo calor, enciende el aire del salón", "feel"],
  ]) {
    es.refused(text, refusal);
  }
  es.problem("apaga las luces de la cocina y cierra las persianas?", "question");
  // At most five (three until 1.11.0).
  es.problem("apaga las luces de la cocina y cierra las persianas y pon música y activa Cine y enciende la luz de la terraza y abre la puerta del garaje", "tooManyParts");
});

test("Spanish: a question, said or asked, does nothing", () => {
  for (const text of [
    "¿está encendida la luz de la cocina?", "¿apagas la luz de la cocina?", "apaga la luz de la cocina?", "está encendida la luz de la cocina", "la luz de la cocina está encendida",
    "qué temperatura hace en el salón", "están abiertas las persianas del salón", "cuál es la temperatura del salón", "luces de la cocina encendidas",
  ]) {
    es.problem(text, "question");
  }
});

test("Spanish: a time is never a level, and does nothing", () => {
  for (const text of [
    "apaga la luz de la cocina a las 7", "apaga la luz de la cocina a las siete", "apaga la luz de la cocina a las 7 y media", "apaga la luz de la cocina a la una",
    "enciende la luz de la cocina dentro de 5 minutos", "enciende la luz de la cocina dentro de 5", "enciende la luz de la cocina en 5 minutos", "enciende la luz de la cocina en 5",
    "enciende la luz de la cocina en cinco minutos", "enciende la luz de la cocina por 10 minutos", "enciende la luz de la cocina mañana", "enciende la luz de la cocina esta tarde",
    "apaga la luz de la cocina después", "apaga la luz de la cocina luego", "luces de la cocina hasta las 10", "luces de la cocina al 30% a las 8",
    // "En 23" may be in 23 minutes: say "a 23" or "en 23 grados".
    "pon el aire del salón en 23",
  ]) {
    es.refused(text, "time");
  }
  es.same("pon el aire del salón en 23 grados", { change: { temperature: 23 } });
});

test("Spanish: don't does nothing", () => {
  for (const text of ["no apagues la luz de la cocina", "no apagar la luz de la cocina", "nunca apagues la luz de la cocina", "no", "no abras la puerta del garaje", "deja de reproducir música en la cocina", "deja la luz de la cocina encendida"]) {
    es.refused(text, "not");
  }
});

test("Spanish: how warm one feels or it is does nothing", () => {
  // (Since 1.11.0 "más calor en el salón" is the salón's one AC warmer; "aquí" says how it is.)
  for (const text of ["tengo frío", "tengo calor", "hace calor en el salón", "hace frío", "más calor aquí", "hace más frío en el dormitorio principal", "pon la luz cálida en el salón"]) {
    es.refused(text, "feel");
  }
});

test("Spanish: más, menos and un poco without a step's words stay refused", () => {
  // (Since 1.11.0 "sube un poco la persiana del salón" is a step for the blind; never for a door.)
  for (const text of ["las luces de la cocina más", "luces de la cocina menos", "abre un poco la puerta del garaje", "un poco más", "enciende un poco la luz de la cocina", "más en la cocina"]) {
    es.refused(text, "time");
  }
});

test("Spanish: never a guess: one letter off in a short name, the other ending, part of a name ask", () => {
  for (const text of ["enciende la luz del cuarto de Nura", "enciende la luz de la habitación de las niñas", "apaga las luces del dormitorio"]) {
    assert.equal(es.asks(text).partial, true, text);
  }
  es.unknown("apaga las luces de la bodega", ["bodega"]);
  // A longer word with one letter off is that name, as in English and Hebrew.
  es.same("apaga las luces de la cosina", { room: 2, change: { on: false } });
});

// ---- Italian ---------------------------------------------------------------------------------

test("Italian: a room's lights off and on, in every form of the verb, with or without accents", () => {
  for (const text of ["spegni le luci della cucina", "SPEGNI LE LUCI DELLA CUCINA", "spegni le luci in cucina", "spenga le luci della cucina", "spegnete le luci della cucina", "spegnere le luci della cucina", "spegni la luce della cucina", "disattiva le luci della cucina", "luci della cucina, spegnile", "luci della cucina, spegnerle"]) {
    it.same(text, { type: "lights", room: 2, device: null, ids: [103, 104], change: { on: false } });
  }
  for (const text of ["accendi le luci del soggiorno", "accendi la luce del soggiorno", "accenda la luce in soggiorno", "accendete le luci del soggiorno", "accendere le luci nel soggiorno", "luci del soggiorno, accendile"]) {
    it.same(text, { type: "lights", room: 1, ids: [100, 101, 102], change: { on: true } });
  }
});

test("Italian: a level, in digits or words, with per cento, al, a metà", () => {
  for (const text of ["luci del soggiorno al 30%", "metti le luci del soggiorno al 30 per cento", "metti la luce del soggiorno a trenta per cento", "luci del soggiorno 30", "luci in soggiorno al trenta percento"]) {
    it.same(text, { type: "lights", room: 1, ids: [100, 101], change: { brightness: 30 } });
  }
  it.same("metti la luce del soggiorno a metà", { change: { brightness: 50 } });
  it.same("luci del soggiorno al cento per cento", { change: { brightness: 100 } });
  it.same("luci del soggiorno al settantacinque per cento", { change: { brightness: 75 } });
  it.same("luci del soggiorno al cinque per cento", { change: { brightness: 5 } });
  it.problem("luce del soggiorno al 150%", "range");
  it.problem("attenua le luci del soggiorno", "needLevel");
  it.problem("striscia LED al 30%", "cannotDim");
  it.unknown("accendi due luci del soggiorno", ["due"]);
});

test("Italian: a light by its name, with or without its room; two of one name ask which", () => {
  it.same("accendi la lampada da terra", { type: "lights", device: { kind: "light", id: 101 }, ids: [101], change: { on: true } });
  it.same("spegni la striscia LED", { device: { kind: "light", id: 102 }, change: { on: false } });
  it.same("spegni l'isola", { device: { kind: "light", id: 103 }, change: { on: false } });
  it.same("spegni le luci del soffitto del soggiorno", { device: { kind: "light", id: 100 } });
  assert.deepEqual(it.asks("spegni le luci del soffitto").options.map((option) => option.device.id).sort(), [100, 106]);
  it.problem("accendi la luce", "needRoom");
});

test("Italian: heaters wired as lights are left as they are by the room's lights; named, they are switched", () => {
  it.same("spegni le luci del bagno", { room: 7, ids: [110], change: { on: false }, kept: [108, 109] });
  it.same("accendi le luci del bagno", { room: 7, ids: [110], change: { on: true }, kept: [108, 109] });
  it.same("spegni lo scaldabagno", { device: { kind: "light", id: 108 }, ids: [108], change: { on: false } });
  it.same("accendi lo scaldasalviette", { device: { kind: "light", id: 109 }, change: { on: true } });
  it.same("spegni tutte le luci", { type: "offAll", filters: ["lights"] });
});

test("Italian: the AC to a temperature, off, to a mode; one that is off asks the mode", () => {
  for (const text of ["metti il condizionatore del soggiorno a 23", "condizionatore del soggiorno a 23 gradi", "clima in soggiorno a 23", "metti il condizionatore del soggiorno a ventitré gradi", "imposta la temperatura del soggiorno a 23 °C", "condizionatore del soggiorno a ventitre"]) {
    it.same(text, { type: "climate", ids: [200], change: { temperature: 23 } });
  }
  for (const text of ["condizionatore del soggiorno a ventitré e mezzo", "condizionatore del soggiorno a 23,5", "condizionatore del soggiorno a 23 e mezzo"]) {
    it.same(text, { ids: [200], change: { temperature: 23.5 } });
  }
  it.same("condizionatore del soggiorno a ventotto", { change: { temperature: 28 } });
  it.same("condizionatore del soggiorno a ventuno", { change: { temperature: 21 } });
  it.problem("condizionatore del soggiorno a trentuno", "range");
  for (const text of ["spegni il condizionatore del soggiorno", "spegni l'aria condizionata in soggiorno", "spegni il clima del soggiorno"]) {
    it.same(text, { ids: [200], change: { mode: "off" } });
  }
  for (const text of ["metti il condizionatore del soggiorno su freddo", "condizionatore del soggiorno in modalità freddo", "raffredda il soggiorno", "condizionatore del soggiorno in raffreddamento"]) {
    it.same(text, { ids: [200], change: { mode: "cool" } });
  }
  it.same("metti il condizionatore del soggiorno sul caldo a 22", { ids: [200], change: { mode: "heat", temperature: 22 } });
  assert.equal(it.asks("accendi il climatizzatore della camera da letto").question, "mode");
  assert.equal(it.asks("clima della cameretta a 22").question, "setpoint");
  // Its last mode known (1.10.0, ADR-070): on as it was, no question.
  const known = { ...IT, devices: IT.devices.map((device) => (device.id === 201 ? { ...device, last: "heat" } : device)) };
  it.same("accendi il climatizzatore della camera da letto", { ids: [201], change: { asItWas: true } }, known);
});

test("Italian: the AC warmer and cooler, with the AC or the temperature said", () => {
  for (const text of ["alza la temperatura del soggiorno", "condizionatore del soggiorno più caldo", "metti il condizionatore del soggiorno più caldo", "alza un po' la temperatura del soggiorno", "fai più caldo in soggiorno", "condizionatore del soggiorno meno freddo"]) {
    it.same(text, { type: "climate", ids: [200], change: { temperatureBy: 1 } });
  }
  for (const text of ["abbassa la temperatura del soggiorno", "metti il condizionatore del soggiorno più freddo", "condizionatore del soggiorno più fresco"]) {
    it.same(text, { type: "climate", ids: [200], change: { temperatureBy: -1 } });
  }
  for (const [text, by] of [
    ["abbassa il condizionatore del soggiorno di due gradi", -2],
    ["abbassa il condizionatore del soggiorno due gradi", -2],
    ["alza la temperatura del soggiorno di un grado", 1],
    ["alza il condizionatore del soggiorno di 1,5 gradi", 1.5],
  ]) {
    it.same(text, { ids: [200], change: { temperatureBy: by } });
  }
  it.unknown("alza il condizionatore del soggiorno");
  it.unknown("abbassa il condizionatore del soggiorno");
  it.problem("climatizzatore della camera da letto più caldo", "isOff");
  it.problem("abbassa il condizionatore del soggiorno di quindici gradi", "step");
  it.same("abbassa il condizionatore del soggiorno a 22", { ids: [200], change: { temperature: 22 } });
});

test("Italian: blinds, an awning that only opens and closes, fans", () => {
  it.same("apri le tapparelle della cucina", { type: "blinds", room: 2, ids: [301], change: { position: 100 } });
  it.same("chiudi la tapparella del soggiorno", { ids: [300], change: { position: 0 } });
  it.same("tapparella del soggiorno, chiudila", { ids: [300], change: { position: 0 } });
  it.same("alza la tapparella del soggiorno", { ids: [300], change: { position: 100 } });
  it.same("abbassa la tapparella del soggiorno", { ids: [300], change: { position: 0 } });
  it.same("tapparella del soggiorno al 40%", { ids: [300], change: { position: 40 } });
  for (const text of ["ferma la tapparella del soggiorno", "fermate le tapparelle del soggiorno", "blocca la tapparella del soggiorno"]) it.same(text, { ids: [300], change: { stop: true } });
  it.same("apri la tenda da sole", { ids: [302], change: { position: 100 } });
  it.problem("tenda da sole al 50%", "noPosition");
  it.same("accendi il ventilatore della camera da letto", { type: "fans", ids: [400], change: { on: true } });
  it.same("spegni il ventilatore", { type: "fans", ids: [400], change: { on: false } });
});

test("Italian: scenes, and music in a Sonos room", () => {
  for (const [text, id] of [["attiva Buonanotte", "it000001"], ["buonanotte", "it000001"], ["avvia lo scenario Cinema", "it000002"], ["esegui la scena cinema", "it000002"], ["esegui esco di casa", "it000003"]]) {
    it.same(text, { type: "scene", id });
  }
  for (const [text, change] of [
    ["metti la musica in cucina", { action: "play" }],
    ["riproduci la musica in cucina", { action: "play" }],
    ["metti in pausa la musica in cucina", { action: "pause" }],
    ["ferma la musica in cucina", { action: "pause" }],
    ["prossima canzone in cucina", { action: "next" }],
    ["brano successivo in cucina", { action: "next" }],
    ["volume in cucina a 30", { volume: 30 }],
    ["metti il volume della cucina al 30%", { volume: 30 }],
  ]) {
    it.same(text, { type: "music", ids: ["RINCON_IT2"], change });
  }
  for (const text of ["alza la musica in cucina", "alza il volume della cucina", "più volume in cucina", "metti la musica più forte in cucina", "aumenta il volume della cucina", "alza un po' la musica in cucina"]) {
    it.same(text, { type: "music", ids: ["RINCON_IT2"], change: { volumeBy: 10 } });
  }
  for (const text of ["abbassa il volume della cucina", "abbassa la musica in cucina", "meno volume in cucina", "metti la musica più piano in cucina", "diminuisci il volume della cucina"]) {
    it.same(text, { type: "music", ids: ["RINCON_IT2"], change: { volumeBy: -10 } });
  }
  it.same("alza il volume della cucina del 20%", { change: { volumeBy: 20 } });
});

test("Italian: brighter and dimmer, with their own words", () => {
  for (const text of ["alza la luce del soggiorno", "alza le luci del soggiorno", "più luce in soggiorno", "aumenta la luce del soggiorno", "più luminosità in soggiorno", "metti la luce del soggiorno più chiara", "alza un po' la luce del soggiorno"]) {
    it.same(text, { type: "lights", room: 1, ids: [100, 101], change: { brightnessBy: 20 } });
  }
  for (const text of ["abbassa la luce del soggiorno", "abbassa un po' la luce del soggiorno", "meno luce in soggiorno", "attenua un po' le luci del soggiorno", "metti la luce del soggiorno più scura", "diminuisci la luce del soggiorno", "riduci la luce del soggiorno"]) {
    it.same(text, { type: "lights", room: 1, ids: [100, 101], change: { brightnessBy: -20 } });
  }
  for (const [text, by] of [["alza la luce del soggiorno del 30%", 30], ["abbassa la luce del soggiorno del 10 per cento", -10], ["attenua le luci del soggiorno del 20%", -20], ["alza la luce del soggiorno di 25%", 25]]) {
    it.same(text, { ids: [100, 101], change: { brightnessBy: by } });
  }
  it.same("alza la luce del soggiorno all'80%", { ids: [100, 101], change: { brightness: 80 } });
  it.problem("alza la striscia LED", "cannotDim");
});

test("Italian: a room's All off, Turn off all, doors and gates", () => {
  for (const text of ["spegni la cucina", "spegni tutto in cucina", "spegnila tutta la cucina"]) it.same(text, { type: "roomOff", room: 2 });
  for (const text of ["spegni tutto", "spegni tutta la casa"]) it.same(text, { type: "offAll", filters: ["lights", "climate"] });
  it.same("spegni le luci di tutta la casa", { type: "offAll", filters: ["lights"] });
  it.same("spegni tutti i condizionatori", { type: "offAll", filters: ["climate"] });
  it.same("chiudi tutte le tapparelle", { type: "offAll", filters: ["blinds"] });
  it.same("apri la porta del garage", { type: "door", device: { kind: "relay", id: 500 } });
  it.same("apri il cancello dell'ingresso", { type: "door", device: { kind: "relay", id: 501 } });
  // Two gates and doors: which one.
  assert.deepEqual(it.asks("apri il cancello").options.map((option) => option.device.id).sort(), [500, 501]);
  it.problem("apri la porta del garage e il cancello dell'ingresso", "oneDoor");
});

test("Italian: two or three things in one sentence, the room said once; all or nothing", () => {
  it.several("spegni le luci della cucina e chiudi le tapparelle", [{ type: "lights", room: 2, ids: [103, 104], change: { on: false } }, { type: "blinds", room: 2, ids: [301], change: { position: 0 } }]);
  it.several("spegni la luce del soggiorno e metti il condizionatore a 23", [{ type: "lights", room: 1 }, { type: "climate", ids: [200], change: { temperature: 23 } }]);
  it.several("spegni le luci e il condizionatore del soggiorno", [{ type: "lights", room: 1 }, { type: "climate", ids: [200], change: { mode: "off" } }]);
  it.several("spegni le luci della cucina, chiudi le tapparelle e metti la musica", [{ type: "lights" }, { type: "blinds", ids: [301] }, { type: "music", ids: ["RINCON_IT2"], change: { action: "play" } }]);
  for (const text of ["spegni la luce della cucina e poi chiudi la tapparella", "spegni la luce della cucina e dopo chiudi la tapparella", "spegni la luce della cucina, poi chiudi la tapparella", "spegni la luce della cucina ed abbassa la tapparella"]) {
    it.several(text, [{ type: "lights", room: 2 }, { type: "blinds", ids: [301], change: { position: 0 } }]);
  }
  it.several("apri la porta del garage e accendi le luci del terrazzo", [{ type: "door", device: { kind: "relay", id: 500 } }, { type: "lights", ids: [111], change: { on: true } }]);
  it.same("spegni tutto e chiudi le tapparelle", { type: "offAll", filters: ["lights", "climate", "blinds"] });
  it.same("condizionatore del soggiorno a ventidue e mezzo", { change: { temperature: 22.5 } });
  it.same("attiva rock e pop", { type: "scene", id: "it000009" }, { ...IT, scenes: [...IT.scenes, { id: "it000009", name: "Rock e pop" }] });
  assert.equal(it.parse("spegni le luci della cucina e chiudi la porta del garage").part, "chiudi la porta del garage");
  for (const [text, refusal] of [
    ["spegni le luci della cucina e non chiudere le tapparelle", "not"],
    ["spegni le luci della cucina e chiudi le tapparelle alle 10", "time"],
    ["ho caldo, accendi il condizionatore del soggiorno", "feel"],
  ]) {
    it.refused(text, refusal);
  }
  it.problem("spegni le luci della cucina e chiudi le tapparelle?", "question");
});

test("Italian: a question, said or asked, does nothing", () => {
  for (const text of ["la luce della cucina è accesa?", "è accesa la luce della cucina", "e accesa la luce della cucina", "la luce della cucina è accesa", "che temperatura c'è in soggiorno", "quale è la temperatura del soggiorno", "sono aperte le tapparelle del soggiorno", "luci della cucina accese"]) {
    it.problem(text, "question");
  }
});

test("Italian: a time is never a level, and does nothing", () => {
  for (const text of [
    "spegni la luce della cucina alle 7", "spegni la luce della cucina alle sette", "spegni la luce della cucina all'una", "spegni la luce della cucina alle ore 7",
    "accendi la luce della cucina tra 5 minuti", "accendi la luce della cucina tra 5", "accendi la luce della cucina fra cinque minuti", "accendi la luce della cucina in 5 minuti",
    "accendi la luce della cucina in 5", "accendi la luce della cucina per un'ora", "accendi la luce della cucina per 10 minuti", "accendi la luce della cucina domani",
    "accendi la luce della cucina stasera", "spegni la luce della cucina dopo", "spegni la luce della cucina fino alle 10", "luci della cucina al 30% alle 8", "spegni la luce della cucina tra mezz'ora",
  ]) {
    it.refused(text, "time");
  }
});

test("Italian: don't does nothing", () => {
  for (const text of ["non spegnere la luce della cucina", "non spegnete la luce della cucina", "mai spegnere la luce della cucina", "non", "no", "non aprire la porta del garage", "lascia la luce della cucina accesa"]) {
    it.refused(text, "not");
  }
});

test("Italian: how warm one feels or it is does nothing", () => {
  // (Since 1.11.0 "più caldo in soggiorno" is the soggiorno's one AC warmer; "qui" says how it is.)
  for (const text of ["ho freddo", "ho caldo", "fa caldo in soggiorno", "fa freddo", "più caldo qui", "fa più freddo in camera da letto", "metti la luce calda in soggiorno"]) {
    it.refused(text, "feel");
  }
});

test("Italian: più, meno and un po' without a step's words stay refused", () => {
  // (Since 1.11.0 "alza un po' la tapparella del soggiorno" is a step for the blind; never for a gate.)
  for (const text of ["luce della cucina più", "luci della cucina meno", "apri un po' il cancello", "un po' più", "accendi un po' la luce della cucina", "più in cucina"]) {
    it.refused(text, "time");
  }
});

test("Italian: never a guess: one letter off in a short name, the other ending, part of a name ask", () => {
  assert.equal(it.asks("accendi la luce della camera di Dina").partial, true);
  // Part of a name: "camera" is a room's word, as "room" is.
  it.problem("accendi la luce in camera", "needRoom");
  it.same("spegni le luci della camera da letto", { room: 3, ids: [105, 106], change: { on: false } });
  const kids = { ...IT, rooms: [...IT.rooms, { id: 10, names: ["Camera bambine"] }], devices: [...IT.devices, { kind: "light", id: 120, name: "Luce", room: 10, dimmable: true, on: false }] };
  assert.equal(it.asks("accendi la luce della camera bambini", kids).partial, true, "the boys' room is not the girls'");
  it.unknown("spegni le luci della cantina", ["cantina"]);
  it.same("spegni le luci della cucnia", { room: 2, change: { on: false } });
});

test("Spanish and Italian: number words, abbreviations, two pronouns on a verb", () => {
  es.same("pon el aire del salón a dieciséis", { change: { temperature: 16 } });
  es.same("pon el aire del salon a diecinueve y medio", { change: { temperature: 19.5 } });
  es.same("pon el A/A del salón a 24", { ids: [200], change: { temperature: 24 } });
  es.same("luces del salón al setenta y cinco por ciento", { change: { brightness: 75 } });
  es.same("la persiana del salón, pónmela al 40%", { ids: [300], change: { position: 40 } });
  it.same("condizionatore del soggiorno a diciotto e mezzo", { change: { temperature: 18.5 } });
  it.same("luci del soggiorno al trentotto per cento", { change: { brightness: 38 } });
  it.same("luci del soggiorno al novantanove percento", { change: { brightness: 99 } });
  it.same("la tapparella del soggiorno, mettimela al 40%", { ids: [300], change: { position: 40 } });
});

// ---- which words a sentence is read with ---------------------------------------------------------

// A home whose rooms have a name in each language (Settings → Rooms).
const MIXED = {
  rooms: [
    { id: 1, names: ["Kitchen", "מטבח", "Cocina", "Cucina"] },
    { id: 2, names: ["Living room", "סלון", "Salón", "Soggiorno"] },
  ],
  devices: [
    { kind: "light", id: 1, name: "Island", room: 1, dimmable: true, on: true },
    { kind: "light", id: 2, name: "Spots", room: 1, dimmable: true, on: true },
    { kind: "light", id: 3, name: "Ceiling", room: 2, dimmable: true, on: false },
    { kind: "thermostat", id: 4, name: "AC", room: 2, modes: ["off", "cool", "heat"], mode: "cool", min: 16, max: 30 },
  ],
  scenes: [{ id: "mx000001", name: "Good night" }],
};
const read = (text, language) => parseCommand(text, MIXED, { language });

test("languages: Spanish only in Spanish, Italian only in Italian; English and Hebrew in every language", () => {
  const off = { type: "lights", room: 1, change: { on: false } };
  const check = (text, language) => {
    const result = read(text, language);
    assert.equal(result.status, "ok", `${text} (${language}): ${JSON.stringify(result)}`);
    for (const [field, value] of Object.entries(off)) assert.deepEqual(result.action[field], value, `${text} (${language})`);
  };
  for (const language of ["en", "he", "es", "it"]) {
    check("turn off the kitchen lights", language);
    check("כבו את האורות במטבח", language);
  }
  check("apaga las luces de la cocina", "es");
  check("spegni le luci della cucina", "it");
  // Another language's sentence is not understood: never read with this one's words.
  for (const [text, language] of [
    ["apaga las luces de la cocina", "en"],
    ["apaga las luces de la cocina", "he"],
    ["apaga las luces de la cocina", "it"],
    ["spegni le luci della cucina", "en"],
    ["spegni le luci della cucina", "es"],
  ]) {
    assert.equal(read(text, language).status, "unknown", `${text} (${language})`);
  }
  // Without a language, as in 1.9.0: English and Hebrew.
  assert.equal(parseCommand("apaga las luces de la cocina", MIXED).status, "unknown");
  assert.equal(parseCommand("turn off the kitchen lights", MIXED).status, "ok");
  assert.deepEqual(parseCommand("kitchen lights 30 per cent", MIXED).action.change, { brightness: 30 });
  // A number word after a word for a time is a time, in English too (as "a las siete").
  assert.equal(parseCommand("turn on the kitchen lights at seven", MIXED).refusal, "time");
});

test("languages: a Spanish word is never read as an English one, nor the other way", () => {
  // "a 70" is "to 70" in Spanish; in English "a" is an article, and the sentence is not English.
  assert.deepEqual(read("pon la luz de la cocina a 70", "es").action.change, { brightness: 70 });
  assert.equal(read("pon la luz de la cocina a 70", "en").status, "unknown");
  // "Once" is eleven only in a Spanish sentence: an English one with it is not a level.
  assert.equal(read("turn on the kitchen lights once", "es").status, "unknown");
  assert.deepEqual(read("enciende la luz de la cocina once", "es").action.change, { brightness: 11 });
  // "In 5" in an English sentence said in the Spanish app is still a time.
  assert.equal(read("turn on the kitchen lights in 5", "es").refusal, "time");
  assert.equal(read("apaga la luz de la cocina in 5 minutes", "es").refusal, "time");
  // A refusal in the app's language stands; one in English counts too.
  assert.equal(read("no apagues las luces de la cocina", "es").refusal, "not");
  assert.equal(read("don't turn off the kitchen lights", "es").refusal, "not");
  assert.equal(read("non spegnere le luci della cucina", "it").refusal, "not");
  // Italian "e" is "and"; "è" is "is": a question.
  assert.equal(read("è accesa la luce della cucina", "it").problem, "question");
  // Of two readings not understood, the words not known of the closer one.
  assert.deepEqual(read("frobnicate the kitchen", "es").words, ["frobnicate"]);
  assert.deepEqual(read("apaga la bodega", "es").words, ["bodega"]);
  // The names count in any language: Hebrew and English names in a Spanish sentence.
  assert.equal(read("apaga las luces del מטבח", "es").status, "ok");
  assert.equal(read("activa Good night", "es").action.id, "mx000001");
  assert.equal(read("apaga el island", "es").action.device.id, 1);
});

test("fast enough in Spanish and Italian for a phone in a home with 111 lights", () => {
  const rooms = Array.from({ length: 40 }, (_value, index) => ({ id: index + 1, names: [`Habitación ${index + 1}`, `Stanza ${index + 1}`] }));
  const devices = [
    ...Array.from({ length: 111 }, (_value, index) => ({ kind: "light", id: 1000 + index, name: `Luz ${index} foco`, room: (index % 40) + 1, dimmable: true, on: false })),
    ...Array.from({ length: 22 }, (_value, index) => ({ kind: "thermostat", id: 2000 + index, name: `Aire ${index}`, room: (index % 40) + 1, modes: ["off", "cool"], mode: "cool", min: 16, max: 30 })),
    ...Array.from({ length: 15 }, (_value, index) => ({ kind: "blind", id: 3000 + index, name: `Persiana ${index}`, room: (index % 40) + 1, position: true })),
  ];
  const big = { rooms, devices, scenes: Array.from({ length: 30 }, (_value, index) => ({ id: `s${index}`, name: `Escena número ${index}` })) };
  const started = performance.now();
  for (let round = 0; round < 20; round += 1) {
    parseCommand("apaga las luces de la habitación 12 y cierra las persianas", big, { language: "es" });
    parseCommand("turn off the lights in room 12", big, { language: "es" });
    parseCommand("spegni le luci della stanza 7 e chiudi le tapparelle", big, { language: "it" });
  }
  const each = (performance.now() - started) / 60;
  assert.ok(each < 50, `${each.toFixed(1)} ms a command`);
  assert.equal(parseCommand("apaga las luces de la habitación 12", big, { language: "es" }).action.room, 12);
});

// ---- 1.10.0 review -------------------------------------------------------------------------------

test("Spanish and Italian: \"la del salón\", \"quella del soggiorno\" is the kind said before, in that room; never its All off", () => {
  es.several("enciende la luz de la cocina y apaga la del salón", [
    { type: "lights", room: 2, change: { on: true } },
    { type: "lights", room: 1, ids: [100, 101, 102], change: { on: false } },
  ]);
  es.several("apaga las luces de la cocina y apaga las del salón", [{ type: "lights", room: 2 }, { type: "lights", room: 1, change: { on: false } }]);
  // "El del dormitorio": the AC, not the bedroom's lights too.
  const bedroom = { ...ES, rooms: ES.rooms.map((room) => (room.id === 3 ? { id: 3, names: ["Dormitorio"] } : room)) };
  es.several("apaga el aire del salón y apaga el del dormitorio", [{ type: "climate", ids: [200], change: { mode: "off" } }, { type: "climate", ids: [201], change: { mode: "off" } }], bedroom);
  // With nothing said before it: not understood, never the room's All off.
  es.unknown("apaga la del salón");
  es.unknown("apaga las de la cocina");
  // "La de pie" names the floor lamp by its own words.
  es.same("apaga la de pie", { device: { kind: "light", id: 101 }, change: { on: false } });
  it.several("accendi la luce della cucina e spegni quella del soggiorno", [{ type: "lights", room: 2, change: { on: true } }, { type: "lights", room: 1, change: { on: false } }]);
  it.several("spegni le luci della cucina e spegni quelle del soggiorno", [{ type: "lights", room: 2 }, { type: "lights", room: 1, change: { on: false } }]);
  it.unknown("spegni quella del soggiorno", ["quella"]);
  // "Quella luce": that light, its kind said.
  it.same("spegni quella luce del soggiorno", { type: "lights", room: 1, change: { on: false } });
});

test("Spanish and Italian: a change by N without its unit is refused, never a level of N; with its unit, the step", () => {
  for (const text of ["alza il volume in cucina di 10", "abbassa il volume in cucina di 10", "alza la luce in cucina di 20", "abbassa le luci in cucina del 30"]) it.refused(text, "time");
  for (const text of ["sube el volumen de la cocina un 10", "baja la luz de la cocina un 20"]) es.refused(text, "time");
  // A number after up or down without "a" or "al" is not a level either.
  es.unknown("sube el volumen de la cocina 10");
  it.unknown("alza la luce in cucina 20");
  // With its unit, after up or down: the step, as "baja el aire dos grados".
  es.same("sube la luz de la cocina 20%", { type: "lights", room: 2, change: { brightnessBy: 20 } });
  it.same("alza la luce in cucina 20%", { type: "lights", room: 2, change: { brightnessBy: 20 } });
  es.same("baja el volumen de la cocina 20%", { type: "music", change: { volumeBy: -20 } });
  // With "a", "al", "hasta el": the level.
  es.same("sube la luz del salón al 80%", { change: { brightness: 80 } });
  es.same("sube el volumen de la cocina a 30", { type: "music", change: { volume: 30 } });
  es.same("sube la persiana del salón hasta el 60%", { change: { position: 60 } });
  it.same("alza il volume in cucina a 30", { type: "music", change: { volume: 30 } });
});

test("Spanish: \"a la una\" keeps its time with an amount after it", () => {
  for (const text of [
    "sube la luz de la cocina a la una 20%", "baja el aire del salón a la una dos grados", "sube la temperatura del salón a la una 2 grados",
    "sube la luz de la cocina hasta la una 20%", "baja la música de la cocina a la una 10%",
  ]) {
    es.refused(text, "time");
  }
  it.refused("abbassa la temperatura del soggiorno all'una 2 gradi", "time");
  // "En un 25%" is by 25%.
  es.same("sube la luz del salón en un 25%", { change: { brightnessBy: 25 } });
});

test("Spanish and Italian: a numbered room said with its room word is the room, not a light of that number elsewhere", () => {
  const light = (id, name, room) => ({ kind: "light", id, name, room, dimmable: true, on: false });
  const numbered = (room, ceiling, lamp, kitchen, living) => ({
    rooms: [{ id: 1, names: [living] }, { id: 2, names: [`${room} 1`] }, { id: 3, names: [`${room} 2`] }, { id: 4, names: [kitchen] }],
    devices: [light(1, ceiling, 1), light(2, `${lamp} 2`, 4), light(3, ceiling, 2), light(4, ceiling, 3)],
    scenes: [],
  });
  const spanish = numbered("Habitación", "Techo", "Foco", "Cocina", "Salón");
  const italian = numbered("Camera", "Soffitto", "Lampada", "Cucina", "Soggiorno");
  es.same("enciende la luz de la habitación 2", { type: "lights", room: 3, ids: [4], change: { on: true } }, spanish);
  es.same("pon la luz de la habitación 2 al 30", { room: 3, ids: [4], change: { brightness: 30 } }, spanish);
  it.same("accendi la luce della camera 2", { type: "lights", room: 3, ids: [4], change: { on: true } }, italian);
  es.same("enciende el foco 2", { device: { kind: "light", id: 2 } }, spanish);
  it.same("accendi la lampada 2", { device: { kind: "light", id: 2 } }, italian);
});

test("Spanish and Italian: a room word alone asks which room, never the whole home's Turn off all", () => {
  for (const text of ["spegni la luce in camera", "spegni tutto in camera", "chiudi la tapparella in camera"]) it.problem(text, "needRoom");
  // Also with a scene named like the command.
  it.problem("spegni tutto in camera", "needRoom", { ...IT, scenes: [...IT.scenes, { id: "it000010", name: "Spegni tutto" }] });
  for (const text of ["apaga las luces del cuarto", "apaga todo en la habitación"]) es.problem(text, "needRoom");
  es.same("apaga las luces de todas las habitaciones", { type: "offAll", filters: ["lights"] });
  it.same("spegni le luci in tutte le stanze", { type: "offAll", filters: ["lights"] });
});

test("Spanish and Italian: night is a time; a scene or a light with a time word is that only said whole", () => {
  const scenes = { ...ES, scenes: [...ES.scenes, { id: "es000010", name: "Mañana" }, { id: "es000011", name: "Noche" }] };
  es.refused("apaga la isla mañana", "time", scenes);
  es.refused("apaga las luces del salón por la noche", "time", scenes);
  es.same("activa mañana", { type: "scene", id: "es000010" }, scenes);
  es.same("noche", { type: "scene", id: "es000011" }, scenes);
  es.same("buenas noches", { type: "scene", id: "es000001" });
  // "Lámpara de noche" said whole is the lamp; "noche" alone in a sentence is a time.
  es.same("enciende la lámpara de noche", { device: { kind: "light", id: 105 }, change: { on: true } });
  es.refused("apaga las luces del dormitorio principal por la noche", "time");
  const domani = { ...IT, scenes: [...IT.scenes, { id: "it000010", name: "Domani" }] };
  it.refused("spegni l'isola domani", "time", domani);
  it.same("attiva domani", { type: "scene", id: "it000010" }, domani);
  it.refused("spegni le luci del soggiorno di notte", "time");
  it.same("buonanotte", { type: "scene", id: "it000001" });
});

test("Spanish and Italian: è asks and parts nothing; a room and a light of one name ask; dictation's periods part", () => {
  it.problem("spegni l'isola è chiudi la tapparella del soggiorno", "question");
  it.several("spegni l'isola e chiudi la tapparella del soggiorno", [{ device: { kind: "light", id: 103 } }, { type: "blinds", ids: [300] }]);
  // A room "Termo" and the heater "Termo" in the bathroom: which one.
  const termo = {
    ...ES,
    rooms: [...ES.rooms, { id: 10, names: ["Termo"] }],
    devices: [...ES.devices, { kind: "light", id: 120, name: "Termo", room: 7, dimmable: false, on: true }, { kind: "light", id: 121, name: "Lámpara", room: 10, dimmable: true, on: true }],
  };
  const which = es.asks("apaga el termo", termo);
  assert.deepEqual(which.options.map((option) => option.type).sort(), ["lights", "roomOff"]);
  // "The lights in Termo" are the room's.
  es.same("apaga las luces en termo", { type: "lights", room: 10, ids: [121] }, termo);
  es.several("Apaga la luz de la cocina. Cierra la persiana.", [{ type: "lights", room: 2 }, { type: "blinds", ids: [301], change: { position: 0 } }]);
  it.several("Spegni la luce della cucina. Chiudi la tapparella.", [{ type: "lights", room: 2 }, { type: "blinds", ids: [301] }]);
  es.refused("Apaga la luz de la cocina. No cierres la persiana.", "not");
  es.problem("apaga la calefacción", "needRoom");
});

// ---- 1.11.0 (ADR-079): five things at once, steps for blinds and fans, a step to a level, warmer
// without the AC ------------------------------------------------------------------------------------

test("Spanish and Italian: five things in one sentence, the room said once for every part after it; all or nothing (1.11.0)", () => {
  es.several("apaga las luces de la cocina, cierra las persianas, pon música, enciende la luz de la terraza y pon el aire del salón a 23", [
    { type: "lights", room: 2, ids: [103, 104], change: { on: false } },
    { type: "blinds", room: 2, ids: [301], change: { position: 0 } },
    { type: "music", room: 2, ids: ["RINCON_ES2"], change: { action: "play" } },
    { type: "lights", ids: [112], change: { on: true } },
    { type: "climate", ids: [200], change: { temperature: 23 } },
  ]);
  it.several("spegni le luci della cucina, chiudi le tapparelle, metti la musica, accendi le luci del terrazzo e metti il condizionatore del soggiorno a 23", [
    { type: "lights", room: 2, ids: [103, 104], change: { on: false } },
    { type: "blinds", room: 2, ids: [301], change: { position: 0 } },
    { type: "music", room: 2, ids: ["RINCON_IT2"], change: { action: "play" } },
    { type: "lights", ids: [111], change: { on: true } },
    { type: "climate", ids: [200], change: { temperature: 23 } },
  ]);
  assert.equal(es.parse("apaga las luces de la cocina, cierra las persianas, pon música, enciende la luz de la terraza y cierra la puerta del garaje").part, "cierra la puerta del garaje");
  es.refused("apaga las luces de la cocina, cierra las persianas, pon música, enciende la luz de la terraza y no actives Cine", "not");
  it.refused("spegni le luci della cucina, chiudi le tapparelle, metti la musica, accendi le luci del terrazzo e attiva Cinema alle 10", "time");
  it.problem("spegni le luci della cucina e chiudi le tapparelle e metti la musica e attiva Cinema e accendi le luci del terrazzo e apri la porta del garage", "tooManyParts");
});

test("Spanish: blinds a step, fans faster and slower, a quarter, más calor without the AC (1.11.0)", () => {
  for (const text of ["abre un poco la persiana del salón", "sube un poco la persiana del salón", "abre más la persiana del salón", "abre un poco más la persiana del salón", "sube la persiana del salón un 20%", "sube la persiana del salón 20%", "abre la persiana del salón un 20%"]) {
    es.same(text, { type: "blinds", ids: [300], change: { positionBy: 20 } });
  }
  for (const text of ["cierra un poco la persiana del salón", "baja un poco la persiana del salón", "cierra un poco más las persianas del salón"]) {
    es.same(text, { type: "blinds", ids: [300], change: { positionBy: -20 } });
  }
  es.same("cierra un poco más las persianas de la cocina", { room: 2, ids: [301], change: { positionBy: -20 } });
  es.problem("abre un poco el toldo de la terraza", "noPosition");
  es.refused("abre un poco la puerta del garaje", "time");
  es.refused("abre la puerta del garaje un 20%", "time");
  // A position is still a position.
  es.same("sube la persiana del salón hasta el 60%", { ids: [300], change: { position: 60 } });
  es.same("persiana del salón a la mitad", { ids: [300], change: { position: 50 } });
  for (const text of ["sube el ventilador", "ventilador más rápido", "sube un poco el ventilador", "aumenta la velocidad del ventilador", "sube el ventilador del dormitorio principal una velocidad", "pon el ventilador más rápido"]) {
    es.same(text, { type: "fans", ids: [400], change: { speedBy: 1 } });
  }
  for (const text of ["baja el ventilador", "ventilador más lento", "disminuye la velocidad del ventilador"]) {
    es.same(text, { type: "fans", ids: [400], change: { speedBy: -1 } });
  }
  es.same("pon la luz del salón a un cuarto", { ids: [100, 101], change: { brightness: 25 } });
  es.same("pon la luz del salón a tres cuartos", { change: { brightness: 75 } });
  es.same("más luz en el salón al 80%", { change: { brightness: 80 } });
  // "Cuarto" alone is a room, never a quarter; "en un cuarto de hora" a time.
  es.same("enciende la luz del cuarto de Nora", { room: 9, ids: [113], change: { on: true } });
  es.refused("enciende la luz de la cocina en un cuarto de hora", "time");
  // Warmer without the AC said: the salón's one AC.
  for (const text of ["más calor en el salón", "menos frío en el salón"]) es.same(text, { type: "climate", room: 1, ids: [200], change: { temperatureBy: 1 } });
  es.same("más frío en el salón", { ids: [200], change: { temperatureBy: -1 } });
  es.problem("más calor en el dormitorio principal", "isOff");
  for (const text of ["hace más calor en el salón", "tengo más frío", "más calor aquí", "demasiado calor en el salón"]) es.refused(text, "feel");
});

test("Italian: blinds a step, fans faster and slower, a quarter, più caldo without the AC (1.11.0)", () => {
  for (const text of ["apri un po' la tapparella del soggiorno", "alza un po' la tapparella del soggiorno", "apri di più la tapparella del soggiorno", "apri un po' di più la tapparella del soggiorno", "alza la tapparella del soggiorno del 20%", "alza la tapparella del soggiorno 20%"]) {
    it.same(text, { type: "blinds", ids: [300], change: { positionBy: 20 } });
  }
  for (const text of ["chiudi un po' la tapparella del soggiorno", "abbassa un po' la tapparella del soggiorno", "chiudi un po' di più le tapparelle del soggiorno"]) {
    it.same(text, { type: "blinds", ids: [300], change: { positionBy: -20 } });
  }
  it.same("chiudi un po' di più le tapparelle della cucina", { room: 2, ids: [301], change: { positionBy: -20 } });
  it.problem("apri un po' la tenda da sole", "noPosition");
  it.refused("apri un po' il cancello", "time");
  it.refused("apri la porta del garage del 20%", "time");
  it.same("metti la tapparella del soggiorno a metà", { ids: [300], change: { position: 50 } });
  for (const text of ["alza il ventilatore", "ventilatore più veloce", "alza un po' il ventilatore", "aumenta la velocità del ventilatore", "metti il ventilatore più veloce"]) {
    it.same(text, { type: "fans", ids: [400], change: { speedBy: 1 } });
  }
  for (const text of ["abbassa il ventilatore", "ventilatore più lento", "diminuisci la velocità del ventilatore"]) {
    it.same(text, { type: "fans", ids: [400], change: { speedBy: -1 } });
  }
  it.same("metti la luce del soggiorno a un quarto", { ids: [100, 101], change: { brightness: 25 } });
  it.same("metti la luce del soggiorno a tre quarti", { change: { brightness: 75 } });
  // "Quarto" alone is the fourth, never a quarter; a quarter of an hour is a time.
  assert.notEqual(it.parse("metti la luce del soggiorno al quarto").status, "ok");
  it.refused("accendi la luce della cucina tra un quarto d'ora", "time");
  it.refused("spegni la luce della cucina alle sette e un quarto", "time");
  for (const text of ["più caldo in soggiorno", "meno freddo in soggiorno"]) it.same(text, { type: "climate", room: 1, ids: [200], change: { temperatureBy: 1 } });
  it.same("più freddo in soggiorno", { ids: [200], change: { temperatureBy: -1 } });
  for (const text of ["fa più caldo in soggiorno", "ho più freddo", "più caldo qui", "troppo caldo in soggiorno"]) it.refused(text, "feel");
});
