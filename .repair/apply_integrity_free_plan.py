from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing replacement target: {label}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"expected one regex target for {label}, found {count}")
    return updated

# Graph request classification, sanitized diagnostics, and bounded retries.
graph_path = Path("src/graph-core.ts")
graph = graph_path.read_text()
graph_replacement = r'''export type GraphFetchExceptionClassification = {
  code: "graph_subrequest_limit" | "graph_timeout" | "graph_network_error" | "graph_unreachable";
  category: "resource_limit" | "timeout" | "network" | "unknown";
  message: string;
  retryable: boolean;
  exceptionName: string;
  exceptionMessage: string;
};

function sanitizeExceptionMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[redacted]")
    .slice(0, 300);
}

export function classifyGraphFetchException(error: unknown): GraphFetchExceptionClassification {
  const exceptionName = error instanceof Error ? error.name : "UnknownError";
  const exceptionMessage = sanitizeExceptionMessage(error);
  const sample = `${exceptionName} ${exceptionMessage}`.toLocaleLowerCase("en");
  if (/too many subrequests|subrequest limit|exceededresources|resource limit/.test(sample)) {
    return { code: "graph_subrequest_limit", category: "resource_limit", message: "The Worker external-subrequest budget was exhausted.", retryable: true, exceptionName, exceptionMessage };
  }
  if (/timeout|timed out|aborterror|deadline/.test(sample)) {
    return { code: "graph_timeout", category: "timeout", message: "Microsoft Graph timed out.", retryable: true, exceptionName, exceptionMessage };
  }
  if (/network|fetch failed|connection|socket|dns|econn|enet|reset/.test(sample)) {
    return { code: "graph_network_error", category: "network", message: "A network connection to Microsoft Graph failed.", retryable: true, exceptionName, exceptionMessage };
  }
  return { code: "graph_unreachable", category: "unknown", message: "Microsoft Graph is temporarily unavailable.", retryable: true, exceptionName, exceptionMessage };
}

function retryDelayMs(response: Response, attempt: number): number {
  const graphMilliseconds = Number(response.headers.get("x-ms-retry-after-ms") ?? "");
  if (Number.isFinite(graphMilliseconds) && graphMilliseconds >= 0) return Math.min(graphMilliseconds, 1_000);
  const retryAfter = Number(response.headers.get("retry-after") ?? "");
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1_000, 1_000);
  return Math.min(100 * 2 ** attempt, 1_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function graphResponse(
  env: Env,
  userId: string,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getGraphAccessToken(env, userId);
  const correlationId = crypto.randomUUID();
  const maximumAttempts = 3;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(graphUrl(pathOrUrl), {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
          "client-request-id": correlationId,
          "return-client-request-id": "true",
        },
      });
    } catch (caught) {
      const classified = classifyGraphFetchException(caught);
      const error = new ConnectorError(classified.code, classified.message, {
        retryable: classified.retryable,
        correlationId,
        details: {
          exceptionCategory: classified.category,
          exceptionName: classified.exceptionName,
          exceptionMessage: classified.exceptionMessage,
          attempt: attempt + 1,
        },
      });
      logSafeError("microsoft_graph_fetch_exception", error);
      if (classified.code !== "graph_subrequest_limit" && classified.retryable && attempt + 1 < maximumAttempts) {
        await delay(Math.min(100 * 2 ** attempt, 1_000));
        continue;
      }
      throw error;
    }
    if (response.ok) return response;
    let graphCode = "";
    try {
      const body = (await response.clone().json()) as { error?: { code?: string } };
      graphCode = String(body.error?.code ?? "").slice(0, 120);
    } catch {
      // Upstream body is intentionally discarded.
    }
    const code =
      response.status === 401 ? "authentication_required" :
      response.status === 403 ? "graph_forbidden" :
      response.status === 404 ? "item_not_found" :
      response.status === 409 || graphCode === "nameAlreadyExists" ? "name_conflict" :
      response.status === 412 ? "etag_conflict" :
      response.status === 413 ? "file_too_large" :
      response.status === 429 ? "graph_rate_limited" :
      response.status >= 500 ? "graph_server_error" :
      "graph_request_failed";
    const message =
      code === "name_conflict" ? "An item with that name already exists." :
      code === "etag_conflict" ? "The item changed since it was read. Fetch the current eTag and retry." :
      code === "item_not_found" ? "The requested OneDrive item was not found." :
      code === "authentication_required" ? "Microsoft authorization is no longer valid. Reconnect the ChatGPT app." :
      code === "graph_rate_limited" ? "Microsoft Graph rate-limited the request." :
      code === "graph_server_error" ? "Microsoft Graph returned a transient server error." :
      "Microsoft Graph could not complete the request.";
    const details = {
      graphErrorCode: graphCode || null,
      clientRequestId: response.headers.get("client-request-id") ?? correlationId,
      requestId: response.headers.get("request-id"),
      retryAfter: response.headers.get("retry-after"),
      retryAfterMs: response.headers.get("x-ms-retry-after-ms"),
      attempt: attempt + 1,
    };
    const retryable = response.status === 429 || response.status >= 500;
    const error = new ConnectorError(code, message, {
      retryable,
      status: response.status,
      correlationId,
      details,
    });
    logSafeError("microsoft_graph_error", error);
    if (retryable && attempt + 1 < maximumAttempts) {
      await response.body?.cancel();
      await delay(retryDelayMs(response, attempt));
      continue;
    }
    throw error;
  }
  throw new ConnectorError("graph_unreachable", "Microsoft Graph is temporarily unavailable.", { retryable: true, correlationId });
}

export async function graphFetch<T>'''
graph = regex_once(
    graph,
    r'async function graphResponse\([\s\S]*?\n}\n\nexport async function graphFetch<T>',
    graph_replacement,
    "graphResponse",
)
graph_path.write_text(graph)

