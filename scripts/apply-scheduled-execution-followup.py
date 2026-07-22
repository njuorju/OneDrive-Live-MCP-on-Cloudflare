from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


coordination_path = Path("src/integrity-coordination.ts")
c = coordination_path.read_text()
c = replace_once(c,
    'return { acquired: false, alreadyExecuting: true, planId, activeOwnerType: other.ownerType, activeOwnerId: other.ownerId, activeInvocationId: other.currentInvocationId, activeSince: other.acquiredAt, leaseExpiresAt: other.expiresAt, currentActionId: other.currentActionId, retryAfterSeconds: retryAfter(other, nowMs), safeToRetry: true, resumeRequired: true, overlapProtected: true };',
    'return { acquired: false, alreadyExecuting: true, planId, leaseId: other.leaseId, fencingToken: other.fencingToken, correlationId: other.correlationId, activeOwnerType: other.ownerType, activeOwnerId: other.ownerId, activeInvocationId: other.currentInvocationId, activeSince: other.acquiredAt, leaseExpiresAt: other.expiresAt, currentActionId: other.currentActionId, retryAfterSeconds: retryAfter(other, nowMs), safeToRetry: true, resumeRequired: true, overlapProtected: true };',
    "scope-overlap contention metadata")
c = replace_once(c,
    'return { acquired: false, alreadyExecuting: true, planId, activeOwnerType: existing.ownerType, activeOwnerId: existing.ownerId, activeInvocationId: existing.currentInvocationId, activeSince: existing.acquiredAt, leaseExpiresAt: existing.expiresAt, currentActionId: existing.currentActionId, retryAfterSeconds: retryAfter(existing, nowMs), safeToRetry: true, resumeRequired: true };',
    'return { acquired: false, alreadyExecuting: true, planId, leaseId: existing.leaseId, fencingToken: existing.fencingToken, correlationId: existing.correlationId, activeOwnerType: existing.ownerType, activeOwnerId: existing.ownerId, activeInvocationId: existing.currentInvocationId, activeSince: existing.acquiredAt, leaseExpiresAt: existing.expiresAt, currentActionId: existing.currentActionId, retryAfterSeconds: retryAfter(existing, nowMs), safeToRetry: true, resumeRequired: true };',
    "same-plan contention metadata")
c = replace_once(c,
    'return { acquired: false, alreadyExecuting: true, recoveryInProgress: true, planId, activeOwnerType: "recovery", activeSince: existing.acquiredAt, leaseExpiresAt: existing.expiresAt, currentActionId: existing.currentActionId, retryAfterSeconds: retryAfter(existing, nowMs), safeToRetry: true, resumeRequired: true };',
    'return { acquired: false, alreadyExecuting: true, recoveryInProgress: true, planId, leaseId: existing.leaseId, fencingToken: existing.fencingToken, correlationId: existing.correlationId, activeOwnerType: existing.ownerType, activeOwnerId: existing.ownerId, activeInvocationId: existing.currentInvocationId, activeSince: existing.acquiredAt, leaseExpiresAt: existing.expiresAt, currentActionId: existing.currentActionId, retryAfterSeconds: retryAfter(existing, nowMs), safeToRetry: true, resumeRequired: true };',
    "recovery contention metadata")
c = replace_once(c, 'ownerType: "recovery",\n        currentInvocationId: invocationId,', 'ownerType,\n        currentInvocationId: invocationId,', "normal recovery owner type")
c = replace_once(c,
    'return { acquired: true, alreadyExecuting: false, planId, leaseId: lease.leaseId, fencingToken: generation, leaseExpiresAt: lease.expiresAt, recoveredExpiredLease: Boolean(previousLeaseId), previousLeaseId, newLeaseId: lease.leaseId, newFencingToken: generation };',
    'return { acquired: true, alreadyExecuting: false, planId, leaseId: lease.leaseId, ownerType: lease.ownerType, ownerId: lease.ownerId, invocationId: lease.currentInvocationId, correlationId: lease.correlationId, fencingToken: generation, leaseExpiresAt: lease.expiresAt, recoveredExpiredLease: Boolean(previousLeaseId), previousLeaseId, newLeaseId: lease.leaseId, newFencingToken: generation };',
    "acquired response ownership")
