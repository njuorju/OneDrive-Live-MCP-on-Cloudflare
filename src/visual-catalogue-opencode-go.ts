import { ConnectorError } from "./errors";
import { getArtifact, nowIso, putArtifact } from "./paid-core";

export const OPENCODE_GO_PROVIDER = "opencode_go" as const;
export const OPENCODE_GO_MODE = "opencode_go_chat_completions" as const;
export const OPENCODE_GO_MODEL = "mimo-v2.5" as const;
export const OPENCODE_GO_MODELS_ENDPOINT = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_GO_CHAT_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_GO_ENDPOINT_FAMILY = "openai_compatible_chat_completions" as const;
export const ODL_REQ_022_GO_PROBE_VERSION = "odl-req-022-go-capability-v1" as const;
export const OPENCODE_GO_CAPABILITY_CACHE_SECONDS = 60 * 60;
export const OPENCODE_GO_FALLBACK_PRICING_VERSION = "mimo-v2.5-fallback-2026-08-03";
export const OPENCODE_GO_MAX_BILLABLE_REQUESTS = 75;
export const OPENCODE_GO_MAX_ESTIMATED_SPEND_USD = 1;

export type OpenCodeGoCredentialBindingName = "OPENCODE_GO_API_KEY" | "OPENCODE_ZEN_API_KEY";

export type OpenCodeGoPricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedReadPerMillionUsd: number;
  source: "provider_model_metadata" | "fallback_price_table";
  version: string;
};

export const OPENCODE_GO_FALLBACK_PRICING: OpenCodeGoPricing = {
  inputPerMillionUsd: 0.14,
  outputPerMillionUsd: 0.28,
  cachedReadPerMillionUsd: 0.0028,
  source: "fallback_price_table",
  version: OPENCODE_GO_FALLBACK_PRICING_VERSION,
};

export type OpenCodeGoUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedReadTokens: number | null;
  totalTokens: number | null;
  reported: boolean;
};

export type OpenCodeGoAccountingEntry = {
  sequence: number;
  timestamp: string;
  context: string;
  httpStatus: number;
  costBearing: boolean;
  usage: OpenCodeGoUsage;
  estimatedIncrementalCostUsd: number | null;
  requestIdentity: string | null;
};

export type OpenCodeGoSpendLedger = {
  version: 1;
  scopeId: string;
  provider: typeof OPENCODE_GO_PROVIDER;
  mode: typeof OPENCODE_GO_MODE;
  model: typeof OPENCODE_GO_MODEL;
  credentialBindingName: OpenCodeGoCredentialBindingName;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
  billableRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  usageNotReportedResponses: number;
  estimatedSpendUsd: number | null;
  pricing: OpenCodeGoPricing;
  remainingRequestAllowance: number;
  remainingEstimatedDollarAllowance: number | null;
  dollarEnforcement: "exact_estimate" | "conservative_request_ceiling_only";
  status: "active" | "request_limit_reached" | "dollar_limit_reached";
  responses: OpenCodeGoAccountingEntry[];
  createdAt: string;
  updatedAt: string;
};

export type OpenCodeGoCapabilityReceipt = {
  provider: typeof OPENCODE_GO_PROVIDER;
  mode: typeof OPENCODE_GO_MODE;
  model: typeof OPENCODE_GO_MODEL;
  endpointFamily: typeof OPENCODE_GO_ENDPOINT_FAMILY;
  probeVersion: typeof ODL_REQ_022_GO_PROBE_VERSION;
  credentialBindingName: OpenCodeGoCredentialBindingName;
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
    pricing: OpenCodeGoPricing;
  };
  visionProbe: {
    passed: boolean;
    status: number;
    latencyMilliseconds: number;
    exactTextObserved: boolean;
    blueSquareObserved: boolean;
    redCircleObserved: boolean;
    detailFieldAccepted: boolean;
    sanitizedUsage: {
      inputTokens: number | null;
      outputTokens: number | null;
      cachedReadTokens: number | null;
      totalTokens: number | null;
    };
  };
  structuredOutput: {
    responseFormatAccepted: boolean;
    jsonObjectReliable: boolean;
  };
  spendScopeId: string;
  spendLedgerKey: string;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
  accounting: OpenCodeGoSpendLedger;
  costClassification: "provider_metered_or_fallback_estimate" | "usage_not_reported";
};

