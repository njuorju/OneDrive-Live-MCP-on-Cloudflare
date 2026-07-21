import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectBlockedMove } from "../src/integrity-blocked-move-reconcile.js";

const source = readFileSync(new URL("../src/integrity-blocked-move-reconcile.ts", import.meta.url), "utf8");

function move(actionId: string, operationOrder: number) {
  return {
    actionId,
    action: "MOVE",
    sourceItemId: `${actionId}-item`,
    sourcePath: `scope/${actionId}.txt`,
    destinationPath: "scope/destination",
    currentFilename: `${actionId}.txt`,
    operationOrder,
    dependencies: [],
  } as any;
}

test("selects a failed move before a dependency-skipped move", () => {
  const failed = move("FAILED", 2);
  const skipped = move("SKIPPED", 1);
  const plan = {
    actions: [skipped, failed],
    completedActions: [],
    failedActions: [{ actionId: "FAILED", code: "path_conflict", message: "stale" }],
    skippedDependencyActions: ["SKIPPED"],
  } as any;
  assert.equal(selectBlockedMove(plan), failed);
});

test("ignores completed and ordinary ready moves", () => {
  const completed = move("DONE", 1);
  const ready = move("READY", 2);
  const plan = {
    actions: [completed, ready],
    completedActions: ["DONE"],
    failedActions: [],
    skippedDependencyActions: [],
  } as any;
  assert.equal(selectBlockedMove(plan), null);
});

test("blocked move reconciliation is exact-path, stable-ID, hash verified and read-only", () => {
  assert.match(source, /resolveConfiguredRoot/);
  assert.match(source, /encodeGraphPath/);
  assert.match(source, /item\.id !== action\.sourceItemId/);
  assert.match(source, /verifyHash/);
  assert.match(source, /snapshotSha256/);
  assert.match(source, /mutationPerformed: false/);
  assert.doesNotMatch(source, /moveVerifiedItemStrict|method:\s*"PATCH"/);
});

test("ordinary execution delegates through the downstream reconciliation layer", () => {
  assert.match(source, /return executeIntegrityPlanWithDownstreamReconciliation\(context, input\)/);
});
