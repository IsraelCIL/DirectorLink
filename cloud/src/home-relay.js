// One Durable Object per home (named by home_id): holds the driver's WebSocket and relays requests
// over it (docs/RELAY.md): version 0 test requests, and the sealed messages of accounts
// (docs/ACCOUNTS.md), which it passes on without being able to read them.
//
// The socket uses the WebSocket Hibernation API: while nothing is being relayed, the object can be
// evicted from memory and the connection stays open without duration charges. The keep-alive
// "ping" is answered "pong" by the runtime itself (setWebSocketAutoResponse), so it never wakes the
// object; getWebSocketAutoResponseTimestamp() tells when the last one was answered. What has to
// survive hibernation lives in the socket's attachment or in storage:
//
//   attachment  { conn, home, connectedAt, version, lastSeen,         per socket (milliseconds)
//                 pingS, stale, features, instance }                  ping interval from the hello;
//                                                                     when it was found quiet; what
//                                                                     the hello says it takes (1.7.0);
//                                                                     which start of the driver (1.10.0)
//   storage     secret_sha256                                         SHA-256 hex of the home_secret,
//                                                                     trusted on first use
//               connected_at, disconnected_at, last_seen, version     for the status (ISO times)
//               driver_features                                       the last hello's features
//                                                                     (1.9.0: alerts.js and
//                                                                     device-requests.js ask)
//
// A driver whose connection is lost connects again within seconds (1.5.0). A request that arrives
// meanwhile, up to 30 s after the disconnect or after a restart under the connection, waits up to
// 8 s for its hello instead of failing with HOME_OFFLINE (liveDriver).
//
// A connection can also die without the relay seeing a close: the socket stays open here while
// nothing reaches the driver. The driver pings every 5 s (1.10.0; every 10 s from 1.6.0, and its
// hello says so in ping_s; older drivers ping every 25 s), so a socket whose pings stopped for 2.5
// intervals is taken as gone (stale): requests wait for the driver's next connection as after a
// disconnect, and the status says offline.
//
// A request already sent when the connection ends (1.10.0, ADR-072) is sent again, the same frame
// with the same id, on the driver's next connection once its hello lists `resend` and names the same
// driver `instance` (resendLost): that driver runs each id once and gives a repeat its first answer.
//
// Every request ends within REQUEST_BUDGET_MS (18 s) of reaching this object (1.10.1, ADR-073): the
// wait for the driver, the sends and the answer together, so the app (20 s) hears the relay's 504.
// An alert the driver sends with an id (`notify`, 1.10.1) is answered `notify_result`, and one it
// sends again after a lost connection is not pushed twice (alerts.js keeps the ids it handled).

import { DurableObject } from "cloudflare:workers";
import { bearerToken, json, problem, sameSecret, sha256Hex } from "./http.js";
import { keyAccounts, recordUsedKey, syncKeys, validKeyList } from "./member-keys.js";
import { cancelHomeInvitation, cancelOwnerMove, moveHomeOwner, registerHomeInvitation } from "./homes.js";
import { receiveBackupChunk } from "./backups.js";
// Scene links (ADR-051): a phone's automation runs a scene; the controller checks the secret.
import { LINK_ID, LINK_SECRET, RESULT_MESSAGES, linkNotFound } from "./scene-links.js";
// Alerts (ADR-047, ADR-050): this object tells alerts.js when the driver connects and disconnects,
// the admin key ids and the controller's "alert" and "notify" messages, and runs its alarms; alerts.js
// tells the driver which keys' browsers are gone (1.9.0, ADR-062: tellDriver).
import { HomeAlerts } from "./alerts.js";
// The oldest DirectorLink the relay takes (ADR-059): a home whose last driver is older is answered
// HOME_UPDATE_REQUIRED, not HOME_OFFLINE (the Worker refuses that driver's connections).
import { updateRequired } from "./min-version.js";
// Direct HTTPS (1.12.0, ADR-082): the controller's certificate for its own name and the name's A
// record (https.js), its order run from the object's alarm, which alerts.js shares (alarms.js).
import { Alarms } from "./alarms.js";
import { HTTPS_FEATURE, HomeHttps } from "./https.js";

const DRIVER = "driver";
const OPEN = 1; // WebSocket readyState
const DEFAULT_TIMEOUT_MS = 15000;
const NULL_BODY_STATUS = new Set([204, 205, 304]);
// A request that finds no driver within RECONNECT_GRACE_MS of its disconnect waits up to
// RECONNECT_WAIT_MS for it to connect again (it does within seconds: docs/RELAY.md), rather than
// failing with HOME_OFFLINE. Longer gone, the home is offline and the answer is immediate.
const RECONNECT_GRACE_MS = 30000;
const DEFAULT_RECONNECT_WAIT_MS = 8000;
// A socket on which the driver has not been heard (a ping answered, or a message) for
// STALE_PINGS of its ping intervals is stale. Drivers before 1.6.0 announce no interval: 25 s.
const STALE_PINGS = 2.5;
const DEFAULT_PING_S = 25;
// A request already sent when the driver's connection ended (closed, failed, or replaced by a new
// one: 1.10.0, ADR-072) waits for the driver's next hello, at most RECONNECT_WAIT_MS, and goes again
// on that connection when the hello lists `resend` and comes from the same driver instance (one that
// has not restarted: its memory of what it ran is whole). At most MAX_RESENDS times, and only within
// RESEND_WITHIN_MS (10 s) of reaching the relay; each resend waits RESEND_TIMEOUT_MS for its answer. So a
// resent request is answered within 18 s of reaching the relay, under the app's 20 s (app/js/
// remote.js). Otherwise it fails as before (502 HOME_DISCONNECTED).
const RESEND_FEATURE = "resend";
const MAX_RESENDS = 2;
const DEFAULT_RESEND_WITHIN_MS = 10000;
const RESEND_TIMEOUT_MS = 8000;
// Every request ends within this long of reaching the home's object (1.10.1, ADR-073): waiting for
// the driver to come back (RECONNECT_WAIT_MS), sending, sending again (above) and the answer
// (REQUEST_TIMEOUT_MS) together. Up to 1.10.0 a request that first waited 8 s for the driver then
// had the full 15 s for its answer: 23 s, while the app gives up after 20 s (app/js/remote.js) and
// says DirectorLink's servers could not be reached, though the home may still carry it out. At 18 s
// the relay's own 504 HOME_TIMEOUT reaches the app first, with time to spare for the Worker's own
// work and the way back.
const REQUEST_BUDGET_MS = 18000;
// A relayed message is logged only when it was refused or took this long (1.11.0, ADR-081): one
// line per message was most of the Worker's log, and logs are billed by the line.
const SLOW_MESSAGE_MS = 3000;
// A driver whose hello lists this keeps the alerts it sends (`notify`) until the relay answers
// `notify_result`, and sends them again after a lost connection (1.10.1, ADR-073); the relay says
// it does, right after that hello (`relay_features`). Alerts.js pushes each id once.
const ALERT_ACKS = "alert_acks";
// The driver ran a request sent again but no longer has its answer (too large to keep, such as a
// picture): the caller gets 502 HOME_DISCONNECTED, as before 1.10.0 when the connection ended.
const ANSWER_NOT_KEPT = "ANSWER_NOT_KEPT";
const ANSWER_TYPES = new Set(["e2e", "join_result", "claim_result", "link_result"]);
// Scene links (ADR-051): at most this many runs a minute reach the home, whatever their link.
const LINK_RUNS_PER_MINUTE = 30;
// A client (an address; an IPv6 one by its /64) whose runs were refused as unknown this many times
// within LINK_MISS_WINDOW_MS gets 429 until the first of them is that old, before its runs count
// against the home's limit: someone guessing from one place cannot use up the family's runs. At
// most LINK_CLIENTS clients are remembered (the one seen longest ago goes first), in memory only.
const LINK_MISSES_PER_CLIENT = 10;
const LINK_MISS_WINDOW_MS = 10 * 60 * 1000;
const LINK_CLIENTS = 1000;

