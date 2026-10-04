# Backup and restore

**Status: built in DirectorLink 1.4.0 (ADR-042); automatic backups to the account and the Sonos
room choices in 1.6.0 (ADR-048).**

Updating the driver keeps everything DirectorLink knows. Removing the driver from the project (by
accident), replacing the controller or rebuilding the project loses it all: Control4 deletes a
removed driver's data. A backup brings it back. Admins make one in the app (Settings → Controller →
Backup) and restore it there; the file is locked with a password in the browser, and the controller
never sees the password or the file. From 1.6.0 the controller can also back up to the home's
account every night, locked with a backup password only the family knows
([Automatic backups to your account](#automatic-backups-to-your-account)). The app shows Backup only when the controller's DirectorLink
says it has it (`GET /v1/system`: `features.backup`, 1.4.0 and newer); a request answered `404`
says to update DirectorLink.

## What a backup holds

| Kept by the driver | In a backup | When restored |
| --- | --- | --- |
| Keys (`directorlink_api_key_hashes`) | Each key as stored: its hash and lock key, name, role, profile, when it was made and when it expires. Never a key itself. | Only in the reinstall case (below): then as they were, so every device keeps working without pairing again. Otherwise every key stays as it is now. |
| Profiles | Each person's language, theme, palette, favorites and hidden rooms. | As they were, favorites and hidden rooms matched to the project. With the keys kept, only the profiles today's keys use. |
| Room names, the room order | Every room's names in every language, and the home's order. | Matched to the project. |
| Scenes | Every scene with its steps, ids and versions. | Steps matched to the project. |
| Schedules | Every schedule's definition. Not what it ran. | They start as if saved at the restore (below). A schedule whose scene is not in the backup stays out. |
| The calendar's settings | Candle lighting and havdalah minutes, Israel or abroad. | As they were. |
| The remote identity | The home id, its secret and the replacements waiting for the owner's approval, only once the relay has accepted it (`linked`). | By the rules below. |
| The Sonos room choices (1.6.0) | Each Sonos player an admin put in a room: the room and the player's name. | Matched to the project, as a scene's room. A backup made before 1.6.0 has none: the choices on the controller stay as they are. |

Not in a backup: pending invitations (revoked by a restore; see ADR-042 for why), the activity
history (it stays on the controller, and a restore adds to it; ADR-046), what the schedules ran, the request ids kept against replays, the random pool, the weather, the last automation shown
in Composer, the pairing and start counters, the log and a claim token (both only in memory). A
remote identity the relay never accepted (Remote Access never on, or never connected) is not in a
backup either, and none is made for one: restored, it would replace a home that is linked now.

**DirectorLink's Composer properties** are listed, never restored: Door Control, Relay Hold,
Schedules, Jewish Calendar, Alarm Status, Remote Access and Log Level. The restore screen shows how
each was set when the backup was made and how it is now, so the installer can set them again in
Composer. A file must never switch a safety setting on.

## The file

`DirectorLink backup <home> <date>.dlbackup`, made by the app (`app/js/backup.js`):

```json
{"format": "directorlink-backup-file", "version": 1, "header": "{...}", "data": "<base64>"}
```

- `header` is a JSON text: `version` (the file's, 1), `cipher` (`AES-256-GCM`), `kdf`
  (`PBKDF2-SHA-256`), `iterations` (600000), `salt` (16 random bytes), `iv` (12 random bytes), and
  the home's name, when the backup was made and by which DirectorLink, so the restore screen can say
  whose backup it is before the password is typed.
- `data` is the document (below) as JSON, encrypted with AES-256-GCM under the key PBKDF2-SHA-256
  makes from the password and the salt, with the header's exact text as additional data: a file
  whose header or data was changed does not open. WebCrypto does all of it. Only version 1 opens,
  outside and inside the header; a later one says to reload the app.
- The password is typed twice, at least 10 characters, with a short strength hint: common
  passwords, one word with digits or symbols (`Shalom2024!`), sequences (`abcd`, `4321`), keyboard
  rows (`qwerty`) and repeats are weak. Without it the file cannot be opened, by anyone,
  DirectorLink included.
- The password never leaves the browser, and is never written into the page's HTML; the opened
  document goes only to this controller, in sealed requests.
- A file over 4 MB is not read (a real one is under 3 MB).

## The document

`GET /v1/backup` (admins, sealed requests only) answers:

```json
{
  "format": "directorlink-backup",
  "format_version": 1,
  "driver_version": "1.4.0",
  "created_at": "2026-10-01T09:30:00Z",
  "home": { "name": "Home" },
  "controller_id": "3f2a…",
  "composer": { "Door Control": "Enabled", "Relay Hold": "Not allowed", "...": "..." },
  "references": {
    "rooms": { "10": { "name": "Kitchen" } },
    "devices": { "20": { "name": "Kitchen Island", "kind": "light", "room_id": 10 } }
  },
  "sections": {
    "keys": { "version": 4, "keys": [] },
    "profiles": { "version": 1, "profiles": [] },
    "room_names": { "version": 1, "rooms": {} },
    "room_order": { "version": 1, "order": [] },
    "scenes": { "version": 1, "scenes": [] },
    "schedules": { "version": 1, "schedules": [] },
    "calendar": { "version": 1, "settings": {} },
    "remote_identity": { "version": 1, "linked": true, "home_id": "…", "home_secret": "…" },
    "sonos_rooms": { "version": 1, "rooms": { "RINCON_…": { "room_id": 10, "name": "Kitchen" } } },
    "scene_links": { "version": 1, "links": [{ "id": "…", "scene_id": "…", "alg": "sha256", "hash": "…", "home": "…", "by": "…" }] }
  }
}
```

Each section is its store as the driver keeps it, with the store's version. `references` names the
rooms and devices the sections refer to by id, as the project named them when the backup was made.
The home's name is its site in Composer's project tree. `controller_id` is a hash of the
controller's MAC address (`C4:GetUniqueMAC`), the same after the driver is added again and another
on a replacement; null when Director does not give it. Without a linked identity,
`remote_identity` is `{"version": 1, "linked": false}`. `sonos_rooms` (1.6.0) may be missing: a
backup made before 1.6.0 has none, and restores as it did.

`scene_links` (1.7.0, ADR-051) holds each scene link as the controller keeps it: a hash of its
secret, never the secret, the home id its address names and the key that made it (`by`). The links
follow the keys: the backup's come back only when its keys do (`keys.action` `restore`: only the
restoring device is paired, after a reinstall or on a replacement; from a backup made before 1.7.0,
the links this controller has); otherwise this controller's links stay as they are, so a link
removed or replaced since the backup was made never comes back. Either way only the links whose
scene comes back without doors or gates, that name the home identity in use after the restore (the
backup's, when it moves here; else this controller's), and whose key is among the keys after it (one
that `replaces_key` names passes its links to the restoring device's key). So the family's NFC tags
and Shortcuts keep working after a replaced controller is restored with its identity. The preview
counts them (`counts.scene_links`).

It holds every key's lock key and the home secret: whoever has the document can reach the home
through the account, sealed, as any of its devices. That is why it goes only in sealed requests
(`403 SEALED_REQUEST_REQUIRED` otherwise, like `GET /v1/alarm`) and is saved only encrypted.

## Restoring

1. The app opens the file with its password.
2. It sends the document back in parts (`POST /v1/restore/parts`), each small enough for a sealed
   request at home (64 KiB of HTTP body) and through the account.
3. `POST /v1/restore {"upload": …}` checks it: nothing changes, and the answer says what a restore
   would do (`dry_run` is true unless it is false).
4. The app shows it: first, when the backup looks like another home's, a warning that names it and
   says why; the date and DirectorLink version, how many of each there are, the keys that come back
   by name and role (or that the keys stay as they are now), what was found by name, what matches
   nothing (and where it was used), remote access, the Composer properties. **Replace everything**,
   confirmed with the home's name, sends `{"upload": …, "dry_run": false}`, with `replaces_key` and
   `move_remote` when chosen (below).
5. The result says what was done; the app reads everything again.

The controller checks the whole document first: that it is a DirectorLink backup, that it has every
section in the right shape, that the remote identity is one the relay accepts, and that neither
DirectorLink nor a store's version is newer than this one (`409 BACKUP_TOO_NEW`: update DirectorLink
first). Older backups are read as an update reads their stores (a key store before version 4: the
console's keys expire in a day). If Director could not read one of DirectorLink's stores when it
started, the restore is refused (`503 UNAVAILABLE`, naming it): it would overwrite what that store
still holds; restart the driver and try again. Then it writes every store, or none: when one cannot
be saved, the ones written so far get their values from before, and the answer is
`500 RESTORE_FAILED` (the upload stays, to try again). Names are cut to what the API takes (64
characters, 10 languages a room) and preferences it would refuse are left out.

### Keys

- **The reinstall case:** no key is paired but the restoring device's, and that one was paired after
  the backup was made (the driver was removed and added again, or the controller replaced). The
  backup's keys come back, so every device with its key works without pairing again; the preview
  lists them by name and role.
- **Otherwise every key stays exactly as it is now**, and the preview says "Keys: kept as they are
  now". A key revoked since the backup was made (a lost phone), or an admin made a member since,
  never comes back. To bring the backup's keys back after a reinstall, restore from the first device
  paired, before anyone else pairs or is invited.
- **"This device is …"** (reinstall case only; none by default): the restoring device always pairs
  anew, so its owner's old key is in the backup on no device. Picking it gives this device's key
  that key's profile (favorites, theme, hidden rooms) and role, and that key is not restored: no
  admin key is left that nobody holds. A choice that would leave no admin is refused
  (`409 LAST_ADMIN`).
- The restoring device's key keeps working as it is now: its role (unless it takes an old key's
  place), and its profile with it. If the backup has another key with the same id (8 random hex
  digits), that one stays out. If the backup already has 20 keys, the restoring one comes on top: new
  devices can pair once some are removed.
- A backup's key record is checked as DirectorLink makes keys (an id of 8 hex digits, a role, a hash
  of the right length, a lock key of 64 hex digits or none, a hash no other key has); one that is
  not right stays out and is counted. Keys whose expiry has passed, or with more than 30 days and an
  hour left (made while a clock ran ahead, ADR-040), stay out.

### Rooms and devices

Scene steps, favorites, hidden rooms, room names, the room order and the Sonos room choices refer to
Control4 ids. For each:

1. The same id, still a room, or a device of the same kind (a lights step needs a light), with the
   same name: kept.
2. Otherwise the one other room of the backup's name, or the one other device of the same kind and
   name in the same room: its id (`by_name`). This is how ids that were swapped when the project was
   rebuilt are put right.
3. Otherwise the same id with another name: kept, and the preview says so (`renamed`).
4. Otherwise it is left out and listed (`unmatched`), with the scenes and people's favorites that
   used it. A step with no device left, or whose room matches nothing, is left out: a step without
   its room would act on every room of the home. A step's room that is only where its devices were
   picked is dropped quietly when it is gone; the step keeps its devices.

**Doors and gates are never moved.** A relay or a doorbell (a step that opens doors, a relays step
for a whole room, a favorite) is kept only on the same id with the same name. Otherwise it is left
out and listed with what that id is called now: a gate's morning scene must not pulse the main
door.

### Schedules

What the schedules ran stays with the controller that ran them. After a restore every schedule starts
as if saved then: nothing that was due before runs, and nothing is caught up; a weather rule waits
until the weather has turned (it was probably run already where the backup was made).

### Another home's backup

The preview says the backup looks like another home's when:

- both the backup and this controller have a remote identity the relay accepted, and they are
  different homes; or, when there is no such pair to compare, the backup was made on another
  controller;
- or the backup's home has another name than this project's;
- or most of the rooms and devices it refers to are not in this project.

Then the app warns first, naming that home and why; Replace everything asks a confirmation that
names it; and its remote identity stays out unless the admin ticks **Move remote access to this
controller** (off by default). Restore only this home's own backups. When the controller was replaced
or the home linked again after the accident, the backup is this home's even though it looks like
another's: tick the box once the old controller is off or reset.

### Remote access

- The backup holds no identity (it was never linked): the controller's own stays as it is.
- The backup's home is the controller's: the identity in use stays (its secret may be newer than
  the backup's). The relay connection stays, and learns the key ids: people whose keys are not on
  the controller leave the home in the account.
- Otherwise (and for another home's backup only when asked): the backup's identity is used, and the
  one in use now is kept as `previous`. Two seconds after the answer (which goes out on the
  connection there is), the controller connects with the backup's identity. The home in the account
  comes back with its people, whose keys the backup has; the home the controller used until then
  goes offline in the account. If the relay refuses the backup's identity (its secret was replaced
  after the backup was made; it tries the waiting replacements first; or the relay does not take
  it), the controller's own comes back, it connects with that, and the log and Remote Status say so.
  Then the family's restored keys belong to the backup's home, which the controller no longer
  answers as: they reach it only at home until they are invited again. With Remote Access off, this
  happens when it is turned on.
- **Two controllers must not run with one identity.** When the identity moves here from a backup
  made on another controller (or one that cannot be told), the preview warns: turn Remote Access off
  on the controller the backup was made on, or remove DirectorLink from it, before restoring. The
  relay lets one connection carry a home, so two controllers would push each other off about every
  30 seconds, and the family would reach one or the other.
- A device linked to the other home through the account: the app points it at the backup's home.
- Pending invitations and a claim token made before the restore are revoked.

## Automatic backups to your account

From 1.6.0 (ADR-048) the controller can send a backup to the home's account every night, so that a
controller that died, or a driver removed by accident, can be brought back without a file anyone
remembered to download. Nobody but the family can open them: not DirectorLink's servers, which keep
them, and not the controller, which makes them.

### The backup password

An admin sets it once in the app (Settings → Controller → Backup → **Automatic backups to your
account**), signed in to the account, with the home linked to it. It is typed twice, at least 10
characters, with the same strength hint as a file's, and the app says plainly that without it the
backups cannot be opened, by anyone, DirectorLink included.

The browser makes an X25519 key pair from it: PBKDF2-SHA-256 with 600,000 iterations and a random
16-byte salt gives the private key's 32 bytes. Only the public key, the salt and the iterations go
to the controller (`PUT /v1/backup/automatic`, admins, sealed requests only, so that nobody on the
network can put their own key in its place). The password and the private key never leave the
browser. **Change backup password** sends a new key: backups made before keep the old password, and
the list in the app marks them "earlier password". **Turn off** forgets the key; the backups in the
account stay until an admin deletes them there (**Delete these backups**).

### Every night

At the home's own minute between 03:00 and 04:59 (the controller's time, picked at random once;
`GET /v1/backup/automatic` gives it as `time`), and when an admin taps **Back up now**
(`POST /v1/backup/automatic/run`, answered `202`), the controller makes the same document as
`GET /v1/backup` and seals it to the public key:

1. a key pair used once (the ephemeral key, 32 random bytes) and the X25519 shared value with the
   backup password's public key;
2. a lock key `HMAC-SHA256(shared, "DirectorLink cloud backup v1|" + epk + "|" + public key)` (both
   keys in base64), and from it, as in the end-to-end lock (docs/ACCOUNTS.md), an `enc` and a `mac`
   key;
3. AES-256-CBC with a random IV, then an HMAC-SHA256 over the label, the key's id, the salt, the
   iterations, the ephemeral key, the IV and the ciphertext (encrypt-then-MAC).

```json
{"format": "directorlink-cloud-backup", "version": 1, "cipher": "X25519-AES-256-CBC-HMAC-SHA256",
 "kdf": "PBKDF2-SHA-256", "iterations": 600000, "salt": "…", "key_id": "ca1a0c76b8987230",
 "epk": "…", "iv": "…", "ct": "…", "mac": "…"}
```

`key_id` is the public key's first 8 bytes in hex. C4:HMAC and C4:Encrypt do the encryption, as for
every sealed request; the two scalar multiplications are plain Lua (`src/core/x25519.lua`), 64 of
their 255 steps at a time, each slice and each one's final inversion in a timer tick of its own (11
steps in all), as are the document, its JSON and each chunk: nothing holds Director's Lua thread
long. On a PC a big home's backup (130 KB of JSON, 175 KB sealed, 3 chunks) takes 16 ms for the
document, 10 ms for its JSON, some 70 ms of Lua for the seal in steps of at most about 15 ms (two
scalar multiplications of 29 ms each, and their inversions), and 2 to 5 ms to frame each chunk; the
controller's AES and HMAC run natively. The CORE-1's Cortex-A53 is some 5 to 10 times slower: about
0.35 to 0.7 s of seal in all, no step much over 0.15 s. The log line `backup uploaded` gives the
real `seal_ms` and `total_ms`.