const CAPABILITY_CACHE_KEY = `visual-compiler/provider-cache/opencode-go/${OPENCODE_GO_MODEL}/${ODL_REQ_022_GO_PROBE_VERSION}/capabilities.json`;
const MAX_RESPONSE_BYTES = 64 * 1024;

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
    const value = boundedNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

export function resolveOpenCodeGoPricing(model: Record<string, unknown> | null | undefined): OpenCodeGoPricing {
  const pricing = model?.pricing && typeof model.pricing === "object" ? model.pricing as Record<string, unknown> : null;
  if (!pricing) return { ...OPENCODE_GO_FALLBACK_PRICING };
  const unit = String(pricing.unit ?? pricing.units ?? "").toLocaleLowerCase("en");
  const input = firstRate(pricing, ["input_per_million", "input_per_1m_tokens", "prompt_per_million", "prompt_per_1m_tokens"]);
  const output = firstRate(pricing, ["output_per_million", "output_per_1m_tokens", "completion_per_million", "completion_per_1m_tokens"]);
  const cached = firstRate(pricing, ["cached_read_per_million", "cached_input_per_million", "cache_read_per_million", "cached_read_per_1m_tokens"]);
  if (input !== null && output !== null && cached !== null) {
    return {
      inputPerMillionUsd: input,
      outputPerMillionUsd: output,
      cachedReadPerMillionUsd: cached,
      source: "provider_model_metadata",
      version: String(pricing.version ?? model?.id ?? OPENCODE_GO_MODEL).slice(0, 120),
    };
  }
  if (/million|1m/.test(unit)) {
    const genericInput = firstRate(pricing, ["input", "prompt"]);
    const genericOutput = firstRate(pricing, ["output", "completion"]);
    const genericCached = firstRate(pricing, ["cached_read", "cached_input", "cache_read"]);
    if (genericInput !== null && genericOutput !== null && genericCached !== null) {
      return {
        inputPerMillionUsd: genericInput,
        outputPerMillionUsd: genericOutput,
        cachedReadPerMillionUsd: genericCached,
        source: "provider_model_metadata",
        version: String(pricing.version ?? model?.id ?? OPENCODE_GO_MODEL).slice(0, 120),
      };
    }
  }
  return { ...OPENCODE_GO_FALLBACK_PRICING };
}

export function parseOpenCodeGoUsage(body: Record<string, unknown>): OpenCodeGoUsage {
  const usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : null;
  if (!usage) return { inputTokens: null, outputTokens: null, cachedReadTokens: null, totalTokens: null, reported: false };
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? usage.input_tokens_details as Record<string, unknown>
      : {};
  const inputTokens = boundedInteger(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = boundedInteger(usage.completion_tokens ?? usage.output_tokens);
  const cachedReadTokens = boundedInteger(
    usage.cached_read_tokens
      ?? usage.cached_input_tokens
      ?? details.cached_tokens
      ?? details.cached_read_tokens,
  );
  const totalTokens = boundedInteger(usage.total_tokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)));
  const reported = inputTokens !== null || outputTokens !== null || cachedReadTokens !== null || totalTokens !== null;
  return { inputTokens, outputTokens, cachedReadTokens, totalTokens, reported };
}

export function selectOpenCodeGoCredentialBinding(env: Pick<Env, "OPENCODE_GO_API_KEY" | "OPENCODE_ZEN_API_KEY">): OpenCodeGoCredentialBindingName {
  if (String(env.OPENCODE_GO_API_KEY ?? "").trim()) return "OPENCODE_GO_API_KEY";
  if (String(env.OPENCODE_ZEN_API_KEY ?? "").trim()) return "OPENCODE_ZEN_API_KEY";
  throw new ConnectorError("provider_secret_missing", "Neither OPENCODE_GO_API_KEY nor OPENCODE_ZEN_API_KEY is configured for the OpenCode Go access test.");
}

export function openCodeGoCredentialValue(env: Pick<Env, "OPENCODE_GO_API_KEY" | "OPENCODE_ZEN_API_KEY">, binding: OpenCodeGoCredentialBindingName): string {
  const value = binding === "OPENCODE_GO_API_KEY" ? env.OPENCODE_GO_API_KEY : env.OPENCODE_ZEN_API_KEY;
  if (!String(value ?? "").trim()) throw new ConnectorError("provider_secret_missing", `${binding} is not configured.`);
  return String(value);
}

