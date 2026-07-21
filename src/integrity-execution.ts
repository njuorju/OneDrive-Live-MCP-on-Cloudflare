export const MAX_MUTATIONS_PER_INVOCATION = 1;
export const WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT = 50;
export const INTEGRITY_MOVE_TESTED_FETCH_CEILING = 32;

export type ProgressAction = {
  actionId: string;
  operationOrder?: number;
  dependencies?: string[];
};

export type ProgressFailure = {
  actionId: string;
  code: string;
  message: string;
  retryable?: boolean;
  status?: number;
  correlationId?: string;
  details?: Record<string, unknown>;
};

export type ProgressResult = Record<string, unknown> & { actionId?: unknown };

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function upsertFailure(failures: ProgressFailure[], failure: ProgressFailure): ProgressFailure[] {
  return [...failures.filter((entry) => entry.actionId !== failure.actionId), failure];
}

export function upsertResult(results: ProgressResult[], result: ProgressResult): ProgressResult[] {
  const actionId = String(result.actionId ?? "");
  return actionId
    ? [...results.filter((entry) => String(entry.actionId ?? "") !== actionId), result]
    : [...results, result];
}

export function normalizeProgress<T extends {
  completedActions: string[];
  failedActions: ProgressFailure[];
  skippedDependencyActions: string[];
  results: ProgressResult[];
}>(plan: T): T {
  plan.completedActions = uniqueStrings(plan.completedActions);
  plan.skippedDependencyActions = uniqueStrings(plan.skippedDependencyActions);
  plan.failedActions = [...new Map(plan.failedActions.map((entry) => [entry.actionId, entry])).values()];
  plan.results = [...new Map(plan.results.map((entry, index) => [String(entry.actionId ?? `unkeyed-${index}`), entry])).values()];
  const completed = new Set(plan.completedActions);
  plan.failedActions = plan.failedActions.filter((entry) => !completed.has(entry.actionId));
  plan.skippedDependencyActions = plan.skippedDependencyActions.filter((actionId) => !completed.has(actionId));
  return plan;
}

export function orderedActions<T extends ProgressAction>(actions: T[]): T[] {
  return [...actions].sort((left, right) => Number(left.operationOrder ?? 0) - Number(right.operationOrder ?? 0));
}

export function advanceDependencySkips<T extends {
  actions: ProgressAction[];
  completedActions: string[];
  failedActions: ProgressFailure[];
  skippedDependencyActions: string[];
}>(plan: T): string[] {
  const completed = new Set(plan.completedActions);
  const failed = new Set(plan.failedActions.map((entry) => entry.actionId));
  const previous = new Set(plan.skippedDependencyActions);
  const skipped = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const action of orderedActions(plan.actions)) {
      if (completed.has(action.actionId) || failed.has(action.actionId) || skipped.has(action.actionId)) continue;
      if ((action.dependencies ?? []).some((dependency) => failed.has(dependency) || skipped.has(dependency))) {
        skipped.add(action.actionId);
        changed = true;
      }
    }
  }
  plan.skippedDependencyActions = [...skipped];
  return [...skipped].filter((actionId) => !previous.has(actionId));
}

export function remainingActions<T extends ProgressAction>(
  actions: T[],
  completedActions: string[],
  failedActions: ProgressFailure[],
  skippedDependencyActions: string[],
): T[] {
  const terminal = new Set([
    ...completedActions,
    ...failedActions.map((entry) => entry.actionId),
    ...skippedDependencyActions,
  ]);
  return orderedActions(actions).filter((action) => !terminal.has(action.actionId));
}

export function estimateOrdinaryMoveExternalFetches(
  sourcePath: string,
  destinationPath: string,
  options: { collisionPages?: number; contentRedirectSubrequests?: number; tokenRefresh?: boolean; transientRetries?: number } = {},
): number {
  const sourceSegments = sourcePath.split("/").filter(Boolean).length;
  const destinationSegments = destinationPath.split("/").filter(Boolean).length;
  const sourceVerification = sourceSegments + 2;
  const destinationResolutionAndVerification = destinationSegments + 4;
  const collisionPages = Math.max(1, options.collisionPages ?? 1);
  const contentRedirects = Math.max(1, options.contentRedirectSubrequests ?? 2);
  const tokenRefresh = options.tokenRefresh === false ? 0 : 1;
  const mutation = 1;
  const retries = Math.max(0, options.transientRetries ?? 0);
  return sourceVerification + destinationResolutionAndVerification + collisionPages + contentRedirects + tokenRefresh + mutation + retries;
}
