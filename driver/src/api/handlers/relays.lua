local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local Views = require("src.api.views")
local Activity = require("src.core.activity")
local Access = require("src.auth.access")
local AskLinkHandlers = require("src.api.handlers.ask_links")
local DoorbellHandlers = require("src.api.handlers.doorbells")

-- How the history names what a relay was told (a relay held closed holds its door open).
local HISTORY = { pulse = "pulse", close = "hold", open = "release" }

local Relays = {}

local STATES = { open = "open", closed = "close" }

local function findRelay(ctx)
    local id, problem = Validate.id(ctx.params.relayId, "relayId")
    if not id then
        return nil, problem
    end
    local device = ctx.services.registry.getDevice(id)
    -- A door or gate the caller may not see is, for them, one that does not exist (ADR-054).
    if not device or device.kind ~= "relay" or device.supported ~= true or not Access.canSee(ctx.apiKey, device) then
        return nil, Problem.notFound("Relay", id)
    end
    return device
end

-- `answering`: an ask-to-open link's request this pulse answers (ADR-058): { link_id, note, done }.
-- `doorbell`: the doorbell whose screen or ring banner it came from (1.11.0, ADR-078): { id, name }.
local function run(ctx, device, action, answering, doorbell)
    -- Seen but not theirs to open: 403, as for the doors role of 1.7.0 (ADR-054).
    if not Access.canOpen(ctx.apiKey, device) then
        return Problem.new(403, "FORBIDDEN", "Opening doors and gates is not among this person's permissions")
    end
    if not ctx.services.doorControlEnabled() then
        return Problem.new(403, "DOOR_CONTROL_DISABLED",
            "Door control is off; turn on the Door Control property of DirectorLink in Composer")
    end
    -- A relay held closed holds its door or gate open until someone opens the relay: only where
    -- an installer allowed it (1.1.1, ADR-036). Nothing is sent otherwise.
    if action == "close" and not ctx.services.relayHoldAllowed() then
        return Problem.new(409, "HOLD_NOT_ALLOWED",
            "Holding a relay closed is off: use pulse. An installer can allow it in Composer (Relay Hold).")
    end
    -- A Relay Door or Gate Controller set to hold its relay holds its door open with Open: that too
    -- only where an installer allowed holds (ADR-069); its adapter refuses it otherwise.
    local ok, failure = ctx.services.adapters.execute(device.id, action, { hold_allowed = ctx.services.relayHoldAllowed() })
    if not ok then
        return Problem.fromAdapter(failure)
    end
    if answering then
        answering.done()
    end
    ctx.services.log.info("relay_command", "relay " .. action .. " requested", {
        device_id = device.id,
        key_id = ctx.apiKey and ctx.apiKey.id or Json.null,
        client = ctx.client and ctx.client.ip or Json.null,
        link_id = answering and answering.link_id or nil,
        doorbell_id = doorbell and doorbell.id or nil,
    })
    Activity.record("door", HISTORY[action], {
        by = ctx.apiKey,
        what = device.name,
        room = device.room_name,
        -- Opened in answer to an ask-to-open link: its label, and its id; from a doorbell's screen
        -- or ring banner: the doorbell's name, and its id.
        note = answering and answering.note or doorbell and doorbell.name or nil,
        ids = {
            device_id = device.id,
            room_id = device.room_id,
            link_id = answering and answering.link_id or nil,
            doorbell_id = doorbell and doorbell.id or nil,
        },
    })
    return 202, Views.relay(ctx.services.registry, device)
end

function Relays.list(ctx)
    local roomId, problem = Validate.optionalInteger(ctx.query.room_id, "room_id", 1)
    if problem then
        return problem
    end
    local registry = ctx.services.registry
    local items = Json.array()
    for _, device in ipairs(Access.filter(ctx.apiKey, registry.relayList())) do
        if roomId == nil or tonumber(device.room_id) == roomId then
            items[#items + 1] = Views.relay(registry, device)
        end
    end
    return 200, { items = items }
end

function Relays.get(ctx)
    local device, problem = findRelay(ctx)
    if not device then
        return problem
    end
    return 200, Views.relay(ctx.services.registry, device)
end

function Relays.update(ctx)
    local device, problem = findRelay(ctx)
    if not device then
        return problem
    end
    local body = ctx.body
    problem = Validate.body(body, { state = true }, true)
    if problem then
        return problem
    end
    local action = STATES[body.state]
    if not action then
        return Problem.invalidField("state", 'state must be "open" or "closed"')
    end
    return run(ctx, device, action)
end

-- POST, optionally with {"request": "<id>"}: the answer to an ask-to-open link's request (ADR-058),
-- from a device it was sent to, only while it lasts and once (src/api/handlers/ask_links.lua). With
-- {"doorbell": <id>} (1.11.0, ADR-078) it is opened from that doorbell's screen or ring banner: an
-- ordinary opening of this door, checked as any, that the history says came from the doorbell when
-- the door is one of that doorbell's (else it says nothing of it). Any other body is ignored, as
-- before.
function Relays.pulse(ctx)
    local device, problem = findRelay(ctx)
    if not device then
        return problem
    end
    local answering, doorbell
    if type(ctx.body) == "table" and ctx.body.request ~= nil and ctx.body.request ~= Json.null then
        answering, problem = AskLinkHandlers.claim(ctx, device, ctx.body.request)
        if not answering then
            return problem
        end
    elseif type(ctx.body) == "table" and ctx.body.doorbell ~= nil and ctx.body.doorbell ~= Json.null then
        doorbell = DoorbellHandlers.at(ctx, device, ctx.body.doorbell)
    end
    return run(ctx, device, "pulse", answering, doorbell)
end

return Relays