The ephemeral key is forgotten as soon as the backup is sealed: the controller cannot open its own
backups. The sealed text goes to the account over the relay connection in chunks of 60,000
characters (`backup_chunk`, docs/RELAY.md), each sent once the one before is answered. Only while
Remote Access is on, the relay has accepted the home's identity and the lock passed its self-test;
the account keeps backups only of a home an account has claimed (`NOT_CLAIMED` otherwise). A daily
backup that could not be made for a reason that may pass (the relay offline or not answering within
30 s, the account service's own error, the project not read yet) is tried again every 15 minutes
until 06:00, then that day has none. Any other reason (Remote Access off, the home not in an
account, too large, the account's limits of backups a day or of space, any other refusal of the
account's, a failure on the controller, the password changed) is not tried again that night, since each try seals the backup again: the next night's
goes as usual. Turning automatic backups off or changing the password stops a backup being made,
also between two chunks (`AUTOMATIC_BACKUP_OFF`, `KEY_CHANGED`); the account service drops the
unfinished upload. The log says `backup uploaded` (with its size, chunks and times) or `automatic
backup not made` with why (once a night for a daily one that could not start);
`GET /v1/backup/automatic` gives the last one's time, size and outcome. History lists a night whose
backup failed once, with why and whether it is tried again, and a backup made later that night
(docs/HISTORY.md).

### In the account

The account service keeps the ciphertext in chunks (D1, `migrations/0007_cloud_backups.sql`), with
its size, when it came and its `key_id`: nothing about the home. The sealed text is printable ASCII
(JSON around base64), and the account takes nothing else, so its sizes are bytes. One a day per home
(a newer one the same day, UTC, replaces it, and does not count against the others), the last 7, and
at most 5 MB a home in all: above that the oldest go first, and the newest always stays. The homes
of one account's owner hold at most 25 MB together: above that the oldest go first, whichever home
they are of, and each home's newest stays. A single backup is at most 3,000,000 bytes (the largest
backup, 2 MiB of JSON, is about 2.8 MB sealed; a big home's is about 175 KB): the controller knows
the sealed size from the document's JSON, so a larger one is neither sealed nor sent, and the log
says `BACKUP_TOO_LARGE` (download a backup file instead). They go when an admin
deletes them, and with the home when its owner deletes their account; an upload that never finished
goes after an hour.

A home starts at most 4 backups a UTC day (Back up now, a nightly one tried again); the nightly one
goes besides, once a day, so pressing Back up now never costs the night's backup. A fifth start is
refused with `BACKUP_LIMIT`, and one that would not fit in the owner's 25 MB with the newest backup
of each of their other homes with `ACCOUNT_BACKUPS_FULL` (only an owner of many large homes); the
controller logs the code, and `GET /v1/backup/automatic` gives it as the last backup's.

The home's admins list them (date, size, which password), download one and delete them
(`GET /v1/homes/{home_id}/backups`, `GET …/backups/{id}`, `DELETE …/backups`). The account service
does not know roles (they are the controller's keys): a 1.6.0 controller names its admin keys with
its key ids, and the accounts that use one of them pass, the home's owner too only then (an owner
whose keys are all members' or viewers' now is refused, as for alerts). A controller before 1.6.0
names none: then only the home's owner passes, who claimed it at home with an admin key.
`mayUseBackups` in `cloud/src/backups.js` is the one place that decides.

### Restoring one

The app lists the backups of the account's homes it may see (this device's linked home first). An
admin picks one and types its backup password; the browser downloads it, makes the private key
again from the password and the backup's own salt and iterations, checks the MAC (a wrong password,
or a changed backup, opens nothing and sends nothing) and opens it. The document then goes through
the same check, preview and **Replace everything** as a file (above). After a controller was
replaced, pair one device at home, sign in, and restore from the list; the backup's remote identity
moves to the new controller by the rules above (it looks like another home's: tick **Move remote
access to this controller**). Then set the backup password again on it: the new controller has no
key until an admin sets one.

