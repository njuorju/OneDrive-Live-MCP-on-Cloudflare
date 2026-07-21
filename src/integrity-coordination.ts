import { ConnectorError } from "./errors";
import type { StableStorage } from "./version20-hotfix";

export const DEFAULT_INTEGRITY_LEASE_SECONDS = 600;
export const MIN_INTEGRITY_LEASE_SECONDS = 60;
export const MAX_INTEGRITY_LEASE_SECONDS = 1_800;
export const MAX_INTEGRITY_AUDIT_RECORDS = 200;
export const JOB_LEASE_SECONDS = 180;
export const AUDIT_GATE_SECONDS = 21_600;
export const INTEGRITY_LEASE_HARDENING_V2 = true;

export type IntegrityOwnerType = "manual" | "scheduled_task" | "api" | "recovery" | "internal_job";
export type IntegrityLeaseStatus = "active" | "recovering";
export type ReservationState = "reserved" | "mutation_in_progress" | "completed" | "reconciled" | "failed" | "ready_for_retry" | "failed_closed" | "manual_review";

export type IntegrityLease = {
  planId: string;
  scopePath?: string;
  leaseId: string;
  ownerId: string;
  ownerType: IntegrityOwnerType;
  acquiredAt: string;
  expiresAt: string;
  lastHeartbeatAt: string;
  lastProgressAt: string;
  progressSequence: number;
  currentActionId: string | null;
  currentInvocationId: string;
  workerVersion: string;
  correlationId: string | null;
  status: IntegrityLeaseStatus;
  fencingToken: number;
  recoveryOfLeaseId?: string | null;
};

export type ActionReservation = {
  planId: string;
  actionId: string;
  invocationId: string;
  leaseId: string;
  fencingToken: number;
  reservedAt: string;
  updatedAt: string;
  attempt: number;
  logicalAttemptGeneration: number;
  idempotencyKey: string;
  expectedPreconditions: unknown;
  intendedPostcondition: unknown;
  state: ReservationState;
  outcome?: unknown;
};

export type AuditRecord = {
  sequence: number;
  at: string;
  event: string;
  planId: string;
  leaseId?: string | null;
  invocationId?: string | null;
  ownerType?: IntegrityOwnerType | null;
  actionId?: string | null;
  fencingToken?: number | null;
  details?: unknown;
};

export type CoordinationStorage = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;

export type CoordinationRequest = {
  op: string;
  userId: string;
  planId?: string;
  scopePath?: string;
  jobId?: string;
  invocationId?: string;
  ownerId?: string;
  ownerType?: IntegrityOwnerType;
  correlationId?: string | null;
  workerVersion?: string;
  leaseDurationSeconds?: number;
  leaseId?: string;
  fencingToken?: number;
  currentActionId?: string | null;
  progressSequence?: number;
  actionId?: string;
  expectedPreconditions?: unknown;
  intendedPostcondition?: unknown;
  reservationState?: ReservationState;
  outcome?: unknown;
  recoveryResolution?: unknown;
  recoveryResult?: string;
  logicalKey?: string;
  value?: unknown;
  force?: boolean;
  auditJobId?: string;
  cursor?: number;
  limit?: number;
  nowMs?: number;
};

function iso(ms: number): string { return new Date(ms).toISOString(); }
function clampLease(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_INTEGRITY_LEASE_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_INTEGRITY_LEASE_SECONDS;
  return Math.min(Math.max(Math.round(parsed), MIN_INTEGRITY_LEASE_SECONDS), MAX_INTEGRITY_LEASE_SECONDS);
}
function validId(value: string | undefined, max = 500): value is string {
  return Boolean(value && value.length <= max && !/[\u0000-\u001f]/.test(value));
}
function stateKey(userId: string, logicalKey: string): string {
  if (!validId(userId, 500) || !logicalKey.startsWith("integrated:") || logicalKey.length > 1_200 || /[\u0000-\u001f]/.test(logicalKey)) {
    throw new ConnectorError("coordination_key_invalid", "The integrity coordination key is invalid.");
  }
  return `integrated-state:${userId}:${logicalKey}`;
}
function leaseKey(userId: string, planId: string): string { return stateKey(userId, `integrated:execution-lease:${planId}`); }
function generationKey(userId: string, planId: string): string { return stateKey(userId, `integrated:execution-generation:${planId}`); }
function reservationKey(userId: string, planId: string): string { return stateKey(userId, `integrated:action-reservation:${planId}`); }
function attemptKey(userId: string, planId: string, actionId: string): string { return stateKey(userId, `integrated:action-attempt:${planId}:${actionId}`); }
function auditKey(userId: string, planId: string): string { return stateKey(userId, `integrated:execution-audit:${planId}`); }
function auditSequenceKey(userId: string, planId: string): string { return stateKey(userId, `integrated:execution-audit-sequence:${planId}`); }
function auditGateKey(userId: string, planId: string): string { return stateKey(userId, `integrated:plan-audit-gate:${planId}`); }
function jobLeaseKey(userId: string, jobId: string): string { return stateKey(userId, `integrated:job-lease:${jobId}`); }
function jobGenerationKey(userId: string, jobId: string): string { return stateKey(userId, `integrated:job-generation:${jobId}`); }
function leasePrefix(userId: string): string { return stateKey(userId, "integrated:execution-lease:"); }
function auditGatePrefix(userId: string): string { return stateKey(userId, "integrated:plan-audit-gate:"); }

