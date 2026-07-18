import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAllowedOriginalFile,
  isAllowedTextFile,
  isVisualAsset,
  normalizedMimeType,
  validateFileSignature,
} from "../src/file-types.ts";

function bytes(values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

describe("file type policy", () => {
  it("allowlists required originals", () => {
    for (const name of ["photo.jpg", "map.png", "deck.pptx", "template.potx", "doc.docx", "sheet.xlsx", "data.csv", "code.ts"]) {
      assert.equal(isAllowedOriginalFile(name), true, name);
    }
  });

  it("limits text writes to text extensions", () => {
    assert.equal(isAllowedTextFile("notes.md"), true);
    assert.equal(isAllowedTextFile("config.json"), true);
    assert.equal(isAllowedTextFile("deck.pptx"), false);
  });

  it("recognizes visual discovery formats", () => {
    for (const name of ["a.jpg", "a.heic", "a.tiff", "a.svg", "a.emf", "a.wmf"]) {
      assert.equal(isVisualAsset(name), true, name);
    }
  });

  it("validates JPEG and PNG signatures", () => {
    assert.equal(validateFileSignature("a.jpg", bytes([0xff, 0xd8, 0xff, 0xdb])).compatible, true);
    assert.equal(validateFileSignature("a.png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).compatible, true);
  });

  it("rejects material extension/signature mismatch", () => {
    const result = validateFileSignature("fake.png", bytes([0xff, 0xd8, 0xff, 0xdb]));
    assert.equal(result.compatible, false);
    assert.match(result.reason ?? "", /signature indicates image\/jpeg/);
  });

  it("accepts Office Open XML ZIP signatures", () => {
    assert.equal(validateFileSignature("slides.pptx", bytes([0x50, 0x4b, 0x03, 0x04])).compatible, true);
    assert.equal(validateFileSignature("template.potx", bytes([0x50, 0x4b, 0x03, 0x04])).compatible, true);
  });

  it("normalizes MIME from the allowlisted extension rather than an untrusted upstream value", () => {
    assert.equal(normalizedMimeType("image.png", "text/plain"), "image/png");
  });
});
