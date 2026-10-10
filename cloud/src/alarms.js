// The home's Durable Object has one alarm (1.12.0): alerts (alerts.js) and Direct HTTPS's
// certificate orders (https.js) each keep the time they want in storage (`alarm_<name>`), and the
// object's alarm is set to the earliest. When it rings, the object runs those that are due.
//
// Objects whose alarm was set before 1.12.0 have never been given a name (`alarms_named`): that
// alarm is the alerts'.

export const ALARM_NAMES = ["alerts", "https"];
const NAMED = "alarms_named";

const keyOf = (name) => `alarm_${name}`;

export class Alarms {
  constructor(storage) {
    this.storage = storage;
  }

  // When `name` wants the alarm (milliseconds), or null.
  async get(name) {
    return (await this.storage.get(keyOf(name))) ?? null;
  }

  async set(name, at) {
    await this.storage.put({ [keyOf(name)]: at, [NAMED]: true });
    await this.arm();
  }

  async clear(name) {
    await this.storage.delete(keyOf(name));
    await this.arm();
  }

  // The object's alarm: the earliest wanted, or none.
  async arm() {
    const times = await this.storage.get(ALARM_NAMES.map(keyOf));
    let earliest = null;
    for (const at of times.values()) {
      if (Number.isFinite(at) && (earliest === null || at < earliest)) earliest = at;
    }
    if (earliest === null) {
      await this.storage.deleteAlarm();
    } else if ((await this.storage.getAlarm()) !== earliest) {
      await this.storage.setAlarm(earliest);
    }
  }

  // The alarm rang at `now`: the names due, each taken off (they set a new time if they want one).
  // An alarm with no name (set before 1.12.0) is the alerts'.
  async due(now) {
    const times = await this.storage.get([NAMED, ...ALARM_NAMES.map(keyOf)]);
    if (!times.has(NAMED)) return ["alerts"];
    const due = ALARM_NAMES.filter((name) => times.has(keyOf(name)) && times.get(keyOf(name)) <= now);
    if (due.length) await this.storage.delete(due.map(keyOf));
    return due;
  }

  // A view of `storage` for code that sets the object's alarm itself (alerts.js): its setAlarm,
  // getAlarm and deleteAlarm are `name`'s; everything else is the storage's own.
  storageFor(name) {
    const alarms = this;
    return new Proxy(this.storage, {
      get(target, property) {
        if (property === "setAlarm") return (at) => alarms.set(name, typeof at === "number" ? at : new Date(at).getTime());
        if (property === "getAlarm") return () => alarms.get(name);
        if (property === "deleteAlarm") return () => alarms.clear(name);
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
