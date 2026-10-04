// DirectorLink in numbers (cloud/src/stats.js, ADR-052) end to end: the Worker under `wrangler dev`
// with its D1, a fake Google and a fake Apple for the accounts, fake controllers that claim homes,
// and a fake GitHub releases list (GITHUB_API_URL). The hourly trigger runs with GET /__scheduled.
//   node --test tests/cloud/stats.test.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, afterEach, before, test } from "node:test";

import { connectDriver, randomHex } from "../../scripts/relay_smoke.mjs";
import { appleVars, signInWithApple, postNotification, startFakeApple } from "./fake-apple.mjs";
import { googleVars, signInAs, startFakeGoogle } from "./fake-google.mjs";
import { STARTUP_MS, freePort, startWorker } from "./worker.mjs";

const APP = "http://localhost:8080";
const SITE = "https://directorlink.io";
const TEST = { timeout: 60_000 };
const PACKAGE = "DirectorLink.c4z";

let worker;
let google;
let apple;
let github;
const drivers = [];

// The fake GitHub: 120 releases in pages of 100, each with the package and two other files.
async function startFakeGitHub() {
  const releases = Array.from({ length: 120 }, (_, index) => ({
    tag_name: `v0.${index}.0`,
    assets: [
      { name: PACKAGE, download_count: index + 1 },
      { name: "SHA256SUMS.txt", download_count: 1000 },
      { name: "openapi.json", download_count: 1000 },
    ],
  }));
  const fake = { failing: false, asked: [], total: (120 * 121) / 2 };
  const port = await freePort();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    fake.asked.push({ path: url.pathname, page: url.searchParams.get("page"), userAgent: request.headers["user-agent"] ?? null });
    if (fake.failing) {
      response.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0" });
      return response.end(JSON.stringify({ message: "API rate limit exceeded" }));
    }
    if (url.pathname !== "/repos/IsraelCIL/DirectorLink/releases") {
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: "Not Found" }));
    }
    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(releases.slice((page - 1) * perPage, page * perPage)));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise((resolve) => server.close(resolve));
  return fake;
}

before(async () => {
  google = await startFakeGoogle();
  apple = await startFakeApple();
  github = await startFakeGitHub();
  worker = await startWorker({
    migrate: true,
    scheduled: true,
    devVars: { ...googleVars(google, APP, "https://api.directorlink.test"), ...appleVars(apple), GITHUB_API_URL: github.url },
  });
}, { timeout: STARTUP_MS + 10_000 });

after(async () => {
  await worker?.stop();
  await google?.close();
  await apple?.close();
  await github?.close();
});

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((connection) => connection.close()));
});

// A controller at a new home, connected to the relay, that confirms its own claim token.
async function home() {
  const state = { home: randomHex(16), claimToken: randomHex(24) };
  const connection = await connectDriver({ url: worker.ws, home: state.home, pingIntervalMs: 0, silenceTimeoutMs: 0 });
  drivers.push(connection);
  connection.on("unknown", (text) => {
    const message = JSON.parse(text);
    if (message.type === "claim") {
      const ok = message.token === state.claimToken;
      connection.sendJson({ id: message.id, type: "claim_result", ok, code: ok ? undefined : "INVALID_CLAIM" });
    }
  });
  return state;
}

async function claim(cookie) {
  const state = await home();
  const response = await fetch(`${worker.http}/v1/homes/claim`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: APP, "content-type": "application/json" },
    body: JSON.stringify({ home_id: state.home, claim_token: state.claimToken }),
  });
  assert.equal(response.status, 200, await response.text());
  return state;
}

// The Worker's log lines of `event` since the line that names `mark` (worker.output() keeps the
// last 200 lines, so lines are found after a mark rather than counted).
function logged(event, mark) {
  const lines = worker.output().split("\n");
  const from = mark ? lines.findIndex((line) => line.includes(mark)) : -1;
  return lines.slice(from + 1).filter((line) => line.includes(`"event":"${event}"`));
}

