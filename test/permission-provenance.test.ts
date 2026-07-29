import test from "node:test";
import assert from "node:assert/strict";
import { buildEnforcementPreview, classifyPermissionRecords, evaluateOwnerOnlyPolicy, summarizePermissionRecords } from "../src/visual-phase2";

const ownerWithLink = {
  id: "owner-membership",
  roles: ["owner"],
  link: {},
  grantedToV2: { user: { id: "owner-id" } },
  grantedToIdentitiesV2: [{ user: { id: "second-user" } }],
};

test("owner role takes precedence over a simultaneous Graph link facet", () => {
  const [record] = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: true, permissions: [ownerWithLink] });
  assert.equal(record.classification, "owner");
  assert.equal(record.hasLinkFacet, true);
  assert.equal(record.linkType, null);
  assert.equal(record.linkScope, null);
  assert.equal(record.hasGrantedToV2, true);
  assert.equal(record.principalCounts.user, 2);
  assert.equal(record.isOwnerPermission, true);
  assert.equal(record.isProtectedPermission, true);
  assert.equal(record.removable, false);
  assert.equal(record.nonRemovableReason, "protected_owner_permission");
  assert.equal(record.policyRelevantSharingPermission, false);
  assert.equal(record.selectedForDeletion, false);
  assert.equal(record.selectionDecision, "protected_owner_permission_skipped");
  assert.equal(record.intendedHttpMethod, null);
  assert.equal(record.intendedEndpoint, null);
  assert.equal(record.descendantsWouldReceiveAccess, false);
});

test("protected owner permission alone produces an enforcement no-op and verification pass", () => {
  const records = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: true, permissions: [ownerWithLink] });
  const evaluation = evaluateOwnerOnlyPolicy(records);
  const summary = evaluation.summary;
  assert.equal(summary.totalSharingLinkCount, 1);
  assert.equal(summary.rawLinkFacetCount, 1);
  assert.equal(summary.policyRelevantSharingLinkCount, 0);
  assert.equal(summary.protectedOwnerPermissionCount, 1);
  assert.equal(evaluation.satisfied, true);
  assert.deepEqual(evaluation.selectedPermissionIds, []);
  const preview = buildEnforcementPreview(records) as any;
  assert.deepEqual(preview.selectedPermissionIds, []);
  assert.deepEqual(preview.selectedOperations, []);
  assert.equal(preview.evaluatedPermissions[0].expectedMutation, "none");
});

test("protected owner is skipped while a genuine direct read link is selected", () => {
  const records = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: true, permissions: [ownerWithLink, { id: "read-link", roles: ["read"], link: { type: "view", scope: "anonymous" } }] });
  const evaluation = evaluateOwnerOnlyPolicy(records);
  assert.equal(records[0].selectedForDeletion, false);
  assert.equal(records[1].classification, "direct_link");
  assert.equal(records[1].selectedForDeletion, true);
  assert.deepEqual(evaluation.selectedPermissionIds, ["read-link"]);
  assert.equal(evaluation.satisfied, false);
});

test("protected owner is skipped while a genuine direct write link is selected", () => {
  const records = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: true, permissions: [ownerWithLink, { id: "write-link", roles: ["write"], link: { type: "edit", scope: "organization" } }] });
  assert.equal(records[0].selectionDecision, "protected_owner_permission_skipped");
  assert.equal(records[1].selectionDecision, "direct_link_selected");
  assert.deepEqual(evaluateOwnerOnlyPolicy(records).selectedPermissionIds, ["write-link"]);
});

test("protected owner and inherited link preserve inherited-access semantics", () => {
  const records = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: true, permissions: [ownerWithLink, { id: "inherited-link", roles: ["read"], inheritedFrom: { driveId: "drive", id: "parent", path: "/drive/root:/parent" }, link: { type: "view", scope: "organization" } }] });
  const evaluation = evaluateOwnerOnlyPolicy(records);
  assert.equal(records[0].selectedForDeletion, false);
  assert.equal(records[1].classification, "inherited_link");
  assert.equal(records[1].selectedForDeletion, false);
  assert.equal(records[1].nonRemovableReason, "inherited_permission");
  assert.deepEqual(records[1].inheritedFrom, { driveId: "drive", itemId: "parent", path: "/drive/root:/parent" });
  assert.equal(evaluation.inheritedUnsafeCount, 1);
  assert.equal(evaluation.satisfied, false);
});

test("non-owner direct-link deletion semantics remain unchanged", () => {
  const [record] = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: true, permissions: [{ id: "direct-link", roles: ["read"], link: { type: "view", scope: "anonymous", preventsDownload: true } }] });
  assert.equal(record.classification, "direct_link");
  assert.equal(record.removable, true);
  assert.equal(record.selectionDecision, "direct_link_selected");
  assert.equal(record.intendedHttpMethod, "DELETE");
  assert.equal(record.preventsDownload, true);
});

test("owner permission without a link facet remains protected and non-removable", () => {
  const [record] = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: true, permissions: [{ id: "owner", roles: ["owner"], grantedToV2: { user: { id: "owner-id" } } }] });
  assert.equal(record.classification, "owner");
  assert.equal(record.hasLinkFacet, false);
  assert.equal(record.isProtectedPermission, true);
  assert.equal(record.removable, false);
  assert.equal(record.nonRemovableReason, "protected_owner_permission");
  assert.equal(summarizePermissionRecords([record]).policyRelevantSharingLinkCount, 0);
});

test("unfamiliar non-owner permission facets remain explicitly unknown", () => {
  const [record] = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: false, permissions: [{ id: "unknown", roles: ["read"], futureFacet: { value: true } } as any] });
  assert.equal(record.classification, "unknown");
  assert.equal(record.isOwnerPermission, false);
  assert.equal(record.removable, false);
  assert.equal(record.nonRemovableReason, "unresolved_principal");
});

test("preview and execution evaluation consume the same selector output and never construct owner DELETE", () => {
  const records = classifyPermissionRecords({ ownerIds: ["owner-id"], itemIsFolder: true, permissions: [ownerWithLink, { id: "direct-link", roles: ["read"], link: { type: "view", scope: "anonymous" } }] });
  const evaluation = evaluateOwnerOnlyPolicy(records);
  const preview = buildEnforcementPreview(records) as any;
  assert.deepEqual(preview.selectedPermissionIds, evaluation.selectedPermissionIds);
  assert.equal(preview.selectedOperations.some((operation: any) => operation.permissionId === "owner-membership"), false);
  assert.equal(preview.evaluatedPermissions[0].intendedHttpMethod, null);
  assert.equal(preview.evaluatedPermissions[0].intendedEndpoint, null);
});