type AuditGate = { planId: string; scopePath: string; jobId: string; startedAt: string; expiresAt: string };

function normalizeScope(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
}
function scopeContains(parent: string, child: string): boolean {
  return parent === "" || child === parent || child.startsWith(`${parent}/`);
}
function scopesOverlap(left: string, right: string): boolean {
  return scopeContains(left, right) || scopeContains(right, left);
}
function boundedAuditDetails(details: unknown): unknown {
  if (details === undefined) return undefined;
  try {
    const serialized = JSON.stringify(details);
    if (serialized.length <= 8_000) return details;
    return { truncated: true, characterCount: serialized.length, preview: serialized.slice(0, 2_000) };
  } catch {
    return { truncated: true, reason: "not_serializable" };
  }
}
async function getActiveAuditGate(storage: CoordinationStorage, userId: string, planId: string, nowMs: number): Promise<AuditGate | undefined> {
  const key = auditGateKey(userId, planId);
  const gate = await storage.get<AuditGate>(key);
  if (!gate) return undefined;
  if (Date.parse(gate.expiresAt) > nowMs) return gate;
  await storage.delete(key);
  return undefined;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function appendAudit(storage: CoordinationStorage, request: CoordinationRequest, event: string, nowMs: number, details?: unknown): Promise<void> {
  const userId = String(request.userId ?? "");
  const planId = String(request.planId ?? "");
  const seqKey = auditSequenceKey(userId, planId);
  const key = auditKey(userId, planId);
  const sequence = Number(await storage.get<number>(seqKey) ?? 0) + 1;
  const records = await storage.get<AuditRecord[]>(key) ?? [];
  const record: AuditRecord = {
    sequence,
    at: iso(nowMs),
    event,
    planId,
    leaseId: request.leaseId ?? null,
    invocationId: request.invocationId ?? null,
    ownerType: request.ownerType ?? null,
    actionId: request.actionId ?? request.currentActionId ?? null,
    fencingToken: request.fencingToken ?? null,
    details: boundedAuditDetails(details),
  };
  await storage.put(seqKey, sequence);
  await storage.put(key, [...records, record].slice(-MAX_INTEGRITY_AUDIT_RECORDS));
}

function retryAfter(lease: IntegrityLease | undefined, nowMs: number): number {
  if (!lease) return 0;
  return Math.max(1, Math.ceil((Date.parse(lease.expiresAt) - nowMs) / 1_000));
}

async function assertLease(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<IntegrityLease> {
  const planId = String(request.planId ?? "");
  const lease = await storage.get<IntegrityLease>(leaseKey(request.userId, planId));
  if (!lease || lease.status !== "active" || lease.leaseId !== request.leaseId || lease.fencingToken !== Number(request.fencingToken) || lease.currentInvocationId !== request.invocationId) {
    throw new ConnectorError("stale_fencing_token", "The integrity executor no longer owns the plan.", { retryable: true });
  }
  if (Date.parse(lease.expiresAt) <= nowMs) {
    throw new ConnectorError("lease_expired", "The integrity execution lease expired before the state commit.", { retryable: true });
  }
  return lease;
}

async function acquire(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const planId = String(request.planId ?? "");
  const invocationId = String(request.invocationId ?? "");
  const ownerId = String(request.ownerId ?? "");
  const ownerType = request.ownerType ?? "api";
  const scopePath = normalizeScope(request.scopePath);
  if (!validId(planId) || !validId(invocationId) || !validId(ownerId)) throw new ConnectorError("lease_input_invalid", "Lease ownership metadata is invalid.");
  const key = leaseKey(request.userId, planId);
  const existing = await storage.get<IntegrityLease>(key);

  const gates = await storage.list<AuditGate>({ prefix: auditGatePrefix(request.userId) });
  for (const [gateKey, gate] of gates) {
    if (Date.parse(gate.expiresAt) <= nowMs) { await storage.delete(gateKey); continue; }
    if (scopesOverlap(scopePath, normalizeScope(gate.scopePath))) {
      return { acquired: false, alreadyExecuting: true, planId, activeOwnerType: "internal_job", activeSince: gate.startedAt, leaseExpiresAt: gate.expiresAt, currentActionId: null, retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(gate.expiresAt) - nowMs) / 1_000)), safeToRetry: true, resumeRequired: true, auditInProgress: true, auditJobId: gate.jobId };
    }
  }

  const leases = await storage.list<IntegrityLease>({ prefix: leasePrefix(request.userId) });
  for (const [, other] of leases) {
    if (other.planId === planId || Date.parse(other.expiresAt) <= nowMs) continue;
    if (scopesOverlap(scopePath, normalizeScope(other.scopePath))) {
      await appendAudit(storage, request, "lease_denied_scope_overlap", nowMs, { activeOwnerType: other.ownerType, activePlanId: other.planId, activeScopePath: other.scopePath ?? null });
      return { acquired: false, alreadyExecuting: true, planId, activeOwnerType: other.ownerType, activeSince: other.acquiredAt, leaseExpiresAt: other.expiresAt, currentActionId: other.currentActionId, retryAfterSeconds: retryAfter(other, nowMs), safeToRetry: true, resumeRequired: true, overlapProtected: true };
    }
  }

  if (existing && existing.status === "active" && Date.parse(existing.expiresAt) > nowMs) {
    if (existing.currentInvocationId === invocationId && existing.ownerId === ownerId) {
      return { acquired: true, alreadyExecuting: false, idempotentRetry: true, planId, leaseId: existing.leaseId, fencingToken: existing.fencingToken, leaseExpiresAt: existing.expiresAt, recoveredExpiredLease: Boolean(existing.recoveryOfLeaseId), currentActionId: existing.currentActionId };
    }
    await appendAudit(storage, { ...request, leaseId: existing.leaseId, fencingToken: existing.fencingToken, currentActionId: existing.currentActionId }, "lease_denied", nowMs, { activeOwnerType: existing.ownerType });
    return { acquired: false, alreadyExecuting: true, planId, activeOwnerType: existing.ownerType, activeSince: existing.acquiredAt, leaseExpiresAt: existing.expiresAt, currentActionId: existing.currentActionId, retryAfterSeconds: retryAfter(existing, nowMs), safeToRetry: true, resumeRequired: true };
  }
  if (existing) {
    const recoveringByCaller = existing.status === "recovering" && existing.currentInvocationId === invocationId && existing.ownerId === ownerId;
    if (existing.status === "recovering" && Date.parse(existing.expiresAt) > nowMs && !recoveringByCaller) {
      return { acquired: false, alreadyExecuting: true, recoveryInProgress: true, planId, activeOwnerType: "recovery", activeSince: existing.acquiredAt, leaseExpiresAt: existing.expiresAt, currentActionId: existing.currentActionId, retryAfterSeconds: retryAfter(existing, nowMs), safeToRetry: true, resumeRequired: true };
    }
    if (!request.recoveryResolution) {
      const recovering: IntegrityLease = {
        ...existing,
        ownerId,
        ownerType: "recovery",
        currentInvocationId: invocationId,
        correlationId: request.correlationId ?? null,
        workerVersion: String(request.workerVersion ?? "unknown"),
        status: "recovering",
        lastHeartbeatAt: iso(nowMs),
        expiresAt: iso(nowMs + 120_000),
      };
      await storage.put(key, recovering);
      await appendAudit(storage, { ...request, leaseId: existing.leaseId, fencingToken: existing.fencingToken, currentActionId: existing.currentActionId }, "lease_expired_recovery_started", nowMs);
      return { acquired: false, alreadyExecuting: false, recoveryRequired: true, recoveredExpiredLease: true, planId, previousLeaseId: existing.leaseId, previousOwnerType: existing.ownerType, previousActionId: existing.currentActionId, previousFencingToken: existing.fencingToken, recoveryClaimExpiresAt: recovering.expiresAt };
    }
    if (!recoveringByCaller) throw new ConnectorError("recovery_claim_lost", "The expired lease recovery claim is no longer owned by this invocation.", { retryable: true });
    const resolution = request.recoveryResolution as Record<string, unknown>;
    const reservation = await storage.get<ActionReservation>(reservationKey(request.userId, planId));
    if (reservation?.leaseId === existing.leaseId) {
      const resolutionState = String(resolution?.reconciliationResult ?? "manual_review");
      const allowed: ReservationState = ["completed", "ready_for_retry", "failed_closed", "manual_review"].includes(resolutionState) ? resolutionState as ReservationState : "manual_review";
      reservation.state = allowed;
      reservation.updatedAt = iso(nowMs);
      reservation.outcome = { recoveryResolution: boundedAuditDetails(resolution) };
      await storage.put(reservationKey(request.userId, planId), reservation);
    }
    await appendAudit(storage, { ...request, leaseId: existing.leaseId, fencingToken: existing.fencingToken, currentActionId: existing.currentActionId }, "lease_recovered", nowMs, resolution);
  }
  const previousLeaseId = existing?.leaseId ?? null;
  const generation = Number(await storage.get<number>(generationKey(request.userId, planId)) ?? 0) + 1;
  const duration = clampLease(request.leaseDurationSeconds);
  const lease: IntegrityLease = {
    planId,
    scopePath,
    leaseId: crypto.randomUUID(),
    ownerId,
    ownerType,
    acquiredAt: iso(nowMs),
    expiresAt: iso(nowMs + duration * 1_000),
    lastHeartbeatAt: iso(nowMs),
    lastProgressAt: iso(nowMs),
    progressSequence: 0,
    currentActionId: null,
    currentInvocationId: invocationId,
    workerVersion: String(request.workerVersion ?? "unknown").slice(0, 200),
    correlationId: request.correlationId ? String(request.correlationId).slice(0, 500) : null,
    status: "active",
    fencingToken: generation,
    recoveryOfLeaseId: previousLeaseId,
  };
  await storage.put(generationKey(request.userId, planId), generation);
  await storage.put(key, lease);
  await appendAudit(storage, { ...request, leaseId: lease.leaseId, fencingToken: generation }, "lease_acquired", nowMs, { recoveredExpiredLease: Boolean(previousLeaseId), scopePath });
  return { acquired: true, alreadyExecuting: false, planId, leaseId: lease.leaseId, fencingToken: generation, leaseExpiresAt: lease.expiresAt, recoveredExpiredLease: Boolean(previousLeaseId), previousLeaseId, newLeaseId: lease.leaseId, newFencingToken: generation };
}

