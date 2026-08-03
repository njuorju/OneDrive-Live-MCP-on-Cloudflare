import type { WorkflowStep } from "cloudflare:workers";
import { ConnectorError } from "./errors";
import { bytesToBase64, sha256Bytes } from "./integrated-core";
import {
  canonicalJson,
  coordinatorRequest,
  errorResult,
  nowIso,
  putArtifact,
  requestHash,
  sha256HexUtf8,
  textResult,
  type PaidJobRecord,
} from "./paid-core";
import type { HotfixContext } from "./version20-hotfix";
import {
  normalizedResponseClass,
  parseRetryAfterSeconds,
  responseClassRetryable,
  sanitizeProviderError,
  type CapabilityStage,
  type NormalizedResponseClass,
} from "./visual-classifier-capability-common";
import {
  ODL_REQ_022_GO_PROBE_VERSION,
  OPENCODE_GO_CHAT_ENDPOINT,
  OPENCODE_GO_ENDPOINT_FAMILY,
  OPENCODE_GO_MODE,
  OPENCODE_GO_MODEL,
  OPENCODE_GO_MODELS_ENDPOINT,
  OPENCODE_GO_PROVIDER,
  assertOpenCodeGoBudgetAvailable,
  initializeOpenCodeGoSpendLedger,
  openCodeGoCredentialValue,
  parseOpenCodeGoUsage,
  readOpenCodeGoSpendLedger,
  recordOpenCodeGoAccounting,
  resolveOpenCodeGoPricing,
  selectOpenCodeGoCredentialBinding,
  updateOpenCodeGoPricing,
  validateOpenCodeGoBudgets,
  writeOpenCodeGoCapabilityCache,
  type OpenCodeGoCapabilityReceipt,
  type OpenCodeGoCredentialBindingName,
  type OpenCodeGoSpendLedger,
  type OpenCodeGoUsage,
} from "./visual-catalogue-opencode-go";
import { syntheticVisionProbeJpegBytes } from "./visual-catalogue-probe-fixture";

export const ODL_REQ_022_GO_MAX_CYCLES = 6;
export const ODL_REQ_022_GO_MAX_ELAPSED_MS = 4 * 60 * 60 * 1000;
export const ODL_REQ_022_GO_RECEIPT_TTL_MS = 60 * 60 * 1000;
export const ODL_REQ_022_GO_RETRY_DELAYS_SECONDS = [0, 120, 600, 1800, 3600, 7200] as const;
export const ODL_REQ_022_GO_MAX_RETRY_DELAY_SECONDS = 7200;
const MAX_RESPONSE_BYTES = 64 * 1024;

type StageResult = "passed" | "failed" | "not_run";

export type OpenCodeGoCapabilityAttemptReceipt = {
  version: 1;
  capabilityJobId: string;
  cycleNumber: number;
  attemptNumber: number;
  probeStage: CapabilityStage;
  provider: typeof OPENCODE_GO_PROVIDER;
  mode: typeof OPENCODE_GO_MODE;
  exactModel: typeof OPENCODE_GO_MODEL;
  endpointFamily: typeof OPENCODE_GO_ENDPOINT_FAMILY;
  probeVersion: typeof ODL_REQ_022_GO_PROBE_VERSION;
  credentialBindingName: OpenCodeGoCredentialBindingName;
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
  usage: OpenCodeGoUsage | null;
  accounting: OpenCodeGoSpendLedger;
  nextRetryTimestamp: string | null;
  terminalDisposition: "stage_passed" | "retry_scheduled" | "terminal_failure";
};

export type OpenCodeGoCapabilityTerminalReceipt = {
  version: 1;
  capabilityJobId: string;
  provider: typeof OPENCODE_GO_PROVIDER;
  mode: typeof OPENCODE_GO_MODE;
  exactModel: typeof OPENCODE_GO_MODEL;
  probeVersion: typeof ODL_REQ_022_GO_PROBE_VERSION;
  endpointFamily: typeof OPENCODE_GO_ENDPOINT_FAMILY;
  credentialBindingName: OpenCodeGoCredentialBindingName;
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
  stageResults: Record<CapabilityStage, StageResult>;
  attempts: OpenCodeGoCapabilityAttemptReceipt[];
  accounting: OpenCodeGoSpendLedger;
};

export type OpenCodeGoCapabilityJobManifest = {
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
  provider: typeof OPENCODE_GO_PROVIDER;
  mode: typeof OPENCODE_GO_MODE;
  model: typeof OPENCODE_GO_MODEL;
  endpointFamily: typeof OPENCODE_GO_ENDPOINT_FAMILY;
  probeVersion: typeof ODL_REQ_022_GO_PROBE_VERSION;
  credentialBindingName: OpenCodeGoCredentialBindingName;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
  spendLedgerKey: string;
  stageResults: Record<CapabilityStage, StageResult>;
  modelMetadata: OpenCodeGoCapabilityReceipt["modelMetadata"] | null;
  attempts: OpenCodeGoCapabilityAttemptReceipt[];
  terminalReceipt: OpenCodeGoCapabilityTerminalReceipt | null;
  createdAt: string;
  updatedAt: string;
};

