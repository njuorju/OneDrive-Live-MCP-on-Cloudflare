import { readFile, writeFile } from "node:fs/promises";

const sourcePath = "src/integrated-tools.ts";
let source = await readFile(sourcePath, "utf8");
const startMarker = "async function diffScopeBeforeAfter(context: IntegratedContext, planId: string): Promise<Record<string, unknown>> {";
const endMarker = "\n}\n\nfunction classifyAdministrative(";

if (source.includes("export function reconstructAuditLiveRecords(")) {
  console.log("AUDIT_PATCH_ALREADY_APPLIED");
} else {
  const start = source.indexOf(startMarker);
  const endStart = source.indexOf(endMarker, start);
  if (start < 0 || endStart < 0) throw new Error("audit function markers not found");
  const end = endStart + 2;
  const replacement = `export function reconstructAuditLiveRecords(snapshot: SnapshotRecord[], comparison: Record<string, unknown>): SnapshotRecord[] {
  const removedIds = new Set(((comparison.removedItems ?? []) as SnapshotRecord[]).map((record) => record.itemId));
  const movedPaths = new Map(((comparison.movedOrRenamedItems ?? []) as Array<{ itemId: string; after: string }>).map((entry) => [entry.itemId, entry.after]));
  const changedETags = new Map(((comparison.changedETags ?? []) as Array<{ itemId: string; after: string | null }>).map((entry) => [entry.itemId, entry.after]));
  const changedSizes = new Map(((comparison.changedSizes ?? []) as Array<{ itemId: string; after: number | null }>).map((entry) => [entry.itemId, entry.after]));
  const records = snapshot.filter((record) => !removedIds.has(record.itemId)).map((record) => {
    const relativePath = movedPaths.get(record.itemId) ?? record.relativePath;
    return {
      ...record,
      relativePath,
      filename: relativePath.split("/").pop() ?? record.filename,
      eTag: changedETags.has(record.itemId) ? changedETags.get(record.itemId) ?? null : record.eTag,
      byteSize: changedSizes.has(record.itemId) ? changedSizes.get(record.itemId) ?? null : record.byteSize,
    };
  });
  const seen = new Set(records.map((record) => record.itemId));
  for (const added of (comparison.addedItems ?? []) as SnapshotRecord[]) {
    if (!seen.has(added.itemId)) {
      records.push(added);
      seen.add(added.itemId);
    }
  }
  const folderIdByPath = new Map(records.filter((record) => record.type === "folder").map((record) => [record.relativePath, record.itemId]));
  return records.map((record) => {
    const parentPath = record.relativePath.split("/").slice(0, -1).join("/");
    return { ...record, parentItemId: folderIdByPath.get(parentPath) ?? record.parentItemId };
  });
}

export function auditDuplicateHashGroups(
  snapshot: SnapshotRecord[],
  live: SnapshotRecord[],
  comparison: Record<string, unknown>,
): { groups: Array<{ hash: string; members: SnapshotRecord[] }>; knownHashCount: number; totalFileCount: number } {
  const snapshotById = new Map(snapshot.map((record) => [record.itemId, record]));
  const changedHashes = new Map(((comparison.changedSha256 ?? []) as Array<{ itemId: string; after: string }>).map((entry) => [entry.itemId, entry.after]));
  const byHash = new Map<string, SnapshotRecord[]>();
  let knownHashCount = 0;
  const files = live.filter((record) => record.type === "file");
  for (const record of files) {
    const hash = changedHashes.get(record.itemId) ?? snapshotById.get(record.itemId)?.sha256 ?? record.sha256;
    if (!hash) continue;
    knownHashCount += 1;
    const group = byHash.get(hash) ?? [];
    group.push(record);
    byHash.set(hash, group);
  }
  return {
    groups: [...byHash.entries()].filter(([, members]) => members.length > 1).map(([hash, members]) => ({ hash, members })),
    knownHashCount,
    totalFileCount: files.length,
  };
}

async function diffScopeBeforeAfter(context: IntegratedContext, planId: string): Promise<Record<string, unknown>> {
  const plan = await getPlan(context, planId);
  const comparison = await compareSnapshotToLive(context, plan.snapshotId);
  const operationLogs = await context.storage.list<Record<string, unknown>>({ prefix: \`integrated:operation:\${plan.planId}:\` });
  const modifiedOperations = [...operationLogs.values()].filter((record) => record.state === "completed");
  const outsideScopeOperations = modifiedOperations.filter((record) => {
    const before = record.before as CompactItem | undefined;
    const after = record.after as CompactItem | undefined;
    return (before && !scopeContains(plan.scopePath, before.relativePath)) || (after && !scopeContains(plan.scopePath, after.relativePath));
  });
  const snapshotRecords = await listSnapshotRecords(context, plan.snapshotId);
  const live = reconstructAuditLiveRecords(snapshotRecords, comparison);
  const parentCounts = new Map<string, number>();
  for (const record of live) if (record.parentItemId) parentCounts.set(record.parentItemId, (parentCounts.get(record.parentItemId) ?? 0) + 1);
  const duplicateHashEvidence = auditDuplicateHashGroups(snapshotRecords, live, comparison);
  const classification = classifyAdministrative(live, ADMIN_DEFAULT_PATTERNS, ["_Catalogue"]);
  const removedItems = comparison.removedItems as SnapshotRecord[];
  const changedETags = comparison.changedETags as Array<Record<string, unknown>>;
  return {
    planId,
    scopePath: plan.scopePath,
    expectedChanges: plan.actions.filter((action) => !["KEEP", "METADATA_ONLY", "CATALOGUE_ONLY"].includes(action.action)),
    unexpectedChanges: {
      addedItems: comparison.addedItems,
      removedItems: removedItems.filter((record) => !plan.actions.some((action) => action.sourceItemId === record.itemId && actionIsDestructive(action))),
      changedETags: changedETags.filter((change) => !plan.actions.some((action) => action.sourceItemId === change.itemId)),
    },
    unchangedItems: snapshotRecords.length - removedItems.length - changedETags.length,
    additions: comparison.addedItems,
    removals: comparison.removedItems,
    renamesAndMoves: comparison.movedOrRenamedItems,
    recycledItems: plan.results.filter((result) => result.recycled === true),
    hashChanges: comparison.changedSha256,
    catalogueChanges: plan.actions.filter((action) => ["CREATE_TEXT", "REPLACE_TEXT", "CATALOGUE_ONLY"].includes(action.action)),
    administrativeFiles: classification.administrative,
    substantiveFiles: classification.substantive,
    emptyFolders: live.filter((record) => record.type === "folder" && !parentCounts.has(record.itemId)),
    duplicateHashes: duplicateHashEvidence.groups,
    duplicateHashCoverage: {
      knownHashCount: duplicateHashEvidence.knownHashCount,
      totalFileCount: duplicateHashEvidence.totalFileCount,
      complete: duplicateHashEvidence.knownHashCount === duplicateHashEvidence.totalFileCount,
      source: "snapshot_and_changed-file_comparison",
    },
    changesOutsideScope: outsideScopeOperations,
    proof: {
      allMutationOperationsRecorded: plan.completedActions.every((actionId) => plan.results.some((result) => result.actionId === actionId)),
      outsideScopeOperationCount: outsideScopeOperations.length,
      rootAncestryRevalidatedPerOperation: true,
      operationLogCount: operationLogs.size,
      liveEnumerationCount: 1,
      secondLiveTraversalAvoided: true,
    },
  };
}`;
  source = source.slice(0, start) + replacement + source.slice(end);
  await writeFile(sourcePath, source, "utf8");
}