async function renew(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const lease = await assertLease(storage, request, nowMs);
  const nextProgress = Number(request.progressSequence ?? lease.progressSequence);
  const progressed = nextProgress > lease.progressSequence || request.currentActionId !== lease.currentActionId;
  if (!progressed && nowMs - Date.parse(lease.lastProgressAt) > MAX_INTEGRITY_LEASE_SECONDS * 1_000) {
    throw new ConnectorError("lease_progress_stalled", "The lease cannot be renewed indefinitely without active progress.");
  }
  const duration = clampLease(request.leaseDurationSeconds);
  lease.lastHeartbeatAt = iso(nowMs);
  lease.expiresAt = iso(nowMs + duration * 1_000);
  lease.currentActionId = request.currentActionId ?? lease.currentActionId;
  if (progressed) {
    lease.progressSequence = nextProgress;
    lease.lastProgressAt = iso(nowMs);
  }
  await storage.put(leaseKey(request.userId, lease.planId), lease);
  await appendAudit(storage, { ...request, ownerType: lease.ownerType }, "lease_renewed", nowMs, { progressed });
  return { renewed: true, leaseId: lease.leaseId, fencingToken: lease.fencingToken, leaseExpiresAt: lease.expiresAt, lastHeartbeatAt: lease.lastHeartbeatAt };
}

