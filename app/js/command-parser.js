// Say or type a command (1.9.0, ADR-063; 1.10.0, ADR-066, ADR-068; 1.11.0, ADR-079): a sentence in
// English, Hebrew, Spanish or Italian, by this user's own names of rooms, devices, scenes and Sonos
// rooms, becomes one action of the app (or up to five: "kitchen lights off and close the blinds"),
// a question (which one, which mode), a problem to say, or "I didn't understand". No AI and nothing
// sent anywhere: words, numbers and the names the app already has for this user (js/commands.js
// builds the catalog from what the controller lists for them). Its only import is heaters.js (the
// one rule for lights named for heating), so the rules can be tested under Node
// (tests/app/command-parser.test.mjs).
//
// The languages (ADR-068): English and Hebrew are read together, as in 1.9.0 (their letters never
// mix up). Spanish and Italian each have their own words, read only when the app is in that
// language, and first: then English and Hebrew only when the app's language understood nothing in
// the sentence (a refusal in it stands), so a Spanish or Italian sentence is never read as English
// words, nor the other way. The user's names count in every language.
//
// parseCommand(text, catalog, { language }) answers one of:
//   { status: "ok", action }                     do it (doors, Turn off all and scenes that open
//                                                doors still get their second tap: commands.js)
//   { status: "ok", actions }                    two to five things, each understood; all of them
//                                                are done (each second tap still its own)
//   { status: "ask", options: [action], partial } which one; nothing is done until one is chosen.
//                                                `partial`: only part of a name was said ("Did you
//                                                mean"), so even one match is asked
//   { status: "problem", problem, ... }          understood, but it cannot be done as said
//   { status: "unknown", words, refusal }        not understood; `words` it does not know (or none);
//                                                `refusal` (not, time, feel) when it says not to,
//                                                names a time or a change by an amount, or how warm
//                                                the user feels: then nothing else counts either
//                                                (not the speech service's other guesses)
// In a sentence of several parts, a part that is not understood, asks or is refused makes the
// whole sentence that answer, with `part` (its words): nothing is done (an ask becomes the problem
// "partAsks", with its question and options to name).
//
// The catalog: { rooms: [{ id, names }], scenes: [{ id, name }], devices: [{ kind, id, name, room,
// ... }] }, the kinds: light (dimmable, on), thermostat (modes, mode, dual, min, max), blind
// (position: it can stop between open and closed), fan (on, speeds: its own, 1.11.0), music (a
// Sonos room, its id a string), relay and doorbell (doors and gates; canOpen).
//
// An action: { type, ids, change, room, device, kept }. type: lights | climate | blinds | fans |
// music (`ids` of that kind's devices, `change` what they get: also a step from where each one is,
// brightnessBy, temperatureBy, volumeBy, 1.11.0 positionBy, speedBy), scene (`id`), door
// (`device`), roomOff (`room`: the room's All off) or offAll (`filters`: Home's Turn off all for
// lights, climate or blinds). `room` is the room named, `device` ({ kind, id }) the device named,
// for the words shown; `kept` the lights named for heating that "the lights" left out (heaters.js),
// and `onOff` the lights that only turn on and off a room's level left out (1.10.3), to say so.

import { isHeater } from "./heaters.js";

// ---- words ---------------------------------------------------------------------------------

const FINAL_FORMS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };

// Lower case, without accents, niqqud and Hebrew final forms: what words are compared by.
export function fold(word) {
  return String(word)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[ךםןףץ]/g, (letter) => FINAL_FORMS[letter]);
}

const HEBREW = /[א-ת]/;
const PREFIXES = "והבלמשכ";

// The word without a plural ending (lights, אורות) or a Hebrew feminine one (מנורה). Two Hebrew
// plurals, ים and ות, are not the same form of a word (בנים, בנות: sameForm).
function stem(word) {
  if (/^[a-z]+$/.test(word)) {
    if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
    return word;
  }
  if (HEBREW.test(word) && word.length >= 4) {
    if (word.endsWith("ימ") || word.endsWith("ות")) return word.slice(0, -2);
    if (word.endsWith("ה")) return word.slice(0, -1);
  }
  return word;
}

const hebrewPlural = (word) => (HEBREW.test(word) && word.length >= 4 ? (word.endsWith("ימ") ? "ימ" : word.endsWith("ות") ? "ות" : null) : null);

// Two forms of one word: the same without their endings, unless one is a masculine plural and the
// other a feminine one (בנים, boys, is not בנות, girls).
function sameForm(a, b) {
  if (stem(a) !== stem(b)) return spanishPlural(a, b) || spanishPlural(b, a);
  const one = hebrewPlural(a);
  const other = hebrewPlural(b);
  return !one || !other || one === other;
}

// The Spanish plural of a word that ends in a consonant: salón, salones; luz, luces.
function spanishPlural(one, other) {
  if (!/^[a-z]+$/.test(one) || other.length !== one.length + 2 || !other.endsWith("es")) return false;
  if (one.endsWith("z")) return other === `${one.slice(0, -1)}ces`;
  return /[lnrdjy]$/.test(one) && other === `${one}es`;
}

// Two Spanish or Italian words that differ only in the vowel of gender or number at their end
// (niños, niñas; bambini, bambine; nonno, nonna): often two names, so said for one it is asked,
// as the other Hebrew plural is.
function otherEnding(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 4 || !/^[a-z]+$/.test(a) || !/^[a-z]+$/.test(b)) return false;
  const end = a.endsWith("s") && b.endsWith("s") ? a.length - 2 : a.length - 1;
  if (a.slice(0, end) !== b.slice(0, end) || a.slice(end + 1) !== b.slice(end + 1)) return false;
  const pair = [a[end], b[end]].sort().join("");
  return pair === "ao" || pair === "ei";
}

// Hebrew spelled with one vowel letter (י, ו) more or less, or doubled, not first or last: חניה,
// חנייה; כניסה, כנסה; מטבח, מיטבח. Only for a name's word of four letters or more. "sure" when the
// shorter has four letters too; with three (גנה for גינה, also דנה for דינה) it is only a typo.
function spelling(name, said) {
  if (!HEBREW.test(name) || !HEBREW.test(said) || name.length < 4 || said.length < 3 || Math.abs(name.length - said.length) !== 1) return null;
  const [long, short] = name.length > said.length ? [name, said] : [said, name];
  for (let index = 1; index < long.length - 1; index += 1) {
    if ((long[index] === "י" || long[index] === "ו") && long.slice(0, index) + long.slice(index + 1) === short) return short.length >= 4 ? "sure" : "typo";
  }
  return null;
}

// A Hebrew word said with up to two of its prefixes taken off (ו, ה, ב, ל, מ, ש, כ: "ובסלון" is
// also "בסלון" and "סלון"), the word itself first. A word of a name keeps its own letters: only its
// article may be left out ("חדר הילדים" said "חדר ילדים"), so that "בני" is not "שני".
function bareForms(word, name = false) {
  const forms = [word];
  if (!HEBREW.test(word)) return forms;
  if (name) return word.startsWith("ה") && word.length >= 4 ? [word, word.slice(1)] : forms;
  for (let index = 0; index < 2 && PREFIXES.includes(word[index]) && word.length - index - 1 >= 2; index += 1) {
    forms.push(word.slice(index + 1));
  }
  return forms;
}

