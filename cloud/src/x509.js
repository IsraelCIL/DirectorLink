// The little of X.509 the Worker reads for Direct HTTPS (1.12.0, ADR-082), in plain JavaScript: PEM
// blocks, a certificate request's names and public key (what it may ask for), and a certificate's
// names, public key, issuer and validity (what Let's Encrypt gave). No signature is checked here:
// Let's Encrypt checks the request's, browsers the certificate's.

const OID = {
  ecPublicKey: "2a8648ce3d0201", // 1.2.840.10045.2.1
  prime256v1: "2a8648ce3d030107", // 1.2.840.10045.3.1.7 (P-256)
  rsaEncryption: "2a864886f70d010101", // 1.2.840.113549.1.1.1
  commonName: "550403", // 2.5.4.3
  subjectAltName: "551d11", // 2.5.29.17
  extensionRequest: "2a864886f70d01090e", // 1.2.840.113549.1.9.14
};

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OBJECT_ID = 0x06;
const BOOLEAN = 0x01;
const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;
const STRING_TAGS = new Set([0x0c, 0x13, 0x16, 0x14]); // UTF8, Printable, IA5, T61
const DNS_NAME = 0x82; // [2] IA5String in GeneralNames

export function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The PEM blocks labelled `label` ("CERTIFICATE", "CERTIFICATE REQUEST"), each as DER bytes; null
// when one of them is not base64.
export function pemBlocks(text, label) {
  if (typeof text !== "string") return null;
  const pattern = new RegExp(`-----BEGIN ${label}-----([^-]*)-----END ${label}-----`, "g");
  const blocks = [];
  for (const match of text.matchAll(pattern)) {
    try {
      const binary = atob(match[1].replace(/\s+/g, ""));
      if (!binary) return null;
      blocks.push(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    } catch {
      return null;
    }
  }
  return blocks;
}

// DER bytes as PEM, 64 characters a line.
export function pem(der, label) {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/.{64}/g, "$&\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// One element at `at`: { tag, start, end, from } (contents from start to end, exclusive), or null.
function element(data, at, limit = data.length) {
  if (at + 2 > limit) return null;
  const tag = data[at];
  const first = data[at + 1];
  if ((tag & 0x1f) === 0x1f || first === 0x80) return null;
  let length = first;
  let header = 2;
  if (first > 0x80) {
    const count = first - 0x80;
    if (count > 4 || at + 2 + count > limit) return null;
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + data[at + 2 + index];
    header = 2 + count;
  }
  const start = at + header;
  const end = start + length;
  return end > limit ? null : { tag, start, end, from: at };
}

// The elements inside `parent`, in order; null when they do not fill it.
function children(data, parent) {
  const list = [];
  let at = parent.start;
  while (at < parent.end) {
    const child = element(data, at, parent.end);
    if (!child) return null;
    list.push(child);
    at = child.end;
  }
  return list;
}

const contents = (data, node) => data.subarray(node.start, node.end);
const whole = (data, node) => data.subarray(node.from, node.end);
const text = (data, node) => new TextDecoder().decode(contents(data, node));

// Every common name of a Name.
function commonNames(data, name) {
  const names = [];
  for (const set of children(data, name) ?? []) {
    if (set.tag !== SET) continue;
    for (const attribute of children(data, set) ?? []) {
      const parts = attribute.tag === SEQUENCE ? children(data, attribute) : null;
      if (parts?.length === 2 && parts[0].tag === OBJECT_ID && hex(contents(data, parts[0])) === OID.commonName && STRING_TAGS.has(parts[1].tag)) {
        names.push(text(data, parts[1]));
      }
    }
  }
  return names;
}

// SubjectPublicKeyInfo: { spki (its DER), type: "ec" | "rsa" | <oid hex>, curve, bits }, or null.
function publicKeyInfo(data, node) {
  const parts = node.tag === SEQUENCE ? children(data, node) : null;
  if (!parts || parts.length !== 2 || parts[0].tag !== SEQUENCE || parts[1].tag !== BIT_STRING) return null;
  const algorithm = children(data, parts[0]);
  if (!algorithm?.length || algorithm[0].tag !== OBJECT_ID) return null;
  const info = { spki: whole(data, node), type: hex(contents(data, algorithm[0])), curve: null, bits: null };
  if (info.type === OID.ecPublicKey) {
    info.type = "ec";
    const parameters = algorithm[1];
    info.curve = parameters?.tag === OBJECT_ID ? (hex(contents(data, parameters)) === OID.prime256v1 ? "P-256" : hex(contents(data, parameters))) : "explicit";
    const key = contents(data, parts[1]);
    info.bits = key.length === 66 && key[0] === 0 && key[1] === 4 ? 256 : null;
  } else if (info.type === OID.rsaEncryption) {
    info.type = "rsa";
    const key = contents(data, parts[1]);
    const inner = key[0] === 0 ? element(key, 1) : null;
    const numbers = inner?.tag === SEQUENCE ? children(key, inner) : null;
    if (numbers?.[0]?.tag === INTEGER) {
      let modulus = contents(key, numbers[0]);
      while (modulus.length > 1 && modulus[0] === 0) modulus = modulus.subarray(1);
      info.bits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]));
    }
  }
  return info;
}

