import type { WorkflowStep } from "cloudflare:workers";
import { bytesToBase64, sha256Bytes } from "./integrated-core";
import { canonicalJson, nowIso, putArtifact, sha256HexUtf8 } from "./paid-core";
import {
  OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH,
  OPENCODE_VISION_PROBE_JPEG_SHA256,
  syntheticVisionProbeJpegBytes,
} from "./visual-catalogue-probe-fixture";
import {
  OPENCODE_GO_CHAT_ENDPOINT,
  OPENCODE_GO_ENDPOINT_FAMILY,
  OPENCODE_GO_MODE,
  OPENCODE_GO_MODEL,
  OPENCODE_GO_MODELS_ENDPOINT,
  OPENCODE_GO_PROVIDER,
  ODL_REQ_024_GO_PROBE_VERSION,
  assertOpenCodeGoBudgetAvailable,
  initializeOpenCodeGoSpendLedger,
  openCodeGoCredentialValue,
  parseOpenCodeGoUsage,
  readOpenCodeGoSpendLedger,
  recordOpenCodeGoAccounting,
  selectOpenCodeGoCredentialBinding,
  writeOpenCodeGoCapabilityCache,
  type OpenCodeGoCapabilityReceipt,
  type OpenCodeGoCredentialBindingName,
  type OpenCodeGoSpendLedger,
  type OpenCodeGoUsage,
} from "./visual-catalogue-opencode-go";

export const ODL_REQ_024_DIAGNOSTIC_MAX_REQUESTS = 8;
export const ODL_REQ_024_DIAGNOSTIC_MAX_SPEND_USD = 0.05;
export const ODL_REQ_024_CAPABILITY_MAX_REQUESTS = 75;
export const ODL_REQ_024_CAPABILITY_MAX_SPEND_USD = 1;
const MAX_RESPONSE_BYTES = 64 * 1024;
const EXPECTED_FIXTURE_WIDTH = 480;
const EXPECTED_FIXTURE_HEIGHT = 270;

export type GoSuccessEnvelopeClass =
  | "openai_message_content_string"
  | "openai_message_content_parts"
  | "openai_message_refusal"
  | "reasoning_only_no_final_content"
  | "empty_message_content"
  | "choices_missing"
  | "message_missing"
  | "finish_reason_length_without_content"
  | "provider_error_embedded_in_200"
  | "alternate_documented_text_field"
  | "unknown_success_envelope";

export type GoDiagnosticProbeName =
  | "text_control"
  | "current_vision_payload"
  | "canonical_vision_payload"
  | "minimal_token_control"
  | "structured_vision"
  | "model_discovery"
  | "text_structured_output"
  | "capability_vision_unstructured"
  | "capability_vision_structured";

export type GoRequestShapeReceipt = {
  endpoint: string;
  model: string;
  streamFlag: boolean | null;
  responseFormatPresent: boolean;
  responseFormatType: string | null;
  messageCount: number;
  roleSequence: string[];
  contentContainerType: string;
  orderedContentPartTypes: string[];
  imageTransportType: "data_url" | null;
  imageMimeType: "image/jpeg" | null;
  decodedImageByteCount: number | null;
  imageSha256: string | null;
  dataUrlPrefixClass: "data:image/jpeg;base64" | null;
  maxTokenFieldName: "max_tokens" | null;
  maxTokenValue: number | null;
  temperaturePresent: boolean;
  topPPresent: boolean;
  unsupportedOrDuplicateFields: string[];
  totalRequestByteCount: number;
  requestShapeFingerprint: string;
};

export type GoResponseShapeReceipt = {
  httpStatus: number | null;
  contentType: string | null;
  responseByteCount: number | null;
  topLevelJsonKeys: string[];
  choicesExists: boolean;
  choicesLength: number | null;
  firstChoiceKeys: string[];
  messageKeys: string[];
  messageContentType: string;
  messageContentArrayLength: number | null;
  contentPartKeyNames: string[][];
  contentPartDeclaredTypes: Array<string | null>;
  fieldPresenceTypes: {
    text: string;
    output_text: string;
    reasoning_content: string;
    refusal: string;
    tool_calls: string;
  };
  finishReason: string | null;
  providerReturnedModelId: string | null;
  usageFieldPresent: boolean;
  providerRequestId: string | null;
  edgeRequestId: string | null;
  bodySha256: string | null;
  responseShapeFingerprint: string;
  successEnvelopeClass: GoSuccessEnvelopeClass | null;
};

export type GoDiagnosticProbeReceipt = {
  probe: GoDiagnosticProbeName;
  attempt: number;
  startedAt: string;
  completedAt: string;
  latencyMilliseconds: number;
  requestShape: GoRequestShapeReceipt;
  responseShape: GoResponseShapeReceipt;
  usage: OpenCodeGoUsage | null;
  accounting: OpenCodeGoSpendLedger;
  usableFinalContent: boolean;
  visualFixtureMatched: boolean;
  structuredFixtureMatched: boolean;
  retryReason: string | null;
};

