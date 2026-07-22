import { getConnectionStatus } from "./graph";
import { validateIntegrityPlan } from "./integrated-tools";
import {
  executeWithLease,
  executionState,
  getJobWithCoordination,
  startDiffWithCoordination,
} from "./integrity-lease-tools";
import type { ScheduleSnapshot } from "./snapshot-model";
import type { HotfixContext } from "./version20-hotfix";

export const DEFAULT_SOURCE_INTEGRITY_PLAN_ID = "72d309d6-aac4-47a5-8f83-fe9364b282bc";
export const SOURCE_INTEGRITY_OWNER_ID = "uca-source-library-hourly";

export type ScheduledIntegrityInput = {
  planId: string;
  ownerId: string;
  invocationId: string;
  correlationId: string;
};

function activeJobId(state: Record<string, unknown>): string | null {
  const jobs = Array.isArray(state.activeContinuationJobs)
    ? state.activeContinuationJobs
    : Array.isArray(state.activeJobs)
      ? state.activeJobs
      : [];
  const first = jobs[0] as Record<string, unknown> | undefined;
  return first?.jobId ? String(first.jobId) : null;
}

/**
 * Execute exactly one bounded scheduled continuation.
 *
 * The function deliberately contains no retry loop. A later cron invocation is
 * the only ordinary retry mechanism. Mutation overlap is prevented by the same
 * durable lease, reservation and fencing implementation used by the MCP tool.
 */
export async function runScheduledIntegrityContinuation(
  context: HotfixContext,
  schedule: ScheduleSnapshot,
  input: ScheduledIntegrityInput,
): Promise<Record<string, unknown>> {
  const readiness = await getConnectionStatus(context.env, context.userId);
  const before = await executionState(context, input.planId);

  if (before.alreadyExecuting === true || before.currentlyLeased === true) {
    return {
      scheduled: true,
      noOp: true,
      reason: "alreadyExecuting",
      readiness,
      ...before,
      ownerType: before.ownerType ?? "scheduled_task",
      ownerId: before.ownerId ?? input.ownerId,
      invocationId: before.invocationId ?? input.invocationId,
      correlationId: before.correlationId ?? input.correlationId,
    };
  }

  const remaining = Number(before.remainingActions ?? 0);
  if (remaining > 0) {
    const validation = await validateIntegrityPlan(context, input.planId);
    if (validation.valid !== true || typeof validation.executionToken !== "string") {
      return {
        scheduled: true,
        noOp: true,
        reason: "validation_failed",
        readiness,
        before,
        validation,
        ownerType: "scheduled_task",
        ownerId: input.ownerId,
        invocationId: input.invocationId,
        correlationId: input.correlationId,
      };
    }

    const execution = await executeWithLease(context, {
      executionToken: validation.executionToken,
      ownerType: "scheduled_task",
      ownerId: input.ownerId,
      invocationId: input.invocationId,
      correlationId: input.correlationId,
    });
    return { scheduled: true, readiness, before, validation: { valid: true }, ...execution };
  }

  const jobId = activeJobId(before);
  if (jobId) {
    const continuation = await getJobWithCoordination(context, schedule, jobId);
    return {
      scheduled: true,
      readiness,
      before,
      auditContinuationAdvanced: true,
      auditJobId: jobId,
      continuation,
      ownerType: "scheduled_task",
      ownerId: input.ownerId,
      invocationId: input.invocationId,
      correlationId: input.correlationId,
    };
  }

  if (before.auditStatus === "pending") {
    const audit = await startDiffWithCoordination(context, schedule, input.planId);
    return {
      scheduled: true,
      readiness,
      before,
      auditStarted: true,
      audit,
      ownerType: "scheduled_task",
      ownerId: input.ownerId,
      invocationId: input.invocationId,
      correlationId: input.correlationId,
    };
  }

  return {
    scheduled: true,
    noOp: true,
    reason: "plan_and_audit_complete",
    readiness,
    ...before,
    ownerType: "scheduled_task",
    ownerId: input.ownerId,
    invocationId: input.invocationId,
    correlationId: input.correlationId,
  };
}
