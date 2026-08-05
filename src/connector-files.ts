import { z } from "zod";
import { ConnectorError } from "./errors";
import { isAllowedTextFile, validateFileSignature } from "./file-types";
import { validateItemName } from "./graph-core";

export const CHATGPT_ATTACHMENT_HOST = "oaisdmntprindiasocentral.blob.core.windows.net" as const;
export const CHATGPT_ATTACHMENT_HOST_PATTERN = /^oaisdmntpr[a-z0-9]+\.blob\.core\.windows\.net$/;
export const CHATGPT_ATTACHMENT_ETLD_PLUS_ONE = "blob.core.windows.net" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|[0-9a-f]*:[0-9a-f:.]+)$/i;

export const connectorFileInputSchema = z.object({
  download_url: z.string().min(1).max(20_000),
  file_id: z.string().min(1).max(5_000),
  mime_type: z.string().min(1).max(500).optional(),
  file_name: z.string().min(1).max(255).optional(),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().describe("ChatGPT-authorized connector file reference.");

export type ConnectorFileReference = z.infer<typeof connectorFileInputSchema>;
export type SanitizedConnectorFileShape = {
  type: string;
  array: boolean;
  keys: string[];
  required: { downloadUrl: boolean; fileId: boolean };
  filename: string | null;
  mimeType: string | null;
  declaredByteSize: number | null;
};
export type SanitizedConnectorNetworkReceipt = {
  scheme: "https";
  hostname: string;
  effectivePort: 443;
  eTldPlusOne: typeof CHATGPT_ATTACHMENT_ETLD_PLUS_ONE;
  redirectCount: 0 | 1;
  dnsAddressCount: number;
  dnsRevalidated: boolean;
  connectionPinned: false;
};
export type LoadedConnectorTextFile = {
  bytes: Uint8Array;
  text: string;
  byteLength: number;
  sha256: string;
  fileName: string;
  declaredMimeType: string | null;
  sourceMimeType: string | null;
  runtimeShape: SanitizedConnectorFileShape;
  networkReceipt: SanitizedConnectorNetworkReceipt | null;
};
export type ConnectorFileNetworkOptions = {
  enforceAuthorizedFileParam?: boolean;
  authorizedTopLevelFileParam?: string;
  declaredFileParams?: readonly string[];
  resolveHost?: (hostname: string) => Promise<string[]>;
  allowSingleSameHostRedirect?: boolean;
};

type FetchLike = typeof fetch;

function boundaryError(
  code: string,
  message: string,
  options: { retryable?: boolean; status?: number; details?: Record<string, unknown> } = {},
): ConnectorError {
  return new ConnectorError(code, message, {
    retryable: options.retryable ?? false,
    ...(options.status === undefined ? {} : { status: options.status }),
    details: { mutationBegan: false, ...(options.details ?? {}) },
  });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function connectorFileRuntimeShape(value: unknown): SanitizedConnectorFileShape {
  const record = objectRecord(value);
  const filename = record && typeof record.file_name === "string" ? record.file_name : null;
  const mimeType = record && typeof record.mime_type === "string" ? record.mime_type : null;
  const declared = record && Number.isSafeInteger(record.size) && Number(record.size) >= 0 ? Number(record.size) : null;
  return {
    type: value === null ? "null" : typeof value,
    array: Array.isArray(value),
    keys: record ? Object.keys(record).sort() : [],
    required: {
      downloadUrl: Boolean(record && typeof record.download_url === "string" && record.download_url.length > 0),
      fileId: Boolean(record && typeof record.file_id === "string" && record.file_id.length > 0),
    },
    filename,
    mimeType,
    declaredByteSize: declared,
  };
}

export function normalizeConnectorFileReference(value: unknown): ConnectorFileReference {
  const shape = connectorFileRuntimeShape(value);
  const record = objectRecord(value);
  if (!record) {
    throw boundaryError("connector_file_reference_malformed", "The connector file reference must be a platform-issued object.", { details: { runtimeShape: shape } });
  }
  if (typeof record.file_id !== "string" || !record.file_id.trim()) {
    throw boundaryError("connector_file_metadata_missing", "The connector file reference is missing file_id metadata.", { details: { runtimeShape: shape } });
  }
  if (typeof record.download_url !== "string" || !record.download_url.trim()) {
    throw boundaryError("connector_file_download_url_missing", "The connector file reference is missing download_url.", { details: { runtimeShape: shape } });
  }
  const parsed = connectorFileInputSchema.safeParse(record);
  if (!parsed.success) {
    throw boundaryError("connector_file_reference_malformed", "The connector file reference does not match the supported platform file shape.", { details: { runtimeShape: shape } });
  }
  return parsed.data;
}

function normalizedHostname(url: URL): string {
  const lower = url.hostname.toLocaleLowerCase("en");
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

export function isTrustedChatGptAttachmentHostname(hostname: string): boolean {
  const lower = hostname.toLocaleLowerCase("en");
  const normalized = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  if (!normalized || normalized.endsWith(".") || normalized.split(".").some((label) => label.startsWith("xn--"))) return false;
  return CHATGPT_ATTACHMENT_HOST_PATTERN.test(normalized);
}

export function trustedConnectorFileUrl(reference: string): URL {
  let url: URL;
  try { url = new URL(reference); }
  catch { throw boundaryError("connector_file_reference_malformed", "The connector file download URL is malformed."); }
  const host = normalizedHostname(url);
  const effectivePort = url.port ? Number(url.port) : 443;
  if (url.protocol !== "https:" || effectivePort !== 443 || url.username || url.password || !host || IP_LITERAL.test(host)) {
    throw boundaryError("connector_file_download_forbidden", "The connector file download URL is not permitted.");
  }
  if (!isTrustedChatGptAttachmentHostname(host)) {
    throw boundaryError("connector_file_download_forbidden", "The connector file download host is not permitted.", {
      details: { scheme: url.protocol.replace(":", ""), normalizedHostname: host, effectivePort },
    });
  }
  url.hostname = host;
  url.port = "";
  return url;
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
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word || "0", 16));
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
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // unique local
  if ((first & 0xffc0) === 0xfe80) return false; // link local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && words[1] === 0x0db8) return false; // documentation
  if (first === 0x2001 && words[1] === 0x0000) return false; // Teredo/reserved
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const mapped = `${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`;
    return isPublicRoutableAddress(mapped);
  }
  return (first & 0xe000) === 0x2000; // public global unicast only
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const addresses = new Set<string>();
  for (const type of ["A", "AAAA"] as const) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { Accept: "application/dns-json" }, redirect: "error",
    });
    if (!response.ok) throw boundaryError("connector_file_dns_validation_failed", "The connector file host could not be resolved safely.", { retryable: response.status >= 500 });
    const body = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
    for (const answer of body.Answer ?? []) {
      if ((answer.type === 1 || answer.type === 28) && typeof answer.data === "string") addresses.add(answer.data);
    }
  }
  return [...addresses].sort();
}

