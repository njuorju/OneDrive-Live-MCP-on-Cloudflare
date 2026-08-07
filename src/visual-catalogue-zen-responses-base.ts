import { ConnectorError } from "./errors";
import { getArtifact, nowIso, putArtifact, sha256HexUtf8 } from "./paid-core";

export const ZEN_RESPONSES_PROVIDER = "opencode_zen_responses" as const;
export const ZEN_RESPONSES_MODE = "opencode_responses" as const;
export const ZEN_RESPONSES_MODEL = "gpt-5.6-luna" as const;
export const ZEN_RESPONSES_ENDPOINT = "https://opencode.ai/zen/v1/responses" as const;
export const ZEN_RESPONSES_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models" as const;
export const ZEN_RESPONSES_ENDPOINT_FAMILY = "opencode_zen_responses" as const;
export const ZEN_RESPONSES_PROBE_VERSION = "odl-req-025-zen-responses-v1" as const;
export const ZEN_RESPONSES_CREDENTIAL_BINDING = "OPENCODE_ZEN_API_KEY" as const;
export const ZEN_RESPONSES_MAX_BILLABLE_REQUESTS = 75;
export const ZEN_RESPONSES_MAX_ESTIMATED_SPEND_USD = 1;
export const ZEN_RESPONSES_FALLBACK_PRICING_VERSION = "gpt-5.6-luna-fallback-2026-08-04" as const;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ZEN_RESPONSES_TIMEOUT_MS = 60_000;

export type ZenResponsesPricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedReadPerMillionUsd: number;
  cachedWritePerMillionUsd: number;
  source: "provider_model_metadata" | "fallback_price_table";
  version: string;
};

export const ZEN_RESPONSES_FALLBACK_PRICING: ZenResponsesPricing = {
  inputPerMillionUsd: 0.20,
  outputPerMillionUsd: 1.20,
  cachedReadPerMillionUsd: 0.02,
  cachedWritePerMillionUsd: 0.25,
  source: "fallback_price_table",
  version: ZEN_RESPONSES_FALLBACK_PRICING_VERSION,
};

export type ZenResponsesUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  totalTokens: number | null;
  reported: boolean;
};

export type ZenResponsesAccountingEntry = {
  sequence: number;
  timestamp: string;
  context: string;
  httpStatus: number;
  costBearing: boolean;
  usage: ZenResponsesUsage;
  estimatedIncrementalCostUsd: number | null;
  requestIdentity: string | null;
};

export type ZenResponsesSpendLedger = {
  version: 1;
  scopeId: string;
  provider: typeof ZEN_RESPONSES_PROVIDER;
  mode: typeof ZEN_RESPONSES_MODE;
  model: typeof ZEN_RESPONSES_MODEL;
  credentialBindingName: typeof ZEN_RESPONSES_CREDENTIAL_BINDING;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
  billableRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  usageNotReportedResponses: number;
  estimatedSpendUsd: number | null;
  pricing: ZenResponsesPricing;
  remainingRequestAllowance: number;
  remainingEstimatedDollarAllowance: number | null;
  dollarEnforcement: "exact_estimate" | "conservative_request_ceiling_only";
  status: "active" | "request_limit_reached" | "dollar_limit_reached";
  responses: ZenResponsesAccountingEntry[];
  createdAt: string;
  updatedAt: string;
};

export type ZenResponsesModelMetadata = {
  id: string;
  enabled: boolean;
  inputModalities: string[];
  outputModalities: string[];
  pricingMetadataPresent: boolean;
  pricing: ZenResponsesPricing;
};

export type ZenResponsesCapabilityReceipt = {
  provider: typeof ZEN_RESPONSES_PROVIDER;
  mode: typeof ZEN_RESPONSES_MODE;
  model: typeof ZEN_RESPONSES_MODEL;
  exactModel: typeof ZEN_RESPONSES_MODEL;
  endpoint: typeof ZEN_RESPONSES_ENDPOINT;
  endpointFamily: typeof ZEN_RESPONSES_ENDPOINT_FAMILY;
  probeVersion: typeof ZEN_RESPONSES_PROBE_VERSION;
  credentialBindingName: typeof ZEN_RESPONSES_CREDENTIAL_BINDING;
  discoveryTimestamp: string;
  discoveryCacheHit: boolean;
  modelPresent: true;
  modelMetadata: ZenResponsesModelMetadata;
  visionProbe: {
    passed: true;
    status: number;
    latencyMilliseconds: number;
    exactTextObserved: boolean;
    blueSquareObserved: boolean;
    redCircleObserved: boolean;
    detailFieldAccepted: false;
    sanitizedUsage: ZenResponsesUsage;
  };
  structuredOutput: {
    responseFormatAccepted: true;
    jsonObjectReliable: true;
  };
  spendScopeId: string;
  spendLedgerKey: string;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
  accounting: ZenResponsesSpendLedger;
  costClassification: "provider_metered_or_fallback_estimate" | "usage_not_reported";
};

export type ZenResponsesStructuralReceipt = {
  topLevelKeys: string[];
  outputItemTypes: string[];
  outputContentPartTypes: string[];
  completionStatus: string | null;
  incompleteReason: string | null;
  usagePresent: boolean;
  requestFingerprint: string;
  responseFingerprint: string;
  httpStatus: number;
  responseClass: "completed_output" | "incomplete" | "refusal" | "reasoning_only" | "malformed";
};


