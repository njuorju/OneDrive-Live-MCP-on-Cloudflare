import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError, safeErrorResult } from "./errors";
import {
  GRAPH_ROOT,
  compactVerifiedItem,
  downloadVerifiedItem,
  getGraphAccessToken,
  graphFetchBytes,
  graphResponse,
  listVerifiedChildren,
  resolveRelativeFolder,
  resolveRelativeItem,
  strictRelativePath,
  validateItemName,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import { readAllowedFile } from "./onedrive-files";
import { fetchImageForAnalysisSecure } from "./visual-assets";
import {
  createFolderInVerifiedDestinationStrict,
  createFolderStrict,
  createTextFileInVerifiedDestinationStrict,
  createTextFileStrict,
  moveItemStrict,
  moveVerifiedItemStrict,
  renameItemStrict,
  renameVerifiedItemStrict,
  replaceTextFileStrict,
  replaceVerifiedTextFileStrict,
} from "./write-operations";
import { extensionOf, isVisualAsset, normalizedMimeType, validateFileSignature } from "./file-types";
import { openJson, sealJson, sha256Hex } from "./security";
import type { CompactItem, GraphDriveItem } from "./types";
import {
  INTEGRATED_LIMITS,
  baseNameForWork,
  bytesToBase64,
  extensionOfName,
  extractVisualBytes,
  hammingDistanceHex,
  inspectDocx,
  inspectHtml,
  inspectPdfBytes,
  inspectPptx,
  normalizeExtractedText,
  parseCsv,
  pngDifferenceHash,
  safeUnzipOoxml,
  sha256Bytes,
  sha256Text,
  stripXml,
  toCsv,
  xmlText,
  type DocumentVisualCandidate,
  type OoxmlEntryMap,
} from "./integrated-core";
import {
  MAX_MUTATIONS_PER_INVOCATION,
  advanceDependencySkips,
  normalizeProgress,
  remainingActions,
  uniqueStrings,
  upsertFailure,
  upsertResult,
} from "./integrity-execution";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".svg", ".bmp", ".tif", ".tiff"]);
const OOXML_PRESENTATION_EXTENSIONS = new Set([".pptx", ".potx", ".ppsx"]);
const OOXML_WORD_EXTENSIONS = new Set([".docx"]);
const TEXT_READABLE_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".potx", ".ppsx", ".html", ".htm", ".txt", ".md", ".markdown", ".csv", ".json"]);
const BINARY_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".pdf"]);
const ADMIN_DEFAULT_PATTERNS = [
  "(^|/)_Catalogue(/|$)", "(^|/)(catalogue|catalog|manifest|inventory|report|log|audit)([^/]*)(\\.|/|$)",
  "(^|/)README(?:\\.[^/]+)?$", "(^|/)(duplicate|deletion|operation)[_-]?(register|log|report)",
];

export type StorageLike = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;

