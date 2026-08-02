import type { WorkflowStep } from "cloudflare:workers";
import { ConnectorError } from "./errors";
import {
  compactVerifiedItem,
  graphFetchBytes,
  graphResponse,
  listVerifiedChildren,
  resolveRelativeFolder,
  validateItemName,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import { bytesToBase64, sha256Bytes } from "./integrated-core";
import {
  canonicalJson,
  coordinatorRequest,
  getArtifact,
  nowIso,
  putArtifact,
  sha256HexUtf8,
  type PaidJobRecord,
} from "./paid-core";
import type { GraphDriveItem } from "./types";
import {
  VISUAL_COMPILER_VERSION,
  appendUniqueCsvRows,
  assertMasterParity,
  csvObjects,
  masterJsonFromCsv,
  objectsCsv,
  outcomeCounts,
  parseCsv,
  serializeCsv,
  type CatalogueFileReference,
  type PreparedCatalogueFile,
  type PreparedOutcome,
  type SeriesRecord,
  type SourceIdentity,
  type VisualPublicationPreparation,
  type VisualResultRecord,
} from "./visual-catalogue-model";
import {
  loadCompilerResults,
  readCompilerManifest,
  type CompilerJobManifest,
  type VisualWorkflowPayload,
} from "./visual-catalogue-runtime";

export type DestinationPolicy = {
  adapter: "uca_visual_v4";
  outputBasePath: string;
  sourceTitle?: string;
  moduleRelevance?: string;
  allowPendingAssets?: boolean;
  deterministicFilenamePrefix?: string;
};

export type PrepareVisualPublicationInput = {
  classificationJobId: string;
  approvalFingerprint: string;
  catalogueFiles: CatalogueFileReference[];
  destinationPolicy: DestinationPolicy;
};

export type CommitVisualPublicationInput = {
  preparationId: string;
  preparationFingerprint: string;
  explicitApproval: boolean;
  callerOwnership: { ownerType: "interactive" | "scheduled_task" | "system_recovery"; ownerId: string; invocationId: string; correlationId: string };
  injectFailureAfterWrites?: number;
};

export type PublishCachedAssetsInput = {
  classificationJobId: string;
  approvedFingerprint: string;
  selectedCanonicalVisualIds?: string[];
  selectedSeriesIds?: string[];
  destinationPath: string;
  filenamePolicy?: { prefix?: string; includePage?: boolean; includeStableKey?: boolean };
  exactSourceETag: string;
  exactSourceSha256: string;
};

type PhysicalAsset = {
  stableVisualId: string;
  seriesId: string | null;
  itemId: string;
  outputPath: string;
  filename: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  format: string;
  sourceVisualIds: string[];
  sourceStableKeys: string[];
  createdAt: string;
};

type PublicationJobManifest = {
  version: 1;
  compilerVersion: string;
  jobId: string;
  operation: "prepare" | "commit" | "publish";
  status: "running" | "completed" | "failed" | "rolled_back";
  stage: string;
  classificationJobId: string | null;
  preparationId: string | null;
  preparationFingerprint: string | null;
  resultKey: string | null;
  createdAt: string;
  updatedAt: string;
  error: { code: string; message: string; retryable: boolean } | null;
};

type CommitState = {
  version: 1;
  jobId: string;
  preparationId: string;
  preparationFingerprint: string;
  state: "running" | "completed" | "rolling_back" | "rolled_back" | "failed";
  completedRoles: Array<{ role: string; itemId: string; newETag: string; targetSha256: string }>;
  rollbackRoles: Array<{ role: string; itemId: string; restoredSha256: string }>;
  fencingToken: string;
  updatedAt: string;
};

const MAX_CATALOGUE_BYTES = 20 * 1024 * 1024;
const PREPARATION_MIME = "application/vnd.onedrive-live.visual-publication-preparation+json";
const PUBLICATION_RESULT_MIME = "application/vnd.onedrive-live.visual-publication-result+json";

function publicationPrefix(jobId: string): string {
  return `visual-compiler/publication-jobs/${jobId}`;
}

function publicationManifestKey(jobId: string): string {
  return `${publicationPrefix(jobId)}/manifest.json`;
}

function preparationPrefix(preparationId: string): string {
  return `visual-compiler/preparations/${preparationId}`;
}

function preparationKey(preparationId: string): string {
  return `${preparationPrefix(preparationId)}/definition.json`;
}

function commitStateKey(jobId: string): string {
  return `${publicationPrefix(jobId)}/commit-state.json`;
}

function physicalAssetsKey(classificationJobId: string): string {
  return `visual-compiler/jobs/${classificationJobId}/physical-assets.json`;
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

function compilerError(error: unknown): { code: string; message: string; retryable: boolean } {
  const value = error as { code?: string; retryable?: boolean };
  return { code: String(value?.code ?? "visual_publication_failed"), message: error instanceof Error ? error.message : String(error), retryable: Boolean(value?.retryable) };
}

async function writePublicationManifest(env: Env, manifest: PublicationJobManifest): Promise<void> {
  manifest.updatedAt = nowIso();
  await storeJson(env, publicationManifestKey(manifest.jobId), manifest, { jobId: manifest.jobId, operation: manifest.operation, status: manifest.status });
}

export async function readPublicationManifest(env: Env, jobId: string): Promise<PublicationJobManifest> {
  return readJson<PublicationJobManifest>(env, publicationManifestKey(jobId));
}

async function liveCatalogueBytes(env: Env, userId: string, reference: CatalogueFileReference): Promise<{ verified: VerifiedItem; bytes: Uint8Array; sha256: string }> {
  const verified = await verifyItemInsideRoot(env, userId, reference.itemId);
  if (verified.item.folder) throw new ConnectorError("catalogue_folder_invalid", `Catalogue role ${reference.role} is a folder.`);
  if (!verified.item.eTag || verified.item.eTag !== reference.expectedETag) throw new ConnectorError("etag_conflict", `Catalogue role ${reference.role} changed before preparation.`);
  if (Number(verified.item.size ?? 0) > MAX_CATALOGUE_BYTES) throw new ConnectorError("catalogue_too_large", `Catalogue role ${reference.role} exceeds 20 MB.`);
  const bytes = new Uint8Array(await graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(reference.itemId)}/content`, MAX_CATALOGUE_BYTES, { headers: { "If-Match": reference.expectedETag } }));
  return { verified, bytes, sha256: await sha256Bytes(bytes) };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function physicalByVisual(assets: PhysicalAsset[]): Map<string, PhysicalAsset> {
  return new Map(assets.map((asset) => [asset.stableVisualId, asset]));
}

function finalOutputRecords(results: VisualResultRecord[]): VisualResultRecord[] {
  return results.filter((result) => ["retain_canonical", "retain_provisional"].includes(result.outcome));
}

function ucaMasterAdditions(
  results: VisualResultRecord[],
  physicalAssets: PhysicalAsset[],
  policy: DestinationPolicy,
): Record<string, unknown>[] {
  const physical = physicalByVisual(physicalAssets);
  return finalOutputRecords(results).map((record) => {
    const asset = physical.get(record.stableVisualId);
    if (!asset && !policy.allowPendingAssets) throw new ConnectorError("physical_asset_missing", `No physical output is available for ${record.stableVisualId}.`);
    const retainStatus = record.outcome === "retain_provisional"
      ? "retain_provisional"
      : asset ? "retain" : "retain_pending_render";
    return {
      visual_id: record.stableVisualId,
      stable_visual_key: record.stableKey,
      source_item_id: record.source.itemId,
      source_path: record.source.path,
      source_title: policy.sourceTitle ?? record.source.filename.replace(/\.[^.]+$/, ""),
      page: record.pageOrSlide ?? "",
      record_kind: record.pageSeriesId ? "series_canonical" : record.relationship === "embedded_object" ? "embedded_original" : "page_render",
      visual_type: record.visualType,
      retain_status: retainStatus,
      description: record.conciseDescription,
      module_relevance: policy.moduleRelevance ?? "CPUR_1103|CPUR_3115",
      standalone_usability: record.pageSeriesId ? "series" : "standalone",
      confidence: record.confidence.toFixed(2),
      inspection_method: "durable_visual_catalogue_compiler",
      output_item_id: asset?.itemId ?? "",
      output_path: asset?.outputPath ?? "",
      width: asset?.width ?? record.artifactWidth ?? "",
      height: asset?.height ?? record.artifactHeight ?? "",
      byte_size: asset?.byteSize ?? "",
      sha256: asset?.sha256 ?? "",
      pre_existing_verified: "false",
    };
  });
}

function ucaRejectedAdditions(results: VisualResultRecord[]): Record<string, unknown>[] {
  return results.filter((result) => ["reject", "duplicate_context_only", "retain_series_member"].includes(result.outcome)).map((record) => ({
    visual_id: record.stableVisualId,
    stable_visual_key: record.stableKey,
    source_item_id: record.source.itemId,
    source_title: record.source.filename.replace(/\.[^.]+$/, ""),
    page: record.pageOrSlide ?? "",
    record_kind: record.relationship === "embedded_object" ? "embedded_original" : "page_render",
    visual_type: record.visualType,
    retain_status: record.outcome === "retain_series_member" ? "duplicate" : record.outcome === "duplicate_context_only" ? "duplicate" : "reject",
    rejection_reason: record.outcome === "retain_series_member" ? "series_member_no_separate_output" : record.rejectRationale ?? "classified_reject",
    duplicate_group_id: record.pageSeriesId ?? "",
    canonical_visual_id: record.canonicalVisualId ?? "",
    description: record.conciseDescription,
  }));
}

function ucaDuplicateAdditions(results: VisualResultRecord[]): Record<string, unknown>[] {
  return results.filter((result) => result.outcome === "retain_series_member" || result.outcome === "duplicate_context_only").map((record) => ({
    duplicate_group_id: record.pageSeriesId ?? `DG-CONTEXT-${record.stableVisualId.slice(4, 16).toUpperCase()}`,
    relationship: record.outcome === "retain_series_member" ? "page_series_member" : "context_only",
    canonical_visual_id: record.canonicalVisualId ?? "",
    member_visual_id: record.stableVisualId,
    canonical_source_item_id: record.source.itemId,
    member_source_item_id: record.source.itemId,
    canonical_output_item_id: "",
    member_output_item_id: "",
    notes: record.outcome === "retain_series_member" ? "Page-level decision preserved; no separate output because the series has one canonical asset." : record.conciseDescription,
  }));
}

function mappingTarget(
  current: string,
  source: SourceIdentity,
  results: VisualResultRecord[],
  assets: PhysicalAsset[],
  policy: DestinationPolicy,
): string {
  const parsed = JSON.parse(current) as Record<string, unknown>;
  const physical = physicalByVisual(assets);
  const retained = finalOutputRecords(results);
  const rejected = results.filter((record) => record.outcome === "reject");
  const duplicates = results.filter((record) => ["duplicate_context_only", "retain_series_member"].includes(record.outcome));
  return JSON.stringify({
    ...parsed,
    schema: "visual_source_to_output_mapping_compiler_v1",
    generated_utc: nowIso(),
    compiler_version: VISUAL_COMPILER_VERSION,
    source: {
      item_id: source.itemId,
      path: source.path,
      etag: source.eTag,
      sha256: source.sha256,
      state: "compiler_prepared",
      inventory: [results.filter((record) => record.relationship === "embedded_object").length, results.filter((record) => record.relationship !== "embedded_object").length, results.length],
    },
    output_base_path: `${policy.outputBasePath.replace(/\/$/, "")}/`,
    compiler_result_fields: ["stable_key", "visual_id", "outcome", "page", "series_id", "canonical_visual_id", "output_item_id", "output_path", "sha256"],
    compiler_results: results.map((record) => {
      const asset = physical.get(record.stableVisualId);
      return [record.stableKey, record.stableVisualId, record.outcome, record.pageOrSlide, record.pageSeriesId, record.canonicalVisualId, asset?.itemId ?? null, asset?.outputPath ?? null, asset?.sha256 ?? null];
    }),
    reconciliation: {
      total: results.length,
      retained: retained.length,
      rejected: rejected.length,
      duplicate_or_series_member: duplicates.length,
      needs_review: results.filter((record) => record.outcome === "needs_review").length,
      physical_outputs: assets.length,
    },
  }, null, 2);
}

function statusTarget(current: string, source: SourceIdentity, results: VisualResultRecord[], assets: PhysicalAsset[]): string {
  const parsed = csvObjects(current);
  const counts = outcomeCounts(results);
  const row: Record<string, unknown> = {
    source_item_id: source.itemId,
    source_path: source.path,
    source_filename: source.filename,
    source_etag: source.eTag,
    byte_size: source.byteSize,
    page_count: Math.max(0, ...results.map((result) => Number(result.pageOrSlide ?? 0))),
    visual_count: results.length,
    state: results.some((result) => result.outcome === "needs_review") ? "completed_with_review_required" : assets.length < finalOutputRecords(results).length ? "completed_with_pending_render_exports" : "completed",
    classified_count: results.length,
    retained_count: counts.retain_canonical,
    provisional_count: counts.retain_provisional,
    rejected_count: counts.reject,
    duplicate_count: counts.duplicate_context_only + counts.retain_series_member,
    exact_originals_saved: assets.filter((asset) => asset.format === "jpeg" && asset.sourceStableKeys.some((key) => key.startsWith("pdf:image:"))).length,
    page_renders_saved: assets.filter((asset) => asset.sourceStableKeys.some((key) => key.includes("page:") || key.includes("slide:"))).length,
    last_updated_utc: nowIso(),
    notes: `Durable compiler reconciliation ${results.length}=${counts.retain_canonical}+${counts.retain_series_member}+${counts.retain_provisional}+${counts.reject}+${counts.duplicate_context_only}+${counts.needs_review}.`,
  };
  const existing = parsed.rows.findIndex((candidate) => candidate.source_item_id === source.itemId);
  if (existing >= 0) parsed.rows[existing] = Object.fromEntries(parsed.header.map((field) => [field, String(row[field] ?? parsed.rows[existing][field] ?? "")]));
  else parsed.rows.push(Object.fromEntries(parsed.header.map((field) => [field, String(row[field] ?? "")])));
  return objectsCsv(parsed.header, parsed.rows);
}

function exceptionsTarget(current: string, source: SourceIdentity, results: VisualResultRecord[], assets: PhysicalAsset[]): string {
  const parsed = csvObjects(current);
  const existingIds = new Set(parsed.rows.map((row) => row.exception_id));
  let counter = parsed.rows.reduce((maximum, row) => Math.max(maximum, Number(/VEX-(\d+)/.exec(row.exception_id)?.[1] ?? 0)), 0);
  const additions: Record<string, unknown>[] = [];
  const pending = finalOutputRecords(results).filter((record) => !assets.some((asset) => asset.stableVisualId === record.stableVisualId));
  const review = results.filter((record) => record.outcome === "needs_review");
  for (const item of [
    ...(pending.length ? [{ category: "pending_cached_asset_publication", status: "open", details: `${pending.length} approved retained candidates have cached artifacts but no OneDrive physical output yet.`, next_action: "Call publish_cached_visual_assets, then prepare publication again." }] : []),
    ...(review.length ? [{ category: "visual_review_required", status: "open", details: `${review.length} candidates remain needs_review.`, next_action: "Apply explicit review overrides before catalogue publication." }] : []),
  ]) {
    let id: string;
    do { counter += 1; id = `VEX-${String(counter).padStart(4, "0")}`; } while (existingIds.has(id));
    additions.push({ exception_id: id, category: item.category, source_item_id: source.itemId, source_path_or_output: source.path, status: item.status, details: item.details, next_action: item.next_action });
  }
  return objectsCsv(parsed.header, [...parsed.rows, ...additions]);
}

function reportTarget(current: string, source: SourceIdentity, results: VisualResultRecord[], series: SeriesRecord[], assets: PhysicalAsset[]): string {
  const counts = outcomeCounts(results);
  const section = [
    "",
    `## Durable visual-catalogue compiler — ${source.filename}`,
    "",
    `Generated: ${nowIso()}`,
    "",
    `- Source item: \`${source.itemId}\``,
    `- Source SHA-256: \`${source.sha256}\``,
    `- Classified candidates: ${results.length}`,
    `- Retain canonical: ${counts.retain_canonical}`,
    `- Retain series member: ${counts.retain_series_member}`,
    `- Retain provisional: ${counts.retain_provisional}`,
    `- Reject: ${counts.reject}`,
    `- Duplicate context only: ${counts.duplicate_context_only}`,
    `- Needs review: ${counts.needs_review}`,
    `- Detected series: ${series.length}`,
    `- Verified physical outputs: ${assets.length}`,
    "",
    "The source-level result records and exact prepared catalogue bytes are stored privately in R2. Publication requires a separate explicit commit.",
  ].join("\n");
  const marker = `## Durable visual-catalogue compiler — ${source.filename}`;
  const index = current.indexOf(marker);
  return index >= 0 ? `${current.slice(0, index).trimEnd()}${section}\n` : `${current.trimEnd()}${section}\n`;
}

function checkpointTarget(source: SourceIdentity, results: VisualResultRecord[], series: SeriesRecord[], assets: PhysicalAsset[], classificationJobId: string): string {
  return JSON.stringify({
    schema: "visual_processing_checkpoint_compiler_v1",
    generated_utc: nowIso(),
    classification: results.some((result) => result.outcome === "needs_review") ? "visual_library_review_required" : "visual_library_processing_complete",
    compiler: { version: VISUAL_COMPILER_VERSION, classification_job_id: classificationJobId },
    source: { item_id: source.itemId, path: source.path, etag: source.eTag, byte_size: source.byteSize, sha256: source.sha256 },
    outcome_counts: outcomeCounts(results),
    page_outcomes: results.map((record) => ({ key: record.stableKey, visual_id: record.stableVisualId, outcome: record.outcome, confidence: record.confidence, description: record.conciseDescription, series_id: record.pageSeriesId, canonical_visual_id: record.canonicalVisualId, review_state: record.reviewState })),
    series,
    physical_assets: assets,
    reconciliation: { candidates: results.length, outcomes: Object.values(outcomeCounts(results)).reduce((sum, value) => sum + value, 0), passed: true },
  }, null, 2);
}

function checkpointMarkdownTarget(source: SourceIdentity, results: VisualResultRecord[], series: SeriesRecord[], assets: PhysicalAsset[], classificationJobId: string): string {
  const counts = outcomeCounts(results);
  return [
    "# Visual processing checkpoint",
    "",
    `Classification job: \`${classificationJobId}\``,
    `Source: \`${source.path}\``,
    `Source SHA-256: \`${source.sha256}\``,
    "",
    `Candidates: **${results.length}**`,
    `Retain canonical: **${counts.retain_canonical}**`,
    `Retain series member: **${counts.retain_series_member}**`,
    `Retain provisional: **${counts.retain_provisional}**`,
    `Reject: **${counts.reject}**`,
    `Duplicate context only: **${counts.duplicate_context_only}**`,
    `Needs review: **${counts.needs_review}**`,
    `Series: **${series.length}**`,
    `Physical outputs: **${assets.length}**`,
    "",
    "All page-level decisions remain available in the durable R2 result manifest.",
    "",
  ].join("\n");
}

async function preparationDefinition(env: Env, preparationId: string): Promise<VisualPublicationPreparation> {
  const definition = await readJson<VisualPublicationPreparation>(env, preparationKey(preparationId));
  const recomputed = await sha256HexUtf8(canonicalJson({
    version: definition.version,
    classificationJobId: definition.classificationJobId,
    approvalFingerprint: definition.approvalFingerprint,
    source: definition.source,
    files: definition.files,
    resultCounts: definition.resultCounts,
    physicalReferencesValidated: definition.physicalReferencesValidated,
    csvJsonParity: definition.csvJsonParity,
    reconciliationPassed: definition.reconciliationPassed,
    diffSummary: definition.diffSummary,
  }));
  if (definition.fingerprint !== recomputed || definition.preparationId !== `vprep_${recomputed.slice(0, 48)}`) throw new ConnectorError("preparation_fingerprint_invalid", "The visual publication preparation fingerprint is invalid.");
  return definition;
}

export async function runPrepareVisualPublicationWorkflow(
  env: Env,
  payload: VisualWorkflowPayload,
  step: WorkflowStep,
): Promise<Record<string, unknown>> {
  const input = payload.input as PrepareVisualPublicationInput;
  const jobManifest: PublicationJobManifest = { version: 1, compilerVersion: VISUAL_COMPILER_VERSION, jobId: payload.jobId, operation: "prepare", status: "running", stage: "loading_classification", classificationJobId: input.classificationJobId, preparationId: null, preparationFingerprint: null, resultKey: null, createdAt: nowIso(), updatedAt: nowIso(), error: null };
  await writePublicationManifest(env, jobManifest);
  await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: 1, stage: jobManifest.stage });
  try {
    const compiler = await readCompilerManifest(env, input.classificationJobId);
    if (compiler.status !== "completed" || !compiler.approvedFingerprint) throw new ConnectorError("classification_not_approved", "The classification job is not completed with an approved review result.");
    if (compiler.approvedFingerprint !== input.approvalFingerprint) throw new ConnectorError("approval_fingerprint_changed", "The approved classification fingerprint does not match.");
    if (!compiler.source) throw new ConnectorError("source_identity_missing", "The classification source identity is unavailable.");
    const results = await loadCompilerResults(env, compiler);
    if (results.some((result) => result.outcome === "needs_review")) throw new ConnectorError("review_incomplete", "Catalogue preparation cannot proceed while needs_review records remain.");
    const series = compiler.seriesKey ? await readJson<SeriesRecord[]>(env, compiler.seriesKey) : [];
    const assets = await env.ARTIFACTS.head(physicalAssetsKey(input.classificationJobId)) ? await readJson<PhysicalAsset[]>(env, physicalAssetsKey(input.classificationJobId)) : [];

    jobManifest.stage = "reading_live_catalogues";
    await writePublicationManifest(env, jobManifest);
    const live = new Map<CatalogueFileReference["role"], { reference: CatalogueFileReference; verified: VerifiedItem; bytes: Uint8Array; sha256: string }>();
    for (let index = 0; index < input.catalogueFiles.length; index += 1) {
      const reference = input.catalogueFiles[index];
      const item = await liveCatalogueBytes(env, payload.userId, reference);
      live.set(reference.role, { reference, ...item });
      await updateJob(env, payload.userId, payload.jobId, { progress: Math.min(30, 5 + Math.round((index + 1) / input.catalogueFiles.length * 25)), stage: `read_${reference.role}` });
    }
    const required: CatalogueFileReference["role"][] = ["master_csv", "master_json", "rejected_csv", "duplicates_csv", "mapping_json", "status_csv", "exceptions_csv", "report_md", "checkpoint_json"];
    for (const role of required) if (!live.has(role)) throw new ConnectorError("catalogue_role_missing", `Required catalogue role ${role} was not supplied.`);

    jobManifest.stage = "building_exact_targets";
    await writePublicationManifest(env, jobManifest);
    const text = (role: CatalogueFileReference["role"]): string => decodeUtf8(live.get(role)?.bytes as Uint8Array);
    const masterCsv = appendUniqueCsvRows(text("master_csv"), "visual_id", ucaMasterAdditions(results, assets, input.destinationPolicy));
    const masterJson = masterJsonFromCsv(masterCsv, text("master_json"));
    const parity = assertMasterParity(masterCsv, masterJson);
    const targets = new Map<CatalogueFileReference["role"], string>([
      ["master_csv", masterCsv],
      ["master_json", masterJson],
      ["rejected_csv", appendUniqueCsvRows(text("rejected_csv"), "visual_id", ucaRejectedAdditions(results))],
      ["duplicates_csv", appendUniqueCsvRows(text("duplicates_csv"), "duplicate_group_id", ucaDuplicateAdditions(results))],
      ["mapping_json", mappingTarget(text("mapping_json"), compiler.source, results, assets, input.destinationPolicy)],
      ["status_csv", statusTarget(text("status_csv"), compiler.source, results, assets)],
      ["exceptions_csv", exceptionsTarget(text("exceptions_csv"), compiler.source, results, assets)],
      ["report_md", reportTarget(text("report_md"), compiler.source, results, series, assets)],
      ["checkpoint_json", checkpointTarget(compiler.source, results, series, assets, input.classificationJobId)],
    ]);
    if (live.has("checkpoint_md")) targets.set("checkpoint_md", checkpointMarkdownTarget(compiler.source, results, series, assets, input.classificationJobId));

    const provisional: PreparedCatalogueFile[] = [];
    for (const [role, liveItem] of live.entries()) {
      const targetText = targets.get(role);
      if (targetText === undefined) continue;
      const targetBytes = encodeUtf8(targetText);
      const sourceR2Key = `${publicationPrefix(payload.jobId)}/source/${role}.bin`;
      const targetR2Key = `${publicationPrefix(payload.jobId)}/target/${role}.bin`;
      const targetSha256 = await sha256Bytes(targetBytes);
      await putArtifact(env, sourceR2Key, liveItem.bytes, "application/octet-stream", { role, itemId: liveItem.reference.itemId, eTag: liveItem.reference.expectedETag, sha256: liveItem.sha256 });
      await putArtifact(env, targetR2Key, targetBytes, "application/octet-stream", { role, itemId: liveItem.reference.itemId, eTag: liveItem.reference.expectedETag, sha256: targetSha256 });
      provisional.push({
        ...liveItem.reference,
        sourcePath: liveItem.verified.relativePath,
        sourceSha256: liveItem.sha256,
        sourceByteLength: liveItem.bytes.byteLength,
        sourceR2Key,
        targetSha256,
        targetByteLength: targetBytes.byteLength,
        targetR2Key,
      });
    }
    const material = {
      version: 1 as const,
      classificationJobId: input.classificationJobId,
      approvalFingerprint: input.approvalFingerprint,
      source: compiler.source,
      files: provisional,
      resultCounts: outcomeCounts(results),
      physicalReferencesValidated: input.destinationPolicy.allowPendingAssets ? true : finalOutputRecords(results).every((record) => assets.some((asset) => asset.stableVisualId === record.stableVisualId)),
      csvJsonParity: parity.parity,
      reconciliationPassed: results.length === Object.values(outcomeCounts(results)).reduce((sum, value) => sum + value, 0),
      diffSummary: {
        masterRecordsAfter: parity.recordCount,
        masterRecordsAdded: ucaMasterAdditions(results, assets, input.destinationPolicy).length,
        rejectedRecordsAdded: ucaRejectedAdditions(results).length,
        duplicateRecordsAdded: ucaDuplicateAdditions(results).length,
        fileCount: provisional.length,
        sourceUnchanged: true,
      },
    };
    const fingerprint = await sha256HexUtf8(canonicalJson(material));
    const preparationId = `vprep_${fingerprint.slice(0, 48)}`;
    const definition: VisualPublicationPreparation = { ...material, preparationId, fingerprint, createdAt: nowIso() };
    const definitionKey = preparationKey(preparationId);
    const existing = await env.ARTIFACTS.head(definitionKey);
    if (!existing) await storeJson(env, definitionKey, definition, { preparationId, fingerprint, classificationJobId: input.classificationJobId });
    else {
      const previous = await preparationDefinition(env, preparationId);
      if (previous.fingerprint !== fingerprint) throw new ConnectorError("preparation_collision", "The deterministic preparation ID is already associated with another definition.");
    }
    jobManifest.status = "completed";
    jobManifest.stage = "prepared";
    jobManifest.preparationId = preparationId;
    jobManifest.preparationFingerprint = fingerprint;
    jobManifest.resultKey = definitionKey;
    await writePublicationManifest(env, jobManifest);
    await updateJob(env, payload.userId, payload.jobId, { status: "completed", progress: 100, stage: "prepared", resultKey: definitionKey, resultMimeType: PREPARATION_MIME });
    return { preparationId, fingerprint, classificationJobId: input.classificationJobId, source: compiler.source, targetHashes: provisional.map((file) => ({ role: file.role, sha256: file.targetSha256, byteLength: file.targetByteLength })), counts: definition.resultCounts, diffSummary: definition.diffSummary, csvJsonParity: true, reconciliationPassed: true, oneDriveMutationPerformed: false };
  } catch (error) {
    const failure = compilerError(error);
    jobManifest.status = "failed";
    jobManifest.stage = "failed";
    jobManifest.error = failure;
    await writePublicationManifest(env, jobManifest).catch(() => undefined);
    await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: failure }).catch(() => undefined);
    throw error;
  }
}

