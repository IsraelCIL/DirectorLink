"""The release checks themselves (scripts/build.py, check_package.py, check_repo.py and
check_app.py): the relay's CA file holds exactly the pinned roots however its blocks are written,
nothing else in driver/certs reaches the package, line endings do not change it, check_repo vets
what is staged, the door switches, the Jewish calendar, the alarm's status and Sonos in driver.xml
ship off, the alarm stays read-only, one file talks to the Sonos players, the app names every
month, holiday and weekly reading the calendar API can send, every language has exactly English's
strings, placeholders and the disclaimer (1.10.0), Say or type a command has a parser without
imports and opens no door from the words, and the website's one script asks only for DirectorLink
in numbers (check_sites.py).

    python -m unittest discover -s tests/scripts
"""

import base64
import contextlib
import io
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import build  # noqa: E402
import check_app  # noqa: E402
import check_package  # noqa: E402
import check_repo  # noqa: E402
import check_sites  # noqa: E402

CA_FILE = "certs/directorlink-roots.pem"
PEM = (ROOT / "driver" / CA_FILE).read_bytes().replace(b"\r\n", b"\n")
WEBSOCKET = (ROOT / "driver" / "src" / "cloud" / "websocket.lua").read_text(encoding="utf-8")
SPEC = {"openapi": "3.1.0", "info": {"title": "test", "version": "1.1.0"}}

# A block OpenSSL would load as one more trust anchor: any base64 body, as the checks never parse
# the certificate itself, only its SHA-256.
EXTRA = base64.encodebytes(b"a tenth root, not one of the pinned ones" * 3).decode("ascii")
# A key block with a made-up body, its markers split so no scanner takes this file for a key.
KEY_LABEL = "PRIVATE" + " KEY"
KEY = f"-----BEGIN {KEY_LABEL}-----\n" + base64.encodebytes(b"not a real key" * 4).decode("ascii") + f"-----END {KEY_LABEL}-----\n"


def refusal(check, *args):
    """The ERROR a check prints when it refuses, or None when it passes."""
    printed = io.StringIO()
    with contextlib.redirect_stderr(printed):
        try:
            check(*args)
        except SystemExit:
            return printed.getvalue()
    return None


def relay_roots(pem):
    return refusal(check_package.check_relay_roots, {"src/cloud/websocket.lua": WEBSOCKET, CA_FILE: pem})


class RelayRoots(unittest.TestCase):
    def test_the_real_file_passes(self):
        self.assertIsNone(relay_roots(PEM.decode("ascii")))

    def test_crlf_line_endings_read_like_lf(self):
        # A Windows checkout with core.autocrlf=true, before .gitattributes.
        self.assertIsNone(relay_roots(PEM.decode("ascii").replace("\n", "\r\n")))

    def test_every_block_openssl_would_load_is_counted(self):
        for begin, end in (
            ("-----BEGIN TRUSTED CERTIFICATE----- ", "-----END TRUSTED CERTIFICATE-----"),
            ("-----BEGIN TRUSTED CERTIFICATE-----", "-----END TRUSTED CERTIFICATE-----"),
            ("-----BEGIN X509 CERTIFICATE-----", "-----END X509 CERTIFICATE-----"),
            ("-----BEGIN CERTIFICATE----- ", "-----END CERTIFICATE-----"),
            ("-----BEGIN CERTIFICATE-----\t", "-----END CERTIFICATE-----"),
            ("-----BEGIN CERTIFICATE-----", "-----END CERTIFICATE-----"),
        ):
            with self.subTest(begin=begin):
                pem = PEM.decode("ascii") + f"\n# Extra Root\n{begin}\n{EXTRA}{end}\n"
                self.assertIsNotNone(relay_roots(pem), "a tenth trust anchor passed")
                self.assertIsNotNone(relay_roots(pem.replace("\n", "\r\n")), "a tenth trust anchor passed with CRLF")

    def test_a_key_or_any_other_block_fails(self):
        for extra in (KEY, KEY.replace(f"-----BEGIN {KEY_LABEL}-----", f"-----BEGIN EC {KEY_LABEL}----- "), "-----BEGIN X509 CRL-----\nAAAA\n-----END X509 CRL-----\n"):
            with self.subTest(extra=extra.splitlines()[0]):
                self.assertIsNotNone(relay_roots(PEM.decode("ascii") + extra))
                self.assertIsNotNone(relay_roots((PEM.decode("ascii") + extra).replace("\n", "\r\n")))

    def test_a_root_missing_or_twice_fails(self):
        text = PEM.decode("ascii")
        first = text.index("# ISRG Root X1\n")
        block = text[first:text.index("-----END CERTIFICATE-----", first) + len("-----END CERTIFICATE-----\n")]
        self.assertIsNotNone(relay_roots(text.replace(block, "")))
        self.assertIsNotNone(relay_roots(text + "\n" + block))


