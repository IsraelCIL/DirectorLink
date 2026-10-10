#!/usr/bin/env python3
"""Checks the built dist/DirectorLink.c4z against the source tree and the release contract."""

import base64
import binascii
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / "driver"
PACKAGE = ROOT / "dist" / "DirectorLink.c4z"
SPEC_MODULE = "src/api/openapi_spec.lua"

# The Composer properties, in order: what an installer needs, nothing more (0.8.0).
REQUIRED_PROPERTIES = (
    "Status",
    "Version",
    "API Status",
    "Pairing Code",
    "Pairing Status",
    "API Keys",
    "Door Control",
    # Holding a relay closed, which holds a door or gate open (1.1.1, ADR-036).
    "Relay Hold",
    # Whether the alarm is armed, shown read-only to members and admins (1.2.0, ADR-038).
    "Alarm Status",
    "Remote Access",
    "Remote Status",
    # The API over HTTPS on port 28443 under the home's own name (1.12.0, ADR-082): the installer's
    # switch, and its name and state.
    "Direct HTTPS",
    "Direct HTTPS Status",
    # What DirectorLink automates, visible to the installer (0.15.0): a pause switch, a summary
    # and the last run.
    "Schedules",
    "Schedule Status",
    "Last Automation",
    # Shabbat and holiday times (1.2.0, ADR-037): the switch, and what the calendar works out.
    "Jewish Calendar",
    "Calendar Status",
    # Sonos on the home network (1.5.0, ADR-044): the switch, a player's address when the search
    # finds none, and what was found.
    "Sonos",
    "Sonos Address",
    "Sonos Players",
    "Log Level",
    "Inventory",
)

# The door switches ship off; an installer turns them on in Composer (ADR-025, ADR-036). So does
# the Jewish calendar: with it off the driver works nothing out and the app shows none of it. And
# the alarm's status: with it off the driver does not watch the alarm (ADR-038). And Sonos: with it
# off the driver looks for no player and sends nothing to one (ADR-044). And Direct HTTPS: with it
# off the driver makes no key and opens no TLS server (ADR-082).
SAFE_DEFAULTS = {"Door Control": "Disabled", "Relay Hold": "Not allowed", "Jewish Calendar": "Off", "Alarm Status": "Off", "Sonos": "Off",
                 "Direct HTTPS": "Off"}

# Refresh Project (1.1.0) reads the project again after changes in Composer, without a restart.
# Remove All Scene Links (1.7.0, ADR-051) ends every scene's link at once.
REQUIRED_ACTIONS = ("NEW_PAIRING_CODE", "REVOKE_API_KEYS", "PRINT_AUTOMATION", "REFRESH_PROJECT", "RESET_REMOTE_IDENTITY", "REMOVE_SCENE_LINKS")

