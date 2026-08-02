import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkflowStep } from "cloudflare:workers";
import { ConnectorError } from "./errors";
import { extensionOf, validateFileSignature } from "./file-types";
import { graphFetchBytes, verifyItemInsideRoot } from "./graph-core";
import { base64ToBytes, bytesToBase64, sha256Bytes } from "./integrated-core";
import { registerIntegratedToolsWithQuietPdfJsHotfix } from "./pdfjs-final-registration";
import {
  canonicalJson,
  coordinatorRequest,
  getArtifact,
  nowIso,
  putArtifact,
  sha256HexUtf8,
  type PaidJobRecord,
} from "./paid-core";
import { createIntegratedStateStorage } from "./version20-hotfix";
import {
  VISUAL_COMPILER_VERSION,
  VISUAL_PROMPT_VERSION,
  VISUAL_RENDERER_VERSION,
  VISUAL_RUBRIC_VERSION,
  applyReviewOverrides,
  applySeries,
  boundedConfidence,
  confidenceBuckets,
  detectVisualSeries,
  deterministicPageHeuristic,
  enforceFalseRejectProtection,
  inferSourceType,
  outcomeCounts,
  renderCacheIdentity,
  requiresSecondPass,
  reviewFingerprint,
  routeForSource,
  selectReviewVisuals,
  type ClassificationProposal,
  type PreparedOutcome,
  type RenderArtifactManifest,
  type ReviewOverride,
  type ReviewPacketSummary,
  type RoutingMode,
  type SeriesRecord,
  type SourceIdentity,
  type SourceType,
  type VisualCandidate,
  type VisualResultRecord,
} from "./visual-catalogue-model";

export type ClassifierMode = "openai_responses" | "openai_batch" | "fixture";

export type StartVisualCatalogueInput = {
  sourceItemId: string;
  expectedSourceETag: string;
  expectedSourceSha256: string;
  sourceType?: SourceType;
  pageStart?: number;
  pageEnd?: number;
  renderFormat?: "png" | "jpeg" | "webp";
  renderWidth?: number;
  renderDpi?: number;
  classifierMode?: ClassifierMode;
  model?: string;
  rubricVersion?: string;
  promptVersion?: string;
  dryRun?: boolean;
  autoApproveDryRun?: boolean;
  calibrationCheckpointItemId?: string;
  highConfidenceRejectThreshold?: number;
  simulateInterruptAfterRenderingOnce?: boolean;
};

export type VisualWorkflowPayload = {
  version: 1;
  operation: "compile" | "prepare" | "commit" | "publish";
  jobId: string;
  workflowId: string;
  userId: string;
  requestHash: string;
  input: Record<string, unknown>;
  createdAt: string;
};

export type CompilerMetrics = {
  inventoriedCandidates: number;
  renderedArtifacts: number;
  embeddedArtifacts: number;
  cacheHits: number;
  renderMisses: number;
  classifierRequests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  startedAt: string;
  completedAt: string | null;
  elapsedMilliseconds: number | null;
};

export type CompilerJobManifest = {
  version: 1;
  compilerVersion: string;
  jobId: string;
  workflowId: string;
  userIdHash: string;
  operation: "compile";
  status: "running" | "awaiting_review" | "completed" | "failed";
  stage: string;
  source: SourceIdentity | null;
  sourceType: SourceType | null;
  routingMode: RoutingMode | null;
  input: StartVisualCatalogueInput;
  candidatesKey: string | null;
  resultsKey: string | null;
  approvedResultsKey: string | null;
  seriesKey: string | null;
  reviewPacketKey: string | null;
  contactSheetKey: string | null;
  approvalFingerprint: string | null;
  approvedFingerprint: string | null;
  resultCounts: Record<PreparedOutcome, number> | null;
  metrics: CompilerMetrics;
  errors: Array<{ stage: string; code: string; message: string }>;
  createdAt: string;
  updatedAt: string;
};

type GoldDecision = {
  stableKey: string;
  outcome: PreparedOutcome;
  description: string;
  knownRetained: boolean;
};

type OpenAIUsage = { inputTokens: number; outputTokens: number };

type ClassifiedCandidate = {
  proposal: ClassificationProposal;
  usage: OpenAIUsage;
};

const OPENAI_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.2-2025-12-11";
const MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const MAX_BATCH_ITEMS = 40;
const RESULT_MIME = "application/vnd.onedrive-live.visual-compiler+json";

function compilerPrefix(jobId: string): string {
  return `visual-compiler/jobs/${jobId}`;
}

function compilerManifestKey(jobId: string): string {
  return `${compilerPrefix(jobId)}/manifest.json`;
}

function candidateKey(jobId: string): string {
  return `${compilerPrefix(jobId)}/candidates.json`;
}

function resultsKey(jobId: string): string {
  return `${compilerPrefix(jobId)}/results.json`;
}

function approvedResultsKey(jobId: string): string {
  return `${compilerPrefix(jobId)}/results-approved.json`;
}

function seriesKey(jobId: string): string {
  return `${compilerPrefix(jobId)}/series.json`;
}

function reviewKey(jobId: string): string {
  return `${compilerPrefix(jobId)}/review-packet.json`;
}

function contactSheetKey(jobId: string): string {
  return `${compilerPrefix(jobId)}/review-contact-sheet.png`;
}

async function storeJson(env: Env, key: string, value: unknown, metadata: Record<string, string> = {}): Promise<void> {
  await putArtifact(env, key, JSON.stringify(value, null, 2), "application/json; charset=utf-8", metadata);
}

async function readJson<T>(env: Env, key: string): Promise<T> {
  return JSON.parse(await (await getArtifact(env, key)).text()) as T;
}

async function updateJob(env: Env, userId: string, jobId: string, patch: Partial<PaidJobRecord>): Promise<PaidJobRecord> {
  return coordinatorRequest<PaidJobRecord>(env, userId, "/jobs/update", { jobId, ...patch });
}

export async function readCompilerManifest(env: Env, jobId: string): Promise<CompilerJobManifest> {
  return readJson<CompilerJobManifest>(env, compilerManifestKey(jobId));
}

async function writeManifest(env: Env, manifest: CompilerJobManifest): Promise<void> {
  manifest.updatedAt = nowIso();
  await storeJson(env, compilerManifestKey(manifest.jobId), manifest, {
    jobId: manifest.jobId,
    operation: manifest.operation,
    status: manifest.status,
    stage: manifest.stage,
  });
}

function asCompilerError(error: unknown): { code: string; message: string; retryable: boolean } {
  const value = error as { code?: string; message?: string; retryable?: boolean };
  return {
    code: String(value?.code ?? "visual_compiler_failed"),
    message: error instanceof Error ? error.message : String(value?.message ?? error),
    retryable: Boolean(value?.retryable),
  };
}

async function rawToolServer(env: Env, userId: string): Promise<McpServer> {
  const server = new McpServer({ name: "OneDrive visual catalogue compiler", version: VISUAL_COMPILER_VERSION });
  registerIntegratedToolsWithQuietPdfJsHotfix(server, () => ({
    env,
    userId,
    storage: createIntegratedStateStorage(env, userId),
  }));
  return server;
}

async function invokeRawTool(
  env: Env,
  userId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = await rawToolServer(env, userId);
  const registered = (server as any)._registeredTools?.[name];
  if (!registered?.handler) throw new ConnectorError("compiler_dependency_missing", `The required ${name} tool is not registered.`);
  const result = await registered.handler(input, {}) as CallToolResult;
  if (!result.isError) return result;
  const error = (result.structuredContent as { error?: Record<string, unknown> } | undefined)?.error;
  throw new ConnectorError(
    String(error?.code ?? "compiler_dependency_failed"),
    String(error?.message ?? `${name} failed.`),
    { retryable: Boolean(error?.retryable), details: error?.details as Record<string, unknown> | undefined },
  );
}

