-- Which alerts a device gets (ADR-050, src/cloud/alerts.lua): each key's own choices, read and set
-- by that key only. `on`: its device switched alerts on (Settings → Controller → Alerts on this
-- device); `kinds`: what it wants of the kinds its role may get that this home has.
--   GET /v1/alerts/choices   { on, kinds: { doorbell, door_opened, fridge_door, schedule_failed } }
--   PUT /v1/alerts/choices   { on?, kinds? }: the same, changed

local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local Alerts = require("src.cloud.alerts")

local Handlers = {}

local KNOWN = {}
for _, kind in ipairs(Alerts.KINDS) do
    KNOWN[kind] = true
end

local function view(choices)
    -- An empty table is an object in JSON: nothing to choose is {}.
    return { on = choices.on, kinds = choices.kinds }
end

function Handlers.get(ctx)
    return 200, view(Alerts.view(ctx.apiKey))
end

function Handlers.put(ctx)
    local body = ctx.body
    local problem = Validate.body(body, { on = true, kinds = true }, true)
    if problem then
        return problem
    end
    if body.on ~= nil and type(body.on) ~= "boolean" then
        return Problem.invalidField("on", "on must be true or false")
    end
    local kinds = body.kinds
    if kinds ~= nil then
        if type(kinds) ~= "table" or kinds == Json.null or Json.isArray(kinds) and #kinds > 0 then
            return Problem.invalidField("kinds", "kinds must be an object of kinds, each true or false")
        end
        for kind, on in pairs(kinds) do
            if not KNOWN[kind] then
                return Problem.invalidField("kinds." .. tostring(kind), "Unknown alert: " .. tostring(kind) .. " (" .. table.concat(Alerts.KINDS, ", ") .. ")")
            end
            if type(on) ~= "boolean" then
                return Problem.invalidField("kinds." .. kind, kind .. " must be true or false")
            end
        end
    end
    local choices, code = Alerts.choose(ctx.apiKey, body.on, kinds)
    if not choices then
        return Problem.new(503, code or "UNAVAILABLE", "The alert choices could not be saved; try again")
    end
    return 200, view(choices)
end

return Handlers
