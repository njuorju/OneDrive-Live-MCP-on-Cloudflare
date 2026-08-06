import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ZEN_RESPONSES_CAPABILITY_OUTPUT_CEILINGS,
  zenResponsesCapabilityOutputCeiling,
} from "../src/visual-classifier-capability-output-ceilings";
import {
  OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH,
  OPENCODE_VISION_PROBE_JPEG_SHA256,
  syntheticVisionProbeJpegBytes,
} from "../src/visual-catalogue-probe-fixture";
import { buildZenResponsesRequest } from "../src/visual-catalogue-zen-responses";
import {
  ZEN_VISION_CONTRADICTORY_FEATURE_ORDER,
  ZEN_VISION_MANDATORY_FEATURE_ORDER,
  assertZenVisionFixtureRecognition,
  buildBoundedZenVisionDataUrl,
  classifyZenVisionProviderText,
  inspectZenVisionProviderText,
  inspectZenVisionRequest,
} from "../src/visual-zen-responses-vision";

const CURRENT_CANONICAL_ANSWER = "Blue square, red circle, UCA VISION PROBE 2047";
const COMPLETE_POSITIONAL_ANSWER = "Blue square on the left; red circle on the right; UCA VISION PROBE 2047";

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && typeof (error as Record<string, unknown>).code === "string"
    ? String((error as Record<string, unknown>).code)
    : null;
}

