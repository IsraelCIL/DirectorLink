// Joining from another device (app/js/device-join.js, ADR-053): the key pairs, the commitment, the
// check code both devices show, the invitation sealed to the new device, and reading an invitation
// out of pasted text.
//   node --test tests/app/

import assert from "node:assert/strict";
import test from "node:test";

import { useLadder } from "../../app/js/cpace.js";
import { checkCode, codeText, commitmentOf, invitationFromText, keyPair, openInvitation, sealInvitation } from "../../app/js/device-join.js";
import { fromBase64, toBase64 } from "../../app/js/lock.js";

const HOME = "0123456789abcdef0123456789abcdef";
const REQUEST = "fedcba9876543210fedcba9876543210";
const INVITATION = `${HOME}.89abcdef.${"ab".repeat(32)}`;

test("a key pair comes back from its secret, so a reload carries on", async () => {
  const pair = await keyPair();
  assert.match(pair.secret, /^[0-9a-f]{64}$/);
  assert.equal(fromBase64(pair.publicKey).length, 32);
  const again = await keyPair(pair.secret);
  assert.equal(again.publicKey, pair.publicKey);
  assert.notEqual((await keyPair()).publicKey, pair.publicKey);
  await assert.rejects(keyPair("abcd"));
});

test("the invitation sealed to the new device opens there, and only there", async () => {
  const approver = await keyPair();
  const device = await keyPair();
  const request = { requestId: REQUEST, home: HOME };
  const sealed = await sealInvitation(approver, { ...request, deviceKey: device.publicKey }, INVITATION);
  assert.ok(!sealed.includes(INVITATION) && !Buffer.from(sealed, "base64").toString("latin1").includes("89abcdef"), "nothing of it can be read");
  assert.equal(await openInvitation(device, { ...request, approverKey: approver.publicKey }, sealed), INVITATION);
  // Each seal is new (a random IV).
  assert.notEqual(await sealInvitation(approver, { ...request, deviceKey: device.publicKey }, INVITATION), sealed);

  const stranger = await keyPair();
  assert.equal(await openInvitation(stranger, { ...request, approverKey: approver.publicKey }, sealed), null, "another device");
  assert.equal(await openInvitation(device, { ...request, approverKey: stranger.publicKey }, sealed), null, "another approving key");
  assert.equal(await openInvitation(device, { requestId: "0".repeat(32), home: HOME, approverKey: approver.publicKey }, sealed), null, "another request");
  assert.equal(await openInvitation(device, { requestId: REQUEST, home: "1".repeat(32), approverKey: approver.publicKey }, sealed), null, "another home");
  const bytes = fromBase64(sealed);
  bytes[20] ^= 1;
  assert.equal(await openInvitation(device, { ...request, approverKey: approver.publicKey }, toBase64(bytes)), null, "changed on the way");
  assert.equal(await openInvitation(device, { ...request, approverKey: approver.publicKey }, "not base64!"), null);
  assert.equal(await openInvitation(device, { ...request, approverKey: approver.publicKey }, "AAAA"), null, "too short");
  // A key of low order gives no shared secret: nothing is sealed to it.
  await assert.rejects(sealInvitation(approver, { ...request, deviceKey: toBase64(new Uint8Array(32)) }, INVITATION));
  await assert.rejects(sealInvitation(approver, { ...request, deviceKey: "AAAA" }, INVITATION));
});

test("browsers without X25519 in WebCrypto make the same keys and open the same seals", async () => {
  const approver = await keyPair();
  const device = await keyPair();
  const sealed = await sealInvitation(approver, { requestId: REQUEST, home: HOME, deviceKey: device.publicKey }, INVITATION);
  useLadder(true);
  try {
    const sameDevice = await keyPair(device.secret);
    assert.equal(sameDevice.publicKey, device.publicKey);
    assert.equal(await openInvitation(sameDevice, { requestId: REQUEST, home: HOME, approverKey: approver.publicKey }, sealed), INVITATION);
    const ladderApprover = await keyPair(approver.secret);
    const back = await sealInvitation(ladderApprover, { requestId: REQUEST, home: HOME, deviceKey: device.publicKey }, INVITATION);
    useLadder(false);
    assert.equal(await openInvitation(device, { requestId: REQUEST, home: HOME, approverKey: approver.publicKey }, back), INVITATION);
  } finally {
    useLadder(false);
  }
});

test("both devices show the same check code, made from the request and both keys", async () => {
  const approver = await keyPair();
  const device = await keyPair();
  const onApprover = await checkCode(REQUEST, approver.publicKey, device.publicKey);
  const onDevice = await checkCode(REQUEST, (await keyPair(approver.secret)).publicKey, (await keyPair(device.secret)).publicKey);
  assert.equal(onApprover, onDevice);
  assert.match(onApprover, /^[0-9]{6}$/);
  const other = await keyPair();
  // A key put in the middle, on either side, gives another code (one chance in a million to match).
  assert.notEqual(await checkCode(REQUEST, other.publicKey, device.publicKey), onApprover);
  assert.notEqual(await checkCode(REQUEST, approver.publicKey, other.publicKey), onApprover);
  assert.notEqual(await checkCode("0".repeat(32), approver.publicKey, device.publicKey), onApprover);
  assert.equal(codeText("042917"), "042 917");
  assert.equal(codeText("12345"), "");
  // Spread over all six digits, leading zeros kept.
  const codes = await Promise.all(Array.from({ length: 200 }, (_, index) => checkCode(REQUEST, approver.publicKey, String(index))));
  assert.ok(codes.every((code) => /^[0-9]{6}$/.test(code)));
  assert.ok(new Set(codes).size > 195);
});

test("the commitment binds the new device's key before the other is seen", async () => {
  const device = await keyPair();
  const commitment = await commitmentOf(device.publicKey);
  assert.match(commitment, /^[0-9a-f]{64}$/);
  assert.equal(await commitmentOf(device.publicKey), commitment);
  assert.notEqual(await commitmentOf((await keyPair()).publicKey), commitment);
  // What the account service checks (cloud/src/device-requests.js: COMMIT_LABEL + the key).
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`DirectorLink device join v1|commit|${device.publicKey}`));
  assert.equal(Buffer.from(digest).toString("hex"), commitment);
});

test("a pasted invitation: a whole link, a message around one, or only its last part", () => {
  const token = INVITATION;
  assert.equal(invitationFromText(`https://app.directorlink.io/#/join/${token}`), token);
  assert.equal(invitationFromText(`  https://app.directorlink.io/#/join/${token}\n`), token);
  assert.equal(invitationFromText(`Join my home: https://app.directorlink.io/#/join/${token} (10 minutes)`), token);
  assert.equal(invitationFromText(token), token);
  assert.equal(invitationFromText(`#/join/${token}`), token);
  assert.equal(invitationFromText(token.toUpperCase()), token, "upper case, as some apps change it");
  assert.equal(invitationFromText(`http://localhost:8205/#/join/${token}`), token);
  for (const text of [
    "",
    null,
    undefined,
    42,
    "https://app.directorlink.io/#/join/",
    token.slice(0, -1),
    `${token}0`,
    `0${token}`,
    token.replace(".89abcdef.", ".89abcde."),
    token.replace(/\./g, "/"),
    "1234 5678",
  ]) {
    assert.equal(invitationFromText(text), null, String(text));
  }
});
