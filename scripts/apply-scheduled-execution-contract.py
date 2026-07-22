from pathlib import Path
from textwrap import dedent


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


coordination_path = Path("src/integrity-coordination.ts")
c = coordination_path.read_text()
c = replace_once(c,
    'export type IntegrityOwnerType = "manual" | "scheduled_task" | "api" | "recovery" | "internal_job";',
    'export type IntegrityOwnerType = "interactive" | "scheduled_task" | "system_recovery" | "manual" | "api" | "recovery" | "internal_job";',
    "owner type union")
c = replace_once(c,
    "  intendedPostcondition: unknown;\n  state: ReservationState;",
    "  intendedPostcondition: unknown;\n  ownerType: IntegrityOwnerType;\n  ownerId: string;\n  correlationId: string | null;\n  state: ReservationState;",
    "reservation ownership fields")
c = replace_once(c,
    "  ownerType?: IntegrityOwnerType | null;\n  actionId?: string | null;",
    "  ownerType?: IntegrityOwnerType | null;\n  ownerId?: string | null;\n  correlationId?: string | null;\n  actionId?: string | null;",
    "audit ownership fields")
c = replace_once(c,
    'export type CoordinationStorage = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;',
    dedent('''
    export type InvocationRecord = {
      planId: string;
      invocationId: string;
      ownerType: IntegrityOwnerType;
      ownerId: string;
      correlationId: string | null;
      createdAt: string;
      updatedAt: string;
      status: "active" | "completed";
      leaseId?: string | null;
      fencingToken?: number | null;
      outcome?: unknown;
    };

    export type CoordinationStorage = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;
    ''').strip(),
    "invocation record type")
c = replace_once(c,
    'function reservationKey(userId: string, planId: string): string { return stateKey(userId, `integrated:action-reservation:${planId}`); }',
    'function reservationKey(userId: string, planId: string): string { return stateKey(userId, `integrated:action-reservation:${planId}`); }\nfunction invocationKey(userId: string, planId: string, invocationId: string): string { return stateKey(userId, `integrated:execution-invocation:${planId}:${invocationId}`); }',
    "invocation key")
c = replace_once(c,
    "    ownerType: request.ownerType ?? null,\n    actionId: request.actionId ?? request.currentActionId ?? null,",
    "    ownerType: request.ownerType ?? null,\n    ownerId: request.ownerId ?? null,\n    correlationId: request.correlationId ?? null,\n    actionId: request.actionId ?? request.currentActionId ?? null,",
    "audit record ownership")
c = replace_once(c,
    '  const ownerType = request.ownerType ?? "api";\n  const scopePath = normalizeScope(request.scopePath);\n  if (!validId(planId) || !validId(invocationId) || !validId(ownerId)) throw new ConnectorError("lease_input_invalid", "Lease ownership metadata is invalid.");\n  const key = leaseKey(request.userId, planId);',
    dedent('''
      const ownerType = request.ownerType ?? "api";
      const correlationId = request.correlationId == null ? null : String(request.correlationId);
      const allowedOwnerTypes: IntegrityOwnerType[] = ["interactive", "scheduled_task", "system_recovery", "manual", "api", "recovery", "internal_job"];
      const scopePath = normalizeScope(request.scopePath);
      if (!validId(planId) || !validId(invocationId) || !validId(ownerId) || !allowedOwnerTypes.includes(ownerType) || (correlationId !== null && !validId(correlationId))) throw new ConnectorError("lease_input_invalid", "Lease ownership metadata is invalid.");
      const invocationStorageKey = invocationKey(request.userId, planId, invocationId);
      const priorInvocation = await storage.get<InvocationRecord>(invocationStorageKey);
      if (priorInvocation) {
        const sameMetadata = priorInvocation.ownerType === ownerType && priorInvocation.ownerId === ownerId && priorInvocation.correlationId === correlationId;
        if (!sameMetadata) throw new ConnectorError("invocation_metadata_conflict", "The invocation ID was already used with different ownership metadata.");
        if (priorInvocation.status === "completed") {
          return { acquired: false, alreadyExecuting: false, idempotentInvocation: true, invocationId, ownerType, ownerId, correlationId, persistedOutcome: priorInvocation.outcome ?? null, leaseId: priorInvocation.leaseId ?? null, fencingToken: priorInvocation.fencingToken ?? null, safeToRetry: true };
        }
      }
      const key = leaseKey(request.userId, planId);
    ''').rstrip(),
    "acquire validation and invocation lookup")