# Resumable, one-mutation executor with live checks deferred to execution.
path = Path("src/integrated-tools.ts")
text = path.read_text()
text = replace_once(text, "  getGraphAccessToken,\n", "  getGraphAccessToken,\n  graphFetchBytes,\n  graphResponse,\n", "graph imports")
text = replace_once(
    text,
    '''  createFolderStrict,\n  createTextFileStrict,\n  moveItemStrict,\n  renameItemStrict,\n  replaceTextFileStrict,\n''',
    '''  createFolderInVerifiedDestinationStrict,\n  createFolderStrict,\n  createTextFileInVerifiedDestinationStrict,\n  createTextFileStrict,\n  moveItemStrict,\n  moveVerifiedItemStrict,\n  renameItemStrict,\n  renameVerifiedItemStrict,\n  replaceTextFileStrict,\n  replaceVerifiedTextFileStrict,\n''',
    "verified mutation imports",
)
text = replace_once(
    text,
    '} from "./integrated-core";\n',
    '''} from "./integrated-core";\nimport {\n  MAX_MUTATIONS_PER_INVOCATION,\n  advanceDependencySkips,\n  normalizeProgress,\n  remainingActions,\n  uniqueStrings,\n  upsertFailure,\n  upsertResult,\n} from "./integrity-execution";\n''',
    "integrity execution imports",
)
text = replace_once(
    text,
    '  failedActions: Array<{ actionId: string; code: string; message: string }>;\n',
    '  failedActions: Array<{ actionId: string; code: string; message: string; retryable?: boolean; status?: number; correlationId?: string; details?: Record<string, unknown> }>;\n',
    "failure type",
)
text = replace_once(
    text,
    '  finalFilesystemDiffReference: string | null;\n  planHash: string;\n',
    '  finalFilesystemDiffReference: string | null;\n  nextAction?: string | null;\n  auditStatus?: "not_requested" | "pending" | "running" | "completed" | "failed";\n  completedInvocations?: number;\n  lastExecutionAt?: string | null;\n  planHash: string;\n',
    "plan progress fields",
)
text = replace_once(
    text,
    '''    finalFilesystemDiffReference: null,\n    planHash,\n''',
    '''    finalFilesystemDiffReference: null,\n    nextAction: actions[0]?.actionId ?? null,\n    auditStatus: "not_requested",\n    completedInvocations: 0,\n    lastExecutionAt: null,\n    planHash,\n''',
    "plan initialization",
)

