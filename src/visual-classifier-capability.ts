import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import {
  normalizedResponseClass,
  parseRetryAfterSeconds,
  responseClassRetryable,
  sanitizeProviderError,
  type CapabilityStage,
  type NormalizedResponseClass,
} from "./visual-classifier-capability-common";
export { normalizedResponseClass, parseRetryAfterSeconds, responseClassRetryable, sanitizeProviderError };
export type { CapabilityStage, NormalizedResponseClass };
import { ConnectorError } from "./errors";
import { bytesToBase64, sha256Bytes } from "./integrated-core";
import {
  canonicalJson,
  coordinatorRequest,
  errorResult,
  getArtifact,
  nowIso,
  putArtifact,
  requestHash,
  sha256HexUtf8,
  textResult,
  type PaidJobRecord,
} from "./paid-core";
import { createIntegratedStateStorage, type HotfixContext } from "./version20-hotfix";
import {
  OPENCODE_ZEN_ENDPOINT,
  OPENCODE_ZEN_MODELS_ENDPOINT,
  OPENCODE_ZEN_MODEL,
  type OpenCodeCapabilityReceipt,
} from "./visual-catalogue-opencode";
import {
  VISUAL_RENDERER_VERSION,
  renderCacheIdentity,
  type RenderArtifactManifest,
  type VisualCandidate,
} from "./visual-catalogue-model";
import {
  readCompilerManifest,
  type CompilerJobManifest,
  type StartVisualCatalogueInput,
  type VisualWorkflowPayload,
} from "./visual-catalogue-runtime";
import {
  OPENCODE_GO_MODE,
  OPENCODE_GO_MODEL,
  OPENCODE_GO_PROVIDER,
} from "./visual-catalogue-opencode-go";
import {
  getOpenCodeGoCapabilityJob,
  readSuccessfulOpenCodeGoCapabilityReceipt,
  startOpenCodeGoCapabilityJob,
} from "./visual-classifier-capability-go";
import { syntheticVisionProbeJpegBytes } from "./visual-catalogue-probe-fixture";

export const ODL_REQ_021_PROBE_VERSION = "odl-req-021-capability-v1";
export const ODL_REQ_021_ENDPOINT_FAMILY = "openai_compatible_chat_completions" as const;
export const ODL_REQ_021_MAX_CYCLES = 6;
export const ODL_REQ_021_MAX_ELAPSED_MS = 4 * 60 * 60 * 1000;
export const ODL_REQ_021_RECEIPT_TTL_MS = 60 * 60 * 1000;
export const ODL_REQ_021_RETRY_DELAYS_SECONDS = [0, 120, 600, 1800, 3600, 7200] as const;
export const ODL_REQ_021_MAX_RETRY_DELAY_SECONDS = 7200;
export const ODL_REQ_021_MAX_RESPONSE_BYTES = 64 * 1024;

const CAPABILITY_PREFIX = "visual-compiler/provider-capability/opencode-zen/mimo-v2.5-free/odl-req-021-capability-v1";
const CAPABILITY_INDEX_KEY = `${CAPABILITY_PREFIX}/active.json`;
const LEGACY_CAPABILITY_KEY = `visual-compiler/provider-cache/opencode-zen/${OPENCODE_ZEN_MODEL}/capabilities.json`;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const NON_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const UUID = z.string().uuid();
const SHA256 = /^[0-9a-f]{64}$/;

export type CapabilityAttemptReceipt = {
  version: 1;
  capabilityJobId: string;
  cycleNumber: number;
  attemptNumber: number;
  probeStage: CapabilityStage;
  provider: "opencode_zen";
  mode: "opencode_chat_completions";
  exactModel: "mimo-v2.5-free";
  endpointFamily: typeof ODL_REQ_021_ENDPOINT_FAMILY;
  requestFingerprint: string;
  requestImageSha256: string | null;
  requestImageByteSize: number | null;
  requestImageMimeType: "image/jpeg" | null;
  startedAt: string;
  completedAt: string;
  latencyMilliseconds: number;
  httpStatus: number | null;
  normalizedResponseClass: NormalizedResponseClass;
  retryable: boolean;
  retryAfterSeconds: number | null;
  providerRequestId: string | null;
  edgeRequestId: string | null;
  responseContentType: string | null;
  responseByteCount: number | null;
  sanitizedProviderErrorCode: string | null;
  sanitizedProviderErrorMessage: string | null;
  parserResult: string;
  schemaValidationResult: string;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
  nextRetryTimestamp: string | null;
  terminalDisposition: "stage_passed" | "retry_scheduled" | "terminal_failure";
};

export type CapabilityTerminalReceipt = {
  version: 1;
  capabilityJobId: string;
  provider: "opencode_zen";
  mode: "opencode_chat_completions";
  exactModel: "mimo-v2.5-free";
  probeVersion: typeof ODL_REQ_021_PROBE_VERSION;
  endpointFamily: typeof ODL_REQ_021_ENDPOINT_FAMILY;
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  totalElapsedMilliseconds: number;
  attemptCountByStage: Record<CapabilityStage, number>;
  httpStatusDistribution: Record<string, number>;
  responseClassDistribution: Partial<Record<NormalizedResponseClass, number>>;
  anySuccessfulHttpResponse: boolean;
  modelDiscoveryWorked: boolean;
  textTransportWorked: boolean;
  visionWorked: boolean;
  structuredOutputWorked: boolean;
  finalRetryability: boolean;
  finalReasonForStopping: string;
  blockerClassification: string | null;
  stageResults: Record<CapabilityStage, "passed" | "failed" | "not_run">;
  attempts: CapabilityAttemptReceipt[];
};

export type CapabilityJobManifest = {
  version: 1;
  jobId: string;
  workflowId: string;
  userIdHash: string;
  status: "reserved" | "running" | "retry_wait" | "completed" | "failed";
  currentStage: CapabilityStage;
  cycleNumber: number;
  attemptNumber: number;
  nextScheduledAttempt: string | null;
  forceFresh: boolean;
  provider: "opencode_zen";
  mode: "opencode_chat_completions";
  model: "mimo-v2.5-free";
  probeVersion: typeof ODL_REQ_021_PROBE_VERSION;
  stageResults: Record<CapabilityStage, "passed" | "failed" | "not_run">;
  modelMetadata: OpenCodeCapabilityReceipt["modelMetadata"] | null;
  attempts: CapabilityAttemptReceipt[];
  terminalReceipt: CapabilityTerminalReceipt | null;
  createdAt: string;
  updatedAt: string;
};

type CapabilityIndex = {
  version: 1;
  identity: string;
  jobId: string;
  status: CapabilityJobManifest["status"];
  updatedAt: string;
};

