import { canonicalJson, sha256HexUtf8 } from "./paid-core";

export const VISUAL_COMPILER_VERSION = "odl-req-020-v1";
export const VISUAL_RUBRIC_VERSION = "uca-visual-rubric-2026-08-02";
export const VISUAL_PROMPT_VERSION = "visual-source-classifier-2026-08-02";
export const VISUAL_RENDERER_VERSION = "pdfjs-cache-v1";

export const PREPARED_OUTCOMES = [
  "retain_canonical",
  "retain_series_member",
  "retain_provisional",
  "reject",
  "duplicate_context_only",
  "needs_review",
] as const;

export type PreparedOutcome = typeof PREPARED_OUTCOMES[number];
export type SourceType = "academic" | "spatial_plan" | "donor_report" | "design_guideline" | "visual_compendium" | "presentation" | "scan_heavy" | "unknown";
export type RoutingMode = "embedded_first" | "page_compositions" | "slide_compositions" | "bounded_page_vision";
export type ReviewState = "unreviewed" | "review_required" | "approved" | "overridden";

export type SourceIdentity = {
  itemId: string;
  path: string;
  filename: string;
  eTag: string;
  byteSize: number;
  sha256: string;
};

export type VisualCandidate = {
  stableVisualId: string;
  stableKey: string;
  pageOrSlide: number | null;
  parentPages: number[];
  relationship: "page" | "slide" | "embedded_object";
  renderRequired: boolean;
  embeddedArtifactId: string | null;
  embeddedArtifactKey: string | null;
  embeddedSha256: string | null;
  caption: string | null;
  heading: string | null;
  nearbyText: string | null;
};

export type RenderCacheDescriptor = {
  sourceSha256: string;
  stableKey: string;
  outputFormat: "png" | "jpeg" | "webp";
  width: number;
  dpi: number | null;
  crop: { x: number; y: number; width: number; height: number } | null;
  rendererVersion: string;
};

export type RenderArtifactManifest = {
  renderArtifactId: string;
  cacheKey: string;
  r2Key: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp";
  mimeType: string;
  cacheHit: boolean;
  createdAt: string;
};

export type ClassificationProposal = {
  outcome: PreparedOutcome;
  confidence: number;
  visualType: string;
  conciseDescription: string;
  retainRationale: string | null;
  rejectRationale: string | null;
  reusableVisualStructure: boolean;
  continuationLikely: boolean;
  continuationTitle: string | null;
  deterministicOutcome: PreparedOutcome | null;
  deterministicReason: string | null;
  modelOutcome: PreparedOutcome | null;
  modelReason: string | null;
  disagreement: boolean;
  secondPassApplied: boolean;
};

export type VisualResultRecord = {
  version: 1;
  jobId: string;
  source: SourceIdentity;
  stableVisualId: string;
  stableKey: string;
  pageOrSlide: number | null;
  parentPages: number[];
  relationship: VisualCandidate["relationship"];
  renderArtifactId: string | null;
  embeddedArtifactId: string | null;
  artifactSha256: string | null;
  artifactWidth: number | null;
  artifactHeight: number | null;
  artifactFormat: string | null;
  artifactR2Key: string | null;
  sourceType: SourceType;
  routingMode: RoutingMode;
  outcome: PreparedOutcome;
  confidence: number;
  conciseDescription: string;
  retainRationale: string | null;
  rejectRationale: string | null;
  visualType: string;
  pageSeriesId: string | null;
  canonicalVisualId: string | null;
  reviewState: ReviewState;
  deterministicOutcome: PreparedOutcome | null;
  modelOutcome: PreparedOutcome | null;
  disagreement: boolean;
  modelProvider: string;
  model: string;
  pinnedModelVersion: string;
  rubricVersion: string;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
  error: { code: string; message: string; retryable: boolean } | null;
  classifierArtifactId?: string | null;
  classifierArtifactSha256?: string | null;
  classifierArtifactWidth?: number | null;
  classifierArtifactHeight?: number | null;
  classifierEndpointFamily?: string | null;
  classificationPassNumber?: number | null;
  responseLatencyMilliseconds?: number | null;
  parserResult?: string | null;
  schemaValidationResult?: string | null;
  sanitizedUsage?: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  reviewRoutingReason?: string | null;
};

