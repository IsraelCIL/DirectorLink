// DirectorLink in numbers on the website (site/numbers.js, ADR-052): the section stays hidden
// under 25 homes and whenever the totals cannot be had, and shows the three numbers otherwise.
// Runs the site's own module in Node with a fake page and a fake fetch.
//   node --test tests/app/site-numbers.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MIN_HOMES, STATS_URL, loadTotals, showNumbers, totalsToShow } from "../../site/numbers.js";

const TOTALS = ["homes", "people", "downloads"];

// The section as site/index.html has it: hidden, with an empty place for each total.
function page() {
  const slots = Object.fromEntries(TOTALS.map((name) => [name, { textContent: "" }]));
  const section = {
    hidden: true,
    querySelector(selector) {
      const match = /^\[data-total="(\w+)"\]$/.exec(selector);
      return match ? slots[match[1]] ?? null : null;
    },
  };
  return { section, slots, doc: { getElementById: (id) => (id === "numbers" ? section : null) } };
}

function answering(body, { status = 200, raw = false } = {}) {
  const asked = [];
  const fetcher = async (url, init) => {
    asked.push({ url, init });
    return new Response(raw ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetcher, asked };
}

const TOTALS_25 = { homes: 25, people: 64, downloads: 1234, updated: "2026-10-03T10:47:00.000Z" };

test("from 25 homes the three totals show, written out in English", async () => {
  const { section, slots, doc } = page();
  const { fetcher, asked } = answering(TOTALS_25);
  assert.equal(await showNumbers(doc, fetcher), true);
  assert.equal(section.hidden, false);
  assert.deepEqual(Object.fromEntries(TOTALS.map((name) => [name, slots[name].textContent])), { homes: "25", people: "64", downloads: "1,234" });
  assert.equal(asked.length, 1, "asked once, at load");
  assert.equal(asked[0].url, "https://api.directorlink.io/v1/stats");
  assert.equal(asked[0].init.credentials, "omit", "no cookies");
  assert.equal(asked[0].init.referrerPolicy, "no-referrer");
  assert.ok(asked[0].init.signal, "a slow answer is given up");
});

test("under 25 homes nothing shows", async () => {
  assert.equal(MIN_HOMES, 25);
  for (const homes of [0, 2, 24]) {
    const { section, slots, doc } = page();
    assert.equal(await showNumbers(doc, answering({ ...TOTALS_25, homes }).fetcher), false, `${homes} homes`);
    assert.equal(section.hidden, true);
    assert.ok(TOTALS.every((name) => slots[name].textContent === ""), "nothing filled in");
  }
});

test("an error, a refusal or an answer that is not three counts shows nothing", async () => {
  const failures = {
    "unreachable": { fetcher: async () => { throw new TypeError("Failed to fetch"); } },
    "not counted yet (503)": answering({ code: "STATS_NOT_COUNTED" }, { status: 503 }),
    "not found (an older account service)": answering({ code: "NOT_FOUND" }, { status: 404 }),
    "not JSON": answering("<html>", { raw: true }),
    "null": answering(null),
    "a list": answering([25, 64, 1234]),
    "a total missing": answering({ homes: 30, people: 64 }),
    "a total as text": answering({ ...TOTALS_25, homes: "30" }),
    "a negative total": answering({ ...TOTALS_25, people: -1 }),
    "a fraction": answering({ ...TOTALS_25, downloads: 12.5 }),
    "not a number": answering({ ...TOTALS_25, homes: null }),
  };
  for (const [what, { fetcher }] of Object.entries(failures)) {
    const { section, doc } = page();
    assert.equal(await showNumbers(doc, fetcher), false, what);
    assert.equal(section.hidden, true, what);
  }
});

test("only the totals are taken from the answer", async () => {
  assert.deepEqual(totalsToShow({ ...TOTALS_25, extra: "<b>x</b>" }), { homes: 25, people: 64, downloads: 1234 });
  assert.equal(await loadTotals(answering({ ...TOTALS_25, homes: 24 }).fetcher), null);
  assert.equal(STATS_URL, "https://api.directorlink.io/v1/stats");
});

test("a page without the section asks nothing", async () => {
  const { fetcher, asked } = answering(TOTALS_25);
  assert.equal(await showNumbers({ getElementById: () => null }, fetcher), false);
  assert.equal(asked.length, 0);
});

test("the page has the section hidden, with a place for each total, and loads the script", () => {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  assert.match(html, /<section class="numbers" id="numbers"[^>]*\shidden>/);
  for (const name of TOTALS) assert.match(html, new RegExp(`<dd data-total="${name}"></dd>`));
  assert.match(html, /<script type="module" src="\/numbers\.js"><\/script>/);
  const css = readFileSync(new URL("../../site/site.css", import.meta.url), "utf8");
  assert.match(css, /\.numbers\[hidden\] \{\s*display: none;/, "the section's own display must not undo hidden");
});
