import { promises as dnsPromises } from "node:dns";
import { ConnectorError } from "./errors";

const DEFAULT_DNS_TIMEOUT_MS = 2_500;
const MIN_DNS_TIMEOUT_MS = 25;
const MAX_DNS_TIMEOUT_MS = 10_000;
const SAFE_CLASS = /^[a-z0-9_.:-]+$/i;
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|[0-9a-f]*:[0-9a-f:.]+)$/i;

export type ConnectorDnsFamilyStatus = "success" | "no_data" | "timeout" | "unsupported" | "resolver_error" | "malformed";

export type ConnectorDnsFamilyResult = {
  status: ConnectorDnsFamilyStatus;
  addressCount: number;
  errorCode: string | null;
  errorClass: string | null;
};

export type SanitizedConnectorDnsReceipt = {
  normalizedHostname: string;
  resolverImplementationClass: string;
  methodsAttempted: string[];
  ipv4: ConnectorDnsFamilyResult;
  ipv6: ConnectorDnsFamilyResult;
  addressCount: number;
  ipv4AddressCount: number;
  ipv6AddressCount: number;
  publicAddressValidationResult: "not_run" | "passed" | "failed";
  revalidationResult: "not_run" | "passed" | "failed";
  localErrorCode: string | null;
  localErrorClass: string | null;
  correlationId: string;
};

export type ConnectorDnsResolver = {
  implementationClass?: string;
  resolve4: (hostname: string) => Promise<unknown>;
  resolve6: (hostname: string) => Promise<unknown>;
};

export type ConnectorDnsValidationOptions = {
  resolver?: ConnectorDnsResolver | null;
  legacyResolveHost?: ((hostname: string) => Promise<string[]>) | null;
  timeoutMs?: number;
  correlationId?: string;
};

export type ConnectorDnsValidationResult = {
  addresses: string[];
  receipt: SanitizedConnectorDnsReceipt;
};

type AddressFamily = 4 | 6;
type FamilyResolution = ConnectorDnsFamilyResult & { addresses: string[] };
type ResolutionPass = {
  ipv4: FamilyResolution;
  ipv6: FamilyResolution;
  addresses: string[];
};

class DnsTimeoutError extends Error {
  constructor() {
    super("DNS resolution timed out.");
    this.name = "DnsTimeoutError";
  }
}

function boundaryError(
  code: string,
  message: string,
  receipt: SanitizedConnectorDnsReceipt,
  retryable = false,
): ConnectorError {
  return new ConnectorError(code, message, {
    retryable,
    details: { mutationBegan: false, dnsReceipt: receipt },
  });
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_DNS_TIMEOUT_MS;
  return Math.min(MAX_DNS_TIMEOUT_MS, Math.max(MIN_DNS_TIMEOUT_MS, Math.trunc(Number(value))));
}

function safeClass(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim().slice(0, 120);
  return normalized && SAFE_CLASS.test(normalized) ? normalized : fallback;
}