export type SeriesRecord = {
  seriesId: string;
  memberVisualIds: string[];
  memberStableKeys: string[];
  canonicalVisualId: string;
  publicationMode: "canonical_member" | "stitched_series";
  rationale: string;
  confidence: number;
};

export type ReviewOverride = {
  stableVisualId: string;
  outcome?: PreparedOutcome;
  conciseDescription?: string;
  visualType?: string;
  pageSeriesId?: string | null;
  canonicalVisualId?: string | null;
  reviewNote?: string;
};

export type ReviewPacketSummary = {
  jobId: string;
  source: SourceIdentity;
  outcomeCounts: Record<PreparedOutcome, number>;
  confidenceBuckets: { high: number; medium: number; low: number };
  series: SeriesRecord[];
  disagreements: string[];
  errors: Array<{ stableVisualId: string; error: VisualResultRecord["error"] }>;
  reviewVisualIds: string[];
  deterministicSampleVisualIds: string[];
  approvalFingerprint: string;
  reviewInstructions?: string;
};

export type CatalogueFileReference = {
  role: "master_csv" | "master_json" | "rejected_csv" | "duplicates_csv" | "mapping_json" | "status_csv" | "exceptions_csv" | "report_md" | "checkpoint_json" | "checkpoint_md";
  itemId: string;
  expectedETag: string;
};

export type PreparedCatalogueFile = CatalogueFileReference & {
  sourcePath: string;
  sourceSha256: string;
  sourceByteLength: number;
  sourceR2Key: string;
  targetSha256: string;
  targetByteLength: number;
  targetR2Key: string;
};

export type VisualPublicationPreparation = {
  version: 1;
  preparationId: string;
  fingerprint: string;
  classificationJobId: string;
  approvalFingerprint: string;
  source: SourceIdentity;
  files: PreparedCatalogueFile[];
  resultCounts: Record<PreparedOutcome, number>;
  physicalReferencesValidated: boolean;
  csvJsonParity: boolean;
  reconciliationPassed: boolean;
  diffSummary: Record<string, unknown>;
  createdAt: string;
};

function canonicalCrop(crop: RenderCacheDescriptor["crop"]): RenderCacheDescriptor["crop"] {
  if (!crop) return null;
  return {
    x: Number(crop.x.toFixed(4)),
    y: Number(crop.y.toFixed(4)),
    width: Number(crop.width.toFixed(4)),
    height: Number(crop.height.toFixed(4)),
  };
}

export async function renderCacheIdentity(descriptor: RenderCacheDescriptor): Promise<{ renderArtifactId: string; r2Key: string; fingerprint: string }> {
  const material = {
    version: 1,
    sourceSha256: descriptor.sourceSha256.toLowerCase(),
    stableKey: descriptor.stableKey,
    outputFormat: descriptor.outputFormat,
    width: Math.round(descriptor.width),
    dpi: descriptor.dpi === null ? null : Math.round(descriptor.dpi),
    crop: canonicalCrop(descriptor.crop),
    rendererVersion: descriptor.rendererVersion,
  };
  const fingerprint = await sha256HexUtf8(canonicalJson(material));
  return {
    fingerprint,
    renderArtifactId: `render_${fingerprint.slice(0, 48)}`,
    r2Key: `visual-cache/${descriptor.sourceSha256.toLowerCase()}/${fingerprint.slice(0, 2)}/${fingerprint}.${descriptor.outputFormat}`,
  };
}

export function routeForSource(sourceType: SourceType): RoutingMode {
  if (sourceType === "academic") return "embedded_first";
  if (sourceType === "presentation") return "slide_compositions";
  if (sourceType === "scan_heavy") return "bounded_page_vision";
  return "page_compositions";
}

export function inferSourceType(filename: string, explicit?: SourceType): SourceType {
  if (explicit && explicit !== "unknown") return explicit;
  const value = filename.toLocaleLowerCase("en");
  if (/\.pptx$|\.potx$|\.ppsx$/.test(value)) return "presentation";
  if (/design[_ -]?guide|guideline/.test(value)) return "design_guideline";
  if (/spatial|masterplan|master_plan|strategy|strategic_plan/.test(value)) return "spatial_plan";
  if (/compendium|atlas/.test(value)) return "visual_compendium";
  if (/article|journal|chapter|paper|thesis|research/.test(value)) return "academic";
  if (/scan|scanned/.test(value)) return "scan_heavy";
  if (/donor|report|profile/.test(value)) return "donor_report";
  return "unknown";
}