// A sentence in words: numbers apart from letters ("ל-23", "30%"), a decimal point kept.
function split(text) {
  return String(text ?? "")
    .normalize("NFC")
    // Italian elisions are two words: "l'aria", "dell'ingresso", "all'una", "mezz'ora".
    .replace(/\b(l|dell|all|nell|sull|dall|coll|un|quest|quell|c|d|tutt|mezz)['’‘`](?=\p{L})/giu, "$1 ")
    .replace(/['’‘`׳״"“”]/g, "")
    // Percent in words: "por ciento", "per cento", "cien por cien", "per cent".
    .replace(/\b(?:por|per)\s+(?:ciento|cien|cento|cent)\b/giu, " % ")
    // "A/C", "a.c." are AC, as is Spanish "A/A" (aire acondicionado); "a.m.", "p. m." a time.
    .replace(/\ba[./][ca]\b\.?/gi, "ac")
    .replace(/\b([ap])\.\s?m\b\.?/gi, "$1m")
    // Degrees Celsius: "23°C", "23 °C", "23C", "23º", "23℃".
    .replace(/[º˚℃]/g, "°")
    .replace(/(\d)\s*°?\s*c(?![\p{L}\p{N}])/giu, "$1°")
    .replace(/(\d)[.,](\d)/g, "$1\u0001$2")
    // A minus sign before a number ("-18"), not a hyphen after a word ("ל-23").
    .replace(/(^|\s)[-−‐–](?=\d)/g, "$1\u0002")
    .replace(/[%°]/g, " $& ")
    // A comma or a semicolon may part two things said ("kitchen lights off, AC to 23"), and so may
    // the end of a sentence, as dictation writes it ("Kitchen lights off. Close the blinds."): one
    // at the end parts nothing.
    .replace(/[,;،]|[.!…]+/g, " \u0003 ")
    .replace(/(\p{L})(?=\p{N})|(\p{N})(?=\p{L})/gu, "$1$2 ")
    .replace(/[^\p{L}\p{M}\p{N}\u0001\u0002\u0003%°]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/\u0001/g, ".").replace(/\u0002/g, "-").replace(/\u0003/g, ","));
}

function word(display, name = false) {
  const raw = fold(display);
  const bares = bareForms(raw, name);
  return { display, raw, stem: stem(raw), bares, stems: [...new Set(bares.map(stem))], num: /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : null };
}

// ---- the languages ---------------------------------------------------------------------------
//
// Each language's words: what they mean (role, and for kinds of devices, which kind and whether the
// word is plural or says "all of them": lighting, מיזוג, iluminación), its numbers, and the few
// rules that differ (lexicon() below). Verbs in the forms people say and type: in Hebrew the
// imperative, the future and the infinitive, for one or more; in Spanish and Italian the imperative
// for one and for many, familiar and polite (apaga, apague, apagad, apaguen; spegni, spenga,
// spegnete), and the infinitive, with the pronouns they take (apágalas, spegnile: clitics).

// English and Hebrew, read together as in 1.9.0.
const ENGLISH_HEBREW = {
  vocabulary: [
    ["on", "on הדלק הדליקי הדליקו תדליק תדליקי תדליקו להדליק הדלקה"],
    ["off", "off out deactivate disable כבה כבי כבו תכבה תכבי תכבו לכבות כיבוי"],
    ["open", "open פתח פתחי פתחו תפתח תפתחי תפתחו לפתוח פתיחה"],
    ["close", "close shut סגור סגרי סגרו תסגור תסגרי תסגרו לסגור סגירה"],
    ["up", "up raise הרם הרימי הרימו תרים תרימי תרימו להרים העלה העלי העלו תעלה תעלי תעלו להעלות"],
    ["down", "down lower הורד הורידי הורידו תוריד תורידי תורידו להוריד"],
    ["stop", "stop halt עצור עצרי עצרו תעצור תעצרי תעצרו לעצור עצירה הפסק הפסיקי הפסיקו תפסיק תפסיקי תפסיקו להפסיק"],
    ["start", "start activate הפעל הפעילי הפעילו תפעיל תפעילי תפעילו להפעיל הפעלה התחל התחילי התחילו תתחיל"],
    ["run", "run scene trigger הרץ הריצי הריצו תריץ תריצי תריצו להריץ סצנה סצינה סצנת סצינת תרחיש"],
    ["play", "play resume unpause continue נגן נגני נגנו תנגן תנגני תנגנו לנגן השמע השמיעי השמיעו תשמיע תשמיעי תשמיעו להשמיע המשך המשיכי המשיכו תמשיך"],
    ["pause", "pause השהה השהי השהו תשהה להשהות השהיה"],
    ["next", "next skip הבא הבאה דלג דלגי דלגו תדלג לדלג"],
    ["volume", "volume vol loudness ווליום וליום עוצמה עוצמת"],
    // A fan's speed (1.11.0): "speed up the fan", "one speed up", "תגביר את המהירות".
    ["speed", "speed speeds מהירות"],
    ["level", "dim brightness level בהירות עמעם עמעמי עמעמו תעמעם תעמעמי תעמעמו לעמעם"],
    ["cool", "cool cooling קירור לקרר"],
    ["heat", "heat heating חימום לחמם"],
    ["auto", "auto automatic אוטומטי אוטו"],
    ["percent", "percent pct % אחוז אחוזים"],
    ["degrees", "degree degrees deg ° celsius מעלה מעלות צלזיוס"],
    ["all", "all every each כל"],
    ["everything", "everything הכל הכול כולם כולן"],
    // Not a command: "don't", a question, a time or a change by an amount (DirectorLink does it now,
    // as said, or not at all).
    ["not", "not dont never אל לא אין בלי ואל ולא שלא ושלא"],
    // How it is (דלוק, כבוי, פתוח, סגורים) says a state, not what to do: answered as a question, as
    // in Spanish and Italian, since dictation and typing often drop the "?" (1.10.0). Not "סגור":
    // the same letters are the imperative ("סגור את התריס").
    ["question", "is are what whats how which does did why when where who האם מה למה מתי איפה איך מי כמה " +
      "דלוק דלוקה דלוקים דלוקות דולק דולקת דולקים דולקות כבוי כבויה כבויים כבויות פתוח פתוחה פתוחים פתוחות סגורה סגורים סגורות"],
    ["time", "am pm oclock minute minutes hour hours seconds tomorrow tonight morning evening afternoon night later until till after before within דקה דקות שעה שעות שנייה שניות מחר בוקר ערב צהריים לילה עוד אחרי לפני"],
    [
      "filler",
      "the a an in at to into of my our your please now hey can could would will you i me want it its be for with and set turn switch make put change adjust room house home whole entire also just then thanks thank kindly air mode , " +
        "את של על עם ב ה ל ו מ ש כ בבקשה אנא נא לי עכשיו גם רק עד חדר בית אוויר אויר שים שימי שימו תשים תשימי תשימו כוון כווני כוונו תכוון תכווני תכוונו לכוון קבע קבעי קבעו תקבע תקבעי תקבעו שנה תשנה העבר תעביר עשה עשי עשו תעשה תעשי תעשו הגדר תגדיר אפשר תוכל מצב וגם ואז ואת אז",
    ],
  ],
  // A change by a step from where each device is (1.10.0, ADR-066), only with these words: a kind
  // (or, for increase and decrease, a light or the music said), and up (1) or down (-1). A
  // comparative may take an amount said next to it ("2 degrees warmer").
  relative: [
    ["light", 1, "brighter brighten", true],
    ["light", -1, "dimmer darker", true],
    ["climate", 1, "warmer hotter", true],
    ["climate", -1, "cooler colder", true],
    ["music", 1, "louder", true],
    ["music", -1, "quieter softer", true],
    // A fan a speed faster or slower (1.11.0).
    ["fan", 1, "faster", true],
    ["fan", -1, "slower", true],
    [null, 1, "increase הגבר הגבירי הגבירו תגביר תגבירי תגבירו להגביר הגברה", false],
    [null, -1, "decrease reduce הנמך הנמיכי הנמיכו תנמיך תנמיכי תנמיכו להנמיך הנמכה", false],
  ],
  // Words that make a change by a step only with the words above ("more light", "יותר חם", "a bit
  // brighter", "by 20%", "ב-2 מעלות"); alone they are a change by an amount, which is not done
  // (a time role, as in 1.9.0: "more", "by 20%").
  modifiers: [
    ["more", "more יותר"],
    ["less", "less פחות"],
    ["bit", "bit little slightly קצת טיפה"],
    ["by", "by"],
  ],
  // How warm the user feels ("I'm cold", "חם לי") is not what the AC should do: a mode only right
  // after `modeAfter` ("on", "to", "על") in a sentence that names the AC ("מזגן על קר").
  feelings: [
    ["cool", "cold chilly freezing קר קרה קרים"],
    ["heat", "warm hot חם חמה חמים"],
  ],
  modeAfter: "על to on",
  kinds: [
    ["light", "light lamp bulb אור מנורה מנורת נורה נורת", "lights lamps lighting bulbs אורות תאורה תאורת מנורות נורות"],
    ["climate", "ac aircon airco thermostat temperature temp conditioner אירקון מזגן תרמוסטט טמפרטורה טמפרטורת", "acs climate thermostats hvac conditioning מזגנים מיזוג"],
    ["blind", "blind shade shutter curtain drape roller תריס וילון תריסול", "blinds shades shutters curtains drapes rollers תריסים וילונות הצללה"],
    ["fan", "fan מאוורר מאורר", "fans מאווררים"],
    ["music", "song track speaker שיר רמקול", "music songs speakers sonos audio radio מוזיקה מוסיקה שירים רמקולים סונוס רדיו"],
    ["door", "door gate דלת שער", "doors gates דלתות שערים"],
  ],
  // The words for an AC itself (not a thermostat, temperature or climate): a room's AC is its
  // thermostats that cool, not its floor heating.
  ac: "ac aircon airco conditioner אירקון מזגן acs conditioning מזגנים מיזוג",
  // Before a number, these make it a time, not a level or a temperature, unless a unit follows
  // ("at 7", "in 5", "עד 7"; "at 50%" is a level). Also two words ("a las 7").
  at: "at in for until till עד",
  atPairs: [],
  // A number right after these is a level, a temperature or a time, never an amount.
  target: "to at in for until till into על ל עד",
  // "Dim" with a step ("dim the lights a bit", "by 20%") is dimmer; alone, a level to say.
  dim: "dim עמעם עמעמי עמעמו תעמעם תעמעמי תעמעמו לעמעם",
  // "Make it warmer": a climate comparative needs the AC said, or one of these.
  make: "make תעשה תעשי תעשו עשה עשי עשו",
  // Said with these, a climate comparative is how the user feels ("I'm colder", "יותר חם לי").
  feelMarkers: "i im me feel feels feeling felt לי מרגיש מרגישה מרגישים מרגישות",
  // Said with these, a climate comparative without the AC is how it is ("it's colder in the
  // bedroom", "נהיה חם בסלון", "יותר מדי חם", "קר יותר בחוץ"), not what to do (1.11.0).
  stateMarkers: "its getting gets got outside too here there נהיה נהייה נהיית נעשה נעשית חוץ פה כאן מדי מידי",
  // "More" or "less" with a word for warm or cold is warmer or cooler only in Hebrew ("יותר חם").
  moreFeel: "hebrew",
  // "יותר מהר", "לאט יותר": a fan a speed faster or slower (1.11.0), either order in Hebrew.
  adjectives: [
    ["fan", 1, "מהר מהיר מהירה"],
    ["fan", -1, "לאט איטי איטית"],
  ],
  adjectiveBefore: true,
  // "עוד קצת": a bit more (alone, "עוד" is a time: "עוד 5 דקות").
  stillMore: "עוד",
  // What parts a sentence, the words that may come before the next thing said, and the verbs that
  // start one (several things, below).
  separators: "and then ו וגם ואז ואת ,",
  leads: "the a an my our also then please את גם אז בבקשה",
  verbs: "set turn switch make put change adjust שים שימי שימו תשים תשימי תשימו כוון כווני כוונו תכוון תכווני תכוונו לכוון קבע קבעי קבעו תקבע תקבעי תקבעו שנה תשנה העבר תעביר עשה עשי עשו תעשה תעשי תעשו הגדר תגדיר",
  // "Room" said alone, no room's name with it ("the lights in the room", "האור בחדר"): which room?
  // Never the whole home (1.10.0). Not after "all" or "every" ("in every room").
  room: "room חדר",
  numbers: [
    ["zero אפס", 0, "unit"],
    ["one אחת אחד", 1, "unit"],
    ["two שתיים שתים שניים שנים שתי שני", 2, "unit"],
    ["three שלוש שלושה שלש שלשה", 3, "unit"],
    ["four ארבע ארבעה", 4, "unit"],
    ["five חמש חמישה חמשה", 5, "unit"],
    ["six שש שישה ששה", 6, "unit"],
    ["seven שבע שבעה", 7, "unit"],
    ["eight שמונה", 8, "unit"],
    ["nine תשע תשעה", 9, "unit"],
    ["ten", 10, "teen"],
    ["עשר עשרה", 10, "ten"],
    ...["eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"].map((entry, index) => [entry, 11 + index, "teen"]),
    ["twenty עשרים", 20, "tens"],
    ["thirty שלושים שלשים", 30, "tens"],
    ["forty fourty ארבעים", 40, "tens"],
    ["fifty חמישים חמשים", 50, "tens"],
    ["sixty שישים ששים", 60, "tens"],
    ["seventy שבעים", 70, "tens"],
    ["eighty שמונים", 80, "tens"],
    ["ninety תשעים", 90, "tens"],
    ["hundred מאה", 100, "hundred"],
    ["half halfway חצי", 50, "half"],
    // A quarter, three quarters (1.11.0): "dim the kitchen lights to a quarter", "לרבע".
    ["quarter quarters רבע רבעים", 25, "fraction"],
  ],
  // "And a half" ("23 and a half", "23 וחצי").
  halves: "half חצי",
  halfAnd: "and",
  halfArticle: "a",
};

// Spanish (1.10.0, ADR-068): Spain's and Latin America's words, accents optional.
const SPANISH = {
  vocabulary: [
    ["on", "enciende encienda encended enciendan encender encende prende prenda prended prendan prender conecta conecte conectad conecten conectar"],
    ["off", "apaga apague apagad apaguen apagar desconecta desconecte desconectad desconecten desconectar desactiva desactive desactivad desactiven desactivar"],
    ["open", "abre abra abrid abran abrir abri"],
    ["close", "cierra cierre cerrad cierren cerrar cerra"],
    ["up", "sube suba subid suban subir subi levanta levante levantad levanten levantar"],
    ["down", "baja baje bajad bajen bajar"],
    ["stop", "para pare parad paren parar detén detenga detened detengan detener stop"],
    ["start", "activa active activad activen activar inicia inicie iniciad inicien iniciar arranca arranque arrancad arranquen arrancar"],
    ["run", "ejecuta ejecute ejecutad ejecuten ejecutar lanza lance lanzad lancen lanzar escena escenas"],
    ["play", "reproduce reproduzca reproducid reproduzcan reproducir reanuda reanude reanudad reanuden reanudar continúa continúe continuad continúen continuar play"],
    ["pause", "pausa pausar pausad pausen"],
    ["next", "siguiente próxima próximo salta salte saltad salten saltar"],
    ["volume", "volumen"],
    ["speed", "velocidad velocidades"],
    ["level", "brillo intensidad nivel atenúa atenúe atenuad atenúen atenuar"],
    ["cool", "refrigeración refrigerar enfriamiento enfría enfríe enfriad enfríen enfriar"],
    ["heat", "calefacción calienta calentad calienten calentar"],
    ["auto", "automático automática auto"],
    ["percent", "porciento %"],
    ["degrees", "grado grados ° celsius centígrados"],
    ["all", "todas todos toda"],
    ["everything", "todo"],
    ["not", "no nunca jamás ni sin deja deje dejad dejen dejar"],
    // How it is ("encendida", "abiertas") says a state, not what to do: answered as a question
    // ("está encendida la luz de la cocina", without its "?").
    ["question", "qué cuál cuáles cuándo dónde adónde cómo quién quiénes cuánto cuánta cuántos cuántas está están estás es son hay será " +
      "encendido encendida encendidos encendidas prendido prendida prendidos prendidas apagado apagada apagados apagadas abierto abierta abiertos abiertas cerrado cerrada cerrados cerradas"],
    ["time", "am pm minuto minutos hora horas segundos mañana tarde noche noches temprano pronto rato momento mediodía medianoche madrugada después antes tras luego semana lunes martes miércoles jueves viernes sábado domingo"],
    [
      "filler",
      "el la los las lo le les un una unos unas de del al a en con por favor porfa porfavor me mi mis te tu tus su sus nos nuestro nuestra nuestros nuestras y e ya ahora mismo enseguida también solo además entonces " +
        "casa hogar habitación habitaciones cuarto cuartos entera entero completa completo modo acondicionado quiero quisiera puedes puede podrías podría oye hola gracias vale hasta desde dentro hace hacía " +
        "pon ponga poned pongan poner haz haga haced hagan hacer cambia cambie cambiad cambien cambiar ajusta ajuste ajustad ajusten ajustar configura configure configurad configuren configurar ,",
    ],
  ],
  relative: [
    [null, 1, "aumenta aumente aumentad aumenten aumentar incrementa incremente incrementar", false],
    [null, -1, "disminuye disminuya disminuid disminuyan disminuir reduce reduzca reducid reduzcan reducir", false],
  ],
  modifiers: [
    ["more", "más"],
    ["less", "menos"],
    ["bit", "poco poquito ligeramente"],
  ],
  feelings: [
    ["cool", "frío fría fríos frías fresco fresca frescos frescas"],
    ["heat", "calor caliente calientes cálido cálida cálidos cálidas"],
  ],
  modeAfter: "en a al modo",
  kinds: [
    ["light", "luz lámpara bombilla foco", "luces lámparas bombillas focos iluminación"],
    ["climate", "aire ac clima climatizador termostato temperatura split", "aires climatizadores termostatos temperaturas climatización splits"],
    ["blind", "persiana estor cortina toldo contraventana veneciana", "persianas estores cortinas toldos contraventanas venecianas"],
    ["fan", "ventilador", "ventiladores"],
    ["music", "canción tema altavoz bafle", "música canciones temas altavoces sonos audio radio"],
    ["door", "puerta portón verja cancela portal", "puertas portones verjas cancelas portales"],
  ],
  ac: "aire ac clima climatizador split aires climatizadores splits",
  // "Sube la temperatura": the setpoint up (with the AC alone, "sube el aire", it is not clear).
  temperature: "temperatura temperaturas",
  // "a las 7", "en 5", "hasta las 7", "dentro de 5", "a la una": a time.
  at: "en hasta durante por desde las",
  atPairs: ["a la", "hasta la", "desde la", "para la", "sobre la", "sobre las", "dentro de", "antes de", "después de", "cerca de"],
  target: "a al en hasta",
  // An amount with a step: "sube la luz un 20%", "baja el aire en 2 grados".
  byWords: "en un una",
  dim: "atenúa atenúe atenuad atenúen atenuar",
  make: "haz haga haced hagan pon ponga poned pongan",
  // "Pon música": play.
  put: "pon ponga poned pongan",
  feelMarkers: "tengo tenemos tiene tienen tienes siento sentimos siente sienten sientes me nos hace hacía estoy estamos está están",
  stateMarkers: "aquí acá afuera fuera demasiado",
  moreFeel: "all",
  // "Más alta", "más oscuro": a comparative said in two words (with "más" or "menos").
  adjectives: [
    [null, 1, "alto alta fuerte"],
    [null, -1, "bajo baja bajito bajita flojo floja suave"],
    ["light", 1, "claro clara brillante luminoso luminosa"],
    ["light", -1, "oscuro oscura tenue"],
    ["fan", 1, "rápido rápida deprisa"],
    ["fan", -1, "lento lenta despacio"],
  ],
  // "Más brillo", "más volumen": brighter, louder.
  moreLevel: true,
  // "Sube la luz", "baja las luces": brighter, dimmer. "Sube el aire dos grados": warmer by that.
  upDownLight: true,
  upDownClimate: true,
  separators: "y e ,",
  leads: "el la los las lo un una unos unas también luego después además entonces",
  // "Y luego", "y después": then (alone, "luego" and "después" are later).
  then: "luego después",
  verbs: "pon ponga poned pongan poner haz haga haced hagan hacer cambia cambie cambiad cambien cambiar ajusta ajuste ajustad ajusten ajustar configura configure configurad configuren configurar",
  room: "habitación cuarto",
  // "La del salón", "el del dormitorio", "las de la cocina": the one of a room, for the kind said in
  // the part before ("enciende la luz de la cocina y apaga la del salón"), one or many; an article
  // only right before "de" or "del".
  pronouns: [["la el", false], ["las los", true]],
  pronounOf: "de del",
  clitics: "los las les lo la le nos me",
  numbers: [
    ["cero", 0, "unit"],
    ["un uno una", 1, "unit"],
    ["dos", 2, "unit"],
    ["tres", 3, "unit"],
    ["cuatro", 4, "unit"],
    ["cinco", 5, "unit"],
    ["seis", 6, "unit"],
    ["siete", 7, "unit"],
    ["ocho", 8, "unit"],
    ["nueve", 9, "unit"],
    ...["diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve"].map((entry, index) => [entry, 10 + index, "teen"]),
    ["veinte", 20, "tens"],
    ["veintiuno veintiún veintiuna", 21, "teen"],
    ...["veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"].map((entry, index) => [entry, 22 + index, "teen"]),
    ...["treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"].map((entry, index) => [entry, 30 + index * 10, "tens"]),
    ["cien ciento", 100, "hundred"],
    ["mitad", 50, "half"],
    // "A un cuarto", "a tres cuartos" (1.11.0); alone, "cuarto" is a room.
    ["cuarto cuartos", 25, "fraction"],
  ],
  fractionNeedsUnit: true,
  // "Treinta y cinco".
  tensAnd: true,
  halves: "medio media",
  halfAnd: "y",
};

// Italian (1.10.0, ADR-068), accents optional.
const ITALIAN_TENS = [["venti", 20], ["trenta", 30], ["quaranta", 40], ["cinquanta", 50], ["sessanta", 60], ["settanta", 70], ["ottanta", 80], ["novanta", 90]];
const ITALIAN_UNITS = [["uno", 1], ["due", 2], ["tre", 3], ["quattro", 4], ["cinque", 5], ["sei", 6], ["sette", 7], ["otto", 8], ["nove", 9]];
const ITALIAN = {
  vocabulary: [
    ["on", "accendi accenda accendete accendano accendere"],
    ["off", "spegni spenga spegnete spengano spegnere disattiva disattivi disattivate disattivino disattivare"],
    ["open", "apri apra aprite aprano aprire"],
    ["close", "chiudi chiuda chiudete chiudano chiudere"],
    ["up", "alza alzi alzate alzino alzare solleva sollevi sollevate sollevare"],
    ["down", "abbassa abbassi abbassate abbassino abbassare giù cala cali calate calare"],
    ["stop", "ferma fermi fermate fermino fermare arresta arresti arrestate arrestare blocca blocchi bloccate bloccare stop"],
    ["start", "attiva attivi attivate attivino attivare avvia avvii avviate avviino avviare"],
    ["run", "esegui esegua eseguite eseguano eseguire lancia lanci lanciate lanciare scena scene scenario scenari"],
    ["play", "riproduci riproduca riproducete riprodurre suona suoni suonate suonare riprendi riprenda riprendete riprendere play"],
    ["pause", "pausa"],
    ["next", "prossima prossimo successiva successivo avanti salta salti saltate saltare"],
    ["volume", "volume"],
    ["speed", "velocità"],
    ["level", "luminosità intensità livello attenua attenui attenuate attenuare"],
    ["cool", "raffreddamento raffrescamento raffredda raffreddi raffreddate raffreddare rinfresca rinfrescare"],
    ["heat", "riscaldamento riscalda riscaldi riscaldate riscaldare"],
    ["auto", "automatico automatica auto"],
    ["percent", "percento percentuale %"],
    ["degrees", "grado gradi ° celsius centigradi"],
    ["all", "tutte tutti tutta"],
    ["everything", "tutto"],
    ["not", "non no mai né senza lascia lasci lasciate lasciare"],
    ["question", "che cosa quale quali quanto quanta quanti quante quando dove come chi perché sono " +
      "acceso accesa accesi accese spento spenta spenti spente aperto aperta aperti aperte chiuso chiusa chiusi chiuse"],
    // "Ora" is the hour ("tra un'ora", "per un'ora"): to say now, "adesso" or "subito".
    ["time", "am pm minuto minuti ora ore secondi momento attimo domani stasera stanotte stamattina mattina pomeriggio sera notte dopo prima tardi presto tra fra entro verso mezzogiorno mezzanotte settimana lunedì martedì mercoledì giovedì venerdì sabato domenica"],
    [
      "filler",
      "il lo la i gli le l un uno una del dello della dei degli delle dell al allo alla ai agli alle all dal dallo dalla dai dagli dalle dall nel nello nella nei negli nelle nell sul sullo sulla sui sugli sulle sull col coi " +
        "di da in a su con per favore piacere mi ti ci vi si me te ce mio mia miei mie tuo tua nostro nostra e ed anche pure adesso subito poi inoltre c d " +
        "casa stanza stanze camera camere intera intero modalità modo condizionata puoi può potresti potrebbe vorrei voglio ehi ciao grazie fino fa fanno " +
        "metti metta mettete mettano mettere imposta imposti impostate impostino impostare regola regoli regolate regolino regolare cambia cambi cambiate cambiare fai faccia fate fare rendi renda rendete rendere ,",
    ],
  ],
  relative: [
    [null, 1, "aumenta aumenti aumentate aumentare incrementa incrementare", false],
    [null, -1, "diminuisci diminuisca diminuite diminuire riduci riduca riducete ridurre", false],
  ],
  modifiers: [
    ["more", "più"],
    ["less", "meno"],
    ["bit", "po poco pochino pochettino leggermente"],
  ],
  feelings: [
    ["cool", "freddo fredda freddi fredde fresco fresca freschi fresche"],
    ["heat", "caldo calda caldi calde"],
  ],
  modeAfter: "a al su sul in modalità modo",
  kinds: [
    ["light", "luce lampada lampadina", "luci lampade lampadine illuminazione"],
    ["climate", "condizionatore climatizzatore clima ac aria split termostato temperatura", "condizionatori climatizzatori termostati temperature climatizzazione"],
    ["blind", "tapparella persiana tenda avvolgibile serranda veneziana", "tapparelle persiane tende avvolgibili serrande veneziane"],
    ["fan", "ventilatore ventola", "ventilatori ventole"],
    ["music", "canzone brano cassa altoparlante", "musica canzoni brani casse altoparlanti sonos audio radio"],
    ["door", "porta cancello portone cancelletto", "porte cancelli portoni cancelletti"],
  ],
  ac: "condizionatore climatizzatore clima ac aria split condizionatori climatizzatori",
  temperature: "temperatura temperature",
  // "alle 7", "in 5", "tra 5", "per 5", "entro le 7", "fino a 7", "all'una": a time.
  at: "in tra fra entro per durante dalle alle le ore all verso",
  atPairs: ["fino a", "fino al", "fino alle", "prima di", "prima delle", "dopo le"],
  target: "a al allo alla su sul sulla fino",
  // An amount with a step: "alza la luce del 20%", "abbassa di 2 gradi".
  byWords: "di del dello della",
  dim: "attenua attenui attenuate attenuare",
  make: "fai faccia fate rendi renda rendete metti metta mettete",
  // "Metti la musica": play.
  put: "metti metta mettete mettano",
  feelMarkers: "ho abbiamo ha hanno hai sento sentiamo sente sentono senti mi ci fa fanno sto stiamo",
  stateMarkers: "qui qua fuori troppo",
  moreFeel: "all",
  adjectives: [
    [null, 1, "alto alta forte"],
    [null, -1, "basso bassa piano"],
    ["light", 1, "chiaro chiara luminoso luminosa"],
    ["light", -1, "scuro scura"],
    ["fan", 1, "veloce veloci rapido rapida"],
    ["fan", -1, "lento lenta lenti lente"],
  ],
  moreLevel: true,
  upDownLight: true,
  upDownClimate: true,
  separators: "e ed poi ,",
  leads: "il lo la i gli le l un uno una anche poi pure inoltre",
  then: "dopo",
  verbs: "metti metta mettete mettano mettere imposta imposti impostate impostino impostare regola regoli regolate regolino regolare cambia cambi cambiate cambiare fai faccia fate fare rendi renda rendete rendere",
  room: "stanza camera",
  // "Quella del soggiorno", "quelle in cucina": the one of a room ("that light", with its kind said,
  // is that one).
  pronouns: [["quella quello quel quell", false], ["quelle quelli quei quegli", true]],
  clitics: "glie gli le li lo la ne mi ci me ce",
  // "Spegnerla": the infinitive drops its last e before a pronoun.
  cliticE: true,
  // "È" (is) asks; "e" (and) parts a sentence.
  exact: [["è", "question"]],
  numbers: [
    ["zero", 0, "unit"],
    ["un uno una", 1, "unit"],
    ...ITALIAN_UNITS.slice(1).map(([entry, value]) => [entry, value, "unit"]),
    ...["dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove"].map((entry, index) => [entry, 10 + index, "teen"]),
    ...ITALIAN_TENS.map(([entry, value]) => [entry, value, "tens"]),
    // Ventuno, ventitré, trentotto: one word.
    ...ITALIAN_TENS.flatMap(([tens, value]) => ITALIAN_UNITS.map(([unit, add]) => [`${/^[uo]/.test(unit) ? tens.slice(0, -1) : tens}${unit}`, value + add, "teen"])),
    ["cento", 100, "hundred"],
    ["metà", 50, "half"],
    // "A un quarto", "a tre quarti" (1.11.0); alone, "quarto" is the fourth.
    ["quarto quarti", 25, "fraction"],
  ],
  fractionNeedsUnit: true,
  halves: "mezzo mezza",
  halfAnd: "e",
};

const list = (text) => String(text || "").split(" ").filter(Boolean);
const foldedSet = (text) => new Set(list(text).map(fold));

// A language's words, as the parser asks them.
function lexicon(spec) {
  const ac = foldedSet(spec.ac);
  const temperature = foldedSet(spec.temperature);
  const roles = new Map(); // folded word -> { role, kind?, plural? }
  for (const [role, words] of spec.vocabulary) {
    for (const entry of list(words)) roles.set(fold(entry), { role });
  }
  for (const [kind, singular, plural] of spec.kinds) {
    for (const [words, many] of [[singular, false], [plural, true]]) {
      for (const entry of list(words)) roles.set(fold(entry), { role: "kind", kind, plural: many, ac: ac.has(fold(entry)), temperature: temperature.has(fold(entry)) });
    }
  }
  for (const [mode, words] of spec.feelings) {
    for (const entry of list(words)) roles.set(fold(entry), { role: "feel", mode });
  }
  for (const [kind, dir, words, comparative] of spec.relative) {
    for (const entry of list(words)) roles.set(fold(entry), { role: "rel", kind, dir, comparative });
  }
  for (const [modifier, words] of spec.modifiers) {
    for (const entry of list(words)) roles.set(fold(entry), { role: "time", modifier });
  }
  const roleStems = new Map(); // a word's stem -> the same
  for (const [key, value] of roles) if (!roleStems.has(stem(key))) roleStems.set(stem(key), value);
  const numbers = new Map();
  for (const [words, value, type] of spec.numbers) {
    for (const entry of list(words)) numbers.set(fold(entry), { value, type });
  }
  const adjectives = new Map();
  for (const [kind, dir, words] of spec.adjectives || []) {
    for (const entry of list(words)) adjectives.set(fold(entry), { kind, dir });
  }
  return {
    roles,
    roleStems,
    // Words close enough to a command word to be a typo of it (6 letters or more, never a filler:
    // "night" is not a typo of "light").
    fuzzy: [...roles].filter(([key, value]) => key.length >= 6 && value.role !== "filler"),
    exact: new Map((spec.exact || []).map(([entry, role]) => [entry, { role }])),
    numbers,
    adjectives,
    halves: foldedSet(spec.halves),
    halfAnd: foldedSet(spec.halfAnd),
    halfArticle: spec.halfArticle || null,
    tensAnd: Boolean(spec.tensAnd),
    at: foldedSet(spec.at),
    atPairs: new Set((spec.atPairs || []).map((pair) => list(pair).map(fold).join(" "))),
    target: foldedSet(spec.target),
    byWords: foldedSet(spec.byWords),
    dim: foldedSet(spec.dim),
    make: foldedSet(spec.make),
    put: foldedSet(spec.put),
    feelMarkers: foldedSet(spec.feelMarkers),
    stateMarkers: foldedSet(spec.stateMarkers),
    modeAfter: foldedSet(spec.modeAfter),
    moreFeel: spec.moreFeel,
    moreLevel: Boolean(spec.moreLevel),
    adjectiveBefore: Boolean(spec.adjectiveBefore),
    stillMore: foldedSet(spec.stillMore),
    fractionNeedsUnit: Boolean(spec.fractionNeedsUnit),
    upDownLight: Boolean(spec.upDownLight),
    upDownClimate: Boolean(spec.upDownClimate),
    separators: foldedSet(spec.separators),
    leads: foldedSet(spec.leads),
    then: foldedSet(spec.then),
    verbs: foldedSet(spec.verbs),
    room: foldedSet(spec.room),
    pronouns: new Map((spec.pronouns || []).flatMap(([words, plural]) => list(words).map((entry) => [fold(entry), plural]))),
    pronounOf: foldedSet(spec.pronounOf),
    // Longest first: "las" before "la".
    clitics: list(spec.clitics).map(fold).sort((a, b) => b.length - a.length),
    cliticE: Boolean(spec.cliticE),
  };
}

const LEXICONS = { base: lexicon(ENGLISH_HEBREW), es: lexicon(SPANISH), it: lexicon(ITALIAN) };
// Which words a sentence is read with, in turn: the app's language first, then English and Hebrew.
const READINGS = { es: [LEXICONS.es, LEXICONS.base], it: [LEXICONS.it, LEXICONS.base] };

// The user's names count in every reading, in any language. A word of a name that is a kind of
// device or a filler need not be said ("Porch light" by "porch", "Luces del techo" by "techo"): in
// English and Hebrew, and in Spanish or Italian too when the sentence is read in that language (so
// an English or Hebrew home's names are matched as in 1.9.0).
for (const lex of [LEXICONS.es, LEXICONS.it]) {
  lex.nameRoles = new Map([...lex.roles, ...LEXICONS.base.roles]);
  lex.nameRoleStems = new Map([...lex.roleStems, ...LEXICONS.base.roleStems]);
}
LEXICONS.base.nameRoles = LEXICONS.base.roles;
LEXICONS.base.nameRoleStems = LEXICONS.base.roleStems;

// A number with ב or מ in front ("ב-7", "בשבע", "ב-20%", "מ-7") is a time or a change by that
// much, never a level.
const AT_PREFIX = /^[וש]?[במ]$/;
const FILLER = { role: "filler" };
// What a sentence does, as verbs: the verb of one part counts for another that says none.
const DOING = new Set(["on", "off", "open", "close", "up", "down", "stop", "start", "run", "play", "pause", "next"]);
const ACTING = new Set([...DOING, "volume", "speed", "level", "rel"]);

// ---- numbers -------------------------------------------------------------------------------

// A number word, and the prefixes said before it ("בשבע": ב).
function numberWord(token, lex) {
  if (!token || token.num !== null) return null;
  for (const form of token.bares) {
    const found = lex.numbers.get(form);
    if (found) return { ...found, prefix: token.raw.slice(0, token.raw.length - form.length) };
  }
  return null;
}

const isHalf = (token, lex) => Boolean(token) && token.bares.some((form) => lex.halves.has(form));
// A unit after a number: percent, degrees, or a fan's speeds ("one speed up", 1.11.0).
const isUnit = (token, lex) => Boolean(token?.bares.some((form) => ["percent", "degrees", "speed"].includes(lex.roles.get(form)?.role)));

// The number that starts at tokens[index] (digits, or words: "twenty three", "עשרים ושלוש",
// "שלוש עשרה", "treinta y cinco", "ventitré", "23 and a half", "23 וחצי", "23 y medio", "22 e
// mezzo", 1.11.0: "a quarter", "three quarters", "רבע", "un cuarto", "tre quarti"), and where it
// ends; null when none starts there.
function readNumber(tokens, index, names, lex) {
  const first = tokens[index];
  let value = null;
  let prefix = "";
  let end = index + 1;
  if (first.num !== null) {
    value = first.num;
  } else {
    // A number word that is also in a name stays a word ("שני", a name too).
    const found = names.has(first.stem) ? null : numberWord(first, lex);
    if (!found) return null;
    const next = numberWord(tokens[end], lex);
    if (found.type === "half") return { value: 50, end, prefix: found.prefix, half: true };
    // A quarter alone ("to a quarter", "לרבע"); in Spanish and Italian only after a number ("un
    // cuarto", "tre quarti"): alone, "cuarto" is a room and "quarto" the fourth.
    if (found.type === "fraction") return lex.fractionNeedsUnit ? null : { value: found.value, end, prefix: found.prefix };
    value = found.value;
    prefix = found.prefix;
    const after = lex.tensAnd && lex.halfAnd.has(tokens[end]?.raw) ? numberWord(tokens[end + 1], lex) : null;
    if (found.type === "unit" && next?.type === "fraction" && found.value > 0 && found.value < 4) {
      // "Three quarters", "שלושה רבעים", "un cuarto", "tres cuartos", "tre quarti".
      value *= next.value;
      end += 1;
    } else if (found.type === "tens" && next?.type === "unit" && next.value > 0) {
      value += next.value;
      end += 1;
    } else if (found.type === "tens" && after?.type === "unit" && after.value > 0) {
      value += after.value;
      end += 2;
    } else if (found.type === "unit" && next?.type === "ten") {
      value += 10;
      end += 1;
    } else if (found.type === "unit" && next?.type === "hundred") {
      value *= 100;
      end += 1;
    } else if (found.type === "unit" && !isUnit(tokens[end], lex)) {
      // "One of the lights", "שתי מנורות", "una luz": a word from one to nine is a number only
      // with its unit ("five percent", "dos grados"); digits always are.
      return null;
    }
  }
  // "and a half", "וחצי", "y medio", "e mezzo"
  const and = lex.halfAnd.has(tokens[end]?.raw) ? 1 : 0;
  const a = lex.halfArticle && tokens[end + and]?.raw === lex.halfArticle ? 1 : 0;
  if (isHalf(tokens[end + and + a], lex) && (and || tokens[end].raw.startsWith("ו"))) {
    value += 0.5;
    end += and + a + 1;
  }
  return { value, end, prefix };
}

// A number right after a word for a time ("at 7", "in 5", "a las 7", "alle 7", "dentro de 5").
function atBefore(words, index, lex) {
  const before = words[index - 1];
  if (!before) return false;
  if (lex.at.has(before.raw)) return true;
  const two = words[index - 2];
  return Boolean(two) && lex.atPairs.has(`${two.raw} ${before.raw}`);
}

// The sentence as tokens: words and numbers. A number says `at`: "by" with ב or מ in front of it
// ("ב-7", "בעשר", "ב-20%": a time or a change by that much), "at" after at, in, for, until, עד, a
// las, alle… (a time, unless a unit follows: "at 50%").
function tokenize(text, names, lex) {
  const words = split(text).map((display) => word(display));
  const tokens = [];
  for (let index = 0; index < words.length; ) {
    const number = readNumber(words, index, names, lex);
    if (number) {
      const display = words.slice(index, number.end).map((item) => item.display).join(" ");
      const before = words[index - 1];
      const prefix = AT_PREFIX.test(number.prefix) ? number.prefix : before && AT_PREFIX.test(before.raw) ? before.raw : null;
      // "At a quarter" is a time too (1.11.0: "at a quarter to seven").
      const article = Boolean(lex.halfArticle) && before?.raw === lex.halfArticle;
      const at = prefix ? "by" : atBefore(words, index, lex) || (article && atBefore(words, index - 1, lex)) ? "at" : null;
      // `byPrefix`: ב ("by 2 degrees" with a change by a step) or מ ("from": never an amount).
      tokens.push({ ...word(display), raw: `#${number.value}`, stem: "", bares: [], stems: [], num: number.value, digits: words[index].num !== null && number.end === index + 1, at, byPrefix: prefix ? prefix.slice(-1) : null, half: Boolean(number.half) });
      index = number.end;
    } else {
      // A number word kept as a word still matches a number in a name ("Bedroom two"); with ב or
      // מ in front ("בשבע"), or after a word for a time ("a las siete", "alle sette"), it is a
      // time, unless it is in a name ("בשני").
      // "Cuarto", "quarto" alone are a room and the fourth, not a quarter (1.11.0).
      const spoken = numberWord(words[index], lex);
      const found = spoken?.type === "fraction" && lex.fractionNeedsUnit ? null : spoken;
      // "En un 25%": before a number, "un" is "a", not one (o'clock is "la una": "a la una 20%").
      const article = words[index].raw === "un" && words[index + 1]?.num != null && lex.at.has(words[index - 1]?.raw);
      const atWord = Boolean(found && !article && (AT_PREFIX.test(found.prefix) || atBefore(words, index, lex)));
      tokens.push(found && found.type !== "half" ? { ...words[index], wordNum: found.value, atWord } : found ? { ...words[index], atWord } : words[index]);
      index += 1;
    }
  }
  return tokens;
}

// ---- comparing names ------------------------------------------------------------------------

// Optimal string alignment distance (a swap of two letters is one), or more than `limit`.
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before = null;
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], before[j - 2] + 1);
    }
    before = previous;
    previous = row;
  }
  return previous[b.length];
}

