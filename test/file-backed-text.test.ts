import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ConnectorError } from "../src/errors";
import {
  connectorFileInputSchema,
  coordinatePairReplacement,
  loadConnectorTextFile,
  sha256HexBytes,
  trustedConnectorFileUrl,
  validateCataloguePairBytes,
} from "../src/file-backed-text";

const connectorReference = { download_url: "https://oaisdmntprindiasocentral.blob.core.windows.net/connector/fixture", file_id: "file_fixture" };

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function responseFor(bytes: Uint8Array, contentType = "text/plain"): typeof fetch {
  return (async (..._args: Parameters<typeof fetch>) => new Response(arrayBuffer(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
    },
  })) as typeof fetch;
}

test("file inputs use the supported ChatGPT connector-file object schema", () => {
  const schema = z.toJSONSchema(connectorFileInputSchema) as any;
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["download_url", "file_id"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["download_url", "file_id", "file_name", "mime_type", "size"]);
  assert.equal(schema.additionalProperties, false);
});

test("only OpenAI and ChatGPT connector file references are accepted", () => {
  assert.equal(trustedConnectorFileUrl(connectorReference.download_url).hostname, "oaisdmntprindiasocentral.blob.core.windows.net");
  assert.throws(
    () => trustedConnectorFileUrl("https://example.com/catalogue.csv"),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_download_forbidden",
  );
  assert.throws(
    () => trustedConnectorFileUrl("/mnt/data/catalogue.csv"),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_reference_malformed",
  );
});

test("mounted UTF-8 bytes, BOM, CRLF and terminal newline remain exact", async () => {
  const bytes = Uint8Array.from([
    0xef, 0xbb, 0xbf,
    ...new TextEncoder().encode("id,name\r\n1,Нарын\r\n"),
  ]);
  const loaded = await loadConnectorTextFile(
    connectorReference,
    "fixture.csv",
    4_194_304,
    undefined,
    responseFor(bytes),
  );
  assert.deepEqual(loaded.bytes, bytes);
  assert.equal(loaded.byteLength, bytes.byteLength);
  assert.equal(loaded.sha256, await sha256HexBytes(bytes));
});

test("expected SHA-256 is checked before publication", async () => {
  const bytes = new TextEncoder().encode("id,name\n1,A\n");
  await assert.rejects(
    () => loadConnectorTextFile(connectorReference, "fixture.csv", 1024, "0".repeat(64), responseFor(bytes)),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_hash_mismatch",
  );
});

test("malformed UTF-8 is rejected", async () => {
  const bytes = Uint8Array.from([0xc3, 0x28]);
  await assert.rejects(
    () => loadConnectorTextFile(connectorReference, "fixture.txt", 1024, undefined, responseFor(bytes)),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_content_invalid",
  );
});

test("binary control bytes are rejected", async () => {
  const bytes = Uint8Array.from([0x41, 0x00, 0x42]);
  await assert.rejects(
    () => loadConnectorTextFile(connectorReference, "fixture.txt", 1024, undefined, responseFor(bytes)),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_content_invalid",
  );
});

test("files over the configured text limit fail before mutation", async () => {
  const bytes = new TextEncoder().encode("12345");
  await assert.rejects(
    () => loadConnectorTextFile(connectorReference, "fixture.txt", 4, undefined, responseFor(bytes)),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_too_large",
  );
});

test("unsupported destination extensions fail before retrieval", async () => {
  const bytes = new TextEncoder().encode("text");
  await assert.rejects(
    () => loadConnectorTextFile(connectorReference, "fixture.exe", 1024, undefined, responseFor(bytes)),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_content_invalid",
  );
});

test("catalogue parity supports a JSON record array", () => {
  const result = validateCataloguePairBytes(
    "id,name,count\n1,A,2\n2,B,3\n",
    JSON.stringify([{ id: "1", name: "A", count: 2 }, { id: "2", name: "B", count: 3 }]),
    "id",
    "",
    2,
  );
  assert.equal(result.recordCount, 2);
  assert.deepEqual(result.sharedFields, ["count", "id", "name"]);
  assert.equal(result.sharedFieldParity, true);
});

test("catalogue parity supports an object records path", () => {
  const result = validateCataloguePairBytes(
    "id,name\n1,A\n",
    JSON.stringify({ schema: { version: 1 }, records: [{ id: "1", name: "A" }] }),
    "id",
    "records",
    1,
  );
  assert.equal(result.recordCount, 1);
  assert.deepEqual(result.sharedFields, ["id", "name"]);
});

test("mismatched key sets, duplicate keys and shared-field differences fail", () => {
  assert.throws(
    () => validateCataloguePairBytes("id,name\n1,A\n", JSON.stringify([{ id: "2", name: "A" }]), "id"),
    (error: unknown) => error instanceof ConnectorError && error.code === "catalogue_key_set_mismatch",
  );
  assert.throws(
    () => validateCataloguePairBytes("id,name\n1,A\n1,B\n", JSON.stringify([{ id: "1", name: "A" }]), "id"),
    (error: unknown) => error instanceof ConnectorError && error.code === "record_key_duplicate",
  );
  assert.throws(
    () => validateCataloguePairBytes("id,name\n1,A\n", JSON.stringify([{ id: "1", name: "B" }]), "id"),
    (error: unknown) => error instanceof ConnectorError && error.code === "catalogue_record_mismatch",
  );
});

test("expected record count is enforced", () => {
  assert.throws(
    () => validateCataloguePairBytes("id,name\n1,A\n", JSON.stringify([{ id: "1", name: "A" }]), "id", "", 2),
    (error: unknown) => error instanceof ConnectorError && error.code === "record_count_mismatch",
  );
});

test("integration: a deterministic second-write failure restores the first state", async () => {
  const state = { csv: "old-csv", json: "old-json" };
  await assert.rejects(
    () => coordinatePairReplacement(
      async () => { state.csv = "new-csv"; return { eTag: "csv-new" }; },
      async () => { throw new ConnectorError("etag_conflict", "stale"); },
      async () => { state.csv = "old-csv"; },
    ),
    (error: unknown) => error instanceof ConnectorError && error.code === "catalogue_pair_second_write_failed_first_rolled_back",
  );
  assert.deepEqual(state, { csv: "old-csv", json: "old-json" });
});

test("integration: ambiguous second-write outcome is explicit after first rollback", async () => {
  let first = "old";
  await assert.rejects(
    () => coordinatePairReplacement(
      async () => { first = "new"; return "first"; },
      async () => { throw new ConnectorError("graph_network_error", "ambiguous"); },
      async () => { first = "old"; },
    ),
    (error: unknown) => error instanceof ConnectorError && error.code === "catalogue_pair_ambiguous_second_write_first_rolled_back",
  );
  assert.equal(first, "old");
});

test("integration: rollback failure is reported as ambiguous", async () => {
  await assert.rejects(
    () => coordinatePairReplacement(
      async () => "first",
      async () => { throw new ConnectorError("etag_conflict", "second failed"); },
      async () => { throw new ConnectorError("etag_conflict", "rollback stale"); },
    ),
    (error: unknown) => error instanceof ConnectorError && error.code === "catalogue_pair_ambiguous_rollback_failed",
  );
});
