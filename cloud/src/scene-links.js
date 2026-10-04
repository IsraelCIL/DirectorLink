// Scene links (ADR-051, docs/SCENES.md): a private link per scene that a phone's own automations
// call (iPhone Shortcuts, Android automation apps, an NFC tag opened in a browser). The address
// names the home and the link; the secret travels in the body of a POST, never in the address, so
// it stays out of the request URLs Workers Logs record. A browser gets it after "#", which it never
// sends: the page's script reads it and posts it.
//
//   GET  /run/{home_id}.{link_id}    a small page with one Run button; it runs nothing (link
//                                    previews in Messages, WhatsApp or Slack fetch links) and says
//                                    nothing about the home or the scene
//   POST /run/{home_id}.{link_id}    the secret in the body: {"secret": "…"} (JSON), secret=… (a
//                                    form), or the secret alone (text). 200 {"result", "message"}:
//                                    ran, partly, failed or nothing. 404 for an unknown home, link
//                                    or secret alike; 429 too many runs; 503 the home is offline.
//
// The home's Durable Object passes the link and its secret to the controller (`link`,
// docs/RELAY.md), which checks the secret against the hash it keeps and runs the scene. The secret
// is never logged here; each run is (the home, the link's id, the answer, how long it took), and
// the request's address goes to the home's object for its limit on wrong guesses, in memory only.

import { json, problem, readText } from "./http.js";

const RUN_PATH = /^\/run\/([0-9a-f]{32})\.([0-9a-f]{8})\/?$/;
export const LINK_ID = /^[0-9a-f]{8}$/;
export const LINK_SECRET = /^[0-9a-f]{40}$/;
// A body is a secret and a little JSON or form around it.
const MAX_BODY_BYTES = 1024;

// What the phone is told, besides the result word (the controller's link_result).
export const RESULT_MESSAGES = {
  ran: "The scene ran.",
  partly: "The scene ran, but some devices were skipped or did not respond.",
  failed: "Nothing ran: the scene's devices were skipped or did not respond.",
  nothing: "Nothing ran: the scene has no devices left to switch.",
};

export function linkNotFound() {
  return problem(404, "NOT_FOUND", "This link does not work: it was removed or replaced, or it is not complete");
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

// The secret in the request's body, or null when there is none. Whatever form an automation app
// sends it in: JSON ({"secret": "…"} or a JSON string), a form field `secret` (url-encoded or
// multipart), or the bare secret as text. The whole link pasted in place of the secret works too
// (what follows "#").
export async function secretOf(request) {
  const text = await readText(request, MAX_BODY_BYTES);
  if (text === null) {
    return null;
  }
  // A multipart boundary is case-sensitive (RFC 2046): the form is read with the header as it came.
  const rawType = request.headers.get("content-type") ?? "";
  const type = rawType.toLowerCase();
  const trimmed = text.trim();
  let value = null;
  if (type.includes("multipart/form-data")) {
    try {
      const form = await new Request("https://link.invalid/", { method: "POST", headers: { "content-type": rawType }, body: text }).formData();
      value = form.get("secret");
    } catch {
      value = null;
    }
  } else if (type.includes("json") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      value = typeof parsed === "string" ? parsed : parsed && typeof parsed === "object" ? parsed.secret : null;
    } catch {
      value = null;
    }
  } else if (type.includes("x-www-form-urlencoded") || /^secret=/.test(trimmed)) {
    value = new URLSearchParams(trimmed).get("secret");
  } else {
    value = trimmed;
  }
  // The secret alone, whatever the app said it sends (Shortcuts set to JSON with a bare secret).
  if (typeof value !== "string" && /^[0-9a-f]{40}$/i.test(trimmed)) {
    value = trimmed;
  }
  if (typeof value !== "string") {
    return null;
  }
  const secret = value.includes("#") ? value.slice(value.lastIndexOf("#") + 1) : value;
  return secret.trim().toLowerCase() || null;
}

// Answers /run/…; null for any other path.
export async function handleSceneLink(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/run/")) {
    return null;
  }
  const match = RUN_PATH.exec(path);
  if (request.method === "GET" || request.method === "HEAD") {
    // The same page for every address, a link that never existed too: it tells nothing.
    return match ? runPage(request.method === "HEAD") : problem(404, "NOT_FOUND", "This is not a DirectorLink link");
  }
  if (request.method !== "POST") {
    return problem(405, "METHOD_NOT_ALLOWED", "A link runs its scene with POST; GET shows a page with a Run button", { Allow: "GET, POST" });
  }
  if (!match) {
    return linkNotFound();
  }
  const [, homeId, linkId] = match;
  const secret = await secretOf(request);
  if (secret === null) {
    return problem(400, "SECRET_REQUIRED", 'Send the link\'s secret in the body: {"secret": "…"}, or secret=… as a form');
  }
  if (!LINK_SECRET.test(secret)) {
    log("link_run", { home: homeId, link: linkId, status: 404, why: "not a secret" });
    return linkNotFound();
  }
  // Only a home linked to an account (its owner claimed it) takes links.
  const home = await env.DB.prepare("SELECT 1 AS found FROM homes WHERE id = ?").bind(homeId).first();
  if (!home) {
    log("link_run", { home: homeId, link: linkId, status: 404, why: "home not claimed" });
    return linkNotFound();
  }
  const stub = env.HOME_RELAY.get(env.HOME_RELAY.idFromName(homeId));
  return stub.fetch("https://home-relay/link", {
    method: "POST",
    // The phone's address, for the limit on wrong guesses from one place (HomeRelay.link).
    headers: { "X-DirectorLink-Home": homeId, "X-DirectorLink-Client": request.headers.get("cf-connecting-ip") ?? "", "content-type": "application/json" },
    body: JSON.stringify({ link: linkId, secret }),
  });
}