// Typos allowed: none in words of three letters or fewer, one from four, two from eight.
function typosAllowed(a, b) {
  const length = Math.min(a.length, b.length);
  return length >= 8 ? 2 : length >= 4 ? 1 : 0;
}

function closeEnough(a, b) {
  const limit = typosAllowed(a, b);
  return limit > 0 && distance(a, b, limit) <= limit;
}

function roleOf(token, names, lex) {
  if (token.num !== null) return null;
  // "בשבע", "בעשר", "a las siete": at seven, at ten.
  if (token.atWord && !token.bares.some((form) => names.has(stem(form)))) return { role: "time" };
  // A word known by its accent ("è", is; "e", and).
  const exact = lex.exact.get(token.display.toLowerCase());
  if (exact) return exact;
  for (const [index, form] of token.bares.entries()) {
    // With its prefixes off, a command word of three letters or more ("בבוקר" is not "קר"), and
    // כל ("בכל הבית").
    if (index > 0 && form.length < 3 && form !== "כל") continue;
    const found = lex.roles.get(form) || lex.roleStems.get(stem(form));
    if (found) return found;
  }
  // Never a word of one of the names: a verb with its pronouns ("apágalas"), a typo of one letter
  // in a command word ("ligths"; "deactivate" is two from "activate": not a typo of it).
  if (names.has(token.stem)) return null;
  const verb = withPronouns(token.raw, lex);
  if (verb) return verb;
  if (token.raw.length < 6) return null;
  for (const [key, value] of lex.fuzzy) {
    if (distance(token.raw, key, 1) <= 1) return value;
  }
  return null;
}

