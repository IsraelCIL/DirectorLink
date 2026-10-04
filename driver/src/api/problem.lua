-- RFC 9457 Problem Details with a stable machine-readable `code`.

local Json = require("src.core.json")
local Http = require("src.api.http")

local Problem = {}
Problem.__index = Problem

function Problem.new(status, code, detail, extra)
    local problem = {
        type = "about:blank",
        title = Http.statusText(status),
        status = status,
        code = code,
        detail = detail,
    }
    for key, value in pairs(extra or {}) do
        problem[key] = value
    end
    return setmetatable(problem, Problem)
end

function Problem.is(value)
    return type(value) == "table" and getmetatable(value) == Problem
end

function Problem.invalidRequest(detail)
    return Problem.new(400, "INVALID_REQUEST", detail)
end

function Problem.invalidField(field, message)
    return Problem.new(400, "INVALID_FIELD", message, {
        errors = Json.array({ { field = field, message = message } }),
    })
end

function Problem.invalidParameter(name, message)
    return Problem.new(400, "INVALID_PARAMETER", message, {
        errors = Json.array({ { field = name, message = message } }),
    })
end

function Problem.notFound(what, id)
    return Problem.new(404, "NOT_FOUND", what .. " " .. tostring(id) .. " does not exist")
end

function Problem.unauthorized()
    return Problem.new(401, "UNAUTHORIZED", "A valid API key is required: send Authorization: Bearer <api key>")
end

function Problem.internal(detail)
    return Problem.new(500, "INTERNAL_ERROR", detail or "The request failed inside DirectorLink; see GET /v1/logs")
end

-- Adapter errors use internal codes; translate them to API problems.
local ADAPTER_ERRORS = {
    DEVICE_NOT_FOUND = { 404, "NOT_FOUND" },
    DEVICE_NOT_SUPPORTED = { 409, "NOT_SUPPORTED" },
    ACTION_NOT_SUPPORTED = { 409, "NOT_SUPPORTED" },
    -- Shades that only open and close fully, or cannot stop (their proxy's setup says so).
    POSITION_NOT_SUPPORTED = { 409, "POSITION_NOT_SUPPORTED" },
    STOP_NOT_SUPPORTED = { 409, "STOP_NOT_SUPPORTED" },
    HVAC_MODE_NOT_SUPPORTED = { 409, "MODE_NOT_SUPPORTED" },
    -- A refrigerator feature its model does not have (ADR-049).
    FEATURE_NOT_SUPPORTED = { 409, "FEATURE_NOT_SUPPORTED" },
    INVALID_FEATURE = { 400, "INVALID_FIELD" },
    INVALID_BRIGHTNESS = { 400, "INVALID_FIELD" },
    INVALID_SPEED = { 400, "INVALID_FIELD" },
    INVALID_HVAC_MODE = { 400, "INVALID_FIELD" },
    INVALID_FAN_MODE = { 400, "INVALID_FIELD" },
    INVALID_TEMPERATURE = { 400, "INVALID_FIELD" },
    CONTROL4_COMMAND_FAILED = { 502, "CONTROLLER_COMMAND_FAILED" },
    COMMAND_FAILED = { 502, "CONTROLLER_COMMAND_FAILED" },
}

function Problem.fromAdapter(failure)
    failure = failure or {}
    local mapped = ADAPTER_ERRORS[failure.code]
    if not mapped then
        return Problem.internal(failure.message)
    end
    return Problem.new(mapped[1], mapped[2], failure.message)
end

return Problem
