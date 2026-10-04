// Accounts (docs/ACCOUNTS.md): sign in with Google or Apple, the session, and deleting the account.
//
//   GET    /auth/providers                                   the sign-ins set up on this server
//   GET    /auth/{google|apple}/start?return_to=<app URL>[&link=1]   → the provider, then back
//   GET    /auth/google/callback                             (Google redirects here)
//   POST   /auth/apple/callback                              (Apple posts its form here)
//   POST   /auth/logout                                      ends this session
//   POST   /auth/logout?everywhere=1                         ends every session of this account
//   GET    /v1/me                                            the signed-in account, or 401
//   DELETE /v1/me                                            deletes the account and all its sessions
//   DELETE /v1/me/identities/{google|apple}                  it no longer signs in with that provider
//
// An account is found by the provider's own id for the person (identities), never by email: an
// address can pass to someone else. A signed-in account may add the other provider (`link=1`, from
// the app's Settings); both then sign in to it.
//
// The session is a random token in the `__Host-dl_session` cookie of api.directorlink.io; D1 keeps
// only its SHA-256. The app calls /v1/me and /auth/logout with `credentials: "include"`; only the
// app's own origins (APP_ORIGINS) get CORS answers, and changes are refused from any other origin.

import { homesChanged } from "./alerts.js";
import { apple } from "./apple.js";
import { google } from "./google.js";
import { json, methodNotAllowed, problem, randomHex, randomToken, readCookie, readText, setCookie, sha256Hex } from "./http.js";
import { forgetInvitations } from "./invitations.js";
import { SignInError } from "./jwt.js";

const PROVIDERS = { google, apple };
const SESSION_COOKIE = "__Host-dl_session";
const SESSION_SECONDS = 30 * 24 * 3600;
const SIGN_IN_SECONDS = 10 * 60;
// The browser keeps the sign-in's state in a cookie until the provider sends it back. Google comes
// back with a redirect (a navigation: Lax is enough); Apple posts a form from its own site, which
// only a SameSite=None cookie survives.
const SIGN_IN_COOKIES = {
  google: { name: "__Host-dl_signin", sameSite: "Lax" },
  apple: { name: "__Host-dl_signin_apple", sameSite: "None" },
};
const MAX_FORM_BYTES = 16 * 1024;

// The provider sends the browser back to exactly the address registered for the client, so it is
// configured rather than taken from the request.
function callbackUrl(env, provider) {
  return new URL(`/auth/${provider}/callback`, env.PUBLIC_URL || "https://api.directorlink.io").toString();
}

export function appOrigins(env) {
  return (env.APP_ORIGINS || "https://app.directorlink.io")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Where to go back to: an address of the app itself, never anywhere else.
function safeReturn(env, value) {
  const origins = appOrigins(env);
  try {
    const url = new URL(value);
    if (origins.includes(url.origin)) {
      return url.toString();
    }
  } catch {
    // Not a URL.
  }
  return `${origins[0]}/#/settings`;
}

// The app learns the outcome from ?signin=… (it removes it from the address bar). After Apple's
// form (a POST), 303 makes the browser load the app with GET.
function backToApp(returnTo, outcome, headers = [], status = 302) {
  const url = new URL(returnTo);
  url.searchParams.set("signin", outcome);
  const response = new Response(null, { status, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
  for (const [name, value] of headers) {
    response.headers.append(name, value);
  }
  return response;
}

function cors(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !appOrigins(env).includes(origin)) {
    return null;
  }
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
}

// The providers set up here (their settings and secrets exist): the app shows only their buttons.
export function configuredProviders(env) {
  return Object.values(PROVIDERS)
    .filter((provider) => provider.configured(env))
    .map((provider) => provider.name);
}

function withHeaders(response, headers) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    response.headers.set(name, value);
  }
  return response;
}

