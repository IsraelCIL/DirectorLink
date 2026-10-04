# Scenes

**Status: built in DirectorLink 0.13.0.** Schedules (0.14.0, `docs/SCHEDULES.md`) run them by
time, sun and weather; since 1.7.0 the phone's own automations run them by a link (ADR-051, *Links
for automations* below).

A scene is one tap that sets several things: "all lights off, the bedroom AC to 24°, the
living-room blinds closed". Scenes belong to the home and are kept on the controller
(`src/core/scenes.lua`, persistent data that survives driver updates). They are DirectorLink's own:
Composer scenes and programming are never read or changed (docs/DECISIONS.md).

## Who does what

| Role | Scenes |
| --- | --- |
| viewer | sees them |
| member | also runs them |
| doors | also runs their doors and gates |
| admin | also makes, changes, tries and deletes them, and gives them links for automations (1.7.0) |

## A scene

- `name` (1–64 characters), `icon` (`moon`, `sun`, `leave`, `movie`, `bulb`, `climate`, `blinds`,
  `home`), `show_on_home` (a Run button at the top of Home), and up to 40 `steps`, run in order.
- A step sets devices of one `type`: `lights`, `climate`, `fans` (1.2.0), `blinds`, `relays`
  (doors and gates) or `refrigerators` (1.7.0), or the Sonos music (`music`, 1.5.0).
  - With `device_ids`, those devices (`room_id` is then only the room they were picked in).
  - Without, every device of that type in `room_id`, or in the whole home when `room_id` is null.
    This is worked out each time the scene runs, so a light added to the room later is included.
- What a step sets:
  - lights: `{"on": true|false}` or `{"brightness": 0-100}`; on/off-only lights turn on.
  - climate: any of `mode` (`off`, `heat`, `cool`, `auto`), `target_temperature`, `fan_speed`
    (`low`, `medium`, `high`, `auto`, `on`, `circulate`), and since 1.1.0 `heat_setpoint` and
    `cool_setpoint` instead of `target_temperature` (5–40, cool above heat). With `mode: off`,
    nothing else. The temperature is kept within each thermostat's range; a fan speed a unit does
    not have is left out.
  - Thermostats with heat and cool setpoints (1.1.0) take `heat_setpoint` and `cool_setpoint` as
    their setpoints, and `target_temperature` as the setpoint of the step's mode (or of the current
    mode); in auto and off a target is left out. Setpoints that come closer than the thermostat's
    deadband are left out. Single-setpoint thermostats take `heat_setpoint` in heat and
    `cool_setpoint` in cool, and leave out any other setpoint.
  - fans (1.2.0): `{"on": true|false}` or `{"speed": 1-4}` (1 low to 4 high; a speed turns a fan
    on). `"on": true` turns each fan on at the speed it chooses (its preset, or its last one).
  - blinds: `{"position": 0-100}` (0 closed, 100 open).
  - relays: `{"action": "pulse"}` — what the door's or gate's Open button does. A scene never
    holds a relay closed: on door strikes and gate inputs that would leave the door unlocked or
    the gate's button pressed.
  - music (1.5.0, docs/SONOS.md): `{"action": "pause"}` or `{"action": "stop"}`, in `room_id` or
    the whole home; it names no devices. Every Sonos group with a room there that plays pauses
    as one (a radio station stops), and counts as ran; a group already paused or stopped is left
    alone. It is skipped, with the reason, when Sonos is off in Composer (`SONOS_OFF`), no player
    has been found yet (`NO_PLAYERS`), or no Sonos room is shown in its room (`NO_SONOS_ROOM`).
  - refrigerators (1.7.0, ADR-049): any of `power_cool`, `power_freeze`, `sabbath_mode` and
    `ice_maker`, `true` (on) or `false` (off), at least one: `{"sabbath_mode": true}`. Each goes to
    the refrigerator's driver as its own command, through Samsung's cloud; the step counts as ran
    once the commands are handed over (the refrigerator confirms seconds later). A feature a
    refrigerator does not have (its driver says which it has) is left out on it (`partial`), or the
    refrigerator is skipped with `NOT_SUPPORTED` when none is left. A member may run it, so
    schedules do: Sabbath Mode on before Shabbat and off after it.
- At most 50 scenes. `version` goes up with every change; sent back with a change
  (`PATCH /v1/scenes/{id}`), it makes the change conditional (409 `VERSION_CONFLICT`).

## Running

`POST /v1/scenes/{id}/run` sends the commands of each step, in order, through the same adapters as
the device routes, and answers `202` with what happened to each device:

- `ran`: commands handed to the controller (a device that ran with a setting it does not have left
  out, such as a fan speed, or a setpoint the thermostat refuses, is also listed in `problems` as
  `partial`, `NOT_SUPPORTED`);
- `skipped`: left alone, with the reason in `problems` — doors and gates for a key without door
  access (`FORBIDDEN`) or with Door Control off in Composer (`DOOR_CONTROL_DISABLED`), a mode a
  unit does not have (`MODE_NOT_SUPPORTED`), a device no longer in the project (`NOT_FOUND`), a
  thermostat left with nothing to do once its refused setpoints are left out;