validate_function = r'''export async function validateIntegrityPlan(context: IntegratedContext, planId: string): Promise<Record<string, unknown>> {
  const plan = normalizeProgress(await getPlan(context, planId));
  const records = await listSnapshotRecords(context, plan.snapshotId);
  const byId = new Map(records.map((record) => [record.itemId, record]));
  const errors: Array<Record<string, unknown>> = [];
  const destinationMap = new Map<string, string>();
  const actionIds = new Set(plan.actions.map((action) => action.actionId));
  const actionById = new Map(plan.actions.map((action) => [action.actionId, action]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (actionId: string): void => {
    if (visiting.has(actionId)) { errors.push({ actionId, code: "dependency_cycle" }); return; }
    if (visited.has(actionId)) return;
    visiting.add(actionId);
    for (const dependency of actionById.get(actionId)?.dependencies ?? []) if (actionById.has(dependency)) visit(dependency);
    visiting.delete(actionId);
    visited.add(actionId);
  };
  for (const action of plan.actions) visit(action.actionId);
  for (const action of plan.actions) {
    for (const dependency of action.dependencies ?? []) {
      if (!actionIds.has(dependency)) errors.push({ actionId: action.actionId, code: "missing_dependency", dependency });
      else if (Number(actionById.get(dependency)?.operationOrder ?? -1) >= Number(action.operationOrder ?? 0)) errors.push({ actionId: action.actionId, code: "invalid_dependency_order", dependency });
    }
    if (action.sourcePath && !scopeContains(plan.scopePath, action.sourcePath)) errors.push({ actionId: action.actionId, code: "source_outside_scope" });
    if (action.destinationPath && !scopeContains(plan.scopePath, action.destinationPath)) errors.push({ actionId: action.actionId, code: "destination_outside_scope" });
    if (action.destinationPath) {
      const finalName = action.proposedFilename ?? action.currentFilename ?? "";
      const destinationKey = `${strictRelativePath(action.destinationPath)}/${finalName}`.toLocaleLowerCase("en");
      if (destinationMap.has(destinationKey)) errors.push({ actionId: action.actionId, code: "duplicate_destination", conflictingActionId: destinationMap.get(destinationKey) });
      destinationMap.set(destinationKey, action.actionId);
    }
    if (action.action === "MOVE" && action.sourcePath && action.destinationPath && `${strictRelativePath(action.destinationPath)}/`.toLocaleLowerCase("en").startsWith(`${strictRelativePath(action.sourcePath)}/`.toLocaleLowerCase("en"))) errors.push({ actionId: action.actionId, code: "circular_move" });
    if (action.action === "RECYCLE_FOLDER" && action.requiredStructuralPlaceholder) errors.push({ actionId: action.actionId, code: "required_placeholder_protected" });
    if (actionIsDestructive(action) && ambiguityIsYes(action)) errors.push({ actionId: action.actionId, code: "ambiguous_destructive_action" });
    if (actionIsDestructive(action) && !deletionApproved(action)) errors.push({ actionId: action.actionId, code: "destructive_decision_missing" });
    if (action.proposedFilename) {
      try { validateItemName(action.proposedFilename); } catch (error) { const safe = connectorError(error); errors.push({ actionId: action.actionId, code: safe.code, message: safe.message }); }
    }
    if (action.sourceItemId) {
      const snapshot = byId.get(action.sourceItemId);
      if (!snapshot) { errors.push({ actionId: action.actionId, code: "source_missing_from_snapshot" }); continue; }
      if (action.sourcePath && snapshot.relativePath !== action.sourcePath) errors.push({ actionId: action.actionId, code: "snapshot_path_mismatch" });
      if (action.currentFilename && snapshot.filename !== action.currentFilename) errors.push({ actionId: action.actionId, code: "snapshot_filename_mismatch" });
      if (action.snapshotETag && snapshot.eTag !== action.snapshotETag) errors.push({ actionId: action.actionId, code: "snapshot_etag_mismatch" });
      if (action.snapshotSha256 && snapshot.sha256 && snapshot.sha256 !== action.snapshotSha256) errors.push({ actionId: action.actionId, code: "snapshot_sha256_mismatch" });
      if (["MOVE", "RENAME", "REPLACE_TEXT", "RECYCLE"].includes(action.action) && snapshot.type === "file" && !action.snapshotSha256) errors.push({ actionId: action.actionId, code: "mutation_hash_required" });
    }
    if (["CREATE_FOLDER", "CREATE_TEXT"].includes(action.action) && !(action.proposedFilename ?? action.currentFilename)) errors.push({ actionId: action.actionId, code: "destination_name_required" });
  }
  const recycleFolders = plan.actions.filter((action) => action.action === "RECYCLE_FOLDER");
  for (const folder of recycleFolders) {
    const descendants = plan.actions.filter((action) => action.sourcePath && folder.sourcePath && action.sourcePath.startsWith(`${folder.sourcePath}/`));
    if (descendants.some((action) => Number(action.operationOrder ?? 0) >= Number(folder.operationOrder ?? 0))) errors.push({ actionId: folder.actionId, code: "folder_recycled_before_descendants" });
    if (strictRelativePath(folder.sourcePath ?? "") === strictRelativePath(plan.scopePath)) errors.push({ actionId: folder.actionId, code: "scope_root_recycle_forbidden" });
  }
  if (errors.length > 0) {
    plan.validationStatus = "invalid";
    if (plan.executionStatus === "not_started") plan.status = "draft";
    await storePlan(context, plan);
    return { valid: false, planId, errors, validationExternalGraphRequests: 0 };
  }
  const retryableFailures = new Set(plan.failedActions.filter((entry) => entry.retryable).map((entry) => entry.actionId));
  if (retryableFailures.size > 0) {
    plan.failedActions = plan.failedActions.filter((entry) => !retryableFailures.has(entry.actionId));
    plan.skippedDependencyActions = [];
  }
  const prepared = new Set(plan.deletionLogsPrepared);
  for (const action of plan.actions.filter(actionIsDestructive)) {
    if (prepared.has(action.actionId)) continue;
    await context.storage.put(operationKey(plan.planId, `deletion-prepared-${action.actionId}`), {
      preparedAt: nowIso(), planId: plan.planId, actionId: action.actionId, sourceItemId: action.sourceItemId, sourcePath: action.sourcePath,
      snapshotETag: action.snapshotETag, snapshotSha256: action.snapshotSha256, finalDecision: action.finalDecision,
    });
    prepared.add(action.actionId);
  }
  plan.deletionLogsPrepared = [...prepared];
  plan.validationStatus = "valid";
  const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  if (plan.executionStatus !== "completed") {
    plan.status = plan.completedActions.length || plan.failedActions.length || plan.skippedDependencyActions.length ? "running" : "validated";
    plan.executionStatus = plan.completedActions.length || plan.failedActions.length || plan.skippedDependencyActions.length ? "running" : "not_started";
  }
  plan.nextAction = remaining[0]?.actionId ?? null;
  await storePlan(context, plan);
  const executionToken = await sealJson(context.env.COOKIE_ENCRYPTION_KEY, { planId: plan.planId, planHash: plan.planHash, expiresAt: Date.now() + INTEGRATED_LIMITS.executionTokenSeconds * 1000 });
  return {
    valid: true,
    planId,
    executionToken,
    expiresInSeconds: INTEGRATED_LIMITS.executionTokenSeconds,
    deletionLogsPrepared: plan.deletionLogsPrepared,
    validationExternalGraphRequests: 0,
    livePreconditionsDeferredUntilMutation: true,
    resumeFromAction: plan.nextAction,
    completedActions: plan.completedActions,
  };
}
'''
text = regex_once(
    text,
    r'async function validateIntegrityPlan\([\s\S]*?\n}\n\nasync function acquireScopeLock',
    validate_function + '\nasync function acquireScopeLock',
    "validateIntegrityPlan",
)

