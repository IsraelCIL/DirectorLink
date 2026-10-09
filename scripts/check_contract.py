#!/usr/bin/env python3
"""Contract test: runs the real driver (fake Director) on a local port, calls every API operation
with a real HTTP client, and validates each response against api/openapi.yaml.

Checks per response: the status code is declared for the operation, the Content-Type matches the
declared media type, and the JSON body validates against the declared schema. Fails if any
operation in the spec was not exercised.

It also validates the hand-written calendar examples the app's tests read
(tests/vectors/calendar/api-examples.json): each group is named after the schema its examples match.
The Jewish calendar is called while it is off (as it ships) and then on, as the installer sets it.
"""

import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dev_server  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SPEC = yaml.safe_load((ROOT / "api" / "openapi.yaml").read_text(encoding="utf-8"))
REGISTRY = Registry().with_resource("urn:spec", Resource.from_contents(SPEC, default_specification=DRAFT202012))
METHODS = ("get", "post", "put", "patch", "delete")
EXAMPLES_FILE = ROOT / "tests" / "vectors" / "calendar" / "api-examples.json"
EXAMPLES = json.loads(EXAMPLES_FILE.read_text(encoding="utf-8"))


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def resolve(node):
    while isinstance(node, dict) and "$ref" in node:
        target = SPEC
        for part in node["$ref"].lstrip("#/").split("/"):
            target = target[part]
        node = target
    return node


P25519 = 2**255 - 19


def x25519_public(private, u=9):
    """X25519 (RFC 7748): 32 private bytes times the u-coordinate `u` (the base point unless given),
    for pairing with a key exchange or with CPace."""
    p = P25519
    scalar = bytearray(private)
    scalar[0] &= 248
    scalar[31] &= 127
    scalar[31] |= 64
    k = int.from_bytes(scalar, "little")
    x1, x2, z2, x3, z3, swap = u, 1, 0, u, 1, 0
    for t in reversed(range(255)):
        bit = (k >> t) & 1
        swap ^= bit
        if swap:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = bit
        a, b = (x2 + z2) % p, (x2 - z2) % p
        aa, bb = a * a % p, b * b % p
        e = (aa - bb) % p
        c, d = (x3 + z3) % p, (x3 - z3) % p
        da, cb = d * a % p, c * b % p
        x3, z3 = (da + cb) ** 2 % p, x1 * (da - cb) ** 2 % p
        x2, z2 = aa * bb % p, e * (aa + 121665 * e) % p
    if swap:
        x2, z2 = x3, z3
    return (x2 * pow(z2, p - 2, p) % p).to_bytes(32, "little")


def lv_cat(*parts):
    """CPace's length-value encoding (LEB128 lengths)."""
    out = b""
    for part in parts:
        length, encoded = len(part), b""
        while True:
            low, length = length & 0x7F, length >> 7
            encoded += bytes([low | (0x80 if length else 0)])
            if not length:
                break
        out += encoded + part
    return out


def cpace_client(code, name, expires_in, sid, share_a):
    """The client's side of DirectorLink's CPace (ADR-039): the generator from the code (Elligator 2,
    RFC 9380), its share Yb, and the tags. Returns (Yb, its tag, the controller's tag, ISK)."""
    ci = lv_cat(b"DirectorLink pair v2", name.encode(), b"" if expires_in is None else str(expires_in).encode())
    prs, dsi = code.encode(), b"CPace255"
    zeros = bytes(max(0, 128 - 1 - len(lv_cat(prs)) - len(lv_cat(dsi))))
    u = int.from_bytes(hashlib.sha512(lv_cat(dsi, prs, zeros, ci, sid)).digest()[:32], "little") & ((1 << 255) - 1)
    a, p = 486662, P25519
    x1 = -a * pow(1 + 2 * u * u, p - 2, p) % p
    x = x1 if pow((x1 * x1 * x1 + a * x1 * x1 + x1) % p, (p - 1) // 2, p) == 1 else (-x1 - a) % p
    yb = os.urandom(32)
    share_b = x25519_public(yb, x)
    k = x25519_public(yb, int.from_bytes(share_a, "little") & ((1 << 255) - 1))
    isk = hashlib.sha512(lv_cat(b"CPace255_ISK", sid, k) + lv_cat(share_a, b"") + lv_cat(share_b, b"")).digest()
    mac_key = hashlib.sha512(b"CPaceMac" + sid + isk).digest()
    tag = lambda share: hmac.new(mac_key, lv_cat(share, b""), hashlib.sha512).digest()
    return share_b, tag(share_b), tag(share_a), isk


def absolute(schema):
    """The schema with its references pointing into the spec (also inside oneOf, items, ...)."""
    if isinstance(schema, dict):
        return {key: ("urn:spec#" + value[1:] if key == "$ref" and isinstance(value, str) and value.startswith("#") else absolute(value))
                for key, value in schema.items()}
    if isinstance(schema, list):
        return [absolute(item) for item in schema]
    return schema


def template_regex(path):
    return re.compile("^" + re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(path)) + "$")


def check_examples():
    """Every example in api-examples.json matches the schema its group is named after (dates and
    times included). Returns how many there are."""
    count = 0
    for group, examples in EXAMPLES.items():
        if group == "about":
            continue
        if group not in SPEC["components"]["schemas"]:
            fail(f"{EXAMPLES_FILE.name}: {group} is not a schema in api/openapi.yaml")
        validator = Draft202012Validator({"$ref": f"urn:spec#/components/schemas/{group}"}, registry=REGISTRY,
                                         format_checker=Draft202012Validator.FORMAT_CHECKER)
        for name, example in examples.items():
            if not isinstance(example, dict) or "value" not in example:
                fail(f"{EXAMPLES_FILE.name}: {group}.{name} has no value")
            errors = sorted(validator.iter_errors(example["value"]), key=lambda e: list(e.path))
            if errors:
                details = "; ".join(f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in errors[:5])
                fail(f"{EXAMPLES_FILE.name}: {group}.{name} does not match the spec: {details}")
            count += 1
    return count


OPERATIONS = [
    (method.upper(), path, template_regex(path), item[method])
    for path, item in SPEC["paths"].items()
    for method in METHODS
    if method in item
]


def operation_for(method, target):
    path = target.split("?", 1)[0]
    operation = next((op for op in OPERATIONS if op[0] == method and op[2].match(path)), None)
    if not operation:
        fail(f"{method} {path} is not an operation in the spec")
    return operation[1], operation[3]


class Client:
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}"
        self.key = None
        self.key_id = None
        self.covered = set()
        self.checked = 0

    def check(self, method, target, expected, body=None, auth=True, headers=None):
        template, definition = operation_for(method, target)

        request = urllib.request.Request(self.base + target, method=method, headers=dict(headers or {}))
        if body is not None:
            request.data = json.dumps(body).encode()
            request.add_header("Content-Type", "application/json")
        if auth and self.key:
            request.add_header("Authorization", f"Bearer {self.key}")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status, content_type, raw = response.status, response.headers.get("Content-Type", ""), response.read()
                response_headers = response.headers
        except urllib.error.HTTPError as error:
            status, content_type, raw = error.code, error.headers.get("Content-Type", ""), error.read()
            response_headers = error.headers
        return self.validate(f"{method} {target} -> {status}", method, template, definition, expected, status, content_type, raw, response_headers)

    def check_sealed(self, bridge, method, target, expected, body=None):
        """The request sealed as the app seals it at home (POST /v1/sealed, no Authorization
        header), and the answer inside the sealed envelope checked against the operation."""
        template, definition = operation_for(method, target)
        request = {"method": method, "path": target}
        if body is not None:
            request["body"] = body
        envelope = bridge.seal(self.key, self.key_id, request)
        sealed = self.check("POST", "/v1/sealed", 200, body={"envelope": envelope}, auth=False)
        answer = bridge.unseal(self.key, sealed["envelope"])
        if not isinstance(answer, dict):
            fail(f"sealed {method} {target}: the answer does not open with the key's lock key")
        raw = answer.get("body", "").encode()
        content_type = answer.get("content_type", "")
        return self.validate(f"sealed {method} {target} -> {answer.get('status')}", method, template, definition, expected,
                             answer.get("status"), content_type, raw, {})

    def validate(self, label, method, template, definition, expected, status, content_type, raw, response_headers):
        if status != expected:
            fail(f"{label}, expected {expected}: {raw[:300]!r}")
        declared = resolve(definition["responses"].get(str(status)))
        if declared is None:
            fail(f"{label}: status {status} is not documented for {method} {template}")

        content = declared.get("content")
        if not content:
            if raw:
                fail(f"{label}: expected an empty body")
        else:
            # The first declared media type, or another one the operation declares (a picture may
            # be JPEG or PNG).
            media_type = content_type.split(";")[0].strip()
            if media_type not in content:
                fail(f"{label}: Content-Type {content_type!r}, spec says {' or '.join(content)}")
            if not media_type.endswith("json"):
                if not raw:
                    fail(f"{label}: expected a {media_type} body")
                self.covered.add((method, template))
                self.checked += 1
                return raw
            data = json.loads(raw)
            schema = content[media_type].get("schema", {})
            validator = Draft202012Validator(absolute(schema), registry=REGISTRY)
            errors = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
            if errors:
                details = "; ".join(f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in errors[:5])
                fail(f"{label}: response does not match the spec: {details}")
            for name in resolve(declared).get("headers", {}):
                if name not in response_headers:
                    fail(f"{label}: missing documented header {name}")

        self.covered.add((method, template))
        self.checked += 1
        return json.loads(raw) if raw else None


KITCHEN, LIVING, BEDROOM, TV = "RINCON_000E58A0000101400", "RINCON_000E58A0000201400", "RINCON_000E58A0000301400", "RINCON_000E58A0000401400"