class Build(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.driver = self.temp / "driver"
        shutil.copytree(ROOT / "driver", self.driver, ignore=shutil.ignore_patterns("tests"))
        self.saved = build.DRIVER
        build.DRIVER = self.driver

    def tearDown(self):
        build.DRIVER = self.saved
        shutil.rmtree(self.temp, ignore_errors=True)

    def entries(self):
        return build.package_entries("1.1.0", 10100, SPEC)

    def test_only_the_ca_file_is_packaged(self):
        certs = sorted(name for name in self.entries() if name.startswith("certs/"))
        self.assertEqual(certs, [CA_FILE])

    def test_anything_else_in_certs_stops_the_build(self):
        # Git ignores other .pem files, so git status would not show this one.
        (self.driver / "certs" / "local-test-key.pem").write_text(KEY, encoding="ascii")
        printed = refusal(self.entries)
        self.assertIsNotNone(printed, "a key in driver/certs was packaged")
        self.assertIn("local-test-key.pem", printed)

    def test_a_crlf_checkout_gives_the_same_package(self):
        path = self.driver / CA_FILE
        path.write_bytes(PEM.replace(b"\n", b"\r\n"))
        self.assertEqual(self.entries()[CA_FILE], PEM)

    def test_the_wrong_roots_package_trusts_one_root(self):
        pem = build.roots_only(PEM, "ISRG_Root_X1")
        self.assertEqual(check_package.pem_certificates(pem), [("ISRG Root X1", check_package.RELAY_ROOTS["ISRG Root X1"])])
        self.assertIsNotNone(check_package.relay_roots_problem(pem), "check_package would pass it as a release")
        self.assertIsNotNone(refusal(build.roots_only, PEM, "No Such Root"))


class DriverXml(unittest.TestCase):
    def test_the_door_switches_ship_off(self):
        source = (ROOT / "driver" / "driver.xml").read_text(encoding="utf-8")
        for name, off, on in (("Door Control", "Disabled", "Enabled"), ("Relay Hold", "Not allowed", "Allowed")):
            with self.subTest(name=name):
                self.assertEqual(source.count(f"<default>{off}</default>"), 1)
                shipped_on = source.replace(f"<default>{off}</default>", f"<default>{on}</default>")
                printed = refusal(check_package.check_driver_xml, shipped_on, "0")
                self.assertIn(f"{name} must default to {off}", printed or "", "a door switch that ships on passed")

    def test_the_jewish_calendar_ships_off(self):
        # Off: the driver works nothing out and the app shows none of it (1.2.0, ADR-037).
        source = (ROOT / "driver" / "driver.xml").read_text(encoding="utf-8")
        shipped_on, count = re.subn(r"(<name>Jewish Calendar</name>.*?<default>)Off(</default>)", r"\1On\2", source, count=1, flags=re.S)
        self.assertEqual(count, 1, "driver.xml has a Jewish Calendar property that defaults to Off")
        printed = refusal(check_package.check_driver_xml, shipped_on, "0")
        self.assertIn("Jewish Calendar must default to Off", printed or "", "a Jewish calendar that ships on passed")

    def test_the_alarm_status_ships_off(self):
        source = (ROOT / "driver" / "driver.xml").read_text(encoding="utf-8")
        start = source.index("<name>Alarm Status</name>")
        end = source.index("</property>", start)
        block = source[start:end]
        self.assertEqual(block.count("<default>Off</default>"), 1)
        shipped_on = source[:start] + block.replace("<default>Off</default>", "<default>On</default>") + source[end:]
        printed = refusal(check_package.check_driver_xml, shipped_on, "0")
        self.assertIn("Alarm Status must default to Off", printed or "", "an alarm status that ships on passed")

    def test_sonos_ships_off(self):
        # Off: DirectorLink looks for no Sonos player and sends nothing to one (1.5.0, ADR-044).
        source = (ROOT / "driver" / "driver.xml").read_text(encoding="utf-8")
        shipped_on, count = re.subn(r"(<name>Sonos</name>.*?<default>)Off(</default>)", r"\1On\2", source, count=1, flags=re.S)
        self.assertEqual(count, 1, "driver.xml has a Sonos property that defaults to Off")
        printed = refusal(check_package.check_driver_xml, shipped_on, "0")
        self.assertIn("Sonos must default to Off", printed or "", "a Sonos switch that ships on passed")


class SonosOnly(unittest.TestCase):
    """check_package.py: one file talks to the Sonos players, only with the actions listed, and only
    src/sonos/sonos.lua allows an address (1.5.0, ADR-044)."""

    def refused(self, files):
        return refusal(check_package.check_sonos, files)

    def test_the_driver_passes(self):
        self.assertIsNone(self.refused(driver_sources()))

    def test_only_the_client_talks_to_players(self):
        files = driver_sources()
        for name in ("src/sonos/sonos.lua", "src/api/handlers/music.lua", "src/sonos/protocol.lua"):
            with self.subTest(name=name):
                talking = files[name] + '\nlocal function x() C4:url():Get("http://192.168.1.2:1400/") end\n'
                self.assertIn("only src/sonos/client.lua talks to the Sonos players", self.refused({**files, name: talking}) or "")

    def test_no_handler_allows_an_address(self):
        files = driver_sources()
        handler = files["src/api/handlers/music.lua"]
        self.assertIn("allows a Sonos address", self.refused({**files, "src/api/handlers/music.lua": handler + "\nClient.allow(ctx.body.address)\n"}) or "")
        loading = handler.replace('local Sonos = require("src.sonos.sonos")', 'local Sonos = require("src.sonos.sonos")\nlocal Client = require("src.sonos.client")')
        self.assertNotEqual(loading, handler)
        self.assertIn("loads src/sonos/client.lua", self.refused({**files, "src/api/handlers/music.lua": loading}) or "")

    def test_the_client_is_caught_under_any_name(self):
        # "\bClient" does not match inside "SonosClient": the name the client has in main.lua.
        files = driver_sources()
        for name in ("src/api/handlers/music.lua", "src/core/scenes.lua", "src/main.lua"):
            for call in ('SonosClient.allow("10.1.2.3", "x")', "Client:allow(ctx.body.address)", "MyClient . allow (ip)"):
                with self.subTest(name=name, call=call):
                    self.assertIn("allows a Sonos address", self.refused({**files, name: files[name] + "\n" + call + "\n"}) or "")

    def test_main_only_hands_the_search_events_over(self):
        files = driver_sources()
        main = files["src/main.lua"]
        self.assertIn("SonosClient.onData(", main)
        self.assertIn("SonosClient.onConnectionStatus(", main)
        for added in (
            'SonosClient.call("192.168.1.2", "Play", {}, function() end)',
            'SonosClient.picture("192.168.1.2", "/getaa", print)',
            "SonosClient.search(print, print)",
            "SonosClient.forget(\"topology\")",
            "local other = SonosClient",
            'SonosClient["allow"]("10.1.2.3")',
            'package.loaded["src.sonos.client"].call()',
            'local Again = require("src.sonos.client")',
        ):
            with self.subTest(added=added):
                printed = self.refused({**files, "src/main.lua": main + "\nlocal function x()\n    " + added + "\nend\n"}) or ""
                self.assertRegex(printed, r"src/main\.lua (uses .*: of src/sonos/client\.lua it may use only onConnectionStatus, onData|loads src/sonos/client\.lua other than once)")
        # A comment naming it is not code.
        self.assertIsNone(self.refused({**files, "src/main.lua": main + "\n-- SonosClient.call(ip, ...) is not for main.lua\n"}))

    def test_no_other_action_reaches_a_player(self):
        # Grouping is joining and leaving (1.8.0, ADR-057); nothing else new: no other way to
        # group, no group volume of its own, no alarms or settings.
        files = driver_sources()
        protocol = files["src/sonos/protocol.lua"]
        self.assertIn('    BecomeCoordinatorOfStandaloneGroup = "AVTransport",\n', protocol)
        for action, service in (
            ("DelegateGroupCoordinationTo", "AVTransport"),
            ("AddMember", "AVTransport"),
            ("RemoveMember", "AVTransport"),
            ("SetGroupVolume", "GroupRenderingControl"),
            ("SetRelativeVolume", "RenderingControl"),
            ("SnapshotGroupVolume", "GroupRenderingControl"),
            ("CreateAlarm", "AlarmClock"),
            ("SetZoneAttributes", "DeviceProperties"),
        ):
            with self.subTest(action=action):
                added = protocol.replace('    Browse = "ContentDirectory",\n', f'    Browse = "ContentDirectory",\n    {action} = "{service}",\n')
                self.assertNotEqual(added, protocol)
                self.assertIn("the actions sent to Sonos players must be exactly", self.refused({**files, "src/sonos/protocol.lua": added}) or "")
        # Leaving taken away is a change of the list too.
        removed = protocol.replace('    BecomeCoordinatorOfStandaloneGroup = "AVTransport",\n', "")
        self.assertIn("the actions sent to Sonos players must be exactly", self.refused({**files, "src/sonos/protocol.lua": removed}) or "")

    def test_only_the_protocol_makes_a_group_address_and_only_the_sonos_module_uses_it(self):
        files = driver_sources()
        self.assertIn('return "x-rincon:" .. coordinatorId', files["src/sonos/protocol.lua"])
        self.assertIn("Protocol.groupUri(", files["src/sonos/sonos.lua"])
        for name in ("src/api/handlers/music.lua", "src/sonos/sonos.lua", "src/api/handlers/scenes.lua"):
            for added in ('local uri = "x-rincon:" .. ctx.body.with', "local uri = 'x-rincon:' ..id"):
                with self.subTest(name=name, added=added):
                    self.assertIn("makes an x-rincon: address", self.refused({**files, name: files[name] + "\nlocal function x()\n    " + added + "\nend\n"}) or "")
        for name in ("src/api/handlers/music.lua", "src/api/handlers/scenes.lua", "src/main.lua"):
            with self.subTest(name=name):
                printed = self.refused({**files, name: files[name] + "\nlocal function x() return Protocol.groupUri(ctx.body.with) end\n"}) or ""
                self.assertIn("uses Protocol.groupUri", printed)
        # Reading what plays (a room that follows another: x-rincon:...) is not making one.
        self.assertIn('startsWith(uri, "x-rincon:")', files["src/sonos/protocol.lua"])
        self.assertIsNone(self.refused(files))


def driver_sources():
    """The driver's Lua files as the package names them (src/...)."""
    base = ROOT / "driver"
    return {path.relative_to(base).as_posix(): path.read_text(encoding="utf-8") for path in (base / "src").rglob("*.lua")}


class DoorControllersOpenOnly(unittest.TestCase):
    """A Relay Door, Gate or Garage Door Controller (ADR-069) is sent its own Open and nothing else."""

    ADAPTER = "src/adapters/relay_controller.lua"
    OPEN = 'C4:SendToDevice(info.controller, "OPEN", {})'

    def refused(self, files):
        return refusal(check_package.check_door_controllers_open_only, files)

    def test_the_driver_passes(self):
        self.assertIsNone(self.refused(driver_sources()))

    def test_close_stop_select_or_another_command_is_refused(self):
        files = driver_sources()
        adapter = files[self.ADAPTER]
        self.assertIn(self.OPEN, adapter)
        for added in (
            'C4:SendToDevice(info.controller, "CLOSE", {})',
            'C4:SendToDevice(info.controller, "STOP", {})',
            'C4:SendToProxy(5001, "SELECT", {})',
            'C4:SendToDevice(info.controller, "LUA_ACTION", { ACTION = "CLOSE" })',
            'C4:SendToDevice(info.relays[1], "CLOSE", {})',
            'local command = "TOGGLE"',
        ):
            with self.subTest(added=added):
                changed = adapter.replace(self.OPEN, self.OPEN + "\n            " + added, 1)
                self.assertNotEqual(changed, adapter)
                self.assertIsNotNone(self.refused({**files, self.ADAPTER: changed}))
        # Its comments may name what it never sends.
        self.assertIsNone(self.refused({**files, self.ADAPTER: adapter + '\n-- never "CLOSE" or C4:SendToDevice(id, "STOP", {})\n'}))

    def test_the_hold_refusal_must_stay(self):
        files = driver_sources()
        guard = "if info.hold and not (type(params) == \"table\" and params.hold_allowed == true) then"
        self.assertIn(guard, files[self.ADAPTER])
        self.assertIn(guard, check_package.SECURITY_CONTRACT[self.ADAPTER])
        self.assertIsNone(refusal(check_package.check_security_contract, files))
        loosened = {**files, self.ADAPTER: files[self.ADAPTER].replace(guard, "if false then")}
        self.assertIn("missing security contract", refusal(check_package.check_security_contract, loosened) or "")


class AlarmReadOnly(unittest.TestCase):
    ADAPTER = "src/adapters/alarm.lua"

    def refused(self, files):
        return refusal(check_package.check_alarm_read_only, files)

    def test_the_driver_passes(self):
        self.assertIsNone(self.refused(driver_sources()))

    def test_the_adapter_may_only_read_and_watch(self):
        files = driver_sources()
        adapter = files[self.ADAPTER]
        send = "function Alarm.execute()\n    C4:SendToDevice(81, \"DISARM\", {})\n"
        for number, changed in enumerate((
            adapter.replace("function Alarm.execute()\n", send),
            adapter.replace("function Alarm.execute()\n", "function Alarm.execute()\n    C4:SendToProxy(5001, \"ARM\", {})\n"),
            adapter.replace("function Alarm.execute()\n", "function Alarm.execute()\n    local send = C4.SendToDevice\n"),
            adapter.replace("local Alarm = {}", "local Alarm = {}\nlocal Log = require(\"src.core.log\")"),
            adapter.replace("function Alarm.execute()\n", "function Alarm.execute()\n    print(\"state\")\n"),
            adapter.replace("function Alarm.execute()\n", "function Alarm.execute()\n    _G.C4:SendToDevice(81, \"ARM\", {})\n"),
        )):
            with self.subTest(change=number):
                self.assertNotEqual(changed, adapter, "the test did not change the adapter")
                self.assertIsNotNone(self.refused({**files, self.ADAPTER: changed}))

    def test_comments_and_strings_do_not_count_but_code_does(self):
        files = driver_sources()
        # The adapter's own comment names the commands it never sends.
        self.assertIn("PARTITION_ARM", files[self.ADAPTER])
        relays = files["src/api/handlers/relays.lua"]
        commented = relays + "\n-- never PARTITION_DISARM here\n--[[ nor C4:SendToDevice(81, \"PARTITION_ARM\") ]]\n"
        self.assertIsNone(self.refused({**files, "src/api/handlers/relays.lua": commented}))
        sending = relays + '\nlocal function disarm(id) C4:SendToDevice(id, "PARTITION_DISARM", {}) end\n'
        printed = self.refused({**files, "src/api/handlers/relays.lua": sending})
        self.assertIn("partition command", printed or "")

    def test_the_api_only_reads_the_alarm(self):
        files = driver_sources()
        routes = files["src/api/routes.lua"]
        read = '    { method = "GET", path = "/v1/alarm", handler = "alarm.status", role = "member" },\n'
        write = '    { method = "POST", path = "/v1/alarm/{partitionId}/disarm", handler = "alarm.status", role = "admin" },\n'
        self.assertIn(read, routes)
        printed = self.refused({**files, "src/api/routes.lua": routes.replace(read, read + write)})
        self.assertIn("the alarm is only read", printed or "")

    def test_no_scene_step_reaches_the_alarm(self):
        files = driver_sources()
        for name, old, new in (
            ("src/core/scenes.lua", "refrigerators = true }", "refrigerators = true, alarm = true }"),
            ("src/api/handlers/scenes.lua", 'refrigerators = "refrigerator" }', 'refrigerators = "refrigerator", partitions = "alarm" }'),
        ):
            with self.subTest(name=name):
                self.assertIn(old, files[name])
                printed = self.refused({**files, name: files[name].replace(old, new, 1)})
                self.assertIn("scene steps must never reach the alarm", printed or "")


class CalendarNames(unittest.TestCase):
    """check_app.py: every dictionary names what GET /v1/calendar sends by key (1.2.0, ADR-037)."""

    def setUp(self):
        import yaml

        self.spec = yaml.safe_load((ROOT / "api" / "openapi.yaml").read_text(encoding="utf-8"))
        self.dictionaries = {code: check_app.read_dictionary((ROOT / "app" / "i18n" / f"{code}.js").read_text(encoding="utf-8")) for code in ("en", "he")}

    def test_the_dictionaries_are_read_as_the_app_reads_them(self):
        he = self.dictionaries["he"]
        self.assertEqual(he["calendar"]["parashot"]["28"], "מצורע")
        self.assertEqual(he["calendar"]["join"], "־")
        self.assertEqual(he["connect"]["errors"]["wrongCode"]["two"], "הקוד שגוי. נותרו עוד {count} ניסיונות לפני שהצימוד יינעל לדקה.")
        self.assertEqual(he["connect"]["errors"]["invalidCode"], "הזינו את קוד הצימוד בן 8 הספרות, למשל ⁦1234 5678⁩.")
        self.assertEqual(check_app.read_dictionary('// x\nexport default { a: { "b-c": \'it\\\'s\', 1: "\\u{1F56F}" }, /* y */ d: [1, 2.5], };'), {"a": {"b-c": "it's", "1": "\U0001F56F"}, "d": [1, 2.5]})

    def test_the_real_dictionaries_pass(self):
        self.assertIsNone(refusal(check_app.check_calendar_names, self.spec, self.dictionaries))

    def test_a_missing_month_holiday_or_reading_fails(self):
        for group, key in (("months", "adar_2"), ("holidays", "shiva_asar_btamuz"), ("parashot", "54")):
            with self.subTest(group=group):
                del self.dictionaries["he"]["calendar"][group][key]
                printed = refusal(check_app.check_calendar_names, self.spec, self.dictionaries)
                self.assertIn(f"app/i18n/he.js has no calendar.{group} name for: {key}", printed or "")
                self.setUp()

    def test_a_key_added_to_the_api_fails_until_it_is_named(self):
        self.spec["components"]["schemas"]["HolidayKey"]["enum"].append("yom_hamishpacha")
        printed = refusal(check_app.check_calendar_names, self.spec, self.dictionaries)
        self.assertIn("app/i18n/en.js has no calendar.holidays name for: yom_hamishpacha", printed or "")

    def test_an_empty_name_or_rosh_chodesh_without_its_month_fails(self):
        self.dictionaries["en"]["calendar"]["parashot"]["3"] = " "
        self.assertIn("calendar.parashot name for: 3", refusal(check_app.check_calendar_names, self.spec, self.dictionaries) or "")
        self.setUp()
        self.dictionaries["he"]["calendar"]["holidays"]["rosh_chodesh"] = "ראש חודש"
        self.assertIn("rosh_chodesh must name the month", refusal(check_app.check_calendar_names, self.spec, self.dictionaries) or "")


class Translations(unittest.TestCase):
    """check_app.py (1.10.0, ADR-067): every language file has exactly en.js's keys, each with the
    same placeholders and plural forms, and the disclaimer; theme-boot.js and the service worker
    know every language."""

    CODES = ("en", "he", "es", "it")

    def setUp(self):
        self.dictionaries = {code: check_app.read_dictionary((ROOT / "app" / "i18n" / f"{code}.js").read_text(encoding="utf-8")) for code in self.CODES}

    def refused(self):
        return refusal(check_app.check_translations, self.dictionaries) or ""

    def test_the_real_dictionaries_pass(self):
        self.assertIsNone(refusal(check_app.check_translations, self.dictionaries))
        boot = (ROOT / "app" / "theme-boot.js").read_text(encoding="utf-8")
        worker = (ROOT / "app" / "sw.js").read_text(encoding="utf-8")
        self.assertIsNone(refusal(check_app.check_language_files, list(self.CODES), boot, worker))

    def test_a_missing_or_extra_key_fails(self):
        for code in ("es", "it", "he"):
            with self.subTest(code=code):
                del self.dictionaries[code]["settings"]["appearance"]["textSizeHelp"]
                self.assertIn(f"app/i18n/{code}.js is missing 1 key(s) of en.js: settings.appearance.textSizeHelp", self.refused())
                self.setUp()
                self.dictionaries[code]["home"]["extra"] = "?"
                self.assertIn(f"app/i18n/{code}.js has 1 key(s) en.js does not: home.extra", self.refused())
                self.setUp()

    def test_placeholders_must_match_english(self):
        self.dictionaries["es"]["settings"]["rows"]["about"] = "Versión {versión} · código abierto"
        self.assertIn("app/i18n/es.js: settings.rows.about has the placeholders {versión}, en.js {version}", self.refused())
        self.setUp()
        # A plural's forms count together: "one" may leave {count} out when "other" has it.
        self.dictionaries["it"]["home"]["lightsOn"] = {"one": "Una luce accesa", "other": "{count} luci accese"}
        self.assertIsNone(refusal(check_app.check_translations, self.dictionaries))
        self.dictionaries["it"]["home"]["lightsOn"] = {"one": "Una luce accesa", "other": "Luci accese"}
        self.assertIn("home.lightsOn has the placeholders none, en.js {count}", self.refused())
        self.setUp()
        # The command examples may give the room as {inRoom} (Hebrew), and only those.
        self.dictionaries["es"]["command"]["example"]["lights"] = "Apaga las luces {inRoom}"
        self.assertIsNone(refusal(check_app.check_translations, self.dictionaries))
        self.dictionaries["es"]["command"]["example"]["scene"] = "Ejecuta {inRoom}"
        self.assertIn("command.example.scene has the placeholders {inRoom}, en.js {name}", self.refused())

    def test_plural_forms_as_in_english(self):
        self.dictionaries["es"]["home"]["lightsOn"] = "{count} luces encendidas"
        self.assertIn("app/i18n/es.js: home.lightsOn must be plural forms, as in en.js", self.refused())
        self.setUp()
        self.dictionaries["it"]["home"]["lightsOn"] = {"one": "{count} luce accesa"}
        self.assertIn('app/i18n/it.js: home.lightsOn needs an "other" form', self.refused())
        self.setUp()
        del self.dictionaries["es"]["perm"]["roomCount"]["zero"]
        self.assertIn('app/i18n/es.js: perm.roomCount needs a "zero" form, as in en.js', self.refused())

    def test_the_disclaimer_word_for_word(self):
        for code, words in (("en", "DirectorLink is an independent project."), ("es", "DirectorLink es un proyecto independiente."), ("it", "DirectorLink è indipendente.")):
            with self.subTest(code=code):
                self.dictionaries[code]["settings"]["about"]["independent"] = words
                self.assertIn(f"app/i18n/{code}.js settings.about.independent must be the disclaimer word for word", self.refused())
                self.setUp()
        # A language without its words written down must still name all three.
        self.assertIsNone(refusal(check_app.check_translations, {"en": self.dictionaries["en"], "fr": {**self.dictionaries["it"], "settings": {**self.dictionaries["it"]["settings"], "about": {**self.dictionaries["it"]["settings"]["about"], "independent": "DirectorLink est un projet indépendant, sans lien avec Control4 ni Snap One."}}}}))
        self.dictionaries["he"]["settings"]["about"]["independent"] = "פרויקט עצמאי."
        self.assertIn("app/i18n/he.js settings.about.independent must say the disclaimer (DirectorLink, Control4, Snap One)", self.refused())

    def test_every_language_before_the_first_paint_and_offline(self):
        boot = (ROOT / "app" / "theme-boot.js").read_text(encoding="utf-8")
        worker = (ROOT / "app" / "sw.js").read_text(encoding="utf-8")
        self.assertIn("theme-boot.js must list the same languages", refusal(check_app.check_language_files, [*self.CODES, "fr"], boot, worker) or "")
        self.assertIn("must cache /i18n/it.js", refusal(check_app.check_language_files, list(self.CODES), boot, worker.replace('"/i18n/it.js",', "")) or "")


class Commands(unittest.TestCase):
    """check_app.py: Say or type a command (1.9.0, ADR-063) has a parser of its own without imports
    but the heaters' rule (1.10.0, ADR-066), which has none, never opens a door or gate from the
    words, and the app's headers allow the microphone."""

    def setUp(self):
        self.files = {path: (ROOT / "app" / path).read_text(encoding="utf-8") for path in ("js/command-parser.js", "js/heaters.js", "js/commands.js", "js/views/command.js", "_headers")}

    def test_the_real_files_pass(self):
        self.assertIsNone(refusal(check_app.check_commands, self.files))

    def test_a_parser_with_an_import_fails(self):
        self.files["js/command-parser.js"] = 'import { t } from "./i18n.js";\n' + self.files["js/command-parser.js"]
        self.assertIn("must not import", refusal(check_app.check_commands, self.files) or "")
        self.setUp()
        self.files["js/command-parser.js"] += '\nconst late = () => import("./i18n.js");\n'
        self.assertIn("must not import", refusal(check_app.check_commands, self.files) or "")

    def test_the_parser_imports_the_heaters_rule_which_imports_nothing(self):
        self.assertIn('from "./heaters.js"', self.files["js/command-parser.js"])
        self.files["js/heaters.js"] = 'import { t } from "./i18n.js";\n' + self.files["js/heaters.js"]
        self.assertIn("heaters.js must not import", refusal(check_app.check_commands, self.files) or "")

    def test_opening_a_door_from_the_words_fails(self):
        self.files["js/commands.js"] += "\nexport const open = (relay) => pressRelay(relay);\n"
        self.assertIn("must not open doors", refusal(check_app.check_commands, self.files) or "")

    def test_headers_without_the_microphone_fail(self):
        self.files["_headers"] = self.files["_headers"].replace("microphone=(self)", "microphone=()")
        self.assertIn("microphone=(self)", refusal(check_app.check_commands, self.files) or "")


class StagedRoots(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        subprocess.run(["git", "init", "-q", str(self.temp)], check=True)
        (self.temp / "driver" / "certs").mkdir(parents=True)
        self.saved = check_repo.ROOT
        check_repo.ROOT = self.temp

    def tearDown(self):
        check_repo.ROOT = self.saved
        shutil.rmtree(self.temp, ignore_errors=True)

    def stage(self, staged, working):
        path = self.temp / "driver" / CA_FILE
        path.write_bytes(staged)
        subprocess.run(["git", "-c", "core.autocrlf=false", "add", "--", f"driver/{CA_FILE}"], check=True, cwd=self.temp)
        path.write_bytes(working)

    def test_a_key_staged_fails_even_when_the_working_file_is_clean(self):
        self.stage(PEM + KEY.encode("ascii"), PEM)
        self.assertIsNotNone(refusal(check_repo.main), "the staged key would be committed")

    def test_the_staged_roots_pass_whatever_the_working_file_holds(self):
        self.stage(PEM, PEM + KEY.encode("ascii"))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(refusal(check_repo.main))


class SiteNumbers(unittest.TestCase):
    """check_sites.py: the website's one script asks only for DirectorLink in numbers, from 25
    homes, and the section starts hidden (1.7.0, ADR-052)."""

    SITE = ROOT / "site"

    def files(self):
        pages = {path.name: path.read_text(encoding="utf-8") for path in self.SITE.glob("*.html")}
        return pages, (self.SITE / "numbers.js").read_text(encoding="utf-8"), (self.SITE / "_headers").read_text(encoding="utf-8")

    def refused(self, pages, script, headers):
        return refusal(check_sites.check_site_numbers, pages, script, headers)

    def test_the_site_passes(self):
        self.assertIsNone(self.refused(*self.files()))

    def test_the_section_must_start_hidden(self):
        pages, script, headers = self.files()
        shown = pages["index.html"].replace('aria-labelledby="numbers-title" hidden>', 'aria-labelledby="numbers-title">')
        self.assertNotEqual(shown, pages["index.html"])
        self.assertIn("must start hidden", self.refused({**pages, "index.html": shown}, script, headers) or "")

    def test_the_csp_allows_only_the_script_and_the_totals(self):
        pages, script, headers = self.files()
        for old, new in (
            ("connect-src https://api.directorlink.io;", "connect-src https://api.directorlink.io https://example.com;"),
            ("connect-src https://api.directorlink.io;", "connect-src *;"),
            ("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
        ):
            with self.subTest(new=new):
                changed = headers.replace(old, new)
                self.assertNotEqual(changed, headers)
                self.assertIn("site/_headers CSP", self.refused(pages, script, changed) or "")

    def test_the_script_asks_for_the_totals_only_and_from_25_homes(self):
        pages, script, headers = self.files()
        for changed, expected in (
            (script.replace("export const MIN_HOMES = 25;", "export const MIN_HOMES = 1;"), "only from 25 homes"),
            (script + '\nfetch("https://example.com/beacon");\n', "may ask only"),
            (script.replace('credentials: "omit"', 'credentials: "include"'), "without cookies"),
            (script + "\nlocalStorage.setItem('seen', '1');\n", "must not use localStorage"),
            (script + "\nsection.innerHTML = answer;\n", "must not use innerHTML"),
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, self.refused(pages, changed, headers) or "")

    def test_no_other_page_loads_a_script(self):
        pages, script, headers = self.files()
        privacy = pages["privacy.html"].replace("</head>", '<script type="module" src="/numbers.js"></script></head>')
        self.assertIn("site/privacy.html may load only", self.refused({**pages, "privacy.html": privacy}, script, headers) or "")

    def test_only_the_demo_page_loads_the_demo(self):
        pages, script, headers = self.files()
        demo = (self.SITE / "try" / "index.html").read_text(encoding="utf-8")
        self.assertIsNone(self.refused({**pages, "try/index.html": demo}, script, headers))
        privacy = pages["privacy.html"].replace("</head>", '<script type="module" src="/try/demo.js"></script></head>')
        self.assertIn("site/privacy.html may load only", self.refused({**pages, "privacy.html": privacy}, script, headers) or "")


class SiteDemo(unittest.TestCase):
    """check_sites.py: the demo home's script (site/try/) talks to nothing, stores nothing, sets no
    markup but its own icons, and is in English (ADR-060)."""

    TRY = ROOT / "site" / "try"

    def files(self):
        return (
            (self.TRY / "index.html").read_text(encoding="utf-8"),
            (self.TRY / "demo.js").read_text(encoding="utf-8"),
            {path.name for path in (self.TRY / "pictures").glob("*.jpg")},
        )

    def refused(self, page, script, pictures):
        return refusal(check_sites.check_site_demo, page, script, pictures)

    def test_the_demo_passes(self):
        self.assertIsNone(self.refused(*self.files()))

    def test_the_demo_talks_to_nothing_and_stores_nothing(self):
        page, script, pictures = self.files()
        for added, expected in (
            ('\nfetch("/v1/stats");\n', "must not use fetch("),
            ('\nconst where = "https://example.com/";\n', "must not name any address"),
            ("\nlocalStorage.setItem('done', '1');\n", "must not use localStorage"),
            ("\nnavigator.sendBeacon('/x');\n", "must not use sendBeacon"),
            ("\nscreenEl.innerHTML = text;\n", "may set innerHTML only to its own icons"),
            ('\nconst title = "בית";\n', "English only"),
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, self.refused(page, script + added, pictures) or "")

    def test_the_page_loads_the_demo_and_says_it_is_made_up(self):
        page, script, pictures = self.files()
        for changed, expected in (
            (page.replace('<script type="module" src="/try/demo.js"></script>', ""), "must load /try/demo.js"),
            (page.replace("made up", "real"), "made up"),
        ):
            with self.subTest(expected=expected):
                self.assertNotEqual(changed, page)
                self.assertIn(expected, self.refused(changed, script, pictures) or "")

    def test_every_camera_has_its_two_pictures(self):
        page, script, pictures = self.files()
        self.assertIn("garden-640.jpg is missing", self.refused(page, script, pictures - {"garden-640.jpg"}) or "")


class DeployApproval(unittest.TestCase):
    """check_sites.py (ADR-075): the sites' deploy and the driver's release run only in the
    production environment, which the owner approves and which alone has the Cloudflare token;
    pull requests get no preview versions; each site gets a build.json; the hourly watch only
    reads the code and writes issues; a release starts only after Validate DirectorLink passed on
    a push to main of this repository, and works on that commit."""

    def setUp(self):
        self.workflows = {path.name: path.read_text(encoding="utf-8") for path in (ROOT / ".github" / "workflows").glob("*.yml")}
        self.ignores = {folder: (ROOT / folder / ".assetsignore").read_text(encoding="utf-8") for folder in check_sites.STAMPED_SITES}

    def refused(self, workflows=None, ignores=None, tracked=()):
        return refusal(check_sites.check_workflows, {**self.workflows, **(workflows or {})}, {**self.ignores, **(ignores or {})}, set(tracked)) or ""

    def edited(self, name, old, new):
        self.assertIn(old, self.workflows[name])
        return {name: self.workflows[name].replace(old, new)}

    def test_the_real_workflows_pass(self):
        self.assertEqual(self.refused(), "")

    def test_the_deploy_waits_for_the_owner(self):
        self.assertRegex(self.refused(self.edited("deploy.yml", "    environment: production\n", "")), "outside the production environment|without the owner's approval")
        # Deploying from a job without the environment, even with no secret named in it.
        dry_run = "(cd \"$folder\" && npx --yes wrangler@4.143.0 deploy --dry-run)"
        self.assertIn("deploys without the owner's approval", self.refused(self.edited("deploy.yml", dry_run, dry_run.replace(" --dry-run", ""))))

    def test_the_release_waits_for_the_owner(self):
        self.assertIn("publishes a release without the owner's approval", self.refused(self.edited("release.yml", "    environment: production\n", "")))
        publish_if = "    if: github.ref == 'refs/heads/main' && needs.gate.outputs.release == 'true'\n"
        self.assertIn("only from main", self.refused(self.edited("release.yml", publish_if, "    if: needs.gate.outputs.release == 'true'\n")))
        self.assertIn("contents: read", self.refused(self.edited("release.yml", "permissions:\n  contents: read\n\nenv:", "permissions:\n  contents: write\n\nenv:")))
        # Published even when the build failed or was skipped.
        self.assertIn("must not run when a job it needs failed", self.refused(self.edited("release.yml", publish_if, "    if: always() && github.ref == 'refs/heads/main'\n")))
        # The files the build job checked, compared with the ones about to be published.
        self.assertIn("only the files the build job checked", self.refused(self.edited("release.yml", "          TESTED: ${{ needs.build.outputs.sums }}\n", "          TESTED: unchecked\n")))
        wider = self.edited("release.yml", "    permissions:\n      contents: write\n", "    permissions:\n      contents: write\n      actions: write\n")
        self.assertIn("exactly contents: write", self.refused(wider))
        gate_reads = "    permissions:\n      contents: read\n      actions: read\n"
        self.assertIn("job gate may write to the repository", self.refused(self.edited("release.yml", gate_reads, gate_reads.replace("actions: read", "actions: write"))))
        self.assertIn("job gate may only read", self.refused(self.edited("release.yml", gate_reads, "    permissions: write-all\n")))

    def test_the_release_runs_only_after_validate_passed_on_main(self):
        # The tests are not run again: no release on a push of its own.
        on_push = self.edited("release.yml", "  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n    branches: [\"main\"]\n")
        self.assertIn("only after Validate DirectorLink (workflow_run) or by hand", self.refused(on_push))
        trigger = "    workflows: [\"Validate DirectorLink\"]\n"
        self.assertIn("must start when Validate DirectorLink completes on main", self.refused(self.edited("release.yml", trigger, "    workflows: [\"Deploy DirectorLink sites\"]\n")))
        self.assertIn("completes on main", self.refused(self.edited("release.yml", "    branches: [\"main\"]\n  workflow_dispatch:", "  workflow_dispatch:")))
        # Validate renamed: the release would never start again.
        renamed = self.edited("validate.yml", "name: Validate DirectorLink\n", "name: Validate\n")
        self.assertIn("must start when Validate completes on main", self.refused(renamed))
        # A pull request's run (a fork's too: its branch may be called main), a fork's push, a
        # failed run, another branch: each clause of the gate is needed, and nothing may widen it.
        for clause in (
            "      github.event.workflow_run.conclusion == 'success' &&\n",
            "      github.event.workflow_run.event == 'push' &&\n",
            "      github.event.workflow_run.head_branch == 'main' &&\n",
        ):
            self.assertIn("must run only after Validate passed on a push to main", self.refused(self.edited("release.yml", clause, "")))
        fork = " &&\n      github.event.workflow_run.head_repository.full_name == github.repository)\n"
        self.assertIn("must run only after Validate passed", self.refused(self.edited("release.yml", fork, ")\n")))
        by_hand = "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||"
        self.assertIn("must run only after Validate passed", self.refused(self.edited("release.yml", by_hand, "github.event_name == 'workflow_dispatch' ||")))
        self.assertIn("must run only after Validate passed", self.refused(self.edited("release.yml", "github.repository)\n    runs-on", "github.repository) || true\n    runs-on")))
        # Run by hand, nothing but GitHub's API says that Validate passed.
        asks = "actions/workflows/validate.yml/runs?head_sha=$SHA"
        self.assertIn("whether Validate DirectorLink passed on the commit", self.refused(self.edited("release.yml", asks, "actions/runs")))

    def test_the_release_works_on_the_commit_validate_passed(self):
        # After Validate, github.sha is main's latest commit, not the one Validate tested.
        commit = "  SHA: ${{ github.event.workflow_run.head_sha || github.sha }}\n"
        self.assertIn("env: SHA:", self.refused(self.edited("release.yml", commit, "  SHA: ${{ github.sha }}\n")))
        self.assertIn("use $SHA", self.refused(self.edited("release.yml", '--target "$SHA"', '--target "$GITHUB_SHA"')))
        self.assertIn("at the commit Validate passed", self.refused(self.edited("release.yml", '            --target "$SHA"\n', "")))
        build_checkout = "      sums: ${{ steps.sums.outputs.sums }}\n\n    steps:\n      - name: Checkout\n"
        checkout = self.workflows["release.yml"].split(build_checkout, 1)[1].split("\n\n", 1)[0]
        self.assertIn("          ref: ${{ env.SHA }}\n", checkout)
        main_latest = self.edited("release.yml", build_checkout + checkout, build_checkout + checkout.replace("          ref: ${{ env.SHA }}\n", ""))
        self.assertIn("job build must check out the commit Validate passed", self.refused(main_latest))

    def test_no_other_job_reads_a_secret_or_gets_a_preview(self):
        secret = "        run: lua5.1 driver/tests/run.lua --shard ${{ matrix.part }}/3\n"
        leaked = self.edited("validate.yml", secret, secret + "        env:\n          TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n")
        self.assertIn("reads a secret outside the production environment", self.refused(leaked))
        preview = self.edited("deploy.yml", "deploy --dry-run)", "versions upload --preview-alias pr)")
        self.assertIn("uploads a preview version", self.refused(preview))
        target = self.edited("validate.yml", "  pull_request:\n", "  pull_request_target:\n")
        self.assertIn("no pull_request_target", self.refused(target))

    def test_each_site_gets_a_build_json_it_publishes_and_nobody_commits(self):
        unstamped = self.edited("deploy.yml", "printf '{\"commit\": \"%s\", \"built_at\": \"%s\"}\\n'", "printf '{}\\n'")
        self.assertIn("must write each site's build.json", self.refused(unstamped))
        self.assertIn("app/.assetsignore must not keep build.json", self.refused(ignores={"app": self.ignores["app"] + "*.json\n"}))
        self.assertIn("site/build.json must not be committed", self.refused(tracked={"site/build.json"}))

    def test_the_watch_runs_every_hour_and_only_reads_and_writes_issues(self):
        wider = self.edited("watch-live.yml", "permissions:\n  contents: read\n  issues: write\n", "permissions:\n  contents: write\n  issues: write\n")
        self.assertIn("watch-live.yml permissions must be exactly", self.refused(wider))
        unscheduled = self.edited("watch-live.yml", "  schedule:\n    - cron: \"17 * * * *\"\n", "")
        self.assertIn("must run on a schedule", self.refused(unscheduled))
        self.assertIn("watch-live.yml must compare", refusal(check_sites.check_workflows, {name: text for name, text in self.workflows.items() if name != "watch-live.yml"}, self.ignores, set()) or "")


if __name__ == "__main__":
    unittest.main()
