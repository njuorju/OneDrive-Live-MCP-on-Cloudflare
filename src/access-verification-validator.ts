import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorError } from "./errors";
import { strictRelativePath, validateItemName } from "./graph-core";
import {
  validateIntegrityPlan,
  type IntegrityPlan,
  type IntegratedContext,
  type PlanAction,
} from "./integrated-tools";
import { errorResult, textResult } from "./paid-core";
import type { HotfixContext, StableStorage } from "./version20-hotfix";

const POLICY = "owner_only_no_sharing_links" as const;
const PLAN_PREFIX = "integrated:plan:";
const BASE_ACTIONS = new Set([
  "KEEP",
  "RENAME",
  "MOVE",
  "RECYCLE",
  "METADATA_ONLY",
  "CATALOGUE_ONLY",
  "CREATE_TEXT",
  "REPLACE_TEXT",
  "CREATE_FOLDER",
  "RECYCLE_FOLDER",
]);
const VISUAL_PHASE2_ACTIONS = new Set([
  "CREATE_PREPARED_BINARY",
  "ENSURE_FOLDER_ACCESS_POLICY",
  "VERIFY_ACCESS_POLICY",
]);
const ACCESS_ACTIONS = new Set([
  "ENSURE_FOLDER_ACCESS_POLICY",
  "VERIFY_ACCESS_POLICY",
]);
const ACCESS_MUTATION_ONLY_FIELDS = [
  "sourceItemId",
  "currentFilename",
  "proposedFilename",
  "snapshotETag",
  "snapshotSha256",
  "normalizedTextSha256",
  "content",
  "bytes",
  "binary",
  "requiredStructuralPlaceholder",
] as const;
const BINARY_META_FIELDS = [
  "preparationId",
  "preparationFingerprint",
  "destinationPath",
  "proposedFilename",
  "expectedFinalSha256",
  "expectedByteLength",
  "expectedFormat",
  "expectedWidth",
  "expectedHeight",
  "provenance",
  "rightsEvidence",
] as const;

type ValidationAction = Omit<PlanAction, "action"> & {
  action: string;
  evidence?: unknown;
  [key: string]: unknown;
};

type VisualPhase2Meta = {
  version?: unknown;
  actionType?: unknown;
  targetPath?: unknown;
  policy?: unknown;
  preparationId?: unknown;
  preparationFingerprint?: unknown;
  destinationPath?: unknown;
  proposedFilename?: unknown;
  expectedFinalSha256?: unknown;
  expectedByteLength?: unknown;
  expectedFormat?: unknown;
  expectedWidth?: unknown;
  expectedHeight?: unknown;
  provenance?: unknown;
  rightsEvidence?: unknown;
  [key: string]: unknown;
};

export type AccessVerificationValidationError = {
  actionId: string;
  code: string;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function actionName(action: ValidationAction): string {
  return String(action.action ?? "");
}

function phase2Meta(action: ValidationAction): VisualPhase2Meta | null {
  if (!isRecord(action.evidence) || !isRecord(action.evidence.visualPhase2)) return null;
  return action.evidence.visualPhase2 as VisualPhase2Meta;
}

function planKey(planId: string): string {
  return `${PLAN_PREFIX}${planId}`;
}

function canonicalPath(value: unknown): string {
  const raw = String(value ?? "");
  if (!raw) throw new ConnectorError("access_target_invalid", "The access-policy target path is required.");
  const canonical = strictRelativePath(raw);
  if (!canonical || canonical !== raw) {
    throw new ConnectorError("access_target_invalid", "The access-policy target path must be canonical and unambiguous.");
  }
  return canonical;
}

function withinScope(scopePath: string, candidatePath: string): boolean {
  const scope = strictRelativePath(scopePath).toLocaleLowerCase("en");
  const candidate = strictRelativePath(candidatePath).toLocaleLowerCase("en");
  return !scope || candidate === scope || candidate.startsWith(`${scope}/`);
}

function operationOrder(action: ValidationAction): number {
  return Number(action.operationOrder ?? 0);
}

function dependencyList(action: ValidationAction): string[] {
  return Array.isArray(action.dependencies) ? action.dependencies.map(String) : [];
}

function hasValue(action: ValidationAction, field: string): boolean {
  const value = action[field];
  return value !== undefined && value !== null && value !== "" && value !== false;
}

function targetPathForAccessAction(action: ValidationAction, meta: VisualPhase2Meta): string {
  const target = canonicalPath(meta.targetPath);
  const source = canonicalPath(action.sourcePath);
  const destination = canonicalPath(action.destinationPath);
  if (source !== target || destination !== target) {
    throw new ConnectorError("access_target_ambiguous", "The access-policy action paths do not identify one exact target.");
  }
  return target;
}

function policyCoversTarget(enforcementTarget: string, verificationTarget: string): boolean {
  const enforcement = enforcementTarget.toLocaleLowerCase("en");
  const verification = verificationTarget.toLocaleLowerCase("en");
  return verification === enforcement || verification.startsWith(`${enforcement}/`);
}

function dependsTransitively(
  actionById: Map<string, ValidationAction>,
  startActionId: string,
  targetActionId: string,
): boolean {
  const pending = [...dependencyList(actionById.get(startActionId) ?? ({ dependencies: [] } as unknown as ValidationAction))];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = String(pending.pop());
    if (candidate === targetActionId) return true;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    const action = actionById.get(candidate);
    if (action) pending.push(...dependencyList(action));
  }
  return false;
}

