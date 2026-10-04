// Samsung refrigerators (DirectorLink 1.7.0, ADR-049): fridge and freezer temperatures (°C), the
// door, the water filter, and four features switched on and off. A command goes through Samsung's
// cloud: the controller answers at once, and the refrigerator confirms a few seconds later (its
// driver gives up after about a minute), so the app shows the switch as waiting until the feature
// reports the change, or for CONFIRM_MS at most; then it keeps reading quietly for LATE_MS, so that
// a change confirmed later still shows.
// No imports, so the rules can be tested under Node (tests/app/refrigerators.test.mjs).

// The features, in the order the card and the scene editor show them.
export const FEATURES = ["power_cool", "power_freeze", "sabbath_mode", "ice_maker"];
export const FEATURE_ICONS = { power_cool: "coolFast", power_freeze: "snowflake", sabbath_mode: "candles", ice_maker: "ice" };

// How long a command may take to show (the refrigerator confirms through Samsung's cloud,
// typically within 4 s; its driver reads it again about 3, 10, 25 and 55 s after the command), and
// how often the app reads the refrigerator meanwhile. After that, the driver may still see the change
// at its next poll (every 2 minutes by default): the app reads every LATE_POLL_MS for LATE_MS more,
// and shows the change if it comes.
export const CONFIRM_MS = 65000;
export const CONFIRM_POLL_MS = 2000;
export const LATE_MS = 120000;
export const LATE_POLL_MS = 5000;

// The features this refrigerator has (the ones PATCH takes), in FEATURES order.
export function fridgeFeatures(fridge) {
  const listed = Array.isArray(fridge?.features) ? fridge.features : FEATURES;
  return FEATURES.filter((feature) => listed.includes(feature));
}

// The features any of `fridges` has: what a scene step can offer for them.
export function featuresOf(fridges) {
  const all = new Set(fridges.flatMap(fridgeFeatures));
  return FEATURES.filter((feature) => all.has(feature));
}

// The refrigerator reports what `change` ({ sabbath_mode: true, … }) asked for.
export function fridgeChangeConfirmed(fridge, change) {
  return Object.entries(change).every(([feature, on]) => fridge?.[feature] === on);
}

// The refrigerator as the screen shows it while `change` is on its way.
export function optimisticFridge(fridge, change) {
  return { ...fridge, ...change };
}

// A number to show, or null: what the controller reports, else nothing.
function reported(value) {
  return Number.isFinite(value) ? value : null;
}

// The two compartments with what they report: [{ zone: "fridge" | "freezer", temperature,
// setpoint }], without one that reports neither (a one-door refrigerator has no freezer).
export function zones(fridge) {
  return ["fridge", "freezer"]
    .map((zone) => ({ zone, temperature: reported(fridge?.[`${zone}_temperature`]), setpoint: reported(fridge?.[`${zone}_setpoint`]) }))
    .filter((item) => item.temperature !== null || item.setpoint !== null);
}

// What a scene step sets from the editor's choices: one feature, on or off.
export function stepSet(feature, on) {
  return { [feature]: Boolean(on) };
}

// The first feature a step sets and whether on, for the editor; null when it sets none it knows.
export function stepFeature(set) {
  const feature = FEATURES.find((item) => typeof set?.[item] === "boolean");
  return feature ? { feature, on: set[feature] } : null;
}