async function validatedResolution(hostname: string, resolver: (hostname: string) => Promise<string[]>): Promise<string[]> {
  let addresses: string[];
  try { addresses = [...new Set(await resolver(hostname))].sort(); }
  catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw boundaryError("connector_file_dns_validation_failed", "The connector file host could not be resolved safely.", { retryable: true });
  }
  if (!addresses.length || addresses.some((address) => !isPublicRoutableAddress(address))) {
    throw boundaryError("connector_file_dns_forbidden", "The connector file host resolved to a non-public or reserved address.", { details: { addressCount: addresses.length } });
  }
  return addresses;
}

function sameAddressSet(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedMime(value: string | null | undefined): string | null {
  if (!value) return null;
  const mime = value.split(";", 1)[0].trim().toLocaleLowerCase("en");
  return mime || null;
}

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLocaleLowerCase("en");
}

function allowedMime(name: string, rawMime: string | null | undefined): boolean {
  const mime = normalizedMime(rawMime);
  if (!mime) return true;
  const ext = extension(name);
  if (ext === "csv") return new Set(["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"]).has(mime);
  if (ext === "json") return new Set(["application/json", "text/json", "text/plain"]).has(mime);
  return mime.startsWith("text/") || new Set(["application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/javascript", "application/typescript"]).has(mime);
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw boundaryError("connector_file_too_large", "The connector file exceeds the configured byte ceiling.", { details: { maximumBytes, declaredByteSize: declaredLength } });
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) throw boundaryError("connector_file_too_large", "The connector file exceeds the configured byte ceiling.");
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw boundaryError("connector_file_too_large", "The connector file exceeds the configured byte ceiling.", { details: { maximumBytes, actualByteSizeAtAbort: total } });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export function decodeStrictUtf8(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw boundaryError("connector_file_content_invalid", "The connector file is not valid UTF-8 text."); }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const disallowedC0 = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const disallowedC1 = code >= 0x7f && code <= 0x9f;
    if (code === 0 || disallowedC0 || disallowedC1) throw boundaryError("connector_file_content_invalid", "The connector file contains binary or disallowed control bytes.");
  }
  return text;
}

