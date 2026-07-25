import test from "node:test";
import assert from "node:assert/strict";
import {
  composeVisualPhase2PlanActions,
  readJpegProperties,
  ownerOnlyPolicySatisfied,
} from "../src/visual-phase2";

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

test("exact image inspection reads JPEG dimensions without decoding or recompression", () => {
  assert.deepEqual(readJpegProperties(jpeg(2406, 1434)), {
    format: "jpeg",
    mimeType: "image/jpeg",
    width: 2406,
    height: 1434,
  });
});

test("owner-only policy fails closed on every broader-access category", () => {
  const safe = {
    permissionCount: 1,
    ownerGrantCount: 1,
    sharingLinkCount: 0,
    directAdditionalGrantCount: 0,
    inheritedUnsafeCount: 0,
    externalPrincipalCount: 0,
    unresolvedPrincipalCount: 0,
  };
  assert.equal(ownerOnlyPolicySatisfied(safe), true);
  for (const key of ["sharingLinkCount", "directAdditionalGrantCount", "inheritedUnsafeCount", "externalPrincipalCount", "unresolvedPrincipalCount"] as const) {
    assert.equal(ownerOnlyPolicySatisfied({ ...safe, [key]: 1 }), false, key);
  }
});

test("visual Phase 2 composition retains explicit semantics and dependencies while forbidding inline bytes", () => {
  const actions = composeVisualPhase2PlanActions({
    scopePath: "UCA/Modules",
    structuralActions: [{ actionId: "folder", action: "CREATE_FOLDER", destinationPath: "UCA/Modules", proposedFilename: "04_Visual_Library", dependencies: [] }],
    preparedBinaryActions: [{
      preparationId: `prep_${"a".repeat(48)}`,
      preparationFingerprint: "b".repeat(64),
      actionId: "asset",
      destinationPath: "UCA/Modules/04_Visual_Library",
      proposedFilename: "asset.jpg",
      dependencies: ["folder"],
      expectedFinalSha256: "c".repeat(64),
      expectedByteLength: 650746,
      expectedFormat: "jpeg",
      expectedWidth: 2406,
      expectedHeight: 1434,
      provenance: { stableVisualKey: "pdf:image:999:0" },
      rightsEvidence: { permission: "pending" },
    }],
    accessActions: [{ actionId: "access", action: "VERIFY_ACCESS_POLICY", targetPath: "UCA/Modules/04_Visual_Library", policy: "owner_only_no_sharing_links", dependencies: ["asset"] }],
  });
  assert.deepEqual(actions.map((action) => action.actionId), ["folder", "asset", "access"]);
  assert.equal(actions[1].action, "CREATE_PREPARED_BINARY");
  assert.equal(actions[2].action, "VERIFY_ACCESS_POLICY");
  assert.equal((actions[1].evidence as any).visualPhase2.actionType, "CREATE_PREPARED_BINARY");
  assert.throws(() => composeVisualPhase2PlanActions({
    scopePath: "UCA/Modules",
    structuralActions: [],
    preparedBinaryActions: [{
      preparationId: `prep_${"a".repeat(48)}`,
      preparationFingerprint: "b".repeat(64),
      actionId: "asset",
      destinationPath: "UCA/Modules",
      proposedFilename: "asset.jpg",
      expectedFinalSha256: "c".repeat(64),
      expectedByteLength: 1,
      expectedFormat: "jpeg",
      expectedWidth: 1,
      expectedHeight: 1,
      provenance: {},
      rightsEvidence: {},
      bytes: "forbidden",
    }],
    accessActions: [{ actionId: "access", action: "VERIFY_ACCESS_POLICY", targetPath: "UCA/Modules", policy: "owner_only_no_sharing_links", dependencies: ["asset"] }],
  }), /binary payloads are forbidden/i);
});