# Source fragments that encode security decisions; removing one should be deliberate.
SECURITY_CONTRACT = {
    "src/api/server.lua": (
        "if not match.route.public then",
        'string.lower(scheme) ~= "bearer"',
        '["https://app.directorlink.io"] = true',
        # The home's own name passes the Host check only on the Direct HTTPS server (ADR-082).
        "return client ~= nil and client.secure == true and services.https ~= nil and services.https.hostAllowed(host) == true",
    ),
    # Direct HTTPS (1.12.0, ADR-082): TLS 1.2 and 1.3, no client certificate asked for,
    # exactly the home's name, and only its own server destroyed (DestroyServer() would end 41999's).
    "src/api/direct_https.lua": (
        "DirectHttps.TLS_OPTIONS = 0",
        "DirectHttps.VERIFY_MODE = 1",
        "C4:DestroyServer(DirectHttps.PORT)",
        'return host == name or host == name .. ":" .. DirectHttps.PORT',
    ),
    "src/auth/keys.lua": (
        # Only hashes are stored, never the keys themselves.
        "local ok = Store.write(STORE_KEY, { version = 4, keys = records }, false)",
        "        records[#records + 1] = {\n"
        "            id = key.id,\n"
        "            name = key.name,\n"
        "            role = key.role,\n"
        "            alg = key.alg,\n"
        "            hash = key.hash,\n"
        "            lock = key.lock,\n"
        "            created_at = key.created_at,\n"
        "            profile = key.profile,\n"
        "            expires = key.expires,\n"
        "        }\n",
        # An expired key is refused (ADR-040).
        'return nil, "KEY_EXPIRED"',
        'C4:Hash(algorithm.c4, text, { return_encoding = "HEX" })',
        "return Random.hex(32)",
        "constantTimeEqual(hashes[key.alg], key.hash)",
        "Store.write(OLD_STORE_KEY, { version = 2, keys = Json.array() }, true)",
    ),
    # Secrets never come from Director's UUIDs alone: they are mixed into a pool that moves on.
    "src/core/random.lua": (
        'out = out .. hash(state.pool .. "|out|" .. state.counter .. "|" .. sources())',
        'state.pool = hash(state.pool .. "|next|" .. state.counter .. "|" .. sources())',
        # Only a hash of the pool is kept: a copy of the driver's data does not tell what follows.
        'pool = hash("seed|" .. state.pool)',
    ),
    "src/auth/pairing.lua": (
        "Pairing.CODE_TTL_SECONDS = 15 * 60",
        "MAX_FAILED_ATTEMPTS = 5",
        "LOCK_SECONDS = 60",
        "constantTimeEqual(input, state.code)",
        'close("Used at "',
        # A CPace attempt counts as a wrong code from its start (ADR-039).
        "client.failed = client.failed + 1\n    state.codeFailures = state.codeFailures + 1\n    return { code = state.code, ip = ip, generation = state.generation, target = state.target }",
    ),
    # CPace (ADR-039): the key is made only after the app's tag is right; low-order shares are refused.
    "src/auth/cpace_pairing.lua": (
        "if #appShare ~= 32 or X25519.smallOrder(appShare) then",
        "if not sameBytes(Cpace.tag(macKey, appShare, AD), appTag) then",
    ),
    "src/api/handlers/auth.lua": (
        "local paired, failure = ctx.services.pairing.conclude(session.attempt, isk ~= nil)\n    if not paired then\n        return pairingFailure(ctx, failure)\n    end",
        # The owner's person is only the owner's (ADR-054: Access.mayChangePerson): no key made
        # into it, no device moved into or out of it, none revoked, by anyone else.
        "local allowed, refusal = Access.mayChangePerson(ctx.apiKey, body.profile_id)",
        "problem = personRefused(ctx, before.profile) or personRefused(ctx, changes.profile)",
        # A member removes only their own user's devices; an admin any but the owner's (ADR-061).
        "local allowed, refusal = Access.mayRemoveDevice(ctx.apiKey, revoked)",
        # Every way a key gets into a user stays within five devices (ADR-061).
        "if profileId and Users.full(profileId) then\n        return nil, UserHandlers.limitProblem(ctx, profileId)",
        "problem = UserHandlers.refuseWhenFull(ctx, changes.profile)",
    ),
    # Users and their devices (ADR-061): another admin never removes the owner's devices; the
    # owner's user stays when an account's devices are brought together, which only the owner
    # confirms; DirectorLink never does it by itself, nor offers the owner's access to keep for
    # another user's devices.
    "src/auth/access.lua": (
        "if Access.isAdmin(actor) then\n        return Access.mayChangePerson(actor, key.profile)\n    end",
        "if keepId ~= owner then\n                return false, \"OWNER_KEEPS\"",
        "if unknown or (left == owner and right ~= owner) then\n        return false\n    end",
        # Handing the home over (ADR-064): only the owner, and only to another admin user.
        "if owner == nil or own ~= owner then\n        return false, \"OWNER_ONLY\"\n    end",
        "if not Access.isAdminPerson(profileId) then\n        return false, \"NOT_AN_ADMIN\"\n    end",
    ),
    # The owner's choice decides who the owner is (ADR-064), asked of Access before and again after
    # the account service answered, and recorded only once it moved its record (or has none): its
    # word alone makes nobody the owner.
    "src/api/handlers/users.lua": (
        # A suggestion is confirmed only as it was shown (ADR-061): its revision.
        "if Users.revision(group) ~= body.revision:lower() then",
        # The home's account is never guessed, and a move the controller did not follow is undone.
        "local tag, unclear, devices = Users.ownerAccount(target, previous)",
        "cancelMove(ctx, message.id, \"no_answer\")",
        "local allowed, refusal = Access.mayMakeOwner(ctx.apiKey, target)",
        "local still, again = Access.mayMakeOwner(ctx.apiKey, target)",
        "if answer and answer.ok == true then\n                outcome = \"moved\"\n            elseif answer and answer.code == \"NOT_CLAIMED\" then",
    ),
    "src/auth/users.lua": (
        # The suggestion offers the user whose access is within every other's, never more.
        "if other ~= id and not Access.within(id, other) then",
        "if Users.after(group, keepId, keys) > Users.DEVICE_LIMIT then",
        "if not adminLeft(ids, keepId, keys) then",
        # A device that is no longer an admin's keeps none of the invitations it made.
        "if not Access.isAdminPerson(keepId) then\n        for _, id in ipairs(ids) do\n            Invitations.revokeCreatedBy(id)",
    ),
    "src/cloud/relay.lua": (
        # An answer counts only as the answer of its own question's type.
        "if waiting and message.type == waiting.expects then",
        # Plain relayed requests (version 0) never reach the API: the relay cannot read a home.
        'code = "RELAY_REQUESTS_RETIRED"',
        "refuseRequest(message)",
        "Store.write(IDENTITY_KEY, identity, false)",
        # Key ids only: never names, roles or secrets; and never a list that may be short.
        "ids[#ids + 1] = key.id",
        "if state.services.keys.complete and not state.services.keys.complete() then",
        # Relayed requests go through the answer memory, so one sent again runs once (ADR-072).
        "local handled, what = Answers.handle(message, send, state.remote)",
        # An alert goes again only after the relay it goes to said it answers alerts, and to one that
        # does not, once, as before (ADR-073).
        "if open and state.acks == false then",
        "local count, again = Outbox.resend(state.connection, send)",
        # Kept while down only within the window after a relay that answered alerts (1.10.1 review).
        "return Relay.connected() or (state.enabled and state.keepWindow ~= nil)",
    ),
    # Alerts kept to be sent again are bounded in time (a timer each) and in number and bytes, and
    # only one that went to a relay known to answer alerts goes again (1.10.1 review).
    "src/cloud/outbox.lua": (
        "entry.timer = C4:SetTimer(",
        "while #state.entries > Outbox.MAX or state.bytes > Outbox.MAX_BYTES do",
        "elseif entry.sends == 0 or entry.known then",
    ),
    # A request the relay sends again after a lost connection never runs twice: a known id is
    # answered from memory, and one that may have been forgotten is not run (ADR-072).
    "src/cloud/answers.lua": (
        "local entry = state.byId[id]\n    if entry then",
        "if resent and state.forgotAt and at - state.forgotAt < Answers.RESEND_SECONDS then",
    ),
    # The end-to-end lock (docs/ACCOUNTS.md): the MAC is checked before anything is decrypted,
    # requests are fresh and used once, claims come only from the home network, and invitation
    # secrets are never stored.
    "src/cloud/lock.lua": (
        "Lock.WINDOW_SECONDS = 120",
        "if not sameText(expected, Base64.toHex(mac)) then\n        return nil, \"BAD_MAC\"\n    end\n    local plaintext = C4:Decrypt(",
        'local DEVICE_LABEL = "DirectorLink e2e v1"',
    ),
    "src/cloud/remote.lua": (
        "if seen[requestId] then",
        "math.abs(now - ts) > Lock.WINDOW_SECONDS or ts < state.startedAt",
        # Replays across a restart: ids of requests dated ahead of the clock are saved and loaded.
        "remember(keyId, requestId, ts, now)",
        "state.seen[item.k][item.i] = state.startedAt",
        # A claim token dies with its admin key (an admin's: ADR-054), and works only while that
        # admin may claim the home (only the owner, once the home was claimed with 1.8.0).
        "return owner ~= nil and Access.isAdmin(owner) and (Access.mayClaim(owner)) == true, owner",
        "state.services.invitations.consume(invitationId)",
        # An invitation into an existing person joins only while its maker may add a device there.
        "allowed, refusal = Access.mayChangePerson(inviter, profile.id)",
        # A sealed request never carries another (it would run as one from the home network).
        'if path:gsub("/+$", "") == "/v1/sealed" then',
        "state.services.keys.remote(keyId)",
    ),
    # Doors and gates in a scene: only a pulse (never held closed), never when DirectorLink runs a
    # scene itself (schedules, links: ADR-054), and only with Door Control on.
    "src/api/handlers/scenes.lua": (
        "if not Access.scenesOpenDoors(ctx.apiKey) then",
        "elseif not services.doorControlEnabled() then",
        'return { { action = "pulse" } }',
    ),
    "src/core/scenes.lua": (
        'return set.action == "pulse" and { action = "pulse" } or nil',
    ),
    # A relay is held closed (its door or gate held open) only with Relay Hold allowed (ADR-036).
    "src/api/handlers/relays.lua": (
        'if action == "close" and not ctx.services.relayHoldAllowed() then',
    ),
    # A Relay Door, Gate or Garage Door Controller (ADR-069) is told only its own Open, and one that
    # holds its relay opens only where Relay Hold is allowed (check_door_controllers_open_only).
    "src/adapters/relay_controller.lua": (
        'C4:SendToDevice(info.controller, "OPEN", {})',
        "if info.hold and not (type(params) == \"table\" and params.hold_allowed == true) then",
    ),
    # A schedule runs its scene like a member's key: never doors or gates.
    "src/core/scheduler.lua": (
        '{ id = "schedule:" .. schedule.id, role = "member" }',
    ),
    # Scene links (ADR-051): only a hash of each secret is kept, compared in constant time; only
    # scenes whose steps are all of an allowed type (never doors or gates); a run is a member's,
    # checked again (its key too), and never logs the secret.
    "src/core/scene_links.lua": (
        "        hash = link.hash,\n        home = link.home,\n",
        "if found and hash and sameText(hash, found.hash) then",
        "SceneLinks.ALLOWED = { lights = true, climate = true, fans = true, blinds = true, music = true, refrigerators = true }",
        "SceneLinks.REFUSED = { relays = true }",
        'if type(step) ~= "table" or not SceneLinks.ALLOWED[step.type] then',
    ),
    "src/api/handlers/scene_links.lua": (
        'return Problem.new(409, "SCENE_OPENS_DOORS", "A scene that opens doors or gates cannot have a link")',
        '{ id = "link:" .. link.id, role = "member" }',
        # The key that made it still there, and still an admin's (ADR-054: mayLink).
        "if not scene or not SceneLinks.linkable(scene) or link.home ~= linkedHome() or (link.by and Keys.complete() and not mayLink(link.by)) then",
        "return key ~= nil and Access.isAdmin(key)",
    ),
    # Ask to open (ADR-058): only a hash of each secret, compared in constant time; a request lasts
    # two minutes, and only a pulse from a device it was sent to, by a key that may open the door,
    # answers it (check_ask_links_open_nothing: the link's own code never opens anything).
    "src/core/ask_links.lua": (
        "if SceneLinks.secretMatches(found and found.alg, found and found.hash, secret) and found then",
        "AskLinks.OPEN_SECONDS = 120",
    ),
    "src/api/handlers/ask_links.lua": (
        "if not Access.canOpen(ctx.apiKey, relay) then",
        "if not request or request.relay_id ~= tonumber(device.id) or not request.keys[ctx.apiKey.id] then",
        "if not maker or not relay or link.home ~= linkedHome() or not Access.canOpen(maker, relay) then",
    ),
    "src/api/handlers/remote.lua": (
        "if ctx.apiKey.remote then",
    ),
    # The alarm's status (ADR-038): nothing while Alarm Status is Off, then only for members and
    # admins, and only in sealed answers. Read-only: check_alarm_read_only.
    "src/api/handlers/alarm.lua": (
        "if not services.alarmStatusEnabled() then\n        return 200, { enabled = false, partitions = Json.array() }",
        "if not (ctx.request and ctx.request.principal) then",
    ),
    "src/api/routes.lua": (
        '{ method = "GET", path = "/v1/alarm", handler = "alarm.status", role = "member" },',
    ),
    "src/adapters/alarm.lua": (
        'return driver == "security.c4i" and Alarm.enabled()',
        'return Properties ~= nil and Properties[Alarm.PROPERTY] == "On"',
    ),
    # Sonos (ADR-044): off by default; only home network addresses DirectorLink was given by the
    # players or the installer, only port 1400 (check_sonos).
    "src/sonos/sonos.lua": (
        'return Properties ~= nil and Properties[Sonos.PROPERTY] == "On"',
    ),
    "src/sonos/client.lua": (
        'local url = "http://" .. job.ip .. ":" .. Protocol.PORT .. job.path',
        "if not state.allowed[job.ip] then",
        "local ip = Protocol.lanAddress(address)",
    ),
    "src/sonos/protocol.lua": (
        "Protocol.PORT = 1400",
        "if a == 10 or (a == 172 and b >= 16 and b <= 31) or (a == 192 and b == 168) then",
    ),
    "src/auth/invitations.lua": (
        "items[#items + 1] = { id = item.id, role = item.role, lock = item.lock, created_at = item.created_at, expires = item.expires, created_by = item.created_by, profile = item.profile }",
    ),
    # Director hands stored JSON back decoded (ADR-028); keys must stay readable.
    "src/core/store.lua": (
        'local PREFIX = "json:"',
        "C4:PersistSetValue(name, PREFIX .. Json.encode(value), encrypted == true)",
        'if type(raw) == "table" then',
    ),
    "src/core/log.lua": (
        "pairing_code = true",
        "authorization = true",
    ),
    # Director checks the relay's certificate only when asked (NetPortOptions VERIFY_MODE); the CA
    # file is checked in check_relay_roots.
    "src/cloud/websocket.lua": (
        'VERIFY_MODE = "peer",',
        "CACERTFILE = WebSocket.CA_FILE,",
    ),
}

