import { z } from "zod";
import { ConnectorError } from "./errors";
import { isAllowedTextFile, validateFileSignature } from "./file-types";
import { validateItemName } from "./graph-core";

const CONNECTOR_FILE_HOST_SUFFIXES = [
  "openai.com",
  "chatgpt.com",
  "openaiusercontent.com",
  "oaiusercontent.com",
] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const connectorFileInputSchema = z.object({
  download_url: z.string().min(1).max(20_000),
  file_id: z.string().min(1).max(5_000),
  mime_type: z.string().min(1).max(500).optional(),
  file_name: z.string().min(1).max(255).optional(),
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
export type LoadedConnectorTextFile = {
  bytes: Uint8Array;
  text: string;
  byteLength: number;
  sha256: string;
  fileName: string;
  declaredMimeType: string | null;
  sourceMimeType: string | null;
  runtimeShape: SanitizedConnectorFileShape;
};

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
    declaredByteSize: null,
  };
}

export function normalizeConnectorFileReference(value: unknown): ConnectorFileReference {
  const shape = connectorFileRuntimeShape(value);
  const record = objectRecord(value);
  if (!record) {
    throw boundaryError("connector_file_reference_malformed", "The connector file reference must be an object.", { details: { runtimeShape: shape } });
  }
  if (typeof record.file_id !== "string" || !record.file_id.trim()) {
    throw boundaryError("connector_file_metadata_missing", "The connector file reference is missing file_id metadata.", { details: { runtimeShape: shape } });
  }
  if (typeof record.download_url !== "string" || !record.download_url.trim()) {
    throw boundaryError("connector_file_download_url_missing", "The connector file reference is missing download_url.", { details: { runtimeShape: shape } });
  }
  if (record.mime_type !== undefined && (typeof record.mime_type !== "string" || !record.mime_type.trim())) {
    throw boundaryError("connector_file_reference_malformed", "The connector file MIME metadata is malformed.", { details: { runtimeShape: shape } });
  }
  if (record.file_name !== undefined && (typeof record.file_name !== "string" || !record.file_name.trim())) {
    throw boundaryError("connector_file_reference_malformed", "The connector file name metadata is malformed.", { details: { runtimeShape: shape } });
  }
  const parsed = connectorFileInputSchema.safeParse(record);
  if (!parsed.success) {
    throw boundaryError("connector_file_reference_malformed", "The connector file reference does not match the supported ChatGPT file shape.", { details: { runtimeShape: shape } });
  }
  return parsed.data;
}

export function trustedConnectorFileUrl(reference: string): URL {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw boundaryError("connector_file_reference_malformed", "The connector file download URL is malformed.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw boundaryError("connector_file_download_forbidden", "The connector file download URL is not permitted.");
  }
  const host = url.hostname.toLocaleLowerCase("en");
  const trusted = CONNECTOR_FILE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!trusted) {
    throw boundaryError("connector_file_download_forbidden", "The connector file download host is not permitted.");
  }
  return url;
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
    if (buffer.byteLength > maximumBytes) {
      throw boundaryError("connector_file_too_large", "The connector file exceeds the configured byte ceiling.", { details: { maximumBytes, actualByteSize: buffer.byteLength } });
    }
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
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function decodeStrictUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw boundaryError("connector_file_content_invalid", "The connector file is not valid UTF-8 text.");
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const disallowedC0 = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const disallowedC1 = code >= 0x7f && code <= 0x9f;
    if (code === 0 || disallowedC0 || disallowedC1) {
      throw boundaryError("connector_file_content_invalid", "The connector file contains binary or disallowed control bytes.");
    }
  }
  return text;
}

