local Json = require("src.core.json")
local Clock = require("src.core.clock")
local Version = require("src.core.version")
local Problem = require("src.api.problem")
local Access = require("src.auth.access")
local Units = require("src.adapters.thermostat_units")

local System = {}

local function text(value)
    if value == nil or tostring(value) == "" then
        return Json.null
    end
    return tostring(value)
end

local function number(value)
    local parsed = tonumber(value)
    if parsed == nil then
        return Json.null
    end
    return parsed
end

-- Whether a camera raises alerts (src/adapters/camera.lua).
local function cameraAlerts(registry)
    for _, camera in ipairs(registry.cameraList and registry.cameraList() or {}) do
        if camera.capabilities and camera.capabilities.alerts == true then
            return true
        end
    end
    return false
end

function System.health(ctx)
    local status = ctx.services.status()
    return 200, {
        -- What answers on this port: the app's Find my controller tells DirectorLink from other devices.
        product = "directorlink",
        status = status.state,
        version = Version.BRIDGE_VERSION,
        api_version = Version.API_VERSION,
        detail = text(status.detail),
    }
end

-- The document is generated from api/openapi.yaml by scripts/build.py.
function System.openapi(_ctx)
    local ok, document = pcall(require, "src.api.openapi_spec")
    if not ok or type(document) ~= "string" then
        return Problem.new(503, "UNAVAILABLE", "This driver build does not include the API description")
    end
    return 200, document
end

-- What the home has, as GET /v1/system's inventory: everything for admins; for a member only what
-- they see (ADR-054: the rooms theirs, and there the devices Access.canSee gives them), so that it
-- says nothing of the rest.
local INVENTORY = { light = "lights", climate = "thermostats", fan = "fans", blind = "blinds", camera = "cameras", relay = "relays", doorbell = "doorbells", refrigerator = "refrigerators" }

local function inventory(actor, registry, counts)
    if Access.isAdmin(actor) then
        return {
            rooms = counts.rooms,
            devices = counts.devices,
            supported_devices = counts.supported,
            lights = counts.supported_lights,
            thermostats = counts.supported_climate,
            fans = counts.supported_fans,
            blinds = counts.supported_blinds,
            cameras = counts.supported_cameras,
            relays = counts.supported_relays,
            doorbells = counts.supported_doorbells,
            refrigerators = counts.supported_refrigerators,
        }
    end
    local result = { rooms = 0, devices = 0, supported_devices = 0 }
    for _, field in pairs(INVENTORY) do
        result[field] = 0
    end
    for id in pairs(registry.rooms or {}) do
        if Access.seesRoom(actor, id) then
            result.rooms = result.rooms + 1
        end
    end
    for _, device in pairs(registry.devices or {}) do
        if Access.canSee(actor, device) then
            result.devices = result.devices + 1
            -- Alarm partitions are counted apart, as for admins (Registry.counts).
            if device.supported and device.kind ~= "alarm" then
                result.supported_devices = result.supported_devices + 1
                local field = INVENTORY[device.kind]
                if field then
                    result[field] = result[field] + 1
                end
            end
        end
    end
    -- Cameras that are doorbells (ADR-065) are doorbells too, for whoever sees them as one.
    for _, doorbell in ipairs(registry.doorbellList()) do
        if doorbell.camera_doorbell and Access.canSee(actor, doorbell) then
            result.doorbells = result.doorbells + 1
        end
    end
    return result
end

local function rounded(value)
    if type(value) ~= "number" then
        return Json.null
    end
    return math.floor(value * 100 + 0.5) / 100
end

