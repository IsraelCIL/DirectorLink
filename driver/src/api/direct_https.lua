-- Direct HTTPS (1.12.0, ADR-082): the same LAN API also over TLS, on port 28443, under a name of the
-- home's own (20 random letters and digits under dlhome.cc) whose public DNS record points at the
-- controller's LAN address, with a publicly trusted certificate for that name. An iPhone or iPad
-- then reaches the controller from https://app.directorlink.io at home, which WebKit refuses over
-- plain HTTP (mixed content).
--
-- Two switches: the installer allows it in Composer (the property Direct HTTPS: Off, the default,
-- or Allowed), then the home's owner turns it on in the app (PUT /v1/https). It needs Remote Access
-- and a home linked to an account: the certificate comes through DirectorLink's servers.
--
-- Once on, the controller makes its name, a P-256 key and its certificate request (CSR) once, and
-- asks DirectorLink's servers for a certificate over the relay's connection (docs/RELAY.md,
-- `https_certificate`): the Worker gets it from Let's Encrypt (DNS-01) and writes the name's A
-- record, the controller's LAN address, which the controller tells it (`https`) at every connection
-- and when it changes. The answer comes later (`https_certificate_result`, tens of seconds); the
-- certificate is kept only when it is for this key and name and valid, then the TLS server starts
-- with it. Asked again when less than a third of its lifetime is left (looked at every 10 minutes),
-- with a backoff after a refusal. Turned off (by the owner, or Composer back to Off): the TLS server
-- stops, the certificate is forgotten (it expires by itself) and the Worker deletes the A record.
--
-- Requests on the TLS server go through exactly what port 41999 does (src/api/server.lua); the Host
-- check also takes the name there. The private key is stored with the driver's data
-- (src/core/store.lua, like the home secret), and never logged, answered, printed, sent or put in a
-- backup: only the CSR leaves the controller.

local Json = require("src.core.json")
local Store = require("src.core.store")
local Random = require("src.core.random")
local Clock = require("src.core.clock")
local X509 = require("src.core.x509")

local DirectHttps = {}

DirectHttps.PORT = 28443
-- Given to C4:CreateTLSServer and passed back by Director's server callbacks (OS 3.3.1 and newer),
-- so that they tell this server from the API's own on 41999.
DirectHttps.IDENTIFIER = "https"
DirectHttps.PROPERTY = "Direct HTTPS"
DirectHttps.STATUS_PROPERTY = "Direct HTTPS Status"
DirectHttps.ALLOWED = "Allowed"
DirectHttps.DOMAIN = "dlhome.cc"
DirectHttps.LABEL_LENGTH = 20
DirectHttps.STORE_KEY = "directorlink_https"
DirectHttps.STORE_VERSION = 2
-- C4:CreateTLSServer: options 0 is Director's default 0x3D (no SSLv2, SSLv3, TLS 1.0 or 1.1: TLS
-- 1.2 and 1.3 only); verify mode 1 is SSL_VERIFY_NONE (0 would be 0x0A, which asks every client for
-- a certificate); the cipher list "" is Director's default; the key has no password.
DirectHttps.TLS_OPTIONS = 0
DirectHttps.VERIFY_MODE = 1
-- C4:GenerateCSR_ECC: P-256 ("prime256v1"), which public CAs take (Let's Encrypt refuses secp256k1).
DirectHttps.DIGEST = "SHA256"
DirectHttps.CURVE = "prime256v1"
DirectHttps.MAX_PEM_BYTES = 16 * 1024
-- What the relay lists in `relay_features` when it issues certificates (docs/RELAY.md).
DirectHttps.FEATURE = "https"
-- The address and the certificate's age are looked at this often (and at every connection).
DirectHttps.TICK_SECONDS = 600
-- The relay answers a request for a certificate within this long (pending, issued or refused), and
-- a pending one's certificate comes within ISSUE_SECONDS (the Worker gives up on an order after 10
-- minutes); otherwise it counts as a failure.
DirectHttps.ANSWER_SECONDS = 60
DirectHttps.ISSUE_SECONDS = 900
-- After a refusal or no answer: 5 minutes, 15, an hour, 6 hours, then once a day; longer when the
-- Worker says so (retry_s), at most a week.
DirectHttps.BACKOFF_SECONDS = { 300, 900, 3600, 6 * 3600, 24 * 3600 }
DirectHttps.MAX_RETRY_SECONDS = 7 * 24 * 3600
-- Asked again when less than this part of the certificate's lifetime is left (30 of Let's Encrypt's
-- 90 days).
DirectHttps.RENEW_PART = 3
-- A new name or key because of the Worker's answer (NAME_MISMATCH, NAME_TAKEN, INVALID_CSR): at most
-- this many a start, so that a Worker that keeps refusing cannot make the controller make keys.
DirectHttps.MAX_REMAKES = 3
-- A certificate the Worker gave that is due all the same (its clock and the controller's differ):
-- asked again after this long, not at once.
DirectHttps.SAME_WAIT_SECONDS = 6 * 3600
-- A TLS server that went offline, or could not be started, while it should listen: started again
-- after 10 s, 30 s, a minute, 5 minutes, then every 15 minutes. One that Director has not said is
-- online within SERVER_WATCH_SECONDS counts as not started.
DirectHttps.SERVER_RETRY_SECONDS = { 10, 30, 60, 300, 900 }
DirectHttps.SERVER_WATCH_SECONDS = 30
-- The owner turned it off: the TLS server stops this long after, so that the answer to that request
-- (it may have come over the TLS server itself) has gone out whole first.
DirectHttps.STOP_DELAY_SECONDS = 2

local BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

-- `error` in GET /v1/https, which the app shows the owner word for word, and Composer's status: short
-- sentences. What Director said goes to the log.
local WORDS = {
    OLD_OS = "This controller's OS is too old for Direct HTTPS. It needs OS 3.3.1 or later.",
    KEY_FAILED = "The controller couldn't make its key.",
    KEY_UNREADABLE = "The controller made a key it can't use.",
    KEY_NOT_SAVED = "The controller couldn't save its key.",
    SERVER_FAILED = "The controller couldn't start its HTTPS server.",
    SERVER_STOPPED = "The controller's HTTPS server stopped.",
    REMOTE = "It needs Remote Access and the home linked to an account.",
}

-- What the Worker's codes (docs/RELAY.md) and the controller's own refusals mean, in the same words.
local REFUSALS = {
    HTTPS_UNAVAILABLE = "DirectorLink's servers can't issue certificates right now.",
    NOT_CLAIMED = "The home isn't linked to an account.",
    RATE_LIMITED = "Too many certificates were asked for.",
    ACME_FAILED = "Let's Encrypt didn't issue the certificate.",
    DNS_FAILED = "The home's name couldn't be set up.",
    ADDRESS_NEEDED = "The controller's address isn't a home network address.",
    INVALID_CSR = "DirectorLink's servers refused the controller's key.",
    INVALID_REQUEST = "DirectorLink's servers refused the request.",
    NAME_TAKEN = "The home's name belongs to another home.",
    NAME_MISMATCH = "The home has another name at DirectorLink's servers.",
    CERTIFICATE_MISMATCH = "The certificate received isn't for this controller.",
    SERVER_FAILED = "The new certificate couldn't start the HTTPS server.",
    NO_ANSWER = "DirectorLink's servers didn't answer in time.",
    NO_FEATURE = "DirectorLink's servers can't issue certificates yet.",
    ADDRESS_UNKNOWN = "The controller's address is unknown.",
    INTERNAL = "DirectorLink's servers failed.",
}

local state = {
    configured = false,
    log = nil,
    allowed = function()
        return false
    end,
    -- Remote Access is on and the home linked to an account (main.lua).
    remote = function()
        return false
    end,
    -- The relay's connection (src/cloud/relay.lua): features() (nil until the relay said what it
    -- does on this connection), tell(message), connection() (its number).
    relay = nil,
    -- The controller's LAN address (C4:GetControllerNetworkAddress), or nil.
    address = nil,
    -- History (src/core/activity.lua).
    activity = nil,
    onStatus = nil,
    -- The stored record: { version, name, key, csr, created_at, enabled, dns_off, certificate,
    -- chain, not_before, not_after, issuer_cn, installed_at }; nil when there is none.
    stored = nil,
    -- The certificate's times, read from it: { from, to } (Unix seconds), false when unreadable.
    times = nil,
    -- C4:CreateTLSServer was called and the server not destroyed since; ONLINE seen since then.
    created = false,
    listening = false,
    -- Why it cannot work without help: no key could be made, an OS without the TLS server.
    hardError = nil,
    -- The TLS server is not running while it should (it could not be started, or went offline):
    -- the words, when it is started again (retry_at), the timer, how many times in a row, and the
    -- wait for Director's ONLINE after a start.
    serverError = nil,
    serverRetryAt = nil,
    serverTimer = nil,
    serverFailures = 0,
    serverWatch = nil,
    -- The owner turned it off: the TLS server stops when this timer fires (STOP_DELAY_SECONDS).
    stopTimer = nil,
    deferStop = false,
    -- The Worker's last refusal (or no answer), { code, retry_at }, and how many in a row.
    failure = nil,
    failures = 0,
    retryTimer = nil,
    -- The request for a certificate waiting for its answer: { id, pending, timer }.
    asking = nil,
    -- The address told on a connection, and the message telling it: { id, ip, connection }.
    told = nil,
    telling = nil,
    -- The id of the `https` message asking the Worker to delete the A record.
    offAsking = nil,
    tick = nil,
    remakes = 0,
    asked = 0,
    shown = nil,
}

