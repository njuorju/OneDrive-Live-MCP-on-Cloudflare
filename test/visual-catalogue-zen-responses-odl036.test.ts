import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
import type {
  ZenVisionRequestReceipt,
  ZenVisionSemanticReceipt,
} from "../src/visual-zen-responses-vision";

const RECOGNIZED_OUTPUT = "Blue square on the left; red circle on the right; UCA VISION PROBE 2047";
const MISMATCH_OUTPUT = "Blue triangle on the right; red square on the left; UCA VISION PROBE 2048";
const FORBIDDEN_PROMPT = "DO_NOT_PERSIST_ODL036_PROMPT";

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

function completedEnvelope(text: string, outputTokens: number): Record<string, unknown> {
  return {
    id: "resp_odl036",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    }],
    usage: {
      input_tokens: 182,
      output_tokens: outputTokens,
      total_tokens: 182 + outputTokens,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
}

function visionRequest(maxOutputTokens = 1024) {
  const fixture = syntheticVisionProbeJpegBytes();
  return buildZenResponsesRequest({
    text: FORBIDDEN_PROMPT,
    imageDataUrl: `data:image/jpeg;base64,${Buffer.from(fixture).toString("base64")}`,
    maxOutputTokens,
  });
}

async function invokeVision(output: string, outputTokens = 419) {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "mock-secret-never-persist" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, `odl-req-036-${crypto.randomUUID()}`, 75, 1);
  const body = JSON.stringify(completedEnvelope(output, outputTokens));
  const mockFetch: typeof fetch = (async () => new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
  })) as typeof fetch;
  return {
    r2,
    ledger,
    invoke: () => requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: visionRequest(zenResponsesCapabilityOutputCeiling("vision_unstructured")),
      context: "capability:vision_unstructured",
      requestIdentity: "odl-req-036:vision_unstructured",
      fetchImpl: mockFetch,
    }),
  };
}

function readMismatchDetails(error: unknown) {
  if (!(error instanceof ConnectorError)) assert.fail("Expected ConnectorError.");
  assert.equal(error.code, "provider_visual_fixture_mismatch");
  const details = error.details as Record<string, unknown>;
  assert.ok(details);
  return {
    error,
    transportReceipt: details.transportReceipt as ZenResponsesTransportReceipt,
    visionSemanticReceipt: details.visionSemanticReceipt as ZenVisionSemanticReceipt,
    structuralReceipt: details.structuralReceipt as ZenResponsesStructuralReceipt,
    usage: details.usage as ZenResponsesUsage,
    accounting: details.accounting as ZenResponsesSpendLedger,
    httpStatus: Number(details.httpStatus),
  };
}

test("completed recognized vision response still passes with bounded receipts", async () => {
  const invocation = await invokeVision(RECOGNIZED_OUTPUT, 48);
  const result = await invocation.invoke();
  assert.equal(result.status, 200);
  assert.equal(result.transportReceipt.fetchBegan, true);
  assert.equal(result.transportReceipt.httpStatus, 200);
  assert.equal(result.transportReceipt.finalEndpointClass, "documented_canonical");
  assert.equal(result.transportReceipt.redirectDisposition, "direct_canonical");
  assert.equal(result.transportReceipt.redirectHopCount, 0);
  assert.equal(result.transportReceipt.completionStatus, "completed");
  assert.equal(result.transportReceipt.requestedMaxOutputTokens, 1024);
  assert.equal(result.transportReceipt.reportedOutputTokens, 48);
  assert.equal(result.visionSemanticReceipt?.fixtureRecognitionStatus, "recognized");
  assert.equal(result.visionSemanticReceipt?.mandatoryFeatureMatchBitmap, "111");
  assert.equal(result.visionSemanticReceipt?.contradictoryFeatureMatchBitmap, "000000");
});

