import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ConnectorError, safeErrorResult } from "../src/errors";
import {
  ZEN_RESPONSES_ENDPOINT,
  ZEN_RESPONSES_MODE,
  ZEN_RESPONSES_MODEL,
  ZEN_RESPONSES_PROVIDER,
  buildZenResponsesRequest,
  initializeZenResponsesSpendLedger,
  isZenResponsesTransportError,
  requestZenResponses,
} from "../src/visual-catalogue-zen-responses";

class MemoryR2 {
  values = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>();
  failWrites = false;
  async get(key: string) {
    const value = this.values.get(key);
    if (!value) return null;
    return { text: async () => new TextDecoder().decode(value.body), arrayBuffer: async () => value.body.slice().buffer, customMetadata: value.customMetadata };
  }
  async put(key: string, body: string | ArrayBuffer | Uint8Array, options?: any) {
    if (this.failWrites) throw new Error("r2 unavailable");
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body);
    this.values.set(key, { body: bytes, customMetadata: options?.customMetadata });
  }
  async head(key: string) { return this.values.has(key) ? {} : null; }
}

function completed(text: string, usage: Record<string, unknown> = { input_tokens: 12, output_tokens: 4, total_tokens: 16 }) {
  return { id: "resp_test", status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }], usage };
}

async function setup(scope: string) {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "zen-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, scope, 75, 1);
  return { r2, env, ledger };
}

function transportObjects(r2: MemoryR2) {
  return [...r2.values.entries()].filter(([key]) => key.includes("/provider-transport/")).map(([key, value]) => ({ key, receipt: JSON.parse(new TextDecoder().decode(value.body)) as any }));
}

test("Zen Responses POST persists a sanitized pre-fetch receipt before exact endpoint dispatch", async () => {
  const { r2, env, ledger } = await setup("transport-success");
  let observed = false;
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    assert.equal(url, ZEN_RESPONSES_ENDPOINT);
    assert.equal(init?.method, "POST");
    assert.equal(JSON.parse(String(init?.body)).model, ZEN_RESPONSES_MODEL);
    const existing = transportObjects(r2);
    assert.equal(existing.length, 1);
    assert.equal(existing[0].receipt.fetchBegan, true);
    assert.equal(existing[0].receipt.httpStatus, null);
    assert.equal(existing[0].receipt.endpointClass, "responses_post");
    observed = true;
    return new Response(JSON.stringify(completed('{"ok":true,"probe":"odl-req-025"}')), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-safe", "cf-ray": "edge-safe" } });
  }) as typeof fetch;
  const request = buildZenResponsesRequest({ text: "PRIVATE_PROMPT", maxOutputTokens: 128, schema: { name: "probe", schema: { type: "object" } } });
  const result = await requestZenResponses({ env, spendLedgerKey: ledger.key, body: request, context: "capability:text_structured_output", requestIdentity: "job:stage", fetchImpl });
  assert.equal(observed, true);
  assert.equal(result.status, 200);
  assert.equal(result.transportReceipt.httpStatus, 200);
  assert.equal(result.transportReceipt.parserResult, "output_text_parsed");
  assert.equal(result.transportReceipt.schemaResult, "json_object_parsed");
  assert.equal(result.transportReceipt.providerRequestId, "req-safe");
  assert.equal(result.transportReceipt.edgeRequestId, "edge-safe");
  assert.equal(result.accounting.billableRequestCount, 1);
  assert.equal(result.accounting.inputTokens, 12);
  const rendered = JSON.stringify(result.transportReceipt);
  for (const forbidden of ["PRIVATE_PROMPT", "zen-secret", "https://", "Bearer ", "output_text\",\"text", "data:image"]) assert.equal(rendered.includes(forbidden), false, forbidden);
});

