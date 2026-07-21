import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError, safeErrorResult } from "./errors";
import {
  compactVerifiedItem,
  graphFetch,
  graphFetchBytes,
  resolveConfiguredRoot,
  strictRelativePath,
  type VerifiedItem,
} from "./graph-core";
import { INTEGRATED_LIMITS, sha256Bytes } from "./integrated-core";
import type { IntegrityPlan, PlanAction } from "./integrated-tools";
import { remainingActions, uniqueStrings, upsertResult } from "./integrity-execution";
import { refreshDependencySkips } from "./integrity-resume-repair";
import { executeIntegrityPlanWithDownstreamReconciliation } from "./integrity-downstream-reconcile";
import { encodeGraphPath, openJson } from "./security";
import type { GraphDriveItem } from "./types";
import type { HotfixContext } from "./version20-hotfix";

const PLAN_PREFIX = "integrated:plan:";
const OPERATION_PREFIX = "integrated:operation:";
const RECONCILIATION_PREFIX = "integrated:reconciliation:";
const ITEM_SELECT = "id,name,size,eTag,lastModifiedDateTime,file,folder,parentReference,remoteItem,deleted";

function planKey(planId: string): string { return `${PLAN_PREFIX}${planId}`; }
function operationKey(planId: string, actionId: string): string { return `${OPERATION_PREFIX}${planId}:${actionId}`; }
function reconciliationKey(planId: string, actionId: string): string { return `${RECONCILIATION_PREFIX}${planId}:${actionId}`; }
function filenameFromAction(action: PlanAction): string {
  if (action.proposedFilename) return action.proposedFilename;
  if (action.currentFilename) return action.currentFilename;
  return strictRelativePath(String(action.sourcePath ?? "")).split("/").pop() ?? "";
}
function nowIso(): string { return new Date().toISOString(); }

function textResult(data: Record<string, unknown>): CallToolResult {
  return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function errorResult(error: unknown): CallToolResult { return safeErrorResult(error) as CallToolResult; }

async function getPlan(context: HotfixContext, planId: string): Promise<IntegrityPlan> {
  const plan = await context.storage.get<IntegrityPlan>(planKey(planId));
  if (!plan || Date.parse(plan.expiresAt) <= Date.now()) {
    throw new ConnectorError("plan_not_found", "The integrity plan does not exist or has expired.");
  }
  return plan;
}

export function selectBlockedMove(plan: IntegrityPlan): PlanAction | null {
  const completed = new Set(plan.completedActions);
  const failed = new Set(plan.failedActions.map((entry) => entry.actionId));
  const skipped = new Set(plan.skippedDependencyActions);
  return [...plan.actions]
    .filter((action) => action.action === "MOVE" && !completed.has(action.actionId) && (failed.has(action.actionId) || skipped.has(action.actionId)))
    .sort((a, b) => Number(failed.has(b.actionId)) - Number(failed.has(a.actionId)) || Number(a.operationOrder ?? 0) - Number(b.operationOrder ?? 0))[0] ?? null;
}

async function readMoveDestination(
  context: HotfixContext,
  action: PlanAction,
): Promise<VerifiedItem | null> {
  if (!action.sourceItemId || !action.destinationPath) return null;
  const filename = filenameFromAction(action);
  if (!filename) return null;
  const relativePath = strictRelativePath(`${action.destinationPath}/${filename}`);
  const configuredRootPath = strictRelativePath(context.env.ONEDRIVE_ROOT);
  const root = await resolveConfiguredRoot(context.env, context.userId);
  const rootDriveId = root.parentReference?.driveId;
  if (!rootDriveId) throw new ConnectorError("root_invalid", "The configured OneDrive root could not be verified.");
  let item: GraphDriveItem;
  try {
    item = await graphFetch<GraphDriveItem>(
      context.env,
      context.userId,
      `/me/drive/root:/${encodeGraphPath(`${configuredRootPath}/${relativePath}`)}?$select=${ITEM_SELECT}`,
    );
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "item_not_found") return null;
    throw error;
  }
  if (
    item.id !== action.sourceItemId
    || item.remoteItem
    || item.deleted
    || item.parentReference?.driveId !== rootDriveId
  ) return null;
  return { item, root, relativePath, ancestorIds: [item.id, root.id], driveId: rootDriveId };
}