# The Jewish calendar is worked out on the controller from the project's location (1.2.0,
# ADR-037): none of its files reaches the network. The engine's files must be there; the service,
# jewish_calendar.lua, is guarded by name whether or not it exists yet.
CALENDAR_ENGINE = (
    "src/core/hebrew_date.lua",
    "src/core/holidays.lua",
    "src/core/parasha.lua",
    "src/core/sun.lua",
    "src/core/holy_times.lua",
)
CALENDAR_SERVICE = "src/core/jewish_calendar.lua"
NETWORK_CALLS = (
    ("C4:url", re.compile(r"C4\s*[:.]\s*url")),
    ("CreateNetworkConnection", re.compile(r"CreateNetworkConnection")),
    ("SendToNetwork", re.compile(r"SendToNetwork")),
)

# The roots the relay connection trusts: the authorities Cloudflare issues from (docs/RELAY.md),
# in file order, each with the SHA-256 of its certificate (checked against certifi 2026.07.22). A
# label alone would let a rebuild put the wrong certificate under the right name; remote access
# would then fail only on the controller. Today's chain ends at GTS Root R4.
RELAY_ROOTS = {
    "ISRG Root X1": "96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6",
    "ISRG Root X2": "69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470",
    "GTS Root R1": "d947432abde7b7fa90fc2e6b59101b1280e0e1c7e4e40fa3c6887fff57a7f4cf",
    "GTS Root R3": "34d8a73ee208d9bcdb0d956520934b4e40e69482596e8b6f73c8426b010a6f48",
    "GTS Root R4": "349dfa4058c5e263123b398ae795573c4e1313c83fe68f93556cd5e8031b3c7d",
    "SSL.com TLS RSA Root CA 2022": "8faf7d2e2cb4709bb8e0b33666bf75a5dd45b5de480f8ea8d4bfe6bebc17f2ed",
    "SSL.com TLS ECC Root CA 2022": "c32ffd9f46f936d16c3673990959434b9ad60aafbb9e7cf33654f144cc1ba143",
    "SSL.com Root Certification Authority RSA": "85666a562ee0be5ce925c1d8890a6f76a87ec16d4d7d5f29ea7419cf20123b69",
    "SSL.com Root Certification Authority ECC": "3417bb06cc6007da1b961c920b8ab4ce3fad820e4aa30b9acbc4a74ebdcebc65",
}