// A Spanish or Italian verb with the pronouns it takes at its end, one or two: "apágalas",
// "ciérralas", "ponlo", "pónmelo", "spegnile", "chiudile", "spegnerla". Only a verb (what to do,
// or one of the verbs that set), never another word that happens to end so.
function withPronouns(raw, lex, depth = 0) {
  if (!lex.clitics.length || depth > 1 || !/^[a-z]+$/.test(raw)) return null;
  for (const clitic of lex.clitics) {
    if (!raw.endsWith(clitic) || raw.length - clitic.length < 3) continue;
    const rest = raw.slice(0, -clitic.length);
    for (const form of lex.cliticE ? [rest, `${rest}e`] : [rest]) {
      const found = lex.roles.get(form);
      if (found && (DOING.has(found.role) || found.role === "level" || found.role === "rel" || lex.verbs.has(form))) return found;
    }
    const twice = withPronouns(rest, lex, depth + 1);
    if (twice) return twice;
  }
  return null;
}

// How well a word of a name matches a word said: 1 the same, 0.95 another form (plural), 0.9
// with a Hebrew prefix or another Hebrew spelling (חנייה for חניה), 0.75 a small typo (never
// against a command word; also the other Hebrew plural, בנים for בנות), 0 not at all.
function quality(part, token, exactOnly) {
  if (token.num !== null) return part.num !== null && part.num === token.num ? 1 : 0;
  if (part.num !== null) return token.wordNum === part.num ? 1 : 0;
  if (part.raw === token.raw) return 1;
  if (exactOnly) return part.bares.some((form) => token.bares.includes(form)) ? 0.9 : 0;
  if (sameForm(part.raw, token.raw)) return 0.95;
  if (part.bares.some((form) => token.bares.some((said) => sameForm(form, said)))) return 0.9;
  if (token.role) return 0;
  const spelled = part.bares.flatMap((form) => token.bares.map((said) => spelling(form, said)));
  if (spelled.includes("sure")) return 0.9;
  if (spelled.includes("typo") || token.stems.some((form) => closeEnough(part.stem, form))) return 0.75;
  // The other Hebrew plural of the same word.
  if (part.bares.some((form) => token.bares.some((said) => stem(form) === stem(said)))) return 0.75;
  return 0;
}

// ---- the catalog ----------------------------------------------------------------------------

const KIND_OF = { light: "light", thermostat: "climate", blind: "blind", fan: "fan", music: "music", relay: "door", doorbell: "door" };

// A name as words. In a device's or room's name, words for kinds of devices and fillers ("Porch
// light", "חדר שינה") need not be said; a name made only of such words ("Light", "מזגן") must be
// said word for word, and only with its room.
function nameParts(name, type, lex) {
  const parts = split(name)
    .map((display) => word(display, true))
    .map((part) => ({ ...part, role: part.num !== null ? null : lex.nameRoles.get(part.raw) || lex.nameRoleStems.get(part.stem) || null }));
  for (const part of parts) {
    part.optional = part.role ? part.role.role === "filler" || (type !== "scene" && part.role.role === "kind") : false;
  }
  let exactOnly = false;
  if (parts.length && parts.every((part) => part.optional)) {
    exactOnly = true;
    const kinds = parts.filter((part) => part.role?.role === "kind");
    for (const part of kinds.length ? kinds : parts) part.optional = false;
  }
  return { parts, exactOnly, required: parts.filter((part) => !part.optional).length };
}

// A catalog's names as each language reads them (a catalog is made per command: commands.js).
const prepared = new WeakMap();

function prepare(catalog, lex) {
  if (!prepared.has(catalog)) prepared.set(catalog, new Map());
  const cache = prepared.get(catalog);
  if (cache.has(lex)) return cache.get(lex);
  const entities = [];
  for (const room of catalog.rooms || []) {
    for (const name of new Set((room.names || []).filter(Boolean))) entities.push({ type: "room", room, ...nameParts(name, "room", lex) });
  }
  for (const device of catalog.devices || []) {
    if (device.name) entities.push({ type: "device", device, kind: KIND_OF[device.kind], ...nameParts(device.name, "device", lex) });
  }
  for (const scene of catalog.scenes || []) {
    if (scene.name) entities.push({ type: "scene", scene, ...nameParts(scene.name, "scene", lex) });
  }
  const names = new Set(entities.flatMap((entity) => entity.parts.map((part) => part.stem)));
  const value = { entities, names };
  cache.set(lex, value);
  return value;
}

