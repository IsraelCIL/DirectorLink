# DirectorLink

**Direct to Director. End-to-end integration. Open source.**

DirectorLink is an open-source, local-first management layer for Control4 homeowners.

The goal is to provide simple device control, scenes, schedules, and everyday automation without requiring homeowners to use Composer Pro for routine changes.

## Screenshots

The app on a demo home: made-up rooms and devices, and drawn camera pictures.

<table>
  <tr>
    <td><img src="docs/screenshots/home.png" width="260" alt="Home: the alarm, what is on, one-tap scenes, favorites with a camera picture, and the rooms"></td>
    <td><img src="docs/screenshots/room.png" width="260" alt="Living Room: dimmable lights with switches and brightness sliders, and the AC"></td>
    <td><img src="docs/screenshots/climate.png" width="260" alt="Climate: the living room AC cooling to 23 degrees and the bedroom floor heating at 24, by room"></td>
  </tr>
  <tr>
    <td align="center">Home</td>
    <td align="center">A room</td>
    <td align="center">Climate</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/scenes.png" width="260" alt="Scenes: Good Morning, Movie Night, Leaving Home and Good Night, each one tap to run"></td>
    <td><img src="docs/screenshots/schedules.png" width="260" alt="Schedules: the weather at home, and scenes run on weekday mornings, at sunset and when it gets hot"></td>
    <td><img src="docs/screenshots/home-dark.png" width="260" alt="Home in dark mode"></td>
  </tr>
  <tr>
    <td align="center">Scenes</td>
    <td align="center">Schedules</td>
    <td align="center">Dark mode</td>
  </tr>
</table>

<img src="docs/screenshots/desktop.png" alt="Home in a desktop browser: side navigation, scenes, favorites and room cards side by side">

## V1 scope

- Control4 Director OS **3.3.0+**
- `DirectorLink.c4z` is assumed to already be installed in the Control4 project
- Installation method is outside the scope of this project
- A standard REST API on the local LAN, described by OpenAPI 3.1, protected by API keys
- An app (PWA) hosted on Cloudflare; the browser connects directly to DirectorLink over the LAN, and seals every request with its own lock key, so its API key does not cross the network
- LAN-first, with no port forwarding; remote access with a Google or Apple account through `api.directorlink.io`, locked end to end so that DirectorLink's servers cannot read it (off by default; `docs/ACCOUNTS.md`)
- One owner and invited family members, with a separate named API key and role (viewer, member, doors, admin) per browser, app or script
- Device adapters: lights (Light V2 and the older Light proxy), HVAC/climate (Thermostat V2, including floor heating set through its heat setpoint, and Control4 thermostats with heat and cool setpoints), fans (the Control4 fan proxy: on, off and four speeds), blinds, cameras (snapshots), KNX relays (doors and gates), DoorBird doorbells, Samsung refrigerators (through the Samsung Refrigerator (DirectorLink) driver: temperatures, the door, Power Cool, Power Freeze, Sabbath Mode and the ice maker), the alarm's status (security partitions: read-only, off by default), and Sonos speakers on the home network (off by default; DirectorLink talks to them itself, docs/SONOS.md)
- Room names in several languages
- Unknown devices are exposed as unsupported
- DirectorLink owns its own scenes, schedules, and automations
- No import of Composer programming, scenes, or schedules
- Schedules by time and weekday, at sunrise or sunset with offsets, and by the weather (heat, wind and rain from Open-Meteo), with "only if" weather conditions; with the Jewish calendar on, also at candle lighting and havdalah, or never or only on Shabbat and holidays (worked out on the controller)
- Director location/timezone used for solar scheduling
- A private link per scene for the phone's own automations (iPhone Shortcuts, Android apps, an NFC tag), through the account; never for scenes that open doors or gates, and every run in History (docs/SCENES.md)
- No automatic `.c4z` self-update in V1

## Installation

You need **Composer Pro**, Control4's setup tool, to add DirectorLink to your Control4 project, and later to update it. After that, DirectorLink runs on its own: the app, scenes and schedules never need Composer. Its settings, such as Remote Access for using the app away from home, are set in Composer too.

### 1. Download DirectorLink

