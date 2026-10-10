// Alerts (ADR-047, ADR-050, docs/ACCOUNTS.md): Web Push notifications (web-push.js).
//
// What the controller alerts about (a doorbell rang, a door or gate was opened, the refrigerator's
// door was left open, a schedule failed; ADR-050) it sends sealed: {"type":"notify","at","for":
// { <key id>: { iv, ct, mac } }, "brief"?} (docs/RELAY.md). The controller decided who gets it; the
// cloud cannot read what it says, not even its kind. Each part goes, at once, to the browsers
// registered with that key id by an account that uses that key at the home (member_keys), and to
// nobody else; `brief` (a doorbell) is kept by the push service a minute only. At most
// NOTIFY_PER_HOUR (60) notify messages a home an hour are delivered. Since 1.10.1 (ADR-073) a
// notify may carry an `id`: it is answered {"type":"notify_result","id","ok":true}, and an id
// handled already (the driver sends again what it sent into a connection that died) is not pushed
// again. The ids are kept 10 minutes (NOTIFY_IDS_MS), at most NOTIFY_IDS_MAX (200), in storage,
// so that they outlive the object's eviction while the driver reconnects, and a deploy.
//
// The cloud makes one alert itself, and the controller made one in the clear before 1.7.0, each
// carrying its kind, the home id and a time, never a name (ADR-047):
// - offline: the home has been away from the relay for OFFLINE_ALERT_MINUTES (10), once per absence.
//   Away is no driver connection, or a stale one, away since the driver was last heard on it: a
//   connection can die without the relay noticing. Stale is the relay's own rule (home-relay.js
//   stale(), 1.6.0: nothing heard for 2.5 of the driver's ping intervals, 12.5 s at 5 s pings); where
//   the relay has none, nothing heard for ALERT_SILENCE_SECONDS (60). A drop of seconds never alerts.
// - schedule_failed: the controller says a scheduled scene failed ({"type":"alert"}, docs/RELAY.md),
//   at most SCHEDULE_ALERTS_PER_HOUR (3) an hour.
// They go to the browsers of the home's admins: a browser registered with an admin key (1.7.0: and
// that wants offline alerts), or one registered by an app before 1.7.0 (no key) of an account that
// holds an admin key at the home, as far as the cloud knows. The controller lists its admin key ids
// with its key ids ("keys"); the cloud knows which account uses which key (member_keys).
//
//   GET    /v1/homes/{home_id}/alerts   { public_key }: the VAPID key the app subscribes with (members)
//   POST   /v1/homes/{home_id}/alerts   { endpoint, keys: { p256dh, auth }, key_id?, offline?,
//                                       device_requests? }: this browser gets the alerts of key_id (an
//                                       account that uses that key at the home), and the offline alert
//                                       unless offline is false; without key_id (apps before 1.7.0),
//                                       the admins' alerts (accounts with an admin key there).
//                                       device_requests (1.8.0): whether it wants a push when a new
//                                       device of its account asks to join (below)
//   DELETE /v1/homes/{home_id}/alerts   { endpoint }: it no longer does
//
// The home's Durable Object (home-relay.js) runs the rest with HomeAlerts. It sets alarms only
// while an admin's browser is subscribed: at a disconnect (OFFLINE_ALERT_MINUTES later) and, while
// the driver is connected, every OFFLINE_ALERT_MINUTES to see that its pings are still answered.
// Whatever removes subscriptions tells the object ({ op: "changed" }, homesChanged), and while
// connected it also asks D1 again every RECHECK_TIMES alarms, so it stops once nobody is left. An
// offline alert that reached no push service (D1 failed, or the service was unreachable, busy or
// failing) is tried again ALERT_RETRY_SECONDS (60) later, ALERT_TRIES times in all.
// Its storage:
//   alerts_home      the home id (an alarm has no request to name it)
//   alerts_admins    the admin key ids of the controller's last "keys"; none: it never said (before 1.6.0)
//   alerts_on        true while an admin's browser is subscribed
//   alerts_checked   when an alarm last asked D1 whether one still is (milliseconds)
//   away_since       when the driver went away (milliseconds): its disconnect, or, when the relay
//                    restarted under the connection (a deploy records no disconnect), when an alarm
//                    first found it gone
//   offline_alerted  the offline alert of this absence went, or was given up (milliseconds)
//   offline_retry    { tries, endpoints }: the offline alert's tries so far, and the browsers it is
//                    still to reach (null: all), while it is tried again
//   schedule_alerts  the times of the schedule alerts of the last hour
//   notify_times     the times of the notify messages of the last hour
//   notify_ids       [[id, ms], …]: the ids of the notify messages handled in the last 10
//                    minutes, oldest first, at most NOTIFY_IDS_MAX (1.10.1)
//   device_request_choices  { <SHA-256 of an endpoint>: { on, at } }: whether that browser wants the
//                    push of a new device asking to join (1.8.0); only browsers whose app said so
//   device_request_pushes   { <account id>: [times] }: the account's join pushes of the last hour
//
// The controller is told which keys no browser can get alerts for any more (1.9.0, ADR-062):
// {"type":"alerts_gone","id","keys":[<key id>, ...]} (docs/RELAY.md), to a driver whose hello lists
// alerts_gone. At each "keys" message, and when browsers are removed ({ op: "changed" }), those of
// its keys with no browser registered by an account that uses them; after a notify, those it named
// that had none, or whose every browser the push service no longer knew (404, 410); after any other
// push, those whose last browser went so. The controller then switches their alerts off, so that an
// ask-to-open link whose devices are all gone answers "nobody" rather than "asked". Key ids only:
// the cloud knew which keys have browsers.
//
// A new device asks to join (ADR-053, amended in 1.8.0 by ADR-059): device-requests.js tells the
// object, which pushes { kind: "device_request", home, at, request } at once to the browsers of
// that same account registered at the home with one of its admin keys (only admins approve; since
// 1.9.0, ADR-061, with any of its keys when the driver's hello lists `users`: every user adds their
// own devices there), whose
// app said it wants it (on by default there), at most DEVICE_REQUEST_PUSHES_PER_HOUR an account an
// hour. The cloud made the request, so the push tells it nothing new, and it names nothing but the
// home, the time and the request's id. The choice is kept here, not in D1 (no migration): an app
// sends it with every registration (at each start), so a choice pruned or lost comes back by itself.

