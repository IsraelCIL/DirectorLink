# DirectorLink Test Plan

## Current release

`v1.7.0` — Join from another device and Paste invitation link (0zu), scene links (0zt), alerts sealed to each device: doorbells, doors, the refrigerator and choices (0zs), Samsung refrigerators (0zr), DirectorLink in numbers and the drivers pages (0zq). Apply migrations 0008, 0009 and 0010 and deploy the Worker before updating the driver.

## 0zu. Join from another device, and Paste invitation link (1.7.0)

1. On a computer: an admin key, the home linked, signed in, DirectorLink open. On an iPhone: add DirectorLink to the Home Screen, open it and sign in with the same account. The Connect screen offers **Join from another device**; tap it: "Waiting for your other device…".
2. Within a minute, or at once when the computer's window comes to the front, the computer shows the request with "Didn't ask? Decline it and sign out everywhere…". Tap **Show code**: the computer shows a field, the iPhone shows six digits.
   - A wrong code: "That isn't the code…", nothing approved.
   - The right code (with or without its space), then **Approve**: the iPhone joins by itself ("Connected · via account"), and People and devices lists its key under your person.
3. Again, with three wrong codes: the request is declined on both devices. Again, and wait 10 minutes: it ran out. Sign out everywhere while one waits: it ends.
4. A member-key device, or one still connecting or with the home offline, shows no request. An account with member keys only is told to ask an admin for an invitation.
5. Android asks to join, then pairs at home or opens an Add my other device link: its request disappears from the computer.
6. **Paste invitation link:** on the computer, Add my other device → Copy link; on the iPhone, Paste invitation link → iOS's Paste prompt → the join page → Accept. Refuse the paste: a field takes the whole link or only the part after `#/join/`. Other text on the clipboard is neither shown nor joined.
7. In DevTools on the computer, `/device-requests` is asked about once a minute, and at once on focus.

## 0zt. Scene links (1.7.0)

1. With Remote Access On and the home linked, an admin opens a lights-only scene → **Link for automations** → **Make a link**, named "Test". The secret shows once, with QR and Copy buttons; History → Access: "Made a link for the scene …".
2. iPhone Shortcuts: Get Contents of URL, the copied address, Method POST, Request Body JSON with the field `secret`. Running it runs the scene and returns `{"result":"ran"}`; History shows the run by Link "Test", and Composer's Last Automation "run from a scene link (Test)". An Arrive or NFC personal automation with Run Immediately runs it too.
3. Android (HTTP Shortcuts posting the secret as text, or a form): it runs.
4. Write the whole link to an NFC tag: tapping it opens the Run page, and nothing runs until Run. Paste the link into WhatsApp or Messages: the preview runs nothing.
5. Change one character of the secret: 404. A 7th run within a minute: 429. Ten wrong secrets from one network: the 11th gets 429 (Retry-After up to 600); a correct run over mobile data still runs.
6. Replace the link: the old one gets 404, the new one runs. Remove it: 404.
7. Add a Doors & gates action to the linked scene: a warning, and Save asks first; after saving the link is gone and History says why. Make a link on a gate scene: refused.
8. A second admin key B links another scene; revoke B in People and devices (the question says its link stops): B's link gets 404, the first still runs. Forget access key on the first device says the same before you cancel.
9. Composer **Revoke All API Keys**: every link gets 404, and History (after pairing again) says all were removed. **Remove All Scene Links** does the same.
10. Restore: make L1, back up, Replace (L2), restore that backup with another device paired: L1 gets 404, L2 runs.
11. A scene whose only step is room-wide fans in a room without fans: "Nothing ran: the scene has no devices left to switch."
12. Turn Remote Access Off: runs get 503, and Make a link explains why it can't.
13. Workers Observability: `link_run` events, and searching for a secret finds nothing.
14. Downgrade to 1.6.0: runs get 404 at once, scenes are unchanged; back on 1.7.0 the links run again.

## 0zs. Alerts sealed to each device: doorbells, doors, the refrigerator, choices (1.7.0)

1. Apply migration 0008 and deploy the Worker before updating the driver.
2. On an admin device that had alerts on with 1.6.0, open the app once: the card lists Offline, Doorbell, Doors (off) and Schedules; the driver log says "alert choices changed".
3. On a member's iPhone (the Home Screen app, signed in and linked), switch alerts on: Doorbell, and Refrigerator in a home with one.
4. Close the app on both and press the DoorBird: both get "<doorbell> rang at HH:MM" within seconds; tapping opens Home with the banner. A second press within 30 s: no new notification. With the app open in front, the banner shows and the notification comes without sound.
5. As an admin, turn on "A door or gate is opened"; open a gate from another device: "…opened by <person> (<device>) at HH:MM", tapping opens History. Open it from the Control4 app or a keypad: "…opened in Control4", and History says "In Control4" (this is the check that the DoorBird's and the KNX relays' events reach DirectorLink). Twice within a minute: one entry, one alert. A gate held open whose relay reports "closed" again: no Control4 entry.
6. Leave the refrigerator door open past its Door Open Alert: members and admins who chose it get "…open for at least N min" (N about 5–7 at the defaults). An admin who chose doors only gets nothing for it.
7. Make a schedule fail: admins get "the schedule for <scene> had a problem".
8. Turn one kind off on one device: only that device stops getting it. Switch the app to Hebrew and ring again: the notification is in Hebrew.
9. Cut the controller's internet for 10 minutes: the offline alert reaches only admin devices with Offline on.
10. On a new device, with Remote Access off, switch alerts on: "Your home couldn't be reached…".
11. Workers Observability: `notify_sent` shows counts only, never kinds or names.

## 0zr. Refrigerators (1.7.0)

1. Install the DirectorLink · Samsung Refrigerator driver, authorize it and select the refrigerator; update DirectorLink. Its Inventory property ends with ", 1 refrigerators", and with Log Level Debug and Refresh Project the log lists the refrigerator driver's variables.
2. The kitchen's Refrigerators card shows the temperatures as the refrigerator driver's properties do; its feature tiles are not listed as other devices.
3. Switch Sabbath Mode: "Turning on…", then on within about 10 s; Composer's property and the Control4 tile agree. Switch it back. When Samsung's cloud is slow, the wait lasts up to 65 s, and a later confirmation still flips the switch.
4. A viewer's key: the card shows the state, without switches.
5. Leave the door open at least 8 minutes: the card and Home show "Door open" within one poll, and History → Doors lists it once. Close and reopen: once more.
6. Scene: Add an action → Refrigerators → Sabbath Mode → On; Try it now; run it from a schedule.
7. Remove the refrigerator step from a scene and restart DirectorLink: it stays removed. On 1.6.0, save any scene, then return to 1.7.0: the step is back in the scenes that had it.
8. Download a backup: the restore preview keeps the refrigerator step and favorite.

## 0zq. DirectorLink in numbers, and the drivers pages (1.7.0)

1. After migration 0010 and the Worker, `curl https://api.directorlink.io/v1/stats` answers 503 `STATS_NOT_COUNTED` until the next :47, then `{"homes","people","downloads","updated"}` and nothing else, matching D1 (claimed homes; accounts with a sign-in) and GitHub's total for DirectorLink.c4z.
2. With `-H "Origin: https://directorlink.io"`: `Access-Control-Allow-Origin` for it and `Cache-Control: public, max-age=300`; another origin gets no ACAO; POST gets 405.
3. Workers Observability shows `stats_counted` every hour; `stats_not_counted` only when GitHub or D1 failed, and the totals then stay.
4. directorlink.io with fewer than 25 homes: no numbers section, no console or CSP errors.
5. directorlink.io/drivers and /drivers/samsung-refrigerator load; Download gives the latest `DirectorLink-Samsung-Refrigerator.c4z`; Release notes, Report a problem and Source lead to the driver's GitHub pages.

## 0zp. Automatic backups to the account, and the Sonos rooms in backups (1.6.0)