export type ZenResponsesTransportReceipt = {
  version: 1;
  provider: typeof ZEN_RESPONSES_PROVIDER;
  mode: typeof ZEN_RESPONSES_MODE;
  model: typeof ZEN_RESPONSES_MODEL;
  endpointClass: "responses_post";
  stage: string;
  requestByteCount: number | null;
  requestShapeFingerprint: string | null;
  timeoutMilliseconds: number;
  fetchBegan: boolean;
  credentialBindingExists: boolean;
  correlationId: string;
  httpStatus: number | null;
  responseContentType: string | null;
  declaredContentLength: number | null;
  providerRequestId: string | null;
  edgeRequestId: string | null;
  responseByteCount: number | null;
  responseShapeFingerprint: string | null;
  parserResult: string;
  schemaResult: string;
  usagePresent: boolean | null;
  localErrorCode: string | null;
  localErrorClass: string | null;
  errorName: string | null;
  errorMessage: string | null;
  codeLocation: string | null;
  requestMethod: "POST";
  headerNames: string[];
  signalPresent: boolean;
  redirectMode: "error";
  fetchImplementationClass: "unresolved" | "invalid_explicit" | "global_fetch_missing" | "explicit_injected" | "global_fetch_bound";
};

export class ZenResponsesTransportError extends ConnectorError {
  readonly receipt: ZenResponsesTransportReceipt;

  constructor(
    code: string,
    message: string,
    receipt: ZenResponsesTransportReceipt,
    options: { retryable?: boolean; status?: number } = {},
  ) {
    super(code, message, {
      ...options,
      correlationId: receipt.correlationId,
      details: { transportReceipt: receipt },
    });
    this.receipt = receipt;
  }
}

export function isZenResponsesTransportError(error: unknown): error is ZenResponsesTransportError {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const receipt = record.receipt;
  return typeof record.code === "string"
    && Boolean(receipt && typeof receipt === "object" && (receipt as Record<string, unknown>).endpointClass === "responses_post");
}

function boundedInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function boundedNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function firstRate(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const result = boundedNumber(record[key]);
    if (result !== null) return result;
  }
  return null;
}

export function resolveZenResponsesPricing(model: Record<string, unknown> | null | undefined): ZenResponsesPricing {
  const pricing = model?.pricing && typeof model.pricing === "object" ? model.pricing as Record<string, unknown> : null;
  if (!pricing) return { ...ZEN_RESPONSES_FALLBACK_PRICING };
  const input = firstRate(pricing, ["input_per_million", "input_per_1m_tokens"]);
  const output = firstRate(pricing, ["output_per_million", "output_per_1m_tokens"]);
  const cachedRead = firstRate(pricing, ["cached_read_per_million", "cached_input_per_million"]);
  const cachedWrite = firstRate(pricing, ["cached_write_per_million", "cache_write_per_million"]);
  if ([input, output, cachedRead, cachedWrite].every((value) => value !== null)) {
    return {
      inputPerMillionUsd: input as number,
      outputPerMillionUsd: output as number,
      cachedReadPerMillionUsd: cachedRead as number,
      cachedWritePerMillionUsd: cachedWrite as number,
      source: "provider_model_metadata",
      version: String(pricing.version ?? model?.id ?? ZEN_RESPONSES_MODEL).slice(0, 120),
    };
  }
  return { ...ZEN_RESPONSES_FALLBACK_PRICING };
}

export function parseZenResponsesUsage(body: Record<string, unknown>): ZenResponsesUsage {
  const usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : null;
  if (!usage) return { inputTokens: null, outputTokens: null, cachedReadTokens: null, cachedWriteTokens: null, totalTokens: null, reported: false };
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object" ? usage.input_tokens_details as Record<string, unknown> : {};
  const inputTokens = boundedInteger(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = boundedInteger(usage.output_tokens ?? usage.completion_tokens);
  const cachedReadTokens = boundedInteger(usage.cached_read_tokens ?? inputDetails.cached_tokens ?? inputDetails.cached_read_tokens);
  const cachedWriteTokensReported = boundedInteger(usage.cached_write_tokens ?? inputDetails.cached_write_tokens);
  const explicitTotalTokens = boundedInteger(usage.total_tokens);
  const usageKnown = inputTokens !== null || outputTokens !== null || cachedReadTokens !== null || explicitTotalTokens !== null;
  const cachedWriteTokens = cachedWriteTokensReported ?? (usageKnown ? 0 : null);
  const totalTokens = explicitTotalTokens ?? (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);
  const reported = [inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens].some((value) => value !== null);
  return { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens, reported };
}

export function validateZenResponsesBudgets(maxBillableRequests: unknown, maxEstimatedSpendUsd: unknown): { maxBillableRequests: number; maxEstimatedSpendUsd: number } {
  const requests = Number(maxBillableRequests);
  const dollars = Number(maxEstimatedSpendUsd);
  if (!Number.isInteger(requests) || requests < 1 || requests > ZEN_RESPONSES_MAX_BILLABLE_REQUESTS) {
    throw new ConnectorError("provider_request_budget_invalid", "maxBillableRequests must be an integer from 1 through 75.");
  }
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > ZEN_RESPONSES_MAX_ESTIMATED_SPEND_USD) {
    throw new ConnectorError("provider_spend_budget_invalid", "maxEstimatedSpendUsd must be greater than zero and no more than 1.00.");
  }
  return { maxBillableRequests: requests, maxEstimatedSpendUsd: Number(dollars.toFixed(6)) };
}

export function zenResponsesCredential(env: Pick<Env, "OPENCODE_ZEN_API_KEY">): string {
  const value = String(env.OPENCODE_ZEN_API_KEY ?? "").trim();
  if (!value) throw new ConnectorError("provider_secret_missing", "OPENCODE_ZEN_API_KEY is not configured.");
  return value;
}

export function zenResponsesSpendLedgerKey(scopeId: string): string {
  return `visual-compiler/provider-spend/opencode-zen-responses/${ZEN_RESPONSES_MODEL}/${scopeId}.json`;
}

