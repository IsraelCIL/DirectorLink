// A ring's notification while the app is open but not in front (app/js/doorbells.js), next to the
// controller's alert of the same ring with the app closed (ADR-050, app/sw.js): the same tag, the
// ring's time with it, and a ring the alert already shows is not shown twice.
//   node --test tests/app/

import assert from "node:assert/strict";
import test from "node:test";

const stored = new Map([["directorlink.doorbellNotifications", "on"]]);
globalThis.window = globalThis;
window.isSecureContext = true;
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  },
  configurable: true,
});
globalThis.document = { hidden: true, hasFocus: () => false, documentElement: {}, addEventListener() {} };
globalThis.Notification = { permission: "granted" };
// The service worker's registration: what it shows, and what it finds shown.
const shown = [];
const registration = {
  showNotification: async (title, options) => shown.push({ title, options }),
  getNotifications: async ({ tag } = {}) => shown.filter((item) => item.options.tag === tag).map((item) => ({ tag: item.options.tag, data: item.options.data })),
};
Object.defineProperty(globalThis, "navigator", {
  value: { languages: ["en"], language: "en", serviceWorker: { getRegistration: async () => registration } },
  configurable: true,
});

const { notifyRings, ringIsActive, trackRings } = await import("../../app/js/doorbells.js");
const { state } = await import("../../app/js/state.js");

const RING = "2026-10-03T05:00:00Z";

test("a ring is shown once, with its time, under the tag the controller's alert uses", async () => {
  await notifyRings([{ id: 93, name: "Front Gate", last_ring_at: RING }]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.tag, "doorbell-93");
  // Its tap opens the doorbell's screen (1.11.0, ADR-078).
  assert.deepEqual(shown[0].options.data, { url: "/#/doorbell/93", ring: RING });
  assert.equal(shown[0].options.actions, undefined, "no buttons where the browser shows none");

  // The same ring again (the alert came first and shows it): not shown twice.
  await notifyRings([{ id: 93, name: "Front Gate", last_ring_at: RING }]);
  assert.equal(shown.length, 1);

  // The next ring is.
  await notifyRings([{ id: 93, name: "Front Gate", last_ring_at: "2026-10-03T05:03:00Z" }]);
  assert.equal(shown.length, 2);
});

// Only a later last_ring_at is a ring. After DirectorLink restarts it may say an older time (the one
// the doorbell's driver kept): no banner and no notification for it, and the next real ring counts.
test("a last_ring_at that goes back is not a ring", () => {
  const LATER = "2026-10-03T05:10:00Z";
  assert.deepEqual(trackRings([{ id: 94, name: "Entrance", last_ring_at: RING }]), [], "the value there when the page loaded");
  const rang = trackRings([{ id: 94, name: "Entrance", last_ring_at: LATER }]);
  assert.deepEqual(rang.map((doorbell) => doorbell.id), [94]);

  const restarted = { id: 94, name: "Entrance", last_ring_at: "2026-10-03T05:05:00Z" };
  assert.deepEqual(trackRings([restarted]), [], "an older time: not a ring");
  assert.equal(ringIsActive(restarted), false, "no banner");
  assert.deepEqual(trackRings([{ id: 94, name: "Entrance", last_ring_at: LATER }]), [], "back to the ring it knows: not a new one");
  assert.deepEqual(trackRings([{ id: 94, name: "Entrance", last_ring_at: "2026-10-03T05:20:00Z" }]).length, 1, "the next ring");
});

// 1.11.0 (ADR-078): where the browser shows a notification's buttons, the app's own ring notification
// offers "Open <door>…" for each door at the doorbell this user may open, as the controller's alert
// does (sw.js): it opens the doorbell's screen. None for a door this user may not open.
test("where the browser shows buttons, a ring offers Open <door>… for the doors this user may open", async () => {
  shown.length = 0;
  globalThis.Notification = { permission: "granted", maxActions: 2 };
  state.relays = [{ id: 76, name: "Entrance Gate" }, { id: 70, name: "Main Door" }];
  const doorbell = {
    id: 68,
    name: "Entrance",
    last_ring_at: "2026-10-03T06:00:00Z",
    doors: [{ id: 76, link: "automatic", can_open: true }, { id: 70, link: "manual", can_open: false }, { id: 71, link: "manual", can_open: true }],
  };
  await notifyRings([doorbell]);
  assert.deepEqual(shown[0].options.actions, [{ action: "door-76", title: "Open Entrance Gate…" }], "the gate; not the door this user may not open, nor one not listed here");
  assert.equal(shown[0].options.data.url, "/#/doorbell/68");

  // A member without doors: none.
  state.access = { role: "member", doors: false };
  await notifyRings([{ ...doorbell, last_ring_at: "2026-10-03T06:05:00Z" }]);
  assert.equal(shown[1].options.actions, undefined);
  state.access = null;
  globalThis.Notification = { permission: "granted" };
});