import { json, problem, readText, sha256Hex } from "./http.js";
import { validKeyId, validKeyList } from "./member-keys.js";
import { sendPush, subscriptionKeys, validEndpoint, vapidProblem } from "./web-push.js";

const HOUR_MS = 3600 * 1000;
const DEFAULT_OFFLINE_MINUTES = 10;
const DEFAULT_SILENCE_SECONDS = 60;
const DEFAULT_RETRY_SECONDS = 60;
// Sends of one offline alert at most: the first and the tries again.
export const ALERT_TRIES = 4;
// While the driver is connected, every this many alarms (an hour at 10 minutes) ask D1 again.
const RECHECK_TIMES = 6;
const SCHEDULE_ALERTS_PER_HOUR = 3;
// Notify messages a home's alerts may carry an hour (a controller that misbehaves sends no more),
// and keys one may name.
export const NOTIFY_PER_HOUR = 60;
const NOTIFY_MAX_KEYS = 50;
// The ids of the notify messages handled (1.10.1, ADR-073), so that one the driver sends again is
// pushed once: kept 10 minutes, well past the 2 minutes the driver keeps an alert to send again
// (its own timers count them, which may run late on a busy controller), and at most 200 (a driver
// sends at most 60 alerts an hour). A notify id: what the driver makes (16 hex digits), or any
// short word of these characters.
const NOTIFY_IDS_MS = 10 * 60 * 1000;
const NOTIFY_IDS_MAX = 200;
const NOTIFY_ID = /^[0-9A-Za-z_-]{1,64}$/;
// A sealed part's ciphertext, in base64 characters: the controller pads every detail to 496 bytes,
// which seal to 512 (684 characters).
const SEALED_MAX_CT = 700;
// How long a push service keeps an alert for a device that is off; a doorbell's ("brief") only a
// minute: a ring heard later is no use.
const ALERT_TTL_SECONDS = 12 * 3600;
const BRIEF_TTL_SECONDS = 60;
// Browsers one account may have subscribed for one home: a new one beyond it replaces the oldest.
const MAX_PER_MEMBER = 10;
const MAX_BODY_BYTES = 4096;
// A new device asking to join (1.8.0): the pushes an account may get an hour at one home, how long
// the push service keeps one (a request lasts 10 minutes), and how many browsers' choices are kept.
export const DEVICE_REQUEST_PUSHES_PER_HOUR = 3;
const DEVICE_REQUEST_TTL_SECONDS = 600;
const DEVICE_REQUEST_CHOICES_MAX = 200;
// Key ids one "alerts_gone" message names at most (the controller keeps 20 keys).
const GONE_MAX_KEYS = 200;
const KINDS = new Set(["offline", "schedule_failed"]);

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

function offlineMs(env) {
  const value = Number(env.OFFLINE_ALERT_MINUTES);
  return Math.round((Number.isFinite(value) && value > 0 ? value : DEFAULT_OFFLINE_MINUTES) * 60000);
}

function silenceMs(env) {
  const value = Number(env.ALERT_SILENCE_SECONDS);
  return Math.round((Number.isFinite(value) && value > 0 ? value : DEFAULT_SILENCE_SECONDS) * 1000);
}

function retryMs(env) {
  const value = Number(env.ALERT_RETRY_SECONDS);
  return Math.round((Number.isFinite(value) && value > 0 ? value : DEFAULT_RETRY_SECONDS) * 1000);
}

// A push that may get through if sent again: the service could not be reached (0), was busy (429)
// or failed (5xx). A redirect (3xx) or a refusal (4xx) would not.
const retryable = (status) => status === 0 || status === 429 || status >= 500;

// Whether the driver has gone quiet on its socket `ws` (see the top of this file).
function quiet(relay, ws, now) {
  if (typeof relay.stale === "function") {
    return relay.stale(ws);
  }
  return now - relay.lastSeen(ws) > silenceMs(relay.env);
}

