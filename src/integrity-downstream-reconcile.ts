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
import {
  executeIntegrityPlanRepair,
  refreshDependencySkips,
} from "./integrity-resume-repair";
import { encodeGraphPath, openJson } from "./security";
import type { GraphDriveItem } from "./types";
import type { HotfixContext } from "./version20-hotfix";

const PLAN_PREFIX = "integrated:plan:";
const OPERATION_PREFIX = "integrated:operation:";
const RECONCILIATION_PREFIX = "integrated:reconciliation:";
const RECONCILIATION_ITEM_SELECT = "id,name,size,eTag,lastModifiedDateTime,file,folder,parentReference,remoteItem,deleted";
const MAX_DECLARED_DESTINATIONS = 3;

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

export function findDeclaredDownstreamMoves(plan: IntegrityPlan, action: PlanAction): PlanAction[] {
  return [...plan.actions]
    .filter((candidate) =>
      candidate.action === "MOVE"
      && candidate.sourceItemId === action.sourceItemId
      && Number(candidate.operationOrder ?? 0) > Number(action.operationOrder ?? 0)
      && Boolean(candidate.destinationPath),
    )
    .sort((a, b) => Number(a.operationOrder ?? 0) - Number(b.operationOrder ?? 0))
    .slice(0, MAX_DECLARED_DESTINATIONS);
}

export function findDeclaredDownstreamMove(plan: IntegrityPlan, action: PlanAction): PlanAction | null {
  return findDeclaredDownstreamMoves(plan, action)[0] ?? null;
}

export function relativePathFromParentReference(root: GraphDriveItem, item: GraphDriveItem): string | null {
  const driveId = root.parentReference?.driveId;
  const itemDriveId = item.parentReference?.driveId;
  const rootParentPath = root.parentReference?.path;
  const itemParentPath = item.parentReference?.path;
  if (!driveId || !itemDriveId || driveId !== itemDriveId || !rootParentPath || !itemParentPath) return null;
  const rootAbsolutePath = `${rootParentPath}/${root.name}`;
  if (item.id === root.id) return "";
  if (itemParentPath !== rootAbsolutePath && !itemParentPath.startsWith(`${rootAbsolutePath}/`)) return null;
  const relativeParent = itemParentPath.slice(rootAbsolutePath.length).replace(/^\/+/, "");
  return strictRelativePath(relativeParent ? `${relativeParent}/${item.name}` : item.name);
}

async function readStableItemBounded(
  context: HotfixContext,
  root: GraphDriveItem,
  action: PlanAction,
): Promise<VerifiedItem | null> {
  if (!action.sourceItemId) return null;
  const item = await graphFetch<GraphDriveItem>(
    context.env,
    context.userId,
    `/me/drive/items/${encodeURIComponent(action.sourceItemId)}?$select=${RECONCILIATION_ITEM_SELECT}`,
  );
  if (item.remoteItem || item.deleted || item.id !== action.sourceItemId) return null;
  const relativePath = relativePathFromParentReference(root, item);
  const driveId = root.parentReference?.driveId;
  if (relativePath === null || !driveId || item.parentReference?.driveId !== driveId) return null;
  return { item, root, relativePath, ancestorIds: [item.id, root.id], driveId };
}

async function readDeclaredDestinationBounded(
  context: HotfixContext,
  root: GraphDriveItem,
  action: PlanAction,
  move: PlanAction,
): Promise<VerifiedItem | null> {
  if (!action.sourceItemId || !action.proposedFilename || !move.destinationPath) return null;
  const relativePath = strictRelativePath(`${move.destinationPath}/${action.proposedFilename}`);
  const configuredRootPath = strictRelativePath(context.env.ONEDRIVE_ROOT);
  let item: GraphDriveItem;
  try {
    item = await graphFetch<GraphDriveItem>(
      context.env,
      context.userId,
      `/me/drive/root:/${encodeGraphPath(`${configuredRootPath}/${relativePath}`)}?$select=${RECONCILIATION_ITEM_SELECT}`,
    );
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "item_not_found") return null;
    throw error;
  }
  const driveId = root.parentReference?.driveId;
  if (
    !driveId
    || item.id !== action.sourceItemId
    || item.remoteItem
    || item.deleted
    || item.parentReference?.driveId !== driveId
  ) return null;
  return { item, root, relativePath, ancestorIds: [item.id, root.id], driveId };
}

