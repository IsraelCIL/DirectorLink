#!/usr/bin/env python3
"""Static validation for the small DirectorLink sites:

  console/      API console, debugging and logs  -> https://console.directorlink.io
  site/         landing page                     -> https://directorlink.io (and www)
  github-link/  short link to the source code    -> https://github.directorlink.io

Checks the published files, the Cloudflare configuration, the security headers, that the
console uses the app's API client unchanged, and that the pages keep to the CSP (no inline
scripts or styles, no scripts from elsewhere). The landing page's one script asks only for
DirectorLink in numbers, which stays hidden until it has totals (ADR-052); the demo home's script
(try/) talks to nothing and stores nothing (ADR-060). Links to the source
code use the short link: the repository's long address appears only where a machine needs it.
Nothing reaches production without the owner's approval (ADR-075): the workflows that deploy the
sites and publish the driver do it only in the "production" environment, each site gets a
build.json that the hourly watch compares with the source, and a release starts only once
Validate DirectorLink has passed on its commit of main.
"""

from fnmatch import fnmatch
from html.parser import HTMLParser
import json
import re
from pathlib import Path
import struct
import subprocess
import sys
import zlib

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONSOLE = ROOT / "console"
SITE = ROOT / "site"
APP = ROOT / "app"
GITHUB_LINK = ROOT / "github-link"

GITHUB = "https://github.directorlink.io"
# The repository's own address. People only ever see the short link above; the long one stays
# where a machine needs it: the short link's target, and the app's check that GitHub's release
# answers point into this project (app/js/updates.js and the tests that hold such answers), and
# the website's redirects to the drivers' own repositories (their names start with the same text).
REPOSITORY = "https://github.com/DirectorLink/DirectorLink"
REPOSITORY_ALLOWED = {
    "github-link/worker.js",
    "site/_redirects",
    "app/js/updates.js",
    "tests/app/updates.test.mjs",
    "tests/app/update-notice.test.mjs",
    "tests/app/settings-pages.test.mjs",
    "scripts/check_sites.py",
}
NOT_AFFILIATED = "not affiliated with Control4 or Snap One"
# The owner's disclaimer, word for word: prominent in the README, the docs, the app and the console.
DISCLAIMER = "DirectorLink is an independent project, not affiliated with Control4 or Snap One."
SLOGAN = ("Direct to Director.", "End-to-end integration.", "Open source.")

REQUIRED = {
    CONSOLE: [
        "index.html",
        "console.js",
        "console.css",
        "api-client.js",
        "icons/icon.svg",
        "_headers",
        ".assetsignore",
        "wrangler.jsonc",
        "README.md",
    ],
    SITE: [
        "index.html",
        "privacy.html",
        "drivers/index.html",
        "drivers/samsung-refrigerator.html",
        "site.css",
        "_redirects",
        "icons/icon.svg",
        "_headers",
        ".assetsignore",
        "wrangler.jsonc",
    ],
}

WORKERS = {
    CONSOLE: ("directorlink-console", ["console.directorlink.io"]),
    SITE: ("directorlink-site", ["directorlink.io", "www.directorlink.io"]),
}

TEST_SUFFIXES = (".test.js", ".test.mjs", ".spec.js", ".spec.mjs")

# 0.8.0 onboarding: the pairing code from Composer is the only way to a first key. Access
# requests and the DirectorLink Access button are gone and must not come back.
RETIRED = ("/v1/auth/requests", "DirectorLink Access", "Request admin access")
PAIRING_PROBLEMS = (
    "INVALID_FIELD",
    "PAIRING_CODE_INVALID",
    "PAIRING_NOT_ACTIVE",
    "PAIRING_RATE_LIMITED",
    "KEY_LIMIT_REACHED",
    "PAIRING_UNAVAILABLE",
    "PAIRING_SESSION_EXPIRED",
)
# Modules the console shares with the app byte for byte: the API client, and pairing without
# sending the code (CPace, ADR-039) with the lock that opens its answer.
SHARED_WITH_APP = ("api-client.js", "js/cpace.js", "js/lock.js")


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def require(text, fragment, message):
    if fragment not in text:
        fail(message)


def rel(path):
    return path.relative_to(ROOT).as_posix()


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.scripts = []
        self.stylesheets = []
        self.images = []
        self.images_without_alt = []
        self.links = []
        self.inline_scripts = 0
        self.inline_handlers = []
        self.style_attributes = 0
        self.style_elements = 0
        self.landmarks = set()
        self.icon = None
        self.lang = None
        self.title = ""
        self._in_title = False
        self._in_script = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "html":
            self.lang = values.get("lang")
        if "id" in values:
            self.ids.add(values["id"])
        if "style" in values:
            self.style_attributes += 1
        for name in values:
            if name.startswith("on"):
                self.inline_handlers.append(f"<{tag} {name}>")
        if tag == "script":
            self._in_script = True
            if values.get("src"):
                self.scripts.append(values["src"])
        if tag == "style":
            self.style_elements += 1
        if tag == "link" and values.get("rel") == "stylesheet":
            self.stylesheets.append(values.get("href"))
        if tag == "link" and values.get("rel") == "icon":
            self.icon = values.get("href")
        if tag == "img" and values.get("src"):
            self.images.append(values["src"])
            if "alt" not in values:
                self.images_without_alt.append(values["src"])
        if tag == "source" and values.get("srcset"):
            self.images.extend(part.split()[0] for part in values["srcset"].split(",") if part.strip())
        if tag == "a" and values.get("href"):
            self.links.append(values["href"])
        if tag in ("header", "main", "footer", "nav"):
            self.landmarks.add(tag)
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_script = False
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_script and data.strip():
            self.inline_scripts += 1
        if self._in_title:
            self.title += data


