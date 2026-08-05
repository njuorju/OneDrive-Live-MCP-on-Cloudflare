import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  discoverZenResponsesModelWithReceipt,
  isZenModelsDiscoveryError,
} from "../src/visual-classifier-zen-model-discovery";
import {
  ZEN_RESPONSES_MODE,
  ZEN_RESPONSES_MODEL,
  ZEN_RESPONSES_MODELS_ENDPOINT,
  ZEN_RESPONSES_PROVIDER,
} from "../src/visual-catalogue-zen-responses";

const env = { OPENCODE_ZEN_API_KEY: "test-secret" } as any;

function mockJson(body: unknown, status = 200, observe?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    observe?.(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function rejectedCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(isZenModelsDiscoveryError(error), true);
    assert.equal((error as any).code, code);
    return true;
  });
}

test("exact Zen Responses discovery dispatches one bounded models GET and persists structural receipt", async () => {
  let calls = 0;
  let method = "";
  let url = "";
  const result = await discoverZenResponsesModelWithReceipt(env, {
    provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE, model: ZEN_RESPONSES_MODEL,
  }, mockJson({ object: "list", data: [
    { id: "other", object: "model" },
    { id: ZEN_RESPONSES_MODEL, object: "model", owned_by: "opencode", extra: { tolerated: true } },
  ] }, 200, (seenUrl, init) => {
    calls += 1;
    url = seenUrl;
    method = String(init?.method);
  }));
  assert.equal(calls, 1);
  assert.equal(url, ZEN_RESPONSES_MODELS_ENDPOINT);
  assert.equal(method, "GET");
  assert.equal(result.metadata.id, ZEN_RESPONSES_MODEL);
  assert.equal(result.receipt.fetchBegan, true);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.responseEnvelopeShape, "openai_list");
  assert.equal(result.receipt.modelRecordCount, 2);
  assert.equal(result.receipt.exactModelIdPresent, true);
  assert.equal(result.receipt.billableRequestIncrement, 0);
  assert.equal(result.receipt.inputTokenIncrement, 0);
  assert.equal(result.receipt.outputTokenIncrement, 0);
  assert.equal(result.receipt.spendIncrementUsd, 0);
  assert.equal(JSON.stringify(result.receipt).includes("test-secret"), false);
});

test("empty list and aliases never satisfy exact-ID discovery", async () => {
  await rejectedCode(discoverZenResponsesModelWithReceipt(env, {}, mockJson({ object: "list", data: [] })), "zen_model_exact_id_absent");
  await rejectedCode(discoverZenResponsesModelWithReceipt(env, {}, mockJson({ object: "list", data: [
    { id: "GPT-5.6-LUNA" }, { id: "gpt-5.6-luna-preview" }, { name: "gpt-5.6-luna" },
  ] })), "zen_model_exact_id_absent");
});

test("malformed root, missing data, and non-array data have precise classes", async () => {
  await rejectedCode(discoverZenResponsesModelWithReceipt(env, {}, mockJson([{}])), "zen_models_response_malformed");
  await rejectedCode(discoverZenResponsesModelWithReceipt(env, {}, mockJson({ object: "list" })), "zen_models_data_missing");
  await rejectedCode(discoverZenResponsesModelWithReceipt(env, {}, mockJson({ object: "list", data: {} })), "zen_models_response_malformed");
  await rejectedCode(discoverZenResponsesModelWithReceipt(env, {}, mockJson({ object: "collection", data: [] })), "zen_models_response_malformed");
});

test("non-2xx and network failures preserve whether fetch began", async () => {
  await assert.rejects(discoverZenResponsesModelWithReceipt(env, {}, mockJson({ error: "no" }, 503)), (error: unknown) => {
    assert.equal(isZenModelsDiscoveryError(error), true);
    assert.equal((error as any).code, "zen_models_http_error");
    assert.equal((error as any).receipt.fetchBegan, true);
    assert.equal((error as any).receipt.httpStatus, 503);
    return true;
  });
  const failing = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  await assert.rejects(discoverZenResponsesModelWithReceipt(env, {}, failing), (error: unknown) => {
    assert.equal(isZenModelsDiscoveryError(error), true);
    assert.equal((error as any).code, "zen_models_fetch_failed");
    assert.equal((error as any).receipt.fetchBegan, true);
    assert.equal((error as any).receipt.httpStatus, null);
    return true;
  });
});

test("missing binding, local dispatch, and missing fetch implementation fail before fetch without leakage", async () => {
  let calls = 0;
  const observing = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
  await assert.rejects(discoverZenResponsesModelWithReceipt({ OPENCODE_ZEN_API_KEY: "" } as any, {}, observing), (error: unknown) => {
    assert.equal((error as any).code, "zen_credential_binding_missing");
    assert.equal((error as any).receipt.fetchBegan, false);
    assert.equal((error as any).receipt.credentialBindingExists, false);
    assert.equal("body" in (error as any).receipt, false);
    return true;
  });
  await assert.rejects(discoverZenResponsesModelWithReceipt(env, { provider: "opencode_go", mode: ZEN_RESPONSES_MODE, model: ZEN_RESPONSES_MODEL }, observing), (error: unknown) => {
    assert.equal((error as any).code, "zen_discovery_dispatch_unsupported");
    assert.equal((error as any).receipt.fetchBegan, false);
    return true;
  });
  await assert.rejects(discoverZenResponsesModelWithReceipt(env, {}, null as any), (error: unknown) => {
    assert.equal((error as any).code, "zen_models_fetch_not_started");
    assert.equal((error as any).receipt.fetchBegan, false);
    assert.equal((error as any).receipt.credentialBindingExists, true);
    return true;
  });
  assert.equal(calls, 0);
});

test("discovery repair is isolated from OpenCode Go, direct OpenAI, OneDrive, source, cache, and catalogue mutation routes", async () => {
  const source = await readFile(new URL("../src/visual-classifier-zen-model-discovery.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /OPENCODE_GO|OPENAI_API_KEY|api\.openai\.com|graphFetch|read_onedrive|render_document|publish_cached|replace_catalogue|prepare_catalogue|commit_visual/);
  assert.match(source, /billableRequestIncrement: 0/);
  assert.match(source, /spendIncrementUsd: 0/);
});
