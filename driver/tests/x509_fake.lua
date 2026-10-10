-- Fake certificate requests and certificates for the Direct HTTPS tests (ADR-082): DER built by
-- hand, shaped as Director's C4:GenerateCSR_ECC and a CA such as Let's Encrypt make them, with
-- made-up public keys and signatures (DirectorLink checks no signature: browsers do). Never a key.

local Base64 = require("src.core.base64")

local Fake = {}

local function bytes(...)
    return string.char(...)
end

local OID_EC_PUBLIC_KEY = bytes(0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01)
local OID_PRIME256V1 = bytes(0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07)
local OID_PRIME_FIELD = bytes(0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x01, 0x01)
local OID_ECDSA_SHA256 = bytes(0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02)
local OID_COMMON_NAME = bytes(0x55, 0x04, 0x03)
local OID_SUBJECT_ALT_NAME = bytes(0x55, 0x1D, 0x11)
local OID_EXTENSION_REQUEST = bytes(0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x0E)

local function length(count)
    if count < 128 then
        return bytes(count)
    elseif count < 256 then
        return bytes(0x81, count)
    end
    return bytes(0x82, math.floor(count / 256), count % 256)
end

function Fake.tlv(tag, content)
    return bytes(tag) .. length(#content) .. content
end
local tlv = Fake.tlv

local function sequence(...)
    return tlv(0x30, table.concat({ ... }))
end

local function set(...)
    return tlv(0x31, table.concat({ ... }))
end

function Fake.name(commonName)
    return sequence(set(sequence(tlv(0x06, OID_COMMON_NAME), tlv(0x0C, commonName))))
end

-- An uncompressed P-256 point's 65 bytes, different for each seed.
function Fake.point(seed)
    local out = { bytes(0x04) }
    for index = 1, 64 do
        out[#out + 1] = bytes((seed * 131 + index * 7 + math.floor(seed / 7)) % 256)
    end
    return table.concat(out)
end

-- SubjectPublicKeyInfo for `point`: the curve by its name (as public CAs want it), or, `explicit`,
-- by its parameters (as an old OpenSSL wrote it).
function Fake.spki(point, explicit)
    local parameters = tlv(0x06, OID_PRIME256V1)
    if explicit then
        parameters = sequence(tlv(0x02, bytes(0x01)), sequence(tlv(0x06, OID_PRIME_FIELD), tlv(0x02, bytes(0x00, 0xFF, 0xFF))))
    end
    return sequence(sequence(tlv(0x06, OID_EC_PUBLIC_KEY), parameters), tlv(0x03, bytes(0x00) .. point))
end

local function dnsNames(names)
    local list = {}
    for _, name in ipairs(names) do
        list[#list + 1] = tlv(0x82, name)
    end
    return sequence(sequence(tlv(0x06, OID_SUBJECT_ALT_NAME), tlv(0x04, sequence(table.concat(list)))))
end

local function signed(body)
    return sequence(body, sequence(tlv(0x06, OID_ECDSA_SHA256)), tlv(0x03, bytes(0x00) .. sequence(tlv(0x02, string.rep("\1", 32)), tlv(0x02, string.rep("\2", 32)))))
end

-- A CSR for `name` (CN and subjectAltName DNS:name), as C4:GenerateCSR_ECC makes it.
function Fake.request(name, point, explicit)
    local attributes = tlv(0xA0, sequence(tlv(0x06, OID_EXTENSION_REQUEST), set(dnsNames({ name }))))
    return signed(sequence(tlv(0x02, bytes(0x00)), Fake.name(name), Fake.spki(point, explicit), attributes))
end

-- "2027-01-08T12:00:00Z" as UTCTime (before 2050) or GeneralizedTime.
local function time(iso)
    local year, month, day, hour, minute, second = iso:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)Z$")
    if tonumber(year) < 2050 then
        return tlv(0x17, year:sub(3) .. month .. day .. hour .. minute .. second .. "Z")
    end
    return tlv(0x18, year .. month .. day .. hour .. minute .. second .. "Z")
end

-- A certificate: options.spki (DER, e.g. read from a CSR) or options.point; options.names (DNS
-- names), options.issuer_cn ("E5"), options.not_before and options.not_after (ISO), options.serial.
function Fake.certificate(options)
    local spki = options.spki or Fake.spki(options.point or Fake.point(99))
    local names = options.names or {}
    local subject = options.subject_cn or names[1] or "nobody"
    local tbs = sequence(
        tlv(0xA0, tlv(0x02, bytes(0x02))),
        tlv(0x02, bytes(0x01, (options.serial or 1) % 256)),
        sequence(tlv(0x06, OID_ECDSA_SHA256)),
        Fake.name(options.issuer_cn or "E5"),
        sequence(time(options.not_before or "2026-10-01T00:00:00Z"), time(options.not_after or "2027-01-08T12:00:00Z")),
        Fake.name(subject),
        spki,
        tlv(0xA3, dnsNames(names))
    )
    return signed(tbs)
end

function Fake.pem(der, label)
    local encoded = Base64.encode(der)
    local lines = { "-----BEGIN " .. label .. "-----" }
    for index = 1, #encoded, 64 do
        lines[#lines + 1] = encoded:sub(index, index + 63)
    end
    lines[#lines + 1] = "-----END " .. label .. "-----"
    return table.concat(lines, "\n") .. "\n"
end

-- A stand-in for the private key C4:GenerateCSR_ECC returns: PEM-shaped, not a key.
function Fake.privateKey(seed)
    local label = "EC " .. "PRIVATE KEY"
    return "-----BEGIN " .. label .. "-----\n" .. Base64.encode("not a key, test " .. tostring(seed)) .. "\n-----END " .. label .. "-----\n"
end

return Fake
