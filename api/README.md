# DirectorLink API

> **DirectorLink is an independent project, not affiliated with Control4 or Snap One.**

[`openapi.yaml`](openapi.yaml) is the contract for the LAN API that the DirectorLink driver serves on the Control4 controller. It is the single source of truth: the driver routes are checked against it in CI (`scripts/check_api.py`), the build embeds it in the driver, and every release publishes it as `openapi.json`.

A running bridge also serves its own copy at `http://<controller-ip>:41999/v1/openapi.json`, so tools such as Postman or Swagger UI can import it directly. The [API console](https://console.directorlink.io) ([`../console/`](../console/)) reads it to list and try every endpoint.

## Conventions

| Topic | Rule |
| --- | --- |
| Base URL | `http://<controller-ip>:41999` on the home network. Every path starts with `/v1`. The `Host` must be the controller's IP address or a local name (e.g. `director.local`), otherwise `421 MISDIRECTED_REQUEST`; browsers may call it only from app.directorlink.io and console.directorlink.io. |
| Names | Logical resources — rooms, devices, lights, thermostats, fans, blinds, cameras, relays, doorbells, refrigerators, the alarm, music (Sonos), scenes, schedules, the weather, the calendar, profiles, invitations. No Control4 command names, proxy IDs or variable numbers. |
| Authentication | `Authorization: Bearer <api key>` on every route except health, `GET /v1/openapi.json`, pairing (`POST /v1/auth/pair`) and `/v1/sealed`, which carries requests sealed with a key's lock key instead (the app's way, so its key does not cross the network; `docs/ACCOUNTS.md`). |
| Roles | Since 1.8.0 every key belongs to a user, `admin` or `member`, and has that user's permissions ([Users and permissions](#users-and-permissions)). Each operation states who may call it as `x-directorlink-role`: `member` (every user; the answer holds only what they may see and do) or `admin` (otherwise `403 FORBIDDEN`). `GET /v1/api-keys/current` tells a client its role and `access`. Opening doors also needs **Door Control** = Enabled in Composer. Up to 1.7.0 each key had one of four roles: `viewer`, `member`, `doors`, `admin` (ADR-025). |
| Reading | `GET` on a collection returns `{ "items": [...] }`; `GET` on an item returns the object. |
| Changing | `PATCH` with the desired state, e.g. `{"on": true}`. For a device the answer is `202 Accepted` with the last state the controller reported; read the resource again to confirm. Scenes, schedules, rooms, profiles and keys answer `200` with the stored result. |
| Errors | RFC 9457 Problem Details (`application/problem+json`) with a stable `code`, e.g. `INVALID_FIELD`, `NOT_FOUND`, `UNAUTHORIZED`. |
| JSON | snake_case properties, ISO 8601 UTC times, temperatures in °C, `null` for unknown values. |
| IDs | The numeric IDs of the Control4 project. Treat them as opaque. |
| Versioning | Breaking changes get a new path prefix (`/v2`). `info.version` is the bridge release. |

## Getting a key

The first key comes from a **pairing code**: in Composer, run **New Pairing Code** on DirectorLink (a new DirectorLink shows one right away). The code is shown as `1234 5678`, is valid for 15 minutes and works once; the key it gives is `admin`.

1. Exchange the code for a key:

   ```bash
   curl -X POST http://<controller-ip>:41999/v1/auth/pair \
     -H "Content-Type: application/json" \
     -d '{"pairing_code": "1234 5678", "name": "My laptop"}'
   ```

