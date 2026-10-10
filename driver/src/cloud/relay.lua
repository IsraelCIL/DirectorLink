-- Remote access (docs/RELAY.md, docs/ACCOUNTS.md): one outgoing WebSocket to the DirectorLink
-- relay, kept open while the Composer property "Remote Access" is On. Everything the relay passes
-- on is sealed end to end and handled by remote.lua; the plain requests of version 0 are refused,
-- so the relay cannot read the home.

local Json = require("src.core.json")
local Random = require("src.core.random")
local Store = require("src.core.store")
local Version = require("src.core.version")
local WebSocket = require("src.cloud.websocket")
local Activity = require("src.core.activity")
local Access = require("src.auth.access")
local Answers = require("src.cloud.answers")
local Outbox = require("src.cloud.outbox")

local Relay = {}

Relay.HOST = "api.directorlink.io"
Relay.PORT = 443
Relay.PATH = "/relay/connect"
Relay.BINDING = 6001
-- A ping every 5 s (10 s from 1.6.0, 25 s up to 1.5.0): a connection that died without a word is
-- found within seconds, at the next ping, which Director then refuses. The hello says how often
-- (ping_s), so the relay holds requests for a driver whose pings have stopped instead of sending
-- them into a dead connection (ADR-045, ADR-072).
Relay.KEEPALIVE_MS = 5000
-- A connection that hears nothing (not even a pong) for this many keep-alive ticks in a row is
-- dropped: about 15 s. Ticks, not the clock, so setting the controller's clock back cannot
-- delay it.
Relay.SILENCE_TICKS = 3
Relay.BACKOFF_SECONDS = { 5, 10, 30, 60 }
Relay.REFUSED_RETRY_SECONDS = 300
-- The account service no longer takes this version (426 DRIVER_UPDATE_REQUIRED, ADR-059): a flaw
-- was found in the remote protocol, and only an update fixes it. Asked again once an hour, in case
-- the minimum is lowered again; Remote Status says what to do.
Relay.UPDATE_RETRY_SECONDS = 3600
Relay.UPDATE_STATUS = "Update DirectorLink: this version can no longer connect to remote access"
-- A connection that was up for STABLE_SECONDS and is lost is tried again after QUICK_RETRY_SECONDS,
-- and so are the next QUICK_IN_ROW connections that open and are lost sooner (1.10.0, ADR-072: the
-- home's route to Cloudflare was seen to flip again within seconds, and a request the relay keeps
-- for the next connection goes again only within 10 s). Then, and after an attempt that does not
-- open, the backoff: a connection that keeps failing as soon as it opens is not retried every second.
Relay.QUICK_RETRY_SECONDS = 1
Relay.STABLE_SECONDS = 60
Relay.QUICK_IN_ROW = 2
-- A connection that opens after one was lost pings every WATCH_MS for its first WATCH_PINGS pings
-- (1.10.0, ADR-072), before the keep-alive's first: a second cut right after the first is found
-- within a second rather than 5 s, in time for the relay to send its requests again.
Relay.WATCH_MS = 1000
Relay.WATCH_PINGS = 4
-- Closed with 4000 "replaced": another connection with this home's identity took its place (a
-- second controller, after a backup was restored on it). Waiting longer keeps the two from pushing
-- each other off every few seconds.
Relay.REPLACED_RETRY_SECONDS = 30
-- How long an attempt may take from NetConnect to the relay's answer to the upgrade.
Relay.CONNECT_SECONDS = 30
-- Replacement home secrets waiting for the owner's approval: the newest few, for a day.
Relay.CANDIDATES = 3
Relay.CANDIDATE_SECONDS = 24 * 3600
-- What this driver tells the relay it takes, in its hello (1.7.0); `alerts_gone` (1.9.0, ADR-062):
-- the key ids whose browsers the account service no longer has (src/cloud/remote.lua); `users`
-- (1.9.0, ADR-061): the relay sends which keys share an account (`accounts`), and any device of an
-- account may approve that account's new device, as the controller lets every user add their own;
-- `resend` (1.10.0, ADR-072): a request already sent when the connection ended may come again on
-- the next one, with the same id, and runs once (src/cloud/answers.lua); `alert_acks` (1.10.1,
-- ADR-073): this driver keeps its alerts until the relay answers them, and sends them again after a
-- lost connection to a relay that says it answers them (src/cloud/outbox.lua).
Relay.FEATURES = Json.array({ "scene_links", "alerts_gone", "users", "resend", "alert_acks" })
Relay.ALERT_ACKS = "alert_acks"
-- Alerts made while the connection is down are kept for the next one (1.10.1, ADR-073) only within
-- this long of losing a connection whose relay answered alerts: a reconnect takes seconds, a short
-- outage a minute or two (the longest an alert is kept, Alerts.KEEP_SECONDS). After it, as before
-- 1.10.1: an alert while not connected is not made, and counts toward no limit; a home away longer
-- is the account service's offline alert (ADR-047). Counted by a timer, not the clock.
Relay.KEEP_WINDOW_SECONDS = 120
-- A relay heard on a connection (a pong, a message) that has not said it answers alerts by the
-- second keep-alive tick after is taken as one that does not (before 1.10.1, ADR-073). Two, so that
-- a `relay_features` slowed down on its way (it comes right after the hello) still counts.
Relay.ACKS_TICKS = 2

