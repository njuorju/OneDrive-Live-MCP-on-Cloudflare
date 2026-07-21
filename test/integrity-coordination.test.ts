import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_INTEGRITY_AUDIT_RECORDS,
  processIntegrityCoordination,
  type CoordinationRequest,
} from "../src/integrity-coordination";

class MemoryTransaction {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const prefix = options.prefix ?? "";
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
  }
}

class TransactionHarness {
  readonly storage = new MemoryTransaction();
  private tail: Promise<unknown> = Promise.resolve();
  run(request: CoordinationRequest, nowMs = Date.parse("2026-07-21T12:00:00Z")): Promise<Record<string, unknown>> {
    const next = this.tail.then(() => processIntegrityCoordination(this.storage as any, request, nowMs));
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const base = { userId: "user", planId: "72d309d6-aac4-47a5-8f83-fe9364b282bc", ownerId: "owner", workerVersion: "test" } as const;
function acquire(invocationId: string, ownerType: "manual" | "scheduled_task" = "manual"): CoordinationRequest {
  return { op: "acquire", ...base, invocationId, ownerType, leaseDurationSeconds: 600 };
}

async function owned(h: TransactionHarness, invocationId = "inv-1") {
  const result = await h.run(acquire(invocationId));
  return { planId: base.planId, userId: base.userId, invocationId, leaseId: String(result.leaseId), fencingToken: Number(result.fencingToken) };
}

test("two simultaneous plan acquisitions grant exactly one lease", async () => {
  const h = new TransactionHarness();
  const [manual, scheduled] = await Promise.all([h.run(acquire("manual-1", "manual")), h.run({ ...acquire("schedule-1", "scheduled_task"), ownerId: "schedule" })]);
  assert.equal([manual, scheduled].filter((result) => result.acquired === true).length, 1);
  assert.equal([manual, scheduled].filter((result) => result.alreadyExecuting === true).length, 1);
});

test("a scheduled collision performs no ownership takeover", async () => {
  const h = new TransactionHarness();
  const first = await h.run(acquire("manual-1"));
  const second = await h.run({ ...acquire("schedule-1", "scheduled_task"), ownerId: "schedule" });
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.alreadyExecuting, true);
  assert.equal(second.activeOwnerType, "manual");
});

test("manual execution collides safely with a scheduled owner", async () => {
  const h = new TransactionHarness();
  await h.run({ ...acquire("schedule-1", "scheduled_task"), ownerId: "schedule" });
  const manual = await h.run(acquire("manual-1"));
  assert.equal(manual.alreadyExecuting, true);
  assert.equal(manual.activeOwnerType, "scheduled_task");
});

test("same invocation retries acquisition idempotently", async () => {
  const h = new TransactionHarness();
  const first = await h.run(acquire("same"));
  const second = await h.run(acquire("same"));
  assert.equal(second.acquired, true);
  assert.equal(second.idempotentRetry, true);
  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.fencingToken, first.fencingToken);
});

test("different invocation cannot reuse another owner's lease", async () => {
  const h = new TransactionHarness();
  const first = await h.run(acquire("one"));
  const second = await h.run({ ...acquire("two"), leaseId: String(first.leaseId), fencingToken: Number(first.fencingToken) });
  assert.equal(second.acquired, false);
  assert.equal(second.alreadyExecuting, true);
});

test("lease renewal succeeds only for the current owner", async () => {
  const h = new TransactionHarness();
  const lease = await owned(h);
  const renewed = await h.run({ op: "renew", ...lease, currentActionId: "A1", progressSequence: 1, leaseDurationSeconds: 600 });
  assert.equal(renewed.renewed, true);
  await assert.rejects(() => h.run({ op: "renew", ...lease, invocationId: "intruder", progressSequence: 2 }));
});

test("expired lease enters recovery and grants a higher fencing token after durable resolution", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  const first = await h.run({ ...acquire("old"), leaseDurationSeconds: 60 }, start);
  const recovery = await h.run({ ...acquire("new"), ownerId: "new-owner" }, start + 61_000);
  assert.equal(recovery.recoveryRequired, true);
  const recovered = await h.run({ ...acquire("new"), ownerId: "new-owner", recoveryResolution: { reconciliationResult: "completed" } }, start + 62_000);
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.recoveredExpiredLease, true);
  assert.ok(Number(recovered.fencingToken) > Number(first.fencingToken));
});