execution_block = r'''function actionNeedsContentHash(action: PlanAction): boolean {
  return ["MOVE", "RENAME", "REPLACE_TEXT", "RECYCLE"].includes(action.action) || actionIsDestructive(action);
}

async function shaForRetainedItem(context: IntegratedContext, source: VerifiedItem): Promise<string> {
  if (source.item.folder) throw new ConnectorError("folder_not_file", "A folder does not have a file SHA-256.");
  if ((source.item.size ?? 0) > INTEGRATED_LIMITS.fileBytesMax) throw new ConnectorError("file_too_large", "The file exceeds the integrated-operation size limit.");
  const buffer = await graphFetchBytes(context.env, context.userId, `/me/drive/items/${encodeURIComponent(source.item.id)}/content`, INTEGRATED_LIMITS.fileBytesMax);
  return sha256Bytes(buffer);
}

function expectedAppliedPath(action: PlanAction): string | null {
  if (action.action === "MOVE" && action.destinationPath) {
    const name = action.proposedFilename ?? action.currentFilename ?? action.sourcePath?.split("/").pop();
    return name ? strictRelativePath(`${action.destinationPath}/${name}`) : null;
  }
  if (action.action === "RENAME" && action.sourcePath && action.proposedFilename) {
    const parent = action.sourcePath.split("/").slice(0, -1).join("/");
    return strictRelativePath(parent ? `${parent}/${action.proposedFilename}` : action.proposedFilename);
  }
  return null;
}

async function completedOperation(context: IntegratedContext, plan: IntegrityPlan, action: PlanAction, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  const completed = { state: "completed", ...result };
  await context.storage.put(operationKey(plan.planId, action.actionId), completed);
  return result;
}

async function executePlanAction(context: IntegratedContext, plan: IntegrityPlan, action: PlanAction): Promise<Record<string, unknown>> {
  let source: VerifiedItem | null = null;
  if (action.sourceItemId) {
    source = await verifyItemInsideRoot(context.env, context.userId, action.sourceItemId);
    if (!scopeContains(plan.scopePath, source.relativePath)) throw new ConnectorError("outside_scope", "The source moved outside the plan scope.");
    const expectedApplied = expectedAppliedPath(action);
    if (action.sourcePath && source.relativePath !== action.sourcePath) {
      if (expectedApplied && source.relativePath === expectedApplied) {
        if (action.snapshotSha256 && !source.item.folder && await shaForRetainedItem(context, source) !== action.snapshotSha256) throw new ConnectorError("sha256_conflict", "The already-moved item no longer matches the snapshot hash.");
        return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before: null, after: compactVerifiedItem(source), alreadyApplied: true, completedAt: nowIso() });
      }
      throw new ConnectorError("path_conflict", "The source path changed after the plan snapshot was created.");
    }
    if (action.snapshotETag && source.item.eTag !== action.snapshotETag) throw new ConnectorError("etag_conflict", "The source changed after the plan snapshot was created.");
    if (actionNeedsContentHash(action) && !source.item.folder) {
      if (!action.snapshotSha256) throw new ConnectorError("mutation_hash_required", "The file mutation requires the snapshot SHA-256.");
      if (await shaForRetainedItem(context, source) !== action.snapshotSha256) throw new ConnectorError("sha256_conflict", "The source content changed after the plan snapshot was created.");
    }
  }
  if (action.destinationPath && !scopeContains(plan.scopePath, action.destinationPath)) throw new ConnectorError("outside_scope", "The destination is outside the plan scope.");
  if (action.action === "KEEP" || action.action === "METADATA_ONLY" || action.action === "CATALOGUE_ONLY") {
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, status: "recorded", completedAt: nowIso() });
  }
  if (action.action === "CREATE_FOLDER") {
    const destination = await resolveRelativeFolder(context.env, context.userId, String(action.destinationPath ?? plan.scopePath));
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before: null, destination: compactVerifiedItem(destination) });
    const result = await createFolderInVerifiedDestinationStrict(context.env, context.userId, destination, String(action.proposedFilename ?? action.currentFilename ?? ""));
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, after: result, rollbackPossible: true, completedAt: nowIso() });
  }
  if (action.action === "CREATE_TEXT") {
    const destination = await resolveRelativeFolder(context.env, context.userId, String(action.destinationPath ?? plan.scopePath));
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before: null, destination: compactVerifiedItem(destination) });
    const result = await createTextFileInVerifiedDestinationStrict(context.env, context.userId, destination, String(action.proposedFilename ?? action.currentFilename ?? ""), String(action.content ?? ""));
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, after: result, rollbackPossible: true, completedAt: nowIso() });
  }
  if (action.action === "REPLACE_TEXT") {
    if (!source || !action.snapshotETag) throw new ConnectorError("etag_required", "REPLACE_TEXT requires a retained source and snapshot eTag.");
    const before = compactVerifiedItem(source);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before });
    const result = await replaceVerifiedTextFileStrict(context.env, context.userId, source, action.snapshotETag, String(action.content ?? ""));
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before, after: result, rollbackPossible: false, completedAt: nowIso() });
  }
  if (action.action === "RENAME") {
    if (!source || !action.proposedFilename || !action.snapshotETag) throw new ConnectorError("rename_fields_required", "RENAME requires source, proposedFilename, and snapshotETag.");
    const parentId = source.item.parentReference?.id;
    if (!parentId) throw new ConnectorError("root_rename_forbidden", "The configured root cannot be renamed.");
    const parent = await verifyItemInsideRoot(context.env, context.userId, parentId);
    const before = compactVerifiedItem(source);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before, destination: compactVerifiedItem(parent) });
    const result = await renameVerifiedItemStrict(context.env, context.userId, source, parent, action.proposedFilename, action.snapshotETag);
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before, after: result, rollbackPossible: true, completedAt: nowIso() });
  }
  if (action.action === "MOVE") {
    if (!source || !action.destinationPath || !action.snapshotETag) throw new ConnectorError("move_fields_required", "MOVE requires source, destinationPath, and snapshotETag.");
    const destination = await resolveRelativeFolder(context.env, context.userId, action.destinationPath);
    const before = compactVerifiedItem(source);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before, destination: compactVerifiedItem(destination) });
    const result = await moveVerifiedItemStrict(context.env, context.userId, source, destination, action.snapshotETag, action.proposedFilename);
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before, after: result, rollbackPossible: true, completedAt: nowIso() });
  }
  if (action.action === "RECYCLE" || action.action === "RECYCLE_FOLDER") {
    if (!source) throw new ConnectorError("source_item_required", "Recycle actions require a retained source.");
    if (!plan.deletionLogsPrepared.includes(action.actionId)) throw new ConnectorError("recycle_log_missing", "The recycle deletion log was not prepared.");
    if (action.action === "RECYCLE_FOLDER") {
      if (source.item.id === source.root.id) throw new ConnectorError("scope_root_recycle_forbidden", "The scope root cannot be recycled.");
      const page = await listVerifiedChildren(context.env, context.userId, source, 200);
      if (page.items.length > 0 || page.nextUrl) throw new ConnectorError("folder_not_empty", "The folder is not empty after descendant actions.");
    }
    const before = compactVerifiedItem(source);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), before, action });
    await graphRaw(context, `/me/drive/items/${encodeURIComponent(source.item.id)}`, { method: "DELETE", headers: action.snapshotETag ? { "If-Match": action.snapshotETag } : {} });
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before, after: null, recycled: true, reversibleThroughOneDriveRecycleBin: true, automaticRollbackAvailable: false, completedAt: nowIso() });
  }
  throw new ConnectorError("unsupported_plan_action", "The plan contains an unsupported action.");
}

export async function executeIntegrityPlan(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await openJson<{ planId: string; planHash: string; expiresAt: number }>(context.env.COOKIE_ENCRYPTION_KEY, String(input.executionToken ?? "")).catch(() => null);
  if (!token || token.expiresAt <= Date.now()) throw new ConnectorError("execution_token_invalid", "The execution token is invalid or expired.");
  const plan = normalizeProgress(await getPlan(context, token.planId));
  if (plan.validationStatus !== "valid" || plan.planHash !== token.planHash) throw new ConnectorError("plan_not_validated", "The integrity plan is not currently validated.");
  await acquireScopeLock(context, plan);
  const completedThisInvocation: string[] = [];
  const failedThisInvocation: string[] = [];
  try {
    advanceDependencySkips(plan);
    let remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    if (remaining.length > 0) {
      const action = remaining[0];
      plan.currentAction = action.actionId;
      plan.nextAction = action.actionId;
      plan.status = "running";
      plan.executionStatus = "running";
      await storePlan(context, plan);
      const existing = await context.storage.get<Record<string, unknown>>(operationKey(plan.planId, action.actionId));
      if (existing?.state === "completed") {
        const reconciled = { ...existing, actionId: action.actionId };
        plan.results = upsertResult(plan.results, reconciled);
        plan.completedActions = uniqueStrings([...plan.completedActions, action.actionId]);
        completedThisInvocation.push(action.actionId);
      } else {
        try {
          const result = await executePlanAction(context, plan, action);
          plan.results = upsertResult(plan.results, result);
          plan.completedActions = uniqueStrings([...plan.completedActions, action.actionId]);
          plan.failedActions = plan.failedActions.filter((entry) => entry.actionId !== action.actionId);
          completedThisInvocation.push(action.actionId);
        } catch (error) {
          const safe = connectorError(error);
          plan.failedActions = upsertFailure(plan.failedActions, {
            actionId: action.actionId,
            code: safe.code,
            message: safe.message,
            retryable: safe.retryable,
            status: safe.status,
            correlationId: safe.correlationId,
            details: safe.details,
          });
          failedThisInvocation.push(action.actionId);
          await context.storage.put(operationKey(plan.planId, action.actionId), { state: "failed", failedAt: nowIso(), error: { code: safe.code, message: safe.message, retryable: safe.retryable, status: safe.status ?? null, correlationId: safe.correlationId, details: safe.details ?? null }, action });
        }
      }
    }
    normalizeProgress(plan);
    advanceDependencySkips(plan);
    remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    plan.currentAction = null;
    plan.nextAction = remaining[0]?.actionId ?? null;
    plan.completedInvocations = Number(plan.completedInvocations ?? 0) + 1;
    plan.lastExecutionAt = nowIso();
    if (remaining.length > 0) {
      plan.status = "running";
      plan.executionStatus = "running";
    } else {
      plan.executionStatus = plan.failedActions.length > 0 ? "failed" : "completed";
      plan.status = plan.failedActions.length > 0 ? "failed" : "completed";
      if (plan.completedActions.length > 0) plan.auditStatus = "pending";
    }
    await storePlan(context, plan);
    return {
      planId: plan.planId,
      status: plan.status,
      executionStatus: plan.executionStatus,
      resumeRequired: remaining.length > 0,
      completedThisInvocation,
      failedThisInvocation,
      mutationLimitThisInvocation: MAX_MUTATIONS_PER_INVOCATION,
      remainingActions: remaining.length,
      remainingActionIds: remaining.map((action) => action.actionId),
      nextAction: plan.nextAction,
      completedActions: plan.completedActions,
      failedActions: plan.failedActions,
      skippedDependencyActions: plan.skippedDependencyActions,
      results: plan.results,
      auditPending: plan.auditStatus === "pending",
      finalFilesystemDiffReference: plan.finalFilesystemDiffReference,
      recoveryState: plan.failedActions.length > 0 ? { successfulActionsRemainApplied: true, dependentActionsSkipped: true, automaticRollbackPerformed: false, revalidateToRetryTransientFailures: plan.failedActions.some((entry) => entry.retryable) } : null,
    };
  } finally {
    await releaseScopeLock(context, plan);
  }
}
'''
text = regex_once(
    text,
    r'async function recycleItem\([\s\S]*?\n}\n\nasync function diffScopeBeforeAfter',
    execution_block + '\nasync function diffScopeBeforeAfter',
    "resumable execution block",
)