local function log(level, message, data)
    if state.log then
        state.log.write(level, "https", message, data)
    end
end

-- A short, single-line text from Director, never more than 200 characters.
local function short(value)
    return (tostring(value or ""):gsub("%s+", " "):sub(1, 200))
end

-- Whether Director offers C4:<name> (an older OS may not).
local function has(name)
    local ok, value = pcall(function()
        return C4[name]
    end)
    return ok and type(value) == "function"
end

local function call(fn, ...)
    if type(fn) ~= "function" then
        return nil
    end
    local ok, value = pcall(fn, ...)
    if ok then
        return value
    end
    return nil
end

local function allowed()
    return call(state.allowed) == true
end

local function remoteReady()
    return call(state.remote) == true
end

local function isText(value)
    return type(value) == "string" and value ~= ""
end

local function validName(value)
    return type(value) == "string" and #value == DirectHttps.LABEL_LENGTH + 1 + #DirectHttps.DOMAIN
        and value:sub(1, DirectHttps.LABEL_LENGTH):match("^[a-z2-7]+$") ~= nil
        and value:sub(DirectHttps.LABEL_LENGTH + 1) == "." .. DirectHttps.DOMAIN
end

local function cancel(timer)
    if timer then
        pcall(function()
            timer:Cancel()
        end)
    end
end

local function after(seconds, callback)
    local timer
    pcall(function()
        timer = C4:SetTimer(seconds * 1000, callback, false)
    end)
    return timer
end

