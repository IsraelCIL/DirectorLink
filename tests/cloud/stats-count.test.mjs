// DirectorLink in numbers (cloud/src/stats.js, ADR-052) in Node, without a Worker: the downloads
// summed over GitHub's pages of releases (DirectorLink.c4z only), a count that fails keeping the
// totals as they were, and GET /v1/stats' answer. GitHub is a fake fetch here, and D1 a fake that
// keeps the stats table and can fail; stats.test.mjs runs the real queries in `wrangler dev`.
//   node --test tests/cloud/stats-count.test.mjs

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { MAX_PAGES, PACKAGE_NAME, PER_PAGE, REPOSITORY, STATS_CRON, countDownloads, countStats, handleStats } from "../../cloud/src/stats.js";

const BASE = "http://github.test";
const SITE = "https://directorlink.io";

// Releases as GitHub lists them: each with the package, its checksums and the API description.
// `extra` adds assets that must not count.
function releases(count, { first = 0, extra = [] } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    tag_name: `v0.${first + index}.0`,
    assets: [
      { name: PACKAGE_NAME, download_count: first + index + 1 },
      { name: "SHA256SUMS.txt", download_count: 1000 },
      { name: "openapi.json", download_count: 500 },
      ...extra,
    ],
  }));
}
const sum = (list) => list.reduce((total, release) => total + release.assets.filter((asset) => asset.name === PACKAGE_NAME).reduce((n, asset) => n + asset.download_count, 0), 0);

// The fake GitHub: `pages[n - 1]` answers page n (a list, a Response, or an Error to throw).
let pages;
let asked;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  asked.push({ url, headers: new Headers(init.headers) });
  const page = Number(url.searchParams.get("page"));
  const answer = pages[page - 1] ?? [];
  if (answer instanceof Error) throw answer;
  if (answer instanceof Response) return answer;
  return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
};

beforeEach(() => {
  pages = [];
  asked = [];
});

// A fake D1 with the stats table: the counts the queries would give (homes, people), and whether
// the batch or the read fails.
function fakeDb({ homes = 2, people = 5, failBatch = false, failRead = false, failWrite = false } = {}) {
  const table = new Map();
  const db = {
    table,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          statement.values = values;
          return statement;
        },
        async run() {
          if (failWrite) throw new Error("D1_ERROR: write failed");
          const [name, at, value] = statement.values;
          table.set(name, { name, value, updated_at: at });
          return { meta: { changes: 1 } };
        },
        async all() {
          if (failRead) throw new Error("D1_ERROR: read failed");
          return { results: [...table.values()] };
        },
      };
      return statement;
    },
    async batch(statements) {
      if (failBatch) throw new Error("D1_ERROR: database unavailable");
      return statements.map((statement) => {
        const [name, at] = statement.values;
        const value = { homes, people }[name];
        assert.match(statement.sql, name === "homes" ? /FROM homes WHERE EXISTS \(SELECT 1 FROM users/ : /FROM users WHERE EXISTS \(SELECT 1 FROM identities/);
        table.set(name, { name, value, updated_at: at });
        return { results: [{ value }] };
      });
    },
  };
  return db;
}

function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (text) => lines.push(JSON.parse(text));
  return { lines, restore: () => (console.log = original) };
}

// --- The downloads ---------------------------------------------------------------------------------

test("the downloads are DirectorLink.c4z's over every page of releases, and nothing else", async () => {
  const first = releases(PER_PAGE, { extra: [{ name: "DirectorLink (1).c4z", download_count: 7 }, { name: "C4Bridge.c4z", download_count: 9 }] });
  const second = releases(30, { first: PER_PAGE });
  pages = [first, second];
  const total = await countDownloads({ GITHUB_API_URL: `${BASE}/` });
  assert.equal(total, sum(first) + sum(second));
  assert.equal(total, (130 * 131) / 2, "1 + 2 + … + 130: only the package's own counts");
  assert.deepEqual(
    asked.map(({ url }) => url.href),
    [1, 2].map((page) => `${BASE}/repos/${REPOSITORY}/releases?per_page=${PER_PAGE}&page=${page}`),
    "pages of 100 until one is not full"
  );
  for (const { headers } of asked) {
    assert.match(headers.get("user-agent"), /^DirectorLink/, "GitHub refuses requests without a User-Agent");
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("authorization"), null, "no token unless one is set");
  }
});

test("a full last page asks for the next, which is empty", async () => {
  pages = [releases(PER_PAGE), []];
  assert.equal(await countDownloads({ GITHUB_API_URL: BASE }), sum(pages[0]));
  assert.equal(asked.length, 2);
});