async function reserve(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const lease = await assertLease(storage, request, nowMs);
  const actionId = String(request.actionId ?? "");
  if (!validId(actionId, 200)) throw new ConnectorError("action_id_invalid", "The action reservation ID is invalid.");
  const key = reservationKey(request.userId, lease.planId);
  const existing = await storage.get<ActionReservation>(key);
  if (existing && !["completed", "reconciled", "failed", "ready_for_retry", "failed_closed", "manual_review"].includes(existing.state)) {
    if (existing.leaseId === lease.leaseId && existing.invocationId === lease.currentInvocationId && existing.actionId === actionId) return { reserved: true, idempotentRetry: true, reservation: existing };
    throw new ConnectorError("action_already_reserved", "The plan already has an active action reservation.", { retryable: true });
  }
  const attemptsKey = attemptKey(request.userId, lease.planId, actionId);
  const attempt = Number(await storage.get<number>(attemptsKey) ?? 0) + 1;
  const reservation: ActionReservation = {
    planId: lease.planId,
    actionId,
    invocationId: lease.currentInvocationId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    reservedAt: iso(nowMs),
    updatedAt: iso(nowMs),
    attempt,
    logicalAttemptGeneration: attempt,
    idempotencyKey: await sha256(`${lease.planId}:${actionId}:${attempt}`),
    expectedPreconditions: request.expectedPreconditions ?? null,
    intendedPostcondition: request.intendedPostcondition ?? null,
    state: "reserved",
  };
  lease.currentActionId = actionId;
  lease.progressSequence += 1;
  lease.lastProgressAt = iso(nowMs);
  await storage.put(attemptsKey, attempt);
  await storage.put(key, reservation);
  await storage.put(leaseKey(request.userId, lease.planId), lease);
  await appendAudit(storage, { ...request, ownerType: lease.ownerType }, "action_reserved", nowMs, { attempt, idempotencyKey: reservation.idempotencyKey });
  return { reserved: true, reservation };
}