// The push service a subscription is with, for the logs: an endpoint itself is never logged.
function serviceOf(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

// Whether `userId` holds one of the home's admin keys.
async function isAdmin(env, homeId, userId, admins) {
  const row = await env.DB.prepare("SELECT 1 AS found FROM member_keys WHERE home_id = ?1 AND user_id = ?2 AND key_id IN (SELECT value FROM json_each(?3)) LIMIT 1")
    .bind(homeId, userId, JSON.stringify(admins))
    .first();
  return Boolean(row);
}

// The admins' browsers for the cloud's own alerts (`kind` offline, or schedule_failed from a driver
// before 1.7.0): those registered with an admin key by an account that uses it (for offline, only
// those that want it), and those registered without a key (apps before 1.7.0) by an account that
// holds an admin key at the home.
async function recipients(env, homeId, admins, kind) {
  if (!Array.isArray(admins) || admins.length === 0) {
    return [];
  }
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth, key_id FROM push_subscriptions AS s WHERE s.home_id = ?1 AND (" +
      "(s.key_id IS NULL AND s.user_id IN (SELECT user_id FROM member_keys WHERE home_id = ?1 AND key_id IN (SELECT value FROM json_each(?2)))) " +
      "OR (s.key_id IN (SELECT value FROM json_each(?2)) AND (?3 = 0 OR s.offline = 1) " +
      "AND EXISTS (SELECT 1 FROM member_keys AS m WHERE m.home_id = ?1 AND m.key_id = s.key_id AND m.user_id = s.user_id)))"
  )
    .bind(homeId, JSON.stringify(admins), kind === "offline" ? 1 : 0)
    .all();
  return results;
}

// The browsers registered with these key ids, each by an account that uses its key at the home.
async function keyRecipients(env, homeId, keyIds) {
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth, key_id FROM push_subscriptions AS s WHERE s.home_id = ?1 AND s.key_id IN (SELECT value FROM json_each(?2)) " +
      "AND EXISTS (SELECT 1 FROM member_keys AS m WHERE m.home_id = ?1 AND m.key_id = s.key_id AND m.user_id = s.user_id)"
  )
    .bind(homeId, JSON.stringify(keyIds))
    .all();
  return results;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// A notify message's `for`: key id -> { iv, ct, mac } (base64: a 16-byte IV, whole AES blocks, a
// 32-byte MAC). A Map, or null when it is not that.
function sealedParts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > NOTIFY_MAX_KEYS) {
    return null;
  }
  const parts = new Map();
  for (const [keyId, part] of entries) {
    const { iv, ct, mac } = part ?? {};
    const valid =
      validKeyId(keyId) &&
      typeof iv === "string" && iv.length === 24 && BASE64.test(iv) &&
      typeof mac === "string" && mac.length === 44 && BASE64.test(mac) &&
      typeof ct === "string" && ct.length >= 24 && ct.length <= SEALED_MAX_CT && ct.length % 4 === 0 && BASE64.test(ct);
    if (!valid) {
      return null;
    }
    parts.set(keyId, { iv, ct, mac });
  }
  return parts;
}

// --- The Worker's routes (homes.js) --------------------------------------------------------------