test("GitHub's own address unless another is set, and the token when there is one", async () => {
  pages = [releases(3)];
  await countDownloads({ GITHUB_TOKEN: "github_pat_test" });
  assert.equal(asked[0].url.origin, "https://api.github.com");
  assert.equal(asked[0].headers.get("authorization"), "Bearer github_pat_test");
});

test("a page that fails or is not a list of releases gives no total at all", async () => {
  const failures = {
    "rate limited": new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    "server error": new Response("oops", { status: 502 }),
    "unreachable": new TypeError("network error"),
    "not JSON": new Response("<html>", { status: 200 }),
    "not a list": { message: "Not Found" },
    "a release without assets": [{ tag_name: "v1.0.0" }],
    "a count that is not a number": [{ assets: [{ name: PACKAGE_NAME, download_count: "12" }] }],
    "a negative count": [{ assets: [{ name: PACKAGE_NAME, download_count: -1 }] }],
  };
  for (const [what, answer] of Object.entries(failures)) {
    pages = [releases(PER_PAGE), answer];
    asked = [];
    await assert.rejects(countDownloads({ GITHUB_API_URL: BASE }), Error, `${what}: page 1 alone is not the total`);
  }
});

test("more pages than it reads is a failure, not a smaller total", async () => {
  pages = Array.from({ length: MAX_PAGES + 1 }, (_, index) => releases(PER_PAGE, { first: index * PER_PAGE }));
  await assert.rejects(countDownloads({ GITHUB_API_URL: BASE }), /more than 1000 releases/);
  assert.equal(asked.length, MAX_PAGES);
});

// --- The hourly count ------------------------------------------------------------------------------

test("the hourly count keeps all three totals with the time it counted them", async () => {
  pages = [releases(4)];
  const db = fakeDb({ homes: 2, people: 5 });
  const logs = captureLogs();
  try {
    await countStats({ DB: db, GITHUB_API_URL: BASE });
  } finally {
    logs.restore();
  }
  assert.deepEqual([...db.table.keys()].sort(), ["downloads", "homes", "people"]);
  assert.equal(db.table.get("homes").value, 2);
  assert.equal(db.table.get("people").value, 5);
  assert.equal(db.table.get("downloads").value, 10);
  const times = new Set([...db.table.values()].map((row) => row.updated_at));
  assert.equal(times.size, 1);
  assert.ok(Math.abs(Date.parse([...times][0]) - Date.now()) < 5000);
  assert.deepEqual(logs.lines, [{ event: "stats_counted", homes: 2, people: 5, downloads: 10 }]);
});

test("GitHub failing keeps the downloads and their time; the accounts are still counted", async () => {
  const db = fakeDb({ homes: 3, people: 7 });
  const old = "2026-10-01T09:47:00.000Z";
  db.table.set("homes", { name: "homes", value: 2, updated_at: old });
  db.table.set("people", { name: "people", value: 5, updated_at: old });
  db.table.set("downloads", { name: "downloads", value: 34, updated_at: old });
  pages = [new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })];
  const logs = captureLogs();
  try {
    await countStats({ DB: db, GITHUB_API_URL: BASE });
  } finally {
    logs.restore();
  }
  assert.deepEqual(db.table.get("downloads"), { name: "downloads", value: 34, updated_at: old });
  assert.equal(db.table.get("homes").value, 3);
  assert.equal(db.table.get("people").value, 7);
  assert.notEqual(db.table.get("homes").updated_at, old);
  assert.deepEqual(logs.lines[0], { event: "stats_not_counted", totals: "downloads", error: "GitHub answered 403", status: 403, page: 1, rate_limit_remaining: "0" });
  assert.deepEqual(logs.lines[1], { event: "stats_counted", homes: 3, people: 7, downloads: null });

  const answer = await handleStats(new Request("https://api.directorlink.io/v1/stats"), { DB: db });
  const body = await answer.json();
  assert.equal(body.downloads, 34);
  assert.equal(body.updated, old, "updated: the oldest total's time");
});

test("D1 failing to count keeps the homes and people; the downloads are still kept", async () => {
  const db = fakeDb({ failBatch: true });
  const old = "2026-10-01T09:47:00.000Z";
  db.table.set("homes", { name: "homes", value: 2, updated_at: old });
  db.table.set("people", { name: "people", value: 5, updated_at: old });
  pages = [releases(2)];
  const logs = captureLogs();
  try {
    await countStats({ DB: db, GITHUB_API_URL: BASE });
  } finally {
    logs.restore();
  }
  assert.deepEqual(db.table.get("homes"), { name: "homes", value: 2, updated_at: old });
  assert.deepEqual(db.table.get("people"), { name: "people", value: 5, updated_at: old });
  assert.equal(db.table.get("downloads").value, 3);
  assert.equal(logs.lines[0].event, "stats_not_counted");
  assert.equal(logs.lines[0].totals, "homes, people");
  assert.deepEqual(logs.lines[1], { event: "stats_counted", homes: null, people: null, downloads: 3 });
});

