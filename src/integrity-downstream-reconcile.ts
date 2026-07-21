import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError, safeErrorResult } from "./errors";
import { compactVerifiedItem, graphFetchBytes, strictRelativePath, verifyItemInsideRoot } from "./graph-core";
import { INTEGRATED_LIMITS, sha256Bytes } from "./integrated-core";
import type { IntegrityPlan, PlanAction } from "./integrated-tools";
import { remainingActions, uniqueStrings, upsertResult } from "./integrity-execution";
import {
  executeIntegrityPlanRepair,
  refreshDependencySkips,
} from "./integrity-resume-repair";
import { openJson } from "./security";
import type { HotfixContext } from "./version20-hotfix";

const PLAN_PREFIX = "integrated:plan:";
const OPERATION_PREFIX = "integrated:operation:";
const RECONCILIATION_PREFIX = "integrated:reconciliation:";

function planKey(planId: string): string { return `${PLAN_PREFIX}${planId}`; }
function operationKey(planId: string, actionId: string): string { return `${OPERATION_PREFIX}${planId}:${actionId}`; }
function reconciliationKey(planId: string, actionId: string): string { return `${RECONCILIATION_PREFIX}${planId}:${actionId}`; }
function parentPath(path: string): string { return strictRelativePath(path).split("/").slice(0, -1).join("/"); }
function nowIso(): string { return new Date().toISOString(); }

function textResult(data: Record<string, unknown>): CallToolResult {
  return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  return safeErrorResult(error) as CallToolResult;
}

async function getPlan(context: HotfixContext, planId: string): Promise<IntegrityPlan> {
  const plan = await context.storage.get<IntegrityPlan>(planKey(planId));
  if (!plan || Date.parse(plan.expiresAt) <= Date.now()) {
    throw new ConnectorError("plan_not_found", "The integrity plan does not exist or has expired.");
  }
  return plan;
}

export function findDeclaredDownstreamMove(plan: IntegrityPlan, action: PlanAction): PlanAction | null {
  return [...plan.actions]
    .filter((candidate) =>
      candidate.action === "MOVE"
      && candidate.sourceItemId === action.sourceItemId
      && Number(candidate.operationOrder ?? 0) > Number(action.operationOrder ?? 0)
      && (candidate.dependencies ?? []).includes(action.actionId)
      && Boolean(candidate.destinationPath),
    )
    .sort((a, b) => Number(a.operationOrder ?? 0) - Number(b.operationOrder ?? 0))[0] ?? null;
}

async function verifySnapshotHash(context: HotfixContext, action: PlanAction, itemId: string, itemSize: number, eTag?: string | null): Promise<void> {
  if (!action.snapshotSha256) return;
  if (itemSize > INTEGRATED_LIMITS.fileBytesMax) {
    throw new ConnectorError("file_too_large", "The file exceeds the integrated-operation size limit.");
  }
  const bytes = await graphFetchBytes(
    context.env,
    context.userId,
    `/me/drive/items/${encodeURIComponent(itemId)}/content`,
    INTEGRATED_LIMITS.fileBytesMax,
    eTag ? { headers: { "If-Match": eTag } } : {},
  );
  if (sha256Bytes(bytes) !== action.snapshotSha256) {
    throw new ConnectorError("sha256_conflict", "The live item does not match the plan snapshot hash.");
  }
}