function assertStructuredTextContent(fileName: string, text: string): void {
  const ext = extension(fileName);
  const clean = text.replace(/^\uFEFF/, "");
  if (ext === "json") {
    try { JSON.parse(clean); }
    catch { throw boundaryError("connector_file_content_invalid", "The connector JSON file is malformed."); }
    return;
  }
  if (ext !== "csv") return;
  let quoted = false;
  let fieldStarted = false;
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index];
    if (quoted) {
      if (character === '"') {
        if (clean[index + 1] === '"') index += 1;
        else quoted = false;
      }
      continue;
    }
    if (character === '"') {
      if (fieldStarted) throw boundaryError("connector_file_content_invalid", "The connector CSV file is malformed.");
      quoted = true;
    } else if (character === "," || character === "\n" || character === "\r") {
      fieldStarted = false;
    } else {
      fieldStarted = true;
    }
  }
  if (quoted) throw boundaryError("connector_file_content_invalid", "The connector CSV file is malformed.");
}

function requireAuthorizedParameter(options: ConnectorFileNetworkOptions): void {
  if (!options.enforceAuthorizedFileParam) return;
  const name = options.authorizedTopLevelFileParam ?? "";
  if (!name || !options.declaredFileParams?.includes(name)) {
    throw boundaryError("connector_file_parameter_not_authorized", "The connector file reference did not arrive through an authorized top-level file parameter.");
  }
}

async function requestFile(
  url: URL,
  fetchImpl: FetchLike,
  options: ConnectorFileNetworkOptions,
): Promise<{ response: Response; redirectCount: 0 | 1 }> {
  const response = await fetchImpl(url.href, {
    method: "GET",
    redirect: "manual",
    headers: { Accept: "text/plain, text/csv, application/json" },
  });
  if (!(response.status >= 300 && response.status < 400)) return { response, redirectCount: 0 };
  if (!options.allowSingleSameHostRedirect) {
    await response.body?.cancel();
    throw boundaryError("connector_file_download_forbidden", "Connector file redirects are not permitted.", { status: response.status, details: { redirectRejected: true } });
  }
  const location = response.headers.get("location");
  await response.body?.cancel();
  if (!location) throw boundaryError("connector_file_download_forbidden", "The connector file redirect was missing a destination.");
  const destination = trustedConnectorFileUrl(new URL(location, url).href);
  if (normalizedHostname(destination) !== normalizedHostname(url)) {
    throw boundaryError("connector_file_download_forbidden", "Cross-origin connector file redirects are not permitted.");
  }
  const redirected = await fetchImpl(destination.href, {
    method: "GET", redirect: "manual", headers: { Accept: "text/plain, text/csv, application/json" },
  });
  if (redirected.status >= 300 && redirected.status < 400) {
    await redirected.body?.cancel();
    throw boundaryError("connector_file_download_forbidden", "More than one connector file redirect is not permitted.");
  }
  return { response: redirected, redirectCount: 1 };
}

