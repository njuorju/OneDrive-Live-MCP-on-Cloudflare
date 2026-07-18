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

function zipPackage(...names: string[]): ArrayBuffer {
  const prefix = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
  const labels = new TextEncoder().encode(names.join("\0"));
  const result = new Uint8Array(prefix.length + labels.length);
  result.set(prefix);
  result.set(labels, prefix.length);
  return result.buffer;
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

  it("rejects a material Microsoft MIME mismatch", () => {
    const result = validateFileSignature(
      "fake.png",
      bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "application/pdf",
    );
    assert.equal(result.compatible, false);
    assert.match(result.reason ?? "", /Microsoft metadata indicates application\/pdf/);
  });

  it("accepts Office Open XML packages only when expected package entries exist", () => {
    const presentation = zipPackage("[Content_Types].xml", "ppt/presentation.xml");
    assert.equal(validateFileSignature("slides.pptx", presentation).compatible, true);
    assert.equal(validateFileSignature("template.potx", presentation).compatible, true);
    assert.equal(validateFileSignature("slides.pptx", zipPackage("random.bin")).compatible, false);
    assert.equal(
      validateFileSignature("document.docx", zipPackage("[Content_Types].xml", "word/document.xml")).compatible,
      true,
    );
    assert.equal(
      validateFileSignature("sheet.xlsx", zipPackage("[Content_Types].xml", "xl/workbook.xml")).compatible,
      true,
    );
  });

  it("recognizes common HEIF and WMF signatures", () => {
    const hevc = new Uint8Array(32);
    hevc.set(new TextEncoder().encode("ftyp"), 4);
    hevc.set(new TextEncoder().encode("hevc"), 8);
    assert.equal(validateFileSignature("photo.heif", hevc.buffer).compatible, true);
    assert.equal(validateFileSignature("drawing.wmf", bytes([0x01, 0x00, 0x09, 0x00, 0x00, 0x03])).compatible, true);
  });

  it("normalizes MIME from the allowlisted extension rather than an untrusted upstream value", () => {
    assert.equal(normalizedMimeType("image.png", "text/plain"), "image/png");
  });
});
