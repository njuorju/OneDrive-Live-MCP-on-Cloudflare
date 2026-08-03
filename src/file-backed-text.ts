import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getRuntimeConfig } from "./config";
import { asConnectorError, ConnectorError, logSafeError, safeErrorResult } from "./errors";
import { isAllowedTextFile, normalizedMimeType, validateFileSignature } from "./file-types";
import {
  compactVerifiedItem,
  graphFetch,
  graphFetchBytes,
  resolveRelativeFolder,
  validateItemName,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import type { GraphDriveItem } from "./types";
import {
  connectorFileInputSchema,
  decodeStrictUtf8,
  loadConnectorTextFile,
  trustedConnectorFileUrl,
  type LoadedConnectorTextFile,
} from "./connector-files";
export {
  connectorFileInputSchema,
  connectorFileRuntimeShape,
  loadConnectorTextFile,
  normalizeConnectorFileReference,
  trustedConnectorFileUrl,
} from "./connector-files";

const AMBIGUOUS_GRAPH_CODES = new Set([
  "graph_network_error",
  "graph_timeout",
  "graph_unreachable",
  "graph_server_error",
  "graph_subrequest_limit",
]);
type CatalogueRecord = Record<string, unknown>;
type ParsedCsv = { records: CatalogueRecord[]; columns: string[] };
type FileBackedContext = { env: Env; userId: string };
type ExactVerification = {
  item: VerifiedItem;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  verified: true;
};

export type CatalogueParityResult = {
  recordCount: number;
  recordKeyField: string;
  sharedFields: string[];
  identicalRecordKeySet: true;
  duplicateKeys: false;
  sharedFieldParity: true;
};

function textResult(data: unknown): CallToolResult {
  const structuredContent = data && typeof data === "object"
    ? data as Record<string, unknown>
    : { value: data };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  return safeErrorResult(error) as CallToolResult;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireExpectedETag(source: VerifiedItem, expectedETag: string): void {
  if (!expectedETag) throw new ConnectorError("etag_required", "An expected eTag is required for this verified mutation.");
  if (!source.item.eTag || source.item.eTag !== expectedETag) {
    throw new ConnectorError("etag_conflict", "The item changed since its eTag was read.");
  }
}

function assertWritableTextItem(source: VerifiedItem): void {
  if (source.item.folder || !isAllowedTextFile(source.item.name)) {
    throw new ConnectorError("not_text_file", "Only allowlisted UTF-8 text files can be replaced.");
  }
}

async function createExactTextBytes(
  env: Env,
  userId: string,
  destination: VerifiedItem,
  filename: string,
  bytes: Uint8Array,
): Promise<VerifiedItem> {
  if (!destination.item.folder) throw new ConnectorError("not_a_folder", "The destination is not a folder.");
  const created = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(destination.item.id)}:/${encodeURIComponent(filename)}:/content?%40microsoft.graph.conflictBehavior=fail`,
    {
      method: "PUT",
      headers: {
        "Content-Type": normalizedMimeType(filename),
        "If-None-Match": "*",
      },
      body: exactArrayBuffer(bytes),
    },
  );
  if (!created.id) throw new ConnectorError("mutation_result_invalid", "Microsoft Graph returned an invalid created item.");
  return verifyItemInsideRoot(env, userId, created.id);
}

async function replaceExactTextBytes(
  env: Env,
  userId: string,
  source: VerifiedItem,
  expectedETag: string,
  bytes: Uint8Array,
): Promise<VerifiedItem> {
  assertWritableTextItem(source);
  requireExpectedETag(source, expectedETag);
  const replaced = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(source.item.id)}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": normalizedMimeType(source.item.name, source.item.file?.mimeType),
        "If-Match": expectedETag,
      },
      body: exactArrayBuffer(bytes),
    },
  );
  if (replaced.id !== source.item.id || replaced.parentReference?.driveId !== source.driveId) {
    throw new ConnectorError("mutation_result_invalid", "Microsoft Graph returned an unexpected replacement item.");
  }
  return verifyItemInsideRoot(env, userId, replaced.id);
}

async function verifyExactLiveBytes(
  env: Env,
  userId: string,
  item: VerifiedItem,
  expectedBytes: Uint8Array,
  expectedHash: string,
  maximumBytes: number,
): Promise<ExactVerification> {
  const current = await verifyItemInsideRoot(env, userId, item.item.id);
  const bytes = new Uint8Array(await graphFetchBytes(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(current.item.id)}/content`,
    maximumBytes,
  ));
  const sha256 = await sha256HexBytes(bytes);
  if (bytes.byteLength !== expectedBytes.byteLength || sha256 !== expectedHash) {
    throw new ConnectorError("write_verification_failed", "The OneDrive read-back did not match the submitted exact bytes.", {
      details: {
        expectedByteLength: expectedBytes.byteLength,
        actualByteLength: bytes.byteLength,
        expectedSha256: expectedHash,
        actualSha256: sha256,
      },
    });
  }
  return { item: current, bytes, byteLength: bytes.byteLength, sha256, verified: true };
}

