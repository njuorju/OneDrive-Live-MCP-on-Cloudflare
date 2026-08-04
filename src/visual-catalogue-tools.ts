import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import { ConnectorError } from "./errors";
import { bytesToBase64 } from "./integrated-core";
import {
  coordinatorRequest,
  errorResult,
  getArtifact,
  nowIso,
  putArtifact,
  requestHash,
  textResult,
  type PaidJobRecord,
} from "./paid-core";
import type { HotfixContext } from "./version20-hotfix";
import {
  PREPARED_OUTCOMES,
  type CatalogueFileReference,
  type PreparedOutcome,
  type ReviewOverride,
  type SourceType,
  type VisualResultRecord,
} from "./visual-catalogue-model";
import {
  loadCompilerResults,
  loadReviewPacket,
  readCompilerManifest,
  runVisualCompileWorkflow,
  sendReviewEvent,
  type StartVisualCatalogueInput,
  type VisualWorkflowPayload,
} from "./visual-catalogue-runtime";
import { resolveClassifierSelection } from "./visual-catalogue-opencode";
import {
  readPreparation,
  readPublicationManifest,
  runCommitVisualPublicationWorkflow,
  runPrepareVisualPublicationWorkflow,
  runPublishCachedAssetsWorkflow,
  type CommitVisualPublicationInput,
  type DestinationPolicy,
  type PrepareVisualPublicationInput,
  type PublishCachedAssetsInput,
} from "./visual-catalogue-publication";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const NON_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const MUTATING = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const UUID = z.string().uuid();
const SHA256 = z.string().regex(/^[0-9a-fA-F]{64}$/);

const sourceTypeSchema = z.enum(["academic", "spatial_plan", "donor_report", "design_guideline", "visual_compendium", "presentation", "scan_heavy", "unknown"]);
const outcomeSchema = z.enum(PREPARED_OUTCOMES);
const catalogueRoleSchema = z.enum(["master_csv", "master_json", "rejected_csv", "duplicates_csv", "mapping_json", "status_csv", "exceptions_csv", "report_md", "checkpoint_json", "checkpoint_md"]);

const overrideSchema = z.object({
  stableVisualId: z.string().min(1).max(200),
  outcome: outcomeSchema.optional(),
  conciseDescription: z.string().max(700).optional(),
  visualType: z.string().max(80).optional(),
  pageSeriesId: z.string().max(200).nullable().optional(),
  canonicalVisualId: z.string().max(200).nullable().optional(),
  reviewNote: z.string().max(2000).optional(),
});

function tool(server: McpServer, name: string): any {
  return (server as any)._registeredTools?.[name];
}

async function reserveWorkflowJob(
  context: HotfixContext,
  toolName: string,
  operation: VisualWorkflowPayload["operation"],
  input: Record<string, unknown>,
): Promise<{ job: PaidJobRecord; idempotentReplay: boolean }> {
  const hash = await requestHash(toolName, input);
  const requestedJobId = crypto.randomUUID();
  const requestedWorkflowId = requestedJobId;
  const job = await coordinatorRequest<PaidJobRecord>(context.env, context.userId, "/jobs/begin", {
    jobId: requestedJobId,
    workflowId: requestedWorkflowId,
    toolName,
    requestHash: hash,
  });
  const payload: VisualWorkflowPayload = {
    version: 1,
    operation,
    jobId: job.jobId,
    workflowId: job.workflowId,
    userId: context.userId,
    requestHash: hash,
    input,
    createdAt: nowIso(),
  };
  try {
    await (context.env.VISUAL_CATALOGUE_WORKFLOW as any).create({ id: job.workflowId, params: payload });
  } catch (error) {
    const sample = error instanceof Error ? error.message.toLocaleLowerCase("en") : String(error).toLocaleLowerCase("en");
    if (!/already exists|duplicate|conflict/.test(sample)) throw error;
  }
  return { job, idempotentReplay: job.jobId !== requestedJobId };
}