def sonos(client, bridge):
    """Sonos (1.5.0, ADR-044) with the fake players of tests/sonos/fake-sonos.mjs (Kitchen leads
    Living Room and plays a track, Bedroom plays the radio, TV Room is paused in Spotify Connect):
    off as it ships, then on as the installer sets it."""
    off = client.check("GET", "/v1/music", 200)
    if off != {"enabled": False, "status": "off", "items": []}:
        fail(f"GET /v1/music with Sonos Off should say only that: {off}")
    if client.check("GET", "/v1/system", 200)["features"]["sonos"] is not False:
        fail("GET /v1/system should say that Sonos is off")
    if client.check("POST", f"/v1/music/{KITCHEN}/play", 409)["code"] != "SONOS_OFF":
        fail("a command with Sonos Off should be refused with SONOS_OFF")
    client.check("POST", "/v1/scenes/try", 202, body={"steps": [{"type": "music", "room_id": None, "set": {"action": "pause"}}]})

    bridge.set_property("Sonos", "On")
    if client.check("GET", "/v1/system", 200)["features"]["sonos"] is not True:
        fail("GET /v1/system should say that Sonos is on")
    music = client.check("GET", "/v1/music", 200)
    rooms = {item["id"]: item for item in music["items"]}
    if music["status"] != "ok" or sorted(rooms) != sorted([KITCHEN, LIVING, BEDROOM, TV]):
        fail(f"GET /v1/music should list the four fake Sonos rooms (the search found them): {music}")
    kitchen = rooms[KITCHEN]
    if (kitchen["room_id"], kitchen["room_match"], kitchen["state"], kitchen["now_playing"]["title"]) != (10, "name", "playing", "Morning Light"):
        fail(f"Kitchen should be in the Kitchen and play Morning Light: {kitchen}")
    if rooms[BEDROOM]["now_playing"]["station"] != "Example FM 99" or rooms[BEDROOM]["room_id"] is not None:
        fail(f"Bedroom should play Example FM 99 and be in no room: {rooms[BEDROOM]}")
    client.check("GET", "/v1/music?room_id=10", 200)
    client.check("GET", "/v1/music?room_id=x", 400)
    client.check("GET", f"/v1/music/{LIVING}", 200)
    client.check("GET", "/v1/music/RINCON_0BADF00D", 404)
    client.check("GET", "/v1/music/192.168.50.11", 400)
    client.check_sealed(bridge, "GET", "/v1/music", 200)
    art = client.check("GET", f"/v1/music/{LIVING}/art", 200)
    if not art.startswith(b"\x89PNG"):
        fail("the album art should be the fake player's picture")
    client.check("GET", f"/v1/music/{TV}/art", 404)
    client.check("POST", f"/v1/music/{LIVING}/pause", 200)
    client.check("POST", f"/v1/music/{KITCHEN}/play", 200)
    client.check("POST", f"/v1/music/{KITCHEN}/next", 200)
    client.check("POST", f"/v1/music/{KITCHEN}/previous", 200)
    if client.check("POST", f"/v1/music/{BEDROOM}/next", 409)["code"] != "ACTION_NOT_POSSIBLE":
        fail("the radio cannot skip: ACTION_NOT_POSSIBLE")
    if client.check("POST", f"/v1/music/{BEDROOM}/pause", 200)["state"] != "stopped":
        fail("a radio station that cannot pause stops")
    if client.check("PATCH", f"/v1/music/{LIVING}", 200, body={"volume": 25, "muted": False})["volume"] != 25:
        fail("PATCH should set Living Room's volume")
    client.check("PATCH", f"/v1/music/{LIVING}", 400, body={"volume": 101})
    favorites = client.check("GET", f"/v1/music/{KITCHEN}/favorites", 200)["items"]
    if [(item["id"], item["playable"]) for item in favorites] != [("10", True), ("11", True), ("12", True), ("1", False)]:
        fail(f"the fake favorites: three playable and a shortcut: {favorites}")
    client.check("POST", f"/v1/music/{KITCHEN}/favorites/11/play", 200)
    if client.check("POST", f"/v1/music/{KITCHEN}/favorites/1/play", 409)["code"] != "FAVORITE_NOT_PLAYABLE":
        fail("a shortcut cannot be started: FAVORITE_NOT_PLAYABLE")
    client.check("POST", f"/v1/music/{KITCHEN}/favorites/99/play", 404)
    placed = client.check("PUT", f"/v1/music/{BEDROOM}/room", 200, body={"room_id": 11})
    if (placed["room_id"], placed["room_match"]) != (11, "admin"):
        fail(f"an admin puts Bedroom in the Living Room: {placed}")
    client.check("PUT", f"/v1/music/{BEDROOM}/room", 400, body={"room_id": 999})
    client.check("PUT", f"/v1/music/{BEDROOM}/room", 200, body={"room_id": None})
    ran = client.check("POST", "/v1/scenes/try", 202, body={"steps": [{"type": "music", "room_id": 10, "set": {"action": "stop"}}]})
    if ran["ran"] != 1:
        fail(f"a music step in the Kitchen should stop one group: {ran}")
    client.check("POST", "/v1/scenes/try", 400, body={"steps": [{"type": "music", "device_ids": [20], "set": {"action": "pause"}}]})

    # Groups and the new scene steps (1.8.0, ADR-057).
    if client.check("GET", "/v1/system", 200)["features"].get("sonos_groups") is not True:
        fail("GET /v1/system should say that this driver groups Sonos rooms")
    groups = {group["id"]: group for group in client.check("GET", "/v1/music", 200)["groups"]}
    if groups[KITCHEN]["rooms"] != [KITCHEN, LIVING]:
        fail(f"GET /v1/music should list Kitchen's group with Living Room: {groups}")
    joined = client.check("POST", f"/v1/music/{TV}/group", 200, body={"with": LIVING})
    if [room["id"] for room in joined["group"]["rooms"]] != [KITCHEN, LIVING, TV] or joined["group"]["id"] != KITCHEN:
        fail(f"TV Room should join Kitchen's group: {joined}")
    client.check("POST", f"/v1/music/{TV}/group", 404, body={"with": "RINCON_0BADF00D01400"})
    client.check("POST", f"/v1/music/{TV}/group", 400, body={"with": "192.168.50.11"})
    louder = client.check("PATCH", f"/v1/music/{TV}/group", 200, body={"volume": 40})
    if louder["group"]["volume"] is None:
        fail(f"the group's volume should be shown: {louder}")
    client.check("PATCH", f"/v1/music/{TV}/group", 400, body={"volume": 101})
    left = client.check("DELETE", f"/v1/music/{TV}/group", 200)
    if [room["id"] for room in left["group"]["rooms"]] != [TV]:
        fail(f"TV Room should play on its own again: {left}")
    favorite = client.check("POST", "/v1/scenes/try", 202, body={"steps": [
        {"type": "music", "room_id": 11, "set": {"action": "play_favorite", "favorite": {"id": "10"}, "volume": 20, "with_room_ids": [10]}},
        {"type": "music", "room_id": 10, "set": {"action": "volume", "volume": 15}},
        {"type": "music", "room_id": None, "set": {"action": "resume"}},
    ]})
    if favorite["skipped"] or favorite["failed"]:
        fail(f"the music steps should run: {favorite}")
    gone = client.check("POST", "/v1/scenes/try", 202, body={"steps": [{"type": "music", "room_id": 11, "set": {"action": "play_favorite", "favorite": {"id": "77", "title": "Old FM", "uri": "x-sonosapi-stream:gone"}}}]})
    if [problem["code"] for problem in gone["problems"]] != ["FAVORITE_GONE"]:
        fail(f"a favorite no longer in Sonos favorites should be reported: {gone}")
    client.check("POST", "/v1/scenes/try", 400, body={"steps": [{"type": "music", "set": {"action": "play_favorite", "favorite": {"id": "10"}}}]})