async function startSignIn(request, env, provider) {
  if (!provider.configured(env)) {
    return problem(503, "SIGN_IN_NOT_CONFIGURED", `${provider.label} sign-in is not set up on this server yet`);
  }
  const url = new URL(request.url);
  const returnTo = safeReturn(env, url.searchParams.get("return_to"));
  // Adding this provider to the signed-in account: the app's own page navigates here (same site,
  // so the session cookie comes along); from another site it does not, and nothing is linked.
  let linkTo = null;
  if (url.searchParams.get("link") === "1") {
    linkTo = await currentUser(request, env);
    if (!linkTo) {
      return backToApp(returnTo, "expired");
    }
  }
  const state = randomToken();
  const nonce = randomToken();
  const verifier = provider.usesVerifier ? randomToken(48) : "";
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sign_ins WHERE expires_at < ?").bind(iso(now)),
    env.DB.prepare(
      "INSERT INTO sign_ins (state_sha256, nonce, verifier, return_to, expires_at, provider, link_user_id, link_session_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(await sha256Hex(state), nonce, verifier, returnTo, iso(now + SIGN_IN_SECONDS * 1000), provider.name, linkTo?.id ?? null, linkTo ? await sha256Hex(linkTo.token) : null),
  ]);
  const location = await provider.authorizationUrl(env, { redirectUri: callbackUrl(env, provider.name), state, nonce, verifier });
  const cookie = SIGN_IN_COOKIES[provider.name];
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Set-Cookie": setCookie(cookie.name, state, { maxAge: SIGN_IN_SECONDS, sameSite: cookie.sameSite }),
    },
  });
}

// The callback's parameters: Google's in the query, Apple's in a posted form.
async function callbackParams(request) {
  if (request.method !== "POST") {
    return new URL(request.url).searchParams;
  }
  return new URLSearchParams((await readText(request, MAX_FORM_BYTES)) ?? "");
}

// The account of a person the provider vouched for: the one this identity belongs to, else a new
// one. Never an account found by email: Google, for one, vouches for an address only when the
// account was made, and addresses get reused.
async function accountFor(env, provider, person) {
  const now = iso(Date.now());
  const find = () => env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").bind(provider, person.subject).first();
  let identity = await find();
  if (!identity) {
    // An account made before identities existed (by the previous Worker while an update rolled
    // out) gets its identity now; so does one whose only sign-in, the Apple ID it began with, Apple
    // said was no longer used for DirectorLink (apple-notifications.js): the same Apple ID gets it
    // back.
    const legacy = await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND subject = ?").bind(provider, person.subject).first();
    if (legacy) {
      await env.DB.prepare("INSERT OR IGNORE INTO identities (provider, subject, user_id, email, created_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(provider, person.subject, legacy.id, person.email ?? "", now, now)
        .run();
      identity = { user_id: legacy.id };
    }
  }
  if (identity) {
    // The account's email follows the identity it was created with; a linked provider's does not.
    await env.DB.batch([
      env.DB.prepare("UPDATE identities SET email = COALESCE(?, email), last_sign_in_at = ? WHERE provider = ? AND subject = ?").bind(person.email, now, provider, person.subject),
      env.DB.prepare(
        "UPDATE users SET email = CASE WHEN provider = ? AND subject = ? THEN COALESCE(?, email) ELSE email END, name = COALESCE(?, name), last_sign_in_at = ? WHERE id = ?"
      ).bind(provider, person.subject, person.email, person.name, now, identity.user_id),
    ]);
    return { userId: identity.user_id, created: false };
  }
  if (!person.email) {
    throw new SignInError("EMAIL_NOT_VERIFIED", "A new account needs a verified email address");
  }
  const userId = randomHex(16);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, provider, subject, email, name, created_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(userId, provider, person.subject, person.email, person.name, now, now),
      env.DB.prepare("INSERT INTO identities (provider, subject, user_id, email, created_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(provider, person.subject, userId, person.email, now, now),
    ]);
  } catch (error) {
    // The same person signing in twice at once: the other request made the account.
    const made = await find();
    if (made) {
      return { userId: made.user_id, created: false };
    }
    throw error;
  }
  return { userId, created: true };
}

// Another account that began with this sign-in, which it no longer has (Apple said the person
// stopped using it for DirectorLink, apple-notifications.js): signing in with it gets that account
// back (accountFor), so it is not free to add to another.
function heldElsewhere(env, provider, person, userId) {
  return env.DB.prepare("SELECT id FROM users WHERE provider = ? AND subject = ? AND id <> ?").bind(provider, person.subject, userId).first();
}

