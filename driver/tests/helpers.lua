-- Assertions and an HTTP client that talks to the driver through OnServerDataIn.

local Json = require("src.core.json")

local T = {}

local function show(value)
    if type(value) == "string" then
        return string.format("%q", value)
    end
    if type(value) == "table" then
        local ok, encoded = pcall(Json.encode, value)
        if ok then
            return encoded
        end
    end
    return tostring(value)
end

function T.eq(actual, expected, message)
    if actual ~= expected then
        error((message or "values differ") .. ": expected " .. show(expected) .. ", got " .. show(actual), 2)
    end
end

function T.truthy(value, message)
    if not value then
        error(message or "expected a truthy value", 2)
    end
end

function T.contains(text, fragment, message)
    if type(text) ~= "string" or not text:find(fragment, 1, true) then
        error((message or "missing text") .. ": " .. show(fragment) .. " not in " .. show(text), 2)
    end
end

function T.notContains(text, fragment, message)
    if type(text) == "string" and text:find(fragment, 1, true) then
        error((message or "unexpected text") .. ": " .. show(fragment) .. " found", 2)
    end
end

function T.same(actual, expected, message)
    T.eq(Json.encode(actual), Json.encode(expected), message)
end

-- Ends a test that cannot run here (run.lua counts it as skipped and says why).
local SKIP = {}

function T.skip(reason)
    error(setmetatable({ reason = reason }, SKIP), 0)
end

function T.skipped(err)
    return type(err) == "table" and getmetatable(err) == SKIP and err.reason or nil
end

local handles = 0

-- Sends one request as raw bytes (optionally in small chunks) and parses the response.
function T.http(mock, method, path, options)
    options = options or {}
    handles = handles + 1
    local handle = handles

    local body = options.body
    if type(body) == "table" then
        body = Json.encode(body)
    end

    local lines = { method .. " " .. path .. " HTTP/1.1", "Host: " .. (options.host or "192.168.1.10:41999") }
    if options.key then
        lines[#lines + 1] = "Authorization: Bearer " .. options.key
    end
    for name, value in pairs(options.headers or {}) do
        lines[#lines + 1] = name .. ": " .. value
    end
    if body then
        lines[#lines + 1] = "Content-Type: " .. (options.contentType or "application/json")
        lines[#lines + 1] = "Content-Length: " .. #body
    end
    local raw = table.concat(lines, "\r\n") .. "\r\n\r\n" .. (body or "")

    -- options.tls: the request comes on the Direct HTTPS server (ADR-082), with its identifier as
    -- Director passes it (OS 3.3.1 and newer); "port" announces the connection on port 28443 and
    -- passes no identifier (as before OS 3.3.1).
    if options.tls == "port" then
        OnServerConnectionStatusChanged(handle, 28443, "ONLINE", options.ip or "192.168.1.50")
    end
    local identifier = options.tls == true and "https" or nil
    local size = options.chunkSize or #raw
    for index = 1, #raw, size do
        OnServerDataIn(handle, raw:sub(index, index + size - 1), options.ip or "192.168.1.50", "50123", identifier)
    end

    return T.response(mock, handle)
end

-- The answer sent on connection `handle` so far (a handler that answers later: read it again).
function T.response(mock, handle)
    local response = mock.sent[handle]
    if not response then
        return { status = nil, closed = mock.closed[handle], handle = handle }
    end
    local head, payload = response:match("^(.-)\r\n\r\n(.*)$")
    local headers = {}
    for name, value in head:gmatch("\r\n([^:\r\n]+): ([^\r\n]*)") do
        headers[string.lower(name)] = value
    end
    local result = {
        status = tonumber(head:match("^HTTP/1%.1 (%d+)")),
        headers = headers,
        body = payload,
        closed = mock.closed[handle],
    }
    if payload ~= "" and tostring(headers["content-type"] or ""):find("json", 1, true) then
        result.json = Json.decode(payload)
    end
    return result
end

-- Pairs with the code currently shown in the Composer property and returns the API key.
-- Pairs like a homeowner: creates a code with the Composer action when none is active, then
-- sends it as Composer shows it ("1234 5678").
function T.pair(mock, name)
    if not tostring(mock.properties["Pairing Code"] or ""):match("^%d%d%d%d %d%d%d%d$") then
        ExecuteCommand("LUA_ACTION", { ACTION = "NEW_PAIRING_CODE" })
    end
    local response = T.http(mock, "POST", "/v1/auth/pair", {
        body = { pairing_code = mock.properties["Pairing Code"], name = name or "Test client" },
    })
    T.eq(response.status, 201, "pairing should succeed")
    return response.json.key, response
end

return T
