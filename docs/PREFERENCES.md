# Preferences, users and the home's settings

**Status: built in DirectorLink 0.12.0.** Scenes (0.13.0, `docs/SCENES.md`) and schedules (0.14.0,
`docs/SCHEDULES.md`) follow the same rules. Users' roles and permissions: 1.8.0 (ADR-054, *Users:
admins and members* below). Users and their devices: 1.9.0 (ADR-061, *Users and their devices*
below). Settings → Appearance and language, the text size, Spanish and Italian: 1.10.0 (ADR-067,
*Appearance and language* below).

## Where each setting lives

| Whose | Examples | Where | Who changes it |
| --- | --- | --- | --- |
| The home's | room names per language, the room order, rooms hidden from members, scenes, schedules, users' roles and permissions | the controller | admins (members run the scenes an admin chose for them) |
| A user's | language, theme, palette (colours), favorites, hidden rooms | the controller, in their **profile** | that user, from any of their devices |
| This device's | the controller's address, the access key, the browser's notification permission, the text size | the browser | this device |

Everything on the controller works without the internet and without DirectorLink's servers,
survives driver updates (`src/core/store.lua`), and travels through the end-to-end lock when used
away from home, and from the app on the home network too (1.0.0). The cloud never sees any of it.

## Profiles

- A profile is a user (until 1.9.0 the docs said a person). **Every API key belongs to one profile**
  (`profile_id` on the key): the key is one of that user's devices.
- Composer's pairing code, an admin creating a key, and an invitation for someone else each make a
  new profile, named after the key (a key created with `profile_id` joins that user instead, 1.8.0);
  since 1.12.0 (ADR-083) an invitation from Add a user, like a pairing code made for a new user,
  names the profile as the admin chose.
  **Add my other device** (an invitation with `for_me`) puts the new key in the inviter's profile,
  so a user's phone starts with their language, theme and favorites. Since 1.9.0 a pairing code an
  admin makes in the app is for a user they choose, or a new one (*Users and their devices*).
- An admin can move a key to another profile (`PATCH /v1/api-keys/{id}` `profile_id`, or Settings →
  Users → User) — for two devices of one user that were paired separately; since 1.8.0 the key then
  has that user's permissions — and rename a profile (`PATCH /v1/profiles/{id}`). Since 1.12.0 every
  user names their own profile (`PATCH /v1/profile` `name`) and renames their own devices
  (`PATCH /v1/api-keys/{id}` `name`); `GET /v1/profile` says `name_from_device` while the name is
  still one of their devices', and the app then asks once for their name. A profile goes with its
  last key.
- Keys from before 0.12.0 get a profile each at the first start; an admin can then merge them.
- `GET /v1/profile` / `PATCH /v1/profile` are the caller's own (any role): `prefs` with `language`
  (`auto` or a tag), `theme` (`auto`, `light`, `dark`), `palette`, `favorites` (`"kind:id"`, in
  order) and `hidden_rooms` (room ids). `null` clears one. `version` goes up with every change; sent
  back, it makes the change conditional (409 `VERSION_CONFLICT` if another device changed it).
  Since 1.8.0 `GET /v1/profile` also has `access`: what the caller may see and do (below).

## Users: admins and members (1.8.0, ADR-054)

A user has a role, **admin** or **member**, and every key of theirs has that user's permissions:
all of a user's devices follow one change. Before 1.8.0 each key had a role of its own (`viewer`,
`member`, `doors`, `admin`; ADR-025).

- **Admins** do everything: users and their permissions, keys, invitations, rooms, scenes,
  schedules, settings, History, backups, remote access, the log.
- **Members** have what an admin chose for them in Settings → Users, or when inviting them
  (`GET`/`PATCH /v1/profiles/{profileId}/access`):

| Permission | What it gives | A new member |
| --- | --- | --- |
| Rooms | the rooms they see: all, or a list | all |
| Lights, Climate (AC and heating), Fans, Blinds, Music (Sonos), Refrigerators | that kind of device in their rooms; off hides the kind from them (lists, Home, Turn off all) and the controller refuses it. Heaters wired as KNX lights follow Lights | all on |
| Cameras | the cameras in their rooms, and a doorbell's picture | on |
| Doors and gates | opening the doors and gates in their rooms (they see them and their state either way); Door Control must be on in Composer too | off |
| Sees the alarm | the alarm's status; Alarm Status must be On in Composer too | on |
| Scenes they may run | those scenes, run in full: devices they could not control themselves too, doors and gates included (with Door Control on) | none |

- A doorbell in a member's rooms rings for them (with its ring alert) either way; its picture shows
  only with Cameras on.
- Members never edit scenes and never see schedules, History, keys, invitations, profiles, room
  settings, controller settings or backups. Since 1.9.0 they see their own user and its devices in
  Settings → Users, and add and remove their own devices (*Users and their devices*).
- The controller checks every request. A device, room or scene a member may not see answers `404`
  like one that does not exist; a door or gate they see but may not open, `403 FORBIDDEN`.
