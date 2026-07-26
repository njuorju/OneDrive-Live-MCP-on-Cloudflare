import test from "node:test";
import assert from "node:assert/strict";
import {
  projectReadOnlyAccessVerifications,
  validateAccessVerificationActions,
  validateAccessVerificationIntegrityPlan,
} from "../src/access-verification-validator";
import type { IntegrityPlan, PlanAction, SnapshotMeta } from "../src/integrated-tools";
import type { HotfixContext, StableStorage } from "../src/version20-hotfix";

const SCOPE = "UCA/Modules";
const SNAPSHOT_ID = "bd19d58f-acbc-485b-9f86-45472d541eb2";
const PLAN_ID = "7136d47e-6e01-4c42-b16d-70110ff173c3";
const POLICY = "owner_only_no_sharing_links";

class MemoryStorage implements StableStorage {
  readonly values = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T = unknown>(key: string, value: T): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T = unknown>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const prefix = String(options.prefix ?? "");
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, value as T]));
  }
}

function folder(id: string, destination: string, name: string, order: number, dependencies: string[] = []): PlanAction {
  return { actionId: id, action: "CREATE_FOLDER", destinationPath: destination, proposedFilename: name, operationOrder: order, dependencies, destructive: false, ambiguity: false };
}

function access(id: string, kind: "ENSURE_FOLDER_ACCESS_POLICY" | "VERIFY_ACCESS_POLICY", path: string, order: number, dependencies: string[] = [], policy: string = POLICY): PlanAction {
  return {
    actionId: id,
    action: kind as unknown as PlanAction["action"],
    sourcePath: path,
    destinationPath: path,
    operationOrder: order,
    dependencies,
    destructive: false,
    ambiguity: false,
    finalDecision: kind.toLowerCase(),
    evidence: { visualPhase2: { version: 1, actionType: kind, targetPath: path, policy } },
  };
}

function binary(id: string, destination: string, name: string, order: number, dependencies: string[] = []): PlanAction {
  return {
    actionId: id,
    action: "CREATE_PREPARED_BINARY" as unknown as PlanAction["action"],
    destinationPath: destination,
    proposedFilename: name,
    operationOrder: order,
    dependencies,
    destructive: false,
    ambiguity: false,
    finalDecision: "create_prepared_binary_exact",
    evidence: { visualPhase2: {
      version: 1,
      actionType: "CREATE_PREPARED_BINARY",
      preparationId: `prep_${"a".repeat(48)}`,
      preparationFingerprint: "b".repeat(64),
      destinationPath: destination,
      proposedFilename: name,
      expectedFinalSha256: "c".repeat(64),
      expectedByteLength: 100,
      expectedFormat: "jpeg",
      expectedWidth: 10,
      expectedHeight: 10,
      provenance: {},
      rightsEvidence: {},
    } },
  };
}

function makePlan(actions: PlanAction[]): IntegrityPlan {
  return {
    planId: PLAN_ID,
    snapshotId: SNAPSHOT_ID,
    scopePath: SCOPE,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: "draft",
    validationStatus: "not_validated",
    executionStatus: "not_started",
    currentAction: null,
    actions,
    completedActions: [],
    failedActions: [],
    skippedDependencyActions: [],
    results: [],
    deletionLogsPrepared: [],
    finalFilesystemDiffReference: null,
    nextAction: actions[0]?.actionId ?? null,
    auditStatus: "not_requested",
    completedInvocations: 0,
    lastExecutionAt: null,
    planHash: "d".repeat(64),
  };
}

function makeSnapshot(): SnapshotMeta {
  return {
    snapshotId: SNAPSHOT_ID,
    scopePath: SCOPE,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    rootItemId: "root",
    rootETag: null,
    totalFiles: 0,
    totalFolders: 0,
    totalRecords: 0,
    complete: true,
    options: {},
    errors: [],
    jobId: "00000000-0000-0000-0000-000000000000",
  };
}