async function markMutationStarted(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const lease = await assertLease(storage, request, nowMs);
  const key = reservationKey(request.userId, lease.planId);
  const reservation = await storage.get<ActionReservation>(key);
  if (!reservation || reservation.leaseId !== lease.leaseId || reservation.fencingToken !== lease.fencingToken || reservation.actionId !== request.actionId) throw new ConnectorError("reservation_not_owned", "The action reservation is not owned by this lease.");
  reservation.state = "mutation_in_progress";
  reservation.updatedAt = iso(nowMs);
  lease.lastHeartbeatAt = iso(nowMs);
  lease.expiresAt = iso(nowMs + clampLease(request.leaseDurationSeconds) * 1_000);
  await storage.put(key, reservation);
  await storage.put(leaseKey(request.userId, lease.planId), lease);
  await appendAudit(storage, { ...request, ownerType: lease.ownerType }, "mutation_attempt_started", nowMs, { idempotencyKey: reservation.idempotencyKey });
  return { started: true, reservation, leaseExpiresAt: lease.expiresAt };
}

async function finalizeAction(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const lease = await assertLease(storage, request, nowMs);
  const state = request.reservationState;
  if (!state || !["completed", "reconciled", "failed", "ready_for_retry", "failed_closed", "manual_review"].includes(state)) throw new ConnectorError("reservation_state_invalid", "The action outcome state is invalid.");
  const key = reservationKey(request.userId, lease.planId);
  const reservation = await storage.get<ActionReservation>(key);
  if (!reservation || reservation.leaseId !== lease.leaseId || reservation.fencingToken !== lease.fencingToken) throw new ConnectorError("reservation_not_owned", "The action reservation is not owned by this lease.");
  reservation.state = state;
  reservation.outcome = request.outcome ?? null;
  reservation.updatedAt = iso(nowMs);
  lease.currentActionId = null;
  lease.progressSequence += 1;
  lease.lastProgressAt = iso(nowMs);
  await storage.put(key, reservation);
  await storage.put(leaseKey(request.userId, lease.planId), lease);
  await appendAudit(storage, { ...request, actionId: reservation.actionId, ownerType: lease.ownerType }, state === "reconciled" ? "reconciliation_result" : "action_finalized", nowMs, request.outcome);
  return { finalized: true, reservation };
}

async function release(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const lease = await assertLease(storage, request, nowMs);
  const reservation = await storage.get<ActionReservation>(reservationKey(request.userId, lease.planId));
  if (reservation?.leaseId === lease.leaseId && reservation.state === "mutation_in_progress") throw new ConnectorError("mutation_commit_in_progress", "The lease cannot be released while its mutation result remains unresolved.");
  await appendAudit(storage, { ...request, ownerType: lease.ownerType }, "lease_released", nowMs, request.outcome);
  await storage.delete(leaseKey(request.userId, lease.planId));
  return { released: true, planId: lease.planId, leaseId: lease.leaseId, fencingToken: lease.fencingToken };
}

async function status(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const planId = String(request.planId ?? "");
  const lease = await storage.get<IntegrityLease>(leaseKey(request.userId, planId));
  const reservation = await storage.get<ActionReservation>(reservationKey(request.userId, planId));
  const gate = await getActiveAuditGate(storage, request.userId, planId, nowMs);
  const expired = Boolean(lease && Date.parse(lease.expiresAt) <= nowMs);
  return {
    planId,
    leased: Boolean(lease && !expired),
    leaseExpired: expired,
    recoveryRequired: Boolean(lease && expired) || lease?.status === "recovering",
    activeLease: lease ? {
      leaseId: lease.leaseId,
      ownerType: lease.ownerType,
      acquiredAt: lease.acquiredAt,
      lastHeartbeatAt: lease.lastHeartbeatAt,
      expiresAt: lease.expiresAt,
      currentActionId: lease.currentActionId,
      fencingToken: lease.fencingToken,
      status: lease.status,
      workerVersion: lease.workerVersion,
    } : null,
    reservation: reservation ?? null,
    auditInProgress: Boolean(gate),
    activeAuditJobId: gate?.jobId ?? null,
    auditGateExpiresAt: gate?.expiresAt ?? null,
  };
}

