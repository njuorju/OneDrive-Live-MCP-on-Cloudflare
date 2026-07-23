import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError } from "./errors";
import { strictRelativePath } from "./graph-core";
import { bytesToBase64, sha256Text, toCsv } from "./integrated-core";
import type { IntegrityPlan, PlanAction } from "./integrated-tools";
import { sealJson } from "./security";
import type { HotfixContext } from "./version20-hotfix";
import {
  PAID_LONG_POLL_MAX_SECONDS,
  canonicalJson,
  coordinatorRequest,
  errorResult,
  getArtifact,
  logPaidError,
  nowIso,
  putArtifact,
  requestHash,
  sha256HexUtf8,
  textResult,
  type PaidJobMessage,
  type PaidJobRecord,
  type PaidPlanRecord,
  type StableVisualRecord,
} from "./paid-core";
import { readPaidJobResult, readStableVisualArtifact } from "./paid-jobs";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const STATEFUL_NON_DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const PAID_QUEUED_TOOLS = new Set([
  "create_source_snapshot",
  "calculate_file_hashes",
  "find_source_duplicates",
  "find_visual_duplicates",
  "inspect_document",
  "list_document_visuals",
  "render_document_page",
]);

function tool(server: McpServer, name: string): any {
  return (server as any)._registeredTools?.[name];
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent as Record<string, unknown>
    : {};
}

function resultErrorCode(result: CallToolResult): string | null {
  if (!result.isError) return null;
  return String((structured(result).error as Record<string, unknown> | undefined)?.code ?? "unknown_error");
}

async function stableActionId(index: number, action: Record<string, unknown>): Promise<string> {
  const digest = await sha256HexUtf8(canonicalJson({ index, action }));
  return `auto_${digest.slice(0, 32)}`;
}

async function normalizePlanInput(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const actions = Array.isArray(input.actions) ? input.actions : [];
  const normalized: Record<string, unknown>[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const raw = actions[index] as Record<string, unknown>;
    normalized.push({
      ...raw,
      actionId: raw.actionId ? String(raw.actionId) : await stableActionId(index, raw),
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
      operationOrder: Number.isFinite(Number(raw.operationOrder)) ? Number(raw.operationOrder) : index,
    });
  }
  return { ...input, actions: normalized };
}

function actionMatches(requested: Record<string, unknown>, stored: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    if (canonicalJson(value) !== canonicalJson(stored[key])) return false;
  }
  return true;
}

function planMatchesRequest(
  plan: IntegrityPlan,
  input: Record<string, unknown>,
  scopePath: string,
): boolean {
  if (plan.snapshotId !== String(input.snapshotId ?? "")) return false;
  if (strictRelativePath(plan.scopePath) !== scopePath) return false;
  const requested = Array.isArray(input.actions) ? input.actions as Record<string, unknown>[] : [];
  if (requested.length !== plan.actions.length) return false;
  return requested.every((action, index) => actionMatches(action, plan.actions[index] as unknown as Record<string, unknown>));
}

async function recoverCreatedPlan(
  context: HotfixContext,
  input: Record<string, unknown>,
  scopePath: string,
  reservedAt: string,
): Promise<IntegrityPlan | null> {
  const values = await context.storage.list<IntegrityPlan>({ prefix: "integrated:plan:" });
  const threshold = Date.parse(reservedAt) - 60_000;
  const candidates = [...values.values()]
    .filter((plan) => Date.parse(plan.createdAt) >= threshold && planMatchesRequest(plan, input, scopePath))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return candidates[0] ?? null;
}