# Route all integrated Graph requests through the same classified retry layer.
text = regex_once(
    text,
    r'async function graphRaw\(context: IntegratedContext, pathOrUrl: string, init: RequestInit = \{\}\): Promise<Response> \{[\s\S]*?\n}\n',
    '''async function graphRaw(context: IntegratedContext, pathOrUrl: string, init: RequestInit = {}): Promise<Response> {\n  return graphResponse(context.env, context.userId, pathOrUrl, init);\n}\n''',
    "graphRaw wrapper",
)

text = replace_once(
    text,
    'server.registerTool("execute_integrity_plan", { title: "Execute validated integrity plan serially", description: "Execute one validated plan under an overlap-aware scope lock with live ancestry, path, eTag, SHA-256, and destination checks before every action. Recycling is reversible through the OneDrive recycle bin; permanent deletion is unavailable.",',
    'server.registerTool("execute_integrity_plan", { title: "Resume validated integrity plan", description: "Execute at most one mutation per invocation under an overlap-aware scope lock, persisting progress and rechecking live ancestry, path, eTag, SHA-256, destination, collision, circularity, and If-Match preconditions immediately before mutation.",',
    "execute tool description",
)
text = replace_once(
    text,
    'return textResult({ planId, planStatus: plan.status, validationStatus: plan.validationStatus, executionStatus: plan.executionStatus, currentAction: plan.currentAction, completedActions: plan.completedActions, failedActions: plan.failedActions, skippedDependencyActions: plan.skippedDependencyActions, finalFilesystemDiffReference: plan.finalFilesystemDiffReference });',
    'const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions); return textResult({ planId, planStatus: plan.status, validationStatus: plan.validationStatus, executionStatus: plan.executionStatus, currentAction: plan.currentAction, nextAction: plan.nextAction ?? remaining[0]?.actionId ?? null, resumeRequired: remaining.length > 0, remainingActions: remaining.length, completedActions: plan.completedActions, failedActions: plan.failedActions, skippedDependencyActions: plan.skippedDependencyActions, auditStatus: plan.auditStatus ?? "not_requested", finalFilesystemDiffReference: plan.finalFilesystemDiffReference });',
    "status response",
)
text = replace_once(
    text,
    'server.registerTool("diff_scope_before_after", { title: "Verify scope before and after", description: "Compare the original snapshot, executed plan, operation logs, and final live scope, including evidence that no plan operation modified an item outside the declared scope.", inputSchema: { planId: z.string().uuid() }, annotations: READ_ONLY }, async ({ planId }) => { try { return textResult(await diffScopeBeforeAfter(contextFactory(), planId)); } catch (error) { return errorResult(error); } });',
    'server.registerTool("diff_scope_before_after", { title: "Verify scope before and after", description: "Run the final full-scope enumeration, hashing, catalogue analysis, and operation-log comparison as a separate follow-up after bounded plan execution.", inputSchema: { planId: z.string().uuid() }, annotations: READ_ONLY }, async ({ planId }) => { const context = contextFactory(); try { const plan = await getPlan(context, planId); plan.auditStatus = "running"; await storePlan(context, plan); const diff = await diffScopeBeforeAfter(context, planId); plan.finalFilesystemDiffReference = `integrated:diff:${plan.planId}`; plan.auditStatus = "completed"; await context.storage.put(plan.finalFilesystemDiffReference, diff); await storePlan(context, plan); return textResult(diff); } catch (error) { try { const plan = await getPlan(context, planId); plan.auditStatus = "failed"; await storePlan(context, plan); } catch { /* preserve the original error */ } return errorResult(error); } });',
    "separate diff persistence",
)
path.write_text(text)