type DiagnosticPayload = {
  __odlReq024GoVisionDiagnostic: true;
  maxBillableRequests?: number;
  maxEstimatedSpendUsd?: number;
};

type WorkflowPayload = {
  jobId?: string;
  workflowId?: string;
  userId?: string;
  input?: DiagnosticPayload;
};

type BuiltRequest = {
  endpoint: string;
  method: "GET" | "POST";
  body: Record<string, unknown> | null;
  image: Uint8Array | null;
};

type SanitizedModelMetadata = {
  id: string;
  object: string | null;
  created: number | null;
  ownedBy: string | null;
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  pricingMetadataPresent: boolean;
};

type ProbeInternal = {
  receipt: GoDiagnosticProbeReceipt;
  modelMetadata: SanitizedModelMetadata | null;
};

function boundedKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort().slice(0, 48);
}

function structuralType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.byteLength) break;
    if (new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]).has(marker)) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return { width, height };
    }
    offset += length;
  }
  return null;
}

export async function verifyOpenCodeGoDiagnosticFixture(bytes: Uint8Array): Promise<{
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  mimeType: "image/jpeg";
}> {
  const sha256 = await sha256Bytes(bytes);
  const dimensions = jpegDimensions(bytes);
  if (
    bytes.byteLength !== OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH
    || sha256 !== OPENCODE_VISION_PROBE_JPEG_SHA256
    || !dimensions
    || dimensions.width !== EXPECTED_FIXTURE_WIDTH
    || dimensions.height !== EXPECTED_FIXTURE_HEIGHT
  ) {
    throw new Error("The deterministic OpenCode Go JPEG fixture failed exact integrity validation.");
  }
  return {
    byteLength: bytes.byteLength,
    sha256,
    width: dimensions.width,
    height: dimensions.height,
    mimeType: "image/jpeg",
  };
}

function dataUrl(fixture: Uint8Array): string {
  return `data:image/jpeg;base64,${bytesToBase64(fixture)}`;
}

export function buildOpenCodeGoDiagnosticRequest(
  probe: GoDiagnosticProbeName,
  fixture: Uint8Array,
): BuiltRequest {
  if (probe === "model_discovery") return { endpoint: OPENCODE_GO_MODELS_ENDPOINT, method: "GET", body: null, image: null };
  if (probe === "text_control") {
    return {
      endpoint: OPENCODE_GO_CHAT_ENDPOINT,
      method: "POST",
      image: null,
      body: {
        model: OPENCODE_GO_MODEL,
        stream: false,
        messages: [{ role: "user", content: "Reply with the exact bounded phrase: ODL-REQ-024 TEXT CONTROL." }],
        max_tokens: 256,
        temperature: 0,
      },
    };
  }
  if (probe === "text_structured_output") {
    return {
      endpoint: OPENCODE_GO_CHAT_ENDPOINT,
      method: "POST",
      image: null,
      body: {
        model: OPENCODE_GO_MODEL,
        stream: false,
        messages: [{ role: "user", content: "Return exactly one JSON object with ok=true and probe=odl-req-024." }],
        response_format: { type: "json_object" },
        max_tokens: 120,
        temperature: 0,
      },
    };
  }

  const imageUrl = dataUrl(fixture);
  const structured = probe === "structured_vision" || probe === "capability_vision_structured";
  const current = probe === "current_vision_payload";
  const higherToken = probe === "minimal_token_control";
  const body: Record<string, unknown> = {
    model: OPENCODE_GO_MODEL,
    messages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: structured
            ? "Return JSON only with blue_shape, red_shape, visible_text, and capability_ready."
            : "Identify the blue square, red circle, and exact visible text in ordinary text.",
        },
        {
          type: "image_url",
          image_url: current
            ? { url: imageUrl, detail: "high" }
            : { url: imageUrl },
        },
      ],
    }],
    temperature: 0,
    max_tokens: higherToken ? 512 : structured ? 320 : 180,
  };
  if (!current) body.stream = false;
  if (structured) body.response_format = { type: "json_object" };
  return { endpoint: OPENCODE_GO_CHAT_ENDPOINT, method: "POST", body, image: fixture };
}

