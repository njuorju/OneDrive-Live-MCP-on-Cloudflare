import test from "node:test";
import assert from "node:assert/strict";
import { assertPreparationFingerprint, composePreparedPlanActions } from "../src/prepared-plan-composition";
import { buildPreparedPlanActions } from "../src/structured-preparation-store";

test("legacy prepared commit action builder remains unchanged for a pair", () => {
  const definition: any = {
    preparationId: `prep_${"a".repeat(48)}`,
    fingerprint: "b".repeat(64),
    semanticDigest: "c".repeat(64),
    items: [
      { role: "csv", itemId: "csv", relativePath: "scope/legal_sources.csv", filename: "legal_sources.csv", sourceETag: "\"csv\"", sourceSha256: "1".repeat(64), outputSha256: "2".repeat(64), outputByteLength: 48643, diff: [] },
      { role: "json", itemId: "json", relativePath: "scope/legal_sources.json", filename: "legal_sources.json", sourceETag: "\"json\"", sourceSha256: "3".repeat(64), outputSha256: "4".repeat(64), outputByteLength: 93630, diff: [] },
    ],
  };
  const actions = buildPreparedPlanActions(definition, ["csv-bytes", "json-bytes"], "reason", "prepared");
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((action) => action.actionId), ["prepared-csv-1", "prepared-json-2"]);
  assert.deepEqual(actions.map((action) => action.dependencies), [[], []]);
  assert.deepEqual(actions.map((action) => action.content), ["csv-bytes", "json-bytes"]);
});

const renames = Array.from({ length: 18 }, (_, index) => ({
  actionId: `KGZ_LEGAL_RENAME_${String(index + 1).padStart(3, "0")}`,
  action: "RENAME",
  sourceItemId: `item-${index + 1}`,
  sourcePath: `UCA/Modules/03_Source_Library/Legal/Kyrgyzstan/National/source-${index + 1}.docx`,
  currentFilename: `source-${index + 1}.docx`,
  proposedFilename: `target-${index + 1}.docx`,
  snapshotETag: `\"etag-${index + 1}\"`,
  snapshotSha256: String(index).padStart(64, "0"),
  dependencies: [],
}));
const preparedItems = [{ role: "csv" as const }, { role: "json" as const }];
const preparedActions = [
  { actionId: "old-csv", action: "REPLACE_TEXT", sourcePath: "UCA/Modules/03_Source_Library/Legal/legal_sources.csv", content: "csv", evidence: { preparedSha256: "a".repeat(64), preparedByteLength: 48643 }, dependencies: [] },
  { actionId: "old-json", action: "REPLACE_TEXT", sourcePath: "UCA/Modules/03_Source_Library/Legal/legal_sources.json", content: "json", evidence: { preparedSha256: "b".repeat(64), preparedByteLength: 93630 }, dependencies: [] },
];
const csvId = "KGZ_LEGAL_CATALOGUE_CSV";
const jsonId = "KGZ_LEGAL_CATALOGUE_JSON";
const compose = (overrides: Record<string, unknown> = {}) => composePreparedPlanActions({
  scopePath: "UCA/Modules/03_Source_Library/Legal",
  preparedItems,
  preparedActions,
  additionalActions: renames,
  preparedActionIds: { csv: csvId, json: jsonId },
  preparedDependencies: { [csvId]: renames.map((action) => action.actionId), [jsonId]: [csvId] },
  ...overrides,
} as any);

test("composes exactly 18 renames and two prepared replacements", () => {
  const actions = compose();
  assert.equal(actions.length, 20);
  assert.equal(actions.filter((action) => action.action === "RENAME").length, 18);
  assert.equal(actions.filter((action) => action.action === "REPLACE_TEXT").length, 2);
  assert.deepEqual(actions[18].dependencies, renames.map((action) => action.actionId));
  assert.deepEqual(actions[19].dependencies, [csvId]);
  assert.equal(actions[18].content, "csv");
  assert.equal(actions[19].content, "json");
  assert.deepEqual(actions[18].evidence, preparedActions[0].evidence);
  assert.deepEqual(actions[19].evidence, preparedActions[1].evidence);
});

test("rejects inline content and caller payload-bearing actions", () => {
  assert.throws(() => compose({ additionalActions: [{ ...renames[0], content: "forbidden" }] }), /inline payload/);
  assert.throws(() => compose({ additionalActions: [{ ...renames[0], action: "REPLACE_TEXT" }] }), /Only RENAME/);
  assert.throws(() => compose({ additionalActions: [{ ...renames[0], action: "CREATE_TEXT" }] }), /Only RENAME/);
});

test("rejects duplicate IDs, unknown dependencies, and cycles", () => {
  assert.throws(() => compose({ additionalActions: [renames[0], { ...renames[1], actionId: renames[0].actionId }] }), /Duplicate action ID/);
  assert.throws(() => compose({ preparedDependencies: { [csvId]: ["missing"], [jsonId]: [csvId] } }), /unknown action/);
  assert.throws(() => compose({ preparedDependencies: { [csvId]: [jsonId], [jsonId]: [csvId] } }), /cycle/);
});

test("rejects out-of-scope paths and stale fingerprints", () => {
  assert.throws(() => compose({ additionalActions: [{ ...renames[0], sourcePath: "UCA/Modules/04_Visual_Library/file.docx" }] }), /declared scope/);
  assert.throws(() => assertPreparationFingerprint({ fingerprint: "a".repeat(64) }, "b".repeat(64)), /fingerprint/);
  assert.doesNotThrow(() => assertPreparationFingerprint({ fingerprint: "a".repeat(64) }, "a".repeat(64)));
});

test("composition source has no Microsoft Graph mutation path", async () => {
  const { readFileSync } = await import("node:fs");
  const source = ["prepared-plan-composition.ts", "composed-prepared-plan.ts"].map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(source, /replaceTextFileStrict|renameItemStrict|moveItemStrict|execute_integrity_plan|validate_integrity_plan/);
  assert.match(source, /create_integrity_plan/);
  assert.match(source, /oneDriveMutationPerformed: false/);
});
