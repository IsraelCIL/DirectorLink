#!/usr/bin/env python3
"""Serves the real DirectorLink driver on localhost against a fake Director.

The driver runs in Lua 5.1 with driver/tests/c4mock.lua standing in for Director, so the app
and API clients can be developed without a controller:

    python scripts/build.py                        # optional: serve the real API description
    python scripts/dev_server.py                   # API on http://localhost:41999
    python -m http.server 8080 --directory app     # app; use "localhost" as the controller

The fake project has two rooms; five lights (two of them older Light proxies), plus an older light
that cannot be read and is listed as unsupported; four thermostats in °C (an AC zone, a Control4
thermostat with heat and cool setpoints, floor heating set through its heat setpoint, and a floor
zone that reports no room temperature); two fans (one on at Medium, one off), which follow their
commands; two blinds, two cameras and a door relay.
With --fahrenheit (1.10.2, ADR-076) the project is a US home's instead: Composer's temperature scale
and every thermostat in °F, with the thermostats of GitHub issue #75: 33 "Living Room Minisplit"
(74 °F now, 69 °F set), 34 "Hallway" (a Nest: heat and cool setpoints, no single one), 36
"Bathroom" (a temperature and humidity reading with nothing to set) and 37 "Weather Driver" (an
outdoor weather driver on the thermostat proxy, left out).
Two more shades report their movement as KNX blinds do (one of them only opens and closes fully),
and every blind moves over some seconds, reported while the requests come in.
A Samsung refrigerator in the kitchen (its driver is device 140, with the variables of the
Samsung Refrigerator (DirectorLink) driver 1.0.0) follows its feature commands 4 seconds later, as
the refrigerator confirms them through Samsung's cloud; "var 140 1006 1" opens its door and
"event 140 15" is its driver's Door Left Open.
An alarm panel has two partitions (House, disarmed with a zone open; Garage, armed away) and a third
it does not use; Alarm Status is On in this fake home. Type "alarm off" or "alarm on" to switch it
as in Composer, and "var <device id> <variable id> <value>" for a partition to report a change
(e.g. "var 80 1007 ENTRY_DELAY"; the variables are listed in driver/tests/c4mock.lua).
The pairing code is printed at start (valid 15 minutes, works once); type "code" and Enter for a new
one, as the Composer action New Pairing Code would.
The Jewish calendar is Off, as it ships; --jewish-calendar starts with it On (the fake project is in
Tel Aviv, so there are Shabbat and holiday times for the app's screens), and "calendar on" or
"calendar off" switches it as in Composer.
Sonos is Off, as it ships. With fake Sonos players running (node tests/sonos/fake-sonos.mjs, port
8212), --sonos 8212 starts with it On: the driver finds them and talks to them through this server.
"sonos on" or "sonos off" switches it as in Composer.
With --cameras N (1.8.0, ADR-055 and ADR-056), the two plain cameras are N cameras on the
DirectorLink · Hikvision Camera driver (ids 601 on, their drivers 701 on), and every camera's
picture comes from fake cameras here, as from real ones: a digest login (a new nonce at each 401,
each nonce's counts taken in order only, as Hikvision does), --camera-ms for a picture (the
challenge takes a fifth of it; larger pictures three times as long), and a picture of about a real
camera's size. "alert <driver id> <label>" makes a camera's driver raise an alert (e.g. "alert 701
Person"); "stats" says how many requests the fake cameras got.
With --agreement-cameras (1.10.0, ADR-065), two cameras whose drivers follow DirectorLink's camera
agreement join the project: 67 "Porch" (a camera, driver 157) and 68 "Entrance" (a doorbell, driver
158, listed with the doorbells). "alert 157 Animal" raises an alert by the event named Alert, and
"ring 158" rings the doorbell camera (LAST_RING, then the event named Ring). --latency MS delays every request and
answer by half of MS each way, as the account's relay does (its round trip).
With --door-controllers (1.10.0, ADR-069), Control4's Relay Door, Gate and Garage Door Controllers
join the project: 71 "Main Gate" (a gate whose controller, driver 161, drives the DoorBird's relay
and has a contact), 72 "Garage Door" (driver 162, two relays, no contact), the KNX relay 75 "Back Door
Relay" as the door of controller 163, and 74 "Side Gate" (nothing bound, not listed). "event 161 1"
is the gate's controller saying Opened, "event 161 2" Closed, "event 161 3" Partial.
With both --agreement-cameras and --door-controllers (1.11.0, ADR-078), the doorbell camera 68
"Entrance" has its gate: 76 "Entrance Gate", a Relay Gate Controller (driver 166) whose Open relay is
bound to the doorbell's driver 158, as the owner's gate is bound to his DoorBird's relay; "ring 158"
then shows the Entrance's ring with "Open Entrance Gate".
"""