test("exact provider, mode, model, credential and fetch implementation are validated before fetch", async () => {
  const { r2, env, ledger } = await setup("transport-prefetch");
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
  const body = buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 });
  await assert.rejects(() => requestZenResponses({ env, spendLedgerKey: ledger.key, body, context: "test", provider: "opencode_go", mode: ZEN_RESPONSES_MODE, fetchImpl }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_fetch_not_started" && error.receipt.fetchBegan === false);
  await assert.rejects(() => requestZenResponses({ env: { ...env, OPENCODE_ZEN_API_KEY: "" }, spendLedgerKey: ledger.key, body, context: "test", fetchImpl }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_fetch_not_started" && error.receipt.credentialBindingExists === false);
  await assert.rejects(() => requestZenResponses({ env, spendLedgerKey: ledger.key, body, context: "test", fetchImpl: {} as any }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_fetch_not_started");
  assert.equal(calls, 0);
  assert.ok(transportObjects(r2).length >= 3);
});

test("bounded timeout settles even when the fetch promise never settles", async () => {
  const { env, ledger } = await setup("transport-timeout");
  const never = (() => new Promise<Response>(() => {})) as typeof fetch;
  const started = Date.now();
  await assert.rejects(() => requestZenResponses({ env, spendLedgerKey: ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }), context: "test", timeoutMilliseconds: 20, fetchImpl: never }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_timeout" && error.receipt.fetchBegan === true);
  assert.ok(Date.now() - started < 1000);
});

test("network failure has a precise pre-HTTP classification and does not increment accounting", async () => {
  const { env, ledger } = await setup("transport-network");
  const failing = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  await assert.rejects(() => requestZenResponses({ env, spendLedgerKey: ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }), context: "test", fetchImpl: failing }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_network_error" && error.receipt.httpStatus === null);
  const stored = JSON.parse(await (await env.ARTIFACTS.get(ledger.key)).text());
  assert.equal(stored.billableRequestCount, 0);
});

test("non-2xx HTTP is recorded structurally and remains non-billable", async () => {
  const { env, ledger } = await setup("transport-http");
  const fetchImpl = (async () => new Response(JSON.stringify({ error: { type: "bad_request" } }), { status: 503, headers: { "content-type": "application/json", "content-length": "32", "x-request-id": "req-503" } })) as typeof fetch;
  await assert.rejects(() => requestZenResponses({ env, spendLedgerKey: ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }), context: "test", fetchImpl }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_http_error" && error.receipt.httpStatus === 503 && error.receipt.providerRequestId === "req-503");
  const stored = JSON.parse(await (await env.ARTIFACTS.get(ledger.key)).text());
  assert.equal(stored.billableRequestCount, 0);
});

test("bounded response-body handling distinguishes oversized and failed reads", async () => {
  const oversized = await setup("transport-large");
  const largeFetch = (async () => new Response("x", { status: 200, headers: { "content-type": "application/json", "content-length": "70000" } })) as typeof fetch;
  await assert.rejects(() => requestZenResponses({ env: oversized.env, spendLedgerKey: oversized.ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }), context: "test", fetchImpl: largeFetch }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_body_too_large");

  const failed = await setup("transport-read-fail");
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("read failure")); } });
  const failedFetch = (async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  await assert.rejects(() => requestZenResponses({ env: failed.env, spendLedgerKey: failed.ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }), context: "test", fetchImpl: failedFetch }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_body_read_failed");
});

test("malformed JSON, missing output and invalid structured JSON retain precise receipts", async () => {
  const malformed = await setup("transport-malformed");
  await assert.rejects(() => requestZenResponses({ env: malformed.env, spendLedgerKey: malformed.ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }), context: "test", fetchImpl: (async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_response_malformed" && error.receipt.responseByteCount === 8);

  const missing = await setup("transport-missing");
  await assert.rejects(() => requestZenResponses({ env: missing.env, spendLedgerKey: missing.ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }), context: "test", fetchImpl: (async () => new Response(JSON.stringify({ status: "completed", output: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_output_missing");

  const invalidSchema = await setup("transport-schema");
  const structured = buildZenResponsesRequest({ text: "x", maxOutputTokens: 64, schema: { name: "probe", schema: { type: "object" } } });
  await assert.rejects(() => requestZenResponses({ env: invalidSchema.env, spendLedgerKey: invalidSchema.ledger.key, body: structured, context: "test", fetchImpl: (async () => new Response(JSON.stringify(completed("not-json")), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_schema_invalid" && error.receipt.schemaResult === "invalid");
});

test("receipt persistence failure prevents provider dispatch and is classified exactly", async () => {
  const { r2, env, ledger } = await setup("transport-receipt-fail");
  r2.failWrites = true;
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
  await assert.rejects(() => requestZenResponses({ env, spendLedgerKey: ledger.key, body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }), context: "test", fetchImpl }), (error: unknown) => isZenResponsesTransportError(error) && error.code === "zen_responses_receipt_persist_failed");
  assert.equal(calls, 0);
});

test("sanitized transport errors never expose prompt, generated content, image, URL, token, file ID or secret", async () => {
  const { env, ledger } = await setup("transport-leakage");
  const body = buildZenResponsesRequest({ text: "PROMPT_SECRET", imageDataUrl: "data:image/jpeg;base64,IMAGE_SECRET", maxOutputTokens: 64 });
  let caught: unknown;
  try { await requestZenResponses({ env, spendLedgerKey: ledger.key, body, context: "test", requestIdentity: "file_SECRET", fetchImpl: (async () => { throw new Error("TOKEN_SECRET"); }) as typeof fetch }); } catch (error) { caught = error; }
  const rendered = JSON.stringify(safeErrorResult(caught));
  for (const forbidden of ["PROMPT_SECRET", "IMAGE_SECRET", "TOKEN_SECRET", "file_SECRET", "zen-secret", ZEN_RESPONSES_ENDPOINT, "Authorization", "Bearer"]) assert.equal(rendered.includes(forbidden), false, forbidden);
});

test("capability workflow persists precise transport receipts while discovery and other providers remain isolated", async () => {
  const capability = await readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8");
  assert.match(capability, /isZenResponsesTransportError/);
  assert.match(capability, /transportReceipt/);
  assert.match(capability, /timeout: "2 minutes"/);
  const discovery = await readFile(new URL("../src/visual-classifier-zen-model-discovery.ts", import.meta.url), "utf8");
  assert.match(discovery, /ZEN_RESPONSES_MODELS_ENDPOINT/);
  assert.doesNotMatch(discovery, /responses_post|requestZenResponses/);
  const transport = await readFile(new URL("../src/visual-catalogue-zen-responses.ts", import.meta.url), "utf8");
  assert.doesNotMatch(transport, /OPENCODE_GO|mimo-v2\.5|OPENAI_API_KEY|api\.openai\.com/);
  assert.match(transport, /MAX_RESPONSE_BYTES = 64 \* 1024/);
  assert.match(transport, /ZEN_RESPONSES_TIMEOUT_MS = 60_000/);
});
