import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError, safeErrorResult } from "./errors";
import type { IntegrityPlan, PlanAction } from "./integrated-tools";
import { remainingActions } from "./integrity-execution";
import { executeIntegrityPlanWithBlockedMoveReconciliation, unresolvedActions } from "./integrity-blocked-move-reconcile";
import { getIntegrityJobStatus, reconcileIntegrityPlan, refreshDependencySkips, startDiffScopeBeforeAfter } from "./integrity-resume-repair";
import { continueSourceSnapshotJob } from "./source-snapshot-repair";
import type { ScheduleSnapshot } from "./snapshot-model";
import { openJson } from "./security";
import type { HotfixContext } from "./version20-hotfix";
import {
  DEFAULT_INTEGRITY_LEASE_SECONDS,
  callIntegrityCoordination,
  createJobFencedStorage,
  createLeaseFencedStorage,
  type IntegrityOwnerType,
  type JobLeaseReference,
  type LeaseReference,
  type ReservationState,
} from "./integrity-coordination";

const PLAN_PREFIX = "integrated:plan:";
const DIFF_JOB_PREFIX = "integrated:diff-job:";
const JOB_PREFIX = "integrated:job:";
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const OWNER_TYPES = ["manual", "scheduled_task", "api", "recovery", "internal_job"] as const;

type ExecutionInput = {
  executionToken: string;
  ownerType?: IntegrityOwnerType;
  ownerId?: string;
  invocationId?: string;
  correlationId?: string;
};

type LeaseMetadata = {
  planId: string;
  leaseId: string;
  fencingToken: number;
  invocationId: string;
  leaseExpiresAt: string;
  recoveredExpiredLease: boolean;
  recoveryMetadata?: Record<string, unknown>;
};

function nowIso(): string { return new Date().toISOString(); }
function textResult(data: unknown): CallToolResult {
  const structuredContent = data && typeof data === "object" ? data as Record<string, unknown> : { value: data };
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }] };
}
function errorResult(error: unknown): CallToolResult { return safeErrorResult(error) as CallToolResult; }
function leaseSeconds(env: Env): number { return Number(env.INTEGRITY_LEASE_SECONDS ?? DEFAULT_INTEGRITY_LEASE_SECONDS); }
function workerVersion(env: Env): string { return String(env.WORKER_DEPLOYMENT_ID ?? env.WORKER_VERSION ?? "unknown").slice(0, 200); }
function planKey(planId: string): string { return `${PLAN_PREFIX}${planId}`; }

async function getPlan(context: HotfixContext, planId: string): Promise<IntegrityPlan> {
  const plan = await context.storage.get<IntegrityPlan>(planKey(planId));
  if (!plan || Date.parse(plan.expiresAt) <= Date.now()) throw new ConnectorError("plan_not_found", "The integrity plan does not exist or has expired.");
  refreshDependencySkips(plan);
  return plan;
}

function executionDefaults(input: ExecutionInput): Required<Pick<ExecutionInput, "ownerType" | "ownerId" | "invocationId">> & { correlationId: string | null } {
  const ownerType = input.ownerType ?? "manual";
  return {
    ownerType,
    ownerId: String(input.ownerId ?? `${ownerType}:server-generated`).slice(0, 500),
    invocationId: String(input.invocationId ?? crypto.randomUUID()).slice(0, 500),
    correlationId: input.correlationId ? String(input.correlationId).slice(0, 500) : null,
  };
}

function actionEvidence(action: PlanAction): { expectedPreconditions: Record<string, unknown>; intendedPostcondition: Record<string, unknown> } {
  return {
    expectedPreconditions: {
      sourceItemId: action.sourceItemId ?? null,
      sourcePath: action.sourcePath ?? null,
      snapshotETag: action.snapshotETag ?? null,
      snapshotSha256: action.snapshotSha256 ?? null,
      dependencies: action.dependencies ?? [],
    },
    intendedPostcondition: {
      action: action.action,
      destinationPath: action.destinationPath ?? null,
      proposedFilename: action.proposedFilename ?? null,
      sourceAbsent: action.action === "RECYCLE" || action.action === "RECYCLE_FOLDER",
    },
  };
}

