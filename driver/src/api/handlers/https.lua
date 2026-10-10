-- Direct HTTPS (1.12.0 test build, ADR-082; src/api/direct_https.lua), for admins: the status and
-- the certificate request, the certificate given back, and a new key.

local Json = require("src.core.json")
local Problem = require("src.api.problem")
local Validate = require("src.api.validate")

local Https = {}

local function problem(refusal)
    local extra
    if refusal.field then
        extra = { errors = Json.array({ { field = refusal.field, message = refusal.detail } }) }
    end
    return Problem.new(refusal.status, refusal.code, refusal.detail, extra)
end

-- GET /v1/https (?csr=true: the CSR whatever the state).
function Https.status(ctx)
    local includeCsr, invalid = Validate.optionalBoolean(ctx.query.csr, "csr")
    if invalid then
        return invalid
    end
    return 200, ctx.services.https.status(includeCsr == true)
end

-- PUT /v1/https/certificate {certificate, chain}.
function Https.set_certificate(ctx)
    local invalid = Validate.body(ctx.body, { certificate = true, chain = true })
    if invalid then
        return invalid
    end
    if type(ctx.body.certificate) ~= "string" then
        return Problem.invalidField("certificate", "certificate must be PEM text")
    end
    local chain = ctx.body.chain
    if chain == Json.null then
        chain = nil
    end
    if chain ~= nil and type(chain) ~= "string" then
        return Problem.invalidField("chain", "chain must be PEM text")
    end
    local status, refusal = ctx.services.https.installCertificate(ctx.body.certificate, chain, ctx.apiKey.id)
    if not status then
        return problem(refusal)
    end
    return 200, status
end

-- POST /v1/https/new-key.
function Https.new_key(ctx)
    local status, refusal = ctx.services.https.newKey(ctx.apiKey.id)
    if not status then
        return problem(refusal)
    end
    return 200, status
end

return Https
