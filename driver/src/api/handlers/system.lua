local Json = require("src.core.json")
local Clock = require("src.core.clock")
local Version = require("src.core.version")
local Problem = require("src.api.problem")

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

local function rounded(value)
    if type(value) ~= "number" then
        return Json.null
    end
    return math.floor(value * 100 + 0.5) / 100
end

function System.info(ctx)
    local admin = ctx.apiKey and ctx.apiKey.role == "admin"
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
        inventory = {
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
        },
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
        features = {
            jewish_calendar = services.calendarEnabled ~= nil and services.calendarEnabled() == true,
            alarm_status = services.alarmStatusEnabled ~= nil and services.alarmStatusEnabled() == true,
            backup = true,
            sonos = services.sonosEnabled ~= nil and services.sonosEnabled() == true,
            automatic_backup = true,
            alert_choices = true,
            scene_links = true,
            refrigerators = true,
        },
    }
end

return System