async function runValidation(actions: PlanAction[]): Promise<{ result: Record<string, unknown>; stored: IntegrityPlan; storage: MemoryStorage }> {
  const storage = new MemoryStorage();
  await storage.put(`integrated:plan:${PLAN_ID}`, makePlan(actions));
  await storage.put(`integrated:snapshot:${SNAPSHOT_ID}:meta`, makeSnapshot());
  const env = new Proxy({ COOKIE_ENCRYPTION_KEY: "validator-test-secret" }, {
    get(target, property) {
      if (property === "COOKIE_ENCRYPTION_KEY") return target.COOKIE_ENCRYPTION_KEY;
      throw new Error(`Unexpected environment access during validation: ${String(property)}`);
    },
  }) as unknown as Env;
  const context: HotfixContext = { env, userId: "test-user", storage };
  const result = await validateAccessVerificationIntegrityPlan(context, PLAN_ID);
  const stored = await storage.get<IntegrityPlan>(`integrated:plan:${PLAN_ID}`);
  assert.ok(stored);
  return { result, stored, storage };
}

function codes(result: Record<string, unknown>): string[] {
  return Array.isArray(result.errors) ? result.errors.map((entry) => String((entry as Record<string, unknown>).code)) : [];
}

function exactPhase2Structure(): PlanAction[] {
  const root = "UCA/Modules/04_Visual_Library";
  const rights = `${root}/01_Rights_Pending`;
  const permission = `${root}/02_Permission_Pending`;
  const consent = `${root}/03_Consent_Pending`;
  return [
    folder("P2-FOLDER-ROOT", SCOPE, "04_Visual_Library", 0),
    folder("P2-FOLDER-RIGHTS", root, "01_Rights_Pending", 1, ["P2-FOLDER-ROOT"]),
    folder("P2-FOLDER-PERMISSION", root, "02_Permission_Pending", 2, ["P2-FOLDER-ROOT"]),
    folder("P2-FOLDER-CONSENT", root, "03_Consent_Pending", 3, ["P2-FOLDER-ROOT"]),
    folder("P2-FOLDER-METADATA", root, "04_Metadata", 4, ["P2-FOLDER-ROOT"]),
    folder("P2-FOLDER-SOURCE", root, "05_Source_Evidence", 5, ["P2-FOLDER-ROOT"]),
    access("P2-ACCESS-01-RIGHTS-PENDING", "ENSURE_FOLDER_ACCESS_POLICY", rights, 6, ["P2-FOLDER-RIGHTS"]),
    access("P2-ACCESS-03-PERMISSION-PENDING", "ENSURE_FOLDER_ACCESS_POLICY", permission, 7, ["P2-FOLDER-PERMISSION"]),
    access("P2-ACCESS-02-CONSENT-PENDING", "ENSURE_FOLDER_ACCESS_POLICY", consent, 8, ["P2-FOLDER-CONSENT"]),
    binary("P2-ASSET-004", consent, "NAR-RSP-CAND-004.jpg", 9, ["P2-ACCESS-02-CONSENT-PENDING"]),
    binary("P2-ASSET-079", consent, "NAR-RSP-CAND-079.jpg", 10, ["P2-ACCESS-02-CONSENT-PENDING"]),
    binary("P2-ASSET-080", permission, "NAR-RSP-CAND-080.jpg", 11, ["P2-ACCESS-03-PERMISSION-PENDING"]),
    binary("P2-ASSET-081", rights, "NAR-RSP-CAND-081.jpg", 12, ["P2-ACCESS-01-RIGHTS-PENDING"]),
    access("P2-VERIFY-CONSENT-PENDING", "VERIFY_ACCESS_POLICY", consent, 13, ["P2-ASSET-004", "P2-ASSET-079"]),
    access("P2-VERIFY-PERMISSION-PENDING", "VERIFY_ACCESS_POLICY", permission, 14, ["P2-ASSET-080"]),
    access("P2-VERIFY-RIGHTS-PENDING", "VERIFY_ACCESS_POLICY", rights, 15, ["P2-ASSET-081"]),
    access("P2-VERIFY-ASSET-004", "VERIFY_ACCESS_POLICY", `${consent}/NAR-RSP-CAND-004.jpg`, 16, ["P2-ASSET-004"]),
    access("P2-VERIFY-ASSET-079", "VERIFY_ACCESS_POLICY", `${consent}/NAR-RSP-CAND-079.jpg`, 17, ["P2-ASSET-079"]),
    access("P2-VERIFY-ASSET-080", "VERIFY_ACCESS_POLICY", `${permission}/NAR-RSP-CAND-080.jpg`, 18, ["P2-ASSET-080"]),
    access("P2-VERIFY-ASSET-081", "VERIFY_ACCESS_POLICY", `${rights}/NAR-RSP-CAND-081.jpg`, 19, ["P2-ASSET-081"]),
  ];
}

