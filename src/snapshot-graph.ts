import { ConnectorError } from "./errors";
import {
  MICROSOFT_SCOPES,
  TOKEN_ENDPOINT,
  getStoredTokenRecord,
  storeTokenRecord,
} from "./graph-core";
import { INTEGRATED_LIMITS } from "./integrated-core";
import type { GraphDriveItem } from "./types";

export type GraphDiagnostics = {
  operation: string;
  endpointCategory: string;
  pageNumber?: number;
  enumeratedCount?: number;
  pathContext?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  clientRequestId?: string;
};

type GraphErrorBody = { error?: { code?: string; message?: string } };
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_HASH_MAX_MB = 512;
const DEFAULT_HASH_TOTAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_HASH_IDLE_TIMEOUT_MS = 30_000;
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private bufferLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 digest has already been finalized.");
    this.bytesHashed += data.byteLength;
    let offset = 0;
    if (this.bufferLength > 0) {
      const take = Math.min(64 - this.bufferLength, data.byteLength);
      this.buffer.set(data.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === 64) {
        this.processBlock(this.buffer, 0);
        this.bufferLength = 0;
      }
    }
    while (offset + 64 <= data.byteLength) {
      this.processBlock(data, offset);
      offset += 64;
    }
    if (offset < data.byteLength) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLength = data.byteLength - offset;
    }
    return this;
  }

  digestHex(): string {
    if (this.finished) throw new Error("SHA-256 digest has already been finalized.");
    const finalLength = this.bufferLength < 56 ? 64 : 128;
    const finalBlock = new Uint8Array(finalLength);
    finalBlock.set(this.buffer.subarray(0, this.bufferLength), 0);
    finalBlock[this.bufferLength] = 0x80;
    const bitLength = this.bytesHashed * 8;
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    const lengthOffset = finalLength - 8;
    finalBlock[lengthOffset] = (high >>> 24) & 0xff;
    finalBlock[lengthOffset + 1] = (high >>> 16) & 0xff;
    finalBlock[lengthOffset + 2] = (high >>> 8) & 0xff;
    finalBlock[lengthOffset + 3] = high & 0xff;
    finalBlock[lengthOffset + 4] = (low >>> 24) & 0xff;
    finalBlock[lengthOffset + 5] = (low >>> 16) & 0xff;
    finalBlock[lengthOffset + 6] = (low >>> 8) & 0xff;
    finalBlock[lengthOffset + 7] = low & 0xff;
    for (let offset = 0; offset < finalLength; offset += 64) this.processBlock(finalBlock, offset);
    this.finished = true;
    return Array.from(this.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  private processBlock(data: Uint8Array, offset: number): void {
    const words = this.schedule;
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = (
        (data[position] << 24)
        | (data[position + 1] << 16)
        | (data[position + 2] << 8)
        | data[position + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const sigma0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const sigma1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + upperSigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

function boundedPath(value?: string): string | null {
  if (!value) return null;
  return value.replace(/[\u0000-\u001f]/g, "").split("/").slice(-4).join("/").slice(0, 240);
}
function exceptionClass(error: unknown): string {
  if (error instanceof DOMException) return error.name || "DOMException";
  if (error instanceof Error) return error.constructor?.name || error.name || "Error";
  return typeof error;
}
function safeGraphLog(event: string, fields: Record<string, unknown>): void {
  const safe: Record<string, unknown> = { event, ...fields };
  delete safe.accessToken; delete safe.refreshToken; delete safe.authorization; delete safe.url; delete safe.downloadUrl;
  console.error(JSON.stringify(safe));
}
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), 30_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 30_000) : null;
}
function delayMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return retryAfter;
  const base = Math.min(4_000, 250 * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(base * jitter);
}
async function sleep(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }
function graphUrl(pathOrUrl: string): string {
  if (!pathOrUrl.startsWith("https://")) return `https://graph.microsoft.com/v1.0${pathOrUrl}`;
  const url = new URL(pathOrUrl);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "graph.microsoft.com" || !url.pathname.startsWith("/v1.0/")) {
    throw new ConnectorError("unsafe_graph_url", "The Microsoft Graph continuation URL is not trusted.");
  }
  return url.href;
}
function transientStatus(status: number): boolean { return status === 429 || status === 502 || status === 503 || status === 504; }
function classifyGraphStatus(status: number, graphCode: string, correlationId: string): ConnectorError {
  const options = { status, correlationId, retryable: transientStatus(status) };
  if (status === 400) return new ConnectorError("graph_bad_request", "Microsoft Graph rejected the request.", options);
  if (status === 401) return new ConnectorError("authentication_required", "Microsoft authorization is no longer valid. Reconnect the ChatGPT app.", options);
  if (status === 403) return new ConnectorError("graph_forbidden", "Microsoft Graph denied this operation.", options);
  if (status === 404) return new ConnectorError("item_not_found", "The requested OneDrive item was not found.", options);
  if (status === 429) return new ConnectorError("graph_rate_limited", "Microsoft Graph rate-limited the request.", options);
  if (status === 502 || status === 503 || status === 504) return new ConnectorError("graph_transient_failure", "Microsoft Graph returned a transient service failure.", options);
  return new ConnectorError(graphCode === "nameAlreadyExists" ? "name_conflict" : "graph_request_failed", "Microsoft Graph could not complete the request.", options);
}
function configuredNumber(env: Env, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = Number((env as unknown as Record<string, unknown>)[key] ?? fallback);
  return Math.min(Math.max(Number.isFinite(raw) ? raw : fallback, minimum), maximum);
}
async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ConnectorError("graph_stream_timeout", "Microsoft Graph file streaming timed out.", { retryable: true })), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function reliableGraphAccessToken(env: Env, userId: string, diagnostics: GraphDiagnostics): Promise<string> {
  const record = await getStoredTokenRecord(env, userId);
  if (record.expiresAt > Date.now() + 120_000) return record.accessToken;
  const clientRequestId = diagnostics.clientRequestId ?? crypto.randomUUID();
  const maxAttempts = diagnostics.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let terminal: ConnectorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("token_refresh_timeout"), diagnostics.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.MICROSOFT_CLIENT_ID,
          client_secret: env.MICROSOFT_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: record.refreshToken,
          scope: MICROSOFT_SCOPES,
        }),
      });
      let body: Record<string, unknown> = {};
      try { body = await response.json() as Record<string, unknown>; } catch { /* sanitized */ }
      if (response.ok && body.access_token) {
        await storeTokenRecord(env, userId, body);
        safeGraphLog("token_refresh_success", { operation: diagnostics.operation, tokenRefreshStage: "completed", attempt, elapsedMs: Date.now() - started, clientRequestId });
        return String(body.access_token);
      }
      const retryable = transientStatus(response.status);
      terminal = new ConnectorError(response.status === 400 || response.status === 401 ? "fresh_consent_required" : "oauth_refresh_failed", response.status === 400 || response.status === 401 ? "Microsoft authorization must be refreshed. Disconnect and reconnect the ChatGPT app." : "Microsoft token refresh failed.", { retryable, status: response.status, correlationId: clientRequestId });
      safeGraphLog("token_refresh_failure", { operation: diagnostics.operation, tokenRefreshStage: "response", status: response.status, retryable, attempt, elapsedMs: Date.now() - started, clientRequestId });
      if (!retryable || attempt === maxAttempts) throw terminal;
      await sleep(delayMs(attempt, retryAfterMs(response)));
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const cls = exceptionClass(error);
      terminal = new ConnectorError(cls === "AbortError" ? "oauth_refresh_timeout" : "oauth_refresh_unreachable", cls === "AbortError" ? "Microsoft token refresh timed out." : "Microsoft token refresh is temporarily unavailable.", { retryable: true, correlationId: clientRequestId });
      safeGraphLog("token_refresh_failure", { operation: diagnostics.operation, tokenRefreshStage: "network", retryable: true, attempt, elapsedMs: Date.now() - started, clientRequestId, networkExceptionClass: cls });
      if (attempt === maxAttempts) throw terminal;
      await sleep(delayMs(attempt, null));
    } finally { clearTimeout(timeout); }
  }
  throw terminal ?? new ConnectorError("oauth_refresh_failed", "Microsoft token refresh failed.");
}