async function recoveryResolution(context: HotfixContext, planId: string, previousActionId: string | null): Promise<Record<string, unknown>> {
  const before = await callIntegrityCoordination(context.env, context.userId, { op: "status", planId });
  const reservation = before.reservation as Record<string, unknown> | null;
  const actionId = previousActionId || String(reservation?.actionId ?? "") || null;
  const operation = actionId ? await context.storage.get<Record<string, unknown>>(`integrated:operation:${planId}:${actionId}`) : undefined;
  const reconciliation = await reconcileIntegrityPlan(context, { planId, maximumActions: 3 });
  const reconciled = Array.isArray(reconciliation.reconciledThisInvocation) ? reconciliation.reconciledThisInvocation.map(String) : [];
  let result = "ready_for_retry";
  if (actionId && (operation?.state === "completed" || reconciled.includes(actionId))) result = "completed";
  else if (operation?.state === "prepared" || reservation?.state === "mutation_in_progress") result = "manual_review";
  else if (operation?.state === "failed") {
    const error = operation.error as Record<string, unknown> | undefined;
    const retryable = Boolean(error?.retryable);
    const ambiguous = ["graph_timeout", "graph_network_error", "graph_unreachable", "graph_server_error", "graph_subrequest_limit", "graph_rate_limited", "graph_request_failed"].includes(String(error?.code ?? ""));
    result = retryable && !ambiguous ? "ready_for_retry" : ambiguous ? "manual_review" : "failed_closed";
  }
  return {
    previousActionId: actionId,
    reconciliationResult: result,
    reconciledActions: reconciled,
    operationState: operation?.state ?? null,
    recoveredAt: nowIso(),
  };
}

async function acquireExecutionLease(context: HotfixContext, planId: string, input: ExecutionInput): Promise<LeaseMetadata | Record<string, unknown>> {
  const defaults = executionDefaults(input);
  const request = {
    op: "acquire",
    planId,
    ...defaults,
    workerVersion: workerVersion(context.env),
    leaseDurationSeconds: leaseSeconds(context.env),
  } as const;
  let result = await callIntegrityCoordination(context.env, context.userId, request);
  let recoveryMetadata: Record<string, unknown> | undefined;
  if (result.recoveryRequired === true) {
    recoveryMetadata = await recoveryResolution(context, planId, String(result.previousActionId ?? "") || null);
    result = await callIntegrityCoordination(context.env, context.userId, { ...request, recoveryResolution: recoveryMetadata });
  }
  if (result.acquired !== true) return { ...result, executionState: "already_executing", leaseAcquired: false, alreadyExecuting: true, completedThisInvocation: [], reconciledThisInvocation: [], failedThisInvocation: [], resumeRequired: true, planComplete: false };
  return {
    planId,
    leaseId: String(result.leaseId),
    fencingToken: Number(result.fencingToken),
    invocationId: defaults.invocationId,
    leaseExpiresAt: String(result.leaseExpiresAt),
    recoveredExpiredLease: Boolean(result.recoveredExpiredLease),
    recoveryMetadata,
  };
}

function isLeaseMetadata(value: LeaseMetadata | Record<string, unknown>): value is LeaseMetadata {
  return typeof (value as LeaseMetadata).leaseId === "string" && typeof (value as LeaseMetadata).fencingToken === "number";
}

async function releaseLease(context: HotfixContext, lease: LeaseMetadata, outcome: unknown): Promise<void> {
  await callIntegrityCoordination(context.env, context.userId, { op: "release", planId: lease.planId, leaseId: lease.leaseId, fencingToken: lease.fencingToken, invocationId: lease.invocationId, outcome });
}