async function verifyDownstreamPostcondition(
  context: HotfixContext,
  plan: IntegrityPlan,
  action: PlanAction,
): Promise<{ live: VerifiedItem | null; downstreamMove: PlanAction | null; discrepancy?: string }> {
  const downstreamMoves = findDeclaredDownstreamMoves(plan, action);
  if (downstreamMoves.length === 0) return { live: null, downstreamMove: null, discrepancy: "no_declared_downstream_move" };
  const root = await resolveConfiguredRoot(context.env, context.userId);

  const stable = await readStableItemBounded(context, root, action).catch((error) => {
    if (error instanceof ConnectorError && error.code === "item_not_found") return null;
    throw error;
  });
  if (stable && stable.item.name === action.proposedFilename) {
    const liveParent = parentPath(stable.relativePath).toLocaleLowerCase("en");
    const matchedMove = downstreamMoves.find((move) => strictRelativePath(String(move.destinationPath)).toLocaleLowerCase("en") === liveParent) ?? null;
    if (matchedMove) return { live: stable, downstreamMove: matchedMove };
  }

  for (const move of downstreamMoves) {
    const live = await readDeclaredDestinationBounded(context, root, action, move);
    if (live) return { live, downstreamMove: move };
  }
  return {
    live: stable,
    downstreamMove: downstreamMoves[0] ?? null,
    discrepancy: stable ? "downstream_postcondition_not_satisfied" : "stable_item_not_resolved_inside_root",
  };
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
  if (await sha256Bytes(bytes) !== action.snapshotSha256) {
    throw new ConnectorError("sha256_conflict", "The live item does not match the plan snapshot hash.");
  }
}

type DownstreamOutcome = {
  examinedActionId: string | null;
  reconciledActionId: string | null;
  discrepancy?: string;
  liveEvidence?: Record<string, unknown> | null;
};

async function reconcileOneDownstreamRename(
  context: HotfixContext,
  plan: IntegrityPlan,
): Promise<DownstreamOutcome> {
  refreshDependencySkips(plan);
  const completed = new Set(plan.completedActions);
  const failed = new Set(plan.failedActions.map((entry) => entry.actionId));
  const candidates = [...plan.actions]
    .filter((action) => action.action === "RENAME" && !completed.has(action.actionId) && findDeclaredDownstreamMoves(plan, action).length > 0)
    .sort((a, b) => Number(failed.has(b.actionId)) - Number(failed.has(a.actionId)) || Number(a.operationOrder ?? 0) - Number(b.operationOrder ?? 0));
  const action = candidates[0];
  if (!action) return { examinedActionId: null, reconciledActionId: null };

  const verification = await verifyDownstreamPostcondition(context, plan, action);
  if (!verification.live || !verification.downstreamMove) {
    return {
      examinedActionId: action.actionId,
      reconciledActionId: null,
      discrepancy: verification.discrepancy,
      liveEvidence: verification.live ? compactVerifiedItem(verification.live) : null,
    };
  }

  await verifySnapshotHash(
    context,
    action,
    verification.live.item.id,
    Number(verification.live.item.size ?? 0),
    verification.live.item.eTag,
  );

  const reconciledAt = nowIso();
  const audit = {
    actionId: action.actionId,
    action: action.action,
    reconciliationStatus: "externally_reconciled_after_downstream_move",
    alreadyApplied: true,
    originalPlanAction: action,
    downstreamPlanAction: verification.downstreamMove,
    snapshotEvidence: {
      sourceItemId: action.sourceItemId,
      sourcePath: action.sourcePath ?? null,
      snapshotETag: action.snapshotETag ?? null,
      snapshotSha256: action.snapshotSha256 ?? null,
    },
    liveEvidence: compactVerifiedItem(verification.live),
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
  return { examinedActionId: action.actionId, reconciledActionId: action.actionId };
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
  const outcome = await reconcileOneDownstreamRename(context, plan);
  if (outcome.reconciledActionId) {
    const updated = await getPlan(context, token.planId);
    refreshDependencySkips(updated);
    const remaining = remainingActions(updated.actions, updated.completedActions, updated.failedActions, updated.skippedDependencyActions);
    await context.storage.put(planKey(updated.planId), updated);
    return {
      planId: updated.planId,
      status: updated.status,
      executionStatus: updated.executionStatus,
      completedThisInvocation: [],
      reconciledThisInvocation: [outcome.reconciledActionId],
      failedThisInvocation: [],
      remainingActions: remaining.length,
      nextAction: updated.nextAction ?? remaining[0]?.actionId ?? null,
      resumeRequired: remaining.length > 0,
      auditPending: updated.auditStatus === "pending" || updated.auditStatus === "running",
      mutationPerformed: false,
      reconciliationOnlyThisInvocation: true,
    };
  }

  if (outcome.examinedActionId && plan.failedActions.some((entry) => entry.actionId === outcome.examinedActionId)) {
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
      discrepancy: {
        actionId: outcome.examinedActionId,
        code: outcome.discrepancy ?? "postcondition_not_satisfied",
        liveEvidence: outcome.liveEvidence ?? null,
      },
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
      description: "Reconcile one stable-item rename postcondition per invocation, including externally completed later moves, before executing at most one mutation.",
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
