import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findDeclaredDownstreamMove } from "../src/integrity-downstream-reconcile.js";

const source = readFileSync(new URL("../src/integrity-downstream-reconcile.ts", import.meta.url), "utf8");

function action(overrides: Record<string, unknown>) {
  return {
    actionId: "RENAME",
    action: "RENAME",
    sourceItemId: "stable-item",
    sourcePath: "scope/original.txt",
    proposedFilename: "renamed.txt",
    operationOrder: 1,
    dependencies: [],
    ...overrides,
  } as any;
}

test("finds the declared dependent move for the same stable item", () => {
  const rename = action({});
  const move = action({
    actionId: "MOVE",
    action: "MOVE",
    destinationPath: "scope/destination",
    operationOrder: 2,
    dependencies: ["RENAME"],
  });
  const plan = { actions: [rename, move] } as any;
  assert.equal(findDeclaredDownstreamMove(plan, rename), move);
});

test("does not accept an unrelated or undeclared move", () => {
  const rename = action({});
  const unrelated = action({
    actionId: "MOVE",
    action: "MOVE",
    sourceItemId: "other-item",
    destinationPath: "scope/destination",
    operationOrder: 2,
    dependencies: ["RENAME"],
  });
  assert.equal(findDeclaredDownstreamMove({ actions: [rename, unrelated] } as any, rename), null);
});

test("downstream reconciliation verifies stable identity, destination, filename and hash before success", () => {
  assert.match(source, /verifyItemInsideRoot/);
  assert.match(source, /live\.item\.name !== action\.proposedFilename/);
  assert.match(source, /liveParent !== expectedParent/);
  assert.match(source, /verifySnapshotHash/);
  assert.match(source, /mutationPerformed: false/);
});

test("the override delegates ordinary execution to the validated repair", () => {
  assert.match(source, /return executeIntegrityPlanRepair\(context, input\)/);
});