# Where websocket.lua names the CA file, relative to the package root.
CA_FILE_PATTERN = re.compile(r'WebSocket\.CA_FILE = "\./([^"]+)"')

# What OpenSSL's PEM reader, which loads Director's CA file, drops from the end of every line:
# every character up to and including the space (CR, tab, trailing spaces).
PEM_LINE_END = "".join(chr(code) for code in range(33))


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def ca_file_name(websocket_source):
    """The package path of the relay's CA file, as src/cloud/websocket.lua names it (WebSocket.CA_FILE)."""
    match = CA_FILE_PATTERN.search(websocket_source)
    if not match:
        fail('src/cloud/websocket.lua must set WebSocket.CA_FILE = "./<path in the package>"')
    return match.group(1)


def pem_certificates(data):
    """The certificates in a PEM file (bytes) as OpenSSL would load them as trust anchors, in file
    order: (label, SHA-256 of the DER), the label being the "# ..." line just before the block.

    OpenSSL drops trailing whitespace (CR included) from each line and also takes TRUSTED
    CERTIFICATE and X509 CERTIFICATE blocks, so a narrower reading could miss a root. Here every
    line that holds -----BEGIN or -----END, however written, must open or close a plain
    CERTIFICATE block, the lines in a block must be base64 only, and the file must be ASCII with no
    key. Anything else raises ValueError, so nothing OpenSSL would trust can go uncounted."""
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        raise ValueError("it must be plain ASCII") from None
    if "PRIVATE KEY" in text:
        raise ValueError("it holds a private key")
    certificates = []
    body, label, previous = None, None, ""
    for number, raw in enumerate(text.split("\n"), 1):
        line = raw.rstrip(PEM_LINE_END)
        marker = "-----BEGIN" in line.upper() or "-----END" in line.upper()
        if body is None:
            if line == "-----BEGIN CERTIFICATE-----":
                body, label = [], (previous[2:] if previous.startswith("# ") else None)
            elif marker:
                raise ValueError(f"line {number} ({raw.rstrip(chr(13))!r}) is not -----BEGIN CERTIFICATE-----: only plain certificates belong here")
        elif line == "-----END CERTIFICATE-----":
            try:
                der = base64.b64decode("".join(body), validate=True)
            except binascii.Error:
                raise ValueError(f"the certificate that ends on line {number} is not valid base64") from None
            certificates.append((label, hashlib.sha256(der).hexdigest()))
            body = None
        elif marker or not re.fullmatch(r"[A-Za-z0-9+/=]+", line):
            raise ValueError(f"line {number} ({raw.rstrip(chr(13))!r}) is inside a certificate block and is not base64")
        else:
            body.append(line)
        previous = line
    if body is not None:
        raise ValueError("a certificate block has no -----END CERTIFICATE-----")
    return certificates