// Adds an identity to the signed-in account that asked for it (link=1). Returns the outcome for
// the app: linked, taken (another account signs in with it, or began with it) or duplicate (this
// account already has one from this provider).
async function linkIdentity(env, provider, person, userId) {
  const now = iso(Date.now());
  const owner = await env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").bind(provider, person.subject).first();
  if (owner) {
    return owner.user_id === userId ? "linked" : "taken";
  }
  if (await heldElsewhere(env, provider, person, userId)) {
    return "taken";
  }
  const account = await env.DB.prepare(
    "SELECT users.id AS id, (SELECT COUNT(*) FROM identities WHERE user_id = users.id AND provider = ?) AS same FROM users WHERE users.id = ?"
  )
    .bind(provider, userId)
    .first();
  if (!account) {
    return "expired";
  }
  if (account.same > 0) {
    return "duplicate";
  }
  try {
    await env.DB.prepare("INSERT INTO identities (provider, subject, user_id, email, created_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(provider, person.subject, userId, person.email ?? "", now, now)
      .run();
  } catch {
    // Something changed meanwhile: say what.
    const now_owner = await env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").bind(provider, person.subject).first();
    if (now_owner) {
      return now_owner.user_id === userId ? "linked" : "taken";
    }
    if (await heldElsewhere(env, provider, person, userId)) {
      return "taken";
    }
    if (await env.DB.prepare("SELECT 1 AS found FROM identities WHERE user_id = ? AND provider = ?").bind(userId, provider).first()) {
      return "duplicate";
    }
    return (await env.DB.prepare("SELECT 1 AS found FROM users WHERE id = ?").bind(userId).first()) ? "failed" : "expired";
  }
  return "linked";
}

async function finishSignIn(request, env, provider) {
  const params = await callbackParams(request);
  const state = params.get("state") ?? "";
  const cookie = SIGN_IN_COOKIES[provider.name];
  const clearSignIn = ["Set-Cookie", setCookie(cookie.name, "", { maxAge: 0, sameSite: cookie.sameSite })];
  const status = request.method === "POST" ? 303 : 302;

  // The state must be the one this browser started, with this provider, and each works once.
  const cookieState = readCookie(request, cookie.name);
  const row = state
    ? await env.DB.prepare("DELETE FROM sign_ins WHERE state_sha256 = ? RETURNING nonce, verifier, return_to, expires_at, provider, link_user_id, link_session_sha256")
        .bind(await sha256Hex(state))
        .first()
    : null;
  const returnTo = safeReturn(env, row?.return_to);
  if (!row || row.provider !== provider.name || !cookieState || cookieState !== state || row.expires_at < iso(Date.now())) {
    return backToApp(returnTo, "expired", [clearSignIn], status);
  }
  const error = params.get("error");
  if (error) {
    const cancelled = error === "access_denied" || error === "user_cancelled_authorize";
    return backToApp(returnTo, cancelled ? "cancelled" : "failed", [clearSignIn], status);
  }
  const code = params.get("code");
  if (!code) {
    return backToApp(returnTo, "failed", [clearSignIn], status);
  }
  // Adding a provider needs the session it was asked from, still signed in (the callback itself
  // comes from the provider's site, without the session cookie).
  if (row.link_user_id) {
    const session = row.link_session_sha256
      ? await env.DB.prepare("SELECT user_id FROM sessions WHERE token_sha256 = ? AND expires_at > ?").bind(row.link_session_sha256, iso(Date.now())).first()
      : null;
    if (!session || session.user_id !== row.link_user_id) {
      return backToApp(returnTo, "expired", [clearSignIn], status);
    }
  }

  let userId;
  let created;
  try {
    const person = await provider.finish(env, {
      code,
      redirectUri: callbackUrl(env, provider.name),
      verifier: row.verifier,
      nonce: row.nonce,
      user: params.get("user"),
    });
    if (row.link_user_id) {
      // Adding this provider to the account that asked; its session stays as it is.
      const outcome = await linkIdentity(env, provider.name, person, row.link_user_id);
      console.log(JSON.stringify({ event: "identity_linked", provider: provider.name, user: row.link_user_id, outcome }));
      return backToApp(returnTo, outcome, [clearSignIn], status);
    }
    ({ userId, created } = await accountFor(env, provider.name, person));
  } catch (failure) {
    if (failure instanceof SignInError) {
      console.log(JSON.stringify({ event: "sign_in_refused", provider: provider.name, code: failure.code, detail: failure.message }));
      return backToApp(returnTo, failure.code === "EMAIL_NOT_VERIFIED" ? "unverified" : "failed", [clearSignIn], status);
    }
    console.log(JSON.stringify({ event: "sign_in_failed", provider: provider.name, error: String(failure?.message ?? failure) }));
    return backToApp(returnTo, "failed", [clearSignIn], status);
  }

  const now = Date.now();
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(userId, iso(now)),
    env.DB.prepare("INSERT INTO sessions (token_sha256, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), userId, iso(now), iso(now + SESSION_SECONDS * 1000)),
  ]);
  console.log(JSON.stringify({ event: "signed_in", provider: provider.name, user: userId, new_account: created }));
  return backToApp(returnTo, "ok", [clearSignIn, ["Set-Cookie", setCookie(SESSION_COOKIE, token, { maxAge: SESSION_SECONDS })]], status);
}

