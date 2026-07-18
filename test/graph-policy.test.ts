import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasRequiredGraphScope,
  safeCacheKey,
  strictRelativePath,
  validateItemName,
} from "../src/graph-core.ts";

describe("Microsoft scope enforcement", () => {
  it("accepts delegated Files.ReadWrite", () => {
    assert.equal(hasRequiredGraphScope("openid offline_access Files.ReadWrite User.Read"), true);
    assert.equal(hasRequiredGraphScope("https://graph.microsoft.com/Files.ReadWrite https://graph.microsoft.com/User.Read"), true);
  });

  it("rejects stale Files.Read consent", () => {
    assert.equal(hasRequiredGraphScope("openid offline_access Files.Read User.Read"), false);
  });
});

describe("relative path boundary policy", () => {
  it("normalizes safe relative paths", () => {
    assert.equal(strictRelativePath("Projects/Maps"), "Projects/Maps");
    assert.equal(strictRelativePath(""), "");
  });

  for (const path of ["../secret", "%2e%2e/secret", "%252e%252e/secret", "C:/secret", "https://example.test/x", "/absolute", "safe/ ../x"]) {
    it(`rejects ${path}`, () => {
      assert.throws(() => strictRelativePath(path));
    });
  }

  it("rejects deceptive whitespace and backslash traversal", () => {
    assert.throws(() => strictRelativePath(" safe/file"));
    assert.throws(() => strictRelativePath("..\\secret"));
  });
});

describe("OneDrive item names", () => {
  it("accepts ordinary Unicode names", () => {
    assert.equal(validateItemName("Карта Алматы.md"), "Карта Алматы.md");
  });

  for (const name of ["", "..", "a/b", "a\\b", "CON.txt", "bad?.md", "trailing. "]) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      assert.throws(() => validateItemName(name));
    });
  }
});

describe("cache key sanitization", () => {
  it("contains no item ID, eTag, token, or account identifier", async () => {
    const key = await safeCacheKey("item-123", "etag-owner-token");
    assert.match(key, /^doc-cache:v2:[0-9a-f]{64}$/);
    assert.doesNotMatch(key, /item-123|etag|owner|token/);
  });
});
