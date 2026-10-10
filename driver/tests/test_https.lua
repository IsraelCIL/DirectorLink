-- Direct HTTPS (1.12.0 test build, ADR-082): with Composer's Direct HTTPS Allowed, the controller
-- makes a key and a CSR for a name of its own under dlhome.cc, once; an admin gives back the
-- certificate, and the API is then served over TLS on port 28443 exactly as on 41999, the Host
-- check also taking the name there. Off (the default) makes nothing and stops the server; the key
-- never leaves the controller's store.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")
local X509Fake = require("x509_fake")

local tests = {}

local PORT = 28443
local FUTURE = "2049-12-31T00:00:00Z"
local INTERMEDIATE = X509Fake.pem(X509Fake.certificate({ point = X509Fake.point(7), names = {}, subject_cn = "E5", issuer_cn = "ISRG Root X1" }), "CERTIFICATE")

local function allowed(m)
    Properties["Direct HTTPS"] = "Allowed"
    return m
end

local function start(isAllowed, prepare)
    local mock = Mock.startDriver(nil, nil, nil, function(m)
        if isAllowed then
            allowed(m)
        end
        if prepare then
            prepare(m)
        end
    end)
    return mock, T.pair(mock, "Owner's laptop")
end

-- A driver update in Composer: the stored data and the Composer properties stay.
local function reload(previous, prepare)
    local properties = {}
    for name, value in pairs(Properties) do
        properties[name] = value
    end
    return Mock.startDriver(nil, nil, "DIT_UPDATING", function(m)
        m.uuidCount = previous.uuidCount
        for name, value in pairs(previous.persist) do
            m.persist[name] = value
        end
        for name, value in pairs(properties) do
            Properties[name] = value
        end
        if prepare then
            prepare(m)
        end
    end)
end

local function setProperty(name, value)
    Properties[name] = value
    OnPropertyChanged(name)
end

local function status(mock, key, query)
    local answer = T.http(mock, "GET", "/v1/https" .. (query or ""), { key = key })
    T.eq(answer.status, 200, answer.body)
    return answer.json
end

-- The SubjectPublicKeyInfo of the CSR the controller made, for a certificate issued for it.
local function requestedKey(csr)
    local X509 = require("src.core.x509")
    return X509.readRequest(X509.pemBlocks(csr, "CERTIFICATE REQUEST")[1]).spki
end

local function certificateFor(mock, key, options)
    options = options or {}
    local current = status(mock, key, "?csr=true")
    return X509Fake.pem(X509Fake.certificate({
        spki = options.spki or requestedKey(current.csr),
        names = options.names or { current.name },
        issuer_cn = options.issuer_cn or "E5",
        not_after = options.not_after or FUTURE,
        serial = options.serial,
    }), "CERTIFICATE"), current.name
end

local function install(mock, key, body)
    return T.http(mock, "PUT", "/v1/https/certificate", { key = key, body = body })
end

-- Allowed, with a certificate installed and the TLS server ONLINE. Returns mock, key, name, leaf.
local function listening()
    local mock, key = start(true)
    local leaf, name = certificateFor(mock, key)
    local answer = install(mock, key, { certificate = leaf, chain = INTERMEDIATE })
    T.eq(answer.status, 200, answer.body)
    OnServerStatusChanged(PORT, "ONLINE", "https")
    return mock, key, name, leaf
end

-- What the driver wrote to Director's log (every entry of the API's log goes there too).
local function logText(mock)
    return table.concat(mock.debugLog, "\n")
end

-- ---- off ------------------------------------------------------------------------------------------