export type IntegratedContext = {
  env: Env;
  userId: string;
  storage: StorageLike;
  transaction?: <T>(closure: (transaction: StorageLike) => Promise<T>) => Promise<T>;
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type SnapshotRecord = CompactItem & {
  snapshotIndex: number;
  parentItemId: string | null;
  createdDate: string | null;
  sha256: string | null;
  normalizedTextSha256: string | null;
  extractedCharacterCount: number | null;
  extractionStatus: string | null;
  representationStatus: string | null;
  documentMetadata: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
};

export type SnapshotMeta = {
  snapshotId: string;
  scopePath: string;
  createdAt: string;
  expiresAt: string;
  rootItemId: string;
  rootETag: string | null;
  totalFiles: number;
  totalFolders: number;
  totalRecords: number;
  complete: boolean;
  options: Record<string, unknown>;
  errors: Array<{ itemId?: string; path?: string; code: string; message: string }>;
  jobId: string;
};

export type JobRecord = {
  jobId: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  resultReferences: Record<string, unknown>;
  error: { code: string; message: string; retryable: boolean } | null;
};

export type PlanAction = {
  actionId: string;
  action: "KEEP" | "RENAME" | "MOVE" | "RECYCLE" | "METADATA_ONLY" | "CATALOGUE_ONLY" | "CREATE_TEXT" | "REPLACE_TEXT" | "CREATE_FOLDER" | "RECYCLE_FOLDER";
  sourceItemId?: string | null;
  sourcePath?: string | null;
  destinationPath?: string | null;
  currentFilename?: string | null;
  proposedFilename?: string | null;
  snapshotETag?: string | null;
  snapshotSha256?: string | null;
  normalizedTextSha256?: string | null;
  reason?: string | null;
  evidence?: unknown;
  destructive?: boolean;
  ambiguity?: boolean | "yes" | "no";
  finalDecision?: string | null;
  operationOrder?: number;
  dependencies?: string[];
  content?: string | null;
  requiredStructuralPlaceholder?: boolean;
};

export type IntegrityPlan = {
  planId: string;
  snapshotId: string;
  scopePath: string;
  createdAt: string;
  expiresAt: string;
  status: "draft" | "validated" | "running" | "completed" | "failed";
  validationStatus: "not_validated" | "valid" | "invalid";
  executionStatus: "not_started" | "running" | "completed" | "failed";
  currentAction: string | null;
  actions: PlanAction[];
  completedActions: string[];
  failedActions: Array<{ actionId: string; code: string; message: string; retryable?: boolean; status?: number; correlationId?: string; details?: Record<string, unknown> }>;
  skippedDependencyActions: string[];
  results: Array<Record<string, unknown>>;
  deletionLogsPrepared: string[];
  finalFilesystemDiffReference: string | null;
  nextAction?: string | null;
  auditStatus?: "not_requested" | "pending" | "running" | "completed" | "failed";
  completedInvocations?: number;
  lastExecutionAt?: string | null;
  planHash: string;
};

type VisualToken = {
  version: 1;
  itemId: string;
  eTag: string | null;
  filename: string;
  extension: string;
  candidate: DocumentVisualCandidate;
  expiresAt: number;
};

type SnapshotInput = {
  scopePath: string;
  recursive: boolean;
  includeFiles: boolean;
  includeFolders: boolean;
  calculateSha256: boolean;
  calculateNormalizedTextHash: boolean;
  includeDocumentMetadata: boolean;
  includeExtractionStatus: boolean;
  maximumItems: number;
  maximumDepth: number;
  extensionAllowlist?: string[];
  extensionDenylist?: string[];
};

function textResult(data: unknown): CallToolResult {
  const structuredContent = data && typeof data === "object" ? data as Record<string, unknown> : { value: data };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  return safeErrorResult(error) as CallToolResult;
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiryIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function connectorError(error: unknown): ConnectorError {
  return error instanceof ConnectorError
    ? error
    : new ConnectorError("integrated_operation_failed", error instanceof Error ? error.message : "The integrated operation failed.");
}

function snapshotMetaKey(snapshotId: string): string {
  return `integrated:snapshot:${snapshotId}:meta`;
}

function snapshotItemKey(snapshotId: string, index: number): string {
  return `integrated:snapshot:${snapshotId}:item:${String(index).padStart(8, "0")}`;
}

function snapshotPrefix(snapshotId: string): string {
  return `integrated:snapshot:${snapshotId}:item:`;
}

function jobKey(jobId: string): string {
  return `integrated:job:${jobId}`;
}

function planKey(planId: string): string {
  return `integrated:plan:${planId}`;
}

function operationKey(planId: string, actionId: string): string {
  return `integrated:operation:${planId}:${actionId}`;
}

function lockPrefix(): string {
  return "integrated:lock:";
}

function scopeContains(scopePath: string, candidatePath: string): boolean {
  const scope = strictRelativePath(scopePath).toLocaleLowerCase("en");
  const candidate = strictRelativePath(candidatePath).toLocaleLowerCase("en");
  return !scope || candidate === scope || candidate.startsWith(`${scope}/`);
}

function normalizeExtensionList(values?: string[]): Set<string> | null {
  if (!values?.length) return null;
  return new Set(values.map((value) => value.startsWith(".") ? value.toLocaleLowerCase("en") : `.${value.toLocaleLowerCase("en")}`));
}

function isExpired(value: { expiresAt: string }): boolean {
  return Date.parse(value.expiresAt) <= Date.now();
}

async function putJob(context: IntegratedContext, job: JobRecord): Promise<void> {
  job.updatedAt = nowIso();
  await context.storage.put(jobKey(job.jobId), job);
}

async function getJob(context: IntegratedContext, jobId: string): Promise<JobRecord> {
  const job = await context.storage.get<JobRecord>(jobKey(jobId));
  if (!job || isExpired(job)) throw new ConnectorError("job_not_found", "The job does not exist or has expired.");
  return job;
}

async function getSnapshotMeta(context: IntegratedContext, snapshotId: string): Promise<SnapshotMeta> {
  const meta = await context.storage.get<SnapshotMeta>(snapshotMetaKey(snapshotId));
  if (!meta || isExpired(meta)) throw new ConnectorError("snapshot_not_found", "The snapshot does not exist or has expired.");
  return meta;
}

async function listSnapshotRecords(context: IntegratedContext, snapshotId: string): Promise<SnapshotRecord[]> {
  await getSnapshotMeta(context, snapshotId);
  const values = await context.storage.list<SnapshotRecord>({ prefix: snapshotPrefix(snapshotId) });
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

async function getPlan(context: IntegratedContext, planId: string): Promise<IntegrityPlan> {
  const plan = await context.storage.get<IntegrityPlan>(planKey(planId));
  if (!plan || isExpired(plan)) throw new ConnectorError("plan_not_found", "The integrity plan does not exist or has expired.");
  return plan;
}

async function storePlan(context: IntegratedContext, plan: IntegrityPlan): Promise<void> {
  await context.storage.put(planKey(plan.planId), plan);
}

async function shaForItem(context: IntegratedContext, itemId: string): Promise<{ sha256: string; byteSize: number; eTag: string | null; verified: VerifiedItem; buffer: ArrayBuffer }> {
  const { verified, buffer } = await downloadVerifiedItem(context.env, context.userId, itemId, INTEGRATED_LIMITS.fileBytesMax);
  return { sha256: await sha256Bytes(buffer), byteSize: buffer.byteLength, eTag: verified.item.eTag ?? null, verified, buffer };
}

async function readAllExtractedText(context: IntegratedContext, itemId: string): Promise<{ text: string; truncated: boolean; metadata: CompactItem }> {
  let start = 0;
  let text = "";
  let metadata: CompactItem | null = null;
  while (text.length < INTEGRATED_LIMITS.normalizedTextCharsMax) {
    const page = await readAllowedFile(context.env, context.userId, itemId, start, 50_000);
    metadata = page;
    text += page.content;
    if (!page.hasMore) return { text, truncated: false, metadata: page };
    start += page.returnedChars;
    if (page.returnedChars === 0) break;
  }
  if (!metadata) throw new ConnectorError("extraction_failed", "No document text could be extracted.");
  return { text: text.slice(0, INTEGRATED_LIMITS.normalizedTextCharsMax), truncated: true, metadata };
}

function languageIndicators(text: string, declared?: string | null): Record<string, unknown> {
  const sample = text.slice(0, 20_000);
  const cyrillic = (sample.match(/[\u0400-\u04ff]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  const languages: string[] = [];
  if (cyrillic > 50) languages.push("cyrillic-script");
  if (latin > 50) languages.push("latin-script");
  if (declared) languages.unshift(declared);
  return { declared: declared ?? null, indicators: [...new Set(languages)], cyrillicCharacters: cyrillic, latinCharacters: latin };
}

async function inspectDocumentInternal(
  context: IntegratedContext,
  itemId: string,
  options: {
    startPosition?: number;
    maximumOutput?: number;
    includeMetadata?: boolean;
    includeHeadings?: boolean;
    includeCaptions?: boolean;
    includeHyperlinks?: boolean;
    includeFirstPage?: boolean;
    includeHtmlDiagnostics?: boolean;
    includeVisualSummaryMetadata?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const verified = await verifyItemInsideRoot(context.env, context.userId, itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "Document inspection requires a file.");
  const extension = extensionOf(verified.item.name);
  if (!TEXT_READABLE_EXTENSIONS.has(extension) && !IMAGE_EXTENSIONS.has(extension)) {
    throw new ConnectorError("unsupported_document_type", "This file type is not supported for deterministic inspection.");
  }
  const maximumOutput = Math.min(Math.max(options.maximumOutput ?? 30_000, 1_000), 100_000);
  const startPosition = Math.max(options.startPosition ?? 0, 0);
  let extractedText = "";
  let extractionMethod = "none";
  let extractionConfidence: "high" | "medium" | "low" = "low";
  let pageOrSlideCount: number | null = null;
  let embeddedImageCount: number | null = null;
  let metadata: Record<string, unknown> = {};
  let headings: string[] = [];
  let captions: string[] = [];
  let hyperlinks: string[] = [];
  let htmlDiagnostics: ReturnType<typeof inspectHtml> | null = null;
  let visuals: DocumentVisualCandidate[] = [];
  let headerFooterText: string | null = null;
  let declaredLanguage: string | null = null;
  let truncated = false;

  if (IMAGE_EXTENSIONS.has(extension)) {
    const image = await fetchImageForAnalysisSecure(context.env, context.userId, itemId, "low", 768);
    return {
      ...compactVerifiedItem(verified),
      internalTitle: null,
      authorOrOrganisation: null,
      creationYear: null,
      languageIndicators: [],
      firstSubstantiveHeadings: [],
      captions: [],
      pageOrSlideCount: 1,
      embeddedImageCount: 1,
      hyperlinks: [],
      applicationMetadata: image.metadata,
      titlePageText: null,
      headerFooterText: null,
      extractionConfidence: "high",
      extractionMethod: "image_metadata",
      imageOnlyOrUnextractable: true,
      representationStatus: "image_only_or_unextractable",
      htmlDiagnostics: null,
      visualSummaryMetadata: { looseImage: true },
      boundedText: "",
      boundedStartPosition: 0,
      boundedReturnedCharacters: 0,
      truncated: false,
    };
  }

  if (OOXML_PRESENTATION_EXTENSIONS.has(extension) || OOXML_WORD_EXTENSIONS.has(extension)) {
    const { buffer } = await downloadVerifiedItem(context.env, context.userId, itemId, INTEGRATED_LIMITS.fileBytesMax);
    const entries = safeUnzipOoxml(buffer);
    if (OOXML_PRESENTATION_EXTENSIONS.has(extension)) {
      const inspected = inspectPptx(entries);
      extractedText = inspected.text;
      metadata = inspected.metadata;
      pageOrSlideCount = inspected.pageCount;
      embeddedImageCount = inspected.embeddedImageCount;
      visuals = inspected.visuals;
      headings = inspected.text.split(/\n\n/).map((section) => section.split("\n")[1]).filter((value): value is string => Boolean(value)).slice(0, 20);
      extractionMethod = "ooxml_xml";
      extractionConfidence = "high";
    } else {
      const inspected = inspectDocx(entries);
      extractedText = inspected.text;
      metadata = inspected.metadata;
      pageOrSlideCount = inspected.pageCount;
      embeddedImageCount = inspected.embeddedImageCount;
      visuals = inspected.visuals;
      headings = inspected.headings;
      captions = inspected.captions;
      hyperlinks = inspected.hyperlinks;
      headerFooterText = Object.keys(entries)
        .filter((name) => /^word\/(header|footer)\d+\.xml$/i.test(name))
        .map((name) => stripXml(xmlText(entries, name)))
        .filter(Boolean)
        .join("\n") || null;
      extractionMethod = "ooxml_xml";
      extractionConfidence = "high";
    }
  } else {
    const { text, truncated: extractionTruncated } = await readAllExtractedText(context, itemId);
    extractedText = text;
    truncated = extractionTruncated;
    extractionMethod = extension === ".pdf" ? "workers_ai_markdown" : "direct_text_or_workers_ai";
    extractionConfidence = extension === ".pdf" ? "medium" : "high";
    if (extension === ".pdf") {
      const { buffer } = await downloadVerifiedItem(context.env, context.userId, itemId, INTEGRATED_LIMITS.fileBytesMax);
      const pdf = inspectPdfBytes(buffer);
      pageOrSlideCount = pdf.pageCount;
      embeddedImageCount = pdf.visuals.filter((visual) => visual.objectType === "embedded_raster").length;
      visuals = pdf.visuals;
      metadata = { title: pdf.title, author: pdf.author };
    }
    if (extension === ".html" || extension === ".htm") {
      const { buffer } = await downloadVerifiedItem(context.env, context.userId, itemId, INTEGRATED_LIMITS.fileBytesMax);
      const html = new TextDecoder().decode(buffer);
      htmlDiagnostics = inspectHtml(html);
      declaredLanguage = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? null;
      metadata = {
        ...metadata,
        title: stripXml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") || null,
        author: /<meta\b[^>]*\bname\s*=\s*["']author["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] ?? null,
      };
      hyperlinks = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]).slice(0, 500);
      headings = [...html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((match) => stripXml(match[1])).filter(Boolean).slice(0, 100);
      captions = [...html.matchAll(/<(?:figcaption|caption)\b[^>]*>([\s\S]*?)<\/(?:figcaption|caption)>/gi)].map((match) => stripXml(match[1])).filter(Boolean).slice(0, 100);
    }
  }

  const normalized = normalizeExtractedText(extractedText);
  const bounded = extractedText.slice(startPosition, startPosition + maximumOutput);
  const title = String(metadata.title ?? "") || headings[0] || null;
  const author = String(metadata.author ?? "") || null;
  const creationValue = String(metadata.created ?? metadata.creationDate ?? "");
  const year = /\b(19|20)\d{2}\b/.exec(creationValue)?.[0] ?? null;
  return {
    ...compactVerifiedItem(verified),
    internalTitle: title,
    authorOrOrganisation: author,
    creationYear: year,
    languageIndicators: languageIndicators(extractedText, declaredLanguage),
    firstSubstantiveHeadings: options.includeHeadings === false ? undefined : headings.slice(0, 50),
    captions: options.includeCaptions === false ? undefined : captions.slice(0, 100),
    pageOrSlideCount,
    embeddedImageCount,
    hyperlinks: options.includeHyperlinks === false ? undefined : hyperlinks.slice(0, 500),
    applicationMetadata: options.includeMetadata === false ? undefined : metadata,
    titlePageText: options.includeFirstPage === false ? undefined : extractedText.slice(0, 4_000),
    headerFooterText,
    extractionConfidence,
    extractionMethod,
    imageOnlyOrUnextractable: normalized.representationStatus === "image_only_or_unextractable",
    representationStatus: normalized.representationStatus,
    representationExplanation: normalized.explanation ?? null,
    htmlDiagnostics: options.includeHtmlDiagnostics === false ? undefined : htmlDiagnostics,
    visualSummaryMetadata: options.includeVisualSummaryMetadata === false ? undefined : {
      candidateCount: visuals.length,
      exactOriginalCount: visuals.filter((visual) => visual.exactOriginalAvailable).length,
      renderRequiredCount: visuals.filter((visual) => !visual.exactOriginalAvailable && visual.renderAvailable).length,
      objectTypes: [...new Set(visuals.map((visual) => visual.objectType))],
    },
    boundedText: bounded,
    boundedStartPosition: startPosition,
    boundedReturnedCharacters: bounded.length,
    totalExtractedCharacters: extractedText.length,
    truncated: truncated || startPosition + bounded.length < extractedText.length,
  };
}

async function normalizedHashForItem(context: IntegratedContext, itemId: string): Promise<{
  normalizedTextSha256: string | null;
  extractedCharacterCount: number;
  extractionMethod: string;
  extractionConfidence: string;
  representationStatus: string;
  explanation: string | null;
}> {
  try {
    const inspected = await inspectDocumentInternal(context, itemId, { maximumOutput: 1_000, includeMetadata: false, includeHeadings: false, includeCaptions: false, includeHyperlinks: false, includeFirstPage: false, includeHtmlDiagnostics: true, includeVisualSummaryMetadata: false });
    if (inspected.representationStatus !== "text_readable") {
      return {
        normalizedTextSha256: null,
        extractedCharacterCount: Number(inspected.totalExtractedCharacters ?? 0),
        extractionMethod: String(inspected.extractionMethod ?? "none"),
        extractionConfidence: String(inspected.extractionConfidence ?? "low"),
        representationStatus: "image_only_or_unextractable",
        explanation: String(inspected.representationExplanation ?? "No extractable text."),
      };
    }
    const { text } = await readAllExtractedText(context, itemId).catch(async () => {
      const verified = await verifyItemInsideRoot(context.env, context.userId, itemId);
      const extension = extensionOf(verified.item.name);
      const { buffer } = await downloadVerifiedItem(context.env, context.userId, itemId, INTEGRATED_LIMITS.fileBytesMax);
      if (OOXML_PRESENTATION_EXTENSIONS.has(extension)) return { text: inspectPptx(safeUnzipOoxml(buffer)).text };
      if (OOXML_WORD_EXTENSIONS.has(extension)) return { text: inspectDocx(safeUnzipOoxml(buffer)).text };
      return { text: "" };
    });
    const normalized = normalizeExtractedText(text);
    return {
      normalizedTextSha256: normalized.normalizedText ? await sha256Text(normalized.normalizedText) : null,
      extractedCharacterCount: normalized.extractedCharacterCount,
      extractionMethod: String(inspected.extractionMethod ?? "deterministic"),
      extractionConfidence: String(inspected.extractionConfidence ?? "medium"),
      representationStatus: normalized.representationStatus,
      explanation: normalized.explanation ?? null,
    };
  } catch (error) {
    const safe = connectorError(error);
    return {
      normalizedTextSha256: null,
      extractedCharacterCount: 0,
      extractionMethod: "failed",
      extractionConfidence: "low",
      representationStatus: "image_only_or_unextractable",
      explanation: `${safe.code}: ${safe.message}`,
    };
  }
}

type IntegratedListedItem = GraphDriveItem & { createdDateTime?: string };

async function listIntegratedChildren(
  context: IntegratedContext,
  folder: VerifiedItem,
  nextUrl?: string,
): Promise<{ items: VerifiedItem[]; nextUrl?: string }> {
  const currentFolder = await verifyItemInsideRoot(context.env, context.userId, folder.item.id);
  const select = "id,name,size,file,folder,package,image,photo,parentReference,createdDateTime,lastModifiedDateTime,eTag,cTag,remoteItem,deleted";
  const response = await graphRaw(
    context,
    nextUrl ?? `/me/drive/items/${encodeURIComponent(currentFolder.item.id)}/children?$top=200&$select=${encodeURIComponent(select)}`,
  );
  const body = await response.json() as { value?: IntegratedListedItem[]; "@odata.nextLink"?: string };
  const items: VerifiedItem[] = [];
  for (const listed of body.value ?? []) {
    const verified = await verifyItemInsideRoot(context.env, context.userId, listed.id);
    (verified.item as IntegratedListedItem).createdDateTime = listed.createdDateTime;
    items.push(verified);
  }
  return { items, nextUrl: body["@odata.nextLink"] };
}

async function snapshotRecordForItem(
  context: IntegratedContext,
  verified: VerifiedItem,
  index: number,
  input: SnapshotInput,
): Promise<SnapshotRecord> {
  const compact = compactVerifiedItem(verified);
  const record: SnapshotRecord = {
    ...compact,
    snapshotIndex: index,
    parentItemId: verified.item.parentReference?.id ?? null,
    createdDate: (verified.item as IntegratedListedItem).createdDateTime ?? null,
    sha256: null,
    normalizedTextSha256: null,
    extractedCharacterCount: null,
    extractionStatus: null,
    representationStatus: null,
    documentMetadata: null,
    error: null,
  };
  if (verified.item.folder) return record;
  try {
    if (input.calculateSha256) record.sha256 = (await shaForItem(context, verified.item.id)).sha256;
    if (input.calculateNormalizedTextHash && TEXT_READABLE_EXTENSIONS.has(record.extension)) {
      const normalized = await normalizedHashForItem(context, verified.item.id);
      record.normalizedTextSha256 = normalized.normalizedTextSha256;
      record.extractedCharacterCount = normalized.extractedCharacterCount;
      record.extractionStatus = normalized.extractionMethod;
      record.representationStatus = normalized.representationStatus;
    }
    if (input.includeDocumentMetadata && TEXT_READABLE_EXTENSIONS.has(record.extension)) {
      const inspected = await inspectDocumentInternal(context, verified.item.id, { maximumOutput: 1_000, includeFirstPage: true, includeVisualSummaryMetadata: true });
      record.documentMetadata = {
        internalTitle: inspected.internalTitle,
        authorOrOrganisation: inspected.authorOrOrganisation,
        creationYear: inspected.creationYear,
        languageIndicators: inspected.languageIndicators,
        pageOrSlideCount: inspected.pageOrSlideCount,
        embeddedImageCount: inspected.embeddedImageCount,
        applicationMetadata: inspected.applicationMetadata,
      };
      record.extractionStatus = String(inspected.extractionMethod ?? record.extractionStatus ?? "unknown");
      record.representationStatus = String(inspected.representationStatus ?? record.representationStatus ?? "unknown");
    }
  } catch (error) {
    const safe = connectorError(error);
    record.error = { code: safe.code, message: safe.message };
    if (input.includeExtractionStatus) record.extractionStatus = "failed";
  }
  return record;
}

async function runSnapshot(context: IntegratedContext, snapshotId: string, jobId: string, input: SnapshotInput): Promise<void> {
  const job = await getJob(context, jobId);
  job.status = "running";
  job.currentStage = "enumerating";
  await putJob(context, job);
  const root = await resolveRelativeFolder(context.env, context.userId, input.scopePath);
  const meta: SnapshotMeta = {
    snapshotId,
    scopePath: strictRelativePath(input.scopePath),
    createdAt: nowIso(),
    expiresAt: expiryIso(INTEGRATED_LIMITS.snapshotRetentionSeconds),
    rootItemId: root.item.id,
    rootETag: root.item.eTag ?? null,
    totalFiles: 0,
    totalFolders: 0,
    totalRecords: 0,
    complete: false,
    options: input,
    errors: [],
    jobId,
  };
  await context.storage.put(snapshotMetaKey(snapshotId), meta);
  const allow = normalizeExtensionList(input.extensionAllowlist);
  const deny = normalizeExtensionList(input.extensionDenylist);
  const queue: Array<{ folder: VerifiedItem; depth: number }> = [{ folder: root, depth: 0 }];
  let recordIndex = 0;
  try {
    while (queue.length > 0 && recordIndex < input.maximumItems) {
      const current = queue.shift();
      if (!current) break;
      let nextUrl: string | undefined;
      do {
        const page = await listIntegratedChildren(context, current.folder, nextUrl);
        nextUrl = page.nextUrl;
        for (const child of page.items) {
          if (recordIndex >= input.maximumItems) break;
          if (child.item.folder) {
            if (input.includeFolders) {
              const record = await snapshotRecordForItem(context, child, recordIndex, input);
              await context.storage.put(snapshotItemKey(snapshotId, recordIndex), record);
              recordIndex += 1;
              meta.totalFolders += 1;
            }
            if (input.recursive && current.depth < input.maximumDepth) queue.push({ folder: child, depth: current.depth + 1 });
            continue;
          }
          const extension = extensionOf(child.item.name);
          if (allow && !allow.has(extension)) continue;
          if (deny?.has(extension)) continue;
          if (!input.includeFiles) continue;
          const record = await snapshotRecordForItem(context, child, recordIndex, input);
          await context.storage.put(snapshotItemKey(snapshotId, recordIndex), record);
          recordIndex += 1;
          meta.totalFiles += 1;
          job.progress = Math.min(99, Math.floor(recordIndex / input.maximumItems * 100));
          job.currentStage = input.calculateSha256 || input.calculateNormalizedTextHash ? "hashing_and_extracting" : "enumerating";
          if (recordIndex % 25 === 0) await putJob(context, job);
        }
      } while (nextUrl && recordIndex < input.maximumItems);
    }
    meta.totalRecords = recordIndex;
    meta.complete = queue.length === 0;
    if (!meta.complete) meta.errors.push({ code: "maximum_items_reached", message: "The snapshot reached maximumItems before enumeration completed." });
    await context.storage.put(snapshotMetaKey(snapshotId), meta);
    job.status = "completed";
    job.progress = 100;
    job.currentStage = "completed";
    job.resultReferences = { snapshotId, scopePath: meta.scopePath, totalFiles: meta.totalFiles, totalFolders: meta.totalFolders, complete: meta.complete };
    await putJob(context, job);
  } catch (error) {
    const safe = connectorError(error);
    meta.totalRecords = recordIndex;
    meta.complete = false;
    meta.errors.push({ code: safe.code, message: safe.message });
    await context.storage.put(snapshotMetaKey(snapshotId), meta);
    job.status = "failed";
    job.currentStage = "failed";
    job.error = { code: safe.code, message: safe.message, retryable: safe.retryable };
    await putJob(context, job);
  }
}

async function createSourceSnapshot(context: IntegratedContext, raw: SnapshotInput): Promise<Record<string, unknown>> {
  const input: SnapshotInput = {
    ...raw,
    scopePath: strictRelativePath(raw.scopePath),
    maximumItems: Math.min(Math.max(raw.maximumItems || INTEGRATED_LIMITS.snapshotItemsDefault, 1), INTEGRATED_LIMITS.snapshotItemsMax),
    maximumDepth: Math.min(Math.max(raw.maximumDepth || INTEGRATED_LIMITS.recursionDepthDefault, 0), INTEGRATED_LIMITS.recursionDepthMax),
  };
  await resolveRelativeFolder(context.env, context.userId, input.scopePath);
  const snapshotId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const job: JobRecord = {
    jobId,
    type: "source_snapshot",
    status: "queued",
    progress: 0,
    currentStage: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: expiryIso(INTEGRATED_LIMITS.jobRetentionSeconds),
    resultReferences: { snapshotId },
    error: null,
  };
  await putJob(context, job);
  const expensive = input.calculateSha256 || input.calculateNormalizedTextHash || input.includeDocumentMetadata || input.maximumItems > 500;
  const promise = runSnapshot(context, snapshotId, jobId, input);
  if (expensive && context.waitUntil) {
    context.waitUntil(promise);
    return { snapshotId, scopePath: input.scopePath, createdAt: job.createdAt, totalFiles: 0, totalFolders: 0, jobId, asynchronous: true };
  }
  await promise;
  const meta = await getSnapshotMeta(context, snapshotId);
  return { ...meta, asynchronous: false };
}

function matchesSnapshotFilter(
  record: SnapshotRecord,
  filter: Record<string, unknown>,
  duplicateSha: Set<string>,
  duplicateNormalized: Set<string>,
  emptyFolderIds: Set<string>,
): boolean {
  const path = String(filter.relativePath ?? "").toLocaleLowerCase("en");
  const filename = String(filter.filename ?? "").toLocaleLowerCase("en");
  const extension = String(filter.extension ?? "").toLocaleLowerCase("en");
  const mimeType = String(filter.mimeType ?? "").toLocaleLowerCase("en");
  if (path && !record.relativePath.toLocaleLowerCase("en").includes(path)) return false;
  if (filename && !record.filename.toLocaleLowerCase("en").includes(filename)) return false;
  if (extension && record.extension !== (extension.startsWith(".") ? extension : `.${extension}`)) return false;
  if (mimeType && !(record.mimeType ?? "").toLocaleLowerCase("en").includes(mimeType)) return false;
  if (filter.itemType && record.type !== filter.itemType) return false;
  if (filter.minimumSize !== undefined && (record.byteSize ?? 0) < Number(filter.minimumSize)) return false;
  if (filter.maximumSize !== undefined && (record.byteSize ?? Number.POSITIVE_INFINITY) > Number(filter.maximumSize)) return false;
  if (filter.missingHashes === true && record.sha256 && record.normalizedTextSha256) return false;
  if (filter.duplicateSha256 === true && (!record.sha256 || !duplicateSha.has(record.sha256))) return false;
  if (filter.duplicateNormalizedTextSha256 === true && (!record.normalizedTextSha256 || !duplicateNormalized.has(record.normalizedTextSha256))) return false;
  if (filter.emptyFolders === true && (record.type !== "folder" || !emptyFolderIds.has(record.itemId))) return false;
  if (filter.unsupportedFiles === true && (record.type !== "file" || TEXT_READABLE_EXTENSIONS.has(record.extension) || IMAGE_EXTENSIONS.has(record.extension))) return false;
  if (filter.extractionFailures === true && !record.error && record.extractionStatus !== "failed") return false;
  if (Array.isArray(filter.forbiddenFilenamePatterns) && filter.forbiddenFilenamePatterns.length > 0) {
    const matches = filter.forbiddenFilenamePatterns.some((pattern) => {
      try { return new RegExp(String(pattern), "i").test(record.filename); } catch { return false; }
    });
    if (!matches) return false;
  }
  if (Array.isArray(filter.administrativePathPatterns) && filter.administrativePathPatterns.length > 0) {
    const matches = filter.administrativePathPatterns.some((pattern) => {
      try { return new RegExp(String(pattern), "i").test(record.relativePath); } catch { return false; }
    });
    if (!matches) return false;
  }
  const language = String(filter.language ?? "").toLocaleLowerCase("en");
  if (language && !JSON.stringify(record.documentMetadata ?? {}).toLocaleLowerCase("en").includes(language)) return false;
  return true;
}

async function querySourceSnapshot(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const snapshotId = String(input.snapshotId ?? "");
  const meta = await getSnapshotMeta(context, snapshotId);
  const records = await listSnapshotRecords(context, snapshotId);
  const shaCounts = new Map<string, number>();
  const normalizedCounts = new Map<string, number>();
  const parentCounts = new Map<string, number>();
  for (const record of records) {
    if (record.sha256) shaCounts.set(record.sha256, (shaCounts.get(record.sha256) ?? 0) + 1);
    if (record.normalizedTextSha256) normalizedCounts.set(record.normalizedTextSha256, (normalizedCounts.get(record.normalizedTextSha256) ?? 0) + 1);
    if (record.parentItemId) parentCounts.set(record.parentItemId, (parentCounts.get(record.parentItemId) ?? 0) + 1);
  }
  const duplicateSha = new Set([...shaCounts].filter(([, count]) => count > 1).map(([hash]) => hash));
  const duplicateNormalized = new Set([...normalizedCounts].filter(([, count]) => count > 1).map(([hash]) => hash));
  const emptyFolderIds = new Set(records.filter((record) => record.type === "folder" && !parentCounts.has(record.itemId)).map((record) => record.itemId));
  const cursor = input.cursor ? await openJson<{ offset: number; snapshotId: string }>(context.env.COOKIE_ENCRYPTION_KEY, String(input.cursor)) : { offset: 0, snapshotId };
  if (cursor.snapshotId !== snapshotId) throw new ConnectorError("cursor_filter_mismatch", "The cursor belongs to another snapshot.");
  const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 500);
  const filtered = records.filter((record) => matchesSnapshotFilter(record, input, duplicateSha, duplicateNormalized, emptyFolderIds));
  const page = filtered.slice(cursor.offset, cursor.offset + limit);
  const nextOffset = cursor.offset + page.length;
  return {
    snapshotId,
    scopePath: meta.scopePath,
    totalMatching: filtered.length,
    results: page,
    cursor: nextOffset < filtered.length ? await sealJson(context.env.COOKIE_ENCRYPTION_KEY, { offset: nextOffset, snapshotId }) : null,
  };
}

async function enumerateLive(context: IntegratedContext, scopePath: string, maximumItems: number = INTEGRATED_LIMITS.snapshotItemsMax, recursive = true): Promise<SnapshotRecord[]> {
  const root = await resolveRelativeFolder(context.env, context.userId, scopePath);
  const queue: VerifiedItem[] = [root];
  const records: SnapshotRecord[] = [];
  while (queue.length > 0 && records.length < maximumItems) {
    const folder = queue.shift();
    if (!folder) break;
    let nextUrl: string | undefined;
    do {
      const page = await listVerifiedChildren(context.env, context.userId, folder, 200, nextUrl);
      nextUrl = page.nextUrl;
      for (const child of page.items) {
        const compact = compactVerifiedItem(child);
        records.push({
          ...compact,
          snapshotIndex: records.length,
          parentItemId: child.item.parentReference?.id ?? null,
          createdDate: null,
          sha256: null,
          normalizedTextSha256: null,
          extractedCharacterCount: null,
          extractionStatus: null,
          representationStatus: null,
          documentMetadata: null,
          error: null,
        });
        if (child.item.folder && recursive) queue.push(child);
        if (records.length >= maximumItems) break;
      }
    } while (nextUrl && records.length < maximumItems);
  }
  return records;
}

export function snapshotRecordSizeChanged(
  before: Pick<SnapshotRecord, "type" | "byteSize">,
  after: Pick<SnapshotRecord, "type" | "byteSize">,
): boolean {
  return before.type === "file" && after.type === "file" && before.byteSize !== after.byteSize;
}

async function compareSnapshotToLive(context: IntegratedContext, snapshotId: string): Promise<Record<string, unknown>> {
  const meta = await getSnapshotMeta(context, snapshotId);
  const snapshot = await listSnapshotRecords(context, snapshotId);
  const live = await enumerateLive(context, meta.scopePath, Math.max(meta.totalRecords + 1_000, INTEGRATED_LIMITS.snapshotItemsDefault));
  const snapshotById = new Map(snapshot.map((record) => [record.itemId, record]));
  const liveById = new Map(live.map((record) => [record.itemId, record]));
  const added = live.filter((record) => !snapshotById.has(record.itemId));
  const removed = snapshot.filter((record) => !liveById.has(record.itemId));
  const movedOrRenamed: Array<Record<string, unknown>> = [];
  const changedETags: Array<Record<string, unknown>> = [];
  const changedSizes: Array<Record<string, unknown>> = [];
  const changedSha256: Array<Record<string, unknown>> = [];
  for (const before of snapshot) {
    const after = liveById.get(before.itemId);
    if (!after) continue;
    if (before.relativePath !== after.relativePath || before.filename !== after.filename) movedOrRenamed.push({ itemId: before.itemId, before: before.relativePath, after: after.relativePath });
    if (before.eTag !== after.eTag) changedETags.push({ itemId: before.itemId, path: after.relativePath, before: before.eTag, after: after.eTag });
    if (snapshotRecordSizeChanged(before, after)) changedSizes.push({ itemId: before.itemId, path: after.relativePath, before: before.byteSize, after: after.byteSize });
    if (before.sha256 && before.eTag !== after.eTag && after.type === "file") {
      const currentHash = (await shaForItem(context, after.itemId)).sha256;
      if (currentHash !== before.sha256) changedSha256.push({ itemId: before.itemId, path: after.relativePath, before: before.sha256, after: currentHash });
    }
  }
  const snapshotFolders = new Set(snapshot.filter((record) => record.type === "folder").map((record) => record.relativePath));
  const liveFolders = new Set(live.filter((record) => record.type === "folder").map((record) => record.relativePath));
  return {
    snapshotId,
    scopePath: meta.scopePath,
    stale: added.length > 0 || removed.length > 0 || movedOrRenamed.length > 0 || changedETags.length > 0 || changedSizes.length > 0 || changedSha256.length > 0,
    addedItems: added,
    removedItems: removed,
    movedOrRenamedItems: movedOrRenamed,
    changedETags,
    changedSizes,
    changedSha256,
    changedFolderStructure: {
      addedFolders: [...liveFolders].filter((path) => !snapshotFolders.has(path)),
      removedFolders: [...snapshotFolders].filter((path) => !liveFolders.has(path)),
    },
  };
}

async function imagePerceptualHash(context: IntegratedContext, itemId: string): Promise<string> {
  const { verified, buffer } = await downloadVerifiedItem(context.env, context.userId, itemId, 25 * 1024 * 1024);
  if (!isVisualAsset(verified.item.name)) throw new ConnectorError("not_visual_asset", "Perceptual hashing requires an image.");
  const images = context.env.IMAGES as any;
  const input = images.input(new Blob([buffer], { type: normalizedMimeType(verified.item.name, verified.item.file?.mimeType) }).stream());
  const output = await input.transform({ width: 9, height: 8, fit: "cover" }).output({ format: "image/png", anim: false });
  const response = output.response();
  const png = new Uint8Array(await response.arrayBuffer());
  return pngDifferenceHash(png);
}

async function calculateHashesForRecord(context: IntegratedContext, record: SnapshotRecord, includeNormalized: boolean, includePerceptual: boolean): Promise<Record<string, unknown>> {
  if (record.type !== "file") return { itemId: record.itemId, path: record.relativePath, skipped: "folder" };
  const exact = await shaForItem(context, record.itemId);
  const normalized = includeNormalized && TEXT_READABLE_EXTENSIONS.has(record.extension) ? await normalizedHashForItem(context, record.itemId) : null;
  const perceptualHash = includePerceptual && IMAGE_EXTENSIONS.has(record.extension) ? await imagePerceptualHash(context, record.itemId) : null;
  return {
    itemId: record.itemId,
    path: record.relativePath,
    fileSha256: exact.sha256,
    normalizedTextSha256: normalized?.normalizedTextSha256 ?? null,
    perceptualHash,
    sourceETag: exact.eTag,
    byteSize: exact.byteSize,
    extractionStatus: normalized?.extractionMethod ?? null,
    representationStatus: normalized?.representationStatus ?? null,
  };
}

async function calculateFileHashes(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const includeNormalized = input.calculateNormalizedTextHash !== false;
  const includePerceptual = input.calculatePerceptualHash === true;
  let records: SnapshotRecord[] = [];
  if (input.snapshotId) records = await listSnapshotRecords(context, String(input.snapshotId));
  else {
    const ids = input.itemId ? [String(input.itemId)] : Array.isArray(input.itemIds) ? input.itemIds.map(String) : [];
    if (ids.length === 0) throw new ConnectorError("item_required", "Provide itemId, itemIds, or snapshotId.");
    if (ids.length > INTEGRATED_LIMITS.hashBatchMax) throw new ConnectorError("hash_batch_too_large", "The hash batch exceeds the hard limit.");
    for (const id of ids) {
      const verified = await verifyItemInsideRoot(context.env, context.userId, id);
      records.push({
        ...compactVerifiedItem(verified),
        snapshotIndex: records.length,
        parentItemId: verified.item.parentReference?.id ?? null,
        createdDate: null,
        sha256: null,
        normalizedTextSha256: null,
        extractedCharacterCount: null,
        extractionStatus: null,
        representationStatus: null,
        documentMetadata: null,
        error: null,
      });
    }
  }
  const limit = Math.min(Number(input.limit ?? INTEGRATED_LIMITS.hashBatchMax), INTEGRATED_LIMITS.hashBatchMax);
  const cursor = Math.max(Number(input.cursor ?? 0), 0);
  const selected = records.slice(cursor, cursor + limit);
  const results: Record<string, unknown>[] = [];
  for (const record of selected) {
    try { results.push(await calculateHashesForRecord(context, record, includeNormalized, includePerceptual)); }
    catch (error) {
      const safe = connectorError(error);
      results.push({ itemId: record.itemId, path: record.relativePath, error: { code: safe.code, message: safe.message } });
    }
  }
  return { results, cursor: cursor + selected.length < records.length ? cursor + selected.length : null, total: records.length };
}

function groupBy<T>(values: T[], key: (value: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    if (!groupKey) continue;
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}

async function findSourceDuplicates(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const snapshotId = String(input.snapshotId ?? "");
  const records = (await listSnapshotRecords(context, snapshotId)).filter((record) => record.type === "file");
  const requireHashes = records.some((record) => !record.sha256);
  const enriched: Array<SnapshotRecord & { perceptualHash?: string | null }> = [];
  for (const record of records) {
    const copy = { ...record, perceptualHash: null as string | null };
    if (requireHashes && !copy.sha256) copy.sha256 = (await shaForItem(context, copy.itemId)).sha256;
    if (input.includeNormalizedText !== false && TEXT_READABLE_EXTENSIONS.has(copy.extension) && !copy.normalizedTextSha256) {
      copy.normalizedTextSha256 = (await normalizedHashForItem(context, copy.itemId)).normalizedTextSha256;
    }
    if (input.includePerceptualImages === true && IMAGE_EXTENSIONS.has(copy.extension)) {
      try { copy.perceptualHash = await imagePerceptualHash(context, copy.itemId); } catch { copy.perceptualHash = null; }
    }
    enriched.push(copy);
  }
  const groups: Array<Record<string, unknown>> = [];
  for (const [hash, members] of groupBy(enriched, (record) => record.sha256)) {
    if (members.length < 2) continue;
    groups.push({ stableGroupId: await sha256Hex(`binary:${hash}`), relationship: "exact_binary_duplicate", members });
  }
  for (const [hash, members] of groupBy(enriched, (record) => record.normalizedTextSha256)) {
    if (members.length < 2) continue;
    groups.push({
      stableGroupId: await sha256Hex(`normalized:${hash}`),
      relationship: new Set(members.map((member) => member.extension)).size > 1 ? "same_work_different_format" : "normalized_text_duplicate",
      members,
    });
  }
  const workGroups = groupBy(enriched, (record) => baseNameForWork(record.filename));
  for (const [work, members] of workGroups) {
    if (members.length < 2 || groups.some((group) => (group.members as SnapshotRecord[]).some((member) => members.includes(member)))) continue;
    groups.push({ stableGroupId: await sha256Hex(`suspected:${work}`), relationship: "suspected_same_work", members });
  }
  const perceptual = enriched.filter((record) => record.perceptualHash);
  const threshold = Math.min(Math.max(Number(input.perceptualThreshold ?? 8), 0), 16);
  for (let left = 0; left < perceptual.length; left += 1) {
    for (let right = left + 1; right < perceptual.length; right += 1) {
      const distance = hammingDistanceHex(perceptual[left].perceptualHash!, perceptual[right].perceptualHash!);
      if (distance <= threshold) groups.push({
        stableGroupId: await sha256Hex(`visual:${perceptual[left].itemId}:${perceptual[right].itemId}`),
        relationship: "perceptually_similar_image",
        similarityDistance: distance,
        members: [perceptual[left], perceptual[right]],
      });
    }
  }
  return { snapshotId, groups, automaticDeletionDecision: false };
}

async function documentVisualCandidates(context: IntegratedContext, itemId: string): Promise<{ verified: VerifiedItem; buffer: ArrayBuffer; entries: OoxmlEntryMap | null; candidates: DocumentVisualCandidate[]; pageCount: number | null }> {
  const { verified, buffer } = await downloadVerifiedItem(context.env, context.userId, itemId, INTEGRATED_LIMITS.fileBytesMax);
  const extension = extensionOf(verified.item.name);
  if (OOXML_PRESENTATION_EXTENSIONS.has(extension)) {
    const entries = safeUnzipOoxml(buffer);
    const inspected = inspectPptx(entries);
    return { verified, buffer, entries, candidates: inspected.visuals, pageCount: inspected.pageCount };
  }
  if (OOXML_WORD_EXTENSIONS.has(extension)) {
    const entries = safeUnzipOoxml(buffer);
    const inspected = inspectDocx(entries);
    return { verified, buffer, entries, candidates: inspected.visuals, pageCount: inspected.pageCount };
  }
  if (extension === ".pdf") {
    const inspected = inspectPdfBytes(buffer);
    return { verified, buffer, entries: null, candidates: inspected.visuals, pageCount: inspected.pageCount };
  }
  throw new ConnectorError("unsupported_visual_document", "Document visuals are supported for PDF, PPTX, POTX, PPSX, and DOCX.");
}

async function visualToken(context: IntegratedContext, verified: VerifiedItem, candidate: DocumentVisualCandidate): Promise<string> {
  return sealJson(context.env.COOKIE_ENCRYPTION_KEY, {
    version: 1,
    itemId: verified.item.id,
    eTag: verified.item.eTag ?? null,
    filename: verified.item.name,
    extension: extensionOf(verified.item.name),
    candidate,
    expiresAt: Date.now() + INTEGRATED_LIMITS.snapshotRetentionSeconds * 1000,
  } satisfies VisualToken);
}

async function decodeVisualToken(context: IntegratedContext, token: string): Promise<VisualToken> {
  let value: VisualToken;
  try { value = await openJson<VisualToken>(context.env.COOKIE_ENCRYPTION_KEY, token); }
  catch { throw new ConnectorError("invalid_visual_id", "The visual ID is invalid or expired."); }
  if (value.version !== 1 || value.expiresAt <= Date.now()) throw new ConnectorError("invalid_visual_id", "The visual ID is invalid or expired.");
  const verified = await verifyItemInsideRoot(context.env, context.userId, value.itemId);
  if (value.eTag && verified.item.eTag !== value.eTag) throw new ConnectorError("etag_conflict", "The source document changed after the visual ID was created.");
  return value;
}

async function listDocumentVisuals(context: IntegratedContext, itemId: string, cursor = 0, limit = 100): Promise<Record<string, unknown>> {
  const document = await documentVisualCandidates(context, itemId);
  const selected = document.candidates.slice(cursor, cursor + Math.min(limit, 200));
  const results: Array<Record<string, unknown>> = [];
  for (const candidate of selected) {
    results.push({
      visualId: await visualToken(context, document.verified, candidate),
      sourcePath: document.verified.relativePath,
      ...candidate,
      locator: undefined,
    });
  }
  return {
    source: compactVerifiedItem(document.verified),
    pageOrSlideCount: document.pageCount,
    totalVisuals: document.candidates.length,
    results,
    cursor: cursor + selected.length < document.candidates.length ? cursor + selected.length : null,
  };
}

async function scanVisualSources(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const path = strictRelativePath(String(input.path ?? ""));
  const recursive = input.recursive !== false;
  const maximumItems = Math.min(Math.max(Number(input.maximumItems ?? 1_000), 1), INTEGRATED_LIMITS.snapshotItemsMax);
  const live = await enumerateLive(context, path, maximumItems, recursive);
  const sources: Array<Record<string, unknown>> = [];
  for (const record of live) {
    if (record.type !== "file") continue;
    if (IMAGE_EXTENSIONS.has(record.extension)) {
      sources.push({ ...record, sourceType: "loose_image", likelyVisualCount: 1, originalMediaCount: 1, compositeRenderRequired: false });
      continue;
    }
    if (record.extension === ".pdf" || OOXML_PRESENTATION_EXTENSIONS.has(record.extension) || OOXML_WORD_EXTENSIONS.has(record.extension)) {
      try {
        const candidates = await documentVisualCandidates(context, record.itemId);
        sources.push({
          ...record,
          sourceType: "document",
          likelyVisualCount: candidates.candidates.length,
          pageOrSlideCount: candidates.pageCount,
          originalMediaCount: candidates.candidates.filter((visual) => visual.exactOriginalAvailable).length,
          compositeRenderRequired: candidates.candidates.some((visual) => !visual.exactOriginalAvailable && visual.renderAvailable),
          objectTypes: [...new Set(candidates.candidates.map((visual) => visual.objectType))],
        });
      } catch (error) {
        const safe = connectorError(error);
        sources.push({ ...record, sourceType: "document", error: { code: safe.code, message: safe.message } });
      }
    }
  }
  const cursor = Math.max(Number(input.cursor ?? 0), 0);
  const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 200);
  return { results: sources.slice(cursor, cursor + limit), total: sources.length, cursor: cursor + limit < sources.length ? cursor + limit : null, recursive };
}


function trustedMicrosoftOpaqueUrl(raw: string, purpose: "upload" | "monitor"): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConnectorError(`unsafe_${purpose}_url`, `The ${purpose} URL is invalid.`); }
  const host = url.hostname.toLocaleLowerCase("en");
  const microsoftHost = host === "api.onedrive.com" || host.endsWith(".onedrive.com") || host.endsWith(".1drv.com") || host.endsWith(".sharepoint.com");
  const pathOkay = purpose === "upload"
    ? (/\/up\//i.test(url.pathname) || /uploadsession/i.test(url.pathname + url.search))
    : (/monitor/i.test(url.pathname));
  if (url.protocol !== "https:" || !microsoftHost || !pathOkay || url.username || url.password) {
    throw new ConnectorError(`unsafe_${purpose}_url`, `The ${purpose} URL is not a trusted short-lived Microsoft URL.`);
  }
  return url;
}

async function fetchOpaqueMicrosoftUrl(url: URL, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url.href, { ...init, redirect: init.redirect ?? "manual", headers: { ...(init.headers ?? {}) } });
  if (!(response.ok || response.status === 202 || response.status === 303)) {
    throw new ConnectorError("opaque_microsoft_request_failed", "A short-lived Microsoft operation URL failed.", { status: response.status, retryable: response.status === 429 || response.status >= 500 });
  }
  return response;
}

async function graphRaw(context: IntegratedContext, pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  return graphResponse(context.env, context.userId, pathOrUrl, init);
}

async function pdfBytesForRender(context: IntegratedContext, itemId: string): Promise<{ verified: VerifiedItem; pdf: ArrayBuffer }> {
  const verified = await verifyItemInsideRoot(context.env, context.userId, itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "Rendering requires a file.");
  const extension = extensionOf(verified.item.name);
  const current = await verifyItemInsideRoot(context.env, context.userId, itemId);
  let response: Response;
  if (extension === ".pdf") response = await graphRaw(context, `/me/drive/items/${encodeURIComponent(current.item.id)}/content`);
  else if (OOXML_PRESENTATION_EXTENSIONS.has(extension) || OOXML_WORD_EXTENSIONS.has(extension)) {
    response = await graphRaw(context, `/me/drive/items/${encodeURIComponent(current.item.id)}/content?format=pdf`);
  } else throw new ConnectorError("render_unsupported", "Rendering is supported for PDF, PPTX, POTX, PPSX, and DOCX.");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > INTEGRATED_LIMITS.fileBytesMax) throw new ConnectorError("file_too_large", "The converted PDF exceeds the render-size limit.");
  const pdf = await response.arrayBuffer();
  if (pdf.byteLength > INTEGRATED_LIMITS.fileBytesMax) throw new ConnectorError("file_too_large", "The converted PDF exceeds the render-size limit.");
  const signature = validateFileSignature("render.pdf", pdf, "application/pdf");
  if (!signature.compatible) throw new ConnectorError("conversion_failed", "Microsoft Graph did not return a valid PDF conversion.");
  return { verified: current, pdf };
}

async function browserScreenshot(context: IntegratedContext, html: string, width: number, height: number, crop?: { x: number; y: number; width: number; height: number }): Promise<ArrayBuffer> {
  if (!context.env.BROWSER) throw new ConnectorError("browser_binding_missing", "Cloudflare Browser Run is not configured.");
  const browser = context.env.BROWSER as any;
  let response: Response;
  try {
    response = await browser.quickAction("screenshot", {
      html,
      viewport: { width, height, deviceScaleFactor: 1 },
      waitForTimeout: 1_200,
      screenshotOptions: { type: "png", fullPage: false, ...(crop ? { clip: crop } : {}) },
    });
  } catch (error) {
    throw new ConnectorError("render_failed", "Cloudflare Browser Run could not render the requested page.", { retryable: true });
  }
  if (!(response instanceof Response) || !response.ok) throw new ConnectorError("render_failed", "Cloudflare Browser Run returned an invalid render.", { retryable: true });
  const result = await response.arrayBuffer();
  const signature = validateFileSignature("render.png", result, "image/png");
  if (!signature.compatible) throw new ConnectorError("render_invalid", "The generated page render is not a valid PNG.");
  return result;
}

async function convertImageOutput(context: IntegratedContext, buffer: ArrayBuffer, format: "png" | "jpeg" | "webp"): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  if (format === "png") return { bytes: buffer, mimeType: "image/png" };
  const images = context.env.IMAGES as any;
  const output = await images.input(new Blob([buffer], { type: "image/png" }).stream()).output({ format: format === "jpeg" ? "image/jpeg" : "image/webp", anim: false });
  const response = output.response();
  return { bytes: await response.arrayBuffer(), mimeType: format === "jpeg" ? "image/jpeg" : "image/webp" };
}