function correlationId(value?: string): string {
  const supplied = String(value ?? "").trim();
  if (supplied && /^[a-z0-9-]{1,100}$/i.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function normalizeHostname(hostname: string): string {
  const lower = String(hostname ?? "").trim().toLocaleLowerCase("en");
  const normalized = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  if (!normalized || normalized.length > 253 || IP_LITERAL.test(normalized)) {
    throw new ConnectorError("connector_file_dns_validation_failed", "The connector file hostname is invalid for DNS validation.", {
      retryable: false,
      details: { mutationBegan: false },
    });
  }
  const labels = normalized.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new ConnectorError("connector_file_dns_validation_failed", "The connector file hostname is invalid for DNS validation.", {
      retryable: false,
      details: { mutationBegan: false },
    });
  }
  return normalized;
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const values = parts.map(Number);
  if (values.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((values[0] * 256 + values[1]) * 256 + values[2]) * 256 + values[3]) >>> 0;
}

function ipv4In(address: string, base: string, prefix: number): boolean {
  const value = ipv4Number(address);
  const start = ipv4Number(base);
  if (value === null || start === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (start & mask);
}

function expandIpv6(address: string): number[] | null {
  let raw = address.toLocaleLowerCase("en").split("%", 1)[0];
  if (raw.includes(".")) {
    const lastColon = raw.lastIndexOf(":");
    const v4 = ipv4Number(raw.slice(lastColon + 1));
    if (v4 === null) return null;
    raw = `${raw.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => {
    if (!/^[0-9a-f]{1,4}$/i.test(word || "0")) return Number.NaN;
    return Number.parseInt(word || "0", 16);
  });
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return words;
}

export function isPublicRoutableAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
      ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
      ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, prefix]) => ipv4In(address, base, prefix));
  }
  const words = expandIpv6(address);
  if (!words) return false;
  const first = words[0];
  if (words.every((word) => word === 0) || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (first === 0x2001 && words[1] === 0x0db8) return false;
  if (first === 0x2001 && words[1] === 0x0000) return false;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const mapped = `${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`;
    return isPublicRoutableAddress(mapped);
  }
  return (first & 0xe000) === 0x2000;
}

function emptyFamily(status: ConnectorDnsFamilyStatus, errorCode: string | null = null, errorClass: string | null = null): FamilyResolution {
  return { status, addressCount: 0, errorCode, errorClass, addresses: [] };
}

function timeoutPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DnsTimeoutError()), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? safeClass(value, "resolver_error") : null;
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return safeClass(error.name, "Error");
  return safeClass(typeof error, "unknown");
}

function unsupportedError(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "ERR_NOT_IMPLEMENTED" || /(?:not implemented|unenv)/i.test(message);
}

function noDataError(error: unknown): boolean {
  return errorCode(error) === "ENODATA";
}

function parseFamilyResponse(value: unknown, family: AddressFamily): FamilyResolution {
  if (!Array.isArray(value)) return emptyFamily("malformed", "MALFORMED_RESPONSE", "resolver_response");
  if (!value.length) return emptyFamily("no_data");
  const addresses: string[] = [];
  for (const entry of value) {
    const address = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && typeof (entry as { address?: unknown }).address === "string"
        ? String((entry as { address: string }).address)
        : null;
    if (!address || (family === 4 ? ipv4Number(address) === null : expandIpv6(address) === null)) {
      return emptyFamily("malformed", "MALFORMED_RESPONSE", "resolver_response");
    }
    addresses.push(address.toLocaleLowerCase("en"));
  }
  const unique = [...new Set(addresses)].sort();
  return { status: "success", addressCount: unique.length, errorCode: null, errorClass: null, addresses: unique };
}

async function resolveFamily(
  method: unknown,
  hostname: string,
  family: AddressFamily,
  timeoutMs: number,
): Promise<FamilyResolution> {
  if (typeof method !== "function") return emptyFamily("unsupported", "ERR_NOT_IMPLEMENTED", "resolver_method");
  try {
    const value = await timeoutPromise(Promise.resolve((method as (name: string) => Promise<unknown>)(hostname)), timeoutMs);
    return parseFamilyResponse(value, family);
  } catch (error) {
    if (error instanceof DnsTimeoutError) return emptyFamily("timeout", "DNS_TIMEOUT", error.name);
    if (unsupportedError(error)) return emptyFamily("unsupported", errorCode(error) ?? "ERR_NOT_IMPLEMENTED", errorClass(error));
    if (noDataError(error)) return emptyFamily("no_data", "ENODATA", errorClass(error));
    return emptyFamily("resolver_error", errorCode(error) ?? "RESOLVER_ERROR", errorClass(error));
  }
}

function defaultResolver(): ConnectorDnsResolver {
  return {
    implementationClass: "node:dns.promises",
    resolve4: async (hostname: string) => dnsPromises.resolve4(hostname),
    resolve6: async (hostname: string) => dnsPromises.resolve6(hostname),
  };
}

function resolverClass(resolver: ConnectorDnsResolver): string {
  return safeClass(resolver.implementationClass, "explicit_resolver");
}

async function resolvePass(resolver: ConnectorDnsResolver, hostname: string, timeoutMs: number): Promise<ResolutionPass> {
  const [ipv4, ipv6] = await Promise.all([
    resolveFamily(resolver.resolve4, hostname, 4, timeoutMs),
    resolveFamily(resolver.resolve6, hostname, 6, timeoutMs),
  ]);
  return { ipv4, ipv6, addresses: [...new Set([...ipv4.addresses, ...ipv6.addresses])].sort() };
}

async function resolveLegacyPass(resolveHost: (hostname: string) => Promise<string[]>, hostname: string, timeoutMs: number): Promise<ResolutionPass> {
  try {
    const value = await timeoutPromise(Promise.resolve(resolveHost(hostname)), timeoutMs);
    if (!Array.isArray(value)) {
      const malformed = emptyFamily("malformed", "MALFORMED_RESPONSE", "resolver_response");
      return { ipv4: malformed, ipv6: { ...malformed, addresses: [] }, addresses: [] };
    }
    const ipv4: string[] = [];
    const ipv6: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        const malformed = emptyFamily("malformed", "MALFORMED_RESPONSE", "resolver_response");
        return { ipv4: malformed, ipv6: { ...malformed, addresses: [] }, addresses: [] };
      }
      if (ipv4Number(entry) !== null) ipv4.push(entry);
      else if (expandIpv6(entry) !== null) ipv6.push(entry.toLocaleLowerCase("en"));
      else {
        const malformed = emptyFamily("malformed", "MALFORMED_RESPONSE", "resolver_response");
        return { ipv4: malformed, ipv6: { ...malformed, addresses: [] }, addresses: [] };
      }
    }
    const v4 = [...new Set(ipv4)].sort();
    const v6 = [...new Set(ipv6)].sort();
    return {
      ipv4: v4.length ? { status: "success", addressCount: v4.length, errorCode: null, errorClass: null, addresses: v4 } : emptyFamily("no_data"),
      ipv6: v6.length ? { status: "success", addressCount: v6.length, errorCode: null, errorClass: null, addresses: v6 } : emptyFamily("no_data"),
      addresses: [...v4, ...v6].sort(),
    };
  } catch (error) {
    const status: ConnectorDnsFamilyStatus = error instanceof DnsTimeoutError ? "timeout" : unsupportedError(error) ? "unsupported" : noDataError(error) ? "no_data" : "resolver_error";
    const result = emptyFamily(status, error instanceof DnsTimeoutError ? "DNS_TIMEOUT" : errorCode(error) ?? "RESOLVER_ERROR", errorClass(error));
    return { ipv4: result, ipv6: { ...result, addresses: [] }, addresses: [] };
  }
}

function receiptFor(
  hostname: string,
  implementationClass: string,
  methodsAttempted: string[],
  pass: ResolutionPass,
  id: string,
): SanitizedConnectorDnsReceipt {
  return {
    normalizedHostname: hostname,
    resolverImplementationClass: implementationClass,
    methodsAttempted,
    ipv4: { status: pass.ipv4.status, addressCount: pass.ipv4.addressCount, errorCode: pass.ipv4.errorCode, errorClass: pass.ipv4.errorClass },
    ipv6: { status: pass.ipv6.status, addressCount: pass.ipv6.addressCount, errorCode: pass.ipv6.errorCode, errorClass: pass.ipv6.errorClass },
    addressCount: pass.addresses.length,
    ipv4AddressCount: pass.ipv4.addresses.length,
    ipv6AddressCount: pass.ipv6.addresses.length,
    publicAddressValidationResult: "not_run",
    revalidationResult: "not_run",
    localErrorCode: null,
    localErrorClass: null,
    correlationId: id,
  };
}

function failedReceipt(receipt: SanitizedConnectorDnsReceipt, code: string, errorClassValue: string): SanitizedConnectorDnsReceipt {
  return { ...receipt, localErrorCode: code, localErrorClass: safeClass(errorClassValue, "dns_validation") };
}

function classifyPass(pass: ResolutionPass): { code: string; errorClass: string; retryable: boolean } | null {
  if (pass.ipv4.status === "unsupported" || pass.ipv6.status === "unsupported") {
    return { code: "connector_file_dns_api_unsupported", errorClass: "unsupported_api", retryable: false };
  }
  if (pass.ipv4.status === "malformed" || pass.ipv6.status === "malformed") {
    return { code: "connector_file_dns_response_malformed", errorClass: "malformed_response", retryable: false };
  }
  const successes = [pass.ipv4, pass.ipv6].filter((entry) => entry.status === "success");
  if (successes.length) {
    if (pass.ipv4.status === "resolver_error") return { code: "connector_file_dns_ipv4_failed", errorClass: pass.ipv4.errorCode ?? "ipv4_resolver_error", retryable: true };
    if (pass.ipv6.status === "resolver_error") return { code: "connector_file_dns_ipv6_failed", errorClass: pass.ipv6.errorCode ?? "ipv6_resolver_error", retryable: true };
    return null;
  }
  if (pass.ipv4.status === "timeout" || pass.ipv6.status === "timeout") {
    return { code: "connector_file_dns_timeout", errorClass: "timeout", retryable: true };
  }
  if (pass.ipv4.status === "no_data" && pass.ipv6.status === "no_data") {
    return { code: "connector_file_dns_no_records", errorClass: "no_records", retryable: true };
  }
  if (pass.ipv4.status === "resolver_error" && pass.ipv6.status === "no_data") {
    return { code: "connector_file_dns_ipv4_failed", errorClass: pass.ipv4.errorCode ?? "ipv4_resolver_error", retryable: true };
  }
  if (pass.ipv6.status === "resolver_error" && pass.ipv4.status === "no_data") {
    return { code: "connector_file_dns_ipv6_failed", errorClass: pass.ipv6.errorCode ?? "ipv6_resolver_error", retryable: true };
  }
  return { code: "connector_file_dns_validation_failed", errorClass: "resolver_error", retryable: true };
}

function sameAddressSet(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function messageFor(code: string): string {
  switch (code) {
    case "connector_file_dns_api_unsupported": return "The Workers DNS resolver API is unavailable.";
    case "connector_file_dns_timeout": return "The connector file DNS lookup timed out.";
    case "connector_file_dns_no_records": return "The connector file host returned no A or AAAA records.";
    case "connector_file_dns_ipv4_failed": return "The connector file IPv4 lookup failed.";
    case "connector_file_dns_ipv6_failed": return "The connector file IPv6 lookup failed.";
    case "connector_file_dns_response_malformed": return "The connector file DNS response was malformed.";
    case "connector_file_dns_private_address": return "The connector file host resolved to a non-public or reserved address.";
    case "connector_file_dns_rebinding_detected": return "The connector file host changed resolution before connection.";
    default: return "The connector file host could not be resolved safely.";
  }
}

export async function validateConnectorFileDns(
  hostnameInput: string,
  options: ConnectorDnsValidationOptions = {},
): Promise<ConnectorDnsValidationResult> {
  const hostname = normalizeHostname(hostnameInput);
  const id = correlationId(options.correlationId);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const hasExplicitResolver = Object.prototype.hasOwnProperty.call(options, "resolver");
  const hasLegacyResolver = Object.prototype.hasOwnProperty.call(options, "legacyResolveHost");

  let implementationClass: string;
  let methodsAttempted: string[];
  let resolve: () => Promise<ResolutionPass>;

  if (hasExplicitResolver) {
    const resolver = options.resolver;
    if (!resolver || typeof resolver.resolve4 !== "function" || typeof resolver.resolve6 !== "function") {
      const unsupported = { ipv4: emptyFamily("unsupported", "ERR_NOT_IMPLEMENTED", "resolver_method"), ipv6: emptyFamily("unsupported", "ERR_NOT_IMPLEMENTED", "resolver_method"), addresses: [] };
      const receipt = failedReceipt(receiptFor(hostname, "invalid_explicit_resolver", ["resolve4", "resolve6"], unsupported, id), "connector_file_dns_api_unsupported", "unsupported_api");
      throw boundaryError("connector_file_dns_api_unsupported", messageFor("connector_file_dns_api_unsupported"), receipt, false);
    }
    implementationClass = resolverClass(resolver);
    methodsAttempted = ["resolve4", "resolve6"];
    resolve = () => resolvePass(resolver, hostname, timeoutMs);
  } else if (hasLegacyResolver) {
    const resolver = options.legacyResolveHost;
    if (typeof resolver !== "function") {
      const unsupported = { ipv4: emptyFamily("unsupported", "ERR_NOT_IMPLEMENTED", "resolver_method"), ipv6: emptyFamily("unsupported", "ERR_NOT_IMPLEMENTED", "resolver_method"), addresses: [] };
      const receipt = failedReceipt(receiptFor(hostname, "invalid_legacy_resolver", ["resolveHost"], unsupported, id), "connector_file_dns_api_unsupported", "unsupported_api");
      throw boundaryError("connector_file_dns_api_unsupported", messageFor("connector_file_dns_api_unsupported"), receipt, false);
    }
    implementationClass = "explicit_combined_resolver";
    methodsAttempted = ["resolveHost"];
    resolve = () => resolveLegacyPass(resolver, hostname, timeoutMs);
  } else {
    const resolver = defaultResolver();
    implementationClass = resolverClass(resolver);
    methodsAttempted = ["resolve4", "resolve6"];
    resolve = () => resolvePass(resolver, hostname, timeoutMs);
  }

  const first = await resolve();
  let receipt = receiptFor(hostname, implementationClass, methodsAttempted, first, id);
  const firstFailure = classifyPass(first);
  if (firstFailure) {
    receipt = failedReceipt(receipt, firstFailure.code, firstFailure.errorClass);
    throw boundaryError(firstFailure.code, messageFor(firstFailure.code), receipt, firstFailure.retryable);
  }
  if (!first.addresses.length) {
    receipt = failedReceipt(receipt, "connector_file_dns_no_records", "no_records");
    throw boundaryError("connector_file_dns_no_records", messageFor("connector_file_dns_no_records"), receipt, true);
  }
  if (first.addresses.some((address) => !isPublicRoutableAddress(address))) {
    receipt = failedReceipt({ ...receipt, publicAddressValidationResult: "failed" }, "connector_file_dns_private_address", "private_address");
    throw boundaryError("connector_file_dns_private_address", messageFor("connector_file_dns_private_address"), receipt, false);
  }
  receipt = { ...receipt, publicAddressValidationResult: "passed" };

  const second = await resolve();
  const secondFailure = classifyPass(second);
  if (secondFailure) {
    receipt = failedReceipt({ ...receipt, revalidationResult: "failed" }, secondFailure.code, secondFailure.errorClass);
    throw boundaryError(secondFailure.code, messageFor(secondFailure.code), receipt, secondFailure.retryable);
  }
  if (!second.addresses.length) {
    receipt = failedReceipt({ ...receipt, revalidationResult: "failed" }, "connector_file_dns_no_records", "no_records");
    throw boundaryError("connector_file_dns_no_records", messageFor("connector_file_dns_no_records"), receipt, true);
  }
  if (second.addresses.some((address) => !isPublicRoutableAddress(address))) {
    receipt = failedReceipt({ ...receipt, revalidationResult: "failed", publicAddressValidationResult: "failed" }, "connector_file_dns_private_address", "private_address");
    throw boundaryError("connector_file_dns_private_address", messageFor("connector_file_dns_private_address"), receipt, false);
  }
  if (!sameAddressSet(first.addresses, second.addresses)) {
    receipt = failedReceipt({ ...receipt, revalidationResult: "failed" }, "connector_file_dns_rebinding_detected", "address_set_mismatch");
    throw boundaryError("connector_file_dns_rebinding_detected", messageFor("connector_file_dns_rebinding_detected"), receipt, false);
  }

  receipt = { ...receipt, revalidationResult: "passed" };
  return { addresses: second.addresses, receipt };
}
