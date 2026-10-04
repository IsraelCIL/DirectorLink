// Scene links (ADR-051, cloud/src/scene-links.js and HomeRelay.link): a phone's automation posts
// the link's secret to /run/<home>.<link>, the home's object passes it to the controller (`link`,
// docs/RELAY.md) and answers with how it went. A GET is a page that runs nothing; an unknown home,
// link or secret is the same 404; an offline home 503; too many runs 429; a driver before 1.7.0 is
// never sent a run; the secret is never in what the Worker logs. The Worker under `wrangler dev`,
// a fake Google and a fake controller.
//   node --test tests/cloud/scene-links.test.mjs

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { connectDriver, randomHex } from "../../scripts/relay_smoke.mjs";
import { googleVars, signInAs, startFakeGoogle } from "./fake-google.mjs";
import { STARTUP_MS, startWorker } from "./worker.mjs";

const APP = "http://localhost:8080";
const TEST = { timeout: 30_000 };
const DANA = { sub: "google-dana-links", email: "dana-links@example.com", name: "Dana" };

let worker;
let google;
let dana;
const drivers = [];

before(async () => {
  google = await startFakeGoogle();
  worker = await startWorker({
    migrate: true,
    devVars: { ...googleVars(google, APP, "https://api.directorlink.test"), REQUEST_TIMEOUT_MS: 3000, RECONNECT_WAIT_MS: 300 },
  });
  dana = await signInAs(worker.http, google, DANA, APP);
}, { timeout: STARTUP_MS + 10_000 });

after(async () => {
  await worker?.stop();
  await google?.close();
});

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((connection) => connection.close()));
});

// --- A fake controller ---------------------------------------------------------------------------

// A controller with scene links (`links`: link id -> secret) whose hello says what it takes
// (`features`; DirectorLink 1.7.0 says scene_links, 1.6.0 nothing). `answer(message)` may change
// its answer to a run; null sends none.
async function home({ features = ["scene_links"], version = "1.7.0", claim = true } = {}) {
  const state = { home: randomHex(16), links: new Map(), seen: [], claimToken: randomHex(24), answer: null };
  const connection = await connectDriver({ url: worker.ws, home: state.home, pingIntervalMs: 0, silenceTimeoutMs: 0, hello: false });
  drivers.push(connection);
  state.connection = connection;
  connection.sendJson({ type: "hello", home: state.home, version, ping_s: 10, ...(features ? { features } : {}) });
  connection.on("unknown", (text) => {
    const message = JSON.parse(text);
    state.seen.push(message);
    const reply = (fields) => connection.sendJson({ id: message.id, ...fields });
    if (message.type === "claim") {
      return reply({ type: "claim_result", ok: message.token === state.claimToken });
    }
    if (message.type === "link") {
      const custom = state.answer?.(message);
      if (custom === null) return undefined;
      if (custom) return reply({ type: "link_result", ...custom });
      const known = state.links.get(message.link);
      return reply(known && known === message.secret ? { type: "link_result", ok: true, result: "ran" } : { type: "link_result", ok: false, code: "NOT_FOUND" });
    }
    return undefined;
  });
  if (claim) {
    const claimed = await fetch(`${worker.http}/v1/homes/claim`, {
      method: "POST",
      headers: { Cookie: dana, Origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ home_id: state.home, claim_token: state.claimToken }),
    });
    assert.equal(claimed.status, 200, await claimed.text());
  }
  return state;
}

function newLink(state) {
  const link = { id: randomHex(4), secret: randomHex(20) };
  state.links.set(link.id, link.secret);
  return link;
}

const runPath = (homeId, linkId) => `/run/${homeId}.${linkId}`;

async function post(path, body, contentType = "application/json") {
  const response = await fetch(`${worker.http}${path}`, { method: "POST", headers: contentType ? { "content-type": contentType } : {}, body });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: response.status, json, text, headers: response.headers };
}

const runs = (state) => state.seen.filter((message) => message.type === "link");

// --- Tests ---------------------------------------------------------------------------------------

