// Responses and secret checks shared by the Worker (index.js) and the Durable Object
// (home-relay.js).

const TITLES = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// RFC 9457 Problem Details with a stable machine-readable `code`, like the driver's own API
// (driver/src/api/problem.lua).
export function problem(status, code, detail, headers = {}) {
  const body = { type: "about:blank", title: TITLES[status] ?? "Error", status, detail, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json", "cache-control": "no-store", ...headers },
  });
}

export function methodNotAllowed(allow = "GET") {
  return problem(405, "METHOD_NOT_ALLOWED", `Only ${allow} is allowed here`, { Allow: allow });
}

export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// `bytes` random bytes as base64url (cookies, OAuth state and nonce) or as hex (ids).
export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomHex(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

// A `__Host-` cookie: HTTPS only, this host only, invisible to scripts. Max-Age 0 removes it.
export function setCookie(name, value, { maxAge, sameSite = "Strict" }) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

// The token of `Authorization: Bearer <token>`, or null.
export function bearerToken(request) {
  const match = /^Bearer +(\S+)$/i.exec((request.headers.get("Authorization") ?? "").trim());
  return match ? match[1] : null;
}

// The request's body as text, or null when it is larger than `maxBytes`. It stops reading at the
// limit, so a body without Content-Length (chunked, HTTP/2) cannot fill the Worker's memory.
export async function readText(request, maxBytes) {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    return null;
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const encoder = new TextEncoder();

function sha256(text) {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

export async function sha256Hex(text) {
  const bytes = new Uint8Array(await sha256(text));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Compares two secrets in constant time. Both are hashed first, so the comparison always covers
// 32 bytes and reveals neither the content nor the length of either.
export async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}
