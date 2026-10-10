// A minimal ACME client (RFC 8555) for Direct HTTPS (1.12.0, ADR-082), in plain JavaScript with
// WebCrypto, without dependencies: ES256 JWS (RFC 7515) with the account's P-256 key, its JWK
// thumbprint (RFC 7638) for the dns-01 challenge, nonces, the account, an order, its authorization
// and challenge, the finalize with the controller's CSR, and the certificate's download. The home's
// Durable Object drives it one step at a time from its alarm (https.js); nothing here waits.
//
// Settings: ACME_ACCOUNT_KEY (a secret: the account's private key, PKCS #8 PEM, P-256; registered at
// the first use, terms of service agreed) and ACME_DIRECTORY (a var: Let's Encrypt's production
// directory by default; its staging one, or the tests' fake, otherwise).

import { base64url } from "./http.js";

export const DEFAULT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
const USER_AGENT = "DirectorLink-Worker (https://github.directorlink.io)";
// Answers larger than this are not read (a certificate chain is a few KB).
const MAX_ANSWER_BYTES = 64 * 1024;

const encoder = new TextEncoder();

// An ACME server's problem (RFC 7807 with an urn:ietf:params:acme:error: type), or a failure to
// reach it (`type` "network"). `retryAfter`: seconds, from Retry-After, when it said.
export class AcmeError extends Error {
  constructor(type, detail, status = null, retryAfter = null) {
    super(`${type}: ${detail}`);
    this.type = type;
    this.detail = detail;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  // The short name of the error (badNonce, rateLimited, …), or the type as it came.
  get kind() {
    return this.type.replace(/^urn:ietf:params:acme:error:/, "");
  }

  // Worth trying again the same step a little later.
  get transient() {
    return this.type === "network" || ["badNonce", "serverInternal"].includes(this.kind) || (this.status !== null && this.status >= 500);
  }
}

// The account key, from its PKCS #8 PEM (a .dev.vars line may have "\n" instead of line breaks).
async function importAccountKey(pemText) {
  const body = String(pemText ?? "")
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const { crv, kty, x, y } = await crypto.subtle.exportKey("jwk", privateKey);
  return { privateKey, jwk: { crv, kty, x, y } };
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof bytes === "string" ? encoder.encode(bytes) : bytes));
}

function retryAfter(response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null;
}

async function readText(response) {
  const text = await response.text();
  return text.length > MAX_ANSWER_BYTES ? text.slice(0, MAX_ANSWER_BYTES) : text;
}

export class AcmeClient {
  // `kid`: the account's URL when it is known already (the home's object keeps it).
  constructor({ directoryUrl = DEFAULT_DIRECTORY, accountKey, kid = null, fetcher = (...args) => fetch(...args) }) {
    this.directoryUrl = directoryUrl;
    this.accountKeyPem = accountKey;
    this.kid = kid;
    this.fetcher = fetcher;
    this.nonces = [];
    this.key = null;
    this.urls = null;
  }