test("dependent enforcement and verification on the same folder validate", async () => {
  const path = `${SCOPE}/Folder`;
  const { result, stored } = await runValidation([access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 0), access("verify", "VERIFY_ACCESS_POLICY", path, 1, ["ensure"])]);
  assert.equal(result.valid, true);
  assert.equal(result.validationExternalGraphRequests, 0);
  assert.equal(result.accessVerificationReadOnlyCollisionExcluded, true);
  assert.equal(stored.validationStatus, "valid");
  assert.equal(stored.executionStatus, "not_started");
  assert.equal(stored.actions[1].destinationPath, path);
  assert.equal(typeof result.executionToken, "string");
});

test("verification may depend transitively on enforcement through asset actions", async () => {
  const path = `${SCOPE}/Folder`;
  const { result } = await runValidation([access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 0), binary("asset", path, "asset.jpg", 1, ["ensure"]), access("verify", "VERIFY_ACCESS_POLICY", `${path}/asset.jpg`, 2, ["asset"])]);
  assert.equal(result.valid, true);
});

test("exact relevant 20-action Phase 2 structure passes collision validation", async () => {
  const actions = exactPhase2Structure();
  assert.equal(actions.length, 20);
  assert.deepEqual(actions.map((action) => action.operationOrder), [...Array(20).keys()]);
  assert.equal(projectReadOnlyAccessVerifications(actions).filter((action) => action.destinationPath === null).length, 7);
  const { result, stored } = await runValidation(actions);
  assert.equal(result.valid, true);
  assert.equal(result.accessVerificationActionCount, 7);
  assert.deepEqual(stored.actions.map((action) => action.actionId), actions.map((action) => action.actionId));
  assert.equal(stored.completedActions.length, 0);
  assert.equal(stored.failedActions.length, 0);
});

test("multiple file-level verification actions on distinct paths remain valid", async () => {
  const path = `${SCOPE}/Folder`;
  const { result } = await runValidation([
    access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 0),
    binary("a", path, "a.jpg", 1, ["ensure"]),
    binary("b", path, "b.jpg", 2, ["ensure"]),
    access("verify-a", "VERIFY_ACCESS_POLICY", `${path}/a.jpg`, 3, ["a"]),
    access("verify-b", "VERIFY_ACCESS_POLICY", `${path}/b.jpg`, 4, ["b"]),
  ]);
  assert.equal(result.valid, true);
});

test("validation produces no Graph mutation or operation record", async () => {
  const path = `${SCOPE}/Folder`;
  const { result, storage } = await runValidation([access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 0), access("verify", "VERIFY_ACCESS_POLICY", path, 1, ["ensure"])]);
  assert.equal(result.valid, true);
  assert.deepEqual([...storage.values.keys()].filter((key) => key.includes("operation:")), []);
});

