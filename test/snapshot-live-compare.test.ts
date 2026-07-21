import test from "node:test";
import assert from "node:assert/strict";
import { snapshotRecordSizeChanged } from "../src/integrated-tools.js";

test("ignores aggregate live sizes for folders", () => {
  assert.equal(
    snapshotRecordSizeChanged(
      { type: "folder", byteSize: null },
      { type: "folder", byteSize: 853_889_608 },
    ),
    false,
  );
});

test("detects actual file byte-size changes", () => {
  assert.equal(
    snapshotRecordSizeChanged(
      { type: "file", byteSize: 100 },
      { type: "file", byteSize: 101 },
    ),
    true,
  );
});

test("does not report unchanged files or cross-type records as size changes", () => {
  assert.equal(snapshotRecordSizeChanged({ type: "file", byteSize: 100 }, { type: "file", byteSize: 100 }), false);
  assert.equal(snapshotRecordSizeChanged({ type: "folder", byteSize: null }, { type: "file", byteSize: 100 }), false);
});
