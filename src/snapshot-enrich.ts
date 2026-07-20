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
import type { HotfixContext } from "./version20-hotfix";
import { reliableGraphBytes, reliableGraphSha256, type GraphDiagnostics } from "./snapshot-graph";
import type { ListedItem, SnapshotInput, SnapshotRecord } from "./snapshot-model";

const READABLE_TEXT = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm"]);
const OOXML_PRESENTATION = new Set([".pptx", ".potx", ".ppsx"]);
const OOXML_WORD = new Set([".docx"]);

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

export async function enrichRecord(context: HotfixContext, item: ListedItem, relativePath: string, index: number, input: SnapshotInput, diagnostics: GraphDiagnostics): Promise<SnapshotRecord> {
  const record = baseRecord(item, relativePath, index);
  if (record.type === "folder") return record;
  const needsExtractionBytes = input.calculateNormalizedTextHash || input.includeDocumentMetadata;
  const needsAnyContent = input.calculateSha256 || needsExtractionBytes;
  if (!needsAnyContent) return record;

  const oversizedForDeterministicExtraction = Number(record.byteSize ?? 0) > INTEGRATED_LIMITS.fileBytesMax;
  let bytes: ArrayBuffer | null = null;

  if (input.calculateSha256) {
    if (oversizedForDeterministicExtraction) {
      record.sha256 = (await reliableGraphSha256(context.env, context.userId, item.id, item.eTag ?? null, diagnostics)).sha256;
    } else {
      bytes = await reliableGraphBytes(context.env, context.userId, item.id, item.eTag ?? null, diagnostics);
      record.sha256 = await sha256Bytes(bytes);
    }
  }

  if (needsExtractionBytes && oversizedForDeterministicExtraction) {
    record.extractionStatus = "skipped_size_limit";
    if (input.calculateNormalizedTextHash) {
      record.extractedCharacterCount = 0;
      record.representationStatus = "size_limited";
    }
    if (input.includeDocumentMetadata) {
      record.documentMetadata = {
        extractionSkipped: "file_too_large_for_bounded_deterministic_extraction",
        byteSize: record.byteSize,
        sha256CapturedByStreaming: Boolean(record.sha256),
      };
    }
    record.error = {
      code: "extraction_size_limit",
      message: "SHA-256 was captured by streaming, but bounded deterministic extraction was skipped for this large file.",
    };
    return record;
  }

  if (needsExtractionBytes && !bytes) {
    bytes = await reliableGraphBytes(context.env, context.userId, item.id, item.eTag ?? null, diagnostics);
  }
  if (!bytes) return record;

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

export const snapshotEnrichTestHooks = {
  oversizedForDeterministicExtraction: (byteSize: number) => byteSize > INTEGRATED_LIMITS.fileBytesMax,
};
