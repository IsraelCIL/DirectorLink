# Accounts and end-to-end encrypted remote access

**Status: approved on 2026-09-27 (ADR-029); built in DirectorLink 0.10.0 with Google. 1.0.0 seals
the app's requests on the home network too, pairs with a key exchange, and lets the controller
register its own invitations (ADR-032). 1.3.0 switches Sign in with Apple on, lets the home's owner
approve an invitation accepted with another email, and follows Apple's notifications about its
accounts (ADR-041); it also pairs with CPace, so the pairing code never crosses the network
(ADR-039), and the API console's own key lasts a day (ADR-040). 1.7.0 lets a new device join by
approval from another device of the same account, and paste an invitation link (ADR-053).** The
driver's side is `driver/src/cloud/` (`lock.lua`, `remote.lua`) and
`driver/src/auth/invitations.lua`, the cloud's `cloud/src/accounts.js` and `cloud/src/homes.js`, the
app's `app/js/lock.js`, `app/js/remote.js` and Settings → Account. The relay protocol is
`docs/RELAY.md`, version 1. Known issues are listed at the end.

## Goals

- Sign in with Google or Apple and use the home from anywhere, including from iPhones and iPads.
- **The cloud can route, but not read.** Everything between the app and the controller is locked
  with keys that only the app and the controller hold. DirectorLink's servers, and Cloudflare
  beneath them, see that a device talked to a home, when, and how much. They never see what.
- The owner proves control of the home once, on the home network. Everyone else joins by
  invitation, without Composer and without the home network: family, and the owner's own other
  devices.
- Roles stay those of API keys (`viewer`, `member`, `doors`, `admin`), enforced by the controller.
- Using the app on the home network without an account keeps working.