Path("test/integrity-free-plan.test.ts").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { sealJson } from "../src/security.js";
import { moveVerifiedItemStrict } from "../src/write-operations.js";
import {
  INTEGRITY_MOVE_TESTED_FETCH_CEILING,
  WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT,
  advanceDependencySkips,
  estimateOrdinaryMoveExternalFetches,
  normalizeProgress,
  remainingActions,
  upsertFailure,
  upsertResult,
} from "../src/integrity-execution.js";
import type { VerifiedItem } from "../src/graph-core.js";

function item(id: string, name: string, parentId: string, eTag: string, folder = false) {
  return {
    id,
    name,
    size: folder ? 0 : 10,
    eTag,
    folder: folder ? { childCount: 0 } : undefined,
    file: folder ? undefined : { mimeType: "text/plain" },
    parentReference: { id: parentId, driveId: "drive" },
  } as any;
}

function verified(sourceItem: any, root: any, relativePath: string, ancestors: string[]): VerifiedItem {
  return { item: sourceItem, root, relativePath, ancestorIds: ancestors, driveId: "drive" };
}

test("one retained ordinary MOVE stays far below the hard 50-external-fetch limit", async () => {
  const root = item("root", "Работа", "drive-root", '"root",1', true);
  const sourceItem = item("source", "file.txt", "old-parent", '"source",7');
  const destinationItem = item("destination", "National", "kg", '"destination",2', true);
  const source = verified(sourceItem, root, "UCA/Modules/03_Source_Library/Legal/Kyrgyzstan/National/Local_Government_Investment_and_PPP/file.txt", ["source", "old-parent", "root"]);
  const destination = verified(destinationItem, root, "UCA/Modules/03_Source_Library/Legal/Kyrgyzstan/National", ["destination", "kg", "root"]);
  const key = "test-cookie-key-at-least-32-bytes-long";
  const sealed = await sealJson(key, { accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, scope: "Files.ReadWrite" });
  let externalFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    externalFetches += 1;
    const href = String(url);
    if (href.includes("/children?")) return Response.json({ value: [] });
    if (init?.method === "PATCH") return Response.json({ ...sourceItem, name: "file.txt", eTag: '"source",8', parentReference: { id: destinationItem.id, driveId: "drive" } });
    throw new Error(`unexpected Graph request: ${href}`);
  }) as typeof fetch;
  const env = {
    COOKIE_ENCRYPTION_KEY: key,
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ fetch: async () => Response.json({ ok: true, found: true, expired: false, value: sealed }) }) as unknown as DurableObjectStub,
    } as DurableObjectNamespace,
  } as Env;
  try {
    const result = await moveVerifiedItemStrict(env, "user", source, destination, sourceItem.eTag);
    assert.equal(result.relativePath, `${destination.relativePath}/file.txt`);
    assert.equal(externalFetches, 2);
    assert.ok(externalFetches < WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the full canary ancestry estimate remains within the tested ceiling and below 50", () => {
  const count = estimateOrdinaryMoveExternalFetches(
    "UCA/Modules/03_Source_Library/Legal/Kyrgyzstan/National/Local_Government_Investment_and_PPP/KGN_LG_03.pdf",
    "UCA/Modules/03_Source_Library/Legal/Kyrgyzstan/National",
  );
  assert.ok(count <= INTEGRITY_MOVE_TESTED_FETCH_CEILING, `estimated ${count} external subrequests`);
  assert.ok(count < WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT);
});

