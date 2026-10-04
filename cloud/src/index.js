// DirectorLink relay on https://api.directorlink.io (docs/RELAY.md, version 0).
//
// The driver keeps one outgoing WebSocket here, and requests for its home travel over it. Every
// home is one Durable Object (HomeRelay, home-relay.js, named by home_id); this Worker checks each
// request and hands it to that object.
//
//   GET /health                        {"status":"ok"}
//   GET /relay/connect                 the driver's WebSocket
//                                      (X-DirectorLink-Home, Authorization: Bearer <home_secret>)
//   GET /test/homes/{home_id}/status   the home's connection     } Authorization: Bearer <TEST_TOKEN>
//   GET /test/homes/{home_id}/v1/...   relayed to the driver     } (version 0 only)
//   /auth/google/start, /auth/google/callback, /auth/logout, /v1/me   accounts (accounts.js)
//   POST /auth/apple/notifications     Apple's notifications about its accounts (apple-notifications.js)
//   /v1/homes/..., /v1/join            homes, members, invitations, sealed requests (homes.js)
//   /v1/homes/{home_id}/backups        the home's automatic backups, sealed (backups.js)
//   GET /v1/stats                      DirectorLink in numbers: totals only, public (stats.js)
//   /v1/homes/{home_id}/device-requests  a new device joins by approval (device-requests.js)
//   GET, POST /run/{home_id}.{link_id} a scene's link, from a phone's automation (scene-links.js)
//
// Errors are Problem Details (application/problem+json) with a stable `code`.

import { handleAccounts, purgeAccountsWithoutSignIn } from "./accounts.js";
import { handleAppleNotification } from "./apple-notifications.js";
import { purgeBackupUploads } from "./backups.js";
import { purgeDeviceRequests } from "./device-requests.js";
import { handleHomes } from "./homes.js";
import { handleSceneLink } from "./scene-links.js";
import { HomeRelay } from "./home-relay.js";
import { purgeInvitations } from "./invitations.js";
import { STATS_CRON, countStats, handleStats } from "./stats.js";
import { bearerToken, json, methodNotAllowed, problem, sameSecret } from "./http.js";

export { HomeRelay };

const HOME_ID = /^[0-9a-f]{32}$/;
const HOME_SECRET = /^[0-9a-f]{64}$/i;
const TEST_ROUTE = /^\/test\/homes\/([^/]*)(\/status|\/v1(?:\/.*)?)$/;

export default {
  // Daily housekeeping, and hourly DirectorLink in numbers (wrangler.jsonc → triggers).
  async scheduled(event, env, ctx) {
    if (event.cron === STATS_CRON) {
      ctx.waitUntil(countStats(env));
      return;
    }
    ctx.waitUntil(purgeInvitations(env));
    ctx.waitUntil(purgeSessions(env));
    ctx.waitUntil(purgeAccountsWithoutSignIn(env));
    ctx.waitUntil(purgeBackupUploads(env));
    ctx.waitUntil(purgeDeviceRequests(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        return request.method === "GET" ? json({ status: "ok" }) : methodNotAllowed();
      }
      if (url.pathname === "/v1/stats") {
        return await handleStats(request, env);
      }
      if (url.pathname === "/relay/connect") {
        return await connect(request, env);
      }
      const test = TEST_ROUTE.exec(url.pathname);
      if (test) {
        return await testEndpoint(request, env, test[1], test[2], url.search);
      }
      if (url.pathname === "/auth/apple/notifications") {
        return await handleAppleNotification(request, env);
      }
      const link = await handleSceneLink(request, env);
      if (link) {
        return link;
      }
      const account = await handleAccounts(request, env);
      if (account) {
        return account;
      }
      const home = await handleHomes(request, env);
      if (home) {
        return home;
      }
      return problem(404, "NOT_FOUND", `${url.pathname} is not a DirectorLink relay endpoint`);
    } catch (error) {
      console.error(JSON.stringify({ event: "worker_error", path: url.pathname, error: String(error?.stack ?? error) }));
      return problem(500, "INTERNAL_ERROR", "The relay failed; try again");
    }
  },
};

function homeRelay(env, homeId) {
  return env.HOME_RELAY.get(env.HOME_RELAY.idFromName(homeId));
}

// The driver's WebSocket. The home's Durable Object checks the secret (trust on first use) and
// accepts the socket.
async function connect(request, env) {
  if (request.method !== "GET") {
    return methodNotAllowed();
  }
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return problem(400, "WEBSOCKET_REQUIRED", "Connect with a WebSocket upgrade (Upgrade: websocket)");
  }
  const homeId = request.headers.get("X-DirectorLink-Home") ?? "";
  if (!HOME_ID.test(homeId)) {
    return problem(400, "INVALID_HOME_ID", "X-DirectorLink-Home must be the home_id: 32 lowercase hex characters");
  }
  const secret = bearerToken(request);
  if (!secret || !HOME_SECRET.test(secret)) {
    return problem(400, "INVALID_HOME_SECRET", "Authorization must be Bearer <home_secret>: 64 hex characters");
  }
  return homeRelay(env, homeId).fetch(request);
}

// Version 0 test endpoints: one shared token (the TEST_TOKEN secret) until accounts exist.
async function testEndpoint(request, env, homeId, rest, search) {
  if (!env.TEST_TOKEN) {
    return problem(503, "TEST_TOKEN_NOT_SET", "The test endpoints are off: the TEST_TOKEN secret is not set");
  }
  const token = bearerToken(request);
  if (!token || !(await sameSecret(token, env.TEST_TOKEN))) {
    return problem(401, "UNAUTHORIZED", "Send Authorization: Bearer <TEST_TOKEN>", {
      "WWW-Authenticate": 'Bearer realm="DirectorLink relay"',
    });
  }
  if (request.method !== "GET") {
    return methodNotAllowed();
  }
  if (!HOME_ID.test(homeId)) {
    return problem(400, "INVALID_HOME_ID", "home_id must be 32 lowercase hex characters");
  }
  const relay = homeRelay(env, homeId);
  if (rest === "/status") {
    return relay.fetch("https://home-relay/status", { headers: { "X-DirectorLink-Home": homeId } });
  }
  // The driver gets the API path with its query string, exactly as it arrived here.
  return relay.fetch("https://home-relay/forward", {
    headers: { "X-DirectorLink-Home": homeId, "X-DirectorLink-Path": rest + search },
  });
}

// Daily: sessions and sign-ins that have expired (otherwise only removed when that account signs
// in again).
async function purgeSessions(env) {
  const now = new Date().toISOString();
  const [sessions, signIns] = await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sign_ins WHERE expires_at < ?").bind(now),
  ]);
  console.log(JSON.stringify({ event: "sessions_purged", sessions: sessions.meta?.changes ?? 0, sign_ins: signIns.meta?.changes ?? 0 }));
}