2. Keep the returned `key` — it is shown only once. Without an active code the answer is `403 PAIRING_NOT_ACTIVE`. Five wrong codes within a minute lock pairing for that device (IP address) for 60 s (`429`, `Retry-After`); twenty wrong codes in all close the code. Pairing works only on the home network. With `"expires_in": 86400` (seconds, 60 to 2592000) the key stops working after that long: it is then refused with `401 KEY_EXPIRED` and removed; `expires_at` says when (null for never). With `"exchange": {"public_key": …}` (X25519, base64) the answer is sealed instead (the app's way before 1.3.0).

   The app and the API console never send the code: they pair with CPace (1.3.0), in two requests (`{"name", "cpace": {"nonce"}}`, then `{"cpace": {"session", "share", "confirm"}}`); the exact inputs are in `api/openapi.yaml` (`POST /v1/auth/pair`) and `docs/ACCOUNTS.md`, the test vectors in `tests/vectors/cpace.json`. Each attempt counts as a wrong code until it succeeds. DirectorLink before 1.3.0 refuses the field `cpace` (`INVALID_FIELD`); a controller whose lock failed its self-test answers `503 LOCK_UNAVAILABLE`.

3. Use the returned `key`, and create more keys for other clients under `/v1/api-keys` (each a user of its own, or with `profile_id` another device of a user: [Users and permissions](#users-and-permissions)):

   ```bash
   curl http://<controller-ip>:41999/v1/lights -H "Authorization: Bearer ak_..."
   curl -X PATCH http://<controller-ip>:41999/v1/lights/259 \
     -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
     -d '{"brightness": 40}'
   ```

The controller keeps only a hash of each key, so keys survive driver updates and cannot be read back from it. It also keeps each key's lock key, for sealed requests: if a copy of the controller's data is lost, use **Revoke All API Keys** in Composer (which also removes every key if one is lost) and the owner's **Replace the remote secret** in the app (`docs/ACCOUNTS.md`).

## Users and permissions

Since 1.8.0 (ADR-054) a key belongs to a user (a profile) and has that user's permissions. An admin may do everything. A member uses only the rooms and kinds of devices an admin gave them (`light`, `climate`, `fan`, `blind`, `music`, `refrigerator`), sees cameras and the alarm's status and opens doors and gates only when given them (they see the doors and gates in their rooms either way), and runs only the scenes chosen for them; they never see schedules, history, keys, invitations, profiles, room settings or backups. A room an admin marked hidden from members (`hidden_from_members` in `GET /v1/rooms`) is gone for every member.

- Give a script a user of its own, with only the rooms and kinds it needs:

  ```bash
  curl -X POST http://<controller-ip>:41999/v1/api-keys \
    -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
    -d '{"name": "Garden lights", "role": "member", "access": {"all_rooms": false, "rooms": [12], "kinds": {"climate": false, "fan": false, "blind": false, "music": false, "refrigerator": false}, "cameras": false, "alarm": false}}'
  ```

  What `access` leaves out is as for a new member: every room and kind, cameras on, doors off, the alarm on, no scenes. With `profile_id` instead, the key joins that user and has their permissions.
- `GET /v1/api-keys/current` says what the key may do (`access`). Admins read and change a user's with `GET`/`PATCH /v1/profiles/{profileId}/access` (`role`, `all_rooms`, `rooms`, `kinds`, `cameras`, `doors`, `alarm`, `scenes`; `PATCH` takes any of them, the rest stays).
- A device, room or scene the key may not see answers `404` like one that does not exist; a door or gate it sees but may not open, and an admin-only route, `403 FORBIDDEN`.
- Every key's `role` in the answers stays a 1.7.0 role (`viewer`, `member`, `doors`, `admin`) worked out from its user. `POST /v1/api-keys` and `POST /v1/invitations` still take those roles, and `PATCH /v1/api-keys/{id}` `{"role"}` turns the key's whole user into what that role became.
- After the update from 1.7.0, a script whose key had the `viewer` role sees nothing until an admin gives its user rooms and kinds.
- `GET /v1/system` says `features.people_permissions: true` (missing before 1.8.0).

Since 1.9.0 (ADR-061, `features.users`):

- A user has at most five devices (keys). A key made with `profile_id`, a key moved into a user, an invitation for a user and its join, and a pairing code for a user are refused with `409 USER_DEVICE_LIMIT` while they have five; the problem lists that user's devices (`devices`, with `last_used_at` and `removable`) for a caller who sees them.
- `GET /v1/users` (any key): the users the caller sees (an admin every user, anyone else their own), each with `access`, how many Google or Apple accounts their devices use (`accounts`) and their `devices`; for admins, `suggestions` to bring the devices of one account together (`POST /v1/users/merge {"account", "keep"}`).
- `POST /v1/pairing-code` (admins) `{"profile_id"}` or `{"name", "role", "access"}`: a pairing code whose device joins that user, or a new one; `DELETE /v1/pairing-code` closes it. The device that pairs never chooses its user.
- Every key may revoke the other keys of its own user (`DELETE /v1/api-keys/{keyId}`) and invite its own other device (`POST /v1/invitations` with `for_me`); an admin may invite another device of a user (`profile_id`).
- `POST /v1/users/owner` `{"profile_id"}` (ADR-064): the home's owner, and only the owner (`403 OWNER_ONLY`), makes another admin user the owner (`409 NOT_AN_ADMIN` for a member); the old owner stays an admin and nobody is removed. A home linked to an account moves in the account service first: `409 OWNER_NEEDS_ACCOUNT` when the new owner's devices use no account of the home, `503 REMOTE_OFFLINE` when it does not answer; `account_service` in the answer says what it did. History: `access` `owner_changed`.

Since 1.12.0 (ADR-083, `features.user_names`):

- `POST /v1/invitations` (admins) takes the new user's `name` with `role`/`access`: whoever accepts becomes a user of that name. The name stays on the controller (the account service is told the invitation's id, email and expiry only); the joining device reads it in the sealed answer (`user`, `home_name`). `GET /v1/invitations` lists it as `name`.
- `POST /v1/invitations` `{"for_me": true, "move": true}` (any key): a move invitation, 10 minutes at most, one per device. The device that accepts it joins the same user, and the key that made it is revoked at the new key's first sealed request (only while both are devices of that user): as many devices as before, five or not. History: `access` `moved`.
- `PATCH /v1/profile` `{"name"}`: any key names its own user; `GET /v1/profile` says `name_from_device` while the user's name is still one of their devices' names.
- `PATCH /v1/api-keys/{keyId}` `{"name"}`: a member renames the devices of their own user (`404` for any other; `role` and `profile_id` stay the admins', `403`).

## Thermostats

Most thermostats have one `target_temperature` (`"setpoints": "single"`). Thermostats with separate heat and cool setpoints (`"setpoints": "dual"`, the Control4 thermostat) also report both, and the smallest gap they keep between them:

```json
{
  "id": 31,
  "name": "Study",
  "mode": "auto",
  "target_temperature": null,
  "target_temperature_min": 5,
  "target_temperature_max": 35,
  "setpoints": "dual",
  "heat_setpoint": 20,
  "cool_setpoint": 24.4,
  "setpoint_deadband": 1.7
}
```

(Other fields left out.) Set both in auto:

```bash
curl -X PATCH http://<controller-ip>:41999/v1/thermostats/31 \
  -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
  -d '{"mode": "auto", "heat_setpoint": 20, "cool_setpoint": 24}'
```

- Sending one setpoint moves the other when needed to keep `setpoint_deadband`. Two setpoints sent together must already be that far apart, or the answer is `400 INVALID_FIELD`. When `setpoint_deadband` is `null`, cool must still be above heat.
- `target_temperature` sets the setpoint of the mode (the one in the same request, else the current one). In auto and off it is refused with `409 NOT_SUPPORTED`.
- Temperatures stay in °C, whatever scale the Control4 project uses. `heat_setpoint`, `cool_setpoint` and `setpoint_deadband` are `null` on single-setpoint thermostats. A dual thermostat reports `null` for a setpoint none of its modes uses, such as the heat setpoint of one with only Off and Cool.

## Fans

Since 1.2.0 fans on the Control4 fan proxy are resources too. A fan is on or off, and runs at a
speed from 1 (low) to 4 (high); `speed` is `null` while it is off:

```json
{
  "id": 41,
  "name": "Ceiling Fan",
  "on": true,
  "speed": 2,
  "speeds": [1, 2, 3, 4]
}
```

(`room` left out.) `speeds` lists the speeds `PATCH` takes.

In 1.2.0 every fan is taken to have these four speeds. The fan proxy allows other numbers, set up
in the fan's driver: a fan with three shows its top speed as 3 (*Medium High* in the app), and
`{"speed": 4}` sends it a speed it does not have; on a fan with five or more, the speeds above 4
show only as on (`speed` is `null`).

```bash
curl -X PATCH http://<controller-ip>:41999/v1/fans/41 \
  -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
  -d '{"speed": 3}'
```

- `{"speed": 3}` sets the speed and turns the fan on if it is off. `{"on": true}` turns it on at the
  speed the fan chooses (its preset speed, or the last one); `{"on": false}` turns it off. There is
  no speed 0: `{"speed": 0}`, like any other value outside `speeds`, is `400 INVALID_FIELD`, and
  `"on": false` with a speed is `400 INVALID_REQUEST`. Nothing is sent when a request is refused.
- Admins, and members given fans in their rooms, read and change them. In scenes a `fans` step sets
  `{"on": true|false}` or `{"speed": 1-4}` on the fans it names, or on all of them in a room or the
  whole home.

## Blinds

Since 1.1.0 a blind says what it can do, and whether it is moving:

```json
{
  "id": 52,
  "name": "Terrace Shade",
  "position": 40,
  "position_reported": true,
  "capabilities": { "position": true, "stop": true },
  "moving": true,
  "direction": "opening",
  "target_position": 80
}
```

- `capabilities.position` is false for a blind that only opens and closes fully: `PATCH` then takes only `{"position": 0}` and `{"position": 100}`, and anything else is `409 POSITION_NOT_SUPPORTED`. With `capabilities.stop` false, `POST /v1/blinds/{id}/stop` is `409 STOP_NOT_SUPPORTED`. Both are true where the controller does not say.
- A move takes seconds to a minute, and `position` may keep the value the blind left until it stops: while `moving` is true, show `target_position`, and read the blind again every few seconds. `moving` is `null` when the controller does not report movement.
- `position` and `target_position` are `null` when unknown.

## Turning off several at once

Since 1.3.0 `POST /v1/off` turns off lights, or thermostats (mode `off`), or closes blinds, in one request (the app's **Turn off all** on Home; a member names only devices they control, and any other is `400` like a device that does not exist):

```bash
curl -X POST http://<controller-ip>:41999/v1/off \
  -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
  -d '{"type": "lights", "device_ids": [20, 22, 25]}'
```

`type` is `lights`, `climate` or `blinds`; `device_ids` names 1 to 500 of them. It answers `202` like running a scene: `ran`, `skipped` (e.g. a thermostat without an Off mode, `MODE_NOT_SUPPORTED`), `failed` (refused by the controller) and `problems` with each such device. It never turns anything on, and doors and gates are not among its types.

## Relays

Doors and gates open with `POST /v1/relays/{id}/pulse` (the relay closes, then opens again after 500 ms), as in the app and scenes. `PATCH` with `{"state": "open"}` releases a relay. `{"state": "closed"}` would hold it closed, and its door or gate open: since 1.1.1 it is `409 HOLD_NOT_ALLOWED` and nothing is sent, unless an installer sets **Relay Hold** to Allowed in Composer.

## Shabbat and holidays

Since 1.2.0 DirectorLink works out Shabbat and holiday times on the controller from the project's location (Composer's project properties); nothing is sent to the network. It stays off until an installer sets **Jewish Calendar** to On in Composer. Until then `GET /v1/calendar` answers `{"enabled": false, "status": "off", ...}` with nulls, `GET /v1/system` has `"features": {"jewish_calendar": false}`, and setting anything that uses the calendar is `409 JEWISH_CALENDAR_OFF`.

`GET /v1/calendar` (any key), in Tel Aviv on the Tuesday of Chol HaMoed Sukkot 5787:

```json
{
  "enabled": true,
  "status": "ok",
  "settings": { "holidays": "auto", "israel": true, "candle_lighting_minutes": 20, "havdalah_minutes": 42, "version": 1 },
  "today": {
    "date": "2026-09-29",
    "hebrew": { "year": 5787, "month": "tishrei", "day": 18, "leap_year": true },
    "after_sunset": false,
    "holidays": [{ "key": "chol_hamoed_sukkot", "day": null, "month": null, "yom_tov": false, "name": "Chol HaMoed Sukkot" }],
    "changes_at": "2026-09-29T15:28:37Z"
  },
  "week": { "date": "2026-10-03", "parasha": null, "holidays": ["…Shmini Atzeret and Simchat Torah"] },
  "current": null,
  "next": {
    "starts_at": "2026-10-02T15:04:00Z",
    "ends_at": "2026-10-03T16:05:00Z",
    "approximate": false,
    "days": [{ "date": "2026-10-03", "shabbat": true, "candle_lighting": "2026-10-02T15:04:00Z", "holidays": ["…as in week"] }]
  }
}
```

- `today` is the Hebrew day now, which begins at sunset: after sunset (`after_sunset`) it is tomorrow's, and `date` is the civil date whose daytime it is. `holidays` lists the day's holidays, holy (`yom_tov`) or only shown (fasts, Chanukah, Rosh Chodesh, the national days). `changes_at` is when it changes next, to the second: the controller's sunset, or local midnight without a location or where the sun does not set; read the calendar again then.
- `week` is this week's Shabbat and its reading: `parasha.ids` from 1 (Bereshit) to 54, two for a combined reading, and `null` when a holiday reading replaces it.
- `current` is the holy period now and `next` the next one. Shabbat and holy days that follow each other are one period, from candle lighting (`starts_at`) to havdalah (`ends_at`), in UTC, with each day's candle lighting (a later day's is lit from an existing flame: before sunset for Shabbat, after nightfall otherwise). Candle lighting is sunset, to the minute, less `candle_lighting_minutes`; havdalah is sunset, to the nearest minute, plus `havdalah_minutes`.
- `status: "no_location"`: the Hebrew date and the reading by the civil date, but no times (`current` and `next` are `null`). `approximate: true`: a sunset the period needs does not happen at this latitude, and those times are `null`.
- The API carries stable keys (`key`, `month`, `ids`); `name` is English, in Hebcal's spelling, for scripts and logs. Apps show their own names.

Admins change how the times are worked out; the answer is the settings (`version` goes up by one), and with an old `version` it is `409 VERSION_CONFLICT` with the current one:

```bash
curl -X PATCH http://<controller-ip>:41999/v1/calendar/settings \
  -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
  -d '{"candle_lighting_minutes": 30, "havdalah_minutes": 50, "version": 1}'
```

`candle_lighting_minutes` is 0–90 (20 by default), `havdalah_minutes` 20–90 (42), and `holidays` is `auto` (the default: Israel's when the home is in Israel), `israel` (one day of Yom Tov) or `abroad` (two).

Schedules run at these times (`docs/SCHEDULES.md`, *Shabbat and holidays*):

```bash
curl -X POST http://<controller-ip>:41999/v1/schedules \
  -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
  -d '{"scene_id": "0a1b2c3d", "trigger": {"type": "shabbat", "event": "candle_lighting", "offset": -30}, "days": [0, 1, 2, 3, 4, 5, 6]}'
```

- A `shabbat` trigger runs once when a period begins (`candle_lighting`) or ends (`havdalah`), plus `offset` minutes (−360 to 360); `days` filter by the local weekday of that moment.
- `"during_shabbat": "skip"` keeps a time, sun or weather schedule away from Shabbat and holidays, and `"only"` to them; `"run"` (the default) runs as on any day.
- Every schedule has `during_shabbat` and `calendar_status`: `ok`, `off` or `no_location` for one that uses the calendar (with `off` or `no_location`, Shabbat triggers and `only` do not run and `skip` runs as usual), `null` for the others. `last_run.skipped_by` may be `shabbat`, and `last_run.note` `late`: after a restart, Shabbat automation missed in the last 6 hours runs late.

Example answers: [`tests/vectors/calendar/api-examples.json`](../tests/vectors/calendar/api-examples.json).

## Alarm

`GET /v1/alarm` (since 1.2.0) says whether each partition of the home's alarm is armed. It is read-only: nothing in the API arms or disarms, which takes the user's alarm code (ADR-038).

- Off by default. Until an installer sets **Alarm Status** to On in Composer, the answer is `{"enabled": false, "partitions": []}`, and DirectorLink does not watch the alarm. `GET /v1/system` says which in `features.alarm_status`.
- For admins and the members given the alarm's status (ADR-054); others get `403 FORBIDDEN`.
- Only in sealed requests: on the home network through `POST /v1/sealed`, as the app sends every request, and through remote access. With `Authorization: Bearer` the answer is `403 SEALED_REQUEST_REQUIRED`, so whether the home is armed never crosses a network in the clear. Scripts and the API console, which do not seal, cannot read it.
- Nor does the size of the sealed answer tell it: the JSON is followed by spaces up to the size it would have with every partition at its longest, so that its size depends only on the partitions there are (their names and rooms), never on their state. For that the panel's words are cut, at a character, to 32 bytes (`state`, `armed_type`, `alarm_type`) and 100 (`trouble`), with control characters made spaces, and `open_zones` and the delay's seconds stop at 99999.

```json
{
  "enabled": true,
  "partitions": [
    {
      "id": 81,
      "name": "Garage",
      "state": "entry_delay",
      "armed": true,
      "armed_mode": "away",
      "armed_type": "Away",
      "alarm": false,
      "alarm_type": null,
      "open_zones": 1,
      "delay": { "type": "entry", "remaining": 12, "total": 30 },
      "trouble": null
    }
  ]
}
```

(`room` left out.) `state` is the panel's word in lower case: `disarmed_ready`, `disarmed_not_ready`, `armed`, `exit_delay`, `entry_delay`, `alarm`, `confirmation_required`, `offline`, or another a panel reports. `armed_type` and `alarm_type` are the panel's own words (e.g. `Stay`, `Fire`), `null` unless armed or in alarm. `delay` is `null` unless an entry or exit delay is counting down, in seconds as the panel last reported. Partitions the alarm does not use are left out. In `/v1/devices` a partition stays a device of type `other`.

## Music (Sonos)

Since 1.5.0 DirectorLink talks to the home's Sonos speakers itself, on the home network, with the local protocol the Sonos app uses (UPnP/SOAP on port 1400, which Sonos does not document; ADR-044, [`docs/SONOS.md`](../docs/SONOS.md)).

- Off by default. Until an installer sets **Sonos** to On in Composer, `GET /v1/music` answers `{"enabled": false, "status": "off", "items": []}`, every other music route `409 SONOS_OFF`, and DirectorLink looks for no player. `GET /v1/system` says which in `features.sonos`.
- Each item is a Sonos room, named by its id (`RINCON_…`), never an address: DirectorLink talks only to the players it found (or the one at **Sonos Address**), on port 1400.
- Admins, and members given music in their rooms, read and control; admins place a Sonos room in a Control4 room.

```json
{
  "id": "RINCON_000E58A0000101400",
  "name": "Kitchen",
  "room_id": 10,
  "room_match": "name",
  "group": { "id": "RINCON_000E58A0000101400", "coordinator": true, "rooms": [{ "id": "RINCON_000E58A0000101400", "name": "Kitchen" }, { "id": "RINCON_000E58A0000201400", "name": "Living Room" }] },
  "state": "playing",
  "volume": 30,
  "muted": false,
  "now_playing": { "kind": "music", "title": "Morning Light", "artist": "The Example Band", "album": "First Album", "station": null, "source": null, "art_href": "/v1/music/RINCON_000E58A0000101400/art", "art_key": "80ffc887" },
  "can_skip": true,
  "reachable": true,
  "updated_at": "2026-10-02T10:00:00Z"
}
```

- `GET /v1/music` lists every Sonos room (`?room_id=` those shown in one room) with `status` (`ok`, `searching`, `not_found`, `unreachable`). Asking keeps the rooms asked for read every few seconds for a while; ask every few seconds to follow them.
- `room_id` is the Control4 room of the same name (case and spaces aside, or one of its names in other languages), or the one an admin picked (`room_match`: `name`, `admin`), or `null`.
- `POST /v1/music/{id}/play`, `/pause`, `/next`, `/previous` act on the room's group (its coordinator) and answer `200` with the room once the player has taken the command. Pause stops a radio station, which cannot pause; next and previous on the radio are `409 ACTION_NOT_POSSIBLE` (see `can_skip`).
- `PATCH /v1/music/{id}` with `{"volume": 0-100}` and/or `{"muted": true|false}`: this room's own speaker.
- `GET /v1/music/{id}/favorites` lists the household's Sonos favorites (`playable` false for those only the Sonos app starts); `POST /v1/music/{id}/favorites/{favoriteId}/play` starts one on the group (a playlist replaces the queue).
- `GET /v1/music/{id}/art` is the album art of what the group plays, through the controller (`404 NO_ART` when there is none); `now_playing.art_key` changes when the picture does.
- `PUT /v1/music/{id}/room` with `{"room_id": 12}` (admins) puts a Sonos room in a Control4 room; `null` goes back to its name.
- A player that does not answer: `502 PLAYER_UNREACHABLE` (and `reachable: false`); too many requests waiting: `503 PLAYER_BUSY`.
- Groups (1.8.0, ADR-057; `features.sonos_groups`): `POST /v1/music/{id}/group` with `{"with": "<id>"}` puts the room in the group of that room, as the Sonos app's Group does (`404` for a room DirectorLink does not know); `DELETE /v1/music/{id}/group` takes it out, to play on its own; `PATCH /v1/music/{id}/group` with `{"volume": 0-100}` sets the group's volume through each room's own, keeping their balance. `GET /v1/music` adds `groups`: each coordinator, its rooms, what it plays and its volume (the rooms' average, also `group.volume` on each room). A command on a group (play, pause, skip, a favorite, its volume, leaving, joining) needs every room in it to be one the key may control (`403 FORBIDDEN`).
- In scenes a `music` step `{"type": "music", "room_id": 10, "set": {"action": "pause"}}` pauses (or `"stop"`) the groups with a room there, or every group without `room_id`. Since 1.8.0 also `{"action": "resume"}`, `{"action": "volume", "volume": 20}`, and `{"action": "play_favorite", "favorite": {"id": "10"}, "volume": 25, "with_room_ids": [11]}` in a room: the rooms are grouped, get the volume and play the favorite; a favorite since removed in Sonos is skipped with `FAVORITE_GONE`.

```bash
curl -X POST http://<controller-ip>:41999/v1/music/RINCON_000E58A0000101400/pause -H "Authorization: Bearer ak_..."
curl -X PATCH http://<controller-ip>:41999/v1/music/RINCON_000E58A0000101400   -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" -d '{"volume": 25}'
```

## Backup

`GET /v1/backup` (since 1.4.0) gives everything DirectorLink keeps as one document, and `POST /v1/restore` puts it back (ADR-042, [`docs/BACKUP.md`](../docs/BACKUP.md)). For `admin` keys, and only in sealed requests (`POST /v1/sealed` at home, and through remote access): the document holds every key's hash and lock key and the home's remote identity, so with `Authorization: Bearer` the answer is `403 SEALED_REQUEST_REQUIRED`. The app encrypts it with a password before saving it; scripts and the API console, which do not seal, cannot make or restore one. `GET /v1/system` says the driver has backups (`"features": {"backup": true}`; drivers before 1.4.0 do not say it, and the app shows them no Backup).

- The document: `format`, `format_version`, `driver_version`, `created_at`, `home`, `controller_id` (a hash of the controller's MAC address, null when Director does not give it), `composer` (how the Composer properties are set; listed, never restored), `references` (the rooms' and devices' names by id) and `sections`, one per store as it is kept, with its version: `keys`, `profiles`, `room_names`, `room_order`, `scenes`, `schedules`, `calendar`, `remote_identity` (only an identity the relay has accepted, with `linked: true`; otherwise `{"version": 1, "linked": false}`: none is made for a backup), and since 1.8.0 `people` (each person's role and permissions, the owner, the rooms hidden from members).
- Back, in parts: `POST /v1/restore/parts` with `{"index": 0, "count": 3, "text": "…"}`, then `{"upload": "<id>", "index": 1, …}` in order (at most 48 KiB of the JSON text each, 2 MiB and 100 parts in all; the upload is the key's, one per key and three in all, dropped 10 minutes after its last use). A sealed request at home is at most 64 KiB.
- `POST /v1/restore {"upload": "<id>"}` checks it and changes nothing (`dry_run` is true unless sent false); `{"upload": "<id>", "dry_run": false}` replaces every store, or none (`500 RESTORE_FAILED`). A small document can go as `{"document": {...}}` instead of an upload. The answer, `restore`, says whether the backup looks like another home's (`origin`: `another_home` and its `reasons`), what there is after it (`counts`), what is left out (`left_out`), the keys (`keys.action`: `restore`, the backup's come back, listed in `items` by name and role, only when no key but the sender's is paired and the sender's is not in the backup; or `kept`, every key as it is now), the remote identity (`same`; `restore`: the backup's home from two seconds after the answer, unless the relay refuses it; `kept`: another home's, not moved; `none`: the backup has none; and `old_controller`), the rooms and devices found by id, by name (`by_name`), renamed and not found (`unmatched`, with `used_in`, and `now` for a door or gate that is not moved), and `composer` (the backup's value and the current one). With the restore, `replaces_key` makes the sending key take the place of one of the backup's keys (its profile and role; that key is not restored), and `move_remote: true` brings another home's remote identity here.
- Refused: `422 BACKUP_INVALID` (not a backup, or a section missing or of the wrong shape, with `errors`), `409 BACKUP_TOO_NEW` (made by a newer DirectorLink), `409 UPLOAD_INCOMPLETE`, `409 KEYS_KEPT` (`replaces_key` while the keys are kept), `409 LAST_ADMIN` (it would leave no admin), `404 UPLOAD_NOT_FOUND`, `503 PROJECT_NOT_READY` (the project is not read yet), `503 UNAVAILABLE` (a store could not be read when DirectorLink started, with `store`: a restore would overwrite it; restart the driver).
- Automatic backups to the account (1.6.0, ADR-048): `GET /v1/backup/automatic` says whether they are on, at what time, whether one is being made and how the last one went. The backup password's public key, salt and iterations are in its `key` only in sealed requests (with them a guessed password could be checked offline); with `Authorization: Bearer`, `key` has only `key_id` and `set_at`. Setting the key (`PUT`) and turning them off (`DELETE`) are sealed only; `POST /v1/backup/automatic/run` is Back up now.

## History

`GET /v1/activity` (since 1.6.0, ADR-046, [`docs/HISTORY.md`](../docs/HISTORY.md)) is what the controller did and noticed, newest first, for `admin` keys: scenes and schedules run or skipped and why, doors and gates opened, keys and invitations, changes made in Composer, backups (also automatic ones to the account), restores and driver updates. Each entry has `id`, `at`, `kind` (`scene`, `schedule`, `door`, `composer`, `access`, `system`), `action`, `who` (`type` `key` with the key's `name` and the person's `profile`, `schedule` with its `trigger` and `days`, `composer` or `controller`), `what` and `room` by the names they had then, and as it applies `outcome` (`ran`, `skipped`, `failed`), `reason`, `counts`, `from`/`to`, `changes` and `ids`. The controller keeps the newest 450 to 500, none older than 30 days, across restarts and updates; not in backups.

```bash
curl "http://<controller-ip>:41999/v1/activity?kind=scene,schedule&limit=20" -H "Authorization: Bearer ak_..."
curl "http://<controller-ip>:41999/v1/activity?before=1234&limit=20" -H "Authorization: Bearer ak_..."
```

`next_before` in the answer is the `before` for the entries that came before these (null when there are no more). An unknown `kind`, or `before`/`limit` out of range, is `400 INVALID_PARAMETER`.

An automatic backup to the account is `kind` `system`, `action` `cloud_backup`, with `outcome` `ran` or `failed`; `who` is the key that pressed Back up now, or `controller` for the daily one. A failed one has a `reason`: `remote_off` (Remote Access is off in Composer), `account_unreachable` (not connected to DirectorLink's servers, no answer within 30 s, or the account service's own error), `not_linked` (the home is not in an account), `too_large`, `limit` (backed up too often today: the account starts 4 a UTC day per home, besides the first nightly one), `account_full` (no room left for the owner's homes, 25 MB in all), `stopped` (automatic backups turned off, or the backup password changed, while it was being made) or `error`; `GET /v1/backup/automatic`'s `last.code` and the log have the exact code. A daily one that fails is listed once a night, with `note` `retry` when it is tried again that night (every 15 minutes until 06:00).

## Debugging

`GET /v1/logs` returns the bridge's last 500 log entries (API requests, device commands, state changes, errors). Poll it with `after=<last_seq>` to follow new entries, and switch to `debug` with `PATCH /v1/logs/settings` while investigating. Secrets are never logged.