// The client a scene link's run came from (CF-Connecting-IP), for its limit: an IPv4 address, or
// the first 64 bits of an IPv6 address (one subscriber's network: the rest is chosen at will).
export function linkClient(address) {
  const text = String(address ?? "").trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) return mapped[1];
  if (!text.includes(":")) return text;
  const [head, tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export class HomeRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Relayed requests waiting for the driver: id -> { resolve, timer, conn, record, resend,
    // deadline } (`deadline`, 1.10.1: when its budget ends, REQUEST_BUDGET_MS after it came).
    // `resend` (1.10.0): { frame, instance, receivedAt, sent, lostAt, why } for one the driver may be
    // sent again (`instance` once its connection's hello listed `resend`); `lostAt` while its
    // connection has ended and it waits for the next hello. Memory is
    // enough: while a request waits, its caller's fetch keeps the object awake, so hibernation
    // never drops this map with anything in it.
    this.pending = new Map();
    // Requests waiting for the driver to connect again (liveDriver): each is called with the new
    // socket at its hello. Kept in memory for the same reason as `pending`.
    this.waiting = new Set();
    // Work on which account uses which key runs one step after another, in the order of the
    // driver's frames (member-keys.js); `announced` is its last list of key ids.
    this.keyWork = Promise.resolve();
    this.announced = undefined;
    // One alarm for the object, shared by the alerts and Direct HTTPS's orders (1.12.0): alerts.js
    // sets "its" alarm through alertStorage.
    this.alarms = new Alarms(ctx.storage);
    this.alertStorage = this.alarms.storageFor("alerts");
    this.alerts = new HomeAlerts(this);
    this.https = new HomeHttps(this);
    // When the last scene link runs went to the home (milliseconds), for its limit, and when each
    // client's last runs were refused as unknown (linkClient -> [ms], oldest seen first). Memory is
    // enough: a flood keeps the object awake.
    this.linkRuns = [];
    this.linkMisses = new Map();
  }

  // Queues `work` behind the key work already waiting; returns when it is done.
  queueKeyWork(work, homeId) {
    this.keyWork = this.keyWork.then(work).catch((error) => log("key_work_failed", { home: homeId, error: String(error?.message ?? error) }));
    return this.keyWork;
  }

  // The driver's last list of key ids, from storage after a hibernation; null if it never sent one.
  async announcedKeys() {
    if (this.announced === undefined) {
      const stored = await this.ctx.storage.get("key_ids");
      this.announced = Array.isArray(stored) ? new Set(stored) : null;
    }
    return this.announced;
  }

  // Called by the Worker (index.js), which has already checked the request.
  async fetch(request) {
    const homeId = request.headers.get("X-DirectorLink-Home") ?? "";
    switch (new URL(request.url).pathname) {
      case "/relay/connect":
        return this.connect(request, homeId);
      case "/status":
        return json(await this.status());
      case "/forward":
        return this.forward(request.headers.get("X-DirectorLink-Path") ?? "", homeId);
      case "/message":
        return this.message(await request.json(), homeId, request.headers.get("X-DirectorLink-User"));
      case "/secret":
        return this.replaceSecret(await request.json(), homeId);
      case "/alerts":
        return json(await this.alerts.request(await request.json(), homeId));
      case "/link":
        return this.link(await request.json(), homeId, request.headers.get("X-DirectorLink-Client"));
      case "/accounts":
        // Which account uses which key changed in D1 (a join, a member removed: homes.js).
        await this.queueKeyWork(() => this.sendAccounts(), homeId);
        return json({ ok: true });
      default:
        return problem(404, "NOT_FOUND", "Unknown relay operation");
    }
  }

  // --- The driver's connection ---------------------------------------------------------------

  async connect(request, homeId) {
    const secret = bearerToken(request);
    if (!secret) {
      return problem(400, "INVALID_HOME_SECRET", "Authorization must be Bearer <home_secret>");
    }
    // Trust on first use: the first secret seen for this home is the only one accepted afterwards.
    const hash = await sha256Hex(secret.toLowerCase());
    const known = await this.ctx.storage.get("secret_sha256");
    if (known === undefined) {
      await this.ctx.storage.put("secret_sha256", hash);
      log("home_registered", { home: homeId });
    } else if (!(await sameSecret(hash, known))) {
      log("wrong_secret", { home: homeId });
      return problem(401, "WRONG_HOME_SECRET", "This home_id is registered with a different home_secret");
    }

    // One driver connection per home: a new one replaces the previous. Requests sent over the
    // previous one end their wait there now rather than at their timeout: a driver that connects
    // again has lost that connection, often without the relay noticing (the old socket never
    // answers the close). They fail, or (1.10.0) wait for this connection's hello to go again.
    let replaced = 0;
    for (const old of this.ctx.getWebSockets(DRIVER)) {
      const attachment = old.deserializeAttachment() ?? {};
      this.connectionLost(attachment, "The home connected again before it answered");
      try {
        old.close(4000, "replaced");
        replaced += 1;
      } catch {
        // Already closing.
      }
    }

    const now = Date.now();
    const version = cleanVersion(request.headers.get("X-DirectorLink-Version"));
    // How long the home was away, when its last disconnect was recorded.
    const before = await this.ctx.storage.get(["connected_at", "disconnected_at"]);
    const lastConnect = Date.parse(before.get("connected_at") ?? "");
    const lastDisconnect = Date.parse(before.get("disconnected_at") ?? "");
    const downMs = replaced === 0 && lastDisconnect >= (lastConnect || 0) ? now - lastDisconnect : null;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [DRIVER]);
    server.serializeAttachment({ conn: crypto.randomUUID(), home: homeId, connectedAt: now, version, lastSeen: now });
    const at = iso(now);
    await this.ctx.storage.put({ connected_at: at, last_seen: at, version });
    await this.alerts.connected(homeId);
    log("driver_connected", { home: homeId, version, replaced, down_ms: Number.isFinite(downMs) ? downMs : null });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Without Cloudflare's invocation logs (ADR-081) an error thrown here would leave no line: it is
  // logged, then thrown as before.
  async webSocketMessage(ws, message) {
    try {
      await this.socketMessage(ws, message);
    } catch (error) {
      log("socket_message_failed", { error: String(error?.stack ?? error) });
      throw error;
    }
  }

  async socketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() ?? {};
    attachment.lastSeen = Date.now();
    let data = null;
    if (typeof message === "string") {
      try {
        data = JSON.parse(message);
      } catch {
        // Not JSON; ignored below.
      }
    }
    const type = data?.type;
    if (type === "hello") {
      attachment.version = cleanVersion(data.version) ?? attachment.version ?? null;
      attachment.pingS = pingSeconds(data.ping_s);
      // What the driver takes besides what every version does (1.7.0: scene_links).
      attachment.features = Array.isArray(data.features) ? data.features.filter((item) => typeof item === "string" && item.length <= 32).slice(0, 16) : [];
      // Which start of the driver this is (1.10.0): a random id it makes at each start.
      attachment.instance = typeof data.instance === "string" && /^[0-9a-f]{16,64}$/.test(data.instance) ? data.instance : null;
    }
    ws.serializeAttachment(attachment);

    // A request sent again whose answer the driver no longer has (1.10.0): it ran, or may have (the
    // driver had to forget requests meanwhile and did not run it again), but its answer was lost
    // with the connection, as before 1.10.0.
    if (ANSWER_TYPES.has(type) && data.code === ANSWER_NOT_KEPT && !data.envelope) {
      if (typeof data.id !== "string" || !this.settle(data.id, { failed: "The home may have carried it out, but its answer was lost with the connection" })) {
        log("response_ignored", { home: attachment.home, type, id: data.id ?? null, why: "no request is waiting for this id" });
      }
      return;
    }

    switch (type) {
      case "hello":
        // This relay answers each alert with an id (1.10.1, ADR-073): said at once, before anything
        // else the hello lets it send (`accounts`, `alerts_gone`, requests sent again), so that the
        // driver sends again what it kept from its last connection, and knows a relay that does not.
        // Since 1.12.0 also that it issues Direct HTTPS certificates (https.js, ADR-082).
        if (attachment.features.includes(ALERT_ACKS)) {
          this.reply(ws, { type: "relay_features", id: crypto.randomUUID(), features: [ALERT_ACKS, HTTPS_FEATURE] });
        }
        await this.ctx.storage.put({ version: attachment.version, last_seen: iso(attachment.lastSeen), driver_features: attachment.features });
        if (data.home !== attachment.home) {
          log("hello_home_mismatch", { home: attachment.home, hello_home: String(data.home) });
        }
        log("driver_hello", { home: attachment.home, version: attachment.version, interval_s: attachment.pingS, waiting: this.waiting.size });
        // Requests whose connection ended go again first (1.10.0), then those that waited for it.
        this.resendLost(ws, attachment);
        for (const resume of [...this.waiting]) {
          resume(ws);
        }
        return;
      case "keys": {
        // The home's key ids after a change: members whose keys are all revoked leave it. The list
        // counts from now on, before any frame that follows it.
        if (!validKeyList(data.ids)) {
          log("keys_ignored", { home: attachment.home, why: "not a list of key ids" });
          return;
        }
        const ids = [...new Set(data.ids)];
        this.announced = new Set(ids);
        await this.queueKeyWork(async () => {
          await this.ctx.storage.put("key_ids", ids);
          try {
            await syncKeys(this.env, attachment.home, ids);
          } finally {
            // The admin list counts even when D1 failed above (alerts and backups read it).
            await this.alerts.keys(attachment.home, ids, data.admins);
          }
          // Which of the keys left share an account (1.9.0, ADR-061).
          await this.sendAccounts(ws);
        }, attachment.home);
        return;
      }
      case "e2e": {
        // The home accepted a request sealed with this key: the account that sent it holds it.
        const record = data.envelope && typeof data.id === "string" ? this.pending.get(data.id)?.record : null;
        const work = record
          ? this.queueKeyWork(async () => {
              // A key newly seen with an account: the controller hears which keys share one.
              if ((await recordUsedKey(this.env, attachment.home, record.user, record.key, await this.announcedKeys())) === "added") {
                await this.sendAccounts(ws);
              }
            }, attachment.home)
          : null;
        if (typeof data.id !== "string" || !this.settle(data.id, { message: data })) {
          log("response_ignored", { home: attachment.home, type, id: data.id ?? null, why: "no request is waiting for this id" });
        }
        await work;
        return;
      }
      case "join_result":
        await this.keyWork;
        if (typeof data.id !== "string" || !this.settle(data.id, { message: data })) {
          log("response_ignored", { home: attachment.home, type, id: data.id ?? null, why: "no request is waiting for this id" });
        }
        return;
      case "invitation": {
        // The controller registers an invitation it made for an admin: only the home can, so a
        // member cannot bind an invitation id to an email (docs/ACCOUNTS.md).
        let result;
        try {
          result = await registerHomeInvitation(this.env, attachment.home, data);
        } catch (error) {
          log("invitation_failed", { home: attachment.home, error: String(error?.message ?? error) });
          result = { ok: false, code: "INTERNAL" };
        }
        this.reply(ws, { type: "invitation_result", id: data.id, ...result });
        return;
      }
      case "backup_chunk": {
        // A chunk of the day's sealed backup (backups.js); the next waits for this answer.
        let result;
        try {
          result = await receiveBackupChunk(this.env, attachment.home, data, this.ctx.storage);
        } catch (error) {
          log("backup_chunk_failed", { home: attachment.home, error: String(error?.message ?? error) });
          result = { ok: false, code: "INTERNAL" };
        }
        this.reply(ws, { type: "backup_result", id: data.id, ...result });
        return;
      }
      case "owner": {
        // The controller made another of its admins the home's owner (1.9.0, ADR-064): the home's
        // owner account follows, only on its word over this connection (homes.js), after the key
        // work its frames queued before (the admin keys of its last "keys" count).
        const result = await this.queueKeyWork(async () => {
          try {
            return await moveHomeOwner(this.env, attachment.home, data, await this.ctx.storage.get("alerts_admins"), this.ctx.storage);
          } catch (error) {
            log("owner_failed", { home: attachment.home, error: String(error?.message ?? error) });
            return { ok: false, code: "INTERNAL" };
          }
        }, attachment.home);
        this.reply(ws, { type: "owner_result", id: data.id, ...(result ?? { ok: false, code: "INTERNAL" }) });
        return;
      }
      case "owner_cancel":
        // The controller did not follow that "owner" request, or heard no answer in time: the move
        // it made is undone (homes.js), in order after it. Nothing to answer.
        await this.queueKeyWork(async () => {
          try {
            await cancelOwnerMove(this.env, attachment.home, data, this.ctx.storage);
          } catch (error) {
            log("owner_cancel_failed", { home: attachment.home, error: String(error?.message ?? error) });
          }
        }, attachment.home);
        return;
      case "invitation_cancel":
        // It gave up waiting for invitation_result: nothing to answer.
        try {
          await cancelHomeInvitation(this.env, attachment.home, data);
        } catch (error) {
          log("invitation_cancel_failed", { home: attachment.home, error: String(error?.message ?? error) });
        }
        return;
      case "alert":
        // A schedule failed at home (drivers before 1.7.0): the admins are alerted, without names (alerts.js).
        await this.alerts.fromHome(data, attachment.home);
        return;
      case "notify":
        // An alert sealed to some of the home's keys (1.7.0, ADR-050): to their browsers (alerts.js).
        // One with an id (1.10.1, ADR-073) is answered `notify_result` on this socket, and pushed once
        // however often the driver sends it.
        await this.alerts.notify(data, attachment.home, (answer) => this.reply(ws, answer));
        return;
      case "https":
      case "https_certificate":
        // Direct HTTPS (1.12.0, ADR-082): the controller's address, its certificate (https.js).
        this.reply(ws, await this.https.handle(data, attachment.home));
        return;
      case "response":
      case "claim_result":
      case "link_result":
        if (typeof data.id !== "string" || !this.settle(data.id, { message: data })) {
          log("response_ignored", { home: attachment.home, type, id: data.id ?? null, why: "no request is waiting for this id" });
        }
        return;
      default:
        log("message_ignored", {
          home: attachment.home,
          type: type ?? null,
          message: typeof message === "string" ? message.slice(0, 100) : `${message.byteLength} binary bytes`,
        });
    }
  }

  // Tells a driver whose hello lists `users` (1.9.0, ADR-061) which of its keys share an account:
  // { "type": "accounts", "id", "keys": { "<key id>": ["<tag>", …] } }, an opaque tag per account
  // and home (member-keys.js), never an account's id or email. Run as key work (in the order of the
  // driver's frames); `ws`: the socket, else the driver's live one. No answer is waited for.
  async sendAccounts(ws = null) {
    const socket = ws ?? this.heardDriverSocket();
    if (!socket || socket.readyState !== OPEN) return;
    const { home, features } = socket.deserializeAttachment() ?? {};
    if (!home || !Array.isArray(features) || !features.includes("users")) return;
    const keys = await keyAccounts(this.env, home);
    this.reply(socket, { type: "accounts", id: crypto.randomUUID(), keys });
    log("accounts_sent", { home, keys: Object.keys(keys).length });
  }

  reply(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The driver went away; it asks again.
    }
  }

  // The home's owner approved a new secret (homes.js replaceSecret): only it opens the home's
  // connection from now on. The driver is disconnected and connects again with the new one, which
  // it has been keeping for this (docs/RELAY.md).
  async replaceSecret(input, homeId) {
    const hash = typeof input?.secret_sha256 === "string" ? input.secret_sha256 : "";
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return problem(400, "INVALID_REQUEST", "secret_sha256 must be 64 hex characters");
    }
    await this.ctx.storage.put("secret_sha256", hash);
    for (const ws of this.ctx.getWebSockets(DRIVER)) {
      try {
        ws.close(4001, "secret replaced");
      } catch {
        // Already closing.
      }
    }
    log("home_secret_replaced", { home: homeId });
    return json({ ok: true });
  }

  async webSocketClose(ws, code, reason) {
    await this.disconnected(ws, `closed with ${code}${reason ? ` ${reason}` : ""}`);
    // Completes the closing handshake on runtimes that do not answer the close frame themselves.
    try {
      ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, "closed");
    } catch {
      // Already answered.
    }
  }

  async webSocketError(ws, error) {
    await this.disconnected(ws, `error: ${error?.message ?? error}`);
  }

  async disconnected(ws, why) {
    const attachment = ws.deserializeAttachment() ?? {};
    this.connectionLost(attachment, `The home disconnected before it answered (${why})`);
    if (this.driverSocket({ except: attachment.conn })) {
      log("driver_replaced", { home: attachment.home, why }); // a newer connection took over
      return;
    }
    const now = Date.now();
    this.disconnectedAt = now;
    await this.ctx.storage.put({ disconnected_at: iso(now), last_seen: iso(this.lastSeen(ws)) });
    await this.alerts.disconnected(now);
    // How long the connection was up, and how long before the end the driver last pinged and last
    // sent a message: pings answered until the end mean the connection itself was cut.
    const ping = autoResponseTime(this.ctx, ws);
    log("driver_disconnected", {
      home: attachment.home,
      why,
      up_s: seconds(now, attachment.connectedAt),
      ping_s: seconds(now, ping),
      message_s: seconds(now, attachment.lastSeen),
    });
  }

  // The connection whose socket attachment is `attachment` ended (closed, failed or replaced) with
  // requests sent over it still unanswered: each fails now with `why`, or (1.10.0, ADR-072) one the
  // driver may be sent again waits for its next hello, at most RECONNECT_WAIT_MS and only while it
  // may still go again (RESEND_WITHIN_MS after it reached the relay, MAX_RESENDS times), then fails
  // with `why`.
  connectionLost(attachment, why) {
    const { conn } = attachment;
    for (const [id, entry] of this.pending) {
      if (conn !== undefined && entry.conn === conn) {
        this.lost(id, entry, why, attachment);
      }
    }
  }

  // One request whose connection ended (connectionLost); `attachment`, that connection's socket
  // attachment now. Whether the driver there takes `resend` is decided now, from its hello: a request
  // sent in the moment between a new connection's upgrade and its hello goes again too.
  lost(id, entry, why, attachment = {}) {
    const again = entry.resend;
    if (again && !again.instance) {
      again.instance = takesResend(attachment);
    }
    const now = Date.now();
    const left = again?.instance ? Math.min(reconnectWaitMs(this.env), again.receivedAt + resendWithinMs(this.env) - now, entry.deadline - now) : 0;
    if (!again?.instance || again.sent >= MAX_RESENDS || left <= 0) {
      this.settle(id, { failed: why });
      return;
    }
    clearTimeout(entry.timer);
    entry.conn = null;
    again.lostAt = Date.now();
    again.why = why;
    entry.timer = setTimeout(() => this.settle(id, { failed: `${why}; it did not come back in time` }), left);
  }

  // The driver said hello on `ws` (its `attachment`): the requests whose connection ended go again
  // on it, the same frame with the same id and `resent` counting the sends again, when its hello
  // lists `resend` and comes from the instance they were sent to; otherwise they fail now (a driver
  // that restarted cannot tell whether it ran them). Logged once (`request_resent`): how many, and
  // how long after their connection was found gone. Never a body.
  resendLost(ws, attachment) {
    const takes = takesResend(attachment);
    const now = Date.now();
    let count = 0;
    let afterMs = 0;
    let most = 0;
    for (const [id, entry] of this.pending) {
      const again = entry.resend;
      if (!again || !again.lostAt) {
        continue;
      }
      if (!takes || again.instance !== attachment.instance) {
        this.settle(id, { failed: takes ? `${again.why}; DirectorLink restarted meanwhile` : again.why });
        continue;
      }
      clearTimeout(entry.timer);
      again.sent += 1;
      afterMs = Math.max(afterMs, now - again.lostAt);
      most = Math.max(most, again.sent);
      again.lostAt = null;
      entry.conn = attachment.conn;
      // Its own wait, and never past the request's budget (1.10.1).
      entry.timer = setTimeout(() => this.settle(id, { timeout: true }), Math.min(RESEND_TIMEOUT_MS, requestTimeoutMs(this.env), entry.deadline - now));
      count += 1;
      try {
        ws.send(JSON.stringify({ ...again.frame, resent: again.sent }));
      } catch (error) {
        this.lost(id, entry, `The home's connection could not be written (${error?.message ?? error})`, attachment);
      }
    }
    if (count) {
      log("request_resent", { home: attachment.home, count, after_ms: afterMs, resent: most });
    }
  }

  // Sends `frame` ({ type, id, … }) to the driver over `ws` and waits for the answer with its id:
  // { message }, { timeout: true } or { failed: why }. `record`: the account and key of an e2e
  // request (webSocketMessage). `resend` (1.10.0): the frame may go again on the driver's next
  // connection if this one ends before the answer, when this connection's hello lists `resend` (by
  // the time it ends: lost); `receivedAt`, when the request reached the relay (the resends stop
  // RESEND_WITHIN_MS after it, and every wait ends REQUEST_BUDGET_MS after it: 1.10.1).
  exchange(ws, frame, { record = null, resend = false, receivedAt = Date.now() } = {}) {
    const attachment = ws.deserializeAttachment() ?? {};
    const deadline = receivedAt + REQUEST_BUDGET_MS;
    if (Date.now() >= deadline) {
      return Promise.resolve({ timeout: true }); // nothing left of its budget: not sent at all
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(frame.id, { timeout: true }), Math.min(requestTimeoutMs(this.env), deadline - Date.now()));
      // `instance`: the driver start it went to, once its connection's hello said it takes `resend`.
      const again = resend ? { frame, instance: takesResend(attachment), receivedAt, sent: 0, lostAt: null, why: null } : null;
      const entry = { resolve, timer, conn: attachment.conn, record, resend: again, deadline };
      this.pending.set(frame.id, entry);
      try {
        ws.send(JSON.stringify(frame));
      } catch (error) {
        this.lost(frame.id, entry, `The home's connection could not be written (${error?.message ?? error})`, attachment);
      }
    });
  }

  // The driver's socket; if it has just disconnected or gone quiet (stale), the one it opens next,
  // once it says hello (or, after RECONNECT_WAIT_MS, whichever is connected and heard; null if
  // none). Null at once when the home has been away longer. Nothing is sent into a stale socket.
  // `deadline` (1.10.1): the wait ends then at the latest (the request's budget).
  async liveDriver(deadline = Infinity) {
    const ws = this.driverSocket();
    if (ws && !this.stale(ws)) {
      return ws;
    }
    const expected = ws ? this.staleExpected(ws) : await this.driverExpected();
    if (!expected) {
      return null;
    }
    const socket = await new Promise((resolve) => {
      const resume = (found) => {
        clearTimeout(timer);
        this.waiting.delete(resume);
        resolve(found);
      };
      // At the deadline, a socket that passed the secret check but whose hello is still on its
      // way is used all the same: the driver is back.
      const timer = setTimeout(() => resume(this.heardDriverSocket()), Math.max(0, Math.min(reconnectWaitMs(this.env), deadline - Date.now())));
      this.waiting.add(resume);
    });
    if (!socket && expected.restarted && !this.driverSocket()) {
      // It did not come back after the restart: offline since it was last heard from (the
      // status), and the next requests are answered at once.
      this.disconnectedAt = 0;
      await this.ctx.storage.put("disconnected_at", iso(expected.lastSeen));
    }
    return socket;
  }

  // Whether the driver should be back within seconds: it disconnected less than
  // RECONNECT_GRACE_MS ago, or this object restarted under its connection (a deploy restarts every
  // object and ends its sockets without webSocketClose, so no disconnect is recorded). Returns
  // { restarted, lastSeen } or null.
  async driverExpected() {
    if (this.disconnectedAt !== undefined) {
      return Date.now() - this.disconnectedAt <= RECONNECT_GRACE_MS ? { restarted: false } : null;
    }
    const stored = await this.ctx.storage.get(["connected_at", "disconnected_at", "last_seen"]);
    const connectedAt = Date.parse(stored.get("connected_at") ?? "");
    const disconnectedAt = Date.parse(stored.get("disconnected_at") ?? "");
    if (Number.isFinite(disconnectedAt) && !(connectedAt > disconnectedAt)) {
      return Date.now() - disconnectedAt <= RECONNECT_GRACE_MS ? { restarted: false } : null;
    }
    if (!Number.isFinite(connectedAt)) {
      return null; // never connected
    }
    return { restarted: true, lastSeen: Date.parse(stored.get("last_seen") ?? "") || connectedAt };
  }

  // Whether the driver should be back within seconds from a stale socket: its silence rule drops
  // the connection three pings after it last heard the relay (2.5 intervals is just before that)
  // and connects again a second later. Waited for as after a disconnect, up to RECONNECT_GRACE_MS
  // after the socket went stale; { restarted: false } or null.
  staleExpected(ws) {
    const quietMs = Date.now() - this.lastSeen(ws) - staleAfterMs(ws);
    return quietMs <= RECONNECT_GRACE_MS ? { restarted: false } : null;
  }

  // Whether the driver has gone quiet on this socket: nothing heard (no ping answered, no message)
  // for STALE_PINGS of its ping intervals, so the connection died without the relay seeing a
  // close. Logged once per socket (driver_stale); the mark is kept in its attachment, which
  // outlives an eviction.
  stale(ws) {
    const now = Date.now();
    if (now - this.lastSeen(ws) <= staleAfterMs(ws)) {
      return false;
    }
    const attachment = ws.deserializeAttachment() ?? {};
    if (!attachment.stale) {
      attachment.stale = now;
      ws.serializeAttachment(attachment);
      log("driver_stale", {
        home: attachment.home,
        interval_s: attachment.pingS ?? null,
        up_s: seconds(now, attachment.connectedAt),
        ping_s: seconds(now, autoResponseTime(this.ctx, ws)),
        message_s: seconds(now, attachment.lastSeen),
      });
    }
    return true;
  }

  // The driver's socket while the driver is heard on it, else null.
  heardDriverSocket() {
    const ws = this.driverSocket();
    return ws && !this.stale(ws) ? ws : null;
  }

  // The driver's socket while it is heard and its hello lists `feature` (1.7.0), else null.
  driverTakes(feature) {
    const ws = this.heardDriverSocket();
    const { features } = ws?.deserializeAttachment() ?? {};
    return Array.isArray(features) && features.includes(feature) ? ws : null;
  }

  // Tells the driver `message` ({ type, ... }, with an id of its own) when it takes `feature`; it
  // answers nothing. Whether it went (alerts.js: "alerts_gone", 1.9.0).
  tellDriver({ type, ...fields }, feature) {
    const ws = this.driverTakes(feature);
    if (!ws) {
      return false;
    }
    try {
      ws.send(JSON.stringify({ type, id: crypto.randomUUID(), ...fields }));
      return true;
    } catch {
      return false; // the driver went away; it hears it at its next connection
    }
  }

  // The live driver socket (the newest, while a replaced one is still closing), or null.
  driverSocket({ except } = {}) {
    let newest = null;
    let newestAt = -Infinity;
    for (const ws of this.ctx.getWebSockets(DRIVER)) {
      if (ws.readyState !== OPEN) {
        continue;
      }
      const { conn, connectedAt = 0 } = ws.deserializeAttachment() ?? {};
      if (except !== undefined && conn === except) {
        continue;
      }
      if (connectedAt >= newestAt) {
        newest = ws;
        newestAt = connectedAt;
      }
    }
    return newest;
  }

  // The last time the driver was heard from: its last message, or the last auto-answered ping
  // (those never reach webSocketMessage).
  lastSeen(ws) {
    const { lastSeen = 0 } = ws.deserializeAttachment() ?? {};
    return Math.max(lastSeen, autoResponseTime(this.ctx, ws) ?? 0);
  }

  // The object's alarm (alarms.js): the alerts' (whether the home has been away long enough to
  // alert, alerts.js) and Direct HTTPS's order (https.js), whichever are due; then the next one.
  async alarm() {
    const due = await this.alarms.due(Date.now());
    if (due.includes("alerts")) {
      try {
        await this.alerts.alarm();
      } catch (error) {
        log("alert_alarm_failed", { error: String(error?.message ?? error) });
      }
    }
    if (due.includes("https")) {
      try {
        await this.https.alarm();
      } catch (error) {
        log("https_alarm_failed", { error: String(error?.stack ?? error) });
      }
    }
    await this.alarms.arm();
  }

  // --- Test endpoints ------------------------------------------------------------------------

  async status() {
    const ws = this.driverSocket();
    if (ws) {
      const { connectedAt, version } = ws.deserializeAttachment() ?? {};
      const lastSeen = iso(this.lastSeen(ws));
      // A stale socket: offline since the driver was last heard on it.
      return this.stale(ws)
        ? { connected: false, since: lastSeen, version: version ?? null, last_seen: lastSeen }
        : { connected: true, since: iso(connectedAt), version: version ?? null, last_seen: lastSeen };
    }
    const stored = await this.ctx.storage.get(["connected_at", "disconnected_at", "last_seen", "version"]);
    const connectedAt = stored.get("connected_at");
    const disconnectedAt = stored.get("disconnected_at");
    const lastSeen = stored.get("last_seen") ?? null;
    // Offline since the recorded disconnect; when none was recorded after the last connect (the
    // relay restarted under the connection), since the driver was last heard from.
    const since = disconnectedAt && (!connectedAt || disconnectedAt >= connectedAt) ? disconnectedAt : lastSeen;
    const status = { connected: false, since, version: stored.get("version") ?? null, last_seen: lastSeen };
    // Its driver is older than the relay takes now (ADR-059): it cannot come back until updated.
    const minimum = updateRequired(this.env, status.version);
    return minimum && status.version ? { ...status, update_required: true, minimum_version: minimum } : status;
  }

  // The answer to a request for a home whose driver is not connected: offline, or, when its last
  // driver is below the minimum version (ADR-059), that DirectorLink must be updated.
  async offline() {
    const version = (await this.ctx.storage.get("version")) ?? null;
    const minimum = version ? updateRequired(this.env, version) : null;
    if (minimum) {
      return problem(503, "HOME_UPDATE_REQUIRED", `The home runs DirectorLink ${version}, which can no longer connect to remote access: update DirectorLink in Composer to ${minimum} or later`);
    }
    return problem(503, "HOME_OFFLINE", "The home is not connected to the relay");
  }

  async forward(path, homeId) {
    const receivedAt = Date.now();
    const ws = await this.liveDriver(receivedAt + REQUEST_BUDGET_MS);
    if (!ws) {
      return this.offline();
    }
    const id = crypto.randomUUID();
    const started = Date.now();
    // Version 0's test requests are never sent again: the driver refuses them anyway.
    const outcome = await this.exchange(ws, { type: "request", id, method: "GET", path, body: null }, { receivedAt });
    const ms = Date.now() - started;
    if (outcome.timeout) {
      log("request_timeout", { home: homeId, id, path, ms });
      return homeTimeout(receivedAt);
    }
    if (outcome.failed) {
      log("request_failed", { home: homeId, id, path, ms, why: outcome.failed });
      return problem(502, "HOME_DISCONNECTED", outcome.failed);
    }
    const response = relayedResponse(outcome.message);
    log("request_relayed", { home: homeId, id, path, status: response.status, ms });
    return response;
  }

  // Sends one account message (e2e, join or claim) and waits for the driver's reply with the same
  // id. The reply goes back as it came: sealed contents stay sealed.
  // `userId`: the account the Worker checked, for an e2e message (its key is recorded when the home
  // accepts the request); it never goes to the driver.
  async message(message, homeId, userId) {
    if (!message || !["e2e", "join", "claim"].includes(message.type)) {
      return problem(400, "INVALID_MESSAGE", "Only e2e, join and claim messages are relayed");
    }
    const receivedAt = Date.now();
    const ws = await this.liveDriver(receivedAt + REQUEST_BUDGET_MS);
    if (!ws) {
      return this.offline();
    }
    const id = crypto.randomUUID();
    const started = Date.now();
    const record = message.type === "e2e" && typeof userId === "string" && userId ? { user: userId, key: message.envelope?.key } : null;
    // Sent again if the connection ends first (1.10.0): the driver runs each id once.
    const outcome = await this.exchange(ws, { ...message, id }, { record, resend: true, receivedAt });
    const ms = Date.now() - started;
    if (outcome.timeout) {
      log("message_timeout", { home: homeId, type: message.type, ms, total_ms: Date.now() - receivedAt });
      return homeTimeout(receivedAt);
    }
    if (outcome.failed) {
      log("message_failed", { home: homeId, type: message.type, ms, why: outcome.failed });
      return problem(502, "HOME_DISCONNECTED", outcome.failed);
    }
    const { id: _id, ...reply } = outcome.message;
    const ok = reply.ok ?? Boolean(reply.envelope);
    if (!ok || ms >= SLOW_MESSAGE_MS) {
      log("message_relayed", { home: homeId, type: message.type, ok, code: reply.code ?? null, ms });
    }
    return json(reply);
  }

  // A scene link's run (ADR-051, scene-links.js): `input` { link, secret }, already checked for
  // shape by the Worker; `address` the phone's (CF-Connecting-IP). Only a driver whose hello lists
  // scene_links gets it (an older one would ignore it, and the phone would wait 15 s): otherwise, as
  // for any unknown link, 404.
  async link(input, homeId, address) {
    const linkId = typeof input?.link === "string" ? input.link : "";
    const secret = typeof input?.secret === "string" ? input.secret : "";
    if (!LINK_ID.test(linkId) || !LINK_SECRET.test(secret)) {
      return linkNotFound();
    }
    const started = Date.now();
    const client = linkClient(address);
    // Never the secret nor the address: the home, the link's id, the answer and why.
    const done = (status, fields = {}) => {
      if (status === 404) this.linkMissed(client, Date.now());
      log("link_run", { home: homeId, link: linkId, status, ms: Date.now() - started, ...fields });
    };
    const guessing = this.linkMissWait(client, started);
    if (guessing) {
      log("link_run", { home: homeId, link: linkId, status: 429, ms: 0, why: "client limit" });
      return problem(429, "TOO_MANY_RUNS", "Too many runs of links that do not work from here; try again later", { "Retry-After": String(guessing) });
    }
    const wait = this.linkRunWait(started);
    if (wait) {
      done(429, { why: "home limit" });
      return problem(429, "TOO_MANY_RUNS", "Too many runs for this home; try again in a minute", { "Retry-After": String(wait) });
    }
    const ws = await this.liveDriver(started + REQUEST_BUDGET_MS);
    if (!ws) {
      done(503);
      return problem(503, "HOME_OFFLINE", "The home is not connected to the relay");
    }
    const { features } = ws.deserializeAttachment() ?? {};
    if (!Array.isArray(features) || !features.includes("scene_links")) {
      done(404, { why: "driver without links" });
      return linkNotFound();
    }
    const id = crypto.randomUUID();
    // Sent again if the connection ends first (1.10.0): the driver runs each id once.
    const outcome = await this.exchange(ws, { type: "link", id, link: linkId, secret }, { resend: true, receivedAt: started });
    if (outcome.timeout) {
      done(504);
      return homeTimeout(started);
    }
    if (outcome.failed) {
      done(502, { why: outcome.failed });
      return problem(502, "HOME_DISCONNECTED", outcome.failed);
    }
    const reply = outcome.message ?? {};
    if (reply.ok === true && Object.hasOwn(RESULT_MESSAGES, reply.result)) {
      done(200, { result: reply.result });
      return json({ result: reply.result, message: RESULT_MESSAGES[reply.result] });
    }
    if (reply.code === "RATE_LIMITED") {
      // The real wait: a minute at most for runs in a row (any link), up to an hour for an ask
      // link that asked (or said why nobody was asked) 10 times in the last hour (ADR-058).
      const retry = Math.min(3600, Math.max(1, Math.round(Number(reply.retry_s) || 60)));
      const minutes = Math.ceil(retry / 60);
      done(429, { why: retry > 60 ? "link hour limit" : "link limit" });
      const detail =
        retry > 60 ? `This link asked too often in the last hour; it can ask again in ${minutes} minutes` : "This link ran too often; try again in a minute";
      return problem(429, "TOO_MANY_RUNS", detail, { "Retry-After": String(retry) });
    }
    if (reply.code === "INTERNAL") {
      done(502, { why: "the home failed" });
      return problem(502, "HOME_FAILED", "The home could not run the scene");
    }
    done(404);
    return linkNotFound();
  }

  // Seconds until `client` may run a scene link again, after LINK_MISSES_PER_CLIENT refused as
  // unknown within LINK_MISS_WINDOW_MS; 0 when it may now.
  linkMissWait(client, now) {
    const misses = (this.linkMisses.get(client) ?? []).filter((at) => now - at < LINK_MISS_WINDOW_MS && at <= now);
    if (!misses.length) {
      this.linkMisses.delete(client);
      return 0;
    }
    this.linkMisses.set(client, misses);
    return misses.length >= LINK_MISSES_PER_CLIENT ? Math.max(1, Math.ceil((LINK_MISS_WINDOW_MS - (now - misses[0])) / 1000)) : 0;
  }

  // A run of `client` was refused as unknown (404). The client goes to the end of the Map's order,
  // and the one seen longest ago goes when there are too many.
  linkMissed(client, now) {
    const misses = this.linkMisses.get(client) ?? [];
    this.linkMisses.delete(client);
    misses.push(now);
    this.linkMisses.set(client, misses.slice(-LINK_MISSES_PER_CLIENT));
    while (this.linkMisses.size > LINK_CLIENTS) {
      this.linkMisses.delete(this.linkMisses.keys().next().value);
    }
  }

  // Seconds until another scene link run may go to the home, or 0 when it may now (and it counts).
  linkRunWait(now) {
    this.linkRuns = this.linkRuns.filter((at) => now - at < 60000 && at <= now);
    if (this.linkRuns.length >= LINK_RUNS_PER_MINUTE) {
      return Math.max(1, Math.ceil((60000 - (now - this.linkRuns[0])) / 1000));
    }
    this.linkRuns.push(now);
    return 0;
  }

  settle(id, outcome) {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    return true;
  }
}

