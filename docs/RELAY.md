# DirectorLink relay protocol (version 1)

The relay lets the app reach a home from anywhere without opening anything on the home network:
the **driver** keeps one outgoing WebSocket (TLS, port 443) to `api.directorlink.io`, and requests
for that home travel over it. This document is the contract between `driver/src/cloud/` and
`cloud/`. Accounts, claiming a home, invitations and the lock are in `docs/ACCOUNTS.md` (ADR-029).

Since version 1 (DirectorLink 0.10.0) **everything the relay passes on is sealed end to end**: the
relay routes envelopes it cannot read. The plain requests of version 0 are refused by the driver.
One exception since 1.7.0: a scene link's run (`link`, below; ADR-051) carries the link's id and
secret as the phone sent them, because a phone's automation cannot seal.

## Identity of a home

When **Remote Access** is switched on the first time, the driver creates and keeps, in its
persistent data (ADR-028):

- `home_id` — 32 hex characters, random. Not secret; shown shortened in Composer.
- `home_secret` — 64 hex characters, random. Never logged, never shown. It leaves the controller
  only in a backup (1.4.0, ADR-042): `GET /v1/backup` gives it, with the waiting replacements, to
  admin keys in sealed requests only, and the app saves it encrypted with a password; only an
  identity the relay has accepted goes into one.

The relay trusts the first secret it sees for a `home_id` (it stores the SHA-256) and afterwards
only accepts that secret. This only decides which connection carries the home's envelopes: who may
use the home is decided by the account's claim and by the device keys (`docs/ACCOUNTS.md`).

**Replacing the secret** (1.0.0), for instance after a copy of the controller's data went missing,
needs the home's owner, since whoever holds that copy can connect as the home:

1. The owner's app, on the home network, asks the controller for a new secret
   (`POST /v1/remote/secret`, admin key, refused through the relay). The driver makes a new one for
   every request (never one made earlier, which a copy of its data taken meanwhile would hold),
   keeps the newest three for a day next to the one in use, and answers only its SHA-256 (the
   secrets themselves go only into a backup).
2. The app gives the SHA-256 to the account service (`POST /v1/homes/{home_id}/secret`, the owner's
   session only). From then on the relay accepts only the new secret, and it closes the driver's
   socket (4001 `secret replaced`).
3. The driver reconnects with the secret in use, is refused (401), and tries the waiting ones once
   each, newest first. The one that connects is the home secret from then on, and the others go.
   If all are refused, the driver waits as for any refusal (300 s) and starts again with the secret
   in use.

The account service trusts the owner's session for this: someone who stole it could approve a
secret of their own and cut the controller off from the relay (they still could not read or change
anything, and a stolen owner session could already delete the home). The owner then signs out
everywhere and replaces the secret again at home, or the installer runs Reset Remote Identity.

The Composer action **Reset Remote Identity** is the last resort, for when the owner cannot do this
(someone else took the home over): the driver makes a new `home_id` and secret, revokes its pending
invitations and claim token, and connects as a new home, which the owner links again.

**A restore from a backup** (ADR-042, docs/BACKUP.md) may bring the backup's identity to this
controller: the one it replaces is kept until the relay accepts the backup's, and comes back if the
relay refuses it (401, or 400 for an identity it does not take). Another home's identity moves only
when the admin asks. The relay lets one connection carry a home: a second controller with the same
identity replaces the first (4000 `replaced`), and the two push each other off every 30 seconds
or so, so the controller the backup was made on must be off, or have Remote Access off, first.

## Connecting

```
GET /relay/connect HTTP/1.1
Host: api.directorlink.io
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <base64 of 16 random bytes>
Sec-WebSocket-Version: 13
Authorization: Bearer <home_secret>
X-DirectorLink-Home: <home_id>
X-DirectorLink-Version: <driver version>
User-Agent: DirectorLink/<driver version>
```

- `101 Switching Protocols` — connected. One driver connection per home: a new one replaces the
  previous (the relay closes the old socket with code 4000, reason `replaced`).