export async function reliableGraphResponse(env: Env, userId: string, pathOrUrl: string, init: RequestInit, diagnostics: GraphDiagnostics): Promise<Response> {
  const clientRequestId = diagnostics.clientRequestId ?? crypto.randomUUID();
  const maxAttempts = diagnostics.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = diagnostics.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let terminal: ConnectorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const token = await reliableGraphAccessToken(env, userId, { ...diagnostics, clientRequestId });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("graph_request_timeout"), timeoutMs);
    try {
      const response = await fetch(graphUrl(pathOrUrl), {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
          "client-request-id": clientRequestId,
          "return-client-request-id": "true",
        },
      });
      const requestId = response.headers.get("request-id") ?? response.headers.get("x-ms-request-id");
      if (response.ok) {
        safeGraphLog("graph_request_success", { operation: diagnostics.operation, endpointCategory: diagnostics.endpointCategory, status: response.status, retryable: false, retryAfterMs: null, requestId, clientRequestId, attempt, elapsedMs: Date.now() - started, pageNumber: diagnostics.pageNumber ?? null, enumeratedCount: diagnostics.enumeratedCount ?? null, pathContext: boundedPath(diagnostics.pathContext), concurrency: 1 });
        return response;
      }
      let graphCode = "";
      try { graphCode = String((await response.clone().json() as GraphErrorBody).error?.code ?? ""); } catch { /* sanitized */ }
      const retryable = transientStatus(response.status);
      const after = retryAfterMs(response);
      terminal = classifyGraphStatus(response.status, graphCode, clientRequestId);
      safeGraphLog("graph_request_failure", { operation: diagnostics.operation, endpointCategory: diagnostics.endpointCategory, status: response.status, graphErrorCode: graphCode || null, retryable, retryAfterMs: after, requestId, clientRequestId, attempt, elapsedMs: Date.now() - started, pageNumber: diagnostics.pageNumber ?? null, enumeratedCount: diagnostics.enumeratedCount ?? null, pathContext: boundedPath(diagnostics.pathContext), concurrency: 1 });
      if (!retryable || attempt === maxAttempts) throw terminal;
      await sleep(delayMs(attempt, after));
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const cls = exceptionClass(error);
      terminal = new ConnectorError(cls === "AbortError" ? "graph_timeout" : "graph_network_error", cls === "AbortError" ? "Microsoft Graph request timed out." : "A network error prevented Microsoft Graph from completing the request.", { retryable: true, correlationId: clientRequestId });
      safeGraphLog("graph_request_failure", { operation: diagnostics.operation, endpointCategory: diagnostics.endpointCategory, status: null, graphErrorCode: null, retryable: true, retryAfterMs: null, requestId: null, clientRequestId, attempt, elapsedMs: Date.now() - started, pageNumber: diagnostics.pageNumber ?? null, enumeratedCount: diagnostics.enumeratedCount ?? null, pathContext: boundedPath(diagnostics.pathContext), networkExceptionClass: cls, concurrency: 1 });
      if (attempt === maxAttempts) throw terminal;
      await sleep(delayMs(attempt, null));
    } finally { clearTimeout(timeout); }
  }
  throw terminal ?? new ConnectorError("graph_request_failed", "Microsoft Graph could not complete the request.");
}