def scenario(client, bridge):
    client.check("GET", "/v1/health", 200)
    client.check("GET", "/v1/openapi.json", 200)
    client.check("GET", "/v1/system", 401)
    client.check("POST", "/v1/auth/pair", 403, body={"pairing_code": "00000000"})
    client.check("POST", "/v1/auth/pair", 400, body={"pairing_code": "12"})
    paired = client.check("POST", "/v1/auth/pair", 201, body={"pairing_code": bridge.pairing_code, "name": "contract test"})
    client.key, client.key_id = paired["key"], paired["id"]
    client.check("POST", "/v1/auth/pair", 403, body={"pairing_code": bridge.pairing_code})  # used: works once

    client.check("GET", "/v1/system", 200)
    client.check("GET", "/v1/rooms", 200)
    client.check("GET", "/v1/rooms/10", 200)
    client.check("GET", "/v1/rooms/999", 404)
    client.check("GET", "/v1/rooms/abc", 400)
    client.check("PATCH", "/v1/rooms/10", 200, body={"names": {"en": "Kitchen", "he": "מטבח"}})
    client.check("PATCH", "/v1/rooms/10", 400, body={"names": {"english": "Kitchen"}})
    client.check("PATCH", "/v1/rooms/999", 404, body={"names": {"en": "x"}})
    client.check("GET", "/v1/devices", 200)
    client.check("GET", "/v1/devices?type=light&supported=true&room_id=11", 200)
    client.check("GET", "/v1/devices?type=lamp", 400)
    client.check("GET", "/v1/devices/40", 200)
    client.check("GET", "/v1/devices/9", 404)

    client.check("GET", "/v1/lights", 200)
    client.check("GET", "/v1/lights?room_id=10", 200)
    client.check("GET", "/v1/lights/20", 200)
    client.check("GET", "/v1/lights/99", 404)
    client.check("PATCH", "/v1/lights/20", 202, body={"brightness": 50})
    client.check("PATCH", "/v1/lights/21", 202, body={"on": True})
    client.check("PATCH", "/v1/lights/21", 409, body={"brightness": 50})
    client.check("PATCH", "/v1/lights/21", 400, body={"on": "yes"})
    client.check("PATCH", "/v1/lights/99", 404, body={"on": True})

    client.check("GET", "/v1/thermostats", 200)
    client.check("GET", "/v1/thermostats/30", 200)
    client.check("GET", "/v1/thermostats/20", 404)
    client.check("PATCH", "/v1/thermostats/30", 202, body={"mode": "heat", "target_temperature": 21, "fan_speed": "medium"})
    client.check("PATCH", "/v1/thermostats/30", 409, body={"mode": "auto"})
    client.check("PATCH", "/v1/thermostats/30", 400, body={"target_temperature": 99})

    # The 1.1.0 device families (Mock.demoProject): older lights (25 dimmer, 26 switch), a
    # thermostat with heat and cool setpoints (31, in auto) and floor heating on its heat setpoint (32).
    client.check("GET", "/v1/lights/25", 200)
    client.check("PATCH", "/v1/lights/25", 202, body={"brightness": 40})
    client.check("PATCH", "/v1/lights/26", 409, body={"brightness": 40})
    client.check("GET", "/v1/thermostats/31", 200)
    client.check("PATCH", "/v1/thermostats/31", 202, body={"mode": "auto", "heat_setpoint": 20, "cool_setpoint": 24})
    client.check("PATCH", "/v1/thermostats/31", 202, body={"mode": "cool", "target_temperature": 24})
    client.check("PATCH", "/v1/thermostats/31", 202, body={"fan_speed": "on"})
    client.check("PATCH", "/v1/thermostats/31", 400, body={"heat_setpoint": 22, "cool_setpoint": 23})
    client.check("PATCH", "/v1/thermostats/31", 400, body={"target_temperature": 22, "heat_setpoint": 20})
    client.check("PATCH", "/v1/thermostats/31", 409, body={"target_temperature": 22})
    client.check("PATCH", "/v1/thermostats/30", 409, body={"heat_setpoint": 20})
    client.check("GET", "/v1/thermostats/32", 200)
    client.check("PATCH", "/v1/thermostats/32", 202, body={"target_temperature": 6})

    # Fans (1.2.0, Mock.withFans): 41 on at Medium in the living room, 42 off in the kitchen. The
    # dev bridge's fans follow their commands as the fan proxy is documented to.
    client.check("GET", "/v1/fans", 200)
    client.check("GET", "/v1/fans?room_id=11", 200)
    client.check("GET", "/v1/fans/41", 200)
    client.check("GET", "/v1/fans/20", 404)
    client.check("GET", "/v1/fans/abc", 400)
    client.check("GET", "/v1/devices?type=fan", 200)
    client.check("PATCH", "/v1/fans/42", 202, body={"speed": 3})
    fan = client.check("GET", "/v1/fans/42", 200)
    if (fan["on"], fan["speed"]) != (True, 3):
        fail(f"GET /v1/fans/42 should show the fan on at speed 3: {fan}")
    client.check("PATCH", "/v1/fans/42", 202, body={"on": False})
    client.check("PATCH", "/v1/fans/41", 202, body={"on": True})
    client.check("PATCH", "/v1/fans/41", 400, body={"speed": 5})
    client.check("PATCH", "/v1/fans/41", 400, body={"on": False, "speed": 2})
    client.check("PATCH", "/v1/fans/41", 400, body={"on": "yes"})
    client.check("PATCH", "/v1/fans/99", 404, body={"on": True})

    client.check("GET", "/v1/blinds", 200)
    client.check("GET", "/v1/blinds?room_id=11", 200)
    client.check("GET", "/v1/blinds/50", 200)
    client.check("GET", "/v1/blinds/51", 200)
    client.check("GET", "/v1/blinds/20", 404)
    client.check("PATCH", "/v1/blinds/50", 202, body={"position": 100})
    client.check("PATCH", "/v1/blinds/50", 400, body={"position": 101})
    client.check("PATCH", "/v1/blinds/99", 404, body={"position": 0})
    client.check("POST", "/v1/blinds/50/stop", 202)
    client.check("POST", "/v1/blinds/99/stop", 404)
    # Shades that say what they can do (1.1.0, Mock.withShades): 52 goes anywhere and stops, 53
    # only opens and closes fully and cannot stop. The dev bridge moves them as KNX blinds move.
    client.check("PATCH", "/v1/blinds/52", 202, body={"position": 60})
    moving = client.check("GET", "/v1/blinds/52", 200)
    if (moving["moving"], moving["direction"], moving["target_position"]) != (True, "opening", 60):
        fail(f"GET /v1/blinds/52 should show the shade opening to 60: {moving}")
    client.check("POST", "/v1/blinds/52/stop", 202)
    client.check("PATCH", "/v1/blinds/53", 409, body={"position": 50})
    client.check("PATCH", "/v1/blinds/53", 202, body={"position": 100})
    client.check("POST", "/v1/blinds/53/stop", 409)

    client.check("GET", "/v1/cameras", 200)
    client.check("GET", "/v1/cameras/60", 200)
    client.check("GET", "/v1/cameras/20", 404)
    client.check("GET", "/v1/cameras/60/snapshot", 200)
    client.check("GET", "/v1/cameras/61/snapshot?width=320", 200)
    client.check("GET", "/v1/cameras/60/snapshot?width=500", 400)
    client.check("GET", "/v1/cameras/99/snapshot", 404)

    client.check("GET", "/v1/relays", 200)
    client.check("GET", "/v1/relays/70", 200)
    client.check("GET", "/v1/relays/20", 404)
    client.check("PATCH", "/v1/relays/70", 202, body={"state": "open"})
    # Holding a relay closed holds its door open: refused while Relay Hold is Not allowed (1.1.1).
    held = client.check("PATCH", "/v1/relays/70", 409, body={"state": "closed"})
    if held["code"] != "HOLD_NOT_ALLOWED":
        fail(f"PATCH /v1/relays/70 closed should be refused with HOLD_NOT_ALLOWED: {held}")
    client.check("PATCH", "/v1/relays/70", 400, body={"state": "unlocked"})
    client.check("POST", "/v1/relays/70/pulse", 202)
    client.check("POST", "/v1/relays/99/pulse", 404)
    # Answering an ask-to-open link's request (ADR-058): one that is not there opens nothing.
    if client.check("POST", "/v1/relays/70/pulse", 409, body={"request": "0" * 16})["code"] != "OPEN_REQUEST_EXPIRED":
        fail("a pulse that answers no request should be OPEN_REQUEST_EXPIRED")
    client.check("POST", "/v1/relays/70/pulse", 400, body={"request": "not a request"})
    # Control4's Relay Door, Gate and Garage Door Controllers (1.10.0, ADR-069, dev bridge "doors"):
    # a gate with a contact, a garage door without, the KNX relay 75 as a door controller's door.
    doors = {item["id"]: item for item in client.check("GET", "/v1/relays", 200)["items"]}
    if doors.get(70, {}).get("kind") != "relay" or doors.get(71, {}).get("kind") != "gate" or doors.get(72, {}).get("kind") != "garage_door":
        fail(f"the relays' kinds are wrong: {doors}")
    if doors[71]["door_state"] != "closed" or doors[72]["door_state"] is not None or doors.get(75, {}).get("kind") != "door" or 73 in doors or 74 in doors:
        fail(f"the door controllers are not listed as they should be: {doors}")
    client.check("GET", "/v1/relays/71", 200)
    client.check("GET", "/v1/relays/73", 404)
    client.check("POST", "/v1/relays/71/pulse", 202)
    if client.check("PATCH", "/v1/relays/71", 409, body={"state": "open"})["code"] != "NOT_SUPPORTED":
        fail("a door controller's relay is the controller's: PATCH should be NOT_SUPPORTED")
    # 1.10.1: the controller's button shown as the KNX relay 75, and the DoorBird's button and
    # intercom, are parts of the door and of the doorbell 93 (`part_of`), not devices of their own.
    parts = {item["id"]: item["part_of"] for item in client.check("GET", "/v1/devices", 200)["items"]}
    if (parts.get(73), parts.get(90), parts.get(91), parts.get(75), parts.get(72), parts.get(40)) != (75, 93, 93, None, None, None):
        fail(f"GET /v1/devices should name the door or doorbell a part belongs to, and nothing else: {parts}")
    if client.check("GET", "/v1/devices/73", 200)["part_of"] != 75:
        fail("GET /v1/devices/73 should be part of the door 75")

    # A Samsung refrigerator (1.7.0, Mock.withRefrigerator): the driver 140, the refrigerator 141.
    # The dev bridge's refrigerator confirms a feature 4 seconds later, as through Samsung's cloud.
    client.check("GET", "/v1/refrigerators", 200)
    client.check("GET", "/v1/refrigerators?room_id=10", 200)
    fridge = client.check("GET", "/v1/refrigerators/141", 200)
    if (fridge["fridge_temperature"], fridge["online"], fridge["features_reported"]) != (3, True, False):
        fail(f"GET /v1/refrigerators/141 should show the fake refrigerator: {fridge}")
    client.check("GET", "/v1/refrigerators/142", 404)
    client.check("GET", "/v1/refrigerators/abc", 400)
    client.check("PATCH", "/v1/refrigerators/141", 202, body={"sabbath_mode": True, "ice_maker": False})
    client.check("PATCH", "/v1/refrigerators/141", 400, body={"sabbath_mode": "on"})
    client.check("PATCH", "/v1/refrigerators/141", 400, body={"door_open": True})
    client.check("PATCH", "/v1/refrigerators/99", 404, body={"power_cool": True})
    if bridge.report_variable(140, 1006, "1") != 1 or bridge.fire_event(140, 15) != 1:
        fail("the refrigerator's door and its driver's Door Left Open should be watched")

    client.check("GET", "/v1/doorbells", 200)
    client.check("GET", "/v1/doorbells/93", 200)
    client.check("GET", "/v1/doorbells/92", 404)
    client.check("POST", "/v1/doorbells/93/open", 202)
    client.check("POST", "/v1/doorbells/99/open", 404)
    # A camera that is a doorbell (1.10.0, ADR-065: the dev bridge's agreement cameras, 68 Entrance
    # on driver 158): listed with the doorbells, ringing by its driver's event named Ring; it opens
    # nothing.
    if bridge.camera_ring(158) != 1:
        fail("a doorbell camera's Ring should be watched by its name")
    entrance = client.check("GET", "/v1/doorbells/68", 200)
    if entrance["camera"] != {"id": 68, "snapshot_href": "/v1/cameras/68/snapshot"} or not entrance["last_ring_at"] or entrance["can_open"]:
        fail(f"GET /v1/doorbells/68 should be the doorbell camera, its picture its own, rung: {entrance}")
    if 68 not in [item["id"] for item in client.check("GET", "/v1/doorbells", 200)["items"]]:
        fail("GET /v1/doorbells should list the doorbell camera")
    if {"id": 68, "type": "doorbell"} not in [{"id": item["id"], "type": item["type"]} for item in client.check("GET", "/v1/devices?type=doorbell", 200)["items"]]:
        fail("GET /v1/devices?type=doorbell should list the doorbell camera as a doorbell")
    client.check("POST", "/v1/doorbells/68/open", 409)
    if bridge.camera_alert(157, "Animal") != 1:
        fail("an agreement camera's Alert should be watched by its name")

    # The alarm's status (1.2.0, ADR-038): read-only, off by default (the dev bridge's fake home
    # has it on), and while it is on only in sealed answers (Mock.withPartitions: 80 House, 81
    # Garage, 82 unused).
    bridge.set_property("Alarm Status", "Off")
    off = client.check("GET", "/v1/alarm", 200)
    if off != {"enabled": False, "partitions": []}:
        fail(f"GET /v1/alarm with Alarm Status Off should say only that: {off}")
    if client.check("GET", "/v1/system", 200)["features"]["alarm_status"] is not False:
        fail("GET /v1/system should say that the alarm status is off")
    if client.check_sealed(bridge, "GET", "/v1/alarm", 200) != off:
        fail("a sealed GET /v1/alarm should say only that it is off")
    bridge.set_property("Alarm Status", "On")
    clear = client.check("GET", "/v1/alarm", 403)
    if clear["code"] != "SEALED_REQUEST_REQUIRED":
        fail(f"GET /v1/alarm in the clear should be refused with SEALED_REQUEST_REQUIRED: {clear}")
    alarm = client.check_sealed(bridge, "GET", "/v1/alarm", 200)
    if [partition["id"] for partition in alarm["partitions"]] != [81, 80]:
        fail(f"GET /v1/alarm should list Garage and House, and not the partition the panel does not use: {alarm}")
    for variable, value in ((1007, "ENTRY_DELAY"), (1008, "30"), (1009, "12"), (1003, "1"), (1011, "Fire"), (1005, "Low battery")):
        if bridge.report_variable(80, variable, value) != 1:
            fail(f"partition 80 should watch variable {variable}")
    house = client.check_sealed(bridge, "GET", "/v1/alarm", 200)["partitions"][1]
    if (house["delay"], house["alarm_type"], house["trouble"]) != ({"type": "entry", "remaining": 12, "total": 30}, "Fire", "Low battery"):
        fail(f"GET /v1/alarm should show House's entry delay, fire alarm and trouble: {house}")
    if client.check("GET", "/v1/system", 200)["features"]["alarm_status"] is not True:
        fail("GET /v1/system should say that the alarm status is on")

    sonos(client, bridge)

    # Remote access is off on the dev bridge: status, and the refusals that follow from it.
    client.check("GET", "/v1/remote", 200)
    client.check("POST", "/v1/remote/claim", 409)
    client.check("POST", "/v1/remote/secret", 409)
    client.check("GET", "/v1/invitations", 200)
    client.check("POST", "/v1/invitations", 409, body={"role": "member"})
    client.check("POST", "/v1/invitations", 400, body={"role": "owner"})
    client.check("DELETE", "/v1/invitations/0123abcd", 404)

    # Profiles: the caller's own, and the admin's list; the home's room order.
    profile = client.check("GET", "/v1/profile", 200)
    client.check("PATCH", "/v1/profile", 200, body={"prefs": {"language": "he", "theme": "dark", "favorites": ["light:20"]}})
    client.check("PATCH", "/v1/profile", 200, body={"prefs": {"theme": None}})
    client.check("PATCH", "/v1/profile", 400, body={"prefs": {"theme": "neon"}})
    client.check("PATCH", "/v1/profile", 409, body={"prefs": {"language": "en"}, "version": 0})
    client.check("GET", "/v1/profiles", 200)
    client.check("PATCH", f"/v1/profiles/{profile['id']}", 200, body={"name": "Owner"})
    client.check("PATCH", f"/v1/profiles/{profile['id']}", 400, body={"name": ""})
    client.check("PATCH", "/v1/profiles/deadbeef", 404, body={"name": "Someone"})
    client.check("GET", "/v1/profile", 401, auth=False)
    client.check("PUT", "/v1/rooms/order", 200, body={"room_ids": [11, 10]})
    client.check("PUT", "/v1/rooms/order", 400, body={"room_ids": [999]})
    client.check("PATCH", "/v1/profile", 200, body={"prefs": {"hidden_rooms": [11]}})

    # Scenes: made by admins, run by members; a door in a scene runs with door access.
    night = {
        "name": "Good night",
        "icon": "moon",
        "show_on_home": True,
        "steps": [
            {"type": "lights", "set": {"on": False}},
            {"type": "climate", "room_id": 11, "set": {"mode": "cool", "target_temperature": 24}},
            {"type": "blinds", "room_id": None, "set": {"position": 0}},
            {"type": "lights", "room_id": 10, "device_ids": [20], "set": {"brightness": 30}},
            {"type": "relays", "device_ids": [70], "set": {"action": "pulse"}},
            {"type": "fans", "room_id": 11, "set": {"speed": 1}},
            {"type": "fans", "device_ids": [42], "set": {"on": False}},
            {"type": "refrigerators", "device_ids": [141], "set": {"sabbath_mode": True}},
        ],
    }
    scene = client.check("POST", "/v1/scenes", 201, body=night)
    client.check("POST", "/v1/scenes", 400, body={"name": "Bad", "steps": [{"type": "lights", "set": {"on": True, "brightness": 5}}]})
    client.check("GET", "/v1/scenes", 200)
    client.check("GET", f"/v1/scenes/{scene['id']}", 200)
    client.check("GET", "/v1/scenes/deadbeef", 404)
    client.check("GET", "/v1/scenes/nothex", 400)
    client.check("PATCH", f"/v1/scenes/{scene['id']}", 200, body={"name": "Night", "version": 1})
    client.check("PATCH", f"/v1/scenes/{scene['id']}", 409, body={"name": "Late", "version": 1})
    client.check("PATCH", f"/v1/scenes/{scene['id']}", 400, body={"icon": "rocket"})
    client.check("PATCH", "/v1/scenes/deadbeef", 404, body={"name": "Gone"})
    client.check("POST", f"/v1/scenes/{scene['id']}/run", 202)
    client.check("POST", "/v1/scenes/deadbeef/run", 404)
    client.check("POST", "/v1/scenes/try", 202, body={"steps": [{"type": "lights", "device_ids": [20], "set": {"on": True}}]})
    # A level for a room goes to its dimmers only; the KNX switch there stays as it is (ADR-077).
    dimmed = client.check("POST", "/v1/scenes/try", 202, body={"steps": [{"type": "lights", "room_id": 11, "set": {"brightness": 50}}]})
    switches = [problem["device_id"] for problem in dimmed["problems"] if problem["code"] == "ON_OFF_ONLY"]
    if 21 not in switches or dimmed.get("on_off_only") != len(switches) or dimmed["failed"] != 0:
        fail(f"POST /v1/scenes/try: a level for the Living Room should leave its switches as they are: {dimmed}")
    if client.check("GET", "/v1/system", 200)["features"].get("scene_levels_dimmers_only") is not True:
        fail("GET /v1/system should say features.scene_levels_dimmers_only")
    client.check("POST", "/v1/scenes/try", 400, body={"steps": [{"type": "speakers", "set": {}}]})
    client.check("POST", "/v1/scenes/try", 202, body={"steps": [{"type": "fans", "set": {"on": True}}]})
    client.check("POST", "/v1/scenes/try", 400, body={"steps": [{"type": "fans", "set": {"speed": 0}}]})
    client.check("POST", "/v1/scenes/try", 202, body={"steps": [{"type": "refrigerators", "room_id": 10, "set": {"power_cool": True}}]})
    client.check("POST", "/v1/scenes/try", 400, body={"steps": [{"type": "refrigerators", "set": {}}]})
    # Home's "Turn off all" (1.3.0): lights, AC or blinds it names, never doors.
    off = client.check("POST", "/v1/off", 202, body={"type": "lights", "device_ids": [20, 22]})
    if (off["ran"], off["failed"], off["skipped"]) != (2, 0, 0):
        fail(f"POST /v1/off should turn off both lights: {off}")
    client.check("POST", "/v1/off", 202, body={"type": "climate", "device_ids": [30, 31, 32]})
    client.check("POST", "/v1/off", 202, body={"type": "blinds", "device_ids": [50]})
    client.check("POST", "/v1/off", 400, body={"type": "relays", "device_ids": [70]})
    client.check("POST", "/v1/off", 400, body={"type": "lights", "device_ids": [70]})
    auto = {"type": "climate", "device_ids": [31], "set": {"mode": "auto", "heat_setpoint": 20, "cool_setpoint": 24}}
    dual = client.check("POST", "/v1/scenes", 201, body={"name": "Study auto", "steps": [auto]})
    client.check("POST", "/v1/scenes/try", 202, body={"steps": [auto]})
    client.check("POST", f"/v1/scenes/{dual['id']}/run", 202)
    client.check("POST", "/v1/scenes", 400, body={"name": "Bad", "steps": [{"type": "climate", "set": {"heat_setpoint": 24, "cool_setpoint": 20}}]})
    client.check("DELETE", f"/v1/scenes/{dual['id']}", 204)
    spare = client.check("POST", "/v1/scenes", 201, body={"name": "Spare"})
    client.check("DELETE", f"/v1/scenes/{spare['id']}", 204)
    client.check("DELETE", f"/v1/scenes/{spare['id']}", 404)
    client.check("GET", "/v1/scenes", 401, auth=False)

    # Schedules run scenes by time, sun and weather; the weather view works without the internet.
    client.check("GET", "/v1/weather", 200)
    timed = client.check("POST", "/v1/schedules", 201, body={
        "scene_id": scene["id"], "trigger": {"type": "time", "at": "06:45"}, "days": [0, 1, 2, 3, 4], "only_if": {"not_raining": True},
    })
    client.check("POST", "/v1/schedules", 201, body={"scene_id": scene["id"], "trigger": {"type": "sun", "event": "sunset", "offset": -30}, "days": [5, 6]})
    hot = client.check("POST", "/v1/schedules", 201, body={
        "scene_id": scene["id"], "trigger": {"type": "weather", "kind": "heat", "above": 30, "from": "12:00", "to": "20:00"}, "days": [0, 1, 2, 3, 4, 5, 6],
    })
    client.check("POST", "/v1/schedules", 400, body={"scene_id": scene["id"], "trigger": {"type": "time", "at": "25:00"}, "days": [0]})
    client.check("GET", "/v1/schedules", 200)
    client.check("GET", f"/v1/schedules/{timed['id']}", 200)
    client.check("GET", "/v1/schedules/deadbeef", 404)
    client.check("GET", "/v1/schedules/nothex", 400)
    client.check("PATCH", f"/v1/schedules/{timed['id']}", 200, body={"enabled": False, "version": 1})
    client.check("PATCH", f"/v1/schedules/{timed['id']}", 409, body={"enabled": True, "version": 1})
    client.check("PATCH", f"/v1/schedules/{timed['id']}", 400, body={"days": []})
    client.check("PATCH", "/v1/schedules/deadbeef", 404, body={"enabled": True})
    client.check("DELETE", f"/v1/scenes/{scene['id']}", 409)
    client.check("DELETE", f"/v1/schedules/{hot['id']}", 204)
    client.check("DELETE", f"/v1/schedules/{hot['id']}", 404)

    # The Jewish calendar (1.2.0) ships off, and the API says so: nothing is worked out, and
    # nothing that uses it can be set. Ordinary schedules run as usual on Shabbat.
    features = client.check("GET", "/v1/system", 200)["features"]
    if features.get("jewish_calendar") is not False:
        fail(f"GET /v1/system should show the Jewish calendar off: {features}")
    calendar = client.check("GET", "/v1/calendar", 200)
    if calendar != EXAMPLES["Calendar"]["off"]["value"]:
        fail(f"GET /v1/calendar while it is off should answer as Calendar.off in {EXAMPLES_FILE.name}: {calendar}")
    refused = [
        client.check("PATCH", "/v1/calendar/settings", 409, body={"candle_lighting_minutes": 30, "version": 1}),
        client.check("POST", "/v1/schedules", 409, body={
            "scene_id": scene["id"], "trigger": {"type": "shabbat", "event": "candle_lighting", "offset": -30}, "days": [0, 1, 2, 3, 4, 5, 6],
        }),
        client.check("POST", "/v1/schedules", 409, body={
            "scene_id": scene["id"], "trigger": {"type": "time", "at": "06:30"}, "days": [0, 1, 2, 3, 4], "during_shabbat": "skip",
        }),
    ]
    for answer in refused:
        if answer["code"] != "JEWISH_CALENDAR_OFF":
            fail(f"the calendar is off: expected JEWISH_CALENDAR_OFF, got {answer}")
    client.check("PATCH", "/v1/calendar/settings", 400, body={"havdalah_minutes": 10})
    ordinary = client.check("PATCH", f"/v1/schedules/{timed['id']}", 200, body={"during_shabbat": "run"})
    if (timed["during_shabbat"], timed["calendar_status"], ordinary["during_shabbat"]) != ("run", None, "run"):
        fail(f"an ordinary schedule runs as usual on Shabbat and has no calendar status: {ordinary}")

    created = client.check("POST", "/v1/api-keys", 201, body={"name": "second key"})
    client.check("POST", "/v1/api-keys", 400, body={"name": ""})
    client.check("GET", "/v1/api-keys", 200)
    client.check("GET", "/v1/api-keys/current", 200)
    client.check("PATCH", f"/v1/api-keys/{created['id']}", 200, body={"role": "viewer"})
    client.check("PATCH", f"/v1/api-keys/{created['id']}", 400, body={"role": "owner"})
    client.check("PATCH", "/v1/api-keys/deadbeef", 404, body={"role": "viewer"})
    me = client.check("GET", "/v1/api-keys/current", 200)
    if me.get("access", {}).get("role") != "admin" or me["access"].get("owner") is not True:
        fail(f"the first admin is the home's owner (ADR-054): {me}")
    client.check("PATCH", f"/v1/api-keys/{me['id']}", 409, body={"role": "member"})
    # Admins and members, per person (1.8.0, ADR-054). A viewer of 1.7.0 is a member with no rooms
    # and cameras only: what they may not see answers as what does not exist.
    person = created["profile_id"]
    access = client.check("GET", f"/v1/profiles/{person}/access", 200)
    if (access["role"], access["all_rooms"], access["rooms"], access["cameras"], access["alarm"]) != ("member", False, [], True, False):
        fail(f"a viewer of 1.7.0 should be a member with no rooms and cameras only: {access}")
    client.check("PATCH", f"/v1/profiles/{person}/access", 400, body={})
    client.check("PATCH", f"/v1/profiles/{person}/access", 400, body={"rooms": [999999]})
    client.check("PATCH", f"/v1/profiles/{person}/access", 400, body={"kinds": {"heater": True}})
    client.check("PATCH", f"/v1/profiles/{person}/access", 200, body={"scenes": []})
    client.check("PATCH", f"/v1/profiles/{me['profile_id']}/access", 409, body={"role": "member"})
    client.check("PATCH", "/v1/profiles/00000000/access", 404, body={"doors": True})
    if not any(item.get("access", {}).get("owner") for item in client.check("GET", "/v1/profiles", 200)["items"]):
        fail("GET /v1/profiles should say who the owner is")
    if client.check("PATCH", "/v1/rooms/10", 200, body={"hidden_from_members": True})["hidden_from_members"] is not True:
        fail("an admin hides a room from members")
    client.check("PATCH", "/v1/rooms/10", 200, body={"hidden_from_members": False})
    if client.check("GET", "/v1/system", 200)["features"].get("people_permissions") is not True:
        fail("GET /v1/system should say features.people_permissions")
    # Users and their devices (1.9.0, ADR-061): Settings → Users, five devices a user, a pairing
    # code for a chosen user, a suggestion that is not there.
    if client.check("GET", "/v1/system", 200)["features"].get("users") is not True:
        fail("GET /v1/system should say features.users")
    users = client.check("GET", "/v1/users", 200)
    if users["device_limit"] != 5 or not any(item["you"] and item["access"]["owner"] for item in users["items"]):
        fail(f"GET /v1/users should list the owner's own user, with five devices a user: {users}")
    extra = [client.check("POST", "/v1/api-keys", 201, body={"name": f"device {index}", "profile_id": person}) for index in range(4)]
    full = client.check("POST", "/v1/api-keys", 409, body={"name": "a sixth", "profile_id": person})
    if full["code"] != "USER_DEVICE_LIMIT" or len(full.get("devices", [])) != 5 or full["user"]["id"] != person:
        fail(f"a user's sixth device is refused with their devices: {full}")
    client.check("POST", "/v1/pairing-code", 409, body={"profile_id": person})
    for key in extra:
        client.check("DELETE", f"/v1/api-keys/{key['id']}", 204)
    paired_for = client.check("POST", "/v1/pairing-code", 201, body={"profile_id": person})
    if paired_for["user"]["id"] != person or paired_for["user"]["role"] != "member":
        fail(f"POST /v1/pairing-code should name the user it is for: {paired_for}")
    client.check("POST", "/v1/pairing-code", 201, body={"name": "Kitchen tablet", "role": "member", "access": {"all_rooms": False, "rooms": [10]}})
    client.check("POST", "/v1/pairing-code", 400, body={"profile_id": person, "name": "Two"})
    client.check("DELETE", "/v1/pairing-code", 204)
    client.check("DELETE", "/v1/pairing-code", 404)
    client.check("POST", "/v1/users/merge", 404, body={"account": "0123456789abcdef", "keep": person, "revision": "0123456789abcdef"})
    client.check("POST", "/v1/users/merge", 400, body={"account": "not a tag", "keep": person, "revision": "0123456789abcdef"})
    # Handing the home to another admin (1.9.0, ADR-064): only the owner, only to another admin; the
    # old owner stays an admin. This home never was in the account service: the controller's alone.
    if client.check("POST", "/v1/users/owner", 409, body={"profile_id": person})["code"] != "NOT_AN_ADMIN":
        fail("a member is made an admin before becoming the home's owner")
    client.check("POST", "/v1/users/owner", 409, body={"profile_id": me["profile_id"]})
    client.check("POST", "/v1/users/owner", 404, body={"profile_id": "0000aaaa"})
    client.check("POST", "/v1/users/owner", 400, body={"profile_id": "Dana"})
    partner = client.check("POST", "/v1/api-keys", 201, body={"name": "partner", "role": "admin"})
    handed = client.check("POST", "/v1/users/owner", 200, body={"profile_id": partner["profile_id"]})
    if (handed["owner"]["id"], handed["previous"]["id"], handed["account_service"]) != (partner["profile_id"], me["profile_id"], "not_linked"):
        fail(f"POST /v1/users/owner should name the new owner and the old one: {handed}")
    old_owner = client.check("GET", "/v1/api-keys/current", 200)["access"]
    if old_owner["role"] != "admin" or old_owner["owner"] is not False:
        fail(f"the old owner stays an admin, and is no longer the owner: {old_owner}")
    if client.check("POST", "/v1/users/owner", 403, body={"profile_id": me["profile_id"]})["code"] != "OWNER_ONLY":
        fail("only the home's owner makes someone else the owner")
    owner_key, client.key = client.key, partner["key"]
    client.check("POST", "/v1/users/owner", 200, body={"profile_id": me["profile_id"]})
    client.key = owner_key
    client.check("DELETE", f"/v1/api-keys/{partner['id']}", 204)
    admin_key, client.key = client.key, created["key"]
    mine = client.check("GET", "/v1/users", 200)
    if [item["id"] for item in mine["items"]] != [person] or mine["suggestions"]:
        fail(f"a member sees only their own user, and no suggestion: {mine}")
    client.check("POST", "/v1/pairing-code", 403, body={"profile_id": person})
    client.check("DELETE", f"/v1/api-keys/{me['id']}", 404)
    client.check("POST", "/v1/users/merge", 403, body={"account": "0123456789abcdef", "keep": person, "revision": "0123456789abcdef"})
    client.check("POST", "/v1/users/owner", 403, body={"profile_id": person})
    if client.check("GET", "/v1/lights", 200)["items"]:
        fail("a member with no rooms sees no light")
    client.check("PATCH", "/v1/lights/20", 404, body={"on": True})
    client.check("GET", "/v1/fans", 200)
    client.check("PATCH", "/v1/fans/41", 404, body={"on": False})
    client.check("GET", "/v1/refrigerators/141", 404)
    client.check("PATCH", "/v1/refrigerators/141", 404, body={"sabbath_mode": False})
    client.check("POST", "/v1/relays/70/pulse", 404)
    if client.check("GET", "/v1/alarm", 403)["code"] != "FORBIDDEN":
        fail("a member not given the alarm must not read it")
    # Music, a kind a member is given in their rooms; placing a Sonos room is the admins'.
    client.check("GET", "/v1/music", 200)
    client.check("GET", f"/v1/music/{KITCHEN}/favorites", 404)
    client.check("POST", f"/v1/music/{KITCHEN}/pause", 404)
    client.check("PATCH", f"/v1/music/{KITCHEN}", 404, body={"volume": 5})
    client.check("POST", f"/v1/music/{KITCHEN}/favorites/10/play", 404)
    client.check("PUT", f"/v1/music/{KITCHEN}/room", 403, body={"room_id": 10})
    client.check("GET", "/v1/api-keys", 403)
    client.check("GET", "/v1/profiles", 403)
    client.check("GET", f"/v1/profiles/{person}/access", 403)
    client.check("GET", "/v1/activity", 403)
    client.check("PUT", "/v1/rooms/order", 403, body={"room_ids": [10]})
    client.check("PATCH", "/v1/rooms/10", 403, body={"hidden_from_members": True})
    client.check("GET", "/v1/profile", 200)
    if client.check("GET", "/v1/scenes", 200)["items"]:
        fail("a member lists only the scenes chosen for them")
    client.check("POST", f"/v1/scenes/{scene['id']}/run", 404)
    client.check("POST", "/v1/scenes", 403, body={"name": "Mine"})
    client.check("PATCH", f"/v1/scenes/{scene['id']}", 403, body={"name": "Mine"})
    client.check("DELETE", f"/v1/scenes/{scene['id']}", 403)
    client.check("POST", "/v1/scenes/try", 403, body={"steps": []})
    client.check("POST", "/v1/off", 400, body={"type": "lights", "device_ids": [20]})
    client.check("GET", "/v1/schedules", 403)
    client.check("GET", "/v1/weather", 200)
    client.check("POST", "/v1/schedules", 403, body={"scene_id": scene["id"], "trigger": {"type": "time", "at": "06:45"}, "days": [0]})
    client.check("PATCH", f"/v1/schedules/{timed['id']}", 403, body={"enabled": True})
    client.check("DELETE", f"/v1/schedules/{timed['id']}", 403)
    client.check("GET", "/v1/calendar", 200)
    client.check("PATCH", "/v1/calendar/settings", 403, body={"havdalah_minutes": 50})
    # Each key its own alert choices (1.7.0, ADR-050): among what its person may get (ADR-054).
    choices = client.check("GET", "/v1/alerts/choices", 200)
    if choices != {"on": False, "kinds": {}}:
        fail(f"a member with no rooms has no alert to choose: {choices}")
    choices = client.check("PUT", "/v1/alerts/choices", 200, body={"on": True, "kinds": {"door_opened": True}})
    if choices != {"on": True, "kinds": {}}:
        fail(f"a member cannot choose the doors opened: {choices}")
    client.check("PUT", "/v1/alerts/choices", 400, body={"kinds": {"lights": True}})
    client.check("PUT", "/v1/alerts/choices", 400, body={})
    client.check("DELETE", "/v1/api-keys/current", 204)
    client.check("GET", "/v1/lights", 401)
    client.key = admin_key
    client.check("DELETE", f"/v1/api-keys/{created['id']}", 404)
    client.check("DELETE", "/v1/api-keys/deadbeef", 404)

    client.check("PATCH", "/v1/logs/settings", 200, body={"level": "debug"})
    client.check("GET", "/v1/logs/settings", 200)
    client.check("GET", "/v1/logs?category=api&limit=50", 200)
    client.check("GET", "/v1/logs?level=loud", 400)
    client.check("PATCH", "/v1/logs/settings", 400, body={"level": "verbose"})
    client.check("GET", "/v1/logs", 401, auth=False)

    # The installer turns the Jewish calendar on in Composer. The fake project is in Tel Aviv, so
    # the answer has Shabbat and holiday times, worked out on the controller; settings change with
    # a version, and schedules may use the calendar.
    bridge.set_property("Jewish Calendar", "On")
    features = client.check("GET", "/v1/system", 200)["features"]
    if features.get("jewish_calendar") is not True:
        fail(f"GET /v1/system should show the Jewish calendar on: {features}")
    calendar = client.check("GET", "/v1/calendar", 200)
    if (calendar["enabled"], calendar["status"], calendar["settings"]["israel"]) != (True, "ok", True) or not calendar["next"]:
        fail(f"GET /v1/calendar in Tel Aviv with the calendar on should have Israel's times: {calendar}")
    settings = client.check("PATCH", "/v1/calendar/settings", 200, body={"candle_lighting_minutes": 30, "havdalah_minutes": 50, "version": 1})
    stale = client.check("PATCH", "/v1/calendar/settings", 409, body={"holidays": "abroad", "version": 1})
    if (stale["code"], stale.get("version")) != ("VERSION_CONFLICT", settings["version"]):
        fail(f"a settings change with an old version should be VERSION_CONFLICT with the current one: {stale}")
    client.check("PATCH", "/v1/calendar/settings", 400, body={"holidays": "mars"})
    shabbat = client.check("POST", "/v1/schedules", 201, body={
        "scene_id": scene["id"], "trigger": {"type": "shabbat", "event": "candle_lighting", "offset": -30}, "days": [0, 1, 2, 3, 4, 5, 6],
    })
    client.check("POST", "/v1/schedules", 201, body={
        "scene_id": scene["id"], "trigger": {"type": "time", "at": "06:30"}, "days": [0, 1, 2, 3, 4, 5, 6], "during_shabbat": "skip",
    })
    client.check("POST", "/v1/schedules", 400, body={
        "scene_id": scene["id"], "trigger": {"type": "shabbat", "event": "havdalah"}, "days": [0, 1, 2, 3, 4, 5, 6], "during_shabbat": "only",
    })
    if (shabbat["calendar_status"], shabbat["next_run"] is not None) != ("ok", True):
        fail(f"a Shabbat schedule with the calendar on should run next at candle lighting: {shabbat}")
    client.check("GET", "/v1/schedules", 200)
    viewer = client.check("POST", "/v1/api-keys", 201, body={"name": "calendar viewer", "role": "viewer"})
    admin_key, client.key = client.key, viewer["key"]
    client.check("GET", "/v1/calendar", 200)
    client.check("PATCH", "/v1/calendar/settings", 403, body={"havdalah_minutes": 50})
    client.key = admin_key
    client.check("DELETE", f"/v1/api-keys/{viewer['id']}", 204)

    # Backups (1.4.0, ADR-042): for admins, only in sealed requests. The document goes back in parts,
    # is checked (nothing changes) and restored: here the one just made, so the fake home stays as it is.
    # GET /v1/system says the driver has them (the app shows Backup only then).
    if client.check("GET", "/v1/system", 200)["features"].get("backup") is not True:
        fail("GET /v1/system should say features.backup true: the app shows Backup only then")
    clear = client.check("GET", "/v1/backup", 403)
    if clear["code"] != "SEALED_REQUEST_REQUIRED":
        fail(f"GET /v1/backup in the clear should be refused with SEALED_REQUEST_REQUIRED: {clear}")
    document = client.check_sealed(bridge, "GET", "/v1/backup", 200)
    if not document["sections"]["scenes"]["scenes"] or document["sections"]["keys"]["keys"][0].get("hash") is None:
        fail(f"GET /v1/backup should hold the scenes and the keys' hashes: {sorted(document['sections'])}")
    text = json.dumps(document)
    half = len(text) // 2
    client.check("POST", "/v1/restore/parts", 403, body={"index": 0, "count": 1, "text": text})
    first = client.check_sealed(bridge, "POST", "/v1/restore/parts", 200, body={"index": 0, "count": 2, "text": text[:half]})
    upload = first["upload"]
    client.check_sealed(bridge, "POST", "/v1/restore/parts", 400, body={"upload": upload, "index": 2, "count": 2, "text": "x"})
    client.check_sealed(bridge, "POST", "/v1/restore/parts", 404, body={"upload": "0" * 16, "index": 1, "count": 2, "text": "x"})
    if client.check_sealed(bridge, "POST", "/v1/restore", 409, body={"upload": upload})["code"] != "UPLOAD_INCOMPLETE":
        fail("POST /v1/restore with a part still to come should be UPLOAD_INCOMPLETE")
    client.check_sealed(bridge, "POST", "/v1/restore/parts", 200, body={"upload": upload, "index": 1, "count": 2, "text": text[half:]})
    check = client.check_sealed(bridge, "POST", "/v1/restore", 200, body={"upload": upload})
    counts = check["restore"]["counts"]
    if (check["dry_run"], counts["scenes"], check["restore"]["keys"]["yours"], check["restore"]["references"]["unmatched_count"]) != (
            True, len(document["sections"]["scenes"]["scenes"]), "kept", 0):
        fail(f"POST /v1/restore should check the backup just made without a change: {check}")
    client.check_sealed(bridge, "POST", "/v1/restore", 422, body={"document": {"format": "something else"}})
    client.check_sealed(bridge, "POST", "/v1/restore", 409, body={"document": dict(document, format_version=99)})
    client.check_sealed(bridge, "POST", "/v1/restore", 404, body={"upload": "0" * 16})
    client.check_sealed(bridge, "POST", "/v1/restore", 400, body={"upload": upload, "dry_run": "yes"})
    client.check("POST", "/v1/restore", 403, body={"upload": upload})
    restored = client.check_sealed(bridge, "POST", "/v1/restore", 200, body={"upload": upload, "dry_run": False})
    if restored["dry_run"] is not False or not restored.get("restored_at"):
        fail(f"POST /v1/restore with dry_run false should restore: {restored}")
    client.check("GET", "/v1/scenes", 200)

    # The history (1.6.0, ADR-046): what this scenario did, newest first, for admins; in pages, by
    # kind, in the clear (the console) and sealed (the app).
    history = client.check("GET", "/v1/activity?limit=200", 200)
    kinds = {item["kind"] for item in history["items"]}
    if not {"scene", "door", "access", "composer", "system"} <= kinds:
        fail(f"GET /v1/activity should have scenes, doors, keys, Composer settings and the backup: {sorted(kinds)}")
    if not any(item["action"] == "left_open" for item in history["items"]):
        fail("GET /v1/activity should list the refrigerator door left open")
    restored = next((item for item in history["items"] if item["action"] == "restore"), None)
    if not restored or restored["who"]["type"] != "key" or restored.get("from") != document["created_at"]:
        fail(f"GET /v1/activity should say who restored which backup: {restored}")
    page = client.check("GET", "/v1/activity?kind=door,scene&limit=2", 200)
    if len(page["items"]) != 2 or not page["next_before"] or {item["kind"] for item in page["items"]} - {"door", "scene"}:
        fail(f"GET /v1/activity?kind=door,scene&limit=2 should give two of them and where to go on: {page}")
    after = client.check("GET", f"/v1/activity?kind=door,scene&limit=2&before={page['next_before']}", 200)
    if after["items"][0]["id"] >= page["items"][-1]["id"]:
        fail(f"the next page should start before the last entry shown: {after}")
    client.check("GET", "/v1/activity?kind=lights", 400)
    client.check("GET", "/v1/activity?before=0", 400)
    client.check("GET", "/v1/activity", 401, auth=False)
    sealed = client.check_sealed(bridge, "GET", "/v1/activity?kind=access&limit=5", 200)
    if not sealed["items"] or {item["kind"] for item in sealed["items"]} != {"access"}:
        fail(f"a sealed GET /v1/activity?kind=access should list keys paired and changed: {sealed}")

    # Automatic backups to the account (1.6.0, ADR-048): the backup password's public key, set and
    # read in sealed requests only; Back up now needs Remote Access, which is off here, and so does
    # the night's backup, which the history then lists as not made.
    if client.check("GET", "/v1/system", 200)["features"].get("alert_choices") is not True:
        fail("GET /v1/system should say features.alert_choices true: the app offers alert choices only then")
    choices = client.check_sealed(bridge, "PUT", "/v1/alerts/choices", 200, body={"on": True, "kinds": {"door_opened": True}})
    if not choices["on"] or choices["kinds"].get("door_opened") is not True or choices["kinds"].get("schedule_failed") is not True:
        fail(f"an admin chooses the doors opened, and keeps schedules: {choices}")
    client.check("GET", "/v1/alerts/choices", 401, auth=False)
    if client.check("GET", "/v1/system", 200)["features"].get("automatic_backup") is not True:
        fail("GET /v1/system should say features.automatic_backup true: the app shows the section only then")
    if client.check("GET", "/v1/backup/automatic", 200)["enabled"] is not False:
        fail("automatic backups should be off until a backup password is set")
    backup_key = {"public_key": base64.b64encode(x25519_public(os.urandom(32))).decode(), "salt": base64.b64encode(os.urandom(16)).decode(), "iterations": 600000, "kdf": "PBKDF2-SHA-256"}
    client.check("PUT", "/v1/backup/automatic", 403, body=backup_key)
    client.check_sealed(bridge, "PUT", "/v1/backup/automatic", 400, body=dict(backup_key, iterations=10))
    automatic = client.check_sealed(bridge, "PUT", "/v1/backup/automatic", 200, body=backup_key)
    if not automatic["enabled"] or automatic["key"]["public_key"] != backup_key["public_key"]:
        fail(f"PUT /v1/backup/automatic should turn automatic backups on with the key: {automatic}")
    clear = client.check("GET", "/v1/backup/automatic", 200)
    if not clear["enabled"] or clear["key"]["key_id"] != automatic["key"]["key_id"] or {"public_key", "salt", "iterations", "kdf"} & set(clear["key"]):
        fail(f"GET /v1/backup/automatic in the clear should give the key's id, never what checks a guessed password: {clear['key']}")
    if client.check_sealed(bridge, "GET", "/v1/backup/automatic", 200)["key"] != automatic["key"]:
        fail("a sealed GET /v1/backup/automatic should give the whole key, as PUT does")
    if client.check("POST", "/v1/backup/automatic/run", 409)["code"] != "REMOTE_ACCESS_OFF":
        fail("Back up now with Remote Access off should be REMOTE_ACCESS_OFF")
    hour, minute = (int(part) for part in automatic["time"].split(":"))
    bridge.tick(time.mktime(datetime.datetime.now().replace(hour=hour, minute=minute, second=30, microsecond=0).timetuple()))
    night = client.check("GET", "/v1/activity?kind=system&limit=5", 200)["items"][0]
    if (night["action"], night.get("outcome"), night.get("reason"), night["who"]["type"]) != ("cloud_backup", "failed", "remote_off", "controller"):
        fail(f"GET /v1/activity should list the night's backup as not made, with Remote Access off: {night}")
    if client.check("GET", "/v1/backup/automatic", 200)["last"]["code"] != "REMOTE_ACCESS_OFF":
        fail("GET /v1/backup/automatic should say why the night's backup was not made")
    client.check("DELETE", "/v1/backup/automatic", 403)
    client.check_sealed(bridge, "DELETE", "/v1/backup/automatic", 204)
    if client.check("POST", "/v1/backup/automatic/run", 409)["code"] != "AUTOMATIC_BACKUP_OFF":
        fail("Back up now with automatic backups off should be AUTOMATIC_BACKUP_OFF")

    # Scene links (ADR-051): admins make one per scene, shown once; never for a scene that opens
    # doors or gates; only with Remote Access on and the home linked (the dev bridge marks it so).
    if client.check("GET", "/v1/system", 200)["features"].get("scene_links") is not True:
        fail("GET /v1/system should say features.scene_links true: the app shows scene links only then")
    arriving = client.check("POST", "/v1/scenes", 201, body={"name": "Arriving", "steps": [{"type": "lights", "device_ids": [20], "set": {"on": True}}]})
    link_path = f"/v1/scenes/{arriving['id']}/link"
    links = client.check("GET", "/v1/scene-links", 200)
    if links["remote_access"] or links["home_linked"] or links["items"]:
        fail(f"GET /v1/scene-links should say Remote Access is off and the home not linked, with no links: {links}")
    if client.check("POST", link_path, 409, body={"label": "Arriving home"})["code"] != "REMOTE_ACCESS_OFF":
        fail("a scene link with Remote Access off should be REMOTE_ACCESS_OFF")
    client.check("GET", link_path, 404)
    client.check("DELETE", link_path, 404)
    home_id = bridge.link_home()
    made = client.check("POST", link_path, 201, body={"label": "Arriving home"})
    if made["url"] != f"https://api.directorlink.io/run/{home_id}.{made['link_id']}#{made['secret']}" or made["replaced"]:
        fail(f"POST {link_path} should give the link's address with the secret after #: {made}")
    if client.check("POST", link_path, 201)["replaced"] is not True:
        fail(f"POST {link_path} again should replace the link")
    if made["secret"] in json.dumps(client.check("GET", "/v1/scene-links", 200)) or "secret" in client.check("GET", link_path, 200):
        fail("a scene link's secret is shown only when it is made")
    client.check("POST", link_path, 400, body={"secret": made["secret"]})
    gate = client.check("POST", "/v1/scenes", 201, body={"name": "Gate", "steps": [{"type": "relays", "device_ids": [70], "set": {"action": "pulse"}}]})
    if client.check("POST", f"/v1/scenes/{gate['id']}/link", 409)["code"] != "SCENE_OPENS_DOORS":
        fail("a scene that opens doors or gates should never get a link")
    client.check("POST", "/v1/scenes/deadbeef/link", 404)
    # A store that could not be read is not written: changes answer 503 until it can be.
    if bridge.scene_links_unreadable(True):
        fail("the dev bridge should have made the scene links' store unreadable")
    for method in ("POST", "DELETE"):
        if client.check(method, link_path, 503)["code"] != "UNAVAILABLE":
            fail(f"{method} {link_path} with the store unreadable should be 503 UNAVAILABLE")
    if not bridge.scene_links_unreadable(False):
        fail("the scene links' store should be readable again")
    client.check("DELETE", link_path, 204)
    client.check("GET", "/v1/scene-links", 401, auth=False)

    # Ask to open (ADR-058): a link for a door that asks its person, never opens; the secret once.
    if client.check("GET", "/v1/system", 200)["features"].get("ask_links") is not True:
        fail("GET /v1/system should say features.ask_links true: the app shows ask-to-open links only then")
    asks = client.check("GET", "/v1/ask-links", 200)
    if asks["items"] or not asks["home_linked"] or not asks["door_control"]:
        fail(f"GET /v1/ask-links should list none, with the home linked and Door Control on: {asks}")
    ask = client.check("POST", "/v1/ask-links", 201, body={"relay_id": 70, "label": "Arriving home"})
    if ask["url"] != f"https://api.directorlink.io/run/{home_id}.{ask['link_id']}#{ask['secret']}" or ask["relay_name"] is None or ask["replaced"]:
        fail(f"POST /v1/ask-links should give the link's address with the secret after #: {ask}")
    if ask["secret"] in json.dumps(client.check("GET", "/v1/ask-links", 200)):
        fail("an ask-to-open link's secret is shown only when it is made")
    client.check("POST", "/v1/ask-links", 404, body={"relay_id": 20})
    client.check("POST", "/v1/ask-links", 400, body={"relay_id": 70, "secret": ask["secret"]})
    client.check("DELETE", f"/v1/ask-links/{ask['link_id']}", 204)
    client.check("DELETE", f"/v1/ask-links/{ask['link_id']}", 404)
    client.check("GET", "/v1/ask-links", 401, auth=False)
    # A home the account service knows changes owner only once it agrees: here no relay answers.
    partner = client.check("POST", "/v1/api-keys", 201, body={"name": "partner", "role": "admin"})
    if client.check("POST", "/v1/users/owner", 503, body={"profile_id": partner["profile_id"]})["code"] != "REMOTE_OFFLINE":
        fail("a linked home whose account service does not answer keeps its owner (503 REMOTE_OFFLINE)")
    if client.check("GET", "/v1/api-keys/current", 200)["access"]["owner"] is not True:
        fail("the owner stays the owner when the account service did not agree")
    client.check("DELETE", f"/v1/api-keys/{partner['id']}", 204)
    bridge.set_property("Remote Access", "Off")

    # Sealed requests on the home network: what sealing needs, and refusals (the driver's own tests
    # open real ones). Pairing with a key exchange answers sealed.
    info = client.check("GET", "/v1/sealed", 200, auth=False)
    stray = {"v": 1, "home": info["home"], "key": "deadbeef", "iv": "AAAAAAAAAAAAAAAAAAAAAA==", "ct": "AAAAAAAAAAAAAAAAAAAAAA==", "mac": "A" * 43 + "="}
    client.check("POST", "/v1/sealed", 401, body={"envelope": stray}, auth=False)
    client.check("POST", "/v1/sealed", 400, body={"envelope": "not an envelope", "extra": 1}, auth=False)
    bridge.new_pairing_code()
    exchange = {"public_key": base64.b64encode(x25519_public(os.urandom(32))).decode()}
    client.check("POST", "/v1/auth/pair", 201, body={"pairing_code": bridge.pairing_code, "name": "sealed pairing", "exchange": exchange}, auth=False)

    # Pairing with CPace (ADR-039): the code never goes to the controller; the key, for a day here,
    # comes back sealed with the exchange's key. A wrong tag is a wrong code; an exchange works once.
    bridge.new_pairing_code()
    b64 = lambda data: base64.b64encode(data).decode()
    nonce = os.urandom(16)
    started = client.check("POST", "/v1/auth/pair", 200, body={"name": "cpace", "expires_in": 86400, "cpace": {"nonce": b64(nonce)}}, auth=False)
    sid = nonce + base64.b64decode(started["cpace"]["nonce"])
    share, tag, controller_tag, isk = cpace_client(bridge.pairing_code.replace(" ", ""), "cpace", 86400, sid, base64.b64decode(started["cpace"]["share"]))
    finish = {"cpace": {"session": started["cpace"]["session"], "share": b64(share), "confirm": b64(tag)}}
    paired = client.check("POST", "/v1/auth/pair", 201, body=finish, auth=False)
    if base64.b64decode(paired["cpace"]["confirm"]) != controller_tag:
        fail("POST /v1/auth/pair (CPace): the controller's tag is not the one the exchange gives")
    created = bridge.open_pairing(isk, paired["sealed"])
    errors = list(Draft202012Validator(absolute({"$ref": "#/components/schemas/NewApiKey"}), registry=REGISTRY).iter_errors(created))
    if errors or not created.get("expires_at"):
        fail(f"POST /v1/auth/pair (CPace): the sealed key does not match NewApiKey, with expires_at: {created!r}")
    client.check("POST", "/v1/auth/pair", 409, body=finish, auth=False)  # works once
    bridge.new_pairing_code()
    started = client.check("POST", "/v1/auth/pair", 200, body={"cpace": {"nonce": b64(nonce)}}, auth=False)
    wrong = {"cpace": {"session": started["cpace"]["session"], "share": b64(share), "confirm": b64(bytes(64))}}
    client.check("POST", "/v1/auth/pair", 403, body=wrong, auth=False)

    # Last, because it locks pairing for a minute.
    bridge.new_pairing_code()
    for _ in range(4):
        client.check("POST", "/v1/auth/pair", 403, body={"pairing_code": "00000000"})
    client.check("POST", "/v1/auth/pair", 429, body={"pairing_code": "00000000"})


