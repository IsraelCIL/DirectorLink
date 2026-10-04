-- Scene links (ADR-051, docs/SCENES.md, src/core/scene_links.lua): a private link per scene for the
-- phone's own automations. Admins make, replace and remove a scene's link here; the secret is in
-- the answer that makes it and nowhere else. A run comes from the account service over the relay
-- (docs/RELAY.md, `link`): the scene runs as a member's key would run it, as schedules do, so it
-- never opens a door or gate even if one were in it, and goes into the history as run by the link.
-- A link goes with the key that made it (revoked, or expired: main.lua prunes when keys change).
--   GET    /v1/scene-links                every link, with its scene's name (admins)
--   GET    /v1/scenes/{sceneId}/link      the scene's link, without its secret
--   POST   /v1/scenes/{sceneId}/link      {"label"}: a new link, replacing the scene's; its secret once
--   DELETE /v1/scenes/{sceneId}/link      removes it

local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local Scenes = require("src.core.scenes")
local SceneLinks = require("src.core.scene_links")
local Activity = require("src.core.activity")
local Relay = require("src.cloud.relay")
local Keys = require("src.auth.keys")
local SceneHandlers = require("src.api.handlers.scenes")

local Handlers = {}

-- A refused run is logged at most this often (with how many there were): a flood of wrong secrets
-- must not push the rest out of the log.
Handlers.REFUSAL_LOG_SECONDS = 60

local refusals = { loggedAt = nil, count = 0 }

local function nullable(value)
    if value == nil then
        return Json.null
    end
    return value
end

local function view(link)
    local scene = Scenes.find(link.scene_id)
    return {
        scene_id = link.scene_id,
        scene_name = scene and scene.name or Json.null,
        link_id = link.id,
        label = nullable(link.label),
        -- The key that made it: revoking that key ends the link (the app says so first).
        made_by = nullable(link.by),
        created_at = link.created_at,
        last_used_at = nullable(link.last_used_at),
    }
end

-- The address a phone calls: the account service's /run/<home>.<link>, with the secret after "#"
-- (a browser never sends it; the page there posts it). Automations post the secret in the body.
function Handlers.url(home, linkId, secret)
    return "https://" .. Relay.HOST .. "/run/" .. home .. "." .. linkId .. (secret and ("#" .. secret) or "")
end

-- The home id links are made for: the identity the relay has accepted, else nil.
local function linkedHome()
    local identity = Relay.storedIdentity()
    return identity and identity.linked and identity.home_id or nil
end

local function findScene(ctx)
    local id = tostring(ctx.params.sceneId or "")
    if #id ~= 8 or not id:match("^[%da-f]+$") then
        return nil, Problem.invalidParameter("sceneId", "sceneId is 8 hex characters")
    end
    local scene = Scenes.find(id)
    if not scene then
        return nil, Problem.notFound("Scene", id)
    end
    return scene
end

local function unreadable()
    return Problem.new(503, "UNAVAILABLE", "The saved scene links could not be read when DirectorLink started; restart the driver and try again")
end

-- Links whose scene is gone or now opens doors or gates, that were made for another home than the
-- one the relay knows, or whose key was revoked or expired, go (at start, after a restore, when
-- keys change, before a list). Nothing while the scenes could not be read: every link would look
-- orphaned; and no key is missing while the keys could not be read.
function Handlers.prune()
    if not Scenes.complete() then
        return {}
    end
    return SceneLinks.prune(Scenes.find, linkedHome(), Keys.complete() and Keys.exists or nil)
end

