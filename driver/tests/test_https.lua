-- Direct HTTPS (1.12.0, ADR-082): the installer allows it in Composer, the home's owner turns it on
-- (PUT /v1/https); the controller then makes its name and key once, asks DirectorLink's servers for
-- a certificate over the relay's connection (docs/RELAY.md: https_certificate, https), keeps one
-- only for its own key and name, and serves the API over TLS on port 28443 exactly as on 41999. It
-- asks again when a third of the certificate's lifetime is left, tells the Worker its address when
-- it changes, and has the name's record deleted when it is turned off. The key never leaves the
-- controller's store.

local Mock = require("c4mock")
local T = require("helpers")
local Json = require("src.core.json")
local X509Fake = require("x509_fake")
local Harness = require("relay_harness")

local tests = {}

local PORT = 28443
local DAY = 86400
local INTERMEDIATE = X509Fake.pem(X509Fake.certificate({ point = X509Fake.point(7), names = {}, subject_cn = "YE1", issuer_cn = "Root YE" }), "CERTIFICATE")

local function iso(seconds)
    return os.date("!%Y-%m-%dT%H:%M:%SZ", seconds)
end

-- ---- a home ---------------------------------------------------------------------------------------

local function sentMessages(s)
    local out = {}
    for _, frame in ipairs(Harness.clientFrames(s.connection.sent)) do
        local message = Json.decode(frame.payload)
        if type(message) == "table" then
            out[#out + 1] = message
        end
    end
    s.connection.sent = ""
    return out
end

-- The Direct HTTPS messages the driver sent since the last look (https_certificate, https).
local function httpsMessages(s)
    local out = {}
    for _, message in ipairs(sentMessages(s)) do
        if message.type == "https_certificate" or message.type == "https" then
            out[#out + 1] = message
        end
    end
    return out
end

local function relaySays(s, message)
    s.connection.sent = s.connection.sent or ""
    Harness.relaySays(message)
end

-- The relay says what it does on this connection.
local function relayFeatures(s, features)
    relaySays(s, { type = "relay_features", id = "f-" .. tostring(math.random(1e6)), features = features or { "alert_acks", "https" } })
end

local function claim(s)
    local made = T.http(s.mock, "POST", "/v1/remote/claim", { key = s.key })
    T.eq(made.status, 201, made.body)
    local answer = Harness.relayRequest(s.mock, s.connection, { type = "claim", id = "claim-1", token = made.json.claim_token })
    T.eq(answer.ok, true, "the home is claimed")
end

-- A driver with Direct HTTPS Allowed (options.allowed false: Off), paired (the owner's key), with
-- Remote Access on and connected to the fake relay (options.remote false: off), the home claimed
-- (options.claimed false: not), and the relay saying it issues certificates (options.features: its
-- list; false: it says nothing yet).
local function home(options)
    options = options or {}
    local mock = Mock.startDriver(nil, nil, options.initType, function(m)
        if options.allowed ~= false then
            Properties["Direct HTTPS"] = "Allowed"
        end
        if options.prepare then
            options.prepare(m)
        end
    end)
    local s = { mock = mock }
    s.key = options.key or T.pair(mock, "Owner's laptop")
    if options.remote ~= false then
        local _, connection = Harness.connected({ mock = mock })
        s.connection = connection
        if options.claimed ~= false then
            claim(s)
        end
        if options.features ~= false then
            relayFeatures(s, options.features or nil)
        end
        s.connection.sent = ""
    end
    return s
end

local function status(s, key)
    local answer = T.http(s.mock, "GET", "/v1/https", { key = key or s.key })
    T.eq(answer.status, 200, answer.body)
    return answer.json
end

local function switch(s, on, key)
    return T.http(s.mock, "PUT", "/v1/https", { key = key or s.key, body = { enabled = on } })
end

local function setProperty(name, value)
    Properties[name] = value
    OnPropertyChanged(name)
end

-- The SubjectPublicKeyInfo of a PEM CSR, for a certificate issued for it.
local function requestedKey(csr)
    local X509 = require("src.core.x509")
    return X509.readRequest(X509.pemBlocks(csr, "CERTIFICATE REQUEST")[1]).spki
end

-- A certificate for the CSR the driver sent (`asked`), valid from `from` to `to` (Unix seconds:
-- 90 days from yesterday by default); options.spki, names, issuer_cn.
local function certificateFor(asked, options)
    options = options or {}
    local from = options.from or (os.time() - DAY)
    local to = options.to or (from + 90 * DAY)
    return X509Fake.pem(X509Fake.certificate({
        spki = options.spki or requestedKey(asked.csr),
        names = options.names or { asked.name },
        issuer_cn = options.issuer_cn or "YE1",
        not_before = iso(from),
        not_after = iso(to),
        serial = options.serial,
    }), "CERTIFICATE"), iso(to)
end

-- Turns it on as the owner and returns the request for a certificate the driver sent.
local function turnOn(s)
    local answer = switch(s, true)
    T.eq(answer.status, 200, answer.body)
    local sent = httpsMessages(s)
    T.eq(#sent, 1, "one request for a certificate")
    T.eq(sent[1].type, "https_certificate")
    return sent[1], answer.json
end

local function issued(s, asked, options)
    local leaf, notAfter = certificateFor(asked, options)
    relaySays(s, { type = "https_certificate_result", id = (options and options.id) or asked.id, ok = true, status = "issued",
        name = asked.name, certificate = leaf, chain = (options and options.chain) or INTERMEDIATE, not_after = notAfter })
    return leaf, notAfter
end

-- On, with a certificate (options as certificateFor) and the TLS server ONLINE. Returns s, the
-- request, the leaf and its end.
local function listening(options)
    local s = home(options)
    local asked = turnOn(s)
    relaySays(s, { type = "https_certificate_result", id = asked.id, ok = true, status = "pending" })
    local leaf, notAfter = issued(s, asked, options)
    OnServerStatusChanged(PORT, "ONLINE", "https")
    T.eq(status(s).state, "listening")
    s.connection.sent = ""
    return s, asked, leaf, notAfter
end

-- Director's timers of Direct HTTPS: the repeating tick, or the one-shot ones (retries, waits).
local function httpsTimers(mock, repeating)
    local found = {}
    for _, timer in ipairs(mock.timers) do
        if not timer.fired and not timer.cancelled and (timer.source or ""):find("direct_https", 1, true)
            and (timer.repeating == true) == (repeating == true) then
            found[#found + 1] = timer
        end
    end
    return found
end

local function tick(mock)
    local timers = httpsTimers(mock, true)
    T.eq(#timers, 1, "one repeating timer")
    T.eq(timers[1].delay, 600 * 1000, "every 10 minutes")
    timers[1].callback()
end

-- The one-shot timer of Direct HTTPS with this delay (seconds), fired.
local function fire(mock, seconds)
    for _, timer in ipairs(httpsTimers(mock, false)) do
        if timer.delay == seconds * 1000 then
            timer.fired = true
            timer.callback()
            return
        end
    end
    local delays = {}
    for _, timer in ipairs(httpsTimers(mock, false)) do
        delays[#delays + 1] = tostring(timer.delay / 1000)
    end
    error("no Direct HTTPS timer of " .. seconds .. " s (there are: " .. table.concat(delays, ", ") .. ")")
end

local function hasTimer(mock, seconds)
    for _, timer in ipairs(httpsTimers(mock, false)) do
        if timer.delay == seconds * 1000 then
            return true
        end
    end
    return false
end

-- Runs `fn` with the clock `offset` seconds ahead.
local function later(offset, fn)
    local realTime = os.time
    os.time = function(date)
        if date then
            return realTime(date)
        end
        return realTime() + offset
    end
    local ok, err = pcall(fn)
    os.time = realTime
    if not ok then
        error(err, 0)
    end
end

local function logText(mock)
    return table.concat(mock.debugLog, "\n")
end

-- What Direct HTTPS keeps in the driver's data.
local function stored(mock)
    return Json.decode((mock.persist.directorlink_https:gsub("^json:", "")))
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

-- ---- off, allowed, and who switches it --------------------------------------------------------------

function tests.off_by_default_makes_nothing_and_refuses_the_switch()
    local s = home({ allowed = false })
    T.same(status(s), {
        allowed = false, enabled = false, remote = true, name = Json.null, port = PORT, state = "not_allowed",
        certificate = Json.null, error = Json.null,
    })
    T.eq(s.mock.properties["Direct HTTPS Status"], "Off")
    local refused = switch(s, true)
    T.eq(refused.status, 409)
    T.eq(refused.json.code, "HTTPS_NOT_ALLOWED")
    T.eq(switch(s, false).json.code, "HTTPS_NOT_ALLOWED")
    T.eq(#s.mock.csrCalls, 0, "no key")
    T.eq(#s.mock.tlsCalls, 0, "no TLS server")
    T.eq(s.mock.persist.directorlink_https, nil)
    T.eq(#httpsMessages(s), 0, "nothing told to the relay")
    T.eq(T.http(s.mock, "GET", "/v1/system", { key = s.key }).json.direct_https, Json.null)
    T.truthy(s.mock.servers[41999], "the API's own server is there as always")
end

function tests.allowed_alone_turns_nothing_on()
    local s = home()
    local current = status(s)
    T.eq(current.allowed, true)
    T.eq(current.enabled, false)
    T.eq(current.remote, true)
    T.eq(current.state, "off")
    T.eq(current.name, Json.null)
    T.eq(#s.mock.csrCalls, 0, "no key until the owner turns it on")
    T.eq(#httpsMessages(s), 0)
    T.eq(s.mock.properties["Direct HTTPS Status"], "Allowed: the home's owner turns it on in the app")
    -- Off again: still nothing.
    setProperty("Direct HTTPS", "Off")
    T.eq(status(s).state, "not_allowed")
    T.eq(#httpsMessages(s), 0)
end

function tests.only_the_homes_owner_switches_it()
    local s = home()
    local admin = T.http(s.mock, "POST", "/v1/api-keys", { key = s.key, body = { name = "Partner's phone", role = "admin" } })
    T.eq(admin.status, 201, admin.body)
    local member = T.http(s.mock, "POST", "/v1/api-keys", { key = s.key, body = { name = "Kid's phone", role = "member" } })
    T.eq(member.status, 201, member.body)
    local byAdmin = switch(s, true, admin.json.key)
    T.eq(byAdmin.status, 403)
    T.eq(byAdmin.json.code, "OWNER_ONLY")
    T.eq(status(s, admin.json.key).state, "off", "another admin sees it")
    local byMember = switch(s, true, member.json.key)
    T.eq(byMember.status, 403)
    T.eq(byMember.json.code, "FORBIDDEN")
    T.eq(T.http(s.mock, "GET", "/v1/https", { key = member.json.key }).status, 403)
    T.eq(T.http(s.mock, "GET", "/v1/https").status, 401)
    T.eq(T.http(s.mock, "PUT", "/v1/https", { body = { enabled = true } }).status, 401)
    for _, body in ipairs({ { enabled = "true" }, { enabled = 1 }, {}, { enabled = true, name = "x" }, "true" }) do
        local answer = T.http(s.mock, "PUT", "/v1/https", { key = s.key, body = body })
        T.eq(answer.status, 400, Json.encode(body))
    end
    T.eq(#s.mock.csrCalls, 0)
    T.eq(#httpsMessages(s), 0)
    T.eq(switch(s, true).status, 200, "the owner")
end

function tests.it_needs_remote_access_and_a_linked_home()
    local off = home({ remote = false })
    T.eq(status(off).remote, false)
    local refused = switch(off, true)
    T.eq(refused.status, 409)
    T.eq(refused.json.code, "REMOTE_ACCESS_NEEDED")
    T.eq(#off.mock.csrCalls, 0)

    -- Connected, but no account has the home.
    local unclaimed = home({ claimed = false })
    T.eq(status(unclaimed).remote, false)
    T.eq(switch(unclaimed, true).json.code, "REMOTE_ACCESS_NEEDED")
    -- Claimed: it may.
    claim(unclaimed)
    T.eq(status(unclaimed).remote, true)
    T.eq(switch(unclaimed, true).status, 200)

    -- A home claimed before 1.8.0 recorded no owner: an account using one of its keys says it is in one.
    local older = home({ claimed = false })
    local me = T.http(older.mock, "GET", "/v1/api-keys/current", { key = older.key }).json
    relaySays(older, { type = "accounts", id = "a1", keys = { [me.id] = { "0123456789abcdef" } } })
    T.eq(status(older).remote, true)

    -- Turning off needs neither.
    local s = listening()
    setProperty("Remote Access", "Off")
    local current = status(s)
    T.eq(current.remote, false)
    T.eq(current.state, "listening", "the certificate keeps working until it is due")
    T.eq(current.error, Json.null)
    T.eq(switch(s, false).status, 200)
end

-- ---- a certificate --------------------------------------------------------------------------------

function tests.the_owner_turns_it_on_and_the_certificate_comes_through_the_relay()
    local s = home()
    local asked, answer = turnOn(s)
    T.eq(#s.mock.csrCalls, 1, "a key and CSR, once")
    local call = s.mock.csrCalls[1]
    T.eq(call.digest, "SHA256")
    T.eq(call.curve, "prime256v1")
    T.eq(call.subject, "/CN=" .. asked.name)
    -- No subjectAltName: Director writes it as raw text, which Let's Encrypt refuses.
    T.eq(call.extensions == nil or next(call.extensions) == nil, true)
    T.truthy(asked.name:match("^[a-z2-7]+%.dlhome%.cc$") and #asked.name == 20 + #".dlhome.cc", asked.name)
    T.contains(asked.csr, "-----BEGIN CERTIFICATE REQUEST-----")
    T.eq(asked.ip, "192.168.1.10", "the controller's LAN address, for the A record")
    T.truthy(type(asked.id) == "string" and #asked.id > 0)
    T.eq(answer.enabled, true)
    T.eq(answer.state, "requesting")
    T.eq(answer.name, asked.name)
    T.eq(answer.certificate, Json.null)
    T.eq(answer.error, Json.null)
    T.eq(s.mock.properties["Direct HTTPS Status"], "Asking for a certificate for " .. asked.name)
    T.eq(#s.mock.tlsCalls, 0, "no TLS server without a certificate")

    -- The Worker is issuing it.
    relaySays(s, { type = "https_certificate_result", id = asked.id, ok = true, status = "pending" })
    T.eq(status(s).state, "requesting")
    T.truthy(hasTimer(s.mock, 900), "it waits up to 15 minutes for the certificate")

    -- Issued.
    local leaf, notAfter = issued(s, asked)
    T.eq(#s.mock.tlsCalls, 1)
    local server = s.mock.tlsCalls[1]
    T.eq(server.port, PORT)
    T.eq(server.delimiter, "")
    T.eq(server.options, 0, "TLS 1.2 and 1.3 (Director's default)")
    T.eq(server.verifyMode, 1, "no client certificate asked for (0 would ask)")
    T.eq(server.cipherList, "")
    T.eq(server.certificate, leaf)
    T.eq(server.privateKey, s.mock.privateKeys[1])
    T.eq(server.password, "")
    T.eq(server.chain, INTERMEDIATE)
    T.eq(server.identifier, "https")
    T.eq(status(s).state, "requesting", "until Director says the server is online")
    OnServerStatusChanged(PORT, "ONLINE", "https")
    local current = status(s)
    T.eq(current.state, "listening")
    T.same(current.certificate, { not_after = notAfter, issuer_cn = "YE1" })
    T.eq(current.error, Json.null)
    T.eq(s.mock.properties["Direct HTTPS Status"], "Listening on " .. asked.name .. ":28443, certificate until " .. notAfter)
    T.eq(s.mock.properties["API Status"], "Online - port 41999", "the API's own status is the plain server's")
    T.same(T.http(s.mock, "GET", "/v1/system", { key = s.key }).json.direct_https, { name = asked.name, port = PORT, not_after = notAfter })
    T.eq(#httpsMessages(s), 0, "nothing more asked")

    -- In the history, by the owner's key.
    local history = T.http(s.mock, "GET", "/v1/activity", { key = s.key })
    T.contains(history.body, '"action":"direct_https"')
    T.contains(history.body, '"to":"on"')
    local log = logText(s.mock)
    T.contains(log, "certificate asked for")
    T.contains(log, "certificate installed")
    T.contains(log, "TLS server started")
    T.notContains(log, "BEGIN CERTIFICATE", "never a certificate's text in the log")

    -- Switched on again: nothing new.
    T.eq(switch(s, true).json.state, "listening")
    T.eq(#httpsMessages(s), 0)
end

function tests.a_member_sees_where_to_reach_it_in_the_system()
    local s = listening()
    local member = T.http(s.mock, "POST", "/v1/api-keys", { key = s.key, body = { name = "Kid's phone", role = "member" } }).json.key
    local system = T.http(s.mock, "GET", "/v1/system", { key = member })
    T.eq(system.status, 200)
    T.eq(system.json.direct_https.port, PORT)
    T.truthy(system.json.direct_https.name:match("%.dlhome%.cc$"))
    -- Not listening (Director said OFFLINE): null.
    OnServerStatusChanged(PORT, "OFFLINE", "https")
    T.eq(T.http(s.mock, "GET", "/v1/system", { key = member }).json.direct_https, Json.null)
end

function tests.a_certificate_for_another_key_or_name_is_refused()
    local cases = {
        { spki = X509Fake.spki(X509Fake.point(4242)) },
        { names = { "abcdefghijabcdefghij.dlhome.cc" } },
        { from = os.time() - 100 * DAY, to = os.time() - DAY },
        { chain = "" },
        { chain = "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n" },
    }
    for index, options in ipairs(cases) do
        local s = home()
        local asked = turnOn(s)
        issued(s, asked, options)
        T.eq(#s.mock.tlsCalls, 0, "case " .. index)
        local current = status(s)
        T.eq(current.state, "error", "case " .. index)
        T.eq(current.error, "The certificate received isn't for this controller. Trying again in 5 minutes.", "case " .. index)
        T.eq(current.certificate, Json.null, "case " .. index)
        T.contains(logText(s.mock), "certificate refused")
        T.truthy(hasTimer(s.mock, 300), "asked again after 5 minutes")
    end
    -- A wildcard for the name's parent covers it.
    local s = home()
    local asked = turnOn(s)
    issued(s, asked, { names = { "*.dlhome.cc" } })
    T.eq(#s.mock.tlsCalls, 1)
end

function tests.the_workers_refusals_are_shown_and_asked_again_with_a_backoff()
    local s = home()
    local asked = turnOn(s)
    relaySays(s, { type = "https_certificate_result", id = asked.id, ok = false, code = "RATE_LIMITED", retry_s = 7200 })
    local current = status(s)
    T.eq(current.state, "error")
    T.eq(current.error, "Too many certificates were asked for. Trying again in 2 hours.")
    T.eq(s.mock.properties["Direct HTTPS Status"], "Error: Too many certificates were asked for. Trying again in 2 hours")
    T.eq(#httpsMessages(s), 0)
    -- Nothing at the next tick: it waits.
    tick(s.mock)
    T.eq(#httpsMessages(s), 0)
    fire(s.mock, 7200)
    local again = httpsMessages(s)
    T.eq(#again, 1)
    T.eq(again[1].type, "https_certificate")
    T.eq(again[1].csr, asked.csr, "the same key")
    T.truthy(again[1].id ~= asked.id)
    -- The second refusal in a row: 15 minutes; the third, an hour.
    relaySays(s, { type = "https_certificate_result", id = again[1].id, ok = false, code = "ACME_FAILED" })
    T.eq(status(s).error, "Let's Encrypt didn't issue the certificate. Trying again in 15 minutes.")
    fire(s.mock, 900)
    local third = httpsMessages(s)[1]
    relaySays(s, { type = "https_certificate_result", id = third.id, ok = false, code = "HTTPS_UNAVAILABLE" })
    T.eq(status(s).error, "DirectorLink's servers can't issue certificates right now. Trying again in an hour.")
    fire(s.mock, 3600)
    local fourth = httpsMessages(s)[1]
    -- No answer within a minute counts too.
    fire(s.mock, 60)
    T.contains(status(s).error, "DirectorLink's servers didn't answer in time.")
    T.truthy(hasTimer(s.mock, 6 * 3600))
    -- An answer to an earlier request changes nothing.
    relaySays(s, { type = "https_certificate_result", id = fourth.id, ok = false, code = "INTERNAL" })
    T.contains(status(s).error, "DirectorLink's servers didn't answer in time.")
    T.contains(logText(s.mock), "no certificate from DirectorLink's servers")

    -- Pending, then nothing for 15 minutes: asked again later.
    local quiet = home()
    local waiting = turnOn(quiet)
    relaySays(quiet, { type = "https_certificate_result", id = waiting.id, ok = true, status = "pending" })
    fire(quiet.mock, 900)
    T.eq(status(quiet).state, "error")
    T.truthy(hasTimer(quiet.mock, 300))

    -- A success ends the backoff.
    fire(quiet.mock, 300)
    local last = httpsMessages(quiet)[1]
    issued(quiet, last)
    OnServerStatusChanged(PORT, "ONLINE", "https")
    T.eq(status(quiet).error, Json.null)
    T.eq(#httpsTimers(quiet.mock, false), 0, "no retry left")
end

function tests.the_homes_name_at_the_worker_wins_and_a_taken_name_is_replaced()
    -- This controller's store was lost or replaced: the Worker has the home's name.
    local s = home()
    local asked = turnOn(s)
    local homeName = "abcdefghij234567abcd.dlhome.cc"
    relaySays(s, { type = "https_certificate_result", id = asked.id, ok = false, code = "NAME_MISMATCH", name = homeName })
    local again = httpsMessages(s)
    T.eq(#again, 1, "asked again at once, for the home's name")
    T.eq(again[1].name, homeName)
    T.eq(s.mock.csrCalls[2].subject, "/CN=" .. homeName, "a new key for it")
    T.eq(status(s).name, homeName)
    T.eq(status(s).state, "requesting")
    -- A name that is no name is not taken.
    relaySays(s, { type = "https_certificate_result", id = again[1].id, ok = false, code = "NAME_MISMATCH", name = "evil.example" })
    T.eq(status(s).name, homeName)
    T.eq(status(s).state, "error")

    -- Another home has this name: a new one.
    local taken = home()
    local first = turnOn(taken)
    relaySays(taken, { type = "https_certificate_result", id = first.id, ok = false, code = "NAME_TAKEN" })
    local next = httpsMessages(taken)
    T.eq(#next, 1)
    T.truthy(next[1].name ~= first.name and next[1].name:match("%.dlhome%.cc$"))
    T.truthy(next[1].csr ~= first.csr)
    -- At most three new names a start.
    for _ = 1, 3 do
        local message = httpsMessages(taken)[1] or next[1]
        relaySays(taken, { type = "https_certificate_result", id = message.id, ok = false, code = "NAME_TAKEN" })
        next = httpsMessages(taken)
    end
    T.eq(#next, 0, "then it waits")
    T.eq(#taken.mock.csrCalls, 4)
    T.eq(status(taken).state, "error")

    -- The Worker refused the CSR: a new key, asked for after the backoff.
    local refused = home()
    local csr = turnOn(refused)
    relaySays(refused, { type = "https_certificate_result", id = csr.id, ok = false, code = "INVALID_CSR" })
    T.eq(#refused.mock.csrCalls, 2)
    T.eq(#httpsMessages(refused), 0)
    fire(refused.mock, 300)
    local renewed = httpsMessages(refused)[1]
    T.eq(renewed.name, csr.name)
    T.truthy(renewed.csr ~= csr.csr)
end

function tests.it_asks_again_when_a_third_of_the_lifetime_is_left()
    local now = os.time()
    -- 90 days from 59 days ago: 31 days left, more than a third.
    local s, asked = listening({ from = now - 59 * DAY, to = now + 31 * DAY })
    tick(s.mock)
    T.eq(#httpsMessages(s), 0, "not yet")
    later(2 * DAY, function()
        tick(s.mock)
        local renewal = httpsMessages(s)
        T.eq(#renewal, 1)
        T.eq(renewal[1].type, "https_certificate")
        T.eq(renewal[1].csr, asked.csr)
        T.eq(status(s).state, "listening", "the certificate in use keeps working meanwhile")
        T.contains(logText(s.mock), '"renewal":true')
        local leaf = issued(s, renewal[1], { from = os.time(), serial = 2 })
        T.eq(#s.mock.tlsCalls, 2, "the TLS server again, with the new certificate")
        T.eq(s.mock.tlsCalls[2].certificate, leaf)
        T.eq(s.mock.destroyedServers[#s.mock.destroyedServers], PORT, "only the TLS server, by its port")
        T.truthy(s.mock.servers[41999], "the API's own server stays")
        OnServerStatusChanged(PORT, "OFFLINE", "https")
        OnServerStatusChanged(PORT, "ONLINE", "https")
        T.eq(status(s).state, "listening")
        tick(s.mock)
        T.eq(#httpsMessages(s), 0)
    end)
    -- The Worker gives the same certificate (its clock and the controller's differ): asked again
    -- 6 hours later, not at once.
    local same, sameAsked, sameLeaf = listening({ from = now - 50 * DAY, to = now + 40 * DAY })
    later(21 * DAY, function()
        tick(same.mock)
        local due = httpsMessages(same)
        T.eq(#due, 1)
        relaySays(same, { type = "https_certificate_result", id = due[1].id, ok = true, status = "issued", name = sameAsked.name,
            certificate = sameLeaf, chain = INTERMEDIATE, not_after = iso(now + 40 * DAY) })
        T.eq(#httpsMessages(same), 0, "not asked again at once")
        T.eq(#same.mock.tlsCalls, 1, "the same certificate: the server stays")
        T.eq(status(same).error, Json.null)
        tick(same.mock)
        T.eq(#httpsMessages(same), 0)
        fire(same.mock, 6 * 3600)
        T.eq(#httpsMessages(same), 1, "asked again 6 hours later")
    end)

    -- A refused renewal: still listening, with the error.
    local r = listening({ from = now - 50 * DAY, to = now + 40 * DAY })
    later(21 * DAY, function()
        tick(r.mock)
        local due = httpsMessages(r)
        T.eq(#due, 1, "19 days left")
        relaySays(r, { type = "https_certificate_result", id = due[1].id, ok = false, code = "ACME_FAILED" })
        local current = status(r)
        T.eq(current.state, "listening")
        T.contains(current.error, "Let's Encrypt")
    end)
    -- Expired: forgotten, the TLS server stops.
    later(41 * DAY, function()
        tick(r.mock)
        T.eq(r.mock.tlsServers[PORT], nil)
        local after = status(r)
        T.eq(after.certificate, Json.null)
        T.truthy(after.state == "error" or after.state == "requesting")
        T.eq(T.http(r.mock, "GET", "/v1/system", { key = r.key }).json.direct_https, Json.null)
    end)
end

function tests.the_worker_hears_of_a_new_address()
    local s = listening()
    tick(s.mock)
    T.eq(#httpsMessages(s), 0, "the address it gave with the request")
    s.mock.controllerAddress = "192.168.1.77"
    tick(s.mock)
    local told = httpsMessages(s)
    T.eq(#told, 1)
    T.eq(told[1].type, "https")
    T.eq(told[1].ip, "192.168.1.77")
    T.eq(told[1].name, status(s).name)
    relaySays(s, { type = "https_result", id = told[1].id, ok = true })
    tick(s.mock)
    T.eq(#httpsMessages(s), 0, "told once")
    -- Refused: told again at the next tick.
    s.mock.controllerAddress = "10.0.0.5"
    tick(s.mock)
    local refused = httpsMessages(s)[1]
    relaySays(s, { type = "https_result", id = refused.id, ok = false, code = "DNS_FAILED" })
    tick(s.mock)
    T.eq(httpsMessages(s)[1].ip, "10.0.0.5")
    -- At every new connection, once the relay said what it does.
    local hello = Harness.reconnect(s.mock, s.connection)
    T.eq(hello.type, "hello")
    T.eq(#httpsMessages(s), 0, "not before the relay's features")
    relayFeatures(s)
    local again = httpsMessages(s)
    T.eq(#again, 1)
    T.eq(again[1].ip, "10.0.0.5")
    -- A public address or none is never told.
    relaySays(s, { type = "https_result", id = again[1].id, ok = true })
    s.mock.controllerAddress = "8.8.8.8"
    tick(s.mock)
    s.mock.controllerAddress = false
    tick(s.mock)
    T.eq(#httpsMessages(s), 0)

    -- A request with such an address is not sent: the controller says why.
    local public = home({ prepare = function(m)
        m.controllerAddress = "203.0.113.9"
    end })
    T.eq(switch(public, true).status, 200)
    T.eq(#httpsMessages(public), 0)
    T.contains(status(public).error, "The controller's address isn't a home network address.")
end

function tests.a_request_whose_connection_ended_is_asked_again_on_the_next()
    local s = home()
    local asked = turnOn(s)
    relaySays(s, { type = "https_certificate_result", id = asked.id, ok = true, status = "pending" })
    Harness.reconnect(s.mock, s.connection)
    relayFeatures(s)
    local again = httpsMessages(s)
    T.eq(#again, 1)
    T.eq(again[1].csr, asked.csr)
    T.truthy(again[1].id ~= asked.id)
    -- The certificate the first request got still counts.
    issued(s, asked)
    T.eq(#s.mock.tlsCalls, 1)
    OnServerStatusChanged(PORT, "ONLINE", "https")
    T.eq(status(s).state, "listening")
end

function tests.a_relay_that_issues_no_certificates_is_said()
    local s = home({ features = { "alert_acks" } })
    T.eq(switch(s, true).status, 200)
    T.eq(#httpsMessages(s), 0, "nothing asked of a relay that does not say https")
    local current = status(s)
    T.eq(current.state, "error")
    T.eq(current.error, "DirectorLink's servers can't issue certificates yet.")
    -- Not connected: it waits, without an error.
    local down = home({ features = false })
    T.eq(switch(down, true).status, 200)
    T.eq(status(down).state, "requesting")
    T.eq(status(down).error, Json.null)
end

-- ---- off ------------------------------------------------------------------------------------------

function tests.turned_off_the_server_stops_the_certificate_goes_and_the_record_is_deleted()
    local s, asked = listening()
    local answer = switch(s, false)
    T.eq(answer.status, 200, answer.body)
    T.eq(answer.json.enabled, false)
    T.eq(answer.json.state, "off")
    T.eq(answer.json.certificate, Json.null)
    T.eq(answer.json.name, asked.name, "the name stays")
    T.truthy(s.mock.tlsServers[PORT], "not before its answer has gone")
    fire(s.mock, 2)
    T.eq(s.mock.tlsServers[PORT], nil)
    T.eq(s.mock.destroyedServers[#s.mock.destroyedServers], PORT)
    T.truthy(s.mock.servers[41999], "the API's own server stays")
    T.eq(T.http(s.mock, "GET", "/v1/system", { key = s.key }).json.direct_https, Json.null)
    local record = stored(s.mock)
    T.eq(record.certificate, nil, "the certificate is forgotten")
    T.truthy(record.key, "the key stays")
    T.eq(record.enabled, nil)
    T.eq(record.dns_off, true, "until the Worker deleted the record")
    local off = httpsMessages(s)
    T.eq(#off, 1)
    T.eq(off[1].type, "https")
    T.eq(off[1].name, Json.null, "the Worker deletes the name's record")
    T.eq(off[1].ip, nil)
    relaySays(s, { type = "https_result", id = off[1].id, ok = true })
    T.eq(stored(s.mock).dns_off, nil)
    tick(s.mock)
    T.eq(#httpsMessages(s), 0, "told once")
    local history = T.http(s.mock, "GET", "/v1/activity", { key = s.key }).body
    T.contains(history, '"to":"off"')
    T.contains(logText(s.mock), "TLS server stopped")
    OnServerStatusChanged(PORT, "OFFLINE", "https")
    T.eq(status(s).state, "off")

    -- On again: the same key, a certificate asked for again (the Worker has it already).
    local again = turnOn(s)
    T.eq(again.csr, asked.csr)
    T.eq(#s.mock.csrCalls, 1)
end

function tests.turned_off_while_away_the_record_goes_at_the_next_connection_even_after_a_restart()
    local s = listening()
    OnConnectionStatusChanged(Harness.BINDING, 443, "OFFLINE")
    T.eq(switch(s, false).status, 200)
    T.eq(#httpsMessages(s), 0, "not connected")
    T.eq(stored(s.mock).dns_off, true, "kept until the Worker answers")
    local again = reload(s.mock)
    local after = { mock = again }
    local _, connection = Harness.connected({ mock = again })
    after.connection = connection
    relayFeatures(after)
    local off = httpsMessages(after)
    T.eq(#off, 1)
    T.eq(off[1].name, Json.null)
    -- Not answered: asked again at the next connection.
    Harness.reconnect(again, connection)
    relayFeatures(after)
    off = httpsMessages(after)
    T.eq(#off, 1)
    relaySays(after, { type = "https_result", id = off[1].id, ok = true })
    T.eq(stored(again).dns_off, nil)
    Harness.reconnect(again, connection)
    relayFeatures(after)
    T.eq(#httpsMessages(after), 0, "once deleted, never again")
end

function tests.composer_back_to_off_turns_it_off_and_allowed_again_does_not_turn_it_on()
    local s = listening()
    setProperty("Direct HTTPS", "Off")
    T.eq(s.mock.tlsServers[PORT], nil)
    T.eq(status(s).state, "not_allowed")
    T.eq(status(s).enabled, false)
    T.eq(s.mock.properties["Direct HTTPS Status"], "Off")
    local off = httpsMessages(s)
    T.eq(#off, 1)
    T.eq(off[1].name, Json.null)
    setProperty("Direct HTTPS", "Allowed")
    T.eq(status(s).state, "off", "the owner turns it on again")
    T.eq(#s.mock.tlsCalls, 1)
    T.contains(T.http(s.mock, "GET", "/v1/activity", { key = s.key }).body, "Direct HTTPS")
end

function tests.a_new_remote_identity_forgets_the_name()
    local s, asked = listening()
    ExecuteCommand("LUA_ACTION", { ACTION = "RESET_REMOTE_IDENTITY" })
    local told = httpsMessages(s)
    T.eq(#told, 1, "told on the old connection")
    T.eq(told[1].name, Json.null)
    T.eq(s.mock.tlsServers[PORT], nil)
    local current = status(s)
    T.truthy(current.name ~= asked.name, "a new name for the new home")
    T.eq(current.certificate, Json.null)
    T.eq(current.enabled, true, "the owner's switch stays")
    T.eq(current.remote, false, "until the new home is connected")
    T.eq(#httpsMessages(s), 0, "nothing asked on the old connection")
end

-- ---- what is kept ---------------------------------------------------------------------------------

function tests.a_certificate_and_the_switch_survive_a_reload()
    local s, asked = listening()
    local again = reload(s.mock)
    T.eq(#again.csrCalls, 0)
    T.eq(#again.tlsCalls, 1, "the TLS server starts again at load")
    T.eq(again.tlsCalls[1].certificate, s.mock.tlsCalls[1].certificate)
    T.eq(again.tlsCalls[1].privateKey, s.mock.privateKeys[1])
    OnServerStatusChanged(PORT, "ONLINE", "https")
    local key = T.pair(again, "Again")
    local current = status({ mock = again, key = key })
    T.eq(current.state, "listening")
    T.eq(current.enabled, true)
    T.eq(current.name, asked.name)
    T.eq(T.http(again, "GET", "/v1/health", { tls = true, host = asked.name .. ":28443" }).status, 200)
end

function tests.the_test_builds_key_stays_and_its_allowed_turns_nothing_on()
    local s = home({ prepare = function(m)
        m.persist.directorlink_https = Json.encode({
            version = 1, name = "abcdefghijabcdefghij.dlhome.cc", created_at = "2026-10-10T19:00:00Z",
            key = X509Fake.privateKey(1), csr = X509Fake.pem(X509Fake.request("abcdefghijabcdefghij.dlhome.cc", X509Fake.point(1)), "CERTIFICATE REQUEST"),
        })
    end })
    local current = status(s)
    T.eq(current.state, "off")
    T.eq(current.name, "abcdefghijabcdefghij.dlhome.cc")
    local asked = turnOn(s)
    T.eq(asked.name, "abcdefghijabcdefghij.dlhome.cc")
    T.eq(#s.mock.csrCalls, 0, "its key")
end

function tests.the_private_key_never_leaves_the_store()
    local s = listening()
    local secret = s.mock.privateKeys[1]
    local body = secret:match("%-%-%-%-%-\n(.-)\n%-%-%-%-%-END")
    T.truthy(body and #body > 8)
    local relayFrames = {}
    for _, frame in ipairs(Harness.clientFrames(s.connection.sent)) do
        relayFrames[#relayFrames + 1] = frame.payload
    end
    switch(s, false)
    switch(s, true)
    for _, frame in ipairs(Harness.clientFrames(s.connection.sent)) do
        relayFrames[#relayFrames + 1] = frame.payload
    end
    local answers = {
        T.http(s.mock, "GET", "/v1/https", { key = s.key }).body,
        T.http(s.mock, "GET", "/v1/logs", { key = s.key }).body,
        T.http(s.mock, "GET", "/v1/system", { key = s.key }).body,
        T.http(s.mock, "GET", "/v1/activity", { key = s.key }).body,
        switch(s, true).body,
        logText(s.mock),
        Json.encode(s.mock.properties),
        Json.encode(require("src.core.backup").export(require("src.core.registry"))),
    }
    for index, text in ipairs(answers) do
        T.notContains(text, body, "answer " .. index)
        T.notContains(text, "PRIVATE KEY", "answer " .. index)
        T.notContains(text, "CERTIFICATE REQUEST", "answer " .. index .. ": not even the CSR")
    end
    -- The relay gets the CSR, never the key.
    local relayed = table.concat(relayFrames, "\n")
    T.contains(relayed, "CERTIFICATE REQUEST")
    T.notContains(relayed, body)
    T.notContains(relayed, "PRIVATE KEY")
    -- Only Direct HTTPS's own store holds it.
    for name, value in pairs(s.mock.persist) do
        if name ~= "directorlink_https" then
            T.notContains(tostring(value), body, name)
        end
    end
    T.contains(s.mock.persist.directorlink_https, body)
end

-- ---- what goes wrong on the controller ------------------------------------------------------------

function tests.an_os_without_the_private_key_says_it_is_not_supported()
    local s = home({ prepare = function(m)
        m.csrMode = "csr_only"
    end })
    local answer = switch(s, true)
    T.eq(answer.status, 200)
    T.eq(answer.json.state, "error")
    T.eq(answer.json.error, "This controller's OS is too old for Direct HTTPS. It needs OS 3.3.1 or later.")
    T.eq(s.mock.properties["Direct HTTPS Status"], "Error: This controller's OS is too old for Direct HTTPS. It needs OS 3.3.1 or later")
    T.contains(logText(s.mock), "gave no private key", "what Director did, in the log")
    T.eq(#httpsMessages(s), 0, "nothing asked without a key")
    T.eq(#s.mock.tlsCalls, 0)

    local missing = home({ prepare = function()
        C4.GenerateCSR_ECC = nil
    end })
    T.eq(switch(missing, true).json.error, "This controller's OS is too old for Direct HTTPS. It needs OS 3.3.1 or later.")

    local failing = home({ prepare = function(m)
        m.csrMode = "fail"
    end })
    T.eq(switch(failing, true).json.error, "The controller couldn't make its key.")
    T.contains(logText(failing.mock), "EC key generation failed")
    -- Off and on again tries again.
    failing.mock.csrMode = nil
    switch(failing, false)
    T.eq(switch(failing, true).json.state, "requesting")
end

function tests.a_tls_server_that_fails_to_start_says_why()
    local s = home({ prepare = function(m)
        m.tlsFails = "bind failed"
    end })
    local asked = turnOn(s)
    issued(s, asked)
    local current = status(s)
    T.eq(current.state, "error")
    T.eq(current.error, "The controller couldn't start its HTTPS server. Trying again in a minute.")
    T.eq(s.mock.properties["Direct HTTPS Status"], "Error: The controller couldn't start its HTTPS server. Trying again in a minute")
    T.contains(logText(s.mock), "TLS server failed")
    T.contains(logText(s.mock), "bind failed", "Director's words in the log")
    -- Started again after 10 s, 30 s, a minute…: it works once the port is free.
    T.eq(#s.mock.tlsCalls, 1)
    fire(s.mock, 10)
    T.eq(#s.mock.tlsCalls, 2)
    T.truthy(hasTimer(s.mock, 30))
    s.mock.tlsFails = nil
    fire(s.mock, 30)
    T.eq(#s.mock.tlsCalls, 3)
    OnServerStatusChanged(PORT, "ONLINE", "https")
    current = status(s)
    T.eq(current.state, "listening")
    T.eq(current.error, Json.null)
end

-- ---- requests on the TLS server -------------------------------------------------------------------

function tests.a_request_on_the_tls_server_is_answered_as_on_41999()
    local s, asked = listening()
    local key, mock, host = s.key, s.mock, asked.name .. ":28443"
    local plain = T.http(mock, "GET", "/v1/system", { key = key })
    local secure = T.http(mock, "GET", "/v1/system", { key = key, tls = true, host = host })
    T.eq(secure.status, 200, secure.body)
    T.eq(plain.status, 200)
    T.eq(secure.json.bridge.version, plain.json.bridge.version)
    T.eq(secure.headers["content-type"], plain.headers["content-type"])
    T.eq(secure.closed, true)
    T.eq(T.http(mock, "GET", "/v1/lights", { tls = true, host = host }).status, 401)
    local origin = { Origin = "https://app.directorlink.io", ["Access-Control-Request-Private-Network"] = "true" }
    local preflight = T.http(mock, "OPTIONS", "/v1/sealed", { tls = true, host = host, headers = origin })
    T.eq(preflight.status, 204)
    T.eq(preflight.headers["access-control-allow-origin"], "https://app.directorlink.io")
    T.eq(preflight.headers["access-control-allow-private-network"], "true")
    local health = T.http(mock, "GET", "/v1/health", { tls = true, host = host, headers = { Origin = "https://app.directorlink.io" } })
    T.eq(health.status, 200)
    T.eq(health.headers["access-control-allow-origin"], "https://app.directorlink.io")
    T.eq(T.http(mock, "GET", "/v1/health", { tls = true, host = host, headers = { Origin = "https://evil.example" } }).status, 403)
    T.eq(T.http(mock, "GET", "/v1/system", { key = key, tls = "port", host = host }).status, 200)
    T.contains(logText(mock), '"tls":true')
end

function tests.the_host_check_takes_the_name_only_on_the_tls_server()
    local s, asked = listening()
    local mock, name = s.mock, asked.name
    for _, host in ipairs({ name, name .. ":28443", string.upper(name) .. ":28443", "192.168.1.10:28443", "director.local:28443" }) do
        T.eq(T.http(mock, "GET", "/v1/health", { tls = true, host = host }).status, 200, host)
    end
    for _, host in ipairs({ "other.dlhome.cc", "x" .. name, name .. ":41999", name .. ".", "dlhome.cc", "evil.example:28443" }) do
        local answer = T.http(mock, "GET", "/v1/health", { tls = true, host = host })
        T.eq(answer.status, 421, host)
        T.eq(answer.json.code, "MISDIRECTED_REQUEST")
    end
    for _, host in ipairs({ name, name .. ":28443", name .. ":41999" }) do
        T.eq(T.http(mock, "GET", "/v1/health", { host = host }).status, 421, host)
    end
end

-- ---- what the app relies on (1.12.0 app) ----------------------------------------------------------

function tests.the_system_always_says_direct_https()
    local off = home({ allowed = false, remote = false })
    local body = T.http(off.mock, "GET", "/v1/system", { key = off.key }).body
    T.contains(body, '"direct_https":null', "the key is there, null, while off")
    -- Whatever the module offers, the key stays.
    require("src.api.direct_https").published = nil
    T.contains(T.http(off.mock, "GET", "/v1/system", { key = off.key }).body, '"direct_https":null')
end

function tests.sealed_requests_on_the_tls_server_get_cors_for_the_app()
    local s, asked = listening()
    local mock, host = s.mock, asked.name .. ":28443"
    local origin = "https://app.directorlink.io"
    -- The preflight of the app's JSON POST.
    local preflight = T.http(mock, "OPTIONS", "/v1/sealed", { tls = true, host = host, headers = {
        Origin = origin, ["Access-Control-Request-Method"] = "POST", ["Access-Control-Request-Headers"] = "content-type",
        ["Access-Control-Request-Private-Network"] = "true",
    } })
    T.eq(preflight.status, 204)
    T.eq(preflight.headers["access-control-allow-origin"], origin)
    T.contains(preflight.headers["access-control-allow-methods"], "POST")
    T.contains(preflight.headers["access-control-allow-headers"], "Content-Type")
    -- GET /v1/sealed: answered at once, in the same call (nothing waits on that path), with CORS.
    local started = os.clock()
    local info = T.http(mock, "GET", "/v1/sealed", { tls = true, host = host, headers = { Origin = origin } })
    T.truthy(os.clock() - started < 0.5, "answered at once")
    T.eq(info.status, 200)
    T.eq(info.closed, true)
    T.eq(info.headers["access-control-allow-origin"], origin)
    T.eq(info.json.home, "lan")
    -- POST /v1/sealed: a sealed request, answered sealed, with CORS.
    local Lock = require("src.cloud.lock")
    local me = T.http(mock, "GET", "/v1/api-keys/current", { key = s.key }).json
    local lock = Lock.deviceKey(s.key)
    local envelope = Lock.seal(lock, info.json.home, me.id, "req", Json.encode({ id = "tls-1", ts = info.json.time, method = "GET", path = "/v1/https" }))
    local response = T.http(mock, "POST", "/v1/sealed", { tls = true, host = host, headers = { Origin = origin }, body = { envelope = envelope } })
    T.eq(response.status, 200, response.body)
    T.eq(response.headers["access-control-allow-origin"], origin)
    local answer = Json.decode(Lock.open(lock, response.json.envelope, "res"))
    T.eq(answer.status, 200)
    T.eq(Json.decode(answer.body).state, "listening")
end

function tests.turned_off_over_the_tls_server_its_answer_goes_whole_before_the_server_stops()
    local s, asked = listening()
    local host = asked.name .. ":28443"
    local answer = T.http(s.mock, "PUT", "/v1/https", { key = s.key, tls = true, host = host, body = { enabled = false } })
    T.eq(answer.status, 200, answer.body)
    T.eq(answer.json.state, "off")
    T.eq(answer.closed, true, "the whole answer, then the connection closed")
    T.truthy(s.mock.tlsServers[PORT], "the TLS server still runs when the answer is sent")
    T.eq(s.mock.destroyedServers[#s.mock.destroyedServers] == PORT, false)
    fire(s.mock, 2)
    T.eq(s.mock.tlsServers[PORT], nil, "stopped 2 s later")
    -- On again within the 2 s: it is not stopped.
    local again = listening()
    local againHost = status(again).name .. ":28443"
    T.eq(T.http(again.mock, "PUT", "/v1/https", { key = again.key, tls = true, host = againHost, body = { enabled = false } }).status, 200)
    T.eq(T.http(again.mock, "PUT", "/v1/https", { key = again.key, tls = true, host = againHost, body = { enabled = true } }).status, 200)
    T.eq(hasTimer(again.mock, 2), false, "the stop was called off")
    T.truthy(again.mock.tlsServers[PORT])
    -- Composer's Off stops it at once (no request of the app's is on it).
    setProperty("Direct HTTPS", "Off")
    T.eq(again.mock.tlsServers[PORT], nil)
end

function tests.not_after_is_iso_8601_everywhere()
    local s, _, _, notAfter = listening()
    local pattern = "^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%dZ$"
    T.truthy(notAfter:match(pattern))
    T.truthy(status(s).certificate.not_after:match(pattern), status(s).certificate.not_after)
    T.eq(status(s).certificate.not_after, notAfter)
    local system = T.http(s.mock, "GET", "/v1/system", { key = s.key }).json
    T.truthy(system.direct_https.not_after:match(pattern), system.direct_https.not_after)
    T.eq(system.direct_https.not_after, notAfter)
end

function tests.errors_are_short_sentences_for_the_owner()
    local texts = {}
    local function collect(s)
        local text = status(s).error
        T.truthy(type(text) == "string", "an error")
        texts[#texts + 1] = text
    end
    for _, code in ipairs({ "HTTPS_UNAVAILABLE", "NOT_CLAIMED", "RATE_LIMITED", "ACME_FAILED", "DNS_FAILED", "ADDRESS_NEEDED",
        "INVALID_REQUEST", "INTERNAL", "SOMETHING_NEW" }) do
        local s = home()
        local asked = turnOn(s)
        relaySays(s, { type = "https_certificate_result", id = asked.id, ok = false, code = code })
        collect(s)
    end
    local oldOs = home({ prepare = function(m)
        m.csrMode = "csr_only"
    end })
    switch(oldOs, true)
    collect(oldOs)
    local noRemote = listening({ from = os.time() - 80 * DAY, to = os.time() + 10 * DAY })
    setProperty("Remote Access", "Off")
    collect(noRemote)
    for _, text in ipairs(texts) do
        T.truthy(#text <= 120, text)
        T.truthy(text:match("^%u") and text:match("%.$"), "a sentence: " .. text)
        T.truthy(not text:match("%u%u+_%u"), "no code: " .. text)
        T.truthy(not text:find("C4:", 1, true), "nothing of Director's: " .. text)
    end
end

function tests.a_handle_reused_after_a_tls_connection_never_takes_the_name_on_41999()
    local s, asked = listening()
    local mock, name = s.mock, asked.name
    local handle = 9001
    local function request(identifier)
        mock.sent[handle], mock.closed[handle] = nil, nil
        OnServerDataIn(handle, "GET /v1/health HTTP/1.1\r\nHost: " .. name .. "\r\n\r\n", "192.168.1.50", "50123", identifier)
        return T.response(mock, handle).status
    end
    -- A TLS connection (a Director without identifiers: by its port) whose close was never told,
    -- then a plain connection on 41999 with the same handle.
    OnServerConnectionStatusChanged(handle, 28443, "ONLINE", "192.168.1.50")
    OnServerConnectionStatusChanged(handle, 41999, "ONLINE", "192.168.1.51")
    T.eq(request(nil), 421, "the mark went with its connection")
    -- One that sent half a request first.
    OnServerConnectionStatusChanged(handle, 28443, "ONLINE", "192.168.1.50")
    OnServerDataIn(handle, "GET /v1/health HTTP/1.1\r\n", "192.168.1.50", "50123", nil)
    OnServerConnectionStatusChanged(handle, 41999, "ONLINE", "192.168.1.51")
    T.eq(request(nil), 421)
    -- Closed: nothing left.
    OnServerConnectionStatusChanged(handle, 28443, "ONLINE", "192.168.1.50")
    OnServerConnectionStatusChanged(handle, 28443, "OFFLINE", "192.168.1.50")
    T.eq(request(nil), 421)
    -- A mark whose connection said nothing for longer than a stale connection lives.
    OnServerConnectionStatusChanged(handle, 28443, "ONLINE", "192.168.1.50")
    later(31, function()
        T.eq(request(nil), 421)
    end)
    -- The TLS connection itself still takes it.
    OnServerConnectionStatusChanged(handle, 28443, "ONLINE", "192.168.1.50")
    T.eq(request(nil), 200)
    T.eq(request("https"), 200)
end

function tests.a_tls_server_that_goes_offline_is_started_again()
    local s = listening()
    local calls = #s.mock.tlsCalls
    OnServerStatusChanged(PORT, "OFFLINE", "https")
    local current = status(s)
    T.eq(current.state, "error")
    T.eq(current.error, "The controller's HTTPS server stopped. Trying again in a minute.")
    T.eq(T.http(s.mock, "GET", "/v1/system", { key = s.key }).json.direct_https, Json.null)
    s.mock.tlsFails = "address in use"
    fire(s.mock, 10)
    T.eq(#s.mock.tlsCalls, calls + 1, "started again after 10 s")
    T.eq(s.mock.destroyedServers[#s.mock.destroyedServers], PORT, "the old one by its port first")
    T.eq(status(s).error, "The controller couldn't start its HTTPS server. Trying again in a minute.")
    s.mock.tlsFails = nil
    fire(s.mock, 30)
    T.eq(#s.mock.tlsCalls, calls + 2, "then after 30 s")
    OnServerStatusChanged(PORT, "ONLINE", "https")
    T.eq(status(s).state, "listening")
    T.eq(status(s).error, Json.null)
    -- Started, and Director never says it is online: counts as not started.
    OnServerStatusChanged(PORT, "OFFLINE", "https")
    fire(s.mock, 10)
    T.eq(status(s).state, "error")
    fire(s.mock, 30)
    T.truthy(hasTimer(s.mock, 30), "started again after the next wait")
    T.eq(status(s).error, "The controller couldn't start its HTTPS server. Trying again in a minute.")
    -- Off: nothing is started again.
    switch(s, false)
    fire(s.mock, 2)
    T.eq(#httpsTimers(s.mock, false), 0)
end

function tests.a_new_certificate_that_cannot_start_the_server_leaves_the_old_one_running()
    local now = os.time()
    local s, _, oldLeaf, oldEnd = listening({ from = now - 50 * DAY, to = now + 40 * DAY })
    later(21 * DAY, function()
        tick(s.mock)
        local renewal = httpsMessages(s)[1]
        local newLeaf = certificateFor(renewal, { from = os.time(), serial = 2 })
        s.mock.tlsRefuses = { [newLeaf] = "unusable certificate" }
        local calls = #s.mock.tlsCalls
        relaySays(s, { type = "https_certificate_result", id = renewal.id, ok = true, status = "issued", name = renewal.name,
            certificate = newLeaf, chain = INTERMEDIATE, not_after = "x" })
        T.eq(#s.mock.tlsCalls, calls + 2, "the new one tried, then the old one again")
        T.eq(s.mock.tlsCalls[calls + 1].certificate, newLeaf)
        T.eq(s.mock.tlsServers[PORT].certificate, oldLeaf, "the old certificate serves")
        T.eq(stored(s.mock).certificate, oldLeaf, "and stays stored")
        OnServerStatusChanged(PORT, "ONLINE", "https")
        local current = status(s)
        T.eq(current.state, "listening")
        T.eq(current.certificate.not_after, oldEnd)
        T.eq(current.error, "The new certificate couldn't start the HTTPS server. Trying again in 5 minutes.")
        T.contains(logText(s.mock), "unusable certificate")
        -- A good one later replaces it.
        fire(s.mock, 300)
        local again = httpsMessages(s)[1]
        local good = issued(s, again, { from = os.time(), serial = 3 })
        T.eq(s.mock.tlsServers[PORT].certificate, good)
        T.eq(stored(s.mock).certificate, good)
    end)
end

function tests.the_host_check_takes_no_name_before_there_is_one()
    local s = home({ allowed = false })
    T.eq(T.http(s.mock, "GET", "/v1/health", { tls = true, host = "abcdefghijabcdefghij.dlhome.cc" }).status, 421)
end

return tests