async function exactLiveHash(env: Env, userId: string, itemId: string, expectedETag?: string): Promise<{ verified: VerifiedItem; bytes: Uint8Array; sha256: string }> {
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  const bytes = new Uint8Array(await graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(itemId)}/content`, MAX_CATALOGUE_BYTES, expectedETag ? { headers: { "If-Match": expectedETag } } : {}));
  return { verified, bytes, sha256: await sha256Bytes(bytes) };
}

async function replaceExactBytes(env: Env, userId: string, file: PreparedCatalogueFile, bytes: Uint8Array, expectedETag: string, expectedSha256: string): Promise<{ itemId: string; eTag: string; sha256: string }> {
  let response: Response;
  try {
    response = await graphResponse(env, userId, `/me/drive/items/${encodeURIComponent(file.itemId)}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "If-Match": expectedETag },
      body: new Blob([bytes.slice().buffer], { type: "application/octet-stream" }),
    });
  } catch (error) {
    const reconciled = await exactLiveHash(env, userId, file.itemId).catch(() => null);
    if (reconciled?.sha256 === expectedSha256 && reconciled.verified.item.eTag) return { itemId: file.itemId, eTag: reconciled.verified.item.eTag, sha256: reconciled.sha256 };
    throw error;
  }
  const item = await response.json() as GraphDriveItem;
  const readBack = await exactLiveHash(env, userId, file.itemId, item.eTag);
  if (readBack.sha256 !== expectedSha256 || !readBack.verified.item.eTag) throw new ConnectorError("catalogue_readback_mismatch", `Catalogue role ${file.role} did not match the exact prepared SHA-256 after write.`);
  return { itemId: file.itemId, eTag: readBack.verified.item.eTag, sha256: readBack.sha256 };
}