local IDENTITY_KEY = "directorlink_remote_identity"
-- 0.9.0 kept the identity encrypted under this name; it is moved when Director can still read it.
local OLD_IDENTITY_KEY = "DIRECTORLINK_REMOTE_IDENTITY"

local state = {
    asked = {}, -- id -> { expects = answer type, done = function(answer) }: what the driver asked the relay
    later = {}, -- what to tell the relay once connected again (Relay.tellSoon)
    enabled = false,
    socket = nil,
    identity = nil,
    attempts = 0, -- failed attempts since the last stable connection (the backoff's step)
    quickLeft = 0, -- connections lost soon after they opened that may still be retried at once
    tries = 0, -- attempts started since the connection was lost
    connectedAt = nil,
    downSince = nil, -- when the connection was lost
    lastDrop = nil, -- { at, reason }: the last connection lost, for Remote Status
    lastHeard = 0,
    quietTicks = 0, -- keep-alive ticks since anything was heard
    pingedAt = nil,
    polledAt = nil, -- when Director last polled the connection (OnPoll)
    keepalive = nil,
    watch = nil, -- the first seconds' pings of a connection that follows a lost one
    dropped = false, -- an open connection was lost since the last one opened
    retry = nil,
    connecting = nil, -- the limit on the attempt in progress (watchConnect)
    services = nil,
    onStatus = nil,
    status = "Off",
    -- Which secret this connection attempt uses: nil for the current one, or the index of a
    -- waiting replacement, tried one after another (newest first) after the relay refused the
    -- current one: the owner may have approved one of them meanwhile.
    trying = nil,
    -- The account service refused this version (ADR-059) since the last connection: in the history
    -- once, until a connection opens again; and the minimum it named, if any (GET /v1/remote).
    updateRequired = false,
    minimumVersion = nil,
    -- A random id made at this start of the driver (1.10.0), in the hello: the relay sends a request
    -- again only to the instance it went to, which remembers what it ran (src/cloud/answers.lua).
    instance = nil,
    -- Alerts (1.10.1, ADR-073): the number of the connection (one more at each that opens); whether
    -- the relay of this one answers alerts (nil until it says so, `relay_features`; false once it is
    -- heard without saying so: settleAcks); whether anything was heard on this connection since its
    -- hello, and the keep-alive ticks since then while undecided; and the timer of the window after
    -- a lost connection whose relay answered alerts, while alerts are kept for the next one
    -- (Relay.KEEP_WINDOW_SECONDS).
    connection = 0,
    acks = nil,
    heardSinceHello = false,
    heardTicks = 0,
    keepWindow = nil,
    -- What this connection's relay said it does (`relay_features`, 1.10.1): feature -> true; an
    -- empty table once it was heard without saying (a relay before 1.10.1); nil until then.
    relayFeatures = nil,
    -- Modules told of the relay's features at each connection (Relay.onFeatures), and of the
    -- relay's messages of a type (Relay.on): Direct HTTPS (1.12.0, ADR-082).
    featureListeners = {},
    handlers = {},
}

local function log(level, message, data)
    if state.services and state.services.log then
        state.services.log.write(level, "relay", message, data)
    end
end

local function publish(text)
    state.status = text
    if state.onStatus then
        state.onStatus(text)
    end
end

local function randomHex(length)
    return Random.hex(length)
end

local function validSecret(value)
    return type(value) == "string" and #value == 64 and value:match("^%x+$") ~= nil
end

-- An identity as stored: { home_id, home_secret, next_secrets, linked } or nil. `linked`: the relay
-- has accepted it (1.4.0: it is a home in the account service; only such an identity goes into a
-- backup). `previous` (an identity restored from a backup, until the relay accepts it: ADR-042) is
-- read with it, once.
local function identityFrom(stored, nested)
    if type(stored) == "table" and type(stored.home_id) == "string" and type(stored.home_secret) == "string" then
        local candidates = {}
        for _, item in ipairs(type(stored.next_secrets) == "table" and stored.next_secrets or {}) do
            if type(item) == "table" and validSecret(item.secret) and tonumber(item.at) then
                candidates[#candidates + 1] = { secret = item.secret, at = tonumber(item.at) }
            end
        end
        return {
            home_id = stored.home_id,
            home_secret = stored.home_secret,
            next_secrets = #candidates > 0 and candidates or nil,
            linked = stored.linked == true or nil,
            previous = not nested and identityFrom(stored.previous, true) or nil,
        }
    end
    return nil
end

local function readIdentity(name, encrypted)
    local stored, form = Store.read(name, encrypted)
    return identityFrom(stored), form
end

-- The waiting replacement a connection attempt uses, if any.
local function candidateInUse(identity)
    return state.trying and identity.next_secrets and identity.next_secrets[state.trying] or nil
end

local function saveIdentity(identity)
    return Store.write(IDENTITY_KEY, identity, false)
end

-- The home's identity: a public id and a secret, kept in the driver's data.
function Relay.identity()
    if state.identity then
        return state.identity
    end
    local identity, form = readIdentity(IDENTITY_KEY, false)
    local moved = false
    if not identity then
        identity = readIdentity(OLD_IDENTITY_KEY, true)
        moved = identity ~= nil
        form = moved and "moved" or "created"
        identity = identity or { home_id = randomHex(32), home_secret = randomHex(64) }
    end
    -- Anything not stored the current way is written again, so the next load reads it as it is.
    if form ~= "json" and Store.write(IDENTITY_KEY, identity, false) and moved then
        Store.write(OLD_IDENTITY_KEY, {}, true)
    end
    state.identity = identity
    log("info", form == "created" and "remote identity created" or "remote identity loaded",
        { home_id = identity.home_id, stored_as = form })
    return identity
end

local function cancel(timer)
    if timer then
        pcall(function()
            timer:Cancel()
        end)
    end
end

local function stopTimers()
    cancel(state.keepalive)
    cancel(state.watch)
    cancel(state.retry)
    cancel(state.connecting)
    state.keepalive = nil
    state.watch = nil
    state.retry = nil
    state.connecting = nil
end

local connect

local function closeKeepWindow()
    cancel(state.keepWindow)
    state.keepWindow = nil
end

-- A connection whose relay answered alerts was lost (1.10.1, ADR-073): alerts are kept for the next
-- one for KEEP_WINDOW_SECONDS from now (a new window if one was open), then no more.
local function openKeepWindow()
    closeKeepWindow()
    local timer
    pcall(function()
        timer = C4:SetTimer(Relay.KEEP_WINDOW_SECONDS * 1000, function()
            if state.keepWindow == timer then
                state.keepWindow = nil
            end
        end, false)
    end)
    state.keepWindow = timer
end

local function ago(time)
    return time and os.time() - time or nil
end

-- Connects again after `seconds`, or after the backoff's next step. Every disconnect and failed
-- attempt is logged in one line (`note`: { level, message, data }, else "reconnecting to the
-- relay"), with the reason, the number of the attempt that follows and how long until it starts.
local function scheduleReconnect(reason, seconds, note)
    stopTimers()
    -- An open connection is lost: if its relay answered alerts, those made meanwhile are kept for a
    -- while (ADR-073). Before the retry's timer, which is the last one set.
    if state.connectedAt and state.acks == true and state.enabled then
        openKeepWindow()
    end
    state.connectedAt = nil
    if not state.enabled then
        return
    end
    if not seconds then
        -- The backoff ends a row of quick retries (quickRetry).
        state.quickLeft = 0
        state.attempts = state.attempts + 1
        seconds = Relay.BACKOFF_SECONDS[math.min(state.attempts, #Relay.BACKOFF_SECONDS)]
    end
    state.downSince = state.downSince or os.time()
    note = note or {}
    local data = note.data or {}
    data.reason = tostring(reason)
    data.attempt = state.tries + 1
    data.retry_s = seconds
    log(note.level or "info", note.message or "reconnecting to the relay", data)
    publish(note.status or ("Reconnecting in " .. seconds .. " s (" .. tostring(reason) .. ")"))
    pcall(function()
        state.retry = C4:SetTimer(seconds * 1000, function()
            state.retry = nil
            connect()
        end, false)
    end)
end

-- Gives up on an attempt that has not opened within CONNECT_SECONDS, and retries with the
-- backoff. Director reports a lost connection as OFFLINE, but Control4 does not document how it
-- reports a certificate that fails VERIFY_MODE: if it reports nothing, the attempt would
-- otherwise stay at "Connecting..." until the driver restarts.
local function watchConnect()
    cancel(state.connecting)
    state.connecting = nil
    pcall(function()
        state.connecting = C4:SetTimer(Relay.CONNECT_SECONDS * 1000, function()
            state.connecting = nil
            local socket = state.socket
            if not state.enabled or not socket or (socket.state ~= "connecting" and socket.state ~= "handshake") then
                return
            end
            local message = socket.state == "connecting"
                and "no TLS connection to the relay within " .. Relay.CONNECT_SECONDS .. " s; the certificate check may have failed"
                or "the relay did not answer the upgrade within " .. Relay.CONNECT_SECONDS .. " s"
            socket:close(nil, true)
            scheduleReconnect("no connection within " .. Relay.CONNECT_SECONDS .. " s", nil, { level = "warn", message = message })
        end, false)
    end)
end

local function send(message)
    if state.socket then
        state.socket:send(type(message) == "string" and message or Json.encode(message))
    end
end

-- Version 0 relayed plain requests. Since 0.10.0 every remote request is sealed (remote.lua), so a
-- plain one is answered 410 without reaching the API: the relay cannot read the home.
local function refuseRequest(message)
    if type(message.id) ~= "string" or message.id == "" then
        return
    end
    log("warn", "refused a plain relayed request")
    send({
        type = "response",
        id = message.id,
        status = 410,
        content_type = "application/problem+json",
        body = Json.encode({
            type = "about:blank",
            title = "Gone",
            status = 410,
            code = "RELAY_REQUESTS_RETIRED",
            detail = "Plain relayed requests are refused; remote requests are sealed end to end (docs/ACCOUNTS.md)",
        }),
    })
end

-- What this connection's relay does is known (`features`: feature -> true): the modules that wait
-- for it are told (Direct HTTPS asks for its certificate then, 1.12.0).
local function featuresKnown(features)
    state.relayFeatures = features
    for _, listener in ipairs(state.featureListeners) do
        local ok, err = pcall(listener, features)
        if not ok then
            log("warn", "a module failed on the relay's features", { error = tostring(err) })
        end
    end
end

-- Whether this connection's relay answers alerts is settled (1.10.1, ADR-073): `acks`. When it
-- does, the alerts kept from the last connection (and those made while there was none) go now,
-- oldest first, except one that went to a relay not known to answer alerts (src/cloud/outbox.lua);
-- when it does not (a relay before 1.10.1), they are let go, nothing more is kept while the
-- connection is down, and the alerts that follow go once, as before.
local function settleAcks(acks)
    state.acks = acks
    if acks then
        local count, again = Outbox.resend(state.connection, send)
        if count > 0 then
            log("info", "alerts sent again", { count = count, resent = again })
        end
    else
        closeKeepWindow()
        Outbox.clear()
    end
end

-- What this relay does besides what every relay does (1.10.1, ADR-073), right after the hello:
-- {"type":"relay_features","id","features":["alert_acks"]}; since 1.12.0 also "https": it issues
-- Direct HTTPS certificates (ADR-082).
local function relayFeatures(message)
    local acks = false
    local features = {}
    for _, feature in ipairs(type(message.features) == "table" and message.features or {}) do
        if type(feature) == "string" and #feature <= 32 then
            features[feature] = true
        end
        if feature == Relay.ALERT_ACKS then
            acks = true
        end
    end
    settleAcks(acks)
    featuresKnown(features)
end

-- A relay heard without saying what it does (before 1.10.1): it does nothing more.
local function noFeatures()
    settleAcks(false)
    if state.relayFeatures == nil then
        featuresKnown({})
    end
end

local function onMessage(text, kind)
    state.lastHeard = os.time()
    state.quietTicks = 0
    state.heardSinceHello = true
    if kind == "pong" or text == "pong" then
        return
    end
    local message = Json.decode(text or "")
    if type(message) ~= "table" then
        log("debug", "ignored a relay message that is not JSON")
        return
    end
    -- Answers to what the driver asked (Relay.ask): an invitation registered, a backup's chunk kept,
    -- the home's owner account moved (1.9.0, ADR-064); each only of the type its question takes.
    local waiting = type(message.id) == "string" and state.asked[message.id]
    if waiting and message.type == waiting.expects then
        state.asked[message.id] = nil
        waiting.done(message)
        return
    end
    -- The relay has an alert this driver sent (1.10.1, ADR-073), or says it answers alerts.
    if message.type == "notify_result" then
        if type(message.id) == "string" then
            Outbox.done(message.id)
        end
        return
    elseif message.type == "relay_features" then
        relayFeatures(message)
        return
    elseif state.acks == nil and (message.type == "accounts" or message.type == "alerts_gone") then
        -- What a relay sends after this driver's `keys`, which follow its hello: a relay that answers
        -- alerts says so before (it answers the hello first), so this one does not.
        noFeatures()
    end
    -- Messages for a module (Relay.on): Direct HTTPS's answers (1.12.0, ADR-082).
    local handler = type(message.type) == "string" and state.handlers[message.type]
    if handler then
        local ok, err = pcall(handler, message)
        if not ok then
            log("warn", "a relay message failed", { type = message.type, error = tostring(err) })
        end
        return
    end
    -- Sealed requests, invitations, claims and links (remote.lua). Each runs once: one the relay
    -- sends again after a lost connection gets its first answer (answers.lua, ADR-072).
    if state.remote then
        local handled, what = Answers.handle(message, send, state.remote)
        if what then
            log("info", "a request the relay sent again", { type = tostring(message.type), resent = tonumber(message.resent), outcome = what })
        end
        if handled then
            return
        end
    end
    if message.type == "request" then
        refuseRequest(message)
    else
        log("debug", "ignored relay message", { type = tostring(message.type) })
    end
end

local function ping()
    state.pingedAt = os.time()
    send("ping")
end

-- What a lost connection had been doing, for the log: how long it was up, and how long since the
-- relay was last heard, the last ping and Director's last poll.
local function connectionFacts(data)
    data = data or {}
    data.up_s = ago(state.connectedAt)
    data.heard_s = state.connectedAt and ago(state.lastHeard) or nil
    data.ping_s = state.connectedAt and ago(state.pingedAt) or nil
    data.polled_s = ago(state.polledAt)
    return data
end

-- A connection that was up long enough and is lost is tried again at once, and so are the next
-- QUICK_IN_ROW that open and are lost sooner (a route that flips again); otherwise the backoff
-- goes on. Returns the wait in seconds, or nil for the backoff.
local function quickRetry()
    if not state.connectedAt then
        return nil
    end
    if os.time() - state.connectedAt >= Relay.STABLE_SECONDS then
        state.attempts = 0
        state.quickLeft = Relay.QUICK_IN_ROW
        return Relay.QUICK_RETRY_SECONDS
    end
    if state.quickLeft > 0 then
        state.quickLeft = state.quickLeft - 1
        return Relay.QUICK_RETRY_SECONDS
    end
    return nil
end

-- Remembers why the connection was lost, for Remote Status once it is back.
local function dropped(reason)
    if state.connectedAt then
        state.lastDrop = { at = os.time(), reason = tostring(reason) }
        state.dropped = true
    end
end

local function startKeepalive()
    cancel(state.keepalive)
    pcall(function()
        state.keepalive = C4:SetTimer(Relay.KEEPALIVE_MS, function()
            -- Answers' clock: these ticks, not the controller clock.
            Answers.tick(Relay.KEEPALIVE_MS / 1000)
            -- A relay heard since the hello that has not said it answers alerts by the second tick
            -- after does not (before 1.10.1, ADR-073). One not heard yet may be a connection that
            -- died: undecided.
            if state.acks == nil and state.heardSinceHello then
                state.heardTicks = state.heardTicks + 1
                if state.heardTicks >= Relay.ACKS_TICKS then
                    noFeatures()
                end
            end
            state.quietTicks = state.quietTicks + 1
            if state.quietTicks >= Relay.SILENCE_TICKS then
                local facts = connectionFacts()
                local retry = quickRetry()
                dropped("no answer")
                if state.socket then
                    state.socket:close(1000, false, "no answer")
                end
                scheduleReconnect("no answer", retry, { level = "warn", message = "no answer from the relay; reconnecting", data = facts })
                return
            end
            ping()
        end, true)
    end)
end

-- The first seconds of a connection that follows a lost one: a ping every WATCH_MS, WATCH_PINGS
-- times. Director refuses a ping into a connection that was cut (`connection lost`).
local function startWatch()
    cancel(state.watch)
    state.watch = nil
    local left = Relay.WATCH_PINGS
    local timer
    pcall(function()
        timer = C4:SetTimer(Relay.WATCH_MS, function()
            left = left - 1
            if left <= 0 then
                cancel(timer)
                if state.watch == timer then
                    state.watch = nil
                end
            end
            ping()
        end, true)
    end)
    state.watch = timer
end

-- Director polls a connection it monitors (OnPoll). The relay connection asks it not to
-- (websocket.lua), but if it does, a ping makes the relay answer at once.
function Relay.onPoll(binding)
    if tonumber(binding) ~= Relay.BINDING or not state.socket then
        return
    end
    state.polledAt = os.time()
    log("debug", "Director polled the relay connection", { connected = state.connectedAt ~= nil })
    if state.connectedAt then
        ping()
    end
end

-- Which API keys exist, as key ids only (the cloud sees them in every envelope anyway), and which
-- are admin keys. The cloud keeps which account uses which key; a member whose keys are all revoked
-- leaves the home.
function Relay.announceKeys()
    if not state.socket or not state.services or not state.services.keys then
        return
    end
    -- After a failed read of the key store the list may be short: the cloud would end the
    -- membership of everyone missing from it.
    if state.services.keys.complete and not state.services.keys.complete() then
        log("warn", "key ids not announced: the key store could not be read")
        return
    end
    local ids, admins = Json.array(), Json.array()
    for _, key in ipairs(state.services.keys.list()) do
        ids[#ids + 1] = key.id
        -- Which of them are admin keys (1.6.0): only their accounts get the home's alerts (ADR-047).
        -- Since 1.8.0 the keys of the people who are admins (ADR-054).
        if Access.isAdmin(key) then
            admins[#admins + 1] = key.id
        end
    end
    send({ type = "keys", ids = ids, admins = admins })
end

local function onOpen()
    -- Connected with a replacement: the owner approved it, and it is the home secret from now on
    -- (the others go). Connected with the current one: none was approved; replacements waiting
    -- for approval stay for a day.
    local current = Relay.identity()
    local candidate = candidateInUse(current)
    -- The relay knows an identity restored from a backup: it is the home's from now on (ADR-042).
    if current.previous then
        log("info", "the relay accepted the remote identity restored from a backup", { home_id = current.home_id, previous = current.previous.home_id })
        current.previous = nil
        current.linked = true
        saveIdentity(current)
    elseif not current.linked then
        -- A home in the account service from now on: a backup may hold it (ADR-042).
        current.linked = true
        saveIdentity(current)
    end
    if candidate then
        current.home_secret, current.next_secrets = candidate.secret, nil
        saveIdentity(current)
        log("info", "home secret replaced", { home_id = current.home_id })
    elseif current.next_secrets then
        local kept = {}
        for _, item in ipairs(current.next_secrets) do
            if os.time() - item.at < Relay.CANDIDATE_SECONDS then
                kept[#kept + 1] = item
            end
        end
        if #kept ~= #current.next_secrets then
            current.next_secrets = #kept > 0 and kept or nil
            saveIdentity(current)
        end
    end
    cancel(state.connecting)
    state.connecting = nil
    state.trying = nil
    state.lastHeard = os.time()
    state.quietTicks = 0
    state.pingedAt = nil
    state.connectedAt = os.time()
    local identity = Relay.identity()
    -- `features` (1.7.0): what the relay may send this driver besides what every version takes;
    -- `scene_links`: `link` runs (ADR-051); `alerts_gone` (1.9.0); `resend` (1.10.0). A driver that
    -- does not list one is never sent its messages. `instance` (1.10.0): this start of the driver.
    state.instance = state.instance or Random.hex(32)
    -- Whether this connection's relay answers alerts is not known yet (1.10.1, ADR-073).
    state.connection = state.connection + 1
    state.acks = nil
    state.relayFeatures = nil
    state.heardSinceHello = false
    state.heardTicks = 0
    send({ type = "hello", home = identity.home_id, version = Version.BRIDGE_VERSION, ping_s = math.floor(Relay.KEEPALIVE_MS / 1000), features = Relay.FEATURES, instance = state.instance })
    -- What could not be told while the connection was down (Relay.tellSoon), in order.
    local later = state.later
    state.later = {}
    for _, message in ipairs(later) do
        send(message)
    end
    Relay.announceKeys()
    startKeepalive()
    -- After a lost connection, the route may flip again at once (ADR-072).
    if state.dropped then
        startWatch()
    end
    state.dropped = false
    local drop = state.lastDrop
    publish("Connected since " .. os.date("%H:%M", state.connectedAt) .. " - home " .. identity.home_id:sub(1, 8)
        .. (drop and (" - last drop " .. os.date("%H:%M", drop.at) .. " (" .. drop.reason .. ")") or "")
        .. (state.backupRefused and " (the relay refused the backup's home)" or ""))
    log("info", "connected to the relay", { home_id = identity.home_id, attempts = state.tries, down_s = ago(state.downSince) })
    -- The history (ADR-046): only a connection away for more than a minute, once it is back.
    if (ago(state.downSince) or 0) > Activity.AWAY_SECONDS then
        Activity.record("system", "remote_away", { seconds = ago(state.downSince) })
    end
    state.tries = 0
    state.downSince = nil
    state.updateRequired = false
    state.minimumVersion = nil
end

-- The relay refused this version of DirectorLink (426 DRIVER_UPDATE_REQUIRED, ADR-059): drivers
-- older than the account service's minimum may not connect until they are updated in Composer.
-- Remote Status says so, the next attempt is an hour later, and the history has it once.
local function updateRequired(problem, status)
    state.trying = nil
    local minimum = type(problem) == "table" and type(problem.minimum_version) == "string" and problem.minimum_version:match("^%d+%.%d+%.%d+$") or nil
    if not state.updateRequired then
        state.updateRequired = true
        Activity.record("system", "remote_update_required", { from = Version.BRIDGE_VERSION, to = minimum })
    end
    state.minimumVersion = minimum
    scheduleReconnect("update required", Relay.UPDATE_RETRY_SECONDS, {
        level = "warn",
        message = "the relay no longer takes this version of DirectorLink; update it in Composer",
        data = { status = status, version = Version.BRIDGE_VERSION, minimum = minimum },
        status = Relay.UPDATE_STATUS,
    })
end

-- The wait after the relay closed the connection with `code`: a new secret the owner approved
-- (4001) is tried at once; another connection that took this one's place (4000) is given time.
local function closedByRelay(code)
    if code == 4001 then
        return Relay.QUICK_RETRY_SECONDS
    elseif code == 4000 then
        return Relay.REPLACED_RETRY_SECONDS
    end
    return quickRetry()
end

local function onClose(reason, status, body)
    if not state.enabled then
        return
    end
    if reason == "refused" then
        local problem = Json.decode(body or "")
        local detail = type(problem) == "table" and (problem.code or problem.detail) or ("HTTP " .. tostring(status))
        if tonumber(status) == 426 or detail == "DRIVER_UPDATE_REQUIRED" then
            updateRequired(problem, status)
            return
        end
        -- The owner may have approved a waiting replacement: try each once, newest first.
        local identity = Relay.identity()
        local nextTry = (state.trying or 0) + 1
        if status == 401 and identity.next_secrets and identity.next_secrets[nextTry] then
            state.trying = nextTry
            scheduleReconnect("trying a new home secret", 1, { message = "trying a new home secret", data = { candidate = nextTry } })
            return
        end
        state.trying = nil
        -- An identity restored from a backup that the relay does not know (its secret was replaced
        -- after the backup was made) or does not take (400: not an identity it accepts): the one
        -- this controller had comes back (ADR-042).
        if (status == 401 or status == 400) and identity.previous then
            local previous = identity.previous
            state.identity = { home_id = previous.home_id, home_secret = previous.home_secret, next_secrets = previous.next_secrets, linked = previous.linked }
            saveIdentity(state.identity)
            state.backupRefused = true
            scheduleReconnect("the backup's identity was refused; using this controller's", 1, {
                level = "warn",
                message = "the relay refused the remote identity restored from a backup; this controller's own is back",
                data = { refused = identity.home_id, home_id = previous.home_id, detail = tostring(detail) },
            })
            return
        end
        scheduleReconnect("refused: " .. tostring(detail), status == 401 and Relay.REFUSED_RETRY_SECONDS or nil,
            { level = "warn", message = "the relay refused the connection", data = { status = status, detail = tostring(detail) } })
        return
    end
    -- Lost: Director reported the connection offline ("connection lost"), the relay closed it
    -- (`status` is its close code), or it could not be opened.
    local open = state.connectedAt ~= nil
    local code = tonumber(status)
    local retry = nil
    if open then
        retry = code and closedByRelay(code) or quickRetry()
    end
    local facts = connectionFacts({ code = code })
    dropped(reason)
    scheduleReconnect(reason, retry, { message = open and "relay connection closed" or "relay connection attempt failed", data = facts })
end

connect = function()
    if not state.enabled then
        return
    end
    local identity = Relay.identity()
    if not state.socket then
        state.socket = WebSocket.new({
            binding = Relay.BINDING,
            host = Relay.HOST,
            port = Relay.PORT,
            path = Relay.PATH,
            log = state.services and state.services.log,
            onOpen = onOpen,
            onMessage = onMessage,
            onClose = onClose,
        })
    end
    local candidate = candidateInUse(identity)
    local secret = candidate and candidate.secret or identity.home_secret
    state.socket.headers = {
        { "Authorization", "Bearer " .. secret },
        { "X-DirectorLink-Home", identity.home_id },
        { "X-DirectorLink-Version", Version.BRIDGE_VERSION },
        { "User-Agent", "DirectorLink/" .. Version.BRIDGE_VERSION },
    }
    state.tries = state.tries + 1
    publish("Connecting...")
    log("debug", "connecting to the relay", { attempt = state.tries })
    -- Before connect(): a connection that fails at once cancels it on its way to the backoff.
    watchConnect()
    state.socket:connect()
end

-- The answer each question takes (onMessage): another type with the same id is not its answer.
local ANSWERS = { invitation = "invitation_result", backup_chunk = "backup_result", owner = "owner_result" }

-- Asks the relay something over this home's connection; done(answer) once, or done(nil, code)
-- after `seconds` or when not connected. Answers carry the same id (onMessage), which `message.id`
-- holds once it was sent.
function Relay.ask(message, seconds, done)
    if not state.socket or not state.connectedAt then
        done(nil, "REMOTE_OFFLINE")
        return
    end
    state.askCount = (state.askCount or 0) + 1
    local id = "d" .. state.askCount .. "-" .. os.time()
    message.id = id
    local finished = false
    local timer
    state.asked[id] = { expects = ANSWERS[message.type] or tostring(message.type) .. "_result", done = function(answer)
        if finished then
            return
        end
        finished = true
        if timer then
            pcall(function()
                timer:Cancel()
            end)
        end
        done(answer)
    end }
    pcall(function()
        timer = C4:SetTimer((seconds or 10) * 1000, function()
            if not finished then
                finished = true
                state.asked[id] = nil
                done(nil, "RELAY_TIMEOUT")
            end
        end)
    end)
    send(message)
end

-- Tells the relay something that needs no answer; false when not connected.
function Relay.tell(message)
    if not state.socket or not state.connectedAt then
        return false
    end
    send(message)
    return true
end

-- Whether an alert can go to the relay now (1.10.1, ADR-073): while connected, or while the driver
-- reconnects within KEEP_WINDOW_SECONDS of losing a connection whose relay answered alerts (it is
-- kept for the next connection). Otherwise not, as before: an unreachable home is the account
-- service's own alert (ADR-047).
function Relay.mayAlert()
    return Relay.connected() or (state.enabled and state.keepWindow ~= nil)
end

-- Sends an alert (`notify`, ADR-050) so that it arrives once (1.10.1, ADR-073): with an id, kept
-- until the relay answers it (src/cloud/outbox.lua) for at most `seconds`, and sent again after a
-- lost connection; while down within the window after a relay that answers alerts, kept and sent
-- after the next hello. To a relay that said it does not answer them (before 1.10.1), it goes once,
-- as before, without an id. `kind`: for the log; `letGo()`: called if it is let go before it ever
-- went (the hourly limits count only what was sent). Returns "sent" when it went, "kept" when it is
-- kept for the next connection, false when not connected (Relay.mayAlert false).
function Relay.alert(message, seconds, kind, letGo)
    local open = state.socket ~= nil and state.connectedAt ~= nil
    if open and state.acks == false then
        send(message)
        return "sent"
    end
    if not open and not Relay.mayAlert() then
        return false
    end
    local entry, kept = Outbox.add(message, seconds, kind, letGo)
    if not open then
        if kept then
            log("info", "an alert kept for the next connection", { kind = tostring(kind), keep_s = seconds })
            return "kept"
        end
        return false
    end
    send(Outbox.text(entry, state.connection, state.acks == true))
    return "sent"
end

-- What must reach the relay even if the connection is down now (an `owner_cancel`, ADR-064): told
-- at once, or kept in memory and told right after the next hello, before anything else is asked
-- (the newest LATER_MAX). Returns true.
Relay.LATER_MAX = 20

function Relay.tellSoon(message)
    if state.socket and state.connectedAt then
        send(message)
        return true
    end
    if #state.later >= Relay.LATER_MAX then
        table.remove(state.later, 1)
    end
    state.later[#state.later + 1] = message
    return true
end

-- A replacement for the home secret, for the home's owner to approve (docs/RELAY.md): the owner's
-- app asks for it on the home network (POST /v1/remote/secret) and gives its SHA-256 to the
-- account service, which from then on accepts only it. Each request gets a new one, never one
-- made earlier (a copy of the controller's data taken meanwhile would hold that). The newest few
-- are kept until one of them connects, so an approval that arrives late still works. Returns the
-- SHA-256 (hex), or nil and a code.
function Relay.prepareSecret()
    local identity = Relay.identity()
    local secret = Random.hex(64)
    local ok, hash = pcall(C4.Hash, C4, "SHA256", secret, { return_encoding = "HEX" })
    if not ok or type(hash) ~= "string" or not hash:match("^%x+$") or #hash ~= 64 then
        return nil, "HASH_UNAVAILABLE"
    end
    local candidates = { { secret = secret, at = os.time() } }
    for _, item in ipairs(identity.next_secrets or {}) do
        if #candidates < Relay.CANDIDATES and os.time() - item.at < Relay.CANDIDATE_SECONDS then
            candidates[#candidates + 1] = item
        end
    end
    local previous = identity.next_secrets
    identity.next_secrets = candidates
    if not saveIdentity(identity) then
        identity.next_secrets = previous
        return nil, "STORE_FAILED"
    end
    -- An attempt in progress keeps its place in the list.
    state.trying = nil
    log("info", "new home secret waiting for the owner's approval", { home_id = identity.home_id, waiting = #candidates })
    return hash:lower()
end

-- Composer: Reset Remote Identity. A new home id and secret, for when the old ones cannot be
-- trusted and cannot be replaced (someone else holds the home's connection). The account service
-- sees a new home: the owner links it again and invites everyone again.
function Relay.resetIdentity()
    local identity = { home_id = randomHex(32), home_secret = randomHex(64) }
    if not saveIdentity(identity) then
        return false, "STORE_FAILED"
    end
    state.identity = identity
    state.trying = nil
    -- Alerts kept to be sent again were sealed for the home id that is gone (ADR-073).
    Outbox.clear()
    log("warn", "remote identity reset", { home_id = identity.home_id })
    if state.enabled then
        if state.socket then
            state.socket:close(1000, false, "new identity")
        end
        scheduleReconnect("new remote identity", 1)
    end
    return true
end

-- The identity in use or stored, without making one when there is none yet (nil then).
function Relay.storedIdentity()
    return state.identity or (readIdentity(IDENTITY_KEY, false))
end

-- Backups (ADR-042, src/core/backup.lua): the home id and its secrets, the one in use and the
-- replacements waiting for the owner's approval (one of them may be approved later), marked
-- `linked`. Only an identity the relay has accepted, a home in the account service: one it never
-- saw would replace, when restored, a home that is linked. None is made for a backup.
function Relay.backupIdentity()
    local identity = Relay.storedIdentity()
    if not identity or not identity.linked then
        return { version = 1, linked = false }
    end
    local candidates = nil
    for _, item in ipairs(identity.next_secrets or {}) do
        candidates = candidates or Json.array()
        candidates[#candidates + 1] = { secret = item.secret, at = item.at }
    end
    return { version = 1, linked = true, home_id = identity.home_id, home_secret = identity.home_secret, next_secrets = candidates }
end

-- Uses `identity` ({ home_id, home_secret, next_secrets, previous }) from now on and saves it.
-- `previous`: the identity it replaces, used again if the relay refuses this one. Nothing happens
-- to the connection until Relay.reconnect. Returns true once saved. nil (there was none before a
-- restore that failed): the next use reads the store again.
function Relay.restoreIdentity(identity)
    state.trying = nil
    state.backupRefused = nil
    Outbox.clear()
    if identity == nil then
        state.identity = nil
        return true
    end
    state.identity = identityFrom(identity)
    return saveIdentity(state.identity)
end

-- Connects again with the identity in use then, `seconds` from now: after the answer that changed
-- it has gone out on the connection there is now.
function Relay.reconnect(seconds, reason)
    if not state.enabled then
        return
    end
    stopTimers()
    pcall(function()
        state.retry = C4:SetTimer((seconds or 1) * 1000, function()
            state.retry = nil
            if state.socket then
                state.socket:close(1000, false, "reconnecting")
            end
            scheduleReconnect(reason or "new remote identity", 1)
        end, false)
    end)
end

-- options: { services, onStatus = function(text), remote = Remote.handle }
function Relay.init(options)
    state.services = options.services
    state.onStatus = options.onStatus
    state.remote = options.remote
end

-- True while the relay connection is up.
function Relay.connected()
    return state.enabled and state.connectedAt ~= nil
end

-- What this connection's relay said it does (feature -> true; empty for a relay before 1.10.1), or
-- nil while not connected or before it said.
function Relay.features()
    if not Relay.connected() then
        return nil
    end
    return state.relayFeatures
end

-- The number of the connection (one more at each that opens), to tell a new connection.
function Relay.connectionNumber()
    return state.connection
end

-- `listener(features)` is told at each connection once its relay said what it does (1.12.0).
function Relay.onFeatures(listener)
    state.featureListeners[#state.featureListeners + 1] = listener
end

-- `handler(message)` gets the relay's messages of `messageType` that answer no question of
-- Relay.ask (1.12.0: Direct HTTPS's `https_certificate_result` and `https_result`).
function Relay.on(messageType, handler)
    state.handlers[messageType] = handler
end

-- Whether the account service turned this version away (426, ADR-059) and no connection has opened
-- since, while Remote Access is on; and the minimum version it named (nil when it named none).
function Relay.updateRequired()
    if not state.enabled or state.connectedAt ~= nil or not state.updateRequired then
        return false, nil
    end
    return true, state.minimumVersion
end

function Relay.start()
    if state.enabled then
        return
    end
    state.enabled = true
    state.attempts = 0
    state.quickLeft = 0
    state.tries = 0
    state.downSince = nil
    state.lastDrop = nil
    state.dropped = false
    log("info", "remote access switched on")
    connect()
end

function Relay.stop()
    local wasEnabled = state.enabled
    state.enabled = false
    stopTimers()
    if state.socket then
        state.socket:close(1000, false, "stopped")
    end
    state.connectedAt = nil
    -- Nothing is kept for a connection that will not come (ADR-073).
    state.acks = nil
    closeKeepWindow()
    Outbox.clear()
    publish("Off")
    if wasEnabled then
        log("info", "remote access switched off")
    end
end

function Relay.isEnabled()
    return state.enabled
end

function Relay.status()
    return state.status
end

-- Director network callbacks (routed by main.lua).
function Relay.onConnectionStatus(binding, port, status)
    if tonumber(binding) == Relay.BINDING and state.socket then
        log("debug", "relay connection status", { status = tostring(status) })
        state.socket:onConnectionStatus(status)
    end
end

function Relay.onData(binding, port, data)
    if tonumber(binding) == Relay.BINDING and state.socket then
        state.socket:onData(data)
    end
end

-- Test support: forget everything (a fresh driver instance).
function Relay.reset()
    Relay.stop()
    state.socket = nil
    state.identity = nil
    state.status = "Off"
    state.updateRequired = false
    state.minimumVersion = nil
    state.instance = nil
    state.connection = 0
    state.relayFeatures = nil
    Answers.reset()
    Outbox.reset()
end

return Relay
