import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorError, safeErrorResult } from "./errors";

export const PAID_JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const PAID_PLAN_RETENTION_SECONDS = 365 * 24 * 60 * 60;
export const PAID_VISUAL_RETENTION_SECONDS = 365 * 24 * 60 * 60;
export const PAID_LONG_POLL_MAX_SECONDS = 25;

export type PaidJobStatus = "reserved" | "queued" | "running" | "completed" | "failed" | "cancelled";
export type PaidPlanState =
  | "reserved"
  | "draft"
  | "validated"
  | "running"
  | "completed"
  | "failed"
  | "expired"
  | "abandoned"
  | "superseded";

export type PaidJobMessage = {
  version: 1;
  jobId: string;
  workflowId: string;
  userId: string;
  toolName: string;
  input: Record<string, unknown>;
  requestHash: string;
  correlationId: string;
  chunkIndex: number;
  createdAt: string;
};

export type PaidJobRecord = {
  jobId: string;
  workflowId: string;
  userId: string;
  toolName: string;
  requestHash: string;
  status: PaidJobStatus;
  progress: number;
  stage: string;
  resultKey: string | null;
  resultMimeType: string | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type PaidPlanRecord = {
  operationId: string;
  userId: string;
  requestHash: string;
  planId: string | null;
  planHash: string | null;
  snapshotId: string;
  scopePath: string;
  state: PaidPlanState;
  artifactPrefix: string;
  artifacts: Record<string, string>;
  actionCount: number;
  sourceExpiresAt: string | null;
  supersededBy: string | null;
  abandonReason: string | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type StableVisualRecord = {
  stableId: string;
  userId: string;
  sourceItemId: string;
  sourceETag: string | null;
  sourceFilename: string;
  sourceExtension: string;
  visualKey: string;
  pageOrSlide: number | null;
  parentPages: number[];
  candidate: Record<string, unknown>;
  exactSha256: string | null;
  perceptualHash: string | null;
  originalArtifactKey: string | null;
  originalMimeType: string | null;
  originalByteSize: number | null;
  createdAt: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function expiryIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) output[key] = canonicalValue(nested);
    }
    return output;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256HexUtf8(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function requestHash(toolName: string, input: unknown): Promise<string> {
  return sha256HexUtf8(canonicalJson({ toolName, input }));
}

export function textResult(value: unknown): CallToolResult {
  const structuredContent = value && typeof value === "object"
    ? value as Record<string, unknown>
    : { value };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  } as CallToolResult;
}

export function errorResult(error: unknown): CallToolResult {
  return safeErrorResult(error) as CallToolResult;
}

export function callToolError(result: CallToolResult): ConnectorError | null {
  if (!result.isError) return null;
  const error = (result.structuredContent as { error?: Record<string, unknown> } | undefined)?.error;
  return new ConnectorError(
    String(error?.code ?? "paid_job_failed"),
    String(error?.message ?? "The queued connector operation failed."),
    {
      retryable: Boolean(error?.retryable),
      status: typeof error?.status === "number" ? error.status : undefined,
      correlationId: typeof error?.correlationId === "string" ? error.correlationId : undefined,
      details: error?.details && typeof error.details === "object"
        ? error.details as Record<string, unknown>
        : undefined,
    },
  );
}

export function parseJsonText<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

export async function putArtifact(
  env: Env,
  key: string,
  body: string | ArrayBuffer | Uint8Array | ReadableStream,
  contentType: string,
  customMetadata: Record<string, string> = {},
): Promise<void> {
  if (!env.ARTIFACTS) {
    throw new ConnectorError("r2_binding_missing", "The private R2 artifact binding is not configured.", {
      retryable: false,
    });
  }
  const payload = body instanceof Uint8Array ? ownedArrayBuffer(body) : body;
  await env.ARTIFACTS.put(key, payload as any, {
    httpMetadata: { contentType },
    customMetadata,
  });
}

export async function getArtifact(env: Env, key: string): Promise<R2ObjectBody> {
  const object = await env.ARTIFACTS.get(key);
  if (!object) throw new ConnectorError("artifact_not_found", "The durable artifact was not found.");
  return object;
}

export async function coordinatorRequest<T>(
  env: Env,
  userId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!env.PAID_COORDINATOR) {
    throw new ConnectorError("paid_coordinator_missing", "The paid-workload coordinator is not configured.");
  }
  const id = env.PAID_COORDINATOR.idFromName(userId || "owner");
  const response = await env.PAID_COORDINATOR.get(id).fetch(`https://paid-coordinator${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null) as { ok?: boolean; result?: T; error?: Record<string, unknown> } | null;
  if (!response.ok || !value?.ok) {
    throw new ConnectorError(
      String(value?.error?.code ?? "paid_coordinator_failed"),
      String(value?.error?.message ?? "The paid-workload coordinator could not complete the request."),
      { retryable: response.status >= 500, status: response.status },
    );
  }
  return value.result as T;
}

export function logPaidEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ component: "paid_workers_architecture", event, ...fields }));
}

export function logPaidError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const value = error as { code?: string; message?: string; retryable?: boolean; correlationId?: string };
  console.error(JSON.stringify({
    component: "paid_workers_architecture",
    event,
    code: value?.code ?? "internal_error",
    message: value instanceof Error ? value.message : String(value?.message ?? error),
    retryable: Boolean(value?.retryable),
    correlationId: value?.correlationId ?? null,
    ...fields,
  }));
}
