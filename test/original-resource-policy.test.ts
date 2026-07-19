import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { originalResourceUri } from "../src/original-resource.ts";

describe("original-file resource URI", () => {
  it("preserves opaque item ID case in the path", () => {
    const itemId = "01AbCDefGhIJ-KLmN_opQR";
    const uri = new URL(originalResourceUri(itemId, '"etag-1"'));
    assert.equal(uri.protocol, "onedrive-original:");
    assert.equal(uri.hostname, "");
    assert.equal(decodeURIComponent(uri.pathname.slice("/items/".length)), itemId);
    assert.equal(uri.searchParams.get("etag"), '"etag-1"');
  });

  it("does not put the item ID in a lowercased hostname", () => {
    const uri = new URL(originalResourceUri("CaseSensitiveID", null));
    assert.equal(uri.host, "");
    assert.equal(uri.pathname, "/items/CaseSensitiveID");
  });
});