export async function loadConnectorTextFile(
  fileReference: unknown,
  expectedFilename: string,
  maximumBytes: number,
  suppliedExpectedSha256?: string,
  expectedByteLengthOrFetch?: number | typeof fetch,
  fetchImplMaybe: typeof fetch = fetch,
  networkOptions: ConnectorFileNetworkOptions = {},
): Promise<LoadedConnectorTextFile> {
  requireAuthorizedParameter(networkOptions);
  const reference = normalizeConnectorFileReference(fileReference);
  const runtimeShape = connectorFileRuntimeShape(fileReference);
  const expectedName = validateItemName(expectedFilename);
  const fileName = validateItemName(reference.file_name ?? expectedName);
  if (!isAllowedTextFile(expectedName) || !isAllowedTextFile(fileName)) {
    throw boundaryError("connector_file_content_invalid", "The connector file extension is not allowlisted for textual publication.", { details: { runtimeShape } });
  }
  if (extension(expectedName) !== extension(fileName)) {
    throw boundaryError("connector_file_content_invalid", "The connector file extension does not match the requested target format.", { details: { expectedExtension: extension(expectedName), actualExtension: extension(fileName) } });
  }
  if (!allowedMime(fileName, reference.mime_type)) throw boundaryError("connector_file_mime_rejected", "The connector file MIME metadata is not allowed for this textual format.");
  if (reference.size !== undefined && reference.size > maximumBytes) throw boundaryError("connector_file_too_large", "The connector file exceeds the configured byte ceiling.", { details: { maximumBytes, declaredByteSize: reference.size } });

  const url = trustedConnectorFileUrl(reference.download_url);
  const expectedByteLength = typeof expectedByteLengthOrFetch === "number" ? expectedByteLengthOrFetch : undefined;
  const fetchImpl = typeof expectedByteLengthOrFetch === "function" ? expectedByteLengthOrFetch : fetchImplMaybe;
  const resolver = networkOptions.resolveHost ?? defaultResolveHost;
  let firstResolution: string[] | null = null;
  let secondResolution: string[] | null = null;
  if (networkOptions.enforceAuthorizedFileParam || networkOptions.resolveHost) {
    firstResolution = await validatedResolution(url.hostname, resolver);
    secondResolution = await validatedResolution(url.hostname, resolver);
    if (!sameAddressSet(firstResolution, secondResolution)) {
      throw boundaryError("connector_file_dns_rebinding_detected", "The connector file host changed resolution before connection.", { details: { firstAddressCount: firstResolution.length, secondAddressCount: secondResolution.length } });
    }
  }

  let response: Response;
  let redirectCount: 0 | 1 = 0;
  try {
    const requested = await requestFile(url, fetchImpl, networkOptions);
    response = requested.response;
    redirectCount = requested.redirectCount;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw boundaryError("connector_file_download_failed", "The connector file could not be downloaded.", { retryable: true });
  }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw boundaryError("connector_file_download_forbidden", "The connector file download was forbidden.", { status: response.status }); }
  if (response.status === 404 || response.status === 410) { await response.body?.cancel(); throw boundaryError("connector_file_download_expired", "The connector file download authorization is missing or expired.", { status: response.status }); }
  if (!response.ok) { await response.body?.cancel(); throw boundaryError("connector_file_download_failed", "The connector file download failed.", { retryable: response.status >= 500, status: response.status }); }

  const sourceMimeType = normalizedMime(response.headers.get("content-type"));
  if (!allowedMime(fileName, sourceMimeType)) { await response.body?.cancel(); throw boundaryError("connector_file_mime_rejected", "The downloaded connector file MIME type is not allowed for this textual format."); }
  const bytes = await readBoundedResponse(response, maximumBytes);
  if (reference.size !== undefined && bytes.byteLength !== reference.size) throw boundaryError("connector_file_content_invalid", "The connector file byte size does not match platform metadata.", { details: { expectedByteLength: reference.size, actualByteLength: bytes.byteLength } });
  if (expectedByteLength !== undefined && bytes.byteLength !== expectedByteLength) throw boundaryError("connector_file_content_invalid", "The connector file byte size does not match the expected value.", { details: { expectedByteLength, actualByteLength: bytes.byteLength } });
  const text = decodeStrictUtf8(bytes);
  assertStructuredTextContent(fileName, text);
  const signature = validateFileSignature(fileName, exactArrayBuffer(bytes));
  if (!signature.compatible) throw boundaryError("connector_file_content_invalid", "The connector file content does not match the requested textual format.", { details: { detected: signature.detected, reason: signature.reason ?? null } });
  const sha256 = await sha256Hex(bytes);
  if (suppliedExpectedSha256 !== undefined) {
    const expected = suppliedExpectedSha256.trim().toLocaleLowerCase("en");
    if (!SHA256_PATTERN.test(expected) || expected !== sha256) throw boundaryError("connector_file_hash_mismatch", "The connector file SHA-256 does not match the expected value.", { details: { expectedSha256: SHA256_PATTERN.test(expected) ? expected : null, actualSha256: sha256 } });
  }
  const networkReceipt: SanitizedConnectorNetworkReceipt | null = secondResolution ? {
    scheme: "https", hostname: CHATGPT_ATTACHMENT_HOST, effectivePort: 443,
    eTldPlusOne: CHATGPT_ATTACHMENT_ETLD_PLUS_ONE, redirectCount,
    dnsAddressCount: secondResolution.length, dnsRevalidated: true, connectionPinned: false,
  } : null;
  return {
    bytes, text, byteLength: bytes.byteLength, sha256, fileName,
    declaredMimeType: normalizedMime(reference.mime_type), sourceMimeType,
    runtimeShape: { ...runtimeShape, declaredByteSize: reference.size ?? bytes.byteLength }, networkReceipt,
  };
}