async function claimForceRecovery(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  if (request.force !== true) throw new ConnectorError("force_required", "Forced recovery requires the explicit guarded force parameter.");
  const planId = String(request.planId ?? "");
  const lease = await storage.get<IntegrityLease>(leaseKey(request.userId, planId));
  if (!lease || Date.parse(lease.expiresAt) <= nowMs) return { claimed: false, reason: "lease_not_active" };
  const reservation = await storage.get<ActionReservation>(reservationKey(request.userId, planId));
  if (reservation?.leaseId === lease.leaseId && reservation.state === "mutation_in_progress") return { claimed: false, reason: "mutation_commit_in_progress", activeLease: lease, reservation };
  if (lease.currentActionId && (!reservation || reservation.leaseId !== lease.leaseId)) return { claimed: false, reason: "unverifiable_current_action", activeLease: lease };
  const previousOwnerType = lease.ownerType;
  const previousInvocationId = lease.currentInvocationId;
  if (reservation?.leaseId === lease.leaseId && reservation.state === "reserved") {
    reservation.state = "ready_for_retry";
    reservation.updatedAt = iso(nowMs);
    reservation.outcome = { forcedRecoveryClaimedBeforeMutation: true };
    await storage.put(reservationKey(request.userId, planId), reservation);
  }
  lease.ownerId = String(request.ownerId ?? "recovery");
  lease.ownerType = "recovery";
  lease.currentInvocationId = String(request.invocationId ?? "");
  lease.correlationId = request.correlationId ?? null;
  lease.workerVersion = String(request.workerVersion ?? lease.workerVersion);
  lease.status = "recovering";
  lease.lastHeartbeatAt = iso(nowMs);
  lease.expiresAt = iso(nowMs + 120_000);
  await storage.put(leaseKey(request.userId, planId), lease);
  await appendAudit(storage, { ...request, leaseId: lease.leaseId, fencingToken: lease.fencingToken, currentActionId: lease.currentActionId, ownerType: "recovery" }, "lease_force_recovery_claimed", nowMs, { previousOwnerType, previousInvocationId });
  return { claimed: true, planId, leaseId: lease.leaseId, fencingToken: lease.fencingToken, recoveryClaimExpiresAt: lease.expiresAt, previousOwnerType, previousActionId: lease.currentActionId };
}

async function forceInvalidate(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  if (request.force !== true) throw new ConnectorError("force_required", "Forced invalidation requires the explicit guarded force parameter.");
  const planId = String(request.planId ?? "");
  const lease = await storage.get<IntegrityLease>(leaseKey(request.userId, planId));
  if (!lease) return { invalidated: false, reason: "no_active_lease" };
  if (lease.status !== "recovering" || lease.currentInvocationId !== request.invocationId || lease.ownerId !== request.ownerId) return { invalidated: false, reason: "force_recovery_claim_not_owned" };
  const reservation = await storage.get<ActionReservation>(reservationKey(request.userId, planId));
  if (reservation?.leaseId === lease.leaseId && reservation.state === "mutation_in_progress") return { invalidated: false, reason: "mutation_commit_in_progress", activeLease: lease, reservation };
  const generation = Math.max(Number(await storage.get<number>(generationKey(request.userId, planId)) ?? 0), lease.fencingToken) + 1;
  await storage.put(generationKey(request.userId, planId), generation);
  await appendAudit(storage, { ...request, leaseId: lease.leaseId, fencingToken: lease.fencingToken, currentActionId: lease.currentActionId, ownerType: lease.ownerType }, "lease_force_invalidated", nowMs, request.outcome);
  await storage.delete(leaseKey(request.userId, planId));
  return { invalidated: true, previousLeaseId: lease.leaseId, previousFencingToken: lease.fencingToken, newFencingToken: generation };
}

async function fencedPut(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  await assertLease(storage, request, nowMs);
  const logicalKey = String(request.logicalKey ?? "");
  await storage.put(stateKey(request.userId, logicalKey), request.value);
  return { stored: true };
}
async function fencedDelete(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  await assertLease(storage, request, nowMs);
  const logicalKey = String(request.logicalKey ?? "");
  const deleted = await storage.delete(stateKey(request.userId, logicalKey));
  return { deleted: Boolean(deleted) };
}