async function storeLedger(env: Env, key: string, ledger: ZenResponsesSpendLedger): Promise<void> {
  ledger.updatedAt = nowIso();
  await putArtifact(env, key, JSON.stringify(ledger, null, 2), "application/json; charset=utf-8", {
    provider: ledger.provider, model: ledger.model, scopeId: ledger.scopeId, status: ledger.status,
  });
}

export async function initializeZenResponsesSpendLedger(
  env: Env,
  scopeId: string,
  maxBillableRequests: number,
  maxEstimatedSpendUsd: number,
  pricing: ZenResponsesPricing = ZEN_RESPONSES_FALLBACK_PRICING,
): Promise<{ key: string; ledger: ZenResponsesSpendLedger }> {
  const key = zenResponsesSpendLedgerKey(scopeId);
  const existing = await env.ARTIFACTS.get(key);
  if (existing) return { key, ledger: JSON.parse(await existing.text()) as ZenResponsesSpendLedger };
  const timestamp = nowIso();
  const ledger: ZenResponsesSpendLedger = {
    version: 1, scopeId, provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE, model: ZEN_RESPONSES_MODEL,
    credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING, maxBillableRequests, maxEstimatedSpendUsd,
    billableRequestCount: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0,
    usageNotReportedResponses: 0, estimatedSpendUsd: 0, pricing,
    remainingRequestAllowance: maxBillableRequests, remainingEstimatedDollarAllowance: maxEstimatedSpendUsd,
    dollarEnforcement: "exact_estimate", status: "active", responses: [], createdAt: timestamp, updatedAt: timestamp,
  };
  await storeLedger(env, key, ledger);
  return { key, ledger };
}

export async function readZenResponsesSpendLedger(env: Env, key: string): Promise<ZenResponsesSpendLedger> {
  return JSON.parse(await (await getArtifact(env, key)).text()) as ZenResponsesSpendLedger;
}

export async function updateZenResponsesPricing(env: Env, key: string, pricing: ZenResponsesPricing): Promise<ZenResponsesSpendLedger> {
  const ledger = await readZenResponsesSpendLedger(env, key);
  ledger.pricing = pricing;
  await storeLedger(env, key, ledger);
  return ledger;
}

export async function assertZenResponsesBudgetAvailable(env: Env, key: string): Promise<ZenResponsesSpendLedger> {
  const ledger = await readZenResponsesSpendLedger(env, key);
  if (ledger.billableRequestCount >= ledger.maxBillableRequests) throw new ConnectorError("provider_request_budget_exhausted", "The Zen Responses request ceiling has been reached.");
  if (ledger.estimatedSpendUsd !== null && ledger.estimatedSpendUsd >= ledger.maxEstimatedSpendUsd) throw new ConnectorError("provider_spend_budget_exhausted", "The Zen Responses estimated-spend ceiling has been reached.");
  return ledger;
}

function incrementalCost(usage: ZenResponsesUsage, pricing: ZenResponsesPricing): number | null {
  if (!usage.reported) return null;
  return Number((
    ((usage.inputTokens ?? 0) * pricing.inputPerMillionUsd
      + (usage.outputTokens ?? 0) * pricing.outputPerMillionUsd
      + (usage.cachedReadTokens ?? 0) * pricing.cachedReadPerMillionUsd
      + (usage.cachedWriteTokens ?? 0) * pricing.cachedWritePerMillionUsd) / 1_000_000
  ).toFixed(9));
}

export async function recordZenResponsesAccounting(input: {
  env: Env;
  key: string;
  context: string;
  httpStatus: number;
  usage: ZenResponsesUsage;
  requestIdentity?: string | null;
}): Promise<ZenResponsesSpendLedger> {
  const ledger = await readZenResponsesSpendLedger(input.env, input.key);
  const costBearing = input.httpStatus >= 200 && input.httpStatus < 300;
  const incremental = costBearing ? incrementalCost(input.usage, ledger.pricing) : 0;
  if (costBearing) {
    ledger.billableRequestCount += 1;
    if (input.usage.reported) {
      ledger.inputTokens += input.usage.inputTokens ?? 0;
      ledger.outputTokens += input.usage.outputTokens ?? 0;
      ledger.cachedReadTokens += input.usage.cachedReadTokens ?? 0;
      ledger.cachedWriteTokens += input.usage.cachedWriteTokens ?? 0;
      ledger.estimatedSpendUsd = Number(((ledger.estimatedSpendUsd ?? 0) + (incremental ?? 0)).toFixed(9));
    } else {
      ledger.usageNotReportedResponses += 1;
      ledger.estimatedSpendUsd = null;
      ledger.dollarEnforcement = "conservative_request_ceiling_only";
    }
  }
  ledger.responses.push({
    sequence: ledger.responses.length + 1, timestamp: nowIso(), context: input.context, httpStatus: input.httpStatus,
    costBearing, usage: input.usage, estimatedIncrementalCostUsd: incremental, requestIdentity: input.requestIdentity ?? null,
  });
  ledger.responses = ledger.responses.slice(-100);
  ledger.remainingRequestAllowance = Math.max(0, ledger.maxBillableRequests - ledger.billableRequestCount);
  ledger.remainingEstimatedDollarAllowance = ledger.estimatedSpendUsd === null ? null : Math.max(0, Number((ledger.maxEstimatedSpendUsd - ledger.estimatedSpendUsd).toFixed(9)));
  ledger.status = ledger.remainingRequestAllowance <= 0 ? "request_limit_reached" : ledger.remainingEstimatedDollarAllowance !== null && ledger.remainingEstimatedDollarAllowance <= 0 ? "dollar_limit_reached" : "active";
  await storeLedger(input.env, input.key, ledger);
  return ledger;
}

