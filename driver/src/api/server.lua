-- DirectorLink LAN API server: DriverWorks TCP server + HTTP parsing + Host check (421) + CORS +
-- API-key auth (sealed requests: handlers/sealed.lua) + routing + RFC 9457 errors + access logging.

local Json = require("src.core.json")
local Clock = require("src.core.clock")
local Http = require("src.api.http")
local Router = require("src.api.router")
local Routes = require("src.api.routes")
local Problem = require("src.api.problem")
local Response = require("src.api.response")
local Access = require("src.auth.access")
local Roles = require("src.auth.roles")
local Random = require("src.core.random")

local HANDLERS = {
    system = require("src.api.handlers.system"),
    auth = require("src.api.handlers.auth"),
    rooms = require("src.api.handlers.rooms"),
    devices = require("src.api.handlers.devices"),
    lights = require("src.api.handlers.lights"),
    thermostats = require("src.api.handlers.thermostats"),
    fans = require("src.api.handlers.fans"),
    blinds = require("src.api.handlers.blinds"),
    cameras = require("src.api.handlers.cameras"),
    relays = require("src.api.handlers.relays"),
    doorbells = require("src.api.handlers.doorbells"),
    refrigerators = require("src.api.handlers.refrigerators"),
    alarm = require("src.api.handlers.alarm"),
    music = require("src.api.handlers.music"),
    logs = require("src.api.handlers.logs"),
    remote = require("src.api.handlers.remote"),
    invitations = require("src.api.handlers.invitations"),
    profiles = require("src.api.handlers.profiles"),
    users = require("src.api.handlers.users"),
    scenes = require("src.api.handlers.scenes"),
    scene_links = require("src.api.handlers.scene_links"),
    ask_links = require("src.api.handlers.ask_links"),
    schedules = require("src.api.handlers.schedules"),
    calendar = require("src.api.handlers.calendar"),
    sealed = require("src.api.handlers.sealed"),
    backup = require("src.api.handlers.backup"),
    activity = require("src.api.handlers.activity"),
    alerts = require("src.api.handlers.alerts"),
    https = require("src.api.handlers.https"),
}

local Server = {}

Server.PORT = 41999
-- Director gives a port to the first driver that asks for it and tells the next one nothing (its own
-- log says "attempt to bind ... same port"). Some drivers take a random free port at each start (a
-- camera driver took 41999 on a real controller), so when the port is not ONLINE this long after
-- asking, DirectorLink says so, and asks again every RETRY_SECONDS until it has it: the first time
-- a minute after saying so, so that an ONLINE that is only slow comes before a second request.
Server.CHECK_SECONDS = 15
Server.RETRY_SECONDS = 60

local ALLOWED_ORIGINS = {
    ["https://app.directorlink.io"] = true,
    ["https://console.directorlink.io"] = true,
}

-- Connections that never finish a request are dropped after this many seconds.
local STALE_CONNECTION_SECONDS = 30

local router = Router.new(Routes)
local services = nil
local connections = {}
-- Connections on the Direct HTTPS server (src/api/direct_https.lua, ADR-082), by handle, for a
-- Director that does not pass the server's identifier with the data (before OS 3.3.1).
local secureHandles = {}
local listening = false
local portCheck = nil
-- True from start() to stop(): a port lost meanwhile is asked for again.
local wanted = false
-- Times the port was found taken since the last start; the error is logged the first time only.
local portTaken = 0

local function resolveHandler(name)
    local moduleName, functionName = name:match("^([%w_]+)%.([%w_]+)$")
    local module = HANDLERS[moduleName]
    return module and module[functionName]
end

for _, route in ipairs(Routes) do
    assert(resolveHandler(route.handler), "missing API handler " .. route.handler)
    -- Two roles (ADR-054): admin routes are for admins; on member routes every person may ask, and
    -- the handler answers with what they may see and do (src/auth/access.lua). The other names of
    -- 1.7.0 (viewer, doors) read as member here; scripts/check_api.py wants member or admin.
    assert(route.public or Roles.valid(route.role), "route needs a role, member or admin: " .. route.method .. " " .. route.path)
end

-- Browsers send Origin; other clients (curl, Postman, Home Assistant) do not. Only DirectorLink's
-- own sites are allowed, never localhost: a page on the same computer is not the app.
function Server.originAllowed(origin)
    if origin == nil or origin == "" then
        return true
    end
    return ALLOWED_ORIGINS[origin] == true
end

-- Local names a home network uses; a public name (DNS rebinding: a site's own name made to point
-- at the controller) is refused.
local LOCAL_SUFFIXES = { ".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain" }

