import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import {
  ZEN_RESPONSES_MAX_BILLABLE_REQUESTS,
  ZEN_RESPONSES_MAX_ESTIMATED_SPEND_USD,
  buildZenResponsesRequest,
  classifyZenResponsesIncompleteReason,
  initializeZenResponsesSpendLedger,
  inspectZenResponsesCompletionEnvelope,
  isZenResponsesTransportError,
  readZenResponsesSpendLedger,
  requestZenResponses,
  type ZenResponsesTransportReceipt,
} from "../src/visual-catalogue-zen-responses";
import { syntheticVisionProbeJpegBytes } from "../src/visual-catalogue-probe-fixture";

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

function incompleteEnvelope(reason: string, outputTokens: number, partialText = ""): Record<string, unknown> {
  return {
    id: "resp_incomplete",
    status: "incomplete",
    incomplete_details: { reason },
    output: [{
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: partialText ? [{ type: "output_text", text: partialText }] : [],
    }],
    usage: {
      input_tokens: 182,
      output_tokens: outputTokens,
      total_tokens: 182 + outputTokens,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
}

test("ODL-REQ-033 classifies sanitized incomplete reasons without response content", () => {
  assert.equal(classifyZenResponsesIncompleteReason("max_output_tokens"), "max_output_tokens");
  assert.equal(classifyZenResponsesIncompleteReason("content_filter"), "content_filter");
  assert.equal(classifyZenResponsesIncompleteReason("tool_failure"), "tool_failure");
  assert.equal(classifyZenResponsesIncompleteReason("provider_internal_limit"), "other");
  assert.equal(classifyZenResponsesIncompleteReason(null), null);
});

test("ODL-REQ-033 detects exact configured ceiling and partial output structurally", () => {
  const evidence = inspectZenResponsesCompletionEnvelope(
    incompleteEnvelope("max_output_tokens", 256, "bounded partial output"),
    256,
  );
  assert.deepEqual(evidence, {
    requestedMaxOutputTokens: 256,
    completionStatus: "incomplete",
    incompleteReason: "max_output_tokens",
    incompleteReasonClass: "max_output_tokens",
    reportedOutputTokens: 256,
    outputTokensReachedRequestedCeiling: true,
    partialOutputTextPresent: true,
  });
  assert.equal("text" in evidence, false);
});

test("ODL-REQ-033 keeps non-token incomplete reasons distinct", () => {
  const contentFilter = inspectZenResponsesCompletionEnvelope(incompleteEnvelope("content_filter", 12), 256);
  const toolFailure = inspectZenResponsesCompletionEnvelope(incompleteEnvelope("tool_failure", 20), 256);
  const other = inspectZenResponsesCompletionEnvelope(incompleteEnvelope("provider_internal_limit", 30), 256);
  assert.equal(contentFilter.incompleteReasonClass, "content_filter");
  assert.equal(toolFailure.incompleteReasonClass, "tool_failure");
  assert.equal(other.incompleteReasonClass, "other");
  assert.equal(contentFilter.outputTokensReachedRequestedCeiling, false);
});

test("completed responses never masquerade as incomplete partial output", () => {
  const evidence = inspectZenResponsesCompletionEnvelope({
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "complete" }],
    }],
    usage: { output_tokens: 24 },
  }, 256);
  assert.equal(evidence.completionStatus, "completed");
  assert.equal(evidence.incompleteReason, null);
  assert.equal(evidence.incompleteReasonClass, null);
  assert.equal(evidence.partialOutputTextPresent, null);
  assert.equal(evidence.outputTokensReachedRequestedCeiling, null);
});

