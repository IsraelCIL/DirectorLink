# Sonos

DirectorLink 1.5.0 shows the home's Sonos speakers in the app: what each Sonos room plays, play,
pause, next and previous, its volume and mute, and the Sonos favorites. The home has no Sonos
driver in Control4, so DirectorLink talks to the speakers itself, on the home network (ADR-044).
Since 1.8.0 (ADR-057) rooms play together in groups, as in the Sonos app, and scenes start a
favorite, set the volume and resume.

## Setup

1. In Composer, select DirectorLink and set the property **Sonos** to `On`. It ships `Off`: then
   DirectorLink does not look for any Sonos and sends nothing to one.
2. Look at **Sonos Players**: within a few seconds it lists the players found, with their
   addresses, e.g. `3 players: Bedroom (192.168.50.13), Kitchen (192.168.50.11), Living Room (192.168.50.12)`.
3. If it says `None found`, set **Sonos Address** to one player's IP address (the Sonos app shows
   it under Settings → System → About My System). That player lists the others. This is needed
   when the controller and the speakers are on different networks (VLANs), where the search cannot
   reach them. Spaces around it, `http://` before it and `:1400` after it are fine
   (`http://192.168.50.12:1400/` is read as `192.168.50.12`). Anything else (a name, another port,
   an address outside the home network) is not used, and Sonos Players says so:
   `Sonos Address is not understood: ...`. If no player answers at the address, Sonos Players says
   `None found. No Sonos player answered at 192.168.50.12 (Sonos Address).`

No restart is needed for either property. Turning Sonos off stops everything at once.

## Rooms

Each Sonos room shows in the Control4 room with the same name, matched without regard to case or
spaces ("Living Room", "living room" and "LivingRoom" are one name). A room's names in other
languages, set in the app, count too: a Sonos room named "מטבח" shows in the Control4 room
"Kitchen" when its Hebrew name is מטבח.

A Sonos room whose name matches no room (or more than one) shows under **No room** until an admin
picks its room in the app under Settings → Rooms → Sonos rooms. The choice is kept on the controller
(`PUT /v1/music/{id}/room`); "Same name" goes back to matching by name. Hidden rooms and the room
order work as for other devices.

A Sonos room is a room as the Sonos app shows it: a stereo pair, or a home theater with its
surrounds and sub, is one room. A Boost or a Bridge is no room.

**Control4's own Sonos drivers too.** A project may also have Control4's Sonos drivers ("Works With
Sonos Certified": `sonos.c4z` for each player, `sonosNetwork.c4z`, `sonosGlobalLineIn.c4z`, or any
other driver with Sonos in its file name). DirectorLink does not control their devices; while Sonos
is On they are the same players as its Music cards, so the app leaves them out of their room's
"other devices" (1.11.0, ADR-080: `part_of_music` in `/v1/devices`, which still lists them). With
Sonos Off they are listed there as before.

## In the app

- **On a room's screen**, a Music card for each Sonos room there: the album art, what plays (title,
  artist and album; for the radio, the station and what it plays now; for Spotify Connect or
  AirPlay, the app), whether it plays, and the other rooms of its group.
- **Admins, and members given Music** (1.8.0, ADR-054) play and pause, skip to the next or
  previous track, set the volume and mute, and start a Sonos favorite, in the rooms they see. A
  member without Music does not see the Sonos rooms at all.
- **On Home**, "Music playing" lists each group that plays, with a pause button.
- **Groups** are shown as Sonos has them: play, pause and skip on any room of a group act on the
  whole group (its coordinator). The volume and mute are each room's own.
- **Playing in several rooms (1.8.0).** A group of rooms has one card, on each of its rooms'
  screens: "Kitchen + Living Room", what it plays once, play and pause, a slider for the group and
  one for each room, and **Leave group** for each room. On a room that plays, **Play in more rooms**
  lists the other rooms: a tap and that room joins the group and plays the same, in step. On a room
  that plays nothing, **Play here too** lists what plays elsewhere: a tap and this room joins that
  group. Playing in a second room this way keeps the first one playing (a music service plays one
  stream per account: two rooms each playing on their own stop each other). The group's slider
  sets each room's own volume, keeping their balance (the quieter room stays quieter); the group's
  volume is their average.
- **Favorites** are the household's Sonos favorites (My Sonos). A radio station starts as it is;
  a playlist, an album or a track replaces the group's queue and plays, as the Sonos app's
  "Play now" does. Some favorites, such as Sonos Radio's shortcuts, can only be started in the
  Sonos app: they are greyed out.
- **Album art** comes through the controller, like camera pictures: the app's page is HTTPS and the
  speaker answers plain HTTP on the home network.

## Scenes

A scene step can pause or stop the music in a room, or in the whole home ("Good night: music off").
Since 1.8.0 it can also resume it, set the volume, or play a Sonos favorite (below).
A group pauses as one: if the room is grouped with others, they pause too. Each group is first
asked what it does: one that is already paused or stopped is left as it is, so a paused queue keeps
its place in the track and a paused Spotify Connect session is not ended. A radio station, which
Sonos cannot pause, stops. Scheduled scenes run music steps like any other (as DirectorLink itself).