export async function openCodeGoRequestShapeReceipt(request: BuiltRequest): Promise<GoRequestShapeReceipt> {
  const body = request.body ?? {};
  const messages = Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : [];
  const firstContent = messages[0]?.content;
  const parts = Array.isArray(firstContent) ? firstContent as Record<string, unknown>[] : [];
  const imagePart = parts.find((part) => part?.type === "image_url");
  const imageSha256 = request.image ? await sha256Bytes(request.image) : null;
  const requestBytes = request.body ? new TextEncoder().encode(JSON.stringify(request.body)).byteLength : 0;
  const unsupported = Object.keys(body).filter((key) => !new Set(["model", "messages", "stream", "response_format", "max_tokens", "temperature", "top_p"]).has(key)).sort();
  const base = {
    endpoint: request.endpoint,
    model: String(body.model ?? OPENCODE_GO_MODEL).slice(0, 100),
    streamFlag: typeof body.stream === "boolean" ? body.stream : null,
    responseFormatPresent: Boolean(body.response_format),
    responseFormatType: body.response_format && typeof body.response_format === "object"
      ? String((body.response_format as Record<string, unknown>).type ?? "").slice(0, 100) || null
      : null,
    messageCount: messages.length,
    roleSequence: messages.map((message) => String(message.role ?? "").slice(0, 40)),
    contentContainerType: structuralType(firstContent),
    orderedContentPartTypes: parts.map((part) => String(part?.type ?? "").slice(0, 80)),
    imageTransportType: imagePart ? "data_url" as const : null,
    imageMimeType: request.image ? "image/jpeg" as const : null,
    decodedImageByteCount: request.image?.byteLength ?? null,
    imageSha256,
    dataUrlPrefixClass: imagePart ? "data:image/jpeg;base64" as const : null,
    maxTokenFieldName: typeof body.max_tokens === "number" ? "max_tokens" as const : null,
    maxTokenValue: typeof body.max_tokens === "number" ? body.max_tokens : null,
    temperaturePresent: Object.prototype.hasOwnProperty.call(body, "temperature"),
    topPPresent: Object.prototype.hasOwnProperty.call(body, "top_p"),
    unsupportedOrDuplicateFields: unsupported,
    totalRequestByteCount: requestBytes,
  };
  return {
    ...base,
    requestShapeFingerprint: await sha256HexUtf8(canonicalJson(base)),
  };
}

function firstMessage(body: Record<string, unknown>): Record<string, unknown> | null {
  const choices = Array.isArray(body.choices) ? body.choices as Record<string, unknown>[] : [];
  const message = choices[0]?.message;
  return message && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : null;
}

export function extractOpenCodeGoFinalContent(body: Record<string, unknown>): string | null {
  const message = firstMessage(body);
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string" || !record.text.trim()) continue;
    parts.push(record.text);
  }
  return parts.length ? parts.join("") : null;
}

export function classifyOpenCodeGoSuccessEnvelope(body: Record<string, unknown>): GoSuccessEnvelopeClass {
  if (body.error && typeof body.error === "object") return "provider_error_embedded_in_200";
  if (!Array.isArray(body.choices)) return "choices_missing";
  const choices = body.choices as Record<string, unknown>[];
  const message = firstMessage(body);
  if (!message) return "message_missing";
  if (typeof message.refusal === "string" && message.refusal.trim()) return "openai_message_refusal";
  const content = message.content;
  if (typeof content === "string" && content.trim()) return "openai_message_content_string";
  if (Array.isArray(content) && extractOpenCodeGoFinalContent(body)) return "openai_message_content_parts";
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) return "reasoning_only_no_final_content";
  const finishReason = choices[0]?.finish_reason;
  if (finishReason === "length" && (content === null || content === undefined || content === "" || (Array.isArray(content) && content.length === 0))) {
    return "finish_reason_length_without_content";
  }
  if (typeof message.output_text === "string" && message.output_text.trim()) return "alternate_documented_text_field";
  if (typeof body.output_text === "string" && body.output_text.trim()) return "alternate_documented_text_field";
  if (content === null || content === undefined || content === "" || (Array.isArray(content) && !extractOpenCodeGoFinalContent(body))) {
    return "empty_message_content";
  }
  return "unknown_success_envelope";
}