- `GET /v1/profiles` gives each user's `access`; `GET /v1/profile` and `GET /v1/api-keys/current`
  give the caller's own (an admin's all true), so that the app shows only what they may use.
- The home's **owner** (the user who last claimed it for an account, or whom the owner made the
  owner, else the oldest admin) is always an admin: no other admin can demote them, change their permissions, revoke or move their
  devices, add a key or device to them (a key with `profile_id`, a device moved in, an invitation
  for another device of theirs), or make someone an admin who would then be the owner
  (`403 OWNER_PROTECTED`). There is always an admin (`409 LAST_ADMIN`). While DirectorLink could
  not read the users' (people's) or the profiles' store when it started, admins' devices and permissions
  and claims wait (`503 UNAVAILABLE`), and nothing is written over the store it could not read.
- **Handing the home to another admin** (1.9.0, ADR-064): the owner, and only the owner, taps **Make
  Dana the owner** on another admin's row in Settings → Users (a member is made an admin first) and
  confirms. Dana is then the owner, with everything above, and only Dana can hand the home on; the
  old owner stays an admin like any other, and nobody is removed. When the home is linked to an
  account, Dana's Google or Apple account becomes the home's account too (it approves accounts that
  join with another email and replaces the home's secret), so Dana must have signed in to
  DirectorLink on one of their devices first. In History.
- A member's lists and answers name nothing they may not see: their rooms' alarm partitions only
  with the alarm, a Sonos group only through their Sonos rooms, a scene's steps only with their
  rooms and devices (`elsewhere` for the rest), the controller's inventory only what they see.
- From 1.7.0, each user gets the highest role among their keys: `admin` an admin, `doors` and
  `member` a member with every room and kind (doors and gates for `doors` only), `viewer` a member
  with no rooms and cameras only. ADR-054 has the details. Every key keeps a 1.7.0 `role` worked
  out from its user, for 1.7.0 apps and for a downgrade.

## Users and their devices (1.9.0, ADR-061)

**Settings → Users** is one screen: each user with their name, Admin or Member and their access,
whether their devices use a Google or Apple account, and under them every device they connected,
when it was last used, and **Remove**. Admins see every user; a member sees only themself and their
own devices (`GET /v1/users`).

- **One user, one set of permissions.** Two people who share one Google account are one user.
- **An account for remote access.** A user uses DirectorLink away from home through a Google or
  Apple account on their devices; the account joins the home by an invitation (an admin can invite
  the account of a user paired at home into that user: Invite their account). A user without an
  account is fine (a child's iPad, a kitchen tablet, a script): the home network only.
- **Up to 5 devices a user** (keys that are not revoked or expired). A sixth is refused on every way
  of adding one (a pairing code for the user, an invitation and its join, Add my other device, Join
  from another device, a key made or moved into the user, bringing an account's devices together)
  with `409 USER_DEVICE_LIMIT`, which lists that user's devices with when each was last used; the
  app says "Remove a device first", with Remove where the caller may. A user who had more before
  1.9.0 keeps them and gets none until they have fewer than five. When each device was last used is
  kept across restarts (to the hour).
- **The devices of one account become one user when an admin confirms it.** The account service
  tells the controller which keys share an account, as an opaque tag per account and home
  (docs/ACCOUNTS.md). When an account's devices are in two users or more, Settings → Users shows
  "DirectorLink's servers say these devices use the same account: make them one user?", with each
  user's role (Admin, Member, Owner) and their devices; nothing moves by itself, not even between
  users with the same permissions. An admin chooses whose access stays (the user with less access
  is offered; when neither has less, the admin chooses) and confirms; the confirmation says that
  the moved devices then have that user's access, language, theme and favorites, and what an
  admin's device becomes. When the devices or their users changed after the admin looked, nothing
  moves, and the suggestion is shown again. When one of the users is the owner's, only the owner
  confirms it, and the owner's access stays: the owner's devices never move (another admin's device
  says on which of the owner's devices to confirm it). There is always an admin. The devices that
  move get the access, language, theme and favorites of the user who stays (their old user's
  favorites are added); a user left without devices goes; a device that is no longer an admin's
  loses the invitations it made. Each merge, and each new suggestion (a few a day at most), is in
  History. A device used by several accounts (a shared tablet) stays where it is.
- **A user goes with their last device**, with their name, permissions and preferences, and so do
  the invitations and the pairing code made for them.
- **Pairing at home is for a chosen user.** An admin taps **Pair a device** on a user (or **Add a
  user**, with a name and access, then Pairing code; New user at home before 1.12.0, which added
  Send a link there too, ADR-083): the app shows a pairing code (8 digits, 15 minutes, works
  once, also shown in Composer). The device that pairs with it joins that user, with their access;
  the device never chooses. Composer's New Pairing Code still makes a new admin user.
- **Members add and remove their own devices:** Remove on their other devices, Add my other device in
  Settings → Account (into their own user, with their access), and Join from another device,
  approved on any device of the same account at the home. A member's own invitation lasts 10
  minutes, two at most wait, and it works only for the Google or Apple account the member's device
  already uses at the home (another account is an admin's to invite). A member never moves a device
  into another user, nor gives a device more than their own access.

## The app

- After connecting, and every minute, the app reads the profile and applies its language, theme and
  palette. The first time a profile is used (version 0), this browser's own choices and favorites
  become the profile's. Changes are saved to the profile a moment later, several together.
- The browser keeps its own copy too, so the app opens in the right language before it reaches the
  controller, and works as before with a driver older than 0.12.0 (no profiles).

## Appearance and language (1.10.0, ADR-067)

**Settings → Appearance and language** (`#/settings/appearance`, a row on Settings' list between
Alerts and App, saying the language, theme and colours, and the text size when it is not the
default) has three cards:

- **Language:** Auto (the browser's first language DirectorLink has, else English; it says which),
  English, עברית, Español or Italiano. Hebrew is right to left. Saved in the profile as
  `language` (`auto` or the code).
- **Theme and colours:** Auto (the device's light or dark setting), Light or Dark; and the five
  colour sets. Saved in the profile as `theme` and `palette`.
- **Text size:** Small, Default, Large or Larger (93.75%, 100%, 112.5%, 125% of the browser's
  default font size), each written at the size it gives. **This device only** (`localStorage`
  `directorlink.textSize`), never sent to the controller: a phone and a big screen need different
  sizes, and one user has both. The whole app scales with it, before the first paint
  (`theme-boot.js`).

The page says what follows the user: "Your language, theme and colours follow you to all your
devices. The text size is for this device only." (with a profile; before connecting, "Kept on this
device", until the profile takes them). Favorites and hidden rooms follow the user too, from Home
and Settings → Rooms.

What the other places show in Spanish and Italian: the Jewish calendar's months, holidays and
weekly readings are the Hebrew names transliterated as in English (Tishrei, Chanukah, Pesach,
Bereshit), and its dates use digits; alerts on the phone use the app's words in the app's
language; Composer's property and action names, the API console, the driver's Composer
documentation and the website are in English.

## Rooms

- **The order is the home's**, one for everyone: admins set it in Settings → Rooms by dragging a room
  by its handle, with the keyboard, or with the arrows, one `PUT /v1/rooms/order` per move;
  `GET /v1/rooms` answers in that order. Rooms not in the order follow, in Control4's order.
- **Hiding is personal**: anyone unticks a room in Settings → Rooms; it goes into their profile's
  `hidden_rooms` and disappears from their Home and Climate, not anyone else's. Favorites in a
  hidden room still show.
- **Hidden from members is the home's** (1.8.0): an admin marks a room in Settings → Rooms
  (`PATCH /v1/rooms/{roomId}` `{"hidden_from_members": true}`), and it and its devices disappear
  for every member, whatever rooms they were given. Admins still see it, marked
  (`hidden_from_members` in `GET /v1/rooms`). Personal hiding stays as it is, on top, for anyone.

## Favorites of removed devices (1.8.0, ADR-059)

A favorite names a device by id (`"camera:60"`). When a device is removed in Composer (a camera
replaced by another, which Control4 gives a new id), its favorite would ask for a device that is
not there: the app showed an empty tile and asked the controller for its picture (404). Now:

- **The controller decides, never on one read.** Only a project read that worked counts (at the
  start, Refresh Project, or Composer's changes, `src/core/favorites_gone.lua`). A read that failed,
  or one in which Director lists no devices at all (as while it loads a project), changes nothing.
  The first such read in which no device of the project has a favorite's id marks it gone, with
  the time and, when the read before still knew it, the device's name and room. A later read that
  has the device again (one missing for a moment while its driver is replaced) clears the mark.
- **The app shows it as removed.** `GET` and `PATCH /v1/profile` add `gone_favorites`, the
  caller's own favorites that are marked (`entry`, `since`, and `name` for someone who may see
  such a device there). Home shows each as a tile "Removed in Composer", with the name it had and
  **Remove**, instead of an empty tile; the app never asks for its device. The app never decides
  by itself that a favorite is gone: its own lists leave out what the user may not see, and may
  be a minute old.
- **After 7 days the controller drops it** from every profile that has it (each profile's
  `version` goes up, so every device of that user sees it), at a project read or at the
  scheduler's minute look, and logs it. Only once a read in this run of the driver has looked at
  the marks: a mark kept from before a restart may be of a device that came back meanwhile.
- A kind of favorite DirectorLink does not know (one a newer version keeps) is never marked or
  dropped. The marks are kept in the driver's data (`directorlink_favorites_gone`), so a restart
  does not start the 7 days again; they are not in backups (the next project read marks again).
- DirectorLink 1.7.0 does not read the marks: its app shows nothing of them, and Home leaves the
  gone favorites out as before. A favorite dropped by 1.8.0 stays dropped after going back.
