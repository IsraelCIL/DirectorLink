// The home's alerts alarm (cloud/src/alerts.js HomeAlerts, ADR-047) in Node, with a fake Durable
// Object storage, a fake D1 that can fail, a fake relay and the fake push service: an offline alert
// that did not get through is tried again (and only for the browsers it missed), at most
// ALERT_TRIES times; a connected home's object asks D1 again now and then and stops once nobody is
// subscribed; a "changed" call stops it too. And a registration with a key (ADR-050) waits for the
// key work the object has queued.
//   node --test tests/cloud/alerts-alarm.test.mjs

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ALERT_TRIES, HomeAlerts } from "../../cloud/src/alerts.js";
import { startFakePush, vapidVars } from "./fake-push.mjs";

const HOME = "0123456789abcdef0123456789abcdef";
const MINUTE = 60_000;
const vapid = vapidVars();
let push;
// The object's log lines (JSON), kept here rather than printed.
const logged = [];
const consoleLog = console.log;

before(async () => {
  push = await startFakePush();
  console.log = (line) => logged.push(JSON.parse(line));
});

after(async () => {
  console.log = consoleLog;
  await push?.close();
});

// Durable Object storage, as far as HomeAlerts uses it; `alarm` is the alarm set, or null.
function fakeStorage(initial) {
  const data = new Map(Object.entries(initial));
  const storage = {
    data,
    alarm: null,
    async get(key) {
      if (Array.isArray(key)) {
        return new Map(key.filter((name) => data.has(name)).map((name) => [name, structuredClone(data.get(name))]));
      }
      return structuredClone(data.get(key));
    },
    async put(key, value) {
      for (const [name, item] of typeof key === "object" ? Object.entries(key) : [[key, value]]) {
        data.set(name, structuredClone(item));
      }
    },
    async delete(key) {
      for (const name of [].concat(key)) data.delete(name);
    },
    async getAlarm() {
      return storage.alarm;
    },
    async setAlarm(at) {
      storage.alarm = at;
    },
    async deleteAlarm() {
      storage.alarm = null;
    },
  };
  return storage;
}

// D1 with the home's admins' subscriptions; its next `fail` reads throw, as when D1 is unreachable.
function fakeDB(subscriptions, { fail = 0 } = {}) {
  const db = {
    subscriptions,
    fail,
    reads: 0,
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async all() {
          db.reads += 1;
          if (db.fail > 0) {
            db.fail -= 1;
            throw new Error("D1_ERROR: Network connection lost");
          }
          assert.match(sql, /FROM push_subscriptions/);
          return { results: db.subscriptions.map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth })) };
        },
        sql,
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        assert.match(statement.sql, /^DELETE FROM push_subscriptions/);
      }
      return [];
    },
  };
  return db;
}

// A home whose object watches: `away` (minutes) since the driver went, or connected (`socket`).
function home({ subscriptions, away = null, socket = false, fail = 0, stored = {} }) {
  const storage = fakeStorage({ alerts_home: HOME, alerts_admins: ["aaaa0001"], alerts_on: true, ...(away === null ? {} : { away_since: Date.now() - away * MINUTE }), ...stored });
  const DB = fakeDB(subscriptions, { fail });
  const relay = {
    ctx: { storage },
    env: { ...vapid, DB },
    driverSocket: () => (socket ? {} : null),
    lastSeen: () => Date.now(),
    stale: () => false,
  };
  const alerts = new HomeAlerts(relay);
  // The alarm goes off: the runtime clears it, then calls the handler.
  const fire = async () => {
    storage.alarm = null;
    await alerts.alarm();
  };
  return { storage, DB, alerts, fire };
}

const browser = (options) => {
  const made = push.subscribe(options);
  return { made, row: { endpoint: made.subscription.endpoint, ...made.subscription.keys } };
};
const sent = (made) => push.received.filter((entry) => entry.id === made.id);
const offline = (made) => push.messagesFor(made).filter((message) => message.kind === "offline");
const near = (value, expected) => Math.abs(value - expected) < 5000;

