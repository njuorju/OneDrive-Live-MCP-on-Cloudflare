import { ConnectorError } from "./errors";
import { graphFetchBytes, verifyItemInsideRoot } from "./graph-core";
import { sha256Bytes } from "./integrated-core";
import { canonicalJson, getArtifact, nowIso, putArtifact, sha256HexUtf8 } from "./paid-core";
import {
  applyStructuredPatchText,
  assertExpectedETag,
  preparedContent,
  type CatalogueRecord,
  type FieldDiff,
  type StructuredFormat,
  type StructuredPatch,
} from "./structured-catalogue";
import type { HotfixContext } from "./version20-hotfix";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export type PreparedItemDefinition = {
  role: "single" | "csv" | "json";
  itemId: string;
  relativePath: string;
  filename: string;
  sourceETag: string;
  sourceSha256: string;
  format: StructuredFormat;
  outputSha256: string;
  outputByteLength: number;
  artifactKey: string;
  diff: FieldDiff[];
  preview: string;
};

export type PreparationDefinition = {
  version: 1;
  kind: "single" | "catalogue_pair";
  preparationId: string;
  fingerprint: string;
  fingerprintMaterial: Record<string, unknown>;
  createdAt: string;
  recordKeyField: string;
  patches: StructuredPatch[];
  semanticDigest: string | null;
  items: PreparedItemDefinition[];
  oneDriveMutationPerformed: false;
};

type PreparedCandidate = Omit<PreparedItemDefinition, "artifactKey"> & {
  bytes: Uint8Array;
  records: CatalogueRecord[];
};

function detectFormat(filename: string, requested: "auto" | StructuredFormat): StructuredFormat {
  if (requested !== "auto") return requested;
  const lower = filename.toLocaleLowerCase("en");
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  throw new ConnectorError("structured_format_unsupported", "Only UTF-8 CSV and JSON array catalogues are supported.");
}
async function prefix(context: HotfixContext, preparationId: string): Promise<string> {
  return `preparations/${await sha256HexUtf8(context.userId)}/${preparationId}`;
}

export async function prepareOne(
  context: HotfixContext,
  input: {
    itemId: string;
    expectedETag?: string;
    format: "auto" | StructuredFormat;
    recordKeyField: string;
    patches: StructuredPatch[];
    previewCharacters: number;
  },
  role: PreparedItemDefinition["role"],
): Promise<PreparedCandidate> {
  const verified = await verifyItemInsideRoot(context.env, context.userId, input.itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "Structured preparation requires a file.");
  const sourceETag = assertExpectedETag(input.expectedETag, verified.item.eTag);
  if (Number(verified.item.size ?? 0) > MAX_SOURCE_BYTES) throw new ConnectorError("structured_source_too_large", "The structured catalogue exceeds the 20 MB preparation limit.");
  const buffer = await graphFetchBytes(context.env, context.userId, `/me/drive/items/${encodeURIComponent(verified.item.id)}/content`, MAX_SOURCE_BYTES);
  const current = await verifyItemInsideRoot(context.env, context.userId, input.itemId);
  assertExpectedETag(sourceETag, current.item.eTag);
  const sourceBytes = new Uint8Array(buffer);
  const format = detectFormat(current.item.name, input.format);
  const prepared = applyStructuredPatchText(sourceBytes, format, input.recordKeyField, input.patches, input.previewCharacters);
  return {
    role,
    itemId: current.item.id,
    relativePath: current.relativePath,
    filename: current.item.name,
    sourceETag,
    sourceSha256: await sha256Bytes(sourceBytes),
    format,
    outputSha256: await sha256Bytes(prepared.bytes),
    outputByteLength: prepared.bytes.byteLength,
    diff: prepared.diffs,
    preview: prepared.preview,
    bytes: prepared.bytes,
    records: prepared.records,
  };
}