// The account of this request's session, or null.
export async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const row = await env.DB.prepare(
    "SELECT users.id, users.email, users.name, users.created_at, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_sha256 = ?"
  )
    .bind(await sha256Hex(token))
    .first();
  if (!row || row.expires_at < iso(Date.now())) {
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, created_at: row.created_at, token };
}

// Invitations for this account's email that no other account can accept (they stay while one can).
function forgetInvitationsFor(env, user, where, ...values) {
  if (!user.email) {
    return forgetInvitations(env, where, ...values);
  }
  return forgetInvitations(
    env,
    `${where} OR (email = ? AND NOT EXISTS (SELECT 1 FROM users WHERE email = ? AND id <> ?) AND NOT EXISTS (SELECT 1 FROM identities WHERE email = ? AND user_id <> ?))`,
    ...values,
    user.email,
    user.email,
    user.id,
    user.email,
    user.id
  );
}

// Everything an account is (Delete account, and an account nobody can sign in to any more). The
// first statement gives the homes whose alerts it changes (its browsers' subscriptions, and all of
// those of the homes it owns, which go with it).
function accountDeletion(env, user) {
  return [
    env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 OR home_id IN (SELECT id FROM homes WHERE owner_id = ?1) RETURNING home_id").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    // Its requests to join homes, and those waiting for it to decide (ADR-041).
    env.DB.prepare("DELETE FROM join_requests WHERE user_id = ? OR home_id IN (SELECT id FROM homes WHERE owner_id = ?)").bind(user.id, user.id),
    env.DB.prepare("DELETE FROM invitations WHERE home_id IN (SELECT id FROM homes WHERE owner_id = ?)").bind(user.id),
    env.DB.prepare("DELETE FROM member_keys WHERE user_id = ? OR home_id IN (SELECT id FROM homes WHERE owner_id = ?)").bind(user.id, user.id),
    env.DB.prepare("DELETE FROM members WHERE home_id IN (SELECT id FROM homes WHERE owner_id = ?)").bind(user.id),
    env.DB.prepare("DELETE FROM homes WHERE owner_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM members WHERE user_id = ?").bind(user.id),
    ...forgetInvitationsFor(env, user, "accepted_by = ? OR created_by = ?", user.id, user.id),
    env.DB.prepare("DELETE FROM identities WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ];
}

// Deletes the account, then tells the homes whose alerts that changed (alerts.js).
async function deleteAccount(env, user) {
  const [{ results }] = await env.DB.batch(accountDeletion(env, user));
  await homesChanged(env, results.map((row) => row.home_id));
}

// An account left without any way to sign in (ADR-041: Apple's account-deleted, or no sign-in for
// UNUSED_DAYS after Apple's consent-revoked) keeps nothing of the person. Without a home it is
// deleted, as Delete account does. One that owns a home stays, so the home and its family keep
// working (it can be claimed again at home, ADR-027), but without the person's name and email, and
// outside the homes of others. Returns what was done, for the log; "kept" if it signs in again.
export async function forgetAccountWithoutSignIn(env, userId) {
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ? AND NOT EXISTS (SELECT 1 FROM identities WHERE user_id = users.id)").bind(userId).first();
  if (!user) {
    return "kept";
  }
  if (!(await env.DB.prepare("SELECT 1 AS found FROM homes WHERE owner_id = ?").bind(userId).first())) {
    await deleteAccount(env, user);
    return "account_deleted";
  }
  const others = "home_id NOT IN (SELECT id FROM homes WHERE owner_id = ?)";
  // Its browsers get no more alerts, at its own homes either: a push address is the person's.
  const [{ results: alerts }] = await env.DB.batch([
    env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? RETURNING home_id").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM join_requests WHERE user_id = ?").bind(userId),
    env.DB.prepare(`DELETE FROM member_keys WHERE user_id = ? AND ${others}`).bind(userId, userId),
    env.DB.prepare(`DELETE FROM members WHERE user_id = ? AND ${others}`).bind(userId, userId),
    ...forgetInvitationsFor(env, user, "accepted_by = ?", userId),
    env.DB.prepare("UPDATE users SET email = '', name = NULL WHERE id = ?").bind(userId),
  ]);
  await homesChanged(env, alerts.map((row) => row.home_id));
  return "account_emptied";
}

// Daily (cron): accounts nobody can sign in to (Apple's consent-revoked took their only sign-in)
// and nobody signed in to for UNUSED_DAYS: until then the same Apple ID gets its account back.
const UNUSED_DAYS = 90;

export async function purgeAccountsWithoutSignIn(env) {
  const days = Number(env.UNUSED_ACCOUNT_DAYS ?? UNUSED_DAYS);
  const before = iso(Date.now() - (Number.isFinite(days) && days >= 0 ? days : UNUSED_DAYS) * 24 * 3600 * 1000);
  const { results } = await env.DB.prepare(
    "SELECT id FROM users WHERE last_sign_in_at < ? AND NOT EXISTS (SELECT 1 FROM identities WHERE user_id = users.id) " +
      "AND (email <> '' OR name IS NOT NULL OR NOT EXISTS (SELECT 1 FROM homes WHERE owner_id = users.id)) LIMIT 100"
  )
    .bind(before)
    .all();
  const done = { account_deleted: 0, account_emptied: 0 };
  for (const row of results) {
    const outcome = await forgetAccountWithoutSignIn(env, row.id);
    if (outcome in done) done[outcome] += 1;
  }
  log("accounts_without_sign_in_purged", { deleted: done.account_deleted, emptied: done.account_emptied });
}

function notSignedIn() {
  return problem(401, "NOT_SIGNED_IN", "Sign in first", { "WWW-Authenticate": 'Cookie realm="DirectorLink"' });
}

const clearSession = () => setCookie(SESSION_COOKIE, "", { maxAge: 0 });

async function me(request, env, headers) {
  if (request.method === "GET") {
    const user = await currentUser(request, env);
    if (!user) {
      return withHeaders(notSignedIn(), headers);
    }
    const { results } = await env.DB.prepare("SELECT provider FROM identities WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
    return json(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at,
        providers: results.map((row) => row.provider),
        sign_in_providers: configuredProviders(env),
        // 1.7.0: a new device can join by approval (ADR-053); the app hides it from older servers.
        device_requests: true,
      },
      200,
      headers
    );
  }
  if (request.method === "DELETE") {
    const user = await currentUser(request, env);
    if (!user) {
      return withHeaders(notSignedIn(), headers);
    }
    await deleteAccount(env, user);
    console.log(JSON.stringify({ event: "account_deleted", user: user.id }));
    return new Response(null, { status: 204, headers: { ...headers, "Set-Cookie": clearSession(), "Cache-Control": "no-store" } });
  }
  return withHeaders(methodNotAllowed("GET, DELETE"), headers);
}

// Stops signing in with a provider; the last one stays (deleting the account is the way out).
async function removeIdentity(request, env, headers, provider) {
  if (request.method !== "DELETE") {
    return withHeaders(methodNotAllowed("DELETE"), headers);
  }
  const user = await currentUser(request, env);
  if (!user) {
    return withHeaders(notSignedIn(), headers);
  }
  const { results } = await env.DB.prepare("SELECT provider, subject FROM identities WHERE user_id = ? ORDER BY created_at").bind(user.id).all();
  const removed = results.find((row) => row.provider === provider);
  if (!removed) {
    return withHeaders(problem(404, "NOT_FOUND", `This account does not sign in with ${provider}`), headers);
  }
  const kept = results.find((row) => row.provider !== provider);
  if (!kept) {
    return withHeaders(problem(409, "LAST_SIGN_IN", "An account keeps at least one way to sign in; delete the account instead"), headers);
  }
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM identities WHERE user_id = ? AND provider = ?").bind(user.id, provider),
      // The account's email then follows the provider it keeps.
      env.DB.prepare("UPDATE users SET provider = ?, subject = ? WHERE id = ? AND provider = ? AND subject = ?").bind(kept.provider, kept.subject, user.id, removed.provider, removed.subject),
    ]);
  } catch (error) {
    // Another account still records the sign-in this one keeps as the one it began with (linked
    // before linkIdentity checked for that). The batch changed nothing.
    log("identity_not_removed", { provider, user: user.id, error: String(error?.message ?? error) });
    return withHeaders(problem(409, "SIGN_IN_HELD_ELSEWHERE", "Another DirectorLink account began with the sign-in this one would keep; nothing was changed"), headers);
  }
  console.log(JSON.stringify({ event: "identity_removed", provider, user: user.id }));
  return new Response(null, { status: 204, headers: { ...headers, "Cache-Control": "no-store" } });
}