function validatePreparedBinaryAction(
  action: ValidationAction,
  meta: VisualPhase2Meta,
  errors: AccessVerificationValidationError[],
): void {
  const actionId = String(action.actionId ?? "");
  if (meta.version !== 1 || meta.actionType !== "CREATE_PREPARED_BINARY") {
    errors.push({ actionId, code: "visual_phase2_evidence_invalid" });
    return;
  }
  for (const field of ["content", "bytes", "binary"]) {
    if (hasValue(action, field)) errors.push({ actionId, code: "caller_payload_forbidden", field });
  }
  try {
    const destination = canonicalPath(meta.destinationPath);
    if (canonicalPath(action.destinationPath) !== destination) errors.push({ actionId, code: "prepared_binary_destination_mismatch" });
    const filename = validateItemName(String(meta.proposedFilename ?? ""));
    if (String(action.proposedFilename ?? "") !== filename) errors.push({ actionId, code: "prepared_binary_filename_mismatch" });
  } catch (error) {
    const safe = error instanceof ConnectorError
      ? error
      : new ConnectorError("prepared_binary_path_invalid", "The prepared-binary destination is invalid.");
    errors.push({ actionId, code: safe.code, message: safe.message });
  }
  if (!/^prep_[0-9a-f]{48}$/.test(String(meta.preparationId ?? ""))) errors.push({ actionId, code: "preparation_identifier_invalid" });
  if (!/^[0-9a-f]{64}$/.test(String(meta.preparationFingerprint ?? ""))) errors.push({ actionId, code: "preparation_fingerprint_invalid" });
  if (!/^[0-9a-f]{64}$/.test(String(meta.expectedFinalSha256 ?? ""))) errors.push({ actionId, code: "prepared_binary_sha256_invalid" });
  for (const field of ["expectedByteLength", "expectedWidth", "expectedHeight"] as const) {
    const value = Number(meta[field]);
    if (!Number.isInteger(value) || value <= 0) errors.push({ actionId, code: "prepared_binary_evidence_invalid", field });
  }
  if (!["jpeg", "jpg"].includes(String(meta.expectedFormat ?? ""))) errors.push({ actionId, code: "prepared_binary_format_invalid" });
}