test("three actions resume one at a time and repeated completion is idempotent", () => {
  const plan = { actions: [
    { actionId: "A", operationOrder: 0 },
    { actionId: "B", operationOrder: 1 },
    { actionId: "C", operationOrder: 2 },
  ], completedActions: [] as string[], failedActions: [] as any[], skippedDependencyActions: [] as string[], results: [] as any[] };
  assert.deepEqual(remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions).map((a) => a.actionId), ["A", "B", "C"]);
  plan.completedActions.push("A", "A");
  plan.results = upsertResult(plan.results, { actionId: "A", attempt: 1 });
  plan.results = upsertResult(plan.results, { actionId: "A", attempt: 2 });
  normalizeProgress(plan);
  assert.deepEqual(plan.completedActions, ["A"]);
  assert.equal(plan.results.length, 1);
  assert.deepEqual(remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions).map((a) => a.actionId), ["B", "C"]);
  plan.completedActions.push("B");
  normalizeProgress(plan);
  assert.deepEqual(remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions).map((a) => a.actionId), ["C"]);
  plan.completedActions.push("C");
  normalizeProgress(plan);
  assert.equal(remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions).length, 0);
});

test("failure and dependency-skip records are upserted rather than duplicated", () => {
  const plan = { actions: [
    { actionId: "A", operationOrder: 0 },
    { actionId: "B", operationOrder: 1, dependencies: ["A"] },
  ], completedActions: [] as string[], failedActions: [] as any[], skippedDependencyActions: [] as string[], results: [] as any[] };
  plan.failedActions = upsertFailure(plan.failedActions, { actionId: "A", code: "network", message: "first", retryable: true });
  plan.failedActions = upsertFailure(plan.failedActions, { actionId: "A", code: "network", message: "second", retryable: true });
  advanceDependencySkips(plan);
  advanceDependencySkips(plan);
  normalizeProgress(plan);
  assert.equal(plan.failedActions.length, 1);
  assert.equal(plan.failedActions[0].message, "second");
  assert.deepEqual(plan.skippedDependencyActions, ["B"]);
});
''')

Path("test/graph-error-classification.test.ts").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { classifyGraphFetchException } from "../src/graph-core.js";

test("classifies the Cloudflare external-subrequest limit without same-invocation retry", () => {
  const result = classifyGraphFetchException(new Error("Too many subrequests."));
  assert.equal(result.code, "graph_subrequest_limit");
  assert.equal(result.category, "resource_limit");
  assert.equal(result.retryable, true);
});

test("distinguishes timeout and network connection failures", () => {
  const timeout = new Error("The operation timed out"); timeout.name = "AbortError";
  assert.equal(classifyGraphFetchException(timeout).code, "graph_timeout");
  assert.equal(classifyGraphFetchException(new TypeError("fetch failed: connection reset")).code, "graph_network_error");
});

test("sanitizes URLs and long opaque values from exception diagnostics", () => {
  const result = classifyGraphFetchException(new Error(`fetch failed https://graph.microsoft.com/download?token=${"x".repeat(120)}`));
  assert.equal(result.exceptionMessage.includes("graph.microsoft.com"), false);
  assert.equal(result.exceptionMessage.includes("x".repeat(80)), false);
});
''')