async function beginPlanAudit(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const planId = String(request.planId ?? "");
  const scopePath = normalizeScope(request.scopePath);
  const leases = await storage.list<IntegrityLease>({ prefix: leasePrefix(request.userId) });
  for (const [, lease] of leases) {
    if (Date.parse(lease.expiresAt) <= nowMs) continue;
    if (scopesOverlap(scopePath, normalizeScope(lease.scopePath))) return { acquired: false, alreadyExecuting: true, activeOwnerType: lease.ownerType, activeSince: lease.acquiredAt, leaseExpiresAt: lease.expiresAt, currentActionId: lease.currentActionId, retryAfterSeconds: retryAfter(lease, nowMs), safeToRetry: true, overlapProtected: true };
  }
  const key = auditGateKey(request.userId, planId);
  const existing = await getActiveAuditGate(storage, request.userId, planId, nowMs);
  if (existing) return { acquired: true, idempotentRetry: true, auditJobId: existing.jobId, startedAt: existing.startedAt, expiresAt: existing.expiresAt };
  const gate: AuditGate = { planId, scopePath, jobId: String(request.auditJobId ?? "pending"), startedAt: iso(nowMs), expiresAt: iso(nowMs + AUDIT_GATE_SECONDS * 1_000) };
  await storage.put(key, gate);
  await appendAudit(storage, request, "plan_audit_started", nowMs, gate);
  return { acquired: true, auditJobId: gate.jobId, startedAt: gate.startedAt, expiresAt: gate.expiresAt };
}
async function updatePlanAudit(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const key = auditGateKey(request.userId, String(request.planId ?? ""));
  const gate = await storage.get<AuditGate>(key);
  if (!gate || Date.parse(gate.expiresAt) <= nowMs) { if (gate) await storage.delete(key); return { updated: false }; }
  gate.jobId = String(request.auditJobId ?? gate.jobId);
  gate.expiresAt = iso(nowMs + AUDIT_GATE_SECONDS * 1_000);
  await storage.put(key, gate);
  return { updated: true, gate };
}
async function endPlanAudit(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const key = auditGateKey(request.userId, String(request.planId ?? ""));
  const gate = await storage.get<AuditGate>(key);
  if (!gate) return { released: false, reason: "no_active_audit_gate" };
  if (request.auditJobId && gate.jobId !== "pending" && gate.jobId !== request.auditJobId) return { released: false, reason: "stale_audit_continuation", activeAuditJobId: gate.jobId };
  await storage.delete(key);
  await appendAudit(storage, request, "plan_audit_finished", nowMs, request.outcome);
  return { released: true };
}

async function jobAcquire(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const jobId = String(request.jobId ?? "");
  const invocationId = String(request.invocationId ?? "");
  if (!validId(jobId) || !validId(invocationId)) throw new ConnectorError("job_lease_input_invalid", "The job lease metadata is invalid.");
  const key = jobLeaseKey(request.userId, jobId);
  const existing = await storage.get<IntegrityLease>(key);
  if (existing && Date.parse(existing.expiresAt) > nowMs) {
    if (existing.currentInvocationId === invocationId && existing.ownerId === String(request.ownerId ?? "internal-job")) return { acquired: true, idempotentRetry: true, leaseId: existing.leaseId, fencingToken: existing.fencingToken, leaseExpiresAt: existing.expiresAt };
    return { acquired: false, alreadyExecuting: true, activeSince: existing.acquiredAt, leaseExpiresAt: existing.expiresAt, retryAfterSeconds: retryAfter(existing, nowMs), safeToRetry: true };
  }
  const generation = Number(await storage.get<number>(jobGenerationKey(request.userId, jobId)) ?? 0) + 1;
  const lease: IntegrityLease = {
    planId: jobId,
    leaseId: crypto.randomUUID(),
    ownerId: String(request.ownerId ?? "internal-job"),
    ownerType: request.ownerType ?? "internal_job",
    acquiredAt: iso(nowMs),
    expiresAt: iso(nowMs + JOB_LEASE_SECONDS * 1_000),
    lastHeartbeatAt: iso(nowMs),
    lastProgressAt: iso(nowMs),
    progressSequence: 0,
    currentActionId: null,
    currentInvocationId: invocationId,
    workerVersion: String(request.workerVersion ?? "unknown"),
    correlationId: request.correlationId ?? null,
    status: "active",
    fencingToken: generation,
  };
  await storage.put(jobGenerationKey(request.userId, jobId), generation);
  await storage.put(key, lease);
  return { acquired: true, leaseId: lease.leaseId, fencingToken: generation, leaseExpiresAt: lease.expiresAt };
}
async function assertJobLease(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<IntegrityLease> {
  const lease = await storage.get<IntegrityLease>(jobLeaseKey(request.userId, String(request.jobId ?? "")));
  if (!lease || lease.leaseId !== request.leaseId || lease.fencingToken !== Number(request.fencingToken) || lease.currentInvocationId !== request.invocationId || Date.parse(lease.expiresAt) <= nowMs) throw new ConnectorError("stale_job_fencing_token", "The resumable job continuation no longer owns its cursor.", { retryable: true });
  return lease;
}
async function jobFencedPut(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  await assertJobLease(storage, request, nowMs);
  await storage.put(stateKey(request.userId, String(request.logicalKey ?? "")), request.value);
  return { stored: true };
}
async function jobFencedDelete(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  await assertJobLease(storage, request, nowMs);
  const deleted = await storage.delete(stateKey(request.userId, String(request.logicalKey ?? "")));
  return { deleted: Boolean(deleted) };
}
async function jobRelease(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
  const lease = await assertJobLease(storage, request, nowMs);
  await storage.delete(jobLeaseKey(request.userId, String(request.jobId ?? "")));
  return { released: true, leaseId: lease.leaseId, fencingToken: lease.fencingToken };
}

export async function processIntegrityCoordination(storage: CoordinationStorage, request: CoordinationRequest, suppliedNowMs?: number): Promise<Record<string, unknown>> {
  const nowMs = suppliedNowMs ?? (Number.isFinite(request.nowMs) ? Number(request.nowMs) : Date.now());
  switch (request.op) {
    case "acquire": return acquire(storage, request, nowMs);
    case "renew": return renew(storage, request, nowMs);
    case "reserve": return reserve(storage, request, nowMs);
    case "mark-mutation-started": return markMutationStarted(storage, request, nowMs);
    case "finalize-action": return finalizeAction(storage, request, nowMs);
    case "release": return release(storage, request, nowMs);
    case "status": return status(storage, request, nowMs);
    case "claim-force-recovery": return claimForceRecovery(storage, request, nowMs);
    case "force-invalidate": return forceInvalidate(storage, request, nowMs);
    case "fenced-put": return fencedPut(storage, request, nowMs);
    case "fenced-delete": return fencedDelete(storage, request, nowMs);
    case "begin-plan-audit": return beginPlanAudit(storage, request, nowMs);
    case "update-plan-audit": return updatePlanAudit(storage, request, nowMs);
    case "end-plan-audit": return endPlanAudit(storage, request, nowMs);
    case "job-acquire": return jobAcquire(storage, request, nowMs);
    case "job-fenced-put": return jobFencedPut(storage, request, nowMs);
    case "job-fenced-delete": return jobFencedDelete(storage, request, nowMs);
    case "job-release": return jobRelease(storage, request, nowMs);
    case "audit-page": {
      const records = await storage.get<AuditRecord[]>(auditKey(request.userId, String(request.planId ?? ""))) ?? [];
      const cursor = Math.max(0, Math.floor(Number(request.cursor ?? 0)));
      const limit = Math.min(50, Math.max(1, Math.floor(Number(request.limit ?? 25))));
      const newestFirst = [...records].sort((left, right) => right.sequence - left.sequence);
      const page = newestFirst.slice(cursor, cursor + limit);
      return { records: page, cursor, nextCursor: cursor + page.length < newestFirst.length ? cursor + page.length : null, totalRetained: newestFirst.length, bounded: true, maximumRecords: MAX_INTEGRITY_AUDIT_RECORDS };
    }
    default: throw new ConnectorError("coordination_operation_invalid", "The integrity coordination operation is invalid.");
  }
}

export async function callIntegrityCoordination(env: Env, userId: string, request: Omit<CoordinationRequest, "userId">): Promise<Record<string, unknown>> {
  const id = env.AUTH_STATE.idFromName("global");
  const response = await env.AUTH_STATE.get(id).fetch("https://auth-state/integrity-coordinate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, userId }),
  });
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !result?.ok) throw new ConnectorError(String(result?.code ?? "coordination_failed"), String(result?.message ?? "Integrity coordination failed."), { retryable: response.status >= 500 });
  return result.result as Record<string, unknown>;
}

