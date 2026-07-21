import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { integrityResumeRepairTestHooks } from "../src/integrity-resume-repair.js";

const source = readFileSync(new URL("../src/integrity-resume-repair.ts", import.meta.url), "utf8");
const runnerSource = readFileSync(new URL("../src/snapshot-runner.ts", import.meta.url), "utf8");

function plan() {
  return {
    actions: [
      { actionId: "RENAME", action: "RENAME", operationOrder: 0, dependencies: [] },
      { actionId: "MOVE", action: "MOVE", operationOrder: 1, dependencies: ["RENAME"] },
      { actionId: "RECYCLE_FOLDER", action: "RECYCLE_FOLDER", operationOrder: 2, dependencies: ["MOVE"] },
      { actionId: "INDEPENDENT", action: "MOVE", operationOrder: 3, dependencies: [] },
    ],
    completedActions: [] as string[],
    failedActions: [] as Array<{ actionId: string; code: string; message: string }>,
    skippedDependencyActions: [] as string[],
  } as any;
}

function record(overrides: Record<string, unknown>) {
  return {
    itemId: "item",
    filename: "file.txt",
    relativePath: "scope/from/file.txt",
    type: "file",
    mimeType: "text/plain",
    extension: ".txt",
    byteSize: 10,
    modifiedDate: null,
    eTag: '"item",1',
    snapshotIndex: 0,
    parentItemId: "from",
    createdDate: null,
    sha256: "a".repeat(64),
    normalizedTextSha256: null,
    extractedCharacterCount: null,
    extractionStatus: null,
    representationStatus: null,
    documentMetadata: null,
    error: null,
    ...overrides,
  } as any;
}

test("RENAME followed by MOVE can reactivate its dependent action after reconciliation", () => {
  const state = plan();
  state.failedActions = [{ actionId: "RENAME", code: "path_conflict", message: "stale" }];
  integrityResumeRepairTestHooks.refreshDependencySkips(state);
  assert.deepEqual(state.skippedDependencyActions, ["MOVE", "RECYCLE_FOLDER"]);
  state.failedActions = [];
  state.completedActions = ["RENAME"];
  const changed = integrityResumeRepairTestHooks.refreshDependencySkips(state);
  assert.deepEqual(state.skippedDependencyActions, []);
  assert.deepEqual(changed.reactivated.sort(), ["MOVE", "RECYCLE_FOLDER"]);
});

test("ambiguous invalidRequest is classified for postcondition verification", () => {
  assert.equal(integrityResumeRepairTestHooks.isAmbiguousFailure({
    state: "failed",
    error: { code: "graph_request_failed", status: 400, details: { graphErrorCode: "invalidRequest" } },
  }), true);
});

test("timeouts, 5xx, resource limits, and network failures are ambiguous", () => {
  for (const code of ["graph_timeout", "graph_network_error", "graph_server_error", "graph_subrequest_limit"]) {
    assert.equal(integrityResumeRepairTestHooks.isAmbiguousFailure({ error: { code } }), true, code);
  }
  assert.equal(integrityResumeRepairTestHooks.isAmbiguousFailure({ error: { code: "graph_request_failed", status: 503 } }), true);
});

test("a deterministic conflict is not treated as ambiguous success", () => {
  assert.equal(integrityResumeRepairTestHooks.isAmbiguousFailure({ error: { code: "etag_conflict", status: 412 } }), false);
});

test("already completed MOVE and RENAME are reconciled before any mutation", () => {
  assert.match(source, /const pre = await reconcileIntegrityPlan/);
  assert.match(source, /if \(preReconciled\.length > 0\)[\s\S]*mutationPerformed: false/);
  assert.match(source, /action\.action === "RENAME"/);
  assert.match(source, /action\.action === "MOVE"/);
});

test("stable item ID runtime resolution preserves the original plan evidence", () => {
  assert.match(source, /runtimePathResolvedByStableItemId: true/);
  assert.match(source, /originalSourcePath/);
  assert.match(source, /restoreRuntimeOverride/);
  assert.match(source, /originalPlanAction: action/);
});

