import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ZEN_VISION_MANDATORY_FEATURE_ORDER,
  assertZenVisionFixtureRecognition,
  inspectZenVisionProviderText,
} from "../src/visual-zen-responses-vision";
import {
  OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH,
  OPENCODE_VISION_PROBE_JPEG_HEIGHT,
  OPENCODE_VISION_PROBE_JPEG_SHA256,
  OPENCODE_VISION_PROBE_JPEG_WIDTH,
  syntheticVisionProbeJpegBytes,
} from "../src/visual-catalogue-probe-fixture";
import {
  inspectZenResponsesCompletionEnvelope,
} from "../src/visual-catalogue-zen-responses";
import {
  parseZenResponsesUsage,
} from "../src/visual-catalogue-zen-responses-base";

function jpegMetadata(bytes: Uint8Array): {
  width: number;
  height: number;
  comments: number;
  exifSegments: number;
} {
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  let offset = 2;
  let width = 0;
  let height = 0;
  let comments = 0;
  let exifSegments = 0;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    assert.ok(length >= 2);
    if (marker === 0xfe) comments += 1;
    if (marker === 0xe1) exifSegments += 1;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      width = (bytes[offset + 5] << 8) | bytes[offset + 6];
    }
    offset += length;
  }
  return { width, height, comments, exifSegments };
}

test("mandatory feature order maps fresh bitmap 110 to the exact missing label", async () => {
  assert.deepEqual([...ZEN_VISION_MANDATORY_FEATURE_ORDER], [
    "blue_square",
    "red_circle",
    "visible_label",
  ]);
  const bitmap = "110";
  const missing = [...bitmap]
    .map((bit, index) => bit === "0" ? ZEN_VISION_MANDATORY_FEATURE_ORDER[index] : null)
    .filter((value): value is (typeof ZEN_VISION_MANDATORY_FEATURE_ORDER)[number] => value !== null);
  assert.deepEqual(missing, ["visible_label"]);

  const receipt = await inspectZenVisionProviderText(
    "Blue square on the left; red circle on the right.",
    {
      completionStatus: "completed",
      requestedOutputCeiling: 1024,
      reportedOutputTokens: 544,
    },
  );
  assert.equal(receipt.mandatoryFeatureMatchBitmap, "110");
  assert.equal(receipt.mandatoryFeatureMatchCount, 2);
  assert.equal(receipt.fixtureRecognitionStatus, "partly_recognized");
  assert.equal(receipt.outputTokensReachedRequestedCeiling, false);
  assert.throws(
    () => assertZenVisionFixtureRecognition(receipt),
    (error: unknown) => Boolean(
      error
      && typeof error === "object"
      && (error as Record<string, unknown>).code === "provider_visual_fixture_mismatch"
    ),
  );
});

test("replacement JPEG is the exact reviewed single-label landscape fixture without metadata leakage", () => {
  const fixture = syntheticVisionProbeJpegBytes();
  assert.equal(fixture.byteLength, 14_298);
  assert.equal(fixture.byteLength, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.equal(createHash("sha256").update(fixture).digest("hex"), OPENCODE_VISION_PROBE_JPEG_SHA256);
  assert.equal(OPENCODE_VISION_PROBE_JPEG_SHA256, "da50bd35fd2266fdef0400dbc52968b44e5e743f5654f6b99f0cecbb68cc228a");

  const metadata = jpegMetadata(fixture);
  assert.deepEqual(metadata, {
    width: 640,
    height: 360,
    comments: 0,
    exifSegments: 0,
  });
  assert.equal(metadata.width, OPENCODE_VISION_PROBE_JPEG_WIDTH);
  assert.equal(metadata.height, OPENCODE_VISION_PROBE_JPEG_HEIGHT);
  assert.equal(fixture[fixture.length - 2], 0xff);
  assert.equal(fixture[fixture.length - 1], 0xd9);

  const binaryText = Buffer.from(fixture).toString("latin1");
  assert.doesNotMatch(binaryText, /UCA VISION PROBE 2047|blue square|red circle/i);
});

test("probe prompt remains answer-blind while explicitly requesting every mandatory category", async () => {
  const source = await readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8");
  const match = source.match(/export const ZEN_VISION_UNSTRUCTURED_PROBE_PROMPT = "([^"]+)";/);
  assert.ok(match);
  const prompt = match[1];
  assert.match(prompt, /colored geometric shape/i);
  assert.match(prompt, /left\/right position/i);
  assert.match(prompt, /uppercase label/i);
  assert.doesNotMatch(prompt, /\b(?:blue|red|square|circle|2047)\b|uca vision probe/i);
});

test("completed output deterministically normalizes ceiling and partial-text booleans", () => {
  const completed = inspectZenResponsesCompletionEnvelope({
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "bounded parsed output" }],
    }],
    usage: { output_tokens: 544 },
  }, 1024);
  assert.equal(completed.outputTokensReachedRequestedCeiling, false);
  assert.equal(completed.partialOutputTextPresent, true);

  const completedEmpty = inspectZenResponsesCompletionEnvelope({
    status: "completed",
    output: [],
    usage: { output_tokens: 0 },
  }, 1024);
  assert.equal(completedEmpty.outputTokensReachedRequestedCeiling, false);
  assert.equal(completedEmpty.partialOutputTextPresent, false);

  const unknown = inspectZenResponsesCompletionEnvelope({}, 1024);
  assert.equal(unknown.outputTokensReachedRequestedCeiling, null);
  assert.equal(unknown.partialOutputTextPresent, null);
});

test("cached-write normalization preserves absent usage versus known zero usage", () => {
  const known = parseZenResponsesUsage({
    usage: {
      input_tokens: 182,
      output_tokens: 544,
      total_tokens: 726,
      input_tokens_details: { cached_tokens: 0 },
    },
  });
  assert.equal(known.cachedWriteTokens, 0);
  assert.equal(known.reported, true);

  const explicit = parseZenResponsesUsage({
    usage: {
      input_tokens: 182,
      output_tokens: 544,
      cached_write_tokens: 7,
    },
  });
  assert.equal(explicit.cachedWriteTokens, 7);

  const emptyUsage = parseZenResponsesUsage({ usage: {} });
  assert.equal(emptyUsage.cachedWriteTokens, null);
  assert.equal(emptyUsage.reported, false);

  const absentUsage = parseZenResponsesUsage({});
  assert.equal(absentUsage.cachedWriteTokens, null);
  assert.equal(absentUsage.reported, false);
});

test("ODL-REQ-037 leaves capability output ceilings and fail-closed policy untouched", async () => {
  const ceilingSource = await readFile(new URL("../src/visual-classifier-capability-output-ceilings.ts", import.meta.url), "utf8");
  assert.match(ceilingSource, /text_structured_output:\s*128/);
  assert.match(ceilingSource, /vision_unstructured:\s*1024/);
  assert.match(ceilingSource, /vision_structured_output:\s*1024/);

  const capabilitySource = await readFile(new URL("../src/visual-classifier-capability-zen-responses.ts", import.meta.url), "utf8");
  assert.match(capabilitySource, /retries:\s*\{\s*limit:\s*0/);
  assert.doesNotMatch(capabilitySource, /2\s*(?:of|\/)\s*3|mandatoryFeatureMatchCount\s*>=\s*2/i);
});