def parse(path):
    parser = PageParser()
    parser.feed(path.read_text(encoding="utf-8"))
    return parser


def jsonc(path):
    text = "\n".join(line for line in path.read_text(encoding="utf-8").splitlines() if not line.lstrip().startswith("//"))
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        fail(f"{rel(path)} is not valid JSON (with // comment lines): {error}")


def published_files(folder):
    ignored = set((folder / ".assetsignore").read_text(encoding="utf-8").split())
    for path in folder.rglob("*"):
        if path.is_file() and path.relative_to(folder).as_posix() not in ignored:
            yield path


def check_common(folder):
    name = folder.name
    for relative in REQUIRED[folder]:
        if not (folder / relative).is_file():
            fail(f"missing file: {name}/{relative}")

    worker, domains = WORKERS[folder]
    config = jsonc(folder / "wrangler.jsonc")
    if config.get("name") != worker:
        fail(f"{name}/wrangler.jsonc must name the Worker {worker}")
    if config.get("assets", {}).get("directory") != ".":
        fail(f"{name}/wrangler.jsonc must publish this folder (assets.directory \".\")")
    routes = config.get("routes", [])
    expected = [{"pattern": domain, "custom_domain": True} for domain in domains]
    if routes != expected:
        fail(f"{name}/wrangler.jsonc routes must be exactly the custom domains {', '.join(domains)}")
    if config.get("observability", {}).get("enabled") is not True:
        fail(f"{name}/wrangler.jsonc must enable Workers observability")
    if "main" in config:
        fail(f"{name}/wrangler.jsonc is a static site: no Worker script (main)")

    ignored = (folder / ".assetsignore").read_text(encoding="utf-8").split()
    for entry in ("wrangler.jsonc", ".assetsignore", "README.md"):
        if entry not in ignored:
            fail(f"{name}/.assetsignore must keep {entry} from being published")

    headers = (folder / "_headers").read_text(encoding="utf-8")
    if not headers.startswith("/*"):
        fail(f"{name}/_headers must apply to every path (/*)")
    csp_lines = [line.strip() for line in headers.splitlines() if line.strip().lower().startswith("content-security-policy:")]
    if len(csp_lines) != 1:
        fail(f"{name}/_headers must set one Content-Security-Policy")
    csp = csp_lines[0]
    for directive in ("default-src", "script-src", "object-src 'none'", "frame-ancestors 'none'", "base-uri"):
        require(csp, directive, f"{name}/_headers CSP must set {directive}")
    script_src = re.search(r"script-src ([^;]*)", csp).group(1).split()
    for unsafe in ("'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:"):
        if unsafe in script_src:
            fail(f"{name}/_headers CSP must not allow {unsafe} scripts")
    for header in ("X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", "X-Frame-Options: DENY"):
        require(headers, header, f"{name}/_headers must set {header}")

    for path in folder.rglob("*"):
        if path.is_file() and path.name.endswith(TEST_SUFFIXES):
            fail(f"tests must not live in {name}/ (Cloudflare publishes everything there): {rel(path)}")

    # The old name must not come back on the new sites.
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix in (".html", ".css", ".js", ".svg", ".md", ".jsonc", "") and path.name != ".assetsignore":
            text = path.read_text(encoding="utf-8")
            for match in re.finditer(r"c4bridge", text, re.IGNORECASE):
                fail(f"{rel(path)} still says {match.group(0)!r}; the project is DirectorLink")
            for retired in RETIRED:
                if retired in text:
                    fail(f"{rel(path)} still mentions {retired!r}; since 0.8.0 devices pair with a code from Composer")

    pages = sorted(path.relative_to(folder).as_posix() for path in folder.rglob("*.html"))
    index = None
    for page_name in pages:
        page = parse(folder / page_name)
        if page_name == "index.html":
            index = page
        if page.lang != "en":
            fail(f"{name}/{page_name} must declare lang=\"en\"")
        if page.inline_scripts or page.inline_handlers:
            fail(f"{name}/{page_name} has inline script ({page.inline_handlers or 'a <script> body'}); the CSP only allows files")
        if page.style_attributes or page.style_elements:
            fail(f"{name}/{page_name} has inline styles; the CSP only allows stylesheets")
        for src in page.scripts:
            if not src.startswith("/"):
                fail(f"{name}/{page_name} loads a script from elsewhere: {src}")
        if page.icon != "/icons/icon.svg":
            fail(f"{name}/{page_name} must use /icons/icon.svg as its icon")
        for landmark in ("header", "main", "footer"):
            if landmark not in page.landmarks:
                fail(f"{name}/{page_name} needs a <{landmark}> landmark")
        if "main" not in page.ids:
            fail(f"{name}/{page_name} needs #main (the skip link target)")
        if "#main" not in page.links:
            fail(f"{name}/{page_name} needs a skip link to #main")
        html = (folder / page_name).read_text(encoding="utf-8")
        require(html, NOT_AFFILIATED, f"{name}/{page_name} footer must say DirectorLink is {NOT_AFFILIATED}")
        if GITHUB not in page.links:
            fail(f"{name}/{page_name} must link to {GITHUB}")
        require(html, "DirectorLink", f"{name}/{page_name} must name DirectorLink")

        # Every local reference resolves to a published file.
        published = {"/" + path.relative_to(folder).as_posix() for path in published_files(folder)}
        for reference in [*page.scripts, *page.stylesheets, *page.images, page.icon]:
            if reference and reference.startswith("/") and reference not in published:
                fail(f"{name}/{page_name} references {reference}, which is not published")
        for image in page.images:
            if not image.startswith("/"):
                fail(f"{name}/{page_name} loads a picture from elsewhere ({image}); the CSP only allows its own")
        if page.images_without_alt:
            fail(f"{name}/{page_name}: every picture needs alt text ({', '.join(page.images_without_alt)})")
    css_files = [path for path in folder.rglob("*.css")]
    for path in css_files:
        css = path.read_text(encoding="utf-8")
        require(css, "prefers-color-scheme: dark", f"{rel(path)} must have a dark variant (prefers-color-scheme)")
        require(css, ":focus-visible", f"{rel(path)} must style keyboard focus")
    return index


