import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { ConnectorError } from "../src/errors";
import {
  projectZenResponsesCapabilityAttempt,
  type ZenResponsesCapabilityAttempt,
} from "../src/visual-classifier-capability-zen-responses";
import { zenResponsesCapabilityOutputCeiling } from "../src/visual-classifier-capability-output-ceilings";
import {
  buildZenResponsesRequest,
  initializeZenResponsesSpendLedger,
  requestZenResponses,
  type ZenResponsesSpendLedger,
  type ZenResponsesStructuralReceipt,
  type ZenResponsesTransportReceipt,
  type ZenResponsesUsage,
} from "../src/visual-catalogue-zen-responses";
import {
  OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH,
  OPENCODE_VISION_PROBE_JPEG_SHA256,
  syntheticVisionProbeJpegBytes,
} from "../src/visual-catalogue-probe-fixture";
import type { ZenVisionRequestReceipt, ZenVisionSemanticReceipt } from "../src/visual-zen-responses-vision";

const RECOGNIZED_OUTPUT = "Blue square on the left; red circle on the right; UCA VISION PROBE 2047";
const MISMATCH_OUTPUT = "Blue triangle on the right; red square on the left; UCA VISION PROBE 2048";
const FORBIDDEN_PROMPT = "DO_NOT_PERSIST_ODL036_PROMPT";
const FORBIDDEN_SECRET = "mock-secret-never-persist";

class MemoryR2 {
  values = new Map<string, Uint8Array>();
  async get(key: string) {
    const value = this.values.get(key);
    return value ? { text: async () => new TextDecoder().decode(value), arrayBuffer: async () => value.slice().buffer } : null;
  }
  async put(key: string, body: string | ArrayBuffer | Uint8Array) {
    this.values.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body));
  }
  async head(key: string) { return this.values.has(key) ? {} : null; }
}

function completedEnvelope(text: string, outputTokens: number): Record<string, unknown> {
  return {
    id: "resp_odl036",
    status: "completed",
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 182, output_tokens: outputTokens, total_tokens: 182 + outputTokens, input_tokens_details: { cached_tokens: 0 } },
  };
}

function visionRequest() {
  const fixture = syntheticVisionProbeJpegBytes();
  return buildZenResponsesRequest({
    text: FORBIDDEN_PROMPT,
    imageDataUrl: `data:image/jpeg;base64,${Buffer.from(fixture).toString("base64")}`,
    maxOutputTokens: zenResponsesCapabilityOutputCeiling("vision_unstructured"),
  });
}

async function invokeVision(output: string, outputTokens: number) {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: FORBIDDEN_SECRET } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, `odl-req-036-${crypto.randomUUID()}`, 75, 1);
  const body = JSON.stringify(completedEnvelope(output, outputTokens));
  const fetchImpl: typeof fetch = (async () => new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "content-length": String(new TextEncoder().encode(body).byteLength) },
  })) as typeof fetch;
  return {
    r2,
    invoke: () => requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: visionRequest(),
      context: "capability:vision_unstructured",
      requestIdentity: "odl-req-036:vision_unstructured",
      fetchImpl,
    }),
  };
}

function mismatchDetails(error: unknown) {
  assert.ok(error instanceof ConnectorError);
  assert.equal(error.code, "provider_visual_fixture_mismatch");
  const details = error.details as Record<string, unknown>;
  assert.ok(details);
  return {
    transportReceipt: details.transportReceipt as ZenResponsesTransportReceipt,
    visionSemanticReceipt: details.visionSemanticReceipt as ZenVisionSemanticReceipt,
    structuralReceipt: details.structuralReceipt as ZenResponsesStructuralReceipt,
    usage: details.usage as ZenResponsesUsage,
    accounting: details.accounting as ZenResponsesSpendLedger,
    httpStatus: Number(details.httpStatus),
  };
}

function assertNoSensitiveKeys(value: unknown): void {
  const forbidden = new Set(["providerText", "providerOutputText", "outputExcerpt", "excerpt", "prompt", "imageBytes", "imageDataUrl", "authorizationValue"]);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveKeys(item);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert.equal(forbidden.has(key), false, `forbidden durable key: ${key}`);
    assertNoSensitiveKeys(child);
  }
}