function boundedResult(record: VisualResultRecord): Record<string, unknown> {
  return {
    candidateId: record.stableVisualId,
    stableVisualId: record.stableVisualId,
    stableKey: record.stableKey,
    pageOrSlide: record.pageOrSlide,
    outcome: record.outcome,
    confidence: record.confidence,
    description: record.conciseDescription,
    visualType: record.visualType,
    seriesId: record.pageSeriesId,
    canonicalVisualId: record.canonicalVisualId,
    disagreement: record.disagreement,
    reviewState: record.reviewState,
    reviewRoutingReason: record.reviewRoutingReason ?? null,
    modelProvider: record.modelProvider,
    model: record.model,
    parserResult: record.parserResult ?? null,
    schemaValidationResult: record.schemaValidationResult ?? null,
    error: record.error,
  };
}

async function boundedCandidateImage(env: Env, record: VisualResultRecord, maxDimension: number, detail: "auto" | "low" | "high"): Promise<{ data: string; mimeType: string }> {
  if (!record.artifactR2Key) throw new ConnectorError("candidate_artifact_missing", "The candidate has no private cached image artifact.");
  const source = await getArtifact(env, record.artifactR2Key);
  const bound = detail === "low" ? Math.min(maxDimension, 1024) : maxDimension;
  const transformed = (env.IMAGES as any).input(source.body).transform({ width: bound, height: bound, fit: "scale-down" });
  const output = await transformed.output({ format: "image/jpeg", quality: detail === "high" ? 92 : 88, anim: false });
  const response = output.response();
  if (!response.ok) throw new ConnectorError("candidate_analysis_render_failed", "The private candidate artifact could not be prepared for analysis.", { retryable: true });
  return { data: bytesToBase64(new Uint8Array(await response.arrayBuffer())), mimeType: "image/jpeg" };
}

export class VisualCatalogueWorkflow extends WorkflowEntrypoint<Env, VisualWorkflowPayload> {
  async run(event: WorkflowEvent<VisualWorkflowPayload>, step: WorkflowStep): Promise<Record<string, unknown>> {
    if (event.payload.operation === "compile") return runVisualCompileWorkflow(this.env, event.payload, step);
    if (event.payload.operation === "prepare") return runPrepareVisualPublicationWorkflow(this.env, event.payload, step);
    if (event.payload.operation === "commit") return runCommitVisualPublicationWorkflow(this.env, event.payload, step);
    if (event.payload.operation === "publish") return runPublishCachedAssetsWorkflow(this.env, event.payload, step);
    throw new ConnectorError("visual_workflow_operation_invalid", "The visual catalogue Workflow operation is invalid.");
  }
}