- `400` — missing or malformed headers; `401` — wrong secret for this `home_id`. Problem Details
  JSON (`application/problem+json`) with a `code`.

The driver reconnects after a lost connection: after 1 s when the connection had been up for a
minute, then with backoff, 5 s, 10 s, 30 s, then every 60 s (*Keeping the connection*, below). An
attempt that has not opened within 30 s (no TLS connection, or no answer to the upgrade) counts as
lost too.

The driver asks Director to check the relay's certificate (`VERIFY_MODE = "peer"` in
`driver/src/cloud/websocket.lua`). Without it, Director checks nothing, and anyone in the network
path could pose as the relay and catch the home secret. The chain must end at one of the root
certificates in the driver package, `certs/directorlink-roots.pem`. These are the authorities
Cloudflare issues the relay's certificate from, and Cloudflare may switch between them at any renewal:
- Let's Encrypt: ISRG Root X1 and X2.
- Google Trust Services: GTS Root R1, R3 and R4. Today's chain is WE1 → GTS Root R4.
- SSL.com: the TLS RSA and ECC roots of 2022, and the older RSA and ECC roots.

This check is new in 1.1.0 (ADR-034). Control4 does not document two things, which a controller
has to show: whether Director also checks that the certificate names `api.directorlink.io`, and
how it reports a certificate that does not verify. `Connected` alone shows neither: 1.0.0 connected
with no check at all. docs/TESTING.md 0p has the negative test for the check itself: a test package
(`scripts/build.py --roots-only`) that trusts only a root the relay's chain does not end at must
never connect. The name is not tested; if Director does not check it, a certificate that one of
these authorities issued for another name passes too. Either way the driver retries with the
backoff:
- If Director reports the connection offline, Remote Status shows
  `Reconnecting in N s (connection lost)`.
- If Director reports nothing, the 30 s limit ends the attempt. Remote Status shows
  `Reconnecting in N s (no connection within 30 s)`, and the relay log says *no TLS connection to
  the relay within 30 s; the certificate check may have failed*.

The file lists each root's SHA-256. Rebuild it from a current CA list (such as certifi) before a
root expires or when Cloudflare adds an authority. `scripts/build.py` packages only this file of
`driver/certs/` (any other file there stops the build), with LF line endings.
`scripts/check_package.py` reads it as OpenSSL does (every `BEGIN` block, trailing whitespace and
CRLF included) and checks that the certificates in it are exactly these roots, each once, with its
pinned SHA-256, and nothing else: no key and no other block. `scripts/check_repo.py` checks the
staged file the same way.

## Messages

All frames are **text**. Apart from the keep-alive words below, each is one JSON object with a
`type`. Every message the relay sends has an `id`; the driver's reply carries the same `id`. The
same holds the other way for what the driver asks the relay (`invitation`, `backup_chunk`).

