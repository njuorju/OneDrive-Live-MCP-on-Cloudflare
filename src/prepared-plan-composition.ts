import { ConnectorError } from "./errors";

export type PreparedRole = "single" | "csv" | "json";
export type PlanActionLike = Record<string, unknown> & {
  actionId?: unknown;
  action?: unknown;
  dependencies?: unknown;
  sourcePath?: unknown;
  destinationPath?: unknown;
};

const ACTION_ID_MAX = 200;

function actionId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > ACTION_ID_MAX) {
    throw new ConnectorError("composed_action_id_invalid", `${label} must be an explicit action ID between 1 and ${ACTION_ID_MAX} characters.`);
  }
  return value;
}

function normalizedPath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ConnectorError("composed_path_invalid", "Action paths must be strings.");
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function assertWithinScope(scopePath: string, candidate: unknown): void {
  const candidatePath = normalizedPath(candidate);
  if (!candidatePath) return;
  const scope = normalizedPath(scopePath) ?? "";
  const left = scope.toLocaleLowerCase("en");
  const right = candidatePath.toLocaleLowerCase("en");
  if (left && right !== left && !right.startsWith(`${left}/`)) {
    throw new ConnectorError("composed_action_outside_scope", "Every composed action path must remain inside the declared scope.");
  }
}

function dependencyList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConnectorError("composed_dependencies_invalid", `${label} dependencies must be an array.`);
  return value.map((entry) => actionId(entry, `${label} dependency`));
}

function assertAcyclic(actions: PlanActionLike[]): void {
  const graph = new Map<string, string[]>();
  for (const action of actions) graph.set(String(action.actionId), action.dependencies as string[]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new ConnectorError("composed_dependency_cycle", "The composed integrity-plan dependencies contain a cycle.");
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

export function validateComposedPlanActions(scopePath: string, rawActions: PlanActionLike[]): PlanActionLike[] {
  const actions = rawActions.map((raw, index) => {
    const id = actionId(raw.actionId, `actions[${index}].actionId`);
    assertWithinScope(scopePath, raw.sourcePath);
    assertWithinScope(scopePath, raw.destinationPath);
    return { ...raw, actionId: id, dependencies: dependencyList(raw.dependencies, id) };
  });
  const ids = new Set<string>();
  for (const action of actions) {
    const id = String(action.actionId);
    if (ids.has(id)) throw new ConnectorError("duplicate_action_id", `Duplicate action ID: ${id}.`);
    ids.add(id);
  }
  for (const action of actions) {
    for (const dependency of action.dependencies as string[]) {
      if (!ids.has(dependency)) throw new ConnectorError("unknown_dependency", `Action ${String(action.actionId)} depends on unknown action ${dependency}.`);
    }
  }
  assertAcyclic(actions);
  return actions;
}

export function assertPreparationFingerprint(definition: { fingerprint: string }, suppliedFingerprint: string): void {
  if (definition.fingerprint !== suppliedFingerprint) {
    throw new ConnectorError("preparation_fingerprint_changed", "The supplied preparation fingerprint does not match the immutable stored definition.");
  }
}

export function composePreparedPlanActions(input: {
  scopePath: string;
  preparedItems: Array<{ role: PreparedRole }>;
  preparedActions: PlanActionLike[];
  additionalActions: PlanActionLike[];
  preparedActionIds: Record<string, string>;
  preparedDependencies: Record<string, string[]>;
}): PlanActionLike[] {
  if (input.preparedItems.length !== input.preparedActions.length) {
    throw new ConnectorError("prepared_action_count_mismatch", "The prepared item and action counts do not match.");
  }

  const knownRoles = new Set(input.preparedItems.map((item) => item.role));
  for (const role of Object.keys(input.preparedActionIds)) {
    if (!knownRoles.has(role as PreparedRole)) throw new ConnectorError("prepared_action_role_unknown", `Unknown prepared action role: ${role}.`);
  }

  const additional = input.additionalActions.map((raw, index) => {
    if (Object.prototype.hasOwnProperty.call(raw, "content")) {
      throw new ConnectorError("caller_payload_forbidden", "Caller-supplied inline payload content is forbidden in additionalActions.");
    }
    if (raw.action !== "RENAME") {
      throw new ConnectorError("caller_payload_action_forbidden", "Only RENAME additionalActions are supported by prepared-payload composition.");
    }
    const id = actionId(raw.actionId, `additionalActions[${index}].actionId`);
    assertWithinScope(input.scopePath, raw.sourcePath);
    assertWithinScope(input.scopePath, raw.destinationPath);
    return { ...raw, actionId: id, dependencies: dependencyList(raw.dependencies, id) };
  });

  const prepared = input.preparedActions.map((raw, index) => {
    const role = input.preparedItems[index].role;
    const id = actionId(input.preparedActionIds[role], `preparedActionIds.${role}`);
    const dependencies = dependencyList(input.preparedDependencies[id], id);
    assertWithinScope(input.scopePath, raw.sourcePath);
    assertWithinScope(input.scopePath, raw.destinationPath);
    return { ...raw, actionId: id, dependencies, operationOrder: additional.length + index };
  });

  const actions = validateComposedPlanActions(input.scopePath, [...additional, ...prepared]);
  for (const key of Object.keys(input.preparedDependencies)) {
    if (!actions.some((action) => action.actionId === key)) {
      throw new ConnectorError("prepared_dependency_target_unknown", `preparedDependencies contains an unknown prepared action ID: ${key}.`);
    }
  }
  return actions;
}