- `failed`: refused by the controller.

A thermostat's temperature command is checked before the thermostat gets any command: a refused
one is left out (`partial`), and the rest of the step, such as its mode, still goes to it.

Steps without `device_ids` take the devices DirectorLink supports when the scene runs. So when an
update adds a device family (1.1.0: the older Light proxy and thermostats with heat and cool
setpoints; 1.2.0: fans; 1.7.0: refrigerators), room and whole-home steps, and the schedules that run them, include
those devices from then on.

The rest of the scene still runs when a device is skipped or fails. Doors and gates opened by a
scene are logged like any other relay command, with the key that ran it. In the app, a scene that
opens doors or gates asks for a second tap, like their Open button.

Stored scenes are checked again when the driver starts: steps that are not valid are left out
(and logged). DirectorLink 1.6.0 does not know refrigerator steps: it leaves them out (the rest of
the scene runs), and its next save of any scene drops them. 1.7.0 also keeps them apart, under
`directorlink_scene_steps`, which 1.6.0 does not read, and puts them back in their places when a
scene comes back without them from a save by 1.6.0 (ADR-049). The scenes 1.7.0 saves say so
(`steps_kept`, which 1.6.0 drops when it saves), so a step removed in 1.7.0 never comes back. A
backup restored while 1.6.0 runs is such a save: back on 1.7.0, its scenes get the refrigerator
steps the controller had before the restore, in scenes with the same id. If the stored scenes cannot be read at start, changes are refused (503) until a
restart reads them, so they are never overwritten by an empty list.

`POST /v1/scenes/try` with `steps` runs them once without saving (admins): "Try it now".

`POST /v1/off` with `type` (lights, climate, blinds) and `device_ids` runs one step on those devices
(members, 1.3.0): lights off, AC off or blinds closed, and answers the same way. It is Home's "Turn
off all" in the app.

## Links for automations (1.7.0, ADR-051)

A scene can have one private link that the phone's own automations call: iPhone Shortcuts (when you
arrive home, with Siri, from an NFC tag), Android automation apps (HTTP Shortcuts, Tasker,
MacroDroid), or an NFC tag opened in a browser. Whoever has the link can run that scene, and nothing
else, from anywhere; every run is in History.

- **Admins** make, replace and remove it: the scene editor's *Link for automations* opens the
  scene's link screen (`#/scene/<id>/link`); Scenes → *Links for automations* (`#/links`) lists the
  linked scenes. In the API: `POST`, `GET`, `DELETE /v1/scenes/{id}/link` and `GET /v1/scene-links`
  (admins). `POST` takes an optional `label` (up to 64 characters), shown in History with each run.
- **The secret is shown once**, in the answer that makes the link (`secret`, 160 random bits as 40
  hex digits, and `url`); the controller keeps only its SHA-256, as it keeps API keys. Lost? Make a
  new link: the old one stops working at once. Composer's action **Remove All Scene Links** removes
  every one; so do **Revoke All API Keys** and Reset Remote Identity (the addresses name the home).
- **A link goes with the key that made it**: revoking that key (in People and devices, by removing
  its person, or with Forget access key on that device), or its expiry, removes its links (`made_by`
  in the list; the app says how many before it revokes a key).
- **Never doors or gates.** Only scenes whose steps are all lights, climate, fans, blinds, music or
  refrigerators can have a link; a scene with a doors-and-gates step (or a kind of step added later
  and not yet allowed) gets none (`409 SCENE_OPENS_DOORS`); adding such a step to a linked scene
  removes its link (the app warns and asks before saving), and so does deleting the scene. A run
  checks again and runs the scene as a member's key would (as schedules do), which never opens a
  door or gate.
- **What it needs:** Remote Access on in Composer and the home linked to an account (`409
  REMOTE_ACCESS_OFF`, `HOME_NOT_LINKED` when making one; the app says which).

**Using it.** The address is `https://api.directorlink.io/run/<home_id>.<link_id>`; the secret never
goes in it.

| From | How |
| --- | --- |
| iPhone Shortcuts | An automation (Arrive, NFC, a time) or a shortcut for Siri, with the action **Get Contents of URL**: the address as its URL; then Method **POST**, Request Body **JSON**, Add new field → Text, key `secret`, the secret as its text. For an automation, Run Immediately. |
| Android (HTTP Shortcuts, Tasker, MacroDroid) | An HTTP request: method POST, to the address, with the secret as its body: on its own as text, or as a form field `secret`. |
| An NFC tag or a browser | The whole link, with the secret after `#`: `https://api.directorlink.io/run/<home_id>.<link_id>#<secret>`. Opening it shows a page with one Run button; the browser never sends what follows `#`, the page's script posts it. Write it to a tag with an NFC app (NFC Tools, for example). |

A POST takes `{"secret": "…"}` as JSON, `secret=…` as a form (url-encoded or multipart), or the
secret alone as text; the whole link in place of the secret works too. Answers:

| Status | Body | When |
| --- | --- | --- |
| 200 | `{"result": "ran", "message": "The scene ran."}` | `ran`: everything ran; `partly`: some devices were skipped or did not respond; `failed`: none ran; `nothing`: there was nothing to run (its devices were removed in Composer) |
| 400 | `SECRET_REQUIRED` | no secret in the body |
| 404 | `NOT_FOUND` | an unknown home, link or secret, word for word alike; also a scene gone or with doors, a link whose key was revoked, and a DirectorLink before 1.7.0 |
| 429 | `TOO_MANY_RUNS`, `Retry-After` | more than 6 runs a minute of one link, or 30 of one home; or 10 runs answered 404 in 10 minutes from the same address (an IPv6 one by its /64), which then waits until the first of them is 10 minutes old |
| 503 | `HOME_OFFLINE` | the home is not connected (a claimed home's id therefore shows whether it is online: the family needs to know) |
| 502, 504 | `HOME_DISCONNECTED`, `HOME_FAILED`, `HOME_TIMEOUT` | the home did not answer |

A GET never runs anything (link previews in Messages, WhatsApp and Slack fetch links): it is the
page with the Run button, the same for every address.

**Who sees what.** The account service sees the link and its secret when a phone uses it, never which
scene it runs (it has no names), and keeps no secret (docs/ACCOUNTS.md, "Who knows what"). The secret
is never logged, on the controller or in the cloud; the cloud logs each run (the home, the link's id,
the status, the result word and how long), kept a few days in Workers Logs. A home's id is in every
link and invitation link, so it is not secret.

**Backups** hold each link's hash and the key that made it (section `scene_links`, docs/BACKUP.md).
Like the keys, the backup's links come back only with the backup's keys (the driver added again, or
a replaced controller); otherwise the links here stay as they are, so a link removed or replaced
since the backup was made stays gone. Either way only the links whose scene comes back without doors
or gates, that name the home identity in use after the restore, and whose key is still there.

**A sold home:** another account claiming the home does not end the old family's links. The new
owner runs **Revoke All API Keys** in Composer, which ends every key and every link.

**Going back to 1.6.0:** it does not read the links' store (it stays), and the relay sends it no runs
(its hello lists no `scene_links`), so phones get 404. A scene changed there to open doors or gates
loses its link at the next start of 1.7.0.

## The app

- **Scenes** tab: every scene with a Run button (members and above); admins tap a name to change
  it, make a **New scene**, or start from an idea (All off, Good night, Good morning, Leaving home,
  Cool the house) that opens the editor filled in.
- The editor: the name and an icon; **What happens** (the actions, which can be moved, changed and
  removed); **Add an action** — where (a room or the whole home), what (lights, AC, fans, blinds,
  doors and gates, refrigerators, with how many there are) and what to do (fans: Off, On or a
  speed; refrigerators: Power Cool, Power Freeze, Sabbath mode or Ice maker, the ones they have,
  On or Off); **Choose**
  picks single devices ("only the reading lamp of the six"); **Copy the house as it is now** makes
  the actions from the current state of every light, AC, fan and blind (doors and gates, and
  refrigerators, are never copied); **Show on Home**; **Try it now**; **Save scene**. The ideas All off and Leaving home
  turn fans off too (1.2.0).
- Auto for thermostats with heat and cool setpoints (1.1.0) offers a Heat and a Cool stepper, kept
  at least the largest deadband of the chosen thermostats apart; copying the house keeps both
  setpoints of such a thermostat in auto. Copied temperatures stay within what an action takes
  (5–40 °C) and the thermostat's own range, as brightness and positions do: a setpoint set on the
  thermostat itself below that (40 °F is 4.4 °C) is copied as the lowest the thermostat takes, and
  a pair left with cool not above heat is not copied.
- Changing an action (1.6.0): its **Edit** button, or tapping its text, opens Add an action filled in
  from it (`#/scene/<id>/edit/<index>`): its place, kind, devices (all, or the chosen ones ticked)
  and setting. Ticking and unticking devices, choosing all or some, another place or another
  setting, then **Save action**, puts the changed action where it was; Cancel and Back change
  nothing, and the action has the focus again. Its setting stays exactly as saved until one of the
  setting's choices is changed (a copied AC can have no mode, or setpoints the app would push
  apart). Devices it names that are in another room now are listed with their room, and ones no
  longer in the project as "Removed device" with their ID, ticked: they leave the action only when
  unticked (saving the scene still leaves out what is gone, and says so). An action whose devices
  or room are all gone can still be changed or removed. Actions split from one choice of more than
  100 devices (in a row, with the same kind, place and setting, each but the last naming 100) are
  changed together, as one; the result takes their place, split again when it still names more
  than 100 devices, within the 40 actions a scene has. Its devices stay named as they are while
  they are picked as they were, and an action saved unchanged stays exactly as it was; Use all makes
  it all of them. Doors and gates are always named, one by one, so a scene never opens more of them
  than were picked. The scene is then saved as before (`PATCH /v1/scenes/{id}` with its
  steps), so this works with any driver that has scenes.
- **Home** shows the scenes marked Show on Home, with one-tap Run, above the favorites.
- Saving leaves out devices and rooms that are no longer in the project, and says so.
