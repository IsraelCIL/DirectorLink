# DirectorLink Project Specification

This file is the durable source of truth for the DirectorLink project. It exists so development can continue without relying on any previous chat or private context.

## Product goal

DirectorLink is an open-source, local-first management platform for **Control4 homeowners**.

It is intended for homeowners who want straightforward day-to-day device control and automation without having to use the full Composer Pro interface for routine changes.

DirectorLink is **not** a clone of Composer Pro and is not intended to replace advanced project engineering.

## Core product boundary

DirectorLink begins from one assumption:

> `DirectorLink.c4z` is already installed in the Control4 project.

How it was installed is outside the project scope. A homeowner may ask an integrator to install it, install it themselves if they have appropriate access, or use another installation workflow.

After installation, DirectorLink depends on **Director**, not Composer.

## Supported platform

- Minimum Director OS: **3.3.0**
- Target: **3.3.x and newer**, including later 3.x and 4.x/X4 where compatibility is confirmed
- Public DirectorLink API must remain stable across Director versions
- Director-version differences belong in the internal compatibility layer

## V1 architecture

```text
PWA on Cloudflare Workers (app.directorlink.io)
        |
        | static HTML / JS / CSS
        v
Browser
        |                                   |
        | at home: Local Network Access,    | away (optional): api.directorlink.io,
        | direct LAN connection, sealed     | sealed end to end; the driver keeps
        | requests (app) or API key         | one outgoing WebSocket to it
        v                                   v
DirectorLink.c4z
        |
        | Control4 DriverWorks APIs
        v
Control4 Director
        |
        v
Existing Control4 project/devices
```

At home the browser talks to DirectorLink directly. Remote access, when switched on, passes the app's requests through DirectorLink's relay, sealed end to end so that the relay cannot read or change them (docs/ACCOUNTS.md, ADR-029).

## V1 connectivity

- LAN first
- Optional remote access through api.directorlink.io (off by default; Composer **Remote Access**), sealed end to end, with Google sign-in
- No Internet-exposed DirectorLink port
- No port forwarding recommendation
- The app, console and landing page are Cloudflare Workers static sites; the app is an installable PWA with an offline copy

## V1 authentication

- One owner and invited family members; every client (browser, phone, Home Assistant, script) gets its own named API key with a role (`viewer`, `member`, `doors`, `admin`), grouped by person (profiles)
- Authenticated API even on LAN: `Authorization: Bearer <api key>`, or a request sealed with the key's lock key (`/v1/sealed`, the app's way since 1.0.0), on every route except health, the API description and pairing
- No default/shared password; credentials do not depend on Control4 cloud credentials
- Keys are random; Director keeps only a SHA-256 hash of each (SHA-1 where SHA-256 is missing) and, for sealed requests, each key's lock key; keys survive driver updates and restarts; listed without secrets and revocable (through the API, or all at once with a Composer action)
- First key (0.2.0): exchange the 8-digit Composer pairing code — valid 15 minutes, rotated after use, rate-limited
- Since 0.8.0: the owner pairs once with a pairing code created in Composer (**New Pairing Code**, valid 15 minutes, works once, only on the home network); it is the only way to a first key. Further keys are created by an admin, and family members and the owner's other devices join by invitation (0.10.0). (0.3.0–0.7.0 approved clients with a **C4Bridge Access** button instead.)
- Since 1.3.0: the app and the API console pair with CPace, so the code never crosses the network (ADR-039); a key may expire (`expires_in`), and the console's own key lasts a day (ADR-040)

## V1 device scope

Supported device families (1.2.0):

1. Lights (Light V2 and the legacy Light proxy)
2. HVAC / thermostat / climate (Thermostat V2, Control4 thermostat proxy)
3. Shades / blinds / motorized covers/windows
4. Cameras (snapshots)
5. Doors and gates on KNX Contact/Relay devices
6. DoorBird doorbells (rings, and opening their door)
7. Fans (the Control4 fan proxy: on, off and four speeds; 1.2.0)
8. The alarm's status (security partitions), read-only and off by default (1.2.0, ADR-038)
9. Samsung refrigerators through the Samsung Refrigerator (DirectorLink) driver: temperatures, the door, the water filter, and Power Cool, Power Freeze, Sabbath Mode and the ice maker (1.7.0, ADR-049)