function publicationResult(verification: ExactVerification, previousETag?: string) {
  const compact = compactVerifiedItem(verification.item);
  return {
    itemId: compact.itemId,
    path: compact.relativePath,
    filename: compact.filename,
    ...(previousETag ? { previousETag, newETag: compact.eTag } : { eTag: compact.eTag }),
    byteLength: verification.byteLength,
    sha256: verification.sha256,
    mimeType: compact.mimeType,
    verificationResult: "verified",
    verification: {
      verified: true,
      exactBytes: true,
      readBackByteLength: verification.byteLength,
      readBackSha256: verification.sha256,
    },
  };
}

export async function createTextFileFromConnectorFileStrict(
  env: Env,
  userId: string,
  fileReference: unknown,
  destinationPath: string,
  filename: string,
  suppliedExpectedSha256?: string,
) {
  const config = getRuntimeConfig(env);
  const safeName = validateItemName(filename);
  const incoming = await loadConnectorTextFile(fileReference, safeName, config.maxTextWriteBytes, suppliedExpectedSha256);
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  const created = await createExactTextBytes(env, userId, destination, safeName, incoming.bytes);
  const verification = await verifyExactLiveBytes(env, userId, created, incoming.bytes, incoming.sha256, config.maxTextWriteBytes);
  return publicationResult(verification);
}

export async function replaceTextFileFromConnectorFileStrict(
  env: Env,
  userId: string,
  fileReference: unknown,
  itemId: string,
  expectedETag: string,
  suppliedExpectedSha256?: string,
) {
  const config = getRuntimeConfig(env);
  const source = await verifyItemInsideRoot(env, userId, itemId);
  assertWritableTextItem(source);
  requireExpectedETag(source, expectedETag);
  const incoming = await loadConnectorTextFile(fileReference, source.item.name, config.maxTextWriteBytes, suppliedExpectedSha256);
  const replaced = await replaceExactTextBytes(env, userId, source, expectedETag, incoming.bytes);
  const verification = await verifyExactLiveBytes(env, userId, replaced, incoming.bytes, incoming.sha256, config.maxTextWriteBytes);
  return publicationResult(verification, expectedETag);
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += character;
    } else if (character === '"') {
      if (field) throw new ConnectorError("malformed_csv", "A CSV quote appears inside an unquoted field.");
      quoted = true;
    } else if (character === ",") {
      row.push(field); field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += character;
  }
  if (quoted) throw new ConnectorError("malformed_csv", "The CSV contains an unterminated quoted field.");
  if (field || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows.at(-1)?.every((value) => value === "")) rows.pop();
  return rows;
}

function parseCsvCatalogue(text: string): ParsedCsv {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  if (!rows.length) throw new ConnectorError("malformed_catalogue", "The CSV catalogue is empty.");
  const columns = rows[0];
  if (!columns.length || columns.some((column) => !column)) {
    throw new ConnectorError("malformed_catalogue", "The CSV catalogue has an empty column name.");
  }
  if (new Set(columns).size !== columns.length) {
    throw new ConnectorError("malformed_catalogue", "The CSV catalogue has duplicate column names.");
  }
  const records = rows.slice(1).map((values, index) => {
    if (values.length !== columns.length) {
      throw new ConnectorError("malformed_catalogue", `CSV row ${index + 2} does not match the header column count.`);
    }
    return Object.fromEntries(columns.map((column, columnIndex) => [column, values[columnIndex]]));
  });
  return { records, columns };
}

function plainObject(value: unknown): value is CatalogueRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonRecordsAtPath(text: string, path: string): CatalogueRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ConnectorError("malformed_catalogue", "The JSON catalogue is not valid JSON.");
  }
  let selected = parsed;
  const cleanPath = path.trim();
  if (cleanPath) {
    for (const segment of cleanPath.split(".").filter(Boolean)) {
      if (!plainObject(selected) || !Object.prototype.hasOwnProperty.call(selected, segment)) {
        throw new ConnectorError("json_records_path_missing", `The JSON records path ${cleanPath} does not exist.`);
      }
      selected = selected[segment];
    }
  }
  if (!Array.isArray(selected) || !selected.every(plainObject)) {
    throw new ConnectorError("malformed_catalogue", "The selected JSON records value must be an array of objects.");
  }
  return selected.map((record) => ({ ...record }));
}

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as CatalogueRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
}