function stableVisualId(sourceSha256: string, stableKey: string): Promise<string> {
  return sha256HexUtf8(canonicalJson({ version: 1, sourceSha256, stableKey })).then((hash) => `vis_${hash.slice(0, 48)}`);
}

function pdfPageCount(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  const direct = [...text.matchAll(/\/Type\s*\/Page\b/g)].length;
  const treeCounts = [...text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,500}?\/Count\s+(\d+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  const count = Math.max(direct, ...treeCounts, 1);
  return Math.min(500, count);
}

function mimeForFormat(format: string): string {
  return format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}

function extensionForFormat(format: string): string {
  return format === "jpeg" ? "jpg" : format;
}

async function inventoryPdf(
  env: Env,
  source: SourceIdentity,
  bytes: Uint8Array,
  sourceType: SourceType,
  pageStart: number,
  pageEnd: number,
): Promise<{ candidates: VisualCandidate[]; pageCount: number; embeddedCount: number }> {
  const pageCount = pdfPageCount(bytes);
  const boundedStart = Math.min(Math.max(pageStart, 1), pageCount);
  const boundedEnd = Math.min(Math.max(pageEnd, boundedStart), pageCount);
  const route = routeForSource(sourceType);
  const candidates: VisualCandidate[] = [];
  let embeddedCount = 0;

  if (route === "embedded_first") {
    const binary = new TextDecoder("latin1").decode(bytes);
    const pattern = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
    for (const match of binary.matchAll(pattern)) {
      const body = match[3];
      if (!/\/Subtype\s*\/Image\b/.test(body) || !/\/DCTDecode\b/.test(body)) continue;
      const stream = /stream\r?\n/.exec(body);
      const end = body.lastIndexOf("endstream");
      if (!stream || end <= stream.index) continue;
      const absolute = Number(match.index ?? 0) + match[0].indexOf(body);
      const startOffset = absolute + stream.index + stream[0].length;
      const endOffset = absolute + end;
      if (startOffset < 0 || endOffset <= startOffset || endOffset > bytes.byteLength) continue;
      const original = bytes.slice(startOffset, endOffset);
      if (original.byteLength < 512 || original[0] !== 0xff || original[1] !== 0xd8) continue;
      const stableKey = `pdf:image:${match[1]}:${match[2]}`;
      const visualId = await stableVisualId(source.sha256, stableKey);
      const sha256 = await sha256Bytes(original);
      const artifactId = `embedded_${sha256.slice(0, 48)}`;
      const r2Key = `visual-cache/${source.sha256}/embedded/${sha256}.jpg`;
      if (!await env.ARTIFACTS.head(r2Key)) {
        await putArtifact(env, r2Key, original, "image/jpeg", {
          sourceSha256: source.sha256,
          sourceItemId: source.itemId,
          stableKey,
          sha256,
          artifactId,
        });
      }
      candidates.push({
        stableVisualId: visualId,
        stableKey,
        pageOrSlide: null,
        parentPages: [],
        relationship: "embedded_object",
        renderRequired: false,
        embeddedArtifactId: artifactId,
        embeddedArtifactKey: r2Key,
        embeddedSha256: sha256,
        caption: null,
        heading: null,
        nearbyText: null,
      });
      embeddedCount += 1;
      if (embeddedCount >= 1000) break;
    }
  }

  if (route !== "embedded_first" || embeddedCount === 0) {
    for (let page = boundedStart; page <= boundedEnd; page += 1) {
      const stableKey = `pdf:page:${page}`;
      candidates.push({
        stableVisualId: await stableVisualId(source.sha256, stableKey),
        stableKey,
        pageOrSlide: page,
        parentPages: [page],
        relationship: "page",
        renderRequired: true,
        embeddedArtifactId: null,
        embeddedArtifactKey: null,
        embeddedSha256: null,
        caption: null,
        heading: null,
        nearbyText: null,
      });
    }
  }
  return { candidates, pageCount, embeddedCount };
}

async function inventoryOffice(
  env: Env,
  userId: string,
  source: SourceIdentity,
  sourceType: SourceType,
  pageStart: number,
  pageEnd: number,
): Promise<{ candidates: VisualCandidate[]; pageCount: number; embeddedCount: number }> {
  const result = await invokeRawTool(env, userId, "list_document_visuals", { itemId: source.itemId, cursor: 0, limit: 200 });
  const structured = result.structuredContent as Record<string, unknown>;
  const pageCount = Math.max(1, Number(structured.pageOrSlideCount ?? 1));
  const route = routeForSource(sourceType);
  const raw = Array.isArray(structured.results) ? structured.results as Record<string, unknown>[] : [];
  const candidates: VisualCandidate[] = [];
  let embeddedCount = 0;
  if (route === "embedded_first") {
    for (const item of raw.filter((entry) => entry.exactOriginalAvailable === true)) {
      const stableKey = String(item.visualKey ?? "");
      if (!stableKey) continue;
      const visualId = String(item.visualId ?? await stableVisualId(source.sha256, stableKey));
      candidates.push({
        stableVisualId: visualId,
        stableKey,
        pageOrSlide: Number.isInteger(Number(item.pageOrSlide)) ? Number(item.pageOrSlide) : null,
        parentPages: Array.isArray(item.parentPages) ? item.parentPages.map(Number).filter(Number.isInteger) : [],
        relationship: "embedded_object",
        renderRequired: false,
        embeddedArtifactId: null,
        embeddedArtifactKey: null,
        embeddedSha256: typeof item.embeddedSha256 === "string" ? item.embeddedSha256 : null,
        caption: typeof item.caption === "string" ? item.caption : null,
        heading: typeof item.nearbyHeading === "string" ? item.nearbyHeading : null,
        nearbyText: null,
      });
      embeddedCount += 1;
    }
  }
  if (route !== "embedded_first" || embeddedCount === 0) {
    const start = Math.min(Math.max(pageStart, 1), pageCount);
    const end = Math.min(Math.max(pageEnd, start), pageCount);
    for (let page = start; page <= end; page += 1) {
      const stableKey = sourceType === "presentation" ? `slide:${page}` : `page:${page}`;
      candidates.push({
        stableVisualId: await stableVisualId(source.sha256, stableKey),
        stableKey,
        pageOrSlide: page,
        parentPages: [page],
        relationship: sourceType === "presentation" ? "slide" : "page",
        renderRequired: true,
        embeddedArtifactId: null,
        embeddedArtifactKey: null,
        embeddedSha256: null,
        caption: null,
        heading: null,
        nearbyText: null,
      });
    }
  }
  return { candidates, pageCount, embeddedCount };
}

async function renderAndCache(
  env: Env,
  userId: string,
  source: SourceIdentity,
  candidate: VisualCandidate,
  format: "png" | "jpeg" | "webp",
  width: number,
  dpi: number,
): Promise<RenderArtifactManifest> {
  const identity = await renderCacheIdentity({
    sourceSha256: source.sha256,
    stableKey: candidate.stableKey,
    outputFormat: format,
    width,
    dpi,
    crop: null,
    rendererVersion: VISUAL_RENDERER_VERSION,
  });
  const metadataKey = `${identity.r2Key}.manifest.json`;
  const existing = await env.ARTIFACTS.head(identity.r2Key);
  const existingMetadata = await env.ARTIFACTS.head(metadataKey);
  if (existing && existingMetadata) {
    const manifest = await readJson<RenderArtifactManifest>(env, metadataKey);
    if (manifest.renderArtifactId === identity.renderArtifactId && manifest.sha256 === existing.customMetadata?.sha256) {
      return { ...manifest, cacheHit: true };
    }
  }
  const result = await invokeRawTool(env, userId, "render_document_page", {
    itemId: source.itemId,
    pageOrSlide: candidate.pageOrSlide ?? 1,
    outputFormat: format,
    width,
    dpi,
    transparentBackground: false,
  });
  const image = result.content.find((entry) => entry.type === "image") as { type: "image"; data: string; mimeType: string } | undefined;
  if (!image?.data) throw new ConnectorError("render_invalid", "The durable renderer returned no image bytes.", { retryable: true });
  const bytes = base64ToBytes(image.data);
  if (bytes.byteLength < 512) throw new ConnectorError("render_blank", "The rendered artifact is implausibly small.");
  const filename = `${candidate.stableKey.replace(/[^A-Za-z0-9_.-]+/g, "-")}.${extensionForFormat(format)}`;
  const signature = validateFileSignature(filename, bytes.slice().buffer, image.mimeType);
  if (!signature.compatible) throw new ConnectorError("render_malformed", "The rendered artifact signature is invalid.");
  const structured = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent as Record<string, unknown> : {};
  const renderedPage = Number(structured.requestedPageOrSlide ?? structured.pageOrSlide ?? candidate.pageOrSlide);
  if (candidate.pageOrSlide !== null && renderedPage !== candidate.pageOrSlide) throw new ConnectorError("render_page_mismatch", "The renderer returned a different page or slide.");
  const artifactSha256 = await sha256Bytes(bytes);
  const artifact: RenderArtifactManifest = {
    renderArtifactId: identity.renderArtifactId,
    cacheKey: identity.fingerprint,
    r2Key: identity.r2Key,
    sha256: artifactSha256,
    byteSize: bytes.byteLength,
    width: Math.max(1, Number(structured.width ?? width)),
    height: Math.max(1, Number(structured.height ?? 1)),
    format,
    mimeType: image.mimeType || mimeForFormat(format),
    cacheHit: false,
    createdAt: nowIso(),
  };
  await putArtifact(env, identity.r2Key, bytes, artifact.mimeType, {
    sourceSha256: source.sha256,
    sourceItemId: source.itemId,
    stableKey: candidate.stableKey,
    sha256: artifactSha256,
    renderArtifactId: identity.renderArtifactId,
    rendererVersion: VISUAL_RENDERER_VERSION,
  });
  await storeJson(env, metadataKey, artifact, { renderArtifactId: identity.renderArtifactId, sha256: artifactSha256 });
  return artifact;
}

async function calibrationGold(
  env: Env,
  userId: string,
  itemId: string | undefined,
): Promise<Map<string, GoldDecision>> {
  const decisions = new Map<string, GoldDecision>();
  if (!itemId) return decisions;
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder) throw new ConnectorError("calibration_invalid", "The calibration checkpoint is not a file.");
  const bytes = new Uint8Array(await graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(itemId)}/content`, 10 * 1024 * 1024));
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
  const pageOutcomes = Array.isArray(parsed.page_outcomes)
    ? parsed.page_outcomes
    : Array.isArray((parsed.source as Record<string, unknown> | undefined)?.page_outcomes)
      ? (parsed.source as Record<string, unknown>).page_outcomes
      : [];
  for (const raw of pageOutcomes as Record<string, unknown>[]) {
    const stableKey = String(raw.key ?? raw.stable_visual_key ?? "");
    if (!stableKey) continue;
    const original = String(raw.outcome ?? "");
    const outcome: PreparedOutcome = original === "reject"
      ? "reject"
      : original === "duplicate" || original === "duplicate_context_only"
        ? "duplicate_context_only"
        : original === "retain_provisional"
          ? "retain_provisional"
          : "retain_canonical";
    decisions.set(stableKey, {
      stableKey,
      outcome,
      description: String(raw.description ?? raw.reason ?? "Controlled calibration decision."),
      knownRetained: outcome === "retain_canonical" || outcome === "retain_provisional",
    });
  }
  return decisions;
}

function classificationSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "outcome", "confidence", "visual_type", "concise_description", "retain_rationale", "reject_rationale",
      "reusable_visual_structure", "continuation_likely", "continuation_title",
    ],
    properties: {
      outcome: { type: "string", enum: ["retain_canonical", "retain_provisional", "reject", "duplicate_context_only", "needs_review"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      visual_type: { type: "string", maxLength: 80 },
      concise_description: { type: "string", maxLength: 700 },
      retain_rationale: { type: ["string", "null"], maxLength: 1000 },
      reject_rationale: { type: ["string", "null"], maxLength: 1000 },
      reusable_visual_structure: { type: "boolean" },
      continuation_likely: { type: "boolean" },
      continuation_title: { type: ["string", "null"], maxLength: 300 },
    },
  };
}

function classifierPrompt(input: {
  source: SourceIdentity;
  sourceType: SourceType;
  routingMode: RoutingMode;
  candidate: VisualCandidate;
  deterministicReason: string | null;
  adjacent: Array<{ stableKey: string; pageOrSlide: number | null; description?: string }>;
  secondPass: boolean;
}): string {
  return [
    "Classify one candidate for a controlled resilience-planning visual library.",
    "False rejection is the higher-cost error. Use needs_review whenever uncertain.",
    "Retain maps, plans, diagrams, frameworks, charts, implementation compositions, evidence-rich photographs, and reusable spatial or process compositions.",
    "Reject blank, branding-only, credits, contents, text-only, and generic decorative pages unless they contain independently reusable evidence.",
    "Mark duplicate_context_only when a page only contextualizes an already represented canonical asset.",
    "A continuation page can be retained now; series resolution is a later pass.",
    `Source type: ${input.sourceType}. Routing mode: ${input.routingMode}.`,
    `Source: ${input.source.filename}. Candidate: ${input.candidate.stableKey}. Page/slide: ${input.candidate.pageOrSlide ?? "n/a"}.`,
    input.candidate.caption ? `Caption: ${input.candidate.caption}` : "",
    input.candidate.heading ? `Heading: ${input.candidate.heading}` : "",
    input.candidate.nearbyText ? `Nearby text: ${input.candidate.nearbyText.slice(0, 5000)}` : "",
    input.deterministicReason ? `Deterministic signal: ${input.deterministicReason}` : "",
    input.adjacent.length ? `Adjacent context: ${JSON.stringify(input.adjacent)}` : "",
    input.secondPass ? "This is a conservative second pass. Reconsider any possible reusable visual structure or continuation." : "",
  ].filter(Boolean).join("\n");
}

function responseText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  const output = Array.isArray(body.output) ? body.output as Record<string, unknown>[] : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content as Record<string, unknown>[] : [];
    for (const entry of content) if (typeof entry.text === "string") return entry.text;
  }
  throw new ConnectorError("classifier_output_missing", "OpenAI returned no structured classification text.");
}

function responseUsage(body: Record<string, unknown>): OpenAIUsage {
  const usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : {};
  return {
    inputTokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
  };
}

function proposalFromModel(value: Record<string, unknown>, deterministic: ReturnType<typeof deterministicPageHeuristic>, secondPass: boolean): ClassificationProposal {
  const modelOutcome = String(value.outcome ?? "needs_review") as PreparedOutcome;
  const deterministicOutcome = deterministic.outcome;
  const disagreement = deterministicOutcome !== null && deterministicOutcome !== modelOutcome;
  let outcome = modelOutcome;
  if (disagreement || !Number.isFinite(Number(value.confidence))) outcome = "needs_review";
  return {
    outcome,
    confidence: boundedConfidence(value.confidence),
    visualType: String(value.visual_type ?? "other").slice(0, 80),
    conciseDescription: String(value.concise_description ?? "Candidate visual composition.").slice(0, 700),
    retainRationale: value.retain_rationale === null ? null : String(value.retain_rationale ?? "").slice(0, 1000) || null,
    rejectRationale: value.reject_rationale === null ? null : String(value.reject_rationale ?? "").slice(0, 1000) || null,
    reusableVisualStructure: Boolean(value.reusable_visual_structure),
    continuationLikely: Boolean(value.continuation_likely),
    continuationTitle: value.continuation_title === null ? null : String(value.continuation_title ?? "").slice(0, 300) || null,
    deterministicOutcome,
    deterministicReason: deterministic.reason,
    modelOutcome,
    modelReason: outcome === "needs_review" && disagreement ? "Deterministic and model outcomes disagree." : null,
    disagreement,
    secondPassApplied: secondPass,
  };
}

async function openAIResponse(
  env: Env,
  model: string,
  prompt: string,
  artifact: RenderArtifactManifest | null,
): Promise<{ body: Record<string, unknown>; usage: OpenAIUsage }> {
  const apiKey = String(env.OPENAI_API_KEY ?? "");
  if (!apiKey) throw new ConnectorError("openai_api_key_missing", "OPENAI_API_KEY is not configured.");
  const content: Record<string, unknown>[] = [{ type: "input_text", text: prompt }];
  if (artifact) {
    const bytes = new Uint8Array(await (await getArtifact(env, artifact.r2Key)).arrayBuffer());
    content.push({ type: "input_image", image_url: `data:${artifact.mimeType};base64,${bytesToBase64(bytes)}`, detail: "high" });
  }
  const response = await fetch(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: "visual_catalogue_classification", strict: true, schema: classificationSchema() } },
      max_output_tokens: 1400,
      store: false,
    }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ConnectorError("openai_response_failed", "OpenAI Responses classification failed.", {
    retryable: response.status === 429 || response.status >= 500,
    status: response.status,
    details: { type: (body.error as Record<string, unknown> | undefined)?.type ?? null },
  });
  return { body, usage: responseUsage(body) };
}

async function classifyDirect(
  env: Env,
  model: string,
  source: SourceIdentity,
  sourceType: SourceType,
  routingMode: RoutingMode,
  candidate: VisualCandidate,
  artifact: RenderArtifactManifest | null,
  deterministic: ReturnType<typeof deterministicPageHeuristic>,
  adjacent: Array<{ stableKey: string; pageOrSlide: number | null; description?: string }>,
  secondPass: boolean,
): Promise<ClassifiedCandidate> {
  const prompt = classifierPrompt({ source, sourceType, routingMode, candidate, deterministicReason: deterministic.reason, adjacent, secondPass });
  const response = await openAIResponse(env, model, prompt, artifact);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(responseText(response.body)) as Record<string, unknown>; }
  catch { throw new ConnectorError("classifier_schema_invalid", "OpenAI classification was not valid strict JSON.", { retryable: true }); }
  return { proposal: proposalFromModel(parsed, deterministic, secondPass), usage: response.usage };
}

async function uploadOpenAIFile(env: Env, filename: string, bytes: Uint8Array, purpose: "batch" | "user_data"): Promise<string> {
  const apiKey = String(env.OPENAI_API_KEY ?? "");
  if (!apiKey) throw new ConnectorError("openai_api_key_missing", "OPENAI_API_KEY is not configured.");
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("expires_after[anchor]", "created_at");
  form.append("expires_after[seconds]", "86400");
  form.append("file", new Blob([bytes.slice().buffer], { type: purpose === "batch" ? "application/jsonl" : "application/octet-stream" }), filename);
  const response = await fetch(`${OPENAI_BASE}/files`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || !body.id) throw new ConnectorError("openai_file_upload_failed", "OpenAI file upload failed.", { retryable: response.status === 429 || response.status >= 500, status: response.status });
  return String(body.id);
}

async function deleteOpenAIFile(env: Env, fileId: string): Promise<void> {
  const apiKey = String(env.OPENAI_API_KEY ?? "");
  if (!apiKey || !fileId) return;
  await fetch(`${OPENAI_BASE}/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } }).catch(() => undefined);
}