// The driver's `response` message as the HTTP answer: its status, content type and body, byte
// for byte (`body_base64` for binary answers such as camera pictures).
function relayedResponse(message) {
  const { status } = message;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    return invalidResponse(`status must be a whole number from 200 to 599, not ${JSON.stringify(status)}`);
  }
  let body = null;
  if (message.body_base64 !== undefined && message.body_base64 !== null) {
    if (typeof message.body_base64 !== "string") {
      return invalidResponse("body_base64 must be a string");
    }
    try {
      body = decodeBase64(message.body_base64);
    } catch {
      return invalidResponse("body_base64 is not valid base64");
    }
  } else if (typeof message.body === "string") {
    body = message.body;
  } else if (message.body !== undefined && message.body !== null) {
    return invalidResponse("body must be a string or null");
  }
  const headers = { "cache-control": "no-store" };
  if (typeof message.content_type === "string" && message.content_type !== "") {
    headers["content-type"] = message.content_type;
  }
  try {
    return new Response(NULL_BODY_STATUS.has(status) ? null : body, { status, headers });
  } catch (error) {
    return invalidResponse(error?.message ?? String(error));
  }
}

function invalidResponse(detail) {
  return problem(502, "INVALID_RESPONSE", `The home sent an invalid response: ${detail}`);
}