async function executeWithLease(context: HotfixContext, input: ExecutionInput): Promise<Record<string, unknown>> {
  const token = await openJson<{ planId: string; planHash: string; expiresAt: number }>(context.env.COOKIE_ENCRYPTION_KEY, String(input.executionToken ?? "")).catch(() => null);
  if (!token || token.expiresAt <= Date.now()) throw new ConnectorError("execution_token_invalid", "The execution token is invalid or expired.");
  const acquired = await acquireExecutionLease(context, token.planId, input);
  if (!isLeaseMetadata(acquired)) return acquired;
  const lease: LeaseReference = { planId: acquired.planId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, invocationId: acquired.invocationId };
  let plan = await getPlan(context, token.planId);
  const unresolved = unresolvedActions(plan);
  const action = unresolved[0] ?? null;
  if (!action) {
    await releaseLease(context, acquired, { reason: "plan_complete" });
    return {
      planId: plan.planId,
      executionState: "complete",
      leaseAcquired: true,
      alreadyExecuting: false,
      leaseId: acquired.leaseId,
      fencingToken: acquired.fencingToken,
      leaseExpiresAt: acquired.leaseExpiresAt,
      recoveredExpiredLease: acquired.recoveredExpiredLease,
      completedThisInvocation: [],
      reconciledThisInvocation: [],
      failedThisInvocation: [],
      remainingActions: 0,
      nextAction: null,
      currentAction: null,
      resumeRequired: false,
      auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running",
      planComplete: true,
    };
  }
  const evidence = actionEvidence(action);
  const reserved = await callIntegrityCoordination(context.env, context.userId, { op: "reserve", ...lease, actionId: action.actionId, ...evidence });
  const reservation = reserved.reservation as Record<string, unknown>;
  await callIntegrityCoordination(context.env, context.userId, { op: "mark-mutation-started", ...lease, actionId: action.actionId, progressSequence: 1, leaseDurationSeconds: leaseSeconds(context.env) });
  const fencedContext: HotfixContext = { ...context, storage: createLeaseFencedStorage(context.storage, context.env, context.userId, lease) };
  const underlying = await executeIntegrityPlanWithBlockedMoveReconciliation(fencedContext, { executionToken: input.executionToken });
  const completed = Array.isArray(underlying.completedThisInvocation) ? underlying.completedThisInvocation.map(String) : [];
  const reconciled = Array.isArray(underlying.reconciledThisInvocation) ? underlying.reconciledThisInvocation.map(String) : [];
  const failed = Array.isArray(underlying.failedThisInvocation) ? underlying.failedThisInvocation.map(String) : [];
  let state: ReservationState = "ready_for_retry";
  if (completed.includes(action.actionId)) state = "completed";
  else if (reconciled.includes(action.actionId)) state = "reconciled";
  else if (failed.includes(action.actionId)) state = "failed";
  else if (underlying.discrepancy) state = "manual_review";
  await callIntegrityCoordination(context.env, context.userId, { op: "finalize-action", ...lease, actionId: action.actionId, reservationState: state, outcome: { underlying, idempotencyKey: reservation.idempotencyKey } });
  await releaseLease(context, acquired, { state, actionId: action.actionId });
  plan = await getPlan(context, token.planId);
  const unresolvedAfter = unresolvedActions(plan);
  const readyAfter = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  return {
    ...underlying,
    executionState: unresolvedAfter.length === 0 ? "complete" : state === "manual_review" ? "manual_review" : "yielded",
    leaseAcquired: true,
    alreadyExecuting: false,
    leaseId: acquired.leaseId,
    fencingToken: acquired.fencingToken,
    leaseExpiresAt: acquired.leaseExpiresAt,
    recoveredExpiredLease: acquired.recoveredExpiredLease,
    recoveryMetadata: acquired.recoveryMetadata ?? null,
    currentAction: action.actionId,
    actionReservation: { actionId: action.actionId, attempt: reservation.attempt, idempotencyKey: reservation.idempotencyKey, state },
    completedThisInvocation: completed,
    reconciledThisInvocation: reconciled,
    failedThisInvocation: failed,
    remainingActions: unresolvedAfter.length,
    nextAction: unresolvedAfter[0]?.actionId ?? null,
    nextReadyAction: readyAfter[0]?.actionId ?? null,
    resumeRequired: unresolvedAfter.length > 0,
    auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running",
    planComplete: unresolvedAfter.length === 0,
  };
}

