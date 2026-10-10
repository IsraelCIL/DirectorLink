# Scenes

**Status: built in DirectorLink 0.13.0.** Schedules (0.14.0, `docs/SCHEDULES.md`) run them by
time, sun and weather; since 1.7.0 the phone's own automations run them by a link (ADR-051, *Links
for automations* below), and since 1.8.0 Siri and Google Assistant too. Doors and gates get a link
of their own that asks before opening (1.8.0, ADR-058, *Ask before opening* below).

A scene is one tap that sets several things: "all lights off, the bedroom AC to 24°, the
living-room blinds closed". Scenes belong to the home and are kept on the controller
(`src/core/scenes.lua`, persistent data that survives driver updates). They are DirectorLink's own:
Composer scenes and programming are never read or changed (docs/DECISIONS.md).

## Who does what

| Role (1.8.0, ADR-054) | Scenes |
| --- | --- |
| member | sees and runs only the scenes an admin chose for them (none at first), in full: devices they could not control themselves too, doors and gates included (with Door Control on in Composer); one given doors and gates also makes links that ask before opening them (1.8.0, ADR-058) |
| admin | sees and runs every scene; makes, changes, tries and deletes them, chooses which members may run each, and gives them links for automations (1.7.0) |

A scene a member may not run answers `404` for them, like one that does not exist. Up to 1.7.0 each
key had a role: `viewer` saw scenes, `member` ran them without their doors and gates, `doors` ran
them in full (ADR-025); ADR-054 says what each became.

## A scene

- `name` (1–64 characters), `icon` (`moon`, `sun`, `leave`, `movie`, `bulb`, `climate`, `blinds`,
  `home`), `show_on_home` (a Run button at the top of Home), and up to 40 `steps`, run in order.
- A step sets devices of one `type`: `lights`, `climate`, `fans` (1.2.0), `blinds`, `relays`
  (doors and gates) or `refrigerators` (1.7.0), or the Sonos music (`music`, 1.5.0).
  - With `device_ids`, those devices (`room_id` is then only the room they were picked in).
  - Without, every device of that type in `room_id`, or in the whole home when `room_id` is null.
    This is worked out each time the scene runs, so a light added to the room later is included.