async function storePlanArtifacts(
  env: Env,
  operation: PaidPlanRecord,
  input: Record<string, unknown>,
  plan: IntegrityPlan,
  planJson: string,
  planCsv: string,
): Promise<Record<string, string>> {
  const prefix = operation.artifactPrefix;
  const artifacts: Record<string, string> = {
    request: `${prefix}/request.json`,
    planJson: `${prefix}/plan.json`,
    planCsv: `${prefix}/plan.csv`,
    payloadManifest: `${prefix}/payload-manifest.json`,
  };
  await putArtifact(env, artifacts.request, JSON.stringify(input, null, 2), "application/json; charset=utf-8", {
    operationId: operation.operationId,
    requestHash: operation.requestHash,
  });
  await putArtifact(env, artifacts.planJson, planJson, "application/json; charset=utf-8", {
    operationId: operation.operationId,
    planId: plan.planId,
    planHash: plan.planHash,
  });
  await putArtifact(env, artifacts.planCsv, planCsv, "text/csv; charset=utf-8", {
    operationId: operation.operationId,
    planId: plan.planId,
  });
  const payloads: Record<string, unknown>[] = [];
  for (const action of input.actions as Array<Record<string, unknown>>) {
    if (String(action.action ?? "") !== "CREATE_TEXT" && String(action.action ?? "") !== "REPLACE_TEXT") continue;
    if (typeof action.content !== "string") continue;
    const actionId = String(action.actionId ?? "");
    const key = `${prefix}/payloads/${encodeURIComponent(actionId)}.utf8`;
    const bytes = new TextEncoder().encode(action.content);
    const sha256 = await sha256HexUtf8(action.content);
    await putArtifact(env, key, bytes, "application/octet-stream", {
      operationId: operation.operationId,
      planId: plan.planId,
      actionId,
      sha256,
      encoding: "utf-8",
    });
    artifacts[`payload:${actionId}`] = key;
    payloads.push({ actionId, key, sha256, byteSize: bytes.byteLength, encoding: "utf-8" });
  }
  await putArtifact(env, artifacts.payloadManifest, JSON.stringify({ planId: plan.planId, payloads }, null, 2), "application/json; charset=utf-8", {
    operationId: operation.operationId,
    planId: plan.planId,
  });
  return artifacts;
}

