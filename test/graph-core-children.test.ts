import test from "node:test";
import assert from "node:assert/strict";
import { verifiedChildFromListedItem, type VerifiedItem } from "../src/graph-core.js";
import type { GraphDriveItem } from "../src/types.js";

function graphItem(value: Partial<GraphDriveItem> & Pick<GraphDriveItem, "id" | "name">): GraphDriveItem {
  return value as GraphDriveItem;
}

function verifiedFolder(): VerifiedItem {
  const root = graphItem({
    id: "root",
    name: "Работа",
    folder: {},
    parentReference: { id: "drive-root", driveId: "drive" },
  });
  const item = graphItem({
    id: "folder",
    name: "Modules",
    folder: {},
    parentReference: { id: "root", driveId: "drive" },
  });
  return {
    item,
    root,
    relativePath: "UCA/Modules",
    ancestorIds: ["folder", "root"],
    driveId: "drive",
  };
}

test("derives a verified child from the already verified parent response", () => {
  const folder = verifiedFolder();
  const child = graphItem({
    id: "child",
    name: "source.pdf",
    size: 123,
    file: { mimeType: "application/pdf" },
    parentReference: { id: "folder", driveId: "drive" },
  });
  const verified = verifiedChildFromListedItem(folder, child);
  assert.equal(verified.item, child);
  assert.equal(verified.root, folder.root);
  assert.equal(verified.relativePath, "UCA/Modules/source.pdf");
  assert.deepEqual(verified.ancestorIds, ["child", "folder", "root"]);
  assert.equal(verified.driveId, "drive");
});

test("rejects children whose parent, drive, or remote state breaks the verified boundary", () => {
  const folder = verifiedFolder();
  const base = {
    id: "child",
    name: "source.pdf",
    file: { mimeType: "application/pdf" },
  } as const;
  assert.throws(() => verifiedChildFromListedItem(folder, graphItem({ ...base, parentReference: { id: "other", driveId: "drive" } })), /verified parent folder/);
  assert.throws(() => verifiedChildFromListedItem(folder, graphItem({ ...base, parentReference: { id: "folder", driveId: "other-drive" } })), /verified parent folder/);
  assert.throws(() => verifiedChildFromListedItem(folder, graphItem({ ...base, remoteItem: {}, parentReference: { id: "folder", driveId: "drive" } })), /remote/);
});