export async function reliableGraphJson<T>(env: Env, userId: string, pathOrUrl: string, diagnostics: GraphDiagnostics): Promise<T> {
  const response = await reliableGraphResponse(env, userId, pathOrUrl, {}, diagnostics);
  try { return await response.json() as T; }
  catch { throw new ConnectorError("graph_invalid_response", "Microsoft Graph returned an invalid JSON response.", { retryable: true, correlationId: diagnostics.clientRequestId }); }
}

async function verifiedFileMetadata(env: Env, userId: string, itemId: string, expectedETag: string | null, diagnostics: GraphDiagnostics): Promise<GraphDriveItem> {
  const current = await reliableGraphJson<GraphDriveItem>(env, userId, `/me/drive/items/${encodeURIComponent(itemId)}?$select=id,eTag,size,file`, { ...diagnostics, operation: `${diagnostics.operation}.verify`, endpointCategory: "item_metadata" });
  if (expectedETag && current.eTag !== expectedETag) throw new ConnectorError("snapshot_source_changed", "A source item changed while the snapshot was being captured.");
  return current;
}

export async function reliableGraphBytes(env: Env, userId: string, itemId: string, expectedETag: string | null, diagnostics: GraphDiagnostics): Promise<ArrayBuffer> {
  const current = await verifiedFileMetadata(env, userId, itemId, expectedETag, diagnostics);
  if (Number(current.size ?? 0) > INTEGRATED_LIMITS.fileBytesMax) throw new ConnectorError("file_too_large", "The file exceeds the integrated snapshot size limit.");
  const response = await reliableGraphResponse(env, userId, `/me/drive/items/${encodeURIComponent(itemId)}/content`, { redirect: "follow" }, { ...diagnostics, endpointCategory: "file_content" });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > INTEGRATED_LIMITS.fileBytesMax) throw new ConnectorError("file_too_large", "The file exceeds the integrated snapshot size limit.");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > INTEGRATED_LIMITS.fileBytesMax) throw new ConnectorError("file_too_large", "The file exceeds the integrated snapshot size limit.");
  if (Number(current.size ?? 0) && buffer.byteLength !== Number(current.size)) throw new ConnectorError("snapshot_source_changed", "The source file size changed while the snapshot was being captured.");
  return buffer;
}