async function reconcileOneDownstreamRename(
  context: HotfixContext,
  plan: IntegrityPlan,
): Promise<string | null> {
  refreshDependencySkips(plan);
  const completed = new Set(plan.completedActions);
  const candidates = [...plan.actions]
    .filter((action) => action.action === "RENAME" && !completed.has(action.actionId))
    .sort((a, b) => Number(a.operationOrder ?? 0) - Number(b.operationOrder ?? 0));

  for (const action of candidates) {
    if (!action.sourceItemId || !action.proposedFilename) continue;
    const downstreamMove = findDeclaredDownstreamMove(plan, action);
    if (!downstreamMove?.destinationPath) continue;

    let live;
    try {
      live = await verifyItemInsideRoot(context.env, context.userId, action.sourceItemId);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "item_not_found") continue;
      throw error;
    }

    const liveParent = parentPath(live.relativePath).toLocaleLowerCase("en");
    const expectedParent = strictRelativePath(downstreamMove.destinationPath).toLocaleLowerCase("en");
    if (live.item.name !== action.proposedFilename || liveParent !== expectedParent) continue;

    await verifySnapshotHash(
      context,
      action,
      live.item.id,
      Number(live.item.size ?? 0),
      live.item.eTag,
    );

    const reconciledAt = nowIso();
    const audit = {
      actionId: action.actionId,
      action: action.action,
      reconciliationStatus: "externally_reconciled_after_downstream_move",
      alreadyApplied: true,
      originalPlanAction: action,
      downstreamPlanAction: downstreamMove,
      snapshotEvidence: {
        sourceItemId: action.sourceItemId,
        sourcePath: action.sourcePath ?? null,
        snapshotETag: action.snapshotETag ?? null,
        snapshotSha256: action.snapshotSha256 ?? null,
      },
      liveEvidence: compactVerifiedItem(live),
      reconciledAt,
    };

    plan.completedActions = uniqueStrings([...plan.completedActions, action.actionId]);
    plan.failedActions = plan.failedActions.filter((entry) => entry.actionId !== action.actionId);
    plan.results = upsertResult(plan.results, audit);
    refreshDependencySkips(plan);
    const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    plan.nextAction = remaining[0]?.actionId ?? null;
    plan.status = remaining.length > 0 ? "running" : plan.status;
    plan.executionStatus = remaining.length > 0 ? "running" : plan.executionStatus;

    await context.storage.put(planKey(plan.planId), plan);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "completed", ...audit });
    await context.storage.put(reconciliationKey(plan.planId, action.actionId), audit);
    return action.actionId;
  }
  return null;
}

export async function executeIntegrityPlanWithDownstreamReconciliation(
  context: HotfixContext,
  input: { executionToken: string },
): Promise<Record<string, unknown>> {
  const token = await openJson<{ planId: string; planHash: string; expiresAt: number }>(
    context.env.COOKIE_ENCRYPTION_KEY,
    input.executionToken,
  ).catch(() => null);
  if (!token || token.expiresAt <= Date.now()) {
    throw new ConnectorError("execution_token_invalid", "The execution token is invalid or expired.");
  }

  const plan = await getPlan(context, token.planId);
  const reconciled = await reconcileOneDownstreamRename(context, plan);
  if (reconciled) {
    const updated = await getPlan(context, token.planId);
    refreshDependencySkips(updated);
    const remaining = remainingActions(updated.actions, updated.completedActions, updated.failedActions, updated.skippedDependencyActions);
    await context.storage.put(planKey(updated.planId), updated);
    return {
      planId: updated.planId,
      status: updated.status,
      executionStatus: updated.executionStatus,
      completedThisInvocation: [],
      reconciledThisInvocation: [reconciled],
      failedThisInvocation: [],
      remainingActions: remaining.length,
      nextAction: updated.nextAction ?? remaining[0]?.actionId ?? null,
      resumeRequired: remaining.length > 0,
      auditPending: updated.auditStatus === "pending" || updated.auditStatus === "running",
      mutationPerformed: false,
      reconciliationOnlyThisInvocation: true,
    };
  }

  return executeIntegrityPlanRepair(context, input);
}

export function registerDownstreamRenameReconciliationTool(
  server: McpServer,
  contextFactory: () => HotfixContext,
): void {
  const target = server as any;
  const originalSend = target.sendToolListChanged;
  target.sendToolListChanged = () => undefined;
  try {
    delete target._registeredTools?.execute_integrity_plan;
    server.registerTool("execute_integrity_plan", {
      title: "Resume reconciled integrity plan",
      description: "Reconcile stable-item rename and move postconditions, including externally completed downstream moves, before executing at most one mutation.",
      inputSchema: { executionToken: z.string().min(1).max(50_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (input) => {
      try { return textResult(await executeIntegrityPlanWithDownstreamReconciliation(contextFactory(), input)); }
      catch (error) { return errorResult(error); }
    });
  } finally {
    target.sendToolListChanged = originalSend;
  }
}
