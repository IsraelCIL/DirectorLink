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
- `426` — `DRIVER_UPDATE_REQUIRED` (1.8.0, ADR-059): this DirectorLink is older than the account
  service takes, with `minimum_version`. See *The oldest version the relay takes*, below.

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

### The oldest version the relay takes (1.8.0, ADR-059)

If a flaw is found in the remote protocol, the account service can turn away the drivers without
the fix until they are updated: the Worker var `MIN_DRIVER_VERSION` (`"1.8.0"`; unset, as it is
today, every version connects). The Worker compares `X-DirectorLink-Version` with it before the
home's Durable Object is asked, so an old driver trying again costs one Worker request:

```
HTTP/1.1 426 Upgrade Required
Content-Type: application/problem+json

{"type":"about:blank","title":"Upgrade Required","status":426,"code":"DRIVER_UPDATE_REQUIRED",
 "detail":"DirectorLink 1.7.0 can no longer connect to remote access: update DirectorLink to 1.8.0 or later",
 "minimum_version":"1.8.0"}
```

- Versions compare by their three numbers (`1.8.0-rc.1` is 1.8.0; `1.10.0` is above `1.8.0`). A
  version that is not three numbers (`dev`, a missing header) is below any minimum. A minimum that
  is not three numbers is ignored (logged `min_driver_version_invalid`).
- **Drivers from 1.8.0** say in Remote Status "Update DirectorLink: this version can no longer
  connect to remote access", try again an hour later, log each refusal and put one entry in the
  history (`remote_update_required`) until a connection opens again. Until then their
  `GET /v1/remote` says `update_required: true` (with `minimum_version`), so the app on the home
  network says "Update DirectorLink" too (Settings → Account → This home).
- **Drivers before 1.8.0** take it as any other refusal: they keep trying with their backoff (every
  60 s), and Remote Status says `Reconnecting in 60 s (refused: DRIVER_UPDATE_REQUIRED)`.
- **For the app**, the home's object still has the version of the driver's last connection. While
  no driver is connected and that version is below the minimum, a request through the account is
  answered `503 HOME_UPDATE_REQUIRED` (not `HOME_OFFLINE`), the status says `update_required`
  with `minimum_version`, and `GET /v1/homes` marks the home `update_required`: the app says to
  update DirectorLink. A scene link's run still gets `503 HOME_OFFLINE`.
- Setting or changing the var is a deploy, which ends every driver's connection: each is checked
  again as it reconnects. The home network is never affected.

## Messages

All frames are **text**. Apart from the keep-alive words below, each is one JSON object with a
`type`. Every message the relay sends has an `id`; the driver's reply carries the same `id`. The
same holds the other way for what the driver asks the relay (`invitation`, `backup_chunk`, `owner`;
since 1.10.1 a `notify` with an `id`).