async function logout(request, env, headers) {
  if (request.method !== "POST") {
    return withHeaders(methodNotAllowed("POST"), headers);
  }
  const token = readCookie(request, SESSION_COOKIE);
  const hash = token ? await sha256Hex(token) : null;
  if (new URL(request.url).searchParams.get("everywhere") === "1") {
    // Every device signed in to this account: a lost phone, a shared computer. Only a live session
    // says whose account that is; without one nothing was ended, and the app must say so.
    const session = hash
      ? await env.DB.prepare("SELECT user_id FROM sessions WHERE token_sha256 = ? AND expires_at > ?").bind(hash, iso(Date.now())).first()
      : null;
    if (!session) {
      if (hash) await env.DB.prepare("DELETE FROM sessions WHERE token_sha256 = ?").bind(hash).run();
      const refused = withHeaders(problem(401, "NOT_SIGNED_IN", "This session has ended: sign in again, then sign out everywhere"), headers);
      refused.headers.set("Set-Cookie", clearSession());
      return refused;
    }
    // The account's devices stop getting its homes' alerts too (ADR-047): one may be lost.
    const [, { results: alerts }] = await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(session.user_id),
      env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? RETURNING home_id").bind(session.user_id),
      // And its new devices' requests to join (ADR-053): one may come from the lost one.
      env.DB.prepare("DELETE FROM device_requests WHERE user_id = ?").bind(session.user_id),
    ]);
    await homesChanged(env, alerts.map((row) => row.home_id));
    log("signed_out_everywhere", { user: session.user_id });
  }
  if (hash) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_sha256 = ?").bind(hash).run();
  }
  return new Response(null, { status: 204, headers: { ...headers, "Set-Cookie": clearSession(), "Cache-Control": "no-store" } });
}