import argparse
import base64
import hashlib
import json
import queue
import re
import secrets
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


class FakeCameras:
    """Camera web servers answering the driver's picture requests later, on threads."""

    # Bytes of a picture by the width asked for, about what a camera's JPEG of that size weighs.
    SIZES = {320: 18000, 640: 45000, 1280: 160000, 1920: 300000}

    def __init__(self, picture_ms):
        self.picture_ms = picture_ms
        self.lock = threading.Lock()
        # Address -> { nonce -> highest count taken }.
        self.nonces = {}
        self.counts = {"requests": 0, "challenges": 0, "pictures": 0, "refused": 0}

    def stats(self):
        with self.lock:
            return dict(self.counts)

    def _challenge(self, host, stale=False):
        nonce = secrets.token_hex(16)
        self.nonces.setdefault(host, {})[nonce] = 0
        self.counts["challenges"] += 1
        text = f'Digest realm="IP Camera(fake)", qop="auth", nonce="{nonce}", opaque="dl-fake", algorithm=MD5'
        return {"code": 401, "headers": {"WWW-Authenticate": text + (", stale=TRUE" if stale else "")}, "body_hex": ""}

    def _digest_ok(self, host, path, header, login):
        fields = dict(re.findall(r'(\w+)="([^"]*)"', header))
        fields.update({key: value for key, value in re.findall(r"(\w+)=([^\",\s]+)", header) if key not in fields})
        md5 = lambda text: hashlib.md5(text.encode()).hexdigest()
        known = self.nonces.get(host, {})
        nonce = fields.get("nonce")
        if nonce not in known or fields.get("uri") != path:
            return False
        ha1 = md5(f"{login['username']}:IP Camera(fake):{login['password']}")
        ha2 = md5(f"GET:{path}")
        expected = md5(f"{ha1}:{nonce}:{fields.get('nc')}:{fields.get('cnonce')}:auth:{ha2}")
        try:
            count = int(fields.get("nc", ""), 16)
        except ValueError:
            return False
        # Each count once and in order, as Hikvision takes them.
        if fields.get("response") != expected or count <= known[nonce]:
            return False
        known[nonce] = count
        return True

    @staticmethod
    def _picture(name, width, size):
        height = width * 9 // 16
        stamp = time.strftime("%H:%M:%S")
        hue = sum(name.encode()) * 37 % 360
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 320 180">'
            f'<rect width="320" height="180" fill="hsl({hue},35%,32%)"/>'
            f'<circle cx="250" cy="45" r="22" fill="hsl({(hue + 40) % 360},60%,70%)"/>'
            f'<path d="M0 150 L80 95 L150 140 L220 80 L320 150 L320 180 L0 180 Z" fill="hsl({(hue + 180) % 360},30%,22%)"/>'
            f'<text x="12" y="24" font-family="sans-serif" font-size="15" fill="#fff">{name}</text>'
            f'<text x="12" y="168" font-family="monospace" font-size="13" fill="#fff">{stamp} · {width}px</text>'
            "</svg>"
        )
        padding = max(0, size - len(svg) - 9)
        return (svg + "<!--" + "." * padding + "-->").encode()

    def answer(self, asked):
        """(seconds to wait, answer) for one request: { url, headers, login, name }."""
        url = urlparse(asked["url"])
        host, path = url.hostname, url.path + (f"?{url.query}" if url.query else "")
        login = asked.get("login") or {}
        header = (asked.get("headers") or {}).get("Authorization", "")
        width = int((re.search(r"videoResolutionWidth=(\d+)", url.query) or re.search(r"(\d+)x\d+", url.query) or [None, 640])[1])
        slow = 3 if width > 640 else 1
        with self.lock:
            self.counts["requests"] += 1
            if login.get("type") == "BASIC":
                good = header == "Basic " + base64.b64encode(f"{login['username']}:{login['password']}".encode()).decode()
                if not good:
                    return self.picture_ms / 5000, {"code": 401, "headers": {"WWW-Authenticate": 'Basic realm="fake"'}, "body_hex": ""}
            elif not header.startswith("Digest ") or not self._digest_ok(host, path, header, login):
                if header:
                    self.counts["refused"] += 1
                return self.picture_ms / 5000, self._challenge(host)
            self.counts["pictures"] += 1
        name = asked.get("name") or host
        body = self._picture(name, width, self.SIZES.get(width, 45000))
        return self.picture_ms * slow / 1000, {"code": 200, "headers": {"Content-Type": "image/svg+xml"}, "body_hex": body.hex()}