def check_console():
    page = check_common(CONSOLE)
    if "/console.js" not in page.scripts:
        fail("console/index.html must load /console.js")
    require((CONSOLE / "index.html").read_text(encoding="utf-8"), 'type="module" src="/console.js"', "console.js is an ES module")
    if (CONSOLE / "sw.js").exists() or (CONSOLE / "manifest.webmanifest").exists():
        fail("the console is not a PWA: no service worker or manifest")

    for shared in SHARED_WITH_APP:
        copy = CONSOLE / shared
        if not copy.is_file() or copy.read_bytes() != (APP / shared).read_bytes():
            fail(f"console/{shared} must be an exact copy of app/{shared} (cp app/{shared} console/{shared})")

    headers = (CONSOLE / "_headers").read_text(encoding="utf-8")
    csp = next(line for line in headers.splitlines() if "Content-Security-Policy" in line)
    for directive in ("script-src 'self'", "connect-src 'self' http: https:", "img-src 'self' data: blob:", "style-src 'self'"):
        require(csp, directive, f"console/_headers CSP must include {directive} (the controller is plain HTTP on the LAN)")

    modules = sorted([CONSOLE / "console.js", *(CONSOLE / "js").rglob("*.js")])
    code = "\n".join(path.read_text(encoding="utf-8") for path in modules)

    # Static elements the console looks up by id must exist in index.html.
    for element_id in sorted(set(re.findall(r'byId\(\s*[`"]([A-Za-z0-9_-]+)[`"]\s*\)', code))):
        if element_id not in page.ids:
            fail(f"console JavaScript uses #{element_id}, which console/index.html does not have")
    for tab in re.findall(r'const TABS = \[([^\]]*)\]', code)[0].replace('"', "").split(","):
        tab = tab.strip()
        if tab and f"view-{tab}" not in page.ids:
            fail(f"console/index.html is missing #view-{tab}")
    for element_id in re.findall(r'querySelector(?:All)?\(\s*"#([A-Za-z0-9_-]+)', code):
        if element_id not in page.ids:
            fail(f"console JavaScript uses #{element_id}, which console/index.html does not have")

    for fragment, message in (
        ('"/v1/openapi.json"', "the API tab must load the API description from the controller"),
        ('"x-directorlink-role"', "the API tab must show each operation's role"),
        ('name: CLIENT_NAME', "pairing must name the key DirectorLink Console"),
        ("normalizePairingCode(", "the console must accept the code with or without its space"),
        ("formatPairingCode(", "the console must show the code as 1234 5678 while typing"),
        ('export const CLIENT_NAME = "DirectorLink Console"', "the console's key name is DirectorLink Console"),
        ('"/v1/auth/pair"', "the console must pair with a code from Composer"),
        ('pairing_code: pairingCode', "pairing the old way must send the (normalized) code in the JSON body"),
        # 1.3.0 (ADR-039, ADR-040): the code is never sent, unless Pair anyway was chosen after the
        # warning, and the console's own key lasts a day.
        ("await pairWithCpace(post, { code: pairingCode, name: CLIENT_NAME, expiresIn: KEY_SECONDS })",
         "the console must pair without sending the code (CPace), for a key that lasts a day"),
        ('if (error?.code !== "CPACE_UNSUPPORTED") throw error;', "an older DirectorLink must get no code until Pair anyway"),
        ("anyway\n        ? await pairSendingCode(", "only Pair anyway may send the code"),
        ("export const KEY_SECONDS = 24 * 60 * 60;", "the console's key must last a day"),
        ('handleUnauthorized(refusedText(result.data?.code))', "an expired key must say so and send the console back to pairing"),
        ('code === "KEY_EXPIRED" || (Number.isFinite(at) && Date.now() >= at - CLOCK_SLACK_MS) ? EXPIRED_TEXT',
         "a key refused after its expiry (removed meanwhile) must be called expired too"),
        ('"/v1/api-keys/current"', "the console must read (and revoke) its own key"),
        ('"/v1/api-keys"', "the Keys tab must list and create keys"),
        ("/v1/logs?", "the Logs tab must follow the log"),
        ('"/v1/logs/settings"', "the Logs tab must read and change the recording level"),
        ('"/v1/health"', "the System tab must test the connection"),
        ('"/v1/system"', "the console must load the system information"),
        ("$DIRECTORLINK_KEY", "Copy as curl must use the $DIRECTORLINK_KEY placeholder"),
        ("apiImage", "binary responses (camera snapshots) must be fetched as images"),
        ("saveApiKey", "the console must store its key with saveApiKey"),
        ("handleUnauthorized", "a 401 must clear the key"),
        ('"directorlink.console.tab"', "the console must remember the last tab"),
    ):
        require(code, fragment, message)
    for problem in PAIRING_PROBLEMS:
        require(code, f'"{problem}"', f"the console must explain the pairing problem {problem}")
    html = (CONSOLE / "index.html").read_text(encoding="utf-8")
    for fragment, message in (
        ("This key travels unprotected on your network: use the console only on a network you trust.",
         "the console must warn that its key travels unprotected"),
        ('id="pair-anyway-button"', "the warning about an older DirectorLink needs Pair anyway"),
    ):
        require(re.sub(r"\s+", " ", html), fragment, message)
    field = re.search(r'<input[^>]*id="pair-code"[^>]*>', html)
    for attribute in ('inputmode="numeric"', 'autocomplete="one-time-code"', 'placeholder="1234 5678"', 'dir="ltr"'):
        if not field or attribute not in field.group(0):
            fail(f"console/index.html: the pairing code field needs {attribute}")
    if "localStorage.setItem(\"directorlink.apiKey\"" in code or "sessionStorage" in code:
        fail("the console must store the key only through api-client.js")

    # Copy as curl and the diagnostics must never contain the key.
    curl = re.search(r"export function curlCommand[\s\S]*?\n}\n", code)
    if not curl or "apiKey" in curl.group(0):
        fail("curlCommand must not use the API key")
    diagnostics = re.search(r"export function diagnosticsText[\s\S]*?\n}\n", code)
    if not diagnostics:
        fail("the System tab needs diagnosticsText()")
    for secret in ("apiKey", "pairing", "api_key", ".key}", "state.key.key"):
        if secret in diagnostics.group(0):
            fail(f"the diagnostics report must never include the API key or a pairing code ({secret})")

    # Every module the console imports exists.
    for path in modules:
        for target in re.findall(r'from\s+"(\.[^"]+)"', path.read_text(encoding="utf-8")):
            if not (path.parent / target).resolve().is_file():
                fail(f"{rel(path)} imports {target}, which does not exist")


