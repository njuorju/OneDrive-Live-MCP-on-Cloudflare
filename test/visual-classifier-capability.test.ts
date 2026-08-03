import test from "node:test";
import assert from "node:assert/strict";
import {
  ODL_REQ_021_MAX_ELAPSED_MS,
  ODL_REQ_021_MAX_RETRY_DELAY_SECONDS,
  ODL_REQ_021_MAX_CYCLES,
  ODL_REQ_021_PROBE_VERSION,
  ODL_REQ_021_RETRY_DELAYS_SECONDS,
  normalizedResponseClass,
  parseRetryAfterSeconds,
  preciseBlocker,
  responseClassRetryable,
  sanitizeProviderError,
  type CapabilityAttemptReceipt,
} from "../src/visual-classifier-capability";

function attempt(responseClass: CapabilityAttemptReceipt["normalizedResponseClass"], status: number | null): CapabilityAttemptReceipt {
  return {
    version: 1,
    capabilityJobId: "00000000-0000-4000-8000-000000000001",
    cycleNumber: 1,
    attemptNumber: 1,
    probeStage: "vision_structured_output",
    provider: "opencode_zen",
    mode: "opencode_chat_completions",
    exactModel: "mimo-v2.5-free",
    endpointFamily: "openai_compatible_chat_completions",
    requestFingerprint: "a".repeat(64),
    requestImageSha256: "b".repeat(64),
    requestImageByteSize: 6139,
    requestImageMimeType: "image/jpeg",
    startedAt: "2026-08-03T00:00:00.000Z",
    completedAt: "2026-08-03T00:00:01.000Z",
    latencyMilliseconds: 1000,
    httpStatus: status,
    normalizedResponseClass: responseClass,
    retryable: responseClassRetryable(responseClass),
    retryAfterSeconds: null,
    providerRequestId: null,
    edgeRequestId: null,
    responseContentType: "application/json",
    responseByteCount: 100,
    sanitizedProviderErrorCode: responseClass,
    sanitizedProviderErrorMessage: "bounded",
    parserResult: "response_json_parsed",
    schemaValidationResult: "not_applicable",
    usage: null,
    nextRetryTimestamp: null,
    terminalDisposition: responseClassRetryable(responseClass) ? "retry_scheduled" : "terminal_failure",
  };
}

test("preserves exact HTTP 429 as rate_limited", () => {
  assert.equal(normalizedResponseClass(429), "rate_limited");
  assert.equal(responseClassRetryable("rate_limited"), true);
});

for (const status of [500, 502, 503, 504]) {
  test(`preserves representative HTTP ${status} as provider_server_error`, () => {
    assert.equal(normalizedResponseClass(status), "provider_server_error");
    assert.equal(responseClassRetryable("provider_server_error"), true);
  });
}

test("distinguishes non-retryable 400, 401, and 403", () => {
  assert.equal(normalizedResponseClass(400), "invalid_request");
  assert.equal(normalizedResponseClass(401), "authentication_failed");
  assert.equal(normalizedResponseClass(403), "authorization_failed");
  assert.equal(responseClassRetryable("invalid_request"), false);
  assert.equal(responseClassRetryable("authentication_failed"), false);
  assert.equal(responseClassRetryable("authorization_failed"), false);
});

test("preserves explicit model-missing classification", () => {
  assert.equal(normalizedResponseClass(404, { modelMissing: true }), "model_missing");
  assert.equal(responseClassRetryable("model_missing"), false);
});

test("distinguishes network failures and timeouts", () => {
  assert.equal(normalizedResponseClass(null, { networkFailure: true }), "network_failure");
  assert.equal(normalizedResponseClass(null, { timeout: true }), "timeout");
  assert.equal(responseClassRetryable("network_failure"), true);
  assert.equal(responseClassRetryable("timeout"), true);
});

test("parses Retry-After seconds and bounds the delay", () => {
  assert.equal(parseRetryAfterSeconds("120"), 120);
  assert.equal(parseRetryAfterSeconds("999999"), ODL_REQ_021_MAX_RETRY_DELAY_SECONDS);
  assert.equal(parseRetryAfterSeconds("-1"), null);
});

test("parses Retry-After HTTP dates", () => {
  const now = Date.parse("2026-08-03T00:00:00.000Z");
  assert.equal(parseRetryAfterSeconds("Mon, 03 Aug 2026 00:10:00 GMT", now), 600);
  assert.equal(parseRetryAfterSeconds("Mon, 03 Aug 2026 10:00:00 GMT", now), ODL_REQ_021_MAX_RETRY_DELAY_SECONDS);
});

test("retry schedule is bounded to six cycles and under four hours", () => {
  assert.equal(ODL_REQ_021_MAX_CYCLES, 6);
  assert.deepEqual([...ODL_REQ_021_RETRY_DELAYS_SECONDS], [0, 120, 600, 1800, 3600, 7200]);
  assert.ok(ODL_REQ_021_RETRY_DELAYS_SECONDS.reduce((sum, value) => sum + value, 0) * 1000 < ODL_REQ_021_MAX_ELAPSED_MS);
});

test("sanitizes secrets, URLs, headers, and HTML from provider errors", () => {
  const sanitized = sanitizeProviderError({
    error: {
      code: "rate_limit",
      message: "Authorization: Bearer sk-secret https://private.example/object <html><body>retry</body></html> Set-Cookie: session=secret",
    },
  });
  assert.equal(sanitized.code, "rate_limit");
  assert.ok(!sanitized.message?.includes("sk-secret"));
  assert.ok(!sanitized.message?.includes("private.example"));
  assert.ok(!sanitized.message?.includes("<html>"));
  assert.ok(!sanitized.message?.includes("session=secret"));
});

test("sanitized error excerpts are bounded", () => {
  const sanitized = sanitizeProviderError({ code: "x".repeat(1000), message: "y".repeat(5000) });
  assert.equal(sanitized.code?.length, 120);
  assert.equal(sanitized.message?.length, 500);
});

test("returns precise blocker classifications", () => {
  assert.equal(preciseBlocker([attempt("rate_limited", 429)]), "provider_rate_limited");
  assert.equal(preciseBlocker([attempt("provider_server_error", 503)]), "provider_server_unavailable");
  assert.equal(preciseBlocker([attempt("network_failure", null), attempt("timeout", null)]), "provider_network_unavailable");
  assert.equal(preciseBlocker([attempt("unsupported_media", 415)]), "provider_multimodal_unsupported");
  assert.equal(preciseBlocker([attempt("structured_output_failure", 200)]), "provider_structured_output_unsupported");
  assert.equal(preciseBlocker([attempt("rate_limited", 429), attempt("provider_server_error", 503)]), "provider_mixed_transient_failures");
});

test("probe version is pinned", () => {
  assert.equal(ODL_REQ_021_PROBE_VERSION, "odl-req-021-capability-v1");
});