async function eventually(check, what) {
  for (let tries = 0; tries < 100; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${what}:\n${worker.output()}`);
}

// Runs a trigger and waits for its log line (the work may finish after /__scheduled answers).
// Returns the mark: wrangler logs the request for it, a path of its own.
async function trigger(cron, event) {
  const mark = `/stats-test-mark-${randomHex(6)}`;
  await (await fetch(`${worker.http}${mark}`)).body?.cancel();
  await eventually(() => worker.output().includes(mark), `the mark ${mark} in the log`);
  const response = await fetch(`${worker.http}/__scheduled?cron=${encodeURIComponent(cron)}`);
  assert.equal(response.status, 200);
  await eventually(() => logged(event, mark).length > 0, `${event} after ${cron}`);
  return mark;
}

const lastJson = (lines) => JSON.parse(lines.at(-1).slice(lines.at(-1).indexOf("{")));

const HOURLY = "47 * * * *";
const DAILY = "17 3 * * *";

async function stats(origin = SITE) {
  const response = await fetch(`${worker.http}/v1/stats`, { headers: origin ? { Origin: origin } : {} });
  return { status: response.status, headers: response.headers, json: await response.json() };
}

let first;

test("before the first count the totals are not made up", TEST, async () => {
  const answer = await stats();
  assert.equal(answer.status, 503);
  assert.equal(answer.json.code, "STATS_NOT_COUNTED");
  assert.equal(answer.headers.get("access-control-allow-origin"), SITE, "the website sees why");
});

test("the hourly count: homes linked to an account, people who can sign in, and the package's downloads", TEST, async () => {
  // Dana claims a home; Noa has an account and no home.
  const dana = await signInAs(worker.http, google, { sub: "google-dana", email: "dana@example.com", name: "Dana" }, APP);
  await claim(dana);
  await signInAs(worker.http, google, { sub: "google-noa", email: "noa@example.com", name: "Noa" }, APP);
  // A home connected to the relay that nobody claimed is not counted.
  await home();
  // Avi claims a home, then deletes his account: neither counts.
  const avi = await signInAs(worker.http, google, { sub: "google-avi", email: "avi@example.com", name: "Avi" }, APP);
  await claim(avi);
  const deleted = await fetch(`${worker.http}/v1/me`, { method: "DELETE", headers: { Cookie: avi, Origin: APP } });
  assert.equal(deleted.status, 204);
  // Apple deleted Lior's Apple Account: the account stays only for its home, without the person.
  const lior = await signInWithApple(worker.http, apple, { sub: "001.stats.lior", email: "lior@example.com", firstName: "Lior", lastName: "B" }, APP);
  await claim(lior.cookie);
  assert.equal((await postNotification(worker.http, apple.notification({ type: "account-deleted", sub: "001.stats.lior" }))).status, 200);
  // Rina added Apple to her Google account: one person, two sign-ins.
  const rina = await signInAs(worker.http, google, { sub: "google-rina", email: "rina@example.com", name: "Rina" }, APP);
  await signInWithApple(worker.http, apple, { sub: "001.stats.rina", email: "rina.apple@example.com", firstName: "Rina", lastName: "C" }, APP, { link: rina });

  await trigger(HOURLY, "stats_counted");
  assert.deepEqual(lastJson(logged("stats_counted")), { event: "stats_counted", homes: 2, people: 3, downloads: github.total });
  assert.deepEqual(
    github.asked.map(({ path, page }) => `${path}?page=${page}`),
    ["/repos/IsraelCIL/DirectorLink/releases?page=1", "/repos/IsraelCIL/DirectorLink/releases?page=2"]
  );
  assert.ok(github.asked.every(({ userAgent }) => /^DirectorLink/.test(userAgent ?? "")), "GitHub needs a User-Agent");
  assert.equal(logged("sessions_purged").length, 0, "the hourly trigger is not the daily housekeeping");

  const answer = await stats();
  assert.equal(answer.status, 200);
  const { updated, ...totals } = answer.json;
  assert.deepEqual(totals, { homes: 2, people: 3, downloads: github.total });
  assert.ok(Math.abs(Date.parse(updated) - Date.now()) < 60_000, updated);
  first = answer.json;
});

test("the answer is public, read-only and cacheable, and readable from the website's pages only", TEST, async () => {
  const answer = await stats();
  assert.deepEqual(Object.keys(answer.json).sort(), ["downloads", "homes", "people", "updated"]);
  assert.match(answer.headers.get("content-type"), /^application\/json/);
  assert.equal(answer.headers.get("cache-control"), "public, max-age=300");
  assert.equal(answer.headers.get("access-control-allow-origin"), SITE);
  assert.equal(answer.headers.get("access-control-allow-credentials"), null);
  assert.match(answer.headers.get("vary") ?? "", /Origin/);
  assert.equal(answer.headers.get("set-cookie"), null);
  assert.equal((await stats("https://www.directorlink.io")).headers.get("access-control-allow-origin"), "https://www.directorlink.io");
  for (const origin of [APP, "https://evil.example", null]) {
    const other = await stats(origin);
    assert.equal(other.status, 200);
    assert.equal(other.headers.get("access-control-allow-origin"), null, String(origin));
  }
  const preflight = await fetch(`${worker.http}/v1/stats`, { method: "OPTIONS", headers: { Origin: SITE, "Access-Control-Request-Method": "GET" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), SITE);
  for (const method of ["POST", "PUT", "DELETE"]) {
    const refused = await fetch(`${worker.http}/v1/stats`, { method, headers: { Origin: SITE } });
    assert.equal(refused.status, 405, method);
    await refused.body?.cancel();
  }
});

test("GitHub failing keeps the last downloads and their time; the accounts are counted again", TEST, async () => {
  assert.ok(first, "the count above ran");
  await signInAs(worker.http, google, { sub: "google-tal", email: "tal@example.com", name: "Tal" }, APP);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  github.failing = true;
  let mark;
  try {
    mark = await trigger(HOURLY, "stats_counted");
  } finally {
    github.failing = false;
  }
  assert.deepEqual(lastJson(logged("stats_counted", mark)), { event: "stats_counted", homes: 2, people: 4, downloads: null });
  const refused = lastJson(logged("stats_not_counted", mark));
  assert.equal(refused.totals, "downloads");
  assert.equal(refused.status, 403);
  assert.equal(refused.rate_limit_remaining, "0");
  const answer = await stats();
  assert.equal(answer.status, 200);
  assert.deepEqual({ ...answer.json, updated: undefined }, { homes: 2, people: 4, downloads: github.total, updated: undefined });
  assert.equal(answer.json.updated, first.updated, "updated: when the oldest total was counted, the downloads");
});

test("the daily trigger still does the housekeeping, and does not count", TEST, async () => {
  const mark = await trigger(DAILY, "sessions_purged");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(logged("stats_counted", mark).length, 0);
});