test("completed recognized vision response remains a pass", async () => {
  const { invoke } = await invokeVision(RECOGNIZED_OUTPUT, 48);
  const result = await invoke();
  assert.equal(result.status, 200);
  assert.equal(result.transportReceipt.fetchBegan, true);
  assert.equal(result.transportReceipt.httpStatus, 200);
  assert.equal(result.transportReceipt.redirectDisposition, "direct_canonical");
  assert.equal(result.transportReceipt.redirectHopCount, 0);
  assert.equal(result.transportReceipt.finalEndpointClass, "documented_canonical");
  assert.equal(result.transportReceipt.completionStatus, "completed");
  assert.equal(result.transportReceipt.requestedMaxOutputTokens, 1024);
  assert.equal(result.transportReceipt.reportedOutputTokens, 48);
  assert.equal(result.transportReceipt.outputTokensReachedRequestedCeiling, false);
  assert.equal(result.transportReceipt.partialOutputTextPresent, true);
  assert.equal(result.usage.cachedWriteTokens, 0);
  assert.equal(result.visionSemanticReceipt?.fixtureRecognitionStatus, "recognized");
  assert.equal(result.visionSemanticReceipt?.mandatoryFeatureMatchBitmap, "111");
  assert.equal(result.visionSemanticReceipt?.contradictoryFeatureMatchBitmap, "000000");
});

