import test from "node:test";
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
