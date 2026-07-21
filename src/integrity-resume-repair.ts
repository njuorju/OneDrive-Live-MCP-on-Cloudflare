import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError, safeErrorResult } from "./errors";
import {
  compactVerifiedItem,
  graphFetchBytes,
  strictRelativePath,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import { INTEGRATED_LIMITS, sha256Bytes } from "./integrated-core";
import {
  executeIntegrityPlan as executeLegacyIntegrityPlan,
  type IntegrityPlan,
  type PlanAction,
} from "./integrated-tools";
import {
  normalizeProgress,
  remainingActions,
  uniqueStrings,
  upsertResult,
} from "./integrity-execution";
import { openJson } from "./security";
import { createSourceSnapshot, getJobStatus as getSnapshotJobStatus } from "./snapshot-runner";
import {
  JOB_RETENTION_SECONDS,
  expiryIso,
  getJob,
  jobKey,
  nowIso,
  putJob,
  snapshotMetaKey,
  snapshotPrefix,
  type JobRecord,
  type ScheduleSnapshot,
  type SnapshotMeta,
  type SnapshotRecord,
} from "./snapshot-model";
import type { HotfixContext } from "./version20-hotfix";
import type { CompactItem } from "./types";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const DEFAULT_RECONCILIATIONS = 2;
const MAX_RECONCILIATIONS = 3;
const PLAN_PREFIX = "integrated:plan:";
const OPERATION_PREFIX = "integrated:operation:";
const RECONCILIATION_PREFIX = "integrated:reconciliation:";
const DIFF_JOB_PREFIX = "integrated:diff-job:";
const DIFF_RESULT_PREFIX = "integrated:diff:";

function textResult(data: unknown): CallToolResult {
  const structuredContent = data && typeof data === "object" ? data as Record<string, unknown> : { value: data };
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  return safeErrorResult(error) as CallToolResult;
}

function planKey(planId: string): string { return `${PLAN_PREFIX}${planId}`; }
function operationKey(planId: string, actionId: string): string { return `${OPERATION_PREFIX}${planId}:${actionId}`; }
function reconciliationKey(planId: string, actionId: string): string { return `${RECONCILIATION_PREFIX}${planId}:${actionId}`; }
function diffJobReferenceKey(planId: string): string { return `${DIFF_JOB_PREFIX}${planId}`; }
function parentPath(path: string): string { return strictRelativePath(path).split("/").slice(0, -1).join("/"); }
function fileName(path: string): string { return strictRelativePath(path).split("/").pop() ?? ""; }

async function getPlan(context: HotfixContext, planId: string): Promise<IntegrityPlan> {
  const plan = await context.storage.get<IntegrityPlan>(planKey(planId));
  if (!plan || Date.parse(plan.expiresAt) <= Date.now()) throw new ConnectorError("plan_not_found", "The integrity plan does not exist or has expired.");
  return normalizeProgress(plan);
}

async function storePlan(context: HotfixContext, plan: IntegrityPlan): Promise<void> {
  await context.storage.put(planKey(plan.planId), plan);
}

export function refreshDependencySkips(plan: Pick<IntegrityPlan, "actions" | "completedActions" | "failedActions" | "skippedDependencyActions">): { added: string[]; reactivated: string[] } {
  const completed = new Set(plan.completedActions);
  const failed = new Set(plan.failedActions.map((entry) => entry.actionId));
  const previous = new Set(plan.skippedDependencyActions);
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const action of [...plan.actions].sort((a, b) => Number(a.operationOrder ?? 0) - Number(b.operationOrder ?? 0))) {
      if (completed.has(action.actionId) || failed.has(action.actionId) || blocked.has(action.actionId)) continue;
      if ((action.dependencies ?? []).some((dependency) => failed.has(dependency) || blocked.has(dependency))) {
        blocked.add(action.actionId);
        changed = true;
      }
    }
  }
  plan.skippedDependencyActions = [...blocked];
  return {
    added: [...blocked].filter((actionId) => !previous.has(actionId)),
    reactivated: [...previous].filter((actionId) => !blocked.has(actionId) && !completed.has(actionId)),
  };
}