Not part of this design: local HTTPS, native apps, billing. Alerts (1.6.0, ADR-047; sealed to each
device's key since 1.7.0, ADR-050) are in *6. Alerts* below.

## Who knows what

| | App (your device) | Cloud (`api.directorlink.io`) | Controller |
| --- | --- | --- | --- |
| Account: email, name, sign-in provider | yes | yes | no |
| Which homes the account belongs to | yes | yes | — |
| Which key ids are admin keys (1.6.0) | its own role | yes (ids only) | yes |
| Alerts: this browser's push subscription | its own | its push address and keys, for those who switched alerts on; since 1.7.0 also the key id its device uses, and whether it wants the offline alert | that this key's device switched them on, and its choices (1.7.0) |
| Alerts: the home was offline (the cloud's own) | its kind, home id and time | its kind, home id and time | — |
| Alerts the controller makes (1.7.0): a doorbell rang, a door opened and by whom, the refrigerator, a schedule | what happened and where, opened with its own alert key | **never** what or which: only which key ids one is for, when, and whether it is brief, all the same size; that tells some kinds (*Metadata* below): a brief one is a ring, one that is not brief for a key that is not an admin key is the refrigerator | yes |
| A device's alert key (1.7.0) | its own, kept for its service worker | **never** | derived from that device's lock key |
| API key and lock key | its own | **never** | lock keys of the home's devices; API keys only as hashes |
| Devices, rooms, states, commands, pictures | yes | **never** (locked) | yes |
| Automatic backups (1.6.0) | opened with the backup password | sealed: their date, size and which password's key; **never** what they hold | makes them; cannot open them |
| The backup password | while typed | **never** | **never** (only its public key) |
| DirectorLink in numbers (1.7.0): homes linked, people with an account, driver downloads | the totals, like anyone | counts them once an hour; publishes the totals only (ADR-052) | sends nothing for them |
| Joining from another device (1.7.0): the new device's label ("Safari on iPhone"), both devices' public keys | yes | yes, while the request lasts (10 minutes; deleted within a day) | no |
| Joining from another device (1.7.0): the invitation sent to the new device | yes (the two devices) | sealed: **never** what it holds | made it; sees an ordinary for-me invitation |
| Scene links (1.7.0): a link's id and secret | shown once, when an admin makes it; then only on the phones and tags it was given to | **its id and secret in transit, each time a phone uses it**, with the home, when, and whether it ran, partly ran, failed or found nothing to run; it keeps no secret, and logs each run (the home, the link's id, the status, the result word, how long) in Workers Logs for some days; which scene it runs, **never** | the link's id, a hash of its secret, its scene and the key that made it; every run in History |
| When, and how much data, flows | yes | yes | yes |

A stolen or hacked cloud database gives an attacker email addresses and which account belongs to
which home (and, with alerts, the push addresses of the browsers that switched them on: admins'
before 1.7.0, any role's since). It cannot open a door, read a light's state or show a picture, and
the backups it holds open only with their backup password, which only the family knows.

**Scene links (1.7.0, ADR-051) are the one thing that is not sealed.** A phone's automation (iPhone
Shortcuts, an Android app, an NFC tag) cannot seal a request, so it sends a link's secret in the
clear to the account service, over HTTPS, which passes it to the home. So: whoever holds a link can
run that one scene, from anywhere, until an admin removes or replaces it or the key that made it is
revoked; and the account service sees the link and its secret in transit each time it is used (not
which scene: it has no names). It keeps no secret (no table, never in its logs: the secret is in the
request's body, not its address), but it logs each run: the home, the link's id, the status, the
result word and how long it took, in Workers Logs, which Cloudflare keeps for some days (3 on
Workers Free, 7 on Paid), beside its own line for the request with the phone's IP address. Someone
who could read the account service's traffic could run the linked scenes they saw; a scene that
opens doors or gates can never have a link, so that is at most lights, AC, fans, blinds, music and
refrigerator settings. Everything else stays sealed. Homes without links are as before.

## Keys

Every device already has its own API key `S` (`ak_…`), from pairing or from an invitation. The
**lock key** for remote use is derived from it:

```
K     = HMAC-SHA256(S, "DirectorLink e2e v1")
K_enc = HMAC-SHA256(K, "enc")        K_mac = HMAC-SHA256(K, "mac")
```

- The app keeps `S`, as today, and holds `K` as a non-extractable WebCrypto key.
- The controller keeps `S` only as a hash (ADR-028). It therefore stores `K` alongside each key
  when it creates that key, and for older keys the first time they are used on the home network.
  Both are in Director's plain persistence, which survives driver updates (`src/core/store.lua`).
- Revoking an API key revokes its remote access too. There is no second secret to lose, rotate or
  copy between devices.

## The lock

Every remote request and every answer travels as one envelope:

```json
{"v": 1, "home": "<home_id>", "key": "<key id>", "iv": "<base64, 16 bytes>", "ct": "<base64>", "mac": "<base64>"}
```

- `ct` = AES-256-CBC(`K_enc`, `iv`, plaintext); `mac` = HMAC-SHA256(`K_mac`,
  `"v1|" + home + "|" + key + "|" + dir + "|" + iv + "|" + ct`), where `dir` is `req` or `res`.
  The MAC is checked, in constant time, before anything is decrypted (encrypt-then-MAC).
- Request plaintext: `{"id", "ts", "method", "path", "body"}`. Answer plaintext: `{"id", "ts",
  "status", "content_type", "body" | "body_base64"}`. These are the same requests and answers as
  the LAN API.
- The controller accepts a request only within 2 minutes of its own clock, and only once per `id`
  (it remembers ids for 5 minutes), so a captured envelope cannot be replayed. A request sealed
  before the driver started is refused; the ids of requests dated ahead of the controller's clock
  are also saved in persistence until the window has passed, so a restart does not open a replay.
- At every start the driver checks `C4:HMAC` and `C4:Encrypt` against a known vector
  (`tests/vectors/lock.json`, which the app and cloud tests check too). If that fails, remote
  requests, claims and invitations are refused (`LOCK_UNAVAILABLE`) rather than weakened.
- Why not AES-GCM: DriverWorks documents `C4:Encrypt` with AES-256-CBC, and `C4:HMAC`, but no GCM
  tags. CBC with an HMAC over the ciphertext is the standard safe construction, and browsers have
  both in WebCrypto. The driver functions are native, so camera pictures stay fast.
- The cloud sees the home id, the key id, the size and the time of each envelope (and so does the
  home network, at home). The alarm's answer is padded to a size that does not depend on whether
  the home is armed (ADR-038).

## On the home network (1.0.0)

The same lock seals the app's requests at home, so its API key does not cross the home network
either:

- **Sealed requests.** The app reads the controller's clock from `GET /v1/sealed` (public; it does
  not give out the remote-access home id), seals each request with its lock key `K`, exactly as
  for the cloud but naming the home `lan`, and sends it to `POST /v1/sealed`. The controller
  answers sealed. The window, the one-time ids and the roles are those of remote requests; a
  refused envelope gets a problem with its `code` and the controller's `time`, so a device whose
  clock is off can correct for it. An envelope for the relay's home id is refused here and one for
  `lan` through the relay, and a sealed request cannot carry another one. The app keeps its key id
  (not secret) to name its key; for a key paired before 1.0.0 it learns it once with a plain
  `GET /v1/api-keys/current`.
- **Once sealed, never in the clear.** The app remembers that a controller seals as soon as one
  sealed request there works, or its pairing was sealed. From then on it never sends its key to
  that controller: refusals are not signed, so anyone on the network could send them, and a
  `404` on `GET /v1/sealed`, a `BAD_MAC` or a lost answer only mean "not reachable" (a linked
  device then goes through the account). `UNKNOWN_KEY` means the key is gone, as a `401` did.
  Only a device that never sealed with that controller sends its key as before: a controller from
  before 1.0.0, one whose lock failed its self-test (`LOCK_UNAVAILABLE`), or a key whose `K` it
  does not have yet (the plain request stores it). Away from home, the app goes back to the home
  network only after a sealed request there works.
- **Pairing without sending the code (CPace, 1.3.0, ADR-039).** The app and the API console prove
  that they know the pairing code without sending it, with CPace (draft-irtf-cfrg-cpace, cipher
  suite CPACE-X25519-SHA512; `driver/src/auth/cpace_pairing.lua`, `app/js/cpace.js`). The code is
  the password. Two requests to `POST /v1/auth/pair`:
  1. The app sends a random nonce, its name (and, for the console, `expires_in`). The controller
     (CPace's initiator) answers with its nonce and its share `Ya`, made from a generator that
     depends on the code, on the channel `CI = lv_cat("DirectorLink pair v2", name, expires_in)`
     and on `sid` (the app's nonce, then the controller's).
  2. The app sends its share `Yb` and a tag that only a device that knew the code can make
     (the draft's key confirmation: HMAC-SHA512 with a key from the exchange's session key `ISK`).
     Only then does the controller make the key. It answers with its own tag, which tells the app
     it spoke with a controller that knows the code, and the key sealed with
     `HMAC-SHA256(ISK, "DirectorLink pair v2")`, then the usual `K_enc` and `K_mac` from it.

  Someone who listens learns nothing, and someone in the middle cannot test codes offline: each
  guess needs a whole exchange with the controller, which counts it as a wrong code. Changing the
  name or `expires_in` on the way makes the exchange fail. Shares of low order are refused. An
  exchange lasts 60 seconds and works once, from the device that began it.
- **Older controllers get the code only when asked.** DirectorLink before 1.3.0 refuses the field
  `cpace`, and a controller whose lock failed its self-test answers `503 LOCK_UNAVAILABLE`; either
  way nothing about the code has been sent. The app then warns that the code would travel over the
  network unprotected, and says why: DirectorLink should be updated in Composer, or (the lock) there
  is nothing to update and the installer should look at DirectorLink's log. The warning belongs to
  the controller it was about: another address typed or found clears it. Only **Pair anyway** sends
  the code, to that controller, the old way: with the
  app's X25519 public key, the driver answering with its own public key and the new key sealed
  with `HMAC-SHA256(shared secret, "DirectorLink pair v1|" + code + "|" + app key + "|" + driver
  key)`. Someone who only listens cannot read that key, but someone in the middle can take the
  code. Scripts pair by sending the code and get the key in the answer, as before.
- **Pairing is local and slow to guess.** Pairing is refused as a sealed or remote request
  (`PAIRING_ONLY_ON_HOME_NETWORK`). Five wrong codes lock pairing for that device's address for a
  minute, and twenty wrong codes in all close the code, so Composer has to make a new one. A CPace
  attempt counts as a wrong code from its first request until it succeeds, so attempts that are
  begun and never finished run into the same limits.
- **Only DirectorLink's sites, only local names.** Browsers may call the controller only from
  app.directorlink.io and console.directorlink.io; any other origin, `localhost` included, is
  refused. A request whose `Host` is not an IP address or a local name (`director.local`, a name
  without dots, `.lan`, `.home.arpa`, …) is refused with `421 MISDIRECTED_REQUEST`, so a web page
  cannot reach the controller through a DNS name it controls (DNS rebinding).
- Scripts and the API console may keep using `Authorization: Bearer`; the key then travels in the
  clear on the home network, as the README says. So the key the console pairs for itself lasts a
  day (ADR-040): after that the controller answers `401 KEY_EXPIRED`, removes the key, and the
  console asks for a new pairing code. Keys made in its Keys tab for scripts do not expire.

## Flows

### 1. The owner claims the home (once, on the home network)

1. Pair on a computer or an Android phone, on the home network, with the pairing code from
   Composer. The device gets an admin key `S`, sealed for it (see *On the home network*).
2. Sign in with Google or Apple in the app.
3. Over the home network, the app asks the controller for a claim token (admin keys only; works
   once; valid for 5 minutes, and only while the key that asked for it is still an admin key) and
   gives it to the cloud.
4. The cloud asks the controller, over the relay, whether the token is right. The controller
   confirms and forgets the token; the cloud records the account as the home's owner.

From then on this device also works away from home. Another device of the same account links with
its own key and skips the claim. A later claim from the home network, which again needs an admin
key there, moves the home to the new account and removes the previous members and invitations:
whoever controls the controller controls the home (ADR-027). The app asks before doing that.

### 2. Away from home

The app tries the controller on the home network first, because that is faster. If the controller
cannot be reached, and always on iPhone and iPad, the app sends locked envelopes to the cloud with
the account's session. The cloud checks that the account is a member of the home and passes the
envelope to the home's relay connection. The controller unlocks it, runs it as that key (with that
key's role), locks the answer and sends it back.

### 3. Invitations: family, and the owner's own other devices

1. An admin taps **Invite**, picks a role and enters the person's email, or chooses *my other
   device*.
2. The admin's app asks the controller, locally or through the lock, for an invitation. The
   controller creates an invitation id and a random secret `I`, and remembers the role and the
   expiry.
3. The app shows a link and a QR code: `https://app.directorlink.io/#/join/<home_id>.<invitation id>.<I>`.
   Everything after `#` stays in the browser and is never sent to any server; the app takes it out
   of the address as the page opens and keeps it for that tab only. The admin shares it (WhatsApp,
   email, a QR code on screen). The cloud is told only the invitation id, the email and the
   expiry, once: an invitation cannot be moved to another email. Since 1.0.0 the controller tells
   it itself, over its relay connection, before answering the admin (`{"type":"invitation"}`,
   `docs/RELAY.md`); if that fails the invitation is revoked. Only the home can therefore bind an
   invitation to an email: the cloud does not know members' roles, so a viewer cannot. For drivers
   before 1.0.0 the home's owner registers it from the app; other members are refused
   (`OWNER_ONLY`).
4. The invited person opens the link and signs in. The cloud checks their email against the
   invitation; another email needs the owner's approval (*Another email: the owner approves*,
   below). Then it passes on the person's first envelope, which is locked with keys derived from
   `I` (`HMAC-SHA256(I, "DirectorLink invite v1")`).
5. The controller checks the invitation (unused, not expired), creates a new API key with the
   invitation's role and returns it inside the locked answer. The invitation is used up.

A link lasts 7 days and works once (*my other device*: 10 minutes). Whoever intercepts a link
still has to sign in as the invited email, or be approved by the home's owner, who compares a code
with the person they invited. Revoking or demoting an admin's key revokes the
invitations it made, and Composer's **Revoke All API Keys** revokes every invitation and claim token
too. The controller keeps at most 20 invitations waiting (409 `INVITATION_LIMIT_REACHED`); for
drivers before 1.0.0, which the owner registers, the cloud allows 20 waiting per account and home.

### Another email: the owner approves (1.3.0, ADR-041)

Apple's Hide My Email gives DirectorLink an address nobody invited, and people have more than one
account. So when the signed-in account's emails (its own and those of its sign-ins) do not match
the invitation's, the app asks the home's owner instead of stopping:

1. The app sends the join as always, with `ask_owner`. The cloud sends nothing to the home: it
   records a request for that account and invitation (`join_requests`), with a random 6-digit code,
   and answers `202`. The invited person's page shows the code and says to read it out to the owner.
2. The owner's **People and devices** screen lists it under *Asking to join*: the name the account
   gave (nobody checks it), its email or *hidden by Apple*, how it signs in, how old the account is,
   when it asked, and the invitation (its email and expiry from the cloud; its role and who made it
   from the controller, which also says whether it is still waiting there), with the code.
3. The owner approves only when the person they invited reads out the same code, in person or on a
   call. Anyone who got hold of the link could ask too, under any name, and would see another code.
4. The invited person's page asks every 5 seconds (`GET /v1/join/{home_id}/{invitation_id}`). Once
   approved, it seals a new join request with `I`, because the controller accepts a sealed request
   only within 2 minutes, and the cloud passes it on like any other join. A refusal is final for
   that account and invitation; the invitation's expiry ends its requests; the person may withdraw
   a request that is still open.

Only the owner decides: the cloud knows who owns a home, not the members' roles, which only the
controller knows; letting admins approve would need the controller to vouch for them. An admin who
is not the owner can make an invitation for the right address instead.

The approval changes nothing else. `I` never leaves the device (asking needs only the ids); the
controller still checks the envelope with `I` and uses the invitation up (so an approved account
without the secret gets `BAD_MAC` and nothing else); the key still travels sealed, and the cloud
keeps no envelope; the invitation stays bound to its email and works once; membership and the new
key id are written as for any join, only while the invitation is still pending and the approval
still stands, after the home's Durable Object has handled the controller's key messages in order.
Revoking the invitation, or the admin key that made it, still refuses the join. An account the
owner refuses while the home is already making its key never gets that key (the owner sees it in
People and devices and can remove it). An invitation takes at most 5 open requests (waiting or
approved; a refused one still stops its own account) and a home 20 waiting ones on invitations
that can still be accepted; a request goes with its invitation, its account or a change of owner.

### Join from another device (1.7.0, ADR-053)

iOS gives the app added to the Home Screen its own storage (it signs in again there, and has no key)
and opens every link in Safari, so the link of *my other device* never reaches it. Any device signed
in to the account, with no key for one of the account's homes, can instead ask a device it already
uses to let it in, without a link:

1. On the Connect screen, **Join from another device**. The new device makes an X25519 key pair and
   sends the cloud a request for that home with its label (its browser's own description, e.g.
   *Home Screen app on iPhone*) and a **commitment**: the SHA-256 of its public key, not the key.
   The app says to open DirectorLink on a device already in use.
2. A device of the same account that reaches the home with an admin key (the rule of *Add my other
   device*, once the controller has said the key's role) shows the request under the header of every
   screen while the app is open; it looks every 60 seconds, at once when it comes to the front or
   connects, and every 2 seconds while it answers a request. **Show code** sends that device's own
   public key. Only then does the new device send its public key, which the cloud and the other
   device check against the commitment.
3. Both devices work out the same six digits from the request and both public keys. The new device
   shows them; the device already in use asks the person to type them, and approves only when they
   are its own (it never shows them itself, so Approve cannot be tapped without the new device in
   sight). A wrong code approves nothing; the third declines the request. Because the new device's
   key was fixed (committed) before the other key was known, and the other key before the new one
   was shown, nobody passing the keys on (the cloud included) can choose keys that make two
   different conversations have the same code: a key put in the middle gives each its own code.
4. **Approve** makes a for-me invitation at the controller exactly as *Add my other device* does (10
   minutes, the device's role and person, registered by the controller) and seals it to the new
   device's key: X25519, HKDF-SHA-256 bound to the request, the home and both keys, AES-256-GCM.
   The cloud passes the sealed value on, once, and cannot open it. The invitation is revoked at
   home if the cloud refuses Approve; if no answer comes, the device reads the request first and
   keeps the invitation when the cloud took it.
5. The new device opens it and joins with it as with the link (*3. Invitations*, steps 4 and 5). A
   device that got a key another way meanwhile (it paired at home, or opened an invitation's link)
   withdraws its request when it connects, and is asked before a key it has is replaced.

Only the account's own sessions see, answer, approve, collect or decline its requests. Asking needs
an account that could approve (it uses an admin key at the home, as far as the controller names its
admins); answering and approving need an account that uses a key there (`member_keys`). A request
lasts 10 minutes; it goes once collected, declined or withdrawn, when it is read after it expired,
at the daily clean-up, when the account leaves the home, and when it signs out everywhere. An
account has at most 3 requests open and starts at most 10 an hour. Someone holding the account's
session could ask too, under any label: the account's devices would show a request nobody made
("Didn't ask? Decline it and sign out everywhere in Settings → Account."), and approving it would
take the code on the asker's own screen, which the person does not see.

**Paste invitation link** (the Connect screen, and Settings → Account) brings a link that opened
elsewhere into the Home Screen app: it reads the clipboard (iOS shows its Paste button) or, where
that is refused or holds no link, takes it in a field; a whole link, a message with one in it, or
only the part after `#/join/`. The secret still never reaches a server.

### 4. Removing someone, or a lost phone

An admin revokes that device's key: in the app (Settings → **People and devices**),
the API console, or Composer's Revoke All API Keys. It stops working at home and away at once, and
so do the scene links made with it (1.7.0; Revoke All API Keys ends every link).
Signing in to the account alone gives no access, because the keys live only on the devices.
Settings → Account → **Sign out everywhere** also ends every session of the account, on every
device (`POST /auth/logout?everywhere=1`).

The cloud keeps which accounts use which key, by key id only (`member_keys`; a shared device's key
may belong to several): the key an invitation made (the controller's `join_result`), and the key
of each sealed request the home accepted, which only the key's holder can seal. A linked device
sends one sealed request a day even when it only uses the home network, so its key is known too.
The controller sends its list of key ids when it connects and after every change
(`{"type":"keys"}`, `docs/RELAY.md`), never after a start at which its key store could not be read;
an account whose recorded keys are all gone leaves the home, except its owner. The home's Durable
Object handles the list and the recording of keys one after another, in the order the controller
sent them, so an answer that follows a revocation cannot record the revoked key again; the list
itself is applied as one transaction. The owner's **People and devices** screen shows each
account with its devices; removing someone there revokes their keys at home first, then ends the
membership.

### 5. The home network without an account

Pair with a code (CPace: the code is never sent) and use the LAN API; the app seals its requests
there too (*On the home network*). No cloud is involved.

### 6. Alerts (1.6.0, ADR-047; 1.7.0, ADR-050)

Anyone with a key at the home can get notifications on their phones and computers, with the app
closed: a doorbell rang, a door or gate was opened (admins, if they choose), the refrigerator's
door was left open (members and admins), a schedule had a problem (admins), and the home has been
unreachable for 10 minutes (admins). Before 1.7.0 on the controller, only the last two, for admins.

1. On Settings → Controller, someone signed in to an account, on a device linked to the home,
   switches on **Alerts on this device**. The browser asks for permission and makes a push
   subscription with the cloud's public key (VAPID); the app registers it with its device's key id
   (`POST /v1/homes/{home_id}/alerts`) and tells the controller (`PUT /v1/alerts/choices`, sealed).
   A switch per kind follows; the controller keeps them, per key. On iPhone and iPad only the app
   added to the Home Screen can (iOS 16.4 or later).
2. The cloud takes a registration with a key id only from an account that uses that key at the home
   (`member_keys`). One without (an app before 1.7.0) only from an account that uses one of the
   home's admin keys, which the controller lists (`{"type":"keys","ids":[…],"admins":[…]}`,
   `docs/RELAY.md`). The same checks are made for every alert, so a key revoked, or made a member,
   stops what it may no longer get at once.
3. *What the controller alerts about* it decides and seals: for each key whose role may get it,
   whose device switched alerts on and which chose it, the details sealed with that key's alert key
   (`HMAC-SHA256(lock key, "DirectorLink alert v1")`), in one `{"type":"notify"}` that names only the
   key ids (`docs/RELAY.md`). The cloud pushes each part, at once, to the browsers registered with
   that key id by an account that uses it, and to nobody else; it learns which keys and when, never
   what (every detail is padded to one size before it is sealed; *Metadata* below says what the
   keys tell). *Offline*: the home's Durable Object alerts once the driver has been away for 10
   minutes, or silent on a socket that never closed, once per absence, to admin keys' browsers that
   want it and to the admins' browsers registered before 1.7.0.
4. A push is encrypted for each browser (RFC 8291), padded so that every push is the same size. The
   push service (Google, Mozilla, Apple or Microsoft) sees that something went to the browser, when,
   and how long it may keep it (a ring a minute), not what. The app's service worker opens a sealed
   alert with this device's alert key, which the app keeps for it (never the lock key or the API
   key), and shows it with the app's own words in its language ("Front gate rang at 08:00.", "Main
   door was opened by Dana (Dana's iPhone) at 08:01."); the cloud's offline alert, and anything it
   cannot open, in general words ("Your home – …"): the home's name is never sent. Tapping a ring
   opens Home, a refrigerator's alert its room, the others Settings → Controller → History.

Turning the switch off, signing out or forgetting the key on that device, signing out everywhere
(or Apple ending the account's only sign-in), leaving the home or being removed, the key being
revoked, another account claiming the home, and deleting the account all end that browser's
alerts; the home then stops watching for the offline alert once no admin's browser wants it.

### 7. Scene links (1.7.0, ADR-051)

An admin makes a link for a scene (docs/SCENES.md); the controller shows its secret once and keeps
a hash of it. A phone's automation posts the secret to `https://api.directorlink.io/run/<home_id>.<link_id>`
(in the body, never in the address; a browser gets it after `#` and posts it from the page). The
account service checks that an account has claimed the home, lets at most 30 runs a minute reach
it (and none from an address whose runs were refused as unknown 10 times in 10 minutes), and passes
the link's id and secret over the relay (`link`, docs/RELAY.md). The controller checks the hash in
constant time, runs the scene as a member's key would and records the run in History; the phone gets
`ran`, `partly`, `failed` or `nothing`, and an unknown home, link or secret all get the same 404 (but
a claimed home that is offline gets 503, so that the family knows: whoever has the home's id, which
every link and invitation link carries, can tell whether it is online). No account and no session is
involved: the link is the permission. Removing or replacing the link ends it at once; so do revoking
the key that made it (or its expiry), and Composer's Remove All Scene Links, Revoke All API Keys and
Reset Remote Identity. Another account claiming the home does not: its new owner should run Revoke
All API Keys, which ends every link the old family had.

## Google and Apple

Both are OpenID Connect sign-ins run by `api.directorlink.io` (`google.js`, `apple.js`, the shared
ID token checks in `jwt.js`); no provider script runs in the app's pages.

- **Accounts are found by identity, never by email.** Each provider identity (provider and its
  `sub`) is kept in `identities`, and a sign-in with an identity nobody has makes a new account,
  even when an account with that email exists. Google vouches for an address other than Gmail or
  Workspace only as of when the Google account was made, and addresses pass to other people
  (reused mailboxes, re-registered domains); joining by email would hand them the account.
- **Adding the other provider:** while signed in, Settings → Account → *Also sign in with Apple*
  (or Google) runs that provider's sign-in with `link=1`. The app's page navigates to
  `api.directorlink.io` on the same site, so the session comes along and the sign-in remembers
  which account asked; from another site it does not, and nothing is linked. An identity that
  already belongs to another account is refused (`taken`), and an account has one identity per
  provider. The adding needs the session it was asked from to be still signed in when the provider
  answers, so signing out meanwhile (a shared computer) cancels it. The account's email stays that
  of the identity it was created with; an invitation may be accepted with it or with the email of
  any of the account's sign-ins. Settings can remove either sign-in again, never the last one.
- **Separate accounts still work together:** an invitation checks the signed-in account's email,
  so a person who signs in with Apple with the same address as their Google account can accept
  one, as a second account.
- **Only the sign-ins set up are shown:** the app shows a provider's button only when
  `api.directorlink.io` says it is set up (`GET /auth/providers`, and `sign_in_providers` in
  `/v1/me`), so a missing key never shows a button that fails. A device that never signed in asks
  only when someone taps **Sign in** (or opens an invitation link); the buttons then appear, and
  the answer is remembered. Apple's button follows Apple's Human Interface Guidelines: black, or
  white on the dark theme, the Apple logo and *Sign in with Apple* (*Continue with Apple* to add it
  to an account) in the system font, as large as Google's and next to it.
- **Hide My Email:** Apple may give a relay address instead of the person's own, and keeps giving
  it for DirectorLink. An invitation for the real address then waits for the owner's approval
  (*Another email: the owner approves*); adding Apple to a Google account avoids it.
- **Apple's notifications** (`POST /auth/apple/notifications`, registered on the primary App ID):
  Apple posts a JWT signed with the keys of its ID tokens, issued by `https://appleid.apple.com` for
  the primary App ID (`io.directorlink.app`; an ID token, which is for the Services ID, is refused).
  *consent-revoked* (the person stopped using Sign in with Apple for DirectorLink) and
  *account-deleted* (they deleted their Apple Account; older documents say *account-delete*, also
  accepted) remove that Apple sign-in; an account left without any is signed out everywhere. A
  notice never removes a home, its members or its keys. After *consent-revoked* the account stays
  as it was, and the same Apple ID signing in again gets it back (Apple keeps the same id for the
  person, and the account still records it; that Apple ID cannot be added to another account
  meanwhile, `taken`). After *account-deleted* nobody can sign in to it again, so it keeps nothing
  of the person: an account that owns no home is deleted, as *Delete account* does; one that owns a
  home stays so the home and its family keep working, without the person's name and email and
  outside other homes, and the owner takes the home over by claiming it again at home, from a new
  account (which, as for any new owner, removes the old members and invitations). An account
  nobody can sign in to and nobody signed in to for 90 days goes the same way (the daily clean-up).
  *email-disabled* and *email-enabled* (Hide My Email forwarding off or on) only update the stored
  address when Apple gives one. A notice dated before the person last signed in with that Apple ID
  changes nothing (a late or replayed one), and each can arrive twice. Apple's signing keys are
  cached for an hour and read again early, for an unknown key id, at most once a minute; tokens that
  arrive meanwhile share one read, and a read that fails keeps the keys it had. A refused notice is
  logged with the audience it named (an app's public id), to see which one Apple uses.
- **A returning Apple ID without an email** (Apple may leave it out, e.g. after Hide My Email
  forwarding is turned off) is still found by its `sub`; a new account needs a verified email.
- **Apple's form:** Apple posts its answer (`response_mode=form_post`, the only way it sends the name
  and email scopes) from appleid.apple.com, so the 10-minute sign-in cookie for Apple is
  `SameSite=None`; the state, the nonce and the cookie are checked as for Google, and a state only
  works at the callback of the provider it was made for. The name comes only in that first form and
  is not signed: it is only a display name.
- **Apple's client secret** is a JWT (ES256) the Worker signs for each sign-in with the Sign in with
  Apple key, valid for 5 minutes.

## Cloud storage

Cloudflare D1 (SQLite), next to the relay's Durable Objects:

- `users`: id, the provider and subject it began with, email, name, created (`migrations/0001`).
- `identities`: provider, subject, account, email (`migrations/0003`).
- `sessions`, `sign_ins`: hashes of session tokens; sign-ins in progress.
- `homes`: home id, owner, claimed (`migrations/0002`).
- `members`: home, user, added.
- `member_keys`: home, key id, the account that uses it (`migrations/0004`).
- `invitations`: home, invitation id, email, expiry, created by. A used invitation is removed when
  it is accepted; an expired one a day after its expiry (daily cron). When its email's account, its
  creator or the home's owner goes, a pending invitation keeps only its id until then, so that it
  cannot be registered again for another email.
- `join_requests`: home, invitation id, the account asking, its code, pending, approved or refused,
  when (`migrations/0005`). They go with their invitation, their account or a change of owner.
- `device_requests` (1.7.0, ADR-053, `migrations/0009`): a new device's request to join a home of
  its account, usable for 10 minutes: its label, the commitment and its public key, the approving
  device's public key, the invitation sealed to it (which the cloud cannot open), when. They go
  once collected or declined, when read after they expired or at the daily clean-up, with the
  membership, and when the account signs out everywhere. `device_request_starts` counts each
  account's requests of the hour.
- `backups`, `backup_chunks` (1.6.0, ADR-048, `migrations/0007`): each home's automatic backups as
  the controller sealed them to the backup password's public key: the ciphertext in chunks, its
  size, when it came, and which password's key (the public key's first 8 bytes). Not the home's
  name, nor anything it holds: the cloud cannot open them. One a day (the newest), the last 7, at
  most 5 MB a home and 25 MB an owner's homes; they go with the home (its owner's account deleted),
  when an admin deletes them, and an upload that never finished after an hour (daily cron).
- `push_subscriptions` (1.6.0): home, the browser's push address, its public key and secret, the
  account that registered it, when (`migrations/0006`); since 1.7.0 the key id its device uses at
  the home and whether it wants the offline alert (`migrations/0008`). They go with the membership,
  the account, the key, signing out everywhere (also Apple ending the account's only sign-in), or
  the push service saying the browser is gone. The home's Durable Object keeps the admin key ids
  the controller last listed, and when it last notified (60 an hour at most).
- `stats` (1.7.0, ADR-052, `migrations/0010`): three totals and when each was last counted (below).
- No device data, no keys and no message contents. The hash of each home's connection secret is
  in the relay's Durable Object storage.

After sign-in the cloud sets a `Secure`, `HttpOnly`, `SameSite=Strict` cookie for
`api.directorlink.io`. The page's scripts cannot read it. It lasts 30 days and can be ended from the
app, on this device or on every device. Expired sessions and unfinished sign-ins are deleted every
day. Deleting the account deletes its sessions, memberships, owned homes, invitations and requests
to join.

### What is public: DirectorLink in numbers (1.7.0, ADR-052)

Once an hour the cloud counts three totals, and anyone may read them at
`GET https://api.directorlink.io/v1/stats` (no cookie; the website shows them from 25 homes):

- **homes**: homes linked to an account (claimed, their owner's account still there); a home stays
  counted until its owner's account is deleted, also once it is no longer used (a reset identity, a
  replaced or test controller): the cloud keeps no time a home was last seen;
- **people**: accounts someone can sign in to (deleted accounts are gone; one Apple's notices left
  without a sign-in is not counted);
- **downloads**: how often `DirectorLink.c4z` was downloaded, all GitHub releases together, from
  GitHub's public releases list.

Totals only, with when the oldest of them was counted: nothing about any one home or account, and
nothing new from the homes (no device counts, no versions). As they change at most once an hour,
nobody can watch a home or an account appear; with few homes, a total that changed between two hours
says only that some home was linked or left, or some account was made or deleted, in that hour.
The website asks for them from the visitor's browser, without cookies.

## Relay protocol, version 1

In `docs/RELAY.md`: `e2e`, `join` and `claim` from the relay, answered with `e2e`, `join_result` and
`claim_result`; `invitation` (answered `invitation_result`) and `invitation_cancel` from the
controller (1.0.0); `backup_chunk` (answered `backup_result`) from the controller (1.6.0). Version 0's plain requests are refused (410
`RELAY_REQUESTS_RETIRED`) and its test endpoints are off in production. Roles come from the
device's key.

## What the lock does not protect

- **The app's code.** The app is a web page served from app.directorlink.io. Whoever controls that
  site could ship code that reads keys in the browser. The code is open source and deployed only
  from this repository by CI (`deploy.yml`). A native app would remove this trust, later.
- **The controller's storage.** The lock keys `K` and the home secret are stored on the
  controller. Whoever can read its storage (root access, possibly a project backup) could act as
  those devices, remotely and with sealed requests at home. With the home secret as well, they
  could also connect to the relay as the home itself, read the apps' remote requests and send
  back false answers (a door's state, a camera picture). The API keys `S` themselves are only
  hashes there. After such a copy is lost: Composer's **Revoke All API Keys** (then pair again and
  invite again), and the owner's **Replace the remote secret** in the app (Settings → Account, on
  the home network), which the account service accepts only from the owner (`docs/RELAY.md`). If
  someone else took the home over first, Composer's **Reset Remote Identity** makes it a new home,
  which the owner links again.
- **A DirectorLink backup and its password** (1.4.0, `docs/BACKUP.md`). The file holds the same:
  the lock keys and the home secret, locked with the password in the browser. Together they are
  as good as a copy of the controller's storage, with the same remedies.
- **The owner's account session.** Replacing the home secret trusts it: someone who stole it could
  approve a secret of their own and cut the controller off from the relay, without reading or
  changing anything (a stolen owner session could already delete the home). Sign out everywhere,
  then replace the secret again at home.
- **Someone who can change traffic on the home network.** Sealed requests cannot be read, changed
  or replayed on the Wi-Fi, and since 1.3.0 pairing does not send the code (CPace): someone in
  the middle gets one guess per exchange, counted like a wrong code. They can still stop pairing
  (drop the requests, or use up the code's twenty attempts), and with a controller before 1.3.0,
  **Pair anyway** sends the code, which they could take. The API console and scripts send their
  key in the clear with every request (the console's own key lasts a day), and a key paired
  before 1.0.0 was sent in the clear then: revoke it and pair again if that matters.
- **Someone in the network path with a certificate for another name.** The controller asks
  Director to check the relay's certificate against the authorities Cloudflare issues it from
  (`docs/RELAY.md`, 1.1.0), but whether Director also checks that the certificate names
  `api.directorlink.io` is not known. If it does not, someone between the controller and the
  internet with a certificate one of those authorities issued for any other name could pose as the
  relay, take the home secret from the connection and keep the home offline; sealed requests stay
  unreadable to them.
- **Scene links** (1.7.0, ADR-051): not sealed. Whoever holds one runs its scene; the account
  service, and Cloudflare beneath it, see its secret when a phone uses it. Never a scene with doors
  or gates; remove or replace a link that may have leaked.
- **Metadata:** which account uses which home, when, and how much. With alerts (1.6.0), also when
  a home was offline, and which key ids are admin keys. Since 1.7.0, when the home notified which
  key ids, and whether the notice was brief; every sealed part has the same size, and none names
  anything the cloud can read. The keys and the brevity tell some kinds for certain: a brief notice
  is a doorbell's ring (only rings are brief); one that is not brief and reaches a key that is not
  an admin key is the refrigerator's door left open (doors opened and schedules that failed go to
  admin keys only); one for admin keys only is a door or gate opened, a schedule that failed or the
  refrigerator. Never which doorbell, door or refrigerator, who opened it, or which schedule.
  With requests from new devices (1.7.0), also the kind of device and browser that asked, and
  when. With scene links (1.7.0), when a home's linked scenes run and whether they ran. An alert's
  words are the app's, never the cloud's: whoever could send pushes in DirectorLink's name could
  only choose among its own sentences and a time, and could not seal a detail a device would open;
  the cloud could send a sealed alert again to the same device, which shows its own time.

## iPhone and iPad

They cannot use the home-network connection: WebKit blocks it (see the README). With this design
they always go through the cloud, locked, even at home. The owner still has to claim the home once
from a computer or an Android phone; the owner's iPhone then joins as *my other device*, or (1.7.0)
with **Join from another device**, which the Home Screen app needs: it gets no links (*Join from
another device*, above).

## Phases

1. **Driver** (0.10.0): lock keys, envelopes over the relay, claim and invitations, with tests
   against the fake Director, and a self-test of `C4:Encrypt` and `C4:HMAC` at every start.
2. **Cloud** (0.10.0): Google sign-in, sessions, homes, members, invitations and routing. Apple
   was built since (`cloud/src/apple.js`) and is on from 1.3.0.
3. **App** (0.10.0): sign-in, linking the home, automatic choice between home and remote
   connection, Add my other device and Invite (link and QR), iPhone and iPad. People and devices
   (members and their keys) followed in 0.11.0.
4. **Docs and release** (0.10.0): the privacy page on directorlink.io, and `RELAY.md` version 1.

Sign-in details:
- Google's authorization-code flow with PKCE, run by `api.directorlink.io`; the app only navigates
  to `/auth/google/start` and comes back with `?signin=…`. No Google script runs in the app's pages.
- The browser holds the sign-in's state in a 10-minute `__Host-dl_signin` cookie, so a sign-in
  started elsewhere cannot be completed in this browser; the nonce and the PKCE verifier stay on
  the server. The ID token's signature, issuer, audience, expiry, nonce and verified email are
  checked.
- The session is a random token in the `__Host-dl_session` cookie (`Secure`, `HttpOnly`,
  `SameSite=Strict`, 30 days); D1 keeps only its SHA-256. Sign-out and account deletion are
  accepted only from the app's own origins.

Apple (1.3.0): the Services ID `io.directorlink.signin`, Team ID `VA4Q88T4RC`, Key ID
`Q3WXX95K83` and the primary App ID `io.directorlink.app` are public settings; the `.p8` key is the
Worker secret `APPLE_PRIVATE_KEY`. The return URL is `https://api.directorlink.io/auth/apple/callback`
and the notification endpoint `https://api.directorlink.io/auth/apple/notifications`.

## Known issues

- An owner's approval is only as good as their check of the code: the name an account gives is not
  checked by anyone. Like the email check before it, the approval is enforced by the cloud; the
  controller still checks the invitation's secret.
- The invited person's page must stay open (or be opened again from the link) to finish joining
  once the owner has approved.

## Decisions

1. Lock keys are derived from each device's API key; there is no separate secret.
2. AES-256-CBC with HMAC-SHA256, a 2-minute window and one-time request ids.
3. The owner claims the home on the home network, from a computer or an Android phone.
   A later claim from the home network moves the home to a new owner.
4. Everyone else joins by an invitation link or QR code that the admin shares. The secret sits
   after `#`, and the invitation is bound to an email, works once and lasts 7 days (10 minutes for
   *my other device*); since 1.3.0 the owner approves another email (ADR-041).
5. Google sign-in first, with the session in a secure cookie; Apple once the whole flow works
   (on since 1.3.0).
6. The cloud stores only accounts, homes, members and pending invitations; since 1.6.0 also each
   home's automatic backups, sealed so that only the backup password opens them (ADR-048).
7. Home-network use without an account stays.
8. The version 0 relayed requests, the test endpoints and the viewer-only rule are gone.
9. (1.0.0, ADR-032) The app seals its requests on the home network too and pairs with an X25519 key
   exchange, and never falls back to sending its key once a controller sealed; pairing works only
   on the home network; the controller registers its own invitations; the home's owner replaces
   the home secret, from the home network; an account can sign out everywhere.
10. (1.3.0, ADR-041) Sign in with Apple is on, and the app shows only the sign-ins the cloud has set
    up. An invitation accepted with another email waits for the home's owner, who compares a code
    with the person they invited. Apple's notifications remove an Apple sign-in and end the
    sessions of an account left without one, but never touch a home or a membership.
11. (1.3.0, ADR-039, ADR-040) The app and the console pair with CPace and never send the code;
    with an older DirectorLink only after a warning and **Pair anyway**. The console's own key
    lasts a day.
12. (1.6.0, ADR-047) Admins may get Web Push alerts (home offline 10 minutes, a schedule failed),
    encrypted for their browsers and naming nothing; the controller tells the cloud which key ids
    are admin keys.
13. (1.7.0, ADR-050) What the controller alerts about (doorbells, doors opened, the refrigerator,
    schedules) it seals to each key that gets it, and each key chooses; the cloud delivers each part
    to that key's browsers only, knowing which keys and when, not what (though a brief one is a
    ring, and one for a key that is not an admin key that is not brief is the refrigerator).
14. (1.7.0, ADR-051) A scene may have a private link for the phone's own automations: its secret
    passes the account service in the clear when used (never which scene), the controller keeps
    its hash, and a scene that opens doors or gates never has one.
15. (1.7.0, ADR-052) Three totals are public, counted once an hour: homes linked to an account,
    people with an account, driver downloads. Nothing about any one home; the homes send nothing
    for them.
16. (1.7.0, ADR-053) A new device of the account joins by approval from a device that reaches the
    home with an admin key, after both show the same code; the new device commits to its key first,
    and the invitation reaches it sealed. Paste invitation link brings a link into the Home Screen app.
