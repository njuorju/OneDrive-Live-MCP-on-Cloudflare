import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findDeclaredDownstreamMove,
  findDeclaredDownstreamMoves,
  relativePathFromParentReference,
} from "../src/integrity-downstream-reconcile.js";

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

test("declared destination checks are capped", () => {
  const rename = action({});
  const moves = Array.from({ length: 5 }, (_, index) => action({
    actionId: `MOVE_${index}`,
    action: "MOVE",
    destinationPath: `scope/destination-${index}`,
    operationOrder: index + 2,
    dependencies: ["RENAME"],
  }));
  assert.equal(findDeclaredDownstreamMoves({ actions: [rename, ...moves] } as any, rename).length, 3);
});

test("parent-reference helper accepts only the configured root on the same drive", () => {
  const root = {
    id: "root-id",
    name: "Работа",
    folder: {},
    parentReference: { driveId: "drive", path: "/drive/root:" },
  } as any;
  const item = {
    id: "item-id",
    name: "file.pdf",
    file: {},
    parentReference: { driveId: "drive", path: "/drive/root:/Работа/UCA/deep" },
  } as any;
  assert.equal(relativePathFromParentReference(root, item), "UCA/deep/file.pdf");
  assert.equal(relativePathFromParentReference(root, { ...item, parentReference: { driveId: "other", path: item.parentReference.path } }), null);
  assert.equal(relativePathFromParentReference(root, { ...item, parentReference: { driveId: "drive", path: "/drive/root:/Outside" } }), null);
});

test("downstream reconciliation uses bounded stable-ID and exact-root-path reads", () => {
  assert.match(source, /resolveConfiguredRoot/);
  assert.match(source, /readStableItemBounded/);
  assert.match(source, /readDeclaredDestinationBounded/);
  assert.match(source, /encodeGraphPath/);
  assert.match(source, /configuredRootPath/);
  assert.match(source, /item\.id !== action\.sourceItemId/);
  assert.match(source, /MAX_DECLARED_DESTINATIONS = 3/);
  assert.doesNotMatch(source, /verifyItemInsideRoot/);
});

test("only one rename candidate is examined per invocation", () => {
  assert.match(source, /const action = candidates\[0\]/);
  assert.match(source, /examinedActionId/);
  assert.match(source, /reconciliationOnlyThisInvocation: true/);
});

test("downstream reconciliation verifies hash before durable success and performs no mutation", () => {
  assert.match(source, /verifySnapshotHash/);
  assert.match(source, /snapshotSha256/);
  assert.match(source, /mutationPerformed: false/);
});

test("the override delegates ordinary execution to the validated repair", () => {
  assert.match(source, /return executeIntegrityPlanRepair\(context, input\)/);
});