type CapabilityIndex = {
  version: 1;
  identity: string;
  jobId: string;
  status: OpenCodeGoCapabilityJobManifest["status"];
  updatedAt: string;
};

type CapabilityLocator = {
  version: 1;
  jobId: string;
  credentialBindingName: OpenCodeGoCredentialBindingName;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
};

type GoCapabilityPayload = {
  __odlReq022GoCapability: true;
  forceFresh: boolean;
  credentialBindingName: OpenCodeGoCredentialBindingName;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
  spendLedgerKey: string;
};

type WorkflowPayload = {
  jobId: string;
  workflowId: string;
  userId: string;
  input: Record<string, unknown>;
};

type ProbeResult = {
  receipt: OpenCodeGoCapabilityAttemptReceipt;
  modelMetadata?: OpenCodeGoCapabilityReceipt["modelMetadata"];
};

function stageOrder(): CapabilityStage[] {
  return ["model_discovery", "text_structured_output", "vision_unstructured", "vision_structured_output"];
}

function capabilityBase(binding: OpenCodeGoCredentialBindingName): string {
  return `visual-compiler/provider-capability/opencode-go/${OPENCODE_GO_MODEL}/${ODL_REQ_022_GO_PROBE_VERSION}/${binding}`;
}

function identity(input: Pick<OpenCodeGoCapabilityJobManifest, "credentialBindingName" | "maxBillableRequests" | "maxEstimatedSpendUsd">): string {
  return `${OPENCODE_GO_PROVIDER}|${OPENCODE_GO_MODE}|${OPENCODE_GO_MODEL}|${OPENCODE_GO_ENDPOINT_FAMILY}|${ODL_REQ_022_GO_PROBE_VERSION}|${input.credentialBindingName}|${input.maxBillableRequests}|${input.maxEstimatedSpendUsd.toFixed(6)}`;
}

function indexKey(binding: OpenCodeGoCredentialBindingName, maxBillableRequests: number, maxEstimatedSpendUsd: number): string {
  return `${capabilityBase(binding)}/active-${maxBillableRequests}-${Math.round(maxEstimatedSpendUsd * 1_000_000)}.json`;
}

function manifestKey(jobId: string, binding: OpenCodeGoCredentialBindingName): string {
  return `${capabilityBase(binding)}/jobs/${jobId}/manifest.json`;
}

function attemptKey(jobId: string, binding: OpenCodeGoCredentialBindingName, attempt: number, stage: CapabilityStage): string {
  return `${capabilityBase(binding)}/jobs/${jobId}/attempts/${String(attempt).padStart(4, "0")}-${stage}.json`;
}

function locatorKey(jobId: string): string {
  return `visual-compiler/provider-capability/opencode-go/jobs/${jobId}/locator.json`;
}

async function readJsonIfPresent<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.ARTIFACTS.get(key);
  if (!object) return null;
  try { return JSON.parse(await object.text()) as T; }
  catch { return null; }
}

async function storeJson(env: Env, key: string, value: unknown, metadata: Record<string, string> = {}): Promise<void> {
  await putArtifact(env, key, JSON.stringify(value, null, 2), "application/json; charset=utf-8", metadata);
}

async function writeManifest(env: Env, manifest: OpenCodeGoCapabilityJobManifest): Promise<void> {
  manifest.updatedAt = nowIso();
  await storeJson(env, manifestKey(manifest.jobId, manifest.credentialBindingName), manifest, {
    jobId: manifest.jobId,
    provider: manifest.provider,
    model: manifest.model,
    status: manifest.status,
    credentialBindingName: manifest.credentialBindingName,
  });
  await storeJson(env, indexKey(manifest.credentialBindingName, manifest.maxBillableRequests, manifest.maxEstimatedSpendUsd), {
    version: 1,
    identity: identity(manifest),
    jobId: manifest.jobId,
    status: manifest.status,
    updatedAt: manifest.updatedAt,
  } satisfies CapabilityIndex, { jobId: manifest.jobId, status: manifest.status });
}

function modelList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const values = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return values.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).slice(0, 16) : [];
}

function metadata(model: Record<string, unknown>): OpenCodeGoCapabilityReceipt["modelMetadata"] {
  const created = Number(model.created);
  const contextLength = Number(model.context_length);
  return {
    id: String(model.id ?? model.name ?? OPENCODE_GO_MODEL).slice(0, 100),
    object: model.object === undefined || model.object === null ? null : String(model.object).slice(0, 100),
    created: Number.isFinite(created) ? created : null,
    ownedBy: model.owned_by === undefined || model.owned_by === null ? null : String(model.owned_by).slice(0, 100),
    contextLength: Number.isFinite(contextLength) ? contextLength : null,
    inputModalities: strings(model.input_modalities),
    outputModalities: strings(model.output_modalities),
    pricingMetadataPresent: Boolean(model.pricing && typeof model.pricing === "object"),
    pricing: resolveOpenCodeGoPricing(model),
  };
}

function chatContent(body: Record<string, unknown>): string | null {
  const choices = Array.isArray(body.choices) ? body.choices as Record<string, unknown>[] : [];
  const message = choices[0]?.message && typeof choices[0].message === "object" ? choices[0].message as Record<string, unknown> : null;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : "").join("");
  return null;
}