export async function loadConnectorTextFile(
  fileReference: unknown,
  expectedFilename: string,
  maximumBytes: number,
  suppliedExpectedSha256?: string,
  expectedByteLengthOrFetch?: number | typeof fetch,
  fetchImplMaybe: typeof fetch = fetch,
): Promise<LoadedConnectorTextFile> {
  const reference = normalizeConnectorFileReference(fileReference);
  const runtimeShape = connectorFileRuntimeShape(fileReference);
  const expectedName = validateItemName(expectedFilename);
  const fileName = validateItemName(reference.file_name ?? expectedName);
  if (!isAllowedTextFile(expectedName) || !isAllowedTextFile(fileName)) {
    throw boundaryError("connector_file_content_invalid", "The connector file extension is not allowlisted for textual publication.", { details: { runtimeShape } });
  }
  if (extension(expectedName) !== extension(fileName)) {
    throw boundaryError("connector_file_content_invalid", "The connector file extension does not match the requested target format.", { details: { runtimeShape, expectedExtension: extension(expectedName), actualExtension: extension(fileName) } });
  }
  if (!allowedMime(fileName, reference.mime_type)) {
    throw boundaryError("connector_file_mime_rejected", "The connector file MIME metadata is not allowed for this textual format.", { details: { runtimeShape } });
  }
  const url = trustedConnectorFileUrl(reference.download_url);
  const expectedByteLength = typeof expectedByteLengthOrFetch === "number" ? expectedByteLengthOrFetch : undefined;
  const fetchImpl = typeof expectedByteLengthOrFetch === "function" ? expectedByteLengthOrFetch : fetchImplMaybe;
  let response: Response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/plain, text/csv, application/json" },
    });
  } catch {
    throw boundaryError("connector_file_download_failed", "The connector file could not be downloaded.", { retryable: true });
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw boundaryError("connector_file_download_forbidden", "Connector file redirects are not permitted.", { status: response.status, details: { redirectRejected: true } });
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw boundaryError("connector_file_download_forbidden", "The connector file download was forbidden.", { status: response.status });
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    throw boundaryError("connector_file_download_expired", "The connector file download authorization is missing or expired.", { status: response.status });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw boundaryError("connector_file_download_failed", "The connector file download failed.", { retryable: response.status >= 500, status: response.status });
  }
  const sourceMimeType = normalizedMime(response.headers.get("content-type"));
  if (!allowedMime(fileName, sourceMimeType)) {
    await response.body?.cancel();
    throw boundaryError("connector_file_mime_rejected", "The downloaded connector file MIME type is not allowed for this textual format.", { details: { runtimeShape, responseMimeType: sourceMimeType } });
  }
  const bytes = await readBoundedResponse(response, maximumBytes);
  if (expectedByteLength !== undefined && bytes.byteLength !== expectedByteLength) {
    throw boundaryError("connector_file_content_invalid", "The connector file byte size does not match the expected value.", { details: { expectedByteLength, actualByteLength: bytes.byteLength } });
  }
  const text = decodeStrictUtf8(bytes);
  const signature = validateFileSignature(fileName, exactArrayBuffer(bytes));
  if (!signature.compatible) {
    throw boundaryError("connector_file_content_invalid", "The connector file content does not match the requested textual format.", { details: { detected: signature.detected, reason: signature.reason ?? null } });
  }
  const sha256 = await sha256Hex(bytes);
  if (suppliedExpectedSha256 !== undefined) {
    const expected = suppliedExpectedSha256.trim().toLocaleLowerCase("en");
    if (!SHA256_PATTERN.test(expected) || expected !== sha256) {
      throw boundaryError("connector_file_hash_mismatch", "The connector file SHA-256 does not match the expected value.", { details: { expectedSha256: SHA256_PATTERN.test(expected) ? expected : null, actualSha256: sha256 } });
    }
  }
  return {
    bytes,
    text,
    byteLength: bytes.byteLength,
    sha256,
    fileName,
    declaredMimeType: normalizedMime(reference.mime_type),
    sourceMimeType,
    runtimeShape: { ...runtimeShape, declaredByteSize: bytes.byteLength },
  };
}