// The names of a GeneralNames sequence: { dns: [...], other: count of names that are not DNS names }.
function generalNames(data, node) {
  const result = { dns: [], other: 0 };
  for (const name of (node?.tag === SEQUENCE ? children(data, node) : null) ?? []) {
    if (name.tag === DNS_NAME) result.dns.push(text(data, name).toLowerCase());
    else result.other += 1;
  }
  return result;
}

// The subjectAltName of a list of extensions (a SEQUENCE of Extension), or null when there is none.
function subjectAltName(data, extensions) {
  for (const extension of (extensions?.tag === SEQUENCE ? children(data, extensions) : null) ?? []) {
    const parts = extension.tag === SEQUENCE ? children(data, extension) : null;
    if (!parts?.length || parts[0].tag !== OBJECT_ID || hex(contents(data, parts[0])) !== OID.subjectAltName) continue;
    const value = parts[parts.length - 1];
    if (value.tag !== OCTET_STRING || !(parts.length === 2 || (parts.length === 3 && parts[1].tag === BOOLEAN))) return { dns: [], other: 1 };
    return generalNames(data, element(data, value.start, value.end));
  }
  return null;
}

function time(data, node) {
  const value = text(data, node);
  let match;
  if (node.tag === UTC_TIME && (match = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(value))) {
    const year = Number(match[1]) < 50 ? 2000 + Number(match[1]) : 1900 + Number(match[1]);
    return Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  }
  if (node.tag === GENERALIZED_TIME && (match = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(value))) {
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  }
  return null;
}

// A certificate request (DER): { names (its CNs and DNS names, lower case, each once), otherNames
// (how many names of another kind it asks for), key: publicKeyInfo }, or null.
export function readRequest(der) {
  const top = element(der, 0);
  const parts = top?.tag === SEQUENCE && top.end === der.length ? children(der, top) : null;
  const info = parts?.length === 3 && parts[0].tag === SEQUENCE ? children(der, parts[0]) : null;
  if (!info || info.length < 3 || info[0].tag !== INTEGER || info[1].tag !== SEQUENCE) return null;
  const key = publicKeyInfo(der, info[2]);
  if (!key) return null;
  const names = new Set(commonNames(der, info[1]).map((name) => name.toLowerCase()));
  let otherNames = 0;
  // [0] attributes: an extensionRequest may carry a subjectAltName.
  const attributes = info[3]?.tag === 0xa0 ? children(der, info[3]) ?? [] : [];
  for (const attribute of attributes) {
    const pieces = attribute.tag === SEQUENCE ? children(der, attribute) : null;
    if (!pieces || pieces[0]?.tag !== OBJECT_ID || hex(contents(der, pieces[0])) !== OID.extensionRequest || pieces[1]?.tag !== SET) continue;
    for (const extensions of children(der, pieces[1]) ?? []) {
      const alt = subjectAltName(der, extensions);
      if (alt) {
        alt.dns.forEach((name) => names.add(name));
        otherNames += alt.other;
      }
    }
  }
  return { names: [...names], otherNames, key };
}

// A certificate (DER): { names (DNS names of its subjectAltName), issuerCn, notBefore, notAfter (ms),
// key: publicKeyInfo }, or null.
export function readCertificate(der) {
  const top = element(der, 0);
  const parts = top?.tag === SEQUENCE && top.end === der.length ? children(der, top) : null;
  const fields = parts?.length === 3 && parts[0].tag === SEQUENCE ? children(der, parts[0]) : null;
  if (!fields) return null;
  const first = fields[0]?.tag === 0xa0 ? 1 : 0;
  const [serial, , issuer, validity, subject, spki] = fields.slice(first);
  if (serial?.tag !== INTEGER || issuer?.tag !== SEQUENCE || validity?.tag !== SEQUENCE || subject?.tag !== SEQUENCE || !spki) return null;
  const key = publicKeyInfo(der, spki);
  const times = children(der, validity);
  const notBefore = times?.length === 2 ? time(der, times[0]) : null;
  const notAfter = times?.length === 2 ? time(der, times[1]) : null;
  if (!key || notBefore === null || notAfter === null) return null;
  let names = [];
  for (const field of fields.slice(first + 6)) {
    if (field.tag === 0xa3) {
      const list = children(der, field);
      names = (list?.[0] && subjectAltName(der, list[0])?.dns) ?? [];
    }
  }
  return { names, issuerCn: commonNames(der, issuer)[0] ?? null, notBefore, notAfter, key };
}