const testPath = "test/integrity-free-plan.test.ts";
let tests = await readFile(testPath, "utf8");
const importLine = 'import { auditDuplicateHashGroups, reconstructAuditLiveRecords } from "../src/integrated-tools.js";\n';
if (!tests.includes(importLine)) {
  tests = tests.replace('import type { VerifiedItem } from "../src/graph-core.js";\n', 'import type { VerifiedItem } from "../src/graph-core.js";\n' + importLine);
}
if (!tests.includes("audit reconstruction avoids a second live traversal")) {
  tests += `\n\ntest("audit reconstruction avoids a second live traversal and reuses snapshot hashes", () => {\n  const folderFrom = { itemId: "from", filename: "from", relativePath: "scope/from", type: "folder", parentItemId: "scope", sha256: null, eTag: '\"from\",1', byteSize: null } as any;\n  const folderTo = { itemId: "to", filename: "to", relativePath: "scope/to", type: "folder", parentItemId: "scope", sha256: null, eTag: '\"to\",1', byteSize: null } as any;\n  const first = { itemId: "a", filename: "a.txt", relativePath: "scope/from/a.txt", type: "file", parentItemId: "from", sha256: "same", eTag: '\"a\",1', byteSize: 10 } as any;\n  const second = { itemId: "b", filename: "b.txt", relativePath: "scope/from/b.txt", type: "file", parentItemId: "from", sha256: "same", eTag: '\"b\",1', byteSize: 10 } as any;\n  const snapshot = [folderFrom, folderTo, first, second];\n  const comparison = { addedItems: [], removedItems: [], changedSizes: [], changedSha256: [], movedOrRenamedItems: [{ itemId: "a", before: "scope/from/a.txt", after: "scope/to/a.txt" }], changedETags: [{ itemId: "a", before: '\"a\",1', after: '\"a\",2' }] };\n  const live = reconstructAuditLiveRecords(snapshot, comparison);\n  const moved = live.find((record) => record.itemId === "a")!;\n  assert.equal(moved.relativePath, "scope/to/a.txt");\n  assert.equal(moved.parentItemId, "to");\n  assert.equal(moved.eTag, '\"a\",2');\n  const duplicates = auditDuplicateHashGroups(snapshot, live, comparison);\n  assert.equal(duplicates.knownHashCount, 2);\n  assert.equal(duplicates.totalFileCount, 2);\n  assert.equal(duplicates.groups.length, 1);\n  assert.deepEqual(duplicates.groups[0].members.map((record) => record.itemId).sort(), ["a", "b"]);\n});\n`;
  await writeFile(testPath, tests, "utf8");
}

if (process.argv.includes("--emit-base64")) {
  const patched = await readFile(sourcePath);
  console.log(`PATCHED_SOURCE_BASE64_BEGIN${patched.toString("base64")}PATCHED_SOURCE_BASE64_END`);
}