-- The Host a LAN request was sent to: the controller's IP address, or a local name.
function Server.hostAllowed(host)
    if host == nil or host == "" then
        return true
    end
    host = string.lower(host)
    -- An IPv6 address, possibly IPv4-mapped (::ffff:192.168.1.5) or with a zone (%25eth0).
    local literal = host:match("^%[([^%]]+)%]:?%d*$")
    if literal then
        return literal:gsub("%%25[%w%-%._~]*$", ""):match("^[%x:%.]+$") ~= nil
    end
    local name = host:match("^([^:]+):?%d*$")
    if not name then
        return false
    end
    -- One trailing dot is the same name, fully qualified (director.local.).
    name = name:gsub("%.$", "")
    if name:match("^%d+%.%d+%.%d+%.%d+$") or name:match("^[%w%-_]+$") then
        return true
    end
    for _, suffix in ipairs(LOCAL_SUFFIXES) do
        if #name > #suffix and name:sub(-#suffix) == suffix and name:sub(1, -#suffix - 1):match("^[%w%-%._]+$") then
            return true
        end
    end
    return false
end

local function authenticate(request)
    local header = request.headers["authorization"]
    if not header then
        return nil
    end
    local scheme, token = header:match("^(%S+)%s+(%S+)%s*$")
    if not scheme or string.lower(scheme) ~= "bearer" then
        return nil
    end
    return services.keys.verify(token)
end

