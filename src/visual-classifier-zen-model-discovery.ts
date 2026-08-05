import { ConnectorError } from "./errors";
import {
  ZEN_RESPONSES_CREDENTIAL_BINDING,
  ZEN_RESPONSES_MODE,
  ZEN_RESPONSES_MODEL,
  ZEN_RESPONSES_MODELS_ENDPOINT,
  ZEN_RESPONSES_PROVIDER,
  resolveZenResponsesPricing,
  type ZenResponsesModelMetadata,
} from "./visual-catalogue-zen-responses";

const MAX_MODELS_RESPONSE_BYTES = 128 * 1024;
const MODELS_FETCH_TIMEOUT_MS = 15_000;

export type ZenModelsDiscoveryReceipt = {
  version: 1;
  stage: "model_discovery";
  provider: typeof ZEN_RESPONSES_PROVIDER;
  mode: typeof ZEN_RESPONSES_MODE;
  model: typeof ZEN_RESPONSES_MODEL;
  endpointClass: "models_get";
  endpoint: typeof ZEN_RESPONSES_MODELS_ENDPOINT;
  dispatchBranch: "opencode_zen_responses_models_get";
  localErrorCode: string | null;
  localErrorClass: string | null;
  fetchBegan: boolean;
  credentialBindingExists: boolean;
  credentialBindingName: typeof ZEN_RESPONSES_CREDENTIAL_BINDING;
  correlationId: string;
  httpStatus: number | null;
  responseContentType: string | null;
  responseByteCount: number | null;
  responseEnvelopeShape: "openai_list" | "object" | "non_object" | null;
  topLevelObject: string | null;
  modelRecordCount: number | null;
  exactModelIdPresent: boolean | null;
  parserResult: string;
  billableRequestIncrement: 0;
  inputTokenIncrement: 0;
  outputTokenIncrement: 0;
  spendIncrementUsd: 0;
};

export class ZenModelsDiscoveryError extends ConnectorError {
  readonly receipt: ZenModelsDiscoveryReceipt;

  constructor(
    code: string,
    message: string,
    receipt: ZenModelsDiscoveryReceipt,
    options: { retryable?: boolean; status?: number } = {},
  ) {
    super(code, message, { ...options, correlationId: receipt.correlationId });
    this.receipt = receipt;
  }
}

export function isZenModelsDiscoveryError(error: unknown): error is ZenModelsDiscoveryError {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  const receipt = value.receipt;
  return typeof value.code === "string"
    && Boolean(receipt && typeof receipt === "object" && (receipt as Record<string, unknown>).stage === "model_discovery");
}

function baseReceipt(): ZenModelsDiscoveryReceipt {
  return {
    version: 1,
    stage: "model_discovery",
    provider: ZEN_RESPONSES_PROVIDER,
    mode: ZEN_RESPONSES_MODE,
    model: ZEN_RESPONSES_MODEL,
    endpointClass: "models_get",
    endpoint: ZEN_RESPONSES_MODELS_ENDPOINT,
    dispatchBranch: "opencode_zen_responses_models_get",
    localErrorCode: null,
    localErrorClass: null,
    fetchBegan: false,
    credentialBindingExists: false,
    credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING,
    correlationId: crypto.randomUUID(),
    httpStatus: null,
    responseContentType: null,
    responseByteCount: null,
    responseEnvelopeShape: null,
    topLevelObject: null,
    modelRecordCount: null,
    exactModelIdPresent: null,
    parserResult: "not_started",
    billableRequestIncrement: 0,
    inputTokenIncrement: 0,
    outputTokenIncrement: 0,
    spendIncrementUsd: 0,
  };
}

function failure(
  code: string,
  message: string,
  receipt: ZenModelsDiscoveryReceipt,
  localErrorClass: string,
  options: { retryable?: boolean; status?: number } = {},
): never {
  const failed = { ...receipt, localErrorCode: code, localErrorClass };
  throw new ZenModelsDiscoveryError(code, message, failed, options);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).slice(0, 16) : [];
}