test("two enforcement actions targeting the same folder remain a conflict", async () => {
  const path = `${SCOPE}/Folder`;
  const { result } = await runValidation([access("a", "ENSURE_FOLDER_ACCESS_POLICY", path, 0), access("b", "ENSURE_FOLDER_ACCESS_POLICY", path, 1)]);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("duplicate_destination"));
});

test("verification ordered before or equal to enforcement is rejected", () => {
  const path = `${SCOPE}/Folder`;
  const errors = validateAccessVerificationActions(SCOPE, [access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 1), access("verify", "VERIFY_ACCESS_POLICY", path, 1, ["ensure"])]);
  assert.ok(errors.some((error) => error.code === "access_verification_order_invalid"));
});

test("verification without required dependency relationship is rejected", () => {
  const path = `${SCOPE}/Folder`;
  const errors = validateAccessVerificationActions(SCOPE, [access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 0), access("verify", "VERIFY_ACCESS_POLICY", path, 1)]);
  assert.ok(errors.some((error) => error.code === "access_verification_dependency_missing"));
});

test("verification outside plan scope is rejected", () => {
  const errors = validateAccessVerificationActions(SCOPE, [access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", `${SCOPE}/Folder`, 0), access("verify", "VERIFY_ACCESS_POLICY", "Outside/Folder", 1, ["ensure"])]);
  assert.ok(errors.some((error) => error.code === "destination_outside_scope"));
});

test("invalid target paths are rejected", () => {
  const errors = validateAccessVerificationActions(SCOPE, [access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", `${SCOPE}/Folder`, 0), access("verify", "VERIFY_ACCESS_POLICY", `${SCOPE}/Folder/../Other`, 1, ["ensure"])]);
  assert.ok(errors.some((error) => ["invalid_path", "path_traversal", "ambiguous_path", "access_target_invalid"].includes(error.code)));
});

test("unsupported access policy is rejected", () => {
  const path = `${SCOPE}/Folder`;
  const errors = validateAccessVerificationActions(SCOPE, [access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 0), access("verify", "VERIFY_ACCESS_POLICY", path, 1, ["ensure"], "anyone_with_link")]);
  assert.ok(errors.some((error) => error.code === "access_policy_unsupported"));
});

test("circular dependency remains rejected", async () => {
  const path = `${SCOPE}/Folder`;
  const { result } = await runValidation([access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 0, ["verify"]), access("verify", "VERIFY_ACCESS_POLICY", path, 1, ["ensure"])]);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("dependency_cycle"));
});

test("duplicate action ID remains rejected", () => {
  const path = `${SCOPE}/Folder`;
  const errors = validateAccessVerificationActions(SCOPE, [access("same", "ENSURE_FOLDER_ACCESS_POLICY", path, 0), access("same", "VERIFY_ACCESS_POLICY", path, 1, ["same"])]);
  assert.ok(errors.some((error) => error.code === "duplicate_action_id"));
});

test("verification containing mutation-only payload fields is rejected", () => {
  const path = `${SCOPE}/Folder`;
  const verify = access("verify", "VERIFY_ACCESS_POLICY", path, 1, ["ensure"]) as PlanAction & { content?: string };
  verify.content = "forbidden";
  const errors = validateAccessVerificationActions(SCOPE, [access("ensure", "ENSURE_FOLDER_ACCESS_POLICY", path, 0), verify]);
  assert.ok(errors.some((error) => error.code === "access_verification_mutation_payload_forbidden" && error.field === "content"));
});

test("existing mutation collision protections remain intact", async (t) => {
  await t.test("duplicate folder creation", async () => {
    const { result } = await runValidation([folder("a", SCOPE, "Duplicate", 0), folder("b", SCOPE, "Duplicate", 1)]);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("duplicate_destination"));
  });
  await t.test("duplicate prepared-binary destination", async () => {
    const { result } = await runValidation([binary("a", `${SCOPE}/Folder`, "duplicate.jpg", 0), binary("b", `${SCOPE}/Folder`, "duplicate.jpg", 1)]);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("duplicate_destination"));
  });
});
