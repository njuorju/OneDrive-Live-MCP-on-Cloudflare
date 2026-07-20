import { ConnectorError } from "./errors";
import { extensionOf } from "./file-types";
import {
  INTEGRATED_LIMITS,
  inspectDocx,
  inspectPdfBytes,
  inspectPptx,
  normalizeExtractedText,
  safeUnzipOoxml,
  sha256Bytes,
} from "./integrated-core";
import type { GraphDriveItem } from "./types";
import type { HotfixContext, StableStorage } from "./version20-hotfix";
import { reliableGraphBytes, type GraphDiagnostics } from "./snapshot-graph";

export type SnapshotInput = {
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

export type SnapshotRecord = {
  itemId: string;
  filename: string;
  relativePath: string;
  type: "file" | "folder";
  mimeType: string | null;
  extension: string;
  byteSize: number | null;
  modifiedDate: string | null;
  eTag: string | null;
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
  rootCTag?: string | null;
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
  error: { code: string; message: string; retryable: boolean; status?: number; correlationId?: string } | null;
};

export type ListedItem = GraphDriveItem & { createdDateTime?: string };
export type FolderCursor = { itemId: string; relativePath: string; depth: number; nextUrl?: string };
export type ActivePage = {
  folder: FolderCursor;
  items: ListedItem[];
  offset: number;
  nextUrl?: string;
  pageNumber: number;
};
export type PendingWrite = {
  itemId: string;
  recordIndex: number;
  record: SnapshotRecord;
  isFile: boolean;
  enqueue?: FolderCursor;
};
export type SnapshotCheckpoint = {
  version: 1;
  snapshotId: string;
  jobId: string;
  userId: string;
  input: SnapshotInput;
  queue: FolderCursor[];
  activePage?: ActivePage;
  pending?: PendingWrite;
  recordIndex: number;
  totalFiles: number;
  totalFolders: number;
  pageNumber: number;
  retryCount: number;
  lastResumeRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleSnapshot = (jobId: string, userId: string, delaySeconds?: number) => Promise<void>;
export const SNAPSHOT_RETENTION_SECONDS = INTEGRATED_LIMITS.snapshotRetentionSeconds;
export const JOB_RETENTION_SECONDS = INTEGRATED_LIMITS.jobRetentionSeconds;
export const JOB_RETRY_BUDGET = 8;
export const STEP_WALL_BUDGET_MS = 20_000;
const READABLE_TEXT = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm"]);
const OOXML_PRESENTATION = new Set([".pptx", ".potx", ".ppsx"]);
const OOXML_WORD = new Set([".docx"]);

export function nowIso(): string { return new Date().toISOString(); }
export function expiryIso(seconds: number): string { return new Date(Date.now() + seconds * 1000).toISOString(); }
export function strictPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ConnectorError("invalid_path", "The snapshot scope contains an invalid path segment.");
  }
  return normalized;
}
export function snapshotMetaKey(id: string): string { return `integrated:snapshot:${id}:meta`; }
export function snapshotItemKey(id: string, index: number): string { return `integrated:snapshot:${id}:item:${String(index).padStart(8, "0")}`; }
export function snapshotPrefix(id: string): string { return `integrated:snapshot:${id}:item:`; }
export function checkpointKey(id: string): string { return `integrated:snapshot:${id}:checkpoint`; }
export function seenKey(id: string, itemId: string): string { return `integrated:snapshot:${id}:seen:${itemId}`; }
export function jobKey(id: string): string { return `integrated:job:${id}`; }
function baseRecord(item: ListedItem, relativePath: string, index: number): SnapshotRecord {
  const extension = item.folder ? "" : extensionOf(item.name);
  return {
    itemId: item.id,
    filename: item.name,
    relativePath,
    type: item.folder ? "folder" : "file",
    mimeType: item.file?.mimeType ?? null,
    extension,
    byteSize: item.folder ? null : Number(item.size ?? 0),
    modifiedDate: item.lastModifiedDateTime ?? null,
    eTag: item.eTag ?? null,
    snapshotIndex: index,
    parentItemId: item.parentReference?.id ?? null,
    createdDate: item.createdDateTime ?? null,
    sha256: null,
    normalizedTextSha256: null,
    extractedCharacterCount: null,
    extractionStatus: null,
    representationStatus: null,
    documentMetadata: null,
    error: null,
  };
}