function keyedRecords(records: CatalogueRecord[], keyField: string, role: string): Map<string, CatalogueRecord> {
  const output = new Map<string, CatalogueRecord>();
  records.forEach((record, index) => {
    if (!Object.prototype.hasOwnProperty.call(record, keyField)) {
      throw new ConnectorError("record_key_missing", `${role} record ${index + 1} has no ${keyField} field.`);
    }
    const key = String(record[keyField] ?? "");
    if (!key) throw new ConnectorError("record_key_empty", `${role} record ${index + 1} has an empty stable key.`);
    if (output.has(key)) throw new ConnectorError("record_key_duplicate", `${role} stable record key ${key} occurs more than once.`);
    output.set(key, record);
  });
  return output;
}

export function validateCataloguePairBytes(
  csvText: string,
  jsonText: string,
  recordKeyField: string,
  jsonRecordsPath = "",
  expectedRecordCount?: number,
): CatalogueParityResult {
  if (!recordKeyField) throw new ConnectorError("record_key_required", "A stable record key field is required.");
  const csv = parseCsvCatalogue(csvText);
  const jsonRecords = jsonRecordsAtPath(jsonText, jsonRecordsPath);
  const csvByKey = keyedRecords(csv.records, recordKeyField, "CSV");
  const jsonByKey = keyedRecords(jsonRecords, recordKeyField, "JSON");
  if (expectedRecordCount !== undefined && (!Number.isInteger(expectedRecordCount) || expectedRecordCount < 0)) {
    throw new ConnectorError("invalid_expected_record_count", "expectedRecordCount must be a non-negative integer.");
  }
  if (expectedRecordCount !== undefined && (csvByKey.size !== expectedRecordCount || jsonByKey.size !== expectedRecordCount)) {
    throw new ConnectorError("record_count_mismatch", "The catalogue record count does not match expectedRecordCount.", {
      details: { expectedRecordCount, csvRecordCount: csvByKey.size, jsonRecordCount: jsonByKey.size },
    });
  }
  const csvKeys = [...csvByKey.keys()].sort();
  const jsonKeys = [...jsonByKey.keys()].sort();
  if (csvKeys.length !== jsonKeys.length || csvKeys.some((key, index) => key !== jsonKeys[index])) {
    throw new ConnectorError("catalogue_key_set_mismatch", "The CSV and JSON catalogue record-key sets are not identical.");
  }
  const jsonFields = new Set(jsonRecords.flatMap((record) => Object.keys(record)));
  const sharedFields = csv.columns.filter((field) => jsonFields.has(field)).sort();
  if (!sharedFields.includes(recordKeyField)) {
    throw new ConnectorError("record_key_not_shared", "The record key field must exist in both catalogue representations.");
  }
  for (const key of csvKeys) {
    const csvRecord = csvByKey.get(key)!;
    const jsonRecord = jsonByKey.get(key)!;
    for (const field of sharedFields) {
      if (canonicalValue(csvRecord[field]) !== canonicalValue(jsonRecord[field])) {
        throw new ConnectorError("catalogue_record_mismatch", `CSV and JSON differ for record ${key}, field ${field}.`, {
          details: { recordKey: key, field },
        });
      }
    }
  }
  return {
    recordCount: csvKeys.length,
    recordKeyField,
    sharedFields,
    identicalRecordKeySet: true,
    duplicateKeys: false,
    sharedFieldParity: true,
  };
}

function ambiguousGraphOutcome(error: ConnectorError): boolean {
  return AMBIGUOUS_GRAPH_CODES.has(error.code);
}

