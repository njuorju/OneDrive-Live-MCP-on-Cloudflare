import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ZEN_RESPONSES_CAPABILITY_OUTPUT_CEILINGS,
  zenResponsesCapabilityOutputCeiling,
} from "../src/visual-classifier-capability-output-ceilings";
import {
  OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH,
  OPENCODE_VISION_PROBE_JPEG_SHA256,
  syntheticVisionProbeJpegBytes,
} from "../src/visual-catalogue-probe-fixture";
import {
  ZEN_RESPONSES_MAX_BILLABLE_REQUESTS,
  ZEN_RESPONSES_MAX_ESTIMATED_SPEND_USD,
  buildZenResponsesRequest,
  createBoundedZenResponsesRedirectFetch,
  initializeZenResponsesSpendLedger,
  isZenResponsesTransportError,
  readZenResponsesSpendLedger,
  requestZenResponses,
  type ZenResponsesTransportReceipt,
} from "../src/visual-catalogue-zen-responses";
import {
  assertZenVisionFixtureRecognition,
  buildBoundedZenVisionDataUrl,
  inspectZenVisionRequest,
} from "../src/visual-zen-responses-vision";

class MemoryR2 {
  values = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>();

  async get(key: string) {
    const value = this.values.get(key);
    if (!value) return null;
    return {
      text: async () => new TextDecoder().decode(value.body),
      arrayBuffer: async () => value.body.slice().buffer,
      customMetadata: value.customMetadata,
    };
  }

  async put(key: string, body: string | ArrayBuffer | Uint8Array, options?: any) {
    const bytes = typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : new Uint8Array(body);
    this.values.set(key, { body: bytes, customMetadata: options?.customMetadata });
  }

  async head(key: string) {
    return this.values.has(key) ? {} : null;
  }
}

function completedEnvelope(text: string, inputTokens: number, outputTokens: number): Record<string, unknown> {
  return {
    id: "resp_completed",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    }],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
}

function incompleteEnvelope(partialText = ""): Record<string, unknown> {
  return {
    id: "resp_incomplete",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: partialText ? [{ type: "output_text", text: partialText }] : [],
    }],
    usage: {
      input_tokens: 182,
      output_tokens: 1024,
      total_tokens: 1206,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
}

function visionRequest(stage: "vision_unstructured" | "vision_structured_output") {
  const fixture = syntheticVisionProbeJpegBytes();
  return buildZenResponsesRequest({
    text: stage === "vision_unstructured"
      ? "Identify the blue square, red circle, and exact visible text."
      : "Return the visible blue shape, red shape, exact visible text, and capability_ready=true.",
    imageDataUrl: buildBoundedZenVisionDataUrl(fixture),
    maxOutputTokens: zenResponsesCapabilityOutputCeiling(stage),
    ...(stage === "vision_structured_output"
      ? { schema: { name: "vision_probe", schema: { type: "object" } } }
      : {}),
  });
}

test("ODL-REQ-034 exposes one exact bounded stage policy", () => {
  assert.deepEqual(ZEN_RESPONSES_CAPABILITY_OUTPUT_CEILINGS, {
    text_structured_output: 128,
    vision_unstructured: 1024,
    vision_structured_output: 1024,
  });
  assert.equal(zenResponsesCapabilityOutputCeiling("text_structured_output"), 128);
  assert.equal(zenResponsesCapabilityOutputCeiling("vision_unstructured"), 1024);
  assert.equal(zenResponsesCapabilityOutputCeiling("vision_structured_output"), 1024);
  assert.throws(
    () => zenResponsesCapabilityOutputCeiling("model_discovery"),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as Record<string, unknown>).code === "capability_stage_output_ceiling_unconfigured"),
  );
  assert.throws(
    () => zenResponsesCapabilityOutputCeiling("unknown_stage"),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as Record<string, unknown>).code === "capability_stage_output_ceiling_unconfigured"),
  );
});

