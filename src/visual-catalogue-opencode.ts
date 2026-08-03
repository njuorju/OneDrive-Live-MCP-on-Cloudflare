import { ConnectorError } from "./errors";
import { bytesToBase64, sha256Bytes } from "./integrated-core";
import { canonicalJson, getArtifact, nowIso, putArtifact, sha256HexUtf8 } from "./paid-core";
import { syntheticVisionProbeJpegBytes } from "./visual-catalogue-probe-fixture";
import {
  OPENCODE_GO_CHAT_ENDPOINT,
  OPENCODE_GO_MODE,
  OPENCODE_GO_MODEL,
  OPENCODE_GO_PROVIDER,
  requestOpenCodeGo,
  selectOpenCodeGoCredentialBinding,
  validateOpenCodeGoBudgets,
  type OpenCodeGoCapabilityReceipt,
  type OpenCodeGoSpendLedger,
  type OpenCodeGoUsage,
} from "./visual-catalogue-opencode-go";
import {
  PREPARED_OUTCOMES,
  boundedConfidence,
  type ClassificationProposal,
  type PreparedOutcome,
  type RenderArtifactManifest,
  type RoutingMode,
  type SourceType,
  type VisualCandidate,
} from "./visual-catalogue-model";

export const OPENCODE_ZEN_PROVIDER = "opencode_zen" as const;
export const OPENCODE_ZEN_MODEL = "mimo-v2.5-free" as const;
export const OPENCODE_ZEN_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
export const OPENCODE_POLICY_VERSION = "opencode-zen-observed-2026-08";
export const OPENCODE_CLASSIFIER_ARTIFACT_VERSION = "opencode-jpeg-v1";
export const OPENCODE_CAPABILITY_CACHE_SECONDS = 60 * 60;

export type VisualClassifierProvider = "openai" | "opencode_zen" | "opencode_go" | "fixture";
export type VisualClassifierMode = "openai_responses" | "openai_batch" | "opencode_chat_completions" | "opencode_go_chat_completions" | "fixture";
export type VisualDataSensitivity = "public" | "internal" | "confidential" | "personal" | "restricted";

export type ClassifierSelectionInput = {
  classifierProvider?: VisualClassifierProvider;
  classifierMode?: VisualClassifierMode;
  model?: string;
  allowPaidFallback?: boolean;
  dataSensitivity?: VisualDataSensitivity;
  freeProviderDataPolicyAcknowledged?: boolean;
  dryRun?: boolean;
  maxBillableRequests?: number;
  maxEstimatedSpendUsd?: number;
};

export type ResolvedClassifierSelection = {
  provider: VisualClassifierProvider;
  mode: VisualClassifierMode;
  model: string;
  allowPaidFallback: boolean;
  dataSensitivity: VisualDataSensitivity | null;
  freeProviderDataPolicyAcknowledged: boolean;
  maxBillableRequests: number | null;
  maxEstimatedSpendUsd: number | null;
};

export type OpenCodePolicyReceipt = {
  provider: "opencode_zen";
  model: "mimo-v2.5-free";
  dataSensitivity: "public";
  freeProviderDataPolicyAcknowledged: true;
  policyVersion: string;
} | {
  provider: "opencode_go";
  model: "mimo-v2.5";
  dataSensitivity: "public";
  freeProviderDataPolicyAcknowledged: boolean;
  policyVersion: "opencode-go-paid-2026-08";
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
};

export type OpenCodeCapabilityReceipt = {
  provider: "opencode_zen";
  model: "mimo-v2.5-free";
  endpointFamily: "openai_compatible_chat_completions";
  discoveryTimestamp: string;
  discoveryCacheHit: boolean;
  modelPresent: boolean;
  modelMetadata: {
    id: string;
    object: string | null;
    created: number | null;
    ownedBy: string | null;
    contextLength: number | null;
    inputModalities: string[];
    outputModalities: string[];
    pricingMetadataPresent: boolean;
  };
  visionProbe: {
    passed: boolean;
    status: number;
    latencyMilliseconds: number;
    exactTextObserved: boolean;
    blueSquareObserved: boolean;
    redCircleObserved: boolean;
    detailFieldAccepted: boolean;
    sanitizedUsage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  };
  structuredOutput: {
    responseFormatAccepted: boolean;
    jsonObjectReliable: boolean;
  };
  costClassification: "provider_reported_unknown_or_free_model_id";
};

export type AnyOpenCodeCapabilityReceipt = OpenCodeCapabilityReceipt | OpenCodeGoCapabilityReceipt;

export type ClassifierArtifactManifest = {
  version: 1;
  classifierArtifactId: string;
  r2Key: string;
  sourceRenderArtifactId: string;
  sourceRenderSha256: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  maxDimension: number;
  quality: number;
  transformationVersion: string;
  cacheHit: boolean;
  createdAt: string;
};

export type OpenCodeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
  usageReported?: boolean;
};

export type OpenCodeClassifiedCandidate = {
  proposal: ClassificationProposal;
  usage: OpenCodeUsage;
  latencyMilliseconds: number;
  retries: number;
  rateLimitEvents: number;
  parserResult: "valid_first_response" | "valid_after_retry" | "persistent_invalid";
  schemaValidationResult: "valid" | "invalid";
  classifierArtifact: ClassifierArtifactManifest | null;
  requestIdentity: string;
  idempotentReplay: boolean;
  endpointFamily: "openai_compatible_chat_completions";
  passNumber: 1 | 2;
  reviewRoutingReason: string | null;
  provider?: "opencode_zen" | "opencode_go";
  accounting?: OpenCodeGoSpendLedger | null;
};

type DeterministicSignal = { outcome: PreparedOutcome | null; reason: string | null; confidence: number };
type FetchLike = typeof fetch;

const STRUCTURAL_TYPES = new Set(["map", "plan", "diagram", "framework", "chart", "implementation_composition", "spatial_analysis"]);
const OUTCOME_SET = new Set<string>(PREPARED_OUTCOMES);
const CAPABILITY_KEY = `visual-compiler/provider-cache/opencode-zen/${OPENCODE_ZEN_MODEL}/capabilities.json`;