test("an offline alert whose D1 read failed is tried again a minute later, and goes", async () => {
  const dana = browser();
  const { storage, fire } = home({ subscriptions: [dana.row], away: 11, fail: 1 });
  const since = storage.data.get("away_since");
  await fire();
  assert.equal(sent(dana.made).length, 0);
  assert.equal(storage.data.get("offline_alerted"), undefined, "not marked alerted: it did not go");
  assert.deepEqual(storage.data.get("offline_retry"), { tries: 1, endpoints: null });
  assert.ok(near(storage.alarm, Date.now() + MINUTE), "tried again in a minute");

  await fire();
  const [message] = offline(dana.made);
  assert.deepEqual(message, { kind: "offline", home: HOME, at: new Date(since).toISOString() }, "the same absence, from when it began");
  assert.notEqual(storage.data.get("offline_alerted"), undefined);
  assert.equal(storage.data.get("offline_retry"), undefined);
  assert.equal(storage.alarm, null, "no more alarms after the alert");
  await fire();
  assert.equal(offline(dana.made).length, 1, "once per absence");
});

test("a push service that fails once (503) gets the alert again; a browser that had it does not", async () => {
  const busy = browser({ fails: 1, failStatus: 503 });
  const fine = browser();
  const { storage, fire } = home({ subscriptions: [busy.row, fine.row], away: 11 });
  await fire();
  assert.equal(offline(fine.made).length, 1);
  assert.equal(offline(busy.made).length, 0);
  assert.deepEqual(storage.data.get("offline_retry"), { tries: 1, endpoints: [busy.row.endpoint] });
  assert.ok(near(storage.alarm, Date.now() + MINUTE));

  await fire();
  assert.equal(offline(busy.made).length, 1, "it arrived the second time");
  assert.equal(sent(fine.made).length, 1, "the browser that had it is not sent it twice");
  assert.notEqual(storage.data.get("offline_alerted"), undefined);
  assert.equal(storage.alarm, null);
});

test("busy (429), failing (5xx) or unreachable push services are tried again, ALERT_TRIES sends at most", async () => {
  const busy = browser({ fails: 99, failStatus: 429 });
  const failing = browser({ fails: 99, failStatus: 500 });
  const unreachable = { endpoint: "http://127.0.0.1:9/push/nobody", p256dh: busy.row.p256dh, auth: busy.row.auth };
  const { storage, fire } = home({ subscriptions: [busy.row, failing.row, unreachable], away: 11 });
  for (let tries = 1; tries < ALERT_TRIES; tries += 1) {
    await fire();
    assert.equal(storage.data.get("offline_retry").tries, tries);
    assert.equal(storage.data.get("offline_retry").endpoints.length, 3);
    assert.ok(near(storage.alarm, Date.now() + MINUTE));
  }
  await fire();
  assert.equal(sent(busy.made).length, ALERT_TRIES);
  assert.equal(sent(failing.made).length, ALERT_TRIES);
  assert.notEqual(storage.data.get("offline_alerted"), undefined, "given up: once per absence");
  assert.equal(storage.data.get("offline_retry"), undefined);
  assert.equal(storage.alarm, null);
});

test("a redirect or a refusal is not tried again", async () => {
  const target = browser();
  const redirecting = browser({ status: 307, location: target.made.subscription.endpoint });
  const refusing = browser({ status: 400 });
  const { storage, fire } = home({ subscriptions: [redirecting.row, refusing.row], away: 11 });
  await fire();
  assert.equal(sent(redirecting.made).length, 1);
  assert.equal(sent(refusing.made).length, 1);
  assert.equal(sent(target.made).length, 0, "the redirect was not followed");
  assert.notEqual(storage.data.get("offline_alerted"), undefined);
  assert.equal(storage.alarm, null);
});

