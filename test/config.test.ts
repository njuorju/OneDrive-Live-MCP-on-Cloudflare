import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRuntimeConfig, validateRequiredConfiguration } from "../src/config.ts";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    MICROSOFT_CLIENT_ID: "client",
    MICROSOFT_CLIENT_SECRET: "secret",
    COOKIE_ENCRYPTION_KEY: "a".repeat(64),
    OWNER_MICROSOFT_ID: "owner",
    ONEDRIVE_ROOT: "Work",
    MAX_FILE_MB: "20",
    MAX_ORIGINAL_FILE_MB: "25",
    MAX_TEXT_WRITE_KB: "512",
    MAX_READ_CHARS: "50000",
    CACHE_TTL_SECONDS: "604800",
    MAX_IMAGE_INPUT_MB: "15",
    MAX_IMAGE_PIXELS: "40000000",
    MAX_IMAGE_DIMENSION: "8192",
    MAX_IMAGE_PAGES: "8",
    IMAGE_PROCESSING_TIMEOUT_MS: "15000",
    ...overrides,
  } as unknown as Env;
}

describe("runtime configuration", () => {
  it("accepts bounded finite defaults", () => {
    const config = getRuntimeConfig(env());
    assert.equal(config.maxFileBytes, 20 * 1024 * 1024);
    assert.equal(config.cacheTtlSeconds, 604800);
  });

  for (const invalid of ["NaN", "Infinity", "-1", "1.5", "999999999"]) {
    it(`rejects malformed CACHE_TTL_SECONDS=${invalid}`, () => {
      assert.throws(() => getRuntimeConfig(env({ CACHE_TTL_SECONDS: invalid })), /Configuration CACHE_TTL_SECONDS/);
    });
  }

  it("allows zero only for disabling cache", () => {
    assert.equal(getRuntimeConfig(env({ CACHE_TTL_SECONDS: "0" })).cacheTtlSeconds, 0);
    assert.throws(() => getRuntimeConfig(env({ MAX_FILE_MB: "0" })), /MAX_FILE_MB/);
  });

  it("rejects missing required secret/config references", () => {
    assert.throws(() => validateRequiredConfiguration(env({ MICROSOFT_CLIENT_SECRET: "" })), /MICROSOFT_CLIENT_SECRET/);
    assert.throws(() => validateRequiredConfiguration(env({ ONEDRIVE_ROOT: "" })), /ONEDRIVE_ROOT/);
  });
});