export function boundedConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, Number(number.toFixed(4))));
}

export function deterministicPageHeuristic(input: {
  pageOrSlide: number | null;
  nearbyText?: string | null;
  byteSize?: number | null;
  isExactDuplicate?: boolean;
}): { outcome: PreparedOutcome | null; reason: string | null; confidence: number } {
  if (input.isExactDuplicate) return { outcome: "duplicate_context_only", reason: "Exact duplicate artifact bytes.", confidence: 1 };
  const text = String(input.nearbyText ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
  if ((input.byteSize ?? Number.MAX_SAFE_INTEGER) < 700) return { outcome: "reject", reason: "Implausibly small or blank rendered artifact.", confidence: 0.995 };
  if (text && /^(contents|table of contents|содержание|мазмуну)\b/.test(text)) return { outcome: "reject", reason: "Contents page.", confidence: 0.99 };
  if (text && /(copyright|all rights reserved|disclaimer|credits|authors?|acknowledg(e)?ments)/.test(text) && text.length < 1800) {
    return { outcome: "reject", reason: "Credits, rights, or administrative page.", confidence: 0.97 };
  }
  if (input.pageOrSlide === 1 && text && /(report|plan|strategy|guideline|profile)/.test(text) && text.length < 600) {
    return { outcome: "reject", reason: "Branding-dominated cover page.", confidence: 0.92 };
  }
  return { outcome: null, reason: null, confidence: 0 };
}

export function requiresSecondPass(proposal: ClassificationProposal, highConfidenceReject = 0.94): boolean {
  if (proposal.disagreement) return true;
  if (proposal.confidence < 0.78) return true;
  if (proposal.outcome === "reject" && proposal.confidence < highConfidenceReject) return true;
  if (proposal.outcome === "reject" && proposal.reusableVisualStructure) return true;
  if (["map", "plan", "diagram", "framework", "chart", "implementation_composition"].includes(proposal.visualType)) return true;
  if (proposal.continuationLikely) return true;
  return false;
}

export function enforceFalseRejectProtection(
  proposal: ClassificationProposal,
  knownRetained: boolean,
): ClassificationProposal {
  if (!knownRetained || proposal.outcome !== "reject") return proposal;
  return {
    ...proposal,
    outcome: "needs_review",
    confidence: Math.min(proposal.confidence, 0.74),
    rejectRationale: proposal.rejectRationale,
    retainRationale: proposal.retainRationale ?? "Existing controlled decision retains this page; automatic rejection is prohibited.",
    disagreement: true,
    secondPassApplied: true,
  };
}

function significantTokens(value: string): Set<string> {
  const stop = new Set(["the", "and", "for", "with", "from", "into", "page", "map", "plan", "strategy", "continuation", "showing"]);
  return new Set(value.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{4,}/gu)?.filter((token) => !stop.has(token)) ?? []);
}