test("incomplete partial text fails closed while sanitized receipt and accounting persist", async () => {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "mock-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, "odl-req-033", 75, 1);
  const partial = "DO_NOT_PERSIST_THIS_PARTIAL_TEXT";
  const imageDataUrl = `data:image/jpeg;base64,${Buffer.from(syntheticVisionProbeJpegBytes()).toString("base64")}`;
  const mockFetch: typeof fetch = (async () => new Response(
    JSON.stringify(incompleteEnvelope("max_output_tokens", 256, partial)),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

  let caught: unknown = null;
  try {
    await requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: buildZenResponsesRequest({ text: "bounded test", maxOutputTokens: 256, imageDataUrl }),
      context: "capability:vision_unstructured",
      requestIdentity: "odl-req-033:vision_unstructured",
      fetchImpl: mockFetch,
    });
  } catch (error) {
    caught = error;
  }

  if (!isZenResponsesTransportError(caught)) assert.fail("Expected a Zen Responses transport error.");
  const transportError = caught;
  assert.equal(transportError.code, "provider_response_incomplete");
  const receipt = transportError.receipt as ZenResponsesTransportReceipt;
  assert.equal(receipt.parserResult, "incomplete");
  assert.equal(receipt.requestedMaxOutputTokens, 256);
  assert.equal(receipt.completionStatus, "incomplete");
  assert.equal(receipt.incompleteReason, "max_output_tokens");
  assert.equal(receipt.incompleteReasonClass, "max_output_tokens");
  assert.equal(receipt.reportedOutputTokens, 256);
  assert.equal(receipt.outputTokensReachedRequestedCeiling, true);
  assert.equal(receipt.partialOutputTextPresent, true);
  assert.equal(JSON.stringify(receipt).includes(partial), false);
  assert.equal(JSON.stringify(receipt).includes("bounded test"), false);

  const accounting = await readZenResponsesSpendLedger(env, ledger.key);
  assert.equal(accounting.billableRequestCount, 1);
  assert.equal(accounting.inputTokens, 182);
  assert.equal(accounting.outputTokens, 256);
  assert.equal(accounting.responses[0].estimatedIncrementalCostUsd, 0.0003436);

  const persistedReceipts = [...r2.values.entries()]
    .filter(([key]) => key.includes("/provider-transport/"))
    .map(([, value]) => JSON.parse(new TextDecoder().decode(value.body)) as ZenResponsesTransportReceipt);
  assert.ok(persistedReceipts.some((persisted) =>
    persisted.requestedMaxOutputTokens === 256
    && persisted.incompleteReason === "max_output_tokens"
    && persisted.outputTokensReachedRequestedCeiling === true
  ));
  assert.equal(JSON.stringify(persistedReceipts).includes(partial), false);
});

test("explicit invalid mock transport remains fail closed before dispatch", async () => {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "mock-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, "odl-req-033-invalid-fetch", 75, 1);
  await assert.rejects(
    () => requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 128 }),
      context: "test",
      fetchImpl: undefined as any,
    }),
    (error: unknown) => {
      if (!isZenResponsesTransportError(error)) return false;
      return error.code === "zen_responses_fetch_not_started";
    },
  );
  const accounting = await readZenResponsesSpendLedger(env, ledger.key);
  assert.equal(accounting.billableRequestCount, 0);
});

test("global safety ceilings remain unchanged while stage policy stays explicit", async () => {
  const capabilitySource = await readFile(
    new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url),
    "utf8",
  );
  const policySource = await readFile(
    new URL("../src/visual-classifier-capability-output-ceilings.ts", import.meta.url),
    "utf8",
  );
  const baseSource = await readFile(
    new URL("../src/visual-catalogue-zen-responses-base.ts", import.meta.url),
    "utf8",
  );
  const wrapperSource = await readFile(
    new URL("../src/visual-catalogue-zen-responses.ts", import.meta.url),
    "utf8",
  );

  assert.match(policySource, /text_structured_output:\s*128/);
  assert.match(policySource, /vision_unstructured:\s*1024/);
  assert.match(policySource, /vision_structured_output:\s*1024/);
  assert.match(capabilitySource, /zenResponsesCapabilityOutputCeiling\(stage\)/);
  assert.doesNotMatch(capabilitySource, /maxOutputTokens:\s*(?:128|256|320|1024)/);
  assert.equal(ZEN_RESPONSES_MAX_BILLABLE_REQUESTS, 75);
  assert.equal(ZEN_RESPONSES_MAX_ESTIMATED_SPEND_USD, 1);
  assert.match(baseSource, /const MAX_RESPONSE_BYTES = 64 \* 1024;/);
  assert.match(baseSource, /const ZEN_RESPONSES_TIMEOUT_MS = 60_000;/);
  assert.match(wrapperSource, /const ZEN_RESPONSES_REDIRECT_MAX_HOPS = 1;/);
  assert.match(wrapperSource, /redirect:\s*"manual"/);
  assert.doesNotMatch(wrapperSource, /api\.openai\.com/);
});