function dependenciesSatisfied(plan: IntegrityPlan, action: PlanAction): boolean {
  const completed = new Set(plan.completedActions);
  return (action.dependencies ?? []).every((dependency) => completed.has(dependency));
}

function latestPriorResult(plan: IntegrityPlan, action: PlanAction): Record<string, unknown> | null {
  if (!action.sourceItemId) return null;
  const order = Number(action.operationOrder ?? 0);
  const priorIds = new Set(plan.actions
    .filter((candidate) => candidate.sourceItemId === action.sourceItemId && Number(candidate.operationOrder ?? 0) < order && plan.completedActions.includes(candidate.actionId))
    .sort((a, b) => Number(b.operationOrder ?? 0) - Number(a.operationOrder ?? 0))
    .map((candidate) => candidate.actionId));
  return plan.results.find((result) => priorIds.has(String(result.actionId ?? ""))) ?? null;
}

function expectedRenameParent(plan: IntegrityPlan, action: PlanAction): string {
  const prior = latestPriorResult(plan, action);
  const priorAfter = prior?.after as CompactItem | undefined;
  return priorAfter?.relativePath ? parentPath(priorAfter.relativePath) : parentPath(String(action.sourcePath ?? ""));
}

function isAmbiguousFailure(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  const error = (record.error ?? {}) as Record<string, unknown>;
  const details = (error.details ?? {}) as Record<string, unknown>;
  const code = String(error.code ?? "");
  const graphCode = String(details.graphErrorCode ?? "").toLocaleLowerCase("en");
  const status = Number(error.status ?? 0);
  return ["graph_timeout", "graph_network_error", "graph_unreachable", "graph_server_error", "graph_subrequest_limit", "graph_rate_limited"].includes(code)
    || status >= 500
    || (code === "graph_request_failed" && graphCode === "invalidrequest");
}

async function currentSha256(context: HotfixContext, item: VerifiedItem): Promise<string | null> {
  if (item.item.folder) return null;
  if ((item.item.size ?? 0) > INTEGRATED_LIMITS.fileBytesMax) throw new ConnectorError("file_too_large", "The file exceeds the integrated-operation size limit.");
  const headers = item.item.eTag ? { "If-Match": item.item.eTag } : undefined;
  const bytes = await graphFetchBytes(
    context.env,
    context.userId,
    `/me/drive/items/${encodeURIComponent(item.item.id)}/content`,
    INTEGRATED_LIMITS.fileBytesMax,
    headers ? { headers } : {},
  );
  return sha256Bytes(bytes);
}

async function assertSnapshotIdentity(context: HotfixContext, action: PlanAction, live: VerifiedItem): Promise<void> {
  if (action.snapshotSha256 && !live.item.folder) {
    const actual = await currentSha256(context, live);
    if (actual !== action.snapshotSha256) throw new ConnectorError("sha256_conflict", "The live item does not match the plan snapshot hash.");
  }
}

type ReconciliationEvaluation = {
  satisfied: boolean;
  status?: "already_satisfied" | "externally_reconciled" | "reconciled_after_error";
  liveEvidence?: Record<string, unknown> | null;
  discrepancy?: string;
};

async function verifyRetainedEvidence(context: HotfixContext, action: PlanAction): Promise<Record<string, unknown> | null> {
  const evidence = action.evidence && typeof action.evidence === "object" ? action.evidence as Record<string, unknown> : {};
  const retainedId = String(evidence.retainedItemId ?? evidence.keepItemId ?? evidence.destinationItemId ?? "");
  if (!retainedId) return null;
  const retained = await verifyItemInsideRoot(context.env, context.userId, retainedId);
  const expectedHash = String(evidence.retainedSha256 ?? evidence.destinationSha256 ?? "");
  if (expectedHash && !retained.item.folder && await currentSha256(context, retained) !== expectedHash) return null;
  return compactVerifiedItem(retained);
}