def relay_roots_problem(data):
    """Why a CA file (bytes) is not exactly the relay's pinned roots, or None."""
    try:
        certificates = pem_certificates(data)
    except ValueError as exc:
        return str(exc)
    digests = [digest for _, digest in certificates]
    if sorted(digests) != sorted(RELAY_ROOTS.values()):
        unknown = [label or digest for label, digest in certificates if digest not in RELAY_ROOTS.values()]
        return (
            f"it must hold exactly the roots {', '.join(RELAY_ROOTS)}, once each "
            f"(it holds {len(digests)} certificates{'; not pinned: ' + ', '.join(unknown) if unknown else ''})"
        )
    return None


def expected_versions():
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    # A test build (MAJOR.MINOR.PATCH-test.N, never released) is one below its release (build.py).
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-test\.(\d+))?$", version)
    if not match:
        fail(f"VERSION must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-test.N, got {version!r}")
    major, minor, patch = (int(part) for part in match.groups()[:3])
    return version, str(major * 10000 + minor * 100 + patch - (1 if match.group(4) else 0))


def check_reproducible(infos):
    """Metadata that must not depend on the build machine, so checksums match across OSes."""
    for info in infos:
        if info.date_time != (2026, 1, 1, 0, 0, 0):
            fail(f"{info.filename} has timestamp {info.date_time}; builds must use the fixed timestamp")
        if info.create_system != 3:
            fail(f"{info.filename} was written with create_system {info.create_system}; builds must use 3 (Unix)")


def check_contents(names):
    expected = {"driver.xml", "driver.lua", SPEC_MODULE}
    expected.update(path.relative_to(DRIVER).as_posix() for path in (DRIVER / "src").rglob("*.lua"))
    expected.update(path.relative_to(DRIVER).as_posix() for path in (DRIVER / "www").rglob("*") if path.is_file())
    # Of driver/certs, only the CA file websocket.lua names: never a key or test file left there.
    expected.add(ca_file_name((DRIVER / "src" / "cloud" / "websocket.lua").read_text(encoding="utf-8")))
    missing = expected - names
    if missing:
        fail(f"package is missing files: {sorted(missing)}")
    extra = names - expected
    if extra:
        fail(f"package contains unexpected files: {sorted(extra)}")


def check_driver_xml(text, driver_version):
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        fail(f"packaged driver.xml is not valid XML: {exc}")
    # Director's broker reads driver.xml as "<xml>" + contents + "</xml>". If that does not parse
    # (e.g. an <?xml ...?> declaration), it rejects the driver and "Update Driver" never reloads it.
    try:
        ET.fromstring("<xml>" + text + "</xml>")
    except ET.ParseError as exc:
        fail(f"driver.xml must parse inside <xml>...</xml> like the Control4 broker reads it: {exc}")
    if root.tag != "devicedata":
        fail("driver.xml root must be <devicedata>")
    script = root.find("./config/script")
    if script is None or script.attrib.get("file") != "driver.lua":
        fail("driver.xml must load driver.lua")
    if root.findtext("minimum_os_version") != "3.3.0":
        fail("minimum_os_version must be 3.3.0")
    if root.findtext("auto_update") != "false":
        fail("auto_update must stay false")
    if root.findtext("version") != driver_version:
        fail(f"packaged driver.xml version is {root.findtext('version')!r}, expected {driver_version}")

    properties = [node.findtext("name") for node in root.findall("./config/properties/property")]
    if tuple(properties) != REQUIRED_PROPERTIES:
        fail(f"driver.xml properties must be exactly {', '.join(REQUIRED_PROPERTIES)} (got {', '.join(properties)})")
    for node in root.findall("./config/properties/property"):
        name = node.findtext("name")
        if name in SAFE_DEFAULTS and node.findtext("default") != SAFE_DEFAULTS[name]:
            fail(f"driver.xml: {name} must default to {SAFE_DEFAULTS[name]} (got {node.findtext('default')!r})")
    # A self-contained device: combo driver whose only proxy is itself; no child proxies, no button.
    if root.findtext("combo") != "true":
        fail("driver.xml must declare <combo>true</combo>")
    proxies = [proxy.text for proxy in root.findall("./proxies/proxy")]
    if proxies != ["DirectorLink"]:
        fail(f"driver.xml must declare exactly one proxy, DirectorLink (got {proxies})")
    if root.find("connections") is not None:
        fail("driver.xml must not declare connections: DirectorLink has no child proxies")
    names = set(ZipFile(PACKAGE).namelist())
    for icon in root.iter("Icon"):
        path = "www/" + icon.text.split("controller://driver/DirectorLink/", 1)[-1]
        if path not in names:
            fail(f"driver.xml references {icon.text}, which is not in the package")
    actions = {node.findtext("command") for node in root.findall("./config/actions/action")}
    for command in REQUIRED_ACTIONS:
        if command not in actions:
            fail(f"driver.xml is missing Composer action {command!r}")


def check_requires(files):
    pattern = re.compile(r"""require\s*\(\s*["']([^"']+)["']\s*\)""")
    for name, text in files.items():
        if not name.endswith(".lua"):
            continue
        for module in pattern.findall(text):
            target = module.replace(".", "/") + ".lua"
            if target not in files:
                fail(f"{name} requires {module}, which is not in the package")


