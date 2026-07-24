import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyStructuredPatchText,
  assertExpectedETag,
  semanticCatalogueDigest,
  verifyCataloguePairParity,
  type StructuredPatch,
} from "../src/structured-catalogue";
import { sha256Bytes } from "../src/integrated-core";
import { buildPreparedPlanActions } from "../src/structured-preparation-store";
import { canonicalJson, sha256HexUtf8 } from "../src/paid-core";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const patches: StructuredPatch[] = [{
  recordKey: "2",
  expected: { status: "old" },
  set: { status: "new" },
  clear: ["obsolete"],
  appendNote: { field: "notes", note: "reviewed", separator: "; " },
}];

const csvSource = "id,name,status,obsolete,notes\r\n1,Alpha,ok,x,keep\r\n2,Beta,old,y,existing\r\n";
const jsonSource = JSON.stringify([
  { id: "1", name: "Alpha", status: "ok", obsolete: "x", notes: "keep" },
  { id: "2", name: "Beta", status: "old", obsolete: "y", notes: "existing" },
]);

test("CSV and JSON are patched from one semantic patch set", () => {
  const csv = applyStructuredPatchText(encoder.encode(csvSource), "csv", "id", patches);
  const json = applyStructuredPatchText(encoder.encode(jsonSource), "json", "id", patches);
  assert.doesNotThrow(() => verifyCataloguePairParity(csv.records, json.records, "id"));
  assert.equal(csv.records[1].status, "new");
  assert.equal(json.records[1].status, "new");
});

test("unrelated values and record order are preserved", () => {
  const result = applyStructuredPatchText(encoder.encode(csvSource), "csv", "id", patches);
  assert.equal(result.records[0].name, "Alpha");
  assert.deepEqual(result.records.map((record) => record.id), ["1", "2"]);
});

test("CSV column order and valid quoting are preserved", () => {
  const quoted = applyStructuredPatchText(
    encoder.encode("id,name,status,obsolete,notes\n1,A,old,x,base\n"),
    "csv",
    "id",
    [{ recordKey: "1", set: { name: "A, B" }, appendNote: { field: "notes", note: "line\n2" } }],
  );
  const text = decoder.decode(quoted.bytes);
  assert.ok(text.startsWith("id,name,status,obsolete,notes\n"));
  assert.match(text, /"A, B"/);
  assert.match(text, /"base\nline\n2"/);
});

test("repeated preparation bytes and hashes are deterministic", async () => {
  const first = applyStructuredPatchText(encoder.encode(csvSource), "csv", "id", patches);
  const second = applyStructuredPatchText(encoder.encode(csvSource), "csv", "id", patches);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(await sha256Bytes(first.bytes), await sha256Bytes(second.bytes));
});

test("an exact note is appended only once", () => {
  const first = applyStructuredPatchText(encoder.encode(csvSource), "csv", "id", patches);
  const second = applyStructuredPatchText(first.bytes, "csv", "id", [{ recordKey: "2", appendNote: { field: "notes", note: "reviewed", separator: "; " } }]);
  assert.equal(second.records[1].notes, "existing; reviewed");
});

test("stale expected values are rejected", () => {
  assert.throws(
    () => applyStructuredPatchText(encoder.encode(csvSource), "csv", "id", [{ recordKey: "2", expected: { status: "different" }, set: { status: "new" } }]),
    /expected value/,
  );
});

test("stale eTags are rejected", () => {
  assert.throws(() => assertExpectedETag('"old"', '"new"'), /eTag changed/);
  assert.equal(assertExpectedETag('"same"', '"same"'), '"same"');
});

test("malformed and duplicate-key catalogues are rejected", () => {
  assert.throws(() => applyStructuredPatchText(encoder.encode("id,name\n1,A\n1,B\n"), "csv", "id", [{ recordKey: "1", set: { name: "C" } }]), /more than once/);
  assert.throws(() => applyStructuredPatchText(encoder.encode("id,name\n1,\"broken\n"), "csv", "id", [{ recordKey: "1", set: { name: "C" } }]), /unterminated/);
});

test("CSV and JSON semantic mismatches are rejected", () => {
  const csv = applyStructuredPatchText(encoder.encode(csvSource), "csv", "id", patches);
  const json = applyStructuredPatchText(encoder.encode(jsonSource), "json", "id", patches);
  json.records[0].name = "Changed";
  assert.throws(() => verifyCataloguePairParity(csv.records, json.records, "id"), /not semantically equivalent/);
});

test("identical preparation identity material is idempotent", async () => {
  const material = { version: 1, recordKeyField: "id", patches, sourceETag: '"etag"' };
  assert.equal(await sha256HexUtf8(canonicalJson(material)), await sha256HexUtf8(canonicalJson({ sourceETag: '"etag"', patches, recordKeyField: "id", version: 1 })));
});

test("commit actions contain exact prepared UTF-8 content and immutable evidence", async () => {
  const prepared = applyStructuredPatchText(encoder.encode(csvSource), "csv", "id", patches);
  const content = decoder.decode(prepared.bytes);
  const hash = await sha256Bytes(prepared.bytes);
  const definition = {
    version: 1 as const,
    kind: "single" as const,
    preparationId: `prep_${"a".repeat(48)}`,
    fingerprint: "b".repeat(64),
    fingerprintMaterial: {},
    createdAt: new Date(0).toISOString(),
    recordKeyField: "id",
    patches,
    semanticDigest: null,
    items: [{
      role: "single" as const,
      itemId: "item",
      relativePath: "catalogue.csv",
      filename: "catalogue.csv",
      sourceETag: '"etag"',
      sourceSha256: "c".repeat(64),
      format: "csv" as const,
      outputSha256: hash,
      outputByteLength: prepared.bytes.byteLength,
      artifactKey: "private/key",
      diff: prepared.diffs,
      preview: prepared.preview,
    }],
    oneDriveMutationPerformed: false as const,
  };
  const actions = buildPreparedPlanActions(definition, [content], "reason", "prepared");
  assert.equal(actions[0].content, content);
  assert.equal((actions[0].evidence as Record<string, unknown>).preparedSha256, hash);
  assert.equal(actions[0].action, "REPLACE_TEXT");
});

test("preparation and commit code contain no OneDrive mutation path", () => {
  const source = ["structured-preparation.ts", "structured-preparation-store.ts"].map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(source, /replaceTextFileStrict|replaceVerifiedTextFileStrict|renameItemStrict|moveItemStrict|execute_integrity_plan|validate_integrity_plan/);
  assert.match(source, /create_integrity_plan/);
  assert.match(source, /oneDriveMutationPerformed: false/);
  assert.match(source, /ARTIFACTS/);
});

test("semantic digest is stable across property order", () => {
  const left = [{ id: "1", b: "2", a: "1" }];
  const right = [{ a: "1", id: "1", b: "2" }];
  assert.equal(semanticCatalogueDigest(left, "id"), semanticCatalogueDigest(right, "id"));
});