function requestFor(stage: CapabilityStage, fixture: Uint8Array): { endpoint: string; method: "GET" | "POST"; body: Record<string, unknown> | null; image: Uint8Array | null } {
  if (stage === "model_discovery") return { endpoint: OPENCODE_GO_MODELS_ENDPOINT, method: "GET", body: null, image: null };
  if (stage === "text_structured_output") return {
    endpoint: OPENCODE_GO_CHAT_ENDPOINT,
    method: "POST",
    image: null,
    body: {
      model: OPENCODE_GO_MODEL,
      messages: [{ role: "user", content: "Return exactly one JSON object with ok=true and probe=odl-req-022." }],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 100,
    },
  };
  const dataUrl = `data:image/jpeg;base64,${bytesToBase64(fixture)}`;
  if (stage === "vision_unstructured") return {
    endpoint: OPENCODE_GO_CHAT_ENDPOINT,
    method: "POST",
    image: fixture,
    body: {
      model: OPENCODE_GO_MODEL,
      messages: [{ role: "user", content: [
        { type: "text", text: "Identify the blue square, red circle, and exact visible text in ordinary text." },
        { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
      ] }],
      temperature: 0,
      max_tokens: 180,
    },
  };
  return {
    endpoint: OPENCODE_GO_CHAT_ENDPOINT,
    method: "POST",
    image: fixture,
    body: {
      model: OPENCODE_GO_MODEL,
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

function validation(stage: CapabilityStage, body: Record<string, unknown>): { ok: boolean; parserResult: string; schemaValidationResult: string; model?: Record<string, unknown>; failureClass?: NormalizedResponseClass } {
  if (stage === "model_discovery") {
    const model = modelList(body).find((entry) => String(entry.id ?? entry.name ?? "") === OPENCODE_GO_MODEL);
    return model
      ? { ok: true, parserResult: "models_json_parsed", schemaValidationResult: "exact_model_present", model }
      : { ok: false, parserResult: "models_json_parsed", schemaValidationResult: "exact_model_missing", failureClass: "model_missing" };
  }
  const content = chatContent(body);
  if (!content) return { ok: false, parserResult: "chat_content_missing", schemaValidationResult: "not_validated", failureClass: "malformed_success_response" };
  if (stage === "text_structured_output") {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const ok = parsed.ok === true && parsed.probe === "odl-req-022";
      return { ok, parserResult: "json_parsed", schemaValidationResult: ok ? "valid" : "invalid", failureClass: ok ? undefined : "structured_output_failure" };
    } catch {
      return { ok: false, parserResult: "json_parse_failed", schemaValidationResult: "invalid", failureClass: "structured_output_failure" };
    }
  }
  const lower = content.toLocaleLowerCase("en");
  const visionOk = content.includes("UCA VISION PROBE 2047") && lower.includes("blue") && lower.includes("square") && lower.includes("red") && lower.includes("circle");
  if (stage === "vision_unstructured") return { ok: visionOk, parserResult: "ordinary_text_observed", schemaValidationResult: visionOk ? "visual_fixture_matched" : "visual_fixture_mismatch", failureClass: visionOk ? undefined : "unsupported_media" };
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const structuredOk = visionOk || (String(parsed.blue_shape ?? "").toLocaleLowerCase("en").includes("square")
      && String(parsed.red_shape ?? "").toLocaleLowerCase("en").includes("circle")
      && String(parsed.visible_text ?? "").includes("UCA VISION PROBE 2047"));
    const ok = structuredOk && parsed.capability_ready !== false;
    return { ok, parserResult: "json_parsed", schemaValidationResult: ok ? "valid" : "invalid", failureClass: ok ? undefined : "structured_output_failure" };
  } catch {
    return { ok: false, parserResult: "json_parse_failed", schemaValidationResult: "invalid", failureClass: "structured_output_failure" };
  }
}

async function runProbe(input: {
  env: Env;
  manifest: OpenCodeGoCapabilityJobManifest;
  stage: CapabilityStage;
  cycleNumber: number;
  attemptNumber: number;
  fixture: Uint8Array;
  nextRetryTimestamp: string | null;
}): Promise<ProbeResult> {
  const request = requestFor(input.stage, input.fixture);
  const imageSha256 = request.image ? await sha256Bytes(request.image) : null;
  const requestFingerprint = await sha256HexUtf8(canonicalJson({
    version: 1,
    provider: OPENCODE_GO_PROVIDER,
    mode: OPENCODE_GO_MODE,
    stage: input.stage,
    endpoint: request.endpoint,
    method: request.method,
    model: OPENCODE_GO_MODEL,
    credentialBindingName: input.manifest.credentialBindingName,
    body: request.body ? JSON.parse(JSON.stringify(request.body, (_key, value) => typeof value === "string" && value.startsWith("data:image/") ? `[image:${imageSha256}]` : value)) : null,
  }));
  await assertOpenCodeGoBudgetAvailable(input.env, input.manifest.spendLedgerKey);
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
  let usage: OpenCodeGoUsage | null = null;
  let model: Record<string, unknown> | undefined;
  let accounting = await readOpenCodeGoSpendLedger(input.env, input.manifest.spendLedgerKey);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 45_000);
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${openCodeGoCredentialValue(input.env, input.manifest.credentialBindingName)}`,
          ...(request.body ? { "Content-Type": "application/json" } : {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    status = response.status;
    retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"), Date.now(), ODL_REQ_022_GO_MAX_RETRY_DELAY_SECONDS);
    providerRequestId = (response.headers.get("x-request-id") ?? response.headers.get("request-id"))?.slice(0, 200) ?? null;
    edgeRequestId = response.headers.get("cf-ray")?.slice(0, 200) ?? null;
    responseContentType = response.headers.get("content-type")?.slice(0, 120) ?? null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    responseByteCount = bytes.byteLength;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes.slice(0, MAX_RESPONSE_BYTES))) as Record<string, unknown>;
      parserResult = "response_json_parsed";
    } catch {
      parserResult = "response_json_parse_failed";
    }
    usage = request.method === "POST" ? parseOpenCodeGoUsage(parsed) : null;
    accounting = await recordOpenCodeGoAccounting(input.env, input.manifest.spendLedgerKey, {
      context: `capability:${input.stage}`,
      httpStatus: response.status,
      costBearing: response.ok && request.method === "POST",
      body: parsed,
      requestIdentity: requestFingerprint,
    });
    if (!response.ok) {
      const sanitized = sanitizeProviderError(parsed);
      errorCode = sanitized.code;
      errorMessage = sanitized.message;
      const modelMissing = status === 404 || /model.*(?:missing|not found|unavailable)/i.test(`${errorCode ?? ""} ${errorMessage ?? ""}`);
      responseClass = normalizedResponseClass(status, { modelMissing });
      schemaValidationResult = "not_applicable";
    } else {
      const checked = validation(input.stage, parsed);
      parserResult = checked.parserResult;
      schemaValidationResult = checked.schemaValidationResult;
      model = checked.model;
      responseClass = checked.ok ? "success" : checked.failureClass ?? "unknown_provider_failure";
      if (model) {
        accounting = await updateOpenCodeGoPricing(input.env, input.manifest.spendLedgerKey, model);
      }
      if (!checked.ok) {
        errorCode = responseClass;
        errorMessage = `The ${input.stage} response did not satisfy the deterministic OpenCode Go capability contract.`;
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
  return {
    receipt: {
      version: 1,
      capabilityJobId: input.manifest.jobId,
      cycleNumber: input.cycleNumber,
      attemptNumber: input.attemptNumber,
      probeStage: input.stage,
      provider: OPENCODE_GO_PROVIDER,
      mode: OPENCODE_GO_MODE,
      exactModel: OPENCODE_GO_MODEL,
      endpointFamily: OPENCODE_GO_ENDPOINT_FAMILY,
      probeVersion: ODL_REQ_022_GO_PROBE_VERSION,
      credentialBindingName: input.manifest.credentialBindingName,
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
      accounting,
      nextRetryTimestamp: retryable ? input.nextRetryTimestamp : null,
      terminalDisposition: responseClass === "success" ? "stage_passed" : retryable ? "retry_scheduled" : "terminal_failure",
    },
    modelMetadata: model ? metadata(model) : undefined,
  };
}

function firstIncomplete(manifest: OpenCodeGoCapabilityJobManifest): CapabilityStage | null {
  return stageOrder().find((stage) => manifest.stageResults[stage] !== "passed") ?? null;
}

function distribution(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

export function preciseOpenCodeGoBlocker(manifest: Pick<OpenCodeGoCapabilityJobManifest, "attempts" | "credentialBindingName">): string {
  const failed = manifest.attempts.filter((entry) => entry.normalizedResponseClass !== "success");
  const discovery = failed.find((entry) => entry.probeStage === "model_discovery");
  if (discovery) {
    if (manifest.credentialBindingName === "OPENCODE_ZEN_API_KEY" && ["authentication_failed", "authorization_failed", "model_missing"].includes(discovery.normalizedResponseClass)) return "opencode_go_access_not_authorized";
    if (["authorization_failed", "model_missing"].includes(discovery.normalizedResponseClass)) return "opencode_go_access_not_authorized";
    if (discovery.normalizedResponseClass === "authentication_failed") return "provider_authentication_failed";
  }
  const classes = new Set(failed.map((entry) => entry.normalizedResponseClass));
  if (classes.size === 1 && classes.has("rate_limited")) return "provider_rate_limited";
  if (classes.size === 1 && classes.has("provider_server_error")) return "provider_server_unavailable";
  if ([...classes].every((value) => value === "network_failure" || value === "timeout")) return "provider_network_unavailable";
  if (classes.has("unsupported_media")) return "provider_multimodal_unsupported";
  if (classes.has("structured_output_failure")) return "provider_structured_output_unsupported";
  if ([...classes].some((value) => responseClassRetryable(value)) && classes.size > 1) return "provider_mixed_transient_failures";
  if (classes.has("invalid_request")) return "provider_invalid_request";
  return "provider_unknown_failure";
}

async function terminalReceipt(env: Env, manifest: OpenCodeGoCapabilityJobManifest, status: "passed" | "failed", reason: string): Promise<OpenCodeGoCapabilityTerminalReceipt> {
  const completedAt = nowIso();
  const accounting = await readOpenCodeGoSpendLedger(env, manifest.spendLedgerKey);
  const byStage = Object.fromEntries(stageOrder().map((stage) => [stage, manifest.attempts.filter((entry) => entry.probeStage === stage).length])) as Record<CapabilityStage, number>;
  return {
    version: 1,
    capabilityJobId: manifest.jobId,
    provider: OPENCODE_GO_PROVIDER,
    mode: OPENCODE_GO_MODE,
    exactModel: OPENCODE_GO_MODEL,
    probeVersion: ODL_REQ_022_GO_PROBE_VERSION,
    endpointFamily: OPENCODE_GO_ENDPOINT_FAMILY,
    credentialBindingName: manifest.credentialBindingName,
    status,
    startedAt: manifest.createdAt,
    completedAt,
    totalElapsedMilliseconds: Math.max(0, Date.parse(completedAt) - Date.parse(manifest.createdAt)),
    attemptCountByStage: byStage,
    httpStatusDistribution: distribution(manifest.attempts.map((entry) => entry.httpStatus === null ? "none" : String(entry.httpStatus))),
    responseClassDistribution: distribution(manifest.attempts.map((entry) => entry.normalizedResponseClass)),
    anySuccessfulHttpResponse: manifest.attempts.some((entry) => entry.httpStatus !== null && entry.httpStatus >= 200 && entry.httpStatus < 300),
    modelDiscoveryWorked: manifest.stageResults.model_discovery === "passed",
    textTransportWorked: manifest.stageResults.text_structured_output === "passed",
    visionWorked: manifest.stageResults.vision_unstructured === "passed" || manifest.stageResults.vision_structured_output === "passed",
    structuredOutputWorked: manifest.stageResults.text_structured_output === "passed" && manifest.stageResults.vision_structured_output === "passed",
    finalRetryability: status === "failed" && Boolean(manifest.attempts.at(-1)?.retryable),
    finalReasonForStopping: reason,
    blockerClassification: status === "passed" ? null : preciseOpenCodeGoBlocker(manifest),
    stageResults: { ...manifest.stageResults },
    attempts: manifest.attempts,
    accounting,
  };
}

async function updateJob(env: Env, userId: string, jobId: string, patch: Partial<PaidJobRecord>): Promise<void> {
  await coordinatorRequest(env, userId, "/jobs/update", { jobId, ...patch });
}

export function isOpenCodeGoCapabilityWorkflowPayload(payload: { input?: Record<string, unknown> } | undefined): boolean {
  return Boolean(payload?.input?.__odlReq022GoCapability);
}

export async function runOpenCodeGoCapabilityWorkflow(env: Env, payload: WorkflowPayload, step: WorkflowStep): Promise<Record<string, unknown>> {
  const input = payload.input as unknown as GoCapabilityPayload;
  if (!input.__odlReq022GoCapability) throw new ConnectorError("capability_payload_invalid", "The OpenCode Go capability payload is invalid.");
  let manifest = await readJsonIfPresent<OpenCodeGoCapabilityJobManifest>(env, manifestKey(payload.jobId, input.credentialBindingName));
  if (!manifest) throw new ConnectorError("capability_manifest_missing", "The OpenCode Go capability manifest is missing.");
  manifest.status = "running";
  await writeManifest(env, manifest);
  await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: 1, stage: manifest.currentStage });
  const fixture = syntheticVisionProbeJpegBytes();
  for (let cycle = Math.max(1, manifest.cycleNumber); cycle <= ODL_REQ_022_GO_MAX_CYCLES; cycle += 1) {
    manifest.cycleNumber = cycle;
    const stage = firstIncomplete(manifest);
    if (!stage) break;
    manifest.currentStage = stage;
    manifest.attemptNumber += 1;
    const baseDelay = ODL_REQ_022_GO_RETRY_DELAYS_SECONDS[Math.min(cycle, ODL_REQ_022_GO_RETRY_DELAYS_SECONDS.length - 1)] ?? ODL_REQ_022_GO_MAX_RETRY_DELAY_SECONDS;
    const provisionalNext = new Date(Date.now() + baseDelay * 1000).toISOString();
    const result = await step.do(
      `OpenCode Go capability cycle ${String(cycle).padStart(2, "0")} ${stage}`,
      { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" },
      async () => runProbe({ env, manifest: manifest as OpenCodeGoCapabilityJobManifest, stage, cycleNumber: cycle, attemptNumber: manifest?.attemptNumber ?? 1, fixture, nextRetryTimestamp: provisionalNext }),
    );
    const receipt = result.receipt;
    if (result.modelMetadata) manifest.modelMetadata = result.modelMetadata;
    manifest.attempts.push(receipt);
    const persistAttempt = async (): Promise<void> => storeJson(env, attemptKey(payload.jobId, manifest.credentialBindingName, receipt.attemptNumber, stage), receipt, {
      jobId: payload.jobId,
      stage,
      attemptNumber: String(receipt.attemptNumber),
      responseClass: receipt.normalizedResponseClass,
      httpStatus: receipt.httpStatus === null ? "none" : String(receipt.httpStatus),
    });
    if (receipt.normalizedResponseClass === "success") {
      await persistAttempt();
      manifest.stageResults[stage] = "passed";
      manifest.nextScheduledAttempt = null;
      const next = firstIncomplete(manifest);
      if (next) {
        manifest.currentStage = next;
        await writeManifest(env, manifest);
        await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: Math.min(90, 10 + stageOrder().filter((value) => manifest?.stageResults[value] === "passed").length * 20), stage: next });
        cycle -= 1;
        continue;
      }
      break;
    }
    manifest.stageResults[stage] = "failed";
    const elapsed = Date.now() - Date.parse(manifest.createdAt);
    const canRetry = receipt.retryable && cycle < ODL_REQ_022_GO_MAX_CYCLES && elapsed < ODL_REQ_022_GO_MAX_ELAPSED_MS;
    if (!canRetry) {
      receipt.terminalDisposition = "terminal_failure";
      receipt.nextRetryTimestamp = null;
      await persistAttempt();
      manifest.status = "failed";
      manifest.nextScheduledAttempt = null;
      manifest.terminalReceipt = await terminalReceipt(env, manifest, "failed", receipt.retryable ? "bounded_retry_schedule_exhausted" : `non_retryable_${receipt.normalizedResponseClass}`);
      await writeManifest(env, manifest);
      await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: { code: manifest.terminalReceipt.blockerClassification ?? "provider_capability_failed", message: manifest.terminalReceipt.finalReasonForStopping, retryable: false } });
      return manifest.terminalReceipt as unknown as Record<string, unknown>;
    }
    const requested = receipt.retryAfterSeconds ?? 0;
    const delaySeconds = Math.min(ODL_REQ_022_GO_MAX_RETRY_DELAY_SECONDS, Math.max(baseDelay, requested));
    if (elapsed + delaySeconds * 1000 > ODL_REQ_022_GO_MAX_ELAPSED_MS) {
      receipt.terminalDisposition = "terminal_failure";
      receipt.nextRetryTimestamp = null;
      await persistAttempt();
      manifest.status = "failed";
      manifest.nextScheduledAttempt = null;
      manifest.terminalReceipt = await terminalReceipt(env, manifest, "failed", "four_hour_elapsed_limit_reached");
      await writeManifest(env, manifest);
      await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: { code: manifest.terminalReceipt.blockerClassification ?? "provider_capability_failed", message: manifest.terminalReceipt.finalReasonForStopping, retryable: false } });
      return manifest.terminalReceipt as unknown as Record<string, unknown>;
    }
    manifest.status = "retry_wait";
    manifest.nextScheduledAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    receipt.nextRetryTimestamp = manifest.nextScheduledAttempt;
    receipt.terminalDisposition = "retry_scheduled";
    await persistAttempt();
    await writeManifest(env, manifest);
    await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: Math.min(85, 5 + cycle * 12), stage: `retry_wait_${stage}_${cycle}` });
    await step.sleep(`OpenCode Go capability retry wait ${String(cycle).padStart(2, "0")} ${stage}`, `${delaySeconds} seconds`);
    manifest.status = "running";
    manifest.stageResults[stage] = "not_run";
  }
  if (firstIncomplete(manifest)) {
    manifest.status = "failed";
    manifest.terminalReceipt = await terminalReceipt(env, manifest, "failed", "bounded_retry_schedule_exhausted");
    await writeManifest(env, manifest);
    await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: { code: manifest.terminalReceipt.blockerClassification ?? "provider_capability_failed", message: manifest.terminalReceipt.finalReasonForStopping, retryable: false } });
    return manifest.terminalReceipt as unknown as Record<string, unknown>;
  }
  manifest.status = "completed";
  manifest.nextScheduledAttempt = null;
  manifest.terminalReceipt = await terminalReceipt(env, manifest, "passed", "all_four_mandatory_stages_passed");
  const accounting = manifest.terminalReceipt.accounting;
  const lastVision = [...manifest.attempts].reverse().find((entry) => entry.probeStage === "vision_structured_output" && entry.normalizedResponseClass === "success");
  const capability: OpenCodeGoCapabilityReceipt = {
    provider: OPENCODE_GO_PROVIDER,
    mode: OPENCODE_GO_MODE,
    model: OPENCODE_GO_MODEL,
    endpointFamily: OPENCODE_GO_ENDPOINT_FAMILY,
    probeVersion: ODL_REQ_022_GO_PROBE_VERSION,
    credentialBindingName: manifest.credentialBindingName,
    discoveryTimestamp: nowIso(),
    discoveryCacheHit: false,
    modelPresent: true,
    modelMetadata: manifest.modelMetadata ?? {
      id: OPENCODE_GO_MODEL, object: null, created: null, ownedBy: null, contextLength: null,
      inputModalities: [], outputModalities: [], pricingMetadataPresent: false, pricing: accounting.pricing,
    },
    visionProbe: {
      passed: true,
      status: lastVision?.httpStatus ?? 200,
      latencyMilliseconds: lastVision?.latencyMilliseconds ?? 0,
      exactTextObserved: true,
      blueSquareObserved: true,
      redCircleObserved: true,
      detailFieldAccepted: true,
      sanitizedUsage: {
        inputTokens: lastVision?.usage?.inputTokens ?? null,
        outputTokens: lastVision?.usage?.outputTokens ?? null,
        cachedReadTokens: lastVision?.usage?.cachedReadTokens ?? null,
        totalTokens: lastVision?.usage?.totalTokens ?? null,
      },
    },
    structuredOutput: { responseFormatAccepted: true, jsonObjectReliable: true },
    spendScopeId: manifest.jobId,
    spendLedgerKey: manifest.spendLedgerKey,
    maxBillableRequests: manifest.maxBillableRequests,
    maxEstimatedSpendUsd: manifest.maxEstimatedSpendUsd,
    accounting,
    costClassification: accounting.estimatedSpendUsd === null ? "usage_not_reported" : "provider_metered_or_fallback_estimate",
  };
  await writeOpenCodeGoCapabilityCache(env, capability);
  await writeManifest(env, manifest);
  await updateJob(env, payload.userId, payload.jobId, { status: "completed", progress: 100, stage: "completed", error: null });
  return manifest.terminalReceipt as unknown as Record<string, unknown>;
}

export async function startOpenCodeGoCapabilityJob(context: HotfixContext, raw: {
  provider?: string;
  mode?: string;
  model?: string;
  forceFresh?: boolean;
  maxBillableRequests?: number;
  maxEstimatedSpendUsd?: number;
}): Promise<ReturnType<typeof textResult>> {
  if (String(raw.provider ?? OPENCODE_GO_PROVIDER) !== OPENCODE_GO_PROVIDER) throw new ConnectorError("classifier_configuration_invalid", "OpenCode Go capability jobs require provider opencode_go.");
  if (String(raw.mode ?? OPENCODE_GO_MODE) !== OPENCODE_GO_MODE) throw new ConnectorError("classifier_configuration_invalid", "OpenCode Go capability jobs require opencode_go_chat_completions mode.");
  if (String(raw.model ?? OPENCODE_GO_MODEL) !== OPENCODE_GO_MODEL) throw new ConnectorError("provider_model_not_allowed", `OpenCode Go requires the exact model ${OPENCODE_GO_MODEL}.`);
  const budgets = validateOpenCodeGoBudgets(raw.maxBillableRequests, raw.maxEstimatedSpendUsd);
  const credentialBindingName = selectOpenCodeGoCredentialBinding(context.env);
  const index = await readJsonIfPresent<CapabilityIndex>(context.env, indexKey(credentialBindingName, budgets.maxBillableRequests, budgets.maxEstimatedSpendUsd));
  if (index) {
    const existing = await readJsonIfPresent<OpenCodeGoCapabilityJobManifest>(context.env, manifestKey(index.jobId, credentialBindingName));
    if (existing && ["reserved", "running", "retry_wait"].includes(existing.status)) {
      return textResult({
        jobId: existing.jobId, workflowId: existing.workflowId, status: existing.status, currentStage: existing.currentStage,
        nextScheduledAttempt: existing.nextScheduledAttempt, idempotentReplay: true, provider: OPENCODE_GO_PROVIDER,
        mode: OPENCODE_GO_MODE, model: OPENCODE_GO_MODEL, credentialBindingName, oneDriveMutationPerformed: false,
        recommendedNextOperation: "get_visual_classifier_capability_job",
      });
    }
    if (!raw.forceFresh && existing?.terminalReceipt?.status === "passed" && Date.now() - Date.parse(existing.terminalReceipt.completedAt) <= ODL_REQ_022_GO_RECEIPT_TTL_MS) {
      return textResult({
        jobId: existing.jobId, workflowId: existing.workflowId, status: existing.status, currentStage: existing.currentStage,
        terminalReceipt: existing.terminalReceipt, idempotentReplay: true, provider: OPENCODE_GO_PROVIDER,
        mode: OPENCODE_GO_MODE, model: OPENCODE_GO_MODEL, credentialBindingName, oneDriveMutationPerformed: false,
        recommendedNextOperation: "get_visual_classifier_capability_job",
      });
    }
  }
  const reservationInput = {
    provider: OPENCODE_GO_PROVIDER,
    mode: OPENCODE_GO_MODE,
    model: OPENCODE_GO_MODEL,
    endpointFamily: OPENCODE_GO_ENDPOINT_FAMILY,
    probeVersion: ODL_REQ_022_GO_PROBE_VERSION,
    credentialBindingName,
    ...budgets,
    forceFresh: Boolean(raw.forceFresh),
    forceNonce: raw.forceFresh ? crypto.randomUUID() : null,
  };
  const hash = await requestHash("start_visual_classifier_capability_job", reservationInput);
  const requestedJobId = crypto.randomUUID();
  const job = await coordinatorRequest<PaidJobRecord>(context.env, context.userId, "/jobs/begin", {
    jobId: requestedJobId,
    workflowId: requestedJobId,
    toolName: "start_visual_classifier_capability_job",
    requestHash: hash,
  });
  const ledger = await initializeOpenCodeGoSpendLedger(context.env, {
    scopeId: job.jobId,
    credentialBindingName,
    ...budgets,
  });
  const manifest: OpenCodeGoCapabilityJobManifest = {
    version: 1,
    jobId: job.jobId,
    workflowId: job.workflowId,
    userIdHash: await sha256HexUtf8(context.userId),
    status: "reserved",
    currentStage: "model_discovery",
    cycleNumber: 1,
    attemptNumber: 0,
    nextScheduledAttempt: null,
    forceFresh: Boolean(raw.forceFresh),
    provider: OPENCODE_GO_PROVIDER,
    mode: OPENCODE_GO_MODE,
    model: OPENCODE_GO_MODEL,
    endpointFamily: OPENCODE_GO_ENDPOINT_FAMILY,
    probeVersion: ODL_REQ_022_GO_PROBE_VERSION,
    credentialBindingName,
    ...budgets,
    spendLedgerKey: ledger.key,
    stageResults: { model_discovery: "not_run", text_structured_output: "not_run", vision_unstructured: "not_run", vision_structured_output: "not_run" },
    modelMetadata: null,
    attempts: [],
    terminalReceipt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await storeJson(context.env, locatorKey(job.jobId), {
    version: 1,
    jobId: job.jobId,
    credentialBindingName,
    ...budgets,
  } satisfies CapabilityLocator, { jobId: job.jobId, credentialBindingName });
  await writeManifest(context.env, manifest);
  const payload: WorkflowPayload = {
    jobId: job.jobId,
    workflowId: job.workflowId,
    userId: context.userId,
    input: {
      __odlReq022GoCapability: true,
      forceFresh: Boolean(raw.forceFresh),
      credentialBindingName,
      ...budgets,
      spendLedgerKey: ledger.key,
    },
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
    provider: OPENCODE_GO_PROVIDER,
    mode: OPENCODE_GO_MODE,
    model: OPENCODE_GO_MODEL,
    probeVersion: ODL_REQ_022_GO_PROBE_VERSION,
    credentialBindingName,
    maxBillableRequests: budgets.maxBillableRequests,
    maxEstimatedSpendUsd: budgets.maxEstimatedSpendUsd,
    oneDriveMutationPerformed: false,
    recommendedNextOperation: "get_visual_classifier_capability_job",
  });
}

export async function getOpenCodeGoCapabilityJob(context: HotfixContext, jobId: string): Promise<ReturnType<typeof textResult> | null> {
  const locator = await readJsonIfPresent<CapabilityLocator>(context.env, locatorKey(jobId));
  if (!locator) return null;
  const manifest = await readJsonIfPresent<OpenCodeGoCapabilityJobManifest>(context.env, manifestKey(jobId, locator.credentialBindingName));
  if (!manifest) return null;
  const accounting = await readOpenCodeGoSpendLedger(context.env, manifest.spendLedgerKey);
  return textResult({
    jobId,
    workflowId: manifest.workflowId,
    status: manifest.status,
    currentStage: manifest.currentStage,
    cycleNumber: manifest.cycleNumber,
    nextScheduledAttempt: manifest.nextScheduledAttempt,
    provider: manifest.provider,
    mode: manifest.mode,
    model: manifest.model,
    probeVersion: manifest.probeVersion,
    credentialBindingName: manifest.credentialBindingName,
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
      accounting: entry.accounting,
    })),
    accounting,
    terminalReceipt: manifest.terminalReceipt,
    privateUrlsReturned: false,
    secretValuesReturned: false,
    oneDriveMutationPerformed: false,
  });
}

export async function readSuccessfulOpenCodeGoCapabilityReceipt(env: Env, expected?: { maxBillableRequests?: number; maxEstimatedSpendUsd?: number }): Promise<OpenCodeGoCapabilityReceipt | null> {
  const credentialBindingName = selectOpenCodeGoCredentialBinding(env);
  const budgets = validateOpenCodeGoBudgets(expected?.maxBillableRequests, expected?.maxEstimatedSpendUsd);
  const index = await readJsonIfPresent<CapabilityIndex>(env, indexKey(credentialBindingName, budgets.maxBillableRequests, budgets.maxEstimatedSpendUsd));
  if (!index) return null;
  const manifest = await readJsonIfPresent<OpenCodeGoCapabilityJobManifest>(env, manifestKey(index.jobId, credentialBindingName));
  if (!manifest?.terminalReceipt || manifest.terminalReceipt.status !== "passed") return null;
  if (manifest.probeVersion !== ODL_REQ_022_GO_PROBE_VERSION || manifest.model !== OPENCODE_GO_MODEL || manifest.mode !== OPENCODE_GO_MODE) return null;
  if (Date.now() - Date.parse(manifest.terminalReceipt.completedAt) > ODL_REQ_022_GO_RECEIPT_TTL_MS) return null;
  const cache = await import("./visual-catalogue-opencode-go").then((module) => module.readOpenCodeGoCapabilityCache(env));
  if (!cache || cache.spendScopeId !== manifest.jobId || cache.credentialBindingName !== credentialBindingName) return null;
  return cache;
}

export function errorOpenCodeGoCapability(error: unknown) {
  return errorResult(error);
}