# DirectorLink in numbers (ADR-052): the site's one script asks the account service for its
# totals and nothing else, and the section stays hidden until there are totals to show.
SITE_SCRIPT = "/numbers.js"
STATS_URL = "https://api.directorlink.io/v1/stats"
SCRIPT_FORBIDDEN = (
    "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "import(",
    "localStorage", "sessionStorage", "indexedDB", "document.cookie", "sendBeacon", "XMLHttpRequest", "WebSocket",
)


def check_site_numbers(pages, script, headers):
    """pages: the site's pages ({name: html}); script: numbers.js; headers: site/_headers."""
    for name, html in sorted(pages.items()):
        parser = PageParser()
        parser.feed(html)
        expected = PAGE_SCRIPTS.get(name, [])
        if parser.scripts != expected:
            fail(f"site/{name} may load only {expected or 'no scripts'}, not {parser.scripts}")
    index = pages["index.html"]
    require(index, f'<script type="module" src="{SITE_SCRIPT}"></script>', f"site/index.html must load {SITE_SCRIPT} as a module")
    section = re.search(r'<section\b[^>]*\bid="numbers"[^>]*>', index)
    if not section or not re.search(r"\shidden(?=[\s/>])", section.group(0)):
        fail("site/index.html: the numbers section (#numbers) must start hidden, so that without totals nothing shows or moves")
    for total in ("homes", "people", "downloads"):
        require(index, f'data-total="{total}"', f"site/index.html: the numbers section needs a place for {total}")

    csp = next(line for line in headers.splitlines() if line.strip().lower().startswith("content-security-policy:"))
    directives = {}
    for directive in csp.split(":", 1)[1].split(";"):
        if directive.strip():
            name, *values = directive.split()
            directives[name] = values
    if directives.get("script-src") != ["'self'"]:
        fail("site/_headers CSP: script-src must be exactly 'self' (numbers.js, no inline scripts)")
    if directives.get("connect-src") != [STATS_URL.rsplit("/v1/", 1)[0]]:
        fail("site/_headers CSP: connect-src must be exactly https://api.directorlink.io (the totals, nothing else)")

    urls = sorted(set(re.findall(r"https?://[^\s\"'`)]+", script)))
    if urls != [STATS_URL]:
        fail(f"site/numbers.js may ask only {STATS_URL}, nothing else ({', '.join(urls) or 'none'})")
    require(script, "export const MIN_HOMES = 25;", "site/numbers.js must show the totals only from 25 homes (MIN_HOMES)")
    require(script, 'credentials: "omit"', "site/numbers.js must ask without cookies")
    for forbidden in SCRIPT_FORBIDDEN:
        if forbidden in script:
            fail(f"site/numbers.js must not use {forbidden}: it fills in three numbers and stores nothing")


# The demo home (ADR-060): the app's screens with a made-up home, in the visitor's browser only.
DEMO_PAGE = "try/index.html"
DEMO_SCRIPT = "/try/demo.js"
PAGE_SCRIPTS = {"index.html": [SITE_SCRIPT], DEMO_PAGE: [DEMO_SCRIPT]}
DEMO_FORBIDDEN = (
    "fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "postMessage", "window.open",
    "localStorage", "sessionStorage", "indexedDB", "document.cookie", "caches.",
    "eval(", "new Function", "import(", "outerHTML", "insertAdjacentHTML", "document.write",
)


def check_site_demo(page, script, pictures):
    """page: try/index.html; script: try/demo.js; pictures: the names in try/pictures/."""
    require(page, f'<script type="module" src="{DEMO_SCRIPT}"></script>', f"site/{DEMO_PAGE} must load {DEMO_SCRIPT} as a module")
    # The SVG namespace is a name, not an address anything is fetched from.
    urls = sorted(set(re.findall(r"https?://[^\s\"'`)]+", script)) - {"http://www.w3.org/2000/svg"})
    if urls:
        fail(f"site{DEMO_SCRIPT} must not name any address ({', '.join(urls)}): the demo talks to nothing")
    for forbidden in DEMO_FORBIDDEN:
        if forbidden in script:
            fail(f"site{DEMO_SCRIPT} must not use {forbidden}: the demo talks to nothing and stores nothing")
    markup = [line.strip() for line in script.splitlines() if "innerHTML" in line]
    if markup != ["svg.innerHTML = ICONS[name] || \"\";"]:
        fail(f"site{DEMO_SCRIPT} may set innerHTML only to its own icons, not: {markup}")
    for name, text in ((DEMO_PAGE, page), (DEMO_SCRIPT.lstrip("/"), script)):
        if re.search(r"[\u0590-\u05ff]", text):
            fail(f"site/{name} must be in English only (the website's showcase rule)")
    require(page, "made up", f"site/{DEMO_PAGE} must say that the home and its people are made up")
    block = re.search(r"const CAMERAS = \[(.*?)\];", script, re.S)
    if not block:
        fail(f"site{DEMO_SCRIPT}: no CAMERAS list")
    for camera in re.findall(r'id: "([a-z0-9-]+)"', block.group(1)):
        for size in (320, 640):
            if f"{camera}-{size}.jpg" not in pictures:
                fail(f"site/try/pictures/{camera}-{size}.jpg is missing (camera {camera})")


def check_site():
    page = check_common(SITE)
    check_site_numbers(
        {path.relative_to(SITE).as_posix(): path.read_text(encoding="utf-8") for path in SITE.rglob("*.html")},
        (SITE / SITE_SCRIPT.lstrip("/")).read_text(encoding="utf-8"),
        (SITE / "_headers").read_text(encoding="utf-8"),
    )
    check_site_demo(
        (SITE / DEMO_PAGE).read_text(encoding="utf-8"),
        (SITE / DEMO_SCRIPT.lstrip("/")).read_text(encoding="utf-8"),
        {path.name for path in (SITE / "try" / "pictures").glob("*.jpg")},
    )
    html = (SITE / "index.html").read_text(encoding="utf-8")
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)
    for part in SLOGAN:
        require(text, part, f"site/index.html must carry the slogan ({part})")
    for link in ("https://app.directorlink.io", "https://console.directorlink.io", GITHUB):
        if link not in page.links:
            fail(f"site/index.html must link to {link}")
    require(text, "Apache-2.0", "site/index.html footer must name the license (Apache-2.0)")
    require(text, "pairing code", "How it works must explain pairing with a code")
    require(text, "New Pairing Code", "How it works must say where the code is made (Composer: New Pairing Code)")
    for stylesheet in page.stylesheets:
        if not stylesheet.startswith("/"):
            fail(f"site/index.html loads a stylesheet from elsewhere ({stylesheet}); the site loads nothing from elsewhere")
    check_drivers()