for old, new, label in [
    ('{ ...request, ownerType: lease.ownerType }, "lease_renewed"', '{ ...request, ownerType: lease.ownerType, ownerId: lease.ownerId, correlationId: lease.correlationId }, "lease_renewed"', "renew audit ownership"),
    ('{ ...request, ownerType: lease.ownerType }, "action_reserved"', '{ ...request, ownerType: lease.ownerType, ownerId: lease.ownerId, correlationId: lease.correlationId }, "action_reserved"', "reservation audit ownership"),
    ('{ ...request, ownerType: lease.ownerType }, "mutation_attempt_started"', '{ ...request, ownerType: lease.ownerType, ownerId: lease.ownerId, correlationId: lease.correlationId }, "mutation_attempt_started"', "mutation audit ownership"),
    ('{ ...request, actionId: reservation.actionId, ownerType: lease.ownerType }, state === "reconciled"', '{ ...request, actionId: reservation.actionId, ownerType: lease.ownerType, ownerId: lease.ownerId, correlationId: lease.correlationId }, state === "reconciled"', "finalize audit ownership"),
]:
    c = replace_once(c, old, new, label)
c = replace_once(c, 'lease.ownerType = "recovery";', 'lease.ownerType = request.ownerType ?? "system_recovery";', "forced recovery owner type")
c = replace_once(c,
    'await appendAudit(storage, { ...request, leaseId: lease.leaseId, fencingToken: lease.fencingToken, currentActionId: lease.currentActionId, ownerType: "recovery" }, "lease_force_recovery_claimed"',
    'await appendAudit(storage, { ...request, leaseId: lease.leaseId, fencingToken: lease.fencingToken, currentActionId: lease.currentActionId, ownerType: lease.ownerType, ownerId: lease.ownerId, correlationId: lease.correlationId }, "lease_force_recovery_claimed"',
    "forced recovery audit ownership")
c = replace_once(c,
    'await appendAudit(storage, { ...request, leaseId: lease.leaseId, fencingToken: lease.fencingToken, currentActionId: lease.currentActionId, ownerType: lease.ownerType }, "lease_force_invalidated"',
    'await appendAudit(storage, { ...request, leaseId: lease.leaseId, fencingToken: lease.fencingToken, currentActionId: lease.currentActionId, ownerType: lease.ownerType, ownerId: lease.ownerId, correlationId: lease.correlationId }, "lease_force_invalidated"',
    "force invalidation audit ownership")
coordination_path.write_text(c)

lease_path = Path("src/integrity-lease-tools.ts")
s = lease_path.read_text()
s = replace_once(s,
    'return { remainingActions: unresolved.length, nextAction: plan.nextAction ?? ready[0]?.actionId ?? unresolved[0]?.actionId ?? null, nextReadyAction: ready[0]?.actionId ?? null, resumeRequired: unresolved.length > 0, auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running", planComplete: unresolved.length === 0 };',
    'return { remainingActions: unresolved.length, nextAction: plan.nextAction ?? ready[0]?.actionId ?? unresolved[0]?.actionId ?? null, nextReadyAction: ready[0]?.actionId ?? null, resumeRequired: unresolved.length > 0, auditStatus: plan.auditStatus ?? "not_requested", auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running", planComplete: unresolved.length === 0 };',
    "execution response audit status")
lease_path.write_text(s)

test_path = Path("test/integrity-scheduled-execution.test.ts")
t = test_path.read_text()
t = replace_once(t,
    '  assert.equal(second.activeInvocationId, base.invocationId);\n});',
    '  assert.equal(second.activeInvocationId, base.invocationId);\n  assert.equal(second.leaseId, first.leaseId);\n  assert.equal(second.fencingToken, first.fencingToken);\n  assert.equal(second.correlationId, base.correlationId);\n});',
    "overlap response assertions")
t = replace_once(t,
    '  assert.equal(execute.correlationId.safeParse(undefined).success, false);\n  assert.ok(registered.has("get_integrity_plan_execution_state"));',
    '  assert.equal(execute.correlationId.safeParse(undefined).success, false);\n  assert.equal(execute.ownerId.safeParse("x".repeat(201)).success, false);\n  assert.equal(execute.correlationId.safeParse("x".repeat(201)).success, false);\n  assert.ok(registered.has("get_integrity_plan_execution_state"));',
    "bounded schema assertions")
test_path.write_text(t)
