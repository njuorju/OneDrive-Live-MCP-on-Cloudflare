export type ConnectorDnsAddressFamily = 4 | 6;

export type NormalizedConnectorDnsAnswer =
  | { status: "success"; addresses: string[] }
  | { status: "no_data"; addresses: [] }
  | { status: "malformed"; addresses: [] };

type DnsAddressRecord = { address: string; ttl: number };

const MAX_DNS_TTL = 0xffff_ffff;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function malformed(): NormalizedConnectorDnsAnswer {
  return { status: "malformed", addresses: [] };
}

function noData(): NormalizedConnectorDnsAnswer {
  return { status: "no_data", addresses: [] };
}

function canonicalIpv4(value: string): string | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const octets = value.split(".").map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets.join(".");
}

function expandIpv6(value: string): number[] | null {
  if (!value || value !== value.trim() || value.includes("%") || value.startsWith("[") || value.endsWith("]")) return null;
  let raw = value.toLocaleLowerCase("en");
  if (raw.includes(".")) {
    const lastColon = raw.lastIndexOf(":");
    if (lastColon < 0) return null;
    const embedded = canonicalIpv4(raw.slice(lastColon + 1));
    if (!embedded) return null;
    const octets = embedded.split(".").map(Number);
    raw = `${raw.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;

  const compressed = halves.length === 2;
  const missing = 8 - left.length - right.length;
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return null;

  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

function canonicalIpv6(value: string): string | null {
  const words = expandIpv6(value);
  if (!words) return null;

  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    const length = end - index;
    if (length >= 2 && length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }

  const hex = words.map((word) => word.toString(16));
  if (bestStart < 0) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

function canonicalAddress(value: string, family: ConnectorDnsAddressFamily): string | null {
  if (value !== value.trim()) return null;
  return family === 4 ? canonicalIpv4(value) : canonicalIpv6(value);
}

function canonicalAbsoluteAlias(value: string): string | null {
  if (value !== value.trim() || !value.endsWith(".") || value.endsWith("..") || value.length > 254) return null;
  const hostname = value.slice(0, -1).toLocaleLowerCase("en");
  if (!hostname || hostname.length > 253 || canonicalIpv4(hostname) || canonicalIpv6(hostname)) return null;
  const labels = hostname.split(".");
  if (labels.some((label) => !label || label.length > 63 || !DNS_LABEL.test(label))) return null;
  return hostname;
}

function isExactAddressRecord(value: unknown): value is DnsAddressRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "address" || keys[1] !== "ttl") return false;
  const record = value as { address?: unknown; ttl?: unknown };
  return typeof record.address === "string"
    && typeof record.ttl === "number"
    && Number.isInteger(record.ttl)
    && record.ttl >= 0
    && record.ttl <= MAX_DNS_TTL;
}

/**
 * Normalize only the two proven node:dns promise result forms:
 * bare string arrays (the no-options production call) and exact address/TTL records.
 * Current workerd may prefix either form with absolute CNAME targets from the underlying
 * DNS answer. Those aliases are recognized only as a contiguous prefix and are never
 * returned or safety-validated as addresses.
 */
export function normalizeConnectorDnsAnswer(
  value: unknown,
  family: ConnectorDnsAddressFamily,
): NormalizedConnectorDnsAnswer {
  if (!Array.isArray(value)) return malformed();
  if (value.length === 0) return noData();

  const mode = typeof value[0] === "string" ? "strings" : isExactAddressRecord(value[0]) ? "records" : null;
  if (!mode) return malformed();

  const addresses: string[] = [];
  let addressSeen = false;
  for (const entry of value) {
    let candidate: string;
    if (mode === "strings") {
      if (typeof entry !== "string") return malformed();
      candidate = entry;
    } else {
      if (!isExactAddressRecord(entry)) return malformed();
      candidate = entry.address;
    }

    const address = canonicalAddress(candidate, family);
    if (address) {
      addressSeen = true;
      addresses.push(address);
      continue;
    }

    if (addressSeen || !canonicalAbsoluteAlias(candidate)) return malformed();
  }

  if (addresses.length === 0) return noData();
  return { status: "success", addresses: [...new Set(addresses)].sort() };
}