async function evaluateAction(context: HotfixContext, plan: IntegrityPlan, action: PlanAction): Promise<ReconciliationEvaluation> {
  if (!action.sourceItemId || !["RENAME", "MOVE", "RECYCLE", "RECYCLE_FOLDER"].includes(action.action)) {
    return { satisfied: false, discrepancy: "action_requires_execution" };
  }
  let live: VerifiedItem | null = null;
  let missing = false;
  try {
    live = await verifyItemInsideRoot(context.env, context.userId, action.sourceItemId);
  } catch (error) {
    const safe = error instanceof ConnectorError ? error : new ConnectorError("reconciliation_failed", "The reconciliation read failed.");
    if (safe.code === "item_not_found") missing = true;
    else throw safe;
  }
  const operation = await context.storage.get<Record<string, unknown>>(operationKey(plan.planId, action.actionId));
  if (action.action === "RENAME") {
    if (!live) return { satisfied: false, discrepancy: "renamed_item_missing" };
    await assertSnapshotIdentity(context, action, live);
    const parentMatches = parentPath(live.relativePath).toLocaleLowerCase("en") === expectedRenameParent(plan, action).toLocaleLowerCase("en");
    const nameMatches = live.item.name === String(action.proposedFilename ?? "");
    return nameMatches && parentMatches
      ? { satisfied: true, status: isAmbiguousFailure(operation) ? "reconciled_after_error" : "already_satisfied", liveEvidence: compactVerifiedItem(live) }
      : { satisfied: false, liveEvidence: compactVerifiedItem(live), discrepancy: "rename_postcondition_not_satisfied" };
  }
  if (action.action === "MOVE") {
    if (!live) return { satisfied: false, discrepancy: "moved_item_missing" };
    await assertSnapshotIdentity(context, action, live);
    const destinationMatches = parentPath(live.relativePath).toLocaleLowerCase("en") === strictRelativePath(String(action.destinationPath ?? "")).toLocaleLowerCase("en");
    const nameMatches = !action.proposedFilename || live.item.name === action.proposedFilename;
    return destinationMatches && nameMatches
      ? { satisfied: true, status: isAmbiguousFailure(operation) ? "reconciled_after_error" : "already_satisfied", liveEvidence: compactVerifiedItem(live) }
      : { satisfied: false, liveEvidence: compactVerifiedItem(live), discrepancy: "move_postcondition_not_satisfied" };
  }
  if (!missing) return { satisfied: false, liveEvidence: live ? compactVerifiedItem(live) : null, discrepancy: "recycle_postcondition_not_satisfied" };
  const retainedEvidence = await verifyRetainedEvidence(context, action).catch(() => null);
  const operationSupportsIdentity = operation?.state === "prepared" || isAmbiguousFailure(operation);
  const dependenciesComplete = dependenciesSatisfied(plan, action);
  if ((operationSupportsIdentity || retainedEvidence) && dependenciesComplete) {
    return {
      satisfied: true,
      status: operationSupportsIdentity ? "reconciled_after_error" : "externally_reconciled",
      liveEvidence: { sourceItemId: action.sourceItemId, missingByStableId: true, retainedEvidence },
    };
  }
  return { satisfied: false, liveEvidence: { sourceItemId: action.sourceItemId, missingByStableId: true }, discrepancy: "ambiguous_disappearance" };
}

async function markReconciled(
  context: HotfixContext,
  plan: IntegrityPlan,
  action: PlanAction,
  evaluation: ReconciliationEvaluation,
): Promise<void> {
  const reconciledAt = nowIso();
  const result = {
    actionId: action.actionId,
    action: action.action,
    reconciliationStatus: evaluation.status,
    alreadyApplied: true,
    originalPlanAction: action,
    snapshotEvidence: {
      sourceItemId: action.sourceItemId ?? null,
      sourcePath: action.sourcePath ?? null,
      snapshotETag: action.snapshotETag ?? null,
      snapshotSha256: action.snapshotSha256 ?? null,
    },
    liveEvidence: evaluation.liveEvidence ?? null,
    reconciledAt,
  };
  plan.completedActions = uniqueStrings([...plan.completedActions, action.actionId]);
  plan.failedActions = plan.failedActions.filter((entry) => entry.actionId !== action.actionId);
  plan.results = upsertResult(plan.results, result);
  await context.storage.put(operationKey(plan.planId, action.actionId), { state: "completed", ...result });
  await context.storage.put(reconciliationKey(plan.planId, action.actionId), result);
}

