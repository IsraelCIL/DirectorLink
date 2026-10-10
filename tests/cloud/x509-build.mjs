// DER built by hand for the Direct HTTPS tests (ADR-082): certificate requests as Director's
// C4:GenerateCSR_ECC makes them (the name as CN only), and certificates as a CA issues them, both
// signed with real keys (node:crypto). Never a key in the output.

import { generateKeyPairSync, sign } from "node:crypto";

const OID = {
  ecdsaSha256: "2a8648ce3d040302",
  sha256Rsa: "2a864886f70d01010b",
  commonName: "550403",
  subjectAltName: "551d11",
  extensionRequest: "2a864886f70d01090e",
  basicConstraints: "551d13",
};

function length(count) {
  if (count < 0x80) return Buffer.from([count]);
  const bytes = [];
  for (let value = count; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return Buffer.from([0x80 + bytes.length, ...bytes]);
}

export function tlv(tag, content) {
  const body = Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

export const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const oid = (hex) => tlv(0x06, Buffer.from(hex, "hex"));
const utf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const integer = (bytes) => tlv(0x02, Buffer.from(bytes));
const bitString = (bytes) => tlv(0x03, Buffer.concat([Buffer.from([0]), Buffer.from(bytes)]));

export function name(commonName) {
  return seq(set(seq(oid(OID.commonName), utf8(commonName))));
}

function dnsNames(names) {
  return seq(oid(OID.subjectAltName), tlv(0x04, seq(...names.map((value) => tlv(0x82, Buffer.from(value))))));
}

function utcTime(date) {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
  return tlv(0x17, Buffer.from(text));
}

function algorithm(key) {
  return key.asymmetricKeyType === "rsa" ? seq(oid(OID.sha256Rsa), tlv(0x05, Buffer.alloc(0))) : seq(oid(OID.ecdsaSha256));
}

function signed(body, key) {
  const signature = sign("sha256", body, key);
  return seq(body, algorithm(key), bitString(signature));
}

// A key pair: "P-256" (the default), "P-384", or "rsa" with `bits`.
export function keyPair(kind = "P-256", bits = 2048) {
  if (kind === "rsa") return generateKeyPairSync("rsa", { modulusLength: bits });
  return generateKeyPairSync("ec", { namedCurve: kind === "P-384" ? "secp384r1" : "prime256v1" });
}

export function spkiOf(publicKey) {
  return publicKey.export({ type: "spki", format: "der" });
}

// A CSR for `cn` with `keys` ({ publicKey, privateKey }); `sans`: DNS names in a subjectAltName.
export function makeRequest(cn, keys, { sans = [] } = {}) {
  const attributes = sans.length ? tlv(0xa0, seq(oid(OID.extensionRequest), set(seq(dnsNames(sans))))) : tlv(0xa0, Buffer.alloc(0));
  const info = seq(integer([0]), name(cn), spkiOf(keys.publicKey), attributes);
  return signed(info, keys.privateKey);
}

// A certificate for `spki` (DER) naming `names`, issued by `issuer` ({ name, privateKey }).
export function makeCertificate({ spki, names = [], subject = names[0] ?? "nobody", issuer, notBefore, notAfter, serial = 1, ca = false }) {
  const extensions = [];
  if (names.length) extensions.push(dnsNames(names));
  if (ca) extensions.push(seq(oid(OID.basicConstraints), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))));
  const tbs = seq(
    tlv(0xa0, integer([2])),
    integer([0x01, serial % 256]),
    algorithm(issuer.privateKey),
    name(issuer.name),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(subject),
    Buffer.from(spki),
    ...(extensions.length ? [tlv(0xa3, seq(...extensions))] : []),
  );
  return signed(tbs, issuer.privateKey);
}

export function pem(der, label) {
  const body = Buffer.from(der).toString("base64").replace(/.{64}/g, "$&\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// A P-256 key as PKCS #8 PEM with "\n" for its line breaks: a .dev.vars line (ACME_ACCOUNT_KEY).
export function accountKeyLine() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).trim().replace(/\r?\n/g, "\\n");
}

