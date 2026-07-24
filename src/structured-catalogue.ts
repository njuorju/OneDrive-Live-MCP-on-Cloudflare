import { ConnectorError } from "./errors";
import { canonicalJson } from "./paid-core";

const MAX_PATCHES = 500;
const MAX_PREVIEW_CHARACTERS = 10_000;

export type StructuredFormat = "csv" | "json";
export type CatalogueRecord = Record<string, unknown>;

export type StructuredPatch = {
  recordKey: string;
  expected?: CatalogueRecord;
  set?: CatalogueRecord;
  clear?: string[];
  appendNote?: { field: string; note: string; separator?: string };
};

export type FieldDiff = { recordKey: string; field: string; before: unknown; after: unknown };
export type PreparedStructuredResult = {
  format: StructuredFormat;
  bytes: Uint8Array;
  records: CatalogueRecord[];
  columns: string[];
  diffs: FieldDiff[];
  sourceRecordCount: number;
  outputRecordCount: number;
  preview: string;
};

function plainObject(value: unknown): value is CatalogueRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function own(record: CatalogueRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function scalarToCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) return String(value);
  throw new ConnectorError("csv_non_scalar_value", "CSV catalogue fields only support scalar values.");
}
function patchValue(format: StructuredFormat, value: unknown): unknown {
  return format === "csv" ? scalarToCsv(value) : value;
}

export function decodeUtf8PreservingBom(bytes: Uint8Array): { text: string; bom: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes), bom };
  } catch {
    throw new ConnectorError("structured_text_not_utf8", "The selected catalogue is not valid UTF-8.");
  }
}
function encodeUtf8(text: string, bom: boolean): Uint8Array {
  const payload = new TextEncoder().encode(text);
  if (!bom) return payload;
  const output = new Uint8Array(payload.length + 3);
  output.set([0xef, 0xbb, 0xbf]);
  output.set(payload, 3);
  return output;
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
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function parseCsv(text: string) {
  const rows = parseCsvRows(text);
  if (!rows.length) throw new ConnectorError("malformed_catalogue", "The CSV catalogue is empty.");
  const columns = rows[0];
  if (!columns.length || columns.some((column) => !column)) throw new ConnectorError("malformed_catalogue", "The CSV catalogue has an empty column name.");
  if (new Set(columns).size !== columns.length) throw new ConnectorError("malformed_catalogue", "The CSV catalogue has duplicate column names.");
  const records = rows.slice(1).map((values, index) => {
    if (values.length !== columns.length) throw new ConnectorError("malformed_catalogue", `CSV row ${index + 2} does not match the header column count.`);
    return Object.fromEntries(columns.map((column, columnIndex) => [column, values[columnIndex]]));
  });
  return { records, columns, lineEnding: text.includes("\r\n") ? "\r\n" : "\n", trailingNewline: /(?:\r\n|\n|\r)$/.test(text) };
}
function serializeCsv(records: CatalogueRecord[], columns: string[], lineEnding: string, trailingNewline: boolean): string {
  const rows = [columns, ...records.map((record) => columns.map((column) => scalarToCsv(record[column])))];
  const text = rows.map((row) => row.map(csvCell).join(",")).join(lineEnding);
  return trailingNewline ? `${text}${lineEnding}` : text;
}
function parseJson(text: string): { records: CatalogueRecord[]; columns: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ConnectorError("malformed_catalogue", "The JSON catalogue is not valid JSON."); }
  if (!Array.isArray(parsed) || !parsed.every(plainObject)) throw new ConnectorError("malformed_catalogue", "The JSON catalogue must be an array of objects.");
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const record of parsed) for (const field of Object.keys(record)) if (!seen.has(field)) { seen.add(field); columns.push(field); }
  return { records: parsed.map((record) => ({ ...record })), columns };
}

