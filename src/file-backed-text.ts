import { getRuntimeConfig } from "./config";
import { asConnectorError, ConnectorError, logSafeError } from "./errors";
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

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONNECTOR_FILE_HOSTS = [
  "openai.com",
  "chatgpt.com",
  "openaiusercontent.com",
  "oaiusercontent.com",
] as const;

export type LoadedConnectorTextFile = {
  bytes: Uint8Array;
  text: string;
  byteLength: number;
  sha256: string;
  sourceMimeType: string | null;
};

type CatalogueRecord = Record<string, unknown>;

type ParsedCsv = {
  records: CatalogueRecord[];
  columns: string[];
};

export type CatalogueParityResult = {
  recordCount: number;
  recordKeyField: string;
  sharedFields: string[];
  identicalRecordKeySet: true;
  duplicateKeys: false;
  sharedFieldParity: true;
};

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectedSha256(value?: string): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLocaleLowerCase("en");
  if (!SHA256_PATTERN.test(normalized)) {
    throw new ConnectorError("invalid_expected_sha256", "expectedSha256 must be a lowercase or uppercase 64-character SHA-256 hex digest.");
  }
  return normalized;
}

function trustedConnectorFileUrl(reference: string): URL {
  if (!reference || reference.length > 20_000) {
    throw new ConnectorError("invalid_connector_file", "The connector file reference is missing or too long.");
  }
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new ConnectorError("invalid_connector_file", "The file input was not resolved to a connector file reference.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ConnectorError("untrusted_connector_file", "Only HTTPS connector file references are accepted.");
  }
  const host = url.hostname.toLocaleLowerCase("en");
  const trusted = CONNECTOR_FILE_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!trusted) {
    throw new ConnectorError("untrusted_connector_file", "The file input is not an OpenAI/ChatGPT connector file reference.");
  }
  return url;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new ConnectorError("text_too_large", "The connector file exceeds the existing text write limit.");
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) throw new ConnectorError("text_too_large", "The connector file exceeds the existing text write limit.");
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ConnectorError("text_too_large", "The connector file exceeds the existing text write limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConnectorError("text_not_utf8", "The connector file is not valid UTF-8.");
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      throw new ConnectorError("binary_file_rejected", "The connector file contains binary or disallowed control bytes.");
    }
  }
  return text;
}

export async function loadConnectorTextFile(
  fileReference: string,
  filename: string,
  maximumBytes: number,
  suppliedExpectedSha256?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedConnectorTextFile> {
  const safeName = validateItemName(filename);
  if (!isAllowedTextFile(safeName)) {
    throw new ConnectorError("unsupported_text_extension", "The filename extension is not allowlisted for text publication.");
  }
  const url = trustedConnectorFileUrl(fileReference);
  let response: Response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "text/plain, text/csv, application/json, application/octet-stream" },
    });
  } catch {
    throw new ConnectorError("connector_file_unreachable", "The connector file could not be retrieved.", { retryable: true });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConnectorError("connector_file_unavailable", "The connector file could not be retrieved.", {
      retryable: response.status >= 500,
      status: response.status,
    });
  }
  const bytes = await readBoundedResponse(response, maximumBytes);
  const sourceMimeType = response.headers.get("content-type");
  const signature = validateFileSignature(safeName, bytesBuffer(bytes), sourceMimeType);
  if (!signature.compatible) {
    throw new ConnectorError("binary_file_rejected", "The connector file does not match the requested allowlisted UTF-8 text type.", {
      details: { detected: signature.detected, reason: signature.reason ?? null },
    });
  }
  const text = decodeStrictUtf8(bytes);
  const sha256 = await sha256HexBytes(bytes);
  const expected = expectedSha256(suppliedExpectedSha256);
  if (expected && expected !== sha256) {
    throw new ConnectorError("sha256_mismatch", "The connector file SHA-256 does not match expectedSha256.", {
      details: { expectedSha256: expected, actualSha256: sha256 },
    });
  }
  return { bytes, text, byteLength: bytes.byteLength, sha256, sourceMimeType };
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

async function putCreatedBytes(
  env: Env,
  userId: string,
  destination: VerifiedItem,
  filename: string,
  bytes: Uint8Array,
): Promise<VerifiedItem> {
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
      body: bytesBuffer(bytes),
    },
  );
  if (!created.id) throw new ConnectorError("mutation_result_invalid", "Microsoft Graph returned an invalid created item.");
  return verifyItemInsideRoot(env, userId, created.id);
}