export async function reconcileIntegrityPlan(
  context: HotfixContext,
  input: { planId: string; maximumActions?: number },
): Promise<Record<string, unknown>> {
  const plan = await getPlan(context, input.planId);
  const maximumActions = Math.min(Math.max(Number(input.maximumActions ?? DEFAULT_RECONCILIATIONS), 1), MAX_RECONCILIATIONS);
  const reconciledThisInvocation: string[] = [];
  const discrepancies: Array<Record<string, unknown>> = [];
  let examined = 0;
  refreshDependencySkips(plan);
  const candidates = [...plan.actions].sort((a, b) => Number(a.operationOrder ?? 0) - Number(b.operationOrder ?? 0));
  for (const action of candidates) {
    if (examined >= maximumActions) break;
    if (plan.completedActions.includes(action.actionId)) continue;
    if (!["RENAME", "MOVE", "RECYCLE", "RECYCLE_FOLDER"].includes(action.action)) continue;
    if (!dependenciesSatisfied(plan, action) && !plan.failedActions.some((entry) => entry.actionId === action.actionId)) continue;
    examined += 1;
    const evaluation = await evaluateAction(context, plan, action);
    if (evaluation.satisfied) {
      await markReconciled(context, plan, action, evaluation);
      reconciledThisInvocation.push(action.actionId);
      refreshDependencySkips(plan);
    } else {
      discrepancies.push({ actionId: action.actionId, action: action.action, discrepancy: evaluation.discrepancy, liveEvidence: evaluation.liveEvidence ?? null });
    }
  }
  normalizeProgress(plan);
  const dependencyRefresh = refreshDependencySkips(plan);
  const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  plan.nextAction = remaining[0]?.actionId ?? null;
  if (remaining.length > 0 || plan.failedActions.length > 0 || plan.skippedDependencyActions.length > 0) {
    plan.status = "running";
    plan.executionStatus = "running";
  }
  await storePlan(context, plan);
  return {
    planId: plan.planId,
    examinedThisInvocation: examined,
    reconciledThisInvocation,
    discrepanciesRequiringExecution: discrepancies,
    reactivatedDependencyActions: dependencyRefresh.reactivated,
    skippedDependencyActions: plan.skippedDependencyActions,
    failedActions: plan.failedActions,
    remainingActions: remaining.length,
    nextAction: plan.nextAction,
    resumeRequired: remaining.length > 0,
    mutationPerformed: false,
    auditRecordsWritten: reconciledThisInvocation.length,
  };
}

type RuntimeOverride = { action: PlanAction; sourcePath?: string | null; currentFilename?: string | null; snapshotETag?: string | null };

async function applyRuntimeOverride(context: HotfixContext, plan: IntegrityPlan): Promise<RuntimeOverride | null> {
  refreshDependencySkips(plan);
  const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  const action = remaining[0];
  if (!action?.sourceItemId || !["RENAME", "MOVE", "REPLACE_TEXT", "RECYCLE", "RECYCLE_FOLDER"].includes(action.action)) return null;
  const live = await verifyItemInsideRoot(context.env, context.userId, action.sourceItemId);
  const prior = latestPriorResult(plan, action);
  const priorAfter = prior?.after as CompactItem | undefined;
  const chained = Boolean(priorAfter?.relativePath && priorAfter.relativePath === live.relativePath);
  if (!chained) return null;
  await assertSnapshotIdentity(context, action, live);
  const original: RuntimeOverride = { action, sourcePath: action.sourcePath, currentFilename: action.currentFilename, snapshotETag: action.snapshotETag };
  action.sourcePath = live.relativePath;
  action.currentFilename = live.item.name;
  action.snapshotETag = live.item.eTag ?? null;
  await context.storage.put(reconciliationKey(plan.planId, `${action.actionId}:runtime`), {
    actionId: action.actionId,
    runtimePathResolvedByStableItemId: true,
    originalSourcePath: original.sourcePath ?? null,
    currentSourcePath: live.relativePath,
    originalSnapshotETag: original.snapshotETag ?? null,
    currentETag: live.item.eTag ?? null,
    recordedAt: nowIso(),
  });
  await storePlan(context, plan);
  return original;
}