function Handlers.list(ctx)
    Handlers.prune()
    local items = Json.array()
    for _, link in ipairs(SceneLinks.list()) do
        items[#items + 1] = view(link)
    end
    return 200, {
        items = items,
        -- What a link needs to work: Remote Access on, and a home the relay has accepted (linked to
        -- an account). The app says so when either is missing.
        remote_access = ctx.services.remote.enabled(),
        home_linked = linkedHome() ~= nil,
    }
end

function Handlers.get(ctx)
    local scene, problem = findScene(ctx)
    if not scene then
        return problem
    end
    local link = SceneLinks.forScene(scene.id)
    if not link then
        return Problem.notFound("Link of scene", scene.id)
    end
    return 200, view(link)
end

-- POST {"label": "Arriving home"}: a new link for the scene; the one it had stops working at once.
function Handlers.create(ctx)
    local scene, problem = findScene(ctx)
    if not scene then
        return problem
    end
    local body = ctx.body or {}
    problem = Validate.body(body, { label = true }, false)
    if problem then
        return problem
    end
    local label = nil
    if body.label ~= nil and body.label ~= Json.null and not (type(body.label) == "string" and body.label:match("^%s*$")) then
        label, problem = Validate.name(body.label, "label")
        if problem then
            return problem
        end
    end
    if not SceneLinks.linkable(scene) then
        return Problem.new(409, "SCENE_OPENS_DOORS", "A scene that opens doors or gates cannot have a link")
    end
    if not ctx.services.remote.enabled() then
        return Problem.new(409, "REMOTE_ACCESS_OFF", "A link reaches the home through remote access: turn on Remote Access in Composer first")
    end
    local home = linkedHome()
    if not home then
        return Problem.new(409, "HOME_NOT_LINKED", "DirectorLink's servers have not accepted this home yet: link it to your account first")
    end
    if not SceneLinks.complete() then
        return unreadable()
    end
    local link, secret, replaced = SceneLinks.create(scene.id, label, home, ctx.apiKey.id)
    if not link then
        return Problem.internal("The link could not be made (" .. tostring(secret) .. ")")
    end
    ctx.services.log.info("scenes", replaced and "scene link replaced" or "scene link made", { scene = scene.id, link_id = link.id, by = ctx.apiKey.id })
    Activity.record("access", replaced and "link_replaced" or "link_created", {
        by = ctx.apiKey,
        what = scene.name,
        note = label,
        ids = { scene_id = scene.id, link_id = link.id },
    })
    local answer = view(link)
    answer.home_id = home
    answer.secret = secret
    answer.url = Handlers.url(home, link.id, secret)
    answer.replaced = replaced ~= nil
    return 201, answer
end

function Handlers.delete(ctx)
    local scene, problem = findScene(ctx)
    if not scene then
        return problem
    end
    local removed, failure = SceneLinks.remove(scene.id)
    if not removed then
        if failure == "NOT_FOUND" then
            return Problem.notFound("Link of scene", scene.id)
        elseif failure == "STORE_UNREADABLE" then
            return unreadable()
        end
        return Problem.internal("The link could not be removed")
    end
    ctx.services.log.info("scenes", "scene link removed", { scene = scene.id, link_id = removed.id, by = ctx.apiKey.id })
    Activity.record("access", "link_removed", {
        by = ctx.apiKey,
        what = scene.name,
        note = removed.label,
        ids = { scene_id = scene.id, link_id = removed.id },
    })
    return 204
end

-- What the phone is told: everything ran, some of it, none of it (skipped or failed), or nothing
-- was there to run (its devices were all removed in Composer since).
local function outcome(result)
    if result.ran == 0 and result.skipped == 0 and result.failed == 0 then
        return "nothing"
    elseif result.skipped == 0 and result.failed == 0 then
        return "ran"
    end
    return result.ran > 0 and "partly" or "failed"
end

local function refused(services, why, linkId)
    local now = os.time()
    refusals.count = refusals.count + 1
    if refusals.loggedAt and now - refusals.loggedAt < Handlers.REFUSAL_LOG_SECONDS and now >= refusals.loggedAt then
        return
    end
    services.log.warn("scenes", "refused a scene link run", { why = why, link_id = linkId, refusals = refusals.count })
    refusals.loggedAt, refusals.count = now, 0
end

-- A run from the account service: {"type":"link","id":…,"link":"<8 hex>","secret":"<40 hex>"},
-- answered {"type":"link_result","id":…,"ok":true,"result":"ran"|"partly"|"failed"|"nothing"}, or
-- "ok":false with NOT_FOUND (no such link, a wrong secret, a scene that is gone or opens doors, or
-- the key that made it gone: all alike) or RATE_LIMITED (with retry_s). The secret is never logged.
function Handlers.relayRun(services, message, send)
    local function answer(fields)
        fields.type = "link_result"
        fields.id = message.id
        send(fields)
    end
    local linkId = type(message.link) == "string" and message.link:match("^[0-9a-f]+$") and #message.link == SceneLinks.ID_LENGTH and message.link or nil
    local link = linkId and SceneLinks.check(linkId, message.secret) or nil
    if not link then
        refused(services, "unknown link or wrong secret", linkId)
        answer({ ok = false, code = "NOT_FOUND" })
        return
    end
    local allowed, wait = SceneLinks.allow(link.id)
    if not allowed then
        refused(services, "too many runs", link.id)
        answer({ ok = false, code = "RATE_LIMITED", retry_s = wait })
        return
    end
    local scene = Scenes.find(link.scene_id)
    -- Checked again at every run: the scene may have been changed to open doors (by a driver that
    -- does not know links, before an update), or deleted; the key that made it may have expired a
    -- moment ago (finding it removes it then, and its links with it).
    if not scene or not SceneLinks.linkable(scene) or link.home ~= linkedHome() or (link.by and Keys.complete() and not Keys.find(link.by)) then
        Handlers.prune()
        refused(services, "the scene is gone or opens doors or gates, or its key is gone", link.id)
        answer({ ok = false, code = "NOT_FOUND" })
        return
    end
    local result = SceneHandlers.runSaved(services, scene.id, { id = "link:" .. link.id, role = "member" })
    SceneLinks.used(link.id)
    Activity.record("scene", "run", {
        who = { type = "link", link_id = link.id, name = link.label },
        what = scene.name,
        counts = result,
        ids = { scene_id = scene.id, link_id = link.id },
    })
    -- Shown to the installer in Composer (Last Automation).
    if services.onAutomation then
        pcall(services.onAutomation, { at = os.time(), scene_id = scene.id, key_name = "a scene link" .. (link.label and (" (" .. link.label .. ")") or ""), result = result })
    end
    services.log.info("scenes", "scene ran by its link", {
        scene = scene.id, link_id = link.id, ran = result.ran, skipped = result.skipped, failed = result.failed,
    })
    answer({ ok = true, result = outcome(result) })
end

-- Test support.
function Handlers.reset()
    refusals.loggedAt, refusals.count = nil, 0
end

return Handlers