def fahrenheit_scenario(client, bridge):
    """A US home (dev_server.py --fahrenheit, 1.10.2, ADR-076): thermostats in °F with their `*_f`
    fields, a Nest's heat and cool setpoints, a temperature sensor, and the project's scale."""
    paired = client.check("POST", "/v1/auth/pair", 201, body={"pairing_code": bridge.pairing_code, "name": "contract test"})
    client.key, client.key_id = paired["key"], paired["id"]
    system = client.check("GET", "/v1/system", 200)
    if system.get("temperature_scale") != "F":
        fail("GET /v1/system: a °F project's temperature_scale is not F")
    listed = client.check("GET", "/v1/thermostats", 200)
    if any(item["id"] == 37 for item in listed["items"]):
        fail("GET /v1/thermostats lists the weather driver")
    minisplit = client.check("GET", "/v1/thermostats/33", 200)
    if minisplit.get("target_temperature_f") != 69 or minisplit.get("current_temperature_f") != 74:
        fail(f"GET /v1/thermostats/33: not 69 °F set and 74 °F now: {minisplit}")
    client.check("PATCH", "/v1/thermostats/33", 202, body={"target_temperature_f": 70})
    client.check("PATCH", "/v1/thermostats/33", 400, body={"target_temperature_f": 120})
    client.check("PATCH", "/v1/thermostats/33", 400, body={"target_temperature": 21, "target_temperature_f": 70})
    client.check("GET", "/v1/thermostats/34", 200)
    client.check("PATCH", "/v1/thermostats/34", 202, body={"mode": "auto", "heat_setpoint_f": 66, "cool_setpoint_f": 74})
    sensor = client.check("GET", "/v1/thermostats/36", 200)
    if sensor.get("sensor") is not True or sensor.get("humidity") != 30:
        fail(f"GET /v1/thermostats/36: not a sensor with its humidity: {sensor}")
    client.check("PATCH", "/v1/thermostats/36", 409, body={"mode": "heat"})
    client.check("GET", "/v1/thermostats/37", 404)