test("exact local fixture remains the independently verified bounded JPEG", async () => {
  const fixture = syntheticVisionProbeJpegBytes();
  assert.equal(fixture.byteLength, 6_139);
  assert.equal(fixture.byteLength, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(createHash("sha256").update(fixture).digest("hex"), OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(OPENCODE_VISION_PROBE_JPEG_SHA256, "9134ee7e2592e08a77bfd89d508005a4eb01f6089f4416950b41330daef353cc");

  const request = buildZenResponsesRequest({
    text: "Inspect the attached image in one short line.",
    imageDataUrl: buildBoundedZenVisionDataUrl(fixture),
    maxOutputTokens: zenResponsesCapabilityOutputCeiling("vision_unstructured"),
  });
  const receipt = await inspectZenVisionRequest(request, fixture);
  assert.deepEqual(receipt.contentItemTypes, ["input_text", "input_image"]);
  assert.equal(receipt.mimeType, "image/jpeg");
  assert.equal(receipt.detail, "auto");
  assert.equal(receipt.decodedImageByteCount, 6_139);
  assert.equal(receipt.imageSha256, OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(receipt.imageRoundTripMatched, true);
});

test("unstructured prompt is bounded, non-JSON, answer-blind, and production catalogue prompts stay outside the repair", async () => {
  const capabilitySource = await readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8");
  const match = capabilitySource.match(/export const ZEN_VISION_UNSTRUCTURED_PROBE_PROMPT = "([^"]+)";/);
  assert.ok(match);
  const prompt = match[1];
  assert.match(prompt, /one short line/i);
  assert.match(prompt, /left\/right position/i);
  assert.match(prompt, /complete readable uppercase label/i);
  assert.match(prompt, /do not explain/i);
  assert.doesNotMatch(prompt, /\b(?:blue|red|square|circle|box|disc|disk|2047)\b|uca vision probe/i);
  assert.doesNotMatch(prompt, /json|schema|capability_ready/i);
  assert.match(capabilitySource, /vision_unstructured"\s*\?\s*buildZenResponsesRequest\(\{ text: ZEN_VISION_UNSTRUCTURED_PROBE_PROMPT, imageDataUrl, maxOutputTokens \}\)/);
  assert.match(capabilitySource, /Return the visible blue shape, red shape, exact visible text, and capability_ready=true\./);
  const unstructuredRequestLine = capabilitySource.split("\n").find((line) => line.includes("text: ZEN_VISION_UNSTRUCTURED_PROBE_PROMPT"));
  assert.ok(unstructuredRequestLine);
  assert.doesNotMatch(unstructuredRequestLine, /schema:/);
});

test("feature validator accepts canonical output, correct paraphrases, harmless formatting, and enumerated synonyms", () => {
  const accepted = [
    CURRENT_CANONICAL_ANSWER,
    COMPLETE_POSITIONAL_ANSWER,
    "  UCA   VISION probe 2047 — RIGHT: RED CIRCLE / LEFT: BLUE SQUARE.  ",
    "The leftmost object is an azure box; on the right is a crimson disc; label UCA VISION PROBE 2047.",
    "Label UCA VISION PROBE 2047. Scarlet disk right | azure square left.",
    "UCA VISION PROBE 2047; a blue box is left; a red disc is right.",
  ];
  for (const output of accepted) {
    assert.equal(classifyZenVisionProviderText(output), "fixture_recognized", output);
    assert.equal(assertZenVisionFixtureRecognition(output), "fixture_recognized", output);
  }
});

test("feature validator fails closed on missing, wrong, generic, refusal, unsupported, ignored, and boilerplate outputs", () => {
  const cases: Array<[string, string]> = [
    ["fixture_partly_recognized", "Blue square on the left; UCA VISION PROBE 2047"],
    ["fixture_partly_recognized", "Blue square on the left; red circle on the right"],
    ["wrong_visual_facts", "Blue triangle on the left; red circle on the right; UCA VISION PROBE 2047"],
    ["wrong_visual_facts", "Red square on the left; red circle on the right; UCA VISION PROBE 2047"],
    ["wrong_visual_facts", "Blue square on the right; red circle on the left; UCA VISION PROBE 2047"],
    ["wrong_visual_facts", "Two blue squares on the left; red circle on the right; UCA VISION PROBE 2047"],
    ["wrong_visual_facts", "Blue square on the left; red circle on the right; UCA VISION PROBE 2048"],
    ["generic_visual_prose", "The image contains colorful shapes and a text label."],
    ["refusal", "I refuse to comply with this request."],
    ["explicit_multimodal_unsupported", "This text-only model does not support image input."],
    ["image_ignored_or_stripped", "I cannot view the attached image because the attachment is missing."],
    ["completed_unclassifiable", "I am an AI assistant and can help with text tasks."],
    ["wrong_visual_facts", `${COMPLETE_POSITIONAL_ANSWER}. Actually, the blue object is a triangle and the circle is green.`],
  ];
  for (const [expected, output] of cases) {
    assert.equal(classifyZenVisionProviderText(output), expected, output);
    assert.throws(
      () => assertZenVisionFixtureRecognition(output),
      (error: unknown) => {
        const code = errorCode(error);
        if (expected === "explicit_multimodal_unsupported") return code === "provider_multimodal_unsupported";
        if (expected === "image_ignored_or_stripped") return code === "provider_image_input_ignored";
        if (expected === "refusal") return code === "provider_visual_fixture_refused";
        return code === "provider_visual_fixture_mismatch";
      },
      output,
    );
  }
});

test("completed mismatch receipt is bounded, diagnostic, and contains no provider text", async () => {
  const providerOutput = "Blue triangle on the right; red square on the left; UCA VISION PROBE 2048";
  const receipt = await inspectZenVisionProviderText(providerOutput, {
    completionStatus: "completed",
    requestedOutputCeiling: 1024,
    reportedOutputTokens: 573,
    outputTokensReachedRequestedCeiling: false,
    partialOutputPresent: false,
  });
  assert.equal(receipt.completionStatus, "completed");
  assert.equal(receipt.requestedOutputCeiling, 1024);
  assert.equal(receipt.reportedOutputTokens, 573);
  assert.equal(receipt.outputTokensReachedRequestedCeiling, false);
  assert.equal(receipt.semanticClass, "wrong_visual_facts");
  assert.equal(receipt.fixtureRecognitionStatus, "not_recognized");
  assert.equal(receipt.mandatoryFeatureMatchBitmap.length, ZEN_VISION_MANDATORY_FEATURE_ORDER.length);
  assert.equal(receipt.contradictoryFeatureMatchBitmap.length, ZEN_VISION_CONTRADICTORY_FEATURE_ORDER.length);
  assert.ok(receipt.contradictoryFeatureMatchCount >= 1);
  assert.equal(receipt.refusalIndicator, false);
  assert.equal(receipt.genericIndicator, false);
  assert.equal(receipt.imageIgnoredIndicator, false);
  assert.equal(receipt.unsupportedIndicator, false);
  assert.match(receipt.normalizedOutputSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.partialOutputPresent, true);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /blue triangle|red square|uca vision probe|2048/i);
  assert.doesNotMatch(serialized, /providerText|providerOutput|excerpt|prompt|responseBody/i);
  assert.throws(
    () => assertZenVisionFixtureRecognition(receipt),
    (error: unknown) => errorCode(error) === "provider_visual_fixture_mismatch",
  );
});

test("recognized completed receipt passes and bounded output ceilings remain exact", async () => {
  const receipt = await inspectZenVisionProviderText(COMPLETE_POSITIONAL_ANSWER, {
    completionStatus: "completed",
    requestedOutputCeiling: 1024,
    reportedOutputTokens: 48,
    outputTokensReachedRequestedCeiling: false,
  });
  assert.equal(receipt.semanticClass, "fixture_recognized");
  assert.equal(receipt.fixtureRecognitionStatus, "recognized");
  assert.equal(receipt.mandatoryFeatureMatchBitmap, "111");
  assert.equal(receipt.contradictoryFeatureMatchBitmap, "000000");
  assert.equal(assertZenVisionFixtureRecognition(receipt), "fixture_recognized");
  assert.deepEqual(ZEN_RESPONSES_CAPABILITY_OUTPUT_CEILINGS, {
    text_structured_output: 128,
    vision_unstructured: 1024,
    vision_structured_output: 1024,
  });
});

test("capability attempt persists bounded semantic receipt without changing fail-closed stage policy", async () => {
  const capabilitySource = await readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8");
  assert.match(capabilitySource, /visionSemanticReceipt: ZenVisionSemanticReceipt \| null/);
  assert.match(capabilitySource, /inspectZenVisionProviderText\(result\.text/);
  assert.match(capabilitySource, /assertZenVisionFixtureRecognition\(visionSemanticReceipt\)/);
  assert.match(capabilitySource, /visionRequestReceipt, providerOutputClass, fixtureRecognitionBoolean, visionSemanticReceipt/);
  assert.match(capabilitySource, /if \(attempt\.status === "failed"\)/);
  assert.match(capabilitySource, /retries: \{ limit: 0/);
});
