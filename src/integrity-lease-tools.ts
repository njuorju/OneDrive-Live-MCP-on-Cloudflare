import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError, safeErrorResult } from "./errors";
import type { IntegrityPlan, JobRecord, PlanAction } from "./integrated-tools";
import { remainingActions } from "./integrity-execution";
import { executeIntegrityPlanWithBlockedMoveReconciliation, unresolvedActions } from "./integrity-blocked-move-reconcile";
import { getIntegrityJobStatus, reconcileIntegrityPlan, refreshDependencySkips, startDiffScopeBeforeAfter } from "./integrity-resume-repair";
import { continueSourceSnapshotJob } from "./source-snapshot-repair";
import { resolveRelativeItem, verifyItemInsideRoot } from "./graph-core";
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
const INTEGRITY_LEASE_TOOLS_HARDENING_V2 = true;

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

function expectedRecoveryPath(action: PlanAction): string | null {
  if (action.action === "MOVE" && action.destinationPath) {
    const name = action.proposedFilename ?? action.currentFilename ?? action.sourcePath?.split("/").pop();
    return name ? `${action.destinationPath.replace(/\/$/, "")}/${name}`.replace(/^\//, "") : null;
  }
  if (action.action === "RENAME" && action.sourcePath && action.proposedFilename) {
    const parent = action.sourcePath.split("/").slice(0, -1).join("/");
    return parent ? `${parent}/${action.proposedFilename}` : action.proposedFilename;
  }
  return null;
}

async function classifyReservedActionRecovery(context: HotfixContext, plan: IntegrityPlan, action: PlanAction, reservation: Record<string, unknown> | null, operation: Record<string, unknown> | undefined): Promise<string> {
  if (operation?.state === "completed" || plan.completedActions.includes(action.actionId)) return "completed";
  if (reservation?.state === "reserved") return "ready_for_retry";
  if (["RENAME", "MOVE"].includes(action.action) && action.sourceItemId && action.sourcePath) {
    const expectedPath = expectedRecoveryPath(action);
    const source = await verifyItemInsideRoot(context.env, context.userId, action.sourceItemId).catch(() => null);
    if (source && expectedPath && source.relativePath === expectedPath) return "completed";
    if (!source && expectedPath) {
      const applied = await resolveRelativeItem(context.env, context.userId, expectedPath).catch(() => null);
      if (applied?.item.id === action.sourceItemId) return "completed";
      return "manual_review";
    }
    if (source && source.relativePath === action.sourcePath && (!action.snapshotETag || source.item.eTag === action.snapshotETag)) {
      if (!expectedPath) return "ready_for_retry";
      const destination = await resolveRelativeItem(context.env, context.userId, expectedPath).catch(() => null);
      if (!destination) return "ready_for_retry";
      return destination.item.id === source.item.id ? "completed" : "manual_review";
    }
    return "manual_review";
  }
  if (operation?.state === "failed") {
    const error = operation.error as Record<string, unknown> | undefined;
    const ambiguous = ["graph_timeout", "graph_network_error", "graph_unreachable", "graph_server_error", "graph_subrequest_limit", "graph_rate_limited", "graph_request_failed"].includes(String(error?.code ?? ""));
    return ambiguous ? "manual_review" : Boolean(error?.retryable) ? "ready_for_retry" : "failed_closed";
  }
  if (!operation && reservation?.state !== "mutation_in_progress") return "ready_for_retry";
  return "manual_review";
}

async function recoveryResolution(context: HotfixContext, planId: string, previousActionId: string | null): Promise<Record<string, unknown>> {
  const before = await callIntegrityCoordination(context.env, context.userId, { op: "status", planId });
  const reservation = before.reservation as Record<string, unknown> | null;
  const actionId = previousActionId || String(reservation?.actionId ?? "") || null;
  const operation = actionId ? await context.storage.get<Record<string, unknown>>(`integrated:operation:${planId}:${actionId}`) : undefined;
  const reconciliation = await reconcileIntegrityPlan(context, { planId, maximumActions: 3 });
  const reconciled = Array.isArray(reconciliation.reconciledThisInvocation) ? reconciliation.reconciledThisInvocation.map(String) : [];
  const plan = await getPlan(context, planId);
  const action = actionId ? plan.actions.find((candidate) => candidate.actionId === actionId) : undefined;
  let result = actionId && (operation?.state === "completed" || reconciled.includes(actionId) || plan.completedActions.includes(actionId)) ? "completed" : "ready_for_retry";
  if (action) result = await classifyReservedActionRecovery(context, plan, action, reservation, operation);
  else if (reservation?.state === "mutation_in_progress") result = "manual_review";
  return {
    previousActionId: actionId,
    reconciliationResult: result,
    reconciledActions: reconciled,
    operationState: operation?.state ?? null,
    identityEvidenceUsed: Boolean(action?.sourceItemId),
    recoveredAt: nowIso(),
  };
}

async function acquireExecutionLease(context: HotfixContext, planId: string, input: ExecutionInput): Promise<LeaseMetadata | Record<string, unknown>> {
  const defaults = executionDefaults(input);
  const plan = await getPlan(context, planId);
  const request = {
    op: "acquire",
    planId,
    scopePath: plan.scopePath,
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

function leaseResponseFields(acquired: LeaseMetadata): Record<string, unknown> {
  return { leaseAcquired: true, alreadyExecuting: false, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, leaseExpiresAt: acquired.leaseExpiresAt, retryAfterSeconds: 0, safeToRetry: true, recoveredExpiredLease: acquired.recoveredExpiredLease, recoveryMetadata: acquired.recoveryMetadata ?? null };
}
function planProgressFields(plan: IntegrityPlan): Record<string, unknown> {
  const unresolved = unresolvedActions(plan);
  const ready = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  return { remainingActions: unresolved.length, nextAction: plan.nextAction ?? ready[0]?.actionId ?? unresolved[0]?.actionId ?? null, nextReadyAction: ready[0]?.actionId ?? null, resumeRequired: unresolved.length > 0, auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running", planComplete: unresolved.length === 0 };
}

async function executeWithLease(context: HotfixContext, input: ExecutionInput): Promise<Record<string, unknown>> {
  const token = await openJson<{ planId: string; planHash: string; expiresAt: number }>(context.env.COOKIE_ENCRYPTION_KEY, String(input.executionToken ?? "")).catch(() => null);
  if (!token || token.expiresAt <= Date.now()) throw new ConnectorError("execution_token_invalid", "The execution token is invalid or expired.");
  const initialPlan = await getPlan(context, token.planId);
  if (initialPlan.validationStatus !== "valid" || initialPlan.planHash !== token.planHash) throw new ConnectorError("plan_not_validated", "The integrity plan is not currently validated.");
  const acquired = await acquireExecutionLease(context, token.planId, input);
  if (!isLeaseMetadata(acquired)) return acquired;
  const lease: LeaseReference = { planId: acquired.planId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, invocationId: acquired.invocationId };
  const fencedContext: HotfixContext = { ...context, storage: createLeaseFencedStorage(context.storage, context.env, context.userId, lease) };
  let reservation: Record<string, unknown> | null = null;
  let action: PlanAction | null = null;
  let mutationStarted = false;
  let finalized = false;
  let released = false;
  try {
    const recoveryResult = String(acquired.recoveryMetadata?.reconciliationResult ?? "");
    if (["manual_review", "failed_closed"].includes(recoveryResult)) {
      await releaseLease(context, acquired, { recoveryBlockedExecution: recoveryResult });
      released = true;
      const plan = await getPlan(context, token.planId);
      return { planId: plan.planId, executionState: recoveryResult, ...leaseResponseFields(acquired), completedThisInvocation: [], reconciledThisInvocation: [], failedThisInvocation: recoveryResult === "failed_closed" && acquired.recoveryMetadata?.previousActionId ? [String(acquired.recoveryMetadata.previousActionId)] : [], currentAction: acquired.recoveryMetadata?.previousActionId ?? null, ...planProgressFields(plan) };
    }

    const pre = await reconcileIntegrityPlan(fencedContext, { planId: token.planId, maximumActions: 3 });
    const preReconciled = Array.isArray(pre.reconciledThisInvocation) ? pre.reconciledThisInvocation.map(String) : [];
    if (preReconciled.length > 0 || pre.discrepancy) {
      await releaseLease(context, acquired, { reconciliationOnly: true, reconciled: preReconciled });
      released = true;
      const plan = await getPlan(context, token.planId);
      return { ...pre, planId: plan.planId, executionState: pre.discrepancy ? "manual_review" : "reconciled", ...leaseResponseFields(acquired), completedThisInvocation: [], reconciledThisInvocation: preReconciled, failedThisInvocation: [], currentAction: null, ...planProgressFields(plan) };
    }

    let plan = await getPlan(context, token.planId);
    const ready = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    const unresolved = unresolvedActions(plan);
    action = ready[0] ?? null;
    if (!action) {
      await releaseLease(context, acquired, { reason: unresolved.length === 0 ? "plan_complete" : "no_ready_action" });
      released = true;
      return { planId: plan.planId, executionState: unresolved.length === 0 ? "complete" : "waiting", ...leaseResponseFields(acquired), completedThisInvocation: [], reconciledThisInvocation: [], failedThisInvocation: [], currentAction: null, ...planProgressFields(plan) };
    }

    const evidence = actionEvidence(action);
    const reserved = await callIntegrityCoordination(context.env, context.userId, { op: "reserve", ...lease, actionId: action.actionId, ...evidence });
    reservation = reserved.reservation as Record<string, unknown>;
    await callIntegrityCoordination(context.env, context.userId, { op: "mark-mutation-started", ...lease, actionId: action.actionId, progressSequence: Number(reservation.attempt ?? 1), leaseDurationSeconds: leaseSeconds(context.env) });
    mutationStarted = true;

    const underlying = await executeIntegrityPlanWithBlockedMoveReconciliation(fencedContext, { executionToken: input.executionToken });
    const completed = Array.isArray(underlying.completedThisInvocation) ? underlying.completedThisInvocation.map(String) : [];
    const reconciled = Array.isArray(underlying.reconciledThisInvocation) ? underlying.reconciledThisInvocation.map(String) : [];
    const failed = Array.isArray(underlying.failedThisInvocation) ? underlying.failedThisInvocation.map(String) : [];
    if (completed.length > 0 && !completed.includes(action.actionId)) throw new ConnectorError("action_reservation_mismatch", "The executor attempted to complete an action other than the reserved action.", { retryable: false });
    let state: ReservationState = "ready_for_retry";
    if (completed.includes(action.actionId)) state = "completed";
    else if (reconciled.includes(action.actionId)) state = "reconciled";
    else if (failed.includes(action.actionId)) state = "failed";
    else if (underlying.discrepancy) state = "manual_review";
    const outcome = { completed, reconciled, failed, discrepancy: Boolean(underlying.discrepancy), idempotencyKey: reservation.idempotencyKey };
    await callIntegrityCoordination(context.env, context.userId, { op: "finalize-action", ...lease, actionId: action.actionId, reservationState: state, outcome });
    finalized = true;
    mutationStarted = false;
    await releaseLease(context, acquired, { state, actionId: action.actionId });
    released = true;
    plan = await getPlan(context, token.planId);
    return { ...underlying, executionState: unresolvedActions(plan).length === 0 ? "complete" : state === "manual_review" ? "manual_review" : "yielded", ...leaseResponseFields(acquired), currentAction: action.actionId, actionReservation: { actionId: action.actionId, attempt: reservation.attempt, idempotencyKey: reservation.idempotencyKey, state }, completedThisInvocation: completed, reconciledThisInvocation: reconciled, failedThisInvocation: failed, ...planProgressFields(plan) };
  } catch (error) {
    if (reservation && !mutationStarted && !finalized && action) {
      await callIntegrityCoordination(context.env, context.userId, { op: "finalize-action", ...lease, actionId: action.actionId, reservationState: "ready_for_retry", outcome: { abortedBeforeMutation: true } }).catch(() => undefined);
    }
    if (!mutationStarted && !released) await releaseLease(context, acquired, { abortedBeforeMutation: true }).catch(() => undefined);
    throw error;
  }
}

async function reconcileWithLease(context: HotfixContext, input: { planId: string; maximumActions?: number; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {
  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "internal_job", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
  if (!isLeaseMetadata(acquired)) return acquired;
  const lease: LeaseReference = { planId: acquired.planId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, invocationId: acquired.invocationId };
  const fencedContext: HotfixContext = { ...context, storage: createLeaseFencedStorage(context.storage, context.env, context.userId, lease) };
  try {
    const result = await reconcileIntegrityPlan(fencedContext, { planId: input.planId, maximumActions: input.maximumActions });
    return { ...result, executionState: "reconciled", ...leaseResponseFields(acquired) };
  } finally {
    await releaseLease(context, acquired, { reconciliationOnly: true }).catch(() => undefined);
  }
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
    nextAction: plan.nextAction ?? ready[0]?.actionId ?? unresolved[0]?.actionId ?? null,
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
    const defaults = executionDefaults({ executionToken: "", ownerType: "recovery", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
    const claim = await callIntegrityCoordination(context.env, context.userId, { op: "claim-force-recovery", planId: input.planId, ...defaults, workerVersion: workerVersion(context.env), force: true });
    if (claim.claimed !== true) return { recovered: false, refusedCancellation: true, ...claim };
    const reconciliation = await reconcileIntegrityPlan(context, { planId: input.planId, maximumActions: 3 });
    const invalidated = await callIntegrityCoordination(context.env, context.userId, { op: "force-invalidate", planId: input.planId, ...defaults, force: true, outcome: { reconciliationSummary: { reconciledThisInvocation: reconciliation.reconciledThisInvocation ?? [], discrepancy: reconciliation.discrepancy ?? null } } });
    return { recovered: Boolean(invalidated.invalidated), forced: true, reconciliation, ...invalidated };
  }
  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "recovery", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
  if (!isLeaseMetadata(acquired)) return acquired;
  await releaseLease(context, acquired, { recoveryOnly: true });
  return { recovered: acquired.recoveredExpiredLease, previousLease: acquired.recoveryMetadata ?? null, newFencingToken: acquired.fencingToken, leaseReleased: true };
}

type LeaseProbeInput = { planId: string; mode?: "acquire" | "release" | "acquire_and_release"; ownerId?: string; invocationId?: string; correlationId?: string; leaseId?: string; fencingToken?: number; actionId?: string; simulateMutationInProgress?: boolean };
async function probeLease(context: HotfixContext, input: LeaseProbeInput): Promise<Record<string, unknown>> {
  const mode = input.mode ?? "acquire_and_release";
  if (mode === "release") {
    if (!input.leaseId || !input.invocationId || !Number.isFinite(input.fencingToken)) throw new ConnectorError("probe_release_metadata_required", "Lease ID, invocation ID, and fencing token are required to release a probe lease.");
    return callIntegrityCoordination(context.env, context.userId, { op: "release", planId: input.planId, leaseId: input.leaseId, fencingToken: Number(input.fencingToken), invocationId: input.invocationId, outcome: { acceptanceProbe: true } });
  }
  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "internal_job", ownerId: input.ownerId ?? "integrity-lease-acceptance-probe", invocationId: input.invocationId, correlationId: input.correlationId });
  if (!isLeaseMetadata(acquired)) return acquired;
  const lease: LeaseReference = { planId: acquired.planId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, invocationId: acquired.invocationId };
  let reservation: Record<string, unknown> | null = null;
  if (input.actionId) {
    const plan = await getPlan(context, input.planId);
    const action = plan.actions.find((candidate) => candidate.actionId === input.actionId);
    if (!action) throw new ConnectorError("probe_action_not_found", "The requested probe action does not exist in the plan.");
    const reserved = await callIntegrityCoordination(context.env, context.userId, { op: "reserve", ...lease, actionId: action.actionId, ...actionEvidence(action) });
    reservation = reserved.reservation as Record<string, unknown>;
    if (input.simulateMutationInProgress === true) await callIntegrityCoordination(context.env, context.userId, { op: "mark-mutation-started", ...lease, actionId: action.actionId, progressSequence: Number(reservation.attempt ?? 1), leaseDurationSeconds: leaseSeconds(context.env) });
  }
  if (mode === "acquire_and_release") {
    if (input.simulateMutationInProgress) throw new ConnectorError("probe_inflight_cannot_release", "A simulated in-flight action must be recovered after lease expiry rather than released.");
    if (reservation && input.actionId) {
      await callIntegrityCoordination(context.env, context.userId, {
        op: "finalize-action",
        ...lease,
        actionId: input.actionId,
        reservationState: "ready_for_retry",
        outcome: { acceptanceProbeReleasedBeforeMutation: true },
      });
      reservation = { ...reservation, state: "ready_for_retry" };
    }
    await releaseLease(context, acquired, { acceptanceProbe: true });
  }
  return { planId: input.planId, probeMode: mode, ...leaseResponseFields(acquired), invocationId: acquired.invocationId, reservation, leaseReleased: mode === "acquire_and_release", noGraphMutationPerformed: true };
}

async function executionAudit(context: HotfixContext, planId: string, cursor?: number, limit?: number): Promise<Record<string, unknown>> {
  await getPlan(context, planId);
  return callIntegrityCoordination(context.env, context.userId, { op: "audit-page", planId, cursor, limit });
}

async function startDiffWithCoordination(context: HotfixContext, schedule: ScheduleSnapshot, planId: string): Promise<Record<string, unknown>> {
  const plan = await getPlan(context, planId);
  const gate = await callIntegrityCoordination(context.env, context.userId, { op: "begin-plan-audit", planId, scopePath: plan.scopePath, auditJobId: "pending" });
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
  const current = await context.storage.get<JobRecord>(`${JOB_PREFIX}${jobId}`);
  if (!current) throw new ConnectorError("job_not_found", "The integrated job does not exist or has expired.");
  const invocationId = crypto.randomUUID();
  const acquired = await callIntegrityCoordination(context.env, context.userId, { op: "job-acquire", jobId, invocationId, ownerId: "get_job_status", ownerType: "internal_job", workerVersion: workerVersion(context.env) });
  if (acquired.acquired !== true) {
    await schedule(jobId, context.userId, Math.min(60, Math.max(2, Number(acquired.retryAfterSeconds ?? 5))));
    return { jobId, alreadyExecuting: true, safeToRetry: true, retryScheduled: true, ...acquired };
  }
  const lease: JobLeaseReference = { jobId, invocationId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken) };
  const fencedContext: HotfixContext = { ...context, storage: createJobFencedStorage(context.storage, context.env, context.userId, lease) };
  const childStatus = async (childJobId: string): Promise<JobRecord> => {
    const childInvocationId = crypto.randomUUID();
    const childAcquire = await callIntegrityCoordination(context.env, context.userId, { op: "job-acquire", jobId: childJobId, invocationId: childInvocationId, ownerId: "integrity_diff_child_status", ownerType: "internal_job", workerVersion: workerVersion(context.env) });
    if (childAcquire.acquired !== true) {
      const snapshot = await context.storage.get<JobRecord>(`${JOB_PREFIX}${childJobId}`);
      if (!snapshot) throw new ConnectorError("job_not_found", "The final snapshot job does not exist or has expired.");
      return snapshot;
    }
    const childLease: JobLeaseReference = { jobId: childJobId, invocationId: childInvocationId, leaseId: String(childAcquire.leaseId), fencingToken: Number(childAcquire.fencingToken) };
    try {
      const childContext: HotfixContext = { ...context, storage: createJobFencedStorage(context.storage, context.env, context.userId, childLease) };
      return await getIntegrityJobStatus(childContext, schedule, childJobId);
    } finally {
      await callIntegrityCoordination(context.env, context.userId, { op: "job-release", ...childLease }).catch(() => undefined);
    }
  };
  try {
    const result = await getIntegrityJobStatus(fencedContext, schedule, jobId, current.type === "integrity_diff" ? childStatus : undefined);
    const planId = String(result.resultReferences?.planId ?? "");
    if (planId) await callIntegrityCoordination(context.env, context.userId, { op: "update-plan-audit", planId, auditJobId: jobId }).catch(() => undefined);
    if (planId && ["completed", "failed", "cancelled"].includes(result.status)) await callIntegrityCoordination(context.env, context.userId, { op: "end-plan-audit", planId, auditJobId: jobId, outcome: { status: result.status } });
    return result as unknown as Record<string, unknown>;
  } finally {
    await callIntegrityCoordination(context.env, context.userId, { op: "job-release", ...lease }).catch(() => undefined);
  }
}

export async function continueSnapshotWithLease(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<Record<string, unknown>> {
  const invocationId = crypto.randomUUID();
  const acquired = await callIntegrityCoordination(context.env, context.userId, { op: "job-acquire", jobId, invocationId, ownerId: "scheduled_snapshot_continuation", ownerType: "internal_job", workerVersion: workerVersion(context.env) });
  if (acquired.acquired !== true) {
    await schedule(jobId, context.userId, Math.min(60, Math.max(2, Number(acquired.retryAfterSeconds ?? 5))));
    return { jobId, alreadyExecuting: true, safeToRetry: true, retryScheduled: true, ...acquired };
  }
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
    for (const name of ["execute_integrity_plan", "reconcile_integrity_plan", "get_integrity_plan_status", "get_integrity_plan_execution_state", "get_integrity_plan_execution_audit", "request_integrity_plan_lease_recovery", "probe_integrity_plan_execution_lease", "diff_scope_before_after", "get_job_status"]) delete target._registeredTools?.[name];
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
    server.registerTool("get_integrity_plan_execution_audit", {
      title: "Get bounded integrity execution audit history",
      description: "Return a paginated newest-first page of bounded lease, fencing, reservation, recovery, denial, and release audit records.",
      inputSchema: { planId: z.string().uuid(), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() },
      annotations: READ_ONLY,
    }, async ({ planId, cursor, limit }) => { try { return textResult(await executionAudit(contextFactory(), planId, cursor, limit)); } catch (error) { return errorResult(error); } });
    server.registerTool("request_integrity_plan_lease_recovery", {
      title: "Request guarded integrity lease recovery",
      description: "Recover an expired lease normally. Active leases are refused unless force is explicit, no mutation commit is in progress, reconciliation runs first, and the fencing token is incremented.",
      inputSchema: { planId: z.string().uuid(), force: z.boolean().optional(), ownerId: z.string().max(500).optional(), invocationId: z.string().max(500).optional(), correlationId: z.string().max(500).optional() },
      annotations: DESTRUCTIVE,
    }, async (input) => { try { return textResult(await requestRecovery(contextFactory(), input)); } catch (error) { return errorResult(error); } });
    server.registerTool("probe_integrity_plan_execution_lease", {
      title: "Probe or hold an integrity execution lease without Graph mutation",
      description: "Administrative acceptance tool. Atomically acquire, hold, or owner-check-release a plan lease and optionally reserve a fixture action without issuing any Microsoft Graph mutation.",
      inputSchema: { planId: z.string().uuid(), mode: z.enum(["acquire", "release", "acquire_and_release"]).optional(), ownerId: z.string().max(500).optional(), invocationId: z.string().max(500).optional(), correlationId: z.string().max(500).optional(), leaseId: z.string().uuid().optional(), fencingToken: z.number().int().min(1).optional(), actionId: z.string().max(200).optional(), simulateMutationInProgress: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    }, async (input) => { try { return textResult(await probeLease(contextFactory(), input)); } catch (error) { return errorResult(error); } });
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
