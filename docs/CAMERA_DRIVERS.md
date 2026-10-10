# Camera drivers for DirectorLink

> **DirectorLink is an independent project, not affiliated with Control4 or Snap One.**

DirectorLink shows every camera of a Control4 project in its app, through Control4's camera proxy.
A camera driver can give DirectorLink more: its detections as alerts on the family's phones ("Person
at Garden at 21:14"), and, for a doorbell, its rings, with Home's banner and the ring alert. This
page is the **DirectorLink camera agreement, version 1**: what a Control4 camera driver does so that
DirectorLink 1.10.0 and later takes it without any code of its own for that driver. The free
[DirectorLink Drivers](https://directorlink.io/drivers) follow it; any driver may.

The agreement is a few variables and two events, all by name. A driver that follows it works the
same without DirectorLink: nothing here depends on DirectorLink being in the project.

## The agreement, version 1

| What | The driver | DirectorLink |
| --- | --- | --- |
| **Marker** | A string variable `DIRECTORLINK_CAMERA`, value `1` (the agreement's version) | Knows the camera's driver follows the agreement |
| **Kind** | A string variable `DIRECTORLINK_CAMERA_KIND`, value `camera` or `doorbell` | A `doorbell` is listed with the doorbells too |
| **Its events' ids** (recommended) | A string variable `DIRECTORLINK_CAMERA_EVENTS`, value `Alert=<id>,Ring=<id>` (a camera: `Alert=<id>`), the ids in its `driver.xml` | Watches those events, without reading the driver's `driver.xml` |
| **An alert** | Sets the string variable `LAST_ALERT` to the label (below), then fires the event named exactly `Alert` | Sends the camera alert |
| **A ring** (a doorbell) | Sets the string variable `LAST_RING` to the time, ISO 8601 in UTC (`2026-10-05T18:14:03Z`), then fires the event named exactly `Ring` | A ring: Home's banner, the ring alert |
| **Pictures and live video** | Through its camera proxy, as every Control4 camera driver | Reads the address, the login and the snapshot path from the proxy |

1. **One camera a driver.** The driver has one camera proxy (`camera`). DirectorLink does not watch
   a driver with several camera proxies (an NVR's channels): give each camera its own driver, as the
   DirectorLink · Hikvision Camera driver does.
2. **The marker and the kind** are ordinary driver variables (`C4:AddVariable`), read by their names.
   Add them as early as you can (in `OnDriverInit`). A driver that knows its kind only later (once
   it reaches the camera and learns its model) may add the marker or change the kind then:
   DirectorLink looks again every few minutes. Set the kind before the first ring.
3. **The events** `Alert` and `Ring` are declared in the driver's `driver.xml` (`<events>`), with these
   names. Their ids are yours. A doorbell has both, a camera only `Alert`. Do not add them at run
   time with `C4:AddEvent`: Director lets another driver register them by id only.
4. **Say their ids in `DIRECTORLINK_CAMERA_EVENTS`** (recommended, not required):
   `Alert=7,Ring=8` for a doorbell whose `driver.xml` numbers them 7 and 8, `Alert=7` for a camera.
   Names without case or spaces around, ids as in `driver.xml`, separated by commas. With it,
   DirectorLink watches those ids and needs nothing else from Director. Without it (or with a value
   it cannot read, which it ignores with a warning in its log), DirectorLink looks for the events by
   name in `driver.xml` as Director gives it (`C4:GetDeviceData`; names without case or spaces
   around, the first of each name, comments skipped), which is not yet confirmed on every Director
   version.
5. **Set the variable first, then fire the event.** DirectorLink reads `LAST_ALERT` or `LAST_RING` when
   the event comes. Give `LAST_RING` a new value for every ring.
6. **Pictures** come through Control4's camera proxy, as for every camera: DirectorLink asks the
   proxy for the camera's address, ports, login and snapshot path (`GET_PROPERTIES`, and
   `GET_SNAPSHOT_QUERY_STRING` with `SIZE_X` and `SIZE_Y`, the size it wants), and fetches pictures
   320, 640, 1280 or 1920 pixels wide. Answer small sizes with a small picture (a camera's sub
   stream) where the camera has one.
   - **Only a plain HTTP or HTTPS GET** of `http(s)://<address>:<port>/<snapshot path>`, with the
     proxy's user name and password as a Basic or Digest login, or no login. No token, cookie or other
     header: a camera that needs an API key (a UniFi console, for one) has its driver serve the
     pictures itself, at an address and path the proxy gives.
   - **How many at once:** at most two pictures at a time from one address (scheme, host and port),
     and at most three in all from an address several cameras share (an NVR, or a console that
     serves every camera's pictures); eight at a time in the home. The others wait their turn.

### Example

`driver.xml`:

```xml
<proxies>
    <proxy proxybindingid="5001" name="Camera" primary="True">camera</proxy>
</proxies>
<events>
    <event><id>1</id><name>Alert</name><description>When NAME raises an alert</description></event>
    <event><id>2</id><name>Ring</name><description>When someone rings at NAME</description></event>
</events>
```

`driver.lua`:

```lua
function OnDriverInit()
    C4:AddVariable("DIRECTORLINK_CAMERA", "1", "STRING", true, false)
    C4:AddVariable("DIRECTORLINK_CAMERA_KIND", "doorbell", "STRING", true, false) -- or "camera"
    -- Recommended: the ids of Alert and Ring in driver.xml (a camera: "Alert=1").
    C4:AddVariable("DIRECTORLINK_CAMERA_EVENTS", "Alert=1,Ring=2", "STRING", true, false)
    C4:AddVariable("LAST_ALERT", "", "STRING", true, false)
    C4:AddVariable("LAST_RING", "", "STRING", true, false)
end

-- A detection the driver's own settings say is worth an alert: once per alert.
local function RaiseAlert(label) -- "Person", "Vehicle", "Package", ...
    C4:SetVariable("LAST_ALERT", label)
    C4:FireEvent("Alert")
end

-- Someone pressed the doorbell's button.
local function Ring()
    C4:SetVariable("LAST_RING", os.date("!%Y-%m-%dT%H:%M:%SZ"))
    C4:FireEvent("Ring")
end
```

### The labels

`LAST_ALERT` is one of these labels. Case, spaces, `_` and `-` do not matter: DirectorLink leaves
them out before it compares, so `License Plate`, `license_plate`, `LICENSE-PLATE` and `LicensePlate`
are one label. The app and its alerts say each in the app's language (English, Hebrew, Spanish or
Italian); any other label is said as "Alert".

| Label | The app says |
| --- | --- |
| `Person` | Person |
| `Vehicle` | Vehicle |
| `Animal` | Animal |
| `Package` | Package |
| `Face` | Face |
| `License Plate` | License plate |
| `Line Crossing` | Line crossed |
| `Intrusion` | Intrusion |
| `Motion` | Motion |
| `Region Entrance`, `Region Exiting` | Someone entering, Someone leaving |
| `Tamper`, `Scene Change` | Tampering, View changed |
| `Object Left`, `Object Removed` | Object left behind, Object removed |
| `Alarm Input`, `PIR` | Alarm input, Motion (PIR) |
| `Smoke Alarm`, `CO Alarm` | Smoke alarm, CO alarm (sent even right after another alert: below) |
| `Siren`, `Burglar Alarm` | Siren, Burglar alarm |
| `Glass Break`, `Car Horn` | Glass breaking, Car horn |
| `Baby Crying`, `Speech`, `Barking` | Baby crying, Someone talking, Dog barking |

The sounds (from `Smoke Alarm` to `Barking`, DirectorLink 1.11.0 and later) are what a camera
hears, as the DirectorLink · UniFi Protect driver names them; DirectorLink 1.10.x says them as
"Alert". One label an alert: when a camera heard several sounds at once, give the most urgent
(`Smoke Alarm`, then `CO Alarm`); `Smoke Alarm, Siren` is no label.

## How DirectorLink uses it

- **Recognizing the driver.** When it reads the project, DirectorLink reads the variables of each
  camera proxy's driver by name. A marker that comes later, a kind that changes, or a new
  `DIRECTORLINK_CAMERA_EVENTS` is seen within a few minutes (DirectorLink looks at five cameras a
  minute); what takes something away (the marker gone, a doorbell back to a camera) only when two
  looks in a row say so. A driver updated in Composer (a new `<version>`) is read again within
  minutes, its events too. Refresh Project reads everything again at once.
- **Alerts.** "Person at Garden at 21:14", on the phones and computers that switched on camera alerts
  (off until chosen) and whose user may see that camera's pictures. At most one alert a camera a
  minute, and 30 camera alerts an hour in the home, so that rings always get through. A smoke or CO
  alarm (1.11.0) is not held back by the camera's other alerts: at most one of each a camera a
  minute, whatever else that camera alerted about, and 10 an hour in the home of their own, apart
  from the 30. The driver
  decides what is worth an alert (its own settings, schedules and snooze): DirectorLink passes on its
  `Alert`, not every detection.
- **Doorbells.** A `doorbell` is listed with the doorbells as well as with the cameras, under the
  camera's own id, with its own picture: Home shows "Someone is at the door" with its live picture
  for two minutes after a ring, its room shows when it rang last and its last 5 rings (the API,
  `GET /v1/doorbells/{id}`, keeps its last 20), and everyone who sees the doorbell gets the ring
  alert (members too, in their rooms; the picture only for those who see cameras). At most one ring
  alert a doorbell in 30 seconds. The ring's time is `LAST_RING` when it is new (later than the ring
  before) and from two minutes behind the controller's clock to five seconds ahead of it; else the
  moment the event came, so a `Ring` without a new `LAST_RING` is still a new ring. After
  DirectorLink restarts, its last ring is `LAST_RING`, unless that is ahead of the controller's clock.
- **A gate or door at a doorbell.** A doorbell camera itself opens nothing in DirectorLink
  (`can_open` false; `POST /v1/doorbells/{id}/open` answers `409 NOT_SUPPORTED`). If the doorbell
  has a relay of its own (a door strike, a gate), give the driver a Control4 relay connection and have
  the installer bind it in Composer to a Relay Door, Gate or Garage Door Controller's Open/Toggle
  relay, so that Control4's apps and programming open it. DirectorLink 1.10.0 shows that controller as
  a door or gate of its own, in its room, and opens it with the controller's Open (ADR-069): a relay
  connection must take the controller's `CLOSE` (and `TRIGGER`, `TOGGLE`) as one pulse, never a hold,
  as the DirectorLink · DoorBird driver does.
- **That gate at the ring (DirectorLink 1.11.0, ADR-078).** A controller whose Open/Toggle relay is
  bound to a relay connection of the doorbell camera's own driver is that doorbell's door, found by
  DirectorLink from the binding alone (every one, when several are). The ring's notification opens
  the doorbell's screen in the app, with its live picture and a big "Open <door>" (the door's own
  Open, two taps, for whoever may open that door); Home's ring banner has the same button, and
  Android and desktop browsers show "Open <door>…" on the notification (it opens the screen, never
  the gate). **Nothing new is asked of the driver: the agreement stays version 1.** The relay
  connection and its binding are what they were for Control4; DirectorLink reads what Composer bound
  (`C4:GetBoundProviderDevice`), which also counts a binding Director reports on the camera proxy.
  A gate not wired through the doorbell (a KNX relay, another relay module) can be added at the
  doorbell by an admin in the app.
