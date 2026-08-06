import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorError } from "../src/errors";
import { base64ToBytes, sha256Bytes } from "../src/integrated-core";
import { syntheticVisionProbeJpegBytes, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH, OPENCODE_VISION_PROBE_JPEG_SHA256 } from "../src/visual-catalogue-probe-fixture";
import { buildZenResponsesRequest, parseZenResponsesOutput } from "../src/visual-catalogue-zen-responses-base";
import { createBoundedZenResponsesRedirectFetch } from "../src/visual-catalogue-zen-responses";
import {
  assertZenVisionFixtureRecognition,
  buildBoundedZenVisionDataUrl,
  classifyZenVisionProviderError,
  classifyZenVisionProviderText,
  inspectZenVisionRequest,
} from "../src/visual-zen-responses-vision";

function expectCode(run: () => unknown | Promise<unknown>, code: string): Promise<void> {
  return Promise.resolve().then(run).then(
    () => assert.fail(`expected ${code}`),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, code);
    },
  );
}

function visionRequest(schema = false): Record<string, unknown> {
  const fixture = syntheticVisionProbeJpegBytes();
  return buildZenResponsesRequest({
    text: "bounded fixture recognition",
    imageDataUrl: buildBoundedZenVisionDataUrl(fixture),
    maxOutputTokens: 256,
    ...(schema ? { schema: { name: "vision_probe", schema: { type: "object" } } } : {}),
  });
}

test("uses exact input_text plus input_image Responses structure with detail auto", () => {
  const request = visionRequest();
  const input = request.input as Array<Record<string, unknown>>;
  assert.equal(input.length, 1);
  assert.equal(input[0].role, "user");
  assert.deepEqual((input[0].content as Array<Record<string, unknown>>).map((part) => part.type), ["input_text", "input_image"]);
  assert.equal((input[0].content as Array<Record<string, unknown>>)[1].detail, "auto");
});

