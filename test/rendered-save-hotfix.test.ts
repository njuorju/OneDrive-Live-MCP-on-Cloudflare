import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertNonBlankPixelStatistics,
  type RenderPixelStatistics,
} from "../src/rendered-save-hotfix";

function statistics(overrides: Partial<RenderPixelStatistics> = {}): RenderPixelStatistics {
  return {
    sampleWidth: 128,
    sampleHeight: 128,
    sampledPixels: 16_384,
    opaquePixels: 16_384,
    transparentPixels: 0,
    nearWhitePixels: 15_900,
    nearBlackPixels: 0,
    nonWhitePixels: 484,
    luminanceMinimum: 20,
    luminanceMaximum: 255,
    luminanceVariance: 120,
    alphaMinimum: 255,
    alphaMaximum: 255,
    ...overrides,
  };
}

test("rendered-save blank validation rejects transparent, white, black and zero-variance samples", () => {
  for (const sample of [
    statistics({ opaquePixels: 0, transparentPixels: 16_384, nearWhitePixels: 0, nonWhitePixels: 0, alphaMinimum: 0, alphaMaximum: 0 }),
    statistics({ nearWhitePixels: 16_384, nonWhitePixels: 0, luminanceMinimum: 255, luminanceMaximum: 255, luminanceVariance: 0 }),
    statistics({ nearWhitePixels: 0, nearBlackPixels: 16_384, nonWhitePixels: 16_384, luminanceMinimum: 0, luminanceMaximum: 0, luminanceVariance: 0 }),
    statistics({ nearWhitePixels: 0, nearBlackPixels: 0, nonWhitePixels: 16_384, luminanceMinimum: 127, luminanceMaximum: 128, luminanceVariance: 0.1 }),
  ]) {
    assert.throws(() => assertNonBlankPixelStatistics(sample), (error: unknown) => {
      return Boolean(error && typeof error === "object" && "code" in error && error.code === "render_blank");
    });
  }
});

test("rendered-save blank validation permits a normal light report page", () => {
  assert.doesNotThrow(() => assertNonBlankPixelStatistics(statistics()));
});

test("rendered saves use the proven renderer, decoded pixels, conflict-fail upload and exact read-back", () => {
  const source = readFileSync(new URL("../src/rendered-save-hotfix.ts", import.meta.url), "utf8");
  assert.match(source, /const rendered = await renderHandler/);
  assert.match(source, /renderedPixelStatistics/);
  assert.match(source, /conflictBehavior=fail/);
  assert.match(source, /If-None-Match/);
  assert.match(source, /readBackSha256/);
  assert.match(source, /render_page_mismatch/);
  assert.match(source, /unsupported_visual_id/);
  assert.doesNotMatch(source, /<embed|data:application\/pdf/);
});