1. `GET /v1/system` shows `automatic_backup: true`. A signed-in admin sees "Automatic backups to your account" in Settings → Controller → Backup; signed out, the sign-in line.
2. Set the backup password: the lost-password warning shows. In the console, `GET /v1/backup/automatic` shows `key` with only `key_id` and `set_at` (no public_key, salt or iterations; the app's sealed requests get the whole key), never the password. A `PUT` in the clear gets 403 `SEALED_REQUEST_REQUIRED`.
3. With Remote Access on and the home linked, the first backup runs at once: "Backed up to your account", and the list shows today's (about 100–200 KB).
   - The log's `backup uploaded`: note `seal_ms` and `total_ms`.
   - The app controls lights normally while it runs.
   - History shows "Backed up to your account" with who pressed it.
4. The next morning there is a backup from between 03:00 and 05:00, with `why: daily` in the log and "Backed up to your account · DirectorLink" in History.
5. Back up now twice: the list keeps one backup for today. A fifth Back up now the same day says the account's daily limit was reached; the nightly backup still arrives.
6. Restore:
   - a wrong password says "Wrong password" and sends nothing;
   - the right one shows the preview, including Sonos players with a chosen room;
   - then Cancel, or Replace everything on a test controller.
7. Change backup password, then Back up now: the older backup is marked "earlier password" and opens only with the old password.
8. Turn off: the list stays. "Delete these backups" empties it.
9. With Remote Access off, the card says so, and History has one "Couldn't back up to your account · Remote Access is off in Composer" for the night.
10. A second admin, signed in to another account that joined the home, sees the same list. A member doesn't.
11. Sonos: choose a room for a player, download a backup file and restore it: the choice comes back. A 1.5.0 backup file restores and keeps the current choices.

## 0zo. Alerts (1.6.0)

1. On a computer (Chrome, Edge or Firefox), signed in as an admin on a linked device: Settings → Controller → Alerts on this device → allow. It says "Alerts are on for this device". In Hebrew, the card is in Hebrew.
2. Turn Remote Access Off in Composer for 2 minutes, then On: no notification.
3. Turn it Off for 11 minutes: one notification, "Your home – DirectorLink has not reached it since HH:MM…", and no second one for the same absence. Tapping it opens History.
4. Unplug the controller's network for 11 minutes (a connection that dies silently): one notification. Plug it back in; it reconnects.
5. On an iPhone in Safari, the card shows the Home Screen hint. From the Home Screen app (iOS 16.4+) the switch works and step 3 notifies.
6. A member key's device sees no card. An admin made a member stops getting alerts.
7. Switch off, sign out, or Sign out everywhere: no more alerts on that device.
8. Schedule failed: when a device refuses a scheduled command (DirectorLink log "schedule ran" with failed > 0), the alert says "Your home – a schedule had a problem at HH:MM…", and History shows which one.
9. Workers Observability shows `alert_sent` (kind, devices, delivered, gone) and never a push address.

## 0zn. History (1.6.0)

1. Update the driver: History starts with "DirectorLink updated to 1.6.0", then "DirectorLink started" after a controller restart.
2. Run a scene from the app: your name and device, and "Ran on N devices". A scene with a door shows a door entry "by the scene …".
3. Open the gate from a doors key: History → Doors shows who.
4. Make a time schedule for the next minute with "only if hotter than 40°": "Didn't run …: the weather didn't match its conditions".
5. In Composer set Schedules to Paused at a schedule's minute: "Schedules set to Paused" and "Not run: schedules are paused in Composer". Set it back.
6. In Composer delete a test button (or rename a device): within seconds, History → Changes in Composer lists it by name and room.
7. Change a key's role and revoke a key in People and devices: both under Access.
8. Make a backup file: "Made a backup", and the file has no history in it.
9. Turn the router off for 2 minutes: once remote access is back, an entry says it was down for about 2 min.
10. Open `#/settings/history` with a member key: Settings opens instead. Check the page in Hebrew, at phone width, and dark.

## 0zm. The remote connection checked every 10 seconds (1.6.0)

1. With Remote Access On, Remote Status shows "Connected since …". In Workers Observability, `driver_hello` has `interval_s: 10`.
2. Use the app through the account over a busy evening.
   - **Relay log:** a `driver_stale` (ping_s ≥ 25) is followed within seconds by `driver_connected` with `replaced: 1`, with no failed requests between, apart from ones already sent.
   - **Driver's relay log:** `relay connection closed` shows `heard_s` of about 10 or less.
3. Block the controller's internet for about 40 s with the app open through the account.
   - Within about 25 s the account's home list shows the home offline.
   - A request waits about 8 s, then says offline.
   - After unblocking, it reconnects within seconds and the next request works.
4. GitHub checks: a pull request shows seven checks (three driver test parts, the time zones, the checks, app and cloud, and `validate`) and takes about 4 minutes. The three "Driver tests (part N of 3)" counts add up to the full suite's.

## 0zl. Changing a scene action (1.6.0)

1. As an admin, open a scene with a few actions. Each row has up, down, Edit (pencil) and remove; on a phone the four sit 2×2.
2. Tap Edit, or the row's text, on a lights action of chosen lights: "Edit action" opens with its room, the lights ticked and its level.
3. Untick one light, change the level, then Save action. The row changes in place and keeps the focus. Save the scene, run it, and check only those lights change.
4. Edit another action, change something, then Cancel or Back: nothing changes.
5. After Copy the house in a home with more than 100 lights alike, edit either of the two parts: both open as one ("…2 actions in a row"); Save replaces both.
6. Remove a device in Composer that a scene names: editing that action lists it as "Removed device", ticked. Untick it and save.
7. Edit an action and Save action without changing anything: the scene shows no change. In a door action, tick every door: it is saved by name, not as "all doors".
8. Repeat 2–4 in Hebrew, at 320 and 390 px, light and dark, and with a keyboard (Tab to Edit, Enter, Esc/Back).

## 0zk. DirectorLink's port taken by another driver (1.5.0)

1. After the update, Composer's **API Status** reads *Online - port 41999* within 15 seconds.
2. If it reads *Port 41999 taken by another driver - retrying every minute*:
   - `GET /v1/logs?category=api` (through the account) has one error, *the API port is taken by another driver*;
   - the app still works through the account;
   - restart the controller. **API Status** then reads *Online - port 41999*, and the log's *API server ONLINE* line has no `taken_before`, or the number of tries if the port came back by itself.
3. In a controller snapshot, `system_info/dman-diag.txt` → *Server Connections* lists port 41999 under DirectorLink's item id.

## 0zj. The remote connection stays up (1.5.0)

1. Deploy the cloud. Update DirectorLink in Composer, no reboot. Remote Status shows *Connected since HH:MM - home xxxxxxxx*.
2. After a day, read `GET /v1/logs?category=relay`:
   - far fewer *relay connection closed* lines than before (before: about one every 10–40 minutes);
   - for each one, note `reason`, `up_s`, `heard_s`, `ping_s` and `retry_s` (expect 1);
   - the next *connected to the relay* shows `attempts: 1` and `down_s` around 1–3;
   - if `polled_s` appears, Director still polls: report it;
   - `connection lost` with `heard_s` under 25 means the connection was cut between the controller and the relay;
   - a *no answer* warning means the relay stopped answering pings.
3. After any drop, Remote Status shows *- last drop HH:MM (reason)*.
4. Away from home on mobile data, keep the app open for an hour: it never shows the home offline.
5. In Workers Observability:
   - count `driver_disconnected` per day for the home, with `why`, `up_s` and `ping_s`;
   - `driver_connected` `down_ms` is about 1000–3000;
   - after a deploy, the first request for each home succeeds rather than answering 503.

## 0zi. Sonos (1.5.0)

1. **Off by default.** After the update, **Sonos** is `Off`. `GET /v1/music` answers `"enabled": false`, and the app shows no Music anywhere.
2. **On.**
   - Set **Sonos** to `On`. Within a few seconds **Sonos Players** lists the three speakers with their addresses.
   - If it says *None found*, set **Sonos Address** to one speaker's address and note that the search found nothing.
3. **Rooms.**
   - Sonos rooms named like a Control4 room, or like a room's Hebrew name, show on that room's screen.
   - The others are under **No room**.
   - Settings → Rooms → **Sonos rooms** (admins) lists them, the unplaced first. Picking a room moves the card there; **Same name** puts it back.
   - Members and viewers don't see Sonos rooms in Settings.
4. **Playing.**
   - On a room's screen, the Music card shows what plays and its art.
   - Pause and play act on the whole group.
   - Next and previous, on a queue or playlist (not the radio): note whether the speaker takes them.
   - The volume and mute change only that room. Note the volume before, and set it back.
   - Favorites: a playable one starts; Sonos Radio's shortcuts are greyed out.
5. **Home** lists each group that plays, with a pause button.
6. **Spotify Connect:** play from the Spotify app. The card says *Spotify*, with the track if the speaker reports it.
7. **Scenes.** Add a Music action (Pause, in one room) and run the scene: that room's group pauses; a group already paused is left alone. In a room with no Sonos, the run says *the music was skipped: there's no Sonos speaker in that room*; with Sonos `Off`, *… Sonos is off in Composer*.
8. **Viewer device:** what plays is shown, but no controls.
9. **Phone.** 320 and 390 px, English and Hebrew, light and dark: no sideways scroll; the playback buttons stay left to right in Hebrew.
10. Set **Sonos** to `Off`: Music goes away within a minute, and nothing more is sent to the speakers.

## 0zh. Settings' pages (1.5.0)

1. Settings shows Appearance and Language, then a row per page with a short line each: Controller, Rooms, Shabbat and holidays (admins), People and devices (admins), Account, App, About.
2. Each row opens its page at `#/settings/<page>`. **Back** returns to the list, with that row focused. The browser's Back does the same.
3. A newer DirectorLink: the Controller row has a badge. The Home notice opens Settings → Controller at the steps.
4. The connection chip opens Settings → Controller. Schedules → **Change** (Shabbat) opens Shabbat and holidays. Signing in comes back to Account.
5. Rooms: everyone ticks rooms on and off; admins also move them and rename them.
6. Phone: 320 and 390 px, English and Hebrew, light and dark: no sideways scroll.

## 0zg. Check now, and the app's version (1.5.0)

1. On an admin device, Settings → Controller shows **App version 1.5.0** and the DirectorLink version, then **Updates** with a **Check now** button under the facts. A member or viewer device shows App version, but no Updates line and no button.
2. Tap **Check now**: the Updates line says *Checking…*, then *Up to date* or *DirectorLink X is available*.
3. **Check now** again within a minute: the button is dimmed, *You can check again in a minute* shows under it, and nothing is sent. In DevTools → Network, the first press made one request to `api.github.com`, and the second made none. A screen reader reads the outcome of each check.
4. With the network off, **Check now** says *Could not check just now* on the Updates line until GitHub answers again.
5. After a minute, **Check now** asks again.
6. Hebrew: *בדיקה עכשיו*, then *בודק…*, right to left.

## 0ze. Backup and restore (1.4.0)

1. **Who sees it.** After the update, `GET /v1/system` has `"backup": true` in `features`, and Settings → Controller shows **Backup** on an admin device, but not on a member or viewer device. With a 1.3.0 driver (no `backup` in `features`) there's no Backup. In the API console, `GET /v1/backup` answers `403 SEALED_REQUEST_REQUIRED`.
2. **Download backup.**
   - A password under 10 characters is refused, and so are two different passwords. A common one (*Password1!*) shows *weak*; a long passphrase shows *strong*.
   - The file is saved as *DirectorLink backup <home> <date>.dlbackup*. Opened in a text editor, no scene names, hashes or keys are readable.
   - `GET /v1/logs?category=backup` shows *backup made*, with `controller_known` (this checks the controller's MAC address is read) and `remote_identity`.
3. **Restore on the same controller.**
   - A wrong password gives *Wrong password, or the file was changed*.
   - The right one shows a preview with the home's counts, no "another home" warning, *Keys: kept as they are now* and *Remote access: this home stays linked*.
   - **Cancel** changes nothing.
4. **Replace everything** on the same controller.
   - *Restored*. Every phone keeps working without pairing.
   - Remote Status stays *Connected … home <same id>*, and the log shows *restored from a backup*.
   - Composer properties are unchanged.
5. **A revoked key stays revoked** (test controller): pair devices A and B, make a backup, revoke B, then restore from A. The preview says the keys are kept; afterwards B still gets 401.
6. **A reinstall** (test controller, or a quiet time — this removes the driver).
   - Remove DirectorLink in Composer and add it again. Set the properties the preview listed, and pair one device with a new code.
   - Restore at once. The keys are listed: choose **This device is <old key>**.
   - Scenes, schedules, favorites and room names come back.
   - People and devices shows no duplicate admin, and this device has the old favorites.
   - Family phones that weren't opened meanwhile work without pairing.
   - Within seconds Remote Status reads *Connected … home <old id>*, and the account shows the home online with its people.
7. **Another home's backup.** Open it: the warning names that home, and so does the confirmation. With **Move remote access to this controller** unticked, Remote Status doesn't change.
8. **Phone.** 320 and 390 px, English and Hebrew, light and dark: no sideways scroll. A file over 4 MB is refused before it's read.

## 0za. Pairing without sending the code, and the console's key (1.3.0)

1. Update the driver in Composer, run **New Pairing Code**, and pair the app from a computer. It connects, and the Lua log shows *paired a new client … cpace=true*. In the browser's network tab, neither of the two `POST /v1/auth/pair` requests contains the code. Note how long each takes on the controller (estimated at under half a second each).
2. A wrong code 4 times: the tries left count down 4, 3, 2, 1, and the fifth gives the one-minute lock. Another device can still pair.
3. Pair the API console. Connection shows about 24 hours left and the warning line. Keys, and the app's People and devices, show the console key's expiry.
4. The console key made before the update shows about 24 hours from the first 1.3.0 start, and keeps that value after a driver restart.
5. After it expires (or after pairing a script with `expires_in: 60`), requests get `401 KEY_EXPIRED`, the key is gone from the list within a minute, and the console says *Your console key expired*, even with the app open meanwhile.
6. A script pairs with `curl … -d '{"pairing_code":"…","name":"x"}'`: the key comes back in the clear, with `expires_at: null`.
7. **Older controller:** with a 1.2.x driver (before updating), the app and the console show the "older DirectorLink" warning.
   - **Cancel** makes it disappear at once, and nothing is sent.
   - Warned again, type another address, or pick another controller in Find: the warning goes.
   - **Pair anyway** pairs only the address the warning named.

## 0zb. Find my controller (1.3.0)

1. Use Chrome or Edge on a Windows computer on the home network, in a browser that never paired (or with site data cleared), at app.directorlink.io. The pairing screen shows **Find my controller** under the address.
2. Tap it. The browser asks about devices on the local network, and the screen says to allow it. Allow.
3. Within about 10 s the screen says *Found DirectorLink 1.3.0 at <address>*. The address is filled in, and the code field has the focus. Pair with a code from Composer.
4. Pair again, then **Find my controller**: the address used before is asked first and found at once. **Cancel** during a search stops it.
5. In DevTools → Network during a search, there is only `GET http://<ip>:41999/v1/health`, with no Authorization header.
6. Android Chrome: the same as steps 2–3. iPhone Safari or Chrome: no button.
7. Refuse the browser's prompt, then search: the screen says to allow local network access in the site's settings.
8. On a network without the controller (e.g. a phone hotspot): *No controller found on this network…* within about 30 s.
9. Hebrew: the button reads *חיפוש הבקר שלי*, right to left.

## 0zc. Sign in with Apple, joins with another email, Apple's notices (1.3.0)

After the cloud is deployed (migration 0005, the `APPLE_PRIVATE_KEY` secret, then the Worker), `curl https://api.directorlink.io/auth/providers` answers `["google","apple"]`.

1. **Sign-in buttons.** In a private window, Settings → Account shows **Sign in**. Tap it: Google and Apple appear, one under the other on a phone, with no sideways scroll at 320 and 390 px. Apple's button is black, or white in the dark theme. Check Hebrew too.
2. **Sign in with Apple.** Sign in with your Apple ID: you come back signed in, and Settings says it signs in with Apple. On a Google account, **Continue with Apple** links it; remove it again.
3. **Approve.**
   - Invite a Gmail address. On an iPhone, open the link, sign in with Apple choosing **Hide My Email**, and tap Accept. The iPhone shows *Waiting for the home's owner* and a code.
   - On the owner's computer, open People and devices → **Asking to join**. Check the name, *email hidden by Apple*, Apple, the account's age, and the invitation's email, role and maker. Check the code matches, then **Approve**.
   - Within about 5 s the iPhone opens Home through the account, and People shows the new account.
4. **Refuse.** Repeat with another account and **Refuse**: the invitee is told the owner did not let this account join.
5. **Notices.**
   - In Apple's developer portal (Identifiers → io.directorlink.app → Sign in with Apple → Configure), set the server-to-server endpoint to `https://api.directorlink.io/auth/apple/notifications`.
   - On an iPhone: Settings → your name → Sign in with Apple → DirectorLink → **Stop Using**. The Workers log shows `apple_notification` consent-revoked, and that account is signed out. Homes and members stay.
   - Signing in with Apple again gives back the same account.
   - A refused notice logs its `aud`. If it's `io.directorlink.signin`, tell the developers.

## 0zd. Turn off all from Home (1.3.0)

With Log Level Debug:
1. On Home with no chip tapped, there is no new button. Tap *N lights on*: **Turn off all N** appears next to Show all. A viewer sees no button in any filtered list.
2. Tap once: *Tap again to turn off N*, with Cancel instead of Show all.
   - Wait 5 s: it goes back.
   - Tap, then Cancel: it goes back.
   - The API log shows no `POST /v1/off`.
3. Tap twice: *Turning off…*, then *Done*.
   - The lights that were on go off.
   - The log shows exactly one `POST /v1/off -> 202`, and *turned off* with ran = N.
   - The chip reads *All lights off*, and the button is gone.
4. Hide a room (Settings → Rooms) and repeat: its lights stay on.
5. Through the account on mobile data: one request, and about as quick.
6. **Climate:** AC and floor heating go Off (`SET_MODE_HVAC Off` in the log). Thermostats already Off are not counted.
7. **Blinds:** *Close all N*, then *Tap again to close N*. The blinds show closing, the button doesn't come back while they move, and once closed the chip reads *Blinds closed*.
8. With one light's actuator unplugged, *1 light didn't turn off* names it and its room for 15 s. The rest are off, and the button stays for the one left.
9. 320, 390 and 1280 px, English and Hebrew, light and dark: no sideways scroll, before and at the second tap.

## 0y. Shabbat and holidays (1.2.0)

With **Log Level** Debug set before updating, on a Friday or a holiday eve if possible:

1. After the update, **Jewish Calendar** = `Off` and **Calendar Status** = `Off` show after Last Automation. Nothing new appears in the app (Home, Schedules, the schedule editor, Settings), `GET /v1/calendar` answers `200` with `"enabled": false` and nulls, and `GET /v1/system` has `"features": {"jewish_calendar": false, …}`. `PATCH /v1/calendar/settings` `{"havdalah_minutes": 50}` answers `409 JEWISH_CALENDAR_OFF` for an admin and `403` for a viewer or member; `POST` of a Shabbat schedule answers `409 JEWISH_CALENDAR_OFF`. Existing schedules show `"during_shabbat": "run"` and `"calendar_status": null`, and run as before.
2. Sunrise and sunset schedules' `next_run` and the weather card's times may have moved by up to a minute (NOAA): compare them with hebcal.com's zmanim for the city; equal, or one minute off on a few days.
3. Set **Jewish Calendar** to `On` (no restart). Calendar Status reads at once *Israel (from the location) · candles 20 min before sunset, havdalah 42 min after · next Fri … to Sat …*, and its times equal hebcal.com's Shabbat times for the city (20/42) to the minute. `GET /v1/logs?category=calendar&level=debug` shows *calendar computed* in well under 50 ms. Within a minute Home shows the Hebrew date line (the next day's from sunset: leave Home open over sunset, and the date changes within about 10 seconds of it), and Schedules the times card; an admin sees the Settings card, a member sees the times but not Change or the card.
4. In Hebrew: the date in letters (for example י״ח בתשרי תשפ״ז) and the weekly readings in full spelling (for example תזריע־מצורע).
5. Create *30 min before candle lighting* with one light and a gate: on Friday it runs, the gate is skipped (scheduled scenes never open doors), and Last Automation shows *schedule 30 min before candle lighting*. Create *at havdalah*, *every day 07:30, not on Shabbat and holidays* (on Saturday it reads *Didn't run …: Shabbat or a holiday*, `skipped_by: shabbat`) and *08:00 only on Shabbat and holidays*.
6. Run Update Driver on Friday night: nothing runs twice, havdalah runs on Saturday, and anything missed while it reloaded (within six hours) runs once, marked *late after a restart*.
7. As an admin, set 30/50 in Settings → Shabbat and holidays and Save: *Saved*, and the times move in the app and in Calendar Status. Save a stale change from a second device: the conflict message. A member gets `403` on the PATCH.
8. Set **Jewish Calendar** to `Off` with those schedules in place: they say *Not running: the Jewish calendar is off in Composer* (the "not on Shabbat" one says it runs on Shabbat too), the Shabbat schedule's editor offers only its switch and Delete, the Home line and the Settings card go within a minute, and Schedule Status says *· N Shabbat schedules not running (Jewish Calendar is Off)*. Set it On again: nothing is caught up, and an Update Driver in the next hours catches up nothing that was due while it was Off (nor while **Schedules** was `Paused`).
9. **Print Schedules and Scenes**: line 2 is *Jewish calendar: …*, and the Shabbat texts read as expected.
10. The screens at 320, 360, 414 and 1280 px, in English and Hebrew, light and dark: no horizontal scroll.
11. Later, recorded in docs/VALIDATION.md: Fridays 23 and 30 Oct 2026 and 26 Mar 2027 (clock changes), Adar I and II in Feb–Mar 2027, and Shavuot 10–12 Jun 2027 (or Abroad for 3–4 Oct 2026).

## 0x. Alarm status (1.2.0)

1. After the update, **Alarm Status** = `Off` shows right after Relay Hold (note whether Composer shows its tooltip). Inventory counts no alarm partitions (it reads as in 0w step 1, with *0 fans*), `GET /v1/system` has `"alarm_status": false`, and the app has no Alarm section on Home and no Alarm line in Settings → Controller.
2. In the console with an admin key, `GET /v1/alarm` answers `200 {"enabled": false, "partitions": []}`; with a viewer key, `403 FORBIDDEN`.
3. Set it to `On` (no restart): `GET /v1/logs?category=alarm` shows *alarm status on in Composer*, with `partitions_watched` 0 on the test system; Inventory ends with *, 0 alarm partitions* and `features.alarm_status` is true; the console's `GET /v1/alarm` answers `403 SEALED_REQUEST_REQUIRED`; the app, at home and on mobile data, shows no errors and no Alarm section (there are no partitions).
4. Set it back to `Off`: the log shows *alarm status off in Composer*, the Inventory suffix goes, and step 2 answers again.
5. On a home with an alarm (the contributor's), with it On: Home lists each active partition within about 10 s of a change (arm away or home at the keypad, open a zone, the exit and entry delay, an alarm); there is nothing to press, a viewer device shows nothing, and `GET /v1/logs` at Debug holds no partition state. With nothing else changing, arm, disarm and start a delay: in developer tools → Network the `POST /v1/sealed` answers of each 10-second round keep their sizes (the alarm's is padded). Keep any *unsupported device N: …* line from `category=adapters`.
6. The scene editor offers no alarm step.

## 0w. Fans (1.2.0)

On the test system, which has no fans (a regression check):

1. After the update, Inventory reads *… 22 thermostats, 0 fans, 15 blinds …*, with 111 lights unchanged; `GET /v1/system` shows `"fans": 0` and `GET /v1/fans` answers `{"items": []}`.
2. The app looks as before: no Fans section and no fan badge; `GET /v1/logs?category=api&level=debug` shows no `GET /v1/fans` every 10 s, only at connect (developer tools → Network shows only `POST /v1/sealed`: the app seals every request). Room All off and existing scenes behave as before.

On a Director with a fan (ask @bkwagner), with Log Level Debug set before updating:

3. Save `GET /v1/logs?level=debug&category=fan`: *proxy variables* (IS_ON, CURRENT_SPEED, PRESET_SPEED with values), *proxy setup* (the GET_SETUP answer) and *initialized fan*.
4. `GET /v1/fans` shows each fan with `on`, `speed` as on its keypad, and `speeds [1,2,3,4]`.
5. In the app: switch off and on, then each speed Low to High, each confirmed without *waiting for the device to confirm*; `GET /v1/logs?category=fan_command` shows OFF, ON and SET_SPEED with SPEED 1–4. Note which speed ON returns to (preset or last).
6. Change the fan from a keypad: the app follows within about 10 s, and *fan variable changed* debug lines show the raw values.
7. Run a scene *All fans: Medium* and a room step *Off*, then a schedule that runs it. Favorite the fan and toggle it from its Home tile. With a viewer key there are no controls and `PATCH` answers `403`. At 320 px, in English and Hebrew, Home does not scroll sideways: a room with many kinds of devices puts its badges on two lines.
8. Save `GET /v1/fans` and a scene run result, validate them against `api/openapi.yaml`, and record in docs/VALIDATION.md.

## 0v. Forget key while the app is busy, and shades after a restart (1.2.0)

With **Log Level** Debug, on a second browser paired for this (pair it again with a new code before each step), and the API console open with another admin key:

1. **During a refresh:** leave the app on Settings → Controller for a minute or more (it refreshes every 10 seconds; every sixth refresh also reads the rooms), then press **Forget access key**. The app ends on the pairing screen with *The access key was removed from this device.* and still shows it a minute later: not *Can't reach your controller*, not the home. **API Keys** in Composer goes down by one. In `GET /v1/logs?category=api&level=debug`, that key's `key_id` has nothing after its `DELETE /v1/api-keys/current -> 204`. Do it once more with **Jewish Calendar** `On`: the same, also a few minutes later, and after pairing again the Home line is this home's.
2. **Right after a light:** switch a light, then at once Settings → **Pair again**. The pairing screen stays, and the log has nothing with that key's id after its DELETE.
3. **While connecting:** reload the page and press **Forget access key** in Settings before the home has loaded. The end is the same as step 1. Pair again, open Scenes: it never says the key no longer works.
4. **Controller out of reach:** on a laptop at home without remote access, unplug the controller's network cable (the laptop stays on Wi-Fi: requests go out and get no answer) and wait until Settings says *Can't reach home*. Press **Forget access key**, and **Retry** within the next seconds. About 4 seconds later (the revoke waits that long for an answer) the pairing screen says *The access key was removed from this device.*, and still does a minute later. Plug the cable back in: the key stays in Composer (it could not be revoked): remove it there. (With Wi-Fi off instead, requests fail at once: *Can't reach home* shows after about 13 seconds, Forget key ends at once, and there is no time for Retry.)
5. **Shades after a restart:** reboot the controller. In `GET /v1/blinds` every shade at rest has `"moving": false`, also one whose *proxy variables* in `GET /v1/logs?category=blind&level=debug` show `1002=Stopped:0` with Level and Target Level a little apart. Once nothing moves, the app reads the blinds every 10 seconds, not every 2.
6. Shades move as before (0s step 1, 0r step 8): a move to 50% shows *Opening… to 50%* until the shade stops, and Stop halfway shows it stopped at once, then where it stopped.

## 0u. Rooms in order by dragging them (1.2.0)

1. On an Android phone and an iPhone, as an admin, in Settings → Rooms, hold a room's handle (⠿) for a moment: the room lifts. Drag it several places down and let go. The other rooms make room while you drag; the new order stays after reloading, and shows on another device within a minute.
2. Swipe over the handles and over the room names without holding: the page scrolls and nothing moves.
3. Hold the first room's handle and drag it to just above the tab bar: the list scrolls by itself. Let go at the end: the room is last.
4. Drag a room and put it back where it was: nothing is saved. Start a drag and switch apps: the room goes back.
5. Repeat step 1 in Hebrew: the handle is on the left and dragging works the same.
6. On a computer: drag with the mouse; press Escape mid-drag and the room goes back. Tab to a handle, press Space, use the arrow keys, press Space: the room moves. With VoiceOver or NVDA the positions are read out.
7. The up and down arrows still move a room one place at a time.
8. As a member or viewer: no handles or arrows, and unticking a room still hides it only for you.
9. Away from home (through the relay): a drag is saved once and shows at home.
10. With DirectorLink 1.0.0 on the controller: a drag says to update DirectorLink, and the room goes back.

`v1.1.1` — door relays are pulse-only unless Relay Hold allows holding them (0t, ADR-036); four fixes around shades (0s): Forget key while a shade moves, the moment after Stop, a shade moving again after the app was away, and a shade left marked as not stopped after a restart. Update DirectorLink in Composer (no reboot).

## 0t. Door relays are pulse-only (1.1.1)

With **Door Control** Enabled and an admin key in the console or curl. Have someone at the door for steps 2 and 4.

1. After the update, the properties show **Relay Hold** = `Not allowed` right after Door Control. Hovering shows *Allowed lets API clients hold a relay closed…*; note whether Composer shows this tooltip.
2. `PATCH /v1/relays/{id}` `{"state": "closed"}` on a door answers `409 HOLD_NOT_ALLOWED` (*Holding a relay closed is off: use pulse…*). The door does not open, its `state` does not change, and `GET /v1/logs?category=api` shows `PATCH /v1/relays/{id} -> 409` with the key id.
3. These open the door as before (202; the door opens and the relay releases half a second later): the app's Open, at home and on mobile data; a scene with the gate; `POST /v1/relays/{id}/pulse`. `PATCH {"state": "open"}` answers 202 too, but only releases the relay: the door does not open, and `state` stays or turns `open`.
4. Set Relay Hold to `Allowed` (no restart). `GET /v1/logs?category=relay_command` shows *relay hold allowed in Composer*. `PATCH {"state": "closed"}` answers 202, the door stays open and `state` turns `closed`. `PATCH {"state": "open"}` releases it at once (`open`).
5. Set it back to `Not allowed`. The log shows *relay hold not allowed in Composer*, and step 2 is refused again at once.

## 0s. Shades: four fixes (1.1.1)

With **Log Level** Debug, on a shade with a Percent Set Address, with the app at home:

1. **Stop:** open the shade from closed and press **Stop** halfway, five or six times: the app checks on the shade every 2 seconds, and only a check in the moment right after the Stop showed the problem. Each time the line under its name shows the shade stopped at once, never *Opening…* again, and then where it stopped (the actuator's own position about a second later). Each `STOP` in `GET /v1/logs?category=blind_command` is followed a fraction of a second later by the *movement changed* lines of the stop in `GET /v1/logs?category=blind&level=debug` (Target Level, Opening 0, Stopped 1).
2. **A move after a while away:** open the shade from the app, then put the app in the background (another tab, or the phone locked) for three minutes. Close the shade from a keypad or the Control4 app and bring the app back while it moves: within a few seconds it shows *Closing…*, and `GET /v1/logs?category=api&level=debug` shows `GET /v1/blinds` every 2 seconds until the shade stops, then every 10. The same on a computer without remote access that goes offline (Wi-Fi off) for three minutes while the shade moves: close the shade from a keypad, and turn Wi-Fi back on while it moves.
3. **Forget key:** on a second browser paired for this, set a shade moving and, while it moves, Settings → Controller → **Forget access key**: the app ends on *The access key was removed from this device.*, never *This device’s access key no longer works*, and **API Keys** in Composer goes down by one. Pair it again and do the same with **Pair again**, within two minutes of a command to a shade: the pairing screen does not say the key no longer works.
4. **After a restart:** reboot the controller. In `GET /v1/blinds` every shade at rest has `"moving": false`, also one whose level is unknown (`-255` or `-155` in *proxy variables*, *Position unknown* in the app), and once nothing moves the app reads the blinds every 10 seconds, not every 2. A shade that says `"moving": true` while it stands still: save `GET /v1/logs?category=blind&level=debug` (its *proxy variables* with Stopped, Level and Target Level).
5. Section 0r steps 8 and 10 pass unchanged: a move to 50% shows *Opening… to 50%* until the shade stops, and a move from a keypad shows within about 10 seconds.

`v1.1.0` — older Control4 lights, floor heating set through its heat setpoint, and Control4 thermostats with heat and cool setpoints (thanks to bkwagner, #14, #19, #16, ADR-033); the relay's certificate is checked (ADR-034); shades, Composer changes without a restart and the room order (0r); admins see new versions in the app (0q, ADR-035). Update DirectorLink in Composer (no reboot).

## 0r. Room order, Composer changes and shades (1.1.0)

Room order (broken since 1.0.0):

1. In the app at home, Settings → Rooms: move a room up, then down. The order changes, stays after reloading the app, and no *Remote requests are GET, POST, PATCH or DELETE* message appears. The same away from home (a phone on mobile data, with remote access).

Composer changes, with **Log Level** Debug:

2. After the update, `GET /v1/logs?category=discovery` shows *watching the project for Composer changes* with the events. If it shows *Director does not announce Composer changes to DirectorLink* instead, steps 3–4 need the action Refresh Project.
3. In Composer, move a shade (or a light) to another room. About 5 seconds later the log shows *project event* lines and then *project rediscovered* with `moved` 1; the app shows the device in its new room at its next refresh. Keep the *project event* lines: what Director sends with `OnItemMoved` is not documented. Rename a device, add one and remove one: `renamed`, `added` and `removed`, and **Inventory** follows.
4. Actions → **Refresh Project**: *project rediscovered* with `reason` *Composer action*. Composer's **Refresh Navigators** does the same (`OnPIP`); pressed again within two minutes, it is read once more at the end of the two minutes. Status stays `Ready` throughout, and the adapters' per-device lines of a refresh (*initialized thermostat* and the like) are at debug level; *initialized N controllable proxies* stays at info.
5. After a refresh, a door relay's last state and a doorbell's last ring are as before; a scene with a removed device runs the others and reports the removed one as skipped.

Shades (KNX blinds on the blind proxy), with **Log Level** Debug and the driver reloaded:

6. `GET /v1/logs?category=blind&level=debug`: *proxy setup* for every shade, with the raw `GET_SETUP` answer (`<blind_setup>…`), and *proxy variables* with their values (`1002=Stopped:…`, `1004=Level:…`, `1005=Target Level:…`, `1007=Movement:…`, `1008=Opening:…`, `1009=Closing:…`). Keep both: the values of Stopped, Opening and Closing had not been seen before. Movement is the kind of movement (such as *Up to Down*), not whether the shade moves: at rest every shade has `"moving": false` in `GET /v1/blinds`, and the app reads the blinds every 10 seconds, not every 2.
7. `GET /v1/blinds`: a shade with a Percent Set Address has `"capabilities": {"position": true, …}`, one without has `"position": false` (as its setup's `level_discrete_control`). In the app the second has no slider, and a shade with `"stop": false` has no Stop.
8. Set a shade with a percent address to 50%: the line under its name reads *Opening… to 50%* (or *Closing… to 50%*) and the slider stays at 50 until the shade stops, then shows the position it reports (the actuator's own report comes about a second after the stop; the app reads a few seconds more for it). While it moves, `GET /v1/blinds/{id}` has `"moving": true`, `direction` and `target_position`, and the log has *movement changed* lines with the raw values of Stopped, Opening and Closing. Move the slider again while it moves: it stays where it was put. Open fully and press Stop halfway: the app shows it stopped at once (not *Opening…*), then where it stopped.
9. On a shade without position control, `PATCH {"position": 50}` answers `409 POSITION_NOT_SUPPORTED` and nothing moves; Open and Close work. A shade whose level is unknown (`-155` or `-255` in the log) shows *Position unknown*.
10. Move a shade from a keypad or the Control4 app: the DirectorLink app shows the movement within about 10 seconds.

## 0q. Update notice (1.1.0)

While the controller still runs a DirectorLink older than the latest release on GitHub (1.0.0, once 1.1.0 is published), before updating it. The app asks GitHub at most every 12 hours: if it asked just before the release was published, remove `directorlink.update` from the site's local storage (developer tools → Application) and reload.

1. With an admin key, Settings → Controller shows **Updates**: *DirectorLink 1.1.0 is available* with the release date, **Download DirectorLink.c4z** (the file of that release), **What's new** (the release page, in a new tab) and the steps in Composer.
2. Home shows *DirectorLink 1.1.0 is available. How to update*; the link opens Settings at the steps. ✕ hides the notice, also after a reload; Settings still shows the update.
3. With a member key (another browser), neither Home nor Settings mention updates, and developer tools → Network shows no request to `api.github.com`. On the admin's browser a reload does not ask again within 12 hours.
4. Update the driver with the downloaded file as the steps say, with the app left open on Settings: within a minute, without a reload, Settings → Controller shows version 1.1.0 and *Up to date*, Home shows no notice, and Network shows no new request to `api.github.com`.
5. In developer tools → Application → Local storage, lower `answeredAt` in `directorlink.update` by 300000000 (milliseconds, about 3½ days) and reload: **Updates** says *Could not check for updates (last checked …)* with that day. Remove `directorlink.update` and reload: *Up to date* again.

## 0p. Legacy lights and more thermostats (1.1.0)

On the test system, which has none of the new devices, this is a regression check:

1. Before updating, `GET /v1/thermostats`: note any floor-heating zone whose `target_temperature` is `-18`.
2. After updating, **Inventory** still shows 111 lights and 22 thermostats. More would mean the project has older lights or Control4 thermostats that now join room and whole-home scenes.
3. All 22 thermostats show `"setpoints": "single"`, with `heat_setpoint`, `cool_setpoint` and `setpoint_deadband` `null`, and the same targets, modes and ranges as before. A zone noted in step 1 now shows its real target, 5 °C minimum.
4. Section 4 passes unchanged: an AC zone Off → Cool, 22 °C, fan Low → Medium, and a floor-heating zone without Cool or fan.
5. `GET /v1/logs?category=climate`: each zone's *initialized thermostat* line has the fields of 1.0.0 and no `setpoint_source`, except a zone noted in step 1, whose line adds `setpoint_source` `heat` and the values 1149, 1150 and 1133 read.
6. With **Remote Access** on, **Remote Status** reaches `Connected` again after the update, and the app works away from home. This shows that the relay's certificate passes, not that Director checks it (1.0.0 connected with no check at all); step 7 shows that. If it keeps showing `Reconnecting in N s (connection lost)` or `Reconnecting in N s (no connection within 30 s)` instead, the check may have failed: save `GET /v1/logs?category=relay` and the DirectorLink lines of the Director driver log, and go back to 1.0.0.

The certificate check, once on the test system: a package that trusts only a root the relay's chain does not end at must never connect.

7. Build the test package from the release's commit: `python scripts/build.py --roots-only "ISRG Root X1"` writes `dist/DirectorLink-wrong-roots.c4z`, whose `certs/directorlink-roots.pem` holds only ISRG Root X1 (today's chain is WE1 → GTS Root R4; if a browser shows the certificate of `api.directorlink.io` issued by Let's Encrypt instead, build with `--roots-only "GTS Root R4"`). Copy it to an empty folder as `DirectorLink.c4z` and update DirectorLink with it in Composer (**Driver → Add or Update Driver**). With Remote Access on, Remote Status must never reach `Connected`: watch it for 3 minutes, and again after a reboot of the controller (an update in place might keep the connection's earlier settings). Note which it shows, `connection lost` or `no connection within 30 s`, and save `GET /v1/logs?category=relay` and the lines about the relay connection in `/var/log/debug/director.log` and `/var/log/debug/driver_log.log`: they should show the TLS failure (note its exact words, which Control4 does not document). If it connects, Director did not check the certificate against the package's CA file: stop, and report it.
8. Update DirectorLink again with the release's own `DirectorLink.c4z`: Remote Status reaches `Connected` again and the app works away from home. Record steps 7 and 8 in docs/VALIDATION.md. Whether Director also checks the name on the certificate is not tested here (release notes, *Known issues*).

On a Director with these devices (the contributor, @bkwagner, read them on a live Director; ask before running these steps on someone's installation). Set **Log Level** to Debug in Composer **before** updating: the start-up lines below are written only when the driver loads, and setting Debug later does not bring them back. Right after the update, before using the app, save `GET /v1/logs?level=debug` (it keeps the last 500 entries, and at Debug every request adds one) or the DirectorLink lines of the Director driver log:

9. **Older lights (`light.c4i`):** a dimmer on, off and 40%, and a switch on and off, each confirmed in the app without *waiting for the device to confirm*. `GET /v1/logs?category=light_command` shows `ON`, `OFF` and `SET_LEVEL` with `LEVEL` 40. Keep the `light_state` start-up lines (variable names, protocol drivers).
10. **Floor heating on its heat setpoint:** the zone shows its real target and − goes down to 5°. Set 21°: the device's heat setpoint changes, the log shows `SET_SETPOINT_HEAT` with `FAHRENHEIT` 70 (in a °F project) and `setpoint_source` `heat`. Keep the start-up values of 1100, 1104, 1105, 1120, 1132, 1133, 1149 and 1150.
11. **Each thermostat with heat and cool setpoints:** `GET` shows `"setpoints": "dual"`, both setpoints, the deadband, the modes and fan speeds. In Heat the stepper moves the heat setpoint, in Cool the cool setpoint, in Auto both are shown and Home shows the range (such as *Auto 20°–24°*); raising heat into the deadband moves cool, and the device ends with both values. The mode chips Off, Heat, Cool and Auto work, and a scene *Auto 20°–24°* runs. Set the fan to **On** and, where listed, **Circulate**: each is confirmed in the app, and the log shows `SET_MODE_FAN` with the thermostat's own spelling. Run a scene with a *Cool 24°* action on them (a mode and one target temperature, as scenes made before 1.1.0 have and as the editor makes for Cool): the thermostat goes to Cool with its cool setpoint at 24° (75 °F in a °F project), and the run reports no problem. Keep the Debug list of 1100–1150, and note whether the thermostat moves the other setpoint by itself.
12. Save `GET /v1/lights`, `GET /v1/thermostats` and a scene run's result, and validate them against `api/openapi.yaml`.

`v1.0.0` — the app's key stays off the home network (sealed requests, pairing with a key exchange) and the security review's fixes (issue #43, ADR-032). Update DirectorLink in Composer (no reboot).

## 0o. Security (1.0.0)

1. An app already paired keeps working at home after the update, without pairing again. In the browser's developer tools (Network), requests to the controller are `POST /v1/sealed` and carry no `Authorization` header; the answers are envelopes.
2. **New Pairing Code** in Composer, pair a second computer: the pairing answer holds `exchange` and `sealed`, not `key`. The new device works.
3. Type a wrong code five times from one computer: that computer is locked for a minute (*Too many wrong codes …*); another computer can still pair meanwhile.
4. `curl -H "Host: example.com" http://<controller-ip>:41999/v1/health` answers `421`; with the IP address as the host it answers `200`. A page served from `http://localhost` cannot reach the controller (a CORS error).
5. With a viewer key, `GET /v1/system` has `latitude` and `longitude` `null`; with an admin key they are rounded to two decimals.
6. With remote access: invite someone by email; the invitation is created (the controller registered it; `GET /v1/logs?category=remote` shows no *invitation not registered*) and they can join with it. With the controller's internet unplugged (Remote Status not connected), inviting fails within about 10 seconds and no invitation is left behind.
7. As the home's owner, at home: Settings → Account → **Replace the remote secret**: *Done*; Remote Status shows a reconnect within a minute (the Lua log says *home secret replaced*); the app away from home (a phone on mobile data) still works. From an admin who is not the owner: *Only the home's owner can replace its secret*.
8. Settings → Account → **Sign out everywhere** on one device: *Signed out on every device*; the other signed-in devices need to sign in again for remote use; at home they keep working.
9. (Only on a test project.) Actions → **Reset Remote Identity**: Remote Status connects with a new home id; the home must be linked again from Settings → Account.

`v0.15.0` — DirectorLink's automation is visible to the installer in Composer. Update DirectorLink in Composer (no reboot).

## 0n. Schedules and scenes in Composer

1. The DirectorLink device's properties now include **Schedules** (`On`), **Schedule Status** (e.g. `2 on · next tomorrow 06:45 Good morning`) and **Last Automation**.
2. Run a scene from the app: Last Automation shows its name, *run from* the device's name, and how many devices.
3. When a schedule runs, Last Automation says which schedule (or, for a weather rule, the reading, e.g. *heat rule, 31C outside*).
4. Actions → **Print Schedules and Scenes**: the Lua output lists every schedule and scene with its steps.
5. Set **Schedules** to `Paused`: Schedule Status says *Paused in Composer*, the app's Schedules page says the installer paused them, and a schedule due now does not run. Set it back to `On`.

`v0.14.0` — schedules: scenes run by themselves at a time, at sunrise or sunset, or when it gets hot, windy or rainy (weather from Open-Meteo). Update DirectorLink in Composer (no reboot).

## 0m. Schedules and the weather

1. Scenes → **Schedules**: the weather card shows the temperature, wind and today's forecast, sunrise and sunset. (If it asks for the location, set latitude and longitude in Composer's project properties.)
2. **New schedule** → a scene → At a time, two minutes from now → today's day → Save: the row says *Next: today …*; at that minute the scene runs, and the row says *Ran today …*. `GET /v1/logs?category=schedules` shows it.
3. Switch a schedule off from the list: it no longer runs.
4. Sun: sunset, 30 min before, every day: *Next* shows today's or tomorrow's time.
5. Weather → Heat, a threshold 1° below the temperature now → Save: within 15 minutes it runs once, and not again until it has cooled 2° below.
6. Only if → *It isn’t raining* on a time schedule, with *Skip* for no weather data; unplug the controller's internet: at its time it does not run and says *no weather data*.
7. A scene with a gate, run by a schedule: the gate is skipped (never opened by a schedule).
8. Deleting a scene that a schedule runs is refused, with a message.
9. Update the driver again in Composer: the schedules are still there and nothing runs twice.

`v0.13.0` — scenes: one tap sets lights, AC, blinds and gates; made in the app by admins, run by everyone with member access. Update DirectorLink in Composer (no reboot).

## 0l. Scenes

1. As an admin: **Scenes** tab → **Good night** under *Start from an idea*: the editor opens with all lights off and all blinds closed.
2. **Add an action** → Living room → Lights → **Choose** → only one lamp → Dim to 15% → **Add to scene**. Add the bedroom AC: Cool, 24°.
3. Turn on **Show on Home**, **Try it now** (the house changes, nothing is saved), then **Save scene**.
4. On Home, tap the scene: it says *Done*, and the lights, AC and blinds follow. On a phone with a member key, the same; with a view-only key the scene is listed but has no Run.
5. Add the gate (Doors & gates: *Open (short press)*) and run it from a member key: *doors and gates were skipped*. From an admin key with Door Control on, Run asks for a second tap, then the gate opens exactly like its Open button (the relay closes and releases).
6. Set the house by hand, open the scene → **Copy the house as it is now** → Save: running it later puts the house back like that.
7. Update the driver again in Composer: the scenes are still there.

`v0.12.0` — profiles: your language, theme, favorites and hidden rooms follow you to all your devices; one room order for the home. Update DirectorLink in Composer (no reboot).

## 0k. Profiles and rooms

1. On the PC (paired before the update): the app keeps its language, theme and favorites; `GET /v1/profile` now shows them.
2. Settings → Rooms: untick a room: it disappears from Home and Climate on this device, and on your other devices of the same person within a minute; other people still see it.
3. As an admin, move a room up with the arrow: the new order shows on every device.
4. **Add my other device** and accept it on the iPhone: the iPhone opens in your language and theme, with your favorites and hidden rooms.
5. People and devices: two devices of one person paired separately show as two persons; set one's Person to the other, then Rename the person: both now share the same preferences.

`v0.11.1` — air conditioning: the full 16–32 °C range, and − / + right after a fan or mode change send the temperature chosen. On an AC that is off at 32 °C, change the fan and tap − at once: the target becomes 31 °C, with no error.

`v0.11.0` — People and devices: who has access, from the app; revoking a device's key also ends its account's membership. Update DirectorLink in Composer (no reboot).

## 0j. People and devices

1. On the computer at home (admin key): Settings → **People and devices**. Devices lists every key, with *This device* for the computer (no Revoke, role fixed) and when each was last used; People lists your account as *Owner* with your devices, and anyone who joined with theirs; Invitations lists the ones waiting.
2. Change the role of the iPhone's key to *Member*: the iPhone can still switch lights, and Door Control gates are refused. Set it back to *Admin*.
3. **Add my other device** makes an invitation that appears under Invitations; **Revoke** it: its link answers "used, revoked or has expired".
4. Invite a second Google account, accept it on another device, then **Remove** that person: their device shows "Your home does not know this device’s key" (or the account message), and they are gone from People.
5. Revoke a device's key in the API console instead: within seconds that account also disappears from People (the controller told the cloud), unless it has another device.

`v0.10.0` — remote access with your account, locked end to end, on iPhone too. Update DirectorLink in Composer (no reboot) and set Remote Access to On.

## 0i. Remote access with an account

1. After the update, DirectorLink's log (`GET /v1/logs?category=remote`) shows `lock self-test passed`, and `GET /v1/remote` answers `enabled: true`, `connected: true`, `lock: true` and the home id.
2. On a computer at home (already paired): Settings → Account → **Sign in with Google**, then **Link this home to my account**. The card says the home is linked.
3. **Add my other device**: a QR code and a link appear, valid for 10 minutes. Scan the code with the iPhone camera and open it; the address bar shows only `#/join`. Sign in with the same Google account and **Accept invitation**.
4. The iPhone opens Home with **Connected · via account**; lights, climate and blinds work, and a light switched on the iPhone switches in the Control4 app.
5. On the computer, switch Wi-Fi off and use a phone hotspot: within a few seconds the chip says **Connected · via account**; back on the home Wi-Fi it returns to **Connected** within a minute.
6. **Invite someone** with another Google account's email and the `viewer` role; open the link in a private window signed in as that account: it can read but not switch lights (403 FORBIDDEN in the log). Opened with a third account, the link answers "for another email address".
7. In the log, remote requests appear with `client` = `relay` and the device's key id; the cloud's own logs show only home ids, key ids, sizes and codes.

## 0h. Staying paired through updates

1. After updating to 0.9.2, pair the app once more if it asks (**New Pairing Code**): 0.9.1 and older could not read their saved keys back after a reload.
2. Update DirectorLink again with the same file: the app stays connected without pairing, **API Keys** keeps its count, **Pairing Code** stays `-`, and `GET /v1/logs?category=auth` shows `keys loaded` with `"stored_as":"json"`.
3. Room names set in the app are still there after the update.
4. With **Remote Access** on, **Remote Status** shows the same home id before and after the update.

## 0g. DoorBird

1. **Inventory** ends with `1 doorbells`; `GET /v1/doorbells` lists the DoorBird with its camera (`/v1/cameras/{id}/snapshot` shows the gate).
2. Ring the DoorBird: within 10 s `last_ring_at` is set, `events[0].type` is `doorbell`, and the app shows the banner with the camera.
3. Walk past it: `last_motion_at` updates (`motion` events).
4. With Door Control enabled and a `doors` or `admin` key, **Open gate** in the app (or `POST /v1/doorbells/{id}/open`) opens the entrance gate like the DoorBird button in the Control4 app; `last_opened_at` follows.
5. With a `member` key, opening answers `403 FORBIDDEN`; with Door Control off, `403 DOOR_CONTROL_DISABLED`.

## 0f. Remote access (test)

1. **Remote Access** is `Off` and **Remote Status** `Off` after the update.
2. Set **Remote Access** to `On`: **Remote Status** shows `Connecting...`, then `Connected since HH:MM - home xxxxxxxx`.
3. From outside the home network, the relay's test endpoint returns the lights; `GET /v1/logs?category=relay` shows the connection, and each relayed request is logged with client `relay`.
4. Switch it `Off`: the status returns to `Off` and nothing reconnects.

## 0e. DirectorLink and pairing

1. The project contains one **DirectorLink** device and no button proxy. Its properties are, in order: Status, Version, API Status (`Online - port 41999`), Pairing Code, Pairing Status, API Keys, Door Control, Log Level, Inventory.
2. A new DirectorLink shows a code at once (`1234 5678`, **Pairing Status** `Ready until HH:MM - works once`). Pair https://app.directorlink.io with it: the app gets an admin key, **Pairing Code** turns to `-` and **Pairing Status** to `Used at HH:MM`.
3. Run **New Pairing Code**: a new code appears; after 15 minutes unused it turns to `-` / `Expired`.
4. Pair https://console.directorlink.io with a new code; its Keys tab lists both keys.
5. `POST /v1/auth/requests` answers 404.

## 0d. Roles and Door Control

1. The new **Door Control** property is `Disabled`: opening a door from the API answers `403 DOOR_CONTROL_DISABLED`. Set it to `Enabled` and it works again.
2. `GET /v1/api-keys/current` with an existing key shows `"role": "admin"`.
3. Create a `member` key in the console (Keys → Create) and use it in a second browser: it can switch lights but not open doors (`403 FORBIDDEN`) or list keys.
4. `PATCH /v1/api-keys/{id}` `{"role": "doors"}` from the admin browser lets it open doors.

## 0c. Relays and room names

1. **Inventory** ends with `3 relays` (the test system's two doors and gate).
2. `GET /v1/relays` lists them; `state` is `null` until a relay changes. Open one door from the Control4 app: its state turns `closed` and back to `open`.
3. `POST /v1/relays/{id}/pulse` opens that door exactly like its button in the Control4 app. `GET /v1/logs?category=relay_command` shows who sent it.
4. `PATCH /v1/rooms/{id}` with `{"names": {"en": "Living room"}}`, then `GET /v1/rooms/{id}` shows the name; it survives a driver update.

## 0b. Cameras

1. **Inventory** in Composer ends with `13 cameras` (the test system: 12 Hikvision, 1 DoorBird).
2. `GET /v1/cameras` lists them without addresses or passwords.
3. The app's Cameras grid shows a picture for each camera within a few seconds; tapping one shows it larger, refreshing about once a second.
4. A camera that is offline or rejects its login shows "No picture"; `GET /v1/logs?category=camera` says why (never with the password).

## 0a. Blinds

1. **Inventory** in Composer ends with `15 blinds` (the test system).
2. `GET /v1/blinds` lists them; `position` is a number for blinds with a KNX status address, otherwise `null` until the blind moves.
3. In the app open, stop and close one blind, and set 50% on one with percentage control. The Control4 app shows the same movement.
4. `GET /v1/logs?category=blind_command` shows each command; `GET /v1/logs?category=blind&level=debug` (after setting the log level to Debug and reloading) lists the proxy variables.

## 1. Install

Update the driver in Composer with a local file named exactly `DirectorLink.c4z` (delete an older one from the download folder before downloading, or the browser names the new one `DirectorLink (1).c4z`). Coming from C4Bridge (0.7 and older), remove C4Bridge from the project first and add DirectorLink as a new driver — see the 0.8.0 release notes.

Expected in the DirectorLink properties once the new driver is loaded:

- Status: `Ready`
- Version: `1.1.1`
- API Status: `Online - port 41999`
- Pairing Code: `1234 5678` (new driver) or `-`; Pairing Status: `Ready until HH:MM - works once`, or how to get a code
- API Keys: how many keys exist
- Door Control: `Disabled`; Relay Hold: `Not allowed`; Log Level: `Info`
- Remote Access and Remote Status: `Off` (new driver)
- Schedules: `On`; Schedule Status: `None` (new driver); Last Automation: empty
- Inventory: rooms, devices, lights, thermostats, blinds, cameras, relays and doorbells (the test system: 20 rooms, 111 lights, 22 thermostats, 15 blinds, 13 cameras, 3 relays)

## 2. Request bodies

The driver runs the DriverWorks TCP server without a delimiter and reads bodies by `Content-Length` (confirmed on Director 3.4.3). Check it first after every update:

1. Pair (next step). If pairing hangs or times out, body handling does not work on this Director — capture the log and stop.
2. `PATCH /v1/lights/{id}` with `{"on": true}` must answer `202` within a second.

## 3. Pair and connect

1. Open `https://app.directorlink.io`, enter the controller IP and the Pairing Code, and click **Connect**.
2. Expect rooms, devices, lights and thermostats to load. After pairing the Pairing Code in Composer shows `-`, Pairing Status `Used at HH:MM - …`, and **API Keys** goes up by one.

## 4. Lights and thermostats

Repeat the alpha checks through the new API:

- a KNX switch: on and off, confirmed by the controller
- a dimmable light: set 40%, confirmed (KNX dimmers report "level not reported")
- where the project has them, a legacy (`light.c4i`) switch and dimmer: on/off and 40%, confirmed
- one AC zone: mode Off → Cool, target 22 °C, fan Low → Medium
- one floor-heating zone: no Cool mode and no fan controls offered
- a floor-heating zone shows its real target and a change is confirmed

## 5. API console

Open https://console.directorlink.io (or the app's Settings → App → API console) and check:

- the API tab lists every endpoint, grouped by tag
- `GET /v1/system` returns controller, location and inventory
- `GET /v1/devices?type=light&room_id=<id>` filters
- an invalid `PATCH` (for example `{"brightness": 150}`) returns `400` with `code: INVALID_FIELD`
- the Logs tab follows new `api` entries every 2 seconds as requests are made

## 6. API keys and logs

- `POST /v1/api-keys` with `{"name": "Test"}` returns a key once; `GET /v1/api-keys` lists it without the secret
- `DELETE /v1/api-keys/{id}` makes that key return `401`
- `PATCH /v1/logs/settings` with `{"level": "debug"}` changes the Composer **Log Level** to Debug; set it back to `info` afterwards
- Composer action **Revoke All API Keys** makes every browser need a new pairing

## 7. Testing the app before it is deployed

The driver answers browsers only from app.directorlink.io and console.directorlink.io (since 1.0.0,
not `localhost`): a copy of the app served from this PC talks only to the fake controller of the dev
server, which allows local origins.

```bash
python scripts/dev_server.py                  # fake controller on http://localhost:41999
python -m http.server 8080 --directory app    # app on http://localhost:8080
```

Then open `http://localhost:8080`, with `localhost` as the controller address and the code the dev
server prints (`docs/BUILD.md`). Changes are tried against the real controller once they are
deployed (a merge to `main`).

## If something fails

Collect `GET /v1/logs?level=debug` (after setting the level to debug), the Composer properties, and the DirectorLink lines from the Director driver log.