| Direction | Message | Meaning |
| --- | --- | --- |
| driver → relay | `ping` (plain text) | Keep-alive, every 10 s (25 s before 1.6.0), and if Director polls the connection. |
| relay → driver | `pong` (plain text) | Answer to `ping`, sent by the runtime without waking the relay's code. |
| driver → relay | `{"type":"hello","home":"<home_id>","version":"1.7.0","ping_s":10,"features":["scene_links"]}` | First message after connecting. `ping_s`: how often the driver pings, in seconds (since 1.6.0; without it the relay counts 25 s). `features` (since 1.7.0): what the relay may send this driver besides what every version takes; `scene_links`: `link` runs. A driver that does not list a feature is never sent its messages. |
| driver → relay | `{"type":"keys","ids":["<key id>", …]}` | The ids of the home's API keys (ids only), after `hello` and after every change. The cloud forgets the others; an account whose keys are all gone leaves the home (never its owner). Since 0.11.0. |
| relay → driver | `{"type":"e2e","id":"…","envelope":{…}}` | A request sealed by a device (the lock, `docs/ACCOUNTS.md`). |
| driver → relay | `{"type":"e2e","id":"…","envelope":{…}}` | The sealed answer; or `{"type":"e2e","id":"…","code":"…"}` when the request is refused. |
| relay → driver | `{"type":"join","id":"…","invitation":"<id>","envelope":{…}}` | Accepting an invitation: a request sealed with the invitation's secret. |
| driver → relay | `{"type":"join_result","id":"…","ok":true,"key_id":"…","envelope":{…}}` | The new key, sealed for the invited device; or `"ok":false` with a `code`. |
| relay → driver | `{"type":"claim","id":"…","token":"<48 hex>"}` | Is this the claim token the controller gave out? |
| driver → relay | `{"type":"claim_result","id":"…","ok":true}` | Yes (the token is used up); or `"ok":false,"code":"INVALID_CLAIM"`. |
| driver → relay | `{"type":"invitation","id":"…","invitation_id":"<8 hex>","email":"…","expires_at":"<ISO time>","pending":["<8 hex>", …]}` | Registers an invitation the controller made for an admin (`POST /v1/invitations` with `email`), binding it to that email. `pending`: the ids of every invitation still waiting on the controller (this one included); the relay forgets the others it registered for the home. Since 1.0.0. |
| relay → driver | `{"type":"invitation_result","id":"…","ok":true}` | Registered; or `"ok":false` with `INVALID_REQUEST`, `INVITATION_EXISTS` (an id is bound to its email once), `INVITATION_LIMIT_REACHED` (20 waiting), `NOT_CLAIMED` (no account has claimed the home) or `INTERNAL`: the driver revokes the invitation and answers the admin `502` with that code. With no answer within 10 s, or while not connected, it revokes it and answers `503 REMOTE_OFFLINE`. |
| driver → relay | `{"type":"invitation_cancel","invitation_id":"<8 hex>"}` | The driver revoked the invitation, or gave up waiting for `invitation_result`: the relay forgets it if it took it. No answer. Since 1.0.0. |
| driver → relay | `{"type":"backup_chunk","id":"…","index":0,"count":3,"size":174000,"key_id":"<16 hex>","why":"daily","data":"…"}`, then `{"type":"backup_chunk","id":"…","backup":"<32 hex>","index":1,"data":"…"}` | An automatic backup (ADR-048, `docs/BACKUP.md`), sealed to the backup password's public key: its text, printable ASCII only (JSON around base64), in chunks of at most 65,536 bytes (the driver sends 60,000), each sent once the one before is answered. The first says how many there are, the whole size in bytes (at most 3,000,000), which password's key it is sealed to, and `why`: `daily` for the nightly backup, `now` for Back up now. Since 1.6.0. |
| relay → driver | `{"type":"backup_result","id":"…","ok":true,"backup":"<32 hex>","complete":false}` | Kept (`complete` after the last); or `"ok":false` with `INVALID_REQUEST` (also for a character that is not printable ASCII), `NOT_CLAIMED` (no account has claimed the home), `BACKUP_TOO_LARGE`, `BACKUP_LIMIT` (the home started 4 backups this UTC day; its first `daily` one goes besides), `ACCOUNT_BACKUPS_FULL` (the backups that must stay in the owner's account, with this one, would pass 25 MB), `SIZE_MISMATCH`, `OUT_OF_ORDER`, `UPLOAD_NOT_FOUND` or `INTERNAL`: the driver stops and logs why. With no answer within 30 s it stops too. |
| driver → relay | `{"type":"keys","ids":[…],"admins":["<key id>", …]}` | Since 1.6.0 `keys` also says which of the ids are admin keys: only accounts that use one get the home's alerts (ADR-047) and may list, download and delete the account's backups of the home (ADR-048), the owner too. Without `admins` (drivers before 1.6.0) the cloud knows no admin: nobody can switch alerts on, and only the home's owner sees its backups. |
| driver → relay | `{"type":"alert","kind":"schedule_failed","at":"<ISO time>"}` | A scheduled scene failed at `at` (a device refused, or it could not run): the cloud alerts the home's admins, at most three times an hour. Nothing names the schedule, the scene or a device. Sent only while connected; no answer. Since 1.6.0 (ADR-047); from 1.7.0 drivers send `notify` instead, which the cloud cannot read. |
| driver → relay | `{"type":"notify","at":"<ISO time>","for":{"<key id>":{"iv":"…","ct":"…","mac":"…"}, …},"brief":true}` | An alert the controller made (a doorbell rang, a door or gate was opened, the refrigerator's door was left open, a schedule failed), for the keys it names, each part sealed to that key's alert key (ADR-050), every `ct` 684 characters (each detail is padded to one size): the cloud cannot read what it is about; only which keys it names and `brief` tell it some kinds (ADR-050's Consequence). It pushes each part, at once, only to the browsers registered with that key id by an account that uses that key at the home. `brief` (a doorbell): the push service keeps it a minute. At most 50 keys, 60 messages a home an hour. Sent only while connected; no answer. Since 1.7.0. |
| relay → driver | `{"type":"link","id":"…","link":"<8 hex>","secret":"<40 hex>"}` | A scene's link, run from a phone's automation (1.7.0, ADR-051, docs/SCENES.md): not sealed. Sent only to a driver whose `hello` lists `scene_links`, for a home an account has claimed, at most 30 a minute a home, and none from an address whose runs were answered 404 ten times in 10 minutes. The driver checks the secret against the hash it keeps, in constant time, and runs the scene as a member's key would. |
| driver → relay | `{"type":"link_result","id":"…","ok":true,"result":"ran"}` | How it went: `ran`, `partly` (some devices skipped or failed), `failed` (none ran) or `nothing` (there was nothing to run: its devices were removed in Composer); or `"ok":false` with `NOT_FOUND` (an unknown link, a wrong secret, a scene gone or with doors or gates, the key that made the link gone: all alike), `RATE_LIMITED` (6 runs a minute a link; `retry_s`) or `INTERNAL`. Never names the scene. Since 1.7.0. |
| relay → driver | `{"type":"request",…}` | Version 0. Refused: `{"type":"response","id":"…","status":410,…}` with `code` `RELAY_REQUESTS_RETIRED`; nothing reaches the API. |

A message of a type the driver does not know is ignored (logged at debug level as `ignored relay
message`) and never answered: the relay sends new types only to drivers whose `hello` lists them
(`features`), since one sent anyway would wait for its 15 s timeout. Before 1.7.0 no driver lists any.

Refusal codes from the driver: `UNKNOWN_KEY`, `BAD_ENVELOPE`, `BAD_MAC`, `BAD_CIPHERTEXT`, `BAD_REQUEST`, `STALE`
(outside the 2-minute window, or sealed before the driver started), `REPLAYED`, `TOO_LARGE`
(requests over 64 KiB), `LOCK_UNAVAILABLE` (the lock self-test failed at start),
`INVITATION_NOT_FOUND`, `KEY_LIMIT_REACHED`, `INTERNAL`. The cloud turns them into Problem Details
for the app (`cloud/src/homes.js`).

If the driver hears nothing (not even `pong`) for three pings in a row (about 30 s), it drops the
connection and reconnects.
The relay answers `504 HOME_TIMEOUT` to its caller when a reply takes longer than 15 s.

## Keeping the connection

**What keeps it open.** The driver sends `ping` every 10 s (25 s up to 1.5.0) and the relay's
runtime answers `pong` without waking the home's object. Data then crosses Cloudflare in both
directions every 10 s, well inside any idle limit (Cloudflare closes a WebSocket that carries
nothing in either direction for a while, without a documented figure). A connection that hears
nothing for three pings in a row (about 30 s; counted in pings, not by the clock, so a clock set
back cannot stretch it) is dropped and made again. TCP keep-alive is on as well.

**What a ping costs.** Nothing. The relay sets the answer with `setWebSocketAutoResponse`, and
Cloudflare documents that such an answer is sent "without waking WebSockets in hibernation and
incurring billable duration charges" ([Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/))
and that auto-response messages "will not incur additional wall-clock time, and so they will not
be charged" ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
So pinging every 10 s rather than 25 s costs the relay nothing, and the controller one small
timer.

**Director's own monitoring is off** (1.5.0, ADR-045). Up to 1.4.0 the driver opened the
connection with `MONITOR_CONNECTION = true`. Control4 documents that Director then polls the
connection (it calls the driver's `OnPoll`, which DirectorLink did not define) and considers it
down when no data comes back. It does not document how often, or how long it waits. Real
controllers (CORE-1 on OS 3.4.3, X4 on OS 4.2) reported the connection offline (`connection lost`)
every 10 to 40 minutes. The relay saw the socket end without a close frame (code 1006), with
nothing wrong on its side before. Director's monitoring is the likeliest cause on the
controller's side, and the driver does not need it. Now the driver's ping and its silence rule
are the only checks. If Director polls all the same, `OnPoll` sends a `ping`, so the relay answers at
once.

**What can end it, and what follows.** The driver's relay log names each one (*Logs*, below).

| What happens | Remote Status and log reason | Next attempt |
| --- | --- | --- |
| Director reports the connection offline: the network, the router or Cloudflare cut it | `connection lost` | 1 s, if it was up a minute |
| Nothing heard for three pings, about 30 s (the driver closes it, with `1000 no answer`) | `no answer` | 1 s |
| The relay closes it: `4000 replaced` (another controller with this identity) | `closed by the relay (4000 replaced)` | 30 s |
| The relay closes it: `4001 secret replaced` (the owner approved a new secret) | `closed by the relay (4001 secret replaced)` | 1 s; refused, then the new secret 1 s later |
| The relay closes it with any other code | `closed by the relay (…)` | 1 s, if it was up a minute |
| An attempt that does not open within 30 s, or fails | `no connection within 30 s`, `connection lost` | backoff |
| The relay refuses the upgrade: `401` / other | `refused: <code>` | 300 s / backoff |

A connection lost less than a minute after it opened goes on with the backoff (5 s, 10 s, 30 s,
then every 60 s), so one that fails as soon as it opens is not tried every second.

**Cloudflare's part.** Cloudflare documents three cases where it closes WebSockets on its side,
and DirectorLink cannot prevent them. A deploy of the relay restarts every Durable Object and
disconnects every driver. Updates of the Workers runtime, and moving an object to another machine,
shut objects down, which ends their WebSockets. Cloudflare also restarts edge servers when it
releases new code. None of these has a documented frequency. The driver sees each one as a close
from the relay or as `connection lost` (`wrangler dev`, reloading the relay as a deploy does, ends
the sockets without a close frame), and comes back after about a second.

**Director's connection events.** Director reports `ONLINE` and `OFFLINE` for the binding, not
for one connection. So the driver keeps Director's view of the binding. The `OFFLINE` that answers
the driver's own `NetDisconnect` is not taken for the failure of the next attempt, even when it
arrives after that attempt started. A connection given up on that comes up late is closed again,
and gets no upgrade request. Data that arrives while no connection is being made is dropped.

**A connection that dies without a close** (1.6.0). On the owner's network the connection also
died silently every 20 to 60 minutes at busy times: Cloudflare saw no close, so the relay kept the
socket and went on sending requests into it, and the driver found out only at its next ping, which
Director refused at once (`connection lost` with `heard_s` about one interval and `ping_s` 0). Its
new connection then replaced the old one, and what had been sent meanwhile failed. With a ping
every 10 s that window is at most 10 s. And the relay no longer trusts a socket on which the
driver has gone quiet: once nothing has been heard on it (no ping answered, no message) for 2.5 of
the intervals the `hello` announced (25 s; about 62 s for drivers before 1.6.0, which announce
none and ping every 25 s), the socket is *stale*. Nothing is sent into it, requests wait for the
driver's next connection as below, and the status says offline since the driver was last heard.
The relay logs `driver_stale` once for the socket. If the pings come through again, the socket is
used again; normally the driver's silence rule replaces it a few seconds later.

**While the driver reconnects.** A request for the home that finds no driver connection, within
30 s of the driver's disconnect, or whose driver's socket went stale within the last 30 s, waits
up to 8 s for the driver's `hello` and then goes through.
So does the first request after the relay restarted under the connection (a deploy), which
records no disconnect. Before 1.5.0 it failed at once with `503 HOME_OFFLINE`. A home away for
longer, or that did not come back within the 8 s after a restart, answers `503` at once. A request already sent when the connection ends fails with `502 HOME_DISCONNECTED`
as before, and so does one sent over a connection the driver has since replaced, at once rather
than at its 15 s timeout (the relay may not have noticed that connection die). It is never sent
again, because the controller may have carried it out.

**Logs.** On the controller, `GET /v1/logs?category=relay` gives one line per event:
- `relay connection closed` (info): an open connection was lost. It carries the `reason`, the
  number of the `attempt` that follows, and `retry_s`, the wait until that attempt. It also says
  how long the connection was up (`up_s`) and how long before the end the relay was last heard
  (`heard_s`) and pinged (`ping_s`). `polled_s` appears only if Director polled.
- `relay connection attempt failed` (info): the same, for an attempt that never opened.
- `no answer from the relay; reconnecting` (warn), and the 30 s and refusal lines, also carry
  `attempt` and `retry_s`.
- `connected to the relay` (info) says how many attempts it took (`attempts`) and how long the
  home was away (`down_s`).

Remote Status keeps the last loss after it reconnects: `Connected since 14:23 - home 3f9a1c2e -
last drop 14:22 (connection lost)`. In the relay's own log (Workers Observability) the same loss
is `driver_disconnected`, with `why` (the close code), `up_s`, `ping_s` (seconds since the runtime
last answered the driver's ping) and `message_s`. The next `driver_connected` has `down_ms`, how
long the home was away. A socket the driver went quiet on is `driver_stale`, with `interval_s` (from
the `hello`), `up_s`, `ping_s` and `message_s`.

**What this does not fix.** A cut connection still takes the driver about a second to replace,
plus its TLS handshake. A request already on its way then fails. The app asks again 2 s later, and
that request waits for the driver. A request sent into a connection that died without a close
fails too, in the seconds until the driver's next ping finds it dead (at most 10 s). If drops go
on, the logs above show which side ended the connection. If `heard_s` was under 10 s (25 s before
1.6.0) and the relay saw 1006, the connection was cut between the two: by the home's network, the
internet provider or Cloudflare's edge.

## What a relayed request may do

- A sealed request runs as the device's own API key, with that key's role (viewer, member, doors,
  admin) and the Composer Door Control and Relay Hold switches, exactly as on the home network.
- The driver logs it like a LAN request, with `client` = `relay` and the key id.
- Claim tokens (`POST /v1/remote/claim`) are given out only on the home network, to admin keys,
  and pairing (`POST /v1/auth/pair`) works only there too (`PAIRING_ONLY_ON_HOME_NETWORK`).
- Only the controller registers invitations for its home; the account service's own endpoint for
  it is kept for the home's owner, for drivers before 1.0.0 (`OWNER_ONLY` for other members).
- A scene link's run (`link`, 1.7.0) is no API request: it runs only the scene the link was made
  for, as a member's key, never one that opens doors or gates, and goes into the history as run by
  that link (ADR-051). The driver logs it with the link's id, never its secret.

## Test endpoints

Version 0's `GET /test/homes/{home_id}/status` and `GET /test/homes/{home_id}/v1/...` exist only
while the Worker has a `TEST_TOKEN` secret; production has none, so they answer
`503 TEST_TOKEN_NOT_SET`. Drivers from 0.10.0 refuse the relayed plain request in any case.

- `GET /health` → `{"status":"ok"}` (no token).
