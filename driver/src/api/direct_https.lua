-- Direct HTTPS (1.12.0 test build, ADR-082): the same LAN API also over TLS, on port 28443, under a
-- name of the home's own (20 random letters and digits under dlhome.cc) whose public DNS record
-- points at the controller's LAN address, with a publicly trusted certificate for that name. An
-- iPhone or iPad then reaches the controller from https://app.directorlink.io at home, which
-- WebKit refuses over plain HTTP (mixed content).
--
-- Off unless the installer sets the Composer property Direct HTTPS to Allowed (in this test build
-- that alone turns it on). Then the controller makes its own P-256 key and a certificate request
-- (CSR) for the name, once; an admin reads the CSR (GET /v1/https), has it signed, and gives the
-- certificate back (PUT /v1/https/certificate). Only then does the TLS server start. Requests on it
-- go through exactly what port 41999 does (src/api/server.lua); the Host check also takes the name.
--
-- The private key is stored with the driver's data (src/core/store.lua, like the home secret), and
-- never logged, answered, printed or put in a backup.

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
DirectHttps.STORE_VERSION = 1
-- C4:CreateTLSServer: options 0 is Director's default 0x3D (no SSLv2, SSLv3, TLS 1.0 or 1.1: TLS
-- 1.2 and 1.3 only); verify mode 1 is SSL_VERIFY_NONE (0 would be 0x0A, which asks every client for
-- a certificate); the cipher list "" is Director's default; the key has no password.
DirectHttps.TLS_OPTIONS = 0
DirectHttps.VERIFY_MODE = 1
-- C4:GenerateCSR_ECC: P-256 ("prime256v1"), which public CAs take (Let's Encrypt refuses secp256k1).
DirectHttps.DIGEST = "SHA256"
DirectHttps.CURVE = "prime256v1"
DirectHttps.MAX_PEM_BYTES = 16 * 1024

local BASE32 = "abcdefghijklmnopqrstuvwxyz234567"
local UNSUPPORTED = "not supported on this OS: C4:GenerateCSR_ECC gave no private key (it does from OS 3.3.1)"

local state = {
    configured = false,
    log = nil,
    enabled = function()
        return false
    end,
    onStatus = nil,
    -- The stored record: { version, name, key, csr, certificate, chain, not_after, issuer_cn,
    -- created_at, installed_at }; nil when there is none.
    stored = nil,
    -- The store could not be read at start: nothing is made or written over it until an admin
    -- asks for a new key.
    unreadable = false,
    -- C4:CreateTLSServer was called and the server not destroyed since; ONLINE seen since then.
    created = false,
    listening = false,
    error = nil,
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

local function enabled()
    local ok, value = pcall(state.enabled)
    return ok and value == true
end

local function isText(value)
    return type(value) == "string" and value ~= ""
end

local function load()
    local data, form = Store.read(DirectHttps.STORE_KEY, false)
    state.stored, state.unreadable = nil, false
    if form == "unreadable" then
        state.unreadable = true
        return form
    end
    if type(data) == "table" and isText(data.name) then
        local record = { version = DirectHttps.STORE_VERSION, name = data.name }
        if isText(data.key) and isText(data.csr) then
            record.key, record.csr, record.created_at = data.key, data.csr, data.created_at
            if isText(data.certificate) and isText(data.chain) then
                record.certificate, record.chain = data.certificate, data.chain
                record.not_after, record.issuer_cn, record.installed_at = data.not_after, data.issuer_cn, data.installed_at
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

function DirectHttps.state()
    if not enabled() then
        return "off"
    elseif state.error or not hasKey() then
        return "error"
    elseif not hasCertificate() then
        return "waiting_for_certificate"
    elseif state.listening then
        return "listening"
    elseif state.created then
        return "starting"
    end
    return "error"
end

local function statusText()
    local current = DirectHttps.state()
    local name = state.stored and state.stored.name
    if current == "off" then
        return "Off"
    elseif current == "error" then
        return "Error: " .. tostring(state.error or "no key")
    elseif current == "waiting_for_certificate" then
        return "Waiting for a certificate for " .. name
    elseif current == "starting" then
        return "Starting on " .. name .. ":" .. DirectHttps.PORT
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

local function destroyServer(reason)
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

local function createServer()
    local stored = state.stored
    if not has("CreateTLSServer") then
        state.error = "not supported on this OS: C4:CreateTLSServer is missing"
        log("error", "TLS server failed", { port = DirectHttps.PORT, name = stored.name, error = state.error })
        return false
    end
    local ok, result, failure = pcall(function()
        return C4:CreateTLSServer(DirectHttps.PORT, "", DirectHttps.TLS_OPTIONS, DirectHttps.VERIFY_MODE, "",
            stored.certificate, stored.key, "", stored.chain, DirectHttps.IDENTIFIER)
    end)
    if not ok or result == false then
        state.error = "the TLS server could not be started: " .. short(ok and failure or result)
        log("error", "TLS server failed", { port = DirectHttps.PORT, name = stored.name, error = state.error })
        return false
    end
    state.created, state.listening, state.error = true, false, nil
    log("info", "TLS server started", { port = DirectHttps.PORT, name = stored.name, not_after = stored.not_after or Json.null })
    return true
end

-- A key and CSR for the stored name (a new name the first time). Returns true, or false with
-- state.error set; what was stored stays as it was when it fails.
local function makeKey()
    local name = state.stored and state.stored.name or newName()
    if not has("GenerateCSR_ECC") then
        state.error = "not supported on this OS: C4:GenerateCSR_ECC is missing"
        log("error", "no key made", { name = name, error = state.error })
        return false
    end
    local ok, csr, publicKey, privateKey = pcall(function()
        return C4:GenerateCSR_ECC(DirectHttps.DIGEST, DirectHttps.CURVE, "/CN=" .. name, { subjectAltName = "DNS:" .. name })
    end)
    if not ok or not isText(csr) then
        state.error = "the key could not be made: " .. short(ok and publicKey or csr)
        log("error", "no key made", { name = name, error = state.error })
        return false
    end
    -- Before OS 3.3.1 the function gives only the CSR: its key stays inside Director.
    if not isText(privateKey) or not privateKey:find("PRIVATE KEY-----", 1, true) then
        state.error = UNSUPPORTED
        log("error", "no key made", { name = name, error = state.error, returned = isText(publicKey) and "csr and public key" or "csr only" })
        return false
    end
    local blocks = X509.pemBlocks(csr, "CERTIFICATE REQUEST")
    local parsed = blocks and blocks[1] and X509.readRequest(blocks[1])
    if not parsed then
        state.error = "the certificate request Director made could not be read"
        log("error", "no key made", { name = name, error = state.error })
        return false
    end
    local previous = state.stored
    state.stored = {
        version = DirectHttps.STORE_VERSION,
        name = name,
        key = privateKey,
        csr = X509.pem(blocks[1], "CERTIFICATE REQUEST"),
        created_at = Clock.iso(),
    }
    if not save() then
        state.stored = previous
        state.error = "the key could not be saved"
        log("error", "no key made", { name = name, error = state.error })
        return false
    end
    state.unreadable, state.error = false, nil
    log("info", "key and certificate request made", { name = name, curve = parsed.curve or Json.null })
    return true
end

-- Wires the module to the driver; nothing happens until apply().
function DirectHttps.configure(options)
    state.log = options.log
    state.enabled = options.enabled or state.enabled
    state.onStatus = options.onStatus
    state.configured = true
    state.created, state.listening, state.error, state.shown = false, false, nil, nil
    return load()
end

-- Composer's Direct HTTPS now (at start, or when the installer changed it): off stops the TLS
-- server (the key and certificate stay); Allowed makes the key once, and starts the server when a
-- certificate is stored.
function DirectHttps.apply()
    if not state.configured then
        return
    end
    if not enabled() then
        destroyServer("off")
        state.error = nil
        publish()
        return
    end
    if state.unreadable then
        state.error = "the stored key could not be read; ask for a new key (POST /v1/https/new-key)"
    elseif not hasKey() then
        state.error = nil
        makeKey()
    end
    if hasCertificate() and not state.created then
        createServer()
    end
    publish()
end

-- The driver goes away: the TLS server with it.
function DirectHttps.stop()
    destroyServer("driver stopped")
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

-- GET /v1/https: never the key. The CSR while a certificate is awaited, or when asked for.
function DirectHttps.status(includeCsr)
    local stored = state.stored
    local current = DirectHttps.state()
    local body = {
        enabled = enabled(),
        name = stored and stored.name or Json.null,
        port = DirectHttps.PORT,
        state = current,
        csr = Json.null,
        certificate = Json.null,
        error = current == "error" and (state.error or "no key") or Json.null,
        warning = Json.null,
    }
    if hasKey() and (current == "waiting_for_certificate" or includeCsr) then
        body.csr = stored.csr
    end
    if hasCertificate() then
        body.certificate = { not_after = stored.not_after or Json.null, issuer_cn = stored.issuer_cn or Json.null }
        local expires = Clock.parseIso(stored.not_after)
        if expires and expires <= Clock.now() then
            body.warning = "The certificate expired at " .. stored.not_after .. ": browsers refuse it. Install a new one."
        end
    end
    if hasKey() and current ~= "off" then
        local parsed = request()
        if parsed and parsed.curve ~= "prime256v1" then
            body.warning = "Director's CSR gives its curve as " .. tostring(parsed.curve) .. ", not by the name prime256v1: "
                .. "public CAs such as Let's Encrypt refuse such a request."
        end
    end
    return body
end

local function refused(status, code, detail, field)
    return nil, { status = status, code = code, detail = detail, field = field }
end

local function certificates(text, field)
    if type(text) ~= "string" or #text > DirectHttps.MAX_PEM_BYTES then
        return refused(400, "INVALID_FIELD", field .. " must be PEM text of at most " .. DirectHttps.MAX_PEM_BYTES .. " bytes", field)
    end
    local blocks = X509.pemBlocks(text, "CERTIFICATE")
    if not blocks then
        return refused(400, "INVALID_FIELD", field .. " holds a PEM block that is not base64", field)
    end
    for _, der in ipairs(blocks) do
        if not X509.readCertificate(der) then
            return refused(400, "INVALID_FIELD", field .. " holds something that is not an X.509 certificate", field)
        end
    end
    return blocks
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

-- PUT /v1/https/certificate: the certificate for this controller's key and name, with the
-- certificates between it and a root (`chain`, or after it in `certificate`, as in fullchain.pem).
-- Kept, then the TLS server started again with it. Returns the status, or nil and a refusal
-- { status, code, detail, field }.
function DirectHttps.installCertificate(certificateText, chainText, keyId)
    if not enabled() then
        return refused(409, "HTTPS_OFF", "Direct HTTPS is Off: the installer sets it to Allowed in Composer (DirectorLink properties) first")
    end
    if not hasKey() then
        return refused(409, "HTTPS_NO_KEY", "This controller has no key for Direct HTTPS: " .. tostring(state.error or "none was made"))
    end
    local leafBlocks, problem = certificates(certificateText, "certificate")
    if not leafBlocks then
        return nil, problem
    end
    if #leafBlocks == 0 then
        return refused(400, "INVALID_FIELD", "certificate must hold a PEM certificate (-----BEGIN CERTIFICATE-----)", "certificate")
    end
    local chainBlocks = {}
    if chainText ~= nil then
        chainBlocks, problem = certificates(chainText, "chain")
        if not chainBlocks then
            return nil, problem
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
        return refused(400, "INVALID_FIELD", "chain must hold the issuer's certificate (chain.pem), or send fullchain.pem as certificate: "
            .. "iPhones and iPads do not fetch a missing one", "chain")
    end
    local leaf = X509.readCertificate(leafDer)
    local own = request()
    if not own then
        return refused(409, "HTTPS_NO_KEY", "This controller's certificate request could not be read; ask for a new key (POST /v1/https/new-key)")
    end
    if leaf.public_key ~= own.public_key or leaf.algorithm ~= own.algorithm then
        return refused(422, "CERTIFICATE_KEY_MISMATCH", "This certificate is not for this controller's key: have the CSR of GET /v1/https signed")
    end
    local name = state.stored.name
    if not nameCovered(leaf.dns_names, name) then
        return refused(422, "CERTIFICATE_NAME_MISMATCH", "This certificate is not for " .. name .. " (its DNS names: "
            .. (#leaf.dns_names > 0 and table.concat(leaf.dns_names, ", ") or "none") .. ")")
    end
    if leaf.not_after_s <= Clock.now() then
        return refused(422, "CERTIFICATE_EXPIRED", "This certificate expired at " .. leaf.not_after)
    end

    local chainPem = {}
    for _, der in ipairs(intermediates) do
        chainPem[#chainPem + 1] = X509.pem(der, "CERTIFICATE")
    end
    local previous = {}
    for field, value in pairs(state.stored) do
        previous[field] = value
    end
    state.stored.certificate = X509.pem(leafDer, "CERTIFICATE")
    state.stored.chain = table.concat(chainPem)
    state.stored.not_after = leaf.not_after
    state.stored.issuer_cn = leaf.issuer_cn
    state.stored.installed_at = Clock.iso()
    if not save() then
        state.stored = previous
        return refused(503, "UNAVAILABLE", "The certificate could not be saved on the controller; try again")
    end
    log("info", "certificate installed", {
        name = name,
        not_after = leaf.not_after,
        issuer_cn = leaf.issuer_cn or Json.null,
        intermediates = #intermediates,
        key_id = keyId or Json.null,
    })
    -- The old server goes first: Director takes one server a port.
    destroyServer("new certificate")
    createServer()
    publish()
    return DirectHttps.status(false)
end

-- POST /v1/https/new-key: the key, its CSR and the certificate are forgotten (the TLS server stops)
-- and a new key and CSR are made for the same name.
function DirectHttps.newKey(keyId)
    if not enabled() then
        return refused(409, "HTTPS_OFF", "Direct HTTPS is Off: the installer sets it to Allowed in Composer (DirectorLink properties) first")
    end
    destroyServer("new key")
    local name = state.stored and state.stored.name
    log("info", "new key asked for", { name = name or Json.null, key_id = keyId or Json.null })
    if makeKey() then
        publish()
        return DirectHttps.status(false)
    end
    publish()
    return refused(503, "HTTPS_KEY_FAILED", "No new key was made: " .. tostring(state.error))
end

-- Tests: a fresh module state, as at a driver load.
function DirectHttps.reset()
    state.configured, state.stored, state.unreadable = false, nil, false
    state.created, state.listening, state.error, state.shown = false, false, nil, nil
end

return DirectHttps