function modelList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return list.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).slice(0, 16) : [];
}

export async function discoverZenResponsesModel(env: Pick<Env, "OPENCODE_ZEN_API_KEY">, fetchImpl: typeof fetch = fetch): Promise<ZenResponsesModelMetadata> {
  const response = await fetchImpl(ZEN_RESPONSES_MODELS_ENDPOINT, {
    method: "GET", headers: { Authorization: `Bearer ${zenResponsesCredential(env)}` }, redirect: "error",
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 401 || response.status === 403) throw new ConnectorError("provider_authentication_failed", "OpenCode Zen authentication was rejected during model discovery.", { status: response.status });
  if (!response.ok) throw new ConnectorError("provider_discovery_failed", "OpenCode Zen model discovery failed.", { status: response.status, retryable: response.status >= 500 || response.status === 429 });
  const model = modelList(body).find((entry) => String(entry.id ?? entry.name ?? "") === ZEN_RESPONSES_MODEL);
  const disabled = model && (model.enabled === false || model.disabled === true || String(model.status ?? "").toLocaleLowerCase("en") === "disabled");
  if (!model || disabled) throw new ConnectorError("opencode_zen_gpt_5_6_luna_unavailable", "The exact gpt-5.6-luna model is absent or disabled on the authenticated Zen models surface.");
  return {
    id: ZEN_RESPONSES_MODEL, enabled: true, inputModalities: strings(model.input_modalities ?? model.modalities),
    outputModalities: strings(model.output_modalities), pricingMetadataPresent: Boolean(model.pricing && typeof model.pricing === "object"),
    pricing: resolveZenResponsesPricing(model),
  };
}

export function buildZenResponsesInput(text: string, imageDataUrl?: string): Array<Record<string, unknown>> {
  const content: Record<string, unknown>[] = [{ type: "input_text", text }];
  if (imageDataUrl) content.push({ type: "input_image", image_url: imageDataUrl });
  return [{ role: "user", content }];
}

export function buildZenResponsesRequest(input: {
  text: string;
  imageDataUrl?: string;
  maxOutputTokens: number;
  schema?: { name: string; schema: Record<string, unknown> };
}): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: ZEN_RESPONSES_MODEL,
    input: buildZenResponsesInput(input.text, input.imageDataUrl),
    store: false,
    max_output_tokens: Math.max(16, Math.min(2000, Math.round(input.maxOutputTokens))),
  };
  if (input.schema) {
    request.text = { format: { type: "json_schema", name: input.schema.name, strict: true, schema: input.schema.schema } };
  }
  return request;
}

function boundedJsonBytes(body: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new ConnectorError("provider_response_too_large", "The Zen Responses payload exceeded the bounded response ceiling.");
  return bytes;
}

export function parseZenResponsesOutput(body: Record<string, unknown>, httpStatus = 200, requestFingerprint = ""): { text: string; receipt: ZenResponsesStructuralReceipt } {
  const status = typeof body.status === "string" ? body.status : null;
  const incompleteDetails = body.incomplete_details && typeof body.incomplete_details === "object" ? body.incomplete_details as Record<string, unknown> : null;
  const incompleteReason = incompleteDetails && typeof incompleteDetails.reason === "string" ? incompleteDetails.reason.slice(0, 120) : null;
  const output = Array.isArray(body.output) ? body.output as Record<string, unknown>[] : [];
  const outputItemTypes = output.map((item) => String(item.type ?? "unknown")).slice(0, 32);
  const contentTypes: string[] = [];
  const texts: string[] = [];
  let refusal = false;
  let assistantMessages = 0;
  for (const item of output) {
    if (item.type !== "message" || item.role !== "assistant" || ![undefined, "completed"].includes(item.status as string | undefined)) continue;
    assistantMessages += 1;
    const content = Array.isArray(item.content) ? item.content as Record<string, unknown>[] : [];
    for (const part of content) {
      const type = String(part.type ?? "unknown");
      contentTypes.push(type);
      if (type === "output_text" && typeof part.text === "string") texts.push(part.text);
      if (type === "refusal") refusal = true;
    }
  }
  const responseFingerprintMaterial = {
    topLevelKeys: Object.keys(body).sort(), status, outputItemTypes, contentTypes, usagePresent: Boolean(body.usage), httpStatus,
  };
  const responseFingerprint = requestFingerprint ? `${requestFingerprint.slice(0, 16)}:${JSON.stringify(responseFingerprintMaterial).length}` : String(JSON.stringify(responseFingerprintMaterial).length);
  const base = {
    topLevelKeys: Object.keys(body).sort().slice(0, 64), outputItemTypes, outputContentPartTypes: contentTypes.slice(0, 64),
    completionStatus: status, incompleteReason, usagePresent: Boolean(body.usage), requestFingerprint,
    responseFingerprint, httpStatus,
  };
  if (status === "incomplete" || incompleteReason) throw new ConnectorError("provider_response_incomplete", "The Zen Responses output was incomplete.", { details: { structuralReceipt: { ...base, responseClass: "incomplete" } } });
  if (refusal) throw new ConnectorError("provider_refusal", "The Zen Responses model refused the classification request.", { details: { structuralReceipt: { ...base, responseClass: "refusal" } } });
  if (status !== null && status !== "completed") throw new ConnectorError("provider_response_incomplete", "The Zen Responses output did not complete.", { details: { structuralReceipt: { ...base, responseClass: "incomplete" } } });
  const text = texts.join("").trim();
  if (!text) {
    const responseClass = outputItemTypes.includes("reasoning") ? "reasoning_only" : "malformed";
    throw new ConnectorError(responseClass === "reasoning_only" ? "provider_reasoning_only" : "classifier_output_missing", "The Zen Responses output contained no completed assistant output_text.", { details: { structuralReceipt: { ...base, responseClass } } });
  }
  if (!assistantMessages) throw new ConnectorError("classifier_output_missing", "The Zen Responses output contained no completed assistant message.");
  return { text, receipt: { ...base, responseClass: "completed_output" } };
}


