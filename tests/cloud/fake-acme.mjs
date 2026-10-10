// A fake ACME server (RFC 8555) for the Direct HTTPS tests (ADR-082), shaped as Let's Encrypt: a
// directory, nonces it checks, accounts by JWK, orders for one DNS name, a dns-01 challenge it checks
// in the fake Cloudflare zone (fake-cloudflare.mjs), the finalize with a CSR, and a certificate chain
// (a leaf for the CSR's key, "YE1", issued by "Root YE"), with every JWS's ES256 signature checked.
// `faults` steer it: { badNonce, serverError, rateLimited, failChallenge, processing } (counts of the
// next requests to answer so, or flags).

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";

import { readRequest } from "../../cloud/src/x509.js";
import { freePort } from "./worker.mjs";
import { keyPair, makeCertificate, pem, spkiOf } from "./x509-build.mjs";

const PROBLEM = "urn:ietf:params:acme:error:";
const DAY = 24 * 3600 * 1000;

const b64u = (buffer) => Buffer.from(buffer).toString("base64url");
const fromB64u = (text) => Buffer.from(text, "base64url");

function thumbprint(jwk) {
  return b64u(createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

export async function startFakeAcme({ dns }) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const nonces = new Set();
  const accounts = new Map(); // kid -> jwk
  const orders = new Map(); // id -> order
  const faults = { badNonce: 0, serverError: 0, rateLimited: false, failChallenge: false, processing: 0 };
  const log = { orders: 0, accounts: 0, issued: [], requests: [] };

  const root = { name: "Root YE", ...keyPair() };
  const now = Date.now();
  const intermediateKeys = keyPair();
  const intermediate = {
    name: "YE1",
    privateKey: intermediateKeys.privateKey,
    der: makeCertificate({ spki: spkiOf(intermediateKeys.publicKey), subject: "YE1", issuer: root, notBefore: new Date(now - 30 * DAY), notAfter: new Date(now + 900 * DAY), ca: true }),
  };

  function newNonce() {
    const nonce = b64u(randomBytes(16));
    nonces.add(nonce);
    return nonce;
  }

  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const path = new URL(request.url, url).pathname;
    log.requests.push(`${request.method} ${path}`);
    const send = (status, body, headers = {}) => {
      const isText = typeof body === "string";
      response.writeHead(status, { "Replay-Nonce": newNonce(), "content-type": isText ? "application/pem-certificate-chain" : "application/json", ...headers });
      response.end(isText ? body : JSON.stringify(body));
    };
    const problem = (status, type, detail, headers = {}) => {
      response.writeHead(status, { "Replay-Nonce": newNonce(), "content-type": "application/problem+json", ...headers });
      response.end(JSON.stringify({ type: PROBLEM + type, detail, status }));
    };

    if (path === "/directory") {
      return send(200, { newNonce: `${url}/new-nonce`, newAccount: `${url}/new-account`, newOrder: `${url}/new-order`, revokeCert: `${url}/revoke`, keyChange: `${url}/key-change`, meta: { termsOfService: `${url}/terms` } });
    }
    if (path === "/new-nonce") {
      response.writeHead(request.method === "HEAD" ? 200 : 204, { "Replay-Nonce": newNonce(), "Cache-Control": "no-store" });
      return response.end();
    }
    if (request.method !== "POST") return problem(405, "malformed", "POST only");

    // The JWS: its nonce, URL and signature.
    let jws;
    let header;
    try {
      jws = JSON.parse(text);
      header = JSON.parse(fromB64u(jws.protected).toString("utf8"));
    } catch {
      return problem(400, "malformed", "not a JWS");
    }
    if (request.headers["content-type"] !== "application/jose+json") return problem(415, "malformed", "Content-Type must be application/jose+json");
    if (faults.badNonce > 0) {
      faults.badNonce -= 1;
      return problem(400, "badNonce", "a nonce the test refused");
    }
    if (!nonces.delete(header.nonce)) return problem(400, "badNonce", "unknown or used nonce");
    if (header.url !== `${url}${path}`) return problem(401, "unauthorized", `url ${header.url} is not ${url}${path}`);
    if (header.alg !== "ES256") return problem(400, "badSignatureAlgorithm", "ES256 only");
    let jwk;
    if (header.jwk) {
      if (path !== "/new-account") return problem(400, "malformed", "jwk only for newAccount");
      jwk = header.jwk;
    } else {
      jwk = accounts.get(header.kid);
      if (!jwk) return problem(400, "accountDoesNotExist", "no such account");
    }
    const signed = verify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, fromB64u(jws.signature));
    if (!signed) return problem(401, "unauthorized", "bad signature");
    const payload = jws.payload === "" ? null : JSON.parse(fromB64u(jws.payload).toString("utf8"));

    if (faults.serverError > 0) {
      faults.serverError -= 1;
      return problem(500, "serverInternal", "the test's 500");
    }

    if (path === "/new-account") {
      if (payload?.termsOfServiceAgreed !== true) return problem(400, "malformed", "agree to the terms");
      const existing = [...accounts.entries()].find(([, known]) => thumbprint(known) === thumbprint(jwk));
      if (existing) return send(200, { status: "valid" }, { Location: existing[0] });
      const kid = `${url}/acct/${accounts.size + 1}`;
      accounts.set(kid, jwk);
      log.accounts += 1;
      return send(201, { status: "valid" }, { Location: kid });
    }
    const account = header.kid;

    if (path === "/new-order") {
      if (faults.rateLimited) return problem(429, "rateLimited", "too many certificates already issued", { "Retry-After": "3600" });
      const identifiers = payload?.identifiers;
      if (!Array.isArray(identifiers) || identifiers.length !== 1 || identifiers[0].type !== "dns") return problem(400, "rejectedIdentifier", "one DNS name");
      const id = String(orders.size + 1);
      const order = {
        id,
        account,
        name: identifiers[0].value,
        status: "pending",
        token: b64u(randomBytes(24)),
        authzStatus: "pending",
        challengeError: null,
        processing: faults.processing,
        certificate: null,
      };
      orders.set(id, order);
      log.orders += 1;
      return send(201, orderBody(order), { Location: `${url}/order/${id}` });
    }
    const match = /^\/(order|authz|chall|finalize|cert)\/(\d+)$/.exec(path);
    const order = match ? orders.get(match[2]) : null;
    if (!order || order.account !== account) return problem(404, "malformed", "no such resource");
    const [, kind] = match;
    if (kind === "authz") return send(200, authzBody(order));
    if (kind === "order") {
      if (order.status === "processing" && order.processing-- <= 0) order.status = "valid";
      return send(200, orderBody(order), order.status === "processing" ? { "Retry-After": "0" } : {});
    }
    if (kind === "chall") {
      if (order.authzStatus === "pending") {
        const expected = b64u(createHash("sha256").update(`${order.token}.${thumbprint(jwk)}`).digest());
        const txt = dns.find(`_acme-challenge.${order.name}`, "TXT").map((record) => String(record.content).replace(/^"|"$/g, ""));
        if (!faults.failChallenge && txt.includes(expected)) {
          order.authzStatus = "valid";
          order.status = "ready";
        } else {
          order.authzStatus = "invalid";
          order.status = "invalid";
          order.challengeError = { type: `${PROBLEM}unauthorized`, detail: `Incorrect TXT record found at _acme-challenge.${order.name}` };
        }
      }
      return send(200, challengeBody(order));
    }
    if (kind === "finalize") {
      if (order.status !== "ready") return problem(403, "orderNotReady", `the order is ${order.status}`);
      let request;
      try {
        request = readRequest(fromB64u(payload.csr));
      } catch {
        request = null;
      }
      if (!request || request.names.length !== 1 || request.names[0] !== order.name) return problem(400, "badCSR", "the CSR does not name the order's identifier");
      const issuedAt = Date.now();
      const leaf = makeCertificate({ spki: request.key.spki, names: [order.name], subject: order.name, issuer: intermediate, notBefore: new Date(issuedAt - 3600 * 1000), notAfter: new Date(issuedAt + 90 * DAY), serial: Number(order.id) });
      order.certificate = pem(leaf, "CERTIFICATE") + pem(intermediate.der, "CERTIFICATE");
      order.status = order.processing > 0 ? "processing" : "valid";
      log.issued.push({ name: order.name, spki: createHash("sha256").update(Buffer.from(request.key.spki)).digest("hex") });
      return send(200, orderBody(order), order.status === "processing" ? { "Retry-After": "0" } : {});
    }
    if (kind === "cert") {
      if (order.status !== "valid") return problem(403, "orderNotReady", "not issued");
      return send(200, order.certificate);
    }
    return problem(404, "malformed", "no such resource");
  });

  function orderBody(order) {
    return {
      status: order.status,
      expires: new Date(Date.now() + 7 * DAY).toISOString(),
      identifiers: [{ type: "dns", value: order.name }],
      authorizations: [`${url}/authz/${order.id}`],
      finalize: `${url}/finalize/${order.id}`,
      ...(order.status === "valid" ? { certificate: `${url}/cert/${order.id}` } : {}),
    };
  }

  function challengeBody(order) {
    return {
      type: "dns-01",
      url: `${url}/chall/${order.id}`,
      token: order.token,
      status: order.authzStatus === "pending" ? "pending" : order.authzStatus,
      ...(order.challengeError ? { error: order.challengeError } : {}),
    };
  }

  function authzBody(order) {
    return {
      status: order.authzStatus,
      identifier: { type: "dns", value: order.name },
      challenges: [{ type: "http-01", url: `${url}/chall-http/${order.id}`, token: order.token, status: "pending" }, challengeBody(order)],
    };
  }

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url,
    directory: `${url}/directory`,
    faults,
    log,
    rootPem: pem(makeCertificate({ spki: spkiOf(root.publicKey), subject: "Root YE", issuer: root, notBefore: new Date(now - DAY), notAfter: new Date(now + 3650 * DAY), ca: true }), "CERTIFICATE"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