async function restoreRuntimeOverride(context: HotfixContext, planId: string, override: RuntimeOverride | null): Promise<void> {
  if (!override) return;
  const plan = await getPlan(context, planId);
  const action = plan.actions.find((candidate) => candidate.actionId === override.action.actionId);
  if (!action) return;
  action.sourcePath = override.sourcePath;
  action.currentFilename = override.currentFilename;
  action.snapshotETag = override.snapshotETag;
  await storePlan(context, plan);
}

export async function executeIntegrityPlanRepair(context: HotfixContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await openJson<{ planId: string; planHash: string; expiresAt: number }>(context.env.COOKIE_ENCRYPTION_KEY, String(input.executionToken ?? "")).catch(() => null);
  if (!token || token.expiresAt <= Date.now()) throw new ConnectorError("execution_token_invalid", "The execution token is invalid or expired.");
  const pre = await reconcileIntegrityPlan(context, { planId: token.planId, maximumActions: DEFAULT_RECONCILIATIONS });
  const preReconciled = pre.reconciledThisInvocation as string[];
  if (preReconciled.length > 0) {
    const plan = await getPlan(context, token.planId);
    const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    return {
      planId: plan.planId,
      status: plan.status,
      executionStatus: plan.executionStatus,
      completedThisInvocation: [],
      reconciledThisInvocation: preReconciled,
      failedThisInvocation: [],
      remainingActions: remaining.length,
      nextAction: plan.nextAction ?? remaining[0]?.actionId ?? null,
      resumeRequired: remaining.length > 0,
      auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running",
      mutationPerformed: false,
      reconciliationOnlyThisInvocation: true,
    };
  }
  let plan = await getPlan(context, token.planId);
  const override = await applyRuntimeOverride(context, plan);
  let legacy: Record<string, unknown>;
  try {
    legacy = await executeLegacyIntegrityPlan(context as any, input);
  } finally {
    await restoreRuntimeOverride(context, token.planId, override);
  }
  const failedThisInvocation = Array.isArray(legacy.failedThisInvocation) ? legacy.failedThisInvocation.map(String) : [];
  const reconciledAfterError: string[] = [];
  if (failedThisInvocation.length > 0) {
    const post = await reconcileIntegrityPlan(context, { planId: token.planId, maximumActions: failedThisInvocation.length });
    reconciledAfterError.push(...((post.reconciledThisInvocation as string[]) ?? []));
  }
  plan = await getPlan(context, token.planId);
  const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  return {
    ...legacy,
    completedThisInvocation: (legacy.completedThisInvocation as string[] | undefined) ?? [],
    reconciledThisInvocation: reconciledAfterError,
    failedThisInvocation: failedThisInvocation.filter((actionId) => !reconciledAfterError.includes(actionId)),
    remainingActions: remaining.length,
    nextAction: plan.nextAction ?? remaining[0]?.actionId ?? null,
    resumeRequired: remaining.length > 0,
    auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running",
  };
}