export function registerVisualCatalogueCompilerTools(server: McpServer, contextFactory: () => HotfixContext): void {
  if (tool(server, "start_visual_catalogue_job")) return;

  server.registerTool("start_visual_catalogue_job", {
    title: "Start durable visual catalogue source job",
    description: "Verify one immutable source, inventory it using source-type routing, cache exact renders or embedded artifacts privately in R2, classify asynchronously, detect visual series, and build a durable review packet without mutating OneDrive catalogues.",
    inputSchema: {
      sourceItemId: z.string().min(1).max(500),
      expectedSourceETag: z.string().min(1).max(1000),
      expectedSourceSha256: SHA256,
      sourceType: sourceTypeSchema.optional(),
      pageStart: z.number().int().min(1).max(500).default(1),
      pageEnd: z.number().int().min(1).max(500).optional(),
      renderFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
      renderWidth: z.number().int().min(256).max(4096).default(1600),
      renderDpi: z.number().int().min(36).max(300).default(144),
      classifierProvider: z.enum(["openai", "opencode_zen", "opencode_go", "opencode_zen_responses", "fixture"]).optional(),
      classifierMode: z.enum(["openai_responses", "openai_batch", "opencode_chat_completions", "opencode_go_chat_completions", "opencode_responses", "fixture"]).optional(),
      model: z.string().min(1).max(100).optional(),
      allowPaidFallback: z.boolean().default(false),
      dataSensitivity: z.enum(["public", "internal", "confidential", "personal", "restricted"]).optional(),
      freeProviderDataPolicyAcknowledged: z.boolean().default(false),
      maxBillableRequests: z.number().int().min(1).max(75).optional(),
      maxEstimatedSpendUsd: z.number().positive().max(1).optional(),
      classifierConcurrency: z.number().int().min(1).max(8).default(2),
      classifierMaxDimension: z.number().int().min(256).max(3000).default(1280),
      classifierJpegQuality: z.number().int().min(1).max(100).default(82),
      rubricVersion: z.string().min(1).max(200).optional(),
      promptVersion: z.string().min(1).max(200).optional(),
      dryRun: z.boolean().default(false),
      autoApproveDryRun: z.boolean().default(false),
      calibrationCheckpointItemId: z.string().min(1).max(500).optional(),
      highConfidenceRejectThreshold: z.number().min(0.5).max(1).default(0.94),
      simulateInterruptAfterRenderingOnce: z.boolean().default(false),
    },
    annotations: NON_DESTRUCTIVE,
  }, async (raw) => {
    const context = contextFactory();
    try {
      const input = raw as StartVisualCatalogueInput;
      const selection = resolveClassifierSelection(input, context.env);
      const reserved = await reserveWorkflowJob(context, "start_visual_catalogue_job", "compile", input as unknown as Record<string, unknown>);
      return textResult({
        jobId: reserved.job.jobId,
        workflowId: reserved.job.workflowId,
        status: reserved.job.status,
        stage: reserved.job.stage,
        asynchronous: true,
        idempotentReplay: reserved.idempotentReplay,
        dryRun: Boolean(input.dryRun),
        sourceItemId: input.sourceItemId,
        exactSourceETag: input.expectedSourceETag,
        exactSourceSha256: input.expectedSourceSha256.toLowerCase(),
        classifierProvider: selection.provider,
        classifierMode: selection.mode,
        model: selection.model,
        allowPaidFallback: selection.allowPaidFallback,
        recommendedNextOperation: "get_visual_catalogue_job",
        oneDriveMutationPerformed: false,
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("get_visual_catalogue_job", {
    title: "Get durable visual catalogue job",
    description: "Return bounded durable status, progress, metrics, preparation identifiers, commit state, or cached publication results for one visual catalogue Workflow job.",
    inputSchema: { jobId: UUID },
    annotations: READ_ONLY,
  }, async ({ jobId }) => {
    const context = contextFactory();
    try {
      const job = await coordinatorRequest<PaidJobRecord | null>(context.env, context.userId, "/jobs/get", { jobId });
      if (!job) throw new ConnectorError("job_not_found", "The visual catalogue job was not found.");
      let detail: Record<string, unknown> | null = null;
      try {
        detail = await readCompilerManifest(context.env, jobId) as unknown as Record<string, unknown>;
      } catch {
        try { detail = await readPublicationManifest(context.env, jobId) as unknown as Record<string, unknown>; }
        catch { detail = null; }
      }
      const bounded = detail ? {
        operation: detail.operation,
        status: detail.status,
        stage: detail.stage,
        source: detail.source ?? null,
        sourceType: detail.sourceType ?? null,
        routingMode: detail.routingMode ?? null,
        counts: detail.resultCounts ?? null,
        classifierProvider: detail.classifierProvider ?? null,
        providerPolicyReceipt: detail.providerPolicyReceipt ?? null,
        providerCapabilities: detail.providerCapabilities ?? null,
        calibration: detail.calibration ?? null,
        metrics: detail.metrics ?? null,
        approvalFingerprint: detail.approvalFingerprint ?? null,
        approvedFingerprint: detail.approvedFingerprint ?? null,
        preparationId: detail.preparationId ?? null,
        preparationFingerprint: detail.preparationFingerprint ?? null,
        error: detail.error ?? detail.errors ?? null,
      } : null;
      return textResult({ ...job, architecture: "visual_catalogue_workflow_r2", detail: bounded, recommendedNextOperation: job.status === "completed" ? null : "get_visual_catalogue_job" });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("get_visual_catalogue_review_packet", {
    title: "Get visual catalogue review packet",
    description: "Return a compact bounded review summary and labelled contact sheet for review-required candidates, disagreements, low-confidence rejects, proposed series merges, and deterministic samples.",
    inputSchema: {
      jobId: UUID,
      outcomeFilter: z.array(outcomeSchema).max(PREPARED_OUTCOMES.length).optional(),
      confidenceThreshold: z.number().min(0).max(1).optional(),
      pageStart: z.number().int().min(1).max(500).optional(),
      pageEnd: z.number().int().min(1).max(500).optional(),
      disagreementOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(64).default(32),
    },
    annotations: READ_ONLY,
  }, async ({ jobId, outcomeFilter, confidenceThreshold, pageStart, pageEnd, disagreementOnly, limit }) => {
    const context = contextFactory();
    try {
      const manifest = await readCompilerManifest(context.env, jobId);
      if (!manifest.source || !manifest.reviewPacketKey) throw new ConnectorError("review_packet_not_ready", "The visual catalogue review packet is not ready.");
      const packet = await loadReviewPacket(context.env, manifest);
      const results = await loadCompilerResults(context.env, manifest);
      const allowed = outcomeFilter?.length ? new Set(outcomeFilter as PreparedOutcome[]) : null;
      const selected = results.filter((record) => {
        if (allowed && !allowed.has(record.outcome)) return false;
        if (confidenceThreshold !== undefined && record.confidence > confidenceThreshold) return false;
        if (pageStart !== undefined && (record.pageOrSlide ?? 0) < pageStart) return false;
        if (pageEnd !== undefined && (record.pageOrSlide ?? Number.MAX_SAFE_INTEGER) > pageEnd) return false;
        if (disagreementOnly && !record.disagreement) return false;
        return packet.reviewVisualIds.includes(record.stableVisualId) || packet.deterministicSampleVisualIds.includes(record.stableVisualId);
      }).slice(0, limit);
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{
        type: "text",
        text: JSON.stringify({
          source: packet.source,
          countsByOutcome: packet.outcomeCounts,
          confidenceDistribution: packet.confidenceBuckets,
          series: packet.series,
          disagreements: packet.disagreements,
          errors: packet.errors,
          decisionSummary: selected.map(boundedResult),
          approvalFingerprint: packet.approvalFingerprint,
          totalReviewCandidates: packet.reviewVisualIds.length,
          returnedItems: selected.length,
          contactSheetScope: "all review-required candidates plus deterministic sample",
          candidateFetchTool: "fetch_visual_catalogue_candidate_for_analysis",
          reviewInstructions: packet.reviewInstructions ?? "Open difficult candidates individually using jobId and candidateId.",
        }, null, 2),
      }];
      if (manifest.contactSheetKey) {
        const object = await getArtifact(context.env, manifest.contactSheetKey);
        const bytes = new Uint8Array(await object.arrayBuffer());
        content.push({ type: "image", data: bytesToBase64(bytes), mimeType: object.httpMetadata?.contentType ?? "image/png" });
      }
      return {
        structuredContent: {
          jobId,
          source: packet.source,
          countsByOutcome: packet.outcomeCounts,
          confidenceDistribution: packet.confidenceBuckets,
          series: packet.series,
          disagreements: packet.disagreements,
          errors: packet.errors,
          decisionSummary: selected.map(boundedResult),
          approvalFingerprint: packet.approvalFingerprint,
          returnedItems: selected.length,
          candidateFetchTool: "fetch_visual_catalogue_candidate_for_analysis",
          reviewInstructions: packet.reviewInstructions ?? "Open difficult candidates individually using jobId and candidateId.",
        },
        content,
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("fetch_visual_catalogue_candidate_for_analysis", {
    title: "Fetch visual catalogue candidate for analysis",
    description: "Return actual bounded image content for one difficult compiler candidate, and optionally adjacent members of its proposed series, directly from private R2 without exposing object URLs or mutating OneDrive.",
    inputSchema: {
      jobId: UUID,
      candidateId: z.string().min(1).max(200),
      maxDimension: z.number().int().min(256).max(3000).default(2000),
      detail: z.enum(["auto", "low", "high"]).default("auto"),
      includeAdjacentSeriesMembers: z.boolean().default(false),
    },
    annotations: READ_ONLY,
  }, async ({ jobId, candidateId, maxDimension, detail, includeAdjacentSeriesMembers }) => {
    const context = contextFactory();
    try {
      const manifest = await readCompilerManifest(context.env, jobId);
      const results = await loadCompilerResults(context.env, manifest);
      const selected = results.find((record) => record.stableVisualId === candidateId);
      if (!selected) throw new ConnectorError("candidate_not_found", "The candidate does not belong to this visual catalogue job.");
      const members = includeAdjacentSeriesMembers && selected.pageSeriesId
        ? results.filter((record) => record.pageSeriesId === selected.pageSeriesId).sort((left, right) => Number(left.pageOrSlide ?? 0) - Number(right.pageOrSlide ?? 0)).slice(0, 4)
        : [selected];
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{
        type: "text",
        text: JSON.stringify({
          jobId,
          requestedCandidateId: candidateId,
          returnedCandidates: members.map(boundedResult),
          privateCacheOnly: true,
          oneDriveMutationPerformed: false,
        }, null, 2),
      }];
      for (const member of members) content.push({ type: "image", ...(await boundedCandidateImage(context.env, member, maxDimension, detail)) });
      const auditId = crypto.randomUUID();
      await putArtifact(context.env, `visual-compiler/jobs/${jobId}/review-audit/${auditId}.json`, JSON.stringify({
        version: 1,
        auditId,
        jobId,
        candidateId,
        returnedCandidateIds: members.map((record) => record.stableVisualId),
        detail,
        maxDimension,
        occurredAt: nowIso(),
      }), "application/json; charset=utf-8", { jobId, candidateId, auditId });
      return {
        structuredContent: {
          jobId,
          requestedCandidateId: candidateId,
          returnedCandidates: members.map(boundedResult),
          auditId,
          privateCacheOnly: true,
          oneDriveMutationPerformed: false,
        },
        content,
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("apply_visual_catalogue_review", {
    title: "Apply explicit visual catalogue review",
    description: "Validate the immutable review fingerprint, store bounded decision overrides, and deliver one explicit approval event to the waiting source-level Workflow. This does not mutate OneDrive catalogues.",
    inputSchema: {
      jobId: UUID,
      approvalFingerprint: SHA256,
      overrides: z.array(overrideSchema).max(500).default([]),
      approvedBy: z.string().min(1).max(300),
    },
    annotations: NON_DESTRUCTIVE,
  }, async ({ jobId, approvalFingerprint, overrides, approvedBy }) => {
    const context = contextFactory();
    try {
      const manifest = await readCompilerManifest(context.env, jobId);
      if (manifest.status !== "awaiting_review") throw new ConnectorError("review_not_waiting", "The compiler job is not waiting for review.");
      if (manifest.approvalFingerprint !== approvalFingerprint.toLowerCase()) throw new ConnectorError("approval_fingerprint_changed", "The supplied approval fingerprint does not match the immutable review packet.");
      await sendReviewEvent(context.env, manifest, { approvalFingerprint: approvalFingerprint.toLowerCase(), overrides: overrides as ReviewOverride[], approvedBy });
      return textResult({ jobId, approvalFingerprint: approvalFingerprint.toLowerCase(), overridesAccepted: overrides.length, reviewEventDelivered: true, oneDriveMutationPerformed: false, recommendedNextOperation: "get_visual_catalogue_job" });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("prepare_visual_catalogue_publication", {
    title: "Prepare exact visual catalogue publication",
    description: "Read all controlled catalogue files server-side, verify exact eTags and schemas, apply one approved durable result, generate exact target bytes privately in R2, and validate parity and reconciliation without mutating OneDrive.",
    inputSchema: {
      classificationJobId: UUID,
      approvalFingerprint: SHA256,
      catalogueFiles: z.array(z.object({
        role: catalogueRoleSchema,
        itemId: z.string().min(1).max(500),
        expectedETag: z.string().min(1).max(1000),
      })).min(9).max(10),
      destinationPolicy: z.object({
        adapter: z.literal("uca_visual_v4"),
        outputBasePath: z.string().min(1).max(1000),
        sourceTitle: z.string().max(500).optional(),
        moduleRelevance: z.string().max(500).optional(),
        allowPendingAssets: z.boolean().default(false),
        deterministicFilenamePrefix: z.string().max(120).optional(),
      }),
    },
    annotations: NON_DESTRUCTIVE,
  }, async (raw) => {
    const context = contextFactory();
    try {
      const input = raw as PrepareVisualPublicationInput;
      const reserved = await reserveWorkflowJob(context, "prepare_visual_catalogue_publication", "prepare", input as unknown as Record<string, unknown>);
      return textResult({ preparationJobId: reserved.job.jobId, workflowId: reserved.job.workflowId, status: reserved.job.status, asynchronous: true, idempotentReplay: reserved.idempotentReplay, classificationJobId: input.classificationJobId, approvalFingerprint: input.approvalFingerprint.toLowerCase(), exactTargetBytesWillBeStoredPrivately: true, oneDriveMutationPerformed: false, recommendedNextOperation: "get_visual_catalogue_job" });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("commit_visual_catalogue_publication", {
    title: "Commit exact visual catalogue publication",
    description: "Commit one immutable preparation through exact eTag preconditions, fenced durable Workflow state, exact R2 target bytes, post-write SHA-256 verification, reverse-order rollback, and final reconciliation.",
    inputSchema: {
      preparationId: z.string().regex(/^vprep_[0-9a-f]{48}$/),
      preparationFingerprint: SHA256,
      explicitApproval: z.literal(true),
      callerOwnership: z.object({
        ownerType: z.enum(["interactive", "scheduled_task", "system_recovery"]),
        ownerId: z.string().min(1).max(200),
        invocationId: UUID,
        correlationId: z.string().min(1).max(200),
      }),
      injectFailureAfterWrites: z.number().int().min(1).max(10).optional(),
    },
    annotations: MUTATING,
  }, async (raw) => {
    const context = contextFactory();
    try {
      const input = raw as CommitVisualPublicationInput;
      const definition = await readPreparation(context.env, input.preparationId);
      if (definition.fingerprint !== input.preparationFingerprint.toLowerCase()) throw new ConnectorError("preparation_fingerprint_changed", "The preparation fingerprint does not match the immutable stored definition.");
      const reserved = await reserveWorkflowJob(context, "commit_visual_catalogue_publication", "commit", input as unknown as Record<string, unknown>);
      return textResult({ commitJobId: reserved.job.jobId, workflowId: reserved.job.workflowId, status: reserved.job.status, asynchronous: true, idempotentReplay: reserved.idempotentReplay, preparationId: input.preparationId, preparationFingerprint: input.preparationFingerprint.toLowerCase(), explicitApproval: true, rollbackEnabled: true, recommendedNextOperation: "get_visual_catalogue_job" });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("publish_cached_visual_assets", {
    title: "Publish approved cached visual assets",
    description: "Promote exact private R2 render artifacts or deterministic stitched series to OneDrive without rerendering or reconverting the source, with conflict-fail semantics and exact read-back verification.",
    inputSchema: {
      classificationJobId: UUID,
      approvedFingerprint: SHA256,
      selectedCanonicalVisualIds: z.array(z.string().min(1).max(200)).max(500).optional(),
      selectedSeriesIds: z.array(z.string().min(1).max(200)).max(500).optional(),
      destinationPath: z.string().min(1).max(1000),
      filenamePolicy: z.object({
        prefix: z.string().max(120).optional(),
        includePage: z.boolean().default(true),
        includeStableKey: z.boolean().default(true),
      }).optional(),
      exactSourceETag: z.string().min(1).max(1000),
      exactSourceSha256: SHA256,
    },
    annotations: MUTATING,
  }, async (raw) => {
    const context = contextFactory();
    try {
      const input = raw as PublishCachedAssetsInput;
      const reserved = await reserveWorkflowJob(context, "publish_cached_visual_assets", "publish", input as unknown as Record<string, unknown>);
      return textResult({ publicationJobId: reserved.job.jobId, workflowId: reserved.job.workflowId, status: reserved.job.status, asynchronous: true, idempotentReplay: reserved.idempotentReplay, classificationJobId: input.classificationJobId, sourceRerendered: false, conflictPolicy: "fail", recommendedNextOperation: "get_visual_catalogue_job" });
    } catch (error) {
      return errorResult(error);
    }
  });
}
