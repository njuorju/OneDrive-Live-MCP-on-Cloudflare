import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ConnectorError } from "../src/errors";
import {
  ZEN_RESPONSES_CREDENTIAL_BINDING,
  ZEN_RESPONSES_ENDPOINT,
  ZEN_RESPONSES_ENDPOINT_FAMILY,
  ZEN_RESPONSES_FALLBACK_PRICING,
  ZEN_RESPONSES_MODE,
  ZEN_RESPONSES_MODEL,
  ZEN_RESPONSES_PROVIDER,
  buildZenResponsesInput,
  buildZenResponsesRequest,
  initializeZenResponsesSpendLedger,
  parseZenResponsesOutput,
  parseZenResponsesUsage,
  requestZenResponses,
  resolveZenResponsesPricing,
  validateZenResponsesBudgets,
} from "../src/visual-catalogue-zen-responses";

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
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body);
    this.values.set(key, { body: bytes, customMetadata: options?.customMetadata });
  }
  async head(key: string) { return this.values.has(key) ? {} : null; }
}

function completed(text: string, usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 20, total_tokens: 120 }) {
  return {
    id: "resp_test",
    status: "completed",
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }],
    usage,
  };
}

test("Zen Responses route has exact immutable identity and no direct OpenAI endpoint", () => {
  assert.equal(ZEN_RESPONSES_PROVIDER, "opencode_zen_responses");
  assert.equal(ZEN_RESPONSES_MODE, "opencode_responses");
  assert.equal(ZEN_RESPONSES_MODEL, "gpt-5.6-luna");
  assert.equal(ZEN_RESPONSES_ENDPOINT, "https://opencode.ai/zen/v1/responses");
  assert.equal(ZEN_RESPONSES_ENDPOINT_FAMILY, "opencode_zen_responses");
  assert.equal(ZEN_RESPONSES_CREDENTIAL_BINDING, "OPENCODE_ZEN_API_KEY");
  assert.equal(ZEN_RESPONSES_ENDPOINT.includes("api.openai.com"), false);
});

test("Responses multimodal request uses input_text, input_image and store false", () => {
  const input = buildZenResponsesInput("bounded prompt", "data:image/jpeg;base64,AA==");
  assert.deepEqual(input, [{ role: "user", content: [{ type: "input_text", text: "bounded prompt" }, { type: "input_image", image_url: "data:image/jpeg;base64,AA==" }] }]);
  const request = buildZenResponsesRequest({ text: "bounded prompt", imageDataUrl: "data:image/jpeg;base64,AA==", maxOutputTokens: 512 });
  assert.equal(request.model, ZEN_RESPONSES_MODEL);
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 512);
  assert.equal("tools" in request, false);
  assert.equal("background" in request, false);
});

test("structured stages alone request an exact JSON schema", () => {
  const request = buildZenResponsesRequest({ text: "x", maxOutputTokens: 128, schema: { name: "probe", schema: { type: "object" } } });
  assert.deepEqual(request.text, { format: { type: "json_schema", name: "probe", strict: true, schema: { type: "object" } } });
  const unstructured = buildZenResponsesRequest({ text: "x", maxOutputTokens: 128 });
  assert.equal("text" in unstructured, false);
});

test("documented completed assistant output_text is accepted with structural receipt", () => {
  const parsed = parseZenResponsesOutput(completed('{"ok":true}'), 200, "request-fingerprint");
  assert.equal(parsed.text, '{"ok":true}');
  assert.equal(parsed.receipt.responseClass, "completed_output");
  assert.deepEqual(parsed.receipt.outputItemTypes, ["message"]);
  assert.deepEqual(parsed.receipt.outputContentPartTypes, ["output_text"]);
  assert.equal(parsed.receipt.usagePresent, true);
});

test("reasoning-only, refusal and incomplete Responses outputs are rejected", () => {
  assert.throws(() => parseZenResponsesOutput({ status: "completed", output: [{ type: "reasoning", summary: [] }] }), (error: unknown) => error instanceof ConnectorError && error.code === "provider_reasoning_only");
  assert.throws(() => parseZenResponsesOutput({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] }), (error: unknown) => error instanceof ConnectorError && error.code === "provider_refusal");
  assert.throws(() => parseZenResponsesOutput({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }), (error: unknown) => error instanceof ConnectorError && error.code === "provider_response_incomplete");
  assert.throws(() => parseZenResponsesOutput({ status: "completed", output: [{ type: "message", role: "tool", content: [{ type: "output_text", text: "x" }] }] }), (error: unknown) => error instanceof ConnectorError && error.code === "classifier_output_missing");
});