async function reconcileWithLease(context: HotfixContext, input: { planId: string; maximumActions?: number; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {
  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "internal_job", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
  if (!isLeaseMetadata(acquired)) return acquired;
  const lease: LeaseReference = { planId: acquired.planId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, invocationId: acquired.invocationId };
  const fencedContext: HotfixContext = { ...context, storage: createLeaseFencedStorage(context.storage, context.env, context.userId, lease) };
  const result = await reconcileIntegrityPlan(fencedContext, { planId: input.planId, maximumActions: input.maximumActions });
  await releaseLease(context, acquired, { reconciliationOnly: true });
  return { ...result, executionState: "reconciled", leaseAcquired: true, alreadyExecuting: false, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, leaseExpiresAt: acquired.leaseExpiresAt, recoveredExpiredLease: acquired.recoveredExpiredLease };
}

async function executionState(context: HotfixContext, planId: string): Promise<Record<string, unknown>> {
  const plan = await getPlan(context, planId);
  const coordination = await callIntegrityCoordination(context.env, context.userId, { op: "status", planId });
  const unresolved = unresolvedActions(plan);
  const ready = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  const diffJobId = await context.storage.get<string>(`${DIFF_JOB_PREFIX}${planId}`);
  const diffJob = diffJobId ? await context.storage.get<Record<string, unknown>>(`${JOB_PREFIX}${diffJobId}`) : null;
  const recommended = coordination.recoveryRequired ? "request_integrity_plan_lease_recovery" : coordination.leased ? "wait_and_retry" : unresolved.length > 0 ? "validate_then_execute_integrity_plan" : plan.auditStatus === "pending" ? "diff_scope_before_after" : "none";
  return {
    planId,
    planStatus: plan.status,
    validationStatus: plan.validationStatus,
    executionStatus: plan.executionStatus,
    currentAction: plan.currentAction,
    nextAction: unresolved[0]?.actionId ?? null,
    nextReadyAction: ready[0]?.actionId ?? null,
    outstandingActions: unresolved.map((action) => action.actionId),
    remainingActions: unresolved.length,
    completedActions: plan.completedActions,
    failedActions: plan.failedActions,
    skippedDependencyActions: plan.skippedDependencyActions,
    auditStatus: plan.auditStatus ?? "not_requested",
    finalFilesystemDiffReference: plan.finalFilesystemDiffReference,
    activeJobs: diffJob ? [{ jobId: diffJobId, status: diffJob.status, currentStage: diffJob.currentStage }] : [],
    recoveryState: { required: Boolean(coordination.recoveryRequired), reservation: coordination.reservation ?? null },
    activeLease: coordination.activeLease ?? null,
    currentlyLeased: Boolean(coordination.leased),
    leaseExpired: Boolean(coordination.leaseExpired),
    auditInProgress: Boolean(coordination.auditInProgress),
    recommendedNextOperation: recommended,
    resumeRequired: unresolved.length > 0,
    planComplete: unresolved.length === 0,
  };
}

async function requestRecovery(context: HotfixContext, input: { planId: string; force?: boolean; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {
  const status = await callIntegrityCoordination(context.env, context.userId, { op: "status", planId: input.planId });
  if (status.leased === true && input.force !== true) return { recovered: false, activeLeaseStillValid: true, refusedCancellation: true, safeToRetry: true, activeLease: status.activeLease };
  if (status.leased === true && input.force === true) {
    const reservation = status.reservation as Record<string, unknown> | null;
    if (reservation?.state === "mutation_in_progress") return { recovered: false, refusedCancellation: true, reason: "mutation_commit_in_progress", activeLease: status.activeLease, reservation };
    const reconciliation = await reconcileIntegrityPlan(context, { planId: input.planId, maximumActions: 3 });
    const defaults = executionDefaults({ executionToken: "", ownerType: "recovery", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
    const invalidated = await callIntegrityCoordination(context.env, context.userId, { op: "force-invalidate", planId: input.planId, ...defaults, force: true, outcome: { reconciliation } });
    return { recovered: Boolean(invalidated.invalidated), forced: true, reconciliation, ...invalidated };
  }
  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "recovery", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
  if (!isLeaseMetadata(acquired)) return acquired;
  await releaseLease(context, acquired, { recoveryOnly: true });
  return { recovered: acquired.recoveredExpiredLease, previousLease: acquired.recoveryMetadata ?? null, newFencingToken: acquired.fencingToken, leaseReleased: true };
}

async function startDiffWithCoordination(context: HotfixContext, schedule: ScheduleSnapshot, planId: string): Promise<Record<string, unknown>> {
  const gate = await callIntegrityCoordination(context.env, context.userId, { op: "begin-plan-audit", planId, auditJobId: "pending" });
  if (gate.acquired !== true) return { ...gate, auditStarted: false, planId };
  try {
    const result = await startDiffScopeBeforeAfter(context, schedule, planId);
    if (result.jobId) await callIntegrityCoordination(context.env, context.userId, { op: "update-plan-audit", planId, auditJobId: String(result.jobId) });
    else await callIntegrityCoordination(context.env, context.userId, { op: "end-plan-audit", planId, outcome: { immediate: true } });
    return result;
  } catch (error) {
    await callIntegrityCoordination(context.env, context.userId, { op: "end-plan-audit", planId, outcome: { failedToStart: true } }).catch(() => undefined);
    throw error;
  }
}

async function getJobWithCoordination(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<Record<string, unknown>> {
  const invocationId = crypto.randomUUID();
  const acquired = await callIntegrityCoordination(context.env, context.userId, { op: "job-acquire", jobId, invocationId, ownerId: "get_job_status", ownerType: "internal_job", workerVersion: workerVersion(context.env) });
  if (acquired.acquired !== true) return { jobId, alreadyExecuting: true, safeToRetry: true, ...acquired };
  const lease: JobLeaseReference = { jobId, invocationId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken) };
  const fencedContext: HotfixContext = { ...context, storage: createJobFencedStorage(context.storage, context.env, context.userId, lease) };
  try {
    const result = await getIntegrityJobStatus(fencedContext, schedule, jobId);
    const planId = String(result.resultReferences?.planId ?? "");
    if (planId && ["completed", "failed", "cancelled"].includes(result.status)) await callIntegrityCoordination(context.env, context.userId, { op: "end-plan-audit", planId, auditJobId: jobId, outcome: { status: result.status } });
    return result as unknown as Record<string, unknown>;
  } finally {
    await callIntegrityCoordination(context.env, context.userId, { op: "job-release", ...lease }).catch(() => undefined);
  }
}

export async function continueSnapshotWithLease(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<Record<string, unknown>> {
  const invocationId = crypto.randomUUID();
  const acquired = await callIntegrityCoordination(context.env, context.userId, { op: "job-acquire", jobId, invocationId, ownerId: "scheduled_snapshot_continuation", ownerType: "internal_job", workerVersion: workerVersion(context.env) });
  if (acquired.acquired !== true) return { jobId, alreadyExecuting: true, safeToRetry: true, ...acquired };
  const lease: JobLeaseReference = { jobId, invocationId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken) };
  try {
    await continueSourceSnapshotJob({ ...context, storage: createJobFencedStorage(context.storage, context.env, context.userId, lease) }, schedule, jobId);
    return { jobId, continued: true, fencingToken: lease.fencingToken };
  } finally {
    await callIntegrityCoordination(context.env, context.userId, { op: "job-release", ...lease }).catch(() => undefined);
  }
}

export function registerIntegrityLeaseTools(server: McpServer, contextFactory: () => HotfixContext, schedule: ScheduleSnapshot): void {
  const target = server as any;
  const originalSend = target.sendToolListChanged;
  target.sendToolListChanged = () => undefined;
  try {
    for (const name of ["execute_integrity_plan", "reconcile_integrity_plan", "get_integrity_plan_status", "get_integrity_plan_execution_state", "request_integrity_plan_lease_recovery", "diff_scope_before_after", "get_job_status"]) delete target._registeredTools?.[name];
    server.registerTool("execute_integrity_plan", {
      title: "Resume integrity plan with a durable execution lease",
      description: "Atomically acquire a per-plan Durable Object lease, fence every mutation-state commit, reserve one action, reconcile ambiguous outcomes, execute a bounded batch, and release safely.",
      inputSchema: {
        executionToken: z.string().min(1).max(50_000),
        ownerType: z.enum(OWNER_TYPES).optional(),
        ownerId: z.string().min(1).max(500).optional(),
        invocationId: z.string().min(1).max(500).optional(),
        correlationId: z.string().min(1).max(500).optional(),
      },
      annotations: DESTRUCTIVE,
    }, async (input) => { try { return textResult(await executeWithLease(contextFactory(), input as ExecutionInput)); } catch (error) { return errorResult(error); } });
    server.registerTool("reconcile_integrity_plan", {
      title: "Reconcile integrity plan under the execution lease",
      description: "Perform read-only OneDrive inspection and fenced internal bookkeeping under the same per-plan lease used by mutation execution.",
      inputSchema: { planId: z.string().uuid(), maximumActions: z.number().int().min(1).max(3).optional(), ownerId: z.string().max(500).optional(), invocationId: z.string().max(500).optional(), correlationId: z.string().max(500).optional() },
      annotations: READ_ONLY,
    }, async (input) => { try { return textResult(await reconcileWithLease(contextFactory(), input)); } catch (error) { return errorResult(error); } });
    server.registerTool("get_integrity_plan_execution_state", {
      title: "Get integrity plan execution state",
      description: "Return plan progress, active lease summary, fencing token, reservation, recovery state, active audit jobs, and the recommended next operation without exposing sensitive owner data.",
      inputSchema: { planId: z.string().uuid() },
      annotations: READ_ONLY,
    }, async ({ planId }) => { try { return textResult(await executionState(contextFactory(), planId)); } catch (error) { return errorResult(error); } });
    server.registerTool("get_integrity_plan_status", {
      title: "Get integrity plan status and lease state",
      description: "Backward-compatible plan status extended with durable lease, reservation, recovery, and job coordination state.",
      inputSchema: { planId: z.string().uuid() },
      annotations: READ_ONLY,
    }, async ({ planId }) => { try { return textResult(await executionState(contextFactory(), planId)); } catch (error) { return errorResult(error); } });
    server.registerTool("request_integrity_plan_lease_recovery", {
      title: "Request guarded integrity lease recovery",
      description: "Recover an expired lease normally. Active leases are refused unless force is explicit, no mutation commit is in progress, reconciliation runs first, and the fencing token is incremented.",
      inputSchema: { planId: z.string().uuid(), force: z.boolean().optional(), ownerId: z.string().max(500).optional(), invocationId: z.string().max(500).optional(), correlationId: z.string().max(500).optional() },
      annotations: DESTRUCTIVE,
    }, async (input) => { try { return textResult(await requestRecovery(contextFactory(), input)); } catch (error) { return errorResult(error); } });
    server.registerTool("diff_scope_before_after", {
      title: "Start or resume coordinated final integrity audit",
      description: "Start the resumable final diff only when no mutation lease is active. The plan audit gate prevents mutation bookkeeping races until the audit job finishes.",
      inputSchema: { planId: z.string().uuid() },
      annotations: READ_ONLY,
    }, async ({ planId }) => { try { return textResult(await startDiffWithCoordination(contextFactory(), schedule, planId)); } catch (error) { return errorResult(error); } });
    server.registerTool("get_job_status", {
      title: "Get coordinated resumable job status",
      description: "Advance one snapshot or diff cursor under a per-job lease and fencing token so duplicate continuations cannot overwrite newer state.",
      inputSchema: { jobId: z.string().uuid() },
      annotations: READ_ONLY,
    }, async ({ jobId }) => { try { return textResult(await getJobWithCoordination(contextFactory(), schedule, jobId)); } catch (error) { return errorResult(error); } });
  } finally {
    target.sendToolListChanged = originalSend;
  }
}