export function validateOpenCodeGoBudgets(maxBillableRequests: unknown, maxEstimatedSpendUsd: unknown): { maxBillableRequests: number; maxEstimatedSpendUsd: number } {
  const requests = Number(maxBillableRequests);
  const dollars = Number(maxEstimatedSpendUsd);
  if (!Number.isInteger(requests) || requests < 1 || requests > OPENCODE_GO_MAX_BILLABLE_REQUESTS) {
    throw new ConnectorError("provider_request_budget_invalid", `maxBillableRequests must be an integer from 1 through ${OPENCODE_GO_MAX_BILLABLE_REQUESTS}.`);
  }
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > OPENCODE_GO_MAX_ESTIMATED_SPEND_USD) {
    throw new ConnectorError("provider_spend_budget_invalid", `maxEstimatedSpendUsd must be greater than zero and no more than ${OPENCODE_GO_MAX_ESTIMATED_SPEND_USD.toFixed(2)}.`);
  }
  return { maxBillableRequests: requests, maxEstimatedSpendUsd: Number(dollars.toFixed(6)) };
}

export function openCodeGoSpendLedgerKey(scopeId: string, binding: OpenCodeGoCredentialBindingName): string {
  return `visual-compiler/provider-spend/opencode-go/${OPENCODE_GO_MODEL}/${binding}/${scopeId}.json`;
}

async function readJson<T>(env: Env, key: string): Promise<T> {
  return JSON.parse(await (await getArtifact(env, key)).text()) as T;
}

async function storeLedger(env: Env, key: string, ledger: OpenCodeGoSpendLedger): Promise<void> {
  ledger.updatedAt = nowIso();
  await putArtifact(env, key, JSON.stringify(ledger, null, 2), "application/json; charset=utf-8", {
    provider: ledger.provider,
    model: ledger.model,
    credentialBindingName: ledger.credentialBindingName,
    scopeId: ledger.scopeId,
    billableRequestCount: String(ledger.billableRequestCount),
    status: ledger.status,
  });
}

export async function initializeOpenCodeGoSpendLedger(env: Env, input: {
  scopeId: string;
  credentialBindingName: OpenCodeGoCredentialBindingName;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
}): Promise<{ key: string; ledger: OpenCodeGoSpendLedger }> {
  const budgets = validateOpenCodeGoBudgets(input.maxBillableRequests, input.maxEstimatedSpendUsd);
  const key = openCodeGoSpendLedgerKey(input.scopeId, input.credentialBindingName);
  const existing = await env.ARTIFACTS.get(key);
  if (existing) {
    const ledger = JSON.parse(await existing.text()) as OpenCodeGoSpendLedger;
    if (ledger.maxBillableRequests !== budgets.maxBillableRequests || ledger.maxEstimatedSpendUsd !== budgets.maxEstimatedSpendUsd || ledger.credentialBindingName !== input.credentialBindingName) {
      throw new ConnectorError("provider_budget_identity_conflict", "The existing OpenCode Go spend scope has different immutable budget or credential identity fields.");
    }
    return { key, ledger };
  }
  const createdAt = nowIso();
  const ledger: OpenCodeGoSpendLedger = {
    version: 1,
    scopeId: input.scopeId,
    provider: OPENCODE_GO_PROVIDER,
    mode: OPENCODE_GO_MODE,
    model: OPENCODE_GO_MODEL,
    credentialBindingName: input.credentialBindingName,
    maxBillableRequests: budgets.maxBillableRequests,
    maxEstimatedSpendUsd: budgets.maxEstimatedSpendUsd,
    billableRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    usageNotReportedResponses: 0,
    estimatedSpendUsd: 0,
    pricing: { ...OPENCODE_GO_FALLBACK_PRICING },
    remainingRequestAllowance: budgets.maxBillableRequests,
    remainingEstimatedDollarAllowance: budgets.maxEstimatedSpendUsd,
    dollarEnforcement: "exact_estimate",
    status: "active",
    responses: [],
    createdAt,
    updatedAt: createdAt,
  };
  await storeLedger(env, key, ledger);
  return { key, ledger };
}

export async function readOpenCodeGoSpendLedger(env: Env, key: string): Promise<OpenCodeGoSpendLedger> {
  return readJson<OpenCodeGoSpendLedger>(env, key);
}

export async function updateOpenCodeGoPricing(env: Env, key: string, model: Record<string, unknown>): Promise<OpenCodeGoSpendLedger> {
  const ledger = await readOpenCodeGoSpendLedger(env, key);
  ledger.pricing = resolveOpenCodeGoPricing(model);
  await storeLedger(env, key, ledger);
  return ledger;
}

