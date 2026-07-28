import test from "node:test";
import assert from "node:assert/strict";
import { classifyPermissionRecords, summarizePermissionRecords } from "../src/visual-phase2";

test("owner identities do not become sharing links without a Graph link facet", () => {
  const records = classifyPermissionRecords({
    ownerIds: ["owner-id"], itemIsFolder: true,
    permissions: [{ id: "owner-permission", roles: ["owner"], grantedToV2: { user: { id: "owner-id" } } }],
  });
  const summary = summarizePermissionRecords(records);
  assert.equal(records[0].classification, "owner");
  assert.equal(records[0].hasLinkFacet, false);
  assert.equal(records[0].removable, false);
  assert.equal(records[0].nonRemovableReason, "owner_permission");
  assert.equal(summary.totalSharingLinkCount, 0);
  assert.equal(summary.ownerGrantCount, 1);
});

test("only genuine direct link permissions are selected for the existing DELETE enforcement path", () => {
  const records = classifyPermissionRecords({
    ownerIds: ["owner-id"], itemIsFolder: true,
    permissions: [
      { id: "direct-link", roles: ["read"], link: { type: "view", scope: "anonymous", preventsDownload: true } },
      { id: "inherited-link", roles: ["read"], inheritedFrom: { driveId: "drive", id: "parent", path: "/drive/root:/parent" }, link: { type: "view", scope: "organization" } },
    ],
  });
  const summary = summarizePermissionRecords(records);
  assert.equal(records[0].classification, "direct_link");
  assert.equal(records[0].removable, true);
  assert.equal(records[0].selectionReason, "direct_link_selected");
  assert.equal(records[0].preventsDownload, true);
  assert.equal(records[1].classification, "inherited_link");
  assert.equal(records[1].removable, false);
  assert.equal(records[1].nonRemovableReason, "inherited_permission");
  assert.deepEqual(records[1].inheritedFrom, { driveId: "drive", itemId: "parent", path: "/drive/root:/parent" });
  assert.equal(summary.totalSharingLinkCount, 2);
  assert.equal(summary.inheritedPermissionCount, 1);
  assert.equal(summary.directPermissionCount, 1);
  assert.equal(summary.externalPrincipalCount, 0);
});

test("unresolved permission objects remain unknown instead of being forced into a direct-link class", () => {
  const records = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: false, permissions: [{ id: "unknown", roles: ["read"] }] });
  assert.equal(records[0].classification, "unknown");
  assert.equal(records[0].hasLinkFacet, false);
  assert.equal(records[0].removable, false);
  assert.equal(records[0].nonRemovableReason, "unresolved_principal");
  assert.equal(summarizePermissionRecords(records).totalSharingLinkCount, 0);
});