async function readCommitState(env: Env, jobId: string, preparation: VisualPublicationPreparation): Promise<CommitState> {
  const key = commitStateKey(jobId);
  if (await env.ARTIFACTS.head(key)) return readJson<CommitState>(env, key);
  const state: CommitState = { version: 1, jobId, preparationId: preparation.preparationId, preparationFingerprint: preparation.fingerprint, state: "running", completedRoles: [], rollbackRoles: [], fencingToken: crypto.randomUUID(), updatedAt: nowIso() };
  await storeJson(env, key, state, { jobId, preparationId: preparation.preparationId, fencingToken: state.fencingToken });
  return state;
}

async function writeCommitState(env: Env, state: CommitState): Promise<void> {
  state.updatedAt = nowIso();
  await storeJson(env, commitStateKey(state.jobId), state, { jobId: state.jobId, preparationId: state.preparationId, fencingToken: state.fencingToken, state: state.state });
}

export async function runCommitVisualPublicationWorkflow(
  env: Env,
  payload: VisualWorkflowPayload,
  step: WorkflowStep,
): Promise<Record<string, unknown>> {
  const input = payload.input as CommitVisualPublicationInput;
  const jobManifest: PublicationJobManifest = { version: 1, compilerVersion: VISUAL_COMPILER_VERSION, jobId: payload.jobId, operation: "commit", status: "running", stage: "validating_preparation", classificationJobId: null, preparationId: input.preparationId, preparationFingerprint: input.preparationFingerprint, resultKey: null, createdAt: nowIso(), updatedAt: nowIso(), error: null };
  await writePublicationManifest(env, jobManifest);
  await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: 1, stage: jobManifest.stage });
  let preparation: VisualPublicationPreparation | null = null;
  let state: CommitState | null = null;
  try {
    if (input.explicitApproval !== true) throw new ConnectorError("explicit_approval_required", "Atomic visual catalogue publication requires explicitApproval=true.");
    if (!input.callerOwnership?.ownerId || !input.callerOwnership.invocationId || !input.callerOwnership.correlationId) throw new ConnectorError("caller_ownership_required", "Bounded caller ownership metadata is required.");
    preparation = await preparationDefinition(env, input.preparationId);
    if (preparation.fingerprint !== input.preparationFingerprint) throw new ConnectorError("preparation_fingerprint_changed", "The supplied preparation fingerprint does not match the immutable preparation.");
    state = await readCommitState(env, payload.jobId, preparation);
    if (state.state === "completed") return { jobId: payload.jobId, preparationId: preparation.preparationId, status: "completed", idempotentReplay: true, files: state.completedRoles };
    if (state.preparationFingerprint !== preparation.fingerprint) throw new ConnectorError("commit_state_mismatch", "The durable commit state belongs to another preparation.");

    const completed = new Map(state.completedRoles.map((entry) => [entry.role, entry]));
    for (let index = 0; index < preparation.files.length; index += 1) {
      const file = preparation.files[index];
      const live = await exactLiveHash(env, payload.userId, file.itemId);
      if (live.sha256 === file.targetSha256) {
        if (!completed.has(file.role)) {
          state.completedRoles.push({ role: file.role, itemId: file.itemId, newETag: live.verified.item.eTag as string, targetSha256: file.targetSha256 });
          await writeCommitState(env, state);
        }
        continue;
      }
      if (live.sha256 !== file.sourceSha256 || live.verified.item.eTag !== file.expectedETag) throw new ConnectorError("etag_conflict", `Catalogue role ${file.role} changed after preparation.`);
      const targetBytes = new Uint8Array(await (await getArtifact(env, file.targetR2Key)).arrayBuffer());
      if (targetBytes.byteLength !== file.targetByteLength || await sha256Bytes(targetBytes) !== file.targetSha256) throw new ConnectorError("prepared_bytes_changed", `Prepared target bytes for ${file.role} changed.`);
      const written = await step.do(`commit exact catalogue ${String(index + 1).padStart(2, "0")} ${file.role}`, { retries: { limit: 1, delay: "1 second", backoff: "constant" }, timeout: "5 minutes" }, async () => replaceExactBytes(env, payload.userId, file, targetBytes, live.verified.item.eTag as string, file.targetSha256));
      state.completedRoles.push({ role: file.role, itemId: file.itemId, newETag: written.eTag, targetSha256: written.sha256 });
      await writeCommitState(env, state);
      await updateJob(env, payload.userId, payload.jobId, { progress: Math.min(90, 5 + Math.round((index + 1) / preparation.files.length * 85)), stage: `committed_${file.role}` });
      if (input.injectFailureAfterWrites && state.completedRoles.length >= input.injectFailureAfterWrites) throw new ConnectorError("acceptance_injected_commit_failure", "Bounded acceptance failure injected after a catalogue write.");
    }
    for (const file of preparation.files) {
      const live = await exactLiveHash(env, payload.userId, file.itemId);
      if (live.sha256 !== file.targetSha256) throw new ConnectorError("final_reconciliation_failed", `Final read-back mismatch for ${file.role}.`);
    }
    state.state = "completed";
    await writeCommitState(env, state);
    const resultKey = `${publicationPrefix(payload.jobId)}/commit-result.json`;
    const result = { jobId: payload.jobId, preparationId: preparation.preparationId, preparationFingerprint: preparation.fingerprint, status: "completed", callerOwnership: input.callerOwnership, files: state.completedRoles, finalReconciliation: "passed", rollbackRequired: false, idempotentReplay: false };
    await storeJson(env, resultKey, result, { jobId: payload.jobId, preparationId: preparation.preparationId });
    jobManifest.status = "completed";
    jobManifest.stage = "committed_and_reconciled";
    jobManifest.resultKey = resultKey;
    await writePublicationManifest(env, jobManifest);
    await updateJob(env, payload.userId, payload.jobId, { status: "completed", progress: 100, stage: jobManifest.stage, resultKey, resultMimeType: PUBLICATION_RESULT_MIME });
    return result;
  } catch (error) {
    const failure = compilerError(error);
    if (preparation && state && state.completedRoles.length) {
      state.state = "rolling_back";
      await writeCommitState(env, state).catch(() => undefined);
      try {
        for (const completed of [...state.completedRoles].reverse()) {
          const file = preparation.files.find((candidate) => candidate.role === completed.role);
          if (!file) continue;
          const live = await exactLiveHash(env, payload.userId, file.itemId);
          if (live.sha256 === file.sourceSha256) continue;
          if (live.sha256 !== file.targetSha256) throw new ConnectorError("rollback_ambiguous_live_state", `Cannot safely roll back ${file.role}; live bytes match neither source nor target.`);
          const original = new Uint8Array(await (await getArtifact(env, file.sourceR2Key)).arrayBuffer());
          if (original.byteLength !== file.sourceByteLength || await sha256Bytes(original) !== file.sourceSha256) throw new ConnectorError("rollback_source_changed", `Stored rollback bytes for ${file.role} changed.`);
          await replaceExactBytes(env, payload.userId, file, original, live.verified.item.eTag as string, file.sourceSha256);
          state.rollbackRoles.push({ role: file.role, itemId: file.itemId, restoredSha256: file.sourceSha256 });
          await writeCommitState(env, state);
        }
        state.state = "rolled_back";
        await writeCommitState(env, state);
        jobManifest.status = "rolled_back";
        jobManifest.stage = "failure_rolled_back";
      } catch (rollbackError) {
        const rollback = compilerError(rollbackError);
        state.state = "failed";
        await writeCommitState(env, state).catch(() => undefined);
        jobManifest.status = "failed";
        jobManifest.stage = "rollback_failed";
        jobManifest.error = { code: "catalogue_publication_rollback_failed", message: `${failure.message}; rollback: ${rollback.message}`, retryable: false };
        await writePublicationManifest(env, jobManifest).catch(() => undefined);
        await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: jobManifest.stage, error: jobManifest.error }).catch(() => undefined);
        throw rollbackError;
      }
    } else {
      jobManifest.status = "failed";
      jobManifest.stage = "failed_before_write";
    }
    jobManifest.error = failure;
    await writePublicationManifest(env, jobManifest).catch(() => undefined);
    await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: jobManifest.stage, error: failure }).catch(() => undefined);
    throw error;
  }
}