test("recovery metadata can record a mutation completed before crash", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  await h.run({ ...acquire("old"), leaseDurationSeconds: 60 }, start);
  await h.run({ ...acquire("new"), ownerId: "new-owner" }, start + 61_000);
  const recovered = await h.run({ ...acquire("new"), ownerId: "new-owner", recoveryResolution: { previousActionId: "A1", reconciliationResult: "completed" } }, start + 62_000);
  assert.equal(recovered.recoveredExpiredLease, true);
});

test("recovery metadata can safely return a proven unissued action to ready", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  await h.run({ ...acquire("old"), leaseDurationSeconds: 60 }, start);
  await h.run({ ...acquire("new"), ownerId: "new-owner" }, start + 61_000);
  const recovered = await h.run({ ...acquire("new"), ownerId: "new-owner", recoveryResolution: { previousActionId: "A1", reconciliationResult: "ready_for_retry" } }, start + 62_000);
  assert.equal(recovered.acquired, true);
});

test("ambiguous in-flight mutation cannot be force-invalidated", async () => {
  const h = new TransactionHarness();
  const lease = await owned(h);
  await h.run({ op: "reserve", ...lease, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  await h.run({ op: "mark-mutation-started", ...lease, actionId: "A1", leaseDurationSeconds: 600 });
  const claim = await h.run({ op: "claim-force-recovery", ...base, invocationId: "recovery", ownerId: "recovery", force: true });
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, "mutation_commit_in_progress");
});

test("fencing token prevents a stale executor state commit", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  const first = await h.run({ ...acquire("old"), leaseDurationSeconds: 60 }, start);
  await h.run({ ...acquire("new"), ownerId: "new-owner" }, start + 61_000);
  const second = await h.run({ ...acquire("new"), ownerId: "new-owner", recoveryResolution: { reconciliationResult: "ready_for_retry" } }, start + 62_000);
  await assert.rejects(() => h.run({ op: "fenced-put", ...base, invocationId: "old", leaseId: String(first.leaseId), fencingToken: Number(first.fencingToken), logicalKey: `integrated:plan:${base.planId}`, value: { stale: true } }, start + 63_000));
  const current = await h.run({ op: "fenced-put", ...base, invocationId: "new", leaseId: String(second.leaseId), fencingToken: Number(second.fencingToken), logicalKey: `integrated:plan:${base.planId}`, value: { current: true } }, start + 63_000);
  assert.equal(current.stored, true);
});

test("stale release cannot clear a newer lease", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  const first = await h.run({ ...acquire("old"), leaseDurationSeconds: 60 }, start);
  await h.run({ ...acquire("new"), ownerId: "new-owner" }, start + 61_000);
  await h.run({ ...acquire("new"), ownerId: "new-owner", recoveryResolution: { reconciliationResult: "ready_for_retry" } }, start + 62_000);
  await assert.rejects(() => h.run({ op: "release", ...base, invocationId: "old", leaseId: String(first.leaseId), fencingToken: Number(first.fencingToken) }, start + 63_000));
  const status = await h.run({ op: "status", userId: base.userId, planId: base.planId }, start + 63_000);
  assert.equal(status.leased, true);
});