async function verifyHash(context: HotfixContext, action: PlanAction, live: VerifiedItem): Promise<void> {
  if (!action.snapshotSha256) return;
  if ((live.item.size ?? 0) > INTEGRATED_LIMITS.fileBytesMax) {
    throw new ConnectorError("file_too_large", "The file exceeds the integrated-operation size limit.");
  }
  const bytes = await graphFetchBytes(
    context.env,
    context.userId,
    `/me/drive/items/${encodeURIComponent(live.item.id)}/content`,
    INTEGRATED_LIMITS.fileBytesMax,
    live.item.eTag ? { headers: { "If-Match": live.item.eTag } } : {},
  );
  if (await sha256Bytes(bytes) !== action.snapshotSha256) {
    throw new ConnectorError("sha256_conflict", "The live item does not match the plan snapshot hash.");
  }
}

async function reconcileBlockedMove(
  context: HotfixContext,
  plan: IntegrityPlan,
): Promise<{ actionId: string | null; discrepancy?: Record<string, unknown> }> {
  refreshDependencySkips(plan);
  const action = selectBlockedMove(plan);
  if (!action) return { actionId: null };
  const live = await readMoveDestination(context, action);
  if (!live) {
    return {
      actionId: null,
      discrepancy: { actionId: action.actionId, code: "move_postcondition_not_satisfied", liveEvidence: null },
    };
  }
  await verifyHash(context, action, live);
  const reconciledAt = nowIso();
  const audit = {
    actionId: action.actionId,
    action: action.action,
    reconciliationStatus: "externally_reconciled",
    alreadyApplied: true,
    originalPlanAction: action,
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
  return { actionId: action.actionId };
}

export async function executeIntegrityPlanWithBlockedMoveReconciliation(
  context: HotfixContext,
  input: { executionToken: string },
): Promise<Record<string, unknown>> {
  const token = await openJson<{ planId: string; planHash: string; expiresAt: number }>(context.env.COOKIE_ENCRYPTION_KEY, input.executionToken).catch(() => null);
  if (!token || token.expiresAt <= Date.now()) throw new ConnectorError("execution_token_invalid", "The execution token is invalid or expired.");
  const plan = await getPlan(context, token.planId);
  const outcome = await reconcileBlockedMove(context, plan);
  if (outcome.actionId) {
    const updated = await getPlan(context, token.planId);
    refreshDependencySkips(updated);
    const remaining = remainingActions(updated.actions, updated.completedActions, updated.failedActions, updated.skippedDependencyActions);
    await context.storage.put(planKey(updated.planId), updated);
    return {
      planId: updated.planId,
      status: updated.status,
      executionStatus: updated.executionStatus,
      completedThisInvocation: [],
      reconciledThisInvocation: [outcome.actionId],
      failedThisInvocation: [],
      remainingActions: remaining.length,
      nextAction: updated.nextAction ?? remaining[0]?.actionId ?? null,
      resumeRequired: remaining.length > 0,
      auditPending: updated.auditStatus === "pending" || updated.auditStatus === "running",
      mutationPerformed: false,
      reconciliationOnlyThisInvocation: true,
    };
  }
  if (outcome.discrepancy) {
    const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    return {
      planId: plan.planId,
      status: plan.status,
      executionStatus: plan.executionStatus,
      completedThisInvocation: [],
      reconciledThisInvocation: [],
      failedThisInvocation: [],
      remainingActions: remaining.length,
      nextAction: plan.nextAction ?? remaining[0]?.actionId ?? null,
      resumeRequired: remaining.length > 0,
      auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running",
      mutationPerformed: false,
      reconciliationOnlyThisInvocation: true,
      discrepancy: outcome.discrepancy,
    };
  }
  return executeIntegrityPlanWithDownstreamReconciliation(context, input);
}

export function registerBlockedMoveReconciliationTool(server: McpServer, contextFactory: () => HotfixContext): void {
  const target = server as any;
  const originalSend = target.sendToolListChanged;
  target.sendToolListChanged = () => undefined;
  try {
    delete target._registeredTools?.execute_integrity_plan;
    server.registerTool("execute_integrity_plan", {
      title: "Resume reconciled integrity plan",
      description: "Reconcile one failed or dependency-blocked move by exact configured-root destination and stable item ID before any mutation path.",
      inputSchema: { executionToken: z.string().min(1).max(50_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (input) => {
      try { return textResult(await executeIntegrityPlanWithBlockedMoveReconciliation(contextFactory(), input)); }
      catch (error) { return errorResult(error); }
    });
  } finally {
    target.sendToolListChanged = originalSend;
  }
}
