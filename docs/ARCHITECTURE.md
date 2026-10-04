# DirectorLink Architecture

## Product boundary

DirectorLink is a homeowner-facing local management layer for Control4 Director OS 3.3.0+.

DirectorLink assumes `DirectorLink.c4z` is already installed. Installation method is out of scope.

## Runtime

```text
Cloudflare Workers static sites: app/ (app.directorlink.io),
console/ (console.directorlink.io), site/ (directorlink.io)
        |
        | HTTPS: static files only
        v
Browser / any API client (curl, Home Assistant, scripts)
        |                                     |
        | at home: LAN HTTP,                  | away (the app): HTTPS,
        | sealed (app) or API key (scripts),  | sealed end to end
        | described by api/openapi.yaml       v
        |                          api.directorlink.io (cloud/): accounts and the relay
        |                                     |
        |                                     | the driver's one outgoing WebSocket
        v                                     | (docs/RELAY.md)
DirectorLink.c4z inside Director  <-----------+
        |
        | DriverWorks
        v
Existing Control4 project devices
```

At home, clients talk to DirectorLink directly: the app with sealed requests, scripts with an API key. Away, the app's requests go through api.directorlink.io (`cloud/`), sealed end to end, so the relay cannot read them (docs/ACCOUNTS.md, docs/RELAY.md). Remote access is optional and off by default.

## Repository

```text
api/        openapi.yaml — the API contract (single source of truth)
driver/     the DriverWorks driver
  src/api/        HTTP server, router, handlers, views (API ↔ internal model)
  src/auth/       API keys, roles, pairing, profiles, invitations
  src/adapters/   Control4 proxy adapters (Light V2, Light V1 (legacy Light proxy), Thermostat V2, Control4
                  thermostat proxy, Fan, Blind, Camera, KNX Contact/Relay, DoorBird, security
                  partitions: read-only, ADR-038; Samsung refrigerators through their DirectorLink
                  driver's variables, ADR-049)
  src/cloud/      remote access: WebSocket client, relay connection (docs/RELAY.md), the end-to-end
                  lock (lock.lua) and sealed requests, claims and joins (remote.lua); automatic
                  backups to the account, sealed to the backup password's key (auto_backup.lua,
                  backup_seal.lua; ADR-048); alerts sealed to each device's key (alerts.lua; ADR-050)
  src/control4/   discovery and normalization; Director's project events (Composer changes, read
                  again without a restart) and device events; camera snapshots
  src/core/       json, log, store, registry, version; random (secrets) and x25519 (pairing);
                  scenes, scene links (a private link per scene for the phone's automations,
                  ADR-051), schedules, scheduler, sun, weather, installer view; room names and layout;
                  backup (backup and restore, ADR-042; docs/BACKUP.md);
                  activity (the history admins read, ADR-046; docs/HISTORY.md);
                  the Jewish calendar (jewish_calendar, the service, and its pure engine: hebrew_date,
                  holidays, parasha, holy_times; docs/CALENDAR.md)
  tests/          driver tests against a fake Director
app/        the app (PWA), deployed to app.directorlink.io
console/    API console, debugging and logs, deployed to console.directorlink.io
site/       landing page, deployed to directorlink.io
cloud/      accounts and the relay (Cloudflare Worker), api.directorlink.io
tests/      app and cloud tests, shared test vectors
scripts/    build and validation
docs/       specification, decisions, research, releases
```

## Driver layers

```text
request bytes → api/http.lua (parse) → api/server.lua (Host check, CORS, auth, routing, errors, access log)
             → api/handlers/*.lua → api/views.lua (public JSON)
sealed request (POST /v1/sealed, or an envelope from the relay)
             → api/handlers/sealed.lua → cloud/remote.lua (open, check, run as the key) → the same handlers
             → adapters/*.lua (Control4 commands) → Director
```

Control4 specifics — proxy drivers, command names, variable IDs — live only in `adapters/` and `control4/`. `api/views.lua` is the one place internal records become public JSON.

## Core rules

1. Minimum supported Director version: 3.3.0.
2. Director is the only Control4 runtime dependency.
3. Do not import Composer programming, schedules, or scenes.
4. DirectorLink owns its own scenes, schedules, and automations.
5. Unknown device types are visible but marked unsupported.
6. The public API uses logical names, never raw Control4 command names.
7. OS/version differences stay behind the Control4 compatibility layer.
8. The API needs an API key (or a request sealed with a key's lock key, `/v1/sealed`) for everything except health, the API description and pairing. Remote access is optional, off by default, and sealed end to end.
9. No automatic C4Z self-update in V1.
10. `api/openapi.yaml` and the driver routes must always match (enforced in CI).