c = replace_once(c,
    '    if (existing.currentInvocationId === invocationId && existing.ownerId === ownerId) {\n      return { acquired: true, alreadyExecuting: false, idempotentRetry: true, planId, leaseId: existing.leaseId, fencingToken: existing.fencingToken, leaseExpiresAt: existing.expiresAt, recoveredExpiredLease: Boolean(existing.recoveryOfLeaseId), currentActionId: existing.currentActionId };\n    }',
    '    if (existing.currentInvocationId === invocationId && existing.ownerId === ownerId) {\n      return { acquired: false, alreadyExecuting: true, idempotentInvocation: true, invocationActive: true, planId, leaseId: existing.leaseId, fencingToken: existing.fencingToken, leaseExpiresAt: existing.expiresAt, recoveredExpiredLease: Boolean(existing.recoveryOfLeaseId), currentActionId: existing.currentActionId, activeOwnerType: existing.ownerType, activeOwnerId: existing.ownerId, activeInvocationId: existing.currentInvocationId, correlationId: existing.correlationId, retryAfterSeconds: retryAfter(existing, nowMs), safeToRetry: true };\n    }',
    "active duplicate invocation")
c = c.replace("activeOwnerType: other.ownerType, activeSince:", "activeOwnerType: other.ownerType, activeOwnerId: other.ownerId, activeInvocationId: other.currentInvocationId, activeSince:")
c = c.replace("activeOwnerType: existing.ownerType, activeSince:", "activeOwnerType: existing.ownerType, activeOwnerId: existing.ownerId, activeInvocationId: existing.currentInvocationId, activeSince:")
c = replace_once(c,
    "  await storage.put(generationKey(request.userId, planId), generation);\n  await storage.put(key, lease);",
    dedent('''
      const invocationRecord: InvocationRecord = {
        planId,
        invocationId,
        ownerType,
        ownerId,
        correlationId,
        createdAt: priorInvocation?.createdAt ?? iso(nowMs),
        updatedAt: iso(nowMs),
        status: "active",
        leaseId: lease.leaseId,
        fencingToken: generation,
      };
      await storage.put(generationKey(request.userId, planId), generation);
      await storage.put(invocationStorageKey, invocationRecord);
      await storage.put(key, lease);
    ''').rstrip(),
    "persist invocation on acquire")
c = replace_once(c,
    "    intendedPostcondition: request.intendedPostcondition ?? null,\n    state: \"reserved\",",
    "    intendedPostcondition: request.intendedPostcondition ?? null,\n    ownerType: lease.ownerType,\n    ownerId: lease.ownerId,\n    correlationId: lease.correlationId,\n    state: \"reserved\",",
    "persist reservation ownership")
c = replace_once(c,
    '  await appendAudit(storage, { ...request, ownerType: lease.ownerType }, "lease_released", nowMs, request.outcome);\n  await storage.delete(leaseKey(request.userId, lease.planId));',
    dedent('''
      await appendAudit(storage, { ...request, ownerType: lease.ownerType, ownerId: lease.ownerId, correlationId: lease.correlationId }, "lease_released", nowMs, request.outcome);
      const invocationStorageKey = invocationKey(request.userId, lease.planId, lease.currentInvocationId);
      const invocation = await storage.get<InvocationRecord>(invocationStorageKey);
      if (invocation) {
        invocation.status = "completed";
        invocation.updatedAt = iso(nowMs);
        invocation.outcome = boundedAuditDetails(request.outcome ?? null);
        invocation.leaseId = lease.leaseId;
        invocation.fencingToken = lease.fencingToken;
        await storage.put(invocationStorageKey, invocation);
      }
      await storage.delete(leaseKey(request.userId, lease.planId));
    ''').rstrip(),
    "complete invocation on release")
c = replace_once(c,
    "      ownerType: lease.ownerType,\n      acquiredAt: lease.acquiredAt,",
    "      ownerType: lease.ownerType,\n      ownerId: lease.ownerId,\n      invocationId: lease.currentInvocationId,\n      correlationId: lease.correlationId,\n      acquiredAt: lease.acquiredAt,",
    "status active lease ownership")