function assertKeys(records: CatalogueRecord[], recordKeyField: string): void {
  const keys = new Set<string>();
  records.forEach((record, index) => {
    if (!own(record, recordKeyField)) throw new ConnectorError("record_key_missing", `Catalogue record ${index + 1} has no ${recordKeyField} field.`);
    const key = String(record[recordKeyField] ?? "");
    if (!key) throw new ConnectorError("record_key_empty", `Catalogue record ${index + 1} has an empty stable key.`);
    if (keys.has(key)) throw new ConnectorError("record_key_duplicate", `Stable record key ${key} occurs more than once.`);
    keys.add(key);
  });
}
function applyPatches(records: CatalogueRecord[], columns: string[], format: StructuredFormat, recordKeyField: string, patches: StructuredPatch[]): FieldDiff[] {
  assertKeys(records, recordKeyField);
  const byKey = new Map(records.map((record) => [String(record[recordKeyField]), record]));
  const original = new Map(records.map((record) => [String(record[recordKeyField]), { ...record }]));
  const touched = new Map<string, Set<string>>();
  for (const patch of patches) {
    const key = String(patch.recordKey);
    const record = byKey.get(key);
    if (!record) throw new ConnectorError("record_not_found", `No catalogue record has stable key ${key}.`);
    const fields = touched.get(key) ?? new Set<string>();
    touched.set(key, fields);
    for (const [field, expected] of Object.entries(patch.expected ?? {})) {
      if (!own(record, field)) throw new ConnectorError("expected_field_missing", `Expected field ${field} is absent on record ${key}.`);
      if (!equal(record[field], patchValue(format, expected))) throw new ConnectorError("stale_expected_value", `Record ${key} field ${field} no longer has the expected value.`);
    }
    for (const [field, value] of Object.entries(patch.set ?? {})) {
      if (!own(record, field) || (format === "csv" && !columns.includes(field))) throw new ConnectorError("patch_field_missing", `Field ${field} does not exist on record ${key}; preparation does not add schema columns.`);
      record[field] = patchValue(format, value); fields.add(field);
    }
    for (const field of patch.clear ?? []) {
      if (!own(record, field) || (format === "csv" && !columns.includes(field))) throw new ConnectorError("patch_field_missing", `Field ${field} does not exist on record ${key}.`);
      record[field] = format === "csv" ? "" : null; fields.add(field);
    }
    if (patch.appendNote) {
      const { field, note } = patch.appendNote;
      if (!note) throw new ConnectorError("empty_note", "An appended note must not be empty.");
      if (!own(record, field) || (format === "csv" && !columns.includes(field))) throw new ConnectorError("patch_field_missing", `Note field ${field} does not exist on record ${key}.`);
      const current = record[field] == null ? "" : String(record[field]);
      if (!current.includes(note)) record[field] = current ? `${current}${patch.appendNote.separator ?? "\n"}${note}` : note;
      fields.add(field);
    }
  }
  const diffs: FieldDiff[] = [];
  for (const [key, fields] of touched) {
    const before = original.get(key)!;
    const after = byKey.get(key)!;
    for (const field of [...fields].sort()) if (!equal(before[field], after[field])) diffs.push({ recordKey: key, field, before: before[field] ?? null, after: after[field] ?? null });
  }
  return diffs;
}
function preview(text: string, diffs: FieldDiff[], characters: number): string {
  const bounded = Math.min(Math.max(characters, 0), MAX_PREVIEW_CHARACTERS);
  return JSON.stringify({ diffs: diffs.slice(0, 50), outputPrefix: text.slice(0, bounded), truncated: text.length > bounded }, null, 2);
}

export function applyStructuredPatchText(sourceBytes: Uint8Array, format: StructuredFormat, recordKeyField: string, patches: StructuredPatch[], previewCharacters = 2_000): PreparedStructuredResult {
  if (!recordKeyField) throw new ConnectorError("record_key_required", "A stable record key field is required.");
  if (!patches.length || patches.length > MAX_PATCHES) throw new ConnectorError("patch_count_invalid", "Provide between 1 and 500 structured patches.");
  const decoded = decodeUtf8PreservingBom(sourceBytes);
  if (format === "csv") {
    const parsed = parseCsv(decoded.text);
    const records = parsed.records.map((record) => ({ ...record }));
    const diffs = applyPatches(records, parsed.columns, format, recordKeyField, patches);
    const text = serializeCsv(records, parsed.columns, parsed.lineEnding, parsed.trailingNewline);
    return { format, bytes: encodeUtf8(text, decoded.bom), records, columns: [...parsed.columns], diffs, sourceRecordCount: parsed.records.length, outputRecordCount: records.length, preview: preview(text, diffs, previewCharacters) };
  }
  const parsed = parseJson(decoded.text);
  const records = parsed.records.map((record) => ({ ...record }));
  const diffs = applyPatches(records, parsed.columns, format, recordKeyField, patches);
  const text = `${JSON.stringify(records, null, 2)}\n`;
  return { format, bytes: encodeUtf8(text, decoded.bom), records, columns: [...parsed.columns], diffs, sourceRecordCount: parsed.records.length, outputRecordCount: records.length, preview: preview(text, diffs, previewCharacters) };
}
function semanticValue(value: unknown): string {
  if (value == null) return "";
  return typeof value === "object" ? canonicalJson(value) : String(value);
}
export function semanticCatalogueDigest(records: CatalogueRecord[], recordKeyField: string): string {
  const fields = [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
  const normalized = records.map((record) => Object.fromEntries(fields.map((field) => [field, semanticValue(record[field])])));
  return canonicalJson({ recordKeyField, fields, records: normalized });
}
export function verifyCataloguePairParity(csvRecords: CatalogueRecord[], jsonRecords: CatalogueRecord[], recordKeyField: string): string {
  assertKeys(csvRecords, recordKeyField); assertKeys(jsonRecords, recordKeyField);
  const csv = semanticCatalogueDigest(csvRecords, recordKeyField);
  if (csv !== semanticCatalogueDigest(jsonRecords, recordKeyField)) throw new ConnectorError("catalogue_semantic_mismatch", "The prepared CSV and JSON catalogues are not semantically equivalent.");
  return csv;
}
export function assertExpectedETag(expected: string | undefined, actualValue: string | undefined | null): string {
  const actual = String(actualValue ?? "");
  if (!actual) throw new ConnectorError("etag_missing", "The selected source has no current eTag.");
  if (expected && expected !== actual) throw new ConnectorError("etag_conflict", "The selected source eTag changed before preparation.");
  return actual;
}
export function preparedContent(bytes: Uint8Array): string {
  const decoded = decodeUtf8PreservingBom(bytes);
  return decoded.bom ? `\uFEFF${decoded.text}` : decoded.text;
}