export async function discoverZenResponsesModelWithReceipt(
  env: Pick<Env, "OPENCODE_ZEN_API_KEY">,
  identity: { provider?: unknown; mode?: unknown; model?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ metadata: ZenResponsesModelMetadata; receipt: ZenModelsDiscoveryReceipt }> {
  let receipt = baseReceipt();
  const provider = String(identity.provider ?? ZEN_RESPONSES_PROVIDER);
  const mode = String(identity.mode ?? ZEN_RESPONSES_MODE);
  const model = String(identity.model ?? ZEN_RESPONSES_MODEL);
  if (provider !== ZEN_RESPONSES_PROVIDER || mode !== ZEN_RESPONSES_MODE || model !== ZEN_RESPONSES_MODEL) {
    failure(
      "zen_discovery_dispatch_unsupported",
      "Zen model discovery requires the exact opencode_zen_responses/opencode_responses/gpt-5.6-luna identity.",
      receipt,
      "dispatch_validation",
    );
  }

  const credential = typeof env.OPENCODE_ZEN_API_KEY === "string" ? env.OPENCODE_ZEN_API_KEY.trim() : "";
  receipt = { ...receipt, credentialBindingExists: credential.length > 0 };
  if (!credential) {
    failure(
      "zen_credential_binding_missing",
      "The OPENCODE_ZEN_API_KEY binding is not configured.",
      receipt,
      "credential_validation",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("zen_models_timeout"), MODELS_FETCH_TIMEOUT_MS);
  let response: Response;
  receipt = { ...receipt, fetchBegan: true, parserResult: "fetch_started" };
  try {
    response = await fetchImpl(ZEN_RESPONSES_MODELS_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${credential}` },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : typeof error;
    failure(
      "zen_models_fetch_failed",
      "The bounded Zen models GET did not produce an HTTP response.",
      receipt,
      errorClass,
      { retryable: true },
    );
  } finally {
    clearTimeout(timeout);
  }

  receipt = {
    ...receipt,
    httpStatus: response.status,
    responseContentType: response.headers.get("content-type")?.slice(0, 120) ?? null,
    parserResult: "http_response_received",
  };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    failure(
      "zen_models_fetch_failed",
      "The Zen models response body could not be read.",
      receipt,
      error instanceof Error ? error.name : typeof error,
      { retryable: true, status: response.status },
    );
  }
  receipt = { ...receipt, responseByteCount: bytes.byteLength };

  if (!response.ok) {
    failure(
      "zen_models_http_error",
      "The Zen models endpoint returned a non-success HTTP status.",
      receipt,
      "http_status",
      { retryable: response.status === 429 || response.status >= 500, status: response.status },
    );
  }
  if (bytes.byteLength > MAX_MODELS_RESPONSE_BYTES) {
    failure(
      "zen_models_response_malformed",
      "The Zen models response exceeded the bounded structural parsing limit.",
      receipt,
      "response_size",
      { status: response.status },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    failure(
      "zen_models_response_malformed",
      "The Zen models response was not valid JSON.",
      { ...receipt, responseEnvelopeShape: "non_object", parserResult: "json_parse_failed" },
      "json_parse",
      { status: response.status },
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    failure(
      "zen_models_response_malformed",
      "The Zen models response root was not an object.",
      { ...receipt, responseEnvelopeShape: "non_object", parserResult: "root_invalid" },
      "envelope_validation",
      { status: response.status },
    );
  }

  const root = body as Record<string, unknown>;
  const topLevelObject = root.object === undefined ? null : String(root.object);
  receipt = {
    ...receipt,
    responseEnvelopeShape: topLevelObject === "list" ? "openai_list" : "object",
    topLevelObject,
    parserResult: "json_object_parsed",
  };
  if (topLevelObject !== null && topLevelObject !== "list") {
    failure(
      "zen_models_response_malformed",
      "The Zen models response object discriminator was not list.",
      receipt,
      "envelope_validation",
      { status: response.status },
    );
  }
  if (!("data" in root)) {
    failure(
      "zen_models_data_missing",
      "The Zen models response did not contain data.",
      receipt,
      "data_validation",
      { status: response.status },
    );
  }
  if (!Array.isArray(root.data)) {
    failure(
      "zen_models_response_malformed",
      "The Zen models data member was not an array.",
      receipt,
      "data_validation",
      { status: response.status },
    );
  }

  const records = root.data;
  const exact = records.find((entry) => Boolean(
    entry && typeof entry === "object"
      && typeof (entry as Record<string, unknown>).id === "string"
      && (entry as Record<string, unknown>).id === ZEN_RESPONSES_MODEL,
  ));
  receipt = {
    ...receipt,
    responseEnvelopeShape: "openai_list",
    modelRecordCount: records.length,
    exactModelIdPresent: Boolean(exact),
    parserResult: "openai_list_parsed",
  };
  if (!exact) {
    failure(
      "zen_model_exact_id_absent",
      "The well-formed live Zen model list did not contain the exact gpt-5.6-luna ID.",
      receipt,
      "exact_id_validation",
      { status: response.status },
    );
  }

  const modelRecord = exact as Record<string, unknown>;
  return {
    metadata: {
      id: ZEN_RESPONSES_MODEL,
      enabled: true,
      inputModalities: stringArray(modelRecord.input_modalities ?? modelRecord.modalities),
      outputModalities: stringArray(modelRecord.output_modalities),
      pricingMetadataPresent: Boolean(modelRecord.pricing && typeof modelRecord.pricing === "object"),
      pricing: resolveZenResponsesPricing(modelRecord),
    },
    receipt,
  };
}