function tokenSimilarity(left: string, right: string): number {
  const a = significantTokens(left);
  const b = significantTokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

export async function detectVisualSeries(results: VisualResultRecord[]): Promise<SeriesRecord[]> {
  const candidates = results
    .filter((record) => record.pageOrSlide !== null && ["retain_canonical", "retain_provisional", "needs_review"].includes(record.outcome))
    .sort((left, right) => Number(left.pageOrSlide) - Number(right.pageOrSlide));
  const groups: VisualResultRecord[][] = [];
  let current: VisualResultRecord[] = [];
  for (const record of candidates) {
    const previous = current.at(-1);
    const adjacent = previous && Number(record.pageOrSlide) === Number(previous.pageOrSlide) + 1;
    const visualFamily = new Set(["map", "plan", "diagram", "framework", "implementation_composition"]);
    const sameFamily = previous && (record.visualType === previous.visualType || visualFamily.has(record.visualType) && visualFamily.has(previous.visualType));
    const similarity = previous ? tokenSimilarity(previous.conciseDescription, record.conciseDescription) : 0;
    const continuation = /continuation|continued|eastern|western|part\s+[2-9]/i.test(record.conciseDescription);
    if (previous && adjacent && (sameFamily || similarity >= 0.24 || continuation)) {
      current.push(record);
    } else {
      if (current.length >= 2) groups.push(current);
      current = [record];
    }
  }
  if (current.length >= 2) groups.push(current);

  const series: SeriesRecord[] = [];
  for (const group of groups) {
    const material = { version: 1, members: group.map((record) => record.stableVisualId) };
    const digest = await sha256HexUtf8(canonicalJson(material));
    const canonical = group.reduce((best, record) => record.confidence > best.confidence ? record : best, group[0]);
    const stitch = group.length <= 4 && group.every((record) => record.renderArtifactId);
    series.push({
      seriesId: `series_${digest.slice(0, 48)}`,
      memberVisualIds: group.map((record) => record.stableVisualId),
      memberStableKeys: group.map((record) => record.stableKey),
      canonicalVisualId: canonical.stableVisualId,
      publicationMode: stitch ? "stitched_series" : "canonical_member",
      rationale: "Adjacent pages share visual family, vocabulary, or explicit continuation cues.",
      confidence: boundedConfidence(Math.min(...group.map((record) => record.confidence)) * 0.95),
    });
  }
  return series;
}

export function applySeries(results: VisualResultRecord[], series: SeriesRecord[]): VisualResultRecord[] {
  const byMember = new Map<string, SeriesRecord>();
  for (const item of series) for (const member of item.memberVisualIds) byMember.set(member, item);
  return results.map((record) => {
    const item = byMember.get(record.stableVisualId);
    if (!item) return record;
    const canonical = item.canonicalVisualId === record.stableVisualId;
    return {
      ...record,
      outcome: canonical ? record.outcome : "retain_series_member",
      pageSeriesId: item.seriesId,
      canonicalVisualId: item.canonicalVisualId,
      updatedAt: new Date().toISOString(),
    };
  });
}

export function outcomeCounts(results: VisualResultRecord[]): Record<PreparedOutcome, number> {
  const counts = Object.fromEntries(PREPARED_OUTCOMES.map((outcome) => [outcome, 0])) as Record<PreparedOutcome, number>;
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}

export function confidenceBuckets(results: VisualResultRecord[]): { high: number; medium: number; low: number } {
  return results.reduce((counts, result) => {
    if (result.confidence >= 0.9) counts.high += 1;
    else if (result.confidence >= 0.7) counts.medium += 1;
    else counts.low += 1;
    return counts;
  }, { high: 0, medium: 0, low: 0 });
}

export function selectReviewVisuals(
  results: VisualResultRecord[],
  series: SeriesRecord[],
  highConfidenceReject = 0.94,
  deterministicSampleSize = 4,
): { reviewVisualIds: string[]; sampleVisualIds: string[] } {
  const review = new Set<string>();
  for (const record of results) {
    if (record.outcome === "needs_review" || record.disagreement || record.error) review.add(record.stableVisualId);
    if (record.outcome === "reject" && record.confidence < highConfidenceReject) review.add(record.stableVisualId);
  }
  for (const item of series) for (const member of item.memberVisualIds) review.add(member);
  const accepted = results.filter((record) => record.outcome === "retain_canonical" && record.confidence >= 0.9).sort((a, b) => a.stableVisualId.localeCompare(b.stableVisualId));
  const rejected = results.filter((record) => record.outcome === "reject" && record.confidence >= highConfidenceReject).sort((a, b) => a.stableVisualId.localeCompare(b.stableVisualId));
  const sample = [...accepted.slice(0, Math.ceil(deterministicSampleSize / 2)), ...rejected.slice(0, Math.floor(deterministicSampleSize / 2))];
  return { reviewVisualIds: [...review], sampleVisualIds: sample.map((record) => record.stableVisualId) };
}

export async function reviewFingerprint(input: {
  jobId: string;
  resultFingerprints: Array<{ stableVisualId: string; outcome: PreparedOutcome; confidence: number; pageSeriesId: string | null; canonicalVisualId: string | null }>;
  series: SeriesRecord[];
  overrides?: ReviewOverride[];
}): Promise<string> {
  return sha256HexUtf8(canonicalJson({ version: 1, ...input }));
}

export function applyReviewOverrides(results: VisualResultRecord[], overrides: ReviewOverride[]): VisualResultRecord[] {
  const byId = new Map(overrides.map((override) => [override.stableVisualId, override]));
  return results.map((record) => {
    const override = byId.get(record.stableVisualId);
    if (!override) return record;
    return {
      ...record,
      outcome: override.outcome ?? record.outcome,
      conciseDescription: override.conciseDescription ?? record.conciseDescription,
      visualType: override.visualType ?? record.visualType,
      pageSeriesId: override.pageSeriesId === undefined ? record.pageSeriesId : override.pageSeriesId,
      canonicalVisualId: override.canonicalVisualId === undefined ? record.canonicalVisualId : override.canonicalVisualId,
      reviewState: "overridden",
      updatedAt: new Date().toISOString(),
    };
  });
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((value) => value.some((fieldValue) => fieldValue.length));
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function csvObjects(text: string): { header: string[]; rows: Record<string, string>[] } {
  const parsed = parseCsv(text);
  const header = parsed[0] ?? [];
  return { header, rows: parsed.slice(1).map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""]))) };
}