test("usage parsing never converts missing usage to zero", () => {
  assert.deepEqual(parseZenResponsesUsage({}), { inputTokens: null, outputTokens: null, cachedReadTokens: null, cachedWriteTokens: null, totalTokens: null, reported: false });
  assert.deepEqual(parseZenResponsesUsage({ usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3, cached_write_tokens: 1 } } }), { inputTokens: 10, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 1, totalTokens: 12, reported: true });
});

test("fallback pricing and hard ceilings match the bounded tranche", () => {
  assert.deepEqual(resolveZenResponsesPricing(null), ZEN_RESPONSES_FALLBACK_PRICING);
  assert.deepEqual(ZEN_RESPONSES_FALLBACK_PRICING, { inputPerMillionUsd: 0.20, outputPerMillionUsd: 1.20, cachedReadPerMillionUsd: 0.02, cachedWritePerMillionUsd: 0.25, source: "fallback_price_table", version: "gpt-5.6-luna-fallback-2026-08-04" });
  assert.deepEqual(validateZenResponsesBudgets(75, 1), { maxBillableRequests: 75, maxEstimatedSpendUsd: 1 });
  assert.throws(() => validateZenResponsesBudgets(76, 1), (error: unknown) => error instanceof ConnectorError && error.code === "provider_request_budget_invalid");
  assert.throws(() => validateZenResponsesBudgets(75, 1.01), (error: unknown) => error instanceof ConnectorError && error.code === "provider_spend_budget_invalid");
});

test("request uses only Zen endpoint and Zen credential, preserves store false, and accounts usage", async () => {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "zen-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, "scope", 75, 1);
  let seenUrl = "";
  let seenAuth = "";
  let seenBody: any = null;
  const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    seenAuth = new Headers(init?.headers).get("authorization") ?? "";
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(completed('{"ok":true}')), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const result = await requestZenResponses({ env, spendLedgerKey: ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 128 }), context: "test", requestIdentity: "req", fetchImpl: mockFetch });
  assert.equal(seenUrl, ZEN_RESPONSES_ENDPOINT);
  assert.equal(seenAuth, "Bearer zen-secret");
  assert.equal(seenBody.store, false);
  assert.equal(seenBody.model, ZEN_RESPONSES_MODEL);
  assert.equal(result.accounting.billableRequestCount, 1);
  assert.equal(result.accounting.inputTokens, 100);
  assert.ok((result.accounting.estimatedSpendUsd ?? 0) > 0);
});

test("successful response without usage is usage_not_reported and request ceiling remains conservative", async () => {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "zen-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, "scope-no-usage", 1, 1);
  const mockFetch: typeof fetch = (async () => new Response(JSON.stringify(completed('{"ok":true}', {})), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const result = await requestZenResponses({ env, spendLedgerKey: ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 128 }), context: "test", fetchImpl: mockFetch });
  assert.equal(result.accounting.estimatedSpendUsd, null);
  assert.equal(result.accounting.usageNotReportedResponses, 1);
  assert.equal(result.accounting.remainingRequestAllowance, 0);
  await assert.rejects(() => requestZenResponses({ env, spendLedgerKey: ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 128 }), context: "test", fetchImpl: mockFetch }), (error: unknown) => error instanceof ConnectorError && error.code === "provider_request_budget_exhausted");
});

test("implementation has four mandatory stages and no OneDrive/Graph or fallback import", async () => {
  const source = await readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8");
  for (const stage of ["model_discovery", "text_structured_output", "vision_unstructured", "vision_structured_output"]) assert.match(source, new RegExp(stage));
  assert.doesNotMatch(source, /graphFetch|verifyItemInsideRoot|read_onedrive|OPENAI_API_KEY|api\.openai\.com/);
  assert.match(source, /providerFallbackUsed: false/);
  assert.match(source, /oneDriveMutationPerformed: false/);
});