  async request(url, init = {}) {
    let response;
    try {
      response = await this.fetcher(url, { ...init, redirect: "manual", headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) } });
    } catch (error) {
      throw new AcmeError("network", String(error?.message ?? error));
    }
    const nonce = response.headers.get("replay-nonce");
    if (nonce) this.nonces.push(nonce);
    return response;
  }

  async directory() {
    if (!this.urls) {
      const response = await this.request(this.directoryUrl);
      if (!response.ok) throw new AcmeError("network", `the directory answered ${response.status}`, response.status);
      this.urls = JSON.parse(await readText(response));
    }
    return this.urls;
  }

  async accountKey() {
    if (!this.key) {
      try {
        this.key = await importAccountKey(this.accountKeyPem);
      } catch (error) {
        throw new AcmeError("accountKey", `ACME_ACCOUNT_KEY is not a P-256 PKCS #8 key: ${error?.message ?? error}`);
      }
    }
    return this.key;
  }

  // The JWK thumbprint (RFC 7638): its members in lexicographic order, without spaces.
  async thumbprint() {
    const { jwk } = await this.accountKey();
    return base64url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
  }

  // The TXT record's value for a dns-01 challenge's token (RFC 8555, 8.4).
  async dnsValue(token) {
    return base64url(await sha256(`${token}.${await this.thumbprint()}`));
  }

  async nonce() {
    if (this.nonces.length) return this.nonces.pop();
    const { newNonce } = await this.directory();
    const response = await this.request(newNonce, { method: "HEAD" });
    const nonce = response.headers.get("replay-nonce");
    if (!nonce) throw new AcmeError("network", `newNonce answered ${response.status} without a nonce`, response.status);
    this.nonces = this.nonces.filter((item) => item !== nonce);
    return nonce;
  }

  // A JWS-signed POST (flattened JSON serialization); `payload` null for POST-as-GET. With the
  // account's JWK before it has a URL (newAccount), with its `kid` after. A badNonce is tried again
  // once with the nonce it came with. Returns the response.
  async post(url, payload, { jwk = false, accept = null } = {}) {
    const { privateKey, jwk: publicJwk } = await this.accountKey();
    for (let attempt = 0; ; attempt += 1) {
      const header = { alg: "ES256", nonce: await this.nonce(), url };
      if (jwk) header.jwk = publicJwk;
      else header.kid = this.kid;
      const protectedPart = base64url(encoder.encode(JSON.stringify(header)));
      const payloadPart = payload === null ? "" : base64url(encoder.encode(JSON.stringify(payload)));
      // WebCrypto signs ECDSA as r ‖ s, which is what JWS (ES256) wants.
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(`${protectedPart}.${payloadPart}`)));
      const response = await this.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/jose+json", ...(accept ? { Accept: accept } : {}) },
        body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature: base64url(signature) }),
      });
      if (response.ok) return response;
      const text = await readText(response);
      let problem = null;
      try {
        problem = JSON.parse(text);
      } catch {
        // Not a problem document.
      }
      const error = new AcmeError(problem?.type ?? "network", problem?.detail ?? `${response.status}`, response.status, retryAfter(response));
      error.subproblems = Array.isArray(problem?.subproblems) ? problem.subproblems : undefined;
      if (error.kind === "badNonce" && attempt === 0) continue;
      throw error;
    }
  }

  async json(url, payload, options) {
    const response = await this.post(url, payload, options);
    return { body: JSON.parse(await readText(response)), location: response.headers.get("location"), retryAfter: retryAfter(response) };
  }

  // The account's URL: registered (or found: newAccount answers an existing key with its URL) at the
  // first use, the terms of service agreed.
  async account() {
    if (!this.kid) {
      const { newAccount } = await this.directory();
      const { location } = await this.json(newAccount, { termsOfServiceAgreed: true }, { jwk: true });
      if (!location) throw new AcmeError("network", "newAccount gave no account URL");
      this.kid = location;
    }
    return this.kid;
  }

  // A new order for one DNS name: { url, order }.
  async newOrder(name) {
    await this.account();
    const { newOrder } = await this.directory();
    const { body, location } = await this.json(newOrder, { identifiers: [{ type: "dns", value: name }] });
    if (!location) throw new AcmeError("network", "newOrder gave no order URL");
    return { url: location, order: body };
  }

  // POST-as-GET of an order, authorization or challenge: its JSON, and Retry-After (seconds).
  async get(url) {
    await this.account();
    const { body, retryAfter: wait } = await this.json(url, null);
    return { ...body, retryAfter: wait };
  }

  // The client is ready for the challenge to be checked (RFC 8555, 7.5.1).
  async respond(challengeUrl) {
    await this.account();
    return (await this.json(challengeUrl, {})).body;
  }

  // The order's finalize, with the CSR (DER as base64url).
  async finalize(finalizeUrl, csr) {
    await this.account();
    return (await this.json(finalizeUrl, { csr })).body;
  }

  // The certificate and its chain (PEM).
  async download(certificateUrl) {
    await this.account();
    const response = await this.post(certificateUrl, null, { accept: "application/pem-certificate-chain" });
    return readText(response);
  }
}