export function objectsCsv(header: string[], rows: Record<string, unknown>[]): string {
  return serializeCsv([header, ...rows.map((row) => header.map((key) => String(row[key] ?? "")))]);
}

export function appendUniqueCsvRows(
  text: string,
  keyField: string,
  additions: Record<string, unknown>[],
): string {
  const parsed = csvObjects(text);
  if (!parsed.header.includes(keyField)) throw new Error(`CSV key field ${keyField} is missing.`);
  const existing = new Set(parsed.rows.map((row) => row[keyField]));
  for (const addition of additions) {
    const key = String(addition[keyField] ?? "");
    if (!key || existing.has(key)) continue;
    parsed.rows.push(Object.fromEntries(parsed.header.map((field) => [field, String(addition[field] ?? "")])))
    existing.add(key);
  }
  return objectsCsv(parsed.header, parsed.rows);
}

export function masterJsonFromCsv(csvText: string, currentJsonText: string): string {
  const parsed = parseCsv(csvText);
  const current = JSON.parse(currentJsonText) as { schema?: unknown; records?: unknown } | unknown[];
  if (Array.isArray(current)) {
    const header = parsed[0] ?? [];
    return JSON.stringify(parsed.slice(1).map((row) => Object.fromEntries(header.map((field, index) => [field, row[index] ?? ""]))), null, 2);
  }
  if (!current || typeof current !== "object" || !Array.isArray((current as { schema?: unknown }).schema) || !Array.isArray((current as { records?: unknown }).records)) {
    throw new Error("Unsupported master JSON representation.");
  }
  const schema = (current as { schema: string[] }).schema;
  const csvHeader = parsed[0] ?? [];
  if (canonicalJson(schema) !== canonicalJson(csvHeader)) throw new Error("Master CSV/JSON schema mismatch.");
  return JSON.stringify({ ...(current as Record<string, unknown>), schema, records: parsed.slice(1) }, null, 2);
}

export function assertMasterParity(csvText: string, jsonText: string): { recordCount: number; parity: true } {
  const csv = parseCsv(csvText);
  const parsed = JSON.parse(jsonText) as { schema?: string[]; records?: string[][] } | Array<Record<string, unknown>>;
  if (Array.isArray(parsed)) {
    if (parsed.length !== Math.max(0, csv.length - 1)) throw new Error("Master CSV/JSON record count mismatch.");
    return { recordCount: parsed.length, parity: true };
  }
  if (!Array.isArray(parsed.schema) || !Array.isArray(parsed.records)) throw new Error("Master JSON records are invalid.");
  if (canonicalJson(parsed.schema) !== canonicalJson(csv[0] ?? [])) throw new Error("Master CSV/JSON field mismatch.");
  if (canonicalJson(parsed.records) !== canonicalJson(csv.slice(1))) throw new Error("Master CSV/JSON row mismatch.");
  return { recordCount: parsed.records.length, parity: true };
}