function providerFromMode(mode: VisualClassifierMode): VisualClassifierProvider {
  if (mode === "fixture") return "fixture";
  if (mode === "opencode_chat_completions") return "opencode_zen";
  if (mode === "opencode_go_chat_completions") return "opencode_go";
  return "openai";
}

export function resolveClassifierSelection(input: ClassifierSelectionInput, env?: Pick<Env, "OPENAI_API_KEY" | "OPENCODE_ZEN_API_KEY" | "OPENCODE_GO_API_KEY" | "VISUAL_CLASSIFIER_PROVIDER" | "VISUAL_CLASSIFIER_MODEL" | "OPENCODE_ZEN_MODEL">): ResolvedClassifierSelection {
  const defaultProvider = String(env?.VISUAL_CLASSIFIER_PROVIDER ?? "openai") as VisualClassifierProvider;
  const inferredMode = input.classifierMode ?? (input.dryRun && !input.classifierProvider ? "fixture" : defaultProvider === "opencode_zen" ? "opencode_chat_completions" : defaultProvider === "opencode_go" ? "opencode_go_chat_completions" : "openai_batch");
  const provider = input.classifierProvider ?? providerFromMode(inferredMode);
  const model = String(input.model ?? (provider === "opencode_zen" ? env?.OPENCODE_ZEN_MODEL ?? OPENCODE_ZEN_MODEL : provider === "opencode_go" ? OPENCODE_GO_MODEL : provider === "fixture" ? "calibration-fixture" : env?.VISUAL_CLASSIFIER_MODEL ?? "gpt-5.2-2025-12-11"));
  const allowPaidFallback = Boolean(input.allowPaidFallback ?? false);
  const sensitivity = input.dataSensitivity ?? null;
  const acknowledged = Boolean(input.freeProviderDataPolicyAcknowledged ?? false);

  if (provider === "fixture") {
    if (inferredMode !== "fixture") throw new ConnectorError("classifier_configuration_invalid", "Fixture provider requires fixture mode.");
    if (!input.dryRun) throw new ConnectorError("fixture_production_forbidden", "Fixture classification is permitted only for dry runs.");
    return { provider, mode: inferredMode, model: "calibration-fixture", allowPaidFallback: false, dataSensitivity: null, freeProviderDataPolicyAcknowledged: false, maxBillableRequests: null, maxEstimatedSpendUsd: null };
  }

  if (provider === "openai") {
    if (!new Set<VisualClassifierMode>(["openai_responses", "openai_batch"]).has(inferredMode)) {
      throw new ConnectorError("classifier_configuration_invalid", "OpenAI provider requires an OpenAI classifier mode.");
    }
    if (env && !String(env.OPENAI_API_KEY ?? "")) throw new ConnectorError("openai_api_key_missing", "OPENAI_API_KEY is not configured.");
    return { provider, mode: inferredMode, model, allowPaidFallback, dataSensitivity: sensitivity, freeProviderDataPolicyAcknowledged: acknowledged, maxBillableRequests: null, maxEstimatedSpendUsd: null };
  }

  if (provider === "opencode_go") {
    if (inferredMode !== OPENCODE_GO_MODE) throw new ConnectorError("classifier_configuration_invalid", "OpenCode Go requires opencode_go_chat_completions mode.");
    if (model !== OPENCODE_GO_MODEL) throw new ConnectorError("provider_model_not_allowed", `OpenCode Go jobs require the exact model ID ${OPENCODE_GO_MODEL}.`);
    if (allowPaidFallback) throw new ConnectorError("paid_fallback_forbidden", "Automatic fallback is disabled for OpenCode Go.");
    if (sensitivity !== "public") throw new ConnectorError("provider_data_policy_rejected", "This bounded OpenCode Go tranche accepts only explicitly public source material.");
    if (env) selectOpenCodeGoCredentialBinding(env);
    const budgets = validateOpenCodeGoBudgets(input.maxBillableRequests, input.maxEstimatedSpendUsd);
    return { provider, mode: inferredMode, model, allowPaidFallback: false, dataSensitivity: "public", freeProviderDataPolicyAcknowledged: acknowledged, ...budgets };
  }

  if (inferredMode !== "opencode_chat_completions") throw new ConnectorError("classifier_configuration_invalid", "OpenCode Zen requires opencode_chat_completions mode.");
  if (model !== OPENCODE_ZEN_MODEL) throw new ConnectorError("provider_model_not_allowed", `OpenCode Zen free-only jobs require the exact model ID ${OPENCODE_ZEN_MODEL}.`);
  if (allowPaidFallback) throw new ConnectorError("paid_fallback_forbidden", "Paid fallback is disabled. No alternate OpenCode or OpenAI model will be selected.");
  if (sensitivity !== "public") throw new ConnectorError("provider_data_policy_rejected", "MiMo-V2.5 Free accepts only explicitly public, non-confidential source material.");
  if (!acknowledged) throw new ConnectorError("provider_data_policy_acknowledgement_required", "The free-provider data policy must be explicitly acknowledged.");
  if (env && !String(env.OPENCODE_ZEN_API_KEY ?? "")) throw new ConnectorError("provider_secret_missing", "OPENCODE_ZEN_API_KEY is not configured.");
  return { provider, mode: inferredMode, model, allowPaidFallback: false, dataSensitivity: "public", freeProviderDataPolicyAcknowledged: true, maxBillableRequests: null, maxEstimatedSpendUsd: null };
}