function sanitizedStage(context: string): string {
  const candidate = context.split(":").pop() ?? "unknown";
  return /^[a-z0-9_.-]+$/i.test(candidate) ? candidate.slice(0, 120) : "unknown";
}

export const ZEN_RESPONSES_ILLEGAL_INVOCATION_MESSAGE = "Illegal invocation: function called with incorrect this reference. See [documentation URL removed] for details." as const;

function boundedZenResponsesFetchErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (/illegal invocation/i.test(normalized) && /incorrect [`'"]?this[`'"]? reference/i.test(normalized)) {
    return ZEN_RESPONSES_ILLEGAL_INVOCATION_MESSAGE;
  }
  if (/^(fetch failed|network connection lost|the operation was aborted|this operation was aborted|invalid url|failed to parse url)$/i.test(normalized)) {
    return normalized.slice(0, 240);
  }
  if (/^failed to construct ['"]request['"]:/i.test(normalized) && !/https?:\/\//i.test(normalized)) {
    return normalized.slice(0, 240);
  }
  return "Fetch failed before an HTTP response.";
}

function classifyZenResponsesFetchFailure(error: unknown): {
  code: string;
  message: string;
  localErrorClass: string;
  retryable: boolean;
  errorName: string;
  errorMessage: string;
  codeLocation: string;
} {
  const errorName = error instanceof Error ? error.name.slice(0, 80) : typeof error;
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const lower = rawMessage.toLocaleLowerCase("en");
  const common = {
    errorName,
    errorMessage: boundedZenResponsesFetchErrorMessage(error),
    codeLocation: "visual-catalogue-zen-responses.requestZenResponses.fetch",
  };
  if (errorName === "TypeError" && (lower.includes("illegal invocation") || lower.includes("incorrect this reference"))) {
    return { ...common, code: "zen_responses_fetch_illegal_invocation", message: "The Zen Responses runtime fetch was called without its required receiver.", localErrorClass: "runtime_fetch_binding", retryable: false };
  }
  if (errorName === "TypeError" && lower.includes("header")) {
    return { ...common, code: "zen_responses_invalid_headers", message: "The Zen Responses request headers were rejected locally.", localErrorClass: "request_headers", retryable: false };
  }
  if (errorName === "TypeError" && lower.includes("signal")) {
    return { ...common, code: "zen_responses_invalid_signal", message: "The Zen Responses abort signal was rejected locally.", localErrorClass: "request_signal", retryable: false };
  }
  if (errorName === "TypeError" && lower.includes("redirect")) {
    return { ...common, code: "zen_responses_invalid_redirect", message: "The Zen Responses redirect mode was rejected locally.", localErrorClass: "request_redirect", retryable: false };
  }
  if (errorName === "TypeError" && lower.includes("body")) {
    return { ...common, code: "zen_responses_invalid_body", message: "The Zen Responses request body was rejected locally.", localErrorClass: "request_body", retryable: false };
  }
  if (errorName === "TypeError" && (lower.includes("url") || lower.includes("request"))) {
    return { ...common, code: "zen_responses_invalid_endpoint", message: "The Zen Responses endpoint value was rejected locally.", localErrorClass: "request_endpoint", retryable: false };
  }
  return { ...common, code: "zen_responses_network_error", message: "The Zen Responses request failed before an HTTP response was received.", localErrorClass: errorName, retryable: true };
}

export function createZenResponsesFetchInit(credential: string, serializedBody: string, signal: AbortSignal): RequestInit {
  const headers: Record<string, string> = {
    Authorization: String(`Bearer ${credential}`),
    "Content-Type": String("application/json"),
  };
  const init: RequestInit = {
    method: "POST",
    headers,
    body: String(serializedBody),
    redirect: "error",
    signal,
  };
  Object.freeze(headers);
  Object.freeze(init);
  return init;
}

function boundedHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value.slice(0, 200);
  }
  return null;
}

function declaredContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function requestShape(body: Record<string, unknown>): Record<string, unknown> {
  const inputItems = Array.isArray(body.input) ? body.input as Record<string, unknown>[] : [];
  const contentTypes: string[] = [];
  let imagePresent = false;
  for (const item of inputItems) {
    const content = Array.isArray(item?.content) ? item.content as Record<string, unknown>[] : [];
    for (const part of content) {
      const type = String(part?.type ?? "unknown");
      contentTypes.push(type);
      if (type === "input_image") imagePresent = true;
    }
  }
  return {
    topLevelKeys: Object.keys(body).sort(),
    model: String(body.model ?? ""),
    store: body.store === false,
    inputItemCount: inputItems.length,
    contentTypes: contentTypes.slice(0, 32),
    imagePresent,
    structuredSchemaPresent: Boolean(body.text && typeof body.text === "object"),
    maxOutputTokensPresent: Number.isFinite(Number(body.max_output_tokens)),
  };
}

function responseShape(body: Record<string, unknown>, status: number): Record<string, unknown> {
  const output = Array.isArray(body.output) ? body.output as Record<string, unknown>[] : [];
  const outputItemTypes = output.map((item) => String(item?.type ?? "unknown")).slice(0, 32);
  const contentPartTypes: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content as Record<string, unknown>[] : [];
    for (const part of content) contentPartTypes.push(String(part?.type ?? "unknown"));
  }
  return {
    httpStatus: status,
    topLevelKeys: Object.keys(body).sort().slice(0, 64),
    completionStatus: typeof body.status === "string" ? body.status.slice(0, 80) : null,
    outputItemTypes,
    contentPartTypes: contentPartTypes.slice(0, 64),
    usagePresent: Boolean(body.usage),
  };
}