local function decodeBody(request)
    if request.body == nil or request.body == "" then
        return nil
    end
    local contentType = string.lower(request.headers["content-type"] or "")
    if not contentType:find("application/json", 1, true) then
        return nil, Problem.new(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json")
    end
    local value, err = Json.decode(request.body)
    if value == nil then
        return nil, Problem.new(400, "INVALID_JSON", "The request body is not valid JSON: " .. tostring(err))
    end
    return value
end

local function runHandler(route, request, params, apiKey, client)
    local body, bodyProblem = decodeBody(request)
    if bodyProblem then
        return bodyProblem.status, bodyProblem
    end

    local ctx = {
        request = request,
        params = params,
        query = request.query,
        body = body,
        apiKey = apiKey,
        client = client,
        services = services,
    }

    local ok, first, second, third = pcall(resolveHandler(route.handler), ctx)
    if not ok then
        services.log.error("api", "handler failed", {
            route = route.method .. " " .. route.path,
            error = tostring(first),
        })
        local problem = Problem.internal()
        return problem.status, problem
    end
    if Problem.is(first) then
        return first.status, first, second
    end
    return first, second, third
end

local function encode(status, payload)
    if payload == nil or status == 204 then
        return nil, ""
    end
    if Response.isRaw(payload) then
        return payload.content_type, payload.body
    end
    if type(payload) == "string" then
        return "application/json; charset=utf-8", payload
    end
    local ok, body = pcall(Json.encode, payload)
    if not ok then
        services.log.error("api", "response could not be encoded", { error = tostring(body) })
        return "application/problem+json", Json.encode(Problem.internal("The response could not be encoded")), 500
    end
    if Problem.is(payload) then
        return "application/problem+json", body
    end
    return "application/json; charset=utf-8", body
end


local function logAccess(request, route, status, client, started, apiKey)
    local level = "debug"
    if status >= 500 then
        level = "error"
    elseif status >= 400 then
        level = "info"
    end
    services.log.write(level, "api", request.method .. " " .. request.path .. " -> " .. tostring(status), {
        client = client and client.ip or Json.null,
        duration_ms = Clock.millis() - started,
        key_id = apiKey and apiKey.id or Json.null,
        tls = client and client.secure or nil,
    })
end

local function finalize(request, route, client, started, apiKey, origin, status, payload, extraHeaders)
    local contentType, body, encodeStatus = encode(status, payload)
    status = encodeStatus or status

    local headers = {}
    if origin then
        headers[#headers + 1] = { "Access-Control-Allow-Origin", origin }
        -- Lets the app and console read how long to wait after a 429 or 503.
        headers[#headers + 1] = { "Access-Control-Expose-Headers", "Retry-After" }
        headers[#headers + 1] = { "Vary", "Origin" }
    end
    headers[#headers + 1] = { "Cache-Control", "no-store" }
    headers[#headers + 1] = { "X-Content-Type-Options", "nosniff" }
    if contentType then
        headers[#headers + 1] = { "Content-Type", contentType }
    end
    for _, header in ipairs(extraHeaders or {}) do
        headers[#headers + 1] = header
    end

    logAccess(request, route, status, client, started, apiKey)
    return status, headers, body
end

-- The Host of a request that came over Direct HTTPS may also be the home's own name (ADR-082); on
-- port 41999 nothing more than Server.hostAllowed.
local function secureHostAllowed(client, host)
    return client ~= nil and client.secure == true and services.https ~= nil and services.https.hostAllowed(host) == true
end

-- Handles one parsed request and returns status, headers, body. A handler that must wait (a camera
-- snapshot) answers later: then nothing is returned and respond(status, headers, body) is called.
function Server.handleRequest(request, client, respond)
    local started = Clock.millis()
    pcall(Random.stir, tostring(started) .. "|" .. tostring(client and client.ip) .. "|" .. tostring(client and client.port))
    local origin = request.headers["origin"]
    local status, payload, extraHeaders, apiKey, route

    if not Server.originAllowed(origin) then
        status = 403
        payload = Problem.new(403, "ORIGIN_NOT_ALLOWED", "Requests from " .. tostring(origin) .. " are not allowed")
        origin = nil
    elseif not request.principal and not Server.hostAllowed(request.headers["host"])
        and not secureHostAllowed(client, request.headers["host"]) then
        status = 421
        payload = Problem.new(421, "MISDIRECTED_REQUEST", "Reach DirectorLink by the controller's IP address or its local name")
        origin = nil
    elseif request.method == "OPTIONS" then
        status = 204
        extraHeaders = {
            { "Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
            { "Access-Control-Allow-Headers", "Authorization, Content-Type" },
            { "Access-Control-Max-Age", "600" },
            { "Access-Control-Allow-Private-Network", "true" },
        }
    else
        local match = router:match(request.method, request.path)
        route = match.route
        if match.error == "not_found" then
            status = 404
            payload = Problem.new(404, "NOT_FOUND", "No API route for " .. request.path)
        elseif match.error == "method_not_allowed" then
            status = 405
            payload = Problem.new(405, "METHOD_NOT_ALLOWED", request.method .. " is not supported for " .. request.path)
            extraHeaders = { { "Allow", table.concat(match.allowed, ", ") } }
        else
            local refusal
            if not match.route.public then
                -- Sealed remote requests carry their device's key as principal (src/cloud/remote.lua);
                -- LAN requests come from the HTTP parser, which never sets one.
                apiKey = request.principal
                if not apiKey then
                    apiKey, refusal = authenticate(request)
                end
            end
            if not match.route.public and not apiKey then
                status = 401
                payload = Problem.unauthorized()
                -- A key that expired (ADR-040: the console's lasts a day) is gone now: pair again.
                if refusal == "KEY_EXPIRED" then
                    payload = Problem.new(401, "KEY_EXPIRED", "This API key expired and was removed. Get a new pairing code in Composer "
                        .. "(DirectorLink → Actions → New Pairing Code) and pair again.")
                end
                extraHeaders = { { "WWW-Authenticate", 'Bearer realm="DirectorLink"' } }
            elseif not match.route.public and match.route.role == "admin" and not Access.isAdmin(apiKey) then
                status = 403
                payload = Problem.new(403, "FORBIDDEN", match.route.method .. " " .. match.route.path
                    .. " is for the home's admins; this key's person is a member", {
                    -- The 1.7.0 role the key keeps (ADR-054), as before.
                    role = apiKey.role,
                    required_role = match.route.role,
                })
            else
                status, payload, extraHeaders = runHandler(match.route, request, match.params, apiKey, client)
            end
        end
    end

    if Response.isLater(status) then
        local answered = false
        local ok, err = pcall(status.start, function(laterStatus, laterPayload, laterHeaders)
            if answered then
                return
            end
            answered = true
            if Problem.is(laterStatus) then
                laterStatus, laterPayload, laterHeaders = laterStatus.status, laterStatus, laterPayload
            end
            if respond then
                respond(finalize(request, route, client, started, apiKey, origin, laterStatus, laterPayload, laterHeaders))
            end
        end)
        if not ok then
            services.log.error("api", "handler failed", { route = route and (route.method .. " " .. route.path), error = tostring(err) })
            if not answered then
                answered = true
                local problem = Problem.internal()
                return finalize(request, route, client, started, apiKey, origin, problem.status, problem)
            end
        end
        return nil
    end

    return finalize(request, route, client, started, apiKey, origin, status, payload, extraHeaders)
end

local function send(handle, status, headers, body)
    secureHandles[handle] = nil
    local ok, err = pcall(function()
        C4:ServerSend(handle, Http.buildResponse(status, headers, body))
        C4:ServerCloseClient(handle)
    end)
    if not ok then
        services.log.warn("api", "could not send a response", { error = tostring(err) })
    end
end

local function dropStaleConnections(now)
    for handle, connection in pairs(connections) do
        if now - connection.openedAt > STALE_CONNECTION_SECONDS then
            connections[handle] = nil
            secureHandles[handle] = nil
            pcall(function()
                C4:ServerCloseClient(handle)
            end)
        end
    end
end

function Server.init(options)
    services = options
end

local function cancelPortCheck()
    if portCheck then
        pcall(function()
            portCheck:Cancel()
        end)
        portCheck = nil
    end
end

local function askForPort()
    -- No delimiter: Director hands over data as it arrives and the parser assembles requests.
    return pcall(function()
        C4:CreateServer(Server.PORT, "", false)
    end)
end

-- If the port is not ONLINE in `seconds`, another driver holds it: say so (once), ask for it
-- again if `ask`, and check again in a minute, asking then. The server is not destroyed first:
-- Director never gave it to this driver, and DestroyServer names only a port.
local function checkPortIn(seconds, ask)
    cancelPortCheck()
    portCheck = C4:SetTimer(seconds * 1000, function()
        portCheck = nil
        if listening or not wanted then
            return
        end
        portTaken = portTaken + 1
        if portTaken == 1 then
            services.log.error("api", "the API port is taken by another driver; asking again every minute", {
                port = Server.PORT,
                retry_s = Server.RETRY_SECONDS,
            })
        end
        if services.onServerStatus then
            services.onServerStatus(false, "TAKEN")
        end
        if ask then
            askForPort()
        end
        checkPortIn(Server.RETRY_SECONDS, true)
    end)
end

function Server.start()
    if listening then
        return true
    end
    portTaken = 0
    local ok, err = askForPort()
    if not ok then
        services.log.error("api", "could not start the API server", { port = Server.PORT, error = tostring(err) })
        return false, tostring(err)
    end
    wanted = true
    checkPortIn(Server.CHECK_SECONDS, false)
    return true
end

function Server.stop()
    wanted = false
    cancelPortCheck()
    pcall(function()
        C4:DestroyServer(Server.PORT)
    end)
    listening = false
    connections = {}
    secureHandles = {}
end

function Server.isListening()
    return listening
end

function Server.onStatusChanged(port, status)
    if not services or tonumber(port) ~= Server.PORT then
        return
    end
    listening = tostring(status) == "ONLINE"
    if listening then
        cancelPortCheck()
        services.log.info("api", "API server ONLINE", { port = Server.PORT, taken_before = portTaken > 0 and portTaken or nil })
        portTaken = 0
    else
        services.log.info("api", "API server " .. tostring(status), { port = Server.PORT })
        -- Lost after it was ours (Director has not been seen doing it): asked for again.
        if wanted and not portCheck then
            checkPortIn(Server.CHECK_SECONDS, true)
        end
    end
    if services.onServerStatus then
        services.onServerStatus(listening, tostring(status))
    end
end

-- `secure`: the connection is on the Direct HTTPS server (main.lua tells by its port or identifier).
function Server.onConnectionStatusChanged(handle, _port, status, secure)
    if tostring(status) == "OFFLINE" then
        connections[handle] = nil
        secureHandles[handle] = nil
    elseif secure then
        secureHandles[handle] = true
    end
end

-- `secure`: the data came on the Direct HTTPS server (Director passed its identifier); the same
-- parsing, Host check, CORS, keys, sealing and routing as on 41999.
function Server.onData(handle, data, clientAddress, clientPort, secure)
    if not services then
        return
    end
    local now = os.time()
    local connection = connections[handle]
    if not connection then
        dropStaleConnections(now)
        connection = {
            parser = Http.newParser(),
            client = { ip = clientAddress, port = clientPort, secure = (secure or secureHandles[handle]) and true or nil },
            openedAt = now,
        }
        connections[handle] = connection
    end

    local result, value = Http.feed(connection.parser, data)
    if result == "incomplete" then
        return
    elseif result == "continue" then
        pcall(function()
            C4:ServerSend(handle, "HTTP/1.1 100 Continue\r\n\r\n")
        end)
        return
    end

    connections[handle] = nil

    if result == "error" then
        services.log.warn("api", "rejected a malformed request", {
            client = clientAddress,
            status = value.status,
            reason = value.detail,
        })
        local problem = Problem.new(value.status, value.code, value.detail)
        send(handle, problem.status, {
            { "Cache-Control", "no-store" },
            { "Content-Type", "application/problem+json" },
        }, Json.encode(problem))
        return
    end

    local status, headers, body = Server.handleRequest(value, connection.client, function(...)
        send(handle, ...)
    end)
    if status then
        send(handle, status, headers, body)
    end
end

return Server