def check_embedded_spec(text, version):
    match = re.search(r"return \[(=*)\[(.*)\]\1\]\s*$", text, re.S)
    if not match:
        fail(f"{SPEC_MODULE} does not return a long string")
    try:
        spec = json.loads(match.group(2))
    except json.JSONDecodeError as exc:
        fail(f"embedded API description is not valid JSON: {exc}")
    if not str(spec.get("openapi", "")).startswith("3.1"):
        fail("embedded API description must be OpenAPI 3.1")
    if spec.get("info", {}).get("version") != version:
        fail("embedded API description version does not match VERSION")


def check_relay_roots(files):
    """The CA file websocket.lua names is in the package and holds exactly the relay's roots: every
    certificate OpenSSL would load from it is one of the pinned ones, each once, under its label."""
    name = ca_file_name(files.get("src/cloud/websocket.lua", ""))
    if name not in files:
        fail(f"the relay's CA file {name} is not in the package; with VERIFY_MODE peer no connection would verify")
    data = files[name].encode("utf-8")
    problem = relay_roots_problem(data)
    if problem:
        fail(f"{name}: {problem}")
    # Each certificate is the one its label names: the SHA-256 of its DER bytes is pinned above.
    certificates = pem_certificates(data)
    labels = [label for label, _ in certificates]
    if labels != list(RELAY_ROOTS):
        fail(f"{name} must label its roots {', '.join(RELAY_ROOTS)}, in this order (found {labels})")
    for label, digest in certificates:
        if digest != RELAY_ROOTS[label]:
            fail(f"{name}: the certificate under '# {label}' is not {label} (SHA-256 {digest})")
    # The header lists every root's SHA-256 for readers; it must list the same ones.
    text = files[name].replace("\r\n", "\n")
    header = {
        subject: fingerprint.replace(":", "").lower()
        for subject, fingerprint in re.findall(r"^# CN=([^,\n]+),[^\n]*\n#   for: [^\n]*\n#   SHA-256: ([0-9A-F:]+)$", text, re.M)
    }
    if header != RELAY_ROOTS:
        fail(f"the SHA-256 list at the top of {name} does not match its certificates")


def check_remote_methods(files):
    """Sealed requests (the app's, at home and through the account) may use every method the API
    routes: one missing from src/cloud/remote.lua fails everywhere, as PUT /v1/rooms/order did in 1.0.0."""
    routed = set(re.findall(r'\bmethod\s*=\s*"([A-Z]+)"', files.get("src/api/routes.lua", "")))
    match = re.search(r"^local METHODS = \{([^}]*)\}", files.get("src/cloud/remote.lua", ""), re.M)
    if not routed or not match:
        fail("could not read the methods of src/api/routes.lua and src/cloud/remote.lua (local METHODS = { ... })")
    allowed = set(re.findall(r"\b([A-Z]+)\s*=\s*true\b", match.group(1)))
    missing = sorted(routed - allowed)
    if missing:
        fail(f"src/cloud/remote.lua refuses {', '.join(missing)}, which src/api/routes.lua uses: sealed requests with it would fail")


def check_security_contract(files):
    for name, fragments in SECURITY_CONTRACT.items():
        text = files.get(name, "")
        for fragment in fragments:
            if fragment not in text:
                fail(f"{name} is missing security contract: {fragment}")


LUA_LONG_BRACKET = re.compile(r"\[(=*)\[")


def lua_code(text):
    """Lua source without its comments (each replaced by a space, newlines kept), so that a check
    reads only what runs. Strings, long strings included, are kept."""
    out, i, n = [], 0, len(text)
    while i < n:
        if text.startswith("--", i):
            long = LUA_LONG_BRACKET.match(text, i + 2)
            if long:
                end = text.find("]" + long.group(1) + "]", long.end())
                end = n if end < 0 else end + len(long.group(1)) + 2
            else:
                end = text.find("\n", i)
                end = n if end < 0 else end
            out.append(" " + "\n" * text.count("\n", i, end))
            i = end
        elif text[i] in "\"'":
            quote, j = text[i], i + 1
            while j < n and text[j] != quote and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text[i] == "[" and LUA_LONG_BRACKET.match(text, i):
            level = LUA_LONG_BRACKET.match(text, i).group(1)
            end = text.find("]" + level + "]", i + len(level) + 2)
            end = n if end < 0 else end + len(level) + 2
            out.append(text[i:end])
            i = end
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


# The alarm is read-only (ADR-038): arming and disarming take the user's alarm code, which needs a
# stronger design than an API key. The adapter may only read and watch its partitions' variables,
# with nothing else loaded or logged; no Lua in the package names a partition command; the API
# only reads the alarm, and no scene or schedule step can reach it.
ALARM_ADAPTER = "src/adapters/alarm.lua"
ALARM_DIRECTOR_CALLS = ("GetVariable", "RegisterVariableListener", "UnregisterVariableListener")
PARTITION_COMMANDS = re.compile(r"\bPARTITION_(?:ARM|DISARM)\b")
ALARM_WORDS = re.compile(r"alarm|security|partition", re.I)


# An ask-to-open link (ADR-058) asks; it never opens. Its modules send no command to a device:
# only the pulse route does, with the answering device's own key.
ASK_LINK_MODULES = ("src/core/ask_links.lua", "src/api/handlers/ask_links.lua")


# A door controller (ADR-069) gets its own Open and nothing else: never CLOSE or STOP (a gate
# closing or stopping on someone), never SELECT (its button in the Control4 app, which closes what is
# not Closed), never a relay of its own. The only other commands are a KNX relay's own (the relay a
# controller drives, released and held as before, through KnxRelay.send).
DOOR_CONTROLLER = "src/adapters/relay_controller.lua"
DOOR_CONTROLLER_COMMANDS = re.compile(r'"(?:CLOSE|STOP|SELECT|TOGGLE|TRIGGER|LUA_ACTION|DO_CLICK)"')
DOOR_CONTROLLER_SENDS = ("SendToProxy", "SendToDevice", "SendUIRequest", "SendDirectorCommand", "FireEvent", "ExecuteCommand")
DOOR_CONTROLLER_OPEN = 'C4:SendToDevice(info.controller, "OPEN", {})'