export async function assertOpenCodeGoBudgetAvailable(env: Env, key: string): Promise<OpenCodeGoSpendLedger> {
  const ledger = await readOpenCodeGoSpendLedger(env, key);
  if (ledger.billableRequestCount >= ledger.maxBillableRequests || ledger.status === "request_limit_reached") {
    ledger.status = "request_limit_reached";
    await storeLedger(env, key, ledger);
    throw new ConnectorError("opencode_go_request_budget_exhausted", "The OpenCode Go maxBillableRequests ceiling was reached before the next request.");
  }
  if (ledger.estimatedSpendUsd !== null && ledger.estimatedSpendUsd >= ledger.maxEstimatedSpendUsd) {
    ledger.status = "dollar_limit_reached";
    await storeLedger(env, key, ledger);
    throw new ConnectorError("opencode_go_spend_budget_exhausted", "The OpenCode Go maxEstimatedSpendUsd ceiling was reached before the next request.");
  }
  return ledger;
}

function estimatedCost(usage: OpenCodeGoUsage, pricing: OpenCodeGoPricing): number | null {
  if (!usage.reported) return null;
  const input = Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedReadTokens ?? 0));
  const output = usage.outputTokens ?? 0;
  const cached = usage.cachedReadTokens ?? 0;
  return input / 1_000_000 * pricing.inputPerMillionUsd
    + output / 1_000_000 * pricing.outputPerMillionUsd
    + cached / 1_000_000 * pricing.cachedReadPerMillionUsd;
}

export async function recordOpenCodeGoAccounting(env: Env, key: string, input: {
  context: string;
  httpStatus: number;
  costBearing: boolean;
  body: Record<string, unknown>;
  requestIdentity?: string | null;
}): Promise<OpenCodeGoSpendLedger> {
  const ledger = await readOpenCodeGoSpendLedger(env, key);
  const usage = input.costBearing ? parseOpenCodeGoUsage(input.body) : { inputTokens: null, outputTokens: null, cachedReadTokens: null, totalTokens: null, reported: false };
  const incremental = input.costBearing ? estimatedCost(usage, ledger.pricing) : 0;
  ledger.billableRequestCount += 1;
  if (input.costBearing && usage.reported) {
    ledger.inputTokens += usage.inputTokens ?? 0;
    ledger.outputTokens += usage.outputTokens ?? 0;
    ledger.cachedReadTokens += usage.cachedReadTokens ?? 0;
    if (ledger.estimatedSpendUsd !== null) ledger.estimatedSpendUsd = Number((ledger.estimatedSpendUsd + (incremental ?? 0)).toFixed(12));
  } else if (input.costBearing) {
    ledger.usageNotReportedResponses += 1;
    ledger.estimatedSpendUsd = null;
    ledger.dollarEnforcement = "conservative_request_ceiling_only";
  }
  ledger.remainingRequestAllowance = Math.max(0, ledger.maxBillableRequests - ledger.billableRequestCount);
  ledger.remainingEstimatedDollarAllowance = ledger.estimatedSpendUsd === null
    ? null
    : Number(Math.max(0, ledger.maxEstimatedSpendUsd - ledger.estimatedSpendUsd).toFixed(12));
  if (ledger.billableRequestCount >= ledger.maxBillableRequests) ledger.status = "request_limit_reached";
  if (ledger.estimatedSpendUsd !== null && ledger.estimatedSpendUsd >= ledger.maxEstimatedSpendUsd) ledger.status = "dollar_limit_reached";
  ledger.responses.push({
    sequence: ledger.billableRequestCount,
    timestamp: nowIso(),
    context: input.context.slice(0, 200),
    httpStatus: input.httpStatus,
    costBearing: input.costBearing,
    usage,
    estimatedIncrementalCostUsd: incremental === null ? null : Number(incremental.toFixed(12)),
    requestIdentity: input.requestIdentity?.slice(0, 128) ?? null,
  });
  ledger.responses = ledger.responses.slice(-OPENCODE_GO_MAX_BILLABLE_REQUESTS);
  await storeLedger(env, key, ledger);
  return ledger;
}

function sanitizedErrorType(body: Record<string, unknown>): string | null {
  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : body;
  const value = error.code ?? error.type;
  return value === undefined || value === null ? null : String(value).replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 120);
}

