import fs from "node:fs";

function read(path) { return fs.readFileSync(path, "utf8"); }
function write(path, text) { fs.writeFileSync(path, text); }
function replaceOnce(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`Missing ${label}: ${from.slice(0, 100)}`);
  return text.replace(from, to);
}
function replaceSection(text, start, end, replacement, label) {
  if (text.includes(replacement.trim())) return text;
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing section ${label}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

// The initial wiring is already committed. This pass hardens concurrency,
// recovery, scope overlap, audit expiry/pagination, job-child fencing, and
// adds a no-Graph administrative lease probe for production acceptance.
let coordination = read("src/integrity-coordination.ts");
if (!coordination.includes("INTEGRITY_LEASE_HARDENING_V2")) {
  coordination = replaceOnce(
    coordination,
    "export const JOB_LEASE_SECONDS = 180;",
    "export const JOB_LEASE_SECONDS = 180;\nexport const AUDIT_GATE_SECONDS = 21_600;\nexport const INTEGRITY_LEASE_HARDENING_V2 = true;",
    "coordination constants",
  );
  coordination = replaceOnce(
    coordination,
    "  planId: string;\n  leaseId: string;",
    "  planId: string;\n  scopePath?: string;\n  leaseId: string;",
    "lease scope",
  );
  coordination = replaceOnce(
    coordination,
    "  planId?: string;\n  jobId?: string;",
    "  planId?: string;\n  scopePath?: string;\n  jobId?: string;",
    "request scope",
  );
  coordination = replaceOnce(
    coordination,
    "  auditJobId?: string;\n  nowMs?: number;",
    "  auditJobId?: string;\n  cursor?: number;\n  limit?: number;\n  nowMs?: number;",
    "audit pagination request",
  );
  coordination = replaceOnce(
    coordination,
    "function jobGenerationKey(userId: string, jobId: string): string { return stateKey(userId, `integrated:job-generation:${jobId}`); }\n",
    `function jobGenerationKey(userId: string, jobId: string): string { return stateKey(userId, \`integrated:job-generation:\${jobId}\`); }
function leasePrefix(userId: string): string { return stateKey(userId, "integrated:execution-lease:"); }
function auditGatePrefix(userId: string): string { return stateKey(userId, "integrated:plan-audit-gate:"); }

type AuditGate = { planId: string; scopePath: string; jobId: string; startedAt: string; expiresAt: string };

function normalizeScope(value: unknown): string {
  return String(value ?? "").replace(/\\\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
}
function scopeContains(parent: string, child: string): boolean {
  return parent === "" || child === parent || child.startsWith(\`\${parent}/\`);
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
`,
    "coordination helpers",
  );
  coordination = replaceOnce(
    coordination,
    "    details,\n  };",
    "    details: boundedAuditDetails(details),\n  };",
    "bounded audit details",
  );

  coordination = replaceSection(
    coordination,
    "async function acquire(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {",
    "async function renew(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {",
    `async function acquire(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
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

`,
    "acquire hardening",
  );

  coordination = replaceSection(
    coordination,
    "async function status(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {",
    "async function fencedPut(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {",
    `async function status(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
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

`,
    "status and force recovery",
  );

  coordination = replaceSection(
    coordination,
    "async function beginPlanAudit(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {",
    "async function jobAcquire(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {",
    `async function beginPlanAudit(storage: CoordinationStorage, request: CoordinationRequest, nowMs: number): Promise<Record<string, unknown>> {
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

`,
    "audit gate hardening",
  );

  coordination = replaceOnce(
    coordination,
    "    case \"status\": return status(storage, request, nowMs);\n    case \"force-invalidate\": return forceInvalidate(storage, request, nowMs);",
    "    case \"status\": return status(storage, request, nowMs);\n    case \"claim-force-recovery\": return claimForceRecovery(storage, request, nowMs);\n    case \"force-invalidate\": return forceInvalidate(storage, request, nowMs);",
    "force recovery switch",
  );
  coordination = replaceOnce(
    coordination,
    `    case "audit-page": {
      const records = await storage.get<AuditRecord[]>(auditKey(request.userId, String(request.planId ?? ""))) ?? [];
      return { records: records.slice(-MAX_INTEGRITY_AUDIT_RECORDS), bounded: true, maximumRecords: MAX_INTEGRITY_AUDIT_RECORDS };
    }`,
    `    case "audit-page": {
      const records = await storage.get<AuditRecord[]>(auditKey(request.userId, String(request.planId ?? ""))) ?? [];
      const cursor = Math.max(0, Math.floor(Number(request.cursor ?? 0)));
      const limit = Math.min(50, Math.max(1, Math.floor(Number(request.limit ?? 25))));
      const newestFirst = [...records].sort((left, right) => right.sequence - left.sequence);
      const page = newestFirst.slice(cursor, cursor + limit);
      return { records: page, cursor, nextCursor: cursor + page.length < newestFirst.length ? cursor + page.length : null, totalRetained: newestFirst.length, bounded: true, maximumRecords: MAX_INTEGRITY_AUDIT_RECORDS };
    }`,
    "audit pagination",
  );
  coordination = replaceOnce(
    coordination,
    "    if (existing.currentInvocationId === invocationId) return { acquired: true, idempotentRetry: true, leaseId: existing.leaseId, fencingToken: existing.fencingToken, leaseExpiresAt: existing.expiresAt };",
    "    if (existing.currentInvocationId === invocationId && existing.ownerId === String(request.ownerId ?? \"internal-job\")) return { acquired: true, idempotentRetry: true, leaseId: existing.leaseId, fencingToken: existing.fencingToken, leaseExpiresAt: existing.expiresAt };",
    "job idempotent ownership",
  );
  write("src/integrity-coordination.ts", coordination);
}

let repair = read("src/integrity-resume-repair.ts");
if (!repair.includes("SnapshotStatusReader")) {
  repair = replaceOnce(
    repair,
    "export async function getIntegrityJobStatus(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<JobRecord> {\n  const job = await getJob(context.storage, jobId);\n  if (job.type !== \"integrity_diff\") return getSnapshotJobStatus(context, schedule, jobId);",
    "export type SnapshotStatusReader = (jobId: string) => Promise<JobRecord>;\n\nexport async function getIntegrityJobStatus(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string, snapshotStatus?: SnapshotStatusReader): Promise<JobRecord> {\n  const job = await getJob(context.storage, jobId);\n  const readSnapshotStatus: SnapshotStatusReader = snapshotStatus ?? ((childJobId) => getSnapshotJobStatus(context, schedule, childJobId));\n  if (job.type !== \"integrity_diff\") return readSnapshotStatus(jobId);",
    "coordinated snapshot reader",
  );
  repair = replaceOnce(
    repair,
    "  const child = await getSnapshotJobStatus(context, schedule, childJobId);",
    "  const child = await readSnapshotStatus(childJobId);",
    "child snapshot reader",
  );
  repair = replaceOnce(
    repair,
    `  if (existingJobId) {
    const existing = await getIntegrityJobStatus(context, schedule, existingJobId);
    return existing.status === "completed" ? (existing.resultReferences.result as Record<string, unknown>) : { jobId: existing.jobId, status: existing.status, progress: existing.progress, currentStage: existing.currentStage, resumable: true };
  }`,
    `  if (existingJobId) {
    const existing = await getJob(context.storage, existingJobId);
    return existing.status === "completed" ? (existing.resultReferences.result as Record<string, unknown>) : { jobId: existing.jobId, status: existing.status, progress: existing.progress, currentStage: existing.currentStage, resumable: true };
  }`,
    "non-advancing existing diff",
  );
  write("src/integrity-resume-repair.ts", repair);
}

let tools = read("src/integrity-lease-tools.ts");
if (!tools.includes("INTEGRITY_LEASE_TOOLS_HARDENING_V2")) {
  tools = replaceOnce(
    tools,
    'import type { IntegrityPlan, PlanAction } from "./integrated-tools";',
    'import type { IntegrityPlan, JobRecord, PlanAction } from "./integrated-tools";',
    "JobRecord import",
  );
  tools = replaceOnce(
    tools,
    'import { continueSourceSnapshotJob } from "./source-snapshot-repair";',
    'import { continueSourceSnapshotJob } from "./source-snapshot-repair";\nimport { resolveRelativeItem, verifyItemInsideRoot } from "./graph-core";',
    "recovery graph imports",
  );
  tools = replaceOnce(
    tools,
    'const OWNER_TYPES = ["manual", "scheduled_task", "api", "recovery", "internal_job"] as const;',
    'const OWNER_TYPES = ["manual", "scheduled_task", "api", "recovery", "internal_job"] as const;\nconst INTEGRITY_LEASE_TOOLS_HARDENING_V2 = true;',
    "tool hardening marker",
  );

  tools = replaceSection(
    tools,
    "async function recoveryResolution(context: HotfixContext, planId: string, previousActionId: string | null): Promise<Record<string, unknown>> {",
    "async function acquireExecutionLease(context: HotfixContext, planId: string, input: ExecutionInput): Promise<LeaseMetadata | Record<string, unknown>> {",
    `function expectedRecoveryPath(action: PlanAction): string | null {
  if (action.action === "MOVE" && action.destinationPath) {
    const name = action.proposedFilename ?? action.currentFilename ?? action.sourcePath?.split("/").pop();
    return name ? \`\${action.destinationPath.replace(/\\/$/, "")}/\${name}\`.replace(/^\\//, "") : null;
  }
  if (action.action === "RENAME" && action.sourcePath && action.proposedFilename) {
    const parent = action.sourcePath.split("/").slice(0, -1).join("/");
    return parent ? \`\${parent}/\${action.proposedFilename}\` : action.proposedFilename;
  }
  return null;
}

async function classifyReservedActionRecovery(context: HotfixContext, plan: IntegrityPlan, action: PlanAction, reservation: Record<string, unknown> | null, operation: Record<string, unknown> | undefined): Promise<string> {
  if (operation?.state === "completed" || plan.completedActions.includes(action.actionId)) return "completed";
  if (reservation?.state === "reserved") return "ready_for_retry";
  if (["RENAME", "MOVE"].includes(action.action) && action.sourceItemId && action.sourcePath) {
    const expectedPath = expectedRecoveryPath(action);
    const source = await verifyItemInsideRoot(context.env, context.userId, action.sourceItemId).catch(() => null);
    if (source && expectedPath && source.relativePath === expectedPath) return "completed";
    if (!source && expectedPath) {
      const applied = await resolveRelativeItem(context.env, context.userId, expectedPath).catch(() => null);
      if (applied?.item.id === action.sourceItemId) return "completed";
      return "manual_review";
    }
    if (source && source.relativePath === action.sourcePath && (!action.snapshotETag || source.item.eTag === action.snapshotETag)) {
      if (!expectedPath) return "ready_for_retry";
      const destination = await resolveRelativeItem(context.env, context.userId, expectedPath).catch(() => null);
      if (!destination) return "ready_for_retry";
      return destination.item.id === source.item.id ? "completed" : "manual_review";
    }
    return "manual_review";
  }
  if (operation?.state === "failed") {
    const error = operation.error as Record<string, unknown> | undefined;
    const ambiguous = ["graph_timeout", "graph_network_error", "graph_unreachable", "graph_server_error", "graph_subrequest_limit", "graph_rate_limited", "graph_request_failed"].includes(String(error?.code ?? ""));
    return ambiguous ? "manual_review" : Boolean(error?.retryable) ? "ready_for_retry" : "failed_closed";
  }
  if (!operation && reservation?.state !== "mutation_in_progress") return "ready_for_retry";
  return "manual_review";
}

async function recoveryResolution(context: HotfixContext, planId: string, previousActionId: string | null): Promise<Record<string, unknown>> {
  const before = await callIntegrityCoordination(context.env, context.userId, { op: "status", planId });
  const reservation = before.reservation as Record<string, unknown> | null;
  const actionId = previousActionId || String(reservation?.actionId ?? "") || null;
  const operation = actionId ? await context.storage.get<Record<string, unknown>>(\`integrated:operation:\${planId}:\${actionId}\`) : undefined;
  const reconciliation = await reconcileIntegrityPlan(context, { planId, maximumActions: 3 });
  const reconciled = Array.isArray(reconciliation.reconciledThisInvocation) ? reconciliation.reconciledThisInvocation.map(String) : [];
  const plan = await getPlan(context, planId);
  const action = actionId ? plan.actions.find((candidate) => candidate.actionId === actionId) : undefined;
  let result = actionId && (operation?.state === "completed" || reconciled.includes(actionId) || plan.completedActions.includes(actionId)) ? "completed" : "ready_for_retry";
  if (action) result = await classifyReservedActionRecovery(context, plan, action, reservation, operation);
  else if (reservation?.state === "mutation_in_progress") result = "manual_review";
  return {
    previousActionId: actionId,
    reconciliationResult: result,
    reconciledActions: reconciled,
    operationState: operation?.state ?? null,
    identityEvidenceUsed: Boolean(action?.sourceItemId),
    recoveredAt: nowIso(),
  };
}

`,
    "recovery evidence",
  );

  tools = replaceSection(
    tools,
    "async function acquireExecutionLease(context: HotfixContext, planId: string, input: ExecutionInput): Promise<LeaseMetadata | Record<string, unknown>> {",
    "function isLeaseMetadata(value: LeaseMetadata | Record<string, unknown>): value is LeaseMetadata {",
    `async function acquireExecutionLease(context: HotfixContext, planId: string, input: ExecutionInput): Promise<LeaseMetadata | Record<string, unknown>> {
  const defaults = executionDefaults(input);
  const plan = await getPlan(context, planId);
  const request = {
    op: "acquire",
    planId,
    scopePath: plan.scopePath,
    ...defaults,
    workerVersion: workerVersion(context.env),
    leaseDurationSeconds: leaseSeconds(context.env),
  } as const;
  let result = await callIntegrityCoordination(context.env, context.userId, request);
  let recoveryMetadata: Record<string, unknown> | undefined;
  if (result.recoveryRequired === true) {
    recoveryMetadata = await recoveryResolution(context, planId, String(result.previousActionId ?? "") || null);
    result = await callIntegrityCoordination(context.env, context.userId, { ...request, recoveryResolution: recoveryMetadata });
  }
  if (result.acquired !== true) return { ...result, executionState: "already_executing", leaseAcquired: false, alreadyExecuting: true, completedThisInvocation: [], reconciledThisInvocation: [], failedThisInvocation: [], resumeRequired: true, planComplete: false };
  return {
    planId,
    leaseId: String(result.leaseId),
    fencingToken: Number(result.fencingToken),
    invocationId: defaults.invocationId,
    leaseExpiresAt: String(result.leaseExpiresAt),
    recoveredExpiredLease: Boolean(result.recoveredExpiredLease),
    recoveryMetadata,
  };
}

`,
    "lease acquire scope",
  );

  tools = replaceSection(
    tools,
    "async function executeWithLease(context: HotfixContext, input: ExecutionInput): Promise<Record<string, unknown>> {",
    "async function reconcileWithLease(context: HotfixContext, input: { planId: string; maximumActions?: number; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {",
    `function leaseResponseFields(acquired: LeaseMetadata): Record<string, unknown> {
  return { leaseAcquired: true, alreadyExecuting: false, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, leaseExpiresAt: acquired.leaseExpiresAt, retryAfterSeconds: 0, safeToRetry: true, recoveredExpiredLease: acquired.recoveredExpiredLease, recoveryMetadata: acquired.recoveryMetadata ?? null };
}
function planProgressFields(plan: IntegrityPlan): Record<string, unknown> {
  const unresolved = unresolvedActions(plan);
  const ready = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  return { remainingActions: unresolved.length, nextAction: plan.nextAction ?? ready[0]?.actionId ?? unresolved[0]?.actionId ?? null, nextReadyAction: ready[0]?.actionId ?? null, resumeRequired: unresolved.length > 0, auditPending: plan.auditStatus === "pending" || plan.auditStatus === "running", planComplete: unresolved.length === 0 };
}

async function executeWithLease(context: HotfixContext, input: ExecutionInput): Promise<Record<string, unknown>> {
  const token = await openJson<{ planId: string; planHash: string; expiresAt: number }>(context.env.COOKIE_ENCRYPTION_KEY, String(input.executionToken ?? "")).catch(() => null);
  if (!token || token.expiresAt <= Date.now()) throw new ConnectorError("execution_token_invalid", "The execution token is invalid or expired.");
  const initialPlan = await getPlan(context, token.planId);
  if (initialPlan.validationStatus !== "valid" || initialPlan.planHash !== token.planHash) throw new ConnectorError("plan_not_validated", "The integrity plan is not currently validated.");
  const acquired = await acquireExecutionLease(context, token.planId, input);
  if (!isLeaseMetadata(acquired)) return acquired;
  const lease: LeaseReference = { planId: acquired.planId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, invocationId: acquired.invocationId };
  const fencedContext: HotfixContext = { ...context, storage: createLeaseFencedStorage(context.storage, context.env, context.userId, lease) };
  let reservation: Record<string, unknown> | null = null;
  let action: PlanAction | null = null;
  let mutationStarted = false;
  let finalized = false;
  let released = false;
  try {
    const recoveryResult = String(acquired.recoveryMetadata?.reconciliationResult ?? "");
    if (["manual_review", "failed_closed"].includes(recoveryResult)) {
      await releaseLease(context, acquired, { recoveryBlockedExecution: recoveryResult });
      released = true;
      const plan = await getPlan(context, token.planId);
      return { planId: plan.planId, executionState: recoveryResult, ...leaseResponseFields(acquired), completedThisInvocation: [], reconciledThisInvocation: [], failedThisInvocation: recoveryResult === "failed_closed" && acquired.recoveryMetadata?.previousActionId ? [String(acquired.recoveryMetadata.previousActionId)] : [], currentAction: acquired.recoveryMetadata?.previousActionId ?? null, ...planProgressFields(plan) };
    }

    const pre = await reconcileIntegrityPlan(fencedContext, { planId: token.planId, maximumActions: 3 });
    const preReconciled = Array.isArray(pre.reconciledThisInvocation) ? pre.reconciledThisInvocation.map(String) : [];
    if (preReconciled.length > 0 || pre.discrepancy) {
      await releaseLease(context, acquired, { reconciliationOnly: true, reconciled: preReconciled });
      released = true;
      const plan = await getPlan(context, token.planId);
      return { ...pre, planId: plan.planId, executionState: pre.discrepancy ? "manual_review" : "reconciled", ...leaseResponseFields(acquired), completedThisInvocation: [], reconciledThisInvocation: preReconciled, failedThisInvocation: [], currentAction: null, ...planProgressFields(plan) };
    }

    let plan = await getPlan(context, token.planId);
    const ready = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    const unresolved = unresolvedActions(plan);
    action = ready[0] ?? null;
    if (!action) {
      await releaseLease(context, acquired, { reason: unresolved.length === 0 ? "plan_complete" : "no_ready_action" });
      released = true;
      return { planId: plan.planId, executionState: unresolved.length === 0 ? "complete" : "waiting", ...leaseResponseFields(acquired), completedThisInvocation: [], reconciledThisInvocation: [], failedThisInvocation: [], currentAction: null, ...planProgressFields(plan) };
    }

    const evidence = actionEvidence(action);
    const reserved = await callIntegrityCoordination(context.env, context.userId, { op: "reserve", ...lease, actionId: action.actionId, ...evidence });
    reservation = reserved.reservation as Record<string, unknown>;
    await callIntegrityCoordination(context.env, context.userId, { op: "mark-mutation-started", ...lease, actionId: action.actionId, progressSequence: Number(reservation.attempt ?? 1), leaseDurationSeconds: leaseSeconds(context.env) });
    mutationStarted = true;

    const underlying = await executeIntegrityPlanWithBlockedMoveReconciliation(fencedContext, { executionToken: input.executionToken });
    const completed = Array.isArray(underlying.completedThisInvocation) ? underlying.completedThisInvocation.map(String) : [];
    const reconciled = Array.isArray(underlying.reconciledThisInvocation) ? underlying.reconciledThisInvocation.map(String) : [];
    const failed = Array.isArray(underlying.failedThisInvocation) ? underlying.failedThisInvocation.map(String) : [];
    if (completed.length > 0 && !completed.includes(action.actionId)) throw new ConnectorError("action_reservation_mismatch", "The executor attempted to complete an action other than the reserved action.", { retryable: false });
    let state: ReservationState = "ready_for_retry";
    if (completed.includes(action.actionId)) state = "completed";
    else if (reconciled.includes(action.actionId)) state = "reconciled";
    else if (failed.includes(action.actionId)) state = "failed";
    else if (underlying.discrepancy) state = "manual_review";
    const outcome = { completed, reconciled, failed, discrepancy: Boolean(underlying.discrepancy), idempotencyKey: reservation.idempotencyKey };
    await callIntegrityCoordination(context.env, context.userId, { op: "finalize-action", ...lease, actionId: action.actionId, reservationState: state, outcome });
    finalized = true;
    mutationStarted = false;
    await releaseLease(context, acquired, { state, actionId: action.actionId });
    released = true;
    plan = await getPlan(context, token.planId);
    return { ...underlying, executionState: unresolvedActions(plan).length === 0 ? "complete" : state === "manual_review" ? "manual_review" : "yielded", ...leaseResponseFields(acquired), currentAction: action.actionId, actionReservation: { actionId: action.actionId, attempt: reservation.attempt, idempotencyKey: reservation.idempotencyKey, state }, completedThisInvocation: completed, reconciledThisInvocation: reconciled, failedThisInvocation: failed, ...planProgressFields(plan) };
  } catch (error) {
    if (reservation && !mutationStarted && !finalized && action) {
      await callIntegrityCoordination(context.env, context.userId, { op: "finalize-action", ...lease, actionId: action.actionId, reservationState: "ready_for_retry", outcome: { abortedBeforeMutation: true } }).catch(() => undefined);
    }
    if (!mutationStarted && !released) await releaseLease(context, acquired, { abortedBeforeMutation: true }).catch(() => undefined);
    throw error;
  }
}

`,
    "leased execution hardening",
  );

  tools = replaceSection(
    tools,
    "async function reconcileWithLease(context: HotfixContext, input: { planId: string; maximumActions?: number; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {",
    "async function executionState(context: HotfixContext, planId: string): Promise<Record<string, unknown>> {",
    `async function reconcileWithLease(context: HotfixContext, input: { planId: string; maximumActions?: number; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {
  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "internal_job", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
  if (!isLeaseMetadata(acquired)) return acquired;
  const lease: LeaseReference = { planId: acquired.planId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, invocationId: acquired.invocationId };
  const fencedContext: HotfixContext = { ...context, storage: createLeaseFencedStorage(context.storage, context.env, context.userId, lease) };
  try {
    const result = await reconcileIntegrityPlan(fencedContext, { planId: input.planId, maximumActions: input.maximumActions });
    return { ...result, executionState: "reconciled", ...leaseResponseFields(acquired) };
  } finally {
    await releaseLease(context, acquired, { reconciliationOnly: true }).catch(() => undefined);
  }
}

`,
    "reconciliation release",
  );

  tools = replaceOnce(
    tools,
    "    nextAction: unresolved[0]?.actionId ?? null,",
    "    nextAction: plan.nextAction ?? ready[0]?.actionId ?? unresolved[0]?.actionId ?? null,",
    "status next action preservation",
  );

  tools = replaceSection(
    tools,
    "async function requestRecovery(context: HotfixContext, input: { planId: string; force?: boolean; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {",
    "async function startDiffWithCoordination(context: HotfixContext, schedule: ScheduleSnapshot, planId: string): Promise<Record<string, unknown>> {",
    `async function requestRecovery(context: HotfixContext, input: { planId: string; force?: boolean; ownerId?: string; invocationId?: string; correlationId?: string }): Promise<Record<string, unknown>> {
  const status = await callIntegrityCoordination(context.env, context.userId, { op: "status", planId: input.planId });
  if (status.leased === true && input.force !== true) return { recovered: false, activeLeaseStillValid: true, refusedCancellation: true, safeToRetry: true, activeLease: status.activeLease };
  if (status.leased === true && input.force === true) {
    const defaults = executionDefaults({ executionToken: "", ownerType: "recovery", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
    const claim = await callIntegrityCoordination(context.env, context.userId, { op: "claim-force-recovery", planId: input.planId, ...defaults, workerVersion: workerVersion(context.env), force: true });
    if (claim.claimed !== true) return { recovered: false, refusedCancellation: true, ...claim };
    const reconciliation = await reconcileIntegrityPlan(context, { planId: input.planId, maximumActions: 3 });
    const invalidated = await callIntegrityCoordination(context.env, context.userId, { op: "force-invalidate", planId: input.planId, ...defaults, force: true, outcome: { reconciliationSummary: { reconciledThisInvocation: reconciliation.reconciledThisInvocation ?? [], discrepancy: reconciliation.discrepancy ?? null } } });
    return { recovered: Boolean(invalidated.invalidated), forced: true, reconciliation, ...invalidated };
  }
  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "recovery", ownerId: input.ownerId, invocationId: input.invocationId, correlationId: input.correlationId });
  if (!isLeaseMetadata(acquired)) return acquired;
  await releaseLease(context, acquired, { recoveryOnly: true });
  return { recovered: acquired.recoveredExpiredLease, previousLease: acquired.recoveryMetadata ?? null, newFencingToken: acquired.fencingToken, leaseReleased: true };
}

type LeaseProbeInput = { planId: string; mode?: "acquire" | "release" | "acquire_and_release"; ownerId?: string; invocationId?: string; correlationId?: string; leaseId?: string; fencingToken?: number; actionId?: string; simulateMutationInProgress?: boolean };
async function probeLease(context: HotfixContext, input: LeaseProbeInput): Promise<Record<string, unknown>> {
  const mode = input.mode ?? "acquire_and_release";
  if (mode === "release") {
    if (!input.leaseId || !input.invocationId || !Number.isFinite(input.fencingToken)) throw new ConnectorError("probe_release_metadata_required", "Lease ID, invocation ID, and fencing token are required to release a probe lease.");
    return callIntegrityCoordination(context.env, context.userId, { op: "release", planId: input.planId, leaseId: input.leaseId, fencingToken: Number(input.fencingToken), invocationId: input.invocationId, outcome: { acceptanceProbe: true } });
  }
  const acquired = await acquireExecutionLease(context, input.planId, { executionToken: "", ownerType: "internal_job", ownerId: input.ownerId ?? "integrity-lease-acceptance-probe", invocationId: input.invocationId, correlationId: input.correlationId });
  if (!isLeaseMetadata(acquired)) return acquired;
  const lease: LeaseReference = { planId: acquired.planId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, invocationId: acquired.invocationId };
  let reservation: Record<string, unknown> | null = null;
  if (input.actionId) {
    const plan = await getPlan(context, input.planId);
    const action = plan.actions.find((candidate) => candidate.actionId === input.actionId);
    if (!action) throw new ConnectorError("probe_action_not_found", "The requested probe action does not exist in the plan.");
    const reserved = await callIntegrityCoordination(context.env, context.userId, { op: "reserve", ...lease, actionId: action.actionId, ...actionEvidence(action) });
    reservation = reserved.reservation as Record<string, unknown>;
    if (input.simulateMutationInProgress === true) await callIntegrityCoordination(context.env, context.userId, { op: "mark-mutation-started", ...lease, actionId: action.actionId, progressSequence: Number(reservation.attempt ?? 1), leaseDurationSeconds: leaseSeconds(context.env) });
  }
  if (mode === "acquire_and_release") {
    if (input.simulateMutationInProgress) throw new ConnectorError("probe_inflight_cannot_release", "A simulated in-flight action must be recovered after lease expiry rather than released.");
    await releaseLease(context, acquired, { acceptanceProbe: true });
  }
  return { planId: input.planId, probeMode: mode, ...leaseResponseFields(acquired), invocationId: acquired.invocationId, reservation, leaseReleased: mode === "acquire_and_release", noGraphMutationPerformed: true };
}

async function executionAudit(context: HotfixContext, planId: string, cursor?: number, limit?: number): Promise<Record<string, unknown>> {
  await getPlan(context, planId);
  return callIntegrityCoordination(context.env, context.userId, { op: "audit-page", planId, cursor, limit });
}

`,
    "guarded recovery and probe",
  );

  tools = replaceOnce(
    tools,
    "  const gate = await callIntegrityCoordination(context.env, context.userId, { op: \"begin-plan-audit\", planId, auditJobId: \"pending\" });",
    "  const plan = await getPlan(context, planId);\n  const gate = await callIntegrityCoordination(context.env, context.userId, { op: \"begin-plan-audit\", planId, scopePath: plan.scopePath, auditJobId: \"pending\" });",
    "audit scope",
  );

  tools = replaceSection(
    tools,
    "async function getJobWithCoordination(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<Record<string, unknown>> {",
    "export async function continueSnapshotWithLease(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<Record<string, unknown>> {",
    `async function getJobWithCoordination(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<Record<string, unknown>> {
  const current = await context.storage.get<JobRecord>(\`\${JOB_PREFIX}\${jobId}\`);
  if (!current) throw new ConnectorError("job_not_found", "The integrated job does not exist or has expired.");
  const invocationId = crypto.randomUUID();
  const acquired = await callIntegrityCoordination(context.env, context.userId, { op: "job-acquire", jobId, invocationId, ownerId: "get_job_status", ownerType: "internal_job", workerVersion: workerVersion(context.env) });
  if (acquired.acquired !== true) return { jobId, alreadyExecuting: true, safeToRetry: true, ...acquired };
  const lease: JobLeaseReference = { jobId, invocationId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken) };
  const fencedContext: HotfixContext = { ...context, storage: createJobFencedStorage(context.storage, context.env, context.userId, lease) };
  const childStatus = async (childJobId: string): Promise<JobRecord> => {
    const childInvocationId = crypto.randomUUID();
    const childAcquire = await callIntegrityCoordination(context.env, context.userId, { op: "job-acquire", jobId: childJobId, invocationId: childInvocationId, ownerId: "integrity_diff_child_status", ownerType: "internal_job", workerVersion: workerVersion(context.env) });
    if (childAcquire.acquired !== true) {
      const snapshot = await context.storage.get<JobRecord>(\`\${JOB_PREFIX}\${childJobId}\`);
      if (!snapshot) throw new ConnectorError("job_not_found", "The final snapshot job does not exist or has expired.");
      return snapshot;
    }
    const childLease: JobLeaseReference = { jobId: childJobId, invocationId: childInvocationId, leaseId: String(childAcquire.leaseId), fencingToken: Number(childAcquire.fencingToken) };
    try {
      const childContext: HotfixContext = { ...context, storage: createJobFencedStorage(context.storage, context.env, context.userId, childLease) };
      return await getIntegrityJobStatus(childContext, schedule, childJobId);
    } finally {
      await callIntegrityCoordination(context.env, context.userId, { op: "job-release", ...childLease }).catch(() => undefined);
    }
  };
  try {
    const result = await getIntegrityJobStatus(fencedContext, schedule, jobId, current.type === "integrity_diff" ? childStatus : undefined);
    const planId = String(result.resultReferences?.planId ?? "");
    if (planId) await callIntegrityCoordination(context.env, context.userId, { op: "update-plan-audit", planId, auditJobId: jobId }).catch(() => undefined);
    if (planId && ["completed", "failed", "cancelled"].includes(result.status)) await callIntegrityCoordination(context.env, context.userId, { op: "end-plan-audit", planId, auditJobId: jobId, outcome: { status: result.status } });
    return result as unknown as Record<string, unknown>;
  } finally {
    await callIntegrityCoordination(context.env, context.userId, { op: "job-release", ...lease }).catch(() => undefined);
  }
}

`,
    "parent-child job fencing",
  );

  tools = replaceOnce(
    tools,
    "  if (acquired.acquired !== true) return { jobId, alreadyExecuting: true, safeToRetry: true, ...acquired };\n  const lease: JobLeaseReference = { jobId, invocationId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken) };",
    "  if (acquired.acquired !== true) {\n    await schedule(jobId, context.userId, Math.min(60, Math.max(2, Number(acquired.retryAfterSeconds ?? 5))));\n    return { jobId, alreadyExecuting: true, safeToRetry: true, retryScheduled: true, ...acquired };\n  }\n  const lease: JobLeaseReference = { jobId, invocationId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken) };",
    "scheduled continuation collision retry",
  );

  tools = replaceOnce(
    tools,
    'for (const name of ["execute_integrity_plan", "reconcile_integrity_plan", "get_integrity_plan_status", "get_integrity_plan_execution_state", "request_integrity_plan_lease_recovery", "diff_scope_before_after", "get_job_status"])',
    'for (const name of ["execute_integrity_plan", "reconcile_integrity_plan", "get_integrity_plan_status", "get_integrity_plan_execution_state", "get_integrity_plan_execution_audit", "request_integrity_plan_lease_recovery", "probe_integrity_plan_execution_lease", "diff_scope_before_after", "get_job_status"])',
    "tool replacement list",
  );
  tools = replaceOnce(
    tools,
    `    server.registerTool("request_integrity_plan_lease_recovery", {`,
    `    server.registerTool("get_integrity_plan_execution_audit", {
      title: "Get bounded integrity execution audit history",
      description: "Return a paginated newest-first page of bounded lease, fencing, reservation, recovery, denial, and release audit records.",
      inputSchema: { planId: z.string().uuid(), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() },
      annotations: READ_ONLY,
    }, async ({ planId, cursor, limit }) => { try { return textResult(await executionAudit(contextFactory(), planId, cursor, limit)); } catch (error) { return errorResult(error); } });
    server.registerTool("request_integrity_plan_lease_recovery", {`,
    "audit tool registration",
  );
  tools = replaceOnce(
    tools,
    `    server.registerTool("diff_scope_before_after", {`,
    `    server.registerTool("probe_integrity_plan_execution_lease", {
      title: "Probe or hold an integrity execution lease without Graph mutation",
      description: "Administrative acceptance tool. Atomically acquire, hold, or owner-check-release a plan lease and optionally reserve a fixture action without issuing any Microsoft Graph mutation.",
      inputSchema: { planId: z.string().uuid(), mode: z.enum(["acquire", "release", "acquire_and_release"]).optional(), ownerId: z.string().max(500).optional(), invocationId: z.string().max(500).optional(), correlationId: z.string().max(500).optional(), leaseId: z.string().uuid().optional(), fencingToken: z.number().int().min(1).optional(), actionId: z.string().max(200).optional(), simulateMutationInProgress: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    }, async (input) => { try { return textResult(await probeLease(contextFactory(), input)); } catch (error) { return errorResult(error); } });
    server.registerTool("diff_scope_before_after", {`,
    "probe tool registration",
  );
  write("src/integrity-lease-tools.ts", tools);
}

let tests = read("test/integrity-coordination.test.ts");
if (!tests.includes("overlapping plan scopes are denied atomically")) {
  tests += `

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
  await assert.rejects(() => h.run({ op: "fenced-put", ...lease, logicalKey: \`integrated:plan:\${base.planId}\`, value: { stale: true } }));
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
  for (let index = 0; index < 8; index += 1) await h.run({ ...acquire(\`denied-page-\${index}\`), ownerId: \`denied-page-\${index}\`, scopePath: "Fixture" });
  const first = await h.run({ op: "audit-page", userId: base.userId, planId: base.planId, cursor: 0, limit: 3 });
  const second = await h.run({ op: "audit-page", userId: base.userId, planId: base.planId, cursor: first.nextCursor as number, limit: 3 });
  assert.equal((first.records as any[]).length, 3);
  assert.equal((second.records as any[]).length, 3);
  assert.ok((first.records as any[])[0].sequence > (first.records as any[])[1].sequence);
});
`;
  write("test/integrity-coordination.test.ts", tests);
}

console.log("Integrity lease hardening applied.");