coordination_path.write_text(c)

lease_path = Path("src/integrity-lease-tools.ts")
s = lease_path.read_text()
s = replace_once(s,
    'const OWNER_TYPES = ["manual", "scheduled_task", "api", "recovery", "internal_job"] as const;',
    'const OWNER_TYPES = ["interactive", "scheduled_task", "system_recovery"] as const;',
    "external owner types")
s = replace_once(s,
    dedent('''
    type ExecutionInput = {
      executionToken: string;
      ownerType?: IntegrityOwnerType;
      ownerId?: string;
      invocationId?: string;
      correlationId?: string;
    };
    ''').strip(),
    dedent('''
    type ExecutionInput = {
      executionToken: string;
      ownerType: IntegrityOwnerType;
      ownerId: string;
      invocationId: string;
      correlationId: string;
    };
    ''').strip(),
    "required execution input")
s = replace_once(s,
    "  invocationId: string;\n  leaseExpiresAt: string;",
    "  invocationId: string;\n  ownerType: IntegrityOwnerType;\n  ownerId: string;\n  correlationId: string;\n  leaseAcquired: true;\n  leaseExpiresAt: string;",
    "lease ownership metadata")
s = replace_once(s,
    dedent('''
    function executionDefaults(input: ExecutionInput): Required<Pick<ExecutionInput, "ownerType" | "ownerId" | "invocationId">> & { correlationId: string | null } {
      const ownerType = input.ownerType ?? "manual";
      return {
        ownerType,
        ownerId: String(input.ownerId ?? `${ownerType}:server-generated`).slice(0, 500),
        invocationId: String(input.invocationId ?? crypto.randomUUID()).slice(0, 500),
        correlationId: input.correlationId ? String(input.correlationId).slice(0, 500) : null,
      };
    }
    ''').strip(),
    dedent('''
    function executionDefaults(input: ExecutionInput): Pick<ExecutionInput, "ownerType" | "ownerId" | "invocationId" | "correlationId"> {
      return { ownerType: input.ownerType, ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId };
    }

    function internalExecutionInput(planId: string, ownerType: IntegrityOwnerType, ownerId: string, invocationId?: string, correlationId?: string): ExecutionInput {
      return { executionToken: "", ownerType, ownerId, invocationId: invocationId ?? crypto.randomUUID(), correlationId: correlationId ?? `${ownerType}:${planId}` };
    }

    function logExecution(event: string, ownership: Pick<ExecutionInput, "ownerType" | "ownerId" | "invocationId" | "correlationId">, details: Record<string, unknown> = {}): void {
      console.log(JSON.stringify({ component: "integrity_plan_executor", event, ...ownership, ...details }));
    }
    ''').strip(),
    "execution ownership normalization")
s = replace_once(s,
    '  if (result.acquired !== true) return { ...result, executionState: "already_executing", leaseAcquired: false, alreadyExecuting: true, completedThisInvocation: [], reconciledThisInvocation: [], failedThisInvocation: [], resumeRequired: true, planComplete: false };',
    '  if (result.acquired !== true) return { ...result, executionState: result.idempotentInvocation === true && result.alreadyExecuting !== true ? "idempotent_completed" : "already_executing", leaseAcquired: false, alreadyExecuting: Boolean(result.alreadyExecuting), ownerType: result.activeOwnerType ?? defaults.ownerType, ownerId: result.activeOwnerId ?? defaults.ownerId, invocationId: result.activeInvocationId ?? defaults.invocationId, correlationId: result.correlationId ?? defaults.correlationId, completedThisInvocation: [], reconciledThisInvocation: [], failedThisInvocation: [], resumeRequired: result.idempotentInvocation === true && result.alreadyExecuting !== true ? false : true, planComplete: false };',
    "safe no-op acquisition result")
s = replace_once(s,
    "    invocationId: defaults.invocationId,\n    leaseExpiresAt: String(result.leaseExpiresAt),",
    "    invocationId: defaults.invocationId,\n    ownerType: defaults.ownerType,\n    ownerId: defaults.ownerId,\n    correlationId: defaults.correlationId,\n    leaseAcquired: true,\n    leaseExpiresAt: String(result.leaseExpiresAt),",
    "acquired ownership result")