- **Privacy.** Names, rooms and what a camera saw stay on the controller: an alert is sealed on the
  controller for each phone, and DirectorLink's servers only pass it on (see
  [`ACCOUNTS.md`](ACCOUNTS.md)). Pictures go from the camera to the controller and, sealed, to the app.

## What a driver must not do

- **Alert on every motion.** Fire `Alert` once per alert, not again while it lasts, and only for what
  the user asked for: the home's alerts are limited, and a busy camera crowds out the others.
- **Hold back a smoke or CO alarm** behind another alert of the camera: fire `Alert` with
  `Smoke Alarm` or `CO Alarm` even while another of its alerts lasts (its hold time):
  DirectorLink sends it even right after the camera's other alerts.
- **Fire `Ring` for anything but a press** of a doorbell's button, or from a driver whose kind is
  `camera`.
- **Put names, addresses or other personal data in `LAST_ALERT`.** It is a label from the list.
- **Write `LAST_RING` in local time** or without its zone: UTC, ending in `Z`.
- **Rename or renumber `Alert` and `Ring` without a new driver version** (and a
  `DIRECTORLINK_CAMERA_EVENTS` that says the new ids). DirectorLink reads the events again when
  Composer updates the driver to a new `<version>`.
- **Use the `DIRECTORLINK_` variables for anything else**, or set the marker on a driver with more
  than one camera.