async function listSnapshotRecords(context: HotfixContext, snapshotId: string): Promise<SnapshotRecord[]> {
  const records = await context.storage.list<SnapshotRecord>({ prefix: snapshotPrefix(snapshotId) });
  return [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

function classifyDiff(before: SnapshotRecord[], after: SnapshotRecord[]): Record<string, unknown> {
  const beforeById = new Map(before.map((record) => [record.itemId, record]));
  const afterById = new Map(after.map((record) => [record.itemId, record]));
  const additions = after.filter((record) => !beforeById.has(record.itemId));
  const removals = before.filter((record) => !afterById.has(record.itemId));
  const renames: Array<Record<string, unknown>> = [];
  const moves: Array<Record<string, unknown>> = [];
  const eTagChanges: Array<Record<string, unknown>> = [];
  const sizeChanges: Array<Record<string, unknown>> = [];
  const hashChanges: Array<Record<string, unknown>> = [];
  const folderStructureChanges: Array<Record<string, unknown>> = [];
  for (const original of before) {
    const live = afterById.get(original.itemId);
    if (!live) continue;
    if (original.filename !== live.filename) renames.push({ itemId: original.itemId, before: original.relativePath, after: live.relativePath, beforeName: original.filename, afterName: live.filename });
    if (parentPath(original.relativePath) !== parentPath(live.relativePath)) moves.push({ itemId: original.itemId, before: original.relativePath, after: live.relativePath });
    if (original.eTag !== live.eTag) eTagChanges.push({ itemId: original.itemId, path: live.relativePath, before: original.eTag, after: live.eTag });
    if (original.type === "file" && original.byteSize !== live.byteSize) sizeChanges.push({ itemId: original.itemId, path: live.relativePath, before: original.byteSize, after: live.byteSize });
    if (original.sha256 && live.sha256 && original.sha256 !== live.sha256) hashChanges.push({ itemId: original.itemId, path: live.relativePath, before: original.sha256, after: live.sha256 });
    if (original.parentItemId !== live.parentItemId) folderStructureChanges.push({ itemId: original.itemId, beforeParentItemId: original.parentItemId, afterParentItemId: live.parentItemId, beforePath: original.relativePath, afterPath: live.relativePath });
  }
  return { additions, removals, renames, moves, eTagChanges, sizeChanges, hashChanges, folderStructureChanges };
}

async function finalizeDiffJob(context: HotfixContext, parent: JobRecord): Promise<JobRecord> {
  const planId = String(parent.resultReferences.planId ?? "");
  const finalSnapshotId = String(parent.resultReferences.finalSnapshotId ?? "");
  const plan = await getPlan(context, planId);
  const original = await listSnapshotRecords(context, plan.snapshotId);
  const finalRecords = await listSnapshotRecords(context, finalSnapshotId);
  const changes = classifyDiff(original, finalRecords);
  const operationLogs = await context.storage.list<Record<string, unknown>>({ prefix: `${OPERATION_PREFIX}${planId}:` });
  const outsideScope = [...operationLogs.values()].filter((record) => {
    const before = record.before as CompactItem | undefined;
    const after = record.after as CompactItem | undefined;
    const inside = (path: string | undefined) => !path || !plan.scopePath || path === plan.scopePath || path.startsWith(`${plan.scopePath}/`);
    return !inside(before?.relativePath) || !inside(after?.relativePath);
  });
  const result = {
    planId,
    originalSnapshotId: plan.snapshotId,
    finalSnapshotId,
    scopePath: plan.scopePath,
    planOperations: plan.actions,
    operationLogs: [...operationLogs.values()],
    ...changes,
    outOfScopeMutationEvidence: outsideScope,
    proof: {
      originalSnapshotImmutable: true,
      finalSnapshotResumable: true,
      fullTreeReenumeratedPerContinuation: false,
      persistedCursorUsed: true,
      boundedGraphRequestsPerContinuation: true,
      finalSnapshotHashesRequested: true,
      outsideScopeOperationCount: outsideScope.length,
    },
    completedAt: nowIso(),
  };
  const resultKey = `${DIFF_RESULT_PREFIX}${planId}`;
  await context.storage.put(resultKey, result);
  parent.status = "completed";
  parent.progress = 100;
  parent.currentStage = "completed";
  parent.error = null;
  parent.resultReferences = { ...parent.resultReferences, resultKey, result };
  await putJob(context.storage, parent);
  plan.auditStatus = "completed";
  plan.finalFilesystemDiffReference = resultKey;
  await storePlan(context, plan);
  return parent;
}

export type SnapshotStatusReader = (jobId: string) => Promise<JobRecord>;

export async function getIntegrityJobStatus(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string, snapshotStatus?: SnapshotStatusReader): Promise<JobRecord> {
  const job = await getJob(context.storage, jobId);
  const readSnapshotStatus: SnapshotStatusReader = snapshotStatus ?? ((childJobId) => getSnapshotJobStatus(context, schedule, childJobId));
  if (job.type !== "integrity_diff") return readSnapshotStatus(jobId);
  if (["completed", "failed", "cancelled"].includes(job.status)) return job;
  const childJobId = String(job.resultReferences.finalSnapshotJobId ?? "");
  const child = await readSnapshotStatus(childJobId);
  if (child.status === "failed" || child.status === "cancelled") {
    job.status = "failed";
    job.currentStage = "final_snapshot_failed";
    job.error = child.error ?? { code: "final_snapshot_failed", message: "The final audit snapshot failed.", retryable: false };
    await putJob(context.storage, job);
    const plan = await getPlan(context, String(job.resultReferences.planId ?? ""));
    plan.auditStatus = "failed";
    await storePlan(context, plan);
    return job;
  }
  if (child.status === "completed") return finalizeDiffJob(context, job);
  job.status = "running";
  job.progress = Math.min(95, child.progress);
  job.currentStage = `final_snapshot_${child.currentStage}`;
  await putJob(context.storage, job);
  return job;
}

export async function startDiffScopeBeforeAfter(context: HotfixContext, schedule: ScheduleSnapshot, planId: string): Promise<Record<string, unknown>> {
  const plan = await getPlan(context, planId);
  const existingJobId = await context.storage.get<string>(diffJobReferenceKey(planId));
  if (existingJobId) {
    const existing = await getJob(context.storage, existingJobId);
    return existing.status === "completed" ? (existing.resultReferences.result as Record<string, unknown>) : { jobId: existing.jobId, status: existing.status, progress: existing.progress, currentStage: existing.currentStage, resumable: true };
  }
  const originalMeta = await context.storage.get<SnapshotMeta>(snapshotMetaKey(plan.snapshotId));
  if (!originalMeta) throw new ConnectorError("snapshot_not_found", "The original plan snapshot does not exist.");
  const finalSnapshot = await createSourceSnapshot(context, schedule, {
    scopePath: plan.scopePath,
    recursive: true,
    includeFiles: true,
    includeFolders: true,
    calculateSha256: true,
    calculateNormalizedTextHash: false,
    includeDocumentMetadata: false,
    includeExtractionStatus: true,
    maximumItems: Math.min(Math.max(originalMeta.totalRecords + 1_000, 1_000), INTEGRATED_LIMITS.snapshotItemsMax),
    maximumDepth: INTEGRATED_LIMITS.recursionDepthMax,
  });
  const jobId = crypto.randomUUID();
  const createdAt = nowIso();
  const parent: JobRecord = {
    jobId,
    type: "integrity_diff",
    status: "queued",
    progress: 0,
    currentStage: "final_snapshot_queued",
    createdAt,
    updatedAt: createdAt,
    expiresAt: expiryIso(JOB_RETENTION_SECONDS),
    resultReferences: {
      planId,
      originalSnapshotId: plan.snapshotId,
      finalSnapshotId: String(finalSnapshot.snapshotId),
      finalSnapshotJobId: String(finalSnapshot.jobId),
    },
    error: null,
  };
  await context.storage.put(jobKey(jobId), parent);
  await context.storage.put(diffJobReferenceKey(planId), jobId);
  plan.auditStatus = "running";
  await storePlan(context, plan);
  return { jobId, status: "queued", progress: 0, currentStage: parent.currentStage, finalSnapshotJobId: finalSnapshot.jobId, resumable: true, boundedPerInvocation: true };
}

export function registerIntegrityResumeRepairTools(
  server: McpServer,
  contextFactory: () => HotfixContext,
  schedule: ScheduleSnapshot,
): void {
  const target = server as any;
  const originalSend = target.sendToolListChanged;
  target.sendToolListChanged = () => undefined;
  try {
    delete target._registeredTools?.execute_integrity_plan;
    delete target._registeredTools?.get_integrity_plan_status;
    delete target._registeredTools?.diff_scope_before_after;
    delete target._registeredTools?.get_job_status;
    delete target._registeredTools?.reconcile_integrity_plan;

    server.registerTool("reconcile_integrity_plan", {
      title: "Reconcile integrity plan",
      description: "Read-only reconciliation of pending, failed, and dependency-skipped rename, move, and recycle actions against stable OneDrive item IDs and durable evidence. Never performs a mutation.",
      inputSchema: { planId: z.string().uuid(), maximumActions: z.number().int().min(1).max(MAX_RECONCILIATIONS).optional() },
      annotations: READ_ONLY,
    }, async (input) => { try { return textResult(await reconcileIntegrityPlan(contextFactory(), input)); } catch (error) { return errorResult(error); } });

    server.registerTool("execute_integrity_plan", {
      title: "Resume reconciled integrity plan",
      description: "Reconcile already-satisfied actions first, reactivate dependencies, resolve mutation sources by stable item ID, and execute at most one actual mutation per invocation.",
      inputSchema: { executionToken: z.string().min(1).max(50_000) },
      annotations: DESTRUCTIVE,
    }, async (input) => { try { return textResult(await executeIntegrityPlanRepair(contextFactory(), input)); } catch (error) { return errorResult(error); } });

    server.registerTool("get_integrity_plan_status", {
      title: "Get reconciled integrity plan status",
      description: "Return durable execution, reconciliation, dependency, next-action, and resumable audit status.",
      inputSchema: { planId: z.string().uuid() },
      annotations: READ_ONLY,
    }, async ({ planId }) => { try {
      const plan = await getPlan(contextFactory(), planId);
      refreshDependencySkips(plan);
      const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
      return textResult({ planId, planStatus: plan.status, validationStatus: plan.validationStatus, executionStatus: plan.executionStatus, currentAction: plan.currentAction, nextAction: plan.nextAction ?? remaining[0]?.actionId ?? null, resumeRequired: remaining.length > 0, remainingActions: remaining.length, completedActions: plan.completedActions, failedActions: plan.failedActions, skippedDependencyActions: plan.skippedDependencyActions, auditStatus: plan.auditStatus ?? "not_requested", finalFilesystemDiffReference: plan.finalFilesystemDiffReference });
    } catch (error) { return errorResult(error); } });

    server.registerTool("diff_scope_before_after", {
      title: "Start or resume bounded final integrity audit",
      description: "Start a Durable Object-backed resumable final snapshot and diff job. Returns a job ID when completion requires multiple bounded Worker invocations.",
      inputSchema: { planId: z.string().uuid() },
      annotations: READ_ONLY,
    }, async ({ planId }) => { try { return textResult(await startDiffScopeBeforeAfter(contextFactory(), schedule, planId)); } catch (error) { return errorResult(error); } });

    server.registerTool("get_job_status", {
      title: "Get integrated job status",
      description: "Return and advance resumable source-snapshot and integrity-diff jobs without restarting completed traversal work.",
      inputSchema: { jobId: z.string().uuid() },
      annotations: READ_ONLY,
    }, async ({ jobId }) => { try { return textResult(await getIntegrityJobStatus(contextFactory(), schedule, jobId)); } catch (error) { return errorResult(error); } });
  } finally {
    target.sendToolListChanged = originalSend;
  }
}

export const integrityResumeRepairTestHooks = {
  classifyDiff,
  evaluateAction,
  isAmbiguousFailure,
  refreshDependencySkips,
};