function validateAccessActionShape(
  scopePath: string,
  action: ValidationAction,
  meta: VisualPhase2Meta,
  errors: AccessVerificationValidationError[],
): string | null {
  const actionId = String(action.actionId ?? "");
  const name = actionName(action);
  if (meta.version !== 1 || meta.actionType !== name) {
    errors.push({ actionId, code: "visual_phase2_evidence_invalid" });
    return null;
  }
  if (meta.policy !== POLICY) errors.push({ actionId, code: "access_policy_unsupported", policy: meta.policy ?? null });
  for (const field of ACCESS_MUTATION_ONLY_FIELDS) {
    if (hasValue(action, field)) errors.push({ actionId, code: "access_verification_mutation_payload_forbidden", field });
  }
  for (const field of BINARY_META_FIELDS) {
    if (meta[field] !== undefined && meta[field] !== null) {
      errors.push({ actionId, code: "access_verification_mutation_payload_forbidden", field: `visualPhase2.${field}` });
    }
  }
  if (action.destructive === true) errors.push({ actionId, code: "access_verification_destructive_forbidden" });
  try {
    const target = targetPathForAccessAction(action, meta);
    if (!withinScope(scopePath, target)) errors.push({ actionId, code: "destination_outside_scope" });
    return target;
  } catch (error) {
    const safe = error instanceof ConnectorError
      ? error
      : new ConnectorError("access_target_invalid", "The access-policy target is invalid.");
    errors.push({ actionId, code: safe.code, message: safe.message });
    return null;
  }
}

export function validateAccessVerificationActions(
  scopePath: string,
  rawActions: Array<PlanAction | ValidationAction>,
): AccessVerificationValidationError[] {
  const actions = rawActions as ValidationAction[];
  const errors: AccessVerificationValidationError[] = [];
  const seenIds = new Set<string>();
  const actionById = new Map<string, ValidationAction>();
  for (const action of actions) {
    const actionId = String(action.actionId ?? "");
    if (!actionId || seenIds.has(actionId)) errors.push({ actionId, code: "duplicate_action_id" });
    seenIds.add(actionId);
    actionById.set(actionId, action);
    const name = actionName(action);
    if (!BASE_ACTIONS.has(name) && !VISUAL_PHASE2_ACTIONS.has(name)) {
      errors.push({ actionId, code: "unsupported_plan_action", action: name });
    }
  }

  const accessTargets = new Map<string, string>();
  for (const action of actions) {
    const name = actionName(action);
    const meta = phase2Meta(action);
    if (VISUAL_PHASE2_ACTIONS.has(name) && !meta) {
      errors.push({ actionId: String(action.actionId ?? ""), code: "visual_phase2_evidence_invalid" });
      continue;
    }
    if (!meta) continue;
    if (String(meta.actionType ?? "") !== name) {
      errors.push({ actionId: String(action.actionId ?? ""), code: "visual_phase2_action_mismatch" });
      continue;
    }
    if (name === "CREATE_PREPARED_BINARY") {
      validatePreparedBinaryAction(action, meta, errors);
      continue;
    }
    if (!ACCESS_ACTIONS.has(name)) {
      errors.push({ actionId: String(action.actionId ?? ""), code: "unsupported_visual_phase2_action", action: name });
      continue;
    }
    const target = validateAccessActionShape(scopePath, action, meta, errors);
    if (target) accessTargets.set(String(action.actionId ?? ""), target);
  }

  for (const action of actions.filter((candidate) => actionName(candidate) === "VERIFY_ACCESS_POLICY")) {
    const actionId = String(action.actionId ?? "");
    const target = accessTargets.get(actionId);
    if (!target) continue;
    const candidates = actions.filter((candidate) => {
      if (actionName(candidate) !== "ENSURE_FOLDER_ACCESS_POLICY") return false;
      const candidateTarget = accessTargets.get(String(candidate.actionId ?? ""));
      const candidateMeta = phase2Meta(candidate);
      return Boolean(candidateTarget)
        && policyCoversTarget(String(candidateTarget), target)
        && candidateMeta?.policy === POLICY;
    });
    if (candidates.length === 0) {
      errors.push({ actionId, code: "access_enforcement_missing", targetPath: target });
      continue;
    }
    const linked = candidates.filter((candidate) => dependsTransitively(actionById, actionId, String(candidate.actionId ?? "")));
    if (linked.length === 0) {
      errors.push({ actionId, code: "access_verification_dependency_missing", targetPath: target });
      continue;
    }
    if (!linked.some((candidate) => operationOrder(candidate) < operationOrder(action))) {
      errors.push({ actionId, code: "access_verification_order_invalid", targetPath: target });
    }
  }
  return errors;
}