test("completed mismatch attaches exact bounded transport, semantic, and image receipts", async () => {
  const { invoke } = await invokeVision(MISMATCH_OUTPUT, 419);
  let caught: unknown;
  try { await invoke(); } catch (error) { caught = error; }
  const details = mismatchDetails(caught);
  const transport = details.transportReceipt;
  const semantic = details.visionSemanticReceipt;
  const image = transport.visionRequestReceipt as ZenVisionRequestReceipt;

  assert.equal(details.httpStatus, 200);
  assert.equal(transport.endpointClass, "responses_post");
  assert.equal(transport.finalEndpointClass, "documented_canonical");
  assert.equal(transport.fetchBegan, true);
  assert.equal(transport.httpStatus, 200);
  assert.match(String(transport.responseContentType), /^application\/json/);
  assert.ok(Number(transport.responseByteCount) > 0);
  assert.equal(transport.redirectDisposition, "direct_canonical");
  assert.equal(transport.redirectHopCount, 0);
  assert.equal(transport.completionStatus, "completed");
  assert.equal(transport.requestedMaxOutputTokens, 1024);
  assert.equal(transport.reportedOutputTokens, 419);
  assert.equal(transport.outputTokensReachedRequestedCeiling, false);
  assert.equal(transport.partialOutputTextPresent, true);
  assert.equal(details.usage.cachedWriteTokens, 0);
  assert.equal(transport.providerOutputClass, "fixture_recognition_failed");
  assert.equal(transport.fixtureRecognitionBoolean, false);

  assert.equal(semantic.fixtureRecognitionStatus, "not_recognized");
  assert.equal(semantic.mandatoryFeatureMatchBitmap, "000");
  assert.equal(semantic.mandatoryFeatureMatchCount, 0);
  assert.equal(semantic.contradictoryFeatureMatchBitmap, "111001");
  assert.equal(semantic.contradictoryFeatureMatchCount, 4);
  assert.equal(semantic.refusalIndicator, false);
  assert.equal(semantic.genericIndicator, false);
  assert.equal(semantic.imageIgnoredIndicator, false);
  assert.equal(semantic.unsupportedIndicator, false);
  assert.match(semantic.normalizedOutputSha256, /^[a-f0-9]{64}$/);
  assert.equal(semantic.partialOutputPresent, true);

  assert.deepEqual(image.contentItemTypes, ["input_text", "input_image"]);
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.decodedImageByteCount, 14_298);
  assert.equal(image.imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(image.detail, "auto");
  assert.equal(image.imageRoundTripMatched, true);
  assert.match(image.requestShapeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(details.structuralReceipt.httpStatus, 200);
  assert.equal(details.usage.outputTokens, 419);
  assert.equal(details.accounting.billableRequestCount, 1);
});

test("failed attempt, terminal JSON, R2 JSON, and public projection preserve receipts without sensitive values", async () => {
  const { r2, invoke } = await invokeVision(MISMATCH_OUTPUT, 419);
  let caught: unknown;
  try { await invoke(); } catch (error) { caught = error; }
  const details = mismatchDetails(caught);
  const image = details.transportReceipt.visionRequestReceipt as ZenVisionRequestReceipt;
  const attempt: ZenResponsesCapabilityAttempt = {
    version: 1,
    jobId: "odl-req-036-test-job",
    attemptNumber: 3,
    stage: "vision_unstructured",
    provider: "opencode_zen_responses",
    mode: "opencode_responses",
    exactModel: "gpt-5.6-luna",
    endpointFamily: "opencode_zen_responses",
    probeVersion: "odl-req-025-zen-responses-v1",
    credentialBindingName: "OPENCODE_ZEN_API_KEY",
    startedAt: "2026-08-07T00:00:00.000Z",
    completedAt: "2026-08-07T00:00:01.000Z",
    latencyMilliseconds: 1000,
    httpStatus: 200,
    status: "failed",
    parserResult: details.transportReceipt.parserResult,
    schemaValidationResult: "visual_fixture_mismatch",
    structuralReceipt: details.structuralReceipt,
    transportReceipt: details.transportReceipt,
    discoveryReceipt: null,
    usage: details.usage,
    accounting: details.accounting,
    errorCode: "provider_visual_fixture_mismatch",
    requestImageSha256: OPENCODE_VISION_PROBE_JPEG_SHA256,
    requestImageByteSize: OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH,
    requestImageMimeType: "image/jpeg",
    visionRequestReceipt: image,
    providerOutputClass: details.transportReceipt.providerOutputClass ?? null,
    fixtureRecognitionBoolean: details.transportReceipt.fixtureRecognitionBoolean ?? null,
    visionSemanticReceipt: details.visionSemanticReceipt,
    oneDriveAccessed: false,
    oneDriveMutationPerformed: false,
  };
  const terminal = { status: "failed", blockerClassification: "provider_visual_fixture_mismatch", attempts: [attempt] };
  await r2.put("terminal.json", JSON.stringify(terminal));
  const durable = JSON.parse(await (await r2.get("terminal.json"))!.text()) as typeof terminal;
  const projected = projectZenResponsesCapabilityAttempt(durable.attempts[0]);

  assert.deepEqual(projected.transportReceipt, details.transportReceipt);
  assert.deepEqual(projected.visionSemanticReceipt, details.visionSemanticReceipt);
  assert.deepEqual(projected.visionRequestReceipt, image);
  assert.equal(projected.errorCode, "provider_visual_fixture_mismatch");
  assert.equal(projected.requestImageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(projected.requestImageByteSize, 14_298);
  assert.equal(projected.requestImageMimeType, "image/jpeg");

  const structures = { errorDetails: (caught as ConnectorError).details, attempt, terminal, durable, projected };
  assertNoSensitiveKeys(structures);
  const serialized = JSON.stringify(structures);
  assert.doesNotMatch(serialized, /blue triangle|red square|uca vision probe|2048/i);
  assert.doesNotMatch(serialized, new RegExp(FORBIDDEN_PROMPT));
  assert.doesNotMatch(serialized, new RegExp(FORBIDDEN_SECRET));
  assert.doesNotMatch(serialized, /data:image\/jpeg;base64/i);
  assert.doesNotMatch(serialized, /\/9j\//);
});

test("fixture, output ceilings, retry policy, and accounting limits remain unchanged", async () => {
  assert.equal(OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH, 14_298);
  assert.equal(OPENCODE_VISION_PROBE_JPEG_SHA256, "da50bd35fd2266fdef0400dbc52968b44e5e743f5654f6b99f0cecbb68cc228a");
  assert.equal(zenResponsesCapabilityOutputCeiling("text_structured_output"), 128);
  assert.equal(zenResponsesCapabilityOutputCeiling("vision_unstructured"), 1024);
  assert.equal(zenResponsesCapabilityOutputCeiling("vision_structured_output"), 1024);
  const source = await readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8");
  assert.match(source, /retries: \{ limit: 0/);
  assert.match(source, /completedVisionFailureDetails\(error\)/);
  assert.match(source, /attemptHistorySummary: manifest\.attempts\.map\(projectZenResponsesCapabilityAttempt\)/);
  assert.doesNotMatch(source, /maxOutputTokens:\s*(?:128|1024)/);
});