type ProbeResult = {
  receipt: CapabilityAttemptReceipt;
  modelMetadata?: OpenCodeCapabilityReceipt["modelMetadata"];
};

type CandidateInventory = { pageOrSlideCount?: number; candidates: VisualCandidate[] };

type CapabilityPayloadInput = {
  __odlReq021Capability: true;
  forceFresh: boolean;
};

function capabilityManifestKey(jobId: string): string {
  return `${CAPABILITY_PREFIX}/jobs/${jobId}/manifest.json`;
}

function capabilityAttemptKey(jobId: string, attemptNumber: number, stage: CapabilityStage): string {
  return `${CAPABILITY_PREFIX}/jobs/${jobId}/attempts/${String(attemptNumber).padStart(4, "0")}-${stage}.json`;
}

async function readJson<T>(env: Env, key: string): Promise<T> {
  return JSON.parse(await (await getArtifact(env, key)).text()) as T;
}

async function readJsonIfPresent<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.ARTIFACTS.get(key);
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

async function storeJson(env: Env, key: string, value: unknown, metadata: Record<string, string> = {}): Promise<void> {
  await putArtifact(env, key, JSON.stringify(value, null, 2), "application/json; charset=utf-8", metadata);
}

async function writeCapabilityManifest(env: Env, manifest: CapabilityJobManifest): Promise<void> {
  manifest.updatedAt = nowIso();
  await storeJson(env, capabilityManifestKey(manifest.jobId), manifest, {
    jobId: manifest.jobId,
    status: manifest.status,
    stage: manifest.currentStage,
    probeVersion: manifest.probeVersion,
  });
  await storeJson(env, CAPABILITY_INDEX_KEY, {
    version: 1,
    identity: capabilityIdentity(),
    jobId: manifest.jobId,
    status: manifest.status,
    updatedAt: manifest.updatedAt,
  } satisfies CapabilityIndex, { jobId: manifest.jobId, status: manifest.status });
}

function capabilityIdentity(): string {
  return `opencode_zen|opencode_chat_completions|${OPENCODE_ZEN_MODEL}|${ODL_REQ_021_PROBE_VERSION}`;
}

function usageFromBody(body: Record<string, unknown>): CapabilityAttemptReceipt["usage"] {
  const usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : null;
  if (!usage) return null;
  const bounded = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  };
  const inputTokens = bounded(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = bounded(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = bounded(usage.total_tokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)));
  return { inputTokens, outputTokens, totalTokens };
}

function chatContent(body: Record<string, unknown>): string | null {
  const choices = Array.isArray(body.choices) ? body.choices as Record<string, unknown>[] : [];
  const message = choices[0]?.message && typeof choices[0].message === "object" ? choices[0].message as Record<string, unknown> : null;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : "").join("");
  return null;
}

function modelList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const values = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return values.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).slice(0, 16) : [];
}

function modelMetadata(model: Record<string, unknown>): OpenCodeCapabilityReceipt["modelMetadata"] {
  const created = Number(model.created);
  const contextLength = Number(model.context_length);
  return {
    id: String(model.id ?? model.name ?? OPENCODE_ZEN_MODEL).slice(0, 100),
    object: model.object === undefined || model.object === null ? null : String(model.object).slice(0, 100),
    created: Number.isFinite(created) ? created : null,
    ownedBy: model.owned_by === undefined || model.owned_by === null ? null : String(model.owned_by).slice(0, 100),
    contextLength: Number.isFinite(contextLength) ? contextLength : null,
    inputModalities: safeStringArray(model.input_modalities),
    outputModalities: safeStringArray(model.output_modalities),
    pricingMetadataPresent: Boolean(model.pricing && typeof model.pricing === "object"),
  };
}

async function boundedResponseBody(response: Response): Promise<{ text: string; byteCount: number }> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, ODL_REQ_021_MAX_RESPONSE_BYTES)),
    byteCount: bytes.byteLength,
  };
}

function stageRequest(stage: CapabilityStage, fixtureBytes: Uint8Array): { endpoint: string; method: "GET" | "POST"; body: Record<string, unknown> | null; image: Uint8Array | null } {
  if (stage === "model_discovery") return { endpoint: OPENCODE_ZEN_MODELS_ENDPOINT, method: "GET", body: null, image: null };
  if (stage === "text_structured_output") {
    return {
      endpoint: OPENCODE_ZEN_ENDPOINT,
      method: "POST",
      image: null,
      body: {
        model: OPENCODE_ZEN_MODEL,
        messages: [{ role: "user", content: "Return exactly one JSON object with ok=true and probe=odl-req-021." }],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 100,
      },
    };
  }
  const dataUrl = `data:image/jpeg;base64,${bytesToBase64(fixtureBytes)}`;
  if (stage === "vision_unstructured") {
    return {
      endpoint: OPENCODE_ZEN_ENDPOINT,
      method: "POST",
      image: fixtureBytes,
      body: {
        model: OPENCODE_ZEN_MODEL,
        messages: [{ role: "user", content: [
          { type: "text", text: "Identify the blue square, red circle, and exact visible text in ordinary text." },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ] }],
        temperature: 0,
        max_tokens: 180,
      },
    };
  }
  return {
    endpoint: OPENCODE_ZEN_ENDPOINT,
    method: "POST",
    image: fixtureBytes,
    body: {
      model: OPENCODE_ZEN_MODEL,
      messages: [{ role: "user", content: [
        { type: "text", text: "Return JSON only with blue_shape, red_shape, visible_text, and capability_ready." },
        { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
      ] }],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 220,
    },
  };
}

function stageValidation(stage: CapabilityStage, body: Record<string, unknown>): { ok: boolean; parserResult: string; schemaValidationResult: string; model?: Record<string, unknown>; failureClass?: NormalizedResponseClass } {
  if (stage === "model_discovery") {
    const model = modelList(body).find((entry) => String(entry.id ?? entry.name ?? "") === OPENCODE_ZEN_MODEL);
    return model
      ? { ok: true, parserResult: "models_json_parsed", schemaValidationResult: "exact_model_present", model }
      : { ok: false, parserResult: "models_json_parsed", schemaValidationResult: "exact_model_missing", failureClass: "model_missing" };
  }
  const content = chatContent(body);
  if (!content) return { ok: false, parserResult: "chat_content_missing", schemaValidationResult: "not_validated", failureClass: "malformed_success_response" };
  if (stage === "text_structured_output") {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const ok = parsed.ok === true && parsed.probe === "odl-req-021";
      return { ok, parserResult: "json_parsed", schemaValidationResult: ok ? "valid" : "invalid", failureClass: ok ? undefined : "structured_output_failure" };
    } catch {
      return { ok: false, parserResult: "json_parse_failed", schemaValidationResult: "invalid", failureClass: "structured_output_failure" };
    }
  }
  const lower = content.toLocaleLowerCase("en");
  const visionOk = content.includes("UCA VISION PROBE 2047") && lower.includes("blue") && lower.includes("square") && lower.includes("red") && lower.includes("circle");
  if (stage === "vision_unstructured") {
    return { ok: visionOk, parserResult: "ordinary_text_observed", schemaValidationResult: visionOk ? "visual_fixture_matched" : "visual_fixture_mismatch", failureClass: visionOk ? undefined : "unsupported_media" };
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const structuredOk = visionOk
      || (String(parsed.blue_shape ?? "").toLocaleLowerCase("en").includes("square")
        && String(parsed.red_shape ?? "").toLocaleLowerCase("en").includes("circle")
        && String(parsed.visible_text ?? "").includes("UCA VISION PROBE 2047"));
    const ok = structuredOk && parsed.capability_ready !== false;
    return { ok, parserResult: "json_parsed", schemaValidationResult: ok ? "valid" : "invalid", failureClass: ok ? undefined : "structured_output_failure" };
  } catch {
    return { ok: false, parserResult: "json_parse_failed", schemaValidationResult: "invalid", failureClass: "structured_output_failure" };
  }
}