test("while connected, the object asks D1 again within the hour, and stops once nobody is subscribed", async () => {
  const dana = browser();
  const { storage, DB, fire } = home({ subscriptions: [dana.row], socket: true });
  await fire();
  assert.equal(DB.reads, 1, "the first wake asks");
  assert.ok(near(storage.alarm, Date.now() + 10 * MINUTE));
  await fire();
  assert.equal(DB.reads, 1, "not every wake");
  assert.ok(near(storage.alarm, Date.now() + 10 * MINUTE));

  // The subscription went without the object being told; an hour later it asks again.
  DB.subscriptions = [];
  storage.data.set("alerts_checked", Date.now() - 61 * MINUTE);
  await fire();
  assert.equal(DB.reads, 2);
  assert.equal(storage.data.get("alerts_on"), false);
  assert.equal(storage.alarm, null, "no more alarms");
  assert.ok(logged.some((line) => line.event === "alerts_stopped" && line.home === HOME));
  await fire();
  assert.equal(DB.reads, 2, "and no more D1 reads");
});

test("a D1 failure while connected keeps the object watching", async () => {
  const dana = browser();
  const { storage, fire } = home({ subscriptions: [dana.row], socket: true, fail: 1 });
  await fire();
  assert.equal(storage.data.get("alerts_on"), true);
  assert.ok(near(storage.alarm, Date.now() + 10 * MINUTE), "looks again at the usual pace");
  await fire();
  assert.notEqual(storage.data.get("alerts_checked"), undefined, "asked again, and it worked");
});

test("told that subscriptions went, a watching object stops when none is left; others do not ask D1", async () => {
  const idle = home({ subscriptions: [], stored: { alerts_on: false } });
  assert.deepEqual(await idle.alerts.request({ op: "changed" }, HOME), { ok: true });
  assert.equal(idle.DB.reads, 0);

  const watching = home({ subscriptions: [], socket: true });
  watching.storage.alarm = Date.now() + 5 * MINUTE;
  assert.deepEqual(await watching.alerts.request({ op: "changed" }, HOME), { ok: true });
  assert.equal(watching.DB.reads, 1);
  assert.equal(watching.storage.data.get("alerts_on"), false);
  assert.equal(watching.storage.alarm, null);
});

// Registering with a key (ADR-050): the account must use that key at the home (member_keys). The
// object records it from a request just sealed with the key in the key work it queues after it
// answered (home-relay.js, "e2e"), and the app registers again at once (KEY_NOT_LINKED): the
// registration waits for that work before it looks.
test("a registration with a key waits for the key work still queued before it looks the key up", async () => {
  const linked = new Set();
  const looked = [];
  const DB = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          statement.args = args;
          return statement;
        },
        async first() {
          assert.match(sql, /FROM member_keys/);
          looked.push(statement.args.join("|"));
          return linked.has(statement.args.join("|")) ? { found: 1 } : null;
        },
      };
      return statement;
    },
    async batch(statements) {
      assert.match(statements[0].sql, /^INSERT INTO push_subscriptions/);
      return [];
    },
  };
  let finish;
  const keyWork = new Promise((resolve) => {
    finish = resolve;
  });
  const storage = fakeStorage({});
  const relay = { ctx: { storage }, env: { ...vapid, DB }, keyWork, driverSocket: () => ({}), lastSeen: () => Date.now(), stale: () => false };
  const dana = browser();
  const registering = new HomeAlerts(relay).subscribe({ user: "u1", key_id: "0a1b2c3d", endpoint: dana.row.endpoint, p256dh: dana.row.p256dh, auth: dana.row.auth }, HOME);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(looked, [], "not looked up while the key work waits");
  // The queued work records that this account uses the key, then ends.
  linked.add(`${HOME}|0a1b2c3d|u1`);
  finish();
  assert.deepEqual(await registering, { ok: true });
  assert.deepEqual(looked, [`${HOME}|0a1b2c3d|u1`]);
});
