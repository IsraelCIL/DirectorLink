-- The API route table. It must match api/openapi.yaml exactly: scripts/check_api.py fails the
-- build when a method, path, public flag or role (x-directorlink-role) differs between the two.
-- `role` is who may call the route (ADR-054): "admin", the home's admins, or "member", every person;
-- what a member then sees and may do there is the handler's to check (src/auth/access.lua).

return {
    { method = "GET", path = "/v1/health", handler = "system.health", public = true },
    { method = "GET", path = "/v1/openapi.json", handler = "system.openapi", public = true },
    { method = "GET", path = "/v1/system", handler = "system.info", role = "member" },

    { method = "POST", path = "/v1/auth/pair", handler = "auth.pair", public = true },
    -- Sealed with the device's lock key instead of an Authorization header (handlers/sealed.lua).
    { method = "GET", path = "/v1/sealed", handler = "sealed.info", public = true },
    { method = "POST", path = "/v1/sealed", handler = "sealed.request", public = true },
    { method = "GET", path = "/v1/api-keys", handler = "auth.list_keys", role = "admin" },
    { method = "POST", path = "/v1/api-keys", handler = "auth.create_key", role = "admin" },
    { method = "GET", path = "/v1/api-keys/current", handler = "auth.current_key", role = "member" },
    { method = "DELETE", path = "/v1/api-keys/current", handler = "auth.revoke_current_key", role = "member" },
    { method = "PATCH", path = "/v1/api-keys/{keyId}", handler = "auth.update_key", role = "admin" },
    -- Since 1.9.0 (ADR-061) a member removes their own user's other devices (Access.mayRemoveDevice).
    { method = "DELETE", path = "/v1/api-keys/{keyId}", handler = "auth.delete_key", role = "member" },

    { method = "GET", path = "/v1/profile", handler = "profiles.current", role = "member" },
    { method = "PATCH", path = "/v1/profile", handler = "profiles.update", role = "member" },
    { method = "GET", path = "/v1/profiles", handler = "profiles.list", role = "admin" },
    { method = "PATCH", path = "/v1/profiles/{profileId}", handler = "profiles.rename", role = "admin" },
    -- A person's role and, for a member, what they may see and do (ADR-054).
    { method = "GET", path = "/v1/profiles/{profileId}/access", handler = "profiles.get_access", role = "admin" },
    { method = "PATCH", path = "/v1/profiles/{profileId}/access", handler = "profiles.update_access", role = "admin" },
    -- Users and their devices (1.9.0, ADR-061): Settings → Users (a member sees their own user),
    -- an account's devices brought into one user, and a pairing code made for a chosen user.
    { method = "GET", path = "/v1/users", handler = "users.list", role = "member" },
    { method = "POST", path = "/v1/users/merge", handler = "users.merge", role = "admin" },
    -- The owner makes another admin the home's owner (1.9.0, ADR-064; only the owner: Access).
    { method = "POST", path = "/v1/users/owner", handler = "users.make_owner", role = "admin" },
    { method = "POST", path = "/v1/pairing-code", handler = "users.create_code", role = "admin" },
    { method = "DELETE", path = "/v1/pairing-code", handler = "users.delete_code", role = "admin" },

    -- Direct HTTPS (1.12.0, ADR-082): the API over TLS on port 28443 under the home's own name; its
    -- status for admins, and the owner's switch (only the owner: the handler checks).
    { method = "GET", path = "/v1/https", handler = "https.status", role = "admin" },
    { method = "PUT", path = "/v1/https", handler = "https.set", role = "admin" },

    { method = "GET", path = "/v1/remote", handler = "remote.status", role = "member" },
    { method = "POST", path = "/v1/remote/claim", handler = "remote.claim", role = "admin" },
    { method = "POST", path = "/v1/remote/secret", handler = "remote.secret", role = "admin" },
    { method = "GET", path = "/v1/invitations", handler = "invitations.list", role = "admin" },
    -- Since 1.9.0 (ADR-061) every user invites their own other device (for_me) and revokes what
    -- their devices invited; inviting anyone else stays the admins' (the handler checks).
    { method = "POST", path = "/v1/invitations", handler = "invitations.create", role = "member" },
    { method = "DELETE", path = "/v1/invitations/{invitationId}", handler = "invitations.delete", role = "member" },

    { method = "GET", path = "/v1/rooms", handler = "rooms.list", role = "member" },
    { method = "PUT", path = "/v1/rooms/order", handler = "rooms.order", role = "admin" },
    { method = "GET", path = "/v1/rooms/{roomId}", handler = "rooms.get", role = "member" },
    { method = "PATCH", path = "/v1/rooms/{roomId}", handler = "rooms.update", role = "admin" },

    { method = "GET", path = "/v1/scenes", handler = "scenes.list", role = "member" },
    { method = "POST", path = "/v1/scenes", handler = "scenes.create", role = "admin" },
    { method = "POST", path = "/v1/scenes/try", handler = "scenes.try", role = "admin" },
    { method = "GET", path = "/v1/scenes/{sceneId}", handler = "scenes.get", role = "member" },
    { method = "PATCH", path = "/v1/scenes/{sceneId}", handler = "scenes.update", role = "admin" },
    { method = "DELETE", path = "/v1/scenes/{sceneId}", handler = "scenes.delete", role = "admin" },
    { method = "POST", path = "/v1/scenes/{sceneId}/run", handler = "scenes.run", role = "member" },
    -- A private link per scene for the phone's own automations (ADR-051): admins only, never a
    -- scene that opens doors or gates.
    { method = "GET", path = "/v1/scene-links", handler = "scene_links.list", role = "admin" },
    { method = "GET", path = "/v1/scenes/{sceneId}/link", handler = "scene_links.get", role = "admin" },
    { method = "POST", path = "/v1/scenes/{sceneId}/link", handler = "scene_links.create", role = "admin" },
    { method = "DELETE", path = "/v1/scenes/{sceneId}/link", handler = "scene_links.delete", role = "admin" },
    -- Ask to open (ADR-058): a link that asks its person to open a door or gate, never opens it;
    -- made by those who may open that door (Access.canOpen), each sees their own person's (admins
    -- every one).
    { method = "GET", path = "/v1/ask-links", handler = "ask_links.list", role = "member" },
    { method = "POST", path = "/v1/ask-links", handler = "ask_links.create", role = "member" },
    { method = "DELETE", path = "/v1/ask-links/{linkId}", handler = "ask_links.delete", role = "member" },
    -- Home's "Turn off all": lights, AC or blinds only, never doors (handlers/scenes.lua).
    { method = "POST", path = "/v1/off", handler = "scenes.off", role = "member" },

    -- Schedules are the admins' (ADR-054): members never see them.
    { method = "GET", path = "/v1/schedules", handler = "schedules.list", role = "admin" },
    { method = "POST", path = "/v1/schedules", handler = "schedules.create", role = "admin" },
    { method = "GET", path = "/v1/schedules/{scheduleId}", handler = "schedules.get", role = "admin" },
    { method = "PATCH", path = "/v1/schedules/{scheduleId}", handler = "schedules.update", role = "admin" },
    { method = "DELETE", path = "/v1/schedules/{scheduleId}", handler = "schedules.delete", role = "admin" },
    { method = "GET", path = "/v1/weather", handler = "schedules.weather", role = "member" },

    { method = "GET", path = "/v1/calendar", handler = "calendar.get", role = "member" },
    { method = "PATCH", path = "/v1/calendar/settings", handler = "calendar.update_settings", role = "admin" },

    { method = "GET", path = "/v1/devices", handler = "devices.list", role = "member" },
    { method = "GET", path = "/v1/devices/{deviceId}", handler = "devices.get", role = "member" },

    { method = "GET", path = "/v1/lights", handler = "lights.list", role = "member" },
    { method = "GET", path = "/v1/lights/{lightId}", handler = "lights.get", role = "member" },
    { method = "PATCH", path = "/v1/lights/{lightId}", handler = "lights.update", role = "member" },

    { method = "GET", path = "/v1/thermostats", handler = "thermostats.list", role = "member" },
    { method = "GET", path = "/v1/thermostats/{thermostatId}", handler = "thermostats.get", role = "member" },
    { method = "PATCH", path = "/v1/thermostats/{thermostatId}", handler = "thermostats.update", role = "member" },

    { method = "GET", path = "/v1/fans", handler = "fans.list", role = "member" },
    { method = "GET", path = "/v1/fans/{fanId}", handler = "fans.get", role = "member" },
    { method = "PATCH", path = "/v1/fans/{fanId}", handler = "fans.update", role = "member" },

    { method = "GET", path = "/v1/blinds", handler = "blinds.list", role = "member" },
    { method = "GET", path = "/v1/blinds/{blindId}", handler = "blinds.get", role = "member" },
    { method = "PATCH", path = "/v1/blinds/{blindId}", handler = "blinds.update", role = "member" },
    { method = "POST", path = "/v1/blinds/{blindId}/stop", handler = "blinds.stop", role = "member" },

    { method = "GET", path = "/v1/cameras", handler = "cameras.list", role = "member" },
    { method = "GET", path = "/v1/cameras/{cameraId}", handler = "cameras.get", role = "member" },
    { method = "GET", path = "/v1/cameras/{cameraId}/snapshot", handler = "cameras.snapshot", role = "member" },

    { method = "GET", path = "/v1/relays", handler = "relays.list", role = "member" },
    { method = "GET", path = "/v1/relays/{relayId}", handler = "relays.get", role = "member" },
    { method = "PATCH", path = "/v1/relays/{relayId}", handler = "relays.update", role = "member" },
    { method = "POST", path = "/v1/relays/{relayId}/pulse", handler = "relays.pulse", role = "member" },

    { method = "GET", path = "/v1/doorbells", handler = "doorbells.list", role = "member" },
    { method = "GET", path = "/v1/doorbells/{doorbellId}", handler = "doorbells.get", role = "member" },
    { method = "POST", path = "/v1/doorbells/{doorbellId}/open", handler = "doorbells.open", role = "member" },
    -- The doors and gates an admin links to a doorbell (1.11.0, ADR-078); each still opened with
    -- its own Open, by those who may open it.
    { method = "PUT", path = "/v1/doorbells/{doorbellId}/doors", handler = "doorbells.set_doors", role = "admin" },

    -- Samsung refrigerators (ADR-049): read and switched by those given refrigerators (ADR-054).
    { method = "GET", path = "/v1/refrigerators", handler = "refrigerators.list", role = "member" },
    { method = "GET", path = "/v1/refrigerators/{refrigeratorId}", handler = "refrigerators.get", role = "member" },
    { method = "PATCH", path = "/v1/refrigerators/{refrigeratorId}", handler = "refrigerators.update", role = "member" },

    -- Read-only, and only for those who see the alarm's status (ADR-038, ADR-054): no route arms,
    -- disarms or sends anything to the alarm; scripts/check_package.py fails the build if one does.
    { method = "GET", path = "/v1/alarm", handler = "alarm.status", role = "member" },

    -- Sonos (ADR-044): read and played by those given music (ADR-054), placed in a room by admins;
    -- nothing while the Composer property Sonos is Off. A request names a Sonos room, never an address.
    { method = "GET", path = "/v1/music", handler = "music.list", role = "member" },
    { method = "GET", path = "/v1/music/{musicId}", handler = "music.get", role = "member" },
    { method = "PATCH", path = "/v1/music/{musicId}", handler = "music.update", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/play", handler = "music.play", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/pause", handler = "music.pause", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/next", handler = "music.next", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/previous", handler = "music.previous", role = "member" },
    { method = "GET", path = "/v1/music/{musicId}/favorites", handler = "music.favorites", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/favorites/{favoriteId}/play", handler = "music.play_favorite", role = "member" },
    { method = "GET", path = "/v1/music/{musicId}/art", handler = "music.art", role = "member" },
    { method = "PUT", path = "/v1/music/{musicId}/room", handler = "music.room", role = "admin" },
    -- Groups (1.8.0, ADR-057): join another room's group, leave it, the group's volume.
    { method = "POST", path = "/v1/music/{musicId}/group", handler = "music.join", role = "member" },
    { method = "DELETE", path = "/v1/music/{musicId}/group", handler = "music.leave", role = "member" },
    { method = "PATCH", path = "/v1/music/{musicId}/group", handler = "music.group_volume", role = "member" },

    -- Everything DirectorLink keeps, for admins, only in sealed requests (ADR-042).
    { method = "GET", path = "/v1/backup", handler = "backup.export", role = "admin" },
    { method = "POST", path = "/v1/restore/parts", handler = "backup.part", role = "admin" },
    { method = "POST", path = "/v1/restore", handler = "backup.restore", role = "admin" },
    -- Automatic backups to the account, sealed to the backup password's key (ADR-048).
    { method = "GET", path = "/v1/backup/automatic", handler = "backup.automatic", role = "admin" },
    { method = "PUT", path = "/v1/backup/automatic", handler = "backup.set_automatic", role = "admin" },
    { method = "DELETE", path = "/v1/backup/automatic", handler = "backup.clear_automatic", role = "admin" },
    { method = "POST", path = "/v1/backup/automatic/run", handler = "backup.run_automatic", role = "admin" },

    -- Which alerts this device gets (ADR-050): each key its own.
    { method = "GET", path = "/v1/alerts/choices", handler = "alerts.get", role = "member" },
    { method = "PUT", path = "/v1/alerts/choices", handler = "alerts.put", role = "member" },

    -- What the controller did and noticed (ADR-046), for admins; in the clear too, like the log.
    { method = "GET", path = "/v1/activity", handler = "activity.list", role = "admin" },

    { method = "GET", path = "/v1/logs", handler = "logs.list", role = "admin" },
    { method = "GET", path = "/v1/logs/settings", handler = "logs.get_settings", role = "admin" },
    { method = "PATCH", path = "/v1/logs/settings", handler = "logs.update_settings", role = "admin" },
}