export type LeaseReference = { planId: string; leaseId: string; fencingToken: number; invocationId: string };
export type JobLeaseReference = { jobId: string; leaseId: string; fencingToken: number; invocationId: string };

export function createLeaseFencedStorage(base: StableStorage, env: Env, userId: string, lease: LeaseReference): StableStorage {
  const guarded = (key: string): boolean => key.startsWith(`integrated:plan:${lease.planId}`) || key.startsWith(`integrated:operation:${lease.planId}:`) || key.startsWith(`integrated:reconciliation:${lease.planId}:`) || key.startsWith("integrated:lock:");
  return {
    get: base.get.bind(base),
    list: base.list.bind(base),
    async put<T>(key: string, value: T): Promise<void> {
      if (!guarded(key)) return base.put(key, value);
      await callIntegrityCoordination(env, userId, { op: "fenced-put", ...lease, logicalKey: key, value });
    },
    async delete(key: string): Promise<boolean> {
      if (!guarded(key)) return base.delete(key);
      const result = await callIntegrityCoordination(env, userId, { op: "fenced-delete", ...lease, logicalKey: key });
      return Boolean(result.deleted);
    },
  };
}

export function createJobFencedStorage(base: StableStorage, env: Env, userId: string, lease: JobLeaseReference): StableStorage {
  return {
    get: base.get.bind(base),
    list: base.list.bind(base),
    async put<T>(key: string, value: T): Promise<void> { await callIntegrityCoordination(env, userId, { op: "job-fenced-put", ...lease, logicalKey: key, value }); },
    async delete(key: string): Promise<boolean> {
      const result = await callIntegrityCoordination(env, userId, { op: "job-fenced-delete", ...lease, logicalKey: key });
      return Boolean(result.deleted);
    },
  };
}
