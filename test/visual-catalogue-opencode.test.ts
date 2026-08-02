import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  OPENCODE_ZEN_MODEL,
  classifierArtifactIdentity,
  discoverOpenCodeCapabilities,
  mergeTwoPassOpenCode,
  prepareOpenCodeClassifierQueueMessage,
  processOpenCodeClassifierQueueMessage,
  requestOpenCodeZen,
  resolveClassifierSelection,
  safeOpenCodePrompt,
  validateClassificationObject,
  type OpenCodeClassifiedCandidate,
} from "../src/visual-catalogue-opencode";
import type { VisualCandidate } from "../src/visual-catalogue-model";

class MemoryR2 {
  values = new Map<string, { bytes: Uint8Array; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();
  async put(key: string, body: string | ArrayBuffer | Uint8Array | ReadableStream, options: any = {}): Promise<void> {
    let bytes: Uint8Array;
    if (typeof body === "string") bytes = new TextEncoder().encode(body);
    else if (body instanceof Uint8Array) bytes = body;
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.values.set(key, { bytes, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata });
  }
  async get(key: string): Promise<any | null> {
    const value = this.values.get(key);
    if (!value) return null;
    return {
      body: new Blob([value.bytes.slice().buffer]).stream(),
      httpMetadata: value.httpMetadata,
      customMetadata: value.customMetadata,
      text: async () => new TextDecoder().decode(value.bytes),
      arrayBuffer: async () => value.bytes.slice().buffer,
    };
  }
  async head(key: string): Promise<any | null> {
    const value = this.values.get(key);
    return value ? { httpMetadata: value.httpMetadata, customMetadata: value.customMetadata } : null;
  }
}

function mockImages(): any {
  return {
    input: (_body: unknown) => ({
      transform: (_options: unknown) => ({
        output: (_options: unknown) => ({ response: () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } }) }),
      }),
      output: (_options: unknown) => ({ response: () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } }) }),
    }),
    info: async () => ({ width: 640, height: 360 }),
  };
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    OPENCODE_ZEN_API_KEY: "zen-secret",
    OPENAI_API_KEY: undefined,
    VISUAL_CLASSIFIER_PROVIDER: "openai",
    VISUAL_CLASSIFIER_MODEL: "gpt-5.2-2025-12-11",
    OPENCODE_ZEN_MODEL: OPENCODE_ZEN_MODEL,
    ARTIFACTS: new MemoryR2() as unknown as R2Bucket,
    IMAGES: mockImages(),
    ...overrides,
  } as unknown as Env;
}

const candidate: VisualCandidate = {
  stableVisualId: `vis_${"a".repeat(48)}`,
  stableKey: "pdf:page:26",
  pageOrSlide: 26,
  parentPages: [26],
  relationship: "page",
  renderRequired: true,
  embeddedArtifactId: null,
  embeddedArtifactKey: null,
  embeddedSha256: null,
  caption: "Strategic hazard mitigation map",
  heading: "Risk reduction strategy",
  nearbyText: "Published plan map with legend and implementation areas.",
};

const validObject = {
  outcome: "retain_canonical",
  confidence: 0.93,
  visual_type: "map",
  concise_description: "Strategic mitigation map with labelled interventions.",
  retain_rationale: "Reusable spatial planning evidence.",
  reject_rationale: null,
  reusable_visual_structure: true,
  continuation_likely: false,
  continuation_title: null,
};

function chatResponse(content: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }), { status, headers: { "content-type": "application/json", ...headers } });
}

test("OpenCode provider validates exact free-only configuration without an OpenAI key", () => {
  const selection = resolveClassifierSelection({
    classifierProvider: "opencode_zen",
    classifierMode: "opencode_chat_completions",
    model: "mimo-v2.5-free",
    allowPaidFallback: false,
    dataSensitivity: "public",
    freeProviderDataPolicyAcknowledged: true,
  }, env());
  assert.equal(selection.provider, "opencode_zen");
  assert.equal(selection.model, OPENCODE_ZEN_MODEL);
  assert.equal(selection.allowPaidFallback, false);
});