export function openCodePolicyReceipt(selection: ResolvedClassifierSelection): OpenCodePolicyReceipt | null {
  if (selection.provider === "opencode_go") {
    return {
      provider: "opencode_go", model: OPENCODE_GO_MODEL, dataSensitivity: "public",
      freeProviderDataPolicyAcknowledged: selection.freeProviderDataPolicyAcknowledged,
      policyVersion: "opencode-go-paid-2026-08",
      maxBillableRequests: selection.maxBillableRequests as number,
      maxEstimatedSpendUsd: selection.maxEstimatedSpendUsd as number,
    };
  }
  if (selection.provider !== "opencode_zen") return null;
  return {
    provider: "opencode_zen",
    model: OPENCODE_ZEN_MODEL,
    dataSensitivity: "public",
    freeProviderDataPolicyAcknowledged: true,
    policyVersion: OPENCODE_POLICY_VERSION,
  };
}

function safeUsage(body: Record<string, unknown>): OpenCodeUsage {
  const usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : {};
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

function chatContent(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices as Record<string, unknown>[] : [];
  const message = choices[0]?.message && typeof choices[0].message === "object" ? choices[0].message as Record<string, unknown> : {};
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).text ?? "") : "").join("");
  }
  throw new ConnectorError("classifier_output_missing", "OpenCode Zen returned no message content.");
}

function sanitizedErrorType(body: Record<string, unknown>): string | null {
  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  return typeof error.type === "string" ? error.type.slice(0, 100) : typeof error.code === "string" ? error.code.slice(0, 100) : null;
}

function retryAfterMilliseconds(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  }
  return Math.min(30_000, 750 * (2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 350));
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function requestOpenCodeZen(
  apiKey: string,
  body: Record<string, unknown>,
  options: { fetchImpl?: FetchLike; maximumAttempts?: number } = {},
): Promise<{ body: Record<string, unknown>; status: number; latencyMilliseconds: number; retries: number; rateLimitEvents: number }> {
  if (!apiKey) throw new ConnectorError("provider_secret_missing", "OPENCODE_ZEN_API_KEY is not configured.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maximumAttempts = Math.min(6, Math.max(1, Number(options.maximumAttempts ?? 4)));
  const started = Date.now();
  let rateLimitEvents = 0;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(OPENCODE_ZEN_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt >= maximumAttempts) throw new ConnectorError("provider_network_error", "OpenCode Zen could not be reached.", { retryable: true });
      await sleep(Math.min(30_000, 750 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 350)));
      continue;
    }
    const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok) return { body: parsed, status: response.status, latencyMilliseconds: Date.now() - started, retries: attempt - 1, rateLimitEvents };
    if (response.status === 401 || response.status === 403) throw new ConnectorError("provider_authentication_failed", "OpenCode Zen authentication was rejected.", { status: response.status });
    if (response.status === 404 || /model.*(not found|unavailable)/i.test(JSON.stringify(parsed).slice(0, 1000))) {
      throw new ConnectorError("provider_model_unavailable", `The exact model ${OPENCODE_ZEN_MODEL} is unavailable.`, { status: response.status });
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) throw new ConnectorError("provider_request_rejected", "OpenCode Zen rejected the classification request.", {
      status: response.status,
      details: { providerErrorType: sanitizedErrorType(parsed) },
    });
    if (response.status === 429) rateLimitEvents += 1;
    if (attempt >= maximumAttempts) throw new ConnectorError(response.status === 429 ? "provider_rate_limit_exhausted" : "provider_retry_exhausted", "OpenCode Zen remained unavailable after bounded retries.", { retryable: false, status: response.status });
    await sleep(retryAfterMilliseconds(response, attempt));
  }
  throw new ConnectorError("provider_retry_exhausted", "OpenCode Zen remained unavailable after bounded retries.");
}

async function syntheticVisionProbeJpeg(_env: Env): Promise<Uint8Array> {
  return syntheticVisionProbeJpegBytes();
}

function probePassed(content: string): { passed: boolean; exactTextObserved: boolean; blueSquareObserved: boolean; redCircleObserved: boolean } {
  const lower = content.toLocaleLowerCase("en");
  const exactTextObserved = content.includes("UCA VISION PROBE 2047");
  const blueSquareObserved = lower.includes("blue") && lower.includes("square");
  const redCircleObserved = lower.includes("red") && lower.includes("circle");
  return { passed: exactTextObserved && blueSquareObserved && redCircleObserved, exactTextObserved, blueSquareObserved, redCircleObserved };
}

function modelList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  if (body && typeof body === "object") {
    const value = body as Record<string, unknown>;
    if (Array.isArray(value.data)) return value.data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
    if (Array.isArray(value.models)) return value.models.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  }
  return [];
}

function sanitizedStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).slice(0, 16) : [];
}

function sanitizedModelMetadata(model: Record<string, unknown>): OpenCodeCapabilityReceipt["modelMetadata"] {
  const created = Number(model.created);
  const contextLength = Number(model.context_length);
  return {
    id: String(model.id ?? model.name ?? OPENCODE_ZEN_MODEL),
    object: model.object === undefined || model.object === null ? null : String(model.object),
    created: Number.isFinite(created) ? created : null,
    ownedBy: model.owned_by === undefined || model.owned_by === null ? null : String(model.owned_by),
    contextLength: Number.isFinite(contextLength) ? contextLength : null,
    inputModalities: sanitizedStringArray(model.input_modalities),
    outputModalities: sanitizedStringArray(model.output_modalities),
    pricingMetadataPresent: Boolean(model.pricing && typeof model.pricing === "object"),
  };
}

async function readCapabilityCache(env: Env): Promise<OpenCodeCapabilityReceipt | null> {
  const object = await env.ARTIFACTS.get(CAPABILITY_KEY);
  if (!object) return null;
  try {
    const receipt = JSON.parse(await object.text()) as OpenCodeCapabilityReceipt;
    if (receipt.provider !== "opencode_zen" || receipt.model !== OPENCODE_ZEN_MODEL || !receipt.visionProbe.passed) return null;
    if (Date.now() - Date.parse(receipt.discoveryTimestamp) > OPENCODE_CAPABILITY_CACHE_SECONDS * 1000) return null;
    return { ...receipt, discoveryCacheHit: true };
  } catch {
    return null;
  }
}