async function runOneProbe(input: {
  env: Env;
  jobId: string;
  stage: CapabilityStage;
  cycleNumber: number;
  attemptNumber: number;
  fixtureBytes: Uint8Array;
  nextRetryTimestamp: string | null;
}): Promise<ProbeResult> {
  const request = stageRequest(input.stage, input.fixtureBytes);
  const imageSha256 = request.image ? await sha256Bytes(request.image) : null;
  const requestFingerprint = await sha256HexUtf8(canonicalJson({
    version: 1,
    stage: input.stage,
    endpoint: request.endpoint,
    method: request.method,
    model: OPENCODE_ZEN_MODEL,
    body: request.body ? JSON.parse(JSON.stringify(request.body, (_key, value) => typeof value === "string" && value.startsWith("data:image/") ? `[image:${imageSha256}]` : value)) : null,
  }));
  const startedAt = nowIso();
  const started = Date.now();
  let status: number | null = null;
  let responseClass: NormalizedResponseClass = "unknown_provider_failure";
  let retryAfterSeconds: number | null = null;
  let providerRequestId: string | null = null;
  let edgeRequestId: string | null = null;
  let responseContentType: string | null = null;
  let responseByteCount: number | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let parserResult = "not_run";
  let schemaValidationResult = "not_run";
  let usage: CapabilityAttemptReceipt["usage"] = null;
  let model: Record<string, unknown> | undefined;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 45_000);
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${String(input.env.OPENCODE_ZEN_API_KEY ?? "")}`,
          ...(request.body ? { "Content-Type": "application/json" } : {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    status = response.status;
    retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    providerRequestId = (response.headers.get("x-request-id") ?? response.headers.get("request-id"))?.slice(0, 200) ?? null;
    edgeRequestId = response.headers.get("cf-ray")?.slice(0, 200) ?? null;
    responseContentType = response.headers.get("content-type")?.slice(0, 120) ?? null;
    const bounded = await boundedResponseBody(response);
    responseByteCount = bounded.byteCount;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = bounded.text ? JSON.parse(bounded.text) as Record<string, unknown> : {};
      parserResult = "response_json_parsed";
    } catch {
      parserResult = "response_json_parse_failed";
    }
    usage = usageFromBody(parsed);
    if (!response.ok) {
      const sanitized = sanitizeProviderError(parsed);
      errorCode = sanitized.code;
      errorMessage = sanitized.message;
      const modelMissing = status === 404 || /model.*(?:missing|not found|unavailable)/i.test(`${errorCode ?? ""} ${errorMessage ?? ""}`);
      responseClass = normalizedResponseClass(status, { modelMissing });
      schemaValidationResult = "not_applicable";
    } else {
      const validation = stageValidation(input.stage, parsed);
      parserResult = validation.parserResult;
      schemaValidationResult = validation.schemaValidationResult;
      model = validation.model;
      responseClass = validation.ok ? "success" : validation.failureClass ?? "unknown_provider_failure";
      if (!validation.ok) {
        errorCode = responseClass;
        errorMessage = `The ${input.stage} response did not satisfy the deterministic capability contract.`;
      }
    }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    responseClass = normalizedResponseClass(null, { timeout: timedOut, networkFailure: !timedOut });
    parserResult = timedOut ? "request_timed_out" : "network_request_failed";
    schemaValidationResult = "not_run";
    const sanitized = sanitizeProviderError({ code: responseClass, message: error instanceof Error ? error.message : String(error) });
    errorCode = sanitized.code;
    errorMessage = sanitized.message;
  }
  const retryable = responseClassRetryable(responseClass);
  const receipt: CapabilityAttemptReceipt = {
    version: 1,
    capabilityJobId: input.jobId,
    cycleNumber: input.cycleNumber,
    attemptNumber: input.attemptNumber,
    probeStage: input.stage,
    provider: "opencode_zen",
    mode: "opencode_chat_completions",
    exactModel: OPENCODE_ZEN_MODEL,
    endpointFamily: ODL_REQ_021_ENDPOINT_FAMILY,
    requestFingerprint,
    requestImageSha256: imageSha256,
    requestImageByteSize: request.image?.byteLength ?? null,
    requestImageMimeType: request.image ? "image/jpeg" : null,
    startedAt,
    completedAt: nowIso(),
    latencyMilliseconds: Date.now() - started,
    httpStatus: status,
    normalizedResponseClass: responseClass,
    retryable,
    retryAfterSeconds,
    providerRequestId,
    edgeRequestId,
    responseContentType,
    responseByteCount,
    sanitizedProviderErrorCode: errorCode,
    sanitizedProviderErrorMessage: errorMessage,
    parserResult,
    schemaValidationResult,
    usage,
    nextRetryTimestamp: retryable ? input.nextRetryTimestamp : null,
    terminalDisposition: responseClass === "success" ? "stage_passed" : retryable ? "retry_scheduled" : "terminal_failure",
  };
  return { receipt, modelMetadata: model ? modelMetadata(model) : undefined };
}

function stageOrder(): CapabilityStage[] {
  return ["model_discovery", "text_structured_output", "vision_unstructured", "vision_structured_output"];
}

function firstIncompleteStage(manifest: CapabilityJobManifest): CapabilityStage | null {
  return stageOrder().find((stage) => manifest.stageResults[stage] !== "passed") ?? null;
}

function distribution<T extends string>(values: T[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

export function preciseBlocker(attempts: CapabilityAttemptReceipt[]): string {
  const classes = new Set(attempts.filter((entry) => entry.normalizedResponseClass !== "success").map((entry) => entry.normalizedResponseClass));
  if (classes.size === 1 && classes.has("rate_limited")) return "provider_rate_limited";
  if (classes.size === 1 && classes.has("provider_server_error")) return "provider_server_unavailable";
  if ([...classes].every((value) => value === "network_failure" || value === "timeout")) return "provider_network_unavailable";
  if (classes.has("unsupported_media")) return "provider_multimodal_unsupported";
  if (classes.has("structured_output_failure")) return "provider_structured_output_unsupported";
  if ([...classes].some((value) => responseClassRetryable(value)) && classes.size > 1) return "provider_mixed_transient_failures";
  if (classes.has("authentication_failed")) return "provider_authentication_failed";
  if (classes.has("authorization_failed")) return "provider_authorization_failed";
  if (classes.has("model_missing")) return "provider_model_missing";
  if (classes.has("invalid_request")) return "provider_invalid_request";
  return "provider_unknown_failure";
}

function terminalReceipt(manifest: CapabilityJobManifest, status: "passed" | "failed", reason: string): CapabilityTerminalReceipt {
  const completedAt = nowIso();
  const statusValues = manifest.attempts.map((entry) => entry.httpStatus === null ? "none" : String(entry.httpStatus));
  const classValues = manifest.attempts.map((entry) => entry.normalizedResponseClass);
  const byStage = Object.fromEntries(stageOrder().map((stage) => [stage, manifest.attempts.filter((entry) => entry.probeStage === stage).length])) as Record<CapabilityStage, number>;
  return {
    version: 1,
    capabilityJobId: manifest.jobId,
    provider: "opencode_zen",
    mode: "opencode_chat_completions",
    exactModel: OPENCODE_ZEN_MODEL,
    probeVersion: ODL_REQ_021_PROBE_VERSION,
    endpointFamily: ODL_REQ_021_ENDPOINT_FAMILY,
    status,
    startedAt: manifest.createdAt,
    completedAt,
    totalElapsedMilliseconds: Math.max(0, Date.parse(completedAt) - Date.parse(manifest.createdAt)),
    attemptCountByStage: byStage,
    httpStatusDistribution: distribution(statusValues),
    responseClassDistribution: distribution(classValues),
    anySuccessfulHttpResponse: manifest.attempts.some((entry) => entry.httpStatus !== null && entry.httpStatus >= 200 && entry.httpStatus < 300),
    modelDiscoveryWorked: manifest.stageResults.model_discovery === "passed",
    textTransportWorked: manifest.stageResults.text_structured_output === "passed",
    visionWorked: manifest.stageResults.vision_unstructured === "passed" || manifest.stageResults.vision_structured_output === "passed",
    structuredOutputWorked: manifest.stageResults.text_structured_output === "passed" && manifest.stageResults.vision_structured_output === "passed",
    finalRetryability: status === "failed" && Boolean(manifest.attempts.at(-1)?.retryable),
    finalReasonForStopping: reason,
    blockerClassification: status === "passed" ? null : preciseBlocker(manifest.attempts),
    stageResults: { ...manifest.stageResults },
    attempts: manifest.attempts,
  };
}

async function persistLegacyCapabilityReceipt(env: Env, manifest: CapabilityJobManifest): Promise<void> {
  const vision = [...manifest.attempts].reverse().find((entry) => entry.probeStage === "vision_structured_output" && entry.normalizedResponseClass === "success")
    ?? [...manifest.attempts].reverse().find((entry) => entry.probeStage === "vision_unstructured" && entry.normalizedResponseClass === "success");
  const usage = vision?.usage;
  const receipt: OpenCodeCapabilityReceipt = {
    provider: "opencode_zen",
    model: OPENCODE_ZEN_MODEL,
    endpointFamily: ODL_REQ_021_ENDPOINT_FAMILY,
    discoveryTimestamp: nowIso(),
    discoveryCacheHit: false,
    modelPresent: true,
    modelMetadata: manifest.modelMetadata ?? {
      id: OPENCODE_ZEN_MODEL, object: null, created: null, ownedBy: null, contextLength: null,
      inputModalities: [], outputModalities: [], pricingMetadataPresent: false,
    },
    visionProbe: {
      passed: true,
      status: vision?.httpStatus ?? 200,
      latencyMilliseconds: vision?.latencyMilliseconds ?? 0,
      exactTextObserved: true,
      blueSquareObserved: true,
      redCircleObserved: true,
      detailFieldAccepted: true,
      sanitizedUsage: {
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
      },
    },
    structuredOutput: { responseFormatAccepted: true, jsonObjectReliable: true },
    costClassification: "provider_reported_unknown_or_free_model_id",
  };
  await storeJson(env, LEGACY_CAPABILITY_KEY, receipt, {
    provider: receipt.provider,
    model: receipt.model,
    discoveryTimestamp: receipt.discoveryTimestamp,
    visionProbePassed: "true",
    probeVersion: ODL_REQ_021_PROBE_VERSION,
  });
}

async function updateCoordinatorJob(env: Env, userId: string, jobId: string, patch: Partial<PaidJobRecord>): Promise<void> {
  await coordinatorRequest(env, userId, "/jobs/update", { jobId, ...patch });
}

export async function runVisualClassifierCapabilityWorkflow(
  env: Env,
  payload: VisualWorkflowPayload,
  step: WorkflowStep,
): Promise<Record<string, unknown>> {
  const input = payload.input as unknown as CapabilityPayloadInput;
  if (!input.__odlReq021Capability) throw new ConnectorError("capability_payload_invalid", "The capability workflow payload is invalid.");
  let manifest = await readJsonIfPresent<CapabilityJobManifest>(env, capabilityManifestKey(payload.jobId));
  if (!manifest) {
    manifest = {
      version: 1,
      jobId: payload.jobId,
      workflowId: payload.workflowId,
      userIdHash: await sha256HexUtf8(payload.userId),
      status: "running",
      currentStage: "model_discovery",
      cycleNumber: 1,
      attemptNumber: 0,
      nextScheduledAttempt: null,
      forceFresh: Boolean(input.forceFresh),
      provider: "opencode_zen",
      mode: "opencode_chat_completions",
      model: OPENCODE_ZEN_MODEL,
      probeVersion: ODL_REQ_021_PROBE_VERSION,
      stageResults: { model_discovery: "not_run", text_structured_output: "not_run", vision_unstructured: "not_run", vision_structured_output: "not_run" },
      modelMetadata: null,
      attempts: [],
      terminalReceipt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }
  manifest.status = "running";
  await writeCapabilityManifest(env, manifest);
  await updateCoordinatorJob(env, payload.userId, payload.jobId, { status: "running", progress: 1, stage: manifest.currentStage });
  const fixtureBytes = syntheticVisionProbeJpegBytes();
  for (let cycle = Math.max(1, manifest.cycleNumber); cycle <= ODL_REQ_021_MAX_CYCLES; cycle += 1) {
    manifest.cycleNumber = cycle;
    const stage = firstIncompleteStage(manifest);
    if (!stage) break;
    manifest.currentStage = stage;
    manifest.attemptNumber += 1;
    const baseDelay = ODL_REQ_021_RETRY_DELAYS_SECONDS[Math.min(cycle, ODL_REQ_021_RETRY_DELAYS_SECONDS.length - 1)] ?? ODL_REQ_021_MAX_RETRY_DELAY_SECONDS;
    const provisionalNext = new Date(Date.now() + baseDelay * 1000).toISOString();
    const result = await step.do(
      `capability cycle ${String(cycle).padStart(2, "0")} ${stage}`,
      { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" },
      async () => runOneProbe({
        env,
        jobId: payload.jobId,
        stage,
        cycleNumber: cycle,
        attemptNumber: manifest?.attemptNumber ?? 1,
        fixtureBytes,
        nextRetryTimestamp: provisionalNext,
      }),
    );
    const receipt = result.receipt;
    if (result.modelMetadata) manifest.modelMetadata = result.modelMetadata;
    manifest.attempts.push(receipt);
    const persistAttemptReceipt = async (): Promise<void> => storeJson(env, capabilityAttemptKey(payload.jobId, receipt.attemptNumber, stage), receipt, {
      jobId: payload.jobId,
      stage,
      attemptNumber: String(receipt.attemptNumber),
      responseClass: receipt.normalizedResponseClass,
      httpStatus: receipt.httpStatus === null ? "none" : String(receipt.httpStatus),
    });
    if (receipt.normalizedResponseClass === "success") {
      await persistAttemptReceipt();
      manifest.stageResults[stage] = "passed";
      manifest.nextScheduledAttempt = null;
      const nextStage = firstIncompleteStage(manifest);
      if (nextStage) {
        manifest.currentStage = nextStage;
        await writeCapabilityManifest(env, manifest);
        await updateCoordinatorJob(env, payload.userId, payload.jobId, { status: "running", progress: Math.min(90, 10 + stageOrder().filter((value) => manifest?.stageResults[value] === "passed").length * 20), stage: nextStage });
        cycle -= 1;
        continue;
      }
      break;
    }
    manifest.stageResults[stage] = "failed";
    const elapsed = Date.now() - Date.parse(manifest.createdAt);
    const canRetry = receipt.retryable && cycle < ODL_REQ_021_MAX_CYCLES && elapsed < ODL_REQ_021_MAX_ELAPSED_MS;
    if (!canRetry) {
      receipt.terminalDisposition = "terminal_failure";
      receipt.nextRetryTimestamp = null;
      await persistAttemptReceipt();
      manifest.status = "failed";
      manifest.nextScheduledAttempt = null;
      manifest.terminalReceipt = terminalReceipt(manifest, "failed", receipt.retryable ? "bounded_retry_schedule_exhausted" : `non_retryable_${receipt.normalizedResponseClass}`);
      await writeCapabilityManifest(env, manifest);
      await updateCoordinatorJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: { code: manifest.terminalReceipt.blockerClassification ?? "provider_capability_failed", message: manifest.terminalReceipt.finalReasonForStopping, retryable: false } });
      return manifest.terminalReceipt as unknown as Record<string, unknown>;
    }
    const requested = receipt.retryAfterSeconds ?? 0;
    const delaySeconds = Math.min(ODL_REQ_021_MAX_RETRY_DELAY_SECONDS, Math.max(baseDelay, requested));
    if (elapsed + delaySeconds * 1000 > ODL_REQ_021_MAX_ELAPSED_MS) {
      receipt.terminalDisposition = "terminal_failure";
      receipt.nextRetryTimestamp = null;
      await persistAttemptReceipt();
      manifest.status = "failed";
      manifest.nextScheduledAttempt = null;
      manifest.terminalReceipt = terminalReceipt(manifest, "failed", "four_hour_elapsed_limit_reached");
      await writeCapabilityManifest(env, manifest);
      await updateCoordinatorJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: { code: manifest.terminalReceipt.blockerClassification ?? "provider_capability_failed", message: manifest.terminalReceipt.finalReasonForStopping, retryable: false } });
      return manifest.terminalReceipt as unknown as Record<string, unknown>;
    }
    manifest.status = "retry_wait";
    manifest.nextScheduledAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    receipt.nextRetryTimestamp = manifest.nextScheduledAttempt;
    receipt.terminalDisposition = "retry_scheduled";
    await persistAttemptReceipt();
    await writeCapabilityManifest(env, manifest);
    await updateCoordinatorJob(env, payload.userId, payload.jobId, { status: "running", progress: Math.min(85, 5 + cycle * 12), stage: `retry_wait_${stage}_${cycle}` });
    await step.sleep(`capability retry wait ${String(cycle).padStart(2, "0")} ${stage}`, `${delaySeconds} seconds`);
    manifest.status = "running";
    manifest.stageResults[stage] = "not_run";
  }
  if (firstIncompleteStage(manifest)) {
    manifest.status = "failed";
    manifest.terminalReceipt = terminalReceipt(manifest, "failed", "bounded_retry_schedule_exhausted");
    await writeCapabilityManifest(env, manifest);
    await updateCoordinatorJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: { code: manifest.terminalReceipt.blockerClassification ?? "provider_capability_failed", message: manifest.terminalReceipt.finalReasonForStopping, retryable: false } });
    return manifest.terminalReceipt as unknown as Record<string, unknown>;
  }
  manifest.status = "completed";
  manifest.nextScheduledAttempt = null;
  manifest.terminalReceipt = terminalReceipt(manifest, "passed", "all_four_mandatory_stages_passed");
  await persistLegacyCapabilityReceipt(env, manifest);
  await writeCapabilityManifest(env, manifest);
  await updateCoordinatorJob(env, payload.userId, payload.jobId, { status: "completed", progress: 100, stage: "completed", error: null });
  return manifest.terminalReceipt as unknown as Record<string, unknown>;
}

export function isCapabilityWorkflowPayload(payload: VisualWorkflowPayload): boolean {
  return Boolean((payload.input as Record<string, unknown> | undefined)?.__odlReq021Capability);
}

export async function readSuccessfulCapabilityReceipt(env: Env): Promise<CapabilityTerminalReceipt | null> {
  const index = await readJsonIfPresent<CapabilityIndex>(env, CAPABILITY_INDEX_KEY);
  if (!index) return null;
  const manifest = await readJsonIfPresent<CapabilityJobManifest>(env, capabilityManifestKey(index.jobId));
  const receipt = manifest?.terminalReceipt ?? null;
  if (!receipt || receipt.status !== "passed") return null;
  if (receipt.probeVersion !== ODL_REQ_021_PROBE_VERSION) return null;
  if (Date.now() - Date.parse(receipt.completedAt) > ODL_REQ_021_RECEIPT_TTL_MS) return null;
  return receipt;
}

async function compilerInventory(env: Env, manifest: CompilerJobManifest): Promise<CandidateInventory> {
  if (!manifest.candidatesKey) throw new ConnectorError("candidate_inventory_missing", "The job has no durable candidate inventory.");
  const inventory = await readJson<CandidateInventory>(env, manifest.candidatesKey);
  if (!Array.isArray(inventory.candidates)) throw new ConnectorError("candidate_inventory_invalid", "The durable candidate inventory is invalid.");
  return inventory;
}

async function resolveCandidateArtifact(env: Env, manifest: CompilerJobManifest, candidate: VisualCandidate): Promise<{ bytes: Uint8Array; mimeType: string; artifact: RenderArtifactManifest | null }> {
  if (!manifest.source) throw new ConnectorError("source_identity_missing", "The compiler source identity is unavailable.");
  if (!candidate.renderRequired && candidate.embeddedArtifactKey) {
    const object = await getArtifact(env, candidate.embeddedArtifactKey);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const hash = await sha256Bytes(bytes);
    if (candidate.embeddedSha256 && hash !== candidate.embeddedSha256) throw new ConnectorError("cache_artifact_corrupt", "The cached embedded artifact failed hash verification.");
    return { bytes, mimeType: object.httpMetadata?.contentType ?? "image/jpeg", artifact: null };
  }
  const format = manifest.input.renderFormat ?? "png";
  const width = Math.min(Math.max(Number(manifest.input.renderWidth ?? 1600), 256), 4096);
  const dpi = Math.min(Math.max(Number(manifest.input.renderDpi ?? 144), 36), 300);
  const identity = await renderCacheIdentity({
    sourceSha256: manifest.source.sha256,
    stableKey: candidate.stableKey,
    outputFormat: format,
    width,
    dpi,
    crop: null,
    rendererVersion: VISUAL_RENDERER_VERSION,
  });
  const manifestKey = `${identity.r2Key}.manifest.json`;
  if (!await env.ARTIFACTS.head(identity.r2Key)) throw new ConnectorError("cache_artifact_missing", "The verified private render-cache object is missing.");
  if (!await env.ARTIFACTS.head(manifestKey)) throw new ConnectorError("render_manifest_missing", "The render artifact manifest is missing.");
  const artifact = await readJson<RenderArtifactManifest>(env, manifestKey);
  if (artifact.renderArtifactId !== identity.renderArtifactId || artifact.cacheKey !== identity.fingerprint || artifact.r2Key !== identity.r2Key) {
    throw new ConnectorError("cache_binding_mismatch", "The page-to-artifact cache binding is invalid.");
  }
  if (!SHA256.test(artifact.sha256) || artifact.byteSize <= 0 || artifact.width <= 0 || artifact.height <= 0) {
    throw new ConnectorError("cache_manifest_invalid", "The render artifact manifest has invalid integrity fields.");
  }
  const object = await getArtifact(env, identity.r2Key);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const hash = await sha256Bytes(bytes);
  if (hash !== artifact.sha256 || bytes.byteLength !== artifact.byteSize) throw new ConnectorError("cache_artifact_corrupt", "The cached page render failed exact integrity verification.");
  return { bytes, mimeType: artifact.mimeType, artifact };
}

export async function inspectVisualRenderCache(env: Env, jobId: string): Promise<Record<string, unknown>> {
  const manifest = await readCompilerManifest(env, jobId);
  const inventory = await compilerInventory(env, manifest);
  const results: Array<Record<string, unknown>> = [];
  for (const candidate of inventory.candidates) {
    try {
      const resolved = await resolveCandidateArtifact(env, manifest, candidate);
      results.push({
        stableVisualId: candidate.stableVisualId,
        stableKey: candidate.stableKey,
        pageOrSlide: candidate.pageOrSlide,
        status: "verified",
        sha256: resolved.artifact?.sha256 ?? candidate.embeddedSha256 ?? await sha256Bytes(resolved.bytes),
        byteSize: resolved.bytes.byteLength,
        width: resolved.artifact?.width ?? null,
        height: resolved.artifact?.height ?? null,
      });
    } catch (error) {
      const value = error as { code?: string; message?: string };
      results.push({ stableVisualId: candidate.stableVisualId, stableKey: candidate.stableKey, pageOrSlide: candidate.pageOrSlide, status: "invalid", error: { code: value.code ?? "cache_verification_failed", message: value.message ?? "Cache verification failed." } });
    }
  }
  const verified = results.filter((entry) => entry.status === "verified").length;
  return {
    jobId,
    source: manifest.source,
    candidateCount: inventory.candidates.length,
    verified,
    invalid: results.length - verified,
    cacheIntegrityPassed: verified === results.length,
    rendererVersion: VISUAL_RENDERER_VERSION,
    sourceRerendered: false,
    oneDriveMutationPerformed: false,
    results,
  };
}

async function candidateImage(env: Env, bytes: Uint8Array, mimeType: string, maxDimension: number, detail: "auto" | "low" | "high"): Promise<{ data: string; mimeType: string }> {
  const bound = detail === "low" ? Math.min(maxDimension, 1024) : maxDimension;
  const transformed = (env.IMAGES as any).input(new Blob([bytes.slice().buffer], { type: mimeType }).stream()).transform({ width: bound, height: bound, fit: "scale-down" });
  const output = await transformed.output({ format: "image/jpeg", quality: detail === "high" ? 92 : 88, anim: false });
  const response = output.response();
  if (!response.ok) throw new ConnectorError("candidate_analysis_render_failed", "The private cached candidate could not be prepared for analysis.", { retryable: true });
  return { data: bytesToBase64(new Uint8Array(await response.arrayBuffer())), mimeType: "image/jpeg" };
}

function tool(server: McpServer, name: string): any {
  return (server as any)._registeredTools?.[name];
}

function capabilityInputIsOpenCode(raw: Record<string, unknown>): boolean {
  return raw.classifierProvider === "opencode_zen" || raw.classifierMode === "opencode_chat_completions"
    || raw.classifierProvider === OPENCODE_GO_PROVIDER || raw.classifierMode === OPENCODE_GO_MODE;
}

export function registerODLReq021Tools(server: McpServer, contextFactory: () => HotfixContext): void {
  if (!tool(server, "start_visual_classifier_capability_job")) {
    server.registerTool("start_visual_classifier_capability_job", {
      title: "Start durable visual classifier capability job",
      description: "Reserve and start a non-mutating four-stage OpenCode Zen capability job with durable sanitized attempt receipts and delayed retries.",
      inputSchema: {
        provider: z.enum(["opencode_zen", "opencode_go"]).default("opencode_zen"),
        mode: z.enum(["opencode_chat_completions", "opencode_go_chat_completions"]).default("opencode_chat_completions"),
        model: z.string().min(1).max(100).default(OPENCODE_ZEN_MODEL),
        forceFresh: z.boolean().default(false),
        maxBillableRequests: z.number().int().min(1).max(75).optional(),
        maxEstimatedSpendUsd: z.number().positive().max(1).optional(),
      },
      annotations: NON_DESTRUCTIVE,
    }, async (raw) => {
      const context = contextFactory();
      try {
        if (raw.provider === OPENCODE_GO_PROVIDER || raw.mode === OPENCODE_GO_MODE) {
          return await startOpenCodeGoCapabilityJob(context, raw);
        }
        const forceFresh = Boolean(raw.forceFresh);
        if (raw.provider !== "opencode_zen" || raw.mode !== "opencode_chat_completions" || raw.model !== OPENCODE_ZEN_MODEL) {
          throw new ConnectorError("classifier_configuration_invalid", "OpenCode Zen capability jobs require the exact free provider, mode, and model identity.");
        }
        if (!String(context.env.OPENCODE_ZEN_API_KEY ?? "")) throw new ConnectorError("provider_secret_missing", "OPENCODE_ZEN_API_KEY is not configured.");
        const index = await readJsonIfPresent<CapabilityIndex>(context.env, CAPABILITY_INDEX_KEY);
        if (index) {
          const existing = await readJsonIfPresent<CapabilityJobManifest>(context.env, capabilityManifestKey(index.jobId));
          if (existing && ["reserved", "running", "retry_wait"].includes(existing.status)) {
            return textResult({ jobId: existing.jobId, workflowId: existing.workflowId, status: existing.status, currentStage: existing.currentStage, nextScheduledAttempt: existing.nextScheduledAttempt, idempotentReplay: true, oneDriveMutationPerformed: false, recommendedNextOperation: "get_visual_classifier_capability_job" });
          }
          if (!forceFresh && existing?.terminalReceipt?.status === "passed" && Date.now() - Date.parse(existing.terminalReceipt.completedAt) <= ODL_REQ_021_RECEIPT_TTL_MS) {
            return textResult({ jobId: existing.jobId, workflowId: existing.workflowId, status: existing.status, currentStage: existing.currentStage, terminalReceipt: existing.terminalReceipt, idempotentReplay: true, oneDriveMutationPerformed: false, recommendedNextOperation: "get_visual_classifier_capability_job" });
          }
        }
        const reservationInput = { provider: "opencode_zen", mode: "opencode_chat_completions", model: OPENCODE_ZEN_MODEL, probeVersion: ODL_REQ_021_PROBE_VERSION, forceFresh: Boolean(forceFresh), forceNonce: forceFresh ? crypto.randomUUID() : null };
        const hash = await requestHash("start_visual_classifier_capability_job", reservationInput);
        const requestedJobId = crypto.randomUUID();
        const job = await coordinatorRequest<PaidJobRecord>(context.env, context.userId, "/jobs/begin", {
          jobId: requestedJobId,
          workflowId: requestedJobId,
          toolName: "start_visual_classifier_capability_job",
          requestHash: hash,
        });
        const manifest: CapabilityJobManifest = {
          version: 1,
          jobId: job.jobId,
          workflowId: job.workflowId,
          userIdHash: await sha256HexUtf8(context.userId),
          status: "reserved",
          currentStage: "model_discovery",
          cycleNumber: 1,
          attemptNumber: 0,
          nextScheduledAttempt: null,
          forceFresh: Boolean(forceFresh),
          provider: "opencode_zen",
          mode: "opencode_chat_completions",
          model: OPENCODE_ZEN_MODEL,
          probeVersion: ODL_REQ_021_PROBE_VERSION,
          stageResults: { model_discovery: "not_run", text_structured_output: "not_run", vision_unstructured: "not_run", vision_structured_output: "not_run" },
          modelMetadata: null,
          attempts: [],
          terminalReceipt: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        await writeCapabilityManifest(context.env, manifest);
        const payload: VisualWorkflowPayload = {
          version: 1,
          operation: "compile",
          jobId: job.jobId,
          workflowId: job.workflowId,
          userId: context.userId,
          requestHash: hash,
          input: { __odlReq021Capability: true, forceFresh: Boolean(forceFresh) },
          createdAt: nowIso(),
        };
        try {
          await (context.env.VISUAL_CATALOGUE_WORKFLOW as any).create({ id: job.workflowId, params: payload });
        } catch (error) {
          const message = error instanceof Error ? error.message.toLocaleLowerCase("en") : String(error).toLocaleLowerCase("en");
          if (!/already exists|duplicate|conflict/.test(message)) throw error;
        }
        return textResult({
          jobId: job.jobId,
          workflowId: job.workflowId,
          status: job.status,
          currentStage: "model_discovery",
          asynchronous: true,
          delayedRetriesDurable: true,
          longRunningRequestHeldOpen: false,
          idempotentReplay: job.jobId !== requestedJobId,
          provider: "opencode_zen",
          mode: "opencode_chat_completions",
          model: OPENCODE_ZEN_MODEL,
          probeVersion: ODL_REQ_021_PROBE_VERSION,
          oneDriveMutationPerformed: false,
          recommendedNextOperation: "get_visual_classifier_capability_job",
        });
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  if (!tool(server, "get_visual_classifier_capability_job")) {
    server.registerTool("get_visual_classifier_capability_job", {
      title: "Get durable visual classifier capability job",
      description: "Return the current stage, sanitized attempt history, delayed retry schedule, and exact terminal capability receipt.",
      inputSchema: { jobId: UUID },
      annotations: READ_ONLY,
    }, async ({ jobId }) => {
      const context = contextFactory();
      try {
        const goResult = await getOpenCodeGoCapabilityJob(context, jobId);
        if (goResult) return goResult;
        const job = await coordinatorRequest<PaidJobRecord | null>(context.env, context.userId, "/jobs/get", { jobId });
        if (!job) throw new ConnectorError("job_not_found", "The capability job was not found.");
        const manifest = await readJson<CapabilityJobManifest>(context.env, capabilityManifestKey(jobId));
        return textResult({
          jobId,
          workflowId: manifest.workflowId,
          status: manifest.status,
          currentStage: manifest.currentStage,
          cycleNumber: manifest.cycleNumber,
          nextScheduledAttempt: manifest.nextScheduledAttempt,
          stageResults: manifest.stageResults,
          attemptHistorySummary: manifest.attempts.map((entry) => ({
            attemptNumber: entry.attemptNumber,
            cycleNumber: entry.cycleNumber,
            stage: entry.probeStage,
            httpStatus: entry.httpStatus,
            responseClass: entry.normalizedResponseClass,
            retryable: entry.retryable,
            retryAfterSeconds: entry.retryAfterSeconds,
            nextRetryTimestamp: entry.nextRetryTimestamp,
            latencyMilliseconds: entry.latencyMilliseconds,
            providerRequestId: entry.providerRequestId,
            edgeRequestId: entry.edgeRequestId,
            parserResult: entry.parserResult,
            schemaValidationResult: entry.schemaValidationResult,
            terminalDisposition: entry.terminalDisposition,
          })),
          terminalReceipt: manifest.terminalReceipt,
          privateUrlsReturned: false,
          secretValuesReturned: false,
          oneDriveMutationPerformed: false,
        });
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  if (!tool(server, "inspect_visual_catalogue_render_cache")) {
    server.registerTool("inspect_visual_catalogue_render_cache", {
      title: "Inspect visual catalogue render cache",
      description: "Verify exact page-to-artifact bindings, hashes, byte sizes, and nonzero dimensions without rerendering or mutating OneDrive.",
      inputSchema: { jobId: UUID },
      annotations: READ_ONLY,
    }, async ({ jobId }) => {
      const context = contextFactory();
      try {
        return textResult(await inspectVisualRenderCache(context.env, jobId));
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  const existingStart = tool(server, "start_visual_catalogue_job");
  if (existingStart?.handler && !existingStart.__odlReq021CapabilityGate) {
    const previous = existingStart.handler;
    existingStart.handler = async (raw: Record<string, unknown>, extra: unknown) => {
      const context = contextFactory();
      if (capabilityInputIsOpenCode(raw)) {
        try {
          if (raw.allowPaidFallback === true) throw new ConnectorError("paid_fallback_forbidden", "Automatic provider fallback remains disabled.");
          if (raw.classifierProvider === OPENCODE_GO_PROVIDER || raw.classifierMode === OPENCODE_GO_MODE) {
            if (String(raw.model ?? OPENCODE_GO_MODEL) !== OPENCODE_GO_MODEL) throw new ConnectorError("provider_model_not_allowed", `The exact model ${OPENCODE_GO_MODEL} is required for OpenCode Go.`);
            const receipt = await readSuccessfulOpenCodeGoCapabilityReceipt(context.env, {
              maxBillableRequests: Number(raw.maxBillableRequests),
              maxEstimatedSpendUsd: Number(raw.maxEstimatedSpendUsd),
            });
            if (!receipt) throw new ConnectorError("provider_capability_receipt_required", "A successful, unexpired ODL-REQ-022 OpenCode Go capability receipt with the exact credential and budget identity is required before candidate classification.");
          } else {
            const receipt = await readSuccessfulCapabilityReceipt(context.env);
            if (!receipt) throw new ConnectorError("provider_capability_receipt_required", `A successful, unexpired ${ODL_REQ_021_PROBE_VERSION} capability receipt is required before OpenCode candidate classification.`);
            if (String(raw.model ?? OPENCODE_ZEN_MODEL) !== OPENCODE_ZEN_MODEL) throw new ConnectorError("provider_model_not_allowed", `The exact model ${OPENCODE_ZEN_MODEL} is required.`);
          }
        } catch (error) {
          return errorResult(error);
        }
      }
      return previous(raw, extra);
    };
    existingStart.__odlReq021CapabilityGate = true;
  }

  const existingFetch = tool(server, "fetch_visual_catalogue_candidate_for_analysis");
  if (existingFetch && !existingFetch.__odlReq021CacheFetch) {
    existingFetch.handler = async ({ jobId, candidateId, maxDimension = 2000, detail = "auto", includeAdjacentSeriesMembers = false }: {
      jobId: string;
      candidateId: string;
      maxDimension?: number;
      detail?: "auto" | "low" | "high";
      includeAdjacentSeriesMembers?: boolean;
    }) => {
      const context = contextFactory();
      try {
        const manifest = await readCompilerManifest(context.env, jobId);
        const inventory = await compilerInventory(context.env, manifest);
        const selected = inventory.candidates.find((candidate) => candidate.stableVisualId === candidateId || candidate.stableKey === candidateId);
        if (!selected) throw new ConnectorError("candidate_not_found", "The candidate does not belong to this visual catalogue job inventory.");
        const members = includeAdjacentSeriesMembers && selected.pageOrSlide !== null
          ? inventory.candidates.filter((candidate) => candidate.pageOrSlide !== null && Math.abs(Number(candidate.pageOrSlide) - Number(selected.pageOrSlide)) <= 1).slice(0, 4)
          : [selected];
        const metadata: Array<Record<string, unknown>> = [];
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        for (const candidate of members) {
          const resolved = await resolveCandidateArtifact(context.env, manifest, candidate);
          metadata.push({
            stableVisualId: candidate.stableVisualId,
            stableKey: candidate.stableKey,
            pageOrSlide: candidate.pageOrSlide,
            renderArtifactId: resolved.artifact?.renderArtifactId ?? candidate.embeddedArtifactId,
            sha256: resolved.artifact?.sha256 ?? candidate.embeddedSha256 ?? await sha256Bytes(resolved.bytes),
            byteSize: resolved.bytes.byteLength,
            width: resolved.artifact?.width ?? null,
            height: resolved.artifact?.height ?? null,
            classifierResultRequired: false,
          });
          content.push({ type: "image", ...(await candidateImage(context.env, resolved.bytes, resolved.mimeType, maxDimension, detail)) });
        }
        const auditId = crypto.randomUUID();
        const summary = {
          jobId,
          requestedCandidateId: candidateId,
          returnedCandidates: metadata,
          auditId,
          resolvedFrom: "job_inventory_and_verified_render_cache",
          classifierResultRequired: false,
          privateCacheOnly: true,
          privateUrlsReturned: false,
          sourceBytesReturned: false,
          bearerTokensReturned: false,
          oneDriveMutationPerformed: false,
        };
        await storeJson(context.env, `visual-compiler/jobs/${jobId}/review-audit/${auditId}.json`, summary, { jobId, candidateId, auditId });
        content.unshift({ type: "text", text: JSON.stringify(summary, null, 2) });
        return { structuredContent: summary, content };
      } catch (error) {
        return errorResult(error);
      }
    };
    existingFetch.__odlReq021CacheFetch = true;
  }
}

export function makeODLReq021Context(env: Env, userId: string): HotfixContext {
  return { env, userId, storage: createIntegratedStateStorage(env, userId) };
}