local function load()
    local data, form = Store.read(DirectHttps.STORE_KEY, false)
    state.stored, state.times = nil, nil
    if form == "unreadable" then
        -- Nothing can be known of it, the owner's switch neither: off, until the owner turns it on
        -- again, which writes a new record (the Worker gives the home's name back: NAME_MISMATCH).
        log("error", "the stored key could not be read; Direct HTTPS is off until the home's owner turns it on again")
        return form
    end
    if type(data) == "table" and validName(data.name) then
        local record = { version = DirectHttps.STORE_VERSION, name = data.name, created_at = data.created_at }
        -- The owner's switch (version 2). The test build's record (version 1) had none: off.
        record.enabled = data.version == DirectHttps.STORE_VERSION and data.enabled == true or nil
        record.dns_off = data.dns_off == true or nil
        if isText(data.key) and isText(data.csr) then
            record.key, record.csr = data.key, data.csr
            if isText(data.certificate) and isText(data.chain) then
                record.certificate, record.chain = data.certificate, data.chain
                record.not_before, record.not_after = data.not_before, data.not_after
                record.issuer_cn, record.installed_at = data.issuer_cn, data.installed_at
            end
        end
        state.stored = record
    end
    return form
end

local function save()
    return Store.write(DirectHttps.STORE_KEY, state.stored, false)
end

-- 20 base32 letters from the driver's random pool (src/core/random.lua): 100 bits. A byte each, its
-- low five bits (256 is a multiple of 32: no bias). Not Random.below: it reads 52 bits with
-- tonumber(hex, 16), which a Lua whose unsigned long has 32 bits caps at 4294967295.
local function newName()
    local label = {}
    local random = Random.bytes(DirectHttps.LABEL_LENGTH)
    for index = 1, DirectHttps.LABEL_LENGTH do
        local value = random:byte(index) % 32
        label[index] = BASE32:sub(value + 1, value + 1)
    end
    return table.concat(label) .. "." .. DirectHttps.DOMAIN
end

-- The stored CSR, read: its public key and curve.
local function request()
    local stored = state.stored
    local blocks = stored and stored.csr and X509.pemBlocks(stored.csr, "CERTIFICATE REQUEST")
    if not blocks or not blocks[1] then
        return nil
    end
    return X509.readRequest(blocks[1])
end

local function hasKey()
    return state.stored ~= nil and state.stored.key ~= nil
end

local function hasCertificate()
    return hasKey() and state.stored.certificate ~= nil
end

local function switchedOn()
    return state.stored ~= nil and state.stored.enabled == true
end

local function isOn()
    return allowed() and switchedOn()
end

-- The certificate's times, { from, to } in Unix seconds, or nil.
local function certificateTimes()
    if not hasCertificate() then
        return nil
    end
    if state.times == nil then
        local blocks = X509.pemBlocks(state.stored.certificate, "CERTIFICATE")
        local leaf = blocks and blocks[1] and X509.readCertificate(blocks[1])
        state.times = leaf and { from = leaf.not_before_s, to = leaf.not_after_s } or false
    end
    return state.times or nil
end

-- A certificate that browsers take now: not expired, and not dated more than 5 minutes ahead.
local function validNow()
    local times = certificateTimes()
    local now = Clock.now()
    return times ~= nil and times.to > now and times.from <= now + 300
end

local function expired()
    local times = certificateTimes()
    return times == nil or times.to <= Clock.now()
end

-- No certificate, or less than a third of its lifetime left.
local function renewalDue()
    local times = certificateTimes()
    if not times then
        return true
    end
    local life = times.to > times.from and times.to - times.from or 90 * 86400
    return times.to - Clock.now() < life / DirectHttps.RENEW_PART
end

-- The relay's features on this connection: a table, or nil while not connected or not said yet.
local function relayFeatures()
    return state.relay and call(state.relay.features) or nil
end

local function relayTakes()
    local features = relayFeatures()
    return features ~= nil and features[DirectHttps.FEATURE] == true
end

local function connectionNumber()
    return state.relay and call(state.relay.connection) or nil
end

local function tell(message)
    return state.relay ~= nil and call(state.relay.tell, message) == true
end

local function newId()
    state.asked = state.asked + 1
    return "h" .. state.asked .. "-" .. os.time()
end

-- A private IPv4 address (10/8, 172.16/12, 192.168/16): the only ones the Worker writes.
local function privateAddress(ip)
    if type(ip) ~= "string" then
        return false
    end
    local a, b, c, d = ip:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
    a, b, c, d = tonumber(a), tonumber(b), tonumber(c), tonumber(d)
    if not a or a > 255 or b > 255 or c > 255 or d > 255 then
        return false
    end
    return a == 10 or (a == 172 and b >= 16 and b <= 31) or (a == 192 and b == 168)
end

local function address()
    local ip = state.address and call(state.address)
    if type(ip) == "string" and ip:match("^%d+%.%d+%.%d+%.%d+$") then
        return ip
    end
    return nil
end

-- "Trying again in 5 minutes.", from when it will be.
local function retryWords(at)
    local seconds = (tonumber(at) or 0) - Clock.now()
    if seconds <= 60 then
        return "Trying again in a minute."
    end
    local minutes = math.ceil(seconds / 60)
    if minutes < 60 then
        return "Trying again in " .. minutes .. " minutes."
    end
    local hours = math.floor(minutes / 60 + 0.5)
    if hours < 36 then
        return hours == 1 and "Trying again in an hour." or ("Trying again in " .. hours .. " hours.")
    end
    local days = math.floor(hours / 24 + 0.5)
    return days == 1 and "Trying again in a day." or ("Trying again in " .. days .. " days.")
end

-- What GET /v1/https says in `error`, or nil: a sentence or two, for the owner.
local function errorText()
    if not isOn() then
        return nil
    end
    if state.hardError then
        return state.hardError
    end
    local listening = state.listening and validNow()
    if state.serverError and not listening then
        return state.serverError .. " " .. retryWords(state.serverRetryAt)
    end
    if not remoteReady() then
        if listening and not renewalDue() then
            return nil
        end
        return WORDS.REMOTE
    end
    if state.failure then
        local text = REFUSALS[state.failure.code] or REFUSALS.INTERNAL
        if state.failure.retry_at then
            text = text .. " " .. retryWords(state.failure.retry_at)
        end
        return text
    end
    local features = relayFeatures()
    if features ~= nil and not features[DirectHttps.FEATURE] and not listening then
        return REFUSALS.NO_FEATURE
    end
    return nil
end

function DirectHttps.state()
    if not allowed() then
        return "not_allowed"
    elseif not switchedOn() then
        return "off"
    elseif state.listening and validNow() then
        return "listening"
    elseif errorText() then
        return "error"
    end
    return "requesting"
end

local function statusText()
    local current = DirectHttps.state()
    local name = state.stored and state.stored.name
    if current == "not_allowed" then
        return "Off"
    elseif current == "off" then
        return "Allowed: the home's owner turns it on in the app"
    elseif current == "error" then
        return "Error: " .. tostring(errorText()):gsub("%.$", "")
    elseif current == "requesting" then
        return "Asking for a certificate" .. (name and (" for " .. name) or "")
    end
    return "Listening on " .. name .. ":" .. DirectHttps.PORT .. ", certificate until " .. tostring(state.stored.not_after)
end

local function publish()
    local text = statusText()
    if text ~= state.shown then
        state.shown = text
        if state.onStatus then
            pcall(state.onStatus, text)
        end
    end
end

local function cancelWatch()
    cancel(state.serverWatch)
    state.serverWatch = nil
end

local function stopServerRetry()
    cancel(state.serverTimer)
    state.serverTimer, state.serverRetryAt, state.serverError, state.serverFailures = nil, nil, nil, 0
end

local function destroyServer(reason)
    cancelWatch()
    if not state.created then
        return
    end
    -- By port: Director's DestroyServer names no identifier. Never without one: that would end the
    -- API's own server on 41999 too.
    pcall(function()
        C4:DestroyServer(DirectHttps.PORT)
    end)
    state.created, state.listening = false, false
    log("info", "TLS server stopped", { port = DirectHttps.PORT, name = state.stored and state.stored.name or Json.null, reason = reason })
end

local serverTrouble

-- The TLS server with the stored certificate and key. Returns true, or false and what Director
-- said (for the log). Director says ONLINE once it listens; without that within
-- SERVER_WATCH_SECONDS it counts as not started.
local function createServer()
    local stored = state.stored
    if not has("CreateTLSServer") then
        state.hardError = WORDS.OLD_OS
        log("error", "TLS server failed", { port = DirectHttps.PORT, name = stored.name, detail = "C4:CreateTLSServer is missing" })
        return false, "C4:CreateTLSServer is missing"
    end
    local ok, result, failure = pcall(function()
        return C4:CreateTLSServer(DirectHttps.PORT, "", DirectHttps.TLS_OPTIONS, DirectHttps.VERIFY_MODE, "",
            stored.certificate, stored.key, "", stored.chain, DirectHttps.IDENTIFIER)
    end)
    if not ok or result == false then
        local detail = short(ok and failure or result)
        log("error", "TLS server failed", { port = DirectHttps.PORT, name = stored.name, detail = detail })
        return false, detail
    end
    state.created, state.listening = true, false
    cancelWatch()
    local watch
    watch = after(DirectHttps.SERVER_WATCH_SECONDS, function()
        if state.serverWatch == watch then
            state.serverWatch = nil
            if state.created and not state.listening and isOn() then
                log("warn", "TLS server not online " .. DirectHttps.SERVER_WATCH_SECONDS .. " s after it was started", { port = DirectHttps.PORT })
                serverTrouble(WORDS.SERVER_FAILED)
                publish()
            end
        end
    end)
    state.serverWatch = watch
    log("info", "TLS server started", { port = DirectHttps.PORT, name = stored.name, not_after = stored.not_after or Json.null })
    return true
end

-- The TLS server should listen and does not (`words`: why, for the owner): started again after the
-- next step of SERVER_RETRY_SECONDS, while it still should then.
serverTrouble = function(words)
    state.serverError = words
    if state.serverTimer then
        return
    end
    state.serverFailures = state.serverFailures + 1
    local wait = DirectHttps.SERVER_RETRY_SECONDS[math.min(state.serverFailures, #DirectHttps.SERVER_RETRY_SECONDS)]
    state.serverRetryAt = Clock.now() + wait
    local timer
    timer = after(wait, function()
        if state.serverTimer ~= timer then
            return
        end
        state.serverTimer = nil
        if not isOn() or not hasCertificate() or not validNow() or state.listening then
            publish()
            return
        end
        log("info", "TLS server started again", { port = DirectHttps.PORT, tries = state.serverFailures })
        destroyServer("started again")
        if not createServer() then
            serverTrouble(WORDS.SERVER_FAILED)
        end
        publish()
    end)
    state.serverTimer = timer
    log("warn", "TLS server not running; started again later", { port = DirectHttps.PORT, retry_s = wait, failures = state.serverFailures })
end

-- A key and CSR for `name` (the stored name, or a new one the first time). Returns true, or false
-- with state.hardError set; what was stored stays as it was when it fails. The certificate goes
-- with the old key.
local function makeKey(name)
    name = name or (state.stored and state.stored.name) or newName()
    if not has("GenerateCSR_ECC") then
        state.hardError = WORDS.OLD_OS
        log("error", "no key made", { name = name, detail = "C4:GenerateCSR_ECC is missing" })
        return false
    end
    -- The name in the subject only: Director (OS 4.2.1) writes a subjectAltName given here as the
    -- extension's raw text, not as DER, and Let's Encrypt refuses that CSR ("x509: invalid subject
    -- alternative names"); a CSR with only the CN gets a certificate whose SAN is that name.
    local ok, csr, publicKey, privateKey = pcall(function()
        return C4:GenerateCSR_ECC(DirectHttps.DIGEST, DirectHttps.CURVE, "/CN=" .. name)
    end)
    if not ok then
        ok, csr, publicKey, privateKey = pcall(function()
            return C4:GenerateCSR_ECC(DirectHttps.DIGEST, DirectHttps.CURVE, "/CN=" .. name, {})
        end)
    end
    if not ok or not isText(csr) then
        state.hardError = WORDS.KEY_FAILED
        log("error", "no key made", { name = name, detail = short(ok and publicKey or csr) })
        return false
    end
    -- Before OS 3.3.1 the function gives only the CSR: its key stays inside Director.
    if not isText(privateKey) or not privateKey:find("PRIVATE KEY-----", 1, true) then
        state.hardError = WORDS.OLD_OS
        log("error", "no key made", { name = name, detail = "C4:GenerateCSR_ECC gave no private key (it does from OS 3.3.1)",
            returned = isText(publicKey) and "csr and public key" or "csr only" })
        return false
    end
    local blocks = X509.pemBlocks(csr, "CERTIFICATE REQUEST")
    local parsed = blocks and blocks[1] and X509.readRequest(blocks[1])
    if not parsed then
        state.hardError = WORDS.KEY_UNREADABLE
        log("error", "no key made", { name = name, detail = "the certificate request Director made could not be read" })
        return false
    end
    local previous = state.stored
    state.stored = {
        version = DirectHttps.STORE_VERSION,
        name = name,
        key = privateKey,
        csr = X509.pem(blocks[1], "CERTIFICATE REQUEST"),
        created_at = Clock.iso(),
        enabled = previous and previous.enabled or nil,
        dns_off = previous and previous.dns_off or nil,
    }
    if not save() then
        state.stored = previous
        state.hardError = WORDS.KEY_NOT_SAVED
        log("error", "no key made", { name = name, detail = "the store did not take it" })
        return false
    end
    state.times, state.hardError = nil, nil
    destroyServer("new key")
    log("info", "key and certificate request made", { name = name, curve = parsed.curve or Json.null })
    return true
end

-- The certificate is no longer used: the TLS server stops, and it is forgotten (it expires by
-- itself). The name and the key stay.
local function forgetCertificate(reason, keepServer)
    if not keepServer then
        destroyServer(reason)
    end
    local stored = state.stored
    if stored and stored.certificate then
        stored.certificate, stored.chain, stored.not_before, stored.not_after = nil, nil, nil, nil
        stored.issuer_cn, stored.installed_at = nil, nil
        state.times = nil
        save()
        log("info", "certificate forgotten", { name = stored.name, reason = reason })
    end
end

local function stopRetry()
    cancel(state.retryTimer)
    state.retryTimer = nil
end

local function clearAsking()
    if state.asking then
        cancel(state.asking.timer)
    end
    state.asking = nil
end

local sync

-- The Worker refused (or did not answer): `code`, and its retry_s. Asked again after the backoff's
-- next step, or after retry_s when it is longer.
local function failed(code, retrySeconds)
    state.failures = state.failures + 1
    local wait = DirectHttps.BACKOFF_SECONDS[math.min(state.failures, #DirectHttps.BACKOFF_SECONDS)]
    local asked = tonumber(retrySeconds)
    if asked and asked > wait then
        wait = math.min(math.floor(asked), DirectHttps.MAX_RETRY_SECONDS)
    end
    state.failure = { code = tostring(code or "INTERNAL"), retry_at = Clock.now() + wait }
    stopRetry()
    state.retryTimer = after(wait, function()
        state.retryTimer = nil
        sync("retry")
    end)
    log("warn", "no certificate from DirectorLink's servers", { code = state.failure.code, failures = state.failures, retry_s = wait })
end

local function succeeded()
    state.failures, state.failure = 0, nil
    stopRetry()
end

local function nameCovered(names, name)
    local parent = name:match("^[^.]+%.(.+)$")
    for _, dnsName in ipairs(names) do
        if dnsName == name or (parent and dnsName == "*." .. parent) then
            return true
        end
    end
    return false
end

local function certificateBlocks(text)
    if type(text) ~= "string" or #text > DirectHttps.MAX_PEM_BYTES then
        return nil
    end
    local blocks = X509.pemBlocks(text, "CERTIFICATE")
    if not blocks then
        return nil
    end
    for _, der in ipairs(blocks) do
        if not X509.readCertificate(der) then
            return nil
        end
    end
    return blocks
end

-- The certificate the Worker sent (`certificate`, PEM, maybe followed by its issuers; `chain`, the
-- issuers): kept only when it is for this controller's key and name, valid now, with at least one
-- issuer (iPhones and iPads do not fetch a missing one). Then the TLS server starts again with it.
-- The running server is replaced only once the new certificate has started one (Director takes one
-- server a port): when it cannot, the one before comes back while its certificate is valid.
-- Returns true, or false, why not (for the log; never the certificate's text) and its code.
local function install(certificateText, chainText)
    if not hasKey() then
        return false, "no key"
    end
    local leafBlocks = certificateBlocks(certificateText)
    if not leafBlocks or #leafBlocks == 0 then
        return false, "not a certificate"
    end
    local chainBlocks = {}
    if chainText ~= nil and chainText ~= Json.null then
        chainBlocks = certificateBlocks(chainText)
        if not chainBlocks then
            return false, "the chain is not certificates"
        end
    end
    local leafDer = leafBlocks[1]
    local intermediates, seen = {}, { [leafDer] = true }
    for index = 2, #leafBlocks + #chainBlocks do
        local der = leafBlocks[index] or chainBlocks[index - #leafBlocks]
        if not seen[der] then
            seen[der] = true
            intermediates[#intermediates + 1] = der
        end
    end
    if #intermediates == 0 then
        return false, "no issuer certificate"
    end
    local leaf = X509.readCertificate(leafDer)
    local own = request()
    if not own or leaf.public_key ~= own.public_key or leaf.algorithm ~= own.algorithm then
        return false, "not for this controller's key"
    end
    local name = state.stored.name
    if not nameCovered(leaf.dns_names, name) then
        return false, "not for " .. name
    end
    if leaf.not_after_s <= Clock.now() then
        return false, "expired"
    end
    local leafPem = X509.pem(leafDer, "CERTIFICATE")
    if state.stored.certificate == leafPem and state.created then
        return true, "the same"
    end
    local chainPem = {}
    for _, der in ipairs(intermediates) do
        chainPem[#chainPem + 1] = X509.pem(der, "CERTIFICATE")
    end
    local previous = {}
    for field, value in pairs(state.stored) do
        previous[field] = value
    end
    local oldWorks = hasCertificate() and validNow()
    state.stored.certificate = leafPem
    state.stored.chain = table.concat(chainPem)
    state.stored.not_before = leaf.not_before
    state.stored.not_after = leaf.not_after
    state.stored.issuer_cn = leaf.issuer_cn
    state.stored.installed_at = Clock.iso()
    state.times = nil
    -- The old server goes first: Director takes one server a port.
    destroyServer("new certificate")
    cancel(state.serverTimer)
    state.serverTimer, state.serverRetryAt, state.serverError = nil, nil, nil
    local started, detail = createServer()
    if not started and oldWorks then
        state.stored, state.times = previous, nil
        log("warn", "the new certificate did not start the TLS server; the one before is used again", { name = name, detail = detail or Json.null })
        if not createServer() then
            serverTrouble(WORDS.SERVER_FAILED)
        end
        return false, "it did not start the TLS server", "SERVER_FAILED"
    end
    if not started then
        -- Nothing to go back to: kept, and the server started again later.
        serverTrouble(WORDS.SERVER_FAILED)
    end
    if not save() then
        log("warn", "the certificate could not be saved; it is used until the driver restarts", { name = name })
    end
    log("info", "certificate installed", {
        name = name,
        not_after = leaf.not_after,
        issuer_cn = leaf.issuer_cn or Json.null,
        intermediates = #intermediates,
    })
    return true
end

-- Asks the Worker for a certificate for the stored CSR (docs/RELAY.md, `https_certificate`), with
-- the controller's address for the A record.
local function ask(ip)
    local id = newId()
    local message = { type = "https_certificate", id = id, name = state.stored.name, csr = state.stored.csr, ip = ip }
    if not tell(message) then
        return
    end
    local asking = { id = id, pending = false }
    asking.timer = after(DirectHttps.ANSWER_SECONDS, function()
        if state.asking == asking then
            state.asking = nil
            log("warn", "no answer to the request for a certificate", { name = state.stored and state.stored.name or Json.null })
            failed("NO_ANSWER")
            sync("no answer")
        end
    end)
    state.asking = asking
    if state.telling then
        -- The request carries the address too.
        state.telling = nil
    end
    state.told = { ip = ip, connection = connectionNumber() }
    log("info", "certificate asked for", { name = state.stored.name, renewal = hasCertificate() })
end

-- Tells the Worker the controller's address, for the A record (`https` with the name).
local function tellAddress(ip)
    local id = newId()
    if tell({ type = "https", id = id, name = state.stored.name, ip = ip }) then
        state.telling = { id = id, ip = ip, connection = connectionNumber() }
    end
end

-- Asks the Worker to delete the A record (`https` with name null), once the feature was turned off;
-- again at the next connection until it answers.
local function tellOff()
    if state.offAsking or not relayTakes() then
        return
    end
    local id = newId()
    if tell({ type = "https", id = id, name = Json.null }) then
        state.offAsking = id
        log("info", "asked DirectorLink's servers to delete the home's name", { name = state.stored and state.stored.name or Json.null })
    end
end

-- What is to be done now, from the switches, the certificate and the relay's connection: called at
-- every change (Composer, the owner's switch, the relay, an answer) and every TICK_SECONDS.
sync = function(_reason)
    if not state.configured then
        return
    end
    if not isOn() then
        if state.deferStop and state.created then
            -- The owner's request may be on this server: stopped once its answer has gone.
            if not state.stopTimer then
                state.stopTimer = after(DirectHttps.STOP_DELAY_SECONDS, function()
                    state.stopTimer, state.deferStop = nil, false
                    if not isOn() then
                        destroyServer("turned off")
                        publish()
                    end
                end)
            end
        else
            destroyServer("off")
        end
        stopServerRetry()
        clearAsking()
        stopRetry()
        state.failure, state.failures = nil, 0
        if state.stored and state.stored.dns_off then
            tellOff()
        end
        publish()
        return
    end
    if state.stopTimer then
        -- On again before the server stopped: it stays.
        cancel(state.stopTimer)
        state.stopTimer = nil
    end
    state.deferStop = false
    if not hasKey() and not state.hardError then
        makeKey()
    end
    if not hasKey() then
        publish()
        return
    end
    if hasCertificate() and expired() then
        forgetCertificate("expired")
    end
    if hasCertificate() and validNow() and not state.created and not state.hardError and not state.serverTimer then
        if not createServer() then
            serverTrouble(WORDS.SERVER_FAILED)
        end
    end
    if remoteReady() and relayTakes() and not state.asking then
        local ip = address()
        if renewalDue() then
            if not state.retryTimer then
                if not ip then
                    failed("ADDRESS_UNKNOWN")
                elseif not privateAddress(ip) then
                    failed("ADDRESS_NEEDED")
                else
                    ask(ip)
                end
            end
        elseif ip and privateAddress(ip) and not state.telling then
            local told = state.told
            if not told or told.ip ~= ip or told.connection ~= connectionNumber() then
                tellAddress(ip)
            end
        end
    end
    publish()
end

-- ---- the relay's answers (docs/RELAY.md) ----------------------------------------------------------

local function onCertificateResult(message)
    local asking = state.asking
    local current = asking ~= nil and message.id == asking.id
    if message.ok == true and message.status == "issued" then
        -- Taken whichever request it answers: the certificate itself says whether it is this
        -- controller's (its key, its name, valid).
        if current then
            clearAsking()
        end
        if not isOn() then
            return
        end
        local ok, why, code = install(message.certificate, message.chain)
        if ok then
            succeeded()
            if renewalDue() then
                -- The Worker found it fresh by its clock, this controller not by its own: asked again
                -- later, not at once (it would give the same).
                state.retryTimer = after(DirectHttps.SAME_WAIT_SECONDS, function()
                    state.retryTimer = nil
                    sync("retry")
                end)
                log("info", "the certificate given is due for renewal by this controller's clock; asked again later", { retry_s = DirectHttps.SAME_WAIT_SECONDS })
            end
        else
            log("warn", "certificate refused", { name = state.stored and state.stored.name or Json.null, why = why })
            failed(code or "CERTIFICATE_MISMATCH")
        end
        sync("certificate")
        return
    end
    if not current then
        log("debug", "an answer about a certificate that is no longer asked for", { ok = message.ok == true })
        return
    end
    if message.ok == true and message.status == "pending" then
        asking.pending = true
        cancel(asking.timer)
        asking.timer = after(DirectHttps.ISSUE_SECONDS, function()
            if state.asking == asking then
                state.asking = nil
                log("warn", "no certificate within " .. DirectHttps.ISSUE_SECONDS .. " s", { name = state.stored and state.stored.name or Json.null })
                failed("NO_ANSWER")
                sync("no certificate")
            end
        end)
        log("info", "the certificate is being issued", { name = state.stored.name })
        publish()
        return
    end
    clearAsking()
    local code = type(message.code) == "string" and message.code:sub(1, 40) or "INTERNAL"
    -- The home has its own name at the Worker (this controller's store was lost or replaced, or a
    -- backup moved the home here): that name, with a new key. Another home has this one: a new name.
    -- The Worker refused the CSR: a new key. At most MAX_REMAKES a start.
    local remade = false
    if state.remakes < DirectHttps.MAX_REMAKES and isOn() then
        if code == "NAME_MISMATCH" and validName(message.name) and message.name ~= state.stored.name then
            state.remakes = state.remakes + 1
            log("info", "the home has another name at DirectorLink's servers: taking it", { name = message.name, was = state.stored.name })
            forgetCertificate("another name")
            remade = makeKey(message.name)
        elseif code == "NAME_TAKEN" then
            state.remakes = state.remakes + 1
            log("info", "another home has this name at DirectorLink's servers: a new one", { was = state.stored.name })
            forgetCertificate("another name")
            remade = makeKey(newName())
        elseif code == "INVALID_CSR" then
            -- A new key, asked for after the backoff all the same.
            state.remakes = state.remakes + 1
            makeKey()
        end
    end
    if remade then
        state.failure = nil
        stopRetry()
    else
        failed(code, message.retry_s)
    end
    sync("refused")
end

local function onResult(message)
    if state.offAsking and message.id == state.offAsking then
        state.offAsking = nil
        if message.ok == true then
            if state.stored and state.stored.dns_off and not switchedOn() then
                state.stored.dns_off = nil
                save()
            end
            log("info", "DirectorLink's servers deleted the home's name")
        else
            log("warn", "DirectorLink's servers did not delete the home's name", { code = tostring(message.code) })
        end
        return
    end
    local telling = state.telling
    if telling and message.id == telling.id then
        state.telling = nil
        if message.ok == true then
            state.told = { ip = telling.ip, connection = telling.connection }
            log("info", "the controller's address told to DirectorLink's servers", { name = state.stored and state.stored.name or Json.null })
        else
            log("warn", "DirectorLink's servers did not take the controller's address", { code = tostring(message.code) })
        end
    end
end

-- A message of the relay about Direct HTTPS (src/cloud/relay.lua passes them on).
function DirectHttps.onRelayMessage(message)
    if type(message) ~= "table" then
        return
    end
    if message.type == "https_certificate_result" then
        onCertificateResult(message)
    elseif message.type == "https_result" then
        onResult(message)
    end
end

-- The relay said what it does on a new connection (relay_features), or was found not to say.
function DirectHttps.relayReady()
    state.told, state.telling, state.offAsking = nil, nil, nil
    -- A request whose connection ended is asked again on the new one (the Worker gives the same
    -- answer: its order is not asked twice).
    if state.asking then
        clearAsking()
    end
    sync("relay")
end

-- ---- the driver -----------------------------------------------------------------------------------

-- Wires the module to the driver; nothing happens until apply(). options: { log, allowed(),
-- remote(), relay = { features(), tell(message), connection() }, address(), activity, onStatus }.
function DirectHttps.configure(options)
    state.log = options.log
    state.allowed = options.allowed or state.allowed
    state.remote = options.remote or state.remote
    state.relay = options.relay
    state.address = options.address
    state.activity = options.activity
    state.onStatus = options.onStatus
    state.configured = true
    state.created, state.listening, state.hardError, state.shown = false, false, nil, nil
    state.failure, state.failures, state.remakes = nil, 0, 0
    clearAsking()
    stopRetry()
    stopServerRetry()
    cancelWatch()
    cancel(state.stopTimer)
    state.stopTimer, state.deferStop = nil, false
    cancel(state.tick)
    state.tick = nil
    pcall(function()
        state.tick = C4:SetTimer(DirectHttps.TICK_SECONDS * 1000, function()
            sync("tick")
        end, true)
    end)
    return load()
end

-- Composer's Direct HTTPS now (at start, or when the installer changed it), or Remote Access: Off
-- also turns the owner's switch off, and the Worker deletes the name's record.
function DirectHttps.apply()
    if not state.configured then
        return
    end
    if not allowed() and switchedOn() then
        state.stored.enabled = nil
        state.stored.dns_off = true
        forgetCertificate("not allowed")
        save()
        log("info", "Direct HTTPS turned off: Composer no longer allows it", { name = state.stored.name })
    end
    sync("apply")
end

-- The owner's switch (PUT /v1/https). Returns the status, or nil and a refusal { status, code,
-- detail }. `actor`: the key that asked, for the history.
function DirectHttps.setEnabled(on, actor)
    if not allowed() then
        return nil, { status = 409, code = "HTTPS_NOT_ALLOWED", detail = "Direct HTTPS is not allowed: the installer sets Direct HTTPS to Allowed in Composer (DirectorLink properties) first" }
    end
    if on and not remoteReady() then
        return nil, { status = 409, code = "REMOTE_ACCESS_NEEDED", detail = "Direct HTTPS needs Remote Access on in Composer and the home linked to an account: the certificate comes through DirectorLink's servers" }
    end
    local before = switchedOn()
    if on == before then
        return DirectHttps.status()
    end
    if on then
        -- What failed before is tried again (a key, the TLS server).
        state.hardError = nil
        if not state.stored then
            -- The first time: a name and key now (sync would make them too).
            makeKey()
        end
        if not state.stored then
            -- No key could be made: switched on all the same, to say why.
            state.stored = { version = DirectHttps.STORE_VERSION, name = newName() }
        end
        state.stored.enabled = true
        state.stored.dns_off = nil
        state.failure, state.failures, state.remakes = nil, 0, 0
        stopRetry()
    else
        state.stored.enabled = nil
        state.stored.dns_off = true
        -- The TLS server stops a moment later (sync), after this answer, which may go over it.
        state.deferStop = true
        forgetCertificate("turned off", true)
    end
    if not save() then
        state.stored.enabled = before and true or nil
        return nil, { status = 503, code = "UNAVAILABLE", detail = "The switch could not be saved on the controller; try again" }
    end
    log("info", on and "Direct HTTPS turned on by the home's owner" or "Direct HTTPS turned off by the home's owner",
        { name = state.stored.name, key_id = actor and actor.id or Json.null })
    if state.activity then
        pcall(state.activity.record, "system", "direct_https", { by = actor, to = on and "on" or "off" })
    end
    sync("switch")
    return DirectHttps.status()
end

-- The home's remote identity is being reset (Composer: Reset Remote Identity): the name belongs to
-- the old home at DirectorLink's servers. Its record goes now, on the old connection, and the
-- controller forgets the name, key and certificate; the owner's switch stays, and a new name is
-- made once the new home is linked to an account.
function DirectHttps.identityReset()
    if not state.configured or not state.stored then
        return
    end
    if relayTakes() then
        tell({ type = "https", id = newId(), name = Json.null })
    end
    destroyServer("new remote identity")
    clearAsking()
    stopRetry()
    local enabled = state.stored.enabled
    state.stored = enabled and { version = DirectHttps.STORE_VERSION, name = newName(), enabled = true } or nil
    state.times, state.told, state.telling, state.offAsking = nil, nil, nil, nil
    state.failure, state.failures = nil, 0
    if state.stored then
        save()
    else
        Store.write(DirectHttps.STORE_KEY, {}, false)
    end
    log("info", "Direct HTTPS forgot the home's name: a new remote identity")
    -- Asked for again once the new identity is connected (relayReady), not on the old connection.
    publish()
end

-- The driver goes away: the TLS server with it.
function DirectHttps.stop()
    destroyServer("driver stopped")
    clearAsking()
    stopRetry()
    stopServerRetry()
    cancel(state.stopTimer)
    state.stopTimer, state.deferStop = nil, false
    cancel(state.tick)
    state.tick = nil
end

-- Whether a server callback is about this TLS server: by identifier (OS 3.3.1 and newer), or by
-- its port.
function DirectHttps.owns(port, identifier)
    return identifier == DirectHttps.IDENTIFIER or tonumber(port) == DirectHttps.PORT
end

function DirectHttps.onStatusChanged(port, status)
    status = tostring(status)
    local name = state.stored and state.stored.name or Json.null
    if not state.created then
        log("debug", "TLS server " .. status .. " after it was stopped", { port = tonumber(port) or port, name = name })
        return
    end
    state.listening = status == "ONLINE"
    log("info", "TLS server " .. status, { port = tonumber(port) or port, name = name })
    if state.listening then
        cancelWatch()
        stopServerRetry()
    elseif isOn() and hasCertificate() and validNow() and not state.deferStop then
        -- Director stopped it while it should listen: started again, with a backoff.
        serverTrouble(WORDS.SERVER_STOPPED)
    end
    publish()
end

-- The Host a request on the TLS server may name besides the controller's address: exactly the
-- home's name, with or without the port.
function DirectHttps.hostAllowed(host)
    local name = state.stored and state.stored.name
    if type(host) ~= "string" or not name then
        return false
    end
    host = string.lower(host)
    return host == name or host == name .. ":" .. DirectHttps.PORT
end

-- GET /v1/https, for admins: never the key, nor the CSR.
function DirectHttps.status()
    local stored = state.stored
    local body = {
        allowed = allowed(),
        enabled = isOn(),
        remote = remoteReady(),
        name = stored and stored.name or Json.null,
        port = DirectHttps.PORT,
        state = DirectHttps.state(),
        certificate = Json.null,
        error = errorText() or Json.null,
    }
    if isOn() and hasCertificate() then
        body.certificate = { not_after = stored.not_after or Json.null, issuer_cn = stored.issuer_cn or Json.null }
    end
    return body
end

-- `direct_https` in GET /v1/system, for every key: where the app reaches the API over HTTPS, only
-- while the TLS server is listening with a certificate valid now; else nil.
function DirectHttps.published()
    if DirectHttps.state() ~= "listening" then
        return nil
    end
    return { name = state.stored.name, port = DirectHttps.PORT, not_after = state.stored.not_after }
end

-- Tests: a fresh module state, as at a driver load.
function DirectHttps.reset()
    DirectHttps.stop()
    state.configured, state.stored, state.times = false, nil, nil
    state.created, state.listening, state.hardError, state.shown = false, false, nil, nil
    state.failure, state.failures, state.remakes, state.asked = nil, 0, 0, 0
    state.told, state.telling, state.offAsking = nil, nil, nil
end

return DirectHttps