async function body(request) {
  try {
    const text = await readText(request, MAX_BODY_BYTES);
    const value = text === null ? null : JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// An operation of the home's object (HomeAlerts.request).
export async function homeObject(env, homeId, message) {
  const stub = env.HOME_RELAY.get(env.HOME_RELAY.idFromName(homeId));
  const response = await stub.fetch("https://home-relay/alerts", {
    method: "POST",
    headers: { "X-DirectorLink-Home": homeId, "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  return response.json();
}

// Subscriptions of these homes went (an account signed out everywhere, left, was removed or
// deleted, a home changed hands): each home's object looks again whether an admin's browser is
// still subscribed, and stops its alarms if not. Best effort: the change is made already, and a
// connected home's object also asks D1 again within the hour.
export async function homesChanged(env, homeIds) {
  await Promise.all(
    [...new Set(homeIds)].map((homeId) =>
      homeObject(env, homeId, { op: "changed" }).catch((error) => log("alerts_change_not_told", { home: homeId, error: String(error?.message ?? error) }))
    )
  );
}

const REFUSALS = {
  ADMIN_ONLY: [403, "Only the home's admins get its alerts"],
  KEY_NOT_LINKED: [403, "This account has not used that key at this home yet: send a sealed request through the account first"],
  NOT_A_MEMBER: [403, "This account does not belong to that home"],
  ROLES_UNKNOWN: [409, "The controller has not said who its admins are: alerts need DirectorLink 1.6.0 or later on it, with Remote Access on"],
};

// The routes above, for a signed-in account (homes.js checked the session and the origin).
export async function handleHomeAlerts(request, env, user, homeId) {
  const member = await env.DB.prepare("SELECT 1 AS found FROM members WHERE home_id = ? AND user_id = ?").bind(homeId, user.id).first();
  if (!member) {
    return problem(403, "NOT_A_MEMBER", "This account does not belong to that home");
  }
  if (request.method === "DELETE") {
    const input = await body(request);
    if (typeof input?.endpoint !== "string" || input.endpoint.length > 2048) {
      return problem(400, "INVALID_SUBSCRIPTION", "Send { endpoint } of the browser's push subscription");
    }
    const { meta } = await env.DB.prepare("DELETE FROM push_subscriptions WHERE home_id = ? AND user_id = ? AND endpoint = ?").bind(homeId, user.id, input.endpoint).run();
    await homeObject(env, homeId, { op: "changed", endpoint: input.endpoint });
    log("alerts_unsubscribed", { home: homeId, user: user.id, service: serviceOf(input.endpoint), removed: meta.changes ?? 0 });
    return new Response(null, { status: 204 });
  }
  const unusable = await vapidProblem(env);
  if (unusable) {
    log("alerts_not_configured", { why: unusable });
    return problem(503, "ALERTS_NOT_CONFIGURED", "Alerts are not set up on this server yet");
  }
  if (request.method === "GET") {
    return json({ public_key: env.VAPID_PUBLIC_KEY });
  }
  const input = await body(request);
  const keys = input && validEndpoint(env, input.endpoint) ? await subscriptionKeys(input.keys) : null;
  if (!keys) {
    return problem(400, "INVALID_SUBSCRIPTION", "Send the browser's push subscription: { endpoint, keys: { p256dh, auth } }, from a known push service");
  }
  // The key its device uses at the home (1.7.0); apps before 1.7.0 send none.
  if (
    (input.key_id !== undefined && !validKeyId(input.key_id)) ||
    (input.offline !== undefined && typeof input.offline !== "boolean") ||
    (input.device_requests !== undefined && typeof input.device_requests !== "boolean")
  ) {
    return problem(400, "INVALID_SUBSCRIPTION", "key_id must be the device's key id (8 hex characters), offline and device_requests true or false");
  }
  const answer = await homeObject(env, homeId, {
    op: "subscribe",
    user: user.id,
    endpoint: input.endpoint,
    ...keys,
    ...(input.key_id ? { key_id: input.key_id, offline: input.offline !== false } : {}),
    ...(input.key_id && typeof input.device_requests === "boolean" ? { device_requests: input.device_requests } : {}),
  });
  if (!answer?.ok) {
    const [status, detail] = REFUSALS[answer?.code] ?? [500, "The alerts could not be switched on; try again"];
    return problem(status, REFUSALS[answer?.code] ? answer.code : "INTERNAL_ERROR", detail);
  }
  return json({ alerts: true }, 201);
}

// --- In the home's Durable Object ----------------------------------------------------------------

export class HomeAlerts {
  // `relay`: the HomeRelay object (its storage, env, driver socket and when it was last heard).
  constructor(relay) {
    this.relay = relay;
  }

  // The object's storage, whose alarm is the alerts' share of the object's one (alarms.js, 1.12.0).
  get storage() {
    return this.relay.alertStorage ?? this.relay.ctx.storage;
  }

  get env() {
    return this.relay.env;
  }

  // The Worker's operations: { op: "subscribe", user, endpoint, p256dh, auth } after it checked
  // the account's membership and the subscription, { op: "changed" } after subscriptions went (with
  // the `endpoint` that went, when one browser did), { op: "admins" } for the admin key ids the
  // controller last announced (backups.js and device-requests.js ask), or { op: "device_request",
  // user, request } when a new device of that account asked to join (device-requests.js).
  async request(input, homeId) {
    if (input?.op === "subscribe") {
      return this.subscribe(input, homeId);
    }
    if (input?.op === "device_request") {
      return this.deviceRequest(input, homeId);
    }
    if (input?.op === "admins") {
      const stored = await this.storage.get(["alerts_admins", "driver_features"]);
      const admins = stored.get("alerts_admins");
      // What the home's driver said it takes (1.9.0: `users`, any device of an account approves).
      const features = stored.get("driver_features");
      return { ok: true, admins: Array.isArray(admins) ? admins : null, features: Array.isArray(features) ? features : null };
    }
    if (input?.op === "changed") {
      if (typeof input.endpoint === "string") {
        await this.deviceRequestChoice(input.endpoint, null);
      }
      // Only a home that is watching has anything to stop (and only it asks D1).
      if ((await this.storage.get("alerts_on")) === true) {
        await this.watch(homeId);
      }
      // A key may have no browser left now (1.9.0): its controller is told.
      if (this.takesGone()) {
        await this.browsersGone(homeId, [...((await this.relay.announcedKeys()) ?? [])]);
      }
      return { ok: true };
    }
    return { ok: false, code: "INVALID_REQUEST" };
  }

  async subscribe(input, homeId) {
    const keyId = input.key_id ?? null;
    if (keyId) {
      // Any role: the controller decides what each key gets. The account must use that key here;
      // a request it just sealed with the key is recorded after its answer (home-relay.js, "e2e"),
      // so the key work still queued is waited for first, as the app registers again right after.
      await this.relay.keyWork;
      const uses = await this.env.DB.prepare("SELECT 1 AS found FROM member_keys WHERE home_id = ? AND key_id = ? AND user_id = ?").bind(homeId, keyId, input.user).first();
      if (!uses) {
        log("alerts_refused", { home: homeId, user: input.user, why: "not this account's key" });
        return { ok: false, code: "KEY_NOT_LINKED" };
      }
    } else {
      const admins = await this.storage.get("alerts_admins");
      if (!Array.isArray(admins)) {
        return { ok: false, code: "ROLES_UNKNOWN" };
      }
      if (!(await isAdmin(this.env, homeId, input.user, admins))) {
        log("alerts_refused", { home: homeId, user: input.user, why: "not an admin" });
        return { ok: false, code: "ADMIN_ONLY" };
      }
    }
    const DB = this.env.DB;
    // The keys whose browser this registration took away (1.9.0, ADR-062): the endpoint's key
    // before, when it was registered with another; the oldest browsers of the account beyond
    // MAX_PER_MEMBER, which go.
    let replaced = [];
    try {
      const [selected, , deleted] = await DB.batch([
        DB.prepare("SELECT key_id FROM push_subscriptions WHERE home_id = ? AND endpoint = ?").bind(homeId, input.endpoint),
        DB.prepare(
          "INSERT INTO push_subscriptions (home_id, endpoint, user_id, p256dh, auth, created_at, key_id, offline) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (home_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, key_id = excluded.key_id, offline = excluded.offline, " +
            "created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.created_at ELSE excluded.created_at END, user_id = excluded.user_id"
        ).bind(homeId, input.endpoint, input.user, input.p256dh, input.auth, iso(), keyId, input.offline === false ? 0 : 1),
        DB.prepare(
          "DELETE FROM push_subscriptions WHERE home_id = ?1 AND user_id = ?2 AND endpoint NOT IN " +
            "(SELECT endpoint FROM push_subscriptions WHERE home_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, endpoint LIMIT ?3) RETURNING key_id"
        ).bind(homeId, input.user, MAX_PER_MEMBER),
      ]);
      replaced = [...(selected?.results ?? []), ...(deleted?.results ?? [])].map((row) => row.key_id).filter((id) => id && id !== keyId);
    } catch (error) {
      // The account left the home since the Worker looked (the subscription's foreign key).
      log("alerts_subscribe_failed", { home: homeId, user: input.user, error: String(error?.message ?? error) });
      return { ok: false, code: /FOREIGN KEY/i.test(String(error?.message)) ? "NOT_A_MEMBER" : "INTERNAL" };
    }
    const choice = keyId && typeof input.device_requests === "boolean" ? input.device_requests : null;
    if (choice !== null) {
      await this.deviceRequestChoice(input.endpoint, choice);
    }
    log("alerts_subscribed", { home: homeId, user: input.user, key: keyId, offline: input.offline !== false, device_requests: choice, service: serviceOf(input.endpoint) });
    await this.watch(homeId);
    // A key this took the last browser of is told to its controller, as whenever browsers go.
    if (replaced.length > 0) {
      await this.browsersGone(homeId, replaced);
    }
    return { ok: true };
  }

  // Keeps whether the browser of `endpoint` wants the push of a new device asking to join (`on`), or
  // forgets it (null). The newest DEVICE_REQUEST_CHOICES_MAX are kept.
  async deviceRequestChoice(endpoint, on) {
    const choices = (await this.storage.get("device_request_choices")) ?? {};
    const hash = await sha256Hex(endpoint);
    if (on === null) {
      if (!Object.hasOwn(choices, hash)) return;
      delete choices[hash];
    } else {
      choices[hash] = { on, at: Date.now() };
      const hashes = Object.keys(choices);
      if (hashes.length > DEVICE_REQUEST_CHOICES_MAX) {
        hashes.sort((a, b) => choices[b].at - choices[a].at);
        for (const old of hashes.slice(DEVICE_REQUEST_CHOICES_MAX)) delete choices[old];
      }
    }
    await this.storage.put("device_request_choices", choices);
  }

  // A new device of `input.user` asked to join (device-requests.js; `input.request` is its id): a
  // push, at once, to that account's browsers registered here with one of the home's admin keys that
  // want it, at most DEVICE_REQUEST_PUSHES_PER_HOUR an account an hour. The push says only that a
  // device asks, at this home, when, and the request's id: all of it the cloud's own.
  async deviceRequest(input, homeId) {
    const user = typeof input.user === "string" ? input.user : "";
    const request = typeof input.request === "string" && /^[0-9a-f]{32}$/.test(input.request) ? input.request : null;
    if (!user || !request) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    const stored = await this.storage.get(["alerts_admins", "driver_features"]);
    const admins = stored.get("alerts_admins");
    // A driver that lets every user add their own devices (1.9.0, ADR-061: `users` in its hello):
    // the account's devices at the home with any key approve, so all of them hear of it.
    const anyKey = Array.isArray(stored.get("driver_features")) && stored.get("driver_features").includes("users");
    if (!anyKey && (!Array.isArray(admins) || admins.length === 0)) {
      log("device_request_push_not_sent", { home: homeId, user, request, why: "no admin keys known" });
      return { ok: true, devices: 0 };
    }
    const now = Date.now();
    const pushes = {};
    for (const [account, times] of Object.entries((await this.storage.get("device_request_pushes")) ?? {})) {
      const recent = (Array.isArray(times) ? times : []).filter((time) => now - time < HOUR_MS && time <= now);
      if (recent.length) pushes[account] = recent;
    }
    if ((pushes[user] ?? []).length >= DEVICE_REQUEST_PUSHES_PER_HOUR) {
      log("device_request_push_limited", { home: homeId, user, request });
      return { ok: true, limited: true };
    }
    const { results } = await this.env.DB.prepare(
      "SELECT endpoint, p256dh, auth, key_id FROM push_subscriptions AS s WHERE s.home_id = ?1 AND s.user_id = ?2 AND s.key_id IS NOT NULL AND (?4 = 1 OR s.key_id IN (SELECT value FROM json_each(?3))) " +
        "AND EXISTS (SELECT 1 FROM member_keys AS m WHERE m.home_id = ?1 AND m.key_id = s.key_id AND m.user_id = s.user_id)"
    )
      .bind(homeId, user, JSON.stringify(Array.isArray(admins) ? admins : []), anyKey ? 1 : 0)
      .all();
    const choices = (await this.storage.get("device_request_choices")) ?? {};
    const list = [];
    for (const subscription of results) {
      if (choices[await sha256Hex(subscription.endpoint)]?.on === true) list.push(subscription);
    }
    if (list.length === 0) {
      log("device_request_push_not_sent", { home: homeId, user, request, why: "no admin's browser of this account wants it" });
      return { ok: true, devices: 0 };
    }
    pushes[user] = [...(pushes[user] ?? []), now];
    await this.storage.put("device_request_pushes", pushes);
    const message = { kind: "device_request", home: homeId, at: iso(now), request };
    const outcome = await this.deliver(homeId, list, () => message, DEVICE_REQUEST_TTL_SECONDS, "device_request");
    const counts = outcome ? outcome.counts : { devices: list.length, delivered: 0 };
    log("device_request_pushed", { home: homeId, user, request, ...counts });
    return { ok: true, devices: counts.devices, delivered: counts.delivered };
  }

  // Whether an admin's browser is subscribed; the object sets alarms only then. Returns it.
  async watch(homeId) {
    const stored = await this.storage.get(["alerts_home", "alerts_admins", "alerts_on"]);
    const home = homeId ?? stored.get("alerts_home");
    if (homeId && stored.get("alerts_home") !== homeId) {
      await this.storage.put("alerts_home", homeId);
    }
    const on = Boolean(home) && (await recipients(this.env, home, stored.get("alerts_admins"), "offline")).length > 0;
    if (stored.get("alerts_on") !== on) {
      await this.storage.put("alerts_on", on);
      if (stored.get("alerts_on") === true) {
        log("alerts_stopped", { home, why: "no admin's browser is subscribed" });
      }
    }
    if (!on) {
      await this.storage.deleteAlarm();
    } else if ((await this.storage.getAlarm()) === null) {
      // The first look decides: the driver may be away already.
      await this.storage.setAlarm(Date.now() + 1000);
    }
    return on;
  }

  // The controller's admin key ids, with its key ids (a "keys" message); `admins` is undefined
  // from drivers before 1.6.0, which do not say.
  async keys(homeId, ids, admins) {
    const list = validKeyList(admins) ? [...new Set(admins)].filter((id) => ids.includes(id)).sort() : null;
    const stored = await this.storage.get(["alerts_admins", "alerts_on"]);
    if (JSON.stringify(stored.get("alerts_admins") ?? null) !== JSON.stringify(list)) {
      await (list ? this.storage.put("alerts_admins", list) : this.storage.delete("alerts_admins"));
    }
    // Admins may have changed: only homes with a subscription ask D1.
    if (stored.get("alerts_on") !== undefined) {
      await this.watch(homeId);
    }
    // Which of its keys no browser can get alerts for (1.9.0): browsers that went while it was away
    // (the offline alert's pushes) or without their device telling it.
    await this.browsersGone(homeId, ids);
  }

  // Whether the driver, connected and heard, takes "alerts_gone" (its hello lists it, 1.9.0).
  takesGone() {
    return typeof this.relay.driverTakes === "function" && Boolean(this.relay.driverTakes("alerts_gone"));
  }

  // Tells the controller which of `keyIds` have no browser left (1.9.0, ADR-062): those `left` (the
  // browsers of these keys still there, when the caller has them all) does not name; without `left`,
  // D1 says. Only to a driver that takes it, and only key ids.
  async browsersGone(homeId, keyIds, left = null) {
    const ids = [...new Set(keyIds)].filter(validKeyId);
    if (ids.length === 0 || !this.takesGone()) {
      return;
    }
    let still;
    try {
      still = new Set((left ?? (await keyRecipients(this.env, homeId, ids))).map((subscription) => subscription.key_id));
    } catch (error) {
      // Told at the next "keys", notify or push.
      log("alerts_gone_failed", { home: homeId, error: String(error?.message ?? error) });
      return;
    }
    const keys = ids.filter((id) => !still.has(id)).sort().slice(0, GONE_MAX_KEYS);
    if (keys.length > 0 && this.relay.tellDriver({ type: "alerts_gone", keys }, "alerts_gone")) {
      log("alerts_gone_told", { home: homeId, keys: keys.length });
    }
  }

  // The driver connected: its absence, if any, is over.
  async connected(homeId) {
    const stored = await this.storage.get(["alerts_on", "away_since", "offline_alerted", "offline_retry"]);
    if (stored.get("away_since") !== undefined || stored.get("offline_alerted") !== undefined || stored.get("offline_retry") !== undefined) {
      await this.storage.delete(["away_since", "offline_alerted", "offline_retry"]);
    }
    if (stored.get("alerts_on") === true) {
      await this.storage.setAlarm(Date.now() + offlineMs(this.env));
    }
  }

  // The driver disconnected (and no other connection of it is open) at `at`.
  async disconnected(at) {
    await this.storage.put("away_since", at);
    if ((await this.storage.get("alerts_on")) === true) {
      await this.storage.setAlarm(at + offlineMs(this.env));
    }
  }

  async alarm() {
    try {
      await this.look();
    } catch (error) {
      // D1 or storage failed: the object goes on watching, and looks again at its usual pace.
      log("alert_alarm_failed", { error: String(error?.message ?? error) });
      await this.storage.setAlarm(Date.now() + offlineMs(this.env));
    }
  }

  async look() {
    const stored = await this.storage.get(["alerts_on", "alerts_home", "away_since"]);
    const homeId = stored.get("alerts_home");
    if (stored.get("alerts_on") !== true || !homeId) {
      return;
    }
    const now = Date.now();
    const limit = offlineMs(this.env);
    const ws = this.relay.driverSocket();
    if (ws) {
      const seen = this.relay.lastSeen(ws);
      if (!quiet(this.relay, ws, now)) {
        // Connected, and its pings are answered: look again later. Back without reconnecting
        // after an alert, it may be alerted about again.
        const marks = await this.storage.get(["offline_alerted", "offline_retry", "alerts_checked"]);
        if (marks.get("offline_alerted") !== undefined || marks.get("offline_retry") !== undefined) {
          await this.storage.delete(["offline_alerted", "offline_retry"]);
        }
        // Now and then D1 is asked again, in case subscriptions went without the object being told.
        if (!(now - marks.get("alerts_checked") < RECHECK_TIMES * limit)) {
          if (!(await this.watch(homeId))) {
            return; // nobody to alert: no more alarms
          }
          await this.storage.put("alerts_checked", now);
        }
        await this.storage.setAlarm(now + limit);
        return;
      }
      // Connected, but silent: away since it was last heard. The socket may come back to life,
      // so after an alert it is looked at again.
      if (!(await this.whenAway(homeId, seen, now, limit))) {
        await this.storage.setAlarm(now + limit);
      }
      return;
    }
    let since = stored.get("away_since");
    if (!Number.isFinite(since)) {
      // No disconnect was seen: the relay restarted under the connection (a deploy ends the socket
      // without webSocketClose). When it ended is not known; the driver normally connects again
      // within seconds, so the 10 minutes count from now.
      since = now;
      await this.storage.put("away_since", since);
    }
    // No alarm after an alert: the next connection starts watching again.
    await this.whenAway(homeId, since, now, limit);
  }

  // The driver is away since `since`: the offline alert once it has been `limit`, once per absence;
  // until then, an alarm for that moment (and true). An alert that did not get through is tried
  // again (an alarm, and true) until ALERT_TRIES sends; only then is the absence marked alerted.
  async whenAway(homeId, since, now, limit) {
    if (now - since < limit) {
      await this.storage.setAlarm(since + limit);
      return true;
    }
    const stored = await this.storage.get(["offline_alerted", "offline_retry"]);
    if (stored.get("offline_alerted") !== undefined) {
      return false;
    }
    const before = stored.get("offline_retry") ?? { tries: 0, endpoints: null };
    let left;
    try {
      left = await this.send(homeId, "offline", since, before.endpoints);
    } catch (error) {
      // D1 could not say who to alert: everyone still waiting, again.
      log("alert_failed", { home: homeId, kind: "offline", error: String(error?.message ?? error) });
      left = before.endpoints;
    }
    const tries = before.tries + 1;
    if ((left === null || left.length > 0) && tries < ALERT_TRIES) {
      await this.storage.put("offline_retry", { tries, endpoints: left });
      await this.storage.setAlarm(now + retryMs(this.env));
      log("alert_retry", { home: homeId, kind: "offline", tries, devices: left === null ? null : left.length });
      return true;
    }
    await this.storage.put("offline_alerted", now);
    if (stored.get("offline_retry") !== undefined) {
      await this.storage.delete("offline_retry");
    }
    return false;
  }

  // {"type":"alert"} from a controller before 1.7.0: { kind: "schedule_failed", at }.
  async fromHome(data, homeId) {
    if (data?.kind !== "schedule_failed") {
      log("alert_ignored", { home: homeId, kind: typeof data?.kind === "string" ? data.kind.slice(0, 40) : null });
      return;
    }
    const now = Date.now();
    const at = Date.parse(data.at);
    const when = Number.isFinite(at) && Math.abs(at - now) <= 24 * HOUR_MS ? at : now;
    const recent = ((await this.storage.get("schedule_alerts")) ?? []).filter((time) => now - time < HOUR_MS);
    if (recent.length >= SCHEDULE_ALERTS_PER_HOUR) {
      log("alert_limited", { home: homeId, kind: data.kind, at: iso(when) });
      return;
    }
    recent.push(now);
    await this.storage.put("schedule_alerts", recent);
    await this.send(homeId, "schedule_failed", when);
  }

  // Sends one alert to the admins' browsers (`only`: to those of these endpoints); forgets those
  // the push service no longer knows. Returns the endpoints worth sending to again (retryable). A
  // failed D1 read throws.
  async send(homeId, kind, at, only = null) {
    if (!KINDS.has(kind)) {
      return [];
    }
    let list = await recipients(this.env, homeId, await this.storage.get("alerts_admins"), kind);
    if (only) {
      list = list.filter((subscription) => only.includes(subscription.endpoint));
    }
    if (list.length === 0) {
      if (!only) {
        log("alert_not_sent", { home: homeId, kind, why: "no admin's browser is subscribed" });
        await this.watch(homeId);
      }
      return [];
    }
    const message = { kind, home: homeId, at: iso(at) };
    const outcome = await this.deliver(homeId, list, () => message, ALERT_TTL_SECONDS, kind);
    if (!outcome) {
      return list.map((subscription) => subscription.endpoint);
    }
    log("alert_sent", { home: homeId, kind, at: message.at, ...outcome.counts });
    return outcome.again;
  }

  // {"type":"notify"} from the controller (1.7.0, ADR-050): each sealed part to the browsers of its
  // key, once, at once. Nothing in it says what it is about; only how many are logged. One with an
  // `id` (1.10.1, ADR-073) is answered with `answer({ type: "notify_result", id, ok })` once its id
  // is recorded (before the pushes: the driver may then forget it), and one whose id was handled
  // already is answered the same and not pushed again: the driver sent it again after a lost
  // connection, not knowing it had arrived. Recorded before it is pushed, so that no event is ever
  // pushed twice: should the object fail in between, the alert is lost rather than doubled.
  async notify(data, homeId, answer = () => {}) {
    const id = typeof data?.id === "string" && NOTIFY_ID.test(data.id) ? data.id : null;
    const resent = Number.isInteger(data?.resent) && data.resent > 0 ? data.resent : undefined;
    const parts = sealedParts(data?.for);
    if (!parts) {
      log("notify_ignored", { home: homeId, why: "not sealed parts for key ids" });
      if (id) answer({ type: "notify_result", id, ok: false, code: "INVALID_REQUEST" });
      return;
    }
    if (id) {
      const first = await this.firstNotify(id);
      answer({ type: "notify_result", id, ok: true });
      if (!first) {
        log("notify_again", { home: homeId, keys: parts.size, resent: resent ?? null });
        return;
      }
    }
    const now = Date.now();
    const recent = ((await this.storage.get("notify_times")) ?? []).filter((time) => now - time < HOUR_MS && time <= now);
    if (recent.length >= NOTIFY_PER_HOUR) {
      log("notify_limited", { home: homeId, keys: parts.size });
      return;
    }
    recent.push(now);
    await this.storage.put("notify_times", recent);
    const at = Date.parse(data.at);
    const when = iso(Number.isFinite(at) && Math.abs(at - now) <= 24 * HOUR_MS ? at : now);
    let list;
    try {
      list = await keyRecipients(this.env, homeId, [...parts.keys()]);
    } catch (error) {
      log("notify_failed", { home: homeId, error: String(error?.message ?? error) });
      return;
    }
    // `resent`: it reached the relay only when the driver sent it again (1.10.1).
    const again = resent ? { resent } : {};
    if (list.length === 0) {
      log("notify_sent", { home: homeId, at: when, keys: parts.size, devices: 0, ...again });
      await this.browsersGone(homeId, [...parts.keys()], []);
      return;
    }
    const brief = data.brief === true;
    const messageOf = (subscription) => ({ kind: "sealed", home: homeId, key: subscription.key_id, at: when, sealed: parts.get(subscription.key_id) });
    // `list` has every browser of the keys it names: those with none, or none left, are told.
    const outcome = await this.deliver(homeId, list, messageOf, brief ? BRIEF_TTL_SECONDS : ALERT_TTL_SECONDS, "sealed", [...parts.keys()]);
    log("notify_sent", { home: homeId, at: when, keys: parts.size, brief, ...(outcome ? outcome.counts : { devices: list.length, delivered: 0 }), ...again });
  }

  // Whether the notify `id` is new here (1.10.1, ADR-073); records it if so. The ids live in storage
  // (`notify_ids`) and, once read, in memory: a socket's messages may wake an object that was
  // evicted while the driver reconnected (hibernation), or a new one after a deploy, and the id
  // sent again must still be known there. The check and the record happen with nothing awaited
  // between them, so the same id on two sockets at once is pushed once. A failed write forgets
  // the id again (and throws: neither answered nor pushed; the driver sends it again at its next
  // connection, while it keeps it).
  async firstNotify(id) {
    if (!this.notifyIds) {
      this.notifyIds = this.storage.get("notify_ids").then(
        (stored) => new Map((Array.isArray(stored) ? stored : []).filter((item) => Array.isArray(item) && typeof item[0] === "string" && Number.isFinite(item[1]))),
        (error) => {
          this.notifyIds = null;
          throw error;
        }
      );
    }
    const ids = await this.notifyIds;
    const now = Date.now();
    for (const [old, at] of ids) {
      if (now - at <= NOTIFY_IDS_MS) break;
      ids.delete(old);
    }
    if (ids.has(id)) {
      return false;
    }
    ids.set(id, now);
    while (ids.size > NOTIFY_IDS_MAX) {
      ids.delete(ids.keys().next().value);
    }
    try {
      await this.storage.put("notify_ids", [...ids]);
    } catch (error) {
      ids.delete(id);
      throw error;
    }
    return true;
  }

  // Pushes `messageOf(subscription)` to each of `list`, kept `ttl` seconds by the push service, and
  // forgets the browsers it no longer knows; the controller is told which keys have none left
  // (browsersGone). `named`: the key ids of a notify, whose every browser `list` has. Returns
  // { counts, again } (the endpoints worth sending to again), or null when the VAPID settings do not
  // work.
  async deliver(homeId, list, messageOf, ttl, kind, named = null) {
    let statuses;
    try {
      statuses = await Promise.all(list.map((subscription) => sendPush(this.env, subscription, messageOf(subscription), { ttl })));
    } catch (error) {
      log("alert_failed", { home: homeId, kind, error: String(error?.message ?? error) });
      return null;
    }
    const isGone = (index) => statuses[index] === 404 || statuses[index] === 410;
    const gone = list.filter((_, index) => isGone(index));
    if (gone.length > 0) {
      const DB = this.env.DB;
      try {
        await DB.batch(gone.map((subscription) => DB.prepare("DELETE FROM push_subscriptions WHERE home_id = ? AND endpoint = ?").bind(homeId, subscription.endpoint)));
        await this.watch(homeId);
      } catch (error) {
        // Forgotten at the next alert; what was delivered is not sent again.
        log("alert_failed", { home: homeId, kind, error: String(error?.message ?? error) });
      }
    }
    if (named) {
      await this.browsersGone(homeId, named, list.filter((_, index) => !isGone(index)));
    } else if (gone.length > 0) {
      await this.browsersGone(homeId, gone.map((subscription) => subscription.key_id).filter(Boolean));
    }
    const again = list.filter((_, index) => retryable(statuses[index])).map((subscription) => subscription.endpoint);
    return {
      again,
      counts: {
        devices: list.length,
        delivered: statuses.filter((status) => status >= 200 && status < 300).length,
        gone: gone.length,
        failed: statuses.filter((status) => !(status >= 200 && status < 300) && status !== 404 && status !== 410),
        again: again.length,
      },
    };
  }
}