function System.info(ctx)
    local admin = Access.isAdmin(ctx.apiKey)
    local services = ctx.services
    local registry = services.registry
    local metadata = registry.metadata or {}
    local properties = metadata.properties or {}
    local counts = registry.counts()
    local status = services.status()
    local lifecycle = services.lifecycle()

    return 200, {
        bridge = {
            version = Version.BRIDGE_VERSION,
            api_version = Version.API_VERSION,
            status = status.state,
            detail = text(status.detail),
            started_at = Clock.iso(services.startedAt),
        },
        controller = {
            platform = "control4",
            os_version = text(services.controllerVersion),
            model = text(metadata.systemType),
        },
        location = {
            city = text(properties.CityName),
            country_code = text(properties.CountryCode),
            country = text(properties.CountryName),
            -- Where the home is: for admins only, rounded to two decimals (about a kilometre).
            latitude = admin and rounded(number(properties.Latitude)) or Json.null,
            longitude = admin and rounded(number(properties.Longitude)) or Json.null,
            timezone = text(metadata.timezone),
        },
        -- "C" or "F" (1.10.2): what clients show temperatures in that no one thermostat says.
        temperature_scale = Units.projectScale(registry),
        -- Direct HTTPS (1.12.0, ADR-082): { name, port, not_after } while the TLS server listens with
        -- a certificate valid now, where the app reaches this API over HTTPS at home; else null.
        direct_https = services.https and services.https.published() or Json.null,
        -- A member's: only what they see.
        inventory = inventory(ctx.apiKey, registry, counts),
        lifecycle = {
            reload_count = tonumber(lifecycle.reload_count) or 0,
            last_init_type = text(lifecycle.last_init_type),
            last_init_time = text(lifecycle.last_init_time),
            last_destroy_type = text(lifecycle.last_destroy_type),
            last_destroy_time = text(lifecycle.last_destroy_time),
        },
        -- What the installer switched on in Composer, and what this DirectorLink has; clients show
        -- none of what is false or missing.
        -- jewish_calendar is the Jewish Calendar property (/v1/calendar, Shabbat schedules).
        -- alarm_status: the alarm's partitions, read-only, for members and admins (ADR-038).
        -- backup: GET /v1/backup and POST /v1/restore (1.4.0, ADR-042), always there; drivers
        -- before 1.4.0 do not say it, and the app shows them no Backup.
        -- sonos: the Sonos property, /v1/music (1.5.0, ADR-044).
        -- automatic_backup: /v1/backup/automatic (1.6.0, ADR-048), always there.
        -- alert_choices: sealed alerts and /v1/alerts/choices (1.7.0, ADR-050), always there.
        -- scene_links: /v1/scene-links and a scene's link (1.7.0, ADR-051), always there.
        -- refrigerators: /v1/refrigerators and the scene step that switches their features (1.7.0,
        -- ADR-049), always there.
        -- people_permissions: admins and members set per person, and what each member may see and
        -- do (1.8.0, ADR-054): /v1/profiles/{id}/access, `access` in /v1/api-keys/current and
        -- /v1/profile, rooms hidden from members; always there.
        -- sonos_groups: /v1/music/{id}/group, and music scene steps that resume, set the volume
        -- and play a favorite (1.8.0, ADR-057), always there.
        -- ask_links: /v1/ask-links, open requests sealed as alerts, and a pulse that answers one
        -- (1.8.0, ADR-058), always there.
        -- camera_alerts: a camera of the project raises alerts DirectorLink passes on (1.8.0,
        -- ADR-056: the DirectorLink · Hikvision Camera driver; since 1.10.0 every camera driver of
        -- DirectorLink's camera agreement, ADR-065), so the app offers their choice.
        -- users: Settings → Users (1.9.0, ADR-061): GET /v1/users, up to five devices a user, an
        -- account's devices brought into one user, pairing codes for a chosen user, members adding
        -- and removing their own devices; always there.
        -- climate_last_mode: each thermostat's last mode (`last_mode` in /v1/thermostats), and the
        -- climate scene step that turns each AC on as it was (mode "on") (1.10.0, ADR-070); always there.
        -- scene_levels_dimmers_only: a scene's level for a room or the whole home goes to dimmers
        -- only, and switches there stay as they are (ON_OFF_ONLY; ADR-077, 2026-10-09); always there.
        features = {
            jewish_calendar = services.calendarEnabled ~= nil and services.calendarEnabled() == true,
            alarm_status = services.alarmStatusEnabled ~= nil and services.alarmStatusEnabled() == true,
            backup = true,
            sonos = services.sonosEnabled ~= nil and services.sonosEnabled() == true,
            automatic_backup = true,
            alert_choices = true,
            scene_links = true,
            refrigerators = true,
            people_permissions = true,
            sonos_groups = true,
            ask_links = true,
            camera_alerts = cameraAlerts(registry),
            users = true,
            climate_last_mode = true,
            scene_levels_dimmers_only = true,
        },
    }
end

return System