s = replace_once(s,
    '  return typeof (value as LeaseMetadata).leaseId === "string" && typeof (value as LeaseMetadata).fencingToken === "number";',
    '  return (value as LeaseMetadata).leaseAcquired === true && typeof (value as LeaseMetadata).leaseId === "string" && typeof (value as LeaseMetadata).fencingToken === "number";',
    "lease discriminator")
s = replace_once(s,
    'async function releaseLease(context: HotfixContext, lease: LeaseMetadata, outcome: unknown): Promise<void> {\n  await callIntegrityCoordination(context.env, context.userId, { op: "release", planId: lease.planId, leaseId: lease.leaseId, fencingToken: lease.fencingToken, invocationId: lease.invocationId, outcome });\n}',
    'async function releaseLease(context: HotfixContext, lease: LeaseMetadata, outcome: unknown): Promise<void> {\n  logExecution("lease_release", lease, { planId: lease.planId, leaseId: lease.leaseId, fencingToken: lease.fencingToken });\n  await callIntegrityCoordination(context.env, context.userId, { op: "release", planId: lease.planId, leaseId: lease.leaseId, fencingToken: lease.fencingToken, invocationId: lease.invocationId, ownerType: lease.ownerType, ownerId: lease.ownerId, correlationId: lease.correlationId, outcome });\n}',
    "release logging and ownership")
s = replace_once(s,
    "  return { leaseAcquired: true, alreadyExecuting: false, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, leaseExpiresAt: acquired.leaseExpiresAt, retryAfterSeconds: 0, safeToRetry: true, recoveredExpiredLease: acquired.recoveredExpiredLease, recoveryMetadata: acquired.recoveryMetadata ?? null };",
    "  return { leaseAcquired: true, alreadyExecuting: false, leaseId: acquired.leaseId, ownerType: acquired.ownerType, ownerId: acquired.ownerId, invocationId: acquired.invocationId, correlationId: acquired.correlationId, fencingToken: acquired.fencingToken, leaseExpiresAt: acquired.leaseExpiresAt, retryAfterSeconds: 0, safeToRetry: true, recoveredExpiredLease: acquired.recoveredExpiredLease, recoveryMetadata: acquired.recoveryMetadata ?? null };",
    "lease response ownership")
s = replace_once(s,
    "  const acquired = await acquireExecutionLease(context, token.planId, input);\n  if (!isLeaseMetadata(acquired)) return acquired;",
    "  logExecution(\"invocation_started\", input, { planId: token.planId });\n  const acquired = await acquireExecutionLease(context, token.planId, input);\n  if (!isLeaseMetadata(acquired)) { logExecution(\"invocation_noop\", input, { planId: token.planId, alreadyExecuting: acquired.alreadyExecuting ?? false, executionState: acquired.executionState ?? null }); return acquired; }",
    "structured invocation logs")
s = replace_once(s,
    'async function reconcileWithLease(context: HotfixContext, input: { planId: string; maximumActions?: number; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {\n  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "internal_job", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });',
    'async function reconcileWithLease(context: HotfixContext, input: { planId: string; maximumActions?: number; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {\n  const acquired = await acquireExecutionLease(context, input.planId, internalExecutionInput(input.planId, "internal_job", input.ownerId ?? "reconcile_integrity_plan", input.invocationId, input.correlationId));',
    "internal reconcile ownership")
s = s.replace('{ executionToken: "", ownerType: "recovery", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId }', 'internalExecutionInput(input.planId, "system_recovery", input.ownerId ?? "integrity_plan_recovery", input.invocationId, input.correlationId)')
s = replace_once(s,
    '  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "internal_job", ownerId: input.ownerId ?? "integrity-lease-acceptance-probe", invocationId: input.invocationId, correlationId: input.correlationId });',
    '  const acquired = await acquireExecutionLease(context, input.planId, internalExecutionInput(input.planId, "internal_job", input.ownerId ?? "integrity-lease-acceptance-probe", input.invocationId, input.correlationId));',
    "probe ownership defaults")