export async function discoverOpenCodeCapabilities(env: Env, options: { force?: boolean; fetchImpl?: FetchLike } = {}): Promise<OpenCodeCapabilityReceipt> {
  const apiKey = String(env.OPENCODE_ZEN_API_KEY ?? "");
  if (!apiKey) throw new ConnectorError("provider_secret_missing", "OPENCODE_ZEN_API_KEY is not configured.");
  if (!options.force) {
    const cached = await readCapabilityCache(env);
    if (cached) return cached;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const discoveryStarted = Date.now();
  let response: Response | null = null;
  let body: Record<string, unknown> = {};
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    response = await fetchImpl(OPENCODE_ZEN_MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${apiKey}` } });
    body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 401 || response.status === 403) throw new ConnectorError("provider_authentication_failed", "OpenCode Zen authentication was rejected during model discovery.", { status: response.status });
    if (response.ok) break;
    if (!(response.status === 429 || response.status >= 500) || attempt >= 4) throw new ConnectorError("provider_discovery_failed", "OpenCode Zen model discovery failed.", { retryable: false, status: response.status });
    await sleep(retryAfterMilliseconds(response, attempt));
  }
  if (!response?.ok) throw new ConnectorError("provider_discovery_failed", "OpenCode Zen model discovery failed.");
  const model = modelList(body).find((entry) => String(entry.id ?? entry.name ?? "") === OPENCODE_ZEN_MODEL);
  if (!model) throw new ConnectorError("provider_model_unavailable", `The exact model ${OPENCODE_ZEN_MODEL} is absent from live model discovery.`);

  const probeBytes = await syntheticVisionProbeJpeg(env);
  const dataUrl = `data:image/jpeg;base64,${bytesToBase64(probeBytes)}`;
  const baseMessages = [
    { role: "system", content: "Return JSON only." },
    {
      role: "user",
      content: [
        { type: "text", text: "Identify the two shapes, their colors, and the exact visible text. Return keys blue_shape, red_shape, visible_text." },
        { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
      ],
    },
  ];
  let detailFieldAccepted = true;
  let responseFormatAccepted = true;
  let result: Awaited<ReturnType<typeof requestOpenCodeZen>> | null = null;
  const variants = [
    { detail: true, responseFormat: true },
    { detail: true, responseFormat: false },
    { detail: false, responseFormat: false },
  ];
  for (const variant of variants) {
    const messages = structuredClone(baseMessages) as Record<string, unknown>[];
    if (!variant.detail) delete (((messages[1].content as Record<string, unknown>[])[1].image_url as Record<string, unknown>).detail);
    const request: Record<string, unknown> = { model: OPENCODE_ZEN_MODEL, messages, max_tokens: 350, temperature: 0 };
    if (variant.responseFormat) request.response_format = { type: "json_object" };
    try {
      result = await requestOpenCodeZen(apiKey, request, { fetchImpl, maximumAttempts: 2 });
      detailFieldAccepted = variant.detail;
      responseFormatAccepted = variant.responseFormat;
      break;
    } catch (error) {
      const safe = error as ConnectorError;
      if (safe.code !== "provider_request_rejected") throw error;
    }
  }
  if (!result) throw new ConnectorError("provider_vision_unsupported", "OpenCode Zen did not accept the bounded multimodal probe.");
  const content = chatContent(result.body);
  const observed = probePassed(content);
  if (!observed.passed) throw new ConnectorError("provider_vision_unsupported", "OpenCode Zen did not identify the synthetic image content reliably.", {
    details: { exactTextObserved: observed.exactTextObserved, blueSquareObserved: observed.blueSquareObserved, redCircleObserved: observed.redCircleObserved },
  });
  let jsonReliable = false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    jsonReliable = Boolean(parsed && typeof parsed === "object");
  } catch {
    jsonReliable = false;
  }
  const usage = safeUsage(result.body);
  const receipt: OpenCodeCapabilityReceipt = {
    provider: "opencode_zen",
    model: OPENCODE_ZEN_MODEL,
    endpointFamily: "openai_compatible_chat_completions",
    discoveryTimestamp: nowIso(),
    discoveryCacheHit: false,
    modelPresent: true,
    modelMetadata: sanitizedModelMetadata(model),
    visionProbe: {
      passed: true,
      status: result.status,
      latencyMilliseconds: Date.now() - discoveryStarted,
      exactTextObserved: observed.exactTextObserved,
      blueSquareObserved: observed.blueSquareObserved,
      redCircleObserved: observed.redCircleObserved,
      detailFieldAccepted,
      sanitizedUsage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens },
    },
    structuredOutput: { responseFormatAccepted, jsonObjectReliable: jsonReliable },
    costClassification: "provider_reported_unknown_or_free_model_id",
  };
  await putArtifact(env, CAPABILITY_KEY, JSON.stringify(receipt, null, 2), "application/json; charset=utf-8", {
    provider: receipt.provider,
    model: receipt.model,
    discoveryTimestamp: receipt.discoveryTimestamp,
    visionProbePassed: "true",
  });
  return receipt;
}

export async function classifierArtifactIdentity(input: {
  sourceRenderSha256: string;
  maxDimension: number;
  quality: number;
  transformationVersion?: string;
}): Promise<{ classifierArtifactId: string; r2Key: string; fingerprint: string }> {
  const material = {
    version: 1,
    sourceRenderSha256: input.sourceRenderSha256.toLowerCase(),
    maxDimension: Math.round(input.maxDimension),
    quality: Math.round(input.quality),
    format: "jpeg",
    transformationVersion: input.transformationVersion ?? OPENCODE_CLASSIFIER_ARTIFACT_VERSION,
  };
  const fingerprint = await sha256HexUtf8(canonicalJson(material));
  return {
    fingerprint,
    classifierArtifactId: `classifier_${fingerprint.slice(0, 48)}`,
    r2Key: `visual-classifier-cache/${input.sourceRenderSha256.toLowerCase()}/${fingerprint.slice(0, 2)}/${fingerprint}.jpg`,
  };
}

export async function createClassifierArtifact(
  env: Env,
  original: RenderArtifactManifest,
  options: { maxDimension?: number; quality?: number; transformationVersion?: string } = {},
): Promise<ClassifierArtifactManifest> {
  const maxDimension = Math.min(3000, Math.max(256, Number(options.maxDimension ?? 1280)));
  const quality = Math.min(100, Math.max(1, Number(options.quality ?? 82)));
  const transformationVersion = options.transformationVersion ?? OPENCODE_CLASSIFIER_ARTIFACT_VERSION;
  const identity = await classifierArtifactIdentity({ sourceRenderSha256: original.sha256, maxDimension, quality, transformationVersion });
  const manifestKey = `${identity.r2Key}.manifest.json`;
  if (await env.ARTIFACTS.head(identity.r2Key) && await env.ARTIFACTS.head(manifestKey)) {
    const cached = JSON.parse(await (await getArtifact(env, manifestKey)).text()) as ClassifierArtifactManifest;
    if (cached.classifierArtifactId === identity.classifierArtifactId && cached.sourceRenderSha256 === original.sha256) return { ...cached, cacheHit: true };
  }
  const source = await getArtifact(env, original.r2Key);
  const input = (env.IMAGES as any).input(source.body);
  const transformed = Math.max(original.width, original.height) > maxDimension
    ? input.transform({ width: maxDimension, height: maxDimension, fit: "scale-down" })
    : input;
  const output = await transformed.output({ format: "image/jpeg", quality, anim: false });
  const response = output.response();
  if (!response.ok) throw new ConnectorError("classifier_artifact_failed", "The bounded classifier derivative could not be generated.", { retryable: true });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const info = await (env.IMAGES as any).info(new Blob([bytes.slice().buffer], { type: "image/jpeg" }).stream());
  const sha256 = await sha256Bytes(bytes);
  const manifest: ClassifierArtifactManifest = {
    version: 1,
    classifierArtifactId: identity.classifierArtifactId,
    r2Key: identity.r2Key,
    sourceRenderArtifactId: original.renderArtifactId,
    sourceRenderSha256: original.sha256,
    sha256,
    byteSize: bytes.byteLength,
    width: Math.max(1, Number(info.width ?? Math.min(original.width, maxDimension))),
    height: Math.max(1, Number(info.height ?? Math.min(original.height, maxDimension))),
    mimeType: "image/jpeg",
    maxDimension,
    quality,
    transformationVersion,
    cacheHit: false,
    createdAt: nowIso(),
  };
  await putArtifact(env, identity.r2Key, bytes, "image/jpeg", {
    classifierArtifactId: identity.classifierArtifactId,
    sourceRenderSha256: original.sha256,
    sha256,
    transformationVersion,
  });
  await putArtifact(env, manifestKey, JSON.stringify(manifest, null, 2), "application/json; charset=utf-8", {
    classifierArtifactId: identity.classifierArtifactId,
    sha256,
  });
  return manifest;
}

export function validateClassificationObject(value: unknown): { valid: true; value: Record<string, unknown> } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["response must be one JSON object"] };
  const record = value as Record<string, unknown>;
  const allowed = new Set(["outcome", "confidence", "visual_type", "concise_description", "retain_rationale", "reject_rationale", "reusable_visual_structure", "continuation_likely", "continuation_title"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) errors.push(`unexpected field ${key}`);
  if (!OUTCOME_SET.has(String(record.outcome ?? "")) || record.outcome === "retain_series_member") errors.push("outcome is invalid");
  if (!Number.isFinite(Number(record.confidence)) || Number(record.confidence) < 0 || Number(record.confidence) > 1) errors.push("confidence must be between 0 and 1");
  if (typeof record.visual_type !== "string" || record.visual_type.length > 80) errors.push("visual_type is invalid");
  if (typeof record.concise_description !== "string" || record.concise_description.length > 700) errors.push("concise_description is invalid");
  for (const key of ["retain_rationale", "reject_rationale", "continuation_title"] as const) if (!(record[key] === null || typeof record[key] === "string")) errors.push(`${key} must be string or null`);
  if (typeof record.reusable_visual_structure !== "boolean") errors.push("reusable_visual_structure must be boolean");
  if (typeof record.continuation_likely !== "boolean") errors.push("continuation_likely must be boolean");
  return errors.length ? { valid: false, errors } : { valid: true, value: record };
}

function proposalFromValue(value: Record<string, unknown>, deterministic: DeterministicSignal, secondPass: boolean): ClassificationProposal {
  const modelOutcome = String(value.outcome ?? "needs_review") as PreparedOutcome;
  const disagreement = deterministic.outcome !== null && deterministic.outcome !== modelOutcome;
  let outcome = modelOutcome;
  if (disagreement || !Number.isFinite(Number(value.confidence))) outcome = "needs_review";
  return {
    outcome,
    confidence: boundedConfidence(value.confidence),
    visualType: String(value.visual_type ?? "other").slice(0, 80),
    conciseDescription: String(value.concise_description ?? "Candidate visual composition.").slice(0, 700),
    retainRationale: value.retain_rationale === null ? null : String(value.retain_rationale ?? "").slice(0, 1000) || null,
    rejectRationale: value.reject_rationale === null ? null : String(value.reject_rationale ?? "").slice(0, 1000) || null,
    reusableVisualStructure: Boolean(value.reusable_visual_structure),
    continuationLikely: Boolean(value.continuation_likely),
    continuationTitle: value.continuation_title === null ? null : String(value.continuation_title ?? "").slice(0, 300) || null,
    deterministicOutcome: deterministic.outcome,
    deterministicReason: deterministic.reason,
    modelOutcome,
    modelReason: disagreement ? "Deterministic and model outcomes disagree." : null,
    disagreement,
    secondPassApplied: secondPass,
  };
}

function reviewRoute(proposal: ClassificationProposal, confidenceThreshold: number): { proposal: ClassificationProposal; reason: string | null } {
  let reason: string | null = null;
  if (proposal.disagreement) reason = "deterministic_model_disagreement";
  else if (proposal.confidence < confidenceThreshold) reason = "low_confidence";
  else if (proposal.outcome === "reject" && (STRUCTURAL_TYPES.has(proposal.visualType) || proposal.reusableVisualStructure)) reason = "structural_reject_requires_review";
  else if (proposal.continuationLikely) reason = "suspected_page_series";
  else if (/unreadable|illegible|dense|insufficient detail|not enough detail|cannot read/i.test(`${proposal.conciseDescription} ${proposal.modelReason ?? ""} ${proposal.rejectRationale ?? ""}`)) reason = "visual_detail_insufficient";
  if (!reason) return { proposal, reason: null };
  return {
    reason,
    proposal: {
      ...proposal,
      outcome: "needs_review",
      disagreement: proposal.disagreement || reason === "deterministic_model_disagreement",
      modelReason: proposal.modelReason ?? reason,
    },
  };
}

function invalidProposal(deterministic: DeterministicSignal, secondPass: boolean, reason: string): ClassificationProposal {
  return {
    outcome: "needs_review",
    confidence: 0,
    visualType: "other",
    conciseDescription: "Provider output remained invalid after one correction attempt.",
    retainRationale: "Parsing failure cannot become an automatic rejection.",
    rejectRationale: null,
    reusableVisualStructure: true,
    continuationLikely: false,
    continuationTitle: null,
    deterministicOutcome: deterministic.outcome,
    deterministicReason: deterministic.reason,
    modelOutcome: null,
    modelReason: reason,
    disagreement: deterministic.outcome !== null,
    secondPassApplied: secondPass,
  };
}

export type OpenCodeClassifierQueueMessage = {
  version: 1;
  kind: "visual_classifier";
  jobId: string;
  candidate: VisualCandidate;
  classifierArtifact: ClassifierArtifactManifest | null;
  prompt: string;
  deterministic: DeterministicSignal;
  model: string;
  rubricVersion: string;
  promptVersion: string;
  passNumber: 1 | 2;
  confidenceThreshold: number;
  capability: AnyOpenCodeCapabilityReceipt;
  provider?: "opencode_zen" | "opencode_go";
  mode?: "opencode_chat_completions" | "opencode_go_chat_completions";
  credentialBindingName?: "OPENCODE_GO_API_KEY" | "OPENCODE_ZEN_API_KEY";
  spendLedgerKey?: string;
  maxBillableRequests?: number;
  maxEstimatedSpendUsd?: number;
  requestIdentity: string;
  resultKey: string;
  createdAt: string;
};

export async function prepareOpenCodeClassifierQueueMessage(input: {
  env: Env;
  jobId: string;
  candidate: VisualCandidate;
  originalArtifact: RenderArtifactManifest | null;
  prompt: string;
  deterministic: DeterministicSignal;
  model: string;
  rubricVersion: string;
  promptVersion: string;
  passNumber: 1 | 2;
  confidenceThreshold: number;
  capability: AnyOpenCodeCapabilityReceipt;
  classifierMaxDimension?: number;
  classifierQuality?: number;
  highDetail?: boolean;
}): Promise<{ message: OpenCodeClassifierQueueMessage; cached: OpenCodeClassifiedCandidate | null }> {
  const derivative = input.originalArtifact
    ? await createClassifierArtifact(input.env, input.originalArtifact, {
      maxDimension: input.highDetail ? Math.min(2400, Math.max(1600, Number(input.classifierMaxDimension ?? 1280) * 1.5)) : input.classifierMaxDimension,
      quality: input.classifierQuality,
    })
    : null;
  const requestIdentity = await sha256HexUtf8(canonicalJson({
    version: 1,
    jobId: input.jobId,
    candidateId: input.candidate.stableVisualId,
    classifierArtifactSha256: derivative?.sha256 ?? input.candidate.embeddedSha256 ?? null,
    provider: input.capability.provider,
    mode: "mode" in input.capability ? input.capability.mode : "opencode_chat_completions",
    credentialBindingName: "credentialBindingName" in input.capability ? input.capability.credentialBindingName : "OPENCODE_ZEN_API_KEY",
    model: input.model,
    rubricVersion: input.rubricVersion,
    promptVersion: input.promptVersion,
    passNumber: input.passNumber,
  }));
  const resultKey = `visual-compiler/jobs/${input.jobId}/${input.capability.provider === "opencode_go" ? "opencode-go" : "opencode"}/results/${input.candidate.stableVisualId}/pass-${input.passNumber}/${requestIdentity}.json`;
  const existing = await input.env.ARTIFACTS.get(resultKey);
  if (existing) {
    const cached = JSON.parse(await existing.text()) as OpenCodeClassifiedCandidate;
    return {
      message: {
        version: 1,
        kind: "visual_classifier",
        jobId: input.jobId,
        candidate: input.candidate,
        classifierArtifact: derivative,
        prompt: input.prompt,
        deterministic: input.deterministic,
        model: input.model,
        rubricVersion: input.rubricVersion,
        promptVersion: input.promptVersion,
        passNumber: input.passNumber,
        confidenceThreshold: input.confidenceThreshold,
        capability: input.capability,
        provider: input.capability.provider,
        mode: input.capability.provider === "opencode_go" ? OPENCODE_GO_MODE : "opencode_chat_completions",
        credentialBindingName: input.capability.provider === "opencode_go" ? input.capability.credentialBindingName : "OPENCODE_ZEN_API_KEY",
        spendLedgerKey: input.capability.provider === "opencode_go" ? input.capability.spendLedgerKey : undefined,
        maxBillableRequests: input.capability.provider === "opencode_go" ? input.capability.maxBillableRequests : undefined,
        maxEstimatedSpendUsd: input.capability.provider === "opencode_go" ? input.capability.maxEstimatedSpendUsd : undefined,
        requestIdentity,
        resultKey,
        createdAt: nowIso(),
      },
      cached: { ...cached, idempotentReplay: true, classifierArtifact: cached.classifierArtifact ? { ...cached.classifierArtifact, cacheHit: true } : null },
    };
  }
  return {
    message: {
      version: 1,
      kind: "visual_classifier",
      jobId: input.jobId,
      candidate: input.candidate,
      classifierArtifact: derivative,
      prompt: input.prompt,
      deterministic: input.deterministic,
      model: input.model,
      rubricVersion: input.rubricVersion,
      promptVersion: input.promptVersion,
      passNumber: input.passNumber,
      confidenceThreshold: input.confidenceThreshold,
      capability: input.capability,
      requestIdentity,
      resultKey,
      createdAt: nowIso(),
    },
    cached: null,
  };
}

export async function readOpenCodeClassifierQueueResult(env: Env, resultKey: string): Promise<OpenCodeClassifiedCandidate | null> {
  const object = await env.ARTIFACTS.get(resultKey);
  return object ? JSON.parse(await object.text()) as OpenCodeClassifiedCandidate : null;
}

export async function processOpenCodeClassifierQueueMessage(
  env: Env,
  message: OpenCodeClassifierQueueMessage,
  options: { fetchImpl?: FetchLike } = {},
): Promise<OpenCodeClassifiedCandidate> {
  if (message.version !== 1 || message.kind !== "visual_classifier" || !message.requestIdentity || !message.resultKey) {
    throw new ConnectorError("visual_classifier_message_invalid", "The visual classifier queue message is invalid.");
  }
  const existing = await readOpenCodeClassifierQueueResult(env, message.resultKey);
  if (existing) return { ...existing, idempotentReplay: true };
  const isGo = message.provider === "opencode_go" || message.capability.provider === "opencode_go";
  const apiKey = isGo ? "" : String(env.OPENCODE_ZEN_API_KEY ?? "");
  if (!isGo && !apiKey) throw new ConnectorError("provider_secret_missing", "OPENCODE_ZEN_API_KEY is not configured.");
  if (isGo && !message.spendLedgerKey) throw new ConnectorError("provider_spend_ledger_missing", "OpenCode Go classification requires an immutable spend ledger.");

  const content: Record<string, unknown>[] = [{ type: "text", text: message.prompt }];
  if (message.classifierArtifact) {
    const bytes = new Uint8Array(await (await getArtifact(env, message.classifierArtifact.r2Key)).arrayBuffer());
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${bytesToBase64(bytes)}`,
        ...(message.capability.visionProbe.detailFieldAccepted ? { detail: message.passNumber === 2 ? "high" : "auto" } : {}),
      },
    });
  }
  const messages: Record<string, unknown>[] = [
    { role: "system", content: "Return exactly one JSON object and no Markdown. Do not infer unreadable labels. Use needs_review when uncertain." },
    { role: "user", content },
  ];
  const request: Record<string, unknown> = { model: message.model, messages, max_tokens: 1400, temperature: 0 };
  if (message.capability.structuredOutput.responseFormatAccepted) request.response_format = { type: "json_object" };

  let aggregateRetries = 0;
  let aggregateRateLimits = 0;
  let aggregateLatency = 0;
  let aggregateUsage: OpenCodeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let parserResult: OpenCodeClassifiedCandidate["parserResult"] = "persistent_invalid";
  let parsedValue: Record<string, unknown> | null = null;
  let rawDiagnostic = "";
  let validationErrors: string[] = [];
  for (let correction = 0; correction < 2; correction += 1) {
    if (correction === 1) {
      (messages[1].content as Record<string, unknown>[]).unshift({
        type: "text",
        text: `Your previous response failed validation: ${validationErrors.join("; ")}. Return a corrected JSON object only, preserving the visual meaning.`,
      });
    }
    const response = isGo
      ? await requestOpenCodeGo({
          env,
          credentialBindingName: message.credentialBindingName ?? selectOpenCodeGoCredentialBinding(env),
          spendLedgerKey: String(message.spendLedgerKey ?? ""),
          body: request,
          context: `candidate:${message.candidate.stableVisualId}:pass:${message.passNumber}:correction:${correction + 1}`,
          requestIdentity: message.requestIdentity,
          fetchImpl: options.fetchImpl,
        })
      : await requestOpenCodeZen(apiKey, request, { fetchImpl: options.fetchImpl, maximumAttempts: 4 });
    aggregateRetries += "retries" in response ? response.retries : 0;
    aggregateRateLimits += "rateLimitEvents" in response ? response.rateLimitEvents : 0;
    aggregateLatency += response.latencyMilliseconds;
    const usage: OpenCodeUsage = "usage" in response
      ? { inputTokens: response.usage.inputTokens ?? 0, outputTokens: response.usage.outputTokens ?? 0, totalTokens: response.usage.totalTokens ?? 0, cachedReadTokens: response.usage.cachedReadTokens ?? 0, usageReported: response.usage.reported }
      : safeUsage(response.body);
    aggregateUsage = {
      inputTokens: aggregateUsage.inputTokens + usage.inputTokens,
      outputTokens: aggregateUsage.outputTokens + usage.outputTokens,
      totalTokens: aggregateUsage.totalTokens + usage.totalTokens,
      cachedReadTokens: (aggregateUsage.cachedReadTokens ?? 0) + (usage.cachedReadTokens ?? 0),
      usageReported: (aggregateUsage.usageReported ?? true) && (usage.usageReported ?? true),
    };
    rawDiagnostic = chatContent(response.body).slice(0, 8000);
    let parsed: unknown;
    try { parsed = JSON.parse(rawDiagnostic); }
    catch { validationErrors = ["response is not valid JSON"]; continue; }
    const validation = validateClassificationObject(parsed);
    if (!validation.valid) { validationErrors = validation.errors; continue; }
    parsedValue = validation.value;
    parserResult = correction === 0 ? "valid_first_response" : "valid_after_retry";
    break;
  }

  let proposal: ClassificationProposal;
  let reviewRoutingReason: string | null = null;
  if (parsedValue) {
    const routed = reviewRoute(proposalFromValue(parsedValue, message.deterministic, message.passNumber === 2), message.confidenceThreshold);
    proposal = routed.proposal;
    reviewRoutingReason = routed.reason;
  } else {
    proposal = invalidProposal(message.deterministic, message.passNumber === 2, validationErrors.join("; ") || "persistent schema failure");
    reviewRoutingReason = "persistent_schema_failure";
    const diagnosticKey = `visual-compiler/jobs/${message.jobId}/${isGo ? "opencode-go" : "opencode"}/diagnostics/${message.candidate.stableVisualId}/pass-${message.passNumber}/${message.requestIdentity}.json`;
    await putArtifact(env, diagnosticKey, JSON.stringify({
      version: 1,
      provider: isGo ? OPENCODE_GO_PROVIDER : OPENCODE_ZEN_PROVIDER,
      model: message.model,
      candidateId: message.candidate.stableVisualId,
      passNumber: message.passNumber,
      validationErrors,
      boundedRawResponse: rawDiagnostic,
      createdAt: nowIso(),
    }, null, 2), "application/json; charset=utf-8", {
      provider: isGo ? OPENCODE_GO_PROVIDER : OPENCODE_ZEN_PROVIDER,
      candidateId: message.candidate.stableVisualId,
      passNumber: String(message.passNumber),
    });
  }
  const result: OpenCodeClassifiedCandidate = {
    proposal,
    usage: aggregateUsage,
    latencyMilliseconds: aggregateLatency,
    retries: aggregateRetries,
    rateLimitEvents: aggregateRateLimits,
    parserResult,
    schemaValidationResult: parsedValue ? "valid" : "invalid",
    classifierArtifact: message.classifierArtifact,
    requestIdentity: message.requestIdentity,
    idempotentReplay: false,
    endpointFamily: "openai_compatible_chat_completions",
    passNumber: message.passNumber,
    reviewRoutingReason,
    provider: isGo ? "opencode_go" : "opencode_zen",
    accounting: isGo ? await import("./visual-catalogue-opencode-go").then((module) => module.readOpenCodeGoSpendLedger(env, String(message.spendLedgerKey))) : null,
  };
  await putArtifact(env, message.resultKey, JSON.stringify(result, null, 2), "application/json; charset=utf-8", {
    provider: isGo ? OPENCODE_GO_PROVIDER : OPENCODE_ZEN_PROVIDER,
    model: message.model,
    candidateId: message.candidate.stableVisualId,
    requestIdentity: message.requestIdentity,
    parserResult,
  });
  return result;
}