export async function reliableGraphSha256(env: Env, userId: string, itemId: string, expectedETag: string | null, diagnostics: GraphDiagnostics): Promise<{ sha256: string; byteLength: number }> {
  const current = await verifiedFileMetadata(env, userId, itemId, expectedETag, diagnostics);
  const expectedSize = Number(current.size ?? 0);
  const maximumBytes = Math.round(configuredNumber(env, "SNAPSHOT_HASH_MAX_MB", DEFAULT_HASH_MAX_MB, 20, 2048) * 1024 * 1024);
  if (expectedSize > maximumBytes) throw new ConnectorError("hash_size_limit", "The file exceeds the configured streaming hash size limit.");
  const response = await reliableGraphResponse(env, userId, `/me/drive/items/${encodeURIComponent(itemId)}/content`, { redirect: "follow" }, { ...diagnostics, operation: `${diagnostics.operation}.sha256`, endpointCategory: "file_content_stream" });
  if (!response.body) throw new ConnectorError("graph_invalid_response", "Microsoft Graph returned an empty file stream.", { retryable: true });
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new ConnectorError("hash_size_limit", "The file exceeds the configured streaming hash size limit.");
  const reader = response.body.getReader();
  const hash = new IncrementalSha256();
  const started = Date.now();
  const totalTimeoutMs = configuredNumber(env, "SNAPSHOT_HASH_TIMEOUT_MS", DEFAULT_HASH_TOTAL_TIMEOUT_MS, 30_000, 15 * 60_000);
  const idleTimeoutMs = configuredNumber(env, "SNAPSHOT_HASH_IDLE_TIMEOUT_MS", DEFAULT_HASH_IDLE_TIMEOUT_MS, 5_000, 120_000);
  let total = 0;
  try {
    while (true) {
      if (Date.now() - started > totalTimeoutMs) throw new ConnectorError("graph_stream_timeout", "Microsoft Graph file streaming exceeded the total timeout.", { retryable: true });
      const chunk = await readStreamChunk(reader, idleTimeoutMs);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) throw new ConnectorError("hash_size_limit", "The file exceeds the configured streaming hash size limit.");
      hash.update(chunk.value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* best effort */ }
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("graph_stream_error", "Microsoft Graph file streaming was interrupted.", { retryable: true });
  }
  if (expectedSize && total !== expectedSize) throw new ConnectorError("snapshot_source_changed", "The source file size changed while the snapshot was being captured.");
  const sha256 = hash.digestHex();
  safeGraphLog("graph_stream_hash_success", { operation: diagnostics.operation, endpointCategory: "file_content_stream", clientRequestId: diagnostics.clientRequestId ?? null, elapsedMs: Date.now() - started, pageNumber: diagnostics.pageNumber ?? null, enumeratedCount: diagnostics.enumeratedCount ?? null, pathContext: boundedPath(diagnostics.pathContext), byteLength: total, concurrency: 1 });
  return { sha256, byteLength: total };
}

export const snapshotGraphTestHooks = { retryAfterMs, delayMs, graphUrl, classifyGraphStatus, boundedPath, transientStatus, configuredNumber, IncrementalSha256 };