export async function openCodeGoResponseShapeReceipt(input: {
  status: number | null;
  contentType: string | null;
  bytes: Uint8Array | null;
  body: Record<string, unknown>;
  providerRequestId: string | null;
  edgeRequestId: string | null;
}): Promise<GoResponseShapeReceipt> {
  const choices = Array.isArray(input.body.choices) ? input.body.choices as Record<string, unknown>[] : [];
  const firstChoice = choices[0] && typeof choices[0] === "object" ? choices[0] : null;
  const message = firstMessage(input.body);
  const content = message?.content;
  const parts = Array.isArray(content) ? content : [];
  const fieldType = (key: string): string => {
    const source = message && Object.prototype.hasOwnProperty.call(message, key) ? message : input.body;
    return Object.prototype.hasOwnProperty.call(source, key) ? structuralType(source[key]) : "absent";
  };
  const base = {
    httpStatus: input.status,
    contentType: input.contentType,
    responseByteCount: input.bytes?.byteLength ?? null,
    topLevelJsonKeys: boundedKeys(input.body),
    choicesExists: Array.isArray(input.body.choices),
    choicesLength: Array.isArray(input.body.choices) ? choices.length : null,
    firstChoiceKeys: boundedKeys(firstChoice),
    messageKeys: boundedKeys(message),
    messageContentType: structuralType(content),
    messageContentArrayLength: Array.isArray(content) ? content.length : null,
    contentPartKeyNames: parts.slice(0, 16).map((part) => boundedKeys(part)),
    contentPartDeclaredTypes: parts.slice(0, 16).map((part) => part && typeof part === "object" && !Array.isArray(part)
      ? typeof (part as Record<string, unknown>).type === "string"
        ? String((part as Record<string, unknown>).type).slice(0, 80)
        : null
      : null),
    fieldPresenceTypes: {
      text: fieldType("text"),
      output_text: fieldType("output_text"),
      reasoning_content: fieldType("reasoning_content"),
      refusal: fieldType("refusal"),
      tool_calls: fieldType("tool_calls"),
    },
    finishReason: firstChoice?.finish_reason === undefined || firstChoice?.finish_reason === null
      ? null
      : String(firstChoice.finish_reason).slice(0, 80),
    providerReturnedModelId: input.body.model === undefined || input.body.model === null
      ? null
      : String(input.body.model).slice(0, 120),
    usageFieldPresent: Boolean(input.body.usage && typeof input.body.usage === "object"),
    providerRequestId: input.providerRequestId,
    edgeRequestId: input.edgeRequestId,
    bodySha256: input.bytes ? await sha256Bytes(input.bytes) : null,
    successEnvelopeClass: input.status !== null && input.status >= 200 && input.status < 300
      ? classifyOpenCodeGoSuccessEnvelope(input.body)
      : null,
  };
  return {
    ...base,
    responseShapeFingerprint: await sha256HexUtf8(canonicalJson(base)),
  };
}

function visualFixtureMatched(content: string | null): boolean {
  if (!content) return false;
  const lower = content.toLocaleLowerCase("en");
  return content.includes("UCA VISION PROBE 2047")
    && lower.includes("blue")
    && lower.includes("square")
    && lower.includes("red")
    && lower.includes("circle");
}

function structuredFixtureMatched(content: string | null): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return String(parsed.blue_shape ?? "").toLocaleLowerCase("en").includes("square")
      && String(parsed.red_shape ?? "").toLocaleLowerCase("en").includes("circle")
      && String(parsed.visible_text ?? "").includes("UCA VISION PROBE 2047")
      && parsed.capability_ready !== false;
  } catch {
    return false;
  }
}

function textStructuredMatched(content: string | null): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed.ok === true && parsed.probe === "odl-req-024";
  } catch {
    return false;
  }
}

function sanitizedModelMetadata(body: Record<string, unknown>): SanitizedModelMetadata | null {
  const models = Array.isArray(body.data) ? body.data as Record<string, unknown>[] : [];
  const model = models.find((entry) => String(entry?.id ?? entry?.name ?? "") === OPENCODE_GO_MODEL);
  if (!model) return null;
  return {
    id: String(model.id ?? model.name ?? OPENCODE_GO_MODEL).slice(0, 100),
    object: model.object === undefined || model.object === null ? null : String(model.object).slice(0, 100),
    created: Number.isFinite(Number(model.created)) ? Number(model.created) : null,
    ownedBy: model.owned_by === undefined || model.owned_by === null ? null : String(model.owned_by).slice(0, 100),
    contextLength: Number.isFinite(Number(model.context_length)) ? Number(model.context_length) : null,
    inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities.map(String).slice(0, 16) : [],
    outputModalities: Array.isArray(model.output_modalities) ? model.output_modalities.map(String).slice(0, 16) : [],
    pricingMetadataPresent: Boolean(model.pricing && typeof model.pricing === "object"),
  };
}