// The best way the entity's name lies in the sentence: which tokens, how well, whether all of it.
// Only the words that must be said are placed (a name's kind and fillers may be left over: they
// mean the same there), each at one of its four best places, so a long name stays quick.
function matchEntity(entity, tokens) {
  const parts = entity.parts.filter((part) => !part.optional);
  const candidates = parts.map((part) =>
    tokens
      .map((token, position) => [position, quality(part, token, entity.exactOnly)])
      .filter(([, q]) => q > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
  );
  if (!candidates.some((list) => list.length)) return null;
  let best = null;
  const used = [];
  // A name of many words that each appear often stops looking after this many steps.
  let steps = 0;
  const walk = (index, score, sure) => {
    steps += 1;
    if (steps > 5000) return;
    if (index === parts.length) {
      if (!used.length) return;
      const full = used.length === parts.length;
      const rank = (full ? 100 : 0) + score;
      if (!best || rank > best.rank) best = { rank, full, score, sure, positions: used.map(([position]) => position) };
      return;
    }
    for (const [position, q] of candidates[index]) {
      if (used.some(([taken]) => taken === position)) continue;
      used.push([position, q]);
      walk(index + 1, score + q, sure || (q >= 0.9 && parts[index].num === null));
      used.pop();
    }
    walk(index + 1, score, sure);
  };
  walk(0, 0, false);
  if (!best) return null;
  // A name said only with a typo in a word under six letters (Dana for Dina, בנים for בנות): one
  // letter there is often another name, so it is asked ("Did you mean"), never done.
  // So is one with the other ending of gender (niñas for niños, bambine for bambini).
  const unsure = best.full && !best.sure && parts.some((part, index) => {
    const token = tokens[best.positions[index]];
    return part.num === null && (part.raw.length < 6 || otherEnding(part.raw, token.raw)) && quality(part, token, entity.exactOnly) < 0.9;
  });
  if (!best.full) {
    // Part of a name: never by a typo or a number alone, never only by command words, never a name
    // said word for word.
    if (entity.exactOnly || !best.sure || !best.positions.some((position) => !tokens[position].role && tokens[position].num === null)) return null;
  }
  // A word of the name that need not be said, said with a typo ("porch ligth"), is the name's too.
  const positions = new Set(best.positions);
  for (const part of entity.parts) {
    if (!part.optional) continue;
    const position = tokens.findIndex((token, index) => !positions.has(index) && !token.role && token.num === null && quality(part, token, false) > 0);
    if (position >= 0) positions.add(position);
  }
  return { entity, full: best.full, unsure, score: best.score, positions, required: new Set(best.positions) };
}

// Where a room's name is said: its words matched, and those that need not be said when said right
// before them ("room 12", "habitación 2", "בחדר 2").
function withWordsBefore(match, tokens) {
  const positions = new Set(match.positions);
  for (const position of [...positions].sort((a, b) => b - a)) {
    for (let before = position - 1; before >= 0 && !positions.has(before); before -= 1) {
      if (!match.entity.parts.some((part) => part.optional && quality(part, tokens[before], false) >= 0.9)) break;
      positions.add(before);
    }
  }
  return positions;
}

// A name with a word for "don't", a time or a feeling in it ("Mañana", "Buenas noches", "Lámpara
// de noche", "אור חם") is that name only said whole: each of its words but fillers, in its order,
// with only fillers between. Otherwise the word says what it says ("apaga las luces por la noche").
function saidWhole(match, tokens) {
  const refusing = [...match.positions].filter((position) => tokens[position].num === null && refusalOf(tokens, position));
  if (!refusing.length) return true;
  const words = match.entity.parts.filter((part) => part.role?.role !== "filler");
  for (let start = 0; start < tokens.length; start += 1) {
    const run = [];
    let position = start;
    for (const part of words) {
      if (run.length) while (position < tokens.length && tokens[position].role?.role === "filler" && !quality(part, tokens[position], match.entity.exactOnly)) position += 1;
      if (position >= tokens.length || !quality(part, tokens[position], match.entity.exactOnly)) break;
      run.push(position);
      position += 1;
    }
    if (run.length === words.length && refusing.every((position) => run.includes(position))) return true;
  }
  return false;
}

// ---- what the sentence asks ------------------------------------------------------------------

const MAX_OPTIONS = 6;
const TIE = 0.05;
// A change by a step: lights 20 points, the AC 1°, the music 10, unless an amount is said
// ("by 30%", "2 degrees warmer"); the AC at most 10° at once. 1.11.0: blinds 20 points of their
// position, a fan one of its own speeds (or the speeds said, "two speeds faster": at most 4).
const LIGHT_STEP = 20;
const DEGREE_STEP = 1;
const MUSIC_STEP = 10;
const MAX_DEGREE_STEP = 10;
const BLIND_STEP = 20;
const FAN_STEP = 1;
const MAX_FAN_STEP = 4;

function devicesOf(catalog, kind, roomId = undefined) {
  return (catalog.devices || []).filter((device) => KIND_OF[device.kind] === kind && (roomId === undefined || device.room === roomId));
}

const action = (type, fields) => ({ status: "ok", action: { type, room: null, device: null, ...fields } });
const problem = (code, fields = {}) => ({ status: "problem", problem: code, ...fields });

// A number that is a time or a change by an amount ("at 7", "ב-7", "ב-20%"), not a level.
function timeNumber(tokens, position) {
  const token = tokens[position];
  if (token.at === "by") return true;
  if (token.at !== "at" || token.half) return false;
  return !["percent", "degrees"].includes(tokens[position + 1]?.role?.role);
}

// A number said after "to" ("a 23", "al 30%", "hasta el 60%", "ל-30"): a level, a position or a
// temperature, never a step's amount.
function afterTarget(tokens, position, lex) {
  const before = tokens[position - 1];
  if (!before) return false;
  if (lex.target.has(before.raw)) return true;
  return before.role?.role === "filler" && lex.target.has(tokens[position - 2]?.raw);
}

// What makes a sentence not a command to do now, at that word: "not" (don't, אל), "time" (a time,
// a change by an amount), "feel" (I'm cold, חם לי); null for any other word.
function refusalOf(tokens, position) {
  const token = tokens[position];
  if (token.carried) return null;
  if (token.num !== null) return timeNumber(tokens, position) ? "time" : null;
  const role = token.role?.role;
  return role === "not" || role === "time" || role === "feel" ? role : null;
}

const isDim = (token, lex) => token.role?.role === "level" && token.bares.some((form) => lex.dim.has(form));
// Words that make a number with its unit an amount ("by 20%"): a step's words, up and down, "dim",
// and (1.11.0) open and close ("open the blinds by 20%").
const isMarker = (token, lex) => ["rel", "up", "down", "open", "close"].includes(token.role?.role) || isDim(token, lex);

// A change by a step, said with its words (1.10.0, ADR-066): "more light", "יותר חם", "a bit
// brighter", "dim … a bit", "by 20%", "ב-2 מעלות", "2 degrees warmer", "más luz", "más alta",
// "sube el aire dos grados", "alza la luce del 20%". The words that make it are given the role
// "rel" (a kind and a direction), an amount said with them is marked, and what is left of "more",
// "less", "a bit" and "by" stays a change by an amount that is not done. 1.11.0 (ADR-079): blinds
// and fans too ("open the blinds a bit", "close … a little more", "faster", "turn the fan up a
// bit", "más rápido"); a word that made a step for them is marked `stepWord`, so that a sentence
// they leave not understood (a door: "open the gate a bit") is still refused as a change by an
// amount (readPart).
function relativeRoles(tokens, lex) {
  for (const [position, token] of tokens.entries()) {
    const modifier = token.role?.modifier;
    if (modifier !== "more" && modifier !== "less") continue;
    const sign = modifier === "more" ? 1 : -1;
    const next = tokens[position + 1];
    // "more light", "פחות אור": right before a word for light.
    if (next?.role?.role === "kind" && next.role.kind === "light") {
      token.role = { role: "rel", kind: "light", dir: sign, comparative: true };
      continue;
    }
    // "Más brillo", "più luminosità": the light; "más volumen", "meno volume": the music.
    if (lex.moreLevel && next?.role?.role === "level" && !isDim(next, lex)) {
      token.role = { role: "rel", kind: "light", dir: sign, comparative: true };
      continue;
    }
    if (lex.moreLevel && next?.role?.role === "volume") {
      token.role = { role: "rel", kind: "music", dir: sign, comparative: true };
      continue;
    }
    // "Más alta", "più forte", "más oscuro", "más rápido", "יותר מהר" (and in Hebrew "מהר יותר"):
    // a comparative in two words.
    const adjacent = lex.adjectiveBefore ? [next, tokens[position - 1]] : [next];
    const word = adjacent.find((other) => other && lex.adjectives.has(other.raw));
    if (word) {
      const adjective = lex.adjectives.get(word.raw);
      token.role = { role: "rel", kind: adjective.kind, dir: sign * adjective.dir, comparative: true };
      word.role = FILLER;
      continue;
    }
    // "יותר חם", "קר יותר", "más frío", "più caldo": the AC warmer or cooler (a sentence that
    // names the AC: intent).
    const feel = lex.moreFeel === "hebrew" && !HEBREW.test(token.raw) ? null : [next, tokens[position - 1]].find((other) => other?.role?.role === "feel");
    if (feel) {
      token.role = { role: "rel", kind: "climate", dir: sign * (feel.role.mode === "heat" ? 1 : -1), comparative: true };
      feel.role = FILLER;
      continue;
    }
    // "Open the blinds more", "close … a little more", "abre más la persiana", "תפתח יותר את
    // התריס", "turn the fan up more" (1.11.0): the verb is the step. Never "less" ("open the
    // blinds less" is not clear).
    const step = modifier === "more" ? deviceStep(tokens) : null;
    if (step) {
      step.token.role = { role: "rel", kind: step.kind, dir: step.dir, comparative: true };
      token.role = FILLER;
      token.stepWord = true;
    }
  }
  // An amount: a number with its unit, said with "by" or ב ("by 20%", "ב-2 מעלות"; "un 20%", "en
  // 2 grados", "del 20%", "di 2 gradi"), or next to a comparative ("2 degrees warmer"), and only
  // with a word for a change by a step. In Spanish and Italian, degrees said right after up or
  // down are the step too ("sube el aire dos grados"): a temperature is said with "a" ("baja el
  // aire a 22"), and no AC is set to 2°. A fan's speeds right after up or down too ("one speed
  // up", "two speeds faster", 1.11.0).
  if (tokens.some((token) => isMarker(token, lex))) {
    const comparative = tokens.some((token) => token.role?.role === "rel" && token.role.comparative);
    const upOrDown = tokens.some((token) => token.role?.role === "up" || token.role?.role === "down");
    const upDown = lex.upDownClimate && upOrDown;
    for (const [position, token] of tokens.entries()) {
      if (token.num === null || token.carried) continue;
      const unit = tokens[position + 1]?.role?.role;
      const before = tokens[position - 1];
      // "By", "un", "del", "di": never a word of a time ("a la una 20%" keeps its time).
      const byWord = before?.role?.modifier === "by" || Boolean(before && lex.byWords.has(before.raw) && !before.atWord && before.role?.role !== "time");
      if (unit !== "percent" && unit !== "degrees" && unit !== "speed") {
        // An amount needs its unit ("alza il volume di 10", "sube la luz un 20", "brighter by 30"):
        // refused as a change by an amount, never a level of 10 (1.10.0).
        if (byWord && token.at === null) token.at = "by";
        continue;
      }
      const byPrefix = token.at === "by" && token.byPrefix === "ב";
      // In Spanish and Italian a number with its unit right after up or down, with no "a" or "al"
      // before it, is the step: "baja el aire dos grados", "sube la luz de la cocina 20%" (a level
      // is said with "a": "sube la luz al 80%", "hasta el 60%").
      const near = token.at === null && !afterTarget(tokens, position, lex) && (comparative || (upDown && (unit === "degrees" || lex.upDownLight)) || (upOrDown && unit === "speed"));
      if (!byWord && !byPrefix && !near) continue;
      token.amount = unit;
      // With ב alone ("ב-20%"), which is "at" as often as "by", only for a step's own words (1.11.0).
      token.amountPrefix = byPrefix && !byWord && !near;
      token.stepWord = true;
      tokens[position + 1].amountUnit = true;
      if (byWord) before.role = FILLER;
      // "Dim the lights by 20%": dimmer by that much.
      for (const other of tokens) if (isDim(other, lex)) other.role = { role: "rel", kind: "light", dir: -1, comparative: true };
    }
  }
  // "A bit", "a little", "קצת": with a change by a step ("a bit brighter"), or "dim" ("dim the
  // lights a bit").
  // In Spanish and Italian also with up or down and the light, the music or the temperature said
  // ("baja un poco la luz", "alza un po' la musica"). In every language (1.11.0) with open, close,
  // up or down for the blinds ("open the blinds a bit", "sube un poco la persiana", "תפתח קצת את
  // התריס") and up or down for a fan ("turn the fan up a bit"); "עוד קצת" is a bit more.
  for (const [position, token] of tokens.entries()) {
    if (token.role?.modifier !== "bit") continue;
    if (!tokens.some((other) => other.role?.role === "rel")) {
      const dim = tokens.find((other) => isDim(other, lex));
      const upDown = lex.upDownLight ? tokens.find((other) => other.role?.role === "up" || other.role?.role === "down") : null;
      const kind = upDown ? bitKind(tokens) : null;
      const step = dim || kind ? null : deviceStep(tokens);
      if (dim) dim.role = { role: "rel", kind: "light", dir: -1, comparative: true };
      else if (kind) upDown.role = { role: "rel", kind, dir: upDown.role.role === "up" ? 1 : -1, comparative: false };
      else if (step) {
        step.token.role = { role: "rel", kind: step.kind, dir: step.dir, comparative: false };
        token.stepWord = true;
      } else continue;
    }
    token.role = FILLER;
    const before = tokens[position - 1];
    if (before && lex.stillMore.has(before.raw)) before.role = FILLER;
  }
  // How warm the user feels is never a change ("make it warmer for me", "יותר חם לי"), nor how
  // warm it is ("it's colder in the bedroom", "נהיה חם בסלון"): those are feelings, refused.
  // Without the AC said (AC, temperature, מזגן, aire) or "make" (haz, pon, fai, metti), warmer and
  // cooler are for one thermostat only (1.11.0, ADR-079): `unnamed` (intent).
  const feels = tokens.some((token) => lex.feelMarkers.has(token.raw));
  const saysAC = tokens.some((token) => token.role?.role === "kind" && token.role.kind === "climate");
  const unnamed = !(saysAC || tokens.some((token) => lex.make.has(token.raw)));
  const states = unnamed && tokens.some((token) => token.bares.some((form) => lex.stateMarkers.has(form)));
  for (const token of tokens) {
    if (token.role?.role !== "rel" || token.role.kind !== "climate") continue;
    if (feels || states) token.role = { role: "feel", mode: token.role.dir > 0 ? "heat" : "cool" };
    else if (unnamed) token.role = { ...token.role, unnamed: true };
  }
}

// The kinds a sentence names by their words: the light (also brightness), the music (also the
// volume), the temperature, the AC alone ("ac"), blinds, fans (also a speed), doors.
function kindsSaid(tokens) {
  const kinds = new Set();
  for (const token of tokens) {
    // "La del salón": the kind it stands for.
    const role = token.role?.role === "pronoun" && token.refers ? token.refers : token.role;
    if ((role?.role === "kind" && role.kind === "light") || role?.role === "level") kinds.add("light");
    else if ((role?.role === "kind" && role.kind === "music") || role?.role === "volume") kinds.add("music");
    else if (role?.role === "kind" && role.temperature) kinds.add("climate");
    else if (role?.role === "speed") kinds.add("fan");
    // The AC alone ("sube un poco el aire"): more cooling, or warmer? Not clear.
    else if (role?.role === "kind") kinds.add(role.kind === "climate" ? "ac" : role.kind);
  }
  return kinds;
}

// What "a bit" up or down is said of: the light, the music or the temperature, only one of them.
function bitKind(tokens) {
  const kinds = kindsSaid(tokens);
  const [kind] = kinds;
  return kinds.size === 1 && ["light", "music", "climate"].includes(kind) ? kind : null;
}

// A step for blinds or a fan, said with "a bit" or "more" (1.11.0): open, close, up or down with
// the blinds (by a word, or by a name or a room: no other kind said), up or down with a fan said.
// { token: the verb, kind, dir }, or null. Doors and gates never take a step (kindIntent).
function deviceStep(tokens) {
  const kinds = kindsSaid(tokens);
  const blinds = [...kinds].every((kind) => kind === "blind");
  const opener = tokens.find((token) => token.role?.role === "open" || token.role?.role === "close");
  if (opener) return blinds ? { token: opener, kind: "blind", dir: opener.role.role === "open" ? 1 : -1 } : null;
  const upDown = tokens.find((token) => token.role?.role === "up" || token.role?.role === "down");
  if (!upDown) return null;
  const dir = upDown.role.role === "up" ? 1 : -1;
  if (kinds.size === 1 && kinds.has("fan")) return { token: upDown, kind: "fan", dir };
  return blinds ? { token: upDown, kind: "blind", dir } : null;
}

// The words left over once the names are taken out: what they ask, or null when they contradict
// each other or say nothing this understands.
function summarize(tokens, taken, lex) {
  const summary = { lex, actions: new Set(), kinds: new Map(), modes: new Set(), units: new Set(), all: false, everything: false, numbers: [], ac: false, temperature: false, feel: false, rel: null, amount: null, make: false, put: false, hebrewUpDown: false, numberTo: false, roomWord: false, pronoun: null };
  for (const [position, token] of tokens.entries()) {
    if (taken.has(position)) continue;
    // A room carried from another part of the sentence need not be used.
    if (token.carried || token.amountUnit) continue;
    if (token.amount) {
      if (summary.amount) return null;
      summary.amount = { value: token.num, unit: token.amount, prefix: Boolean(token.amountPrefix) };
      continue;
    }
    if (refusalOf(tokens, position)) return null;
    if (token.num !== null) {
      summary.numbers.push(token.num);
      // Said with "to" ("al 30%"), not only after a verb ("sube la luz 30").
      summary.numberTo = token.at === "at" || afterTarget(tokens, position, lex);
      continue;
    }
    const role = token.role;
    if (!role) return null;
    if (lex.make.has(token.raw)) summary.make = true;
    if (lex.put.has(token.raw)) summary.put = true;
    if (role.role === "question") {
      summary.question = true;
    } else if (role.role === "kind") {
      summary.kinds.set(role.kind, (summary.kinds.get(role.kind) || false) || role.plural);
      if (role.ac) summary.ac = true;
      if (role.temperature) summary.temperature = true;
    } else if (["cool", "heat", "auto"].includes(role.role)) {
      summary.modes.add(role.role);
      if (role.feel) summary.feel = true;
    } else if (role.role === "percent" || role.role === "degrees") {
      summary.units.add(role.role);
    } else if (role.role === "all") {
      summary.all = true;
    } else if (role.role === "everything") {
      summary.everything = true;
    } else if (role.role === "pronoun") {
      // "La del salón": the kind it stands for, from the part before (readSeveral), or none.
      summary.pronoun = { refers: token.refers || null, plural: role.plural };
    } else if (role.role === "rel") {
      // Brighter and dimmer at once, or the lights and the AC: not one change.
      const before = summary.rel;
      if (before && (before.dir !== role.dir || (before.kind && role.kind && before.kind !== role.kind))) return null;
      // `unnamed`: warmer or cooler with no AC said (1.11.0).
      summary.rel = { kind: before?.kind || role.kind || null, dir: role.dir, comparative: Boolean(before?.comparative || role.comparative), unnamed: Boolean(before?.unnamed || role.unnamed) };
    } else if (role.role !== "filler") {
      summary.actions.add(role.role);
      // "תעלה את המזגן": in Hebrew, the AC up is warmer (in English "turn up the AC" is not clear).
      if ((role.role === "up" || role.role === "down") && HEBREW.test(token.raw)) summary.hebrewUpDown = true;
    }
  }
  // "Turn off the light on the porch", "open the gate on the porch": with another verb, an "on"
  // before a name or "the" is a preposition.
  // ("Turn on the kitchen lights and turn it off" is not "off": right after turn or switch, "on" is
  // what to do.)
  const preposition = (position) => {
    const next = tokens[position + 1];
    if (["turn", "switch"].includes(tokens[position - 1]?.raw)) return false;
    return next && (taken.has(position + 1) || ["the", "a", "an", "my", "our"].includes(next.raw));
  };
  if (summary.actions.has("on") && summary.actions.size > 1 && tokens.every((token, position) => taken.has(position) || token.role?.role !== "on" || preposition(position))) {
    summary.actions.delete("on");
  }
  if (summary.actions.has("level")) summary.actions.delete("on");
  if (summary.numbers.length > 1 || summary.modes.size > 1 || summary.units.size > 1) return null;
  // "Quella luce": with its kind said, "that" is only a word.
  if (summary.kinds.size) summary.pronoun = null;
  // A step to a level (1.11.0): "brighter to 80%", "louder to 40", "warmer to 23", "תגביר את האור
  // ל-80%": the level said with "to", as "kitchen lights to 80%" (the step's word says the kind).
  if (summary.rel && summary.numbers.length && summary.numberTo && !summary.amount) summary.rel = { ...summary.rel, level: true };
  return summary;
}

// The one thing the leftover words do: on, off, open, close, up, down, stop, start, run, play,
// pause, next; volume and level go with a number. null: none; false: two that contradict.
function verb(summary) {
  const main = [...summary.actions].filter((item) => item !== "volume" && item !== "level" && item !== "speed");
  if (main.length > 1) {
    // "run" and "start" say the same, as do "start" and "on".
    const same = new Set(main.map((item) => (item === "start" || item === "run" ? "start" : item)));
    if (same.size === 1) return "start";
    if (same.size === 2 && same.has("start") && same.has("on")) return "on";
    return false;
  }
  return main[0] || null;
}

// A temperature as the app sends it (0.5 steps; whole degrees when a thermostat is in °F, 1.10.2),
// or a problem when it is outside what the thermostats take (each in its own scale).
function temperatureFor(value, thermostats) {
  const fahrenheit = thermostats.some((device) => device.scale === "F");
  const rounded = fahrenheit ? Math.round(value) : Math.round(value * 2) / 2;
  for (const device of thermostats) {
    const min = Number.isFinite(device.min) ? device.min : device.scale === "F" ? 50 : 10;
    const max = Number.isFinite(device.max) ? device.max : device.scale === "F" ? 90 : 32;
    if (rounded < min || rounded > max) return problem("range", { device: { kind: device.kind, id: device.id }, min, max, unit: "degrees" });
  }
  return rounded;
}

const MODE_ORDER = ["cool", "heat", "auto"];

function modesOf(thermostats) {
  const all = new Set(thermostats.flatMap((device) => (device.modes || []).filter((mode) => mode !== "off")));
  return [...MODE_ORDER.filter((mode) => all.has(mode)), ...[...all].filter((mode) => !MODE_ORDER.includes(mode))];
}

const isOn = (thermostat) => Boolean(thermostat.mode) && thermostat.mode !== "off";

// On as it was (1.10.0, ADR-070): every thermostat that is off has a last mode to go back to
// (`last`, from the controller); with a temperature, one with heat and cool setpoints only to heat
// or cool (which setpoint), and none of them on in auto. Otherwise the mode is asked, as before.
function asItWas(targets, withTemperature = false) {
  const off = targets.filter((device) => !isOn(device));
  if (!off.length || !off.every((device) => typeof device.last === "string" && device.last !== "" && device.last !== "off")) return false;
  if (!withTemperature) return true;
  const settable = (mode) => mode === "heat" || mode === "cool";
  return off.every((device) => !device.dual || settable(device.last)) && targets.filter(isOn).every((device) => !device.dual || settable(device.mode));
}

// Which mode, for thermostats that are off: one option per mode they have; with a temperature and
// heat and cool setpoints, heat or cool (the setpoint the temperature is for).
function askMode(targets, where, ids, change) {
  const dual = "temperature" in change && targets.some((device) => device.dual);
  const modes = modesOf(targets).filter((mode) => !dual || mode === "cool" || mode === "heat");
  if (!modes.length) return problem("noMode", { device: where.device, mode: null });
  return { status: "ask", question: "mode", options: modes.map((mode) => action("climate", { ...where, ids, change: { mode, ...change } }).action) };
}

// The step of a change by a step: the amount said in its unit, or the usual step; null when the
// amount has another unit ("brighter by 2 degrees").
function stepOf(summary, unit, usual) {
  if (!summary.amount) return usual;
  return summary.amount.unit === unit ? summary.amount.value : null;
}

// One kind's devices: `targets` (the device named, those in the room, or all of the kind), and
// what is asked of them.
function kindIntent(kind, targets, where, summary, act) {
  const ids = targets.map((device) => device.id);
  const number = summary.numbers.length ? summary.numbers[0] : null;
  const unit = [...summary.units][0] || null;
  const named = where.device;
  const percent = (value) => (value < 0 || value > 100 ? problem("range", { min: 0, max: 100, unit: "percent", device: named }) : Math.round(value));
  const rel = summary.rel;
  // A change by a step: its words, or an amount said with ב or "by" (then only with them). A step's
  // word with a level said with "to" is that level (1.11.0: "brighter to 80%"), for its own kind.
  if (rel?.level && rel.kind && rel.kind !== kind) return null;
  const stepped = Boolean((rel && !rel.level) || summary.amount);

  if (kind === "light") {
    if (unit === "degrees" || summary.modes.size) return null;
    // "The lights" leave lights named for heating as they are, unless one is named (heaters.js,
    // ADR-066): `kept` says which, to say so.
    const kept = named ? [] : targets.filter(isHeater);
    const lights = named ? targets : targets.filter((device) => !isHeater(device));
    // A level or a step for a room's lights goes to its dimmers; `onOff` the lights that only turn on
    // and off, left as they are, to say so (1.10.3; 1.11.0).
    const lightAction = (list, change) => {
      const onOff = named || !("brightness" in change || "brightnessBy" in change) ? [] : lights.filter((device) => device.dimmable === false);
      return action("lights", { ...where, ids: list.map((device) => device.id), change, ...(kept.length ? { kept: kept.map((device) => device.id) } : {}), ...(onOff.length ? { onOff: onOff.map((device) => device.id) } : {}) });
    };
    const none = () => (kept.length ? problem("heatersOnly", { room: where.room }) : problem("none", { kind, room: where.room }));
    // "Sube la luz", "abbassa le luci": in Spanish and Italian a step brighter or dimmer (in
    // English, "raise the lights" is on).
    const upDown = summary.lex.upDownLight && !rel && (act === "up" || act === "down") && number === null;
    const step = upDown ? { kind: "light", dir: act === "up" ? 1 : -1, comparative: false } : rel;
    if (stepped || upDown) {
      if (!step || (step.kind && step.kind !== "light") || (act !== null && !upDown) || number !== null) return null;
      // "Increase", "תגביר": the light said.
      if (!step.kind && !(summary.kinds.has("light") || summary.actions.has("level") || named)) return null;
      const by = stepOf(summary, "percent", LIGHT_STEP);
      if (by === null) return null;
      if (!(by > 0 && by <= 100)) return problem("range", { min: 0, max: 100, unit: "percent", device: named });
      if (!lights.length) return none();
      const dimmable = lights.filter((device) => device.dimmable !== false);
      if (!dimmable.length) return problem("cannotDim", { device: named, room: where.room });
      return lightAction(dimmable, { brightnessBy: step.dir * Math.round(by) });
    }
    if (act === "off") {
      if (number !== null) return null;
      if (!lights.length) return none();
      return lightAction(lights, { on: false });
    }
    if (number !== null) {
      if (!["on", "start", "up", "down", null].includes(act)) return null;
      // "Sube la luz 30": up is a step in Spanish and Italian, so a number after it is not a
      // level unless said with "a" or "al" ("sube la luz al 30%"); nor a step without its unit.
      if (summary.lex.upDownLight && (act === "up" || act === "down") && !summary.numberTo) return null;
      const level = percent(number);
      if (typeof level !== "number") return level;
      if (!lights.length) return none();
      if (level === 0) return lightAction(lights, { on: false });
      const dimmable = lights.filter((device) => device.dimmable !== false);
      if (!dimmable.length) return problem("cannotDim", { device: named, room: where.room });
      return lightAction(dimmable, { brightness: level });
    }
    if (summary.actions.has("level")) return problem("needLevel", { kind });
    if (act === "on" || act === "start" || act === "up") {
      if (!lights.length) return none();
      return lightAction(lights, { on: true });
    }
    return act === null ? problem("needWhat", { kind, room: where.room, device: named }) : null;
  }

  if (kind === "climate") {
    if (unit === "percent") return null;
    // Warmer or cooler: "warmer", "יותר חם", "תעלה את המזגן", by a degree or as said. Up and down
    // in Hebrew with the AC said, in Spanish and Italian with the temperature or the degrees said
    // ("sube la temperatura", "baja el aire dos grados"; "sube el aire" alone is not clear).
    const upDown = (act === "up" || act === "down") && (summary.hebrewUpDown || (summary.lex.upDownClimate && (summary.temperature || summary.amount?.unit === "degrees")));
    if (stepped || (upDown && number === null)) {
      if (rel ? rel.kind !== "climate" || act !== null : !upDown) return null;
      if (number !== null || summary.modes.size) return null;
      // A comparative with the AC said (by a word or its name) or "make"; since 1.11.0 without them
      // too (`unnamed`) for the one thermostat of a room or of the home (intent): how it is ("it's
      // warmer in the bedroom") or how one feels is refused before (relativeRoles).
      if (rel && !(summary.kinds.has("climate") || summary.named || summary.make || rel.unnamed)) return null;
      const step = stepOf(summary, "degrees", DEGREE_STEP);
      if (step === null) return null;
      if (!(step > 0 && step <= MAX_DEGREE_STEP)) return problem("step", { max: MAX_DEGREE_STEP });
      const dir = rel ? rel.dir : act === "up" ? 1 : -1;
      // Only an AC that is on has a setpoint to move.
      const running = targets.filter(isOn);
      if (!running.length) return problem("isOff", { device: named, room: where.room });
      const onIds = running.map((device) => device.id);
      // Whole degrees when an AC is in °F (1.10.2), 0.5 otherwise.
      const fahrenheit = running.some((device) => device.scale === "F");
      const change = { temperatureBy: dir * (fahrenheit ? Math.max(1, Math.round(step)) : Math.round(step * 2) / 2) };
      // With heat and cool setpoints in auto: which one.
      if (running.some((device) => device.dual && device.mode !== "heat" && device.mode !== "cool")) {
        return { status: "ask", question: "setpoint", options: ["cool", "heat"].map((setpoint) => action("climate", { ...where, ids: onIds, change: { setpoint, ...change } }).action) };
      }
      return action("climate", { ...where, ids: onIds, change });
    }
    // "Turn off the heating" is the AC off too.
    if (act === "off") return number === null ? action("climate", { ...where, ids, change: { mode: "off" } }) : null;
    if (act && !["on", "start", "up", "down"].includes(act)) return null;
    if ((act === "up" || act === "down") && number === null) return null;
    const mode = [...summary.modes][0] || null;
    if (mode) {
      const lacking = targets.find((device) => !(device.modes || []).includes(mode));
      if (lacking) return problem("noMode", { device: { kind: lacking.kind, id: lacking.id }, mode });
    }
    if (number !== null) {
      const temperature = temperatureFor(number, targets);
      if (typeof temperature !== "number") return temperature;
      if (mode && mode !== "heat" && mode !== "cool" && targets.some((device) => device.dual)) {
        return { status: "ask", question: "setpoint", options: ["cool", "heat"].map((setpoint) => action("climate", { ...where, ids, change: { mode, setpoint, temperature } }).action) };
      }
      if (mode) return action("climate", { ...where, ids, change: { mode, temperature } });
      // Off, the thermostat needs a mode: its last one, else asked; with heat and cool setpoints
      // in auto, which setpoint.
      if (targets.some((device) => !isOn(device))) {
        if (asItWas(targets, true)) return action("climate", { ...where, ids, change: { asItWas: true, temperature } });
        return askMode(targets, where, ids, { temperature });
      }
      if (targets.some((device) => device.dual && device.mode !== "heat" && device.mode !== "cool")) {
        return { status: "ask", question: "setpoint", options: ["cool", "heat"].map((setpoint) => action("climate", { ...where, ids, change: { setpoint, temperature } }).action) };
      }
      return action("climate", { ...where, ids, change: { temperature } });
    }
    if (mode) return action("climate", { ...where, ids, change: { mode } });
    if (act === "on" || act === "start") {
      if (targets.every(isOn)) return problem("alreadyOn", { device: named, room: where.room, kind });
      // Each in its last mode, as it was; asked when one's is not known.
      if (asItWas(targets)) return action("climate", { ...where, ids, change: { asItWas: true } });
      return askMode(targets, where, ids, {});
    }
    return problem("needWhat", { kind, room: where.room, device: named });
  }

  if (kind === "blind") {
    if (unit === "degrees" || summary.modes.size) return null;
    // A step (1.11.0, ADR-079): "open the blinds a bit", "close … a little more", "raise the blinds
    // by 20%", "sube la persiana un 20%": 20 points of their position, or the percent said, from
    // where each one is; only blinds that stop between open and closed.
    if (stepped) {
      // "תעלה את התריס ב-20%": to 20%, or by 20%? Not clear (ב is "at" and "by" alike); "ב-20% יותר"
      // is a step.
      if (rel ? rel.kind !== "blind" : summary.amount?.prefix) return null;
      const dir = rel ? rel.dir : { open: 1, up: 1, close: -1, down: -1 }[act];
      if (!dir || (rel && act !== null) || number !== null) return null;
      const by = stepOf(summary, "percent", BLIND_STEP);
      if (by === null) return null;
      if (!(by > 0 && by <= 100)) return problem("range", { min: 0, max: 100, unit: "percent", device: named });
      const blinds = targets.filter((device) => device.position !== false);
      if (!blinds.length) return problem("noPosition", { device: named, room: where.room });
      return action("blinds", { ...where, ids: blinds.map((device) => device.id), change: { positionBy: dir * Math.round(by) } });
    }
    if (act === "stop") return number === null ? action("blinds", { ...where, ids, change: { stop: true } }) : null;
    let position = null;
    if (number !== null) {
      if (act && !["open", "close", "up", "down", "start", "on"].includes(act)) return null;
      position = percent(number);
      if (typeof position !== "number") return position;
    } else if (act === "open" || act === "up") position = 100;
    else if (act === "close" || act === "down") position = 0;
    else return act === null ? problem("needWhat", { kind, room: where.room, device: named }) : null;
    let blinds = targets;
    if (position > 0 && position < 100) {
      blinds = targets.filter((device) => device.position !== false);
      if (!blinds.length) return problem("noPosition", { device: named, room: where.room });
    }
    return action("blinds", { ...where, ids: blinds.map((device) => device.id), change: { position } });
  }

  if (kind === "fan") {
    if (summary.modes.size || summary.units.size) return null;
    // Faster or slower (1.11.0, ADR-079): "faster", "slower", "turn the fan up", "speed up the fan",
    // "one speed up", "two speeds faster", "תגביר את המאוורר", "más rápido", "più veloce": one of
    // each fan's own speeds, or the speeds said (at most 4), from where each one is.
    const said = summary.kinds.has("fan") || summary.actions.has("speed") || summary.amount?.unit === "speed" || Boolean(named);
    const upDown = (act === "up" || act === "down") && said;
    if (stepped || upDown) {
      if (rel ? (rel.kind && rel.kind !== "fan") || (act !== null && !upDown) : !upDown) return null;
      if (number !== null || (rel && !rel.kind && !said)) return null;
      // "Turn the fan down faster": two ways at once.
      if (rel && upDown && rel.dir !== (act === "up" ? 1 : -1)) return null;
      const by = stepOf(summary, "speed", FAN_STEP);
      if (by === null || !Number.isInteger(by) || by < 1 || by > MAX_FAN_STEP) return null;
      const dir = rel ? rel.dir : act === "up" ? 1 : -1;
      // A fan that lists no speeds only turns on and off.
      const fans = targets.filter((device) => !Array.isArray(device.speeds) || device.speeds.length > 0);
      if (!fans.length) return problem("noSpeeds", { device: named, room: where.room });
      return action("fans", { ...where, ids: fans.map((device) => device.id), change: { speedBy: dir * by } });
    }
    if (number !== null) return null;
    if (act === "on" || act === "start") return action("fans", { ...where, ids, change: { on: true } });
    if (act === "off") return action("fans", { ...where, ids, change: { on: false } });
    return act === null ? problem("needWhat", { kind, room: where.room, device: named }) : null;
  }

  if (kind === "music") {
    if (unit === "degrees" || summary.modes.size) return null;
    // Louder or quieter: "louder", "תגביר את המוזיקה", "turn up the music", "volume down".
    const upDown = (act === "up" || act === "down") && (summary.actions.has("volume") || summary.kinds.has("music"));
    if (stepped || (upDown && number === null)) {
      if (rel ? (rel.kind && rel.kind !== "music") || act !== null : !upDown) return null;
      if (rel && !rel.kind && !(summary.kinds.has("music") || summary.actions.has("volume") || named)) return null;
      if (number !== null) return null;
      const step = stepOf(summary, "percent", MUSIC_STEP);
      if (step === null) return null;
      if (!(step > 0 && step <= 100)) return problem("range", { min: 0, max: 100, unit: "percent", device: named });
      const dir = rel ? rel.dir : act === "up" ? 1 : -1;
      return action("music", { ...where, ids, change: { volumeBy: dir * Math.round(step) } });
    }
    if (number !== null) {
      if (act && !["up", "down", "on", "start"].includes(act)) return null;
      // "Sube el volumen 10": not a volume of 10 (as the lights).
      if (summary.lex.upDownLight && (act === "up" || act === "down") && !summary.numberTo) return null;
      const volume = percent(number);
      if (typeof volume !== "number") return volume;
      return action("music", { ...where, ids, change: { volume } });
    }
    if (summary.actions.has("volume")) return problem("needLevel", { kind });
    // "Pon música", "metti la musica": play.
    const which = { play: "play", start: "play", on: "play", pause: "pause", stop: "pause", off: "pause", next: "next" }[act] || (act === null && summary.put ? "play" : null);
    if (which) return action("music", { ...where, ids, change: { action: which } });
    return act === null ? problem("needWhat", { kind, room: where.room, device: named }) : null;
  }

  if (kind === "door") {
    if (number !== null || summary.modes.size || stepped || (act !== "open" && act !== "start")) return null;
    // Only the doors and gates this user may open; each still gets its second tap.
    const doors = targets.filter((device) => device.canOpen);
    if (!doors.length) return problem("noDoors", { device: targets.length === 1 ? { kind: targets[0].kind, id: targets[0].id } : null });
    if (doors.length > MAX_OPTIONS) return problem("needRoom", { kind });
    const options = doors.map((device) => action("door", { device: { kind: device.kind, id: device.id } }).action);
    return doors.length === 1 ? { status: "ok", action: options[0] } : { status: "ask", question: "which", options };
  }
  return null;
}

// An AC, not floor heating or another thermostat that only heats (one that lists no modes may be
// either).
const isAC = (thermostat) => !(thermostat.modes || []).length || thermostat.modes.includes("cool");

// A room's thermostats (or the home's) for what was said: with "AC" (מזגן), those that cool; with
// a mode, those that have it ("cool the living room": its AC, not its floor heating).
function climateTargets(targets, summary, act) {
  let list = summary.ac ? targets.filter(isAC) : targets;
  const mode = [...summary.modes][0];
  if (mode && act !== "off") {
    const having = list.filter((device) => (device.modes || []).includes(mode));
    if (having.length) list = having;
  }
  return list;
}

// What one reading of the sentence (a target T and a room R, either may be null) asks; null when
// it does not make sense.
function intent(target, room, summary, catalog) {
  if (summary.question) return problem("question");
  const act = verb(summary);
  if (act === false) return null;
  const roomId = room ? room.entity.room.id : null;
  // "La del salón", "quella del soggiorno" (1.10.0): the kind said in the part before, in the room
  // said; or a device by its own words ("la de pie"). Never the room's All off, nor a scene.
  const pronoun = summary.pronoun;
  if (pronoun) {
    if (target?.entity.type === "scene") return null;
    if (target && (pronoun.refers ? pronoun.refers.kind !== target.entity.kind : !summary.named)) return null;
    if (!target) {
      if (!pronoun.refers) return null;
      summary.kinds.set(pronoun.refers.kind, pronoun.plural);
      if (pronoun.refers.ac) summary.ac = true;
      if (pronoun.refers.temperature) summary.temperature = true;
    }
  }
  // "Cold", "חם" are a mode only for the AC said ("מזגן על קר").
  if (summary.feel && !summary.kinds.has("climate") && target?.entity.kind !== "climate") return null;

  if (target?.entity.type === "scene") {
    if (summary.kinds.size || summary.modes.size || summary.numbers.length || summary.all || summary.everything || summary.rel || summary.amount || room || summary.roomWord) return null;
    if (act && !["run", "start", "on", "play"].includes(act)) return null;
    return action("scene", { id: target.entity.scene.id });
  }

  const kinds = [...summary.kinds.keys()];
  if (kinds.length > 1) return problem("oneAtATime");
  if (target) {
    const device = target.entity.device;
    if (kinds.length && kinds[0] !== target.entity.kind) return null;
    if (room && device.room !== roomId) return null;
    if (summary.all || summary.everything) return null;
    // Warmer or cooler with no AC said: a thermostat named by its own words ("VRF warmer"), not by
    // its room's ("warmer in the bedroom" is the room's, below).
    if (summary.rel?.unnamed && target.entity.kind === "climate" && !summary.named) return null;
    return kindIntent(target.entity.kind, [device], { room: null, device: { kind: device.kind, id: device.id } }, summary, act);
  }

  // "In the room", "in camera", "בחדר", no room's name with it: which room? Never the whole home
  // (1.10.0).
  if (!room && summary.roomWord) return problem("needRoom", { kind: kinds[0] || null });

  // No device named: the kind said, or what the words imply.
  let kind = kinds[0] || null;
  if (!kind && summary.rel?.kind) kind = summary.rel.kind;
  // "The heating", "החימום": thermostats, by their mode.
  const byMode = !kind && summary.modes.size > 0;
  if (!kind && summary.modes.size) kind = "climate";
  if (!kind && summary.units.has("degrees")) kind = "climate";
  // "Speed up", "one speed up": a fan (1.11.0).
  if (!kind && (summary.actions.has("speed") || summary.amount?.unit === "speed")) kind = "fan";
  if (!kind && (summary.actions.has("volume") || ["play", "pause", "next"].includes(act))) kind = "music";
  if (!kind && summary.actions.has("level")) kind = "light";
  if (!kind && room && ["open", "close", "up", "down", "stop"].includes(act)) {
    // Open and close are for blinds, stop also for music; open alone for a room's doors.
    if (devicesOf(catalog, "blind", roomId).length) kind = "blind";
    else if (act === "stop" && devicesOf(catalog, "music", roomId).length) kind = "music";
    else if (act === "open" && devicesOf(catalog, "door", roomId).length) kind = "door";
    else return problem("none", { kind: "blind", room: roomId });
  }

  if (!kind) {
    if (summary.numbers.length || summary.rel || summary.amount) return room && summary.numbers.length ? problem("needWhat", { room: roomId }) : null;
    if (act === "off") {
      if (room) return action("roomOff", { room: roomId });
      if (summary.all || summary.everything) return action("offAll", { filters: ["lights", "climate"] });
      return problem("needRoom", { kind: null });
    }
    if (room && (act === "on" || act === "start")) return problem("needWhat", { room: roomId });
    if (!room && (summary.all || summary.everything) && (act === "close" || act === "down")) return action("offAll", { filters: ["blinds"] });
    return null;
  }
  if (summary.everything) return null;

  let targets = devicesOf(catalog, kind, room ? roomId : undefined);
  if (kind === "climate" && targets.length) {
    targets = climateTargets(targets, summary, act);
    if (!targets.length) return problem("none", { kind, room: roomId });
  }
  if (room) {
    if (!targets.length) return problem("none", { kind, room: roomId });
    // Warmer or cooler with no AC said (1.11.0, ADR-079): the room's one thermostat; of two or
    // more (an AC and floor heating), which one.
    if (kind === "climate" && summary.rel?.unnamed && targets.length > 1) return whichOne(kind, targets, summary, act);
    return kindIntent(kind, targets, { room: roomId, device: null }, summary, act);
  }
  // The whole home: Turn off all for lights, AC and blinds; otherwise one device of the kind, or
  // the ones to choose from. Lights named for heating are never "the light" (ADR-066).
  if (kind === "light" && targets.length) {
    const lights = targets.filter((device) => !isHeater(device));
    if (!lights.length) return problem("heatersOnly", { room: null });
    targets = lights;
  }
  if (!targets.length) return problem("none", { kind, room: null });
  if (targets.length === 1) {
    const device = targets[0];
    return kindIntent(kind, targets, { room: null, device: { kind: device.kind, id: device.id } }, summary, act);
  }
  const off = kind === "light" || kind === "climate" ? act === "off" : kind === "blind" ? act === "close" || act === "down" : false;
  if (off && !summary.numbers.length && !summary.rel && !summary.amount) {
    // "Turn off the heating", "תכבה את החימום": the AC, floor heating, or a heater wired as a light?
    // Which room; Turn off all for every thermostat only with "all" (1.10.0).
    if (byMode && !summary.all) return problem("needRoom", { kind });
    return action("offAll", { filters: [{ light: "lights", climate: "climate", blind: "blinds" }[kind]] });
  }
  // All of them at once is only Turn off all (above).
  if (summary.all) return problem("needRoom", { kind });
  if (kind === "door") return kindIntent(kind, targets, { room: null, device: null }, summary, act);
  // Several: ask which (each would get the same), or for the room when there are many.
  const each = targets.map((device) => kindIntent(kind, [device], { room: null, device: { kind: device.kind, id: device.id } }, summary, act));
  if (each.some((item) => !item)) return null;
  if (each.every((item) => item.status === "problem")) return each[0];
  if (kind === "light" || each.length > MAX_OPTIONS || each.some((item) => item.status !== "ok")) return problem("needRoom", { kind });
  return { status: "ask", question: "which", options: each.map((item) => item.action) };
}

// Which one of a room's devices: each that can do what was said is an option (none: why the first
// one cannot).
function whichOne(kind, targets, summary, act) {
  const each = targets.map((device) => kindIntent(kind, [device], { room: null, device: { kind: device.kind, id: device.id } }, summary, act));
  if (each.some((item) => !item)) return null;
  const options = each.filter((item) => item.status === "ok").map((item) => item.action);
  if (!options.length) return each[0];
  if (options.length > MAX_OPTIONS) return problem("tooMany");
  return { status: "ask", question: "which", options };
}

// What two results do, to tell readings that differ from readings that come to the same.
function effect(result) {
  if (result.status === "ok") {
    const { type, ids, change, id, device, room, filters } = result.action;
    return JSON.stringify([type, ids ? [...ids].sort() : null, change || null, id ?? null, type === "door" ? device : null, type === "roomOff" ? room : null, filters || null]);
  }
  if (result.status === "ask") return JSON.stringify(["ask", result.options.map((option) => effect({ status: "ok", action: option }))]);
  return JSON.stringify(["problem", result.problem]);
}

// ---- one sentence, or one part of it -----------------------------------------------------------

// The tokens of one thing said (a whole sentence, or one part with a room or a verb it takes from
// another part): what it asks.
function readPart(input, prepared) {
  const { entities, catalog, lex } = prepared;
  const tokens = input.map((token) => ({ ...token }));
  // "על קר", "to warm", "on cold", "en frío", "modo frío", "su freddo": a mode (the AC must be said
  // too: intent).
  for (const [position, token] of tokens.entries()) {
    if (token.role?.role === "feel" && lex.modeAfter.has(tokens[position - 1]?.raw)) token.role = { role: token.role.mode, feel: true };
  }
  relativeRoles(tokens, lex);

  const matches = entities.map((entity) => matchEntity(entity, tokens)).filter((match) => match && saidWhole(match, tokens));
  const rooms = [null, ...matches.filter((match) => match.entity.type === "room")];
  const targets = [null, ...matches.filter((match) => match.entity.type !== "room")];
  const kindWords = tokens.filter((token) => token.role?.role === "kind");
  const plural = kindWords.some((token) => token.role.plural) || tokens.some((token) => token.role?.role === "all");
  const carriedRoom = matches.find((match) => match.entity.type === "room" && match.full && [...match.positions].every((position) => tokens[position].carried));
  // Rooms said whole, with the words of their name that need not be said when said right before
  // ("habitación 2", "room 2", "בחדר 2").
  const saidRooms = matches.filter((match) => match.entity.type === "room" && match.full && !match.unsure).map((match) => ({ match, positions: withWordsBefore(match, tokens) }));
  // A device in another room named only by words of a room said with more than them ("Foco 2" in
  // the kitchen, for "la luz de la habitación 2"; "Kids lamp" for "the light in the kids room") is
  // not what is meant: the room is (1.10.0).
  const elsewhere = (target) =>
    target?.entity.type === "device" &&
    saidRooms.some(
      ({ match, positions }) =>
        match.entity.room.id !== target.entity.device.room &&
        [...target.required].every((position) => positions.has(position)) &&
        [...positions].some((position) => !target.positions.has(position) && tokens[position].num === null)
    );
  // A room's words that name, as well, a whole device of another room (a room "Termo" and the
  // heater "Termo" in the bathroom): said alone, neither is more likely, so it asks.
  const alsoDevice = (room) =>
    [...room.positions].some((position) => tokens[position].num === null) &&
    matches.some((match) => match.entity.type === "device" && match.full && !match.unsure && match.entity.device.room !== room.entity.room.id && match.positions.size === room.positions.size && [...room.positions].every((position) => match.positions.has(position)));

  const readings = [];
  for (const room of rooms) {
    for (const target of targets) {
      if (room && target && [...room.positions].some((position) => target.positions.has(position))) continue;
      if (elsewhere(target)) continue;
      // A device named only by its kind ("Light", "מזגן") is that device only in its room.
      if (target?.entity.exactOnly && target.entity.type === "device" && !room) continue;
      // A room carried from another part is that room: a device's name may take its words only
      // in it ("the island" after "kitchen…" is the Kitchen Island), a scene's never.
      if (target && [...target.positions].some((position) => tokens[position].carried)) {
        if (target.entity.type !== "device" || !carriedRoom || target.entity.device.room !== carriedRoom.entity.room.id) continue;
      }
      const taken = new Set([...(room?.positions || []), ...(target?.positions || [])]);
      const summary = summarize(tokens, taken, lex);
      if (!summary) continue;
      // "The room" said, and not as a word of the names read ("Quiet room", "חדר שקט"): which room?
      // (intent)
      summary.roomWord = tokens.some((token, position) => token.roomWord && !taken.has(position) && !token.carried && ![room, target].some((match) => match?.entity.parts.some((part) => part.optional && quality(part, token, false) >= 0.9)));
      // A device named by more than its room's words ("the living room AC", not "warmer in the
      // living room" for a thermostat called "Living room AC").
      summary.named = Boolean(target && !matches.some((match) => match.entity.type === "room" && match.full && [...target.positions].every((position) => match.positions.has(position))));
      const result = intent(target, room, summary, catalog);
      if (!result) continue;
      let score = 0;
      for (const match of [room, target]) if (match) score += match.score + (match.full ? 0.5 : 0);
      // "Kitchen lights" is the room's lights, "the kitchen light" a light of that name.
      if (room && !target && (plural || (!kindWords.length && !alsoDevice(room)))) score += 0.3;
      if (target?.entity.type === "device" && kindWords.some((token) => token.role.kind === target.entity.kind && !token.role.plural)) score += 0.3;
      readings.push({ result, score, partial: Boolean((room && (!room.full || room.unsure)) || (target && (!target.full || target.unsure))) });
    }
  }

  if (!readings.length) {
    const covered = new Set(matches.flatMap((match) => [...match.positions]));
    // Don't, a time, how warm one feels: refused, whatever else was said; also when a name has the
    // word ("apaga la isla mañana" with a scene "Mañana"): no reading used it (1.10.0).
    // A step for blinds or a fan that nothing took ("open the gate a bit": doors take none) is still
    // a change by an amount (1.11.0).
    const refusal = tokens.map((_token, position) => refusalOf(tokens, position)).find(Boolean) || (tokens.some((token) => token.stepWord) ? "time" : null);
    if (refusal) return { status: "unknown", words: [], refusal };
    // "La del salón" with no kind before it: those words are not understood.
    const lone = (token) => token?.role?.role === "pronoun" && !token.refers && !kindWords.length;
    const words = tokens
      .filter((token, position) => (!token.role || lone(token) || (token.pronounOf && lone(tokens[position - 1]))) && token.num === null && !token.carried && !covered.has(position))
      .map((token) => token.display);
    // Two rooms said at once.
    const fullRooms = matches.filter((match) => match.entity.type === "room" && match.full);
    if (!words.length && fullRooms.some((one) => fullRooms.some((other) => other.entity.room.id !== one.entity.room.id && ![...one.positions].some((position) => other.positions.has(position))))) {
      return problem("oneAtATime");
    }
    return { status: "unknown", words };
  }

  readings.sort((a, b) => b.score - a.score);
  const best = readings.filter((reading) => reading.score >= readings[0].score - TIE);
  const distinct = [];
  for (const reading of best) {
    if (!distinct.some((other) => effect(other.result) === effect(reading.result))) distinct.push(reading);
  }
  const partial = distinct.some((reading) => reading.partial);
  if (distinct.length === 1 && !partial) return distinct[0].result;
  const options = distinct.flatMap((reading) => (reading.result.status === "ok" ? [reading.result.action] : []));
  if (!options.length) return distinct[0].result;
  if (options.length > MAX_OPTIONS) return problem("tooMany");
  return { status: "ask", question: partial ? "partial" : "which", options, partial };
}

// ---- several things in one sentence (1.10.0, ADR-066) -------------------------------------------

// At most five things a sentence (three until 1.11.0).
export const MAX_PARTS = 5;
// What parts a sentence ("and", ",", "ואז", "וגם", "ואת", "y", "e", "poi": a language's
// `separators`), the words that may come before the next thing said ("and the blinds", "ואת
// התריסים": `leads`), and the verbs that start it ("and set the AC to 23": `verbs`).

// Whether a word is a word of a room's name, and of a device's or a scene's (said as it is, or
// with its prefixes or another form; no typos).
function nameKinds(token, entities) {
  const kinds = { room: false, thing: false };
  if (token.num !== null) return kinds;
  for (const entity of entities) {
    const which = entity.type === "room" ? "room" : "thing";
    if (kinds[which] || entity.exactOnly) continue;
    if (entity.parts.some((part) => !part.optional && quality(part, token, false) >= 0.9)) kinds[which] = true;
  }
  return kinds;
}

// A Hebrew word with ו in front that starts something new: the word without it ("ותסגרו",
// "והמזגן", "ומזגן"). Never a word that is itself a command word or a word of a name ("ורד",
// "וילון").
function andRest(token, names, lex) {
  const raw = token.raw;
  if (token.num !== null || !raw.startsWith("ו") || raw.length < 3) return null;
  if (lex.roles.has(raw) || lex.roleStems.has(stem(raw)) || names.has(token.stem)) return null;
  const rest = word(raw.slice(1));
  rest.role = roleOf(rest, names, lex);
  return rest;
}

// Something new starts at `from` (skipping "the", "את" and a room's name): a verb, a kind of
// device, or a word of a device's or a scene's name.
function startsSomething(tokens, from, end, rest, { entities, lex }) {
  for (let index = from; index < end; index += 1) {
    const token = index === from && rest ? rest : tokens[index];
    const role = token.role?.role;
    // A word for warm or cold too ("…, יותר קר", "…, más frío": a step, 1.11.0; or a feeling, which
    // refuses the sentence).
    if (role === "kind" || role === "feel" || ACTING.has(role) || token.bares?.some((form) => lex.verbs.has(form))) return true;
    const kinds = nameKinds(token, entities);
    if (kinds.thing && !kinds.room) return true;
    if (kinds.room || role === "filler" || role === "all" || role === "everything" || token.role?.modifier || lex.leads.has(token.raw)) continue;
    return false;
  }
  return false;
}

// A word that parts a sentence ("and", "y", "e", a comma): not one known by its accent (Italian "è",
// is, asks; "e" is "and").
function isSeparator(token, lex) {
  return lex.separators.has(token.raw) && !lex.exact.has(token.display.toLowerCase());
}

// A thing of its own: more than a verb ("and off"), and more than a room's name without one
// ("Kitchen," before "lights off"; "kitchen off" is one), even when a device's name has the word.
function hasContent(tokens, from, end, rest, { entities, lex }) {
  let room = false;
  let doing = false;
  for (let index = from; index < end; index += 1) {
    const token = index === from && rest ? rest : tokens[index];
    const role = token.role?.role;
    if (role === "filler" || isSeparator(token, lex) || lex.leads.has(token.raw)) continue;
    if (DOING.has(role)) {
      doing = true;
      continue;
    }
    if (!role && token.num === null && nameKinds(token, entities).room) {
      room = true;
      continue;
    }
    return true;
  }
  return room && doing;
}

// A separator inside a name said ("Rock and Roll", "סרט ומוזיקה") parts nothing.
function insideName(tokens, index, entities) {
  for (const entity of entities) {
    const { parts } = entity;
    if (parts.length < 2) continue;
    for (let start = Math.max(0, index - parts.length + 1); start < index; start += 1) {
      if (start + parts.length > tokens.length) break;
      if (parts.every((part, offset) => tokens[start + offset].raw === part.raw || quality(part, tokens[start + offset], false) >= 0.9)) return true;
    }
  }
  return false;
}

// The parts of a sentence: [{ tokens, text }]. A part starts after "and" (or a comma, ואז, וגם,
// ואת) or at a Hebrew word with ו in front, only where something new starts (a verb, a kind of
// device, a device's or a scene's name) and both sides say more than a room ("kitchen lights on
// and off" is one thing, as is "the lights in the kitchen and the living room").
function splitParts(tokens, prepared) {
  const { entities, names, lex } = prepared;
  const candidates = tokens.map((token, index) => (index === 0 ? null : isSeparator(token, lex) ? { index, drop: true } : andRest(token, names, lex) ? { index, drop: false } : null)).filter(Boolean);
  if (!candidates.length) return [{ tokens, text: tokens.map((token) => token.display).join(" ") }];
  const cuts = [];
  let start = 0;
  for (const [order, candidate] of candidates.entries()) {
    const { index, drop } = candidate;
    const rest = drop ? null : andRest(tokens[index], names, lex);
    const from = drop ? index + 1 : index;
    const end = candidates[order + 1]?.index ?? tokens.length;
    if (from >= end) continue;
    if (!hasContent(tokens, start, index, null, prepared)) continue;
    if (!startsSomething(tokens, from, end, rest, prepared)) continue;
    if (!hasContent(tokens, from, end, rest, prepared)) continue;
    if (insideName(tokens, index, entities)) continue;
    cuts.push({ index, from, rest });
    start = from;
  }
  const parts = [];
  let begin = 0;
  let restFirst = null;
  for (const cut of [...cuts, { index: tokens.length, from: tokens.length, rest: null }]) {
    const list = tokens.slice(begin, cut.index);
    if (list.length) {
      const words = list.map((token, position) => (position === 0 && restFirst ? token.display.replace(/^ו/, "") : token.display));
      parts.push({ tokens: list, text: words.join(" ") });
    }
    begin = cut.from;
    restFirst = cut.rest;
  }
  return parts;
}

// The room a part says itself: the tokens of the best room said whole (in a device's name too:
// "the kitchen island"), or null; and `inName`, a room's words said only in the name of a device
// of another room ("רחצה ספוטים כניסה", a light of the parents' room, has the Entrance's name): not
// the room said, so never carried to another part (1.10.0).
function roomSaid(tokens, prepared) {
  let best = null;
  let inName = false;
  let devices = null;
  for (const entity of prepared.entities) {
    if (entity.type !== "room") continue;
    const match = matchEntity(entity, tokens);
    if (!match?.full || match.unsure) continue;
    // With the words of its name that need not be said, when said right before ("room 12").
    const positions = new Set(match.positions);
    for (const position of [...positions].sort((a, b) => a - b)) {
      const before = tokens[position - 1];
      if (before && !positions.has(position - 1) && entity.parts.some((part) => part.optional && part.raw === before.raw)) positions.add(position - 1);
    }
    // Said by a word, not by a number alone ("set the AC to 23" names no room "23").
    if (![...positions].some((position) => tokens[position].num === null)) continue;
    devices ||= prepared.entities.filter((other) => other.type === "device").map((other) => matchEntity(other, tokens)).filter((other) => other?.full && !other.unsure);
    if (devices.some((device) => device.entity.device.room !== entity.room.id && [...positions].every((position) => device.positions.has(position)))) {
      inName = true;
      continue;
    }
    if (!best || match.score > best.match.score) best = { match, positions };
  }
  return { tokens: best ? [...best.positions].sort((a, b) => a - b).map((position) => tokens[position]) : null, inName };
}

// A part that says only what (a device, a kind, a scene), with no verb, number or mode of its own:
// "and the AC" takes the verb said before it.
function needsVerb(tokens) {
  return !tokens.some((token) => token.num !== null || ACTING.has(token.role?.role) || ["cool", "heat", "auto", "feel"].includes(token.role?.role));
}

// What two to five parts do: each read alone, with the room said in another part when it says
// none (forward, and back to the part before when they share one verb: "turn off the lights and
// the AC in the living room"), and the verb of another part when it has none. All or nothing.
function readSeveral(parts, prepared) {
  const info = parts.map((part) => {
    const said = roomSaid(part.tokens, prepared);
    return {
      room: said.tokens,
      inName: said.inName,
      verb: part.tokens.filter((token) => DOING.has(token.role?.role)),
      // "A bit", "more": they go with the verb to a part that has none (1.11.0: "open the kitchen
      // blinds a bit and the living room blinds").
      bits: part.tokens.filter((token) => token.role?.modifier === "bit" || token.role?.modifier === "more"),
      needsVerb: needsVerb(part.tokens),
      all: part.tokens.some((token) => ["all", "everything"].includes(token.role?.role)),
    };
  });
  const verbFrom = info.map((item, index) => {
    if (!item.needsVerb) return null;
    for (let other = index - 1; other >= 0; other -= 1) if (info[other].verb.length) return other;
    for (let other = index + 1; other < info.length; other += 1) if (info[other].verb.length) return other;
    return null;
  });
  const roomFrom = info.map((item, index) => {
    if (item.room) return null;
    for (let other = index - 1; other >= 0; other -= 1) if (info[other].room) return other;
    const next = index + 1;
    if (info[next]?.room && (verbFrom[index] === next || verbFrom[next] === index)) return next;
    return null;
  });
  const results = [];
  // Each part's kind of device, for "la del salón" in the part after it.
  const kinds = [];
  const carriedRoom = (index) => (roomFrom[index] === null ? [] : info[roomFrom[index]].room.map((token) => ({ ...token, carried: true })));
  // The verb a part lends (1.11.0): a step's verb only with its "a bit" or "more"; a step by an
  // amount lends none ("open the kitchen blinds by 20% and the living room blinds": the second
  // part is not clear, rather than opened fully).
  const lent = (lender) => {
    const own = results[lender] || readPart([...parts[lender].tokens, ...carriedRoom(lender)], prepared);
    const item = own.status === "ok" ? own.action : own.status === "ask" ? own.options[0] : null;
    const step = Object.keys(item?.change || {}).some((key) => key.endsWith("By"));
    if (!step) return info[lender].verb;
    return info[lender].bits.length ? [...info[lender].verb, ...info[lender].bits] : [];
  };
  for (const [index, part] of parts.entries()) {
    const refers = index > 0 ? kinds[index - 1] : null;
    const tokens = part.tokens.map((token) => (token.role?.role === "pronoun" ? { ...token, refers } : token));
    const room = carriedRoom(index);
    const verb = verbFrom[index] === null ? [] : lent(verbFrom[index]);
    let result;
    if (!verb.length) {
      result = readPart([...tokens, ...room], prepared);
    } else {
      // "And the AC": with the verb before it; a scene's name ("and good night") as it is.
      const withVerb = readPart([...verb, ...tokens, ...room], prepared);
      const alone = withVerb.status === "ok" ? null : readPart([...tokens, ...room], prepared);
      result = withVerb.status === "ok" || alone.status !== "ok" ? withVerb : alone;
    }
    results.push(result);
    kinds.push(kindSaid(tokens, result));
  }

  // A refusal anywhere ("don't", a time, how warm one feels) decides; then the first part that is
  // not understood, asks or cannot be done. Nothing is done.
  const refused = results.findIndex((result) => result.status === "unknown" && result.refusal);
  if (refused >= 0) return { ...results[refused], part: parts[refused].text };
  const failed = results.findIndex((result) => result.status !== "ok");
  if (failed >= 0) {
    const result = results[failed];
    const part = parts[failed].text;
    if (result.status === "ask") return problem("partAsks", { question: result.question, options: result.options, part });
    return { ...result, part };
  }
  // The whole home without "all" while another part names a room ("turn off the lights and close
  // the kitchen blinds"), also inside a device's name: which room? never a guess.
  const anyRoom = info.some((item) => item.room || item.inName);
  for (const [index, result] of results.entries()) {
    if (result.action.type === "offAll" && !info[index].all && anyRoom) {
      return problem("needRoom", { kind: { lights: "light", climate: "climate", blinds: "blind" }[result.action.filters[0]] || null, part: parts[index].text });
    }
  }
  return combine(results.map((result) => result.action), parts, prepared.catalog);
}

// The kind of device a part speaks of (a kind role), for a pronoun in the next: its word for it
// ("la luz", "el aire": the AC itself), the one its own pronoun stood for, or what it does.
function kindSaid(tokens, result) {
  const word = tokens.find((token) => token.role?.role === "kind");
  if (word) return word.role;
  const pronoun = tokens.find((token) => token.role?.role === "pronoun" && token.refers);
  if (pronoun) return pronoun.refers;
  const item = result.status === "ok" ? result.action : null;
  const kind = item?.device ? KIND_OF[item.device.kind] : { lights: "light", climate: "climate", blinds: "blind", fans: "fan", music: "music" }[item?.type];
  return kind ? { role: "kind", kind, plural: false } : null;
}

// The devices an action changes, as "kind:id" (a room's All off and Turn off all: all they may).
function touched(item, catalog) {
  const devices = catalog.devices || [];
  const of = (kind) => (device) => device.kind === kind;
  const keys = (list) => list.map((device) => `${device.kind}:${device.id}`);
  const lights = (list) => list.filter((device) => device.kind === "light" && !isHeater(device));
  switch (item.type) {
    case "lights":
      return item.ids.map((id) => `light:${id}`);
    case "climate":
      return item.ids.map((id) => `thermostat:${id}`);
    case "blinds":
      return item.ids.map((id) => `blind:${id}`);
    case "fans":
      return item.ids.map((id) => `fan:${id}`);
    case "music":
      return item.ids.map((id) => `music:${id}`);
    case "door":
      return [`${item.device.kind}:${item.device.id}`];
    case "scene":
      return [`scene:${item.id}`];
    case "roomOff": {
      const here = devices.filter((device) => device.room === item.room);
      return [...keys(lights(here)), ...keys(here.filter(of("thermostat"))), ...keys(here.filter(of("fan")))];
    }
    case "offAll":
      return item.filters.flatMap((filter) => keys(filter === "lights" ? lights(devices) : devices.filter(of(filter === "climate" ? "thermostat" : "blind"))));
    default:
      return [];
  }
}

// The parts' actions as one answer: Turn off all said in two parts is one (one confirm), never the
// same device twice, at most one door or gate.
function combine(actions, parts, catalog) {
  const list = [];
  let offAll = null;
  for (const item of actions) {
    if (item.type !== "offAll") {
      list.push(item);
      continue;
    }
    if (!offAll) {
      offAll = { ...item, filters: [...item.filters] };
      list.push(offAll);
      continue;
    }
    for (const filter of item.filters) {
      if (offAll.filters.includes(filter)) return problem("overlap", { device: null });
      offAll.filters.push(filter);
    }
  }
  if (list.filter((item) => item.type === "door").length > 1) return problem("oneDoor");
  const seen = new Map();
  for (const item of list) {
    for (const key of new Set(touched(item, catalog))) {
      if (seen.has(key)) {
        const [kind, ...rest] = key.split(":");
        const id = rest.join(":");
        if (kind === "scene") return problem("overlap", { scene: id });
        const device = (catalog.devices || []).find((candidate) => candidate.kind === kind && String(candidate.id) === id);
        return problem("overlap", { device: device ? { kind: device.kind, id: device.id } : null });
      }
      seen.set(key, item);
    }
  }
  if (list.length === 1) return { status: "ok", action: list[0] };
  return { status: "ok", actions: list, parts: parts.map((part) => part.text) };
}

// ---- parse ---------------------------------------------------------------------------------

// Longer than this, a text is not a command (the field takes one letter more, so that a longer
// text pasted and cut short by it is never understood in part).
export const MAX_LENGTH = 200;

// `language`: the app's ("en", "he", "es", "it"). Spanish and Italian are read first in their own
// words; then, when they understood nothing at all (no refusal either), in English and Hebrew,
// which every language understands. Of two sentences not understood, the one with fewer words it
// did not know is said.
export function parseCommand(text, catalog = {}, { language = "en" } = {}) {
  const sentence = String(text ?? "");
  if (sentence.trim().length > MAX_LENGTH) return { status: "unknown", words: [] };
  let unknown = null;
  for (const lex of READINGS[language] || [LEXICONS.base]) {
    const result = readSentence(sentence, { ...prepare(catalog, lex), catalog, lex });
    if (result.status !== "unknown" || result.refusal) return result;
    if (!unknown || result.words.length < unknown.words.length) unknown = result;
  }
  return unknown;
}

// The sentence in one language's words.
function readSentence(sentence, prepared) {
  const { lex } = prepared;
  const tokens = tokenize(sentence, prepared.names, lex);
  // A period or a comma at the end ("Kitchen lights off.") says nothing.
  while (tokens.length && tokens[tokens.length - 1].raw === ",") tokens.pop();
  // Five things take more words than three did (30 until 1.11.0); 200 letters stay the limit.
  if (!tokens.length || tokens.length > 50) return { status: "unknown", words: [] };
  // A question mark makes it a question ("האור במטבח כבוי?", "kitchen lights off?", "¿está
  // encendida la luz?"): Hebrew, Spanish and Italian ask yes or no without a question word, and
  // dictation writes "?" for a rising voice.
  if (/[?？؟¿]/u.test(sentence)) return problem("question");
  for (const token of tokens) token.role = roleOf(token, prepared.names, lex);
  for (const [index, token] of tokens.entries()) {
    // "Y luego", "y después", "e dopo": then (alone, later: a time).
    if (index > 0 && lex.then.has(token.raw) && isSeparator(tokens[index - 1], lex)) token.role = FILLER;
    // "La del salón", "quella del soggiorno": the one of a room (1.10.0; readSeveral).
    if (lex.pronouns.has(token.raw) && (!lex.pronounOf.size || lex.pronounOf.has(tokens[index + 1]?.raw))) {
      token.role = { role: "pronoun", plural: lex.pronouns.get(token.raw) };
      if (lex.pronounOf.size) tokens[index + 1].pronounOf = true;
    }
    // "Room" alone, not after "every" ("in every room", "בכל חדר"): which room? (intent)
    token.roomWord = token.bares.some((form) => lex.room.has(form)) && tokens[index - 1]?.role?.role !== "all";
  }
  const parts = splitParts(tokens, prepared);
  if (parts.length === 1) return readPart(parts[0].tokens, prepared);
  if (parts.length > MAX_PARTS) return problem("tooManyParts", { max: MAX_PARTS });
  return readSeveral(parts, prepared);
}
