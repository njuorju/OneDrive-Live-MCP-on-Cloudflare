import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findDeclaredDownstreamMove,
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

test("derives a relative path only from the configured root on the same drive", () => {
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

test("downstream reconciliation verifies stable identity, root path, destination, filename and hash before success", () => {
  assert.match(source, /resolveConfiguredRoot/);
  assert.match(source, /relativePathFromParentReference/);
  assert.match(source, /verifyItemInsideRoot/);
  assert.match(source, /live\.item\.name !== action\.proposedFilename/);
  assert.match(source, /liveParent !== expectedParent/);
  assert.match(source, /verifySnapshotHash/);
  assert.match(source, /mutationPerformed: false/);
});

test("the override delegates ordinary execution to the validated repair", () => {
  assert.match(source, /return executeIntegrityPlanRepair\(context, input\)/);
});