- What a step sets:
  - lights: `{"on": true|false}` or `{"brightness": 0-100}`. A level above 0 for a room or the
    whole home (no `device_ids`) goes to the dimmers there, and the lights that only turn on and
    off (`dimmable` false, ADR-077) stay as they are: they are skipped with `ON_OFF_ONLY` (since
    2026-10-09, after 1.10.2: on the owner's home some are heaters and a door lock). A light that
    only turns on and off that the step names by its id turns on. Off and a level of 0 turn every
    light off, switches too, and `"on": true` turns every one on.
  - climate: any of `mode` (`off`, `heat`, `cool`, `auto`), `target_temperature`, `fan_speed`
    (`low`, `medium`, `high`, `auto`, `on`, `circulate`), and since 1.1.0 `heat_setpoint` and
    `cool_setpoint` instead of `target_temperature` (5–40, cool above heat). With `mode: off`,
    nothing else. The temperature is kept within each thermostat's range; a fan speed a unit does
    not have is left out. What a step leaves out stays as it is: `{"mode": "cool"}` sends the mode
    alone, and each AC keeps its temperature and fan (the app's **Keep**). Temperatures are °C; in a
    °F home (1.10.2, ADR-076) the app shows and sets them in whole °F and keeps each as °C to 0.1
    (69 °F as 20.6), which a °F thermostat gets back as exactly that °F. A temperature sensor
    (`sensor: true`) is skipped, and a step for a room's climate leaves it out.
  - climate, since 1.10.0 (ADR-070): `{"mode": "on"}`, alone, turns each AC on **as it was**: one
    that is off goes back to its last mode that was not off, and nothing else is sent, so its
    temperature and fan are the ones it had; one that is on is left as it is (it counts as ran,
    nothing is sent). One whose last mode is not known yet is skipped with `NO_LAST_MODE` ("No last
    mode known yet; set it once"): DirectorLink never guesses heat or cool. A last mode DirectorLink
    cannot set (an AC last in Dry from its own remote) is skipped with `MODE_NOT_SUPPORTED`. See
    *On, as it was* below.
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
    Since 1.8.0 (ADR-057) also `{"action": "resume"}` (groups paused or stopped play again),
    `{"action": "volume", "volume": 0-100}` (each Sonos room's own volume), and
    `{"action": "play_favorite", "favorite": {"id": "10"}, "volume": 25, "with_room_ids": [11]}`
    in a room (`room_id` required; `volume` and `with_room_ids` optional): the Sonos rooms of the
    step's room and of `with_room_ids` are grouped, get the volume, and play the Sonos favorite.
    The step keeps the favorite's id, name, address and description as the favorites list gives
    them; a favorite since removed in Sonos is skipped with `FAVORITE_GONE` and nothing of the step
    runs. The step runs in full whoever runs the scene (a member it was chosen for, a schedule, a
    link): every Sonos room it names, grouped rooms included. Each room, or group for resume,
    counts as ran.
  - refrigerators (1.7.0, ADR-049): any of `power_cool`, `power_freeze`, `sabbath_mode` and
    `ice_maker`, `true` (on) or `false` (off), at least one: `{"sabbath_mode": true}`. Each goes to
    the refrigerator's driver as its own command, through Samsung's cloud; the step counts as ran
    once the commands are handed over (the refrigerator confirms seconds later). A feature a
    refrigerator does not have (its driver says which it has) is left out on it (`partial`), or the
    refrigerator is skipped with `NOT_SUPPORTED` when none is left. Schedules run it too: Sabbath
    Mode on before Shabbat and off after it.
- At most 50 scenes. `version` goes up with every change; sent back with a change
  (`PATCH /v1/scenes/{id}`), it makes the change conditional (409 `VERSION_CONFLICT`).

## Running

`POST /v1/scenes/{id}/run` sends the commands of each step, in order, through the same adapters as
the device routes, and answers `202` with what happened to each device:

- `ran`: commands handed to the controller (a device that ran with a setting it does not have left
  out, such as a fan speed, or a setpoint the thermostat refuses, is also listed in `problems` as
  `partial`, `NOT_SUPPORTED`);
- `skipped`: left alone, with the reason in `problems` — doors and gates when DirectorLink runs
  the scene itself, from a schedule or a link (`FORBIDDEN`), or with Door Control off in Composer
  (`DOOR_CONTROL_DISABLED`), a mode a
  unit does not have (`MODE_NOT_SUPPORTED`), a device no longer in the project (`NOT_FOUND`), a
  thermostat left with nothing to do once its refused setpoints are left out, an AC turned on as it
  was whose last mode is not known yet (`NO_LAST_MODE`, 1.10.0), a light that only turns on and off
  that a level for a room or the whole home leaves as it is (`ON_OFF_ONLY`, also counted in
  `on_off_only`, every one: their problems come after the others in the 50 listed). A scene link's
  run that left only such lights is `ran`, History says "3 switches left as they were"
  (`counts.on_off_only`), and a schedule's run alerts nobody for them;
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
steps the controller had before the restore, in scenes with the same id. DirectorLink 1.7.0 in
turn knows only the music steps that pause and stop: 1.8.0 keeps the others (resume, volume,
favorite) apart under `directorlink_scene_steps_2`, which 1.7.0 neither reads nor rewrites, and
marks the scenes record `music_steps_kept`, which 1.7.0 drops when it saves; back on 1.8.0 they go
back in their places the same way (ADR-057). A 1.7.0 app shows such a step as "Pause" and keeps
it when it saves the scene. DirectorLink 1.9.0 knows the climate modes off, heat, cool and auto:
1.10.0 keeps the steps that turn each AC on as it was (`mode: on`) apart under
`directorlink_scene_steps_3`, which 1.9.0 neither reads nor rewrites, and marks the scenes record
`climate_steps_kept`, which 1.9.0 and older drop when they save; back on 1.10.0 they go back in
their places the same way (ADR-070). 1.9.0 itself runs the rest of such a scene (and logs the step
it left out). A 1.9.0 app shows such a step as "On" and sends it back unchanged when it saves the
scene; its Edit screen shows Cool picked but keeps the step as it was unless one of its choices is
changed (then it becomes that mode and temperature). If the stored scenes cannot be read at start, changes are refused (503) until a
restart reads them, so they are never overwritten by an empty list.

`POST /v1/scenes/try` with `steps` runs them once without saving (admins): "Try it now".

`POST /v1/off` with `type` (lights, climate, blinds) and `device_ids` runs one step on those devices
(members, 1.3.0; since 1.8.0 a member names only devices they control, any other is `400`): lights
off, AC off or blinds closed, and answers the same way. It is Home's "Turn off all" in the app.

## On, as it was (1.10.0, ADR-070)

"Shabbat and holidays: the AC on" used to set every AC to one mode, temperature and fan. With
`{"mode": "on"}` each AC comes back as the family last left it: the living room in cool at 20°
with its fan on medium, the bedroom in heat at 23°.

- **Each thermostat's last mode.** DirectorLink remembers the last mode each thermostat was in
  that was not off and is one of its own modes (its mode list: a value such as `Undefined` while a
  zone's driver starts is not remembered), whoever set it: Control4's apps, a keypad, Composer
  programming, DirectorLink.
  It looks when the driver starts, at a project refresh or a driver update, and at every change of
  the thermostat's variables (`src/core/last_modes.lua`, from `src/adapters/manager.lua`). It is
  kept in a small store of its own, `directorlink_last_modes` (`{"version": 1, "modes": {"30":
  "cool"}}`, persistent data that survives updates and restarts), written only when a
  thermostat's last mode changes, up to 200 thermostats. It is not in backups: after a restore on
  a new controller each thermostat's last mode is seen again. `GET /v1/thermostats` shows it as
  `last_mode` (null until seen).
- **What a run does.** An AC that is off gets its last mode and nothing else, so its temperature
  and fan are the ones the AC kept. One that is on is left alone (counted as ran). One never seen
  on since DirectorLink 1.10.0 started watching (a new AC, or one off since the update) is left
  off and the run says so, in the app ("1 AC was left off: its last mode isn't known yet") and in
  History ("1 AC left off: no last mode known yet; set it once"; `counts.no_last_mode`): turn it on
  once, in its mode, and from then on it comes back. A schedule's run that leaves one off also
  alerts the admins who chose "A schedule has a problem", once a run. Floor heating and thermostats
  with heat and cool setpoints work the same (both setpoints kept). Composer's printout shows `on,
  as it was`.
- **Before it runs.** The AC action editor and the scene's card in the list name the ACs it would
  leave off now ("Not seen on yet: Living room AC, Bedroom AC — turn each on once, or they stay
  off"): those whose `last_mode` is null, or one DirectorLink cannot set (Dry).
- **Commands.** "Turn on the AC in the living room", "הדלק את המזגן בסלון", "enciende el aire del
  salón", "accendi il condizionatore del soggiorno" turn an AC that is off on in its last mode
  (`PATCH` with that mode alone), instead of asking which mode; "living room AC to 23" sets 23° in
  it. One whose last mode is not known (or a driver before 1.10.0) is asked about, as before; a mode
  said ("on cool") is that mode.

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
- **A link goes with the key that made it**: revoking that key (in Settings → Users, by removing
  its user, or with Forget access key on that device), or its expiry, removes its links (`made_by`
  in the list; the app says how many before it revokes a key). Only admins make links: since 1.8.0
  a key whose user is made a member loses them too, at the change and at a start (History
  `link_removed`, `reason` `no_access`).
- **Never doors or gates.** Only scenes whose steps are all lights, climate, fans, blinds, music or
  refrigerators can have a link; a scene with a doors-and-gates step (or a kind of step added later
  and not yet allowed) gets none (`409 SCENE_OPENS_DOORS`); adding such a step to a linked scene
  removes its link (the app warns and asks before saving), and so does deleting the scene. A run
  checks again and runs the scene as DirectorLink itself (as schedules do), which never opens a
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
| Siri (1.8.0) | A shortcut (not an automation) with the same Get Contents of URL step, named like the scene: "Good night". Then "Hey Siri, Good night". |
| Google Assistant (1.8.0) | The request in HTTP Shortcuts, Tasker or MacroDroid, named like the scene, and an Assistant routine (Assistant settings → Routines → New) that starts when you say its name and starts the app's shortcut. Each app's help says how Assistant starts it. |

A POST takes `{"secret": "…"}` as JSON, `secret=…` as a form (url-encoded or multipart), or the
secret alone as text; the whole link in place of the secret works too. Answers:

| Status | Body | When |
| --- | --- | --- |
| 200 | `{"result": "ran", "message": "The scene ran."}` | `ran`: everything ran; `partly`: some devices were skipped or did not respond; `failed`: none ran; `nothing`: there was nothing to run (its devices were removed in Composer) |
| 400 | `SECRET_REQUIRED` | no secret in the body |
| 404 | `NOT_FOUND` | an unknown home, link or secret, word for word alike; also a scene gone or with doors, a link whose key was revoked or whose key's user is no longer an admin (1.8.0), and a DirectorLink before 1.7.0 |
| 429 | `TOO_MANY_RUNS`, `Retry-After` | more than 6 runs a minute of one link, or 30 of one home; or 10 runs answered 404 in 10 minutes from the same address (an IPv6 one by its /64), which then waits until the first of them is 10 minutes old; an ask link's 10 an hour (1.8.0), `Retry-After` up to an hour and the wait in minutes in `detail` |
| 503 | `HOME_OFFLINE` | the home is not connected (a claimed home's id therefore shows whether it is online: the family needs to know) |
| 502, 504 | `HOME_DISCONNECTED`, `HOME_FAILED`, `HOME_TIMEOUT` | the home did not answer |

A GET never runs anything (link previews in Messages, WhatsApp and Slack fetch links): it is the
page with the Run button, the same for every address.

A new link's screen shows these steps, Siri's and Google Assistant's with the scene's name (1.8.0);
an existing link's screen says it in one line (the secret is not shown again: replace the link for
a new one).

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

## Ask before opening (1.8.0, ADR-058)

A scene link never opens a door or gate. For arriving at the gate, a door has a link of another
kind that **asks**: the phone's automation (Arrive, Siri, an Android app) runs it, DirectorLink asks
the user who made it, by a notification on their own devices, "Open the main gate?", and only
their **Open** there opens it.

- **Who makes one:** a key that may open that door (`Access.canOpen`: an admin, or a member given
  doors and gates whose rooms have that door, ADR-054), with **Door Control** on in Composer, Remote Access on and
  the home linked. One link per door and key: the door's row in its room has **Ask**, which opens its
  screen (`#/door/<id>/ask`); making it again replaces it. The secret is shown once, as a scene
  link's. A key sees and removes its user's links; admins see everyone's on Scenes → *Links for
  automations*, and can remove them. Since 1.9.0 (ADR-062) the door's screen also lists the links of
  the user's other devices for that door, each with the device it was made on and **Remove**: the
  link on a lost phone goes there, whatever the user's role. In the API: `GET`, `POST /v1/ask-links`
  (`{"relay_id": 70, "label": "Arriving home"}`) and `DELETE /v1/ask-links/{linkId}`; since 1.9.0
  each link says its `device` and whether it is one of the asking user's (`this_user`).
- **The run** is a scene link's (the same address, POST with the secret, the same limits), and opens
  nothing. The controller sends one notification, sealed to each device's key like every alert
  (ADR-050), to the devices of the link's user that may open the door and have **Alerts on this
  device** switched on. It is not one of the alert kinds a device chooses: the link is the choice.
  The phone that ran it is told:

  | `result` | When |
  | --- | --- |
  | `asked` | the user's devices were asked |
  | `waiting` | a question about this door is still open for this user (two minutes): nothing new is sent |
  | `nobody` | none of the user's devices that may open the door has alerts on (since 1.9.0 also when their browsers lost their push subscription: the app or DirectorLink's servers tell the controller, ADR-062) |
  | `doors_off` | Door Control is off in Composer |
  | `not_asked` | the notification could not be sent now (try again) |

  Also as a scene link's: `404` (an unknown link or secret; a link whose key, door or permission is
  gone), `429` (6 runs a minute; and at most 10 runs an hour that ask or say why nobody was asked:
  `asked`, `nobody`, `doors_off` and `not_asked` count, `waiting` and refused runs do not; then
  `Retry-After` is the real wait, up to an hour, and `detail` says it in minutes), `503`.
- **Seeing the answer at the gate.** An automation that runs with Run Immediately shows nothing by
  itself: the ask link's steps end with an optional **Show Notification** (and Siri's with **Show
  Result**) with Contents of URL, so that `nobody`, a 404 or a 429 shows on the phone.
- **The question.** The notification says "Open Main gate?" and "Your link “Arriving home” asked at
  07:15. Tap to answer." Tapping it opens the app on the question (`#/open/<door>/<request>/<until>`),
  with **Open** and **Cancel**. Open is the door's ordinary pulse, sealed with that device's key and
  checked as any opening (its role, Door Control, pulse only), and only while the question lasts (two
  minutes), only from a device it was sent to, and once (`POST /v1/relays/{id}/pulse` with
  `{"request": "<id>"}`; `409 OPEN_REQUEST_EXPIRED`, `409 OPEN_REQUEST_ANSWERED`). Cancel sends
  nothing. A question tapped after its two minutes opens nothing; the door's room is one tap away.
- **History:** "Asked whether to open Main gate", by the link (on how many devices, or why nobody
  was asked), then "Opened Main gate", by the user and device that answered, "Answering the link
  “Arriving home”". Making, replacing and removing a link are Access entries.
- **It goes** with the key that made it (revoked or expired), when its user may no longer open the
  door, when the door is removed from the project, and with Composer's Revoke All API Keys, Remove
  All Scene Links and Reset Remote Identity. Not in backups.
- **What the cloud sees:** a link's run, as for a scene link, with its result word, and a sealed
  notification for the user's key ids; never which door (docs/ACCOUNTS.md).
- **Going back to 1.7.0:** it does not read their store (it stays); their runs get 404.

## The app

- **Scenes** tab: every scene with a Run button (for a member, only the scenes they may run);
  admins tap a name to change it, make a **New scene**, or start from an idea (All off, Good night,
  Good morning, Leaving home, Cool the house) that opens the editor filled in.
- The editor: the name and an icon; **What happens** (the actions, which can be moved, changed and
  removed); **Add an action** — where (a room or the whole home), what (lights, AC, fans, blinds,
  doors and gates, refrigerators, the music, with how many there are) and what to do (fans: Off,
  On or a speed; refrigerators: Power Cool, Power Freeze, Sabbath mode or Ice maker, the ones they
  have, On or Off; music: Pause or Stop, and with a 1.8.0 driver Resume, Volume with a slider, or
  Play a favorite: the favorite from the household's Sonos favorites, **Set the volume** with a
  slider, and **Also play in** other rooms with Sonos, which are grouped with it); **Choose**
  picks single devices ("only the reading lamp of the six"); **Copy the house as it is now** makes
  the actions from the current state of every light, AC, fan and blind (doors and gates, and
  refrigerators, are never copied); **Show on Home**; **Try it now**; **Save scene**. The ideas All off and Leaving home
  turn fans off too (1.2.0).
- The AC (1.10.0, ADR-070): **Mode** Off, **On, as it was** (with a 1.10.0 driver:
  `features.climate_last_mode`), then Cool, Heat and Auto as the chosen ACs have them;
  **Temperature** Keep or a value (the stepper, or Heat and Cool in auto); **Fan** Keep or a
  speed. On, as it was hides the temperature and the fan: each AC keeps its own. Keep sends
  nothing for it, so a step can turn the ACs to cool and leave each one's temperature as it is. An
  action saved with a mode alone opens with Keep. Floor heating that only heats offers Off, On, as
  it was and Heat.
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
- Lights (ADR-077): Dim only when a dimmer is there. With a driver that sends a level for a room
  or the whole home to its dimmers only (`features.scene_levels_dimmers_only`), Add an action says
  "Only dimmers get a percentage; switches stay as they are." while there are switches there
  (lights picked one by one get the level, and a switch among them turns on), the action reads
  "All dimmers" ("Kitchen dimmers" on the scene's card), and a run that left only switches as they
  are is done: "Done — only dimmers get a percentage; 3 switches stayed as they were".
- **Home** shows the scenes marked Show on Home, with one-tap Run, above the favorites.
- Saving leaves out devices and rooms that are no longer in the project, and says so.
