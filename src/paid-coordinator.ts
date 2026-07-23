import { DurableObject } from "cloudflare:workers";
import {
  PAID_JOB_RETENTION_SECONDS,
  PAID_PLAN_RETENTION_SECONDS,
  nowIso,
  expiryIso,
  parseJsonText,
  type PaidJobRecord,
  type PaidPlanRecord,
  type StableVisualRecord,
} from "./paid-core";

type JsonObject = Record<string, unknown>;

type PlanRow = {
  operation_id: string;
  user_id: string;
  request_hash: string;
  plan_id: string | null;
  plan_hash: string | null;
  snapshot_id: string;
  scope_path: string;
  state: PaidPlanRecord["state"];
  artifact_prefix: string;
  artifacts_json: string;
  action_count: number;
  source_expires_at: string | null;
  superseded_by: string | null;
  abandon_reason: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  job_id: string;
  workflow_id: string;
  user_id: string;
  tool_name: string;
  request_hash: string;
  status: PaidJobRecord["status"];
  progress: number;
  stage: string;
  result_key: string | null;
  result_mime_type: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type VisualRow = {
  stable_id: string;
  user_id: string;
  source_item_id: string;
  source_etag: string | null;
  source_filename: string;
  source_extension: string;
  visual_key: string;
  page_or_slide: number | null;
  parent_pages_json: string;
  candidate_json: string;
  exact_sha256: string | null;
  perceptual_hash: string | null;
  original_artifact_key: string | null;
  original_mime_type: string | null;
  original_byte_size: number | null;
  created_at: string;
};

function first<T>(cursor: Iterable<T>): T | undefined {
  for (const row of cursor) return row;
  return undefined;
}

function planFromRow(row: PlanRow): PaidPlanRecord {
  const sourceExpired = row.source_expires_at !== null && Date.parse(row.source_expires_at) <= Date.now();
  const effectiveState = sourceExpired && !["completed", "failed", "abandoned", "superseded"].includes(row.state)
    ? "expired"
    : row.state;
  return {
    operationId: row.operation_id,
    userId: row.user_id,
    requestHash: row.request_hash,
    planId: row.plan_id,
    planHash: row.plan_hash,
    snapshotId: row.snapshot_id,
    scopePath: row.scope_path,
    state: effectiveState,
    artifactPrefix: row.artifact_prefix,
    artifacts: parseJsonText(row.artifacts_json, {}),
    actionCount: row.action_count,
    sourceExpiresAt: row.source_expires_at,
    supersededBy: row.superseded_by,
    abandonReason: row.abandon_reason,
    error: row.error_json ? parseJsonText(row.error_json, {}) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobFromRow(row: JobRow): PaidJobRecord {
  return {
    jobId: row.job_id,
    workflowId: row.workflow_id,
    userId: row.user_id,
    toolName: row.tool_name,
    requestHash: row.request_hash,
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    resultKey: row.result_key,
    resultMimeType: row.result_mime_type,
    error: row.error_json ? parseJsonText(row.error_json, {}) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function visualFromRow(row: VisualRow): StableVisualRecord {
  return {
    stableId: row.stable_id,
    userId: row.user_id,
    sourceItemId: row.source_item_id,
    sourceETag: row.source_etag,
    sourceFilename: row.source_filename,
    sourceExtension: row.source_extension,
    visualKey: row.visual_key,
    pageOrSlide: row.page_or_slide,
    parentPages: parseJsonText<number[]>(row.parent_pages_json, []),
    candidate: parseJsonText(row.candidate_json, {}),
    exactSha256: row.exact_sha256,
    perceptualHash: row.perceptual_hash,
    originalArtifactKey: row.original_artifact_key,
    originalMimeType: row.original_mime_type,
    originalByteSize: row.original_byte_size,
    createdAt: row.created_at,
  };
}

export class PaidCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS paid_plans (
        operation_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        plan_id TEXT,
        plan_hash TEXT,
        snapshot_id TEXT NOT NULL,
        scope_path TEXT NOT NULL,
        state TEXT NOT NULL,
        artifact_prefix TEXT NOT NULL,
        artifacts_json TEXT NOT NULL DEFAULT '{}',
        action_count INTEGER NOT NULL DEFAULT 0,
        source_expires_at TEXT,
        superseded_by TEXT,
        abandon_reason TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, request_hash),
        UNIQUE(plan_id)
      );
      CREATE INDEX IF NOT EXISTS paid_plans_updated_idx ON paid_plans(updated_at DESC);
      CREATE TABLE IF NOT EXISTS paid_jobs (
        job_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL,
        stage TEXT NOT NULL,
        result_key TEXT,
        result_mime_type TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE(user_id, tool_name, request_hash)
      );
      CREATE INDEX IF NOT EXISTS paid_jobs_updated_idx ON paid_jobs(updated_at DESC);
      CREATE TABLE IF NOT EXISTS paid_visuals (
        stable_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source_item_id TEXT NOT NULL,
        source_etag TEXT,
        source_filename TEXT NOT NULL,
        source_extension TEXT NOT NULL,
        visual_key TEXT NOT NULL,
        page_or_slide INTEGER,
        parent_pages_json TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        exact_sha256 TEXT,
        perceptual_hash TEXT,
        original_artifact_key TEXT,
        original_mime_type TEXT,
        original_byte_size INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS paid_visuals_source_idx ON paid_visuals(source_item_id, source_etag);
      CREATE TABLE IF NOT EXISTS paid_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS paid_audit_entity_idx ON paid_audit(entity_type, entity_id, sequence DESC);
    `);
  }

  private audit(entityType: string, entityId: string, event: string, payload: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO paid_audit(entity_type, entity_id, event, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      entityType,
      entityId,
      event,
      JSON.stringify(payload ?? {}),
      nowIso(),
    );
  }

  private planByAny(body: JsonObject): PaidPlanRecord | null {
    const operationId = String(body.operationId ?? "");
    const planId = String(body.planId ?? "");
    const requestHash = String(body.requestHash ?? "");
    let row: PlanRow | undefined;
    if (operationId) {
      row = first(this.ctx.storage.sql.exec<PlanRow>("SELECT * FROM paid_plans WHERE operation_id = ?", operationId));
    } else if (planId) {
      row = first(this.ctx.storage.sql.exec<PlanRow>("SELECT * FROM paid_plans WHERE plan_id = ?", planId));
    } else if (requestHash) {
      row = first(this.ctx.storage.sql.exec<PlanRow>("SELECT * FROM paid_plans WHERE user_id = ? AND request_hash = ?", String(body.userId ?? ""), requestHash));
    }
    return row ? planFromRow(row) : null;
  }

  private beginPlan(body: JsonObject): PaidPlanRecord {
    const userId = String(body.userId ?? "");
    const requestHash = String(body.requestHash ?? "");
    const snapshotId = String(body.snapshotId ?? "");
    const scopePath = String(body.scopePath ?? "");
    if (!userId || !requestHash || !snapshotId) throw new Error("plan_begin_invalid");
    const existing = first(this.ctx.storage.sql.exec<PlanRow>(
      "SELECT * FROM paid_plans WHERE user_id = ? AND request_hash = ?",
      userId,
      requestHash,
    ));
    if (existing) return planFromRow(existing);
    const operationId = crypto.randomUUID();
    const createdAt = nowIso();
    const artifactPrefix = `plans/${operationId}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO paid_plans(
        operation_id, user_id, request_hash, snapshot_id, scope_path, state,
        artifact_prefix, artifacts_json, action_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, '{}', ?, ?, ?)`,
      operationId,
      userId,
      requestHash,
      snapshotId,
      scopePath,
      artifactPrefix,
      Number(body.actionCount ?? 0),
      createdAt,
      createdAt,
    );
    this.audit("plan", operationId, "reserved", { requestHash, snapshotId, scopePath });
    return this.planByAny({ operationId }) as PaidPlanRecord;
  }

  private linkPlan(body: JsonObject): PaidPlanRecord {
    const operationId = String(body.operationId ?? "");
    const planId = String(body.planId ?? "");
    if (!operationId || !planId) throw new Error("plan_link_invalid");
    const updatedAt = nowIso();
    this.ctx.storage.sql.exec(
      `UPDATE paid_plans SET plan_id = ?, plan_hash = ?, source_expires_at = ?, state = 'draft',
       action_count = ?, updated_at = ? WHERE operation_id = ?`,
      planId,
      body.planHash ? String(body.planHash) : null,
      body.sourceExpiresAt ? String(body.sourceExpiresAt) : null,
      Number(body.actionCount ?? 0),
      updatedAt,
      operationId,
    );
    this.audit("plan", operationId, "linked", { planId, planHash: body.planHash ?? null });
    return this.planByAny({ operationId }) as PaidPlanRecord;
  }

  private completePlan(body: JsonObject): PaidPlanRecord {
    const operationId = String(body.operationId ?? "");
    const artifacts = body.artifacts && typeof body.artifacts === "object" ? body.artifacts : {};
    const state = String(body.state ?? "draft");
    const updatedAt = nowIso();
    this.ctx.storage.sql.exec(
      "UPDATE paid_plans SET artifacts_json = ?, state = ?, error_json = NULL, updated_at = ? WHERE operation_id = ?",
      JSON.stringify(artifacts),
      state,
      updatedAt,
      operationId,
    );
    this.audit("plan", operationId, "artifacts_committed", { artifacts, state });
    return this.planByAny({ operationId }) as PaidPlanRecord;
  }

  private failPlan(body: JsonObject): PaidPlanRecord {
    const operationId = String(body.operationId ?? "");
    this.ctx.storage.sql.exec(
      "UPDATE paid_plans SET state = 'failed', error_json = ?, updated_at = ? WHERE operation_id = ?",
      JSON.stringify(body.error ?? {}),
      nowIso(),
      operationId,
    );
    this.audit("plan", operationId, "failed", body.error ?? {});
    return this.planByAny({ operationId }) as PaidPlanRecord;
  }

  private setPlanState(body: JsonObject): PaidPlanRecord {
    const record = this.planByAny(body);
    if (!record) throw new Error("plan_not_found");
    const state = String(body.state ?? "") as PaidPlanRecord["state"];
    if (!state) throw new Error("plan_state_invalid");
    const supersededBy = body.supersededBy ? String(body.supersededBy) : record.supersededBy;
    const abandonReason = body.abandonReason ? String(body.abandonReason) : record.abandonReason;
    this.ctx.storage.sql.exec(
      "UPDATE paid_plans SET state = ?, superseded_by = ?, abandon_reason = ?, updated_at = ? WHERE operation_id = ?",
      state,
      supersededBy,
      abandonReason,
      nowIso(),
      record.operationId,
    );
    this.audit("plan", record.operationId, "state_changed", { state, supersededBy, abandonReason });
    return this.planByAny({ operationId: record.operationId }) as PaidPlanRecord;
  }

  private listPlans(body: JsonObject): PaidPlanRecord[] {
    const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 200);
    const state = String(body.state ?? "");
    const scanLimit = state === "expired" ? Math.max(limit * 5, 200) : limit;
    const rows = state && state !== "expired"
      ? this.ctx.storage.sql.exec<PlanRow>("SELECT * FROM paid_plans WHERE state = ? ORDER BY updated_at DESC LIMIT ?", state, scanLimit)
      : this.ctx.storage.sql.exec<PlanRow>("SELECT * FROM paid_plans ORDER BY updated_at DESC LIMIT ?", scanLimit);
    const records = [...rows].map(planFromRow);
    return (state ? records.filter((record) => record.state === state) : records).slice(0, limit);
  }

  private beginJob(body: JsonObject): PaidJobRecord {
    const userId = String(body.userId ?? "");
    const toolName = String(body.toolName ?? "");
    const requestHash = String(body.requestHash ?? "");
    if (!userId || !toolName || !requestHash) throw new Error("job_begin_invalid");
    const existing = first(this.ctx.storage.sql.exec<JobRow>(
      "SELECT * FROM paid_jobs WHERE user_id = ? AND tool_name = ? AND request_hash = ?",
      userId,
      toolName,
      requestHash,
    ));
    if (existing && Date.parse(existing.expires_at) > Date.now()) return jobFromRow(existing);
    if (existing) this.ctx.storage.sql.exec("DELETE FROM paid_jobs WHERE job_id = ?", existing.job_id);
    const jobId = String(body.jobId ?? crypto.randomUUID());
    const workflowId = String(body.workflowId ?? jobId);
    const createdAt = nowIso();
    this.ctx.storage.sql.exec(
      `INSERT INTO paid_jobs(
        job_id, workflow_id, user_id, tool_name, request_hash, status, progress, stage,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'reserved', 0, 'reserved', ?, ?, ?)`,
      jobId,
      workflowId,
      userId,
      toolName,
      requestHash,
      createdAt,
      createdAt,
      expiryIso(PAID_JOB_RETENTION_SECONDS),
    );
    this.audit("job", jobId, "reserved", { toolName, requestHash, workflowId });
    return this.getJob({ jobId }) as PaidJobRecord;
  }

  private updateJob(body: JsonObject): PaidJobRecord {
    const jobId = String(body.jobId ?? "");
    const current = this.getJob({ jobId });
    if (!current) throw new Error("job_not_found");
    const status = String(body.status ?? current.status);
    const progress = Math.min(Math.max(Number(body.progress ?? current.progress), 0), 100);
    const stage = String(body.stage ?? current.stage);
    const resultKey = body.resultKey === undefined ? current.resultKey : body.resultKey ? String(body.resultKey) : null;
    const resultMimeType = body.resultMimeType === undefined ? current.resultMimeType : body.resultMimeType ? String(body.resultMimeType) : null;
    const error = body.error === undefined ? current.error : body.error;
    this.ctx.storage.sql.exec(
      `UPDATE paid_jobs SET status = ?, progress = ?, stage = ?, result_key = ?,
       result_mime_type = ?, error_json = ?, updated_at = ? WHERE job_id = ?`,
      status,
      progress,
      stage,
      resultKey,
      resultMimeType,
      error ? JSON.stringify(error) : null,
      nowIso(),
      jobId,
    );
    this.audit("job", jobId, "updated", { status, progress, stage, resultKey, error: error ?? null });
    return this.getJob({ jobId }) as PaidJobRecord;
  }

  private getJob(body: JsonObject): PaidJobRecord | null {
    const jobId = String(body.jobId ?? "");
    const row = first(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM paid_jobs WHERE job_id = ?", jobId));
    return row ? jobFromRow(row) : null;
  }

  private putVisual(body: JsonObject): StableVisualRecord {
    const record = body.record as StableVisualRecord | undefined;
    if (!record?.stableId || !record.userId || !record.sourceItemId || !record.visualKey) {
      throw new Error("visual_put_invalid");
    }
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO paid_visuals(
        stable_id, user_id, source_item_id, source_etag, source_filename, source_extension,
        visual_key, page_or_slide, parent_pages_json, candidate_json, exact_sha256,
        perceptual_hash, original_artifact_key, original_mime_type, original_byte_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.stableId,
      record.userId,
      record.sourceItemId,
      record.sourceETag,
      record.sourceFilename,
      record.sourceExtension,
      record.visualKey,
      record.pageOrSlide,
      JSON.stringify(record.parentPages),
      JSON.stringify(record.candidate),
      record.exactSha256,
      record.perceptualHash,
      record.originalArtifactKey,
      record.originalMimeType,
      record.originalByteSize,
      record.createdAt,
    );
    this.audit("visual", record.stableId, "upserted", {
      sourceItemId: record.sourceItemId,
      visualKey: record.visualKey,
      exactSha256: record.exactSha256,
      parentPages: record.parentPages,
    });
    return this.getVisual({ stableId: record.stableId }) as StableVisualRecord;
  }

  private getVisual(body: JsonObject): StableVisualRecord | null {
    const stableId = String(body.stableId ?? "");
    const row = first(this.ctx.storage.sql.exec<VisualRow>("SELECT * FROM paid_visuals WHERE stable_id = ?", stableId));
    return row ? visualFromRow(row) : null;
  }

  private auditRecords(body: JsonObject): JsonObject[] {
    const entityType = String(body.entityType ?? "");
    const entityId = String(body.entityId ?? "");
    const limit = Math.min(Math.max(Number(body.limit ?? 100), 1), 500);
    return [...this.ctx.storage.sql.exec<JsonObject>(
      "SELECT sequence, entity_type, entity_id, event, payload_json, created_at FROM paid_audit WHERE entity_type = ? AND entity_id = ? ORDER BY sequence DESC LIMIT ?",
      entityType,
      entityId,
      limit,
    )].map((row) => ({
      ...row,
      payload: parseJsonText(String(row.payload_json ?? "{}"), {}),
      payload_json: undefined,
    }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return Response.json({ ok: false, error: { code: "method_not_allowed", message: "POST required." } }, { status: 405 });
    let body: JsonObject;
    try {
      body = await request.json() as JsonObject;
    } catch {
      return Response.json({ ok: false, error: { code: "invalid_json", message: "Invalid JSON body." } }, { status: 400 });
    }
    try {
      let result: unknown;
      switch (url.pathname) {
        case "/plans/begin": result = this.beginPlan(body); break;
        case "/plans/link": result = this.linkPlan(body); break;
        case "/plans/complete": result = this.completePlan(body); break;
        case "/plans/fail": result = this.failPlan(body); break;
        case "/plans/get": result = this.planByAny(body); break;
        case "/plans/list": result = this.listPlans(body); break;
        case "/plans/state": result = this.setPlanState(body); break;
        case "/jobs/begin": result = this.beginJob(body); break;
        case "/jobs/update": result = this.updateJob(body); break;
        case "/jobs/get": result = this.getJob(body); break;
        case "/visuals/put": result = this.putVisual(body); break;
        case "/visuals/get": result = this.getVisual(body); break;
        case "/audit/list": result = this.auditRecords(body); break;
        case "/health": result = { ready: true, planRetentionSeconds: PAID_PLAN_RETENTION_SECONDS }; break;
        default: return Response.json({ ok: false, error: { code: "not_found", message: "Unknown coordinator operation." } }, { status: 404 });
      }
      if (result === null) return Response.json({ ok: true, result: null }, { status: 200 });
      return Response.json({ ok: true, result });
    } catch (error) {
      const code = error instanceof Error ? error.message : "coordinator_failed";
      const status = /not_found/.test(code) ? 404 : /invalid/.test(code) ? 400 : 409;
      return Response.json({ ok: false, error: { code, message: "The durable coordinator rejected the operation." } }, { status });
    }
  }
}