async function submitBatch(
  env: Env,
  model: string,
  source: SourceIdentity,
  sourceType: SourceType,
  routingMode: RoutingMode,
  entries: Array<{ candidate: VisualCandidate; artifact: RenderArtifactManifest | null; deterministic: ReturnType<typeof deterministicPageHeuristic>; adjacent: Array<{ stableKey: string; pageOrSlide: number | null }> }>,
): Promise<{ batchId: string; inputFileId: string }> {
  const lines: string[] = [];
  for (const entry of entries) {
    const content: Record<string, unknown>[] = [{ type: "input_text", text: classifierPrompt({
      source,
      sourceType,
      routingMode,
      candidate: entry.candidate,
      deterministicReason: entry.deterministic.reason,
      adjacent: entry.adjacent,
      secondPass: false,
    }) }];
    if (entry.artifact) {
      const bytes = new Uint8Array(await (await getArtifact(env, entry.artifact.r2Key)).arrayBuffer());
      content.push({ type: "input_image", image_url: `data:${entry.artifact.mimeType};base64,${bytesToBase64(bytes)}`, detail: "high" });
    }
    lines.push(JSON.stringify({
      custom_id: entry.candidate.stableVisualId,
      method: "POST",
      url: "/v1/responses",
      body: {
        model,
        reasoning: { effort: "low" },
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: "visual_catalogue_classification", strict: true, schema: classificationSchema() } },
        max_output_tokens: 1400,
        store: false,
      },
    }));
  }
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  if (bytes.byteLength > 200 * 1024 * 1024) throw new ConnectorError("openai_batch_too_large", "The OpenAI batch JSONL exceeds 200 MB.");
  const inputFileId = await uploadOpenAIFile(env, "visual-catalogue-batch.jsonl", bytes, "batch");
  const apiKey = String(env.OPENAI_API_KEY ?? "");
  const response = await fetch(`${OPENAI_BASE}/batches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input_file_id: inputFileId, endpoint: "/v1/responses", completion_window: "24h", metadata: { compiler: VISUAL_COMPILER_VERSION, source_sha256: source.sha256 } }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || !body.id) {
    await deleteOpenAIFile(env, inputFileId);
    throw new ConnectorError("openai_batch_submit_failed", "OpenAI Batch submission failed.", { retryable: response.status === 429 || response.status >= 500, status: response.status });
  }
  return { batchId: String(body.id), inputFileId };
}

async function batchStatus(env: Env, batchId: string): Promise<Record<string, unknown>> {
  const apiKey = String(env.OPENAI_API_KEY ?? "");
  const response = await fetch(`${OPENAI_BASE}/batches/${encodeURIComponent(batchId)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ConnectorError("openai_batch_status_failed", "OpenAI Batch status could not be read.", { retryable: response.status === 429 || response.status >= 500, status: response.status });
  return body;
}

async function batchOutput(env: Env, fileId: string): Promise<string> {
  const apiKey = String(env.OPENAI_API_KEY ?? "");
  const response = await fetch(`${OPENAI_BASE}/files/${encodeURIComponent(fileId)}/content`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new ConnectorError("openai_batch_output_failed", "OpenAI Batch output could not be downloaded.", { retryable: response.status === 429 || response.status >= 500, status: response.status });
  return response.text();
}

function parseBatchOutput(text: string, deterministicById: Map<string, ReturnType<typeof deterministicPageHeuristic>>): Map<string, ClassifiedCandidate> {
  const result = new Map<string, ClassifiedCandidate>();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const row = JSON.parse(line) as Record<string, unknown>;
    const customId = String(row.custom_id ?? "");
    const response = row.response && typeof row.response === "object" ? row.response as Record<string, unknown> : {};
    const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
    const deterministic = deterministicById.get(customId) ?? { outcome: null, reason: null, confidence: 0 };
    try {
      const parsed = JSON.parse(responseText(body)) as Record<string, unknown>;
      result.set(customId, { proposal: proposalFromModel(parsed, deterministic, false), usage: responseUsage(body) });
    } catch {
      result.set(customId, {
        proposal: {
          outcome: "needs_review", confidence: 0, visualType: "other", conciseDescription: "Batch classification failed schema validation.",
          retainRationale: null, rejectRationale: null, reusableVisualStructure: false, continuationLikely: false, continuationTitle: null,
          deterministicOutcome: deterministic.outcome, deterministicReason: deterministic.reason, modelOutcome: null, modelReason: "Invalid batch result.", disagreement: true, secondPassApplied: false,
        },
        usage: responseUsage(body),
      });
    }
  }
  return result;
}

function fixtureProposal(gold: GoldDecision | undefined, deterministic: ReturnType<typeof deterministicPageHeuristic>): ClassificationProposal {
  if (gold) {
    return {
      outcome: gold.outcome,
      confidence: 0.99,
      visualType: /map/i.test(gold.description) ? "map" : /diagram|framework|matrix|chart/i.test(gold.description) ? "diagram" : "page_composition",
      conciseDescription: gold.description || "Controlled calibration decision.",
      retainRationale: gold.knownRetained ? "Existing controlled calibration decision retains this candidate." : null,
      rejectRationale: gold.outcome === "reject" ? gold.description : null,
      reusableVisualStructure: gold.knownRetained,
      continuationLikely: /continuation|continued/i.test(gold.description),
      continuationTitle: null,
      deterministicOutcome: deterministic.outcome,
      deterministicReason: deterministic.reason,
      modelOutcome: gold.outcome,
      modelReason: "Non-mutating calibration fixture.",
      disagreement: deterministic.outcome !== null && deterministic.outcome !== gold.outcome,
      secondPassApplied: false,
    };
  }
  if (deterministic.outcome) {
    return {
      outcome: deterministic.outcome,
      confidence: deterministic.confidence,
      visualType: "other",
      conciseDescription: deterministic.reason ?? "Deterministic classification.",
      retainRationale: null,
      rejectRationale: deterministic.outcome === "reject" ? deterministic.reason : null,
      reusableVisualStructure: false,
      continuationLikely: false,
      continuationTitle: null,
      deterministicOutcome: deterministic.outcome,
      deterministicReason: deterministic.reason,
      modelOutcome: null,
      modelReason: null,
      disagreement: false,
      secondPassApplied: false,
    };
  }
  return {
    outcome: "needs_review", confidence: 0.5, visualType: "other", conciseDescription: "No calibration decision or deterministic rule was available.",
    retainRationale: "Uncertain candidates are routed to review.", rejectRationale: null, reusableVisualStructure: true, continuationLikely: false, continuationTitle: null,
    deterministicOutcome: null, deterministicReason: null, modelOutcome: null, modelReason: "Fixture coverage missing.", disagreement: false, secondPassApplied: false,
  };
}

function resultRecord(input: {
  jobId: string;
  source: SourceIdentity;
  sourceType: SourceType;
  routingMode: RoutingMode;
  candidate: VisualCandidate;
  artifact: RenderArtifactManifest | null;
  proposal: ClassificationProposal;
  modelProvider: string;
  model: string;
  rubricVersion: string;
  promptVersion: string;
}): VisualResultRecord {
  const now = nowIso();
  const artifactSha256 = input.artifact?.sha256 ?? input.candidate.embeddedSha256;
  return {
    version: 1,
    jobId: input.jobId,
    source: input.source,
    stableVisualId: input.candidate.stableVisualId,
    stableKey: input.candidate.stableKey,
    pageOrSlide: input.candidate.pageOrSlide,
    parentPages: input.candidate.parentPages,
    relationship: input.candidate.relationship,
    renderArtifactId: input.artifact?.renderArtifactId ?? null,
    embeddedArtifactId: input.candidate.embeddedArtifactId,
    artifactSha256: artifactSha256 ?? null,
    artifactWidth: input.artifact?.width ?? null,
    artifactHeight: input.artifact?.height ?? null,
    artifactFormat: input.artifact?.format ?? (input.candidate.embeddedArtifactKey ? "jpeg" : null),
    artifactR2Key: input.artifact?.r2Key ?? input.candidate.embeddedArtifactKey,
    sourceType: input.sourceType,
    routingMode: input.routingMode,
    outcome: input.proposal.outcome,
    confidence: boundedConfidence(input.proposal.confidence),
    conciseDescription: input.proposal.conciseDescription,
    retainRationale: input.proposal.retainRationale,
    rejectRationale: input.proposal.rejectRationale,
    visualType: input.proposal.visualType,
    pageSeriesId: null,
    canonicalVisualId: null,
    reviewState: input.proposal.outcome === "needs_review" || input.proposal.disagreement ? "review_required" : "unreviewed",
    deterministicOutcome: input.proposal.deterministicOutcome,
    modelOutcome: input.proposal.modelOutcome,
    disagreement: input.proposal.disagreement,
    modelProvider: input.modelProvider,
    model: input.model,
    pinnedModelVersion: input.model,
    rubricVersion: input.rubricVersion,
    promptVersion: input.promptVersion,
    createdAt: now,
    updatedAt: now,
    error: null,
  };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function buildContactSheet(
  env: Env,
  jobId: string,
  results: VisualResultRecord[],
  selectedIds: string[],
): Promise<string | null> {
  const selected = selectedIds.map((id) => results.find((record) => record.stableVisualId === id)).filter((record): record is VisualResultRecord => Boolean(record?.artifactR2Key)).slice(0, 64);
  if (!selected.length) return null;
  const columns = 4;
  const cellWidth = 360;
  const imageHeight = 235;
  const labelHeight = 70;
  const rows = Math.ceil(selected.length / columns);
  const width = columns * cellWidth;
  const height = rows * (imageHeight + labelHeight);
  const fragments: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>`];
  for (let index = 0; index < selected.length; index += 1) {
    const record = selected[index];
    const object = await getArtifact(env, record.artifactR2Key as string);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * (imageHeight + labelHeight);
    const mime = object.httpMetadata?.contentType ?? (record.artifactFormat === "jpeg" ? "image/jpeg" : "image/png");
    fragments.push(`<image x="${x + 5}" y="${y + 5}" width="${cellWidth - 10}" height="${imageHeight - 10}" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${bytesToBase64(bytes)}"/>`);
    fragments.push(`<rect x="${x}" y="${y + imageHeight}" width="${cellWidth}" height="${labelHeight}" fill="white" stroke="#999"/>`);
    fragments.push(`<text x="${x + 8}" y="${y + imageHeight + 20}" font-size="14" font-family="sans-serif">${xmlEscape(record.stableKey)}</text>`);
    fragments.push(`<text x="${x + 8}" y="${y + imageHeight + 40}" font-size="13" font-family="sans-serif">${xmlEscape(`${record.outcome} · ${record.confidence.toFixed(2)}`)}</text>`);
    fragments.push(`<text x="${x + 8}" y="${y + imageHeight + 59}" font-size="11" font-family="sans-serif">${xmlEscape(record.stableVisualId.slice(0, 28))}</text>`);
  }
  fragments.push("</svg>");
  const svg = new TextEncoder().encode(fragments.join(""));
  const output = await env.IMAGES.input(new Blob([svg.slice().buffer], { type: "image/svg+xml" }).stream()).output({ format: "image/png", anim: false });
  const response = output.response();
  if (!response.ok) throw new ConnectorError("review_contact_sheet_failed", "The review contact sheet could not be rendered.", { retryable: true });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const key = contactSheetKey(jobId);
  await putArtifact(env, key, bytes, "image/png", { jobId, itemCount: String(selected.length) });
  return key;
}

function reviewSummary(
  jobId: string,
  source: SourceIdentity,
  results: VisualResultRecord[],
  series: SeriesRecord[],
  reviewVisualIds: string[],
  sampleVisualIds: string[],
  approvalFingerprint: string,
): ReviewPacketSummary {
  return {
    jobId,
    source,
    outcomeCounts: outcomeCounts(results),
    confidenceBuckets: confidenceBuckets(results),
    series,
    disagreements: results.filter((record) => record.disagreement).map((record) => record.stableVisualId),
    errors: results.filter((record) => record.error).map((record) => ({ stableVisualId: record.stableVisualId, error: record.error })),
    reviewVisualIds,
    deterministicSampleVisualIds: sampleVisualIds,
    approvalFingerprint,
  };
}

function estimatedCost(model: string, inputTokens: number, outputTokens: number, batch: boolean): number | null {
  const prices: Record<string, { input: number; output: number }> = {
    "gpt-5.2-2025-12-11": { input: 1.75, output: 14 },
  };
  const price = prices[model];
  if (!price) return null;
  const multiplier = batch ? 0.5 : 1;
  return Number((((inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output) * multiplier).toFixed(6));
}

export async function runVisualCompileWorkflow(
  env: Env,
  payload: VisualWorkflowPayload,
  step: WorkflowStep,
): Promise<Record<string, unknown>> {
  const input = payload.input as StartVisualCatalogueInput;
  const started = Date.now();
  const manifest: CompilerJobManifest = {
    version: 1,
    compilerVersion: VISUAL_COMPILER_VERSION,
    jobId: payload.jobId,
    workflowId: payload.workflowId,
    userIdHash: await sha256HexUtf8(payload.userId),
    operation: "compile",
    status: "running",
    stage: "verifying_source",
    source: null,
    sourceType: null,
    routingMode: null,
    input,
    candidatesKey: null,
    resultsKey: null,
    approvedResultsKey: null,
    seriesKey: null,
    reviewPacketKey: null,
    contactSheetKey: null,
    approvalFingerprint: null,
    approvedFingerprint: null,
    resultCounts: null,
    metrics: {
      inventoriedCandidates: 0, renderedArtifacts: 0, embeddedArtifacts: 0, cacheHits: 0, renderMisses: 0,
      classifierRequests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null,
      startedAt: nowIso(), completedAt: null, elapsedMilliseconds: null,
    },
    errors: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await writeManifest(env, manifest);
  await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: 1, stage: manifest.stage });
  try {
    const verifiedSource = await step.do("verify unchanged source", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => {
      const verified = await verifyItemInsideRoot(env, payload.userId, input.sourceItemId);
      if (verified.item.folder) throw new ConnectorError("folder_not_file", "Visual catalogue compilation requires a file.");
      if (!verified.item.eTag || verified.item.eTag !== input.expectedSourceETag) throw new ConnectorError("etag_conflict", "The source eTag does not match the requested immutable source version.");
      const maximum = Math.min(MAX_SOURCE_BYTES, Math.max(1, Number(env.PAID_MAX_SOURCE_MB ?? 500)) * 1024 * 1024);
      const bytes = new Uint8Array(await graphFetchBytes(env, payload.userId, `/me/drive/items/${encodeURIComponent(verified.item.id)}/content`, maximum, { headers: { "If-Match": verified.item.eTag } }));
      const sha256 = await sha256Bytes(bytes);
      if (sha256 !== input.expectedSourceSha256.toLowerCase()) throw new ConnectorError("sha256_conflict", "The source SHA-256 does not match the requested immutable source version.");
      const key = `${compilerPrefix(payload.jobId)}/source.bin`;
      await putArtifact(env, key, bytes, verified.item.file?.mimeType ?? "application/octet-stream", {
        sourceItemId: verified.item.id,
        sourceETag: verified.item.eTag,
        sourceSha256: sha256,
      });
      return {
        source: {
          itemId: verified.item.id,
          path: verified.relativePath,
          filename: verified.item.name,
          eTag: verified.item.eTag,
          byteSize: bytes.byteLength,
          sha256,
        } satisfies SourceIdentity,
        sourceArtifactKey: key,
      };
    });
    manifest.source = verifiedSource.source;
    manifest.sourceType = inferSourceType(verifiedSource.source.filename, input.sourceType);
    manifest.routingMode = routeForSource(manifest.sourceType);
    manifest.stage = "inventorying";
    await writeManifest(env, manifest);
    await updateJob(env, payload.userId, payload.jobId, { progress: 5, stage: manifest.stage });

    const inventory = await step.do("inventory source visuals", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "15 minutes" }, async () => {
      const sourceBytes = new Uint8Array(await (await getArtifact(env, verifiedSource.sourceArtifactKey)).arrayBuffer());
      const extension = extensionOf(verifiedSource.source.filename);
      const start = Math.max(1, Number(input.pageStart ?? 1));
      const requestedEnd = Math.max(start, Number(input.pageEnd ?? 500));
      return extension === ".pdf"
        ? inventoryPdf(env, verifiedSource.source, sourceBytes, manifest.sourceType as SourceType, start, requestedEnd)
        : inventoryOffice(env, payload.userId, verifiedSource.source, manifest.sourceType as SourceType, start, requestedEnd);
    });
    manifest.metrics.inventoriedCandidates = inventory.candidates.length;
    manifest.metrics.embeddedArtifacts = inventory.embeddedCount;
    manifest.candidatesKey = candidateKey(payload.jobId);
    await storeJson(env, manifest.candidatesKey, { pageOrSlideCount: inventory.pageCount, candidates: inventory.candidates }, { jobId: payload.jobId, count: String(inventory.candidates.length) });
    manifest.stage = "rendering_and_caching";
    await writeManifest(env, manifest);
    await updateJob(env, payload.userId, payload.jobId, { progress: 10, stage: manifest.stage });

    const format = input.renderFormat ?? "png";
    const width = Math.min(Math.max(Number(input.renderWidth ?? 1600), 256), 4096);
    const dpi = Math.min(Math.max(Number(input.renderDpi ?? 144), 36), 300);
    const artifacts = new Map<string, RenderArtifactManifest>();
    const renderable = inventory.candidates.filter((candidate) => candidate.renderRequired);
    for (let index = 0; index < renderable.length; index += 1) {
      const candidate = renderable[index];
      const artifact = await step.do(
        `cache render ${String(index + 1).padStart(4, "0")} ${candidate.stableKey}`,
        { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => renderAndCache(env, payload.userId, verifiedSource.source, candidate, format, width, dpi),
      );
      artifacts.set(candidate.stableVisualId, artifact);
      manifest.metrics.renderedArtifacts += 1;
      if (artifact.cacheHit) manifest.metrics.cacheHits += 1;
      else manifest.metrics.renderMisses += 1;
      if ((index + 1) % 10 === 0 || index + 1 === renderable.length) {
        manifest.stage = `rendering_and_caching_${index + 1}_of_${renderable.length}`;
        await writeManifest(env, manifest);
        await updateJob(env, payload.userId, payload.jobId, { progress: Math.min(55, 10 + Math.round((index + 1) / Math.max(1, renderable.length) * 45)), stage: manifest.stage });
      }
    }

    if (input.simulateInterruptAfterRenderingOnce) {
      await step.do("acceptance interruption after rendering", { retries: { limit: 2, delay: "2 seconds", backoff: "constant" } }, async () => {
        const marker = `${compilerPrefix(payload.jobId)}/acceptance/render-interrupt.marker`;
        if (!await env.ARTIFACTS.head(marker)) {
          await putArtifact(env, marker, "interrupted", "text/plain", { jobId: payload.jobId });
          throw new ConnectorError("acceptance_simulated_interrupt", "Acceptance interruption injected after rendering.", { retryable: true });
        }
        return { resumed: true, cacheArtifacts: artifacts.size };
      });
    }

    manifest.stage = "classifying";
    await writeManifest(env, manifest);
    await updateJob(env, payload.userId, payload.jobId, { progress: 58, stage: manifest.stage });
    const gold = await step.do("load calibration decisions", async () => {
      const map = await calibrationGold(env, payload.userId, input.calibrationCheckpointItemId);
      return [...map.values()];
    });
    const goldMap = new Map(gold.map((decision) => [decision.stableKey, decision]));
    const model = String(input.model ?? env.VISUAL_CLASSIFIER_MODEL ?? DEFAULT_MODEL);
    const mode = input.classifierMode ?? (input.dryRun ? "fixture" : "openai_batch");
    if (!input.dryRun && mode === "fixture") throw new ConnectorError("fixture_production_forbidden", "Fixture classification is permitted only for dry runs.");
    const rubricVersion = String(input.rubricVersion ?? env.VISUAL_RUBRIC_VERSION ?? VISUAL_RUBRIC_VERSION);
    const promptVersion = String(input.promptVersion ?? env.VISUAL_PROMPT_VERSION ?? VISUAL_PROMPT_VERSION);
    const deterministicById = new Map<string, ReturnType<typeof deterministicPageHeuristic>>();
    for (const candidate of inventory.candidates) {
      const artifact = artifacts.get(candidate.stableVisualId);
      deterministicById.set(candidate.stableVisualId, deterministicPageHeuristic({
        pageOrSlide: candidate.pageOrSlide,
        nearbyText: candidate.nearbyText,
        byteSize: artifact?.byteSize ?? null,
        isExactDuplicate: false,
      }));
    }

    const classified = new Map<string, ClassifiedCandidate>();
    if (mode === "fixture") {
      for (const candidate of inventory.candidates) {
        classified.set(candidate.stableVisualId, { proposal: fixtureProposal(goldMap.get(candidate.stableKey), deterministicById.get(candidate.stableVisualId) as ReturnType<typeof deterministicPageHeuristic>), usage: { inputTokens: 0, outputTokens: 0 } });
      }
    } else if (mode === "openai_responses") {
      for (let index = 0; index < inventory.candidates.length; index += 1) {
        const candidate = inventory.candidates[index];
        const adjacent = inventory.candidates.filter((other) => other.pageOrSlide !== null && candidate.pageOrSlide !== null && Math.abs(other.pageOrSlide - candidate.pageOrSlide) === 1).map((other) => ({ stableKey: other.stableKey, pageOrSlide: other.pageOrSlide }));
        const value = await step.do(`classify response ${String(index + 1).padStart(4, "0")} ${candidate.stableKey}`, { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => classifyDirect(
          env, model, verifiedSource.source, manifest.sourceType as SourceType, manifest.routingMode as RoutingMode, candidate,
          artifacts.get(candidate.stableVisualId) ?? null, deterministicById.get(candidate.stableVisualId) as ReturnType<typeof deterministicPageHeuristic>, adjacent, false,
        ));
        classified.set(candidate.stableVisualId, value);
        manifest.metrics.classifierRequests += 1;
        manifest.metrics.inputTokens += value.usage.inputTokens;
        manifest.metrics.outputTokens += value.usage.outputTokens;
      }
    } else {
      for (let chunkStart = 0; chunkStart < inventory.candidates.length; chunkStart += MAX_BATCH_ITEMS) {
        const chunkIndex = Math.floor(chunkStart / MAX_BATCH_ITEMS) + 1;
        const chunk = inventory.candidates.slice(chunkStart, chunkStart + MAX_BATCH_ITEMS);
        const entries = chunk.map((candidate) => ({
          candidate,
          artifact: artifacts.get(candidate.stableVisualId) ?? null,
          deterministic: deterministicById.get(candidate.stableVisualId) as ReturnType<typeof deterministicPageHeuristic>,
          adjacent: inventory.candidates.filter((other) => other.pageOrSlide !== null && candidate.pageOrSlide !== null && Math.abs(other.pageOrSlide - candidate.pageOrSlide) === 1).map((other) => ({ stableKey: other.stableKey, pageOrSlide: other.pageOrSlide })),
        }));
        const submitted = await step.do(`submit OpenAI batch ${chunkIndex}`, { retries: { limit: 4, delay: "20 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => submitBatch(env, model, verifiedSource.source, manifest.sourceType as SourceType, manifest.routingMode as RoutingMode, entries));
        let status: Record<string, unknown> = {};
        for (let poll = 1; poll <= 144; poll += 1) {
          status = await (step as any).do(`poll OpenAI batch ${chunkIndex} attempt ${String(poll).padStart(3, "0")}`, { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" }, async () => batchStatus(env, submitted.batchId)) as Record<string, unknown>;
          const state = String(status.status ?? "");
          if (["completed", "failed", "expired", "cancelled"].includes(state)) break;
          await step.sleep(`wait OpenAI batch ${chunkIndex} attempt ${String(poll).padStart(3, "0")}`, "10 minutes");
        }
        if (String(status.status) !== "completed" || !status.output_file_id) {
          await deleteOpenAIFile(env, submitted.inputFileId);
          throw new ConnectorError("openai_batch_incomplete", `OpenAI Batch ended with status ${String(status.status ?? "unknown")}.`, { retryable: false });
        }
        const output = await step.do(`download OpenAI batch ${chunkIndex}`, { retries: { limit: 4, delay: "20 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => batchOutput(env, String(status.output_file_id)));
        const parsed = parseBatchOutput(output, deterministicById);
        for (const candidate of chunk) {
          const value = parsed.get(candidate.stableVisualId);
          if (value) {
            classified.set(candidate.stableVisualId, value);
            manifest.metrics.inputTokens += value.usage.inputTokens;
            manifest.metrics.outputTokens += value.usage.outputTokens;
          }
        }
        manifest.metrics.classifierRequests += chunk.length;
        await deleteOpenAIFile(env, submitted.inputFileId);
        await deleteOpenAIFile(env, String(status.output_file_id));
      }
    }

    const preliminary: VisualResultRecord[] = [];
    for (let index = 0; index < inventory.candidates.length; index += 1) {
      const candidate = inventory.candidates[index];
      let classifiedValue = classified.get(candidate.stableVisualId);
      if (!classifiedValue) classifiedValue = { proposal: fixtureProposal(undefined, deterministicById.get(candidate.stableVisualId) as ReturnType<typeof deterministicPageHeuristic>), usage: { inputTokens: 0, outputTokens: 0 } };
      if (mode !== "fixture" && requiresSecondPass(classifiedValue.proposal, Number(input.highConfidenceRejectThreshold ?? 0.94))) {
        const adjacent = preliminary.slice(-1).map((record) => ({ stableKey: record.stableKey, pageOrSlide: record.pageOrSlide, description: record.conciseDescription }));
        const second = await step.do(`conservative second pass ${String(index + 1).padStart(4, "0")} ${candidate.stableKey}`, { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => classifyDirect(
          env, model, verifiedSource.source, manifest.sourceType as SourceType, manifest.routingMode as RoutingMode, candidate,
          artifacts.get(candidate.stableVisualId) ?? null, deterministicById.get(candidate.stableVisualId) as ReturnType<typeof deterministicPageHeuristic>, adjacent, true,
        ));
        classifiedValue = second;
        manifest.metrics.classifierRequests += 1;
        manifest.metrics.inputTokens += second.usage.inputTokens;
        manifest.metrics.outputTokens += second.usage.outputTokens;
      }
      const protectedProposal = enforceFalseRejectProtection(classifiedValue.proposal, goldMap.get(candidate.stableKey)?.knownRetained ?? false);
      preliminary.push(resultRecord({
        jobId: payload.jobId,
        source: verifiedSource.source,
        sourceType: manifest.sourceType as SourceType,
        routingMode: manifest.routingMode as RoutingMode,
        candidate,
        artifact: artifacts.get(candidate.stableVisualId) ?? null,
        proposal: protectedProposal,
        modelProvider: mode === "fixture" ? "fixture" : "openai",
        model: mode === "fixture" ? "calibration-fixture" : model,
        rubricVersion,
        promptVersion,
      }));
    }

    manifest.stage = "detecting_series";
    await writeManifest(env, manifest);
    await updateJob(env, payload.userId, payload.jobId, { progress: 82, stage: manifest.stage });
    const detectedSeries = await step.do("detect adjacent visual series", async () => detectVisualSeries(preliminary));
    const results = applySeries(preliminary, detectedSeries);
    manifest.resultsKey = resultsKey(payload.jobId);
    manifest.seriesKey = seriesKey(payload.jobId);
    await storeJson(env, manifest.resultsKey, results, { jobId: payload.jobId, recordCount: String(results.length) });
    await storeJson(env, manifest.seriesKey, detectedSeries, { jobId: payload.jobId, seriesCount: String(detectedSeries.length) });

    manifest.stage = "building_review_packet";
    await writeManifest(env, manifest);
    const selected = selectReviewVisuals(results, detectedSeries, Number(input.highConfidenceRejectThreshold ?? 0.94), 6);
    const fingerprint = await reviewFingerprint({
      jobId: payload.jobId,
      resultFingerprints: results.map((record) => ({ stableVisualId: record.stableVisualId, outcome: record.outcome, confidence: record.confidence, pageSeriesId: record.pageSeriesId, canonicalVisualId: record.canonicalVisualId })),
      series: detectedSeries,
    });
    const packet = reviewSummary(payload.jobId, verifiedSource.source, results, detectedSeries, selected.reviewVisualIds, selected.sampleVisualIds, fingerprint);
    manifest.reviewPacketKey = reviewKey(payload.jobId);
    await storeJson(env, manifest.reviewPacketKey, packet, { jobId: payload.jobId, approvalFingerprint: fingerprint });
    manifest.contactSheetKey = await step.do("render compact review contact sheet", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => buildContactSheet(env, payload.jobId, results, [...selected.reviewVisualIds, ...selected.sampleVisualIds]));
    manifest.approvalFingerprint = fingerprint;
    manifest.resultCounts = outcomeCounts(results);
    manifest.metrics.estimatedCostUsd = estimatedCost(model, manifest.metrics.inputTokens, manifest.metrics.outputTokens, mode === "openai_batch");

    if (input.dryRun && input.autoApproveDryRun) {
      const approved = results.map((record) => ({ ...record, reviewState: record.reviewState === "review_required" ? record.reviewState : "approved" as const }));
      manifest.approvedResultsKey = approvedResultsKey(payload.jobId);
      await storeJson(env, manifest.approvedResultsKey, approved, { jobId: payload.jobId, approvalFingerprint: fingerprint });
      manifest.approvedFingerprint = fingerprint;
      manifest.status = "completed";
      manifest.stage = "completed_dry_run";
    } else {
      manifest.status = "awaiting_review";
      manifest.stage = "awaiting_review";
      await writeManifest(env, manifest);
      await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: 95, stage: manifest.stage, resultKey: manifest.reviewPacketKey, resultMimeType: RESULT_MIME });
      const review = await step.waitForEvent<{ approvalFingerprint: string; overrides: ReviewOverride[]; approvedBy: string; approvedAt: string }>(
        "wait for explicit visual catalogue review",
        { type: "visual-catalogue-review", timeout: "30 days" },
      );
      if (review.payload.approvalFingerprint !== fingerprint) throw new ConnectorError("approval_fingerprint_changed", "The supplied review approval fingerprint does not match the immutable review packet.");
      const approved = applyReviewOverrides(results, review.payload.overrides ?? []).map((record) => ({ ...record, reviewState: record.reviewState === "overridden" ? record.reviewState : "approved" as const }));
      const approvedFingerprint = await reviewFingerprint({
        jobId: payload.jobId,
        resultFingerprints: approved.map((record) => ({ stableVisualId: record.stableVisualId, outcome: record.outcome, confidence: record.confidence, pageSeriesId: record.pageSeriesId, canonicalVisualId: record.canonicalVisualId })),
        series: detectedSeries,
        overrides: review.payload.overrides ?? [],
      });
      manifest.approvedResultsKey = approvedResultsKey(payload.jobId);
      await storeJson(env, manifest.approvedResultsKey, { approvedBy: review.payload.approvedBy, approvedAt: review.payload.approvedAt, approvalFingerprint: fingerprint, approvedFingerprint, overrides: review.payload.overrides ?? [], results: approved }, { jobId: payload.jobId, approvedFingerprint });
      manifest.approvedFingerprint = approvedFingerprint;
      manifest.resultCounts = outcomeCounts(approved);
      manifest.status = "completed";
      manifest.stage = "review_approved";
    }

    manifest.metrics.completedAt = nowIso();
    manifest.metrics.elapsedMilliseconds = Date.now() - started;
    await writeManifest(env, manifest);
    await updateJob(env, payload.userId, payload.jobId, { status: "completed", progress: 100, stage: manifest.stage, resultKey: compilerManifestKey(payload.jobId), resultMimeType: RESULT_MIME, error: null });
    return {
      jobId: payload.jobId,
      status: manifest.status,
      source: manifest.source,
      sourceType: manifest.sourceType,
      routingMode: manifest.routingMode,
      counts: manifest.resultCounts,
      seriesDetected: detectedSeries.length,
      approvalFingerprint: manifest.approvalFingerprint,
      approvedFingerprint: manifest.approvedFingerprint,
      metrics: manifest.metrics,
      oneDriveMutationPerformed: false,
      dryRun: Boolean(input.dryRun),
    };
  } catch (error) {
    const failure = asCompilerError(error);
    manifest.status = "failed";
    manifest.stage = "failed";
    manifest.errors.push({ stage: manifest.stage, code: failure.code, message: failure.message });
    manifest.metrics.completedAt = nowIso();
    manifest.metrics.elapsedMilliseconds = Date.now() - started;
    await writeManifest(env, manifest).catch(() => undefined);
    await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: failure }).catch(() => undefined);
    throw error;
  }
}

export async function loadCompilerResults(env: Env, manifest: CompilerJobManifest): Promise<VisualResultRecord[]> {
  if (manifest.approvedResultsKey) {
    const approved = await readJson<VisualResultRecord[] | { results: VisualResultRecord[] }>(env, manifest.approvedResultsKey);
    return Array.isArray(approved) ? approved : approved.results;
  }
  if (!manifest.resultsKey) throw new ConnectorError("visual_results_missing", "The compiler result records are not available.");
  return readJson<VisualResultRecord[]>(env, manifest.resultsKey);
}

export async function loadReviewPacket(env: Env, manifest: CompilerJobManifest): Promise<ReviewPacketSummary> {
  if (!manifest.reviewPacketKey) throw new ConnectorError("review_packet_missing", "The review packet is not available.");
  return readJson<ReviewPacketSummary>(env, manifest.reviewPacketKey);
}

export async function sendReviewEvent(
  env: Env,
  manifest: CompilerJobManifest,
  input: { approvalFingerprint: string; overrides: ReviewOverride[]; approvedBy: string },
): Promise<void> {
  const instance = await (env.VISUAL_CATALOGUE_WORKFLOW as any).get(manifest.workflowId);
  await instance.sendEvent({
    type: "visual-catalogue-review",
    payload: {
      approvalFingerprint: input.approvalFingerprint,
      overrides: input.overrides,
      approvedBy: input.approvedBy,
      approvedAt: nowIso(),
    },
  });
}