test("OpenCode configuration fails closed for missing secret, non-public data, wrong mode, and paid fallback", () => {
  const base = {
    classifierProvider: "opencode_zen" as const,
    classifierMode: "opencode_chat_completions" as const,
    model: OPENCODE_ZEN_MODEL,
    dataSensitivity: "public" as const,
    freeProviderDataPolicyAcknowledged: true,
  };
  assert.throws(() => resolveClassifierSelection(base, env({ OPENCODE_ZEN_API_KEY: "" })), /OPENCODE_ZEN_API_KEY/);
  assert.throws(() => resolveClassifierSelection({ ...base, dataSensitivity: "confidential" }, env()), /public/);
  assert.throws(() => resolveClassifierSelection({ ...base, classifierMode: "openai_batch" }, env()), /opencode_chat_completions/);
  assert.throws(() => resolveClassifierSelection({ ...base, allowPaidFallback: true }, env()), /Paid fallback/);
  assert.throws(() => resolveClassifierSelection({ ...base, model: "mimo-v2.5" }, env()), /exact model ID/);
});

test("classifier derivative identity is deterministic and transformation-sensitive", async () => {
  const first = await classifierArtifactIdentity({ sourceRenderSha256: "a".repeat(64), maxDimension: 1280, quality: 82 });
  const second = await classifierArtifactIdentity({ sourceRenderSha256: "a".repeat(64), maxDimension: 1280, quality: 82 });
  const changed = await classifierArtifactIdentity({ sourceRenderSha256: "a".repeat(64), maxDimension: 2000, quality: 82 });
  assert.deepEqual(first, second);
  assert.notEqual(first.classifierArtifactId, changed.classifierArtifactId);
  assert.match(first.r2Key, /^visual-classifier-cache\/a{64}\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);
});

test("model discovery verifies exact model and serializes a private multimodal data URL probe", async () => {
  const captured: Array<{ url: string; body?: any; authorization?: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    captured.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: OPENCODE_ZEN_MODEL, input_modalities: ["text", "image"] }] }), { status: 200 });
    return chatResponse(JSON.stringify({ blue_shape: "blue square", red_shape: "red circle", visible_text: "UCA VISION PROBE 2047" }));
  };
  const receipt = await discoverOpenCodeCapabilities(env(), { force: true, fetchImpl });
  assert.equal(receipt.modelPresent, true);
  assert.equal(receipt.visionProbe.passed, true);
  assert.equal(receipt.structuredOutput.responseFormatAccepted, true);
  const request = captured.find((entry) => entry.url.endsWith("/chat/completions"))?.body;
  assert.equal(request.model, OPENCODE_ZEN_MODEL);
  assert.equal(request.messages[1].content[1].type, "image_url");
  assert.match(request.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(captured.every((entry) => entry.authorization === "Bearer zen-secret"), true);
});

test("request engine respects Retry-After and never logs credentials or data URLs", async () => {
  let calls = 0;
  const logs: unknown[][] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args); };
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const result = await requestOpenCodeZen("secret-value", { model: OPENCODE_ZEN_MODEL, image: "data:image/jpeg;base64,AAAA" }, {
      maximumAttempts: 2,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ error: { type: "rate_limit" } }), { status: 429, headers: { "retry-after": "0" } });
        return chatResponse(JSON.stringify(validObject));
      },
    });
    assert.equal(result.retries, 1);
    assert.equal(result.rateLimitEvents, 1);
    assert.deepEqual(logs, []);
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
});

test("strict schema accepts valid output and rejects semantic repair candidates", () => {
  assert.equal(validateClassificationObject(validObject).valid, true);
  const invalid = validateClassificationObject({ ...validObject, confidence: "high", extra: "do not repair" });
  assert.equal(invalid.valid, false);
  if (!invalid.valid) assert.match(invalid.errors.join(" "), /unexpected field|confidence/);
});

test("invalid first response is retried with the same candidate and valid correction is stored durably", async () => {
  const testEnv = env();
  const prepared = await prepareOpenCodeClassifierQueueMessage({
    env: testEnv,
    jobId: "00000000-0000-4000-8000-000000000020",
    candidate,
    originalArtifact: null,
    prompt: "Classify the image.",
    deterministic: { outcome: null, reason: null, confidence: 0 },
    model: OPENCODE_ZEN_MODEL,
    rubricVersion: "rubric-1",
    promptVersion: "prompt-1",
    passNumber: 1,
    confidenceThreshold: 0.78,
    capability: {
      provider: "opencode_zen", model: OPENCODE_ZEN_MODEL, endpointFamily: "openai_compatible_chat_completions",
      discoveryTimestamp: new Date().toISOString(), discoveryCacheHit: false, modelPresent: true, modelMetadata: {},
      visionProbe: { passed: true, status: 200, latencyMilliseconds: 1, exactTextObserved: true, blueSquareObserved: true, redCircleObserved: true, detailFieldAccepted: true, sanitizedUsage: {} },
      structuredOutput: { responseFormatAccepted: false, jsonObjectReliable: false }, costClassification: "provider_reported_unknown_or_free_model_id",
    },
  });
  let calls = 0;
  const result = await processOpenCodeClassifierQueueMessage(testEnv, prepared.message, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? chatResponse("not json") : chatResponse(JSON.stringify(validObject));
    },
  });
  assert.equal(result.parserResult, "valid_after_retry");
  assert.equal(result.proposal.outcome, "retain_canonical");
  assert.equal(calls, 2);
  const replay = await processOpenCodeClassifierQueueMessage(testEnv, prepared.message, { fetchImpl: async () => { throw new Error("must not resend"); } });
  assert.equal(replay.idempotentReplay, true);
});