test("an action cannot be reserved twice by competing invocation", async () => {
  const h = new TransactionHarness();
  const lease = await owned(h);
  const first = await h.run({ op: "reserve", ...lease, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  const retry = await h.run({ op: "reserve", ...lease, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  assert.equal(first.reserved, true);
  assert.equal(retry.idempotentRetry, true);
  await assert.rejects(() => h.run({ op: "reserve", ...lease, actionId: "A2", expectedPreconditions: {}, intendedPostcondition: {} }));
});

test("client disconnect followed by expiry permits safe recovery", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  await h.run({ ...acquire("disconnected"), leaseDurationSeconds: 60 }, start);
  const recovery = await h.run({ ...acquire("resumer"), ownerId: "resumer" }, start + 61_000);
  assert.equal(recovery.recoveryRequired, true);
});

test("idempotency key remains stable for the same reservation retry", async () => {
  const h = new TransactionHarness();
  const lease = await owned(h);
  const first = await h.run({ op: "reserve", ...lease, actionId: "A1", expectedPreconditions: { etag: "1" }, intendedPostcondition: { path: "x" } });
  const retry = await h.run({ op: "reserve", ...lease, actionId: "A1", expectedPreconditions: { etag: "1" }, intendedPostcondition: { path: "x" } });
  assert.equal((first.reservation as any).idempotencyKey, (retry.reservation as any).idempotencyKey);
});

test("read-only status works while a mutation lease is active", async () => {
  const h = new TransactionHarness();
  const lease = await owned(h);
  await h.run({ op: "reserve", ...lease, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  const status = await h.run({ op: "status", userId: base.userId, planId: base.planId });
  assert.equal(status.leased, true);
  assert.equal((status.activeLease as any).currentActionId, "A1");
});

test("final audit gate refuses to start while mutation lease is active", async () => {
  const h = new TransactionHarness();
  await owned(h);
  const audit = await h.run({ op: "begin-plan-audit", userId: base.userId, planId: base.planId, auditJobId: "job-1" });
  assert.equal(audit.acquired, false);
  assert.equal(audit.alreadyExecuting, true);
});

test("duplicate final-diff continuation acquires only one job cursor lease", async () => {
  const h = new TransactionHarness();
  const [one, two] = await Promise.all([
    h.run({ op: "job-acquire", userId: base.userId, jobId: "job-1", invocationId: "one", ownerId: "one", ownerType: "internal_job" }),
    h.run({ op: "job-acquire", userId: base.userId, jobId: "job-1", invocationId: "two", ownerId: "two", ownerType: "internal_job" }),
  ]);
  assert.equal([one, two].filter((result) => result.acquired === true).length, 1);
  assert.equal([one, two].filter((result) => result.alreadyExecuting === true).length, 1);
});

test("job fencing prevents a stale cursor from overwriting newer state", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  const first = await h.run({ op: "job-acquire", userId: base.userId, jobId: "job-1", invocationId: "one", ownerId: "one", ownerType: "internal_job" }, start);
  const second = await h.run({ op: "job-acquire", userId: base.userId, jobId: "job-1", invocationId: "two", ownerId: "two", ownerType: "internal_job" }, start + 181_000);
  await assert.rejects(() => h.run({ op: "job-fenced-put", userId: base.userId, jobId: "job-1", invocationId: "one", leaseId: String(first.leaseId), fencingToken: Number(first.fencingToken), logicalKey: "integrated:job:job-1", value: { cursor: 1 } }, start + 182_000));
  const current = await h.run({ op: "job-fenced-put", userId: base.userId, jobId: "job-1", invocationId: "two", leaseId: String(second.leaseId), fencingToken: Number(second.fencingToken), logicalKey: "integrated:job:job-1", value: { cursor: 2 } }, start + 182_000);
  assert.equal(current.stored, true);
});

test("audit history remains bounded", async () => {
  const h = new TransactionHarness();
  await h.run(acquire("owner"));
  for (let index = 0; index < MAX_INTEGRITY_AUDIT_RECORDS + 25; index += 1) await h.run({ ...acquire(`denied-${index}`), ownerId: `denied-${index}` });
  const page = await h.run({ op: "audit-page", userId: base.userId, planId: base.planId, limit: 50 });
  assert.equal((page.records as unknown[]).length, 50);
  assert.equal(page.totalRetained, MAX_INTEGRITY_AUDIT_RECORDS);
  assert.equal(page.bounded, true);
});


test("overlapping plan scopes are denied atomically", async () => {
  const h = new TransactionHarness();
  const first = await h.run({ ...acquire("one"), scopePath: "UCA/Modules" });
  const second = await h.run({ ...acquire("two"), planId: "11111111-1111-4111-8111-111111111111", ownerId: "two", scopePath: "UCA/Modules/03_Source_Library" });
  assert.equal(first.acquired, true);
  assert.equal(second.alreadyExecuting, true);
  assert.equal(second.overlapProtected, true);
});

test("non-overlapping plan scopes may lease independently", async () => {
  const h = new TransactionHarness();
  const first = await h.run({ ...acquire("one"), scopePath: "UCA/Modules" });
  const second = await h.run({ ...acquire("two"), planId: "11111111-1111-4111-8111-111111111111", ownerId: "two", scopePath: "Transport" });
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true);
});

test("expired recovery durably resolves the old reservation before granting a new fence", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  const lease = await h.run({ ...acquire("old"), scopePath: "Fixture", leaseDurationSeconds: 60 }, start);
  const ref = { userId: base.userId, planId: base.planId, invocationId: "old", leaseId: String(lease.leaseId), fencingToken: Number(lease.fencingToken) };
  await h.run({ op: "reserve", ...ref, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} }, start + 1_000);
  await h.run({ op: "mark-mutation-started", ...ref, actionId: "A1", leaseDurationSeconds: 60 }, start + 2_000);
  await h.run({ ...acquire("new"), ownerId: "new", scopePath: "Fixture" }, start + 63_000);
  await h.run({ ...acquire("new"), ownerId: "new", scopePath: "Fixture", recoveryResolution: { reconciliationResult: "ready_for_retry" } }, start + 64_000);
  const status = await h.run({ op: "status", userId: base.userId, planId: base.planId }, start + 65_000);
  assert.equal((status.reservation as any).state, "ready_for_retry");
});

test("forced recovery first fences the active owner and refuses in-progress mutation", async () => {
  const h = new TransactionHarness();
  const lease = await owned(h);
  const claim = await h.run({ op: "claim-force-recovery", ...base, invocationId: "recovery", ownerId: "recovery", force: true });
  assert.equal(claim.claimed, true);
  await assert.rejects(() => h.run({ op: "fenced-put", ...lease, logicalKey: `integrated:plan:${base.planId}`, value: { stale: true } }));
  const invalidated = await h.run({ op: "force-invalidate", ...base, invocationId: "recovery", ownerId: "recovery", force: true, outcome: { reconciled: true } });
  assert.equal(invalidated.invalidated, true);
});

test("stale audit gates expire and no longer block execution", async () => {
  const h = new TransactionHarness();
  const start = Date.parse("2026-07-21T12:00:00Z");
  await h.run({ op: "begin-plan-audit", userId: base.userId, planId: base.planId, scopePath: "Fixture", auditJobId: "job-1" }, start);
  const blocked = await h.run({ ...acquire("blocked"), scopePath: "Fixture" }, start + 1_000);
  assert.equal(blocked.alreadyExecuting, true);
  const acquired = await h.run({ ...acquire("later"), scopePath: "Fixture" }, start + 21_601_000);
  assert.equal(acquired.acquired, true);
});

test("execution audit is paginated newest first", async () => {
  const h = new TransactionHarness();
  await h.run({ ...acquire("owner"), scopePath: "Fixture" });
  for (let index = 0; index < 8; index += 1) await h.run({ ...acquire(`denied-page-${index}`), ownerId: `denied-page-${index}`, scopePath: "Fixture" });
  const first = await h.run({ op: "audit-page", userId: base.userId, planId: base.planId, cursor: 0, limit: 3 });
  const second = await h.run({ op: "audit-page", userId: base.userId, planId: base.planId, cursor: first.nextCursor as number, limit: 3 });
  assert.equal((first.records as any[]).length, 3);
  assert.equal((second.records as any[]).length, 3);
  assert.ok((first.records as any[])[0].sequence > (first.records as any[])[1].sequence);
});


test("a released pre-mutation reservation can be reserved by a newer lease", async () => {
  const h = new TransactionHarness();
  const first = await owned(h, "first");
  await h.run({ op: "reserve", ...first, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  await h.run({ op: "finalize-action", ...first, actionId: "A1", reservationState: "ready_for_retry", outcome: { probe: true } });
  await h.run({ op: "release", ...first });
  const secondResult = await h.run({ ...acquire("second"), ownerId: "second" });
  const second = { userId: base.userId, planId: base.planId, invocationId: "second", leaseId: String(secondResult.leaseId), fencingToken: Number(secondResult.fencingToken) };
  const reservation = await h.run({ op: "reserve", ...second, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  assert.equal(reservation.reserved, true);
  assert.equal((reservation.reservation as any).attempt, 2);
});
