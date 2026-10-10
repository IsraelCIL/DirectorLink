-- The little of X.509 that Direct HTTPS reads (1.12.0 test build, ADR-082), in plain Lua: PEM
-- blocks, and from a certificate or a certificate request (CSR) its public key, its names, its
-- issuer's name and when it expires. Nothing here checks a signature: a certificate is only kept
-- when its public key is the controller's own (src/api/https.lua), and browsers check the rest.

local Base64 = require("src.core.base64")
local Clock = require("src.core.clock")

local X509 = {}

-- Object identifiers, as their DER contents.
local OID_EC_PUBLIC_KEY = "\42\134\72\206\61\2\1" -- 1.2.840.10045.2.1
local OID_PRIME256V1 = "\42\134\72\206\61\3\1\7" -- 1.2.840.10045.3.1.7 (P-256)
local OID_COMMON_NAME = "\85\4\3" -- 2.5.4.3
local OID_SUBJECT_ALT_NAME = "\85\29\17" -- 2.5.29.17

local SEQUENCE, SET, INTEGER, OID, BIT_STRING, OCTET_STRING, BOOLEAN = 0x30, 0x31, 0x02, 0x06, 0x03, 0x04, 0x01
local UTC_TIME, GENERALIZED_TIME = 0x17, 0x18
local STRING_TAGS = { [0x0C] = true, [0x13] = true, [0x16] = true, [0x14] = true } -- UTF8, Printable, IA5, T61
local DNS_NAME = 0x82 -- [2] IA5String in GeneralNames