async function createIntegrityPlanDurably(
  server: McpServer,
  contextFactory: () => HotfixContext,
  originalHandler: (input: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>,
  rawInput: Record<string, unknown>,
): Promise<CallToolResult> {
  const context = contextFactory();
  let operation: PaidPlanRecord | null = null;
  try {
    const input = await normalizePlanInput(rawInput);
    const snapshotId = String(input.snapshotId ?? "");
    const snapshot = await context.storage.get<{ scopePath?: string }>(`integrated:snapshot:${snapshotId}:meta`);
    const scopePath = strictRelativePath(String(input.scopePath ?? snapshot?.scopePath ?? ""));
    input.scopePath = scopePath;
    const hash = await requestHash("create_integrity_plan", input);
    operation = await coordinatorRequest<PaidPlanRecord>(context.env, context.userId, "/plans/begin", {
      userId: context.userId,
      requestHash: hash,
      snapshotId,
      scopePath,
      actionCount: Array.isArray(input.actions) ? input.actions.length : 0,
    });
    if (operation.planId && operation.artifacts.planJson) {
      return textResult({
        operationId: operation.operationId,
        planId: operation.planId,
        planHash: operation.planHash,
        snapshotId: operation.snapshotId,
        scopePath: operation.scopePath,
        actionCount: operation.actionCount,
        state: operation.state,
        idempotentReplay: true,
        artifacts: operation.artifacts,
        exactPayloadBytesPersisted: true,
      });
    }

    let plan: IntegrityPlan | null = await recoverCreatedPlan(context, input, scopePath, operation.createdAt);
    let planJson: string;
    let planCsv: string;
    if (!plan) {
      const result = await originalHandler(input, {});
      if (result.isError) return result;
      const data = structured(result);
      const planId = String(data.planId ?? "");
      plan = await context.storage.get<IntegrityPlan>(`integrated:plan:${planId}`) ?? null;
      if (!plan) throw new ConnectorError("plan_storage_missing", "The plan was created but could not be recovered from durable state.", { retryable: true });
      planJson = typeof data.planJson === "string" ? data.planJson : JSON.stringify(plan, null, 2);
      planCsv = typeof data.planCsv === "string" ? data.planCsv : toCsv(plan.actions as unknown as Array<Record<string, unknown>>);
    } else {
      planJson = JSON.stringify(plan, null, 2);
      planCsv = toCsv(plan.actions as unknown as Array<Record<string, unknown>>);
    }

    operation = await coordinatorRequest<PaidPlanRecord>(context.env, context.userId, "/plans/link", {
      operationId: operation.operationId,
      planId: plan.planId,
      planHash: plan.planHash,
      sourceExpiresAt: plan.expiresAt,
      actionCount: plan.actions.length,
    });
    const artifacts = await storePlanArtifacts(context.env, operation, input, plan, planJson, planCsv);
    operation = await coordinatorRequest<PaidPlanRecord>(context.env, context.userId, "/plans/complete", {
      operationId: operation.operationId,
      artifacts,
      state: plan.status,
    });
    return textResult({
      operationId: operation.operationId,
      planId: plan.planId,
      planHash: plan.planHash,
      snapshotId: plan.snapshotId,
      scopePath: plan.scopePath,
      actionCount: plan.actions.length,
      state: operation.state,
      sourceExpiresAt: plan.expiresAt,
      idempotentReplay: false,
      artifacts,
      exactPayloadBytesPersisted: true,
      recoveryKey: operation.requestHash,
      note: "The exact plan JSON, CSV, request and CREATE_TEXT/REPLACE_TEXT payload bytes are stored in private R2 and remain recoverable after MCP response disconnection.",
    });
  } catch (error) {
    if (operation) {
      await coordinatorRequest(contextFactory().env, contextFactory().userId, "/plans/fail", {
        operationId: operation.operationId,
        error: {
          code: (error as any)?.code ?? "plan_creation_failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: Boolean((error as any)?.retryable),
        },
      }).catch(() => undefined);
    }
    logPaidError("durable_plan_creation_failed", error, { operationId: operation?.operationId ?? null });
    return errorResult(error);
  }
}

async function enqueuePaidTool(
  context: HotfixContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const hash = await requestHash(toolName, input);
    const jobId = crypto.randomUUID();
    const workflowId = jobId;
    const job = await coordinatorRequest<PaidJobRecord>(context.env, context.userId, "/jobs/begin", {
      userId: context.userId,
      toolName,
      requestHash: hash,
      jobId,
      workflowId,
    });
    if (job.status === "completed") {
      return textResult({
        ...job,
        asynchronous: true,
        idempotentReplay: true,
        recommendedNextOperation: "get_paid_job_result",
      });
    }
    const message: PaidJobMessage = {
      version: 1,
      jobId: job.jobId,
      workflowId: job.workflowId,
      userId: context.userId,
      toolName,
      input,
      requestHash: hash,
      correlationId: crypto.randomUUID(),
      chunkIndex: 0,
      createdAt: nowIso(),
    };
    try {
      await (context.env.PAID_WORKFLOW as any).create({ id: job.workflowId, params: message });
    } catch (error) {
      const sample = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!/already exists|duplicate|conflict/.test(sample)) throw error;
    }
    return textResult({
      jobId: job.jobId,
      workflowId: job.workflowId,
      toolName,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      asynchronous: true,
      idempotentReplay: job.jobId !== jobId,
      correlationId: message.correlationId,
      recommendedNextOperation: "await_paid_job",
      manualPollingRequired: false,
    });
  } catch (error) {
    return errorResult(error);
  }
}

async function getPaidJob(context: HotfixContext, jobId: string): Promise<PaidJobRecord | null> {
  return coordinatorRequest<PaidJobRecord | null>(context.env, context.userId, "/jobs/get", { jobId });
}