function decodeBase64(text) {
  // Encoders that wrap lines (MIME, OpenSSL) are fine: whitespace is not part of the data.
  const binary = atob(text.replace(/[\t\n\f\r ]+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function requestTimeoutMs(env) {
  const value = Number(env.REQUEST_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

// 504 for a request that reached the relay at `receivedAt` and was not answered in time: within
// REQUEST_TIMEOUT_MS of being sent, or within its budget (1.10.1), whichever ended first.
function homeTimeout(receivedAt) {
  return problem(504, "HOME_TIMEOUT", `The home did not answer within ${Math.round((Date.now() - receivedAt) / 1000)} s`);
}

// The interval the driver's hello announced (ping_s, seconds; 1.6.0), or null: none, or not a
// number from 1 to 300.
function pingSeconds(value) {
  return typeof value === "number" && value >= 1 && value <= 300 ? value : null;
}

// How long the driver may go unheard on `ws` before it is stale (milliseconds).
function staleAfterMs(ws) {
  const { pingS } = ws.deserializeAttachment() ?? {};
  return STALE_PINGS * (pingS ?? DEFAULT_PING_S) * 1000;
}

// The driver start (`instance`) on a socket whose hello lists `resend` (1.10.0), else null.
function takesResend({ features, instance } = {}) {
  return Array.isArray(features) && features.includes(RESEND_FEATURE) && typeof instance === "string" && instance ? instance : null;
}

function reconnectWaitMs(env) {
  const value = Number(env.RECONNECT_WAIT_MS);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_RECONNECT_WAIT_MS;
}

// RESEND_WITHIN_MS (.dev.vars, for the tests only): with the production 10 s a request is sent again
// within 10 s and then waits at most 8 s, so the 18 s budget never ends either wait first;
// budget.test.mjs sets it longer than the budget to see that the budget does.
function resendWithinMs(env) {
  const value = Number(env.RESEND_WITHIN_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RESEND_WITHIN_MS;
}

// When the runtime last answered this socket's "ping" (milliseconds), or null.
function autoResponseTime(ctx, ws) {
  try {
    return ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
  } catch {
    return null;
  }
}

// Whole seconds from `since` (milliseconds) to `now`, or null.
function seconds(now, since) {
  return Number.isFinite(since) && since > 0 ? Math.round((now - since) / 1000) : null;
}

function cleanVersion(value) {
  if (typeof value !== "string") {
    return null;
  }
  const version = value.trim();
  return /^[\x21-\x7e]{1,64}$/.test(version) ? version : null;
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}
