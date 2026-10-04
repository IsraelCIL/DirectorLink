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

const { notifyRings } = await import("../../app/js/doorbells.js");

const RING = "2026-10-03T05:00:00Z";

test("a ring is shown once, with its time, under the tag the controller's alert uses", async () => {
  await notifyRings([{ id: 93, name: "Front Gate", last_ring_at: RING }]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.tag, "doorbell-93");
  assert.deepEqual(shown[0].options.data, { url: "/#/", ring: RING });

  // The same ring again (the alert came first and shows it): not shown twice.
  await notifyRings([{ id: 93, name: "Front Gate", last_ring_at: RING }]);
  assert.equal(shown.length, 1);

  // The next ring is.
  await notifyRings([{ id: 93, name: "Front Gate", last_ring_at: "2026-10-03T05:03:00Z" }]);
  assert.equal(shown.length, 2);
});