-- The PEM blocks labelled `label` ("CERTIFICATE", "CERTIFICATE REQUEST"), each as DER bytes; nil
-- when one of them is not base64.
function X509.pemBlocks(text, label)
    if type(text) ~= "string" then
        return nil
    end
    local dashes = "%-%-%-%-%-"
    local pattern = dashes .. "BEGIN " .. label:gsub(" ", "%%s") .. dashes .. "(.-)" .. dashes .. "END " .. label:gsub(" ", "%%s") .. dashes
    local blocks = {}
    for body in text:gmatch(pattern) do
        local der = Base64.decode(body)
        if not der or der == "" then
            return nil
        end
        blocks[#blocks + 1] = der
    end
    return blocks
end

-- DER bytes as PEM, 64 characters a line.
function X509.pem(der, label)
    local encoded = Base64.encode(der)
    local lines = { "-----BEGIN " .. label .. "-----" }
    for index = 1, #encoded, 64 do
        lines[#lines + 1] = encoded:sub(index, index + 63)
    end
    lines[#lines + 1] = "-----END " .. label .. "-----"
    return table.concat(lines, "\n") .. "\n"
end

-- One element at `position`: its tag, where its contents start and end, and where the next
-- element starts; nil when the bytes are not DER this reader takes.
local function element(data, position, limit)
    limit = limit or #data
    local tag, first = data:byte(position, position + 1)
    if not tag or not first or position + 1 > limit or tag % 32 == 31 then
        return nil
    end
    local length, header = first, 2
    if first == 128 then
        return nil
    elseif first > 128 then
        local count = first - 128
        if count > 3 then
            return nil
        end
        length = 0
        for index = 1, count do
            local byte = data:byte(position + 1 + index)
            if not byte then
                return nil
            end
            length = length * 256 + byte
        end
        header = 2 + count
    end
    local start = position + header
    local finish = start + length - 1
    if finish > limit then
        return nil
    end
    return { tag = tag, start = start, finish = finish, from = position, nextAt = finish + 1 }
end

-- The elements inside `parent` (a constructed element), in order; nil when they do not fill it.
local function children(data, parent)
    local list, position = {}, parent.start
    while position <= parent.finish do
        local child = element(data, position, parent.finish)
        if not child then
            return nil
        end
        list[#list + 1] = child
        position = child.nextAt
    end
    return list
end

local function contents(data, node)
    return data:sub(node.start, node.finish)
end

local function whole(data, node)
    return data:sub(node.from, node.finish)
end

-- The first common name (CN) of a Name, or nil.
local function commonName(data, name)
    for _, set in ipairs(children(data, name) or {}) do
        if set.tag == SET then
            for _, attribute in ipairs(children(data, set) or {}) do
                local parts = attribute.tag == SEQUENCE and children(data, attribute)
                if parts and #parts == 2 and parts[1].tag == OID and contents(data, parts[1]) == OID_COMMON_NAME
                    and STRING_TAGS[parts[2].tag] then
                    return contents(data, parts[2])
                end
            end
        end
    end
    return nil
end

-- SubjectPublicKeyInfo: the whole of it, the key's bytes, and its curve: "prime256v1", "explicit"
-- (the curve given by its parameters instead of its name), or another name's identifier in hex.
local function publicKeyInfo(data, node)
    local parts = node.tag == SEQUENCE and children(data, node)
    if not parts or #parts ~= 2 or parts[1].tag ~= SEQUENCE or parts[2].tag ~= BIT_STRING then
        return nil
    end
    local algorithm = children(data, parts[1])
    if not algorithm or #algorithm < 1 or algorithm[1].tag ~= OID then
        return nil
    end
    local info = { spki = whole(data, node), public_key = contents(data, parts[2]) }
    if contents(data, algorithm[1]) == OID_EC_PUBLIC_KEY then
        local parameters = algorithm[2]
        if parameters and parameters.tag == OID then
            local curve = contents(data, parameters)
            info.curve = curve == OID_PRIME256V1 and "prime256v1" or Base64.toHex(curve)
        elseif parameters and parameters.tag == SEQUENCE then
            info.curve = "explicit"
        end
        info.algorithm = "ec"
    else
        info.algorithm = Base64.toHex(contents(data, algorithm[1]))
    end
    return info
end

-- A UTCTime or GeneralizedTime as ISO 8601 UTC and as a Unix time.
local function time(data, node)
    local text = contents(data, node)
    local year, rest
    if node.tag == UTC_TIME then
        local short
        short, rest = text:match("^(%d%d)(%d%d%d%d%d%d%d%d%d%d)Z$")
        if short then
            year = tonumber(short) < 50 and 2000 + tonumber(short) or 1900 + tonumber(short)
        end
    elseif node.tag == GENERALIZED_TIME then
        year, rest = text:match("^(%d%d%d%d)(%d%d%d%d%d%d%d%d%d%d)Z$")
    end
    if not year then
        return nil
    end
    local month, day, hour, minute, second = rest:match("^(%d%d)(%d%d)(%d%d)(%d%d)(%d%d)$")
    local iso = string.format("%04d-%s-%sT%s:%s:%sZ", tonumber(year), month, day, hour, minute, second)
    local seconds = Clock.parseIso(iso)
    if not seconds then
        return nil
    end
    return iso, seconds
end

-- The DNS names of a certificate's Subject Alternative Name extension.
local function dnsNames(data, extensions)
    local names = {}
    local list = children(data, extensions)
    local sequence = list and list[1]
    for _, extension in ipairs(sequence and sequence.tag == SEQUENCE and children(data, sequence) or {}) do
        local parts = extension.tag == SEQUENCE and children(data, extension)
        if parts and parts[1] and parts[1].tag == OID and contents(data, parts[1]) == OID_SUBJECT_ALT_NAME then
            local value = parts[#parts]
            if value.tag == OCTET_STRING and (#parts == 2 or (#parts == 3 and parts[2].tag == BOOLEAN)) then
                local inner = element(data, value.start, value.finish)
                for _, name in ipairs(inner and inner.tag == SEQUENCE and children(data, inner) or {}) do
                    if name.tag == DNS_NAME then
                        names[#names + 1] = string.lower(contents(data, name))
                    end
                end
            end
        end
    end
    return names
end

-- A certificate (DER): { public_key, spki, curve, algorithm, issuer_cn, subject_cn, not_after,
-- not_after_s, dns_names }, or nil and why not.
function X509.readCertificate(der)
    if type(der) ~= "string" then
        return nil, "not a certificate"
    end
    local top = element(der, 1)
    local parts = top and top.tag == SEQUENCE and top.nextAt == #der + 1 and children(der, top)
    if not parts or #parts ~= 3 or parts[1].tag ~= SEQUENCE then
        return nil, "not a DER certificate"
    end
    local fields = children(der, parts[1])
    if not fields then
        return nil, "not a DER certificate"
    end
    local index = 1
    if fields[1] and fields[1].tag == 0xA0 then
        index = 2
    end
    local serial, _signature, issuer, validity, subject, spki =
        fields[index], fields[index + 1], fields[index + 2], fields[index + 3], fields[index + 4], fields[index + 5]
    if not (serial and serial.tag == INTEGER and issuer and issuer.tag == SEQUENCE and validity and validity.tag == SEQUENCE
        and subject and subject.tag == SEQUENCE and spki) then
        return nil, "not a DER certificate"
    end
    local key = publicKeyInfo(der, spki)
    if not key then
        return nil, "the certificate's public key could not be read"
    end
    local times = children(der, validity)
    local notAfter, notAfterSeconds
    if times and #times == 2 then
        notAfter, notAfterSeconds = time(der, times[2])
    end
    if not notAfter then
        return nil, "the certificate's validity could not be read"
    end
    local names = {}
    for position = index + 6, #fields do
        if fields[position].tag == 0xA3 then
            names = dnsNames(der, fields[position])
        end
    end
    key.issuer_cn = commonName(der, issuer)
    key.subject_cn = commonName(der, subject)
    key.not_after = notAfter
    key.not_after_s = notAfterSeconds
    key.dns_names = names
    return key
end

-- A certificate request (DER): { public_key, spki, curve, algorithm, subject_cn }, or nil and why not.
function X509.readRequest(der)
    if type(der) ~= "string" then
        return nil, "not a certificate request"
    end
    local top = element(der, 1)
    local parts = top and top.tag == SEQUENCE and top.nextAt == #der + 1 and children(der, top)
    local info = parts and #parts == 3 and parts[1].tag == SEQUENCE and children(der, parts[1])
    if not info or #info < 3 or info[1].tag ~= INTEGER or info[2].tag ~= SEQUENCE then
        return nil, "not a DER certificate request"
    end
    local key = publicKeyInfo(der, info[3])
    if not key then
        return nil, "the request's public key could not be read"
    end
    key.subject_cn = commonName(der, info[2])
    return key
end

return X509