test("serialized Responses request bodies carry exact stage ceilings", () => {
  const text = buildZenResponsesRequest({
    text: "Return JSON with ok=true and probe=odl-req-025.",
    maxOutputTokens: zenResponsesCapabilityOutputCeiling("text_structured_output"),
    schema: { name: "text_probe", schema: { type: "object" } },
  });
  const unstructured = visionRequest("vision_unstructured");
  const structured = visionRequest("vision_structured_output");
  assert.equal(text.max_output_tokens, 128);
  assert.equal(unstructured.max_output_tokens, 1024);
  assert.equal(structured.max_output_tokens, 1024);
  assert.equal(JSON.parse(JSON.stringify(text)).max_output_tokens, 128);
  assert.equal(JSON.parse(JSON.stringify(unstructured)).max_output_tokens, 1024);
  assert.equal(JSON.parse(JSON.stringify(structured)).max_output_tokens, 1024);
});

test("completed unstructured vision below 1024 passes deterministic fixture recognition", async () => {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "mock-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, "odl-req-034-unstructured", 75, 1);
  const request = visionRequest("vision_unstructured");
  const fixtureReceipt = await inspectZenVisionRequest(request, syntheticVisionProbeJpegBytes());
  const mockFetch: typeof fetch = (async () => new Response(
    JSON.stringify(completedEnvelope("Blue square, red circle, UCA VISION PROBE 2047", 182, 48)),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  const result = await requestZenResponses({
    env,
    spendLedgerKey: ledger.key,
    body: request,
    context: "capability:vision_unstructured",
    requestIdentity: "odl-req-034:vision_unstructured",
    fetchImpl: mockFetch,
  });
  assert.equal(assertZenVisionFixtureRecognition(result.text), "fixture_recognized");
  assert.equal(result.transportReceipt.requestedMaxOutputTokens, 1024);
  assert.equal(result.transportReceipt.completionStatus, "completed");
  assert.equal(fixtureReceipt.decodedImageByteCount, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(fixtureReceipt.imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
});

test("completed structured vision below 1024 passes schema and fixture validation", async () => {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "mock-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, "odl-req-034-structured", 75, 1);
  const request = visionRequest("vision_structured_output");
  const output = JSON.stringify({
    blue_shape: "blue square",
    red_shape: "red circle",
    visible_text: "UCA VISION PROBE 2047",
    capability_ready: true,
  });
  const mockFetch: typeof fetch = (async () => new Response(
    JSON.stringify(completedEnvelope(output, 210, 76)),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  const result = await requestZenResponses({
    env,
    spendLedgerKey: ledger.key,
    body: request,
    context: "capability:vision_structured_output",
    requestIdentity: "odl-req-034:vision_structured_output",
    fetchImpl: mockFetch,
  });
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  assert.equal(parsed.capability_ready, true);
  assert.equal(assertZenVisionFixtureRecognition(`${parsed.blue_shape} ${parsed.red_shape} ${parsed.visible_text}`), "fixture_recognized");
  assert.equal(result.transportReceipt.requestedMaxOutputTokens, 1024);
  assert.equal(result.transportReceipt.completionStatus, "completed");
});

test("incomplete response at 1024 remains fail closed with exact receipt and accounting", async () => {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "mock-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, "odl-req-034-incomplete", 75, 1);
  const partial = "Blue square, red circle, UCA VISION PROBE 2047";
  const mockFetch: typeof fetch = (async () => new Response(
    JSON.stringify(incompleteEnvelope(partial)),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  let caught: unknown = null;
  try {
    await requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: visionRequest("vision_unstructured"),
      context: "capability:vision_unstructured",
      requestIdentity: "odl-req-034:incomplete",
      fetchImpl: mockFetch,
    });
  } catch (error) {
    caught = error;
  }
  if (!isZenResponsesTransportError(caught)) assert.fail("Expected a Zen Responses transport error.");
  const receipt = caught.receipt as ZenResponsesTransportReceipt;
  assert.equal(caught.code, "provider_response_incomplete");
  assert.equal(receipt.requestedMaxOutputTokens, 1024);
  assert.equal(receipt.incompleteReason, "max_output_tokens");
  assert.equal(receipt.incompleteReasonClass, "max_output_tokens");
  assert.equal(receipt.reportedOutputTokens, 1024);
  assert.equal(receipt.outputTokensReachedRequestedCeiling, true);
  assert.equal(receipt.partialOutputTextPresent, true);
  assert.equal(JSON.stringify(receipt).includes(partial), false);
  const accounting = await readZenResponsesSpendLedger(env, ledger.key);
  assert.equal(accounting.billableRequestCount, 1);
  assert.equal(accounting.inputTokens, 182);
  assert.equal(accounting.outputTokens, 1024);
  assert.equal(accounting.estimatedSpendUsd, 0.0012652);
  assert.equal(accounting.maxBillableRequests, ZEN_RESPONSES_MAX_BILLABLE_REQUESTS);
  assert.equal(accounting.maxEstimatedSpendUsd, ZEN_RESPONSES_MAX_ESTIMATED_SPEND_USD);
});

test("accepted redirect preserves the 1024 ceiling and exact image input", async () => {
  const fixture = syntheticVisionProbeJpegBytes();
  const body = JSON.stringify(visionRequest("vision_unstructured"));
  const seenBodies: string[] = [];
  let call = 0;
  const guarded = createBoundedZenResponsesRedirectFetch(async (_url, init) => {
    seenBodies.push(String(init?.body ?? ""));
    call += 1;
    if (call === 1) return new Response(null, { status: 308, headers: { location: "https://opencode.ai/zen/v1/responses/" } });
    return new Response(JSON.stringify(completedEnvelope("Blue square, red circle, UCA VISION PROBE 2047", 10, 20)), { status: 200, headers: { "content-type": "application/json" } });
  });
  await guarded("https://opencode.ai/zen/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer redacted", "content-type": "application/json" },
    body,
    redirect: "manual",
    signal: new AbortController().signal,
  });
  assert.equal(seenBodies.length, 2);
  assert.equal(seenBodies[1], body);
  const reconstructed = JSON.parse(seenBodies[1]) as Record<string, unknown>;
  assert.equal(reconstructed.max_output_tokens, 1024);
  const receipt = await inspectZenVisionRequest(reconstructed, fixture);
  assert.equal(receipt.imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(receipt.imageRoundTripMatched, true);
});

test("text behavior, discovery route, limits, timeout and response ceiling remain unchanged", async () => {
  const capabilitySource = await readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8");
  const discoverySource = await readFile(new URL("../src/visual-classifier-zen-model-discovery.ts", import.meta.url), "utf8");
  const baseSource = await readFile(new URL("../src/visual-catalogue-zen-responses-base.ts", import.meta.url), "utf8");
  assert.match(capabilitySource, /Return JSON with ok=true and probe=odl-req-025\./);
  assert.match(capabilitySource, /discoverZenResponsesModelWithReceipt/);
  assert.match(discoverySource, /ZEN_RESPONSES_MODELS_ENDPOINT/);
  assert.equal(ZEN_RESPONSES_MAX_BILLABLE_REQUESTS, 75);
  assert.equal(ZEN_RESPONSES_MAX_ESTIMATED_SPEND_USD, 1);
  assert.match(baseSource, /const MAX_RESPONSE_BYTES = 64 \* 1024;/);
  assert.match(baseSource, /const ZEN_RESPONSES_TIMEOUT_MS = 60_000;/);
});

test("explicit invalid mocks fail closed before provider dispatch", async () => {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "mock-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, "odl-req-034-invalid-fetch", 75, 1);
  await assert.rejects(
    () => requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 128 }),
      context: "test",
      fetchImpl: undefined as any,
    }),
    (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_fetch_not_started",
  );
  const accounting = await readZenResponsesSpendLedger(env, ledger.key);
  assert.equal(accounting.billableRequestCount, 0);
});