async function zenResponsesTransportReceiptKey(spendLedgerKey: string, correlationId: string): Promise<string> {
  const scopeFingerprint = (await sha256HexUtf8(spendLedgerKey)).slice(0, 32);
  return `visual-compiler/provider-transport/opencode-zen-responses/${ZEN_RESPONSES_MODEL}/${scopeFingerprint}/${correlationId}.json`;
}

async function persistZenResponsesTransportReceipt(
  env: Pick<Env, "ARTIFACTS">,
  key: string,
  receipt: ZenResponsesTransportReceipt,
): Promise<void> {
  await putArtifact(env as Env, key, JSON.stringify(receipt, null, 2), "application/json; charset=utf-8", {
    provider: receipt.provider,
    model: receipt.model,
    stage: receipt.stage,
    status: receipt.localErrorCode ?? receipt.parserResult,
  });
}

function receiptPersistError(receipt: ZenResponsesTransportReceipt): ZenResponsesTransportError {
  const failed = {
    ...receipt,
    localErrorCode: "zen_responses_receipt_persist_failed",
    localErrorClass: "receipt_persistence",
  };
  return new ZenResponsesTransportError(
    "zen_responses_receipt_persist_failed",
    "The sanitized Zen Responses transport receipt could not be persisted.",
    failed,
  );
}

async function persistZenResponsesTransportReceiptOrThrow(
  env: Pick<Env, "ARTIFACTS">,
  key: string,
  receipt: ZenResponsesTransportReceipt,
): Promise<void> {
  try {
    await persistZenResponsesTransportReceipt(env, key, receipt);
  } catch {
    throw receiptPersistError(receipt);
  }
}

async function failZenResponsesTransport(
  env: Pick<Env, "ARTIFACTS">,
  key: string,
  receipt: ZenResponsesTransportReceipt,
  code: string,
  message: string,
  localErrorClass: string,
  options: { retryable?: boolean; status?: number } = {},
): Promise<never> {
  const failed = { ...receipt, localErrorCode: code, localErrorClass };
  try {
    await persistZenResponsesTransportReceipt(env, key, failed);
  } catch {
    throw receiptPersistError(failed);
  }
  throw new ZenResponsesTransportError(code, message, failed, options);
}

