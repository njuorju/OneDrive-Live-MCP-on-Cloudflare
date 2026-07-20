import { createHash } from "node:crypto";
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
  const hash = createHash("sha256");
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
  const sha256 = hash.digest("hex");
  safeGraphLog("graph_stream_hash_success", { operation: diagnostics.operation, endpointCategory: "file_content_stream", clientRequestId: diagnostics.clientRequestId ?? null, elapsedMs: Date.now() - started, pageNumber: diagnostics.pageNumber ?? null, enumeratedCount: diagnostics.enumeratedCount ?? null, pathContext: boundedPath(diagnostics.pathContext), byteLength: total, concurrency: 1 });
  return { sha256, byteLength: total };
}

export const snapshotGraphTestHooks = { retryAfterMs, delayMs, graphUrl, classifyGraphStatus, boundedPath, transientStatus, configuredNumber };
