-- Direct HTTPS (1.12.0, ADR-082; src/api/direct_https.lua): its status for admins, and the home's
-- owner's switch.

local Problem = require("src.api.problem")
local Validate = require("src.api.validate")
local Access = require("src.auth.access")

local Https = {}

-- GET /v1/https.
function Https.status(ctx)
    return 200, ctx.services.https.status()
end

-- PUT /v1/https {"enabled": true | false}: the home's owner only (ADR-064), once the installer has
-- allowed it in Composer; on needs Remote Access and a home linked to an account. In the history.
function Https.set(ctx)
    local invalid = Validate.body(ctx.body, { enabled = true })
    if invalid then
        return invalid
    end
    if type(ctx.body.enabled) ~= "boolean" then
        return Problem.invalidField("enabled", "enabled must be true or false")
    end
    local _, unknown = Access.owner()
    if unknown then
        return Problem.new(503, "UNAVAILABLE", "Who the home's owner is could not be read when DirectorLink started; restart the driver and try again")
    end
    if not Access.isOwner(ctx.apiKey) then
        return Problem.new(403, "OWNER_ONLY", "Only the home's owner turns Direct HTTPS on or off")
    end
    local status, refusal = ctx.services.https.setEnabled(ctx.body.enabled, ctx.apiKey)
    if not status then
        return Problem.new(refusal.status, refusal.code, refusal.detail)
    end
    return 200, status
end

return Https