async function readBoundedZenResponsesBody(response: Response): Promise<Uint8Array> {
  const declared = declaredContentLength(response.headers);
  if (declared !== null && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ConnectorError("zen_responses_body_too_large", "The Zen Responses body exceeded the bounded response ceiling.");
  }
  if (!response.body) {
    let buffer: ArrayBuffer;
    try { buffer = await response.arrayBuffer(); }
    catch { throw new ConnectorError("zen_responses_body_read_failed", "The Zen Responses body could not be read.", { retryable: true }); }
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new ConnectorError("zen_responses_body_too_large", "The Zen Responses body exceeded the bounded response ceiling.");
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); }
      catch { throw new ConnectorError("zen_responses_body_read_failed", "The Zen Responses body could not be read.", { retryable: true }); }
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ConnectorError("zen_responses_body_too_large", "The Zen Responses body exceeded the bounded response ceiling.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export async function requestZenResponses(input: {
  env: Pick<Env, "OPENCODE_ZEN_API_KEY" | "ARTIFACTS">;
  spendLedgerKey: string;
  body: Record<string, unknown>;
  context: string;
  requestIdentity?: string | null;
  provider?: unknown;
  mode?: unknown;
  timeoutMilliseconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ body: Record<string, unknown>; text: string; usage: ZenResponsesUsage; accounting: ZenResponsesSpendLedger; structuralReceipt: ZenResponsesStructuralReceipt; transportReceipt: ZenResponsesTransportReceipt; status: number; latencyMilliseconds: number }> {
  const correlationId = crypto.randomUUID();
  const timeoutMilliseconds = Math.max(1, Math.min(ZEN_RESPONSES_TIMEOUT_MS, Math.round(Number(input.timeoutMilliseconds ?? ZEN_RESPONSES_TIMEOUT_MS)) || ZEN_RESPONSES_TIMEOUT_MS));
  const receiptKey = await zenResponsesTransportReceiptKey(input.spendLedgerKey, correlationId);
  let receipt: ZenResponsesTransportReceipt = {
    version: 1,
    provider: ZEN_RESPONSES_PROVIDER,
    mode: ZEN_RESPONSES_MODE,
    model: ZEN_RESPONSES_MODEL,
    endpointClass: "responses_post",
    stage: sanitizedStage(input.context),
    requestByteCount: null,
    requestShapeFingerprint: null,
    timeoutMilliseconds,
    fetchBegan: false,
    credentialBindingExists: false,
    correlationId,
    httpStatus: null,
    responseContentType: null,
    declaredContentLength: null,
    providerRequestId: null,
    edgeRequestId: null,
    responseByteCount: null,
    responseShapeFingerprint: null,
    parserResult: "not_started",
    schemaResult: "not_run",
    usagePresent: null,
    localErrorCode: null,
    localErrorClass: null,
    errorName: null,
    errorMessage: null,
    codeLocation: null,
    requestMethod: "POST",
    headerNames: ["authorization", "content-type"],
    signalPresent: false,
    redirectMode: "error",
    fetchImplementationClass: "unresolved",
  };

  const provider = String(input.provider ?? ZEN_RESPONSES_PROVIDER);
  const mode = String(input.mode ?? ZEN_RESPONSES_MODE);
  if (provider !== ZEN_RESPONSES_PROVIDER || mode !== ZEN_RESPONSES_MODE || String(input.body.model ?? "") !== ZEN_RESPONSES_MODEL) {
    return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_fetch_not_started", "Zen Responses transport requires the exact provider, mode, and model identity.", "dispatch_validation");
  }
  if (input.body.store !== false) {
    return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_fetch_not_started", "Zen Responses transport requires the existing store=false request contract.", "request_validation");
  }
  const credential = typeof input.env.OPENCODE_ZEN_API_KEY === "string" ? input.env.OPENCODE_ZEN_API_KEY.trim() : "";
  receipt = { ...receipt, credentialBindingExists: credential.length > 0 };
  if (!credential) {
    return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_fetch_not_started", "The OPENCODE_ZEN_API_KEY binding is not configured.", "credential_validation");
  }
  const hasExplicitFetch = Object.prototype.hasOwnProperty.call(input, "fetchImpl");
  const explicitFetch = hasExplicitFetch ? input.fetchImpl : undefined;
  if (hasExplicitFetch && typeof explicitFetch !== "function") {
    receipt = { ...receipt, fetchImplementationClass: "invalid_explicit" };
    return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_fetch_not_started", "The explicitly supplied Zen Responses fetch implementation was not invokable.", "fetch_invocation");
  }
  if (!hasExplicitFetch && typeof globalThis.fetch !== "function") {
    receipt = { ...receipt, fetchImplementationClass: "global_fetch_missing" };
    return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_fetch_not_started", "The Worker runtime fetch implementation was unavailable.", "fetch_invocation");
  }
  const fetchImpl = hasExplicitFetch
    ? explicitFetch as typeof fetch
    : globalThis.fetch.bind(globalThis) as typeof fetch;
  receipt = { ...receipt, fetchImplementationClass: hasExplicitFetch ? "explicit_injected" : "global_fetch_bound" };

  let serializedBody: string;
  try {
    serializedBody = JSON.stringify(input.body);
  } catch {
    return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_fetch_not_started", "The existing Zen Responses request payload could not be serialized.", "body_serialization");
  }
  const requestBytes = new TextEncoder().encode(serializedBody);
  const requestShapeFingerprint = await sha256HexUtf8(JSON.stringify(requestShape(input.body)));
  await assertZenResponsesBudgetAvailable(input.env as Env, input.spendLedgerKey);

  const controller = new AbortController();
  const requestInit = createZenResponsesFetchInit(credential, serializedBody, controller.signal);
  receipt = {
    ...receipt,
    requestByteCount: requestBytes.byteLength,
    requestShapeFingerprint,
    fetchBegan: true,
    signalPresent: Boolean(requestInit.signal),
    parserResult: "prefetch_receipt_persisted",
  };
  await persistZenResponsesTransportReceiptOrThrow(input.env, receiptKey, receipt);

  let timeoutFired = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      controller.abort("zen_responses_timeout");
      reject(new Error("zen_responses_timeout"));
    }, timeoutMilliseconds);
  });
  const started = Date.now();
  let response: Response;
  try {
    response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(ZEN_RESPONSES_ENDPOINT, requestInit)),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timeoutFired || controller.signal.aborted) {
      const timeoutReceipt = {
        ...receipt,
        errorName: error instanceof Error ? error.name.slice(0, 80) : typeof error,
        errorMessage: "The bounded Zen Responses transport timeout fired.",
        codeLocation: "visual-catalogue-zen-responses.requestZenResponses.timeout_race",
      };
      return failZenResponsesTransport(input.env, receiptKey, timeoutReceipt, "zen_responses_timeout", "The Zen Responses request exceeded the bounded transport timeout.", error instanceof Error ? error.name : typeof error, { retryable: true });
    }
    const failure = classifyZenResponsesFetchFailure(error);
    const failedReceipt = { ...receipt, errorName: failure.errorName, errorMessage: failure.errorMessage, codeLocation: failure.codeLocation };
    return failZenResponsesTransport(input.env, receiptKey, failedReceipt, failure.code, failure.message, failure.localErrorClass, { retryable: failure.retryable });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  receipt = {
    ...receipt,
    httpStatus: response.status,
    responseContentType: response.headers.get("content-type")?.slice(0, 160) ?? null,
    declaredContentLength: declaredContentLength(response.headers),
    providerRequestId: boundedHeader(response.headers, ["x-request-id", "request-id", "openai-request-id"]),
    edgeRequestId: boundedHeader(response.headers, ["cf-ray", "x-vercel-id", "x-envoy-upstream-service-time"]),
    parserResult: "headers_received",
  };
  await persistZenResponsesTransportReceiptOrThrow(input.env, receiptKey, receipt);

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedZenResponsesBody(response);
  } catch (error) {
    const code = error instanceof ConnectorError && ["zen_responses_body_too_large", "zen_responses_body_read_failed"].includes(error.code)
      ? error.code
      : "zen_responses_body_read_failed";
    return failZenResponsesTransport(input.env, receiptKey, receipt, code, code === "zen_responses_body_too_large" ? "The Zen Responses body exceeded the bounded response ceiling." : "The Zen Responses body could not be read.", error instanceof Error ? error.name : typeof error, { retryable: code === "zen_responses_body_read_failed", status: response.status });
  }
  receipt = { ...receipt, responseByteCount: bytes.byteLength, parserResult: "body_read" };
  await persistZenResponsesTransportReceiptOrThrow(input.env, receiptKey, receipt);

  let body: Record<string, unknown>;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root_not_object");
    body = parsed as Record<string, unknown>;
  } catch (error) {
    const usage = parseZenResponsesUsage({});
    await recordZenResponsesAccounting({ env: input.env as Env, key: input.spendLedgerKey, context: input.context, httpStatus: response.status, usage, requestIdentity: input.requestIdentity });
    receipt = {
      ...receipt,
      responseShapeFingerprint: await sha256HexUtf8(JSON.stringify({ httpStatus: response.status, responseByteCount: bytes.byteLength, jsonObject: false })),
      parserResult: "json_parse_failed",
      schemaResult: "not_run",
      usagePresent: false,
    };
    if (!response.ok) {
      return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_http_error", "The Zen Responses endpoint returned a non-success HTTP status.", "http_status", { retryable: response.status === 429 || response.status >= 500, status: response.status });
    }
    return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_response_malformed", "The Zen Responses body was not a valid JSON object.", error instanceof Error ? error.name : typeof error, { status: response.status });
  }

  const usage = parseZenResponsesUsage(body);
  const accounting = await recordZenResponsesAccounting({ env: input.env as Env, key: input.spendLedgerKey, context: input.context, httpStatus: response.status, usage, requestIdentity: input.requestIdentity });
  receipt = {
    ...receipt,
    responseShapeFingerprint: await sha256HexUtf8(JSON.stringify(responseShape(body, response.status))),
    parserResult: "json_object_parsed",
    usagePresent: Boolean(body.usage),
  };
  await persistZenResponsesTransportReceiptOrThrow(input.env, receiptKey, receipt);

  if (!response.ok) {
    return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_http_error", "The Zen Responses endpoint returned a non-success HTTP status.", "http_status", { retryable: response.status === 429 || response.status >= 500, status: response.status });
  }

  let parsedOutput: { text: string; receipt: ZenResponsesStructuralReceipt };
  try {
    parsedOutput = parseZenResponsesOutput(body, response.status, requestShapeFingerprint);
  } catch (error) {
    const originalCode = error instanceof ConnectorError ? error.code : "zen_responses_response_malformed";
    const mappedCode = ["classifier_output_missing", "provider_reasoning_only"].includes(originalCode)
      ? "zen_responses_output_missing"
      : originalCode;
    const structuralReceipt = error instanceof ConnectorError && error.details?.structuralReceipt && typeof error.details.structuralReceipt === "object"
      ? error.details.structuralReceipt as ZenResponsesStructuralReceipt
      : null;
    receipt = {
      ...receipt,
      parserResult: structuralReceipt?.responseClass ?? "output_parse_failed",
      schemaResult: "not_run",
    };
    return failZenResponsesTransport(input.env, receiptKey, receipt, mappedCode, mappedCode === "zen_responses_output_missing" ? "The Zen Responses body contained no completed assistant output_text." : "The Zen Responses output failed structural validation.", error instanceof Error ? error.name : typeof error, { status: response.status });
  }

  const schemaRequested = Boolean(input.body.text && typeof input.body.text === "object");
  let schemaResult = "not_requested";
  if (schemaRequested) {
    try {
      const parsed = JSON.parse(parsedOutput.text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("schema_root_not_object");
      schemaResult = "json_object_parsed";
    } catch (error) {
      receipt = { ...receipt, parserResult: "output_text_parsed", schemaResult: "invalid" };
      return failZenResponsesTransport(input.env, receiptKey, receipt, "zen_responses_schema_invalid", "The structured Zen Responses output was not a JSON object.", error instanceof Error ? error.name : typeof error, { status: response.status });
    }
  }

  receipt = {
    ...receipt,
    parserResult: "output_text_parsed",
    schemaResult,
    usagePresent: Boolean(body.usage),
  };
  await persistZenResponsesTransportReceiptOrThrow(input.env, receiptKey, receipt);
  return {
    body,
    text: parsedOutput.text,
    usage,
    accounting,
    structuralReceipt: parsedOutput.receipt,
    transportReceipt: receipt,
    status: response.status,
    latencyMilliseconds: Date.now() - started,
  };
}