async function renderDocumentPage(context: IntegratedContext, input: Record<string, unknown>): Promise<{ metadata: Record<string, unknown>; image: { type: "image"; data: string; mimeType: string } ; bytes: ArrayBuffer }> {
  const itemId = String(input.itemId ?? "");
  const page = Math.max(Number(input.pageOrSlide ?? input.page ?? 1), 1);
  const outputFormat = String(input.outputFormat ?? "png").toLocaleLowerCase("en") as "png" | "jpeg" | "webp";
  if (!["png", "jpeg", "webp"].includes(outputFormat)) throw new ConnectorError("invalid_output_format", "Output format must be PNG, JPEG, or WebP.");
  const requestedDpi = input.dpi === undefined ? null : Math.min(Math.max(Number(input.dpi), 36), 300);
  const widthFromDpi = requestedDpi ? Math.round(requestedDpi * 8.27) : 1_600;
  const width = Math.min(Math.max(Number(input.width ?? widthFromDpi), 256), INTEGRATED_LIMITS.renderDimensionMax);
  const height = Math.min(Math.max(Number(input.height ?? Math.round(width * 1.414)), 256), INTEGRATED_LIMITS.renderDimensionMax);
  const { verified, pdf } = await pdfBytesForRender(context, itemId);
  const pdfInfo = inspectPdfBytes(pdf);
  if (page > pdfInfo.pageCount) throw new ConnectorError("page_out_of_range", "The requested page or slide number is outside the document.");
  const data = bytesToBase64(pdf);
  const background = input.transparentBackground === true ? "transparent" : "white";
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${background}}embed{width:100%;height:100%;border:0}</style></head><body><embed type="application/pdf" src="data:application/pdf;base64,${data}#page=${page}&zoom=page-width&toolbar=0&navpanes=0&scrollbar=0"></body></html>`;
  const cropRaw = input.cropRegion as Record<string, unknown> | undefined;
  const crop = cropRaw ? {
    x: Math.max(Number(cropRaw.x ?? 0), 0), y: Math.max(Number(cropRaw.y ?? 0), 0),
    width: Math.max(Number(cropRaw.width ?? width), 1), height: Math.max(Number(cropRaw.height ?? height), 1),
  } : undefined;
  const png = await browserScreenshot(context, html, width, height, crop);
  const converted = await convertImageOutput(context, png, outputFormat);
  return {
    metadata: {
      ...compactVerifiedItem(verified),
      requestedPageOrSlide: page,
      totalPagesOrSlides: pdfInfo.pageCount,
      outputFormat,
      mimeType: converted.mimeType,
      width: crop?.width ?? width,
      height: crop?.height ?? height,
      requestedDpi,
      cropRegion: crop ?? null,
      exactRequestedPage: true,
      officeConversion: extensionOf(verified.item.name) === ".pdf" ? "not_required" : "microsoft_graph_pdf",
      renderer: "cloudflare_browser_run",
    },
    image: { type: "image", data: bytesToBase64(converted.bytes), mimeType: converted.mimeType },
    bytes: converted.bytes,
  };
}

async function originalVisualBytes(context: IntegratedContext, tokenValue: VisualToken): Promise<{ verified: VerifiedItem; bytes: Uint8Array; mimeType: string; filename: string }> {
  const document = await documentVisualCandidates(context, tokenValue.itemId);
  if (tokenValue.eTag && document.verified.item.eTag !== tokenValue.eTag) throw new ConnectorError("etag_conflict", "The source document changed after the visual ID was created.");
  const bytes = extractVisualBytes(document.buffer, document.entries, tokenValue.candidate.locator);
  if (!bytes || !tokenValue.candidate.exactOriginalAvailable) throw new ConnectorError("not_available", "An unchanged embedded original is not available for this visual.");
  const filename = tokenValue.candidate.originalFilename ?? `visual-${tokenValue.candidate.visualKey}`;
  const mimeType = tokenValue.candidate.mimeType ?? normalizedMimeType(filename, undefined);
  return { verified: document.verified, bytes, mimeType, filename };
}

function visualResourceUri(token: string): string {
  return `onedrive-document-visual:///${encodeURIComponent(token)}`;
}