Download DirectorLink from **[GitHub Releases](https://github.directorlink.io/releases)**.

Each release keeps its own `DirectorLink.c4z`, `openapi.json`, release notes, and SHA-256 checksums so users can upgrade or downgrade to a specific version.

### 2. Get Composer Pro

DirectorLink is installed like any other Control4 driver: with Composer Pro, on a Windows computer on the same network as your controller.

- **You need an active Control4 account with access to Composer Pro.** Composer asks you to sign in with it, and it can't connect to your controller without it. Control4 gives these accounts to its dealers and installers.
- **Download Composer Pro from https://composer.directorlink.io.** It lists the Composer installers on Control4's own servers, newest first. Choose the newest **Composer Pro** release and install it.
- **No Composer Pro account?** Ask your Control4 installer to add DirectorLink for you and to set what you want on (Remote Access, Sonos and the others in step 3). It takes a few minutes and needs no reboot.

### 3. Add the driver to Composer

1. Open Composer Pro and connect to your Director.
2. In the top menu, choose **Driver → Add or Update Driver**.
3. Select `DirectorLink.c4z`.
4. Go to **System Design**.
5. Select any room in the project tree. DirectorLink only needs one instance in the project; the room is not functionally important.
6. Open the **Search** tab in the Items pane.
7. Make sure **Local** drivers are included and search for **DirectorLink**.
8. Double-click or drag **DirectorLink** into the selected room.
9. Select the DirectorLink device and check its Properties.

A successful install shows:

- **Status:** `Ready`
- **Version:** the installed DirectorLink release
- **API Status:** `Online - port 41999`. If it says `Port 41999 taken by another driver`, another driver took the port when the controller started: restart the controller (DirectorLink also asks for the port again every minute)
- **Pairing Code:** 8 digits shown as `1234 5678`, with **Pairing Status** `Ready until HH:MM - works once`
- **API Keys:** how many keys exist
- **Door Control:** `Disabled` until you allow opening doors and gates from the app
- **Relay Hold:** `Not allowed`, so doors and gates are only pulsed (a short press, like their Open button). `Allowed` also lets API clients hold any relay closed, which holds a door or gate open
- **Alarm Status:** `Off`, so DirectorLink does not watch the alarm. `On` shows members and admins in the app (never viewers) whether each partition of the alarm is armed, in alarm, has open zones or trouble. Read-only: DirectorLink never arms or disarms
- **Remote Access** and **Remote Status**: reaching the home from anywhere with an account
- **Schedules** (`On`, or `Paused` to stop every DirectorLink schedule), **Schedule Status** (what is on and what runs next) and **Last Automation** (the last scene DirectorLink ran, when and why); the action **Print Schedules and Scenes** lists them all in the Lua output
- **Sonos:** `Off`, so DirectorLink looks for no Sonos speaker. `On` shows each Sonos room in the app, in the Control4 room of the same name, with play, pause, skip, volume and the Sonos favorites; **Sonos Address** (optional) names one player when the search finds none, and **Sonos Players** shows what was found ([`docs/SONOS.md`](docs/SONOS.md))
- **Jewish Calendar:** `Off`, so DirectorLink works out no Shabbat or holiday times. `On` gives schedules and the app Shabbat and holiday times, the Hebrew date and the weekly reading, from the project's location; **Calendar Status** shows what it works out
- **Log Level** and **Inventory** (rooms and devices found)

Actions: **New Pairing Code**, **Revoke All API Keys** (every key, invitation and scene link), **Print Schedules and Scenes**, **Refresh Project** (reads the project again after changes in Composer; DirectorLink is also meant to do it by itself a few seconds after Composer's changes, which has not yet been seen on a real controller), **Reset Remote Identity** (a last resort: the controller becomes a new home for DirectorLink's servers, and the owner links it again), and **Remove All Scene Links** (every scene's link for automations stops working at once). If a copy of the project's data got into the wrong hands, run Revoke All API Keys, and have the home's owner use **Replace the remote secret** in the app (Settings → Account, at home). A DirectorLink backup file together with its password counts as such a copy.

If the status shows an error, open `GET /v1/logs` (see below) or capture the DirectorLink Lua log and open a GitHub issue.

### 4. Pair the owner's device

Open **https://app.directorlink.io**, enter the controller IP (or tap **Find my controller**, in Chromium browsers on computers and Android) and the **Pairing Code** from the DirectorLink properties. The device gets an admin key.

> **Pair from a computer or an Android phone, not from an iPhone or iPad.** On iPhone and iPad every browser (Safari, Chrome, Edge, …) uses Apple's WebKit, which blocks a secure page such as app.directorlink.io from reaching the controller's plain `http://` address on the home network, and offers no permission to allow it. Pairing cannot work there. iPhones and iPads join through the account instead: on a paired computer at home, sign in and use Settings → Account → **Link this home**. Then, on the iPhone, sign in with the same account and tap **Join from another device**; the computer shows the request, and you approve it there by typing the code the iPhone shows (1.7.0). This is the way for the app added to the Home Screen, which iOS never opens links in. **Add my other device** still makes a QR code and a link, which **Paste invitation link** takes too.

A code is valid for 15 minutes and works once, and only on the home network. Five wrong codes lock pairing for that device for a minute; twenty close the code. The app never sends the code: it pairs with CPace, so neither the code nor its new key can be read or taken on the network (with a DirectorLink before 1.3.0 it warns first, and only **Pair anyway** sends the code). The API console pairs the same way, and its own key lasts a day. A new DirectorLink shows one right away; later, run the Composer action **New Pairing Code** on DirectorLink (an installer can read it out for the homeowner). Other devices and family members do not pair: an admin invites them (Settings → Account → **Invite someone**, with remote access) or creates their keys (API console → Keys).

### Updating DirectorLink

Automatic self-update is intentionally **not** part of V1.

Update the installed driver manually through Composer Pro using the `DirectorLink.c4z` asset from the desired GitHub Release. Admins see in the app when a newer release is out (Settings → Controller, and a notice on Home), with a download of its `DirectorLink.c4z` and the steps in Composer.

**Important:** before updating, make sure the local file is named exactly `DirectorLink.c4z`. Do not select `DirectorLink (1).c4z`, `DirectorLink (2).c4z`, etc. A real Director snapshot showed those suffixed filenames can be installed as separate driver files instead of replacing the canonical package. A browser adds the suffix when an older `DirectorLink.c4z` is already in the download folder, so delete that one before downloading (or download into an empty folder).

To downgrade, download `DirectorLink.c4z` from an older release and install that version through Composer Pro. Release notes say when a downgrade is not safe.

Do not remove and re-add the project instance unless a release specifically requires it. Removing it deletes everything DirectorLink keeps: have an admin make a backup in the app first (Settings → Controller → Backup, [`docs/BACKUP.md`](docs/BACKUP.md)), or turn on automatic backups to the account there (1.6.0).

## API

The LAN API is a standard REST API described by **[`api/openapi.yaml`](api/openapi.yaml)** (OpenAPI 3.1) — see **[`api/README.md`](api/README.md)** for conventions and examples.

```bash
curl http://<controller-ip>:41999/v1/lights -H "Authorization: Bearer <api key>"
curl -X PATCH http://<controller-ip>:41999/v1/lights/259 \
  -H "Authorization: Bearer <api key>" -H "Content-Type: application/json" \
  -d '{"brightness": 40}'
```

Resources: system, rooms, devices, lights, thermostats, fans, blinds, cameras, relays (doors and gates), doorbells, refrigerators, the alarm (read-only, sealed requests only), music (Sonos), scenes, schedules and the weather, the calendar (Shabbat and holiday times), profiles, logs, API keys, invitations and remote access. The running bridge serves its own description at `/v1/openapi.json`, so Postman, Swagger UI or Home Assistant can import it, and the app's **API console** lists and tries every endpoint.

A script's key travels in the clear on the home network (plain HTTP); give each script its own key with the least role it needs. The app does not send its key: it seals each request (`POST /v1/sealed`, [`docs/ACCOUNTS.md`](docs/ACCOUNTS.md)). Requests must name the controller by its IP address or a local name such as `director.local`.

## Design principle

DirectorLink depends on **Director**, not Composer.

```text
DirectorLink app (PWA, hosted on Cloudflare)
        |
        | Local Network Access permission
        v
Browser / any API client
        |
        | LAN: sealed requests (app) or API key (scripts)
        | away: through api.directorlink.io, sealed end to end
        v
DirectorLink.c4z
        |
        v
Control4 Director
        |
        v
Existing Control4 devices
```

## Repository

```text
api/       OpenAPI contract
driver/    DriverWorks driver (Lua 5.1) and its tests
app/       the app (PWA)                       → https://app.directorlink.io
console/   API console, debugging and logs      → https://console.directorlink.io
site/      landing page                         → https://directorlink.io
github-link/ short link to this repository      → https://github.directorlink.io
cloud/     accounts and the relay (Worker)      → https://api.directorlink.io
tests/     app and cloud tests, shared vectors
scripts/   build and validation
docs/      specification, decisions, research, releases
```

See **[`docs/BUILD.md`](docs/BUILD.md)** for building, testing and releasing, **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** for how the pieces fit, and **[`SECURITY.md`](SECURITY.md)** for reporting a security problem.

## Live

- **App:** https://app.directorlink.io
- **API console, debugging and logs:** https://console.directorlink.io
- **Website:** https://directorlink.io
- **Source code:** https://github.directorlink.io

## Status

1.0. The API is described and versioned: 1.x releases add to `/v1` without breaking existing clients, and a breaking change would get a new prefix (`/v2`). The roadmap is [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Disclaimer

DirectorLink is an independent open-source project and is not affiliated with or endorsed by Control4 or Snap One.

Installing third-party drivers or modifying a Control4 project can introduce compatibility, support, warranty, or recovery risks. Users are responsible for understanding those risks and should keep appropriate backups of their Control4 project.

## License

DirectorLink is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