// --- GET /v1/stats ---------------------------------------------------------------------------------

function counted() {
  const db = fakeDb();
  db.table.set("homes", { name: "homes", value: 27, updated_at: "2026-10-03T10:47:00.120Z" });
  db.table.set("people", { name: "people", value: 64, updated_at: "2026-10-03T10:47:00.120Z" });
  db.table.set("downloads", { name: "downloads", value: 412, updated_at: "2026-10-03T08:47:00.950Z" });
  return db;
}

const stats = (init = {}, env = {}) => handleStats(new Request("https://api.directorlink.io/v1/stats", init), { DB: counted(), ...env });

test("the answer is the three totals and when, and nothing else", async () => {
  const answer = await stats({ headers: { Origin: SITE } });
  assert.equal(answer.status, 200);
  assert.match(answer.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(await answer.json(), { homes: 27, people: 64, downloads: 412, updated: "2026-10-03T08:47:00.950Z" });
  assert.equal(answer.headers.get("cache-control"), "public, max-age=300", "browsers keep it a few minutes");
  assert.equal(answer.headers.get("set-cookie"), null);
});

test("the website's origins may read it; other sites' pages may not", async () => {
  for (const origin of [SITE, "https://www.directorlink.io"]) {
    const answer = await stats({ headers: { Origin: origin } });
    assert.equal(answer.headers.get("access-control-allow-origin"), origin);
    assert.equal(answer.headers.get("access-control-allow-credentials"), null, "no cookies");
    assert.equal(answer.headers.get("vary"), "Origin");
  }
  for (const origin of ["https://app.directorlink.io", "https://evil.example", "null"]) {
    const answer = await stats({ headers: { Origin: origin } });
    assert.equal(answer.status, 200, "the totals are public; only browsers on other sites cannot read them");
    assert.equal(answer.headers.get("access-control-allow-origin"), null, origin);
  }
  const local = await stats({ headers: { Origin: "http://localhost:8204" } }, { SITE_ORIGINS: "http://localhost:8204" });
  assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:8204", "SITE_ORIGINS replaces the list");
});

test("only GET: a preflight is answered, anything else refused", async () => {
  const preflight = await stats({ method: "OPTIONS", headers: { Origin: SITE, "Access-Control-Request-Method": "GET" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), SITE);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const answer = await stats({ method, headers: { Origin: SITE } });
    assert.equal(answer.status, 405, method);
    assert.equal(answer.headers.get("allow"), "GET");
  }
});

test("before all three are counted, or when D1 fails: 503, never made-up totals", async () => {
  const db = fakeDb();
  db.table.set("homes", { name: "homes", value: 2, updated_at: "2026-10-03T10:47:00.000Z" });
  db.table.set("people", { name: "people", value: 5, updated_at: "2026-10-03T10:47:00.000Z" });
  const early = await handleStats(new Request("https://api.directorlink.io/v1/stats", { headers: { Origin: SITE } }), { DB: db });
  assert.equal(early.status, 503);
  assert.equal((await early.json()).code, "STATS_NOT_COUNTED");
  assert.equal(early.headers.get("cache-control"), "no-store");
  assert.equal(early.headers.get("access-control-allow-origin"), SITE, "the website can tell");

  const logs = captureLogs();
  let broken;
  try {
    broken = await handleStats(new Request("https://api.directorlink.io/v1/stats"), { DB: fakeDb({ failRead: true }) });
  } finally {
    logs.restore();
  }
  assert.equal(broken.status, 503);
  assert.equal((await broken.json()).code, "STATS_UNAVAILABLE");
  assert.equal(logs.lines[0].event, "stats_unavailable");
});

test("the hourly trigger is the one wrangler.jsonc sets", async () => {
  const { readFileSync } = await import("node:fs");
  const config = readFileSync(new URL("../../cloud/wrangler.jsonc", import.meta.url), "utf8");
  const crons = JSON.parse(/"crons":\s*(\[[^\]]*\])/.exec(config)[1]);
  assert.ok(crons.includes(STATS_CRON), `${STATS_CRON} in ${crons}`);
  assert.ok(crons.includes("17 3 * * *"), "the daily housekeeping stays");
  assert.match(STATS_CRON, /^\d+ \* \* \* \*$/, "once an hour");
});
