import test from "node:test";
import assert from "node:assert/strict";
import { RENDER_CACHE_MAX_BYTES, renderCacheSizeAccepted } from "../src/auth-state";

test("render cache admits the fixed 27,389,891-byte calibration PDF", () => {
  assert.equal(RENDER_CACHE_MAX_BYTES, 32 * 1024 * 1024);
  assert.equal(renderCacheSizeAccepted(27_389_891), true);
});

test("render cache remains fail-closed outside its bounded size envelope", () => {
  assert.equal(renderCacheSizeAccepted(4), false);
  assert.equal(renderCacheSizeAccepted(RENDER_CACHE_MAX_BYTES), true);
  assert.equal(renderCacheSizeAccepted(RENDER_CACHE_MAX_BYTES + 1), false);
  assert.equal(renderCacheSizeAccepted(10.5), false);
});