- **Depend on DirectorLink.** The driver works on its own; DirectorLink only reads what it shows to
  every Control4 driver.

## Versions

| DirectorLink | Camera drivers |
| --- | --- |
| 1.11.0 and later | The sounds among the labels (`Smoke Alarm` … `Barking`); a smoke or CO alarm is not held back by the camera's other alerts (ADR-080). A Relay Door, Gate or Garage Door Controller on the driver's relay connection is the doorbell's door (ADR-078). The agreement stays version 1. |
| 1.10.0 and later | The agreement, version 1, with `DIRECTORLINK_CAMERA_EVENTS`. A driver that says a later version is read as version 1 (a later version only adds). |
| 1.8.0 to 1.9.x | Only the DirectorLink · Hikvision Camera driver, by its file name (`DirectorLink-Hikvision-Camera.c4z`), its event 1 and `LAST_ALERT`. Other cameras: pictures only; a doorbell camera is a camera. |

DirectorLink 1.10.0 still knows the DirectorLink · Hikvision Camera driver by its file name while it
does not set the marker; once it does, by the marker only, never twice.

## Trying a driver

- In Composer, the driver's **Variables** show the marker, the kind, `LAST_ALERT` and `LAST_RING`.
- DirectorLink's log (in Composer, at the shipped **Log Level**, Info) says for each camera of the
  agreement, once it is set up, which `Alert` and `Ring` it watches and how it found them (`a camera
  of DirectorLink's camera agreement`, `events_by`: `by DIRECTORLINK_CAMERA_EVENTS`,
  `by name from Director`, `Hikvision event 1` or `not found`). It warns for each event the kind needs
  and it did not find (`without an event named Alert`, `without an event named Ring`), and for a
  `DIRECTORLINK_CAMERA_EVENTS` it cannot read (`DIRECTORLINK_CAMERA_EVENTS is not Alert=<id>,Ring=<id>`).
  At Debug it also says what Director gave of the driver's `driver.xml` (`what Director gives of a
  camera driver's events`: its size, how many events, their names).
- Without a controller: `python scripts/dev_server.py --agreement-cameras` runs DirectorLink against
  a fake Director with two made-up drivers of the agreement, a camera (driver 157) and a doorbell
  (driver 158); type `alert 157 Animal` or `ring 158`. With `--door-controllers` too, the doorbell
  has its gate, a Relay Gate Controller on driver 158's relay (76 "Entrance Gate").
- DirectorLink's log says, at each project read, `door controller set up` for the gate (its
  controller and bindings), and `GET /v1/doorbells/{id}` lists the gate in `doors` with `link`
  `automatic`.

The decision and its details are ADR-065 in [`DECISIONS.md`](DECISIONS.md); the sounds, ADR-080.