export async function storePreparation(
  context: HotfixContext,
  kind: PreparationDefinition["kind"],
  recordKeyField: string,
  patches: StructuredPatch[],
  items: PreparedCandidate[],
  semanticDigest: string | null,
): Promise<{ definition: PreparationDefinition; idempotentReplay: boolean }> {
  const fingerprintMaterial = {
    version: 1,
    kind,
    recordKeyField,
    patches,
    semanticDigest,
    items: items.map(({ bytes: _bytes, records: _records, ...item }) => item),
  };
  const fingerprint = await sha256HexUtf8(canonicalJson(fingerprintMaterial));
  const preparationId = `prep_${fingerprint.slice(0, 48)}`;
  const base = await prefix(context, preparationId);
  const definitionKey = `${base}/definition.json`;
  const existing = await context.env.ARTIFACTS.head(definitionKey);
  const storedItems: PreparedItemDefinition[] = [];
  for (const item of items) {
    const artifactKey = `${base}/${item.role}.utf8`;
    if (!existing) await putArtifact(context.env, artifactKey, item.bytes, "application/octet-stream", {
      preparationId,
      fingerprint,
      role: item.role,
      sha256: item.outputSha256,
      sourceETag: item.sourceETag,
    });
    const { bytes: _bytes, records: _records, ...rest } = item;
    storedItems.push({ ...rest, artifactKey });
  }
  const definition: PreparationDefinition = {
    version: 1,
    kind,
    preparationId,
    fingerprint,
    fingerprintMaterial,
    createdAt: nowIso(),
    recordKeyField,
    patches,
    semanticDigest,
    items: storedItems,
    oneDriveMutationPerformed: false,
  };
  if (!existing) {
    await putArtifact(context.env, definitionKey, JSON.stringify(definition, null, 2), "application/json; charset=utf-8", { preparationId, fingerprint, kind });
    return { definition, idempotentReplay: false };
  }
  const previous = JSON.parse(await (await getArtifact(context.env, definitionKey)).text()) as PreparationDefinition;
  if (previous.fingerprint !== fingerprint) throw new ConnectorError("preparation_collision", "The deterministic preparation ID is already associated with another definition.");
  return { definition: previous, idempotentReplay: true };
}

export async function readPreparation(context: HotfixContext, preparationId: string): Promise<PreparationDefinition> {
  if (!/^prep_[0-9a-f]{48}$/.test(preparationId)) throw new ConnectorError("preparation_id_invalid", "The preparation ID is invalid.");
  const object = await getArtifact(context.env, `${await prefix(context, preparationId)}/definition.json`);
  let definition: PreparationDefinition;
  try { definition = JSON.parse(await object.text()) as PreparationDefinition; }
  catch { throw new ConnectorError("preparation_definition_invalid", "The stored preparation definition is invalid."); }
  const recomputed = await sha256HexUtf8(canonicalJson(definition.fingerprintMaterial));
  if (definition.preparationId !== preparationId || definition.fingerprint !== recomputed || preparationId !== `prep_${recomputed.slice(0, 48)}`) {
    throw new ConnectorError("preparation_fingerprint_invalid", "The stored preparation fingerprint does not match its immutable definition.");
  }
  return definition;
}

export async function preparedContents(context: HotfixContext, definition: PreparationDefinition): Promise<string[]> {
  const contents: string[] = [];
  for (const item of definition.items) {
    const current = await verifyItemInsideRoot(context.env, context.userId, item.itemId);
    assertExpectedETag(item.sourceETag, current.item.eTag);
    const bytes = new Uint8Array(await (await getArtifact(context.env, item.artifactKey)).arrayBuffer());
    if (bytes.byteLength !== item.outputByteLength || await sha256Bytes(bytes) !== item.outputSha256) throw new ConnectorError("prepared_bytes_changed", "The exact prepared R2 bytes no longer match the immutable preparation definition.");
    contents.push(preparedContent(bytes));
  }
  return contents;
}

export function buildPreparedPlanActions(definition: PreparationDefinition, contents: string[], reason: string, actionIdPrefix: string): Array<Record<string, unknown>> {
  return definition.items.map((item, index) => ({
    actionId: `${actionIdPrefix}-${item.role}-${index + 1}`,
    action: "REPLACE_TEXT",
    sourceItemId: item.itemId,
    sourcePath: item.relativePath,
    currentFilename: item.filename,
    proposedFilename: item.filename,
    snapshotETag: item.sourceETag,
    snapshotSha256: item.sourceSha256,
    reason,
    evidence: {
      preparationId: definition.preparationId,
      preparationFingerprint: definition.fingerprint,
      semanticDigest: definition.semanticDigest,
      preparedSha256: item.outputSha256,
      preparedByteLength: item.outputByteLength,
      fieldDiff: item.diff,
      nonMutatingPreparation: true,
    },
    destructive: false,
    ambiguity: false,
    finalDecision: "prepared_structured_replacement",
    operationOrder: index,
    dependencies: [],
    content: contents[index],
  }));
}