## Limits

- A backup is at most 2 MiB of JSON (a home at DirectorLink's limits: 50 scenes of 40 steps with 100
  devices each, 50 schedules, 100 profiles), in at most 100 parts of 48 KiB. A big home (111 lights,
  50 scenes of 15 steps, 50 schedules, 20 keys, 40 rooms named) is about 130 KB, and the driver
  makes it or restores it in some 0.1 s on a PC (the CORE-1 is about ten times slower).
- One upload at a time for each key, three in all (a fourth replaces the one used longest ago). An
  upload is dropped 10 minutes after its last use, by a timer, so a backup checked and then left does
  not stay in the controller's memory.
- Through the account the backup goes as one relay message: download it at home if the account
  refuses it. The app waits a minute for it; the relay itself waits for the home's answer as long as
  it is set to (15 s by default).
- A device that opened the app while the controller's data was gone was told its key is unknown and
  forgot it: that device pairs again. Restore before the family opens the app.
- The restore needs the project read (`503 PROJECT_NOT_READY` until DirectorLink has read it).

## Tests

`driver/tests/test_backup.lua` (round trip into fresh storage, the checks, all or nothing, the
keys kept or restored and "this device is", key records, matching with swaps and doors, schedules,
invitations, uploads per key and their timer, the remote identity and another home's backup, a store
not read at start, names cut, a big home; the Sonos room choices in and out, by name, gone, a backup
from before 1.6.0, all or nothing), `tests/app/backup.test.mjs` (the file, the strength hint,
the parts, the Settings panel, when it shows, and its preview), the contract test
(`scripts/check_contract.py`), and a browser check against the dev server: download, start it again
with fresh storage, pair, restore.

Automatic backups: `tests/vectors/cloud_backup.json` (Node's crypto made it: the key from the
password, each step of the seal), reproduced by `driver/tests/test_auto_backup.lua` (the seal and
its slices; the key set in sealed requests only; Back up now sealed, in chunks one at a time, opened
with the private key; refusals, timeouts, a changed password; the nightly minute, retries, Remote
Access off) and opened by `tests/app/cloud-backup.test.mjs` (the key and the vectors, the ladder
where WebCrypto has no X25519; the section: signing in first, the password set with only its public
key sent, Back up now, the list, a restore through the same preview, change and turn off), and
`tests/cloud/backups.test.mjs` (chunks kept whole, sizes and order, printable ASCII only, a home
nobody claimed, one a day, seven and 5 MB, starts a day, 25 MB an owner, who may list, download and
delete, the owner made a member).