# DirectorLink Drivers: /drivers/ lists them, /drivers/<slug> is a driver's page, and its download,
# releases, issues and source links are redirects in site/_redirects to the driver's own repository.
DRIVER_REDIRECT = re.compile(
    r"^/drivers/([a-z0-9]+(?:-[a-z0-9]+)*)/(download|releases|issues|source) "
    r"https://github\.com/DirectorLink/DirectorLink-[A-Za-z0-9-]+(/[^\s]*)? 302$"
)


def check_drivers():
    redirects = {}
    for number, line in enumerate((SITE / "_redirects").read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        match = DRIVER_REDIRECT.match(line)
        if not match:
            fail(f"site/_redirects line {number}: only /drivers/<slug>/(download|releases|issues|source) "
                 "to github.com/DirectorLink/DirectorLink-<driver>, as 302")
        source = line.split()[0]
        if source in redirects:
            fail(f"site/_redirects sends {source} twice")
        if not (SITE / "drivers" / f"{match.group(1)}.html").is_file():
            fail(f"site/_redirects has links for {match.group(1)}, which has no page site/drivers/{match.group(1)}.html")
        redirects[source] = line.split()[1]
    for slug in {source.split("/")[2] for source in redirects}:
        if f"/drivers/{slug}/download" not in redirects:
            fail(f"site/_redirects: {slug} needs a /drivers/{slug}/download link")
    for path in sorted(SITE.rglob("*.html")):
        page = parse(path)
        if "/drivers/" not in page.links:
            fail(f"{rel(path)} must link to /drivers/ (in the header)")
        for link in page.links:
            if not link.startswith("/drivers/") or link == "/drivers/":
                continue
            if link in redirects:
                continue
            if not (SITE / (link.strip("/") + ".html")).is_file():
                fail(f"{rel(path)} links to {link}, which is neither a driver page nor in site/_redirects")
    for path in sorted((SITE / "drivers").glob("*.html")):
        if path.name == "index.html":
            continue
        html = path.read_text(encoding="utf-8")
        slug = path.stem
        if f"/drivers/{slug}/download" not in html:
            fail(f"{rel(path)} must offer its download (/drivers/{slug}/download)")
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
        for line in ("Free. No subscription, no license key, no account with us.", "DirectorLink is not required"):
            require(text, line, f"{rel(path)} must say: {line}")
        require(parse(path).title, "DirectorLink · ", f"{rel(path)}: the title is the driver's full name, DirectorLink · <product>")


def png_size(path):
    """Width and height of a PNG, after checking every chunk's CRC and the image data."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        fail(f"{rel(path)} is not a PNG")
    position, size, image = 8, None, b""
    while position < len(data):
        if position + 12 > len(data):
            fail(f"{rel(path)} is corrupt (truncated)")
        (length,) = struct.unpack(">I", data[position : position + 4])
        if position + 12 + length > len(data):
            fail(f"{rel(path)} is corrupt (truncated)")
        kind = data[position + 4 : position + 8]
        body = data[position + 8 : position + 8 + length]
        (crc,) = struct.unpack(">I", data[position + 8 + length : position + 12 + length])
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            fail(f"{rel(path)} is corrupt (bad {kind.decode(errors='replace')} checksum)")
        if kind == b"IHDR":
            size = struct.unpack(">II", body[:8])
        elif kind == b"IDAT":
            image += body
        position += 12 + length
    try:
        zlib.decompress(image)
    except zlib.error as error:
        fail(f"{rel(path)} is corrupt ({error})")
    return size


def check_icons():
    # One DL mark everywhere (scripts/make_icons.py brand writes all of them).
    mark = (APP / "icons" / "icon.svg").read_bytes()
    for folder in (CONSOLE, SITE):
        if (folder / "icons" / "icon.svg").read_bytes() != mark:
            fail(f"{folder.name}/icons/icon.svg must be the DL mark (python scripts/make_icons.py brand)")
    manifest = json.loads((APP / "manifest.webmanifest").read_text(encoding="utf-8"))
    for icon in manifest["icons"]:
        if icon.get("type") == "image/png":
            path = APP / icon["src"].lstrip("/")
            width, height = png_size(path)
            if icon.get("sizes") != f"{width}x{height}":
                fail(f"{rel(path)} is {width}x{height}, but the manifest says {icon.get('sizes')}")


def check_github_link():
    config = jsonc(GITHUB_LINK / "wrangler.jsonc")
    if config.get("name") != "directorlink-github":
        fail("github-link/wrangler.jsonc must name the Worker directorlink-github")
    if config.get("main") != "worker.js" or "assets" in config:
        fail("github-link/wrangler.jsonc runs worker.js and publishes no files")
    if config.get("routes") != [{"pattern": "github.directorlink.io", "custom_domain": True}]:
        fail("github-link/wrangler.jsonc routes must be exactly the custom domain github.directorlink.io")
    if config.get("observability", {}).get("enabled") is not True:
        fail("github-link/wrangler.jsonc must enable Workers observability")
    worker = (GITHUB_LINK / "worker.js").read_text(encoding="utf-8")
    require(worker, f'const REPOSITORY = "{REPOSITORY}";', "github-link/worker.js must lead to the repository")
    require(worker, "REPOSITORY + path + url.search", "github-link/worker.js must keep the path and query")
    require(worker, ", 301)", "github-link/worker.js answers with a permanent redirect")


def check_short_links():
    """The long address is for machines only; every link people see is the short one."""
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    long_address = REPOSITORY.lower().removeprefix("https://").encode()
    for relative in tracked.splitlines():
        path = ROOT / relative
        if relative in REPOSITORY_ALLOWED or not path.is_file():
            continue
        if long_address in path.read_bytes().lower():
            fail(f"{relative} uses the repository's long address; link to {GITHUB} instead")


# ADR-075: nothing reaches production without the owner's approval. The jobs that deploy the sites
# or publish the driver use the "production" environment, which the owner approves for each run,
# which alone holds the Cloudflare token, and which deploys only from main; no other job reads a
# secret or deploys (pull requests get only wrangler's dry run, no preview versions); each static
# site gets a build.json that the hourly watch (watch-live.yml, scripts/verify_live.mjs) compares
# with the public source, and that watch can only read the code and write issues.
WORKFLOWS = ROOT / ".github" / "workflows"
PRODUCTION = "production"
STAMPED_SITES = ("app", "console", "site")
WATCH_PERMISSIONS = {"contents": "read", "issues": "write"}

# A release does not run the tests again (ADR-075, 2026-10-09): release.yml starts when Validate
# DirectorLink completes on main (workflow_run) or by hand, and its first job runs only after a run
# of Validate that succeeded on a push to main of this repository (a workflow_run runs with this
# repository's token whatever started Validate: a pull request, a fork's too), or by hand on main.
# Every job works on the commit Validate passed: after Validate, github.sha is main's latest
# commit, not that one. The first job also asks GitHub whether Validate passed on the commit.
VALIDATE = "validate.yml"
RELEASE = "release.yml"
RELEASE_COMMIT = "${{ github.event.workflow_run.head_sha || github.sha }}"
RELEASE_GATE = (
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||"
    " (github.event_name == 'workflow_run' &&"
    " github.event.workflow_run.conclusion == 'success' &&"
    " github.event.workflow_run.event == 'push' &&"
    " github.event.workflow_run.head_branch == 'main' &&"
    " github.event.workflow_run.head_repository.full_name == github.repository)"
)
# A job whose if has one of these runs even when a job it needs failed or was skipped.
STATUS_OVERRIDE = re.compile(r"\b(always|cancelled|failure)\s*\(")


def workflow(name, text):
    data = yaml.safe_load(text)
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), dict):
        fail(f".github/workflows/{name} is not a workflow with jobs")
    # YAML 1.1 reads a bare `on:` key as true.
    data["on"] = data.get("on", data.get(True))
    return data


def environment(job):
    value = job.get("environment")
    return value.get("name") if isinstance(value, dict) else value


def job_runs(job):
    return "\n".join(str(step.get("run", "")) for step in job.get("steps", []) if isinstance(step, dict))


def check_workflows(workflows, ignores, tracked):
    """workflows: {file name: YAML text} of .github/workflows; ignores: {site folder: its
    .assetsignore}; tracked: the paths Git tracks."""
    deploys = releases = 0
    for name, text in sorted(workflows.items()):
        data = workflow(name, text)
        triggers = data["on"] if isinstance(data["on"], (dict, list)) else [data["on"]]
        if "pull_request_target" in triggers:
            fail(f".github/workflows/{name}: no pull_request_target (it runs others' code with this repository's secrets)")
        for job_name, job in data["jobs"].items():
            where = f".github/workflows/{name} job {job_name}"
            production = environment(job) == PRODUCTION
            runs = job_runs(job)
            if "secrets." in json.dumps(job) and not production:
                fail(f"{where} reads a secret outside the production environment (ADR-075)")
            if re.search(r"versions upload|wrangler(@[\w.]+)? preview", runs):
                fail(f"{where} uploads a preview version: that needs the Cloudflare token, which only production has")
            if any(re.search(r"wrangler(@[\w.]+)? deploy\b", line) and "--dry-run" not in line for line in runs.splitlines()):
                deploys += 1
                if not production:
                    fail(f"{where} deploys without the owner's approval: it needs environment: {PRODUCTION}")
                for folder in STAMPED_SITES:
                    if folder not in runs:
                        fail(f"{where} must deploy {folder}/ with a build.json")
                for part in ("build.json", '"commit"', '"built_at"', "$GITHUB_SHA"):
                    if part not in runs:
                        fail(f"{where} must write each site's build.json: {{\"commit\": ..., \"built_at\": ...}} ({part})")
            if "gh release create" in runs:
                releases += 1
                if not production:
                    fail(f"{where} publishes a release without the owner's approval: it needs environment: {PRODUCTION}")
            permissions = job.get("permissions") or {}
            if isinstance(permissions, dict) and "write" in permissions.values() and not production and name != "watch-live.yml":
                fail(f"{where} may write to the repository outside the production environment")
            if production and "refs/heads/main" not in str(job.get("if", "")):
                fail(f"{where} runs in production: only from main (if: ... github.ref == 'refs/heads/main')")
        if name in ("deploy.yml", "release.yml") and data.get("permissions") != {"contents": "read"}:
            fail(f".github/workflows/{name}: the workflow's permissions must be contents: read (the job that publishes asks for more)")
    if not deploys or not releases:
        fail("the sites' deploy (wrangler deploy) and the driver's release (gh release create) must each be in a workflow job")
    check_release(workflows)

    if "watch-live.yml" not in workflows:
        fail(".github/workflows/watch-live.yml must compare the live sites with the source every hour (ADR-075)")
    watch = workflow("watch-live.yml", workflows["watch-live.yml"])
    if watch.get("permissions") != WATCH_PERMISSIONS:
        fail(f".github/workflows/watch-live.yml permissions must be exactly {WATCH_PERMISSIONS}")
    if any(job.get("permissions") for job in watch["jobs"].values()):
        fail(".github/workflows/watch-live.yml jobs must not ask for more permissions")
    if not isinstance(watch["on"], dict) or "schedule" not in watch["on"]:
        fail(".github/workflows/watch-live.yml must run on a schedule")
    if "node scripts/verify_live.mjs" not in "\n".join(job_runs(job) for job in watch["jobs"].values()):
        fail(".github/workflows/watch-live.yml must run node scripts/verify_live.mjs")

    for folder in STAMPED_SITES:
        for pattern in ignores[folder].split():
            if not pattern.startswith(("#", "!")) and fnmatch("build.json", pattern.lstrip("/").rstrip("/")):
                fail(f"{folder}/.assetsignore must not keep build.json from being published ({pattern})")
        if f"{folder}/build.json" in tracked:
            fail(f"{folder}/build.json must not be committed: deploy.yml writes it at each deploy")


def check_release(workflows):
    """release.yml runs after Validate DirectorLink passed on a push to main, or by hand on main,
    on that commit (RELEASE_GATE above)."""
    for name in (VALIDATE, RELEASE):
        if name not in workflows:
            fail(f".github/workflows/{name} is missing: a release starts once Validate DirectorLink has passed")
    validate = workflow(VALIDATE, workflows[VALIDATE])
    release = workflow(RELEASE, workflows[RELEASE])
    where = f".github/workflows/{RELEASE}"
    triggers = release["on"] if isinstance(release["on"], dict) else {}
    if set(triggers) != {"workflow_run", "workflow_dispatch"}:
        fail(f"{where} must run only after Validate DirectorLink (workflow_run) or by hand (workflow_dispatch), "
             "not on a push or a pull request: the tests run in Validate")
    after = triggers.get("workflow_run") or {}
    if after.get("workflows") != [validate.get("name")] or after.get("types") != ["completed"] or after.get("branches") != ["main"]:
        fail(f"{where} must start when {validate.get('name')} completes on main "
             f"(workflow_run: workflows: [{validate.get('name')}], types: [completed], branches: [main])")
    if (release.get("env") or {}).get("SHA") != RELEASE_COMMIT:
        fail(f"{where} must work on the commit Validate passed: env: SHA: {RELEASE_COMMIT}")
    if re.search(r"GITHUB_SHA|github\.sha\b", json.dumps(release["jobs"])):
        fail(f"{where}: use $SHA, the commit Validate passed; after Validate, github.sha is main's latest commit")

    asks = False
    for job_name, job in release["jobs"].items():
        here = f"{where} job {job_name}"
        condition = " ".join(str(job.get("if", "")).split())
        if not job.get("needs"):
            if condition != RELEASE_GATE:
                fail(f"{here} must run only after Validate passed on a push to main of this repository, "
                     f"or by hand on main: if: {RELEASE_GATE}")
            asks = asks or "actions/workflows/validate.yml/runs?head_sha=$SHA" in job_runs(job)
        if STATUS_OVERRIDE.search(condition):
            fail(f"{here} must not run when a job it needs failed or was skipped (no always(), cancelled() or failure())")
        for step in job.get("steps", []):
            checkout = isinstance(step, dict) and str(step.get("uses", "")).startswith("actions/checkout@")
            if checkout and (step.get("with") or {}).get("ref") != "${{ env.SHA }}":
                fail(f"{here} must check out the commit Validate passed (with: ref: ${{{{ env.SHA }}}})")
        permissions = job.get("permissions") or {}
        if "gh release create" in job_runs(job):
            if '--target "$SHA"' not in job_runs(job):
                fail(f"{here} must create the release at the commit Validate passed (--target \"$SHA\")")
            if permissions != {"contents": "write"}:
                fail(f"{here} must ask for exactly contents: write")
            if "needs.build.outputs.sums" not in json.dumps(job):
                fail(f"{here} must publish only the files the build job checked (needs.build.outputs.sums)")
        elif not isinstance(permissions, dict) or any(value not in ("read", "none") for value in permissions.values()):
            fail(f"{here} may only read")
    if not asks:
        fail(f"{where} must ask GitHub, before anything is built, whether Validate DirectorLink passed on the commit "
             "(actions/workflows/validate.yml/runs?head_sha=$SHA)")


def check_deploy_workflows():
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
    check_workflows(
        {path.name: path.read_text(encoding="utf-8") for path in sorted(WORKFLOWS.glob("*.yml"))},
        {folder: (ROOT / folder / ".assetsignore").read_text(encoding="utf-8") for folder in STAMPED_SITES},
        set(tracked),
    )


def check_disclaimers():
    """The disclaimer stays prominent: near the top of the README and the API's README, and in the console."""
    for relative, lines in (("README.md", 12), ("api/README.md", 6)):
        top = "\n".join((ROOT / relative).read_text(encoding="utf-8").splitlines()[:lines])
        if DISCLAIMER not in top:
            fail(f"{relative} must say, in its first {lines} lines: {DISCLAIMER}")
    require((CONSOLE / "index.html").read_text(encoding="utf-8"), DISCLAIMER, f"console/index.html must say: {DISCLAIMER}")


def main():
    check_console()
    check_disclaimers()
    check_site()
    check_icons()
    check_github_link()
    check_short_links()
    check_deploy_workflows()
    print("OK: DirectorLink console, site, short link and their deploy validated")


if __name__ == "__main__":
    main()