Policy for everything else:

- Discover it
- Show it
- Mark it as **unsupported**
- Add adapters one device/proxy family at a time

Do not send guessed raw commands to unknown devices.

## Control4 abstraction

The public API must never require a client to know Control4 command names.

Example:

```text
DirectorLink API:
set_brightness(70)

Internal adapter:
Control4 proxy-specific command
```

The normalized entity model should preserve:

- proxy ID
- proxy driver filename
- room
- protocol driver relationship
- protocol driver ID/name/filename
- normalized kind
- supported/unsupported status
- capabilities/state when adapters implement them

## Project ownership

DirectorLink owns its own:

- scenes/routines
- schedules
- automations

DirectorLink does **not** import or depend on:

- Composer programming
- Composer schedules
- Composer scenes
- Composer agents as the primary automation engine

## V1 scheduler scope

Built in 0.14.0 (docs/SCHEDULES.md):

- fixed clock time
- day-of-week rules
- sunrise
- sunset
- positive/negative sunrise/sunset offsets
- the weather (heat, wind, rain, from Open-Meteo) as a trigger, and as an "only if" condition
- persistent schedules that survive Director restart
- DirectorLink scenes as schedule actions

The scheduler runs inside DirectorLink/Director so a PC, browser, or phone does not need to remain online, and is visible and pausable in Composer (0.15.0).

## Solar data

Use project location/time-zone data exposed by Director. Solar calculations should run locally so ordinary schedules do not require Internet access.

## Not in V1

- adding/removing arbitrary Control4 drivers
- editing bindings
- Composer-style programming editor
- importing Composer programming
- Control4 project upgrades
- automatic `.c4z` self-update
- generic execution of raw commands against unknown devices

## Optional/deferred extensions

A plugin architecture may be added later for niche functionality. The Jewish-calendar module — Shabbat and holiday times as schedule triggers and conditions, the Hebrew date and the weekly reading — is built in 1.2.0 as an optional module inside the driver, off until an installer turns it on in Composer (ADR-037, docs/SCHEDULES.md, docs/CALENDAR.md).

## Distribution and versioning

- Official `DirectorLink.c4z` binaries are distributed through **GitHub Releases**
- The repository `VERSION` file holds the `MAJOR.MINOR.PATCH` release version (no suffixes) and is the only version to edit
- Release assets include `DirectorLink.c4z`, `openapi.json` and `SHA256SUMS.txt`
- Users may install a newer or older release manually through Composer Pro
- Downgrade safety is release-specific once persistent data formats exist
- No automatic in-driver update is part of V1

## Licensing

Apache License 2.0.

## Adapters added in 1.1.0

Rebuilt from bkwagner's pull requests #14, #19 and #16 (ADR-033). The IDs and commands were read
on a live Director (the floor heating in a °F project). The command names below stay inside the
adapters: the API shows only `on`, `brightness`, `mode`, `target_temperature`, `heat_setpoint`,
`cool_setpoint` and `fan_speed`.

### Legacy Light proxy (`light.c4i`) — 1.1.0

Older Control4 dimmers and switches (LDZ-101/102, LDZ-5S1) use the legacy Light proxy. It has its
own adapter (`light_v1.lua`), so the Light V2 path validated on real hardware stays unchanged:

- state variable `1000`, and level variable `1001` on dimmers (a proxy without it is a switch)
- the light is controllable only when `1000` exists and its listeners register
- normalized `on` → `ON`, `off` → `OFF`, `set_brightness` → `SET_LEVEL` with `LEVEL`, no ramp
  time (the dimmer's own rate)
- no KNX exception like Light V2's `knx_dimmer.c4i`, until a trace from a real device calls for one
- at Debug level, the start-up log lists each proxy's variables and protocol drivers

No DirectorLink command has moved one of these lights on a real controller yet.

### Thermostat V2: floor heating on its heat setpoint — 1.1.0

A Thermostat V2 zone follows its heat setpoint only when all three hold:

- its mode list (`1120`) has Heat and neither Cool nor Auto
- its single setpoint reads 0 in both scales: `1149` (always °F) and `1150` (°C; a missing `1150`
  keeps the single setpoint)
- its heat setpoint `1133` (°C) has a value other than 0

The rule is checked again on every change to `1120`, `1133`, `1149` and `1150`. Only a heat-only
zone whose single setpoint reads 0 reads and watches `1133` and `1150`, at start-up and whenever it
looks again: the mode list or one of these can arrive later, so such a zone looks again on changes
to `1120`, `1149` and the room temperature (`1131`). A zone in use on its single setpoint starts
with the reads, listeners and log line of 1.0.0 and reads nothing more; if its single setpoint
drops to 0, that change looks again. On that path the target is `1133`, the range starts at 5 °C,
and `set_temperature` sends `SET_SETPOINT_HEAT` with `FAHRENHEIT` (whole degrees) when the project
scale (`1100`) is °F, or `CELSIUS` otherwise. Every other zone keeps `SET_SETPOINT_SINGLE` and
16–32 °C, and zones with Cool or Auto never read or watch `1133` and `1150`. The variable list
(`C4:GetDeviceVariables`) is read only at Debug, for the log. A fan mode of `Undefined` is no fan
speed, and a zone whose mode list loses Cool after start-up loses its fan control, as a zone
without Cool never gets it.

### Control4 thermostat proxy (`control4_thermostat_proxy.c4i`) — 1.1.0

Control4 thermostats with separate heat and cool setpoints. The variables (`thermostat_proxy.lua`):

| Id | Name | Id | Name |
| --- | --- | --- | --- |
| 1100 | SCALE | 1130 / 1131 | TEMPERATURE_F / TEMPERATURE_C |
| 1104 | HVAC_MODE | 1132 / 1133 | HEAT_SETPOINT_F / HEAT_SETPOINT_C |
| 1105 | FAN_MODE | 1134 / 1135 | COOL_SETPOINT_F / COOL_SETPOINT_C |
| 1107 | HVAC_STATE | 1146 / 1147 | DEADBAND_F / DEADBAND_C |
| 1112 | IS_CONNECTED | 1120 / 1121 | HVAC_MODES_LIST / FAN_MODES_LIST |

- Required at start: a scale that starts with F or C (never guessed), the mode, a temperature and
  at least one setpoint pair. Every variable read is watched, the deadband too.
- Values are read in the project's scale and compared in its units (whole °F, tenths of °C); the
  API gets °C to 0.1.
- Commands: `SET_MODE_HVAC { MODE }`, `SET_MODE_FAN { MODE }`, and `SET_SETPOINT_HEAT` /
  `SET_SETPOINT_COOL` with `FAHRENHEIT` in whole degrees in a °F project, `CELSIUS` otherwise.
- One setpoint moves the other when needed to keep the deadband; two sent together must already
  be that far apart. Without a reported deadband, cool stays at least one step (1 °F or 0.1 °C)
  above heat. Cool is sent first when it goes up, heat first otherwise, so the pair never breaks
  the deadband in between. The other setpoint and "goes up" are judged against the setpoints
  DirectorLink last sent until the thermostat reports them (or for 10 s), so a request that comes
  before the report does not start from old values. Every command is checked before anything is
  sent.
- A setpoint that none of the thermostat's modes uses (heat on one with only Off and Cool) is
  reported as `null`, so clients do not offer or push it.
- The room temperature is converted as measured, not rounded to whole °F first.
- Setpoints are kept within 5–35 °C.

## Adapters added in 1.2.0

### Fan proxy (`fan.c4i`) — 1.2.0

Rebuilt from bkwagner's pull request #18 (ADR-033). Control4's fan speed controllers, and other fan
drivers, sit behind the Fan proxy. What the contributor read on a live Director, as `fan.lua` uses
it:

| Id | Name | Use |
| --- | --- | --- |
| 1000 | IS_ON | whether the fan runs |
| 1001 | CURRENT_SPEED | 0 off, 1 low to 4 high |
| 1003 | PRESET_SPEED | the speed `ON` turns it on at; only logged |

- The variables are found by name (`IS_ON` and `CURRENT_SPEED`, or Snap One's *Is On* and *Current
  Selected Speed*), else by the ids above. A fan is controllable only when both exist and their
  listeners register.
- `on` follows IS_ON; when it reads neither on nor off, a speed above 0 is on. `speed` is
  CURRENT_SPEED while the fan runs, and null while it is off or for a value other than 0–4.
- Commands, to the proxy: `on` → `ON` (the fan picks its speed: its preset, or its last one, as
  its driver chooses), `off` → `OFF`, a speed → `SET_SPEED` with `SPEED` 1–4. Speed 0, other
  values and other actions are refused before anything is sent: off is `{"on": false}`.
- The API shows `on`, `speed` and `speeds` (`GET /v1/fans`, `GET` and `PATCH /v1/fans/{id}` with
  `{"on": …}` or `{"speed": 1-4}`); scene steps take `{"on": …}` or `{"speed": 1-4}`.
- At Debug, the start-up log lists each proxy's variables with their values, and its `GET_SETUP`
  answer (Snap One documents the number of speeds and their names there), which nothing depends
  on yet.
- **Every fan is taken to have four speeds.** Snap One's fan proxy takes 0 to N speeds
  (`discrete_levels` in its setup); DirectorLink does not read that yet. On a fan with three, its
  top speed shows as Medium High and High sends `SET_SPEED` 4, a speed it does not have; on a fan
  with five or more, the speeds above 4 show only as on.

No DirectorLink command has run on a real fan yet.

### Security partitions (`security.c4i`), read-only — 1.2.0

Rebuilt from bkwagner's pull request #15 (ADR-038); the variables were read on a live Director.
A partition is one area of the home's alarm that is armed on its own. `alarm.lua` watches a
partition only while the Composer property **Alarm Status** is On (default Off: not watched, and
unsupported as before):

| Id | Name | Id | Name |
| --- | --- | --- | --- |
| 1000 | HOME_STATE (armed home) | 1007 | PARTITION_STATE |
| 1001 | AWAY_STATE (armed away) | 1008 | DELAY_TIME_TOTAL (seconds) |
| 1002 | DISARMED_STATE | 1009 | DELAY_TIME_REMAINING (seconds) |
| 1003 | ALARM_STATE | 1010 | OPEN_ZONE_COUNT |
| 1005 | TROUBLE_TEXT | 1011 | ALARM_TYPE |
| 1006 | IS_ACTIVE | 1012 | ARMED_TYPE |

- 1004 is not read, as in #15. A partition is supported only when `1007` can be read and every
  variable read registers a listener; everything read is watched.
- `IS_ACTIVE = 0`: a partition the panel does not use, left out of `GET /v1/alarm` and of the
  count in Composer's Inventory. It is followed as it changes: the panel may connect after Director
  starts.
- The API shows `state` (`PARTITION_STATE` in lower case: `disarmed_ready`, `disarmed_not_ready`,
  `armed`, `exit_delay`, `entry_delay`, `alarm`, `confirmation_required`, `offline`, or what else a
  panel reports), `armed`, `armed_mode` (`home`/`away`), `armed_type` and `alarm_type` (the panel's
  words, only while armed or in alarm), `open_zones`, `delay` (`entry`/`exit`, seconds left and in
  all) and `trouble`.
- Nothing is sent to a partition, and its state is never logged; `scripts/check_package.py` keeps
  the adapter to `C4:GetVariable`, `C4:RegisterVariableListener` and `C4:UnregisterVariableListener`.
- Members and admins read it, only in sealed answers (`403 SEALED_REQUEST_REQUIRED` in the clear);
  viewers get `403`.

No DirectorLink build has run against a real alarm yet.

## History: the first milestones (to 0.2.0)

What was built first, kept as written then. What has been built since is in `docs/releases/`, and
what comes next in `docs/ROADMAP.md`.

### Step 1 — bootstrap/package

Complete:

- repository initialized
- Apache-2.0
- DriverWorks `.c4z` source structure
- minimum OS metadata
- runtime OS version gate
- architecture and protocol documentation

### Step 2 — project discovery

Implemented:

- Director/project metadata
- project hierarchy
- all devices via `C4:GetDevices({})`
- hierarchy normalization
- room fallback from device records
- proxy/protocol relationship preservation
- known proxy classification
- normalized in-memory registry
- Composer-visible discovery status

### Step 3 — Light V2 adapter

Implemented in `v0.1.0-alpha.7`, with On/Off validated and KNX DriverWorks dimmer validation pending:

- Light V2 proxy detection
- state variable `1000`
- brightness variable `1001` when present
- variable subscriptions/live registry updates
- normalized `on` → Light V2 preset ID 1
- normalized `off` → Light V2 preset ID 2
- normalized `set_brightness` → adapter-selected compatibility path; KNX dimmers use `RAMP_TO_LEVEL` with `LEVEL` + `TIME = 0`, other Light V2 dimmers use `SET_BRIGHTNESS_TARGET` + `PERCENT`
- dedicated `GET /v1/lights` endpoint
- PWA Light controls

DirectorLink sends control only to the Light V2 proxy ID. It does not address backing protocol drivers directly.


### PWA shell — implemented ahead of transport

The initial Cloudflare Pages PWA shell is implemented under `app/` (Workers static assets since 0.8.0):

- framework-free HTML/CSS/JavaScript
- installable web manifest
- offline application shell via service worker
- Director IP/local-hostname storage
- browser readiness diagnostics
- security headers
- raster/SVG application icons

The PWA talks to the driver's LAN API directly. The service worker ignores all cross-origin requests so LAN traffic is never cached or proxied by the web shell. An API console page (`app/console.html`; `console/` since 0.8.0) lists every endpoint from the live API description and follows the bridge log.



### LAN API — 0.2.0

The LAN API is described by `api/openapi.yaml` (OpenAPI 3.1) and served on TCP port `41999`:

- HTTP on the LAN only; the public app remains HTTPS
- Chrome Local Network Access permission gates the public-to-local browser request
- API keys (Bearer) on every route except health, the API description and pairing
- CORS restricted to official DirectorLink origins, plus localhost for development (localhost removed in 1.0.0, ADR-032)
- logical resources: system, rooms, devices, lights, thermostats, logs, API keys
- `PATCH` with the desired state, answered with `202 Accepted`; RFC 9457 errors

See `api/README.md` for conventions and examples. The alpha routes (`/v1/system/info`, `/v1/climate`, `/v1/devices/{id}/actions/...`, `/v1/diagnostics`, header-based `/v1/pair`) were removed in 0.2.0.


### Thermostat V2 — alpha.9

The first climate adapter is implemented against the real Director command shapes captured from the stock Control4 UI.

State currently normalized from Thermostat V2 includes:
- current temperature in Celsius
- single target setpoint
- HVAC mode
- HVAC state
- fan mode where applicable
- connection state
- allowed HVAC mode list

Normalized actions:
- `set_hvac_mode`
- `set_fan_mode`
- `set_temperature`

Internal commands used on the real test system:
- `SET_MODE_HVAC { MODE = ... }`
- `SET_MODE_FAN { MODE = ... }`
- `SET_SETPOINT_SINGLE { CELSIUS = ... }`

DirectorLink exposes only actions supported by the normalized device capabilities. Heat-only zones do not receive cooling controls.

Since 0.2.0 these are exposed through `PATCH /v1/thermostats/{id}` as `mode`, `fan_speed` and `target_temperature`; the command names above stay internal to the adapter.