test("persistent invalid output becomes needs_review and never an automatic reject", async () => {
  const testEnv = env();
  const prepared = await prepareOpenCodeClassifierQueueMessage({
    env: testEnv,
    jobId: "00000000-0000-4000-8000-000000000021",
    candidate,
    originalArtifact: null,
    prompt: "Classify the image.",
    deterministic: { outcome: "reject", reason: "deterministic signal", confidence: 0.9 },
    model: OPENCODE_ZEN_MODEL,
    rubricVersion: "rubric-1",
    promptVersion: "prompt-1",
    passNumber: 1,
    confidenceThreshold: 0.78,
    capability: {
      provider: "opencode_zen", model: OPENCODE_ZEN_MODEL, endpointFamily: "openai_compatible_chat_completions",
      discoveryTimestamp: new Date().toISOString(), discoveryCacheHit: false, modelPresent: true, modelMetadata: {},
      visionProbe: { passed: true, status: 200, latencyMilliseconds: 1, exactTextObserved: true, blueSquareObserved: true, redCircleObserved: true, detailFieldAccepted: true, sanitizedUsage: {} },
      structuredOutput: { responseFormatAccepted: false, jsonObjectReliable: false }, costClassification: "provider_reported_unknown_or_free_model_id",
    },
  });
  const result = await processOpenCodeClassifierQueueMessage(testEnv, prepared.message, { fetchImpl: async () => chatResponse("still invalid") });
  assert.equal(result.parserResult, "persistent_invalid");
  assert.equal(result.proposal.outcome, "needs_review");
  assert.equal(result.reviewRoutingReason, "persistent_schema_failure");
});

test("two-pass disagreement routes to ChatGPT review", () => {
  const base: OpenCodeClassifiedCandidate = {
    proposal: {
      outcome: "retain_canonical", confidence: 0.9, visualType: "map", conciseDescription: "Map", retainRationale: "Keep", rejectRationale: null,
      reusableVisualStructure: true, continuationLikely: false, continuationTitle: null, deterministicOutcome: null, deterministicReason: null,
      modelOutcome: "retain_canonical", modelReason: null, disagreement: false, secondPassApplied: false,
    },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, latencyMilliseconds: 1, retries: 0, rateLimitEvents: 0,
    parserResult: "valid_first_response", schemaValidationResult: "valid", classifierArtifact: null, requestIdentity: "a", idempotentReplay: false,
    endpointFamily: "openai_compatible_chat_completions", passNumber: 1, reviewRoutingReason: null,
  };
  const second: OpenCodeClassifiedCandidate = { ...base, proposal: { ...base.proposal, outcome: "reject", modelOutcome: "reject", secondPassApplied: true }, passNumber: 2, requestIdentity: "b" };
  const merged = mergeTwoPassOpenCode(base, second);
  assert.equal(merged.proposal.outcome, "needs_review");
  assert.equal(merged.reviewRoutingReason, "two_pass_disagreement");
});

test("provider prompt excludes source filenames, paths, and account identifiers", () => {
  const prompt = safeOpenCodePrompt({ sourceType: "spatial_plan", routingMode: "page_compositions", candidate, deterministicReason: null, adjacent: [], secondPass: false });
  assert.doesNotMatch(prompt, /OneDrive|ECB059|Source_Library|source\.pdf/i);
  assert.match(prompt, /pdf:page:26/);
});

test("review surface exposes candidate IDs and private candidate fetch, without catalogue mutation paths", async () => {
  const tools = await readFile(new URL("../src/visual-catalogue-tools.ts", import.meta.url), "utf8");
  const provider = await readFile(new URL("../src/visual-catalogue-opencode.ts", import.meta.url), "utf8");
  assert.match(tools, /fetch_visual_catalogue_candidate_for_analysis/);
  assert.match(tools, /candidateId: record\.stableVisualId/);
  assert.doesNotMatch(provider, /replace_text_file|commit_visual_catalogue_publication|graphFetchBytes|\/me\/drive\/items/);
});
