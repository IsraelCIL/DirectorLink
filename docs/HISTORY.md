# History

What the controller did and what it noticed, for admins (1.6.0, ADR-046): **Settings → Controller →
History** in the app, `GET /v1/activity` in the API. It answers questions like "why didn't the AC
turn on on Shabbat morning?" in one look: the schedule was skipped and why, or a button was deleted
in Composer the day before.

## What goes in

Each entry has when, who, what (by the names the controller had then) and how it went.

| Kind | Entries | Who |
| --- | --- | --- |
| Scenes (`scene`) | A scene run from the app or the API, with how many devices ran, were skipped or failed. Home's Turn off all. A scene run by its link from a phone's automation (1.7.0, ADR-051). | The key (its device, and the person it belongs to); for a link, the link, by its label |
| Schedules (`schedule`) | Every run, with the same counts; late runs caught up after a restart. Every skip, with its reason: Shabbat or a holiday, the Jewish calendar off (for a schedule that runs only on Shabbat), its weather conditions not met, no weather data. Paused in Composer: once a schedule for the pause, at its first run skipped (the pause itself is listed under Composer). A run that failed. | The schedule (its time and days) |
| Doors (`door`) | A door or gate opened (a relay's pulse, also by a scene, which is named), a relay held or released, the door at a doorbell opened. Since 1.7.0 also a door or gate opened without DirectorLink, when the device reports it: a KNX relay that closed after it last reported open (not one that says "closed" again), a DoorBird whose relay was triggered (its own app, a keypad), more than 15 s after DirectorLink's own last command to it, at most one a door a minute (ADR-050). Admins may get an alert for each (Settings → Controller → Alerts on this device). A refrigerator's door left open (`left_open`, 1.7.0, ADR-049): its Samsung Refrigerator driver's Door Left Open, once per opening (after its Door Open Alert, 5 minutes by default, as read at its poll interval: 6 to 8 minutes after the door opened). | The key, or Control4 (“In Control4”); DirectorLink for a refrigerator's door |
| Changes in Composer (`composer`) | Devices and rooms removed, added, renamed or moved, as a project refresh found them, by name and room; up to 20 a refresh, then how many more. Devices DirectorLink cannot control are listed too (a keypad's button). DirectorLink's own settings changed in Composer: Remote Access, Schedules, Jewish Calendar, Door Control, Relay Hold, Alarm Status, Sonos. | Composer |
| Access (`access`) | A device paired with a code, a key added, its role changed, a key removed or removing itself, a key that expired, an invitation accepted, all keys revoked in Composer. A scene's link made, replaced or removed (1.7.0), also when it went by itself: the scene now opens doors or gates, or was deleted, or the key that made it was revoked or expired; all of them removed in Composer (or not, when the controller could not save that: they still work), by Revoke All API Keys, or by Reset Remote Identity. | The key that did it, Composer, or DirectorLink |
| System (`system`) | A backup made, a backup restored (and from when), an automatic backup to the account made, or not and why (Remote Access off, the account not reached, the home not in an account, too large, backed up too often that day, no room left in the account, stopped by turning automatic backups off or changing their password, another error; a night's backup that fails is listed once, saying whether it is tried again that night, and once more if it is made later that night), the remote connection back after more than a minute away (and for how long), DirectorLink updated (from which version to which), started again, added to the project. | The key (Back up now), or DirectorLink |

Not in it: lights, AC and blinds changed one by one (the log has them), reads, a remote connection
away for a minute or less (the log has every drop), the changes in Composer made while
DirectorLink was not running (it compares the project with the one it read last, from its start),
and a scene link's run that was refused (a wrong secret, too many runs: the log has one line a
minute, with the link's id).

## Where it is kept

On the controller, in the driver's persistent data, so it survives restarts and driver updates: the
newest 450 to 500 entries, and none older than 30 days, whichever limit comes first. Schedules make
most of the entries, one a run: with N schedules that run every day the history covers about
500 ÷ N days (10 schedules: the whole 30 days; 25: about 20 days; 50: about 10 days), a little less
in weeks with Shabbat and holiday skips. A pause in Composer adds one entry a schedule, however long
it lasts.

The entries are kept in pages of 50 under `directorlink_activity_1` to `_10`; an entry changes only
the newest page, which is written at most every 3 seconds, and at once when the driver stops.
`directorlink_activity` holds the version that started last (for "updated from … to …").
DirectorLink 1.5.0 does not read these, so going back to it loses nothing it knows.

It is not in a backup (ADR-046), and a restore keeps it, adding an entry. It never goes to
DirectorLink's servers except sealed, inside the app's own requests.

## Reading it

`GET /v1/activity`, admins only (`403` for other keys). Newest first; `kind=scene,schedule` for some
kinds; `limit` (1 to 200, default 50); `before=<id>` for the entries before the last one received
(the answer's `next_before`, null when there are no more). Like the log it may be read in the clear,
with `Authorization: Bearer` (scripts, the API console); the app sends it sealed. The fields are in
`api/openapi.yaml` (`ActivityEntry`).

The app's page groups the entries by day in the home's time zone, with an icon per kind, who and what
in one line, and how it went: what ran, what was skipped and why, what failed. Chips show All, Scenes
and schedules, Doors, Changes in Composer or Access; **Load more** reads the next 50. It reads the
newest again every 30 s while open. The app's alert notifications open it (`#/settings/history`); for
a key that is not an admin's, that address opens Settings.

## Tests

`driver/tests/test_activity.lua` (what is kept and for how long, the pages and their writes, a driver
update, every event, the API with its roles and pages), `tests/app/history.test.mjs` (the link, the
page, the chips, Load more, Hebrew), and `scripts/check_contract.py` (the answers against the spec).