export async function classifyOpenCodeCandidate(input: {
  env: Env;
  jobId: string;
  candidate: VisualCandidate;
  originalArtifact: RenderArtifactManifest | null;
  prompt: string;
  deterministic: DeterministicSignal;
  model: string;
  rubricVersion: string;
  promptVersion: string;
  passNumber: 1 | 2;
  confidenceThreshold: number;
  capability: OpenCodeCapabilityReceipt;
  classifierMaxDimension?: number;
  classifierQuality?: number;
  highDetail?: boolean;
  fetchImpl?: FetchLike;
}): Promise<OpenCodeClassifiedCandidate> {
  const prepared = await prepareOpenCodeClassifierQueueMessage(input);
  if (prepared.cached) return prepared.cached;
  return processOpenCodeClassifierQueueMessage(input.env, prepared.message, { fetchImpl: input.fetchImpl });
}

export function mergeTwoPassOpenCode(first: OpenCodeClassifiedCandidate, second: OpenCodeClassifiedCandidate): OpenCodeClassifiedCandidate {
  if (first.proposal.modelOutcome === second.proposal.modelOutcome && first.proposal.outcome === second.proposal.outcome) return second;
  return {
    ...second,
    proposal: {
      ...second.proposal,
      outcome: "needs_review",
      disagreement: true,
      modelReason: "OpenCode pass 1 and pass 2 disagree.",
      secondPassApplied: true,
    },
    reviewRoutingReason: "two_pass_disagreement",
  };
}