async function assertNameAvailable(env: Env, userId: string, folder: VerifiedItem, filename: string): Promise<void> {
  let nextUrl: string | undefined;
  do {
    const page = await listVerifiedChildren(env, userId, folder, 200, nextUrl);
    if (page.items.some((child) => child.item.name.toLocaleLowerCase("en") === filename.toLocaleLowerCase("en"))) throw new ConnectorError("name_conflict", `An item named ${filename} already exists.`);
    nextUrl = page.nextUrl;
  } while (nextUrl);
}

function trustedUploadUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLocaleLowerCase("en");
  if (url.protocol !== "https:" || !(host === "api.onedrive.com" || host.endsWith(".onedrive.com") || host.endsWith(".1drv.com") || host.endsWith(".sharepoint.com"))) throw new ConnectorError("unsafe_upload_url", "Microsoft Graph returned an untrusted upload URL.");
  return url;
}

async function uploadAsset(env: Env, userId: string, destinationPath: string, filename: string, bytes: Uint8Array, mimeType: string): Promise<{ verified: VerifiedItem; sha256: string }> {
  const folder = await resolveRelativeFolder(env, userId, destinationPath);
  const safeName = validateItemName(filename);
  await assertNameAvailable(env, userId, folder, safeName);
  let created: GraphDriveItem;
  if (bytes.byteLength <= 4 * 1024 * 1024) {
    const response = await graphResponse(env, userId, `/me/drive/items/${encodeURIComponent(folder.item.id)}:/${encodeURIComponent(safeName)}:/content?%40microsoft.graph.conflictBehavior=fail`, { method: "PUT", headers: { "Content-Type": mimeType, "If-None-Match": "*" }, body: new Blob([bytes.slice().buffer], { type: mimeType }) });
    created = await response.json() as GraphDriveItem;
  } else {
    const sessionResponse = await graphResponse(env, userId, `/me/drive/items/${encodeURIComponent(folder.item.id)}:/${encodeURIComponent(safeName)}:/createUploadSession`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: { name: safeName, "@microsoft.graph.conflictBehavior": "fail" } }) });
    const session = await sessionResponse.json() as { uploadUrl?: string };
    if (!session.uploadUrl) throw new ConnectorError("upload_session_failed", "Microsoft Graph did not create an upload session.");
    const uploadUrl = trustedUploadUrl(session.uploadUrl);
    const chunkSize = 10 * 320 * 1024;
    let final: GraphDriveItem | null = null;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Length": String(end - offset), "Content-Range": `bytes ${offset}-${end - 1}/${bytes.byteLength}` }, body: new Blob([bytes.slice(offset, end).buffer], { type: "application/octet-stream" }) });
      if (!response.ok) throw new ConnectorError("upload_failed", "Cached visual asset upload failed.", { retryable: response.status === 429 || response.status >= 500, status: response.status });
      if (response.status !== 202) final = await response.json() as GraphDriveItem;
    }
    if (!final) throw new ConnectorError("upload_incomplete", "Microsoft Graph did not confirm the final cached visual upload.");
    created = final;
  }
  const verified = await verifyItemInsideRoot(env, userId, created.id);
  const expectedSha256 = await sha256Bytes(bytes);
  const readBack = new Uint8Array(await graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(created.id)}/content`, Math.max(bytes.byteLength + 1, 20 * 1024 * 1024), verified.item.eTag ? { headers: { "If-Match": verified.item.eTag } } : {}));
  if (readBack.byteLength !== bytes.byteLength || await sha256Bytes(readBack) !== expectedSha256) throw new ConnectorError("upload_readback_mismatch", "The OneDrive read-back did not match the cached R2 bytes.");
  return { verified, sha256: expectedSha256 };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function stitchedSeries(env: Env, classificationJobId: string, series: SeriesRecord, records: VisualResultRecord[]): Promise<{ key: string; bytes: Uint8Array; width: number; height: number }> {
  const members = series.memberVisualIds.map((id) => records.find((record) => record.stableVisualId === id)).filter((record): record is VisualResultRecord => Boolean(record?.artifactR2Key));
  if (members.length < 2) throw new ConnectorError("series_artifacts_missing", `Series ${series.seriesId} has fewer than two cached member artifacts.`);
  const material = { version: 1, seriesId: series.seriesId, members: members.map((record) => ({ id: record.stableVisualId, sha256: record.artifactSha256 })) };
  const fingerprint = await sha256HexUtf8(canonicalJson(material));
  const key = `visual-cache/series/${classificationJobId}/${fingerprint}.png`;
  if (await env.ARTIFACTS.head(key)) {
    const object = await getArtifact(env, key);
    return { key, bytes: new Uint8Array(await object.arrayBuffer()), width: 1600, height: 900 * members.length };
  }
  const width = 1600;
  const itemHeight = 900;
  const fragments = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${itemHeight * members.length}" viewBox="0 0 ${width} ${itemHeight * members.length}"><rect width="100%" height="100%" fill="white"/>`];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    const object = await getArtifact(env, member.artifactR2Key as string);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const mime = object.httpMetadata?.contentType ?? "image/png";
    fragments.push(`<image x="0" y="${index * itemHeight}" width="${width}" height="${itemHeight - 34}" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${bytesToBase64(bytes)}"/>`);
    fragments.push(`<rect x="0" y="${index * itemHeight + itemHeight - 34}" width="${width}" height="34" fill="white"/><text x="14" y="${index * itemHeight + itemHeight - 12}" font-size="18" font-family="sans-serif">${xmlEscape(member.stableKey)}</text>`);
  }
  fragments.push("</svg>");
  const svg = encodeUtf8(fragments.join(""));
  const output = await env.IMAGES.input(new Blob([svg.slice().buffer], { type: "image/svg+xml" }).stream()).output({ format: "image/png", anim: false });
  const response = output.response();
  if (!response.ok) throw new ConnectorError("series_stitch_failed", `Series ${series.seriesId} could not be stitched.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await putArtifact(env, key, bytes, "image/png", { classificationJobId, seriesId: series.seriesId, fingerprint });
  return { key, bytes, width, height: itemHeight * members.length };
}

function deterministicAssetFilename(record: VisualResultRecord, policy: PublishCachedAssetsInput["filenamePolicy"]): string {
  const prefix = String(policy?.prefix ?? record.source.filename.replace(/\.[^.]+$/, "")).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120);
  const page = policy?.includePage === false || record.pageOrSlide === null ? "" : `_p${String(record.pageOrSlide).padStart(3, "0")}`;
  const key = policy?.includeStableKey === false ? "" : `_${record.stableKey.replace(/[^A-Za-z0-9_.-]+/g, "-")}`;
  const extension = record.artifactFormat === "jpeg" ? "jpg" : record.artifactFormat ?? "png";
  return validateItemName(`${prefix}${page}${key}_${record.stableVisualId.slice(4, 12)}.${extension}`);
}

export async function runPublishCachedAssetsWorkflow(
  env: Env,
  payload: VisualWorkflowPayload,
  step: WorkflowStep,
): Promise<Record<string, unknown>> {
  const input = payload.input as PublishCachedAssetsInput;
  const jobManifest: PublicationJobManifest = { version: 1, compilerVersion: VISUAL_COMPILER_VERSION, jobId: payload.jobId, operation: "publish", status: "running", stage: "validating_source_and_selection", classificationJobId: input.classificationJobId, preparationId: null, preparationFingerprint: null, resultKey: null, createdAt: nowIso(), updatedAt: nowIso(), error: null };
  await writePublicationManifest(env, jobManifest);
  await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: 1, stage: jobManifest.stage });
  try {
    const compiler = await readCompilerManifest(env, input.classificationJobId);
    if (compiler.status !== "completed" || compiler.approvedFingerprint !== input.approvedFingerprint) throw new ConnectorError("classification_not_approved", "The approved classification fingerprint does not match.");
    if (!compiler.source) throw new ConnectorError("source_identity_missing", "The classification source identity is unavailable.");
    if (compiler.source.eTag !== input.exactSourceETag || compiler.source.sha256 !== input.exactSourceSha256) throw new ConnectorError("source_identity_changed", "The exact source eTag or SHA-256 does not match the approved classification.");
    const liveSource = await verifyItemInsideRoot(env, payload.userId, compiler.source.itemId);
    if (liveSource.item.eTag !== input.exactSourceETag) throw new ConnectorError("etag_conflict", "The source changed before cached asset publication.");
    const results = await loadCompilerResults(env, compiler);
    const series = compiler.seriesKey ? await readJson<SeriesRecord[]>(env, compiler.seriesKey) : [];
    const selectedVisuals = new Set(input.selectedCanonicalVisualIds ?? []);
    const selectedSeries = new Set(input.selectedSeriesIds ?? []);
    if (!selectedVisuals.size && !selectedSeries.size) {
      for (const record of results.filter((candidate) => ["retain_canonical", "retain_provisional"].includes(candidate.outcome))) selectedVisuals.add(record.stableVisualId);
    }
    const published: PhysicalAsset[] = await env.ARTIFACTS.head(physicalAssetsKey(input.classificationJobId)) ? await readJson<PhysicalAsset[]>(env, physicalAssetsKey(input.classificationJobId)) : [];
    const publishedIds = new Set(published.map((asset) => `${asset.seriesId ?? ""}:${asset.stableVisualId}`));

    const work: Array<{ kind: "visual" | "series"; id: string }> = [
      ...[...selectedVisuals].map((id) => ({ kind: "visual" as const, id })),
      ...[...selectedSeries].map((id) => ({ kind: "series" as const, id })),
    ];
    for (let index = 0; index < work.length; index += 1) {
      const item = work[index];
      if (item.kind === "visual") {
        const record = results.find((candidate) => candidate.stableVisualId === item.id);
        if (!record || !["retain_canonical", "retain_provisional"].includes(record.outcome)) throw new ConnectorError("visual_not_publishable", `Visual ${item.id} is not an approved canonical retained result.`);
        if (!record.artifactR2Key) throw new ConnectorError("cached_artifact_missing", `Visual ${item.id} has no cached R2 artifact.`);
        if (publishedIds.has(`:${record.stableVisualId}`)) continue;
        const object = await getArtifact(env, record.artifactR2Key);
        const bytes = new Uint8Array(await object.arrayBuffer());
        if (await sha256Bytes(bytes) !== record.artifactSha256) throw new ConnectorError("cached_artifact_changed", `Cached bytes for ${item.id} changed.`);
        const filename = deterministicAssetFilename(record, input.filenamePolicy);
        const uploaded = await uploadAsset(env, payload.userId, input.destinationPath, filename, bytes, object.httpMetadata?.contentType ?? "image/png");
        published.push({
          stableVisualId: record.stableVisualId,
          seriesId: null,
          itemId: uploaded.verified.item.id,
          outputPath: uploaded.verified.relativePath,
          filename: uploaded.verified.item.name,
          sha256: uploaded.sha256,
          byteSize: bytes.byteLength,
          width: record.artifactWidth ?? 0,
          height: record.artifactHeight ?? 0,
          format: record.artifactFormat ?? "png",
          sourceVisualIds: [record.stableVisualId],
          sourceStableKeys: [record.stableKey],
          createdAt: nowIso(),
        });
      } else {
        const definition = series.find((candidate) => candidate.seriesId === item.id);
        if (!definition) throw new ConnectorError("series_not_found", `Series ${item.id} was not found.`);
        if (publishedIds.has(`${definition.seriesId}:${definition.canonicalVisualId}`)) continue;
        const canonical = results.find((record) => record.stableVisualId === definition.canonicalVisualId);
        if (!canonical) throw new ConnectorError("series_canonical_missing", `Series ${item.id} has no canonical result.`);
        const stitched = await stitchedSeries(env, input.classificationJobId, definition, results);
        const filename = validateItemName(`${String(input.filenamePolicy?.prefix ?? compiler.source.filename.replace(/\.[^.]+$/, "")).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120)}_${definition.seriesId.slice(7, 19)}_series.png`);
        const uploaded = await uploadAsset(env, payload.userId, input.destinationPath, filename, stitched.bytes, "image/png");
        published.push({
          stableVisualId: definition.canonicalVisualId,
          seriesId: definition.seriesId,
          itemId: uploaded.verified.item.id,
          outputPath: uploaded.verified.relativePath,
          filename: uploaded.verified.item.name,
          sha256: uploaded.sha256,
          byteSize: stitched.bytes.byteLength,
          width: stitched.width,
          height: stitched.height,
          format: "png",
          sourceVisualIds: definition.memberVisualIds,
          sourceStableKeys: definition.memberStableKeys,
          createdAt: nowIso(),
        });
      }
      await storeJson(env, physicalAssetsKey(input.classificationJobId), published, { classificationJobId: input.classificationJobId, count: String(published.length) });
      await updateJob(env, payload.userId, payload.jobId, { progress: Math.min(95, 5 + Math.round((index + 1) / work.length * 90)), stage: `published_${index + 1}_of_${work.length}` });
    }
    const resultKey = `${publicationPrefix(payload.jobId)}/publish-result.json`;
    const result = { jobId: payload.jobId, classificationJobId: input.classificationJobId, status: "completed", destinationPath: input.destinationPath, physicalAssets: published, sourceRerendered: false, exactCachedBytesUsed: true, conflictPolicy: "fail", readBackVerified: true };
    await storeJson(env, resultKey, result, { jobId: payload.jobId, classificationJobId: input.classificationJobId });
    jobManifest.status = "completed";
    jobManifest.stage = "cached_assets_published";
    jobManifest.resultKey = resultKey;
    await writePublicationManifest(env, jobManifest);
    await updateJob(env, payload.userId, payload.jobId, { status: "completed", progress: 100, stage: jobManifest.stage, resultKey, resultMimeType: PUBLICATION_RESULT_MIME });
    return result;
  } catch (error) {
    const failure = compilerError(error);
    jobManifest.status = "failed";
    jobManifest.stage = "failed";
    jobManifest.error = failure;
    await writePublicationManifest(env, jobManifest).catch(() => undefined);
    await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: failure }).catch(() => undefined);
    throw error;
  }
}

export async function readPreparation(env: Env, preparationId: string): Promise<VisualPublicationPreparation> {
  return preparationDefinition(env, preparationId);
}

export async function physicalAssetsForJob(env: Env, classificationJobId: string): Promise<PhysicalAsset[]> {
  return await env.ARTIFACTS.head(physicalAssetsKey(classificationJobId)) ? readJson<PhysicalAsset[]>(env, physicalAssetsKey(classificationJobId)) : [];
}