def check_door_controllers_open_only(files):
    text = files.get(DOOR_CONTROLLER)
    if text is None:
        fail(f"{DOOR_CONTROLLER} is missing")
    code = lua_code(text)
    for match in re.finditer(r"\bC4\s*[:.]\s*(\w+)", code):
        if match.group(1) not in DOOR_CONTROLLER_SENDS:
            continue
        line = code[match.start():].split("\n", 1)[0].strip()
        if line != DOOR_CONTROLLER_OPEN:
            fail(f"{DOOR_CONTROLLER} may only send a controller its own Open ({DOOR_CONTROLLER_OPEN}); found {line!r}")
    found = DOOR_CONTROLLER_COMMANDS.search(code)
    if found:
        fail(f"{DOOR_CONTROLLER} must never send a door controller {found.group(0)}: only its Open")


def check_ask_links_open_nothing(files):
    for name in ASK_LINK_MODULES:
        text = files.get(name)
        if text is None:
            fail(f"{name} is missing")
        code = lua_code(text)
        for pattern, what in (
            (r"\badapters\b", "reach the device adapters"),
            (r"\bexecute\s*\(", "send a command"),
            (r"\bC4:SendToDevice\b", "send a command to a device"),
            (r"\brunSaved\b", "run a scene"),
        ):
            if re.search(pattern, code):
                fail(f"{name} must not {what}: an ask-to-open link only asks")


def check_alarm_read_only(files):
    adapter = files.get(ALARM_ADAPTER)
    if adapter is None:
        fail(f"{ALARM_ADAPTER} is missing")
    code = lua_code(adapter)
    for match in re.finditer(r"\bC4\b", code):
        call = re.match(r"C4:(\w+)\s*\(", code[match.start():])
        if not call or call.group(1) not in ALARM_DIRECTOR_CALLS:
            found = code[match.start():match.start() + 40].split("\n", 1)[0]
            fail(f"{ALARM_ADAPTER} may only read and watch variables ({', '.join(ALARM_DIRECTOR_CALLS)}); found {found!r}")
    for pattern, what in (
        (r"\brequire\b", "load other modules"),
        (r"\bprint\s*\(", "print (the alarm's state is never logged)"),
        (r"\b(?:_G|_ENV|getfenv|setfenv|rawget|loadstring|load|dofile)\b", "reach Director or the log another way"),
    ):
        if re.search(pattern, code):
            fail(f"{ALARM_ADAPTER} must not {what}")
    for name, text in sorted(files.items()):
        if name.endswith(".lua") and PARTITION_COMMANDS.search(lua_code(text)):
            fail(f"{name} names a partition command (PARTITION_ARM / PARTITION_DISARM): the alarm is read-only")
    for method, path in re.findall(r'\bmethod\s*=\s*"([A-Z]+)",\s*path\s*=\s*"([^"]+)"', files.get("src/api/routes.lua", "")):
        if path.startswith("/v1/alarm") and method != "GET":
            fail(f"{method} {path} in src/api/routes.lua: the alarm is only read")
    for name, pattern in (
        ("src/core/scenes.lua", r"^Scenes\.TYPES = \{([^}]*)\}"),
        ("src/api/handlers/scenes.lua", r"^local KINDS = \{([^}]*)\}"),
        ("src/api/handlers/scenes.lua", r"^local LISTS = \{([^}]*)\}"),
    ):
        match = re.search(pattern, files.get(name, ""), re.M)
        if not match:
            fail(f"could not read the scene step types in {name}")
        if ALARM_WORDS.search(match.group(1)):
            fail(f"{name}: scene steps must never reach the alarm ({match.group(0).strip()})")


# Sonos (ADR-044): one file talks to the players, the actions it may send are listed, and an address
# is allowed only by the module that reads the players' answers and the installer's property; the
# API names a Sonos room, never an address.
SONOS_CLIENT = "src/sonos/client.lua"
# Grouping (1.8.0, ADR-057) is two actions: joining (SetAVTransportURI with the coordinator's
# x-rincon: address) and leaving (BecomeCoordinatorOfStandaloneGroup). A group's volume is each
# room's own SetVolume: no GroupRenderingControl, no other grouping action, no alarms or settings.
SONOS_ACTIONS = {
    "GetTransportInfo", "GetPositionInfo", "GetMediaInfo", "Play", "Pause", "Stop", "Next", "Previous",
    "SetAVTransportURI", "RemoveAllTracksFromQueue", "AddURIToQueue", "BecomeCoordinatorOfStandaloneGroup",
    "GetVolume", "SetVolume", "GetMute", "SetMute", "GetZoneGroupState", "Browse",
}
# The x-rincon: address a room joins a group with is made in one place (Protocol.groupUri, which
# takes only a player's id), and only src/sonos/sonos.lua uses it, for a coordinator it found in the
# zone group state: the API never names what a room joins.
SONOS_GROUP_URI = re.compile(r"""["']x-rincon:["']\s*\.\.""")
SONOS_GROUP_URI_USERS = {"src/sonos/protocol.lua", "src/sonos/sonos.lua"}


# main.lua loads the client only to hand it the search's network events (ReceivedFromNetwork,
# OnConnectionStatusChanged): these two, and nothing else of it.
SONOS_CLIENT_IN_MAIN = {"onData", "onConnectionStatus"}
SONOS_CLIENT_REQUIRE = re.compile(r"""\blocal\s+(\w+)\s*=\s*require\s*\(?\s*(["'])src\.sonos\.client\2\s*\)?""")