async function runProbe(input: {
  env: Env;
  probe: GoDiagnosticProbeName;
  attempt: number;
  fixture: Uint8Array;
  credentialBindingName: OpenCodeGoCredentialBindingName;
  spendLedgerKey: string;
  retryReason?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<ProbeInternal> {
  const request = buildOpenCodeGoDiagnosticRequest(input.probe, input.fixture);
  const requestShape = await openCodeGoRequestShapeReceipt(request);
  await assertOpenCodeGoBudgetAvailable(input.env, input.spendLedgerKey);
  const startedAt = nowIso();
  const started = Date.now();
  let status: number | null = null;
  let responseContentType: string | null = null;
  let providerRequestId: string | null = null;
  let edgeRequestId: string | null = null;
  let bytes: Uint8Array | null = null;
  let parsedBody: Record<string, unknown> = {};
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 45_000);
    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(request.endpoint, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${openCodeGoCredentialValue(input.env, input.credentialBindingName)}`,
          ...(request.body ? { "Content-Type": "application/json" } : {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    status = response.status;
    responseContentType = response.headers.get("content-type")?.slice(0, 120) ?? null;
    providerRequestId = (response.headers.get("x-request-id") ?? response.headers.get("request-id"))?.slice(0, 200) ?? null;
    edgeRequestId = response.headers.get("cf-ray")?.slice(0, 200) ?? null;
    bytes = new Uint8Array(await response.arrayBuffer());
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(bytes.slice(0, MAX_RESPONSE_BYTES))) as Record<string, unknown>;
    } catch {
      parsedBody = {};
    }
  } catch {
    status = null;
  }

  const accounting = await recordOpenCodeGoAccounting(input.env, input.spendLedgerKey, {
    context: `odl-req-024:${input.probe}:${input.attempt}`,
    httpStatus: status ?? 0,
    costBearing: status !== null && status >= 200 && status < 300 && request.method === "POST",
    body: parsedBody,
    requestIdentity: requestShape.requestShapeFingerprint,
  });
  const finalContent = status !== null && status >= 200 && status < 300 ? extractOpenCodeGoFinalContent(parsedBody) : null;
  const responseShape = await openCodeGoResponseShapeReceipt({
    status,
    contentType: responseContentType,
    bytes,
    body: parsedBody,
    providerRequestId,
    edgeRequestId,
  });
  const visual = visualFixtureMatched(finalContent);
  const structured = structuredFixtureMatched(finalContent);
  const textStructured = textStructuredMatched(finalContent);
  const usable = input.probe === "model_discovery"
    ? Array.isArray(parsedBody.data)
      && (parsedBody.data as Record<string, unknown>[]).some((entry) => String(entry?.id ?? entry?.name ?? "") === OPENCODE_GO_MODEL)
    : input.probe === "text_control"
      ? Boolean(finalContent?.includes("ODL-REQ-024 TEXT CONTROL"))
      : input.probe === "text_structured_output"
        ? textStructured
        : input.probe === "structured_vision" || input.probe === "capability_vision_structured"
          ? structured
          : visual;

  return {
    modelMetadata: input.probe === "model_discovery" ? sanitizedModelMetadata(parsedBody) : null,
    receipt: {
      probe: input.probe,
      attempt: input.attempt,
      startedAt,
      completedAt: nowIso(),
      latencyMilliseconds: Date.now() - started,
      requestShape,
      responseShape,
      usage: request.method === "POST" ? parseOpenCodeGoUsage(parsedBody) : null,
      accounting,
      usableFinalContent: usable,
      visualFixtureMatched: visual,
      structuredFixtureMatched: structured,
      retryReason: input.retryReason ?? null,
    },
  };
}

function retryableProbe(receipt: GoDiagnosticProbeReceipt): boolean {
  if (receipt.responseShape.httpStatus === null) return true;
  if (receipt.responseShape.httpStatus >= 500) return true;
  if (receipt.responseShape.httpStatus < 200 || receipt.responseShape.httpStatus >= 300) return false;
  return new Set<GoSuccessEnvelopeClass>([
    "empty_message_content",
    "finish_reason_length_without_content",
    "reasoning_only_no_final_content",
    "unknown_success_envelope",
  ]).has(receipt.responseShape.successEnvelopeClass ?? "unknown_success_envelope");
}

export function shouldRunOpenCodeGoTokenControl(receipt: GoDiagnosticProbeReceipt): boolean {
  if (receipt.usableFinalContent || receipt.responseShape.httpStatus !== 200) return false;
  if (receipt.responseShape.finishReason === "length") return true;
  return new Set<GoSuccessEnvelopeClass>([
    "finish_reason_length_without_content",
    "empty_message_content",
  ]).has(receipt.responseShape.successEnvelopeClass ?? "unknown_success_envelope");
}

async function boundedBackoff(step: WorkflowStep, label: string, attempt: number): Promise<void> {
  const seconds = Math.min(4, 2 ** Math.max(0, attempt - 1));
  await step.sleep(`${label} bounded backoff ${attempt}`, `${seconds} seconds`);
}

function distribution<T extends string>(values: T[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return output;
}

async function persistDiagnostic(env: Env, jobId: string, value: unknown): Promise<void> {
  await putArtifact(
    env,
    `visual-compiler/provider-diagnostics/opencode-go/${OPENCODE_GO_MODEL}/${ODL_REQ_024_GO_PROBE_VERSION}/${jobId}.json`,
    JSON.stringify(value, null, 2),
    "application/json; charset=utf-8",
    {
      provider: OPENCODE_GO_PROVIDER,
      model: OPENCODE_GO_MODEL,
      probeVersion: ODL_REQ_024_GO_PROBE_VERSION,
      jobId,
    },
  );
}

export function isOpenCodeGoVisionDiagnosticWorkflowPayload(payload: WorkflowPayload | undefined): boolean {
  return Boolean(payload?.input?.__odlReq024GoVisionDiagnostic);
}

export async function runOpenCodeGoVisionDiagnosticWorkflow(
  env: Env,
  payload: WorkflowPayload,
  step: WorkflowStep,
): Promise<Record<string, unknown>> {
  if (!payload.input?.__odlReq024GoVisionDiagnostic) throw new Error("ODL-REQ-024 diagnostic payload is invalid.");
  await step.do("ODL-REQ-024 initialize sanitized diagnostic", async () => ({
    initialized: true,
    probeVersion: ODL_REQ_024_GO_PROBE_VERSION,
    oneDriveAccessed: false,
    sourcePdfRead: false,
  }));
  const jobId = String(payload.jobId ?? payload.workflowId ?? crypto.randomUUID()).slice(0, 100);
  const diagnosticMaxRequests = Math.min(
    ODL_REQ_024_DIAGNOSTIC_MAX_REQUESTS,
    Math.max(1, Number(payload.input.maxBillableRequests ?? ODL_REQ_024_DIAGNOSTIC_MAX_REQUESTS)),
  );
  const diagnosticMaxSpend = Math.min(
    ODL_REQ_024_DIAGNOSTIC_MAX_SPEND_USD,
    Math.max(0.000001, Number(payload.input.maxEstimatedSpendUsd ?? ODL_REQ_024_DIAGNOSTIC_MAX_SPEND_USD)),
  );
  const credentialBindingName = selectOpenCodeGoCredentialBinding(env);
  const fixture = syntheticVisionProbeJpegBytes();
  const fixtureReceipt = await verifyOpenCodeGoDiagnosticFixture(fixture);
  const diagnosticLedger = await initializeOpenCodeGoSpendLedger(env, {
    scopeId: `${jobId}-diagnostic`,
    credentialBindingName,
    maxBillableRequests: diagnosticMaxRequests,
    maxEstimatedSpendUsd: diagnosticMaxSpend,
  });

  const diagnostics: GoDiagnosticProbeReceipt[] = [];
  const doProbe = async (probe: GoDiagnosticProbeName, attempt: number, retryReason: string | null = null) => {
    const result = await step.do(
      `ODL-REQ-024 diagnostic ${probe} attempt ${attempt}`,
      { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" },
      async () => runProbe({
        env,
        probe,
        attempt,
        fixture,
        credentialBindingName,
        spendLedgerKey: diagnosticLedger.key,
        retryReason,
      }),
    );
    diagnostics.push(result.receipt);
    return result;
  };

  const textControl = await doProbe("text_control", 1);
  const currentVision = await doProbe("current_vision_payload", 1);
  const canonicalAttempts: ProbeInternal[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await doProbe("canonical_vision_payload", attempt, attempt > 1 ? "bounded_retry_after_transient_or_incomplete_response" : null);
    canonicalAttempts.push(result);
    if (result.receipt.usableFinalContent || !retryableProbe(result.receipt)) break;
    if (attempt < 3) await boundedBackoff(step, "ODL-REQ-024 diagnostic canonical vision", attempt);
  }

  let successfulCanonical = canonicalAttempts.find((entry) => entry.receipt.usableFinalContent) ?? null;
  let tokenControl: ProbeInternal | null = null;
  const lastCanonical = canonicalAttempts.at(-1) ?? null;
  if (lastCanonical && shouldRunOpenCodeGoTokenControl(lastCanonical.receipt)) {
    tokenControl = await doProbe("minimal_token_control", 1, "bounded_output_token_control");
    if (tokenControl.receipt.usableFinalContent) successfulCanonical = tokenControl;
  }

  let structuredVision: ProbeInternal | null = null;
  if (successfulCanonical) structuredVision = await doProbe("structured_vision", 1);

  const currentStatus = currentVision.receipt.responseShape.httpStatus;
  const canonicalStatuses = canonicalAttempts.map((entry) => entry.receipt.responseShape.httpStatus);
  const canonicalClasses = canonicalAttempts.map((entry) => entry.receipt.responseShape.successEnvelopeClass);
  const canonicalServerFailures = canonicalStatuses.filter((status) => status !== null && status >= 500).length;
  const canonicalStableIncomplete = canonicalAttempts.length >= 2
    && canonicalAttempts.every((entry) => entry.receipt.responseShape.httpStatus === 200)
    && new Set(canonicalClasses.filter(Boolean)).size === 1
    && !successfulCanonical;

  let selectedBranch:
    | "A_request_shape_defect"
    | "B_valid_alternate_content_shape"
    | "C_transient_malformed_http_200"
    | "D_output_token_truncation"
    | "E_provider_multimodal_failure"
    | "diagnostic_inconclusive";
  let blockerClassification: string | null = null;
  if (tokenControl?.receipt.usableFinalContent) {
    selectedBranch = "D_output_token_truncation";
  } else if (
    successfulCanonical
    && currentStatus === 200
    && !currentVision.receipt.usableFinalContent
  ) {
    selectedBranch = "A_request_shape_defect";
  } else if (
    successfulCanonical
    && (currentStatus === null || currentStatus >= 500 || canonicalAttempts.some((entry, index) => index > 0 && entry.receipt.usableFinalContent))
  ) {
    selectedBranch = "C_transient_malformed_http_200";
  } else if (
    successfulCanonical
    && successfulCanonical.receipt.responseShape.successEnvelopeClass === "openai_message_content_parts"
  ) {
    selectedBranch = "B_valid_alternate_content_shape";
  } else if (canonicalServerFailures >= 2) {
    selectedBranch = "E_provider_multimodal_failure";
    blockerClassification = "opencode_go_mimo_vision_server_unavailable";
  } else if (canonicalStableIncomplete || (!successfulCanonical && canonicalAttempts.some((entry) => entry.receipt.responseShape.httpStatus === 200))) {
    selectedBranch = "E_provider_multimodal_failure";
    blockerClassification = "opencode_go_mimo_multimodal_contract_unsupported";
  } else {
    selectedBranch = "diagnostic_inconclusive";
  }

  const diagnosticReceipt = {
    version: 1,
    jobId,
    provider: OPENCODE_GO_PROVIDER,
    mode: OPENCODE_GO_MODE,
    model: OPENCODE_GO_MODEL,
    endpointFamily: OPENCODE_GO_ENDPOINT_FAMILY,
    probeVersion: ODL_REQ_024_GO_PROBE_VERSION,
    ownerOnlyInvocation: "cloudflare_workflows_api",
    fixture: fixtureReceipt,
    requestAndSpendCeilings: {
      maxBillableRequests: diagnosticMaxRequests,
      maxEstimatedSpendUsd: diagnosticMaxSpend,
    },
    selectedBranch,
    blockerClassification,
    textControlPassed: textControl.receipt.usableFinalContent,
    canonicalVisionPassed: Boolean(successfulCanonical),
    structuredVisionPassed: Boolean(structuredVision?.receipt.structuredFixtureMatched),
    diagnostics,
    accounting: await readOpenCodeGoSpendLedger(env, diagnosticLedger.key),
    oneDriveAccessed: false,
    oneDriveMutationPerformed: false,
    sourcePdfRead: false,
    providerFallbackUsed: false,
  };

  let capabilityReceipt: ({ status: "passed" | "failed" } & Record<string, unknown>) | null = null;
  if (successfulCanonical && structuredVision?.receipt.structuredFixtureMatched) {
    const capabilityLedger = await initializeOpenCodeGoSpendLedger(env, {
      scopeId: `${jobId}-capability`,
      credentialBindingName,
      maxBillableRequests: ODL_REQ_024_CAPABILITY_MAX_REQUESTS,
      maxEstimatedSpendUsd: ODL_REQ_024_CAPABILITY_MAX_SPEND_USD,
    });
    const capabilityAttempts: GoDiagnosticProbeReceipt[] = [];

    const capabilityProbe = async (probe: GoDiagnosticProbeName, maximumAttempts: number) => {
      let last: ProbeInternal | null = null;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const result = await step.do(
          `ODL-REQ-024 capability ${probe} attempt ${attempt}`,
          { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" },
          async () => runProbe({
            env,
            probe,
            attempt,
            fixture,
            credentialBindingName,
            spendLedgerKey: capabilityLedger.key,
            retryReason: attempt > 1 ? "bounded_capability_retry" : null,
          }),
        );
        capabilityAttempts.push(result.receipt);
        last = result;
        if (result.receipt.usableFinalContent) return result;
        if (!retryableProbe(result.receipt) || attempt >= maximumAttempts) return result;
        await boundedBackoff(step, `ODL-REQ-024 capability ${probe}`, attempt);
      }
      return last as ProbeInternal;
    };

    const modelDiscovery = await capabilityProbe("model_discovery", 2);
    const textStructured = modelDiscovery.receipt.usableFinalContent
      ? await capabilityProbe("text_structured_output", 2)
      : null;
    const visionUnstructured = textStructured?.receipt.usableFinalContent
      ? await capabilityProbe("capability_vision_unstructured", 3)
      : null;
    const visionStructured = visionUnstructured?.receipt.usableFinalContent
      ? await capabilityProbe("capability_vision_structured", 3)
      : null;

    const stageResults = {
      model_discovery: modelDiscovery.receipt.usableFinalContent ? "passed" : "failed",
      text_structured_output: textStructured?.receipt.usableFinalContent ? "passed" : textStructured ? "failed" : "not_run",
      vision_unstructured: visionUnstructured?.receipt.usableFinalContent ? "passed" : visionUnstructured ? "failed" : "not_run",
      vision_structured_output: visionStructured?.receipt.structuredFixtureMatched ? "passed" : visionStructured ? "failed" : "not_run",
    } as const;
    const passed = Object.values(stageResults).every((value) => value === "passed");
    const capabilityAccounting = await readOpenCodeGoSpendLedger(env, capabilityLedger.key);
    capabilityReceipt = {
      version: 2,
      capabilityJobId: jobId,
      provider: OPENCODE_GO_PROVIDER,
      mode: OPENCODE_GO_MODE,
      exactModel: OPENCODE_GO_MODEL,
      probeVersion: ODL_REQ_024_GO_PROBE_VERSION,
      endpointFamily: OPENCODE_GO_ENDPOINT_FAMILY,
      status: passed ? "passed" : "failed",
      stageResults,
      attempts: capabilityAttempts,
      httpStatusDistribution: distribution(capabilityAttempts.map((entry) => entry.responseShape.httpStatus === null ? "none" : String(entry.responseShape.httpStatus))),
      responseClassDistribution: distribution(capabilityAttempts.map((entry) => entry.responseShape.successEnvelopeClass ?? (entry.responseShape.httpStatus === null ? "network_failure" : `http_${entry.responseShape.httpStatus}`))),
      requestShapeFingerprints: capabilityAttempts.map((entry) => entry.requestShape.requestShapeFingerprint),
      responseShapeFingerprints: capabilityAttempts.map((entry) => entry.responseShape.responseShapeFingerprint),
      accounting: capabilityAccounting,
      oneDriveAccessed: false,
      oneDriveMutationPerformed: false,
      providerFallbackUsed: false,
      finalReasonForStopping: passed ? "all_four_mandatory_stages_passed" : "fresh_capability_stage_failed",
    };

    if (passed && visionStructured) {
      const model = modelDiscovery.modelMetadata ?? {
        id: OPENCODE_GO_MODEL,
        object: null,
        created: null,
        ownedBy: null,
        contextLength: null,
        inputModalities: [],
        outputModalities: [],
        pricingMetadataPresent: false,
      };
      const cache: OpenCodeGoCapabilityReceipt = {
        provider: OPENCODE_GO_PROVIDER,
        mode: OPENCODE_GO_MODE,
        model: OPENCODE_GO_MODEL,
        endpointFamily: OPENCODE_GO_ENDPOINT_FAMILY,
        probeVersion: ODL_REQ_024_GO_PROBE_VERSION,
        credentialBindingName,
        discoveryTimestamp: nowIso(),
        discoveryCacheHit: false,
        modelPresent: true,
        modelMetadata: {
          id: model.id,
          object: model.object,
          created: model.created,
          ownedBy: model.ownedBy,
          contextLength: model.contextLength,
          inputModalities: model.inputModalities,
          outputModalities: model.outputModalities,
          pricingMetadataPresent: model.pricingMetadataPresent,
          pricing: capabilityAccounting.pricing,
        },
        visionProbe: {
          passed: true,
          status: visionStructured.receipt.responseShape.httpStatus ?? 200,
          latencyMilliseconds: visionStructured.receipt.latencyMilliseconds,
          exactTextObserved: true,
          blueSquareObserved: true,
          redCircleObserved: true,
          detailFieldAccepted: false,
          sanitizedUsage: {
            inputTokens: visionStructured.receipt.usage?.inputTokens ?? null,
            outputTokens: visionStructured.receipt.usage?.outputTokens ?? null,
            cachedReadTokens: visionStructured.receipt.usage?.cachedReadTokens ?? null,
            totalTokens: visionStructured.receipt.usage?.totalTokens ?? null,
          },
        },
        structuredOutput: {
          responseFormatAccepted: true,
          jsonObjectReliable: true,
        },
        spendScopeId: `${jobId}-capability`,
        spendLedgerKey: capabilityLedger.key,
        maxBillableRequests: ODL_REQ_024_CAPABILITY_MAX_REQUESTS,
        maxEstimatedSpendUsd: ODL_REQ_024_CAPABILITY_MAX_SPEND_USD,
        accounting: capabilityAccounting,
        costClassification: capabilityAccounting.estimatedSpendUsd === null
          ? "usage_not_reported"
          : "provider_metered_or_fallback_estimate",
      };
      await writeOpenCodeGoCapabilityCache(env, cache);
    }
  }

  const result = {
    classification: capabilityReceipt && capabilityReceipt.status === "passed"
      ? "visual_paid_capability_repaired_and_passed"
      : selectedBranch === "E_provider_multimodal_failure"
        ? blockerClassification
        : "visual_paid_capability_diagnostic_complete",
    diagnosticReceipt,
    capabilityReceipt,
    calibrationAuthorized: Boolean(capabilityReceipt && capabilityReceipt.status === "passed"),
    calibrationStarted: false,
    pages64Through219Blocked: true,
  };
  await persistDiagnostic(env, jobId, result);
  return result;
}