def main():
    examples = check_examples()
    lua = shutil.which("lua5.1") or shutil.which("lua")
    if not lua:
        fail("Lua 5.1 is required")
    node = shutil.which("node")
    if not node:
        fail("Node.js is required (the fake Sonos players, tests/sonos/fake-sonos.mjs)")
    # Fake Sonos players on a free port; the driver reaches them through the dev bridge.
    players = subprocess.Popen([node, "tests/sonos/fake-sonos.mjs", "--port", "0"], cwd=ROOT, stdout=subprocess.PIPE, text=True)
    started = players.stdout.readline().strip()
    if not started.startswith("FAKE SONOS "):
        players.terminate()
        fail(f"the fake Sonos players did not start: {started!r}")
    spec_json = ROOT / "dist" / "openapi.json"
    bridge = dev_server.Bridge(lua, spec_json if spec_json.is_file() else None, int(started.split()[-1]), agreement=True, doors=True)
    server = dev_server.Server(("127.0.0.1", 0), dev_server.make_handler(bridge))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    client = Client(server.server_address[1])
    try:
        scenario(client, bridge)
    finally:
        server.shutdown()
        bridge.process.terminate()
        players.terminate()

    # The same API in a °F project (1.10.2): its own fake Director, the same coverage.
    bridge = dev_server.Bridge(lua, spec_json if spec_json.is_file() else None, fahrenheit=True)
    server = dev_server.Server(("127.0.0.1", 0), dev_server.make_handler(bridge))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    us = Client(server.server_address[1])
    try:
        fahrenheit_scenario(us, bridge)
    finally:
        server.shutdown()
        bridge.process.terminate()
    client.covered |= us.covered
    client.checked += us.checked

    missing = sorted({(op[0], op[1]) for op in OPERATIONS} - client.covered)
    if missing:
        fail("operations never exercised: " + ", ".join(f"{m} {p}" for m, p in missing))
    print(f"OK: {client.checked} responses match the API spec; all {len(OPERATIONS)} operations covered; {examples} calendar examples match it")


if __name__ == "__main__":
    main()