// Routes this module answers; null for any other path.
export async function handleAccounts(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/auth/providers") {
    // Asked by the app, without cookies, only when someone chooses to sign in (or is signed in).
    if (request.method !== "GET" && request.method !== "OPTIONS") {
      return methodNotAllowed();
    }
    const headers = cors(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...(headers ?? {}), "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "600" } });
    }
    return json({ providers: configuredProviders(env) }, 200, headers ? { "Access-Control-Allow-Origin": headers["Access-Control-Allow-Origin"], Vary: "Origin" } : {});
  }
  const auth = /^\/auth\/(google|apple)\/(start|callback)$/.exec(path);
  if (auth) {
    const provider = PROVIDERS[auth[1]];
    if (auth[2] === "start") {
      return request.method === "GET" ? startSignIn(request, env, provider) : methodNotAllowed();
    }
    // Google redirects (GET); Apple posts a form.
    const method = provider.name === "apple" ? "POST" : "GET";
    return request.method === method ? finishSignIn(request, env, provider) : methodNotAllowed(method);
  }
  const identity = /^\/v1\/me\/identities\/(google|apple)$/.exec(path);
  if (path !== "/v1/me" && path !== "/auth/logout" && !identity) {
    return null;
  }

  const headers = cors(request, env);
  if (request.method === "OPTIONS") {
    if (!headers) {
      return problem(403, "ORIGIN_NOT_ALLOWED", "Only the DirectorLink app may call this");
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": path === "/v1/me" ? "GET, DELETE" : identity ? "DELETE" : "POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  // Changes only from the app's own pages: a form or script on another site cannot sign
  // someone out or delete their account.
  if (request.method !== "GET" && !headers) {
    return problem(403, "ORIGIN_NOT_ALLOWED", "Only the DirectorLink app may call this");
  }
  if (identity) {
    return removeIdentity(request, env, headers, identity[1]);
  }
  return path === "/v1/me" ? me(request, env, headers) : logout(request, env, headers);
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}
