// DirectorLink in numbers (ADR-052): three totals for the website, counted once an hour.
//
//   GET /v1/stats   {"homes", "people", "downloads", "updated"}: no cookie, CORS for SITE_ORIGINS
//
// homes: homes linked to an account (claimed by an owner); people: accounts someone can sign in
// to; downloads: how often DirectorLink.c4z was downloaded from the project's GitHub releases, all
// releases together. The hourly cron (STATS_CRON, wrangler.jsonc → triggers) counts them into D1
// (`stats`, migrations/0010). A count that fails (D1, or GitHub unreachable, limited or answering
// something else) leaves that total as it was, with the time it was last counted. Totals only:
// nothing about any one home or account, and nothing new from the homes themselves.

import { json, methodNotAllowed, problem } from "./http.js";

// The hourly trigger: it must match wrangler.jsonc character for character (event.cron).
export const STATS_CRON = "47 * * * *";
export const PACKAGE_NAME = "DirectorLink.c4z";
export const REPOSITORY = "IsraelCIL/DirectorLink";
export const PER_PAGE = 100;
export const MAX_PAGES = 10;
const GITHUB_API = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 10_000;
const USER_AGENT = "DirectorLink-stats (+https://directorlink.io)";
// Browsers keep an answer for 5 minutes; the totals change once an hour.
const CACHE_SECONDS = 300;
const TOTALS = ["homes", "people", "downloads"];

const UPSERT = "INSERT INTO stats (name, value, updated_at) VALUES (?1, (%COUNT%), ?2) " +
  "ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at RETURNING value";
// A home counts while its owner's account exists (deleting an account deletes its homes).
const HOMES = "SELECT COUNT(*) FROM homes WHERE EXISTS (SELECT 1 FROM users WHERE users.id = homes.owner_id)";
// An account counts while someone can sign in to it: not one Apple's notices left without a
// sign-in (kept for its homes, or for 90 days for the same Apple ID to come back; ADR-041).
const PEOPLE = "SELECT COUNT(*) FROM users WHERE EXISTS (SELECT 1 FROM identities WHERE identities.user_id = users.id)";

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

export function siteOrigins(env) {
  return (env.SITE_ORIGINS || "https://directorlink.io,https://www.directorlink.io")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

class GitHubError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.fields = fields;
  }
}

// The downloads of DirectorLink.c4z over every release, from GitHub's public releases list, page
// by page. Throws when any page fails or is not what GitHub sends: a partial sum is never kept.
export async function countDownloads(env) {
  const base = (env.GITHUB_API_URL || GITHUB_API).replace(/\/+$/, "");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" };
  // Optional: GitHub limits requests without a token by address, and Workers share theirs.
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetch(`${base}/repos/${REPOSITORY}/releases?per_page=${PER_PAGE}&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubError(`GitHub answered ${response.status}`, {
        status: response.status,
        page,
        rate_limit_remaining: response.headers.get("x-ratelimit-remaining"),
      });
    }
    const releases = await response.json().catch(() => null);
    if (!Array.isArray(releases)) {
      throw new GitHubError("GitHub's answer is not a list of releases", { page });
    }
    for (const release of releases) {
      if (!release || typeof release !== "object" || !Array.isArray(release.assets)) {
        throw new GitHubError("a release without its assets", { page });
      }
      for (const asset of release.assets) {
        if (asset?.name !== PACKAGE_NAME) {
          continue;
        }
        if (!Number.isSafeInteger(asset.download_count) || asset.download_count < 0) {
          throw new GitHubError("a download count that is not a count", { page });
        }
        total += asset.download_count;
      }
    }
    if (releases.length < PER_PAGE) {
      return total;
    }
  }
  throw new GitHubError(`more than ${MAX_PAGES * PER_PAGE} releases`);
}

// Homes and people, counted and kept in one batch: both or neither.
async function countAccounts(env, now) {
  const [homes, people] = await env.DB.batch([
    env.DB.prepare(UPSERT.replace("%COUNT%", HOMES)).bind("homes", now),
    env.DB.prepare(UPSERT.replace("%COUNT%", PEOPLE)).bind("people", now),
  ]);
  return { homes: homes.results[0].value, people: people.results[0].value };
}

async function keepDownloads(env, downloads, now) {
  await env.DB.prepare(UPSERT.replace("%COUNT%", "?3")).bind("downloads", now, downloads).run();
  return downloads;
}

// The hourly count (index.js → scheduled). Each part keeps its total, or leaves it as it was.
export async function countStats(env) {
  const now = new Date().toISOString();
  const [accounts, downloads] = await Promise.allSettled([
    countAccounts(env, now),
    countDownloads(env).then((total) => keepDownloads(env, total, now)),
  ]);
  if (accounts.status === "rejected") {
    log("stats_not_counted", { totals: "homes, people", error: String(accounts.reason?.message ?? accounts.reason) });
  }
  if (downloads.status === "rejected") {
    log("stats_not_counted", { totals: "downloads", error: String(downloads.reason?.message ?? downloads.reason), ...downloads.reason?.fields });
  }
  log("stats_counted", {
    homes: accounts.value?.homes ?? null,
    people: accounts.value?.people ?? null,
    downloads: downloads.value ?? null,
  });
}

// GET /v1/stats: the totals as last counted. Public and read-only, without cookies; browsers on
// the website's origins may read it (CORS) and keep it for a few minutes.
export async function handleStats(request, env) {
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  if (origin && siteOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
  }
  if (request.method !== "GET") {
    return methodNotAllowed();
  }
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare("SELECT name, value, updated_at FROM stats").all());
  } catch (error) {
    log("stats_unavailable", { error: String(error?.message ?? error) });
    return problem(503, "STATS_UNAVAILABLE", "The totals cannot be read right now; try again later", headers);
  }
  const found = Object.fromEntries(rows.map((row) => [row.name, row]));
  if (!TOTALS.every((name) => found[name])) {
    return problem(503, "STATS_NOT_COUNTED", "The totals have not been counted yet; they are counted once an hour", headers);
  }
  return json(
    {
      homes: found.homes.value,
      people: found.people.value,
      downloads: found.downloads.value,
      // The oldest of the three: every total is at least this recent.
      updated: TOTALS.map((name) => found[name].updated_at).sort()[0],
    },
    200,
    { ...headers, "cache-control": `public, max-age=${CACHE_SECONDS}` }
  );
}