test("JPEG data URL round-trips exact fixture bytes and SHA-256", async () => {
  const fixture = syntheticVisionProbeJpegBytes();
  const dataUrl = buildBoundedZenVisionDataUrl(fixture);
  assert.ok(dataUrl.startsWith("data:image/jpeg;base64,"));
  const decoded = base64ToBytes(dataUrl.slice("data:image/jpeg;base64,".length));
  assert.equal(decoded.byteLength, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(await sha256Bytes(decoded), OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.deepEqual(decoded, fixture);
  const receipt = await inspectZenVisionRequest(visionRequest(), fixture);
  assert.equal(receipt.imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(receipt.decodedImageByteCount, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(receipt.dataUrlPrefixClass, "data_image_jpeg_base64");
  assert.equal(receipt.imageRoundTripMatched, true);
  assert.ok(!JSON.stringify(receipt).includes(dataUrl.slice(0, 80)));
});

test("image survives JSON serialization", async () => {
  const fixture = syntheticVisionProbeJpegBytes();
  const serialized = JSON.stringify(visionRequest());
  const restored = JSON.parse(serialized) as Record<string, unknown>;
  const receipt = await inspectZenVisionRequest(restored, fixture);
  assert.equal(receipt.imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
});

test("image survives accepted one-hop redirect body reconstruction", async () => {
  const fixture = syntheticVisionProbeJpegBytes();
  const body = JSON.stringify(visionRequest());
  const seenBodies: string[] = [];
  let call = 0;
  const guarded = createBoundedZenResponsesRedirectFetch(async (_url, init) => {
    seenBodies.push(String(init?.body ?? ""));
    call += 1;
    if (call === 1) return new Response(null, { status: 308, headers: { location: "https://opencode.ai/zen/v1/responses/" } });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  await guarded("https://opencode.ai/zen/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer redacted", "content-type": "application/json" },
    body,
    redirect: "manual",
    signal: new AbortController().signal,
  });
  assert.equal(seenBodies.length, 2);
  assert.equal(seenBodies[0], body);
  assert.equal(seenBodies[1], body);
  await inspectZenVisionRequest(JSON.parse(seenBodies[1]) as Record<string, unknown>, fixture);
});

test("malformed, empty, incorrect-MIME, missing, and changed image inputs fail closed distinctly", async () => {
  const fixture = syntheticVisionProbeJpegBytes();
  const empty = visionRequest();
  ((empty.input as any[])[0].content as any[])[1].image_url = "data:image/jpeg;base64,";
  await expectCode(() => inspectZenVisionRequest(empty, fixture), "vision_request_image_base64_invalid");

  const mime = visionRequest();
  ((mime.input as any[])[0].content as any[])[1].image_url = "data:image/png;base64,AAAA";
  await expectCode(() => inspectZenVisionRequest(mime, fixture), "vision_request_image_data_url_invalid");

  const missing = visionRequest();
  (missing.input as any[])[0].content = [(missing.input as any[])[0].content[0]];
  await expectCode(() => inspectZenVisionRequest(missing, fixture), "vision_request_content_items_invalid");

  const changed = visionRequest();
  const altered = fixture.slice();
  altered[100] ^= 1;
  ((changed.input as any[])[0].content as any[])[1].image_url = buildBoundedZenVisionDataUrl(altered);
  await expectCode(() => inspectZenVisionRequest(changed, fixture), "vision_request_image_bytes_changed");
});

test("completed output semantics distinguish recognition, ignored image, unsupported input, and mismatch", async () => {
  assert.equal(classifyZenVisionProviderText("Blue square, red circle, UCA VISION PROBE 2047"), "fixture_recognized");
  assert.equal(classifyZenVisionProviderText("No image was attached, so I cannot inspect it."), "image_ignored_or_stripped");
  assert.equal(classifyZenVisionProviderText("This text-only model does not support image input."), "explicit_multimodal_unsupported");
  assert.equal(classifyZenVisionProviderText("I see a green triangle."), "fixture_recognition_failed");
  assert.equal(assertZenVisionFixtureRecognition("Blue square, red circle, UCA VISION PROBE 2047"), "fixture_recognized");
  await expectCode(() => assertZenVisionFixtureRecognition("No image was attached."), "provider_image_input_ignored");
  await expectCode(() => assertZenVisionFixtureRecognition("Image input is unsupported."), "provider_multimodal_unsupported");
  await expectCode(() => assertZenVisionFixtureRecognition("A green triangle."), "provider_visual_fixture_mismatch");
});

test("provider error semantics distinguish invalid image from explicit unsupported", () => {
  assert.equal(classifyZenVisionProviderError({ error: { code: "invalid_image", message: "Could not decode JPEG image" } }), "invalid_image_payload");
  assert.equal(classifyZenVisionProviderError({ error: { type: "unsupported_media", message: "Image input is not supported" } }), "explicit_multimodal_unsupported");
  assert.equal(classifyZenVisionProviderError({ error: { code: "rate_limit" } }), null);
});

test("provider refusal remains distinct from unsupported", async () => {
  await expectCode(() => parseZenResponsesOutput({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] }), "provider_refusal");
});

test("structured vision and unstructured vision use the same image builder; text-only request remains unchanged", async () => {
  const fixture = syntheticVisionProbeJpegBytes();
  const unstructured = visionRequest(false);
  const structured = visionRequest(true);
  assert.equal((await inspectZenVisionRequest(unstructured, fixture)).imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal((await inspectZenVisionRequest(structured, fixture)).imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.ok(structured.text && typeof structured.text === "object");

  const text = buildZenResponsesRequest({ text: "text probe", maxOutputTokens: 128, schema: { name: "text_probe", schema: { type: "object" } } });
  const content = ((text.input as any[])[0].content as any[]);
  assert.deepEqual(content, [{ type: "input_text", text: "text probe" }]);
});