export function safeOpenCodePrompt(input: {
  sourceType: SourceType;
  routingMode: RoutingMode;
  candidate: VisualCandidate;
  deterministicReason: string | null;
  adjacent: Array<{ stableKey: string; pageOrSlide: number | null; description?: string }>;
  secondPass: boolean;
}): string {
  return [
    "Classify one candidate for a controlled resilience-planning visual library.",
    "The source is an explicitly public published document eligible for third-party model processing.",
    "False rejection is the higher-cost error. Use needs_review whenever uncertain.",
    "Retain maps, plans, diagrams, frameworks, charts, implementation compositions, evidence-rich photographs, and reusable spatial or process compositions.",
    "Reject blank, branding-only, credits, contents, text-only, and generic decorative pages unless independently reusable.",
    "Mark duplicate_context_only only when this page merely contextualizes an already represented asset.",
    `Source type: ${input.sourceType}. Routing mode: ${input.routingMode}.`,
    `Candidate key: ${input.candidate.stableKey}. Page/slide: ${input.candidate.pageOrSlide ?? "n/a"}.`,
    input.candidate.caption ? `Caption: ${input.candidate.caption.slice(0, 1000)}` : "",
    input.candidate.heading ? `Heading: ${input.candidate.heading.slice(0, 500)}` : "",
    input.candidate.nearbyText ? `Minimal nearby text: ${input.candidate.nearbyText.slice(0, 2500)}` : "",
    input.deterministicReason ? `Deterministic signal: ${input.deterministicReason}` : "",
    input.adjacent.length ? `Adjacent metadata: ${JSON.stringify(input.adjacent).slice(0, 1500)}` : "",
    input.secondPass ? "This is a conservative second pass. Inspect structure, legibility, and possible continuation carefully." : "",
    "Return fields: outcome, confidence, visual_type, concise_description, retain_rationale, reject_rationale, reusable_visual_structure, continuation_likely, continuation_title.",
  ].filter(Boolean).join("\n");
}