async function putReplacementBytes(
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
      body: bytesBuffer(bytes),
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
): Promise<{ item: VerifiedItem; byteLength: number; sha256: string; verified: true; exactBytes: true }> {
  const current = await verifyItemInsideRoot(env, userId, item.item.id);
  const readBack = new Uint8Array(await graphFetchBytes(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(current.item.id)}/content`,
    expectedBytes.byteLength + 1,
  ));
  const hash = await sha256HexBytes(readBack);
  if (readBack.byteLength !== expectedBytes.byteLength || hash !== expectedHash) {
    throw new ConnectorError("write_verification_failed", "The OneDrive read-back did not match the submitted exact bytes.", {
      details: {
        expectedByteLength: expectedBytes.byteLength,
        actualByteLength: readBack.byteLength,
        expectedSha256: expectedHash,
        actualSha256: hash,
      },
    });
  }
  return { item: current, byteLength: readBack.byteLength, sha256: hash, verified: true, exactBytes: true };
}

function publicationResult(
  item: VerifiedItem,
  byteLength: number,
  sha256: string,
  previousETag?: string,
) {
  const compact = compactVerifiedItem(item);
  return {
    itemId: compact.itemId,
    path: compact.relativePath,
    filename: compact.filename,
    ...(previousETag ? { previousETag } : {}),
    ...(previousETag ? { newETag: compact.eTag } : { eTag: compact.eTag }),
    byteLength,
    sha256,
    mimeType: compact.mimeType,
    verification: { verified: true, exactBytes: true, readBackByteLength: byteLength, readBackSha256: sha256 },
  };
}

export async function createTextFileFromConnectorFileStrict(
  env: Env,
  userId: string,
  fileReference: string,
  destinationPath: string,
  filename: string,
  suppliedExpectedSha256?: string,
) {
  const config = getRuntimeConfig(env);
  const safeName = validateItemName(filename);
  const loaded = await loadConnectorTextFile(fileReference, safeName, config.maxTextWriteBytes, suppliedExpectedSha256);
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  const created = await putCreatedBytes(env, userId, destination, safeName, loaded.bytes);
  const verified = await verifyExactLiveBytes(env, userId, created, loaded.bytes, loaded.sha256);
  return publicationResult(verified.item, verified.byteLength, verified.sha256);
}

export async function replaceTextFileFromConnectorFileStrict(
  env: Env,
  userId: string,
  fileReference: string,
  itemId: string,
  expectedETag: string,
  suppliedExpectedSha256?: string,
) {
  const config = getRuntimeConfig(env);
  const source = await verifyItemInsideRoot(env, userId, itemId);
  assertWritableTextItem(source);
  requireExpectedETag(source, expectedETag);
  const loaded = await loadConnectorTextFile(fileReference, source.item.name, config.maxTextWriteBytes, suppliedExpectedSha256);
  const replaced = await putReplacementBytes(env, userId, source, expectedETag, loaded.bytes);
  const verified = await verifyExactLiveBytes(env, userId, replaced, loaded.bytes, loaded.sha256);
  return publicationResult(verified.item, verified.byteLength, verified.sha256, expectedETag);
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
  if (!columns.length || columns.some((column) => !column)) throw new ConnectorError("malformed_catalogue", "The CSV catalogue has an empty column name.");
  if (new Set(columns).size !== columns.length) throw new ConnectorError("malformed_catalogue", "The CSV catalogue has duplicate column names.");
  const records = rows.slice(1).map((values, index) => {
    if (values.length !== columns.length) throw new ConnectorError("malformed_catalogue", `CSV row ${index + 2} does not match the header column count.`);
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
  return `{${Object.keys(value as CatalogueRecord).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue((value as CatalogueRecord)[key])}`).join(",")}}`;
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

export async function replaceCataloguePairFromConnectorFilesStrict(
  env: Env,
  userId: string,
  input: {
    csvFile: string;
    jsonFile: string;
    csvItemId: string;
    jsonItemId: string;
    expectedCsvETag: string;
    expectedJsonETag: string;
    recordKeyField: string;
    jsonRecordsPath?: string;
    expectedRecordCount?: number;
  },
) {
  const config = getRuntimeConfig(env);
  const csvSource = await verifyItemInsideRoot(env, userId, input.csvItemId);
  const jsonSource = await verifyItemInsideRoot(env, userId, input.jsonItemId);
  assertWritableTextItem(csvSource);
  assertWritableTextItem(jsonSource);
  if (!csvSource.item.name.toLocaleLowerCase("en").endsWith(".csv")) throw new ConnectorError("catalogue_csv_required", "csvItemId must identify an allowlisted CSV file.");
  if (!jsonSource.item.name.toLocaleLowerCase("en").endsWith(".json")) throw new ConnectorError("catalogue_json_required", "jsonItemId must identify an allowlisted JSON file.");

  const [csvIncoming, jsonIncoming] = await Promise.all([
    loadConnectorTextFile(input.csvFile, csvSource.item.name, config.maxTextWriteBytes),
    loadConnectorTextFile(input.jsonFile, jsonSource.item.name, config.maxTextWriteBytes),
  ]);
  const parity = validateCataloguePairBytes(
    csvIncoming.text,
    jsonIncoming.text,
    input.recordKeyField,
    input.jsonRecordsPath ?? "",
    input.expectedRecordCount,
  );

  requireExpectedETag(csvSource, input.expectedCsvETag);
  requireExpectedETag(jsonSource, input.expectedJsonETag);
  const [previousCsvBuffer, previousJsonBuffer] = await Promise.all([
    graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(csvSource.item.id)}/content`, config.maxTextWriteBytes),
    graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(jsonSource.item.id)}/content`, config.maxTextWriteBytes),
  ]);
  const previousCsv = new Uint8Array(previousCsvBuffer);
  const previousJson = new Uint8Array(previousJsonBuffer);
  const previousCsvHash = await sha256HexBytes(previousCsv);
  const previousJsonHash = await sha256HexBytes(previousJson);

  let csvReplaced: VerifiedItem | null = null;
  try {
    csvReplaced = await putReplacementBytes(env, userId, csvSource, input.expectedCsvETag, csvIncoming.bytes);
    const jsonReplaced = await putReplacementBytes(env, userId, jsonSource, input.expectedJsonETag, jsonIncoming.bytes);
    const [csvVerified, jsonVerified] = await Promise.all([
      verifyExactLiveBytes(env, userId, csvReplaced, csvIncoming.bytes, csvIncoming.sha256),
      verifyExactLiveBytes(env, userId, jsonReplaced, jsonIncoming.bytes, jsonIncoming.sha256),
    ]);
    const readBackCsv = new TextDecoder("utf-8", { fatal: true }).decode(csvIncoming.bytes);
    const readBackJson = new TextDecoder("utf-8", { fatal: true }).decode(jsonIncoming.bytes);
    const readBackParity = validateCataloguePairBytes(readBackCsv, readBackJson, input.recordKeyField, input.jsonRecordsPath ?? "", input.expectedRecordCount);
    return {
      csv: publicationResult(csvVerified.item, csvVerified.byteLength, csvVerified.sha256, input.expectedCsvETag),
      json: publicationResult(jsonVerified.item, jsonVerified.byteLength, jsonVerified.sha256, input.expectedJsonETag),
      parity: readBackParity,
      coordinatedOperation: true,
      rollbackRequired: false,
    };
  } catch (error) {
    if (!csvReplaced?.item.eTag) throw error;
    const second = asConnectorError(error);
    try {
      const currentCsv = await verifyItemInsideRoot(env, userId, csvSource.item.id);
      const rolledBack = await putReplacementBytes(env, userId, currentCsv, csvReplaced.item.eTag, previousCsv);
      await verifyExactLiveBytes(env, userId, rolledBack, previousCsv, previousCsvHash);
      logSafeError("catalogue_pair_second_write_failed_first_rolled_back", second, {
        csvItemId: csvSource.item.id,
        jsonItemId: jsonSource.item.id,
        previousJsonSha256: previousJsonHash,
      });
      const ambiguousSecond = ["graph_network_error", "graph_timeout", "graph_unreachable", "graph_server_error"].includes(second.code);
      throw new ConnectorError(
        ambiguousSecond ? "catalogue_pair_ambiguous_second_write_first_rolled_back" : "catalogue_pair_second_write_failed_first_rolled_back",
        ambiguousSecond
          ? "The second replacement had an ambiguous upstream outcome; the first replacement was restored exactly."
          : "The second replacement failed; the first replacement was restored exactly.",
        {
          retryable: false,
          details: {
            secondErrorCode: second.code,
            firstRollbackVerified: true,
            previousCsvSha256: previousCsvHash,
            previousJsonSha256: previousJsonHash,
          },
        },
      );
    } catch (rollbackError) {
      if (rollbackError instanceof ConnectorError && rollbackError.code.startsWith("catalogue_pair_")) throw rollbackError;
      const rollback = asConnectorError(rollbackError);
      logSafeError("catalogue_pair_rollback_failed", rollback, { secondErrorCode: second.code });
      throw new ConnectorError("catalogue_pair_ambiguous_rollback_failed", "The paired publication failed and the first-file rollback could not be verified.", {
        retryable: false,
        details: { secondErrorCode: second.code, rollbackErrorCode: rollback.code },
      });
    }
  }
}