async function resolveStableVisualToken(context: HotfixContext, stableId: string): Promise<string> {
  const record = await coordinatorRequest<StableVisualRecord | null>(context.env, context.userId, "/visuals/get", { stableId });
  if (!record) throw new ConnectorError("stable_visual_not_found", "The stable document visual was not found.");
  return sealJson(context.env.COOKIE_ENCRYPTION_KEY, {
    version: 1,
    itemId: record.sourceItemId,
    eTag: record.sourceETag,
    filename: record.sourceFilename,
    extension: record.sourceExtension,
    candidate: record.candidate,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
}

async function planExecutionInactive(server: McpServer, planId: string): Promise<void> {
  const execution = tool(server, "get_integrity_plan_execution_state");
  if (!execution?.handler) return;
  const result = await execution.handler({ planId }, {}) as CallToolResult;
  if (result.isError) {
    const code = resultErrorCode(result);
    if (code === "plan_not_found") return;
    throw new ConnectorError(code ?? "plan_state_unavailable", "The plan execution state could not be checked.");
  }
  const state = structured(result);
  const activeLease = state.activeLease ?? state.lease;
  const reservation = state.reservation ?? state.activeReservation;
  const executionStatus = String(state.executionStatus ?? state.status ?? "");
  if (activeLease || reservation || executionStatus === "running") {
    throw new ConnectorError("plan_active", "The plan cannot be abandoned or superseded while a lease, reservation, or execution is active.");
  }
}

export function registerPaidArchitectureTools(
  server: McpServer,
  contextFactory: () => HotfixContext,
): void {
  const createPlan = tool(server, "create_integrity_plan");
  if (!createPlan?.handler) throw new Error("create_integrity_plan must be registered before paid architecture wrappers.");
  const originalCreatePlan = createPlan.handler.bind(createPlan);
  createPlan.handler = async (input: Record<string, unknown>) =>
    createIntegrityPlanDurably(server, contextFactory, originalCreatePlan, input);

  for (const name of PAID_QUEUED_TOOLS) {
    const registered = tool(server, name);
    if (!registered?.handler) continue;
    registered.handler = async (input: Record<string, unknown>) => enqueuePaidTool(contextFactory(), name, input);
  }

  const originalGetJobStatus = tool(server, "get_job_status")?.handler;
  if (originalGetJobStatus) {
    tool(server, "get_job_status").handler = async ({ jobId }: { jobId: string }) => {
      try {
        const paid = await getPaidJob(contextFactory(), jobId);
        return paid ? textResult({ ...paid, architecture: "paid_workflow_queue_r2" }) : originalGetJobStatus({ jobId }, {});
      } catch (error) {
        return errorResult(error);
      }
    };
  }

  const durableExpiredPlanState = async (planId: string, originalResult: CallToolResult): Promise<CallToolResult> => {
    if (!originalResult.isError || resultErrorCode(originalResult) !== "plan_not_found") return originalResult;
    const context = contextFactory();
    const record = await coordinatorRequest<PaidPlanRecord | null>(context.env, context.userId, "/plans/get", { planId });
    if (!record) return originalResult;
    const sourceExpired = record.sourceExpiresAt ? Date.parse(record.sourceExpiresAt) <= Date.now() : false;
    return textResult({
      planId,
      operationId: record.operationId,
      status: sourceExpired && !new Set(["completed", "abandoned", "superseded"]).has(record.state) ? "expired" : record.state,
      executionStatus: "not_executable_from_expired_source_record",
      sourcePlanExpired: sourceExpired,
      planDefinitionRecoverable: Boolean(record.artifacts.planJson),
      artifacts: record.artifacts,
      supersededBy: record.supersededBy,
      abandonReason: record.abandonReason,
      recommendedNextOperation: "get_integrity_plan_definition",
      architecture: "paid_plan_registry_r2",
    });
  };

  const originalPlanStatus = tool(server, "get_integrity_plan_status")?.handler;
  if (originalPlanStatus) {
    tool(server, "get_integrity_plan_status").handler = async ({ planId }: { planId: string }) => {
      try {
        return durableExpiredPlanState(planId, await originalPlanStatus({ planId }, {}) as CallToolResult);
      } catch (error) {
        return errorResult(error);
      }
    };
  }

  const originalExecutionState = tool(server, "get_integrity_plan_execution_state")?.handler;
  if (originalExecutionState) {
    tool(server, "get_integrity_plan_execution_state").handler = async ({ planId }: { planId: string }) => {
      try {
        return durableExpiredPlanState(planId, await originalExecutionState({ planId }, {}) as CallToolResult);
      } catch (error) {
        return errorResult(error);
      }
    };
  }

  const originalVisualForAnalysis = tool(server, "fetch_document_visual_for_analysis")?.handler;
  if (originalVisualForAnalysis) {
    tool(server, "fetch_document_visual_for_analysis").handler = async (input: Record<string, unknown>) => {
      const context = contextFactory();
      const visualId = String(input.visualId ?? "");
      if (!visualId.startsWith("vis_")) return originalVisualForAnalysis(input, {});
      try {
        const record = await coordinatorRequest<StableVisualRecord | null>(context.env, context.userId, "/visuals/get", { stableId: visualId });
        if (!record) throw new ConnectorError("stable_visual_not_found", "The stable document visual was not found.");
        const mode = String(input.mode ?? "rendered");
        if (mode === "original" && record.originalArtifactKey) {
          const artifact = await getArtifact(context.env, record.originalArtifactKey);
          const maximum = Math.min(Math.max(Number(input.maxDimension ?? 1600), 256), 3000);
          const output = await context.env.IMAGES
            .input(artifact.body)
            .transform({ width: maximum, height: maximum, fit: "scale-down" })
            .output({ format: "image/png", anim: false });
          const response = output.response();
          if (!response.ok) throw new ConnectorError("visual_preview_failed", "The exact embedded original could not be previewed.", { retryable: true });
          const bytes = await response.arrayBuffer();
          const metadata = {
            visualId,
            mode: "original_preview",
            sourceMimeType: record.originalMimeType,
            exactOriginalAvailable: true,
            embeddedSha256: record.exactSha256,
            perceptualHash: record.perceptualHash,
            parentPages: record.parentPages,
          };
          return {
            structuredContent: metadata,
            content: [
              { type: "text", text: JSON.stringify(metadata, null, 2) },
              { type: "image", data: bytesToBase64(bytes), mimeType: "image/png" },
            ],
          } as CallToolResult;
        }
        return enqueuePaidTool(context, "render_document_page", {
          itemId: record.sourceItemId,
          pageOrSlide: record.pageOrSlide ?? record.parentPages[0] ?? 1,
          outputFormat: "png",
          width: Number(input.maxDimension ?? 1600),
          cropRegion: mode === "region" ? input.cropRegion : undefined,
        });
      } catch (error) {
        return errorResult(error);
      }
    };
  }

  const originalVisualOriginal = tool(server, "fetch_document_visual_original")?.handler;
  if (originalVisualOriginal) {
    tool(server, "fetch_document_visual_original").handler = async (input: Record<string, unknown>) => {
      const visualId = String(input.visualId ?? "");
      if (!visualId.startsWith("vis_")) return originalVisualOriginal(input, {});
      try {
        const record = await coordinatorRequest<StableVisualRecord | null>(contextFactory().env, contextFactory().userId, "/visuals/get", { stableId: visualId });
        if (!record?.originalArtifactKey) return textResult({ visualId, status: "not_available", reason: "No unchanged embedded original is available." });
        return {
          structuredContent: {
            visualId,
            exactOriginalAvailable: true,
            mimeType: record.originalMimeType,
            byteSize: record.originalByteSize,
            sha256: record.exactSha256,
          },
          content: [{
            type: "resource_link",
            uri: `onedrive-paid-visual:///${encodeURIComponent(visualId)}`,
            name: record.sourceFilename,
            mimeType: record.originalMimeType ?? "application/octet-stream",
            description: "Exact embedded original bytes from private R2, tied to the stable source eTag and visual identity.",
          }],
        } as CallToolResult;
      } catch (error) {
        return errorResult(error);
      }
    };
  }

  for (const name of ["save_document_visual", "create_visual_contact_sheet"]) {
    const registered = tool(server, name);
    if (!registered?.handler) continue;
    const original = registered.handler.bind(registered);
    registered.handler = async (input: Record<string, unknown>) => {
      try {
        const resolved = { ...input };
        if (typeof resolved.visualId === "string" && resolved.visualId.startsWith("vis_")) {
          resolved.visualId = await resolveStableVisualToken(contextFactory(), resolved.visualId);
        }
        if (Array.isArray(resolved.visualIds)) {
          resolved.visualIds = await Promise.all(resolved.visualIds.map(async (value) => {
            const id = String(value);
            return id.startsWith("vis_") ? resolveStableVisualToken(contextFactory(), id) : id;
          }));
        }
        return original(resolved, {});
      } catch (error) {
        return errorResult(error);
      }
    };
  }

  server.registerResource(
    "onedrive-paid-visual-original",
    new ResourceTemplate("onedrive-paid-visual:///{stableId}", { list: undefined }),
    {
      title: "Stable exact embedded document visual",
      description: "Exact embedded original bytes stored privately in R2 and addressed by a stable source/eTag/visual identity.",
      mimeType: "application/octet-stream",
    },
    async (uri) => {
      const stableId = decodeURIComponent(uri.pathname.replace(/^\//, ""));
      const { record, object } = await readStableVisualArtifact(contextFactory().env, contextFactory().userId, stableId);
      return {
        contents: [{
          uri: uri.href,
          mimeType: record.originalMimeType ?? "application/octet-stream",
          blob: bytesToBase64(await object.arrayBuffer()),
        }],
      };
    },
  );

  server.registerTool("await_paid_job", {
    title: "Wait for durable connector job",
    description: "Long-poll one paid Workflow/Queue job for up to 25 seconds, reducing repeated manual get_job_status calls.",
    inputSchema: {
      jobId: z.string().uuid(),
      maximumWaitSeconds: z.number().int().min(1).max(PAID_LONG_POLL_MAX_SECONDS).default(20),
    },
    annotations: READ_ONLY,
  }, async ({ jobId, maximumWaitSeconds }) => {
    const context = contextFactory();
    try {
      const deadline = Date.now() + maximumWaitSeconds * 1000;
      let record: PaidJobRecord | null = null;
      do {
        record = await getPaidJob(context, jobId);
        if (!record) throw new ConnectorError("job_not_found", "The durable paid job was not found.");
        if (new Set(["completed", "failed", "cancelled"]).has(record.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      return textResult({
        ...record,
        completedWithinWait: record?.status === "completed",
        recommendedNextOperation: record?.status === "completed" ? "get_paid_job_result" : "await_paid_job",
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("get_paid_job_result", {
    title: "Get durable connector job result",
    description: "Return the exact MCP tool result stored in private R2 after a paid Workflow/Queue job completes.",
    inputSchema: { jobId: z.string().uuid() },
    annotations: READ_ONLY,
  }, async ({ jobId }) => {
    try {
      const job = await getPaidJob(contextFactory(), jobId);
      if (!job) throw new ConnectorError("job_not_found", "The durable paid job was not found.");
      return readPaidJobResult(contextFactory().env, job);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("get_integrity_plan_definition", {
    title: "Recover exact integrity-plan definition",
    description: "Read exact durable plan JSON, CSV, request, payload manifest, or one exact CREATE_TEXT/REPLACE_TEXT UTF-8 payload from private R2.",
    inputSchema: {
      planId: z.string().uuid().optional(),
      operationId: z.string().uuid().optional(),
      artifact: z.enum(["plan_json", "plan_csv", "request", "payload_manifest", "payload"]).default("plan_json"),
      actionId: z.string().max(200).optional(),
      startByte: z.number().int().min(0).default(0),
      maxBytes: z.number().int().min(1).max(1_000_000).default(100_000),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    const context = contextFactory();
    try {
      if (!input.planId && !input.operationId) throw new ConnectorError("plan_identifier_required", "Provide planId or operationId.");
      const record = await coordinatorRequest<PaidPlanRecord | null>(context.env, context.userId, "/plans/get", input);
      if (!record) throw new ConnectorError("plan_not_found", "The durable plan record was not found.");
      const key = input.artifact === "payload"
        ? record.artifacts[`payload:${String(input.actionId ?? "")}`]
        : record.artifacts[({ plan_json: "planJson", plan_csv: "planCsv", request: "request", payload_manifest: "payloadManifest" } as Record<string, string>)[input.artifact]];
      if (!key) throw new ConnectorError("artifact_not_found", "The requested plan artifact is not available.");
      const head = await context.env.ARTIFACTS.head(key);
      if (!head) throw new ConnectorError("artifact_not_found", "The requested plan artifact is not available.");
      const offset = Math.min(input.startByte, head.size);
      const length = Math.min(input.maxBytes, Math.max(0, head.size - offset));
      const object = await context.env.ARTIFACTS.get(key, { range: { offset, length } });
      if (!object) throw new ConnectorError("artifact_not_found", "The requested plan artifact is not available.");
      const content = new TextDecoder("utf-8", { fatal: false }).decode(await object.arrayBuffer());
      return textResult({
        planId: record.planId,
        operationId: record.operationId,
        artifact: input.artifact,
        actionId: input.actionId ?? null,
        content,
        startByte: offset,
        returnedBytes: length,
        totalBytes: head.size,
        hasMore: offset + length < head.size,
        exactStoredBytes: true,
        customMetadata: head.customMetadata,
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("list_integrity_plans", {
    title: "List durable integrity plans",
    description: "List recoverable plans including expired, abandoned, superseded, failed and disconnected drafts without guessing plan IDs.",
    inputSchema: {
      state: z.enum(["reserved", "draft", "validated", "running", "completed", "failed", "expired", "abandoned", "superseded"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const records = await coordinatorRequest<PaidPlanRecord[]>(contextFactory().env, contextFactory().userId, "/plans/list", input);
      return textResult({ plans: records, count: records.length });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("abandon_integrity_plan", {
    title: "Formally abandon integrity-plan draft",
    description: "Mark one durable plan as abandoned without deleting the definition or mutating OneDrive. Active leases, reservations and executions are refused.",
    inputSchema: { planId: z.string().uuid(), reason: z.string().min(1).max(1000) },
    annotations: STATEFUL_NON_DESTRUCTIVE,
  }, async ({ planId, reason }) => {
    try {
      await planExecutionInactive(server, planId);
      const record = await coordinatorRequest<PaidPlanRecord | null>(contextFactory().env, contextFactory().userId, "/plans/get", { planId });
      if (!record) throw new ConnectorError("plan_not_found", "The durable plan record was not found.");
      if (record.state === "completed") throw new ConnectorError("plan_completed", "A completed plan cannot be abandoned.");
      const updated = await coordinatorRequest<PaidPlanRecord>(contextFactory().env, contextFactory().userId, "/plans/state", {
        planId,
        state: "abandoned",
        abandonReason: reason,
      });
      return textResult({ ...updated, oneDriveMutationPerformed: false });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("supersede_integrity_plan", {
    title: "Supersede integrity-plan draft",
    description: "Formally link one inactive durable draft to its replacement while retaining both exact definitions and performing no OneDrive mutation.",
    inputSchema: { planId: z.string().uuid(), replacementPlanId: z.string().uuid() },
    annotations: STATEFUL_NON_DESTRUCTIVE,
  }, async ({ planId, replacementPlanId }) => {
    try {
      if (planId === replacementPlanId) throw new ConnectorError("same_plan", "A plan cannot supersede itself.");
      await planExecutionInactive(server, planId);
      const replacement = await coordinatorRequest<PaidPlanRecord | null>(contextFactory().env, contextFactory().userId, "/plans/get", { planId: replacementPlanId });
      if (!replacement) throw new ConnectorError("replacement_plan_not_found", "The replacement plan is not in the durable registry.");
      const updated = await coordinatorRequest<PaidPlanRecord>(contextFactory().env, contextFactory().userId, "/plans/state", {
        planId,
        state: "superseded",
        supersededBy: replacementPlanId,
      });
      return textResult({ ...updated, replacementOperationId: replacement.operationId, oneDriveMutationPerformed: false });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("get_paid_architecture_status", {
    title: "Get paid connector architecture status",
    description: "Check Workflow, Queue, R2, coordinator and Browser Rendering bindings without reading or mutating OneDrive.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => {
    const context = contextFactory();
    try {
      const health = await coordinatorRequest<Record<string, unknown>>(context.env, context.userId, "/health", {});
      const r2Probe = await context.env.ARTIFACTS.list({ limit: 1, prefix: "__health__/" });
      return textResult({
        ready: true,
        workflowBinding: Boolean(context.env.PAID_WORKFLOW),
        queueBinding: Boolean(context.env.PAID_JOBS),
        r2Binding: Boolean(context.env.ARTIFACTS),
        coordinatorBinding: Boolean(context.env.PAID_COORDINATOR),
        browserBinding: Boolean(context.env.BROWSER),
        coordinator: health,
        r2Reachable: Array.isArray(r2Probe.objects),
        architecture: "thin_mcp_gateway -> workflow -> queue -> durable_object + r2 + browser_rendering",
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}