export function projectReadOnlyAccessVerifications(
  rawActions: Array<PlanAction | ValidationAction>,
): PlanAction[] {
  return (rawActions as ValidationAction[]).map((action) => actionName(action) === "VERIFY_ACCESS_POLICY"
    ? { ...action, destinationPath: null } as unknown as PlanAction
    : { ...action } as unknown as PlanAction);
}

export function hasVisualPhase2ValidationActions(plan: IntegrityPlan): boolean {
  return (plan.actions as ValidationAction[]).some((action) => VISUAL_PHASE2_ACTIONS.has(actionName(action)) || Boolean(phase2Meta(action)));
}

function projectedStorage(
  storage: StableStorage,
  originalPlan: IntegrityPlan,
  projectedPlan: IntegrityPlan,
): IntegratedContext["storage"] {
  const key = planKey(originalPlan.planId);
  const adapter = {
    async get<T = unknown>(requested: string): Promise<T | undefined> {
      if (requested === key) return projectedPlan as T;
      return storage.get<T>(requested);
    },
    async put<T = unknown>(requested: string, value: T): Promise<void> {
      if (requested === key && isRecord(value)) {
        const updated = value as unknown as IntegrityPlan;
        await storage.put(requested, {
          ...updated,
          actions: originalPlan.actions,
          planHash: originalPlan.planHash,
        });
        return;
      }
      await storage.put(requested, value);
    },
    delete(requested: string): Promise<boolean> {
      return storage.delete(requested);
    },
    list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
      return storage.list<T>(options);
    },
  };
  return adapter as unknown as IntegratedContext["storage"];
}

export async function validateAccessVerificationIntegrityPlan(
  context: HotfixContext,
  planId: string,
): Promise<Record<string, unknown>> {
  const plan = await context.storage.get<IntegrityPlan>(planKey(planId));
  if (!plan || Date.parse(plan.expiresAt) <= Date.now()) {
    throw new ConnectorError("plan_not_found", "The integrity plan does not exist or has expired.");
  }
  const semanticErrors = validateAccessVerificationActions(plan.scopePath, plan.actions);
  if (semanticErrors.length > 0) {
    await context.storage.put(planKey(planId), {
      ...plan,
      validationStatus: "invalid",
      status: plan.executionStatus === "not_started" ? "draft" : plan.status,
    });
    return {
      valid: false,
      planId,
      errors: semanticErrors,
      validationExternalGraphRequests: 0,
      accessVerificationReadOnlyCollisionExcluded: false,
    };
  }
  const projectedPlan: IntegrityPlan = {
    ...plan,
    actions: projectReadOnlyAccessVerifications(plan.actions),
  };
  const validationContext: IntegratedContext = {
    env: context.env,
    userId: context.userId,
    storage: projectedStorage(context.storage, plan, projectedPlan),
    waitUntil: context.waitUntil,
  };
  const result = await validateIntegrityPlan(validationContext, planId);
  return {
    ...result,
    accessVerificationReadOnlyCollisionExcluded: true,
    accessVerificationActionCount: (plan.actions as ValidationAction[])
      .filter((action) => actionName(action) === "VERIFY_ACCESS_POLICY").length,
  };
}

function registeredTool(server: McpServer, name: string): any {
  return (server as any)._registeredTools?.[name];
}

export function registerAccessVerificationValidator(
  server: McpServer,
  contextFactory: () => HotfixContext,
): void {
  const validation = registeredTool(server, "validate_integrity_plan");
  if (!validation?.handler) throw new Error("validate_integrity_plan must be registered before the access-verification validator.");
  if (validation.__accessVerificationValidatorWrapped) return;
  const original = validation.handler.bind(validation);
  validation.handler = async (input: { planId: string }): Promise<CallToolResult> => {
    try {
      const context = contextFactory();
      const plan = await context.storage.get<IntegrityPlan>(planKey(String(input.planId ?? "")));
      if (!plan || !hasVisualPhase2ValidationActions(plan)) return original(input, {});
      return textResult(await validateAccessVerificationIntegrityPlan(context, String(input.planId ?? "")));
    } catch (error) {
      return errorResult(error);
    }
  };
  validation.__accessVerificationValidatorWrapped = true;
}