async function readVisualResource(context: IntegratedContext, uri: URL): Promise<{ uri: string; mimeType: string; blob: string }> {
  if (uri.protocol !== "onedrive-document-visual:") throw new ConnectorError("invalid_resource", "The document-visual resource URI is invalid.");
  const token = decodeURIComponent(uri.pathname.replace(/^\//, ""));
  const value = await decodeVisualToken(context, token);
  const original = await originalVisualBytes(context, value);
  return { uri: uri.href, mimeType: original.mimeType, blob: bytesToBase64(original.bytes) };
}

async function previewVisualForAnalysis(context: IntegratedContext, input: Record<string, unknown>): Promise<{ metadata: Record<string, unknown>; image: { type: "image"; data: string; mimeType: string } }> {
  const token = await decodeVisualToken(context, String(input.visualId ?? ""));
  const mode = String(input.mode ?? "rendered");
  if (mode === "original" && token.candidate.exactOriginalAvailable) {
    const original = await originalVisualBytes(context, token);
    const images = context.env.IMAGES as any;
    const output = await images.input(new Blob([ownedArrayBuffer(original.bytes)], { type: original.mimeType }).stream()).transform({ width: Math.min(Number(input.maxDimension ?? 1_600), 3_000), height: Math.min(Number(input.maxDimension ?? 1_600), 3_000), fit: "scale-down" }).output({ format: "image/png", anim: false });
    const response = output.response();
    const bytes = await response.arrayBuffer();
    return { metadata: { visualId: input.visualId, mode: "original_preview", sourceMimeType: original.mimeType, exactOriginalAvailable: true }, image: { type: "image", data: bytesToBase64(bytes), mimeType: "image/png" } };
  }
  const page = token.candidate.pageOrSlide ?? Number((token.candidate.locator as Record<string, unknown>).page ?? 1);
  const rendered = await renderDocumentPage(context, { itemId: token.itemId, pageOrSlide: page, outputFormat: "png", width: Number(input.maxDimension ?? 1_600), cropRegion: mode === "region" ? input.cropRegion : undefined });
  return { metadata: { ...rendered.metadata, visualId: input.visualId, mode: mode === "region" ? "region" : "rendered" }, image: rendered.image };
}

async function assertNameAvailable(context: IntegratedContext, folder: VerifiedItem, name: string, excludingItemId?: string): Promise<boolean> {
  let nextUrl: string | undefined;
  do {
    const page = await listVerifiedChildren(context.env, context.userId, folder, 200, nextUrl);
    if (page.items.some((child) => child.item.id !== excludingItemId && child.item.name.toLocaleLowerCase("en") === name.toLocaleLowerCase("en"))) return false;
    nextUrl = page.nextUrl;
  } while (nextUrl);
  return true;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

function autoRename(name: string, index: number): string {
  const extension = extensionOfName(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} (${index})${extension}`;
}

async function chooseUploadName(context: IntegratedContext, folder: VerifiedItem, requested: string, conflictPolicy: string): Promise<string> {
  const safe = validateItemName(requested);
  if (await assertNameAvailable(context, folder, safe)) return safe;
  if (conflictPolicy !== "auto-rename") throw new ConnectorError("name_conflict", "An item with that name already exists in the destination folder.");
  for (let index = 2; index <= 999; index += 1) {
    const candidate = validateItemName(autoRename(safe, index));
    if (await assertNameAvailable(context, folder, candidate)) return candidate;
  }
  throw new ConnectorError("name_conflict", "No conflict-free auto-renamed filename could be found.");
}

async function uploadBinary(context: IntegratedContext, destinationPath: string, requestedFilename: string, bytes: Uint8Array, mimeType: string, conflictPolicy: string): Promise<Record<string, unknown>> {
  const extension = extensionOfName(requestedFilename);
  if (!BINARY_UPLOAD_EXTENSIONS.has(extension)) throw new ConnectorError("binary_type_forbidden", "This binary output extension is not allowlisted.");
  const destination = await resolveRelativeFolder(context.env, context.userId, destinationPath);
  const filename = await chooseUploadName(context, destination, requestedFilename, conflictPolicy);
  const currentDestination = await verifyItemInsideRoot(context.env, context.userId, destination.item.id);
  if (!(await assertNameAvailable(context, currentDestination, filename))) throw new ConnectorError("name_conflict", "The destination changed before upload.");
  let created: GraphDriveItem;
  if (bytes.byteLength <= 4 * 1024 * 1024) {
    const response = await graphRaw(context, `/me/drive/items/${encodeURIComponent(currentDestination.item.id)}:/${encodeURIComponent(filename)}:/content?%40microsoft.graph.conflictBehavior=fail`, {
      method: "PUT",
      headers: { "Content-Type": mimeType, "If-None-Match": "*" },
      body: new Blob([ownedArrayBuffer(bytes)], { type: mimeType }),
    });
    created = await response.json() as GraphDriveItem;
  } else {
    const sessionResponse = await graphRaw(context, `/me/drive/items/${encodeURIComponent(currentDestination.item.id)}:/${encodeURIComponent(filename)}:/createUploadSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { name: filename, "@microsoft.graph.conflictBehavior": "fail" } }),
    });
    const session = await sessionResponse.json() as { uploadUrl?: string };
    if (!session.uploadUrl) throw new ConnectorError("upload_session_failed", "Microsoft Graph did not create an upload session.");
    const uploadUrl = trustedMicrosoftOpaqueUrl(session.uploadUrl, "upload");
    const chunkSize = 10 * 320 * 1024;
    let final: GraphDriveItem | null = null;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      await verifyItemInsideRoot(context.env, context.userId, currentDestination.item.id);
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const response = await fetchOpaqueMicrosoftUrl(uploadUrl, {
        method: "PUT",
        headers: { "Content-Length": String(end - offset), "Content-Range": `bytes ${offset}-${end - 1}/${bytes.byteLength}` },
        body: new Blob([ownedArrayBuffer(bytes.slice(offset, end))], { type: "application/octet-stream" }),
      });
      if (response.status !== 202) final = await response.json() as GraphDriveItem;
    }
    if (!final) throw new ConnectorError("upload_incomplete", "Microsoft Graph did not confirm the final upload item.");
    created = final;
  }
  const verified = await verifyItemInsideRoot(context.env, context.userId, created.id);
  return { ...compactVerifiedItem(verified), outputSha256: await sha256Bytes(bytes), conflictPolicy, exactBytesWritten: bytes.byteLength };
}

async function saveDocumentVisual(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await decodeVisualToken(context, String(input.visualId ?? ""));
  const mode = String(input.mode ?? "original");
  let bytes: Uint8Array;
  let mimeType: string;
  let defaultName: string;
  if (mode === "original") {
    const original = await originalVisualBytes(context, token);
    bytes = original.bytes;
    mimeType = original.mimeType;
    defaultName = original.filename;
  } else {
    const page = token.candidate.pageOrSlide ?? Number((token.candidate.locator as Record<string, unknown>).page ?? 1);
    const format = String(input.outputFormat ?? "png");
    const rendered = await renderDocumentPage(context, { itemId: token.itemId, pageOrSlide: page, outputFormat: format, width: input.width, dpi: input.dpi, cropRegion: input.cropRegion });
    bytes = new Uint8Array(rendered.bytes);
    mimeType = rendered.image.mimeType;
    defaultName = `${token.filename.replace(/\.[^.]+$/, "")}_page_${page}.${format === "jpeg" ? "jpg" : format}`;
  }
  const filename = String(input.filename ?? defaultName);
  const saved = await uploadBinary(context, String(input.destinationPath ?? ""), filename, bytes, mimeType, String(input.conflictPolicy ?? "fail"));
  return { ...saved, provenance: { sourceItemId: token.itemId, sourceETag: token.eTag, visualKey: token.candidate.visualKey, mode } };
}

async function looseImagePreview(context: IntegratedContext, itemId: string, maxDimension: number): Promise<{ data: string; mimeType: string; metadata: Record<string, unknown> }> {
  const result = await fetchImageForAnalysisSecure(context.env, context.userId, itemId, "auto", maxDimension);
  return { data: result.image.data, mimeType: result.image.mimeType, metadata: result.metadata };
}

