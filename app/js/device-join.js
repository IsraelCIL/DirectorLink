// Joining from another device (ADR-053, docs/ACCOUNTS.md): the keys, the check code and the seal,
// and reading an invitation out of pasted text. The screens and the account service's part are in
// views/device-join.js.
//
// The new device makes an X25519 key pair and sends the account service only a commitment to its
// public key (SHA-256). A device of the same account that holds a key at the home answers with its
// own public key; only then does the new device show its key, which must match the commitment.
// Both devices show a check code made from both keys, so whoever passes them on cannot choose keys
// that give both screens the same code: each key was fixed before the other was seen. The approving
// device seals the invitation to the new device's key: X25519 with its own key, HKDF-SHA-256, then
// AES-256-GCM (WebCrypto in both browsers; no controller is involved). The account service passes
// on a value it cannot open.

import { fromBase64, toBase64 } from "./lock.js";
import { newScalar } from "./cpace.js";

export const LABEL = "DirectorLink device join v1";
const BASE = Uint8Array.from({ length: 32 }, (_, index) => (index === 0 ? 9 : 0));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function fromHex(text) {
  if (!/^(?:[0-9a-f]{2})+$/.test(text || "")) return null;
  return Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));
}

const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

// A key pair from 32 secret bytes (hex; new ones when left out): { secret, publicKey (base64),
// shared(otherPublic) → 32 bytes or null for a key of low order }. The secret is kept (as hex) only
// while a request lasts, so that a reload can carry on.
export async function keyPair(secret = toHex(crypto.getRandomValues(new Uint8Array(32)))) {
  const bytes = fromHex(secret);
  if (!bytes || bytes.length !== 32) throw new Error("A key pair needs 32 secret bytes");
  const scalar = await newScalar(bytes);
  const publicKey = toBase64(await scalar(BASE));
  return {
    secret,
    publicKey,
    async shared(otherPublic) {
      let other;
      try {
        other = fromBase64(otherPublic);
      } catch {
        return null;
      }
      return other.length === 32 ? scalar(other) : null;
    },
  };
}

// What the new device sends first: SHA-256 (hex) over its public key. The account service checks
// the key it shows later against it, and so does the approving device.
export const commitmentOf = async (publicKey) => toHex(await sha256(`${LABEL}|commit|${publicKey}`));

// The check code both devices show: six digits from the request and both public keys.
export async function checkCode(requestId, approverKey, deviceKey) {
  const digest = await sha256(`${LABEL}|code|${requestId}|${approverKey}|${deviceKey}`);
  // 48 bits, well within a Number: every code is as likely, to one part in four billion.
  const value = digest.slice(0, 6).reduce((sum, byte) => sum * 256 + byte, 0);
  return String(value % 1000000).padStart(6, "0");
}

// The code as it is shown, "123 456" (left to right in both languages).
export const codeText = (code) => (/^[0-9]{6}$/.test(code || "") ? `${code.slice(0, 3)} ${code.slice(3)}` : "");

// The AES-GCM key of one request, from the X25519 shared value; bound to the request, the home and
// both public keys.
async function sealKey(shared, { requestId, home, approverKey, deviceKey }, usage) {
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(LABEL), info: encoder.encode(`${requestId}|${home}|${approverKey}|${deviceKey}`) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

const additional = ({ requestId, home }) => encoder.encode(`${LABEL}|${requestId}|${home}`);

// The approving device: `text` (the invitation, home.invitation.secret) sealed to the new device's
// key with this device's key pair, as base64 (a 12-byte IV, then the ciphertext and its tag).
export async function sealInvitation(pair, request, text) {
  const shared = await pair.shared(request.deviceKey);
  if (!shared) throw new Error("The new device's key cannot be used");
  const key = await sealKey(shared, { ...request, approverKey: pair.publicKey }, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additional(request) }, key, encoder.encode(text)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64(out);
}

// The new device: the invitation's text, or null when it was not sealed to this key pair, for this
// request, by that approving key.
export async function openInvitation(pair, request, sealed) {
  try {
    const bytes = fromBase64(sealed);
    if (bytes.length < 12 + 16) return null;
    const shared = await pair.shared(request.approverKey);
    if (!shared) return null;
    const key = await sealKey(shared, { ...request, deviceKey: pair.publicKey }, "decrypt");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: additional(request) }, key, bytes.slice(12));
    return decoder.decode(plain);
  } catch {
    return null;
  }
}

// An invitation in pasted text: a whole link (…/#/join/<home>.<invitation>.<secret>), a message
// around one, or only that last part. The invitation as the join route keeps it, or null.
const INVITATION = /(?:^|[^0-9a-f])([0-9a-f]{32}\.[0-9a-f]{8}\.[0-9a-f]{64})(?![0-9a-f])/i;

export function invitationFromText(text) {
  const match = INVITATION.exec(typeof text === "string" ? text.trim() : "");
  return match ? match[1].toLowerCase() : null;
}