async function enrichRecord(context: HotfixContext, item: ListedItem, relativePath: string, index: number, input: SnapshotInput, diagnostics: GraphDiagnostics): Promise<SnapshotRecord> {
  const record = baseRecord(item, relativePath, index);
  if (record.type === "folder") return record;
  const needsBytes = input.calculateSha256 || input.calculateNormalizedTextHash || input.includeDocumentMetadata;
  if (!needsBytes) return record;
  const bytes = await reliableGraphBytes(context.env, context.userId, item.id, item.eTag ?? null, diagnostics);
  if (input.calculateSha256) record.sha256 = await sha256Bytes(bytes);
  try {
    let text = "";
    let metadata: Record<string, unknown> = {};
    if (OOXML_PRESENTATION.has(record.extension)) {
      const inspected = inspectPptx(safeUnzipOoxml(bytes));
      text = inspected.text;
      metadata = { pageOrSlideCount: inspected.pageCount, embeddedImageCount: inspected.embeddedImageCount, applicationMetadata: inspected.metadata };
      record.extractionStatus = "ooxml_xml";
    } else if (OOXML_WORD.has(record.extension)) {
      const inspected = inspectDocx(safeUnzipOoxml(bytes));
      text = inspected.text;
      metadata = { pageOrSlideCount: inspected.pageCount, embeddedImageCount: inspected.embeddedImageCount, applicationMetadata: inspected.metadata, firstSubstantiveHeadings: inspected.headings.slice(0, 50) };
      record.extractionStatus = "ooxml_xml";
    } else if (record.extension === ".pdf") {
      const inspected = inspectPdfBytes(bytes);
      metadata = { pageOrSlideCount: inspected.pageCount, internalTitle: inspected.title, authorOrOrganisation: inspected.author, embeddedImageCount: inspected.visuals.filter((visual) => visual.objectType === "embedded_raster").length };
      record.extractionStatus = "pdf_metadata";
    } else if (READABLE_TEXT.has(record.extension)) {
      text = new TextDecoder().decode(bytes).slice(0, INTEGRATED_LIMITS.normalizedTextCharsMax);
      record.extractionStatus = "direct_text";
    } else {
      record.extractionStatus = "unsupported";
    }
    if (input.calculateNormalizedTextHash && text) {
      const normalized = normalizeExtractedText(text);
      record.normalizedTextSha256 = normalized.normalizedText ? await sha256Bytes(new TextEncoder().encode(normalized.normalizedText).buffer as ArrayBuffer) : null;
      record.extractedCharacterCount = normalized.extractedCharacterCount;
      record.representationStatus = normalized.representationStatus;
    } else if (input.calculateNormalizedTextHash) {
      record.extractedCharacterCount = 0;
      record.representationStatus = "image_only_or_unextractable";
    }
    if (input.includeDocumentMetadata) record.documentMetadata = metadata;
  } catch (error) {
    const safe = error instanceof ConnectorError ? error : new ConnectorError("extraction_failed", "Deterministic extraction failed for this file.");
    record.error = { code: safe.code, message: safe.message };
    if (input.includeExtractionStatus) record.extractionStatus = "failed";
  }
  return record;
}

export async function putJob(storage: StableStorage, job: JobRecord): Promise<void> { job.updatedAt = nowIso(); await storage.put(jobKey(job.jobId), job); }
export async function getJob(storage: StableStorage, jobId: string): Promise<JobRecord> {
  const job = await storage.get<JobRecord>(jobKey(jobId));
  if (!job) throw new ConnectorError("job_not_found", "The job does not exist or has expired.");
  return job;
}
export async function getCheckpoint(storage: StableStorage, snapshotId: string): Promise<SnapshotCheckpoint> {
  const checkpoint = await storage.get<SnapshotCheckpoint>(checkpointKey(snapshotId));
  if (!checkpoint) throw new ConnectorError("snapshot_checkpoint_missing", "The resumable snapshot checkpoint is missing.");
  return checkpoint;
}
export async function persistState(storage: StableStorage, checkpoint: SnapshotCheckpoint, meta: SnapshotMeta, job: JobRecord): Promise<void> {
  checkpoint.updatedAt = nowIso();
  meta.totalFiles = checkpoint.totalFiles; meta.totalFolders = checkpoint.totalFolders; meta.totalRecords = checkpoint.recordIndex;
  await storage.put(checkpointKey(checkpoint.snapshotId), checkpoint);
  await storage.put(snapshotMetaKey(checkpoint.snapshotId), meta);
  await putJob(storage, job);
}

export async function finishPending(storage: StableStorage, checkpoint: SnapshotCheckpoint, meta: SnapshotMeta, job: JobRecord): Promise<void> {
  const pending = checkpoint.pending;
  if (!pending) return;
  await storage.put(snapshotItemKey(checkpoint.snapshotId, pending.recordIndex), pending.record);
  await storage.put(seenKey(checkpoint.snapshotId, pending.itemId), true);
  checkpoint.recordIndex = Math.max(checkpoint.recordIndex, pending.recordIndex + 1);
  if (pending.isFile) checkpoint.totalFiles += 1; else checkpoint.totalFolders += 1;
  if (pending.enqueue) checkpoint.queue.push(pending.enqueue);
  if (checkpoint.activePage) checkpoint.activePage.offset += 1;
  checkpoint.pending = undefined;
  job.progress = Math.min(95, Math.max(1, 1 + checkpoint.pageNumber + Math.floor(checkpoint.recordIndex / 5)));
  job.currentStage = `enumerating_page_${Math.max(1, checkpoint.pageNumber)}_items_${checkpoint.recordIndex}`;
  await persistState(storage, checkpoint, meta, job);
}

export function allowed(item: ListedItem, input: SnapshotInput): boolean {
  if (item.folder) return input.includeFolders;
  if (!input.includeFiles) return false;
  const ext = extensionOf(item.name).toLowerCase();
  const allow = input.extensionAllowlist?.map((v) => v.startsWith(".") ? v.toLowerCase() : `.${v.toLowerCase()}`);
  const deny = input.extensionDenylist?.map((v) => v.startsWith(".") ? v.toLowerCase() : `.${v.toLowerCase()}`);
  if (allow?.length && !allow.includes(ext)) return false;
  if (deny?.includes(ext)) return false;
  return true;
}

export async function cleanupExpired(storage: StableStorage, job: JobRecord): Promise<void> {
  if (Date.parse(job.expiresAt) > Date.now()) return;
  const snapshotId = String(job.resultReferences.snapshotId ?? "");
  if (snapshotId) {
    const records = await storage.list({ prefix: snapshotPrefix(snapshotId) });
    for (const key of records.keys()) await storage.delete(key);
    const seen = await storage.list({ prefix: `integrated:snapshot:${snapshotId}:seen:` });
    for (const key of seen.keys()) await storage.delete(key);
    await storage.delete(snapshotMetaKey(snapshotId));
    await storage.delete(checkpointKey(snapshotId));
  }
  await storage.delete(jobKey(job.jobId));
  throw new ConnectorError("job_not_found", "The job does not exist or has expired.");
}