test("dependency-skipped RECYCLE_FOLDER becomes ready after its MOVE completes", () => {
  const state = plan();
  state.failedActions = [{ actionId: "MOVE", code: "graph_request_failed", message: "ambiguous" }];
  state.completedActions = ["RENAME"];
  integrityResumeRepairTestHooks.refreshDependencySkips(state);
  assert.deepEqual(state.skippedDependencyActions, ["RECYCLE_FOLDER"]);
  state.failedActions = [];
  state.completedActions.push("MOVE");
  integrityResumeRepairTestHooks.refreshDependencySkips(state);
  assert.deepEqual(state.skippedDependencyActions, []);
});

test("externally missing recycle items fail closed without operation or retained evidence", () => {
  assert.match(source, /discrepancy: "ambiguous_disappearance"/);
  assert.match(source, /operationSupportsIdentity \|\| retainedEvidence/);
  assert.match(source, /dependenciesComplete/);
});

test("reconciliation endpoint is read-only and performs no mutation", () => {
  const start = source.indexOf("export async function reconcileIntegrityPlan");
  const end = source.indexOf("type RuntimeOverride", start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /moveVerifiedItemStrict|renameVerifiedItemStrict|method:\s*"DELETE"|method:\s*"PATCH"/);
  assert.match(source, /mutationPerformed: false/);
});

test("re-running dependency reconciliation is idempotent", () => {
  const state = plan();
  state.failedActions = [{ actionId: "MOVE", code: "x", message: "x" }];
  state.completedActions = ["RENAME"];
  integrityResumeRepairTestHooks.refreshDependencySkips(state);
  const first = [...state.skippedDependencyActions];
  const second = integrityResumeRepairTestHooks.refreshDependencySkips(state);
  assert.deepEqual(state.skippedDependencyActions, first);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.reactivated, []);
});

test("re-running execution after reconciliation does not repeat the mutation", () => {
  assert.match(source, /plan\.completedActions\.includes\(action\.actionId\)/);
  assert.match(source, /plan\.completedActions = uniqueStrings/);
  assert.match(source, /reconciliationOnlyThisInvocation: true/);
});

test("final diff reports additions, removals, rename, move, eTag, size, hash, and folder changes", () => {
  const before = [record({})];
  const after = [record({
    filename: "renamed.txt",
    relativePath: "scope/to/renamed.txt",
    parentItemId: "to",
    eTag: '"item",2',
    byteSize: 11,
    sha256: "b".repeat(64),
  }), record({ itemId: "added", filename: "added.txt", relativePath: "scope/added.txt", parentItemId: "scope" })];
  const diff = integrityResumeRepairTestHooks.classifyDiff(before, after) as any;
  assert.equal(diff.additions.length, 1);
  assert.equal(diff.removals.length, 0);
  assert.equal(diff.renames.length, 1);
  assert.equal(diff.moves.length, 1);
  assert.equal(diff.eTagChanges.length, 1);
  assert.equal(diff.sizeChanges.length, 1);
  assert.equal(diff.hashChanges.length, 1);
  assert.equal(diff.folderStructureChanges.length, 1);
});

test("final diff continues through a persisted resumable snapshot job", () => {
  assert.match(source, /createSourceSnapshot\(context, schedule/);
  assert.match(source, /finalSnapshotJobId/);
  assert.match(source, /getSnapshotJobStatus/);
  assert.match(source, /persistedCursorUsed: true/);
  assert.doesNotMatch(source.slice(source.indexOf("startDiffScopeBeforeAfter")), /enumerateLiveVerified/);
});

test("audit snapshot work is bounded below the Workers Free external-subrequest limit", () => {
  assert.match(runnerSource, /const stepItems = Math\.min/);
  assert.match(source, /boundedGraphRequestsPerContinuation: true/);
});

test("independent later actions are not permanently stranded by an earlier failure", () => {
  const state = plan();
  state.failedActions = [{ actionId: "MOVE", code: "x", message: "x" }];
  state.completedActions = ["RENAME"];
  integrityResumeRepairTestHooks.refreshDependencySkips(state);
  assert.ok(!state.skippedDependencyActions.includes("INDEPENDENT"));
});