s = replace_once(s,
    "  return {\n    planId,\n    planStatus: plan.status,\n    validationStatus: plan.validationStatus,\n    executionStatus: plan.executionStatus,",
    "  const activeLease = coordination.activeLease as Record<string, unknown> | null;\n  const retryAfterSeconds = activeLease?.expiresAt ? Math.max(0, Math.ceil((Date.parse(String(activeLease.expiresAt)) - Date.now()) / 1_000)) : 0;\n  const executionStateValue = coordination.recoveryRequired ? \"recovery_required\" : coordination.leased ? \"executing\" : String((coordination.reservation as Record<string, unknown> | null)?.state ?? plan.executionStatus ?? plan.status);\n  return {\n    planId,\n    planStatus: plan.status,\n    executionState: executionStateValue,\n    validationStatus: plan.validationStatus,\n    executionStatus: plan.executionStatus,",
    "execution state preamble")
s = replace_once(s,
    "    activeLease: coordination.activeLease ?? null,\n    currentlyLeased: Boolean(coordination.leased),",
    dedent('''
        activeLease: coordination.activeLease ?? null,
        activeLeaseStatus: activeLease?.status ?? "none",
        leaseId: activeLease?.leaseId ?? null,
        ownerType: activeLease?.ownerType ?? null,
        ownerId: activeLease?.ownerId ?? null,
        invocationId: activeLease?.invocationId ?? null,
        correlationId: activeLease?.correlationId ?? null,
        fencingToken: activeLease?.fencingToken ?? null,
        leaseAcquiredAt: activeLease?.acquiredAt ?? null,
        leaseExpiresAt: activeLease?.expiresAt ?? null,
        alreadyExecuting: Boolean(coordination.leased),
        retryAfterSeconds,
        safeToRetry: !coordination.leased,
        safeRetryGuidance: coordination.recoveryRequired ? "Use the normal executor so expired-lease reconciliation can run; do not force-invalidate." : coordination.leased ? "Retry after the reported lease expiry; contention is a successful no-op." : "Validate the plan and execute with a new caller-supplied invocation ID.",
        recoveryRequired: Boolean(coordination.recoveryRequired),
        persistedReservation: coordination.reservation ?? null,
        activeContinuationJobs: diffJob ? [{ jobId: diffJobId, status: diffJob.status, currentStage: diffJob.currentStage }] : [],
        anotherResumeRequired: unresolved.length > 0,
        complete: unresolved.length === 0,
        currentlyLeased: Boolean(coordination.leased),
    ''').rstrip(),
    "expanded execution state")
s = replace_once(s,
    "        ownerType: z.enum(OWNER_TYPES).optional(),\n        ownerId: z.string().min(1).max(500).optional(),\n        invocationId: z.string().min(1).max(500).optional(),\n        correlationId: z.string().min(1).max(500).optional(),",
    "        ownerType: z.enum(OWNER_TYPES),\n        ownerId: z.string().min(1).max(200),\n        invocationId: z.string().uuid(),\n        correlationId: z.string().min(1).max(200),",
    "required MCP execution schema")
s = s.replace("without exposing sensitive owner data.", "including bounded caller-supplied ownership metadata and safe retry guidance.")
lease_path.write_text(s)

test_path = Path("test/integrity-scheduled-execution.test.ts")
test_path.write_text(dedent(r'''
import assert from "node:assert/strict";
import test from "node:test";
import { processIntegrityCoordination, type CoordinationRequest } from "../src/integrity-coordination";
import { registerIntegrityLeaseTools } from "../src/integrity-lease-tools";

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
  assert.ok(registered.has("get_integrity_plan_execution_state"));
  assert.ok(registered.has("get_integrity_plan_status"));
});
''').lstrip())

readme = Path("README.md")
r = readme.read_text()
marker = "## Scheduled integrity execution contract"
if marker not in r:
    r += dedent('''

    ## Scheduled integrity execution contract

    `execute_integrity_plan` requires `executionToken`, `ownerType` (`interactive`, `scheduled_task`, or `system_recovery`), a bounded `ownerId`, a caller-generated UUID `invocationId`, and a bounded `correlationId`. The supplied identifiers are persisted in the lease, invocation record, action reservation, audit records, structured logs, and response. Reusing an invocation ID with identical metadata is idempotent; conflicting reuse fails closed.

    `get_integrity_plan_execution_state` is the canonical read-only state tool. `get_integrity_plan_status` is a compatibility alias backed by the same implementation and response contract.
    ''')
    readme.write_text(r)
