import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ODL_REQ_024_CAPABILITY_MAX_REQUESTS,
  ODL_REQ_024_CAPABILITY_MAX_SPEND_USD,
  ODL_REQ_024_DIAGNOSTIC_MAX_REQUESTS,
  ODL_REQ_024_DIAGNOSTIC_MAX_SPEND_USD,
  buildOpenCodeGoDiagnosticRequest,
  classifyOpenCodeGoSuccessEnvelope,
  extractOpenCodeGoFinalContent,
  openCodeGoRequestShapeReceipt,
  openCodeGoResponseShapeReceipt,
  shouldRunOpenCodeGoTokenControl,
  verifyOpenCodeGoDiagnosticFixture,
} from "../src/visual-classifier-capability-go-diagnostic";
import {
  OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH,
  OPENCODE_VISION_PROBE_JPEG_SHA256,
  syntheticVisionProbeJpegBytes,
} from "../src/visual-catalogue-probe-fixture";
import { OPENCODE_GO_CHAT_ENDPOINT, OPENCODE_GO_MODEL } from "../src/visual-catalogue-opencode-go";

const encoder = new TextEncoder();

function responseBody(message: Record<string, unknown>, finishReason: string | null = "stop") {
  return { id: "redacted", model: OPENCODE_GO_MODEL, choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

test("deterministic JPEG fixture has exact identity and dimensions", async () => {
  const fixture = syntheticVisionProbeJpegBytes();
  const receipt = await verifyOpenCodeGoDiagnosticFixture(fixture);
  assert.equal(receipt.sha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(receipt.byteLength, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(receipt.width, 640);
  assert.equal(receipt.height, 360);
  assert.equal(receipt.mimeType, "image/jpeg");
});

test("canonical multimodal request uses exact OpenAI-compatible image part", () => {
  const fixture = syntheticVisionProbeJpegBytes();
  const request = buildOpenCodeGoDiagnosticRequest("canonical_vision_payload", fixture);
  const body = request.body as any;
  assert.equal(request.endpoint, OPENCODE_GO_CHAT_ENDPOINT);
  assert.equal(body.model, OPENCODE_GO_MODEL);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages[0].content.map((part: any) => part.type), ["text", "image_url"]);
  assert.deepEqual(Object.keys(body.messages[0].content[1].image_url), ["url"]);
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(body.response_format, undefined);
});

test("current payload receipt preserves the exact legacy structural difference", async () => {
  const request = buildOpenCodeGoDiagnosticRequest("current_vision_payload", syntheticVisionProbeJpegBytes());
  const body = request.body as any;
  const receipt = await openCodeGoRequestShapeReceipt(request);
  assert.equal(receipt.streamFlag, null);
  assert.equal(body.messages[0].content[1].image_url.detail, "high");
  assert.deepEqual(receipt.orderedContentPartTypes, ["text", "image_url"]);
  assert.equal(receipt.imageTransportType, "data_url");
  assert.equal(receipt.imageMimeType, "image/jpeg");
  assert.equal(receipt.decodedImageByteCount, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(receipt.imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
});

test("request shape receipt never includes prompt or image data", async () => {
  const request = buildOpenCodeGoDiagnosticRequest("canonical_vision_payload", syntheticVisionProbeJpegBytes());
  const receipt = await openCodeGoRequestShapeReceipt(request);
  const rendered = JSON.stringify(receipt);
  assert.equal(rendered.includes("UCA VISION PROBE 2047"), false);
  assert.equal(rendered.includes("base64,"), false);
  assert.equal(rendered.includes("/9j/"), false);
  assert.match(receipt.requestShapeFingerprint, /^[0-9a-f]{64}$/);
});

test("success-envelope classifier covers exact allowed shapes", () => {
  assert.equal(classifyOpenCodeGoSuccessEnvelope(responseBody({ role: "assistant", content: "ok" })), "openai_message_content_string");
  assert.equal(classifyOpenCodeGoSuccessEnvelope(responseBody({ role: "assistant", content: [{ type: "text", text: "ok" }] })), "openai_message_content_parts");
  assert.equal(classifyOpenCodeGoSuccessEnvelope(responseBody({ role: "assistant", content: null, refusal: "no" })), "openai_message_refusal");
  assert.equal(classifyOpenCodeGoSuccessEnvelope(responseBody({ role: "assistant", content: null, reasoning_content: "private" })), "reasoning_only_no_final_content");
  assert.equal(classifyOpenCodeGoSuccessEnvelope(responseBody({ role: "assistant", content: null })), "empty_message_content");
  assert.equal(classifyOpenCodeGoSuccessEnvelope({ model: OPENCODE_GO_MODEL }), "choices_missing");
  assert.equal(classifyOpenCodeGoSuccessEnvelope({ choices: [{}] }), "message_missing");
  assert.equal(classifyOpenCodeGoSuccessEnvelope(responseBody({ role: "assistant", content: null }, "length")), "finish_reason_length_without_content");
  assert.equal(classifyOpenCodeGoSuccessEnvelope({ error: { type: "server_error" }, choices: [] }), "provider_error_embedded_in_200");
  assert.equal(classifyOpenCodeGoSuccessEnvelope(responseBody({ role: "assistant", content: null, output_text: "alternate" })), "alternate_documented_text_field");
});

test("only message content string or typed text parts become final content", () => {
  assert.equal(extractOpenCodeGoFinalContent(responseBody({ role: "assistant", content: "visible" })), "visible");
  assert.equal(extractOpenCodeGoFinalContent(responseBody({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })), "ab");
  assert.equal(extractOpenCodeGoFinalContent(responseBody({ role: "assistant", content: null, reasoning_content: "not final" })), null);
  assert.equal(extractOpenCodeGoFinalContent(responseBody({ role: "assistant", content: null, output_text: "not allowlisted" })), null);
  assert.equal(extractOpenCodeGoFinalContent(responseBody({ role: "assistant", content: [{ type: "output_text", text: "not allowlisted" }] })), null);
});

test("response structural receipt excludes generated and reasoning content", async () => {
  const body = responseBody({ role: "assistant", content: "SECRET_FINAL", reasoning_content: "SECRET_REASONING", tool_calls: [] });
  const bytes = encoder.encode(JSON.stringify(body));
  const receipt = await openCodeGoResponseShapeReceipt({
    status: 200,
    contentType: "application/json",
    bytes,
    body,
    providerRequestId: "request-redacted",
    edgeRequestId: "edge-redacted",
  });
  const rendered = JSON.stringify(receipt);
  assert.equal(rendered.includes("SECRET_FINAL"), false);
  assert.equal(rendered.includes("SECRET_REASONING"), false);
  assert.deepEqual(receipt.topLevelJsonKeys, ["choices", "id", "model", "usage"]);
  assert.equal(receipt.messageContentType, "string");
  assert.equal(receipt.fieldPresenceTypes.reasoning_content, "string");
  assert.match(receipt.bodySha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(receipt.responseShapeFingerprint, /^[0-9a-f]{64}$/);
});

test("Probe D runs after a non-usable length-truncated content string, but not after HTTP 500", () => {
  const receipt = {
    probe: "canonical_vision_payload",
    attempt: 1,
    startedAt: "2026-08-03T00:00:00.000Z",
    completedAt: "2026-08-03T00:00:01.000Z",
    latencyMilliseconds: 1000,
    requestShape: {} as any,
    responseShape: {
      httpStatus: 200,
      finishReason: "length",
      successEnvelopeClass: "openai_message_content_string",
    } as any,
    usage: null,
    accounting: {} as any,
    usableFinalContent: false,
    visualFixtureMatched: false,
    structuredFixtureMatched: false,
    retryReason: null,
  } as any;
  assert.equal(shouldRunOpenCodeGoTokenControl(receipt), true);
  assert.equal(shouldRunOpenCodeGoTokenControl({ ...receipt, responseShape: { ...receipt.responseShape, httpStatus: 500 } }), false);
  assert.equal(shouldRunOpenCodeGoTokenControl({ ...receipt, usableFinalContent: true }), false);
});

test("diagnostic and capability ceilings are immutable", () => {
  assert.equal(ODL_REQ_024_DIAGNOSTIC_MAX_REQUESTS, 8);
  assert.equal(ODL_REQ_024_DIAGNOSTIC_MAX_SPEND_USD, 0.05);
  assert.equal(ODL_REQ_024_CAPABILITY_MAX_REQUESTS, 75);
  assert.equal(ODL_REQ_024_CAPABILITY_MAX_SPEND_USD, 1);
});

test("diagnostic source has no OneDrive, source-PDF, URL-image or fallback path", async () => {
  const source = await readFile(new URL("../src/visual-classifier-capability-go-diagnostic.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /graph\.microsoft|read_onedrive|sourceItemId|renderAndCache|publish_cached_visual_assets|commit_visual_catalogue_publication/i);
  assert.doesNotMatch(source, /https?:\/\/(?!opencode\.ai)/i);
  assert.doesNotMatch(source, /mimo-v2\.5-free|mimo-v2\.5-pro|OPENAI_API_KEY|allowPaidFallback/i);
  assert.match(source, /attempt <= 3/);
  assert.match(source, /pages64Through219Blocked: true/);
});