| Direction | Message | Meaning |
| --- | --- | --- |
| driver → relay | `ping` (plain text) | Keep-alive, every 5 s (10 s from 1.6.0, 25 s before), and if Director polls the connection. |
| relay → driver | `pong` (plain text) | Answer to `ping`, sent by the runtime without waking the relay's code. |
| driver → relay | `{"type":"hello","home":"<home_id>","version":"1.10.1","ping_s":5,"features":["scene_links","alerts_gone","users","resend","alert_acks"],"instance":"<32 hex>"}` | First message after connecting. `ping_s`: how often the driver pings, in seconds (since 1.6.0; without it the relay counts 25 s). `features` (since 1.7.0): what the relay may send this driver besides what every version takes; `scene_links`: `link` runs; `users` (1.9.0, ADR-061): `accounts`, and any device of an account may approve that account's new device (the controller lets every user add their own; the home's object keeps the last hello's features as `driver_features`). `alerts_gone` (since 1.9.0): `alerts_gone`. `resend` (1.10.0, ADR-072): a request already sent when a connection ended may come again on the next one (*While the driver reconnects*, below). `alert_acks` (1.10.1, ADR-073): the driver gives each `notify` an `id`, keeps it until the relay answers `notify_result`, and sends it again after a lost connection to a relay that says it answers them (`relay_features`; *Alerts the driver sends*, below). A driver that does not list a feature is never sent its messages. `instance` (1.10.0): a random id the driver makes at each start, so that the relay sends a request again only to the start of the driver it went to. |
| relay → driver | `{"type":"relay_features","id":"…","features":["alert_acks","https"]}` | What this relay does besides what every relay does (1.10.1, ADR-073): sent only to a driver whose `hello` lists `alert_acks`, at once, before anything else that `hello` lets the relay send (`accounts`, `alerts_gone`, requests sent again). `alert_acks`: it answers each `notify` that has an `id` with `notify_result`, and pushes an id once. `https` (1.12.0, ADR-082): it answers `https_certificate` and `https` (*Direct HTTPS*, below), even when its own settings are missing (`HTTPS_UNAVAILABLE`). No answer. A relay before 1.10.1 never sends it: the driver takes a relay heard without it (its `accounts` or `alerts_gone` first, or the second keep-alive tick after a `pong`) as one that does not answer alerts, nor issue certificates. |
| driver → relay | `{"type":"keys","ids":["<key id>", …]}` | The ids of the home's API keys (ids only), after `hello` and after every change. The cloud forgets the others; an account whose keys are all gone leaves the home (never its owner). Since 0.11.0. |
| relay → driver | `{"type":"accounts","id":"…","keys":{"<key id>":["<16 hex>", …]}}` | Which of the home's keys share a Google or Apple account (1.9.0, ADR-061, `docs/ACCOUNTS.md` *Users and accounts*): for each key an account uses (`member_keys`), a tag per account, the first 16 hex digits of SHA-256(`DirectorLink account v1\|<home id>\|<account id>`), at most 4 a key, sorted; a key no account uses is left out. Never an account's id or email. Sent only to a driver whose `hello` lists `users`, after each `keys` message it sent (in the order of its frames), after an account's first sealed request with a key, and after a join, a member removed, a new owner, or an account deleted or left without a sign-in. It replaces what the driver knew; no answer. The driver suggests bringing an account's devices into one user, which an admin confirms; it never moves a device on this message. |
| relay → driver | `{"type":"e2e","id":"…","envelope":{…}}` | A request sealed by a device (the lock, `docs/ACCOUNTS.md`). |
| driver → relay | `{"type":"e2e","id":"…","envelope":{…}}` | The sealed answer; or `{"type":"e2e","id":"…","code":"…"}` when the request is refused. |
| relay → driver | `{"type":"join","id":"…","invitation":"<id>","envelope":{…}}` | Accepting an invitation: a request sealed with the invitation's secret. |
| driver → relay | `{"type":"join_result","id":"…","ok":true,"key_id":"…","envelope":{…}}` | The new key, sealed for the invited device; or `"ok":false` with a `code`. |
| relay → driver | `{"type":"claim","id":"…","token":"<48 hex>"}` | Is this the claim token the controller gave out? |
| driver → relay | `{"type":"claim_result","id":"…","ok":true}` | Yes (the token is used up); or `"ok":false,"code":"INVALID_CLAIM"`. |
| driver → relay | `{"type":"invitation","id":"…","invitation_id":"<8 hex>","email":"…","expires_at":"<ISO time>","pending":["<8 hex>", …],"for_key":"<8 hex>"}` | Registers an invitation the controller made (`POST /v1/invitations` with `email`), binding it to that email. `pending`: the ids of every invitation still waiting on the controller (this one included); the relay forgets the others it registered for the home. Since 1.0.0. `for_key` (1.9.0, ADR-061): a member's invitation for their own other device, made with that key: the relay registers it only when the email is that of an account that uses that key at the home (`member_keys`: its own email or one of its sign-ins'). |
| relay → driver | `{"type":"invitation_result","id":"…","ok":true,"for_key":"<8 hex>"}` | Registered (`for_key` repeated when it was checked); or `"ok":false` with `INVALID_REQUEST`, `INVITATION_EXISTS` (an id is bound to its email once), `INVITATION_LIMIT_REACHED` (20 waiting), `NOT_CLAIMED` (no account has claimed the home), `ACCOUNT_NOT_OF_DEVICE` (1.9.0: no account of that email uses `for_key` at the home) or `INTERNAL`: the driver revokes the invitation and answers `502` with that code (`403` for `ACCOUNT_NOT_OF_DEVICE`). An `ok` without `for_key` to a request with one (a Worker before 1.9.0) is no registration: the driver revokes it, sends `invitation_cancel` and answers `502 FOR_KEY_UNSUPPORTED`. With no answer within 10 s, or while not connected, it revokes it and answers `503 REMOTE_OFFLINE`. Only `invitation_result` answers an `invitation` (the driver takes each answer only of its question's type). |
| driver → relay | `{"type":"owner","id":"…","account":"<16 hex>"}` | The home's owner made another admin user the owner (1.9.0, ADR-064): the account service is to move the home's owner account to that user's Google or Apple account, named by its tag (as in `accounts`; `null` when none of their devices has one). Sent only after the owner asked for it on the controller, and only for an account that is not in doubt (the new owner's devices of one account all use it, and the owner's devices do not); the controller records the new owner only once it is answered `ok` (or `NOT_CLAIMED`). After an `ok` it did not follow (the user changed meanwhile, or it could not save), or with no answer within 10 s, it sends `owner_cancel` with this message's id. Since 1.9.0; a Worker before 1.9.0 ignores it, and the driver gives up after 10 s. |
| relay → driver | `{"type":"owner_result","id":"…","ok":true,"previous":"<16 hex>","moved":true}` | Moved: `homes.owner_id` is now the account of the home with that tag, which belongs to the home and uses one of the admin keys of the controller's last `keys`; `previous`, the old owner account's tag; `moved` false when that account owned the home already (a retry of a request that moved it). What each request moved is kept for 15 minutes, for `owner_cancel`. Or `"ok":false` with `NOT_CLAIMED` (no account owns the home: the controller moves alone), `OWNER_NEEDS_ACCOUNT` (no account of the home has that tag, or none was named), `ACCOUNT_NOT_ADMIN` (it uses no admin key), `INVALID_REQUEST` or `INTERNAL`: nothing moved. Handled after the key messages the driver sent before it. Nobody joins or leaves. |
| driver → relay | `{"type":"invitation_cancel","invitation_id":"<8 hex>"}` | The driver revoked the invitation, or gave up waiting for `invitation_result`: the relay forgets it if it took it. No answer. Since 1.0.0. |
| driver → relay | `{"type":"owner_cancel","id":"<the owner message's id>"}` | The driver did not follow that `owner` request (the user changed meanwhile, or it could not save), or heard no answer within 10 s (1.9.0, ADR-064): the relay undoes exactly that request's move, putting back the owner account it replaced, while the account it made the owner still owns the home and the old one is still a member (no admin key needed); nothing when that request moved nothing, never arrived or is older than 15 minutes. Handled in order after the `owner` it cancels. Sent at once, or, when the connection is down, right after the next `hello`, before anything else (the driver keeps it in memory). No answer. |
| driver → relay | `{"type":"backup_chunk","id":"…","index":0,"count":3,"size":174000,"key_id":"<16 hex>","why":"daily","data":"…"}`, then `{"type":"backup_chunk","id":"…","backup":"<32 hex>","index":1,"data":"…"}` | An automatic backup (ADR-048, `docs/BACKUP.md`), sealed to the backup password's public key: its text, printable ASCII only (JSON around base64), in chunks of at most 65,536 bytes (the driver sends 60,000), each sent once the one before is answered. The first says how many there are, the whole size in bytes (at most 3,000,000), which password's key it is sealed to, and `why`: `daily` for the nightly backup, `now` for Back up now. Since 1.6.0. |
| relay → driver | `{"type":"backup_result","id":"…","ok":true,"backup":"<32 hex>","complete":false}` | Kept (`complete` after the last); or `"ok":false` with `INVALID_REQUEST` (also for a character that is not printable ASCII), `NOT_CLAIMED` (no account has claimed the home), `BACKUP_TOO_LARGE`, `BACKUP_LIMIT` (the home started 4 backups this UTC day; its first `daily` one goes besides), `ACCOUNT_BACKUPS_FULL` (the backups that must stay in the owner's account, with this one, would pass 25 MB), `SIZE_MISMATCH`, `OUT_OF_ORDER`, `UPLOAD_NOT_FOUND` or `INTERNAL`: the driver stops and logs why. With no answer within 30 s it stops too. |
| driver → relay | `{"type":"keys","ids":[…],"admins":["<key id>", …]}` | Since 1.6.0 `keys` also says which of the ids are admin keys (since 1.8.0 the keys of admin people, ADR-054): only accounts that use one get the home's alerts (ADR-047) and may list, download and delete the account's backups of the home (ADR-048), the owner too. Without `admins` (drivers before 1.6.0) the cloud knows no admin: nobody can switch alerts on, and only the home's owner sees its backups. |
| driver → relay | `{"type":"alert","kind":"schedule_failed","at":"<ISO time>"}` | A scheduled scene failed at `at` (a device refused, or it could not run): the cloud alerts the home's admins, at most three times an hour. Nothing names the schedule, the scene or a device. Sent only while connected; no answer. Since 1.6.0 (ADR-047); from 1.7.0 drivers send `notify` instead, which the cloud cannot read. |
| driver → relay | `{"type":"notify","at":"<ISO time>","for":{"<key id>":{"iv":"…","ct":"…","mac":"…"}, …},"brief":true}` | An alert the controller made (a doorbell rang, a camera saw someone (1.8.0, ADR-056), a door or gate was opened, the refrigerator's door was left open, a schedule failed), for the keys it names, each part sealed to that key's alert key (ADR-050), every `ct` 684 characters (each detail is padded to one size): the cloud cannot read what it is about; only which keys it names and `brief` tell it some kinds (ADR-050's Consequence). It pushes each part, at once, only to the browsers registered with that key id by an account that uses that key at the home. `brief` (a doorbell, or since 1.8.0 a door's ask-before-opening question, ADR-058): the push service keeps it a minute. At most 50 keys, 60 messages a home an hour. Since 1.7.0; up to 1.10.0 sent only while connected, and never answered. Since 1.10.1 (ADR-073), unless the relay is known not to answer alerts: `"id":"<16 hex>"`, random, answered `notify_result`; sent again after a lost connection with `"resent":1` (2, …: how often it went before), the same id and the same sealed parts; one made while the driver reconnects, within 2 minutes of losing a connection whose relay answers alerts, goes after the next `relay_features`; one that went to a relay that had not said so yet is not sent again. |
| relay → driver | `{"type":"notify_result","id":"…","ok":true}` | The relay has that `notify` (1.10.1, ADR-073): the id is recorded before anything is pushed, and an id it had already (the driver sent it again, not knowing it had arrived) is answered the same and not pushed again. `"ok":false` with `INVALID_REQUEST` for one that is not sealed parts for key ids (nothing pushed). Either way the driver keeps it no more. Only for a `notify` with an `id`. |
| relay → driver | `{"type":"link","id":"…","link":"<8 hex>","secret":"<40 hex>"}` | A scene's link, run from a phone's automation (1.7.0, ADR-051, docs/SCENES.md): not sealed. Sent only to a driver whose `hello` lists `scene_links`, for a home an account has claimed, at most 30 a minute a home, and none from an address whose runs were answered 404 ten times in 10 minutes. The driver checks the secret against the hash it keeps, in constant time, and runs the scene as DirectorLink itself, which opens no door or gate (until 1.8.0: as a member's key would). |
| driver → relay | `{"type":"link_result","id":"…","ok":true,"result":"ran"}` | How it went: `ran`, `partly` (some devices skipped or failed), `failed` (none ran) or `nothing` (there was nothing to run: its devices were removed in Composer); or `"ok":false` with `NOT_FOUND` (an unknown link, a wrong secret, a scene gone or with doors or gates, the key that made the link gone: all alike), `RATE_LIMITED` (6 runs a minute a link; `retry_s`) or `INTERNAL`. Never names the scene. Since 1.7.0. Since 1.8.0 the link may be a door's ask-to-open link (ADR-058), which opens nothing: `asked` (a `notify` went to its person's devices just before), `waiting`, `nobody`, `doors_off` or `not_asked`; `RATE_LIMITED` also after 10 runs an hour that asked or said why nobody was asked (`retry_s` then up to 3600, which the account service passes on as `Retry-After`). Never names the door. |
| relay → driver | `{"type":"alerts_gone","id":"…","keys":["<key id>", …]}` | The key ids that no browser registered at the home can get alerts for any more (1.9.0, ADR-062), sent to a driver whose `hello` lists `alerts_gone`: after each `keys`, and when browsers are removed (also by a registration: the same browser registered again with another key, or an account's oldest beyond ten), those of its keys with none registered by an account that uses them; after a `notify`, those it named that had none, or whose every browser the push service no longer knew (404, 410); after any other push, those whose last browser went so. Key ids only, at most 200: the cloud knew which keys have browsers. The driver switches those keys' alerts off (as their app would: `on` false, their kinds kept), so that it seals nothing more to them and an ask-to-open link whose devices are all gone answers `nobody`; their app switches alerts on again at its next start if it still has them. No answer. Drivers before 1.9.0 are never sent it (and would ignore it). |
| driver → relay | `{"type":"https_certificate","id":"…","name":"<20 base32>.dlhome.cc","csr":"-----BEGIN CERTIFICATE REQUEST-----…","ip":"192.168.1.201"}` | Direct HTTPS (1.12.0, ADR-082): a certificate for the controller's CSR (PEM, the name as its CN only), and the name's A record at its LAN address. Sent only to a relay whose `relay_features` lists `https`, while the home's owner has it on. Answered `https_certificate_result`, at once and again later (*Direct HTTPS*, below). |
| relay → driver | `{"type":"https_certificate_result","id":"…","ok":true,"status":"pending"}`, then `{"type":"https_certificate_result","id":"…","ok":true,"status":"issued","name":"…","certificate":"<PEM>","chain":"<PEM>","not_after":"<ISO time>"}` | `pending`: the order is running; its result follows tens of seconds later, to the id of the driver's newest request for that key. `issued` at once when the home has a fresh certificate for that key (more than a third of its lifetime left). Or `"ok":false` with a `code` (and `retry_s` when the Worker knows how long to wait; *Direct HTTPS*, below). |
| driver → relay | `{"type":"https","id":"…","name":"…","ip":"192.168.1.77"}`, or `{"type":"https","id":"…","name":null}` | Direct HTTPS (1.12.0): the controller's address, after each `relay_features` and when it changes (the A record follows while the home has a certificate); `name` null: turned off, the A record (and any challenge's TXT record) goes. Answered `https_result`. |
| relay → driver | `{"type":"https_result","id":"…","ok":true}` | Done; or `"ok":false` with `HTTPS_UNAVAILABLE`, `INVALID_REQUEST`, `ADDRESS_NEEDED`, `NOT_CLAIMED`, `NAME_MISMATCH` (with `name`), `NAME_TAKEN`, `DNS_FAILED` or `INTERNAL`. The driver tells the address again at its next look (10 minutes) or connection, and asks for the record's deletion again at every connection until it is answered `ok`. |
| relay → driver | the same `e2e`, `join`, `claim` or `link` message again, with `"resent":1` (or `2`) | A request already sent when the driver's connection ended, unanswered (1.10.0, ADR-072): the same id and the same body, on the next connection, right after its `hello`, only to a driver whose `hello` lists `resend` and names the same `instance`. The driver runs each id once: a repeat gets the first answer again, byte for byte; one still running gets nothing then (its answer goes on the connection there is when it is done); one it never got runs. |
| driver → relay | `{"type":"e2e","id":"…","ok":false,"code":"ANSWER_NOT_KEPT"}` (or `join_result`, `claim_result`, `link_result`) | That request ran, but its answer is no longer kept (too large to keep, such as a picture, or let go to stay within the driver's budget): the relay answers `502 HOME_DISCONNECTED`, as when a connection ended before 1.10.0. Also for a request sent again that the driver may have run and forgotten (more than 512 requests in 2 minutes, one of those forgotten within the last 30 s); the relay's log then says the home *may have* carried it out. Since 1.10.0. |
| relay → driver | `{"type":"request",…}` | Version 0. Refused: `{"type":"response","id":"…","status":410,…}` with `code` `RELAY_REQUESTS_RETIRED`; nothing reaches the API. Never sent again. |

A message of a type the driver does not know is ignored (logged at debug level as `ignored relay
message`) and never answered: the relay sends new types only to drivers whose `hello` lists them
(`features`), since one sent anyway would wait for its 15 s timeout. Before 1.7.0 no driver lists any.

Refusal codes from the driver: `UNKNOWN_KEY`, `BAD_ENVELOPE`, `BAD_MAC`, `BAD_CIPHERTEXT`, `BAD_REQUEST`, `STALE`
(outside the 2-minute window, or sealed before the driver started), `REPLAYED`, `TOO_LARGE`
(requests over 64 KiB), `LOCK_UNAVAILABLE` (the lock self-test failed at start),
`INVITATION_NOT_FOUND`, `KEY_LIMIT_REACHED`, `USER_DEVICE_LIMIT` (1.9.0: the user an invitation is for has five devices; the invitation stays), `INTERNAL`. The cloud turns them into Problem Details
for the app (`cloud/src/homes.js`). `ANSWER_NOT_KEPT` (1.10.0) is the relay's own: `502 HOME_DISCONNECTED`.

If the driver hears nothing (not even `pong`) for three pings in a row (about 15 s; 30 s before
1.10.0), it drops the connection and reconnects.
The relay answers `504 HOME_TIMEOUT` to its caller when a reply takes longer than 15 s (8 s after a
request was sent again), and (1.10.1, ADR-073) when 18 s have gone by since the request reached the
relay, whatever it waited for (*One budget for every request*, below).

## Keeping the connection

**What keeps it open.** The driver sends `ping` every 5 s (10 s from 1.6.0, 25 s up to 1.5.0;
every second in the first 4 s of a connection that follows a lost one, 1.10.0) and
the relay's runtime answers `pong` without waking the home's object. Data then crosses Cloudflare
in both directions every 5 s, well inside any idle limit (Cloudflare closes a WebSocket that
carries nothing in either direction for a while, without a documented figure). A connection that
hears nothing for three pings in a row (about 15 s; counted in pings, not by the clock, so a clock
set back cannot stretch it) is dropped and made again. TCP keep-alive is on as well.

**What a ping costs.** Nothing. The relay sets the answer with `setWebSocketAutoResponse`, and
Cloudflare documents that such an answer is sent "without waking WebSockets in hibernation and
incurring billable duration charges" ([Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/))
and that auto-response messages "will not incur additional wall-clock time, and so they will not
be charged" ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
So pinging every 5 s (1.10.0) rather than 10 s or 25 s costs the relay nothing, and the controller
one small timer that sends a 10-byte frame.

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
| Director reports the connection offline: the network, the router or Cloudflare cut it | `connection lost` | 1 s, if it was up a minute (or is one of the two after it, below) |
| Nothing heard for three pings, about 15 s (the driver closes it, with `1000 no answer`) | `no answer` | 1 s |
| The relay closes it: `4000 replaced` (another controller with this identity) | `closed by the relay (4000 replaced)` | 30 s |
| The relay closes it: `4001 secret replaced` (the owner approved a new secret) | `closed by the relay (4001 secret replaced)` | 1 s; refused, then the new secret 1 s later |
| The relay closes it with any other code | `closed by the relay (…)` | 1 s, if it was up a minute (or is one of the two after it, below) |
| An attempt that does not open within 30 s, or fails | `no connection within 30 s`, `connection lost` | backoff |
| The relay refuses the upgrade: `401` / other | `refused: <code>` | 300 s / backoff |
| The relay refuses this version: `426 DRIVER_UPDATE_REQUIRED` (1.8.0) | `Update DirectorLink: this version can no longer connect to remote access` (the log: `update required`) | 3600 s |

A connection lost less than a minute after it opened goes on with the backoff (5 s, 10 s, 30 s,
then every 60 s), so one that fails as soon as it opens is not tried every second. Except
(1.10.0) right after a connection up a minute was lost: the next two connections that open and
are lost sooner are also tried again after 1 s (the home's route was seen to flip again within
seconds, and the relay sends a request again only within 10 s, *While the driver reconnects*);
a third, or one after an attempt that did not open, goes on with the backoff. A connection that
follows a lost one pings every second for its first 4 s: a second cut is found within a second,
not at the keep-alive's first ping 5 s later.

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
died silently every 20 to 60 minutes, all day and at night too: Cloudflare saw no close, so the
relay kept the socket and went on sending requests into it, and the driver found out only at its
next ping, which Director refused at once (`connection lost` with `heard_s` about one interval and
`ping_s` 0). Its new connection then replaced the old one, and what had been sent meanwhile failed.

The cause, measured on 2026-10-06 (1.10.0, ADR-072): the home's internet provider
routes the home's traffic to Cloudflare through changing data centers (Tel
Aviv, Geneva, Zurich, Marseille, Munich; a probe saw the data center flip between Tel Aviv and
Geneva every few seconds). When the route moves, an open TCP connection reaches a data center that
has no state for it and is reset there, while the one that held it never hears a close. Nothing
on the controller or in Composer causes it (driver updates do not), and DirectorLink cannot
prevent it: it can only notice it soon and lose nothing. So since 1.10.0 the driver pings every
5 s, which finds a cut within 5 s, and a request already sent into the dead connection is sent
again on the next one (*While the driver reconnects*, below).

And the relay no longer trusts a socket on which the driver has gone quiet: once nothing has been
heard on it (no ping answered, no message) for 2.5 of the intervals the `hello` announced (12.5 s at
5 s pings, 25 s at 10 s; about 62 s for drivers before 1.6.0, which announce none and ping every
25 s), the socket is *stale*. Nothing is sent into it, requests wait for the
driver's next connection as below, and the status says offline since the driver was last heard.
The relay logs `driver_stale` once for the socket. If the pings come through again, the socket is
used again; normally the driver's silence rule replaces it a few seconds later.

**While the driver reconnects.** A request for the home that finds no driver connection, within
30 s of the driver's disconnect, or whose driver's socket went stale within the last 30 s, waits
up to 8 s for the driver's `hello` and then goes through.
So does the first request after the relay restarted under the connection (a deploy), which
records no disconnect. Before 1.5.0 it failed at once with `503 HOME_OFFLINE`. A home away for
longer, or that did not come back within the 8 s after a restart, answers `503` at once.

A request **already sent** when the connection ends (1.10.0, ADR-072): the connection closed or
failed, or the driver connected again and so replaced it (the relay may not have noticed that
connection die). Before 1.10.0 it failed with `502 HOME_DISCONNECTED`, at once rather than at its
15 s timeout, and was never sent again, because the controller may have carried it out: a press in
the seconds between a cut and the driver noticing it was lost. Since 1.10.0:

- **The relay keeps it** and waits for the driver's next `hello`, up to 8 s (`RECONNECT_WAIT_MS`),
  when the `hello` of the connection it went on lists `resend` (by the time that connection ends:
  a request sent in the moment between a new connection's upgrade and its `hello` is kept too).
  If the next `hello` lists `resend` and names the same `instance` as the connection the request
  went on, the relay sends the exact same frame again (the same id, the same sealed body, with
  `"resent":1`), and waits 8 s for its answer. A request is sent again at most twice (three sends
  in all: a second blink right after the first is covered, since the driver finds it within a
  second and comes back at once, *What can end it, and what follows*; more would not fit the app's
  wait), and only within 10 s of reaching the relay, so it is answered within 18 s, under the 20 s
  the app waits for a request through the account (`app/js/remote.js`). The first resend goes
  within about 7 s (the cut found within 5 s, then 1 s and the TLS handshake); the second within
  10 s while each reconnect's handshake and upgrade take under a second, as measured on the
  owner's home.
- **The driver runs each id once** (`driver/src/cloud/answers.lua`). It remembers, by the relay's
  id, every `e2e`, `join`, `claim` and `link` it got, for 2 minutes (at most 512), and, once
  answered, its answer (at most 64 answers and 512 KB together; one over 16 KB, such as a camera
  picture or a long list, is not kept; a command answers in well under 2 KB). To make room, answers
  older than 30 s go first (the relay no longer asks for them), then the largest, so pictures and
  lists never push out a press's answer. The same id again gets the saved answer, byte for byte,
  and nothing runs; one still running gets nothing then, and its answer goes on whatever connection
  is open when it is done; one whose answer is not kept gets `ANSWER_NOT_KEPT`, and the app `502
  HOME_DISCONNECTED` as before; one it never got runs. This is checked before a sealed request is
  opened, so a repeat never meets the replay check (`REPLAYED`), and the replay check still refuses
  the same sealed request under another id. Its clock is the keep-alive's ticks (5 s each), not the
  controller clock, so no clock change can make it forget early, and nothing ages while the
  connection is down; if it had to forget, to stay within 512, a request that came within the last
  30 s, a request sent again that it does not know gets `ANSWER_NOT_KEPT` rather than run.
- **A driver that restarted** (a Composer update, a reboot) remembers nothing, and its `hello` names
  a new `instance`: the relay does not send it what went to the one before, and answers `502
  HOME_DISCONNECTED`. Were a sealed request sent all the same, the driver would refuse it: it was
  sealed before the driver started (`STALE`), or, sealed by a device whose clock is ahead, its id
  is in the driver's saved list (`REPLAYED`). A door never opens twice.
- **Only these are sent again:** `e2e` (a sealed request: a door's pulse, a scene, Turn off all),
  `join` (accepting an invitation: the same new key, sealed as before), `claim` and `link` (a scene
  link's run or an ask-to-open question). Each is safe by the driver's memory, not by what it
  does. Version 0's `request` is not (the driver refuses it anyway). `accounts` and `alerts_gone`
  need no answer and are sent again after the next `keys` as before. `invitation_result`,
  `backup_result` and `owner_result` answer the driver's own questions: a lost one ends the
  driver's wait as before (the invitation is revoked, the nightly backup is tried again later that
  night, the owner move is undone by `owner_cancel`).
- **Without the feature** (DirectorLink before 1.10.0), or with no `hello` in time: `502
  HOME_DISCONNECTED`, as before.

**One budget for every request** (1.10.1, ADR-073). Every request through the relay (a sealed
request, a join, a claim, a scene link's run, a test request) ends within 18 s
(`REQUEST_BUDGET_MS`) of reaching the home's object: the wait for the driver's `hello` (up to 8 s),
the sends again (at most two, within 10 s) and the wait for the answer (up to 15 s, 8 s after a send
again) all come out of it. Up to 1.10.0 a request that first waited 8 s for the driver then had its
full 15 s: 23 s, while the app gives up after 20 s (`app/js/remote.js`) and says that DirectorLink's
servers could not be reached, though the home may still carry it out. Now the relay's own `504
HOME_TIMEOUT` ("The home did not answer within 18 s") comes first, and the app says that the home
is not connected right now ("Your home is not connected to DirectorLink right now…", as for every
`HOME_TIMEOUT`). The 2 s left are for the Worker's own work (the session, the membership) and the way
back. A request that waited for the driver goes with what is left of its 18 s (at least 10 s with
the production values); one with nothing left is not sent at all.

**Alerts the driver sends** (1.10.1, ADR-073). An alert the controller makes (`notify`: a doorbell
rang, a camera saw someone, a door or gate was opened, the refrigerator's door, a schedule failed,
a door's ask-to-open question) went only while connected, and one written into a connection that
had died without anyone noticing was lost. Since 1.10.1:

- **The driver keeps it until the relay answers.** Each `notify` gets a random `id` (16 hex digits)
  and is kept in memory (`driver/src/cloud/outbox.lua`) until the relay answers `notify_result`
  with that id. After a reconnect, once the relay says it answers alerts (`relay_features`), what
  was not answered goes again, oldest first: the same frame, with `"resent"`. An alert made while
  the connection is down, within 2 minutes of losing a connection whose relay answers alerts
  (`Relay.KEEP_WINDOW_SECONDS`, a timer started at each such loss), is sealed and kept too, and goes
  then for the first time (up to 1.10.0 it was not made at all); after those 2 minutes it is not
  made, as in 1.10.0. Only an alert that went to a relay known to answer alerts goes again: one
  that went while the relay had not said so yet, on a connection that then ended, is let go (that
  relay may have been one before 1.10.1, which pushed it and ignored its id).
- **The hourly limits count what was sent.** An alert kept counts toward the controller's limits
  (60 an hour, 30 of them a camera's, and since 1.11.0 10 a smoke or CO alarm's, ADR-080) as one sent, and is given back if it is let go before it ever
  went: an outage uses up no limit.
- **For a minute or two, twenty at most.** A doorbell's ring and a door's question are kept 60 s
  (they are brief: the push service keeps them only a minute, a visitor does not wait longer, and a
  question has two minutes in all); a camera's alert, a door opened, the refrigerator and a schedule
  120 s (worth knowing late, but a home away longer is the offline alert's, ADR-047). Each is counted
  by a timer of its own, so in real time whatever the controller clock does, also while the
  connection is down. At most 20 alerts and 128 KB together; the oldest go first. Memory only: a
  driver that restarts sends nothing again.
- **The relay pushes an id once.** It records each id before it pushes (`notify_ids` in the home
  object's storage: 10 minutes, at most 200), and answers. An id it had already (it arrived, and
  only its answer was lost with the connection) is answered and not pushed again; one that never
  arrived is pushed then. Storage, because the home's object may be evicted from memory while the
  driver reconnects (its sockets hibernate), or restarted by a deploy, between the two sends. Before
  the push, so that a failure between the two loses the alert rather than doubling it.
- **Only to a relay that says so.** The driver lists `alert_acks` in its `hello`, and a relay from
  1.10.1 answers `relay_features` at once, before anything else that `hello` lets it send. A relay
  heard without it (its `accounts` or `alerts_gone` before any `relay_features`, which follow the
  driver's `keys`, or the second keep-alive tick after anything was heard, such as a `pong`) does
  not answer alerts: what the driver kept is let go, never sent to the next relay (which could push
  it a second time), and its alerts go once, without an id, as from 1.10.0. A connection that ends
  before the relay was heard on it decides nothing.
- **Older versions.** A driver before 1.10.1 sends no id and is answered nothing, as before. A
  1.10.1 driver with a relay before 1.10.1 behaves as 1.10.0 (that relay ignores the id of the
  alerts sent before it was heard).

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
- `a request the relay sent again` (info, 1.10.0): its `type`, how often it was sent again
  (`resent`) and the `outcome`: `answered again`, `still running`, `answer not kept`, `new` (never
  got before: it ran) or `forgotten`.
- `alerts sent again` (info, 1.10.1): after a reconnect, how many alerts went (`count`), and how
  many of them had gone before (`resent`). `an alert kept for the next connection` (its `kind`,
  `keep_s`), `an alert was not acknowledged in time`, `an alert was let go to keep fewer` and `an
  alert was not sent again: the relay it went to had not said it answers alerts` (its `kind`, and
  how often it went: `sent`). The alerts log (`category=alerts`) says `alert kept for the next
  connection` (or `open request kept for the next connection`) for one only kept, rather than
  `alert sent`.

Remote Status keeps the last loss after it reconnects: `Connected since 14:23 - home 3f9a1c2e -
last drop 14:22 (connection lost)`. In the relay's own log (Workers Observability) the same loss
is `driver_disconnected`, with `why` (the close code), `up_s`, `ping_s` (seconds since the runtime
last answered the driver's ping) and `message_s`. The next `driver_connected` has `down_ms`, how
long the home was away. A socket the driver went quiet on is `driver_stale`, with `interval_s` (from
the `hello`), `up_s`, `ping_s` and `message_s`. Requests sent again after a `hello` (1.10.0) are one
`request_resent` line: how many (`count`), the most times one of them was sent again (`resent`),
and how long after their connection was found gone (`after_ms`); never a body. An alert sent again
(1.10.1) is `notify_sent` with `resent` when it had not arrived before, and `notify_again` (with
`resent`) when it had: not pushed again. Neither has the alert's id or its sealed parts.
`message_timeout` has `total_ms`, the time since the request reached the relay.

**What this does not fix.** A cut connection still takes the driver about a second to replace,
plus its TLS handshake, and a request sent into a connection that died without a close waits until
the driver's next ping finds it dead (at most 5 s). Since 1.10.0 neither loses the request: it is
answered a few seconds late. It still fails (`502 HOME_DISCONNECTED`, as before) when the driver
does not come back within 8 s, when it restarted meanwhile, when the connection blinks a third
time, and when its answer was too large to keep (a camera picture, which the app asks for again
anyway). Since 1.10.1 an alert the driver sends into a connection that has died goes again too
(*Alerts the driver sends*); it is still lost when the driver restarts, when the home is away
longer than the alert's minute or two, and beyond 20 waiting. The driver's own questions
(`invitation`, `backup_chunk`, `owner`) have their own waits and undo, as before. If drops go on, the logs
above show which side ended the connection. If `heard_s` was under one ping interval (5 s; 10 s
before 1.10.0, 25 s before 1.6.0) and the relay saw 1006, the connection was cut between the two:
by the home's network, the internet provider or Cloudflare's edge.

## Direct HTTPS (1.12.0, ADR-082)

At home, iPhones and iPads cannot call the controller's plain-HTTP API from the app's HTTPS page, so
the controller can also serve it over TLS on port 28443, under a name of the home's own
(`<20 base32>.dlhome.cc`), with a Let's Encrypt certificate that the relay gets for it. The installer
allows it in Composer (`Direct HTTPS`: Allowed), the home's owner turns it on in the app
(`PUT /v1/https`), and it needs Remote Access and a home linked to an account.

**The controller** (`driver/src/api/direct_https.lua`) makes its name and a P-256 key once, with its
CSR (`C4:GenerateCSR_ECC("SHA256", "prime256v1", "/CN=<name>")`, no subjectAltName). Once the relay
says it issues certificates (`relay_features` lists `https`), it asks for one when it has none, or
less than a third of its lifetime is left: `https_certificate` with the name, the CSR and its LAN
address (`C4:GetControllerNetworkAddress`, private IPv4 only). Its key never leaves it.

- `pending` (the order runs; the result comes to the newest request's id, tens of seconds later)
  waits up to 15 minutes; any other first answer within a minute. A request whose connection ended
  is asked again on the next connection: the relay answers it from what it kept, never a second
  order.
- `issued`: the controller keeps the certificate only when its public key is the controller's own,
  its DNS names cover the name, it is valid now and an issuer comes with it (an `issued` answer is
  taken whichever request id it carries: the certificate itself says whether it is the controller's).
  Then the TLS server starts with it, the old one destroyed by its port first; when the new one
  cannot start a server, the old one serves again while it is valid (asked again after the backoff).
- A refusal (`ok` false) or no answer: asked again after 5 minutes, 15, an hour, 6 hours, then once a
  day, or after `retry_s` when it is longer (at most a week). `NAME_MISMATCH` gives the home's own
  name (`name`): the controller takes it, with a new key, and asks at once; `NAME_TAKEN`: a new name,
  at once; `INVALID_CSR`: a new key, after the wait. At most three new names or keys a start.
- Every 10 minutes it looks at the certificate's age and its address. After each `relay_features`,
  and when its address changed, it sends `https` with its address (unless it is asking for a
  certificate, which carries it). A certificate that expired is forgotten and the TLS server stops.
- Turned off (the owner, or Composer back to Off): the TLS server stops, the certificate is
  forgotten, and `https` with `name` null asks for the A record's deletion, at once or at the next
  connection; the controller keeps asking (the store remembers it over a restart) until it is
  answered `ok`. Reset Remote Identity sends it on the old connection and forgets the name.

**The relay** (`cloud/src/https.js`, `acme.js`, `x509.js`, the home's Durable Object):

| Code | When |
| --- | --- |
| `HTTPS_UNAVAILABLE` | the Worker has no `DLHOME_DNS_TOKEN`, `ACME_ACCOUNT_KEY` or `DLHOME_ZONE_ID`: nothing else is done |
| `INVALID_REQUEST` | no `id`, a name that is not `^[a-z2-7]{20}\.dlhome\.cc$`, a CSR that is not text of at most 8,192 characters |
| `ADDRESS_NEEDED` | `ip` is not a private IPv4 address (10/8, 172.16/12, 192.168/16) |
| `INVALID_CSR` | not one PEM certificate request; it names anything but exactly the name (its CN and DNS names together; any other kind of name); its key is not P-256 or RSA of 2048 bits or more. Also when Let's Encrypt refuses it (`badCSR`) |
| `NOT_CLAIMED` | no account has claimed the home |
| `NAME_MISMATCH` | the home's name is another one, given in `name` |
| `NAME_TAKEN` | another home has this name |
| `RATE_LIMITED` | the home's 3 new orders a day or 5 a week (`retry_s` until one is older), 45 new names a week in all (`retry_s` 6 hours), or Let's Encrypt's own limit (its Retry-After) |
| `ACME_FAILED` | Let's Encrypt refused or failed: the challenge was not seen, the order was invalid, a step failed five times, or the order took longer than 10 minutes |
| `DNS_FAILED` | Cloudflare's API refused or failed five times |
| `INTERNAL` | anything else |

- **One name a home.** The first request the relay accepts for a claimed home binds its name to the
  home in D1 (`https_names`): names are public in Certificate Transparency logs, so no other home may
  ask for one. The object keeps a copy.
- **The order** runs in steps from the object's alarm, which it shares with the alerts
  (`alarms.js`): a new order (the ACME account is registered with `ACME_ACCOUNT_KEY` at its first use,
  and its URL kept), the dns-01 challenge's TXT record `_acme-challenge.<name>` (TTL 60), 20 s, the
  challenge answered, its authorization polled, the finalize with the controller's CSR, the order
  polled, the certificate downloaded. Then the TXT record goes, the certificate is kept (its text,
  chain, dates, issuer and its key's SHA-256), the A record `<name>` → the address is written (DNS
  only, TTL 3600), and the driver is sent `https_certificate_result` if it is connected (otherwise it
  asks again and is answered from what is kept). A step that fails for a moment (the network, a 5xx,
  a bad nonce, Cloudflare's 429) is tried again after 5 s, 15 s, 30 s and 60 s.
- **The address.** `https` writes the A record only while the home has a certificate that has not
  expired, and only when the address differs from what it last wrote, so a connection costs no call
  to Cloudflare. `name` null deletes the name's A and TXT records and the order in progress.
- **Logs:** `https_certificate_requested` (`renewal`), `https_certificate_issued` (`name`,
  `not_after`), `https_certificate_failed` (`code`, the step and why), `https_dns_updated`,
  `https_dns_deleted`, `https_refused` (`code`), `https_step_retried`; never a key, a CSR, a
  certificate's text or an address.

## What a relayed request may do

- A sealed request runs as the device's own API key, with that key's permissions (since 1.8.0 its
  person's, ADR-054; before, its role: viewer, member, doors, admin) and the Composer Door Control
  and Relay Hold switches, exactly as on the home network.
- The driver logs it like a LAN request, with `client` = `relay` and the key id.
- Claim tokens (`POST /v1/remote/claim`) are given out only on the home network, to admin keys,
  and pairing (`POST /v1/auth/pair`) works only there too (`PAIRING_ONLY_ON_HOME_NETWORK`).
- Only the controller registers invitations for its home; the account service's own endpoint for
  it is kept for the home's owner, for drivers before 1.0.0 (`OWNER_ONLY` for other members).
- A scene link's run (`link`, 1.7.0) is no API request: it runs only the scene the link was made
  for, as DirectorLink itself (before 1.8.0: as a member's key), never one that opens doors or gates, and goes into the history as run by
  that link (ADR-051). The driver logs it with the link's id, never its secret.

## Test endpoints

Version 0's `GET /test/homes/{home_id}/status` and `GET /test/homes/{home_id}/v1/...` exist only
while the Worker has a `TEST_TOKEN` secret; production has none, so they answer
`503 TEST_TOKEN_NOT_SET`. Drivers from 0.10.0 refuse the relayed plain request in any case.

- `GET /health` → `{"status":"ok"}` (no token).