export async function coordinatePairReplacement<TFirst, TSecond>(
  replaceFirst: () => Promise<TFirst>,
  replaceSecond: () => Promise<TSecond>,
  rollbackFirst: (first: TFirst) => Promise<void>,
): Promise<{ first: TFirst; second: TSecond }> {
  let first: TFirst;
  try {
    first = await replaceFirst();
  } catch (error) {
    const firstError = asConnectorError(error);
    if (ambiguousGraphOutcome(firstError)) {
      throw new ConnectorError("catalogue_pair_ambiguous_first_write", "The first catalogue replacement had an ambiguous upstream outcome.", {
        retryable: false,
        details: { firstErrorCode: firstError.code },
      });
    }
    throw firstError;
  }
  try {
    const second = await replaceSecond();
    return { first, second };
  } catch (error) {
    const secondError = asConnectorError(error);
    try {
      await rollbackFirst(first);
    } catch (rollbackError) {
      const rollback = asConnectorError(rollbackError);
      throw new ConnectorError("catalogue_pair_ambiguous_rollback_failed", "The paired publication failed and the first-file rollback could not be verified.", {
        retryable: false,
        details: { secondErrorCode: secondError.code, rollbackErrorCode: rollback.code },
      });
    }
    const ambiguousSecond = ambiguousGraphOutcome(secondError);
    throw new ConnectorError(
      ambiguousSecond ? "catalogue_pair_ambiguous_second_write_first_rolled_back" : "catalogue_pair_second_write_failed_first_rolled_back",
      ambiguousSecond
        ? "The second replacement had an ambiguous upstream outcome; the first replacement was restored exactly."
        : "The second replacement failed; the first replacement was restored exactly.",
      { retryable: false, details: { secondErrorCode: secondError.code, firstRollbackVerified: true } },
    );
  }
}

async function restoreExactBytes(
  env: Env,
  userId: string,
  current: VerifiedItem,
  previousBytes: Uint8Array,
  previousHash: string,
  maximumBytes: number,
): Promise<void> {
  if (!current.item.eTag) throw new ConnectorError("etag_missing", "A current eTag is required for rollback.");
  const restored = await replaceExactTextBytes(env, userId, current, current.item.eTag, previousBytes);
  await verifyExactLiveBytes(env, userId, restored, previousBytes, previousHash, maximumBytes);
}

export async function validateCataloguePairFilesStrict(
  input: {
    csvFile: unknown;
    jsonFile: unknown;
    recordKeyField: string;
    jsonRecordsPath?: string;
    expectedRecordCount?: number;
    expectedCsvByteSize?: number;
    expectedCsvSha256?: string;
    expectedJsonByteSize?: number;
    expectedJsonSha256?: string;
  },
  maximumBytes = 4_194_304,
  fetchImpl: typeof fetch = fetch,
) {
  const [csvIncoming, jsonIncoming] = await Promise.all([
    loadConnectorTextFile(input.csvFile, "catalogue.csv", maximumBytes, input.expectedCsvSha256, input.expectedCsvByteSize, fetchImpl),
    loadConnectorTextFile(input.jsonFile, "catalogue.json", maximumBytes, input.expectedJsonSha256, input.expectedJsonByteSize, fetchImpl),
  ]);
  const parity = validateCataloguePairBytes(
    csvIncoming.text,
    jsonIncoming.text,
    input.recordKeyField,
    input.jsonRecordsPath ?? "",
    input.expectedRecordCount,
  );
  return {
    validationReceiptVersion: "odl-req-023-v1",
    files: {
      csv: { filename: csvIncoming.fileName, bytes: csvIncoming.byteLength, sha256: csvIncoming.sha256, declaredMimeType: csvIncoming.declaredMimeType, sourceMimeType: csvIncoming.sourceMimeType },
      json: { filename: jsonIncoming.fileName, bytes: jsonIncoming.byteLength, sha256: jsonIncoming.sha256, declaredMimeType: jsonIncoming.declaredMimeType, sourceMimeType: jsonIncoming.sourceMimeType },
    },
    parity,
    runtimeReferenceShape: { csv: csvIncoming.runtimeShape, json: jsonIncoming.runtimeShape },
    oneDriveCalled: false,
    mutationBegan: false,
  };
}