def check_sonos_client_in_main(code):
    """main.lua may load src/sonos/client.lua once, as a local, and use only SONOS_CLIENT_IN_MAIN
    of it: no address allowed, no request sent, no other name for it."""
    name = "src/main.lua"
    loads = SONOS_CLIENT_REQUIRE.findall(code)
    if code.count("src.sonos.client") != len(loads) or len(loads) > 1:
        fail(f"{name} loads {SONOS_CLIENT} other than once as `local X = require(\"src.sonos.client\")`")
    if not loads:
        return
    local = loads[0][0]
    for use in re.finditer(rf"(?<![\w.:]){re.escape(local)}\b", code):
        rest = code[use.end():]
        if re.match(r"\s*=\s*require\b", rest) and code[:use.start()].rstrip().endswith("local"):
            continue
        member = re.match(r"\s*[.:]\s*(\w+)", rest)
        if not member or member.group(1) not in SONOS_CLIENT_IN_MAIN:
            found = code[use.start():use.start() + 40].split("\n", 1)[0]
            fail(f"{name} uses {found!r}: of {SONOS_CLIENT} it may use only {', '.join(sorted(SONOS_CLIENT_IN_MAIN))}")


def check_sonos(files):
    for name, text in sorted(files.items()):
        if not name.endswith(".lua"):
            continue
        code = lua_code(text)
        if (name.startswith("src/sonos/") or name == "src/api/handlers/music.lua") and name != SONOS_CLIENT:
            for call, pattern in NETWORK_CALLS:
                if pattern.search(code):
                    fail(f"{name} uses {call}: only {SONOS_CLIENT} talks to the Sonos players")
        # Whatever the client is called there (Client, SonosClient, ...).
        if re.search(r"\b\w*Client\s*[.:]\s*allow\s*\(", code) and name not in ("src/sonos/sonos.lua", SONOS_CLIENT):
            fail(f"{name} allows a Sonos address: only src/sonos/sonos.lua does, from the players' answers and Composer")
        if "src.sonos.client" in code and name not in ("src/sonos/sonos.lua", "src/main.lua", SONOS_CLIENT):
            fail(f"{name} loads {SONOS_CLIENT}: requests go through src/sonos/sonos.lua")
        if name == "src/main.lua":
            check_sonos_client_in_main(code)
        if SONOS_GROUP_URI.search(code) and name != "src/sonos/protocol.lua":
            fail(f"{name} makes an x-rincon: address: only Protocol.groupUri in src/sonos/protocol.lua does")
        if re.search(r"\bgroupUri\b", code) and name not in SONOS_GROUP_URI_USERS:
            fail(f"{name} uses Protocol.groupUri: only src/sonos/sonos.lua joins a room to a group")
    match = re.search(r"^Protocol\.ACTIONS = \{([^}]*)\}", files.get("src/sonos/protocol.lua", ""), re.M)
    if not match:
        fail("could not read Protocol.ACTIONS in src/sonos/protocol.lua")
    actions = set(re.findall(r"\b(\w+)\s*=", match.group(1)))
    if actions != SONOS_ACTIONS:
        fail(f"src/sonos/protocol.lua: the actions sent to Sonos players must be exactly {', '.join(sorted(SONOS_ACTIONS))} (got {', '.join(sorted(actions))})")


def check_calendar_privacy(files):
    """The Jewish calendar's files make no network calls: they know the home's location."""
    for name in CALENDAR_ENGINE:
        if name not in files:
            fail(f"{name} is missing; if it moved, move it in CALENDAR_ENGINE too")
    for name in CALENDAR_ENGINE + (CALENDAR_SERVICE,):
        text = files.get(name, "")
        for call, pattern in NETWORK_CALLS:
            if pattern.search(text):
                fail(f"{name} uses {call}: the Jewish calendar is worked out on the controller and never goes to the network")


def check_documentation(xml, documentation):
    """Composer's Documentation tab: declared, packaged, and opening with the owner's disclaimer."""
    disclaimer = "DirectorLink is an independent project, not affiliated with Control4 or Snap One."
    if '<documentation file="www/documentation.html"/>' not in xml:
        fail('driver.xml must declare <documentation file="www/documentation.html"/> (Composer\'s Documentation tab)')
    if not documentation:
        fail("www/documentation.html must be packaged")
    body = documentation[documentation.find("<body>"):]
    first = body.find(disclaimer)
    if first < 0 or first > 400:
        fail(f"www/documentation.html must say near its top: {disclaimer}")


def main():
    if not PACKAGE.is_file():
        fail("dist/DirectorLink.c4z is missing; run python scripts/build.py")
    version, driver_version = expected_versions()

    with ZipFile(PACKAGE) as archive:
        names = set(archive.namelist())
        check_contents(names)
        check_reproducible(archive.infolist())
        files = {name: archive.read(name).decode("utf-8") for name in names if not name.startswith("www/")}
        documentation = archive.read("www/documentation.html").decode("utf-8") if "www/documentation.html" in names else ""

    check_driver_xml(files["driver.xml"], driver_version)
    if f'Version.BRIDGE_VERSION = "{version}"' not in files["src/core/version.lua"]:
        fail("packaged src/core/version.lua was not stamped with VERSION")
    check_requires(files)
    check_embedded_spec(files[SPEC_MODULE], version)
    check_security_contract(files)
    check_alarm_read_only(files)
    check_ask_links_open_nothing(files)
    check_door_controllers_open_only(files)
    check_sonos(files)
    check_calendar_privacy(files)
    check_remote_methods(files)
    check_relay_roots(files)
    check_documentation(files["driver.xml"], documentation)
    print(f"OK: validated {len(files)} packaged files for version {version}")


if __name__ == "__main__":
    main()