function tests.off_by_default_makes_no_key_and_no_server()
    local mock, key = start(false)
    T.eq(#mock.csrCalls, 0, "no key is made while Direct HTTPS is Off")
    T.eq(#mock.tlsCalls, 0)
    T.eq(mock.persist.directorlink_https, nil)
    T.eq(mock.properties["Direct HTTPS Status"], "Off")
    T.same(status(mock, key), {
        enabled = false, name = Json.null, port = PORT, state = "off", csr = Json.null, certificate = Json.null,
        error = Json.null, warning = Json.null,
    })
    local put = install(mock, key, { certificate = INTERMEDIATE, chain = INTERMEDIATE })
    T.eq(put.status, 409)
    T.eq(put.json.code, "HTTPS_OFF")
    local renew = T.http(mock, "POST", "/v1/https/new-key", { key = key })
    T.eq(renew.status, 409)
    T.eq(renew.json.code, "HTTPS_OFF")
    T.eq(#mock.csrCalls, 0)
    T.eq(mock.servers[41999] ~= nil, true, "the API's own server is there as always")
end

-- ---- the key and its CSR --------------------------------------------------------------------------

function tests.allowed_makes_a_name_key_and_csr_once_and_keeps_them_across_reloads()
    local mock, key = start(true)
    T.eq(#mock.csrCalls, 1)
    local call = mock.csrCalls[1]
    local current = status(mock, key)
    local name = current.name
    T.truthy(name:match("^[a-z2-7]+%.dlhome%.cc$") and #name == 20 + #".dlhome.cc", name)
    T.eq(call.digest, "SHA256")
    T.eq(call.curve, "prime256v1")
    T.eq(call.subject, "/CN=" .. name)
    -- No subjectAltName: Director writes it as raw text, which Let's Encrypt refuses.
    T.eq(call.extensions == nil or next(call.extensions) == nil, true)
    T.eq(current.enabled, true)
    T.eq(current.state, "waiting_for_certificate")
    T.contains(current.csr, "-----BEGIN CERTIFICATE REQUEST-----")
    T.eq(current.certificate, Json.null)
    T.eq(current.warning, Json.null)
    T.eq(#mock.tlsCalls, 0, "no TLS server without a certificate")
    T.eq(mock.properties["Direct HTTPS Status"], "Waiting for a certificate for " .. name)

    -- A driver update keeps the name, the key and the CSR.
    local again = reload(mock)
    local againKey = T.pair(again, "Owner's phone")
    T.eq(#again.csrCalls, 0, "no new key at a reload")
    local after = status(again, againKey)
    T.eq(after.name, name)
    T.eq(after.csr, current.csr)

    -- Off and Allowed again: still the same.
    setProperty("Direct HTTPS", "Off")
    setProperty("Direct HTTPS", "Allowed")
    T.eq(#again.csrCalls, 0)
    T.eq(status(again, againKey).csr, current.csr)

    -- Two controllers get two names.
    local other, otherKey = start(true, function(m)
        m.uuidCount = 500
    end)
    T.truthy(status(other, otherKey).name ~= name, "a second controller has a name of its own")
end

function tests.the_csr_is_shown_while_waiting_or_when_asked_for()
    local mock, key, name = listening()
    local current = status(mock, key)
    T.eq(current.state, "listening")
    T.eq(current.csr, Json.null, "with a certificate, the CSR only when asked for")
    T.contains(status(mock, key, "?csr=true").csr, "BEGIN CERTIFICATE REQUEST")
    T.eq(T.http(mock, "GET", "/v1/https?csr=yes", { key = key }).status, 400)
    T.eq(current.name, name)
end

function tests.the_private_key_never_leaves_the_store()
    local mock, key = listening()
    local secret = mock.privateKeys[1]
    local body = secret:match("%-%-%-%-%-\n(.-)\n%-%-%-%-%-END")
    T.truthy(body and #body > 8)
    local answers = {
        T.http(mock, "GET", "/v1/https", { key = key }).body,
        T.http(mock, "GET", "/v1/https?csr=true", { key = key }).body,
        T.http(mock, "GET", "/v1/logs", { key = key }).body,
        T.http(mock, "GET", "/v1/system", { key = key }).body,
        install(mock, key, { certificate = (certificateFor(mock, key)), chain = INTERMEDIATE }).body,
        logText(mock),
        Json.encode(mock.properties),
        table.concat(mock.debugLog, "\n"),
        Json.encode(require("src.core.backup").export(require("src.core.registry"))),
    }
    for index, text in ipairs(answers) do
        T.notContains(text, body, "answer " .. index)
        T.notContains(text, "PRIVATE KEY", "answer " .. index)
    end
    -- Only Direct HTTPS's own store holds it.
    for name, value in pairs(mock.persist) do
        if name ~= "directorlink_https" then
            T.notContains(tostring(value), body, name)
        end
    end
    T.contains(mock.persist.directorlink_https, body)
    -- A new key goes out of the answer too.
    local renewed = T.http(mock, "POST", "/v1/https/new-key", { key = key })
    T.eq(renewed.status, 200, renewed.body)
    T.notContains(renewed.body, "PRIVATE KEY")
end

function tests.an_os_without_the_private_key_says_it_is_not_supported()
    local mock, key = start(true, function(m)
        m.csrMode = "csr_only"
    end)
    local current = status(mock, key)
    T.eq(current.state, "error")
    T.contains(current.error, "not supported on this OS")
    T.contains(mock.properties["Direct HTTPS Status"], "Error: not supported on this OS")
    T.eq(mock.persist.directorlink_https, nil, "nothing stored")
    local put = install(mock, key, { certificate = INTERMEDIATE, chain = INTERMEDIATE })
    T.eq(put.status, 409)
    T.eq(put.json.code, "HTTPS_NO_KEY")
    T.eq(#mock.tlsCalls, 0)

    local missing, missingKey = start(true, function()
        C4.GenerateCSR_ECC = nil
    end)
    T.contains(status(missing, missingKey).error, "not supported on this OS")

    local failing, failingKey = start(true, function(m)
        m.csrMode = "fail"
    end)
    T.contains(status(failing, failingKey).error, "EC key generation failed")
    local renew = T.http(failing, "POST", "/v1/https/new-key", { key = failingKey })
    T.eq(renew.status, 503)
    T.eq(renew.json.code, "HTTPS_KEY_FAILED")
end

function tests.a_csr_with_the_curve_by_its_parameters_is_flagged()
    local mock, key = start(true, function(m)
        m.csrMode = "explicit"
    end)
    local current = status(mock, key)
    T.eq(current.state, "waiting_for_certificate")
    T.contains(current.warning, "Let's Encrypt refuse")
end

-- ---- the certificate and the TLS server ----------------------------------------------------------

function tests.a_certificate_starts_the_tls_server_with_tls_1_2_or_1_3_and_no_client_certificates()
    local mock, key = start(true)
    local leaf, name = certificateFor(mock, key)
    local answer = install(mock, key, { certificate = leaf, chain = INTERMEDIATE })
    T.eq(answer.status, 200, answer.body)
    T.eq(answer.json.state, "starting")
    T.same(answer.json.certificate, { not_after = FUTURE, issuer_cn = "E5" })
    T.eq(#mock.tlsCalls, 1)
    local server = mock.tlsCalls[1]
    T.eq(server.port, PORT)
    T.eq(server.delimiter, "")
    T.eq(server.options, 0, "TLS 1.2 and 1.3 (Director's default)")
    T.eq(server.verifyMode, 1, "no client certificate asked for (0 would ask)")
    T.eq(server.cipherList, "")
    T.eq(server.certificate, leaf)
    T.eq(server.privateKey, mock.privateKeys[1])
    T.eq(server.password, "")
    T.eq(server.chain, INTERMEDIATE)
    T.eq(server.identifier, "https")
    T.contains(mock.properties["Direct HTTPS Status"], "Starting on " .. name .. ":28443")

    OnServerStatusChanged(PORT, "ONLINE", "https")
    T.eq(status(mock, key).state, "listening")
    T.eq(mock.properties["Direct HTTPS Status"], "Listening on " .. name .. ":28443, certificate until " .. FUTURE)
    T.eq(mock.properties["API Status"], "Online - port 41999", "the API's own status is the plain server's")
    local log = logText(mock)
    T.contains(log, "TLS server started")
    T.contains(log, "certificate installed")
    T.contains(log, FUTURE)
    T.notContains(log, "BEGIN CERTIFICATE", "never a certificate's text in the log")

    -- fullchain.pem as the certificate, without chain, is the same.
    local fullchain, fullchainKey = start(true)
    local fullLeaf = certificateFor(fullchain, fullchainKey)
    local full = install(fullchain, fullchainKey, { certificate = fullLeaf .. INTERMEDIATE })
    T.eq(full.status, 200, full.body)
    T.eq(fullchain.tlsCalls[1].certificate, fullLeaf)
    T.eq(fullchain.tlsCalls[1].chain, INTERMEDIATE)
end

function tests.a_second_certificate_recreates_the_server()
    local mock, key = listening()
    local destroyedBefore = #mock.destroyedServers
    local leaf = certificateFor(mock, key, { serial = 2 })
    local answer = install(mock, key, { certificate = leaf, chain = INTERMEDIATE })
    T.eq(answer.status, 200, answer.body)
    T.eq(#mock.destroyedServers, destroyedBefore + 1)
    T.eq(mock.destroyedServers[#mock.destroyedServers], PORT, "only the TLS server, by its port")
    T.eq(#mock.tlsCalls, 2)
    T.eq(mock.tlsCalls[2].certificate, leaf)
    T.eq(mock.tlsServers[PORT], mock.tlsCalls[2])
    T.truthy(mock.servers[41999], "the API's own server stays")
    T.eq(answer.json.state, "starting")
    -- The old server's OFFLINE, then the new one's ONLINE.
    OnServerStatusChanged(PORT, "OFFLINE", "https")
    OnServerStatusChanged(PORT, "ONLINE", "https")
    T.eq(status(mock, key).state, "listening")
end

function tests.a_certificate_survives_a_reload()
    local mock, key, name = listening()
    local again = reload(mock)
    T.eq(#again.csrCalls, 0)
    T.eq(#again.tlsCalls, 1, "the TLS server starts again at load")
    T.eq(again.tlsCalls[1].certificate, mock.tlsCalls[1].certificate)
    T.eq(again.tlsCalls[1].privateKey, mock.privateKeys[1])
    OnServerStatusChanged(PORT, "ONLINE", "https")
    local againKey = T.pair(again, "Again")
    T.eq(status(again, againKey).state, "listening")
    T.eq(T.http(again, "GET", "/v1/health", { tls = true, host = name .. ":28443" }).status, 200)
    T.truthy(key)
end

function tests.wrong_certificates_are_refused_and_start_nothing()
    local mock, key = start(true)
    local current = status(mock, key, "?csr=true")
    local name = current.name
    local function refused(body, statusCode, code, field)
        local answer = install(mock, key, body)
        T.eq(answer.status, statusCode, answer.body)
        T.eq(answer.json.code, code, answer.body)
        if field then
            T.eq(answer.json.errors[1].field, field)
        end
    end
    local otherKey = X509Fake.pem(X509Fake.certificate({ point = X509Fake.point(4242), names = { name }, not_after = FUTURE }), "CERTIFICATE")
    refused({ certificate = otherKey, chain = INTERMEDIATE }, 422, "CERTIFICATE_KEY_MISMATCH")
    local otherName = certificateFor(mock, key, { names = { "abcdefghijabcdefghij.dlhome.cc" } })
    refused({ certificate = otherName, chain = INTERMEDIATE }, 422, "CERTIFICATE_NAME_MISMATCH")
    local expired = certificateFor(mock, key, { not_after = "2020-01-01T00:00:00Z" })
    refused({ certificate = expired, chain = INTERMEDIATE }, 422, "CERTIFICATE_EXPIRED")
    local good = certificateFor(mock, key)
    refused({ certificate = good }, 400, "INVALID_FIELD", "chain")
    refused({ certificate = "hello", chain = INTERMEDIATE }, 400, "INVALID_FIELD", "certificate")
    refused({ certificate = "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n", chain = INTERMEDIATE }, 400, "INVALID_FIELD", "certificate")
    refused({ certificate = X509Fake.pem("not der", "CERTIFICATE"), chain = INTERMEDIATE }, 400, "INVALID_FIELD", "certificate")
    refused({ certificate = good, chain = 5 }, 400, "INVALID_FIELD", "chain")
    refused({ certificate = good, chain = INTERMEDIATE, key = "x" }, 400, "INVALID_FIELD", "key")
    refused({ chain = INTERMEDIATE }, 400, "INVALID_FIELD", "certificate")
    T.eq(#mock.tlsCalls, 0)
    T.eq(status(mock, key).state, "waiting_for_certificate")

    -- A wildcard for the name's parent covers it.
    local wildcard = certificateFor(mock, key, { names = { "*.dlhome.cc" } })
    T.eq(install(mock, key, { certificate = wildcard, chain = INTERMEDIATE }).status, 200)
end

function tests.a_tls_server_that_fails_to_start_says_why()
    local mock, key = start(true, function(m)
        m.tlsFails = "bind failed"
    end)
    local answer = install(mock, key, { certificate = (certificateFor(mock, key)), chain = INTERMEDIATE })
    T.eq(answer.status, 200, answer.body)
    T.eq(answer.json.state, "error")
    T.contains(answer.json.error, "bind failed")
    T.contains(mock.properties["Direct HTTPS Status"], "Error: the TLS server could not be started: bind failed")
    T.contains(logText(mock), "TLS server failed")
end

function tests.a_new_key_forgets_the_certificate_and_keeps_the_name()
    local mock, key, name, leaf = listening()
    local renewed = T.http(mock, "POST", "/v1/https/new-key", { key = key })
    T.eq(renewed.status, 200, renewed.body)
    T.eq(renewed.json.name, name)
    T.eq(renewed.json.state, "waiting_for_certificate")
    T.eq(renewed.json.certificate, Json.null)
    T.contains(renewed.json.csr, "BEGIN CERTIFICATE REQUEST")
    T.eq(#mock.csrCalls, 2)
    T.eq(mock.csrCalls[2].subject, "/CN=" .. name)
    T.eq(mock.tlsServers[PORT], nil, "the TLS server stopped")
    -- The old certificate is for the old key.
    local old = install(mock, key, { certificate = leaf, chain = INTERMEDIATE })
    T.eq(old.status, 422)
    T.eq(old.json.code, "CERTIFICATE_KEY_MISMATCH")
    local fresh = install(mock, key, { certificate = (certificateFor(mock, key)), chain = INTERMEDIATE })
    T.eq(fresh.status, 200, fresh.body)
    T.eq(mock.tlsServers[PORT].privateKey, mock.privateKeys[2])
end

-- ---- requests on the TLS server -------------------------------------------------------------------

function tests.a_request_on_the_tls_server_is_answered_as_on_41999()
    local mock, key, name = listening()
    local host = name .. ":28443"
    local plain = T.http(mock, "GET", "/v1/system", { key = key })
    local secure = T.http(mock, "GET", "/v1/system", { key = key, tls = true, host = host })
    T.eq(secure.status, 200, secure.body)
    T.eq(plain.status, 200)
    T.eq(secure.json.version, plain.json.version)
    T.eq(secure.headers["content-type"], plain.headers["content-type"])
    T.eq(secure.closed, true)
    -- No key: 401, as on 41999.
    T.eq(T.http(mock, "GET", "/v1/lights", { tls = true, host = host }).status, 401)
    -- The app's preflight and CORS from app.directorlink.io.
    local origin = { Origin = "https://app.directorlink.io", ["Access-Control-Request-Private-Network"] = "true" }
    local preflight = T.http(mock, "OPTIONS", "/v1/sealed", { tls = true, host = host, headers = origin })
    T.eq(preflight.status, 204)
    T.eq(preflight.headers["access-control-allow-origin"], "https://app.directorlink.io")
    T.eq(preflight.headers["access-control-allow-private-network"], "true")
    local health = T.http(mock, "GET", "/v1/health", { tls = true, host = host, headers = { Origin = "https://app.directorlink.io" } })
    T.eq(health.status, 200)
    T.eq(health.headers["access-control-allow-origin"], "https://app.directorlink.io")
    T.eq(T.http(mock, "GET", "/v1/health", { tls = true, host = host, headers = { Origin = "https://evil.example" } }).status, 403)
    -- A Director that gives no identifier (before OS 3.3.1): the connection's port says it.
    T.eq(T.http(mock, "GET", "/v1/system", { key = key, tls = "port", host = host }).status, 200)
    T.contains(logText(mock), '"tls":true')
end

function tests.the_host_check_takes_the_name_only_on_the_tls_server()
    local mock, key, name = listening()
    for _, host in ipairs({ name, name .. ":28443", string.upper(name) .. ":28443", "192.168.1.10:28443", "director.local:28443" }) do
        T.eq(T.http(mock, "GET", "/v1/health", { tls = true, host = host }).status, 200, host)
    end
    for _, host in ipairs({ "other.dlhome.cc", "x" .. name, name .. ":41999", name .. ".", "dlhome.cc", "evil.example:28443" }) do
        local answer = T.http(mock, "GET", "/v1/health", { tls = true, host = host })
        T.eq(answer.status, 421, host)
        T.eq(answer.json.code, "MISDIRECTED_REQUEST")
    end
    -- Port 41999 takes nothing new.
    for _, host in ipairs({ name, name .. ":28443", name .. ":41999" }) do
        T.eq(T.http(mock, "GET", "/v1/health", { host = host }).status, 421, host)
    end
    T.eq(T.http(mock, "GET", "/v1/system", { key = key, host = name }).status, 421)
end

function tests.the_host_check_takes_no_name_before_there_is_one()
    local mock = start(false)
    T.eq(T.http(mock, "GET", "/v1/health", { tls = true, host = "abcdefghijabcdefghij.dlhome.cc" }).status, 421)
end

-- ---- who and when ---------------------------------------------------------------------------------

function tests.members_are_refused()
    local mock, key = listening()
    local created = T.http(mock, "POST", "/v1/api-keys", { key = key, body = { name = "Kid's phone", role = "member" } })
    T.eq(created.status, 201, created.body)
    local member = created.json.key
    for _, call in ipairs({
        { "GET", "/v1/https" },
        { "PUT", "/v1/https/certificate", { certificate = INTERMEDIATE, chain = INTERMEDIATE } },
        { "POST", "/v1/https/new-key" },
    }) do
        local answer = T.http(mock, call[1], call[2], { key = member, body = call[3] })
        T.eq(answer.status, 403, call[1] .. " " .. call[2])
        T.eq(answer.json.code, "FORBIDDEN")
        T.notContains(answer.body, "BEGIN CERTIFICATE REQUEST")
    end
    T.eq(T.http(mock, "GET", "/v1/https").status, 401)
    T.eq(#mock.csrCalls, 1)
    T.eq(#mock.tlsCalls, 1)
end

function tests.off_stops_the_server_and_keeps_the_key()
    local mock, key, name = listening()
    local stored = mock.persist.directorlink_https
    setProperty("Direct HTTPS", "Off")
    T.eq(mock.tlsServers[PORT], nil)
    T.eq(mock.destroyedServers[#mock.destroyedServers], PORT)
    T.truthy(mock.servers[41999], "the API's own server stays")
    T.eq(mock.properties["Direct HTTPS Status"], "Off")
    local current = status(mock, key)
    T.eq(current.state, "off")
    T.eq(current.enabled, false)
    T.eq(current.name, name)
    T.eq(mock.persist.directorlink_https, stored, "the key and certificate stay for the next time")
    T.eq(T.http(mock, "GET", "/v1/health", { tls = true, host = name }).status, 200,
        "a request already on its way is still answered")
    OnServerStatusChanged(PORT, "OFFLINE", "https")
    T.eq(status(mock, key).state, "off")
    T.contains(logText(mock), "TLS server stopped")

    -- Allowed again: the same key and certificate, no new CSR.
    setProperty("Direct HTTPS", "Allowed")
    T.eq(#mock.csrCalls, 1)
    T.eq(#mock.tlsCalls, 2)
    T.eq(mock.tlsCalls[2].certificate, mock.tlsCalls[1].certificate)
    OnServerStatusChanged(PORT, "ONLINE", "https")
    T.eq(status(mock, key).state, "listening")
end

function tests.the_switch_is_in_the_history()
    local mock, key = start(false)
    setProperty("Direct HTTPS", "Allowed")
    local history = T.http(mock, "GET", "/v1/activity", { key = key })
    T.eq(history.status, 200, history.body)
    T.contains(history.body, "Direct HTTPS")
end

return tests