// The page a browser gets: a Run button that posts the secret after "#". English or Hebrew, as the
// browser prefers; light or dark, as the device is.
function runPage(headOnly) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
  return new Response(headOnly ? null : PAGE.replaceAll("{{nonce}}", nonce), { status: 200, headers });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>DirectorLink</title>
<style nonce="{{nonce}}">
:root { color-scheme: light dark; --bg: #f5f5f4; --card: #ffffff; --ink: #18181b; --muted: #52525b; --line: #e4e4e7; --primary: #2563eb; --primaryText: #ffffff; --ok: #166534; --err: #991b1b; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1012; --card: #1b1d21; --ink: #f4f4f5; --muted: #a1a1aa; --line: #2a2d33; --primary: #60a5fa; --primaryText: #0b1220; --ok: #86efac; --err: #fca5a5; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 28px 24px; text-align: center; }
.brand { margin: 0 0 16px; font-size: 0.875rem; font-weight: 600; letter-spacing: 0.02em; color: var(--muted); }
h1 { margin: 0 0 8px; font-size: 1.375rem; }
p { margin: 0 0 24px; color: var(--muted); }
button { width: 100%; min-height: 56px; border: 0; border-radius: 12px; background: var(--primary); color: var(--primaryText); font: inherit; font-size: 1.125rem; font-weight: 600; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
button:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
#status { min-height: 1.5em; margin: 16px 0 0; color: var(--ink); }
#status.ok { color: var(--ok); }
#status.err { color: var(--err); }
</style>
</head>
<body>
<main>
<p class="brand">DirectorLink</p>
<h1 id="title">Run a scene</h1>
<p id="help">This private link runs one scene of a home with DirectorLink.</p>
<button id="run" type="button">Run</button>
<p id="status" role="status" aria-live="polite"></p>
</main>
<script nonce="{{nonce}}">
(() => {
  const WORDS = {
    en: {
      title: "Run a scene", help: "This private link runs one scene of a home with DirectorLink.", run: "Run", running: "Running…", again: "Run again",
      ran: "Done: the scene ran.", partly: "The scene ran, but some devices were skipped or did not respond.", failed: "Nothing ran: the scene's devices were skipped or did not respond.",
      nothing: "Nothing ran: the scene has no devices left to switch.",
      notFound: "This link does not work: it was removed or replaced, or it was copied wrong.", tooMany: "Too many runs. Try again later.",
      offline: "The home is not connected right now. Try again later.", noAnswer: "The home did not answer. Try again.", error: "Something went wrong. Try again.",
      incomplete: "This link is not complete: the part after # is missing.",
    },
    he: {
      title: "הפעלת סצנה", help: "הקישור הפרטי הזה מפעיל סצנה אחת בבית עם DirectorLink.", run: "הפעלה", running: "מפעילים…", again: "הפעלה נוספת",
      ran: "בוצע: הסצנה הופעלה.", partly: "הסצנה הופעלה, אבל חלק מהמכשירים דולגו או לא הגיבו.", failed: "שום דבר לא הופעל: המכשירים של הסצנה דולגו או לא הגיבו.",
      nothing: "שום דבר לא הופעל: לא נשארו בסצנה מכשירים להפעלה.",
      notFound: "הקישור הזה לא עובד: הוא הוסר או הוחלף, או שהועתק לא נכון.", tooMany: "יותר מדי הפעלות. נסו שוב מאוחר יותר.",
      offline: "הבית לא מחובר כרגע. נסו שוב מאוחר יותר.", noAnswer: "הבית לא ענה. נסו שוב.", error: "משהו השתבש. נסו שוב.",
      incomplete: "הקישור לא שלם: החלק שאחרי # חסר.",
    },
  };
  const first = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
  const lang = /^(he|iw)\\b/i.test(first) ? "he" : "en";
  const words = WORDS[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
  const $ = (id) => document.getElementById(id);
  $("title").textContent = words.title;
  $("help").textContent = words.help;
  const button = $("run");
  const status = $("status");
  button.textContent = words.run;
  let secret = "";
  try {
    secret = decodeURIComponent(window.location.hash.slice(1)).trim();
  } catch {
    secret = "";
  }
  const say = (text, tone) => {
    status.textContent = text;
    status.className = tone || "";
  };
  if (!/^[0-9a-fA-F]{40}$/.test(secret)) {
    button.disabled = true;
    say(words.incomplete, "err");
    return;
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = words.running;
    say("");
    let text = words.error;
    let tone = "err";
    try {
      const response = await fetch(window.location.pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && words[body.result]) {
        text = words[body.result];
        tone = body.result === "ran" ? "ok" : "";
      } else if (response.status === 404) {
        text = words.notFound;
      } else if (response.status === 429) {
        text = words.tooMany;
      } else if (response.status === 503) {
        text = words.offline;
      } else if (response.status === 502 || response.status === 504) {
        text = words.noAnswer;
      }
    } catch {
      text = words.error;
    }
    say(text, tone);
    button.disabled = false;
    button.textContent = words.again;
  });
})();
</script>
</body>
</html>
`;