async function createVisualContactSheet(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown> & { image?: { type: "image"; data: string; mimeType: string } }> {
  const itemIds = Array.isArray(input.itemIds) ? input.itemIds.map(String) : [];
  const visualIds = Array.isArray(input.visualIds) ? input.visualIds.map(String) : [];
  if (itemIds.length + visualIds.length === 0) throw new ConnectorError("visuals_required", "Provide at least one loose image item ID or document visual ID.");
  if (itemIds.length + visualIds.length > INTEGRATED_LIMITS.contactSheetItemsMax) throw new ConnectorError("contact_sheet_too_large", "The contact sheet exceeds the visual-count limit.");
  const columns = Math.min(Math.max(Number(input.columns ?? 4), 1), 8);
  const requestedThumbnailWidth = Math.min(Math.max(Number(input.thumbnailWidth ?? 300), 96), 800);
  const requestedThumbnailHeight = Math.min(Math.max(Number(input.thumbnailHeight ?? 220), 96), 800);
  const rows = Math.ceil((itemIds.length + visualIds.length) / columns);
  const horizontalOverhead = columns * 32;
  const verticalOverhead = rows * 80;
  const scale = Math.min(
    1,
    (INTEGRATED_LIMITS.renderDimensionMax - horizontalOverhead) / Math.max(columns * requestedThumbnailWidth, 1),
    (INTEGRATED_LIMITS.renderDimensionMax - verticalOverhead) / Math.max(rows * requestedThumbnailHeight, 1),
  );
  if (!Number.isFinite(scale) || scale <= 0) throw new ConnectorError("contact_sheet_dimensions_exceeded", "The contact sheet cannot fit within the render-dimension limit.");
  const thumbnailWidth = Math.max(48, Math.floor(requestedThumbnailWidth * scale));
  const thumbnailHeight = Math.max(48, Math.floor(requestedThumbnailHeight * scale));
  const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
  const cards: string[] = [];
  const provenance: Array<Record<string, unknown>> = [];
  let labelIndex = 0;
  for (const itemId of itemIds) {
    const preview = await looseImagePreview(context, itemId, Math.max(thumbnailWidth, thumbnailHeight));
    const verified = await verifyItemInsideRoot(context.env, context.userId, itemId);
    const label = labels[labelIndex++] || verified.item.name;
    cards.push(`<figure><img src="data:${preview.mimeType};base64,${preview.data}"><figcaption>${escapeHtml(label)}</figcaption></figure>`);
    provenance.push({ itemId, path: verified.relativePath, sourceFilename: verified.item.name, label });
  }
  for (const visualId of visualIds) {
    const preview = await previewVisualForAnalysis(context, { visualId, mode: "rendered", maxDimension: Math.max(thumbnailWidth, thumbnailHeight) });
    const token = await decodeVisualToken(context, visualId);
    const defaultLabel = `${token.filename}${token.candidate.pageOrSlide ? ` — ${token.candidate.pageOrSlide}` : ""}`;
    const label = labels[labelIndex++] || defaultLabel;
    cards.push(`<figure><img src="data:${preview.image.mimeType};base64,${preview.image.data}"><figcaption>${escapeHtml(label)}</figcaption></figure>`);
    provenance.push({ visualId, sourceItemId: token.itemId, sourceFilename: token.filename, pageOrSlide: token.candidate.pageOrSlide, label });
  }
  const width = columns * (thumbnailWidth + 32);
  const height = rows * (thumbnailHeight + 80);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:white;font-family:system-ui,sans-serif}.grid{display:grid;grid-template-columns:repeat(${columns},${thumbnailWidth}px);gap:16px;padding:16px}figure{margin:0;width:${thumbnailWidth}px}img{width:${thumbnailWidth}px;height:${thumbnailHeight}px;object-fit:contain;background:#f5f5f5}figcaption{font-size:12px;line-height:1.25;overflow-wrap:anywhere;margin-top:6px}</style></head><body><div class="grid">${cards.join("")}</div></body></html>`;
  const sheet = await browserScreenshot(context, html, width, height);
  const output: Record<string, unknown> & { image?: { type: "image"; data: string; mimeType: string } } = {
    mimeType: "image/png",
    width,
    height,
    columns,
    count: cards.length,
    provenance,
    sha256: await sha256Bytes(sheet),
  };
  if (input.returnForAnalysis !== false) output.image = { type: "image", data: bytesToBase64(sheet), mimeType: "image/png" };
  if (input.saveToOneDrive === true) {
    output.saved = await uploadBinary(context, String(input.destinationPath ?? ""), String(input.filename ?? `visual_contact_sheet_${Date.now()}.png`), new Uint8Array(sheet), "image/png", String(input.conflictPolicy ?? "fail"));
  }
  return output;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function findVisualDuplicates(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const itemIds = Array.isArray(input.itemIds) ? input.itemIds.map(String) : [];
  const visualIds = Array.isArray(input.visualIds) ? input.visualIds.map(String) : [];
  const entries: Array<Record<string, unknown> & { sha256: string; perceptualHash: string | null }> = [];
  for (const itemId of itemIds) {
    const exact = await shaForItem(context, itemId);
    let perceptualHash: string | null = null;
    try { perceptualHash = await imagePerceptualHash(context, itemId); } catch { perceptualHash = null; }
    entries.push({ itemId, path: exact.verified.relativePath, sha256: exact.sha256, perceptualHash });
  }
  for (const visualId of visualIds) {
    const token = await decodeVisualToken(context, visualId);
    let bytes: Uint8Array;
    if (token.candidate.exactOriginalAvailable) bytes = (await originalVisualBytes(context, token)).bytes;
    else bytes = new Uint8Array((await renderDocumentPage(context, { itemId: token.itemId, pageOrSlide: token.candidate.pageOrSlide ?? 1, outputFormat: "png", width: 512 })).bytes);
    const sha256 = await sha256Bytes(bytes);
    let perceptualHash: string | null = null;
    try {
      const images = context.env.IMAGES as any;
      const output = await images.input(new Blob([ownedArrayBuffer(bytes)]).stream()).transform({ width: 9, height: 8, fit: "cover" }).output({ format: "image/png", anim: false });
      perceptualHash = pngDifferenceHash(new Uint8Array(await output.response().arrayBuffer()));
    } catch { perceptualHash = null; }
    entries.push({ visualId, sourceItemId: token.itemId, visualKey: token.candidate.visualKey, sha256, perceptualHash });
  }
  const exactGroups = [...groupBy(entries, (entry) => entry.sha256).entries()].filter(([, members]) => members.length > 1).map(([hash, members]) => ({ groupId: hash, relationship: "exact_duplicate", members }));
  const threshold = Math.min(Math.max(Number(input.similarityThreshold ?? 8), 0), 16);
  const nearGroups: Array<Record<string, unknown>> = [];
  for (let left = 0; left < entries.length; left += 1) for (let right = left + 1; right < entries.length; right += 1) {
    if (!entries[left].perceptualHash || !entries[right].perceptualHash) continue;
    const distance = hammingDistanceHex(entries[left].perceptualHash!, entries[right].perceptualHash!);
    if (distance <= threshold && entries[left].sha256 !== entries[right].sha256) nearGroups.push({ groupId: await sha256Hex(`near:${left}:${right}:${entries[left].sha256}:${entries[right].sha256}`), relationship: "perceptually_similar", distance, members: [entries[left], entries[right]] });
  }
  return { exactGroups, nearGroups, similarityThreshold: threshold, deletionPerformed: false };
}

async function copyItem(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const source = await verifyItemInsideRoot(context.env, context.userId, String(input.itemId ?? ""));
  const destination = await resolveRelativeFolder(context.env, context.userId, String(input.destinationPath ?? ""));
  if (source.driveId !== destination.driveId) throw new ConnectorError("cross_drive", "Cross-drive copies are not allowed.");
  const requestedName = String(input.filename ?? source.item.name);
  const filename = await chooseUploadName(context, destination, requestedName, String(input.conflictPolicy ?? "fail"));
  const currentSource = await verifyItemInsideRoot(context.env, context.userId, source.item.id);
  const currentDestination = await verifyItemInsideRoot(context.env, context.userId, destination.item.id);
  const response = await graphRaw(context, `/me/drive/items/${encodeURIComponent(currentSource.item.id)}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(currentSource.item.eTag ? { "If-Match": currentSource.item.eTag } : {}) },
    body: JSON.stringify({ parentReference: { driveId: currentDestination.driveId, id: currentDestination.item.id }, name: filename }),
    redirect: "manual",
  });
  if (response.status !== 202) throw new ConnectorError("copy_not_accepted", "Microsoft Graph did not accept the asynchronous copy request.");
  const monitor = response.headers.get("Location");
  if (!monitor) throw new ConnectorError("copy_monitor_missing", "Microsoft Graph did not provide a copy monitor.");
  const monitorUrl = trustedMicrosoftOpaqueUrl(monitor, "monitor");
  let monitorStatus = "notStarted";
  let resourceId: string | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const poll = await fetchOpaqueMicrosoftUrl(monitorUrl, { redirect: "manual" });
    const body = await poll.json().catch(() => ({})) as Record<string, unknown>;
    monitorStatus = poll.status === 303 ? "completed" : String(body.status ?? body.operationStatus ?? "unknown");
    resourceId = typeof body.resourceId === "string" ? body.resourceId : resourceId;
    if (!resourceId && poll.status === 303) {
      const resultLocation = poll.headers.get("Location");
      if (resultLocation) {
        try {
          const resultUrl = new URL(resultLocation);
          if (resultUrl.protocol === "https:" && resultUrl.hostname.toLocaleLowerCase("en") === "graph.microsoft.com") {
            resourceId = decodeURIComponent(/\/items\/([^/?]+)/i.exec(resultUrl.pathname)?.[1] ?? "") || null;
          }
        } catch { /* Completion can still be verified by destination enumeration. */ }
      }
    }
    if (["completed", "succeeded"].includes(monitorStatus.toLocaleLowerCase("en"))) break;
    if (["failed", "cancelled"].includes(monitorStatus.toLocaleLowerCase("en"))) throw new ConnectorError("copy_failed", "Microsoft Graph reported that the copy failed.");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!["completed", "succeeded"].includes(monitorStatus.toLocaleLowerCase("en"))) throw new ConnectorError("copy_timeout", "The copy was not confirmed before the monitoring deadline.", { retryable: true });
  let copied: VerifiedItem | null = resourceId ? await verifyItemInsideRoot(context.env, context.userId, resourceId).catch(() => null) : null;
  if (!copied) {
    let nextUrl: string | undefined;
    do {
      const page = await listVerifiedChildren(context.env, context.userId, currentDestination, 200, nextUrl);
      copied = page.items.find((child) => child.item.name.toLocaleLowerCase("en") === filename.toLocaleLowerCase("en")) ?? null;
      nextUrl = page.nextUrl;
    } while (!copied && nextUrl);
  }
  if (!copied) throw new ConnectorError("copy_result_missing", "The copy completed but the final item could not be verified.");
  const result: Record<string, unknown> = { ...compactVerifiedItem(copied), copyStatus: "completed", conflictPolicy: input.conflictPolicy ?? "fail" };
  if (input.verifySha256 === true && !copied.item.folder && !source.item.folder) {
    const [sourceHash, copiedHash] = await Promise.all([shaForItem(context, source.item.id), shaForItem(context, copied.item.id)]);
    result.sourceSha256 = sourceHash.sha256;
    result.copiedSha256 = copiedHash.sha256;
    result.sha256Verified = sourceHash.sha256 === copiedHash.sha256;
    if (!result.sha256Verified) throw new ConnectorError("copy_hash_mismatch", "The copied file hash does not match the source.");
  }
  return result;
}

function actionIsDestructive(action: PlanAction): boolean {
  return action.action === "RECYCLE" || action.action === "RECYCLE_FOLDER" || action.destructive === true;
}

function ambiguityIsYes(action: PlanAction): boolean {
  return action.ambiguity === true || action.ambiguity === "yes";
}

function deletionApproved(action: PlanAction): boolean {
  return /^(approve|approved|yes|delete|recycle)$/i.test(String(action.finalDecision ?? ""));
}

async function createIntegrityPlan(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const snapshotId = String(input.snapshotId ?? "");
  const snapshot = await getSnapshotMeta(context, snapshotId);
  const scopePath = strictRelativePath(String(input.scopePath ?? snapshot.scopePath));
  if (scopePath !== snapshot.scopePath) throw new ConnectorError("plan_scope_mismatch", "The plan scope must exactly match the snapshot scope.");
  const rawActions = Array.isArray(input.actions) ? input.actions as PlanAction[] : [];
  if (rawActions.length === 0) throw new ConnectorError("plan_actions_required", "The integrity plan must contain at least one action.");
  if (rawActions.length > 5_000) throw new ConnectorError("plan_too_large", "The integrity plan exceeds the action limit.");
  const records = await listSnapshotRecords(context, snapshotId);
  const byId = new Map(records.map((record) => [record.itemId, record]));
  const ids = new Set<string>();
  const actions: PlanAction[] = [];
  for (let index = 0; index < rawActions.length; index += 1) {
    const raw = rawActions[index];
    const actionId = raw.actionId || crypto.randomUUID();
    if (ids.has(actionId)) throw new ConnectorError("duplicate_action_id", "Integrity-plan action IDs must be unique.");
    ids.add(actionId);
    const source = raw.sourceItemId ? byId.get(raw.sourceItemId) : undefined;
    const action: PlanAction = {
      ...raw,
      actionId,
      sourcePath: raw.sourcePath ?? source?.relativePath ?? null,
      currentFilename: raw.currentFilename ?? source?.filename ?? null,
      snapshotETag: raw.snapshotETag ?? source?.eTag ?? null,
      snapshotSha256: raw.snapshotSha256 ?? source?.sha256 ?? null,
      normalizedTextSha256: raw.normalizedTextSha256 ?? source?.normalizedTextSha256 ?? null,
      destructive: actionIsDestructive(raw),
      operationOrder: Number.isFinite(raw.operationOrder) ? Number(raw.operationOrder) : index,
      dependencies: raw.dependencies ?? [],
    };
    actions.push(action);
  }
  const planId = crypto.randomUUID();
  const planHash = await sha256Text(JSON.stringify({ snapshotId, scopePath, actions }));
  const plan: IntegrityPlan = {
    planId,
    snapshotId,
    scopePath,
    createdAt: nowIso(),
    expiresAt: expiryIso(INTEGRATED_LIMITS.planRetentionSeconds),
    status: "draft",
    validationStatus: "not_validated",
    executionStatus: "not_started",
    currentAction: null,
    actions,
    completedActions: [],
    failedActions: [],
    skippedDependencyActions: [],
    results: [],
    deletionLogsPrepared: [],
    finalFilesystemDiffReference: null,
    nextAction: actions[0]?.actionId ?? null,
    auditStatus: "not_requested",
    completedInvocations: 0,
    lastExecutionAt: null,
    planHash,
  };
  await storePlan(context, plan);
  return { planId, snapshotId, scopePath, actionCount: actions.length, planJson: JSON.stringify(plan, null, 2), planCsv: toCsv(actions as Array<Record<string, unknown>>) };
}

export async function validateIntegrityPlan(context: IntegratedContext, planId: string): Promise<Record<string, unknown>> {
  const plan = normalizeProgress(await getPlan(context, planId));
  const records = await listSnapshotRecords(context, plan.snapshotId);
  const byId = new Map(records.map((record) => [record.itemId, record]));
  const errors: Array<Record<string, unknown>> = [];
  const destinationMap = new Map<string, string>();
  const actionIds = new Set(plan.actions.map((action) => action.actionId));
  const actionById = new Map(plan.actions.map((action) => [action.actionId, action]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (actionId: string): void => {
    if (visiting.has(actionId)) { errors.push({ actionId, code: "dependency_cycle" }); return; }
    if (visited.has(actionId)) return;
    visiting.add(actionId);
    for (const dependency of actionById.get(actionId)?.dependencies ?? []) if (actionById.has(dependency)) visit(dependency);
    visiting.delete(actionId);
    visited.add(actionId);
  };
  for (const action of plan.actions) visit(action.actionId);
  for (const action of plan.actions) {
    for (const dependency of action.dependencies ?? []) {
      if (!actionIds.has(dependency)) errors.push({ actionId: action.actionId, code: "missing_dependency", dependency });
      else if (Number(actionById.get(dependency)?.operationOrder ?? -1) >= Number(action.operationOrder ?? 0)) errors.push({ actionId: action.actionId, code: "invalid_dependency_order", dependency });
    }
    if (action.sourcePath && !scopeContains(plan.scopePath, action.sourcePath)) errors.push({ actionId: action.actionId, code: "source_outside_scope" });
    if (action.destinationPath && !scopeContains(plan.scopePath, action.destinationPath)) errors.push({ actionId: action.actionId, code: "destination_outside_scope" });
    if (action.destinationPath) {
      const finalName = action.proposedFilename ?? action.currentFilename ?? "";
      const destinationKey = `${strictRelativePath(action.destinationPath)}/${finalName}`.toLocaleLowerCase("en");
      if (destinationMap.has(destinationKey)) errors.push({ actionId: action.actionId, code: "duplicate_destination", conflictingActionId: destinationMap.get(destinationKey) });
      destinationMap.set(destinationKey, action.actionId);
    }
    if (action.action === "MOVE" && action.sourcePath && action.destinationPath && `${strictRelativePath(action.destinationPath)}/`.toLocaleLowerCase("en").startsWith(`${strictRelativePath(action.sourcePath)}/`.toLocaleLowerCase("en"))) errors.push({ actionId: action.actionId, code: "circular_move" });
    if (action.action === "RECYCLE_FOLDER" && action.requiredStructuralPlaceholder) errors.push({ actionId: action.actionId, code: "required_placeholder_protected" });
    if (actionIsDestructive(action) && ambiguityIsYes(action)) errors.push({ actionId: action.actionId, code: "ambiguous_destructive_action" });
    if (actionIsDestructive(action) && !deletionApproved(action)) errors.push({ actionId: action.actionId, code: "destructive_decision_missing" });
    if (action.proposedFilename) {
      try { validateItemName(action.proposedFilename); } catch (error) { const safe = connectorError(error); errors.push({ actionId: action.actionId, code: safe.code, message: safe.message }); }
    }
    if (action.sourceItemId) {
      const snapshot = byId.get(action.sourceItemId);
      if (!snapshot) { errors.push({ actionId: action.actionId, code: "source_missing_from_snapshot" }); continue; }
      if (action.sourcePath && snapshot.relativePath !== action.sourcePath) errors.push({ actionId: action.actionId, code: "snapshot_path_mismatch" });
      if (action.currentFilename && snapshot.filename !== action.currentFilename) errors.push({ actionId: action.actionId, code: "snapshot_filename_mismatch" });
      if (action.snapshotETag && snapshot.eTag !== action.snapshotETag) errors.push({ actionId: action.actionId, code: "snapshot_etag_mismatch" });
      if (action.snapshotSha256 && snapshot.sha256 && snapshot.sha256 !== action.snapshotSha256) errors.push({ actionId: action.actionId, code: "snapshot_sha256_mismatch" });
      if (["MOVE", "RENAME", "REPLACE_TEXT", "RECYCLE"].includes(action.action) && snapshot.type === "file" && !action.snapshotSha256) errors.push({ actionId: action.actionId, code: "mutation_hash_required" });
    }
    if (["CREATE_FOLDER", "CREATE_TEXT"].includes(action.action) && !(action.proposedFilename ?? action.currentFilename)) errors.push({ actionId: action.actionId, code: "destination_name_required" });
  }
  const recycleFolders = plan.actions.filter((action) => action.action === "RECYCLE_FOLDER");
  for (const folder of recycleFolders) {
    const descendants = plan.actions.filter((action) => action.sourcePath && folder.sourcePath && action.sourcePath.startsWith(`${folder.sourcePath}/`));
    if (descendants.some((action) => Number(action.operationOrder ?? 0) >= Number(folder.operationOrder ?? 0))) errors.push({ actionId: folder.actionId, code: "folder_recycled_before_descendants" });
    if (strictRelativePath(folder.sourcePath ?? "") === strictRelativePath(plan.scopePath)) errors.push({ actionId: folder.actionId, code: "scope_root_recycle_forbidden" });
  }
  if (errors.length > 0) {
    plan.validationStatus = "invalid";
    if (plan.executionStatus === "not_started") plan.status = "draft";
    await storePlan(context, plan);
    return { valid: false, planId, errors, validationExternalGraphRequests: 0 };
  }
  const retryableFailures = new Set(plan.failedActions.filter((entry) => entry.retryable).map((entry) => entry.actionId));
  if (retryableFailures.size > 0) {
    plan.failedActions = plan.failedActions.filter((entry) => !retryableFailures.has(entry.actionId));
    plan.skippedDependencyActions = [];
  }
  const prepared = new Set(plan.deletionLogsPrepared);
  for (const action of plan.actions.filter(actionIsDestructive)) {
    if (prepared.has(action.actionId)) continue;
    await context.storage.put(operationKey(plan.planId, `deletion-prepared-${action.actionId}`), {
      preparedAt: nowIso(), planId: plan.planId, actionId: action.actionId, sourceItemId: action.sourceItemId, sourcePath: action.sourcePath,
      snapshotETag: action.snapshotETag, snapshotSha256: action.snapshotSha256, finalDecision: action.finalDecision,
    });
    prepared.add(action.actionId);
  }
  plan.deletionLogsPrepared = [...prepared];
  plan.validationStatus = "valid";
  const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
  if (plan.executionStatus !== "completed") {
    plan.status = plan.completedActions.length || plan.failedActions.length || plan.skippedDependencyActions.length ? "running" : "validated";
    plan.executionStatus = plan.completedActions.length || plan.failedActions.length || plan.skippedDependencyActions.length ? "running" : "not_started";
  }
  plan.nextAction = remaining[0]?.actionId ?? null;
  await storePlan(context, plan);
  const executionToken = await sealJson(context.env.COOKIE_ENCRYPTION_KEY, { planId: plan.planId, planHash: plan.planHash, expiresAt: Date.now() + INTEGRATED_LIMITS.executionTokenSeconds * 1000 });
  return {
    valid: true,
    planId,
    executionToken,
    expiresInSeconds: INTEGRATED_LIMITS.executionTokenSeconds,
    deletionLogsPrepared: plan.deletionLogsPrepared,
    validationExternalGraphRequests: 0,
    livePreconditionsDeferredUntilMutation: true,
    resumeFromAction: plan.nextAction,
    completedActions: plan.completedActions,
  };
}

async function acquireScopeLock(context: IntegratedContext, plan: IntegrityPlan): Promise<void> {
  const operation = async (storage: StorageLike) => {
    const locks = await storage.list<{ scopePath: string; planId: string; expiresAt: string }>({ prefix: lockPrefix() });
    for (const [key, lock] of locks) {
      if (Date.parse(lock.expiresAt) <= Date.now()) { await storage.delete(key); continue; }
      const overlap = scopeContains(lock.scopePath, plan.scopePath) || scopeContains(plan.scopePath, lock.scopePath);
      if (overlap && lock.planId !== plan.planId) throw new ConnectorError("scope_locked", "An overlapping integrity plan is already executing.", { retryable: true });
    }
    await storage.put(`${lockPrefix()}${await sha256Hex(plan.scopePath)}`, { scopePath: plan.scopePath, planId: plan.planId, expiresAt: expiryIso(3_600) });
  };
  if (context.transaction) await context.transaction(operation); else await operation(context.storage);
}

async function releaseScopeLock(context: IntegratedContext, plan: IntegrityPlan): Promise<void> {
  await context.storage.delete(`${lockPrefix()}${await sha256Hex(plan.scopePath)}`);
}

function actionNeedsContentHash(action: PlanAction): boolean {
  return ["MOVE", "RENAME", "REPLACE_TEXT", "RECYCLE"].includes(action.action) || actionIsDestructive(action);
}

async function shaForRetainedItem(context: IntegratedContext, source: VerifiedItem): Promise<string> {
  if (source.item.folder) throw new ConnectorError("folder_not_file", "A folder does not have a file SHA-256.");
  if ((source.item.size ?? 0) > INTEGRATED_LIMITS.fileBytesMax) throw new ConnectorError("file_too_large", "The file exceeds the integrated-operation size limit.");
  const buffer = await graphFetchBytes(context.env, context.userId, `/me/drive/items/${encodeURIComponent(source.item.id)}/content`, INTEGRATED_LIMITS.fileBytesMax);
  return sha256Bytes(buffer);
}

function expectedAppliedPath(action: PlanAction): string | null {
  if (action.action === "MOVE" && action.destinationPath) {
    const name = action.proposedFilename ?? action.currentFilename ?? action.sourcePath?.split("/").pop();
    return name ? strictRelativePath(`${action.destinationPath}/${name}`) : null;
  }
  if (action.action === "RENAME" && action.sourcePath && action.proposedFilename) {
    const parent = action.sourcePath.split("/").slice(0, -1).join("/");
    return strictRelativePath(parent ? `${parent}/${action.proposedFilename}` : action.proposedFilename);
  }
  return null;
}

async function completedOperation(context: IntegratedContext, plan: IntegrityPlan, action: PlanAction, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  const completed = { state: "completed", ...result };
  await context.storage.put(operationKey(plan.planId, action.actionId), completed);
  return result;
}

async function executePlanAction(context: IntegratedContext, plan: IntegrityPlan, action: PlanAction): Promise<Record<string, unknown>> {
  let source: VerifiedItem | null = null;
  if (action.sourceItemId) {
    source = await verifyItemInsideRoot(context.env, context.userId, action.sourceItemId);
    if (!scopeContains(plan.scopePath, source.relativePath)) throw new ConnectorError("outside_scope", "The source moved outside the plan scope.");
    const expectedApplied = expectedAppliedPath(action);
    if (action.sourcePath && source.relativePath !== action.sourcePath) {
      if (expectedApplied && source.relativePath === expectedApplied) {
        if (action.snapshotSha256 && !source.item.folder && await shaForRetainedItem(context, source) !== action.snapshotSha256) throw new ConnectorError("sha256_conflict", "The already-moved item no longer matches the snapshot hash.");
        return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before: null, after: compactVerifiedItem(source), alreadyApplied: true, completedAt: nowIso() });
      }
      throw new ConnectorError("path_conflict", "The source path changed after the plan snapshot was created.");
    }
    if (action.snapshotETag && source.item.eTag !== action.snapshotETag) throw new ConnectorError("etag_conflict", "The source changed after the plan snapshot was created.");
    if (actionNeedsContentHash(action) && !source.item.folder) {
      if (!action.snapshotSha256) throw new ConnectorError("mutation_hash_required", "The file mutation requires the snapshot SHA-256.");
      if (await shaForRetainedItem(context, source) !== action.snapshotSha256) throw new ConnectorError("sha256_conflict", "The source content changed after the plan snapshot was created.");
    }
  }
  if (action.destinationPath && !scopeContains(plan.scopePath, action.destinationPath)) throw new ConnectorError("outside_scope", "The destination is outside the plan scope.");
  if (action.action === "KEEP" || action.action === "METADATA_ONLY" || action.action === "CATALOGUE_ONLY") {
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, status: "recorded", completedAt: nowIso() });
  }
  if (action.action === "CREATE_FOLDER") {
    const destination = await resolveRelativeFolder(context.env, context.userId, String(action.destinationPath ?? plan.scopePath));
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before: null, destination: compactVerifiedItem(destination) });
    const result = await createFolderInVerifiedDestinationStrict(context.env, context.userId, destination, String(action.proposedFilename ?? action.currentFilename ?? ""));
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, after: result, rollbackPossible: true, completedAt: nowIso() });
  }
  if (action.action === "CREATE_TEXT") {
    const destination = await resolveRelativeFolder(context.env, context.userId, String(action.destinationPath ?? plan.scopePath));
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before: null, destination: compactVerifiedItem(destination) });
    const result = await createTextFileInVerifiedDestinationStrict(context.env, context.userId, destination, String(action.proposedFilename ?? action.currentFilename ?? ""), String(action.content ?? ""));
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, after: result, rollbackPossible: true, completedAt: nowIso() });
  }
  if (action.action === "REPLACE_TEXT") {
    if (!source || !action.snapshotETag) throw new ConnectorError("etag_required", "REPLACE_TEXT requires a retained source and snapshot eTag.");
    const before = compactVerifiedItem(source);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before });
    const result = await replaceVerifiedTextFileStrict(context.env, context.userId, source, action.snapshotETag, String(action.content ?? ""));
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before, after: result, rollbackPossible: false, completedAt: nowIso() });
  }
  if (action.action === "RENAME") {
    if (!source || !action.proposedFilename || !action.snapshotETag) throw new ConnectorError("rename_fields_required", "RENAME requires source, proposedFilename, and snapshotETag.");
    const parentId = source.item.parentReference?.id;
    if (!parentId) throw new ConnectorError("root_rename_forbidden", "The configured root cannot be renamed.");
    const parent = await verifyItemInsideRoot(context.env, context.userId, parentId);
    const before = compactVerifiedItem(source);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before, destination: compactVerifiedItem(parent) });
    const result = await renameVerifiedItemStrict(context.env, context.userId, source, parent, action.proposedFilename, action.snapshotETag);
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before, after: result, rollbackPossible: true, completedAt: nowIso() });
  }
  if (action.action === "MOVE") {
    if (!source || !action.destinationPath || !action.snapshotETag) throw new ConnectorError("move_fields_required", "MOVE requires source, destinationPath, and snapshotETag.");
    const destination = await resolveRelativeFolder(context.env, context.userId, action.destinationPath);
    const before = compactVerifiedItem(source);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), action, before, destination: compactVerifiedItem(destination) });
    const result = await moveVerifiedItemStrict(context.env, context.userId, source, destination, action.snapshotETag, action.proposedFilename);
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before, after: result, rollbackPossible: true, completedAt: nowIso() });
  }
  if (action.action === "RECYCLE" || action.action === "RECYCLE_FOLDER") {
    if (!source) throw new ConnectorError("source_item_required", "Recycle actions require a retained source.");
    if (!plan.deletionLogsPrepared.includes(action.actionId)) throw new ConnectorError("recycle_log_missing", "The recycle deletion log was not prepared.");
    if (action.action === "RECYCLE_FOLDER") {
      if (source.item.id === source.root.id) throw new ConnectorError("scope_root_recycle_forbidden", "The scope root cannot be recycled.");
      const page = await listVerifiedChildren(context.env, context.userId, source, 200);
      if (page.items.length > 0 || page.nextUrl) throw new ConnectorError("folder_not_empty", "The folder is not empty after descendant actions.");
    }
    const before = compactVerifiedItem(source);
    await context.storage.put(operationKey(plan.planId, action.actionId), { state: "prepared", preparedAt: nowIso(), before, action });
    await graphRaw(context, `/me/drive/items/${encodeURIComponent(source.item.id)}`, { method: "DELETE", headers: action.snapshotETag ? { "If-Match": action.snapshotETag } : {} });
    return completedOperation(context, plan, action, { actionId: action.actionId, action: action.action, before, after: null, recycled: true, reversibleThroughOneDriveRecycleBin: true, automaticRollbackAvailable: false, completedAt: nowIso() });
  }
  throw new ConnectorError("unsupported_plan_action", "The plan contains an unsupported action.");
}

export async function executeIntegrityPlan(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await openJson<{ planId: string; planHash: string; expiresAt: number }>(context.env.COOKIE_ENCRYPTION_KEY, String(input.executionToken ?? "")).catch(() => null);
  if (!token || token.expiresAt <= Date.now()) throw new ConnectorError("execution_token_invalid", "The execution token is invalid or expired.");
  const plan = normalizeProgress(await getPlan(context, token.planId));
  if (plan.validationStatus !== "valid" || plan.planHash !== token.planHash) throw new ConnectorError("plan_not_validated", "The integrity plan is not currently validated.");
  await acquireScopeLock(context, plan);
  const completedThisInvocation: string[] = [];
  const failedThisInvocation: string[] = [];
  try {
    advanceDependencySkips(plan);
    let remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    if (remaining.length > 0) {
      const action = remaining[0];
      plan.currentAction = action.actionId;
      plan.nextAction = action.actionId;
      plan.status = "running";
      plan.executionStatus = "running";
      await storePlan(context, plan);
      const existing = await context.storage.get<Record<string, unknown>>(operationKey(plan.planId, action.actionId));
      if (existing?.state === "completed") {
        const reconciled = { ...existing, actionId: action.actionId };
        plan.results = upsertResult(plan.results, reconciled);
        plan.completedActions = uniqueStrings([...plan.completedActions, action.actionId]);
        completedThisInvocation.push(action.actionId);
      } else {
        try {
          const result = await executePlanAction(context, plan, action);
          plan.results = upsertResult(plan.results, result);
          plan.completedActions = uniqueStrings([...plan.completedActions, action.actionId]);
          plan.failedActions = plan.failedActions.filter((entry) => entry.actionId !== action.actionId);
          completedThisInvocation.push(action.actionId);
        } catch (error) {
          const safe = connectorError(error);
          plan.failedActions = upsertFailure(plan.failedActions, {
            actionId: action.actionId,
            code: safe.code,
            message: safe.message,
            retryable: safe.retryable,
            status: safe.status,
            correlationId: safe.correlationId,
            details: safe.details,
          });
          failedThisInvocation.push(action.actionId);
          await context.storage.put(operationKey(plan.planId, action.actionId), { state: "failed", failedAt: nowIso(), error: { code: safe.code, message: safe.message, retryable: safe.retryable, status: safe.status ?? null, correlationId: safe.correlationId, details: safe.details ?? null }, action });
        }
      }
    }
    normalizeProgress(plan);
    advanceDependencySkips(plan);
    remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions);
    plan.currentAction = null;
    plan.nextAction = remaining[0]?.actionId ?? null;
    plan.completedInvocations = Number(plan.completedInvocations ?? 0) + 1;
    plan.lastExecutionAt = nowIso();
    if (remaining.length > 0) {
      plan.status = "running";
      plan.executionStatus = "running";
    } else {
      plan.executionStatus = plan.failedActions.length > 0 ? "failed" : "completed";
      plan.status = plan.failedActions.length > 0 ? "failed" : "completed";
      if (plan.completedActions.length > 0) plan.auditStatus = "pending";
    }
    await storePlan(context, plan);
    return {
      planId: plan.planId,
      status: plan.status,
      executionStatus: plan.executionStatus,
      resumeRequired: remaining.length > 0,
      completedThisInvocation,
      failedThisInvocation,
      mutationLimitThisInvocation: MAX_MUTATIONS_PER_INVOCATION,
      remainingActions: remaining.length,
      remainingActionIds: remaining.map((action) => action.actionId),
      nextAction: plan.nextAction,
      completedActions: plan.completedActions,
      failedActions: plan.failedActions,
      skippedDependencyActions: plan.skippedDependencyActions,
      results: plan.results,
      auditPending: plan.auditStatus === "pending",
      finalFilesystemDiffReference: plan.finalFilesystemDiffReference,
      recoveryState: plan.failedActions.length > 0 ? { successfulActionsRemainApplied: true, dependentActionsSkipped: true, automaticRollbackPerformed: false, revalidateToRetryTransientFailures: plan.failedActions.some((entry) => entry.retryable) } : null,
    };
  } finally {
    await releaseScopeLock(context, plan);
  }
}

export function reconstructAuditLiveRecords(snapshot: SnapshotRecord[], comparison: Record<string, unknown>): SnapshotRecord[] {
  const removedIds = new Set(((comparison.removedItems ?? []) as SnapshotRecord[]).map((record) => record.itemId));
  const movedPaths = new Map(((comparison.movedOrRenamedItems ?? []) as Array<{ itemId: string; after: string }>).map((entry) => [entry.itemId, entry.after]));
  const changedETags = new Map(((comparison.changedETags ?? []) as Array<{ itemId: string; after: string | null }>).map((entry) => [entry.itemId, entry.after]));
  const changedSizes = new Map(((comparison.changedSizes ?? []) as Array<{ itemId: string; after: number | null }>).map((entry) => [entry.itemId, entry.after]));
  const records = snapshot.filter((record) => !removedIds.has(record.itemId)).map((record) => {
    const relativePath = movedPaths.get(record.itemId) ?? record.relativePath;
    return {
      ...record,
      relativePath,
      filename: relativePath.split("/").pop() ?? record.filename,
      eTag: changedETags.has(record.itemId) ? changedETags.get(record.itemId) ?? null : record.eTag,
      byteSize: changedSizes.has(record.itemId) ? changedSizes.get(record.itemId) ?? null : record.byteSize,
    };
  });
  const seen = new Set(records.map((record) => record.itemId));
  for (const added of (comparison.addedItems ?? []) as SnapshotRecord[]) {
    if (!seen.has(added.itemId)) {
      records.push(added);
      seen.add(added.itemId);
    }
  }
  const folderIdByPath = new Map(records.filter((record) => record.type === "folder").map((record) => [record.relativePath, record.itemId]));
  return records.map((record) => {
    const parentPath = record.relativePath.split("/").slice(0, -1).join("/");
    return { ...record, parentItemId: folderIdByPath.get(parentPath) ?? record.parentItemId };
  });
}

export function auditDuplicateHashGroups(
  snapshot: SnapshotRecord[],
  live: SnapshotRecord[],
  comparison: Record<string, unknown>,
): { groups: Array<{ hash: string; members: SnapshotRecord[] }>; knownHashCount: number; totalFileCount: number } {
  const snapshotById = new Map(snapshot.map((record) => [record.itemId, record]));
  const changedHashes = new Map(((comparison.changedSha256 ?? []) as Array<{ itemId: string; after: string }>).map((entry) => [entry.itemId, entry.after]));
  const byHash = new Map<string, SnapshotRecord[]>();
  let knownHashCount = 0;
  const files = live.filter((record) => record.type === "file");
  for (const record of files) {
    const hash = changedHashes.get(record.itemId) ?? snapshotById.get(record.itemId)?.sha256 ?? record.sha256;
    if (!hash) continue;
    knownHashCount += 1;
    const group = byHash.get(hash) ?? [];
    group.push(record);
    byHash.set(hash, group);
  }
  return {
    groups: [...byHash.entries()].filter(([, members]) => members.length > 1).map(([hash, members]) => ({ hash, members })),
    knownHashCount,
    totalFileCount: files.length,
  };
}

async function diffScopeBeforeAfter(context: IntegratedContext, planId: string): Promise<Record<string, unknown>> {
  const plan = await getPlan(context, planId);
  const comparison = await compareSnapshotToLive(context, plan.snapshotId);
  const operationLogs = await context.storage.list<Record<string, unknown>>({ prefix: `integrated:operation:${plan.planId}:` });
  const modifiedOperations = [...operationLogs.values()].filter((record) => record.state === "completed");
  const outsideScopeOperations = modifiedOperations.filter((record) => {
    const before = record.before as CompactItem | undefined;
    const after = record.after as CompactItem | undefined;
    return (before && !scopeContains(plan.scopePath, before.relativePath)) || (after && !scopeContains(plan.scopePath, after.relativePath));
  });
  const snapshotRecords = await listSnapshotRecords(context, plan.snapshotId);
  const live = reconstructAuditLiveRecords(snapshotRecords, comparison);
  const parentCounts = new Map<string, number>();
  for (const record of live) if (record.parentItemId) parentCounts.set(record.parentItemId, (parentCounts.get(record.parentItemId) ?? 0) + 1);
  const duplicateHashEvidence = auditDuplicateHashGroups(snapshotRecords, live, comparison);
  const classification = classifyAdministrative(live, ADMIN_DEFAULT_PATTERNS, ["_Catalogue"]);
  const removedItems = comparison.removedItems as SnapshotRecord[];
  const changedETags = comparison.changedETags as Array<Record<string, unknown>>;
  return {
    planId,
    scopePath: plan.scopePath,
    expectedChanges: plan.actions.filter((action) => !["KEEP", "METADATA_ONLY", "CATALOGUE_ONLY"].includes(action.action)),
    unexpectedChanges: {
      addedItems: comparison.addedItems,
      removedItems: removedItems.filter((record) => !plan.actions.some((action) => action.sourceItemId === record.itemId && actionIsDestructive(action))),
      changedETags: changedETags.filter((change) => !plan.actions.some((action) => action.sourceItemId === change.itemId)),
    },
    unchangedItems: snapshotRecords.length - removedItems.length - changedETags.length,
    additions: comparison.addedItems,
    removals: comparison.removedItems,
    renamesAndMoves: comparison.movedOrRenamedItems,
    recycledItems: plan.results.filter((result) => result.recycled === true),
    hashChanges: comparison.changedSha256,
    catalogueChanges: plan.actions.filter((action) => ["CREATE_TEXT", "REPLACE_TEXT", "CATALOGUE_ONLY"].includes(action.action)),
    administrativeFiles: classification.administrative,
    substantiveFiles: classification.substantive,
    emptyFolders: live.filter((record) => record.type === "folder" && !parentCounts.has(record.itemId)),
    duplicateHashes: duplicateHashEvidence.groups,
    duplicateHashCoverage: {
      knownHashCount: duplicateHashEvidence.knownHashCount,
      totalFileCount: duplicateHashEvidence.totalFileCount,
      complete: duplicateHashEvidence.knownHashCount === duplicateHashEvidence.totalFileCount,
      source: "snapshot_and_changed-file_comparison",
    },
    changesOutsideScope: outsideScopeOperations,
    proof: {
      allMutationOperationsRecorded: plan.completedActions.every((actionId) => plan.results.some((result) => result.actionId === actionId)),
      outsideScopeOperationCount: outsideScopeOperations.length,
      rootAncestryRevalidatedPerOperation: true,
      operationLogCount: operationLogs.size,
      liveEnumerationCount: 1,
      secondLiveTraversalAvoided: true,
    },
  };
}

function classifyAdministrative(records: SnapshotRecord[], patterns: string[], cataloguePaths: string[]): { administrative: SnapshotRecord[]; substantive: SnapshotRecord[] } {
  const regexes = patterns.map((pattern) => {
    try { return new RegExp(pattern, "i"); } catch { return null; }
  }).filter((value): value is RegExp => Boolean(value));
  const administrative: SnapshotRecord[] = [];
  const substantive: SnapshotRecord[] = [];
  for (const record of records.filter((entry) => entry.type === "file")) {
    const inCatalogue = cataloguePaths.some((path) => record.relativePath.toLocaleLowerCase("en").includes(path.toLocaleLowerCase("en")));
    (inCatalogue || regexes.some((regex) => regex.test(record.relativePath) || regex.test(record.filename)) ? administrative : substantive).push(record);
  }
  return { administrative, substantive };
}

async function validateCatalogue(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const catalogueItemId = String(input.catalogueItemId ?? "");
  const pathColumn = String(input.pathColumn ?? "path");
  const shaColumn = String(input.sha256Column ?? "sha256");
  const normalizedColumn = String(input.normalizedTextHashColumn ?? "normalized_text_sha256");
  const requiredColumns = Array.isArray(input.requiredColumns) ? input.requiredColumns.map(String) : [pathColumn];
  const controlled = input.controlledValueFields && typeof input.controlledValueFields === "object" ? input.controlledValueFields as Record<string, string[]> : {};
  const file = await readAllExtractedText(context, catalogueItemId);
  const extension = extensionOf(file.metadata.filename);
  let rows: Array<Record<string, unknown>>;
  if (extension === ".json") {
    const parsed = JSON.parse(file.text) as unknown;
    rows = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : Array.isArray((parsed as Record<string, unknown>).items) ? (parsed as { items: Array<Record<string, unknown>> }).items : [];
  } else {
    const csv = parseCsv(file.text);
    const headers = csv[0] ?? [];
    rows = csv.slice(1).filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
  }
  const records = input.snapshotId ? await listSnapshotRecords(context, String(input.snapshotId)) : await enumerateLive(context, String(input.scopePath ?? ""));
  const adminPatterns = Array.isArray(input.administrativePathExclusions) ? input.administrativePathExclusions.map(String) : ADMIN_DEFAULT_PATTERNS;
  const classification = classifyAdministrative(records, adminPatterns, ["_Catalogue"]);
  const substantiveByPath = new Map(classification.substantive.map((record) => [record.relativePath.toLocaleLowerCase("en"), record]));
  const rowByPath = new Map<string, Array<{ row: Record<string, unknown>; index: number }>>();
  const missingFiles: Array<Record<string, unknown>> = [];
  const duplicateRows: Array<Record<string, unknown>> = [];
  const duplicateIds: Array<Record<string, unknown>> = [];
  const shaMismatches: Array<Record<string, unknown>> = [];
  const normalizedMismatches: Array<Record<string, unknown>> = [];
  const blankRequiredFields: Array<Record<string, unknown>> = [];
  const invalidControlledCodes: Array<Record<string, unknown>> = [];
  const administrativeIncluded: Array<Record<string, unknown>> = [];
  const idMap = new Map<string, number[]>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    for (const column of requiredColumns) if (!String(row[column] ?? "").trim()) blankRequiredFields.push({ row: index + 2, column });
    for (const [field, allowed] of Object.entries(controlled)) if (row[field] && !allowed.includes(String(row[field]))) invalidControlledCodes.push({ row: index + 2, field, value: row[field] });
    const path = strictRelativePath(String(row[pathColumn] ?? ""));
    const key = path.toLocaleLowerCase("en");
    const entries = rowByPath.get(key) ?? [];
    entries.push({ row, index: index + 2 });
    rowByPath.set(key, entries);
    const record = records.find((entry) => entry.relativePath.toLocaleLowerCase("en") === key);
    if (!record) missingFiles.push({ row: index + 2, path });
    else {
      if (classification.administrative.some((entry) => entry.itemId === record.itemId)) administrativeIncluded.push({ row: index + 2, path });
      if (row[shaColumn] && String(row[shaColumn]) !== record.sha256) {
        const actual = record.sha256 ?? (record.type === "file" ? (await shaForItem(context, record.itemId)).sha256 : null);
        if (String(row[shaColumn]) !== actual) shaMismatches.push({ row: index + 2, path, catalogue: row[shaColumn], actual });
      }
      if (row[normalizedColumn] && String(row[normalizedColumn]) !== record.normalizedTextSha256) {
        const actual = record.normalizedTextSha256 ?? (record.type === "file" ? (await normalizedHashForItem(context, record.itemId)).normalizedTextSha256 : null);
        if (String(row[normalizedColumn]) !== actual) normalizedMismatches.push({ row: index + 2, path, catalogue: row[normalizedColumn], actual });
      }
    }
    const id = String(row.id ?? row.ID ?? "").trim();
    if (id) { const ids = idMap.get(id) ?? []; ids.push(index + 2); idMap.set(id, ids); }
  }
  for (const [path, entries] of rowByPath) if (entries.length > 1) duplicateRows.push({ path, rows: entries.map((entry) => entry.index) });
  for (const [id, rowNumbers] of idMap) if (rowNumbers.length > 1) duplicateIds.push({ id, rows: rowNumbers });
  const uncatalogued = [...substantiveByPath.values()].filter((record) => !rowByPath.has(record.relativePath.toLocaleLowerCase("en")));
  const numericIds = [...idMap.keys()].filter((id) => /^\d+$/.test(id)).map(Number).sort((a, b) => a - b);
  const nonSequentialIds = numericIds.length > 0 ? numericIds.filter((value, index) => index > 0 && value !== numericIds[index - 1] + 1) : [];
  return {
    rowCount: rows.length,
    substantiveFileCount: classification.substantive.length,
    administrativeFileCount: classification.administrative.length,
    missingFiles,
    filesWithNoRow: uncatalogued,
    duplicateRows,
    duplicateIds,
    nonSequentialIds,
    sha256Mismatches: shaMismatches,
    normalizedTextMismatches: normalizedMismatches,
    blankRequiredFields,
    invalidControlledCodes,
    administrativeFilesIncludedAsSubstantive: administrativeIncluded,
    countryCityPathInconsistencies: [],
    semanticMetadataInvented: false,
  };
}

async function classifyAdministrativeFiles(context: IntegratedContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const records = input.snapshotId ? await listSnapshotRecords(context, String(input.snapshotId)) : await enumerateLive(context, String(input.scopePath ?? ""));
  const patterns = Array.isArray(input.patterns) ? input.patterns.map(String) : ADMIN_DEFAULT_PATTERNS;
  const cataloguePaths = Array.isArray(input.cataloguePaths) ? input.cataloguePaths.map(String) : ["_Catalogue"];
  const classified = classifyAdministrative(records, patterns, cataloguePaths);
  return { administrativeCount: classified.administrative.length, substantiveCount: classified.substantive.length, administrative: classified.administrative, substantive: classified.substantive };
}

const CROP_REGION_SCHEMA = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive().max(INTEGRATED_LIMITS.renderDimensionMax),
  height: z.number().positive().max(INTEGRATED_LIMITS.renderDimensionMax),
}).strict();

const QUERY_SNAPSHOT_SCHEMA = {
  snapshotId: z.string().uuid(),
  relativePath: z.string().max(1000).optional(),
  filename: z.string().max(255).optional(),
  extension: z.string().max(20).optional(),
  mimeType: z.string().max(200).optional(),
  itemType: z.enum(["file", "folder"]).optional(),
  minimumSize: z.number().int().min(0).optional(),
  maximumSize: z.number().int().min(0).optional(),
  language: z.string().max(50).optional(),
  missingHashes: z.boolean().optional(),
  duplicateSha256: z.boolean().optional(),
  duplicateNormalizedTextSha256: z.boolean().optional(),
  emptyFolders: z.boolean().optional(),
  forbiddenFilenamePatterns: z.array(z.string().max(500)).max(100).optional(),
  administrativePathPatterns: z.array(z.string().max(500)).max(100).optional(),
  unsupportedFiles: z.boolean().optional(),
  extractionFailures: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().max(50_000).optional(),
};

const INSPECT_DOCUMENT_SCHEMA = {
  itemId: z.string().min(1).max(500).optional(),
  snapshotItemId: z.string().min(1).max(500).optional(),
  extractionMode: z.enum(["deterministic", "text", "metadata", "visual-summary"]).default("deterministic"),
  startPosition: z.number().int().min(0).default(0),
  maximumOutput: z.number().int().min(1_000).max(100_000).default(30_000),
  includeMetadata: z.boolean().default(true),
  includeHeadings: z.boolean().default(true),
  includeCaptions: z.boolean().default(true),
  includeHyperlinks: z.boolean().default(true),
  includeFirstPage: z.boolean().default(true),
  includeHtmlDiagnostics: z.boolean().default(true),
  includeVisualSummaryMetadata: z.boolean().default(true),
};

const CALCULATE_HASHES_SCHEMA = {
  itemId: z.string().min(1).max(500).optional(),
  itemIds: z.array(z.string().min(1).max(500)).max(INTEGRATED_LIMITS.hashBatchMax).optional(),
  snapshotId: z.string().uuid().optional(),
  calculateNormalizedTextHash: z.boolean().default(true),
  calculatePerceptualHash: z.boolean().default(false),
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(INTEGRATED_LIMITS.hashBatchMax).default(INTEGRATED_LIMITS.hashBatchMax),
};

const SOURCE_DUPLICATES_SCHEMA = {
  snapshotId: z.string().uuid(),
  includeNormalizedText: z.boolean().default(true),
  includePerceptualImages: z.boolean().default(false),
  perceptualThreshold: z.number().int().min(0).max(16).default(8),
};

const SCAN_VISUAL_SOURCES_SCHEMA = {
  path: z.string().max(1000).default(""),
  recursive: z.boolean().default(true),
  maximumItems: z.number().int().min(1).max(INTEGRATED_LIMITS.snapshotItemsMax).default(INTEGRATED_LIMITS.snapshotItemsDefault),
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
};

const RENDER_DOCUMENT_SCHEMA = {
  itemId: z.string().min(1).max(500),
  pageOrSlide: z.number().int().min(1).max(INTEGRATED_LIMITS.pdfPagesMax).default(1),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  width: z.number().int().min(256).max(INTEGRATED_LIMITS.renderDimensionMax).optional(),
  dpi: z.number().int().min(36).max(300).optional(),
  height: z.number().int().min(256).max(INTEGRATED_LIMITS.renderDimensionMax).optional(),
  cropRegion: CROP_REGION_SCHEMA.optional(),
  transparentBackground: z.boolean().default(false),
};

const FETCH_VISUAL_ANALYSIS_SCHEMA = {
  visualId: z.string().min(1).max(50_000),
  mode: z.enum(["original", "rendered", "region"]).default("rendered"),
  maxDimension: z.number().int().min(256).max(3_000).default(1_600),
  cropRegion: CROP_REGION_SCHEMA.optional(),
};

const SAVE_VISUAL_SCHEMA = {
  visualId: z.string().min(1).max(50_000),
  mode: z.enum(["original", "rendered", "region"]).default("original"),
  destinationPath: z.string().max(1000).default(""),
  filename: z.string().min(1).max(255).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  width: z.number().int().min(256).max(INTEGRATED_LIMITS.renderDimensionMax).optional(),
  dpi: z.number().int().min(36).max(300).optional(),
  cropRegion: CROP_REGION_SCHEMA.optional(),
  conflictPolicy: z.enum(["fail", "auto-rename"]).default("fail"),
};

const CONTACT_SHEET_SCHEMA = {
  itemIds: z.array(z.string().min(1).max(500)).max(INTEGRATED_LIMITS.contactSheetItemsMax).default([]),
  visualIds: z.array(z.string().min(1).max(50_000)).max(INTEGRATED_LIMITS.contactSheetItemsMax).default([]),
  labels: z.array(z.string().max(500)).max(INTEGRATED_LIMITS.contactSheetItemsMax).optional(),
  columns: z.number().int().min(1).max(8).default(4),
  thumbnailWidth: z.number().int().min(96).max(800).default(300),
  thumbnailHeight: z.number().int().min(96).max(800).default(220),
  returnForAnalysis: z.boolean().default(true),
  saveToOneDrive: z.boolean().default(false),
  destinationPath: z.string().max(1000).default(""),
  filename: z.string().min(1).max(255).optional(),
  conflictPolicy: z.enum(["fail", "auto-rename"]).default("fail"),
};

const VISUAL_DUPLICATES_SCHEMA = {
  itemIds: z.array(z.string().min(1).max(500)).max(INTEGRATED_LIMITS.visualCountMax).default([]),
  visualIds: z.array(z.string().min(1).max(50_000)).max(INTEGRATED_LIMITS.visualCountMax).default([]),
  similarityThreshold: z.number().int().min(0).max(16).default(8),
};

const COPY_ITEM_SCHEMA = {
  itemId: z.string().min(1).max(500),
  destinationPath: z.string().max(1000),
  filename: z.string().min(1).max(255).optional(),
  conflictPolicy: z.enum(["fail", "auto-rename"]).default("fail"),
  verifySha256: z.boolean().default(false),
};

const PLAN_ACTION_SCHEMA = z.object({
  actionId: z.string().min(1).max(200).optional(),
  action: z.enum(["KEEP", "RENAME", "MOVE", "RECYCLE", "METADATA_ONLY", "CATALOGUE_ONLY", "CREATE_TEXT", "REPLACE_TEXT", "CREATE_FOLDER", "RECYCLE_FOLDER"]),
  sourceItemId: z.string().min(1).max(500).nullable().optional(),
  sourcePath: z.string().max(1000).nullable().optional(),
  destinationPath: z.string().max(1000).nullable().optional(),
  currentFilename: z.string().max(255).nullable().optional(),
  proposedFilename: z.string().max(255).nullable().optional(),
  snapshotETag: z.string().max(1000).nullable().optional(),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable().optional(),
  normalizedTextSha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable().optional(),
  reason: z.string().max(5_000).nullable().optional(),
  evidence: z.unknown().optional(),
  destructive: z.boolean().optional(),
  ambiguity: z.union([z.boolean(), z.enum(["yes", "no"])]).optional(),
  finalDecision: z.string().max(200).nullable().optional(),
  operationOrder: z.number().int().min(0).optional(),
  dependencies: z.array(z.string().min(1).max(200)).max(500).optional(),
  content: z.string().max(4_194_304).nullable().optional(),
  requiredStructuralPlaceholder: z.boolean().optional(),
}).strict();

const CREATE_PLAN_SCHEMA = {
  snapshotId: z.string().uuid(),
  scopePath: z.string().max(1000).optional(),
  actions: z.array(PLAN_ACTION_SCHEMA).min(1).max(5_000),
};

const VALIDATE_CATALOGUE_SCHEMA = {
  catalogueItemId: z.string().min(1).max(500),
  snapshotId: z.string().uuid().optional(),
  scopePath: z.string().max(1000).optional(),
  pathColumn: z.string().min(1).max(200).default("path"),
  sha256Column: z.string().min(1).max(200).default("sha256"),
  normalizedTextHashColumn: z.string().min(1).max(200).default("normalized_text_sha256"),
  administrativePathExclusions: z.array(z.string().max(500)).max(100).optional(),
  requiredColumns: z.array(z.string().min(1).max(200)).max(100).optional(),
  controlledValueFields: z.record(z.string(), z.array(z.string().max(200)).max(500)).optional(),
};

const CLASSIFY_ADMIN_SCHEMA = {
  snapshotId: z.string().uuid().optional(),
  scopePath: z.string().max(1000).optional(),
  patterns: z.array(z.string().max(500)).max(100).optional(),
  cataloguePaths: z.array(z.string().max(1000)).max(100).optional(),
};

export function registerIntegratedTools(server: McpServer, contextFactory: () => IntegratedContext): void {
  server.registerResource(
    "onedrive-document-visual-original",
    new ResourceTemplate("onedrive-document-visual:///{token}", { list: undefined }),
    { title: "Exact embedded document visual", description: "Exact embedded original bytes for a validated document visual. The source item, eTag, root ancestry, and locator are revalidated on every read.", mimeType: "application/octet-stream" },
    async (uri) => ({ contents: [await readVisualResource(contextFactory(), uri)] }),
  );

  server.registerTool("create_source_snapshot", {
    title: "Create immutable source snapshot",
    description: "Create a bounded immutable logical snapshot of one verified subtree for consistent parallel read-only audits. Large or extraction-heavy requests return a job ID.",
    inputSchema: {
      scopePath: z.string().max(1000).default(""), recursive: z.boolean().default(true), includeFiles: z.boolean().default(true), includeFolders: z.boolean().default(true),
      calculateSha256: z.boolean().default(false), calculateNormalizedTextHash: z.boolean().default(false), includeDocumentMetadata: z.boolean().default(false), includeExtractionStatus: z.boolean().default(true),
      maximumItems: z.number().int().min(1).max(INTEGRATED_LIMITS.snapshotItemsMax).default(INTEGRATED_LIMITS.snapshotItemsDefault), maximumDepth: z.number().int().min(0).max(INTEGRATED_LIMITS.recursionDepthMax).default(INTEGRATED_LIMITS.recursionDepthDefault),
      extensionAllowlist: z.array(z.string().max(20)).max(100).optional(), extensionDenylist: z.array(z.string().max(20)).max(100).optional(),
    }, annotations: READ_ONLY,
  }, async (input) => { try { return textResult(await createSourceSnapshot(contextFactory(), input as SnapshotInput)); } catch (error) { return errorResult(error); } });

  server.registerTool("query_source_snapshot", { title: "Query immutable source snapshot", description: "Filter and paginate stable records from an existing snapshot, including duplicate, empty-folder, administrative, unsupported, and extraction-failure filters.", inputSchema: QUERY_SNAPSHOT_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await querySourceSnapshot(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("compare_snapshot_to_live", { title: "Compare snapshot to live OneDrive", description: "Compare an immutable snapshot with the current verified live subtree and report additions, removals, renames, moves, eTag, size, hash, and folder-structure changes.", inputSchema: { snapshotId: z.string().uuid() }, annotations: READ_ONLY }, async ({ snapshotId }) => { try { return textResult(await compareSnapshotToLive(contextFactory(), snapshotId)); } catch (error) { return errorResult(error); } });
  server.registerTool("inspect_document", { title: "Inspect document deterministically", description: "Inspect PDF, DOCX, PPTX, POTX, PPSX, HTML, TXT, Markdown, CSV, JSON, and common images. Returns evidence and diagnostics without making semantic legal-status decisions.", inputSchema: INSPECT_DOCUMENT_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await inspectDocumentInternal(contextFactory(), String(input.itemId ?? input.snapshotItemId ?? ""), { startPosition: Number(input.startPosition ?? 0), maximumOutput: Number(input.maximumOutput ?? 30_000), includeMetadata: input.includeMetadata !== false, includeHeadings: input.includeHeadings !== false, includeCaptions: input.includeCaptions !== false, includeHyperlinks: input.includeHyperlinks !== false, includeFirstPage: input.includeFirstPage !== false, includeHtmlDiagnostics: input.includeHtmlDiagnostics !== false, includeVisualSummaryMetadata: input.includeVisualSummaryMetadata !== false })); } catch (error) { return errorResult(error); } });
  server.registerTool("calculate_file_hashes", { title: "Calculate exact and normalized hashes", description: "Calculate SHA-256 for files, normalized-text SHA-256 where extractable, and optional documented perceptual image hashes for one item, a bounded list, or a snapshot.", inputSchema: CALCULATE_HASHES_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await calculateFileHashes(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("find_source_duplicates", { title: "Find source-library duplicates", description: "Group exact binary, normalized-text, same-work different-format, suspected same-work, and optional perceptually similar images without making deletion decisions.", inputSchema: SOURCE_DUPLICATES_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await findSourceDuplicates(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("scan_visual_sources", { title: "Scan recursive visual sources", description: "Recursively identify loose images and visual-bearing PDF, PPTX, POTX, PPSX, and DOCX documents with provenance and bounded pagination.", inputSchema: SCAN_VISUAL_SOURCES_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await scanVisualSources(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("list_document_visuals", { title: "List visuals inside a document", description: "Enumerate embedded originals and render-required composite visuals inside PDF, PPTX, POTX, PPSX, or DOCX while preserving relationships, captions, alt text, hyperlinks, and provenance where available.", inputSchema: { itemId: z.string().min(1).max(500), cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }, annotations: READ_ONLY }, async ({ itemId, cursor, limit }) => { try { return textResult(await listDocumentVisuals(contextFactory(), itemId, cursor, limit)); } catch (error) { return errorResult(error); } });
  server.registerTool("render_document_page", { title: "Render exact document page or slide", description: "Render the requested one-based PDF page, PowerPoint slide, or Word page. Office files are converted to PDF by Microsoft Graph and the requested page is rendered through bounded Cloudflare Browser Run; no thumbnail substitution is used.", inputSchema: RENDER_DOCUMENT_SCHEMA, annotations: READ_ONLY }, async (input) => { try { const result = await renderDocumentPage(contextFactory(), input); return { structuredContent: result.metadata, content: [{ type: "text", text: JSON.stringify(result.metadata, null, 2) }, result.image] } as CallToolResult; } catch (error) { return errorResult(error); } });
  server.registerTool("fetch_document_visual_for_analysis", { title: "Fetch document visual for analysis", description: "Return actual bounded MCP image content for a stable document visual ID in original-preview, rendered, or region mode.", inputSchema: FETCH_VISUAL_ANALYSIS_SCHEMA, annotations: READ_ONLY }, async (input) => { try { const result = await previewVisualForAnalysis(contextFactory(), input); return { structuredContent: result.metadata, content: [{ type: "text", text: JSON.stringify(result.metadata, null, 2) }, result.image] } as CallToolResult; } catch (error) { return errorResult(error); } });
  server.registerTool("fetch_document_visual_original", { title: "Fetch exact embedded visual original", description: "Return an authenticated resource link to exact embedded original bytes. If no unchanged original exists, returns structured not_available rather than a rasterized substitute.", inputSchema: { visualId: z.string().min(1).max(50_000) }, annotations: READ_ONLY }, async ({ visualId }) => { try { const context = contextFactory(); const token = await decodeVisualToken(context, visualId); if (!token.candidate.exactOriginalAvailable) throw new ConnectorError("not_available", "An exact embedded original is not available for this visual."); const original = await originalVisualBytes(context, token); const resource = { type: "resource_link" as const, uri: visualResourceUri(visualId), name: original.filename, title: original.filename, description: "Exact embedded original bytes with root and eTag revalidation.", mimeType: original.mimeType, size: original.bytes.byteLength, annotations: { audience: ["assistant", "user"] as Array<"assistant" | "user">, priority: 1 } }; return { structuredContent: { visualId, filename: original.filename, mimeType: original.mimeType, byteSize: original.bytes.byteLength }, content: [{ type: "text", text: JSON.stringify({ visualId, filename: original.filename, mimeType: original.mimeType, byteSize: original.bytes.byteLength }, null, 2) }, resource] } as CallToolResult; } catch (error) { return errorResult(error); } });
  server.registerTool("save_document_visual", { title: "Save document visual to OneDrive", description: "Save an exact embedded original or generated render as an allowlisted binary file inside a verified destination. Conflicts fail by default and silent overwrite is impossible.", inputSchema: SAVE_VISUAL_SCHEMA, annotations: MUTATING }, async (input) => { try { return textResult(await saveDocumentVisual(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("create_visual_contact_sheet", { title: "Create visual contact sheet", description: "Create a bounded labelled contact sheet from loose images, embedded originals, or page renders; return it for analysis and optionally save it inside the configured root.", inputSchema: CONTACT_SHEET_SCHEMA, annotations: MUTATING }, async (input) => { try { const result = await createVisualContactSheet(contextFactory(), input); const content: any[] = [{ type: "text", text: JSON.stringify({ ...result, image: undefined }, null, 2) }]; if (result.image) content.push(result.image); return { structuredContent: { ...result, image: undefined }, content } as CallToolResult; } catch (error) { return errorResult(error); } });
  server.registerTool("find_visual_duplicates", { title: "Find exact and near-duplicate visuals", description: "Group exact SHA-256 duplicate and perceptually similar loose images, embedded originals, and saved renders. No file is moved or deleted.", inputSchema: VISUAL_DUPLICATES_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await findVisualDuplicates(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("copy_item", { title: "Copy OneDrive item non-destructively", description: "Copy a verified file or folder inside the configured root, monitor Microsoft Graph asynchronous completion, and optionally verify the copied SHA-256. HTTP 202 alone is never reported as success.", inputSchema: COPY_ITEM_SCHEMA, annotations: MUTATING }, async (input) => { try { return textResult(await copyItem(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("create_integrity_plan", { title: "Create source-library integrity dry-run", description: "Create and export a non-mutating CSV/JSON integrity plan tied to one immutable snapshot and explicit scope.", inputSchema: CREATE_PLAN_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await createIntegrityPlan(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("validate_integrity_plan", { title: "Validate integrity plan preconditions", description: "Fail closed on stale, ambiguous, conflicting, circular, out-of-scope, unlogged, or unapproved actions. Returns a signed short-lived execution token only when every check passes.", inputSchema: { planId: z.string().uuid() }, annotations: READ_ONLY }, async ({ planId }) => { try { return textResult(await validateIntegrityPlan(contextFactory(), planId)); } catch (error) { return errorResult(error); } });
  server.registerTool("execute_integrity_plan", { title: "Resume validated integrity plan", description: "Execute at most one mutation per invocation under an overlap-aware scope lock, persisting progress and rechecking live ancestry, path, eTag, SHA-256, destination, collision, circularity, and If-Match preconditions immediately before mutation.", inputSchema: { executionToken: z.string().min(1).max(50_000) }, annotations: DESTRUCTIVE }, async (input) => { try { return textResult(await executeIntegrityPlan(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("get_integrity_plan_status", { title: "Get integrity plan status", description: "Return validation, execution, completed, failed, dependency-skipped, and final-diff status for an integrity plan.", inputSchema: { planId: z.string().uuid() }, annotations: READ_ONLY }, async ({ planId }) => { try { const plan = await getPlan(contextFactory(), planId); const remaining = remainingActions(plan.actions, plan.completedActions, plan.failedActions, plan.skippedDependencyActions); return textResult({ planId, planStatus: plan.status, validationStatus: plan.validationStatus, executionStatus: plan.executionStatus, currentAction: plan.currentAction, nextAction: plan.nextAction ?? remaining[0]?.actionId ?? null, resumeRequired: remaining.length > 0, remainingActions: remaining.length, completedActions: plan.completedActions, failedActions: plan.failedActions, skippedDependencyActions: plan.skippedDependencyActions, auditStatus: plan.auditStatus ?? "not_requested", finalFilesystemDiffReference: plan.finalFilesystemDiffReference }); } catch (error) { return errorResult(error); } });
  server.registerTool("diff_scope_before_after", { title: "Verify scope before and after", description: "Run the final full-scope enumeration, hashing, catalogue analysis, and operation-log comparison as a separate follow-up after bounded plan execution.", inputSchema: { planId: z.string().uuid() }, annotations: READ_ONLY }, async ({ planId }) => { const context = contextFactory(); try { const plan = await getPlan(context, planId); plan.auditStatus = "running"; await storePlan(context, plan); const diff = await diffScopeBeforeAfter(context, planId); plan.finalFilesystemDiffReference = `integrated:diff:${plan.planId}`; plan.auditStatus = "completed"; await context.storage.put(plan.finalFilesystemDiffReference, diff); await storePlan(context, plan); return textResult(diff); } catch (error) { try { const plan = await getPlan(context, planId); plan.auditStatus = "failed"; await storePlan(context, plan); } catch { /* preserve the original error */ } return errorResult(error); } });
  server.registerTool("validate_catalogue", { title: "Validate catalogue against filesystem", description: "Validate catalogue paths, IDs, exact and normalized hashes, controlled codes, required fields, administrative exclusions, and substantive-file coverage without inventing semantic metadata.", inputSchema: VALIDATE_CATALOGUE_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await validateCatalogue(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("classify_administrative_files", { title: "Classify administrative and substantive files", description: "Apply caller-supplied path and filename patterns to separate catalogues, reports, manifests, logs, inventories, duplicate registers, audit tables, manual-download lists, and README files from substantive sources.", inputSchema: CLASSIFY_ADMIN_SCHEMA, annotations: READ_ONLY }, async (input) => { try { return textResult(await classifyAdministrativeFiles(contextFactory(), input)); } catch (error) { return errorResult(error); } });
  server.registerTool("get_job_status", { title: "Get integrated job status", description: "Return queued, running, completed, failed, or cancelled status, progress, stage, result references, structured error, retryability, and expiry for long integrated operations.", inputSchema: { jobId: z.string().uuid() }, annotations: READ_ONLY }, async ({ jobId }) => { try { return textResult(await getJob(contextFactory(), jobId)); } catch (error) { return errorResult(error); } });
}
