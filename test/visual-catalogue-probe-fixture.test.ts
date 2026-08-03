import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH, OPENCODE_VISION_PROBE_JPEG_SHA256, syntheticVisionProbeJpegBytes } from "../src/visual-catalogue-probe-fixture";

test("OpenCode vision probe is a deterministic bounded JPEG", () => {
  const bytes = syntheticVisionProbeJpegBytes();
  assert.equal(bytes.byteLength, OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH);
  assert.deepEqual([...bytes.slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...bytes.slice(-2)], [0xff, 0xd9]);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), OPENCODE_VISION_PROBE_JPEG_SHA256);
});
