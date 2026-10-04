-- The API route table. It must match api/openapi.yaml exactly: scripts/check_api.py fails the
-- build when a method, path, public flag or role (x-directorlink-role) differs between the two.
-- `role` is the least API key role that may call the route (src/auth/roles.lua).

return {
    { method = "GET", path = "/v1/health", handler = "system.health", public = true },
    { method = "GET", path = "/v1/openapi.json", handler = "system.openapi", public = true },
    { method = "GET", path = "/v1/system", handler = "system.info", role = "viewer" },

    { method = "POST", path = "/v1/auth/pair", handler = "auth.pair", public = true },
    -- Sealed with the device's lock key instead of an Authorization header (handlers/sealed.lua).
    { method = "GET", path = "/v1/sealed", handler = "sealed.info", public = true },
    { method = "POST", path = "/v1/sealed", handler = "sealed.request", public = true },
    { method = "GET", path = "/v1/api-keys", handler = "auth.list_keys", role = "admin" },
    { method = "POST", path = "/v1/api-keys", handler = "auth.create_key", role = "admin" },
    { method = "GET", path = "/v1/api-keys/current", handler = "auth.current_key", role = "viewer" },
    { method = "DELETE", path = "/v1/api-keys/current", handler = "auth.revoke_current_key", role = "viewer" },
    { method = "PATCH", path = "/v1/api-keys/{keyId}", handler = "auth.update_key", role = "admin" },
    { method = "DELETE", path = "/v1/api-keys/{keyId}", handler = "auth.delete_key", role = "admin" },

    { method = "GET", path = "/v1/profile", handler = "profiles.current", role = "viewer" },
    { method = "PATCH", path = "/v1/profile", handler = "profiles.update", role = "viewer" },
    { method = "GET", path = "/v1/profiles", handler = "profiles.list", role = "admin" },
    { method = "PATCH", path = "/v1/profiles/{profileId}", handler = "profiles.rename", role = "admin" },

    { method = "GET", path = "/v1/remote", handler = "remote.status", role = "viewer" },
    { method = "POST", path = "/v1/remote/claim", handler = "remote.claim", role = "admin" },
    { method = "POST", path = "/v1/remote/secret", handler = "remote.secret", role = "admin" },
    { method = "GET", path = "/v1/invitations", handler = "invitations.list", role = "admin" },
    { method = "POST", path = "/v1/invitations", handler = "invitations.create", role = "admin" },
    { method = "DELETE", path = "/v1/invitations/{invitationId}", handler = "invitations.delete", role = "admin" },

    { method = "GET", path = "/v1/rooms", handler = "rooms.list", role = "viewer" },
    { method = "PUT", path = "/v1/rooms/order", handler = "rooms.order", role = "admin" },
    { method = "GET", path = "/v1/rooms/{roomId}", handler = "rooms.get", role = "viewer" },
    { method = "PATCH", path = "/v1/rooms/{roomId}", handler = "rooms.update", role = "admin" },

    { method = "GET", path = "/v1/scenes", handler = "scenes.list", role = "viewer" },
    { method = "POST", path = "/v1/scenes", handler = "scenes.create", role = "admin" },
    { method = "POST", path = "/v1/scenes/try", handler = "scenes.try", role = "admin" },
    { method = "GET", path = "/v1/scenes/{sceneId}", handler = "scenes.get", role = "viewer" },
    { method = "PATCH", path = "/v1/scenes/{sceneId}", handler = "scenes.update", role = "admin" },
    { method = "DELETE", path = "/v1/scenes/{sceneId}", handler = "scenes.delete", role = "admin" },
    { method = "POST", path = "/v1/scenes/{sceneId}/run", handler = "scenes.run", role = "member" },
    -- A private link per scene for the phone's own automations (ADR-051): admins only, never a
    -- scene that opens doors or gates.
    { method = "GET", path = "/v1/scene-links", handler = "scene_links.list", role = "admin" },
    { method = "GET", path = "/v1/scenes/{sceneId}/link", handler = "scene_links.get", role = "admin" },
    { method = "POST", path = "/v1/scenes/{sceneId}/link", handler = "scene_links.create", role = "admin" },
    { method = "DELETE", path = "/v1/scenes/{sceneId}/link", handler = "scene_links.delete", role = "admin" },
    -- Home's "Turn off all": lights, AC or blinds only, never doors (handlers/scenes.lua).
    { method = "POST", path = "/v1/off", handler = "scenes.off", role = "member" },

    { method = "GET", path = "/v1/schedules", handler = "schedules.list", role = "viewer" },
    { method = "POST", path = "/v1/schedules", handler = "schedules.create", role = "admin" },
    { method = "GET", path = "/v1/schedules/{scheduleId}", handler = "schedules.get", role = "viewer" },
    { method = "PATCH", path = "/v1/schedules/{scheduleId}", handler = "schedules.update", role = "admin" },
    { method = "DELETE", path = "/v1/schedules/{scheduleId}", handler = "schedules.delete", role = "admin" },
    { method = "GET", path = "/v1/weather", handler = "schedules.weather", role = "viewer" },

    { method = "GET", path = "/v1/calendar", handler = "calendar.get", role = "viewer" },
    { method = "PATCH", path = "/v1/calendar/settings", handler = "calendar.update_settings", role = "admin" },

    { method = "GET", path = "/v1/devices", handler = "devices.list", role = "viewer" },
    { method = "GET", path = "/v1/devices/{deviceId}", handler = "devices.get", role = "viewer" },

    { method = "GET", path = "/v1/lights", handler = "lights.list", role = "viewer" },
    { method = "GET", path = "/v1/lights/{lightId}", handler = "lights.get", role = "viewer" },
    { method = "PATCH", path = "/v1/lights/{lightId}", handler = "lights.update", role = "member" },

    { method = "GET", path = "/v1/thermostats", handler = "thermostats.list", role = "viewer" },
    { method = "GET", path = "/v1/thermostats/{thermostatId}", handler = "thermostats.get", role = "viewer" },
    { method = "PATCH", path = "/v1/thermostats/{thermostatId}", handler = "thermostats.update", role = "member" },

    { method = "GET", path = "/v1/fans", handler = "fans.list", role = "viewer" },
    { method = "GET", path = "/v1/fans/{fanId}", handler = "fans.get", role = "viewer" },
    { method = "PATCH", path = "/v1/fans/{fanId}", handler = "fans.update", role = "member" },

    { method = "GET", path = "/v1/blinds", handler = "blinds.list", role = "viewer" },
    { method = "GET", path = "/v1/blinds/{blindId}", handler = "blinds.get", role = "viewer" },
    { method = "PATCH", path = "/v1/blinds/{blindId}", handler = "blinds.update", role = "member" },
    { method = "POST", path = "/v1/blinds/{blindId}/stop", handler = "blinds.stop", role = "member" },

    { method = "GET", path = "/v1/cameras", handler = "cameras.list", role = "viewer" },
    { method = "GET", path = "/v1/cameras/{cameraId}", handler = "cameras.get", role = "viewer" },
    { method = "GET", path = "/v1/cameras/{cameraId}/snapshot", handler = "cameras.snapshot", role = "viewer" },

    { method = "GET", path = "/v1/relays", handler = "relays.list", role = "viewer" },
    { method = "GET", path = "/v1/relays/{relayId}", handler = "relays.get", role = "viewer" },
    { method = "PATCH", path = "/v1/relays/{relayId}", handler = "relays.update", role = "doors" },
    { method = "POST", path = "/v1/relays/{relayId}/pulse", handler = "relays.pulse", role = "doors" },

    { method = "GET", path = "/v1/doorbells", handler = "doorbells.list", role = "viewer" },
    { method = "GET", path = "/v1/doorbells/{doorbellId}", handler = "doorbells.get", role = "viewer" },
    { method = "POST", path = "/v1/doorbells/{doorbellId}/open", handler = "doorbells.open", role = "doors" },

    -- Samsung refrigerators (ADR-049): read by everyone, their features switched by members.
    { method = "GET", path = "/v1/refrigerators", handler = "refrigerators.list", role = "viewer" },
    { method = "GET", path = "/v1/refrigerators/{refrigeratorId}", handler = "refrigerators.get", role = "viewer" },
    { method = "PATCH", path = "/v1/refrigerators/{refrigeratorId}", handler = "refrigerators.update", role = "member" },

    -- Read-only, and never for viewers (ADR-038): no route arms, disarms or sends anything to the
    -- alarm; scripts/check_package.py fails the build if one does.
    { method = "GET", path = "/v1/alarm", handler = "alarm.status", role = "member" },

    -- Sonos (ADR-044): read by everyone, played by members, placed in a room by admins; nothing while
    -- the Composer property Sonos is Off. A request names a Sonos room, never an address.
    { method = "GET", path = "/v1/music", handler = "music.list", role = "viewer" },
    { method = "GET", path = "/v1/music/{musicId}", handler = "music.get", role = "viewer" },
    { method = "PATCH", path = "/v1/music/{musicId}", handler = "music.update", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/play", handler = "music.play", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/pause", handler = "music.pause", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/next", handler = "music.next", role = "member" },
    { method = "POST", path = "/v1/music/{musicId}/previous", handler = "music.previous", role = "member" },
    { method = "GET", path = "/v1/music/{musicId}/favorites", handler = "music.favorites", role = "viewer" },
    { method = "POST", path = "/v1/music/{musicId}/favorites/{favoriteId}/play", handler = "music.play_favorite", role = "member" },
    { method = "GET", path = "/v1/music/{musicId}/art", handler = "music.art", role = "viewer" },
    { method = "PUT", path = "/v1/music/{musicId}/room", handler = "music.room", role = "admin" },

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
    { method = "GET", path = "/v1/alerts/choices", handler = "alerts.get", role = "viewer" },
    { method = "PUT", path = "/v1/alerts/choices", handler = "alerts.put", role = "viewer" },

    -- What the controller did and noticed (ADR-046), for admins; in the clear too, like the log.
    { method = "GET", path = "/v1/activity", handler = "activity.list", role = "admin" },

    { method = "GET", path = "/v1/logs", handler = "logs.list", role = "admin" },
    { method = "GET", path = "/v1/logs/settings", handler = "logs.get_settings", role = "admin" },
    { method = "PATCH", path = "/v1/logs/settings", handler = "logs.update_settings", role = "admin" },
}