Each group handled counts as ran in the run's report. A step that finds nothing is skipped and says
why, as a problem with `device_id` 0: `SONOS_OFF` (Sonos is off in Composer), `NO_PLAYERS` (no
player found yet) or `NO_SONOS_ROOM` (no Sonos room is shown in the step's room, for example after
a Sonos room was renamed).

1.8.0 (ADR-057):

- **Resume**: each group with a room there that is paused or stopped plays again (a radio station
  a scene stopped starts again); one that plays, or has nothing to play, is left alone. It does
  not remember what a scene paused: a room paused earlier by someone else plays too, and Sonos
  rooms not in use usually sit paused, so a Resume for the whole home starts every room that has
  something to play. The editor says so under Resume.
- **Volume**: each Sonos room there gets that volume, its own.
- **Play a favorite**, in a room: the Sonos favorite picked in the editor, at a volume if one is
  set, and in other rooms too (**Also play in**). The rooms are grouped first, as in the Sonos app:
  the step's room leaves a group it followed, the others join it, each gets the volume, then the
  favorite starts on it (a playlist replaces the queue). A room that does not answer is left out
  and the others play. Each room counts as ran.
- **A favorite since removed in Sonos**: the step is skipped with `FAVORITE_GONE` ("The Sonos
  favorite "Morning FM" is no longer in Sonos favorites") and nothing of it runs. The step keeps
  the favorite's id, its name and what the favorites list gives to start it (its address and
  description); at run time DirectorLink looks it up in the favorites list (the same id with the
  same address or name, or the same address under another id) and starts it as the list has it.
  While a scene plays a favorite, the favorites are read every half hour, so a run knows at once;
  just after a start they are read first, and a favorite found gone then is only logged.
- **Who may**: a scene's music steps run in full, as its other steps do (ADR-054): a member an
  admin chose the scene for, a schedule and a link change every Sonos room the step names, grouped
  rooms included, also rooms the member could not control themselves (DirectorLink's own runs,
  schedules and links, leave out only doors and gates). The Music screen and `/v1/music` change
  only the rooms the person may control (`FORBIDDEN` for the others; a group only when every room in
  it may be).

## How DirectorLink talks to the speakers