export async function replaceCataloguePairFromConnectorFilesStrict(
  env: Env,
  userId: string,
  input: {
    csvFile: unknown;
    jsonFile: unknown;
    csvItemId: string;
    jsonItemId: string;
    expectedCsvETag: string;
    expectedJsonETag: string;
    recordKeyField: string;
    jsonRecordsPath?: string;
    expectedRecordCount?: number;
  },
) {
  if (input.csvItemId === input.jsonItemId) {
    throw new ConnectorError("catalogue_pair_items_must_differ", "The CSV and JSON catalogue item IDs must identify different files.");
  }
  const config = getRuntimeConfig(env);
  const [csvInitial, jsonInitial] = await Promise.all([
    verifyItemInsideRoot(env, userId, input.csvItemId),
    verifyItemInsideRoot(env, userId, input.jsonItemId),
  ]);
  assertWritableTextItem(csvInitial);
  assertWritableTextItem(jsonInitial);
  if (!csvInitial.item.name.toLocaleLowerCase("en").endsWith(".csv")) {
    throw new ConnectorError("catalogue_csv_required", "csvItemId must identify an allowlisted CSV file.");
  }
  if (!jsonInitial.item.name.toLocaleLowerCase("en").endsWith(".json")) {
    throw new ConnectorError("catalogue_json_required", "jsonItemId must identify an allowlisted JSON file.");
  }

  const [csvIncoming, jsonIncoming] = await Promise.all([
    loadConnectorTextFile(input.csvFile, csvInitial.item.name, config.maxTextWriteBytes),
    loadConnectorTextFile(input.jsonFile, jsonInitial.item.name, config.maxTextWriteBytes),
  ]);
  const parity = validateCataloguePairBytes(
    csvIncoming.text,
    jsonIncoming.text,
    input.recordKeyField,
    input.jsonRecordsPath ?? "",
    input.expectedRecordCount,
  );

  requireExpectedETag(csvInitial, input.expectedCsvETag);
  requireExpectedETag(jsonInitial, input.expectedJsonETag);
  const [previousCsvBuffer, previousJsonBuffer] = await Promise.all([
    graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(csvInitial.item.id)}/content`, config.maxTextWriteBytes),
    graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(jsonInitial.item.id)}/content`, config.maxTextWriteBytes),
  ]);
  const previousCsv = new Uint8Array(previousCsvBuffer);
  const previousJson = new Uint8Array(previousJsonBuffer);
  const [previousCsvHash, previousJsonHash] = await Promise.all([
    sha256HexBytes(previousCsv),
    sha256HexBytes(previousJson),
  ]);

  const [csvReady, jsonReady] = await Promise.all([
    verifyItemInsideRoot(env, userId, input.csvItemId),
    verifyItemInsideRoot(env, userId, input.jsonItemId),
  ]);
  requireExpectedETag(csvReady, input.expectedCsvETag);
  requireExpectedETag(jsonReady, input.expectedJsonETag);

  const coordinated = await coordinatePairReplacement(
    () => replaceExactTextBytes(env, userId, csvReady, input.expectedCsvETag, csvIncoming.bytes),
    () => replaceExactTextBytes(env, userId, jsonReady, input.expectedJsonETag, jsonIncoming.bytes),
    async (csvReplaced) => {
      await restoreExactBytes(env, userId, csvReplaced, previousCsv, previousCsvHash, config.maxTextWriteBytes);
    },
  );

  try {
    const [csvVerification, jsonVerification] = await Promise.all([
      verifyExactLiveBytes(env, userId, coordinated.first, csvIncoming.bytes, csvIncoming.sha256, config.maxTextWriteBytes),
      verifyExactLiveBytes(env, userId, coordinated.second, jsonIncoming.bytes, jsonIncoming.sha256, config.maxTextWriteBytes),
    ]);
    const readBackParity = validateCataloguePairBytes(
      decodeStrictUtf8(csvVerification.bytes),
      decodeStrictUtf8(jsonVerification.bytes),
      input.recordKeyField,
      input.jsonRecordsPath ?? "",
      input.expectedRecordCount,
    );
    return {
      csv: publicationResult(csvVerification, input.expectedCsvETag),
      json: publicationResult(jsonVerification, input.expectedJsonETag),
      parity: readBackParity,
      preflightParity: parity,
      coordinatedOperation: true,
      rollbackRequired: false,
    };
  } catch (postconditionError) {
    const failure = asConnectorError(postconditionError);
    try {
      const [currentJson, currentCsv] = await Promise.all([
        verifyItemInsideRoot(env, userId, input.jsonItemId),
        verifyItemInsideRoot(env, userId, input.csvItemId),
      ]);
      await restoreExactBytes(env, userId, currentJson, previousJson, previousJsonHash, config.maxTextWriteBytes);
      await restoreExactBytes(env, userId, currentCsv, previousCsv, previousCsvHash, config.maxTextWriteBytes);
      logSafeError("catalogue_pair_postcondition_failed_rolled_back", failure);
      throw new ConnectorError("catalogue_pair_postcondition_failed_rolled_back", "The paired publication postcondition failed; both previous files were restored exactly.", {
        retryable: false,
        details: { postconditionErrorCode: failure.code, rollbackVerified: true },
      });
    } catch (rollbackError) {
      if (rollbackError instanceof ConnectorError && rollbackError.code === "catalogue_pair_postcondition_failed_rolled_back") throw rollbackError;
      const rollback = asConnectorError(rollbackError);
      logSafeError("catalogue_pair_postcondition_rollback_failed", rollback, { postconditionErrorCode: failure.code });
      throw new ConnectorError("catalogue_pair_ambiguous_postcondition_rollback_failed", "The paired publication postcondition failed and exact rollback of both files could not be verified.", {
        retryable: false,
        details: { postconditionErrorCode: failure.code, rollbackErrorCode: rollback.code },
      });
    }
  }
}