class Bridge:
    """One Lua process running the driver; requests are serialized because the driver is single-threaded."""

    def __init__(self, lua, spec_path, sonos_port=None, cameras=0, camera_ms=150, agreement=False, doors=False, fahrenheit=False):
        # Fake Sonos players on this port (tests/sonos/fake-sonos.mjs): the driver's requests to
        # players reach them through _fetch.
        self.sonos_port = sonos_port
        # Fake cameras (--cameras): their answers come later, and what the driver then sends its
        # clients goes to their connections (`clients`: handle -> the connection's sender).
        self.cameras = FakeCameras(camera_ms) if cameras else None
        self.clients = {}
        arguments = [lua, "driver/tests/dev_bridge.lua", str(spec_path or "")]
        if sonos_port:
            arguments.append("sonos")
        if cameras:
            arguments.append(f"cameras={int(cameras)}")
        if agreement:
            arguments.append("agreement")
        if doors:
            arguments.append("doors")
        if fahrenheit:
            arguments.append("fahrenheit")
        self.process = subprocess.Popen(
            arguments,
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        ready = self._readline().strip()
        if not ready.startswith("READY"):
            raise SystemExit(f"driver failed to start: {ready!r}")
        self.pairing_code = ready.split(" ", 1)[1]
        self.lock = threading.Lock()
        self.handles = 0

    def _readline(self):
        """The bridge's next answer; requests it makes to Sonos players meanwhile are answered, and
        those to fake cameras are answered later."""
        while True:
            line = self.process.stdout.readline()
            if line.startswith("CAMERA "):
                _, number, payload = line.strip().split(" ", 2)
                self._camera_later(int(number), json.loads(bytes.fromhex(payload)))
                continue
            if not line.startswith("FETCH "):
                return line
            answer = self._fetch(json.loads(bytes.fromhex(line[6:].strip())))
            self.process.stdin.write("FETCHED " + json.dumps(answer).encode().hex() + "\n")
            self.process.stdin.flush()

    def _write(self, line):
        """A line to the bridge; with fake cameras, DirectorLink's millisecond clock first."""
        if self.cameras:
            self.process.stdin.write(f"clock {int(time.monotonic() * 1000)}\n")
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def _camera_later(self, number, asked):
        wait, answer = self.cameras.answer(asked)
        timer = threading.Timer(wait, self._camera_answer, (number, answer))
        timer.daemon = True
        timer.start()

    def _camera_answer(self, number, answer):
        """A fake camera answers: the driver gets it, and what it sent its clients goes out."""
        with self.lock:
            self._write(f"CAMERA_ANSWER {number} {json.dumps(answer).encode().hex()}")
            word, _, payload = self._readline().strip().partition(" ")
        if word != "PUSHED":
            return
        for item in json.loads(bytes.fromhex(payload)):
            client = self.clients.get(item["handle"])
            if client:
                client.send(bytes.fromhex(item["data_hex"]), item["closed"])

    def _fetch(self, asked):
        """One request of the driver to a Sonos player (http://<player>:1400/...), sent to the fake
        players with the player's address in X-Fake-Sonos-Host; or their search answers."""
        if not self.sonos_port:
            return {"error": "no fake Sonos players"}
        match = re.match(r"^http://([\d.]+)(?::\d+)?(/.*)$", asked["url"])
        if not match:
            return {"error": "not a player's address"}
        headers = {name: value for name, value in (asked.get("headers") or {}).items() if isinstance(value, str)}
        headers["X-Fake-Sonos-Host"] = match.group(1)
        body = bytes.fromhex(asked.get("body_hex") or "")
        request = urllib.request.Request(f"http://127.0.0.1:{self.sonos_port}{match.group(2)}", data=body if asked["method"] == "POST" else None,
                                         headers=headers, method=asked["method"])
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                code, response_headers, payload = response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            code, response_headers, payload = error.code, error.headers, error.read()
        except OSError as error:
            return {"error": str(error)}
        return {"code": code, "headers": {"Content-Type": response_headers.get("Content-Type", "")}, "body_hex": payload.hex()}

    def new_handle(self):
        with self.lock:
            self.handles += 1
            return self.handles

    def new_pairing_code(self):
        """Runs the Composer action New Pairing Code; returns the code as Composer shows it."""
        with self.lock:
            self._write("code")
            self.pairing_code = self._readline().strip().partition(" ")[2]
            return self.pairing_code

    def exchange(self, handle, data):
        with self.lock:
            self._write(f"{handle} {data.hex()}")
            closed, _, payload = self._readline().strip().partition(" ")
            return closed == "1", bytes.fromhex(payload)

    def _ask(self, line, expected):
        with self.lock:
            self._write(line)
            word, _, payload = self._readline().strip().partition(" ")
        if word != expected:
            raise RuntimeError(f"the bridge answered {word!r} to {line.split(' ', 1)[0]!r}")
        return payload

    def set_property(self, name, value):
        """Sets a Composer property of DirectorLink, as an installer would (OnPropertyChanged)."""
        self._ask(f"property {name.encode().hex()} {value.encode().hex()}", "PROPERTY")

    def report_variable(self, device_id, variable_id, value):
        """A device of the fake project reports a variable; returns how many listeners heard it."""
        return int(self._ask(f"variable {int(device_id)} {int(variable_id)} {str(value).encode().hex()}", "VARIABLE"))

    def fire_event(self, device_id, event_id):
        """A device of the fake project fires an event; returns how many registrations heard it."""
        return int(self._ask(f"event {int(device_id)} {int(event_id)}", "EVENT"))

    def camera_alert(self, driver_id, label):
        """A camera's driver (DirectorLink · Hikvision Camera, or of DirectorLink's camera agreement)
        raises an alert ("Person", ...)."""
        return int(self._ask(f"alert {int(driver_id)} {label.encode().hex()}", "ALERTED"))

    def camera_ring(self, driver_id):
        """A doorbell camera's driver of DirectorLink's camera agreement rings (ADR-065)."""
        return int(self._ask(f"ring {int(driver_id)}", "RANG"))

    def tick(self, at=None):
        """Runs the scheduler's minute (schedules, automatic backups) now, or at the Unix time `at`;
        returns how many schedules ran."""
        return int(self._ask("tick" if at is None else f"tick {int(at)}", "TICKED"))

    def link_home(self):
        """Remote Access on, and the home's identity marked as one the relay accepted (there is no
        relay here): scene links can be made (ADR-051). Returns the home id."""
        return self._ask("linked", "LINKED")

    def scene_links_unreadable(self, unreadable=True):
        """The scene links' store cannot be read (the driver answers changes 503), or is back as it
        was. Returns whether the driver has every link (False while unreadable)."""
        return self._ask(f"scene_links {'unreadable' if unreadable else 'readable'}", "SCENE_LINKS") == "true"

    def ask(self, link, secret):
        """Runs an ask-to-open link (ADR-058) as the account service would pass it on: {answer,
        questions: [{key_id, detail}]}, each question as that device's worker would open it."""
        asked = json.dumps({"link": link, "secret": secret})
        return json.loads(bytes.fromhex(self._ask(f"ask {asked.encode().hex()}", "ASKED")))

    def seal(self, key, key_id, request):
        """The envelope the app would send to POST /v1/sealed for `request` ({method, path, body})."""
        asked = json.dumps({"key": key, "key_id": key_id, "request": request})
        return json.loads(bytes.fromhex(self._ask(f"seal {asked.encode().hex()}", "SEALED")))

    def unseal(self, key, envelope):
        """The answer inside a sealed envelope: {id, ts, status, content_type, body}, or None."""
        asked = json.dumps({"key": key, "envelope": envelope})
        return json.loads(bytes.fromhex(self._ask(f"open {asked.encode().hex()}", "OPENED")))

    def open_pairing(self, isk, envelope):
        """The new key inside the sealed answer of a pairing with CPace (the ISK, bytes), or None."""
        asked = json.dumps({"isk": isk.hex(), "envelope": envelope})
        return json.loads(bytes.fromhex(self._ask(f"open {asked.encode().hex()}", "OPENED")))


class Sender:
    """Sends a connection's answers in order, each `delay` seconds after it was ready (the relay's
    way back); closes the connection when the driver did."""

    def __init__(self, connection, delay):
        self.connection = connection
        self.delay = delay
        self.queue = queue.Queue()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def send(self, data, closed=False):
        self.queue.put((time.monotonic() + self.delay, data, closed))

    def finish(self):
        self.queue.put(None)
        self.thread.join(timeout=30)

    def _run(self):
        while True:
            item = self.queue.get()
            if item is None:
                return
            due, data, closed = item
            time.sleep(max(0.0, due - time.monotonic()))
            try:
                if data:
                    self.connection.sendall(data)
                if closed:
                    self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                return


def make_handler(bridge, latency_ms=0):
    one_way = latency_ms / 2000

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            handle = bridge.new_handle()
            sender = Sender(self.request, one_way)
            bridge.clients[handle] = sender
            try:
                while True:
                    try:
                        chunk = self.request.recv(65536)
                    except OSError:
                        chunk = b""
                    if not chunk:
                        bridge.exchange(handle, b"")
                        return
                    if one_way:
                        time.sleep(one_way)
                    closed, response = bridge.exchange(handle, chunk)
                    if response or closed:
                        sender.send(response, closed)
                    if closed:
                        return
            finally:
                bridge.clients.pop(handle, None)
                sender.finish()

    return Handler


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=41999)
    parser.add_argument("--lua", default=shutil.which("lua5.1") or shutil.which("lua"))
    parser.add_argument("--jewish-calendar", action="store_true", help="start with the Composer property Jewish Calendar = On")
    parser.add_argument("--sonos", type=int, metavar="PORT", help="fake Sonos players on this port (tests/sonos/fake-sonos.mjs); starts with Sonos = On")
    parser.add_argument("--remote-linked", action="store_true", help="start with Remote Access On and the home as the relay accepted it (scene links can be made)")
    parser.add_argument("--cameras", type=int, default=0, metavar="N", help="N fake cameras on the DirectorLink · Hikvision Camera driver instead of the two plain ones")
    parser.add_argument("--agreement-cameras", action="store_true", help="two cameras of DirectorLink's camera agreement: 67 Porch (a camera, driver 157) and 68 Entrance (a doorbell, driver 158)")
    parser.add_argument("--door-controllers", action="store_true", help="Relay Door, Gate and Garage Door Controllers: 71 Main Gate (driver 161), 72 Garage Door (162), the KNX relay 75 as door controller 163's door")
    parser.add_argument("--camera-ms", type=int, default=150, metavar="MS", help="how long a fake camera takes for a picture (default 150)")
    parser.add_argument("--latency", type=int, default=0, metavar="MS", help="a round trip added to every request, as the account's relay adds")
    parser.add_argument("--fahrenheit", action="store_true", help="a US home: Composer's scale and every thermostat in °F, with the thermostats of issue #75")
    args = parser.parse_args()
    if not args.lua:
        sys.exit("Lua 5.1 not found; install it or pass --lua")

    spec = ROOT / "dist" / "openapi.json"
    bridge = Bridge(args.lua, spec if spec.is_file() else None, args.sonos, args.cameras, args.camera_ms, args.agreement_cameras, args.door_controllers, args.fahrenheit)
    if args.jewish_calendar:
        bridge.set_property("Jewish Calendar", "On")
    if args.sonos:
        bridge.set_property("Sonos", "On")
    if args.remote_linked:
        bridge.link_home()
    with Server(("127.0.0.1", args.port), make_handler(bridge, args.latency)) as server:
        print(f"DirectorLink dev server on http://localhost:{args.port} (fake Director)")
        print(f"Pairing code: {bridge.pairing_code}")
        if args.jewish_calendar:
            print("Jewish Calendar: On")
        if args.sonos:
            print(f"Sonos: On (fake players on port {args.sonos})")
        if args.cameras:
            print(f"Cameras: {args.cameras} fake DirectorLink · Hikvision cameras (ids 601-{600 + args.cameras}), {args.camera_ms} ms a picture")
        if args.agreement_cameras:
            print('Agreement cameras: 67 Porch (driver 157) and the doorbell 68 Entrance (driver 158); "ring 158" rings it')
        if args.door_controllers:
            print('Door controllers: 71 Main Gate (driver 161), 72 Garage Door (162), 75 Back Door Relay (163); "event 161 1" opens the gate in Control4')
        if args.latency:
            print(f"Latency: {args.latency} ms a round trip")
        if args.fahrenheit:
            print("Fahrenheit: a US home (33 minisplit, 34 Nest, 36 sensor, 37 weather driver left out)")
        if not spec.is_file():
            print("Note: run scripts/build.py first to serve the real API description.")
        print('Type "code" + Enter for a new pairing code; "alarm off" / "alarm on"; "calendar on" / "calendar off"; "sonos on" / "sonos off"; "var <device> <variable> <value>"; "event <device> <event>"; "ask <link id> <secret>" (an ask-to-open link\'s run); "alert <camera driver> <label>"; "ring <doorbell camera driver>"; "stats".')
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            for line in sys.stdin:
                words = line.split()
                if words == ["code"]:
                    print(f"Pairing code: {bridge.new_pairing_code()}")
                elif len(words) == 2 and words[0] == "alarm" and words[1] in ("on", "off"):
                    bridge.set_property("Alarm Status", words[1].capitalize())
                    print(f"Alarm Status: {words[1].capitalize()}")
                elif len(words) == 2 and words[0] == "calendar" and words[1] in ("on", "off"):
                    bridge.set_property("Jewish Calendar", words[1].capitalize())
                    print(f"Jewish Calendar: {words[1].capitalize()}")
                elif len(words) == 2 and words[0] == "sonos" and words[1] in ("on", "off"):
                    bridge.set_property("Sonos", words[1].capitalize())
                    print(f"Sonos: {words[1].capitalize()}")
                elif len(words) == 3 and words[0] == "event" and words[1].isdigit() and words[2].isdigit():
                    print(f"Delivered to {bridge.fire_event(words[1], words[2])} registration(s)")
                elif len(words) == 3 and words[0] == "ask":
                    # An ask-to-open link's run (ADR-058); each question's address, as its tap opens it.
                    asked = bridge.ask(words[1], words[2])
                    print(f"Answer: {json.dumps(asked['answer'])}")
                    for question in asked["questions"]:
                        detail = question["detail"] or {}
                        until = int((time.time() + int(detail.get("seconds") or 120)) * 1000)
                        print(f"Question for key {question['key_id']}: #/open/{detail.get('id')}/{detail.get('request')}/{until}")
                elif len(words) >= 3 and words[0] == "var" and words[1].isdigit() and words[2].isdigit():
                    value = line.split(None, 3)[3].strip() if len(words) > 3 else ""
                    print(f"Reported to {bridge.report_variable(words[1], words[2], value)} listener(s)")
                elif len(words) >= 3 and words[0] == "alert" and words[1].isdigit():
                    label = line.split(None, 2)[2].strip()
                    print(f"Alert delivered to {bridge.camera_alert(words[1], label)} registration(s)")
                elif len(words) == 2 and words[0] == "ring" and words[1].isdigit():
                    print(f"Ring delivered to {bridge.camera_ring(words[1])} registration(s)")
                elif words == ["stats"] and bridge.cameras:
                    print("Camera requests: " + json.dumps(bridge.cameras.stats()))
        except KeyboardInterrupt:
            pass
        server.shutdown()


if __name__ == "__main__":
    main()
