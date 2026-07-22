import assert from "node:assert/strict";
import test from "node:test";
import { processIntegrityCoordination, type CoordinationRequest } from "../src/integrity-coordination";
import { registerIntegrityLeaseTools } from "../src/integrity-lease-tools";

// Non-mutating fixture for caller ownership, idempotency, contention, and generated MCP schema acceptance.
class MemoryTransaction {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> { const prefix = options.prefix ?? ""; return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; }
}

const now = Date.parse("2026-07-22T01:00:00Z");
const base: CoordinationRequest = { op: "acquire", userId: "user", planId: "11111111-1111-4111-8111-111111111111", scopePath: "fixture", ownerType: "scheduled_task", ownerId: "uca-source-library-hourly", invocationId: "22222222-2222-4222-8222-222222222222", correlationId: "scheduled-20260722T010000Z", workerVersion: "test", leaseDurationSeconds: 600 };

test("scheduled ownership metadata persists through lease reservation status and audit", async () => {
  const storage = new MemoryTransaction();
  const acquired = await processIntegrityCoordination(storage as any, base, now);
  const lease = { userId: "user", planId: base.planId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken), invocationId: base.invocationId };
  const reserved = await processIntegrityCoordination(storage as any, { op: "reserve", ...lease, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} }, now + 1);
  const reservation = reserved.reservation as any;
  assert.equal(reservation.ownerType, "scheduled_task");
  assert.equal(reservation.ownerId, "uca-source-library-hourly");
  assert.equal(reservation.correlationId, "scheduled-20260722T010000Z");
  const status = await processIntegrityCoordination(storage as any, { op: "status", userId: "user", planId: base.planId }, now + 2);
  assert.equal((status.activeLease as any).invocationId, base.invocationId);
  assert.equal((status.activeLease as any).ownerId, base.ownerId);
  const audit = await processIntegrityCoordination(storage as any, { op: "audit-page", userId: "user", planId: base.planId }, now + 3);
  assert.ok((audit.records as any[]).some((record) => record.correlationId === base.correlationId));
});

test("completed invocation is idempotent and conflicting reuse is rejected", async () => {
  const storage = new MemoryTransaction();
  const acquired = await processIntegrityCoordination(storage as any, base, now);
  const lease = { userId: "user", planId: base.planId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken), invocationId: base.invocationId };
  await processIntegrityCoordination(storage as any, { op: "release", ...lease, ownerType: base.ownerType, ownerId: base.ownerId, correlationId: base.correlationId, outcome: { executionState: "yielded", completedThisInvocation: ["A1"] } }, now + 1);
  const retry = await processIntegrityCoordination(storage as any, base, now + 2);
  assert.equal(retry.idempotentInvocation, true);
  assert.deepEqual(retry.persistedOutcome, { executionState: "yielded", completedThisInvocation: ["A1"] });
  await assert.rejects(() => processIntegrityCoordination(storage as any, { ...base, ownerId: "different-owner" }, now + 3), /different ownership metadata/);
});

test("overlapping scheduled invocations return one owner and one safe no-op", async () => {
  const storage = new MemoryTransaction();
  const first = await processIntegrityCoordination(storage as any, base, now);
  const second = await processIntegrityCoordination(storage as any, { ...base, invocationId: "33333333-3333-4333-8333-333333333333", correlationId: "scheduled-overlap" }, now + 1);
  assert.equal(first.acquired, true);
  assert.equal(second.alreadyExecuting, true);
  assert.equal(second.activeOwnerType, "scheduled_task");
  assert.equal(second.activeOwnerId, "uca-source-library-hourly");
  assert.equal(second.activeInvocationId, base.invocationId);
  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.fencingToken, first.fencingToken);
  assert.equal(second.correlationId, base.correlationId);
});

test("MCP schema requires complete scheduled ownership metadata and exposes canonical execution state", () => {
  const registered = new Map<string, any>();
  const server: any = { _registeredTools: {}, sendToolListChanged() {}, registerTool(name: string, config: any, handler: any) { registered.set(name, { config, handler }); this._registeredTools[name] = { config, handler }; } };
  registerIntegrityLeaseTools(server, () => ({} as any), async () => undefined);
  const execute = registered.get("execute_integrity_plan").config.inputSchema;
  assert.equal(execute.ownerType.safeParse(undefined).success, false);
  assert.equal(execute.ownerType.safeParse("scheduled_task").success, true);
  assert.equal(execute.ownerType.safeParse("manual").success, false);
  assert.equal(execute.ownerId.safeParse(undefined).success, false);
  assert.equal(execute.invocationId.safeParse("not-a-uuid").success, false);
  assert.equal(execute.invocationId.safeParse("44444444-4444-4444-8444-444444444444").success, true);
  assert.equal(execute.correlationId.safeParse(undefined).success, false);
  assert.equal(execute.ownerId.safeParse("x".repeat(201)).success, false);
  assert.equal(execute.correlationId.safeParse("x".repeat(201)).success, false);
  assert.ok(registered.has("get_integrity_plan_execution_state"));
  assert.ok(registered.has("get_integrity_plan_status"));
});