export async function responseFingerprint(receipt: ZenResponsesStructuralReceipt): Promise<string> {
  return sha256HexUtf8(JSON.stringify(receipt));
}

void boundedJsonBytes;

const ZEN_RESPONSES_CAPABILITY_CACHE_KEY = `visual-compiler/provider-cache/opencode-zen-responses/${ZEN_RESPONSES_MODEL}/${ZEN_RESPONSES_PROBE_VERSION}/capabilities.json`;

export async function writeZenResponsesCapabilityCache(env: Env, receipt: ZenResponsesCapabilityReceipt): Promise<void> {
  await putArtifact(env, ZEN_RESPONSES_CAPABILITY_CACHE_KEY, JSON.stringify(receipt, null, 2), "application/json; charset=utf-8", {
    provider: receipt.provider, model: receipt.model, probeVersion: receipt.probeVersion, visionPassed: "true",
  });
}

export async function readZenResponsesCapabilityCache(env: Env): Promise<ZenResponsesCapabilityReceipt | null> {
  const object = await env.ARTIFACTS.get(ZEN_RESPONSES_CAPABILITY_CACHE_KEY);
  if (!object) return null;
  try {
    const receipt = JSON.parse(await object.text()) as ZenResponsesCapabilityReceipt;
    if (receipt.provider !== ZEN_RESPONSES_PROVIDER || receipt.mode !== ZEN_RESPONSES_MODE || receipt.model !== ZEN_RESPONSES_MODEL || receipt.probeVersion !== ZEN_RESPONSES_PROBE_VERSION || !receipt.visionProbe.passed) return null;
    if (Date.now() - Date.parse(receipt.discoveryTimestamp) > 60 * 60 * 1000) return null;
    return { ...receipt, discoveryCacheHit: true };
  } catch { return null; }
}