test("a POST with the secret runs the scene, in every form an automation app sends it", TEST, async () => {
  const state = await home();
  const link = newLink(state);
  const path = runPath(state.home, link.id);
  const multipart = new FormData();
  multipart.append("secret", link.secret);
  const forms = [
    [JSON.stringify({ secret: link.secret }), "application/json"], // iPhone Shortcuts: Request Body JSON
    [`secret=${link.secret}`, "application/x-www-form-urlencoded"], // Shortcuts: Form; Tasker; HTTP Shortcuts
    [link.secret, "text/plain"], // MacroDroid and others: the secret alone
    [link.secret.toUpperCase(), null],
    [JSON.stringify({ secret: `https://api.directorlink.io${path}#${link.secret}` }), "application/json"], // the whole link pasted
    [JSON.stringify(link.secret), "application/json"],
    [link.secret, "application/json"], // the secret alone, though the app says JSON
    [`secret=${link.secret}`, "text/plain"],
  ];
  for (const [body, type] of forms) {
    const ran = await post(path, body, type);
    assert.equal(ran.status, 200, `${type}: ${ran.text}`);
    assert.deepEqual(ran.json, { result: "ran", message: "The scene ran." });
    assert.equal(ran.headers.get("cache-control"), "no-store");
  }
  const response = await fetch(`${worker.http}${path}`, { method: "POST", body: multipart });
  assert.equal(response.status, 200, await response.text());
  // Multipart as browsers (WebKit) and URLSession-style apps write it: a boundary is case-sensitive.
  const boundaries = ["----WebKitFormBoundary7MA4YWxkTrZu0gW", "Boundary-ABCDEF0123-mixedCase"];
  for (const boundary of boundaries) {
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="secret"\r\n\r\n${link.secret}\r\n--${boundary}--\r\n`;
    const ran = await post(path, body, `multipart/form-data; boundary=${boundary}`);
    assert.equal(ran.status, 200, `${boundary}: ${ran.text}`);
  }
  const sent = runs(state);
  assert.equal(sent.length, forms.length + 1 + boundaries.length);
  for (const message of sent) {
    assert.deepEqual(Object.keys(message).sort(), ["id", "link", "secret", "type"], "only the link and its secret reach the home");
    assert.equal(message.link, link.id);
    assert.equal(message.secret, link.secret, "lower case");
  }
});

test("the controller's answer says how it went", TEST, async () => {
  const state = await home();
  const link = newLink(state);
  const path = runPath(state.home, link.id);
  const body = JSON.stringify({ secret: link.secret });
  state.answer = () => ({ ok: true, result: "partly" });
  assert.deepEqual((await post(path, body)).json, { result: "partly", message: "The scene ran, but some devices were skipped or did not respond." });
  state.answer = () => ({ ok: true, result: "failed" });
  assert.equal((await post(path, body)).json.result, "failed");
  // Nothing was there to run (its devices were removed): not "The scene ran."
  state.answer = () => ({ ok: true, result: "nothing" });
  assert.deepEqual((await post(path, body)).json, { result: "nothing", message: "Nothing ran: the scene has no devices left to switch." });
  state.answer = () => ({ ok: true, result: "exploded" });
  assert.equal((await post(path, body)).status, 404, "an answer it does not know is no run");
  state.answer = () => ({ ok: false, code: "INTERNAL" });
  const failed = await post(path, body);
  assert.equal(failed.status, 502);
  assert.equal(failed.json.code, "HOME_FAILED");
  state.answer = () => null;
  const silent = await post(path, body);
  assert.equal(silent.status, 504, "no answer within the relay's wait");
  assert.equal(silent.json.code, "HOME_TIMEOUT");
});

test("a GET never runs anything: the same small page for every address", TEST, async () => {
  const state = await home();
  const link = newLink(state);
  const page = await fetch(`${worker.http}${runPath(state.home, link.id)}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("x-robots-tag"), /noindex/);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(html, /<button id="run" type="button">Run<\/button>/);
  assert.match(html, /location\.hash/, "the secret comes from after #, which the browser never sends");
  assert.match(html, /method: "POST"/);
  assert.doesNotMatch(html, new RegExp(state.home), "nothing about the home");
  // A link preview (Messages, WhatsApp, Slack) fetches it, as does a HEAD: nothing reaches the home.
  const head = await fetch(`${worker.http}${runPath(state.home, link.id)}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  await sleep(200);
  assert.equal(runs(state).length, 0);
  // An address that never existed gets the same page.
  const other = await (await fetch(`${worker.http}${runPath(randomHex(16), randomHex(4))}`)).text();
  const withoutNonce = (text) => text.replace(/nonce="[^"]+"/g, "");
  assert.equal(withoutNonce(other), withoutNonce(html));
  assert.equal((await fetch(`${worker.http}/run/nothing`)).status, 404);
  const put = await fetch(`${worker.http}${runPath(state.home, link.id)}`, { method: "PUT", body: link.secret });
  assert.equal(put.status, 405);
  assert.equal(put.headers.get("allow"), "GET, POST");
});

test("an unknown home, link or secret is the same 404", TEST, async () => {
  const state = await home();
  const link = newLink(state);
  const unclaimed = await home({ claim: false });
  const unclaimedLink = newLink(unclaimed);
  const wrong = link.secret.slice(0, -1) + (link.secret.endsWith("0") ? "1" : "0");
  const cases = [
    [runPath(randomHex(16), link.id), link.secret], // no such home
    [runPath(unclaimed.home, unclaimedLink.id), unclaimedLink.secret], // a home nobody claimed
    [runPath(state.home, randomHex(4)), link.secret], // no such link
    [runPath(state.home, link.id), wrong], // a wrong secret
    [runPath(state.home, link.id), link.secret.slice(1)], // not a secret at all
    [runPath(state.home, link.id), "x".repeat(40)],
  ];
  const answers = [];
  for (const [path, secret] of cases) {
    const answer = await post(path, JSON.stringify({ secret }));
    assert.equal(answer.status, 404, `${path}: ${answer.text}`);
    answers.push(answer.text);
  }
  assert.equal(new Set(answers).size, 1, "word for word the same");
  assert.equal(JSON.parse(answers[0]).code, "NOT_FOUND");
  assert.equal(runs(unclaimed).length, 0, "a home nobody claimed is never sent a run");
  const missing = await post(runPath(state.home, link.id), JSON.stringify({ name: "no secret" }));
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, "SECRET_REQUIRED");
  assert.equal((await post(runPath(state.home, link.id), "x".repeat(2000), "text/plain")).status, 400, "a body larger than a secret needs");
});

test("a driver before 1.7.0 is never sent a run: 404 at once", TEST, async () => {
  const state = await home({ features: null, version: "1.6.0" });
  const link = newLink(state);
  const started = Date.now();
  const answer = await post(runPath(state.home, link.id), JSON.stringify({ secret: link.secret }));
  assert.equal(answer.status, 404);
  assert.ok(Date.now() - started < 2500, "not the relay's wait for an answer that never comes");
  await sleep(200);
  assert.equal(runs(state).length, 0);
});

test("an offline home answers 503", TEST, async () => {
  const state = await home();
  const link = newLink(state);
  await state.connection.close();
  drivers.splice(drivers.indexOf(state.connection), 1);
  await sleep(300);
  const answer = await post(runPath(state.home, link.id), JSON.stringify({ secret: link.secret }));
  assert.equal(answer.status, 503, answer.text);
  assert.equal(answer.json.code, "HOME_OFFLINE");
});

test("too many runs: the home's limit, and the link's on the controller", TEST, async () => {
  const state = await home();
  const link = newLink(state);
  const body = JSON.stringify({ secret: link.secret });
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await post(runPath(state.home, link.id), body)).status, 200, `run ${index + 1} reaches the home`);
  }
  const limited = await post(runPath(state.home, link.id), body);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, "TOO_MANY_RUNS");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1 && Number(limited.headers.get("retry-after")) <= 60);
  assert.equal(runs(state).length, 30, "the 31st never reached the home");

  const other = await home();
  const otherLink = newLink(other);
  other.answer = () => ({ ok: false, code: "RATE_LIMITED", retry_s: 42 });
  const byLink = await post(runPath(other.home, otherLink.id), JSON.stringify({ secret: otherLink.secret }));
  assert.equal(byLink.status, 429);
  assert.equal(byLink.headers.get("retry-after"), "42");
});

// Someone who knows a home's id (it is in every link and invitation) guesses: after 10 wrong runs in
// 10 minutes their address gets 429 before anything reaches the home, and the family's runs from
// elsewhere still go (the home's 30 a minute are not used up by one stranger). An IPv6 address
// counts by its /64.
test("wrong guesses from one address are stopped there, not at the family's runs", TEST, async () => {
  const state = await home();
  const link = newLink(state);
  const from = (address) => ({ "content-type": "application/json", "CF-Connecting-IP": address });
  const guess = (address) =>
    fetch(`${worker.http}${runPath(state.home, randomHex(4))}`, { method: "POST", headers: from(address), body: JSON.stringify({ secret: randomHex(20) }) });
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await guess("198.51.100.7")).status, 404, `guess ${index + 1}`);
  }
  const stopped = await guess("198.51.100.7");
  assert.equal(stopped.status, 429);
  assert.equal((await stopped.json()).code, "TOO_MANY_RUNS");
  const wait = Number(stopped.headers.get("retry-after"));
  assert.ok(wait > 60 && wait <= 600, `until the first guess is 10 minutes old: ${wait}`);
  // Even the right secret, from there: nothing more reaches the home from that address for now.
  const right = (address) => fetch(`${worker.http}${runPath(state.home, link.id)}`, { method: "POST", headers: from(address), body: JSON.stringify({ secret: link.secret }) });
  assert.equal((await right("198.51.100.7")).status, 429);
  assert.equal(runs(state).length, 10, "the stopped runs never reached the home");
  // The family, elsewhere: their run goes.
  assert.equal((await right("203.0.113.20")).status, 200);
  // An IPv6 network is one client, whatever the last 64 bits.
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await guess(`2001:db8:1:2::${(index + 1).toString(16)}`)).status, 404);
  }
  assert.equal((await guess("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status, 429);
  assert.equal((await right("2001:db8:1:3::1")).status, 200, "another network");
});

test("the secret is never in what the Worker logs", TEST, async () => {
  const state = await home();
  const link = newLink(state);
  const wrong = randomHex(20);
  assert.equal((await post(runPath(state.home, link.id), JSON.stringify({ secret: link.secret }))).status, 200);
  assert.equal((await post(runPath(state.home, link.id), JSON.stringify({ secret: wrong }))).status, 404);
  assert.equal((await post(runPath(state.home, link.id), `secret=${link.secret}`, "application/x-www-form-urlencoded")).status, 200);
  await sleep(500);
  const output = worker.output();
  assert.match(output, /"event":"link_run"/, "runs are logged");
  assert.match(output, new RegExp(`"link":"${link.id}"`), "with the link's id");
  assert.ok(output.includes(`/run/${state.home}.${link.id}`), "the request line is logged, without the secret");
  assert.ok(!output.includes(link.secret), "never the secret");
  assert.ok(!output.includes(wrong), "nor a wrong one");
});
