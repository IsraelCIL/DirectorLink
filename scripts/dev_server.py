#!/usr/bin/env python3
"""Serves the real DirectorLink driver on localhost against a fake Director.

The driver runs in Lua 5.1 with driver/tests/c4mock.lua standing in for Director, so the app
and API clients can be developed without a controller:

    python scripts/build.py                        # optional: serve the real API description
    python scripts/dev_server.py                   # API on http://localhost:41999
    python -m http.server 8080 --directory app     # app; use "localhost" as the controller

The fake project has two rooms; five lights (two of them older Light proxies), plus an older light
that cannot be read and is listed as unsupported; three thermostats (an AC zone, and two that report
in °F: a Control4 thermostat with heat and cool setpoints, and floor heating set through its heat
setpoint); two fans (one on at Medium, one off), which follow their commands; two blinds, two
cameras and a door relay.
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
"""

import argparse
import json
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Bridge:
    """One Lua process running the driver; requests are serialized because the driver is single-threaded."""

    def __init__(self, lua, spec_path, sonos_port=None):
        # Fake Sonos players on this port (tests/sonos/fake-sonos.mjs): the driver's requests to
        # players reach them through _fetch.
        self.sonos_port = sonos_port
        arguments = [lua, "driver/tests/dev_bridge.lua", str(spec_path or "")]
        if sonos_port:
            arguments.append("sonos")
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
        """The bridge's next answer; requests it makes to Sonos players meanwhile are answered."""
        while True:
            line = self.process.stdout.readline()
            if not line.startswith("FETCH "):
                return line
            answer = self._fetch(json.loads(bytes.fromhex(line[6:].strip())))
            self.process.stdin.write("FETCHED " + json.dumps(answer).encode().hex() + "\n")
            self.process.stdin.flush()

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
            self.process.stdin.write("code\n")
            self.process.stdin.flush()
            self.pairing_code = self._readline().strip().partition(" ")[2]
            return self.pairing_code

    def exchange(self, handle, data):
        with self.lock:
            self.process.stdin.write(f"{handle} {data.hex()}\n")
            self.process.stdin.flush()
            closed, _, payload = self._readline().strip().partition(" ")
            return closed == "1", bytes.fromhex(payload)

    def _ask(self, line, expected):
        with self.lock:
            self.process.stdin.write(line + "\n")
            self.process.stdin.flush()
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

    def tick(self, at=None):
        """Runs the scheduler's minute (schedules, automatic backups) now, or at the Unix time `at`;
        returns how many schedules ran."""
        return int(self._ask("tick" if at is None else f"tick {int(at)}", "TICKED"))

    def link_home(self):
        """Remote Access on, and the home's identity marked as one the relay accepted (there is no
        relay here): scene links can be made (ADR-051). Returns the home id."""
        return self._ask("linked", "LINKED")

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


def make_handler(bridge):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            handle = bridge.new_handle()
            while True:
                chunk = self.request.recv(65536)
                if not chunk:
                    bridge.exchange(handle, b"")
                    return
                closed, response = bridge.exchange(handle, chunk)
                if response:
                    self.request.sendall(response)
                if closed:
                    return

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
    args = parser.parse_args()
    if not args.lua:
        sys.exit("Lua 5.1 not found; install it or pass --lua")

    spec = ROOT / "dist" / "openapi.json"
    bridge = Bridge(args.lua, spec if spec.is_file() else None, args.sonos)
    if args.jewish_calendar:
        bridge.set_property("Jewish Calendar", "On")
    if args.sonos:
        bridge.set_property("Sonos", "On")
    if args.remote_linked:
        bridge.link_home()
    with Server(("127.0.0.1", args.port), make_handler(bridge)) as server:
        print(f"DirectorLink dev server on http://localhost:{args.port} (fake Director)")
        print(f"Pairing code: {bridge.pairing_code}")
        if args.jewish_calendar:
            print("Jewish Calendar: On")
        if args.sonos:
            print(f"Sonos: On (fake players on port {args.sonos})")
        if not spec.is_file():
            print("Note: run scripts/build.py first to serve the real API description.")
        print('Type "code" + Enter for a new pairing code; "alarm off" / "alarm on"; "calendar on" / "calendar off"; "sonos on" / "sonos off"; "var <device> <variable> <value>"; "event <device> <event>".')
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
                elif len(words) >= 3 and words[0] == "var" and words[1].isdigit() and words[2].isdigit():
                    value = line.split(None, 3)[3].strip() if len(words) > 3 else ""
                    print(f"Reported to {bridge.report_variable(words[1], words[2], value)} listener(s)")
        except KeyboardInterrupt:
            pass
        server.shutdown()


if __name__ == "__main__":
    main()