export async function requestOpenCodeGo(input: {
  env: Env;
  credentialBindingName: OpenCodeGoCredentialBindingName;
  spendLedgerKey: string;
  body: Record<string, unknown>;
  context: string;
  requestIdentity?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  body: Record<string, unknown>;
  status: number;
  latencyMilliseconds: number;
  usage: OpenCodeGoUsage;
  accounting: OpenCodeGoSpendLedger;
}> {
  await assertOpenCodeGoBudgetAvailable(input.env, input.spendLedgerKey);
  const fetchImpl = input.fetchImpl ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 45_000);
  let response: Response;
  try {
    response = await fetchImpl(OPENCODE_GO_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openCodeGoCredentialValue(input.env, input.credentialBindingName)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    throw new ConnectorError(timedOut ? "provider_timeout" : "provider_network_error", timedOut ? "OpenCode Go request timed out." : "OpenCode Go could not be reached.", { retryable: true });
  } finally {
    clearTimeout(timeout);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(new TextDecoder().decode(bytes.slice(0, MAX_RESPONSE_BYTES))) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const accounting = await recordOpenCodeGoAccounting(input.env, input.spendLedgerKey, {
    context: input.context,
    httpStatus: response.status,
    costBearing: response.ok,
    body,
    requestIdentity: input.requestIdentity,
  });
  if (!response.ok) {
    const details = { providerErrorType: sanitizedErrorType(body), credentialBindingName: input.credentialBindingName };
    if (response.status === 401) {
      if (input.credentialBindingName === "OPENCODE_ZEN_API_KEY") throw new ConnectorError("opencode_go_access_not_authorized", "The existing OpenCode Zen credential is not authorized for the OpenCode Go endpoint.", { status: response.status, details });
      throw new ConnectorError("provider_authentication_failed", "OpenCode Go authentication was rejected.", { status: response.status, details });
    }
    if (response.status === 403 || response.status === 404) {
      throw new ConnectorError("opencode_go_access_not_authorized", "The selected credential is not authorized for the OpenCode Go endpoint or exact mimo-v2.5 model.", { status: response.status, details });
    }
    if (response.status === 429) throw new ConnectorError("provider_rate_limit_exhausted", "OpenCode Go rate limited the request.", { status: response.status, retryable: true, details });
    if (response.status >= 500) throw new ConnectorError("provider_retry_exhausted", "OpenCode Go returned a transient server error.", { status: response.status, retryable: true, details });
    throw new ConnectorError("provider_request_rejected", "OpenCode Go rejected the classification request.", { status: response.status, retryable: false, details });
  }
  return {
    body,
    status: response.status,
    latencyMilliseconds: Date.now() - started,
    usage: parseOpenCodeGoUsage(body),
    accounting,
  };
}

export async function writeOpenCodeGoCapabilityCache(env: Env, receipt: OpenCodeGoCapabilityReceipt): Promise<void> {
  await putArtifact(env, CAPABILITY_CACHE_KEY, JSON.stringify(receipt, null, 2), "application/json; charset=utf-8", {
    provider: receipt.provider,
    model: receipt.model,
    probeVersion: receipt.probeVersion,
    credentialBindingName: receipt.credentialBindingName,
    discoveryTimestamp: receipt.discoveryTimestamp,
  });
}

export async function readOpenCodeGoCapabilityCache(env: Env): Promise<OpenCodeGoCapabilityReceipt | null> {
  const object = await env.ARTIFACTS.get(CAPABILITY_CACHE_KEY);
  if (!object) return null;
  try {
    const receipt = JSON.parse(await object.text()) as OpenCodeGoCapabilityReceipt;
    if (receipt.provider !== OPENCODE_GO_PROVIDER || receipt.mode !== OPENCODE_GO_MODE || receipt.model !== OPENCODE_GO_MODEL) return null;
    if (receipt.probeVersion !== ODL_REQ_022_GO_PROBE_VERSION || !receipt.visionProbe.passed) return null;
    if (receipt.credentialBindingName !== selectOpenCodeGoCredentialBinding(env)) return null;
    if (Date.now() - Date.parse(receipt.discoveryTimestamp) > OPENCODE_GO_CAPABILITY_CACHE_SECONDS * 1000) return null;
    return { ...receipt, discoveryCacheHit: true, accounting: await readOpenCodeGoSpendLedger(env, receipt.spendLedgerKey) };
  } catch {
    return null;
  }
}