Sonos speakers answer a local protocol on port 1400: UPnP, with SOAP calls to the services
AVTransport, RenderingControl, ZoneGroupTopology and ContentDirectory. The Sonos app, Home
Assistant and Control4's own Sonos driver use it. **Sonos does not document it**; it has stayed
the same for years, but a Sonos update could change it. (Sonos's documented Control API works
through Sonos's cloud, which DirectorLink does not use.)

- **Finding the players.** An SSDP search (UDP to 239.255.255.250:1900, for
  `urn:schemas-upnp-org:device:ZonePlayer:1`) when Sonos is turned on and every 5 minutes, and the
  player at Sonos Address if set. One player's zone group state (GetZoneGroupState) lists every
  room and group with its address. A search takes the first 32 addresses that answer, each once
  (any one player lists the whole household); an address from a search is contacted until the
  next search, or for as long as a player lists it. When a player does not list the rooms, the
  next address is asked at once, 4 in a row at most; the others wait for the next read.
- **Only the players.** DirectorLink sends requests only to addresses of the home network
  (10.x, 172.16–31.x, 192.168.x) on port 1400, which a player gave in its answer to the search or
  in its zone group state, or which the installer typed in Composer. An API request names a Sonos
  room, never an address. No other host is contacted: album art a music service keeps on its own
  servers is not shown, and an answer that redirects elsewhere (any 3xx, or more than one answer
  to a request) is a failure whose content is never used. One file sends to the players
  (`src/sonos/client.lua`); `scripts/check_package.py` fails the build if another Sonos file or the
  music API sends anything itself, if any file but `src/sonos/sonos.lua` allows an address or loads
  the client (`src/main.lua` only hands it the search's network events: `onData` and
  `onConnectionStatus`, nothing else), or if another action is added.
- **Answers are not trusted.** Any device on the home network can answer the search. Every answer
  is read in time in proportion to its size, so a crafted one cannot hold the controller's single
  Lua thread: at most 512 KB, 16 KB for one tag, 5000 elements, 64 deep, entities never expanded.
  What is shown is cut to 1 KB (a title, an artist, a favorite's name) and a room's name to 100
  bytes; a picture path longer than 2 KB is not used.
- **What it sends.** Reading: GetTransportInfo, GetPositionInfo, GetMediaInfo, GetVolume, GetMute,
  GetZoneGroupState, Browse of the favorites (FV:2), and a GET of the album art. Controlling: Play,
  Pause, Stop, Next, Previous, SetVolume, SetMute, and to start a favorite SetAVTransportURI,
  RemoveAllTracksFromQueue and AddURIToQueue. Grouping (1.8.0): a room joins a group with
  SetAVTransportURI and the address `x-rincon:<coordinator's id>`, only for a coordinator found in
  the household's zone group state, and leaves it with BecomeCoordinatorOfStandaloneGroup; a
  group's volume is each room's own SetVolume. Nothing else: no alarms or settings.
- **How often.** A room someone has open in the app (its room screen, or Home for all of them) is
  read every few seconds for 15 seconds after each look; the app looks every 5 seconds. The others
  are read once a minute, and the groups every 30 seconds while someone looks, else every 5 minutes.
  A read is one request at a time per group (its transport and track on the coordinator, then each
  room's volume and mute); at most 4 requests are on their way at once, each with a 4-second
  timeout, so the controller's single Lua thread never waits for a speaker. After a command the
  room is read again within 2 seconds. When 40 requests already wait, a read is put off to the
  next tick (every 2 seconds): a room is shown as not answering only when its player did not
  answer. The album art is asked for once however many ask at the same time, and a picture the
  player did not give is not asked for again within 30 seconds. While a scene plays a favorite,
  the favorites are read every half hour (1.8.0). After a room joins or leaves a group the
  household is read again within 2 seconds.
- **Pause.** Pause goes to the group's coordinator. When Sonos refuses it (UPnP error 701),
  DirectorLink reads what the group plays (GetMediaInfo): a radio station, which Sonos cannot
  pause, is stopped instead; anything else (the TV, line-in, a group already stopped) is left as it
  is and the refusal is reported (`409 ACTION_NOT_POSSIBLE`).

## API

`GET /v1/music` (every Sonos room, or `?room_id=` those shown in a room), `GET /v1/music/{id}`,
`POST /v1/music/{id}/play|pause|next|previous`, `PATCH /v1/music/{id}` (`volume`, `muted`),
`GET /v1/music/{id}/favorites`, `POST /v1/music/{id}/favorites/{favoriteId}/play`,
`GET /v1/music/{id}/art`, and for admins `PUT /v1/music/{id}/room`. Since 1.8.0:
`POST /v1/music/{id}/group` with `{"with": "<id>"}` (join the group of that room),
`DELETE /v1/music/{id}/group` (leave it), `PATCH /v1/music/{id}/group` with `{"volume"}` (the
group's volume), and `groups` in `GET /v1/music`; `features.sonos_groups` in `GET /v1/system`.
Admins, and members given music, read and control the Sonos rooms in the rooms they see; to others
a Sonos room answers `404` like one that does not exist (ADR-054). A command on a group needs every
room in it (1.8.0, by `Access.canControl`). See [`api/README.md`](../api/README.md) and
`api/openapi.yaml`.

## Limits

- The protocol is not documented by Sonos (above).
- Spotify Connect and AirPlay play through the speaker from another app: DirectorLink shows the
  app's name, and the track only when the speaker reports it. Next and previous are passed on to
  that app.
- Volume and mute are per room; a group's volume is set through each room's own (1.8.0), as the
  four services have no group volume DirectorLink uses.
- Grouping and a favorite started by a scene (1.8.0) were tested on fake players whose zone group
  state follows the groups, not yet on the owner's.
- Album art only from the speaker itself (most music services' art comes through it).
- Starting a playlist, album or track favorite replaces the group's queue.
- The Sonos room choices go into DirectorLink backups since 1.6.0 (ADR-048), and a restore brings
  them back, each matched to the project's rooms like a scene's room; a backup made before 1.6.0
  leaves the choices on the controller as they are.
- Read against the owner's players (three Sonos Amps, software 97.1, S2): their answers, anonymised,
  are the test fixtures in `tests/sonos/real/`. Grouped rooms, a stereo pair, a home theater, a
  track from the queue, the radio and playable favorites were made in the same shapes
  (`tests/sonos/made/`). Older S1 players have not been tried.
- The search from a DriverWorks driver (a UDP network connection, as Snap One's own SSDP module
  does it) has not been seen on a real controller yet; Sonos Address is the way when it finds
  nothing. A device on the network that answers the search for 32 made-up addresses before the
  players do fills the search: the players already known, and the one at Sonos Address, are still
  asked first.
- Whether Director's HTTP client (`C4:url`) follows a redirect by itself has not been checked on a
  controller. If it does, a "player" that redirects makes the controller send that one request to
  the other host, but nothing it answers is used.

## Testing without speakers

- The driver's tests use fake players (`driver/tests/sonos_fake.lua`) answering with the fixtures.
- `node tests/sonos/fake-sonos.mjs --port 8212` runs fake players (Kitchen leads Living Room and
  plays a track, Bedroom plays the radio, TV Room is paused in Spotify Connect; rooms join and
  leave groups, and the zone group state they answer follows), and
  `python scripts/dev_server.py --sonos 8212` runs the driver against them; the contract test
  (`scripts/check_contract.py`) does the same on a free port.