test("completed fixture mismatch attaches transport and semantic receipts to the local error", async () => {
  const invocation = await invokeVision(MISMATCH_OUTPUT, 419);
  let caught: unknown = null;
  try {
    await invocation.invoke();
  } catch (error) {
    caught = error;
  }
  const details = readMismatchDetails(caught);
  const transport = details.transportReceipt;
  const semantic = details.visionSemanticReceipt;

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
  assert.equal(semantic.completionStatus, "completed");
  assert.equal(semantic.requestedOutputCeiling, 1024);
  assert.equal(semantic.reportedOutputTokens, 419);
  assert.equal(semantic.fixtureRecognitionStatus, "not_recognized");
  assert.equal(semantic.mandatoryFeatureMatchBitmap.length, 3);
  assert.equal(semantic.contradictoryFeatureMatchBitmap.length, 6);
  assert.equal(semantic.mandatoryFeatureMatchCount, [...semantic.mandatoryFeatureMatchBitmap].filter((bit) => bit === "1").length);
  assert.equal(semantic.contradictoryFeatureMatchCount, [...semantic.contradictoryFeatureMatchBitmap].filter((bit) => bit === "1").length);
  assert.equal(semantic.refusalIndicator, false);
  assert.equal(semantic.genericIndicator, false);
  assert.equal(semantic.imageIgnoredIndicator, false);
  assert.equal(semantic.unsupportedIndicator, false);
  assert.match(semantic.normalizedOutputSha256, /^[a-f0-9]{64}$/);
  assert.equal(semantic.partialOutputPresent, true);
  assert.equal(details.structuralReceipt.httpStatus, 200);
  assert.equal(details.usage.outputTokens, 419);
  assert.equal(details.accounting.billableRequestCount, 1);

  const requestReceipt = transport.visionRequestReceipt as ZenVisionRequestReceipt;
  assert.deepEqual(requestReceipt.contentItemTypes, ["input_text", "input_image"]);
  assert.equal(requestReceipt.mimeType, "image/jpeg");
  assert.equal(requestReceipt.decodedImageByteCount, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(requestReceipt.imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(requestReceipt.detail, "auto");
  assert.equal(requestReceipt.imageRoundTripMatched, true);
  assert.match(requestReceipt.requestShapeFingerprint, /^[a-f0-9]{64}$/);
});

test("failed-stage projection and JSON durable round trips preserve both receipts without sensitive content", async () => {
  const invocation = await invokeVision(MISMATCH_OUTPUT, 419);
  let caught: unknown = null;
  try {
    await invocation.invoke();
  } catch (error) {
    caught = error;
  }
  const details = readMismatchDetails(caught);
  const requestReceipt = details.transportReceipt.visionRequestReceipt as ZenVisionRequestReceipt;
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
    httpStatus: details.httpStatus,
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
    visionRequestReceipt: requestReceipt,
    providerOutputClass: details.transportReceipt.providerOutputClass ?? null,
    fixtureRecognitionBoolean: details.transportReceipt.fixtureRecognitionBoolean ?? null,
    visionSemanticReceipt: details.visionSemanticReceipt,
    oneDriveAccessed: false,
    oneDriveMutationPerformed: false,
  };

  const attemptRoundTrip = JSON.parse(JSON.stringify(attempt)) as ZenResponsesCapabilityAttempt;
  const terminalRoundTrip = JSON.parse(JSON.stringify({
    version: 1,
    status: "failed",
    blockerClassification: "provider_visual_fixture_mismatch",
    attempts: [attemptRoundTrip],
  })) as { attempts: ZenResponsesCapabilityAttempt[] };
  const r2RoundTrip = JSON.parse(JSON.stringify(terminalRoundTrip)) as { attempts: ZenResponsesCapabilityAttempt[] };
  const projected = projectZenResponsesCapabilityAttempt(r2RoundTrip.attempts[0]);

  assert.deepEqual(projected.transportReceipt, details.transportReceipt);
  assert.deepEqual(projected.visionSemanticReceipt, details.visionSemanticReceipt);
  assert.deepEqual(projected.visionRequestReceipt, requestReceipt);
  assert.equal(projected.requestImageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(projected.requestImageByteSize, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(projected.requestImageMimeType, "image/jpeg");
  assert.equal(projected.errorCode, "provider_visual_fixture_mismatch");

  const serialized = JSON.stringify({ caught, attemptRoundTrip, terminalRoundTrip, r2RoundTrip, projected });
  assert.doesNotMatch(serialized, /blue triangle|red square|uca vision probe|2048/i);
  assert.doesNotMatch(serialized, /DO_NOT_PERSIST_ODL036_PROMPT/);
  assert.doesNotMatch(serialized, /mock-secret-never-persist/);
  assert.doesNotMatch(serialized, /data:image\/jpeg;base64/i);
  assert.doesNotMatch(serialized, /\/9j\//);
  assert.doesNotMatch(serialized, /providerOutput|providerText|excerpt|prompt|authorization/i);
});

test("ODL-REQ-036 leaves fixture, ceilings, retry policy, and accounting limits unchanged", async () => {
  assert.equal(OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH, 6_139);
  assert.equal(OPENCODE_VISION_PROBE_JPEG_SHA256, "9134ee7e2592e08a77bfd89d508005a4eb01f6089f4416950b41330daef353cc");
  assert.equal(zenResponsesCapabilityOutputCeiling("text_structured_output"), 128);
  assert.equal(zenResponsesCapabilityOutputCeiling("vision_unstructured"), 1024);
  assert.equal(zenResponsesCapabilityOutputCeiling("vision_structured_output"), 1024);

  const capabilitySource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8"));
  assert.match(capabilitySource, /retries: \{ limit: 0/);
  assert.match(capabilitySource, /completedVisionFailureDetails\(error\)/);
  assert.match(capabilitySource, /attemptHistorySummary: manifest\.attempts\.map\(projectZenResponsesCapabilityAttempt\)/);
  assert.doesNotMatch(capabilitySource, /maxOutputTokens:\s*(?:128|1024)/);
});