export function registerFileBackedTextTools(server: McpServer, contextFactory: () => FileBackedContext): void {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const mutating = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  } as const;

  server.registerTool("create_text_file_from_file", {
    title: "Create exact UTF-8 text file from mounted file",
    description: "Create one allowlisted UTF-8 file from a top-level mounted ChatGPT workspace file. Exact submitted bytes are hashed, uploaded without normalization, and read back for verification. Filename conflicts fail.",
    inputSchema: {
      file: connectorFileInputSchema,
      destinationPath: z.string().max(1000).default(""),
      filename: z.string().min(1).max(255),
      expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    },
    annotations: mutating,
    _meta: { "openai/fileParams": ["file"] },
  }, async (input: any) => {
    const context = contextFactory();
    try {
      return textResult(await createTextFileFromConnectorFileStrict(context.env, context.userId, input.file, input.destinationPath, input.filename, input.expectedSha256));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("replace_text_file_from_file", {
    title: "Replace exact UTF-8 text file from mounted file",
    description: "Replace one allowlisted UTF-8 file from a top-level mounted ChatGPT workspace file only when expectedETag exactly matches. Exact submitted bytes are preserved and read back for verification.",
    inputSchema: {
      file: connectorFileInputSchema,
      itemId: z.string().min(1).max(500),
      expectedETag: z.string().min(1).max(1000),
      expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    },
    annotations: mutating,
    _meta: { "openai/fileParams": ["file"] },
  }, async (input: any) => {
    const context = contextFactory();
    try {
      return textResult(await replaceTextFileFromConnectorFileStrict(context.env, context.userId, input.file, input.itemId, input.expectedETag, input.expectedSha256));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("validate_catalogue_pair_files", {
    title: "Validate CSV and JSON connector files",
    description: "Resolve and validate a ChatGPT-authorized CSV/JSON catalogue pair without reading or mutating OneDrive.",
    inputSchema: {
      csvFile: connectorFileInputSchema,
      jsonFile: connectorFileInputSchema,
      recordKeyField: z.string().min(1).max(200),
      jsonRecordsPath: z.string().max(1000).default(""),
      expectedRecordCount: z.number().int().min(0).optional(),
      expectedCsvByteSize: z.number().int().min(0).optional(),
      expectedCsvSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
      expectedJsonByteSize: z.number().int().min(0).optional(),
      expectedJsonSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    },
    annotations: readOnly,
    _meta: { "openai/fileParams": ["csvFile", "jsonFile"] },
  }, async (input: any) => {
    const context = contextFactory();
    try {
      const config = getRuntimeConfig(context.env);
      return textResult(await validateCataloguePairFilesStrict(input, config.maxTextWriteBytes));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("replace_catalogue_pair_from_files", {
    title: "Publish exact CSV and JSON catalogue files",
    description: "Validate and publish a mounted CSV/JSON catalogue pair as full files. Supports a JSON array or an object records path, checks stable-key parity before mutation, confirms both eTags, rolls back the first replacement if the second fails, and verifies both read-backs.",
    inputSchema: {
      csvFile: connectorFileInputSchema,
      jsonFile: connectorFileInputSchema,
      csvItemId: z.string().min(1).max(500),
      jsonItemId: z.string().min(1).max(500),
      expectedCsvETag: z.string().min(1).max(1000),
      expectedJsonETag: z.string().min(1).max(1000),
      recordKeyField: z.string().min(1).max(200),
      jsonRecordsPath: z.string().max(1000).default(""),
      expectedRecordCount: z.number().int().min(0).optional(),
    },
    annotations: mutating,
    _meta: { "openai/fileParams": ["csvFile", "jsonFile"] },
  }, async (input: any) => {
    const context = contextFactory();
    try {
      return textResult(await replaceCataloguePairFromConnectorFilesStrict(context.env, context.userId, input));
    } catch (error) { return errorResult(error); }
  });
}
