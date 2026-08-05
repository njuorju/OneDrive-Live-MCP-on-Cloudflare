import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { z } from "zod";
import { ConnectorError, safeErrorResult } from "../src/errors";
import { CHATGPT_ATTACHMENT_HOST, isPublicRoutableAddress } from "../src/connector-files";
import {
  connectorFileInputSchema,
  loadConnectorTextFile,
  normalizeConnectorFileReference,
  trustedConnectorFileUrl,
  registerFileBackedTextTools,
  replaceCataloguePairFromConnectorFilesStrict,
  sha256HexBytes,
  validateCataloguePairFilesStrict,
} from "../src/file-backed-text";

const encoder = new TextEncoder();
const csv = encoder.encode("source_record_id,name\nACA-0001,A\nACA-0002,B\n");
const json = encoder.encode(JSON.stringify([
  { source_record_id: "ACA-0001", name: "A" },
  { source_record_id: "ACA-0002", name: "B" },
]));
let base = "";
let server: http.Server;

before(async () => {
  server = http.createServer((request, response) => {
    const path = request.url ?? "/";
    const send = (status: number, body: Uint8Array | string, type: string) => {
      const bytes = typeof body === "string" ? encoder.encode(body) : body;
      response.writeHead(status, { "content-type": type, "content-length": String(bytes.byteLength) });
      response.end(bytes);
    };
    if (path === "/csv") return send(200, csv, "text/csv");
    if (path === "/json") return send(200, json, "application/json");
    if (path === "/forbidden") return send(403, "forbidden", "text/plain");
    if (path === "/expired") return send(410, "expired", "text/plain");
    if (path === "/failed") return send(500, "failed", "text/plain");
    if (path === "/redirect") { response.writeHead(302, { location: "/csv" }); return response.end(); }
    if (path === "/cross") { response.writeHead(302, { location: "https://lookalike.blob.core.windows.net/csv" }); return response.end(); }
    if (path === "/oversize") return send(200, "1234567890", "text/plain");
    if (path === "/badmime") return send(200, csv, "application/pdf");
    if (path === "/binary") return send(200, Uint8Array.from([0x41, 0x00, 0x42]), "text/plain");
    if (path === "/badcsv") return send(200, 'source_record_id,name\n"ACA-0001,A', "text/csv");
    if (path === "/badjson") return send(200, "{not-json", "application/json");
    return send(404, "missing", "text/plain");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

const mappedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
  const url = new URL(raw);
  return fetch(`${base}${url.pathname}${url.search}`, init);
}) as typeof fetch;

function ref(path: string, fileName: string, mimeType: string) {
  return { download_url: `https://oaisdmntprindiasocentral.blob.core.windows.net${path}`, file_id: `file_${path.slice(1)}`, file_name: fileName, mime_type: mimeType };
}

test("raw registered descriptors expose exact fileParams metadata and top-level fields", () => {
  const tools: Record<string, any> = {};
  const fake = { registerTool(name: string, config: unknown, callback: unknown) { tools[name] = { config, callback }; } };
  registerFileBackedTextTools(fake as any, () => ({ env: {} as Env, userId: "user" }));
  for (const name of ["validate_catalogue_pair_files", "replace_catalogue_pair_from_files"]) {
    assert.deepEqual(tools[name].config._meta["openai/fileParams"], ["csvFile", "jsonFile"]);
    const schema = z.toJSONSchema(z.object(tools[name].config.inputSchema)) as any;
    assert.equal(schema.properties.csvFile.type, "object");
    assert.equal(schema.properties.jsonFile.type, "object");
    assert.deepEqual(schema.properties.csvFile.required, ["download_url", "file_id"]);
    assert.deepEqual(Object.keys(schema.properties.csvFile.properties).sort(), ["download_url", "file_id", "file_name", "mime_type", "size"]);
  }
  assert.deepEqual(tools.create_text_file_from_file.config._meta["openai/fileParams"], ["file"]);
  assert.deepEqual(tools.replace_text_file_from_file.config._meta["openai/fileParams"], ["file"]);
});

test("valid ChatGPT file-reference objects normalize without exposing values", () => {
  const value = normalizeConnectorFileReference(ref("/csv", "catalogue.csv", "text/csv"));
  assert.equal(value.file_name, "catalogue.csv");
  assert.equal(value.mime_type, "text/csv");
});

test("missing download_url has a precise sanitized error", () => {
  assert.throws(() => normalizeConnectorFileReference({ file_id: "file_x" }), (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_download_url_missing");
});

test("missing file_id has a precise sanitized error", () => {
  assert.throws(() => normalizeConnectorFileReference({ download_url: "https://oaisdmntprindiasocentral.blob.core.windows.net/csv" }), (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_metadata_missing");
});

test("malformed values are rejected", () => {
  assert.throws(() => normalizeConnectorFileReference("/mnt/data/catalogue.csv"), (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_reference_malformed");
});

test("authorized temporary download returns exact bytes and SHA-256", async () => {
  const loaded = await loadConnectorTextFile(ref("/csv", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch);
  assert.deepEqual(loaded.bytes, csv);
  assert.equal(loaded.sha256, await sha256HexBytes(csv));
});

test("forbidden, expired and non-2xx downloads are distinct", async () => {
  await assert.rejects(() => loadConnectorTextFile(ref("/forbidden", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_download_forbidden");
  await assert.rejects(() => loadConnectorTextFile(ref("/expired", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_download_expired");
  await assert.rejects(() => loadConnectorTextFile(ref("/failed", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_download_failed");
});

test("redirect policy is fail-closed", async () => {
  await assert.rejects(() => loadConnectorTextFile(ref("/redirect", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_download_forbidden");
});

test("oversized attachments fail before content parsing", async () => {
  await assert.rejects(() => loadConnectorTextFile(ref("/oversize", "catalogue.csv", "text/csv"), "target.csv", 4, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_too_large");
});

test("declared and response MIME mismatches are rejected", async () => {
  await assert.rejects(() => loadConnectorTextFile(ref("/csv", "catalogue.csv", "application/pdf"), "target.csv", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_mime_rejected");
  await assert.rejects(() => loadConnectorTextFile(ref("/badmime", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_mime_rejected");
});

test("binary and malformed content are rejected", async () => {
  await assert.rejects(() => loadConnectorTextFile(ref("/binary", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_content_invalid");
  await assert.rejects(() => loadConnectorTextFile(ref("/badcsv", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_content_invalid");
  await assert.rejects(() => loadConnectorTextFile(ref("/badjson", "catalogue.json", "application/json"), "target.json", 1024, undefined, undefined, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_content_invalid");
});

test("byte length and hash are enforced", async () => {
  const hash = await sha256HexBytes(csv);
  await assert.rejects(() => loadConnectorTextFile(ref("/csv", "catalogue.csv", "text/csv"), "target.csv", 1024, hash, csv.byteLength + 1, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_content_invalid");
  await assert.rejects(() => loadConnectorTextFile(ref("/csv", "catalogue.csv", "text/csv"), "target.csv", 1024, "0".repeat(64), csv.byteLength, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "connector_file_hash_mismatch");
  const loaded = await loadConnectorTextFile(ref("/csv", "catalogue.csv", "text/csv"), "target.csv", 1024, hash, csv.byteLength, mappedFetch);
  assert.equal(loaded.byteLength, csv.byteLength);
  assert.equal(loaded.sha256, hash);
});

test("pair validation confirms root-array json, key parity, count, bytes and hashes", async () => {
  const validated = await validateCataloguePairFilesStrict({
    csvFile: ref("/csv", "catalogue.csv", "text/csv"),
    jsonFile: ref("/json", "catalogue.json", "application/json"),
    recordKeyField: "source_record_id",
    jsonRecordsPath: "",
    expectedRecordCount: 2,
    expectedCsvByteSize: csv.byteLength,
    expectedCsvSha256: await sha256HexBytes(csv),
    expectedJsonByteSize: json.byteLength,
    expectedJsonSha256: await sha256HexBytes(json),
  }, 1024, mappedFetch);
  assert.equal(validated.parsed.json.rootType, "array");
  assert.equal(validated.parity.recordCount, 2);
  assert.equal(validated.mutationBegan, false);
});

test("pair validation fails on key set or expected count drift", async () => {
  const customFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const url = new URL(raw);
    if (url.pathname === "/mismatch") return new Response(JSON.stringify([{ source_record_id: "ACA-9999", name: "X" }]), { status: 200, headers: { "content-type": "application/json" } });
    return mappedFetch(input, init);
  }) as typeof fetch;
  await assert.rejects(() => validateCataloguePairFilesStrict({ csvFile: ref("/csv", "x.csv", "text/csv"), jsonFile: ref("/mismatch", "x.json", "application/json"), recordKeyField: "source_record_id" }, 1024, customFetch), (e: unknown) => e instanceof ConnectorError && e.code === "catalogue_key_set_mismatch");
  await assert.rejects(() => validateCataloguePairFilesStrict({ csvFile: ref("/csv", "x.csv", "text/csv"), jsonFile: ref("/json", "x.json", "application/json"), recordKeyField: "source_record_id", expectedRecordCount: 3 }, 1024, mappedFetch), (e: unknown) => e instanceof ConnectorError && e.code === "record_count_mismatch");
});

test("errors never leak download URLs, file IDs or content", async () => {
  const secretRef = { download_url: "https://oaisdmntprindiasocentral.blob.core.windows.net/forbidden?token=SECRET", file_id: "file_SECRET", file_name: "x.csv", mime_type: "text/csv" };
  let caught: unknown;
  try { await loadConnectorTextFile(secretRef, "x.csv", 1024, undefined, undefined, mappedFetch); } catch (error) { caught = error; }
  const rendered = JSON.stringify(safeErrorResult(caught));
  assert.equal(rendered.includes("SECRET"), false);
  assert.equal(rendered.includes("download_url"), false);
});

test("replacement source orders both file validations before mutation coordinator", () => {
  const source = replaceCataloguePairFromConnectorFilesStrict.toString();
  assert.ok(source.indexOf("loadConnectorTextFile") >= 0);
  assert.ok(source.indexOf("coordinatePairReplacement") > source.indexOf("loadConnectorTextFile"));
});

test("standalone schema exactly follows the official four-property contract", () => {
  const schema = z.toJSONSchema(connectorFileInputSchema) as any;
  assert.deepEqual(schema.required, ["download_url", "file_id"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["download_url", "file_id", "file_name", "mime_type", "size"]);
  assert.equal(schema.additionalProperties, false);
});


test("exact observed platform host is accepted with safe normalization", () => {
  assert.equal(trustedConnectorFileUrl(`https://${CHATGPT_ATTACHMENT_HOST}/file`).hostname, CHATGPT_ATTACHMENT_HOST);
  assert.equal(trustedConnectorFileUrl(`https://${CHATGPT_ATTACHMENT_HOST.toUpperCase()}/file`).hostname, CHATGPT_ATTACHMENT_HOST);
  assert.equal(trustedConnectorFileUrl(`https://${CHATGPT_ATTACHMENT_HOST}./file`).hostname, CHATGPT_ATTACHMENT_HOST);
});

test("host policy rejects parent-domain bypass, lookalikes, suffix confusion, IDNs, HTTP, custom ports and IP literals", () => {
  const forbidden = [
    "https://blob.core.windows.net/file",
    "https://evil-oaisdmntprindiasocentral.blob.core.windows.net/file",
    "https://oaisdmntprindiasocentral.blob.core.windows.net.evil.example/file",
    "https://oaisdmntprindiasocentral.blob.core.windows.net@evil.example/file",
    "https://xn--oaisdmntprindiasocentral-9za.blob.core.windows.net/file",
    `http://${CHATGPT_ATTACHMENT_HOST}/file`,
    `https://${CHATGPT_ATTACHMENT_HOST}:444/file`,
    "https://127.0.0.1/file",
    "https://[::1]/file",
  ];
  for (const url of forbidden) assert.throws(() => trustedConnectorFileUrl(url), (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_download_forbidden");
});

test("private, loopback, link-local, CGNAT, multicast, documentation and metadata addresses are rejected", () => {
  for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1"]) {
    assert.equal(isPublicRoutableAddress(address), false, address);
  }
  assert.equal(isPublicRoutableAddress("8.8.8.8"), true);
  assert.equal(isPublicRoutableAddress("2606:4700:4700::1111"), true);
});

test("authorized top-level file parameter and stable public DNS are mandatory in production mode", async () => {
  const publicResolver = async () => ["20.60.10.1", "2603:1030:20e:3::23c"];
  await assert.rejects(
    () => loadConnectorTextFile(ref("/csv", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch, { enforceAuthorizedFileParam: true, authorizedTopLevelFileParam: "other", declaredFileParams: ["csvFile"] }),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_parameter_not_authorized",
  );
  const loaded = await loadConnectorTextFile(ref("/csv", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch, { enforceAuthorizedFileParam: true, authorizedTopLevelFileParam: "csvFile", declaredFileParams: ["csvFile"], resolveHost: publicResolver });
  assert.equal(loaded.networkReceipt?.hostname, CHATGPT_ATTACHMENT_HOST);
  assert.equal(loaded.networkReceipt?.dnsRevalidated, true);
  assert.equal(loaded.networkReceipt?.connectionPinned, false);
});

test("DNS rebinding and private DNS results fail before connection", async () => {
  let calls = 0;
  const rebinding = async () => (++calls === 1 ? ["20.60.10.1"] : ["20.60.10.2"]);
  await assert.rejects(
    () => loadConnectorTextFile(ref("/csv", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch, { enforceAuthorizedFileParam: true, authorizedTopLevelFileParam: "csvFile", declaredFileParams: ["csvFile"], resolveHost: rebinding }),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_dns_rebinding_detected",
  );
  await assert.rejects(
    () => loadConnectorTextFile(ref("/csv", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch, { enforceAuthorizedFileParam: true, authorizedTopLevelFileParam: "csvFile", declaredFileParams: ["csvFile"], resolveHost: async () => ["169.254.169.254"] }),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_dns_private_address",
  );
});

test("same-host redirect is allowed only when explicitly enabled and no authorization header is forwarded", async () => {
  const seenAuthorization: Array<string | null> = [];
  const observingFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenAuthorization.push(headers.get("authorization"));
    return mappedFetch(input, init);
  }) as typeof fetch;
  const loaded = await loadConnectorTextFile(ref("/redirect", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, observingFetch, { allowSingleSameHostRedirect: true });
  assert.equal(loaded.networkReceipt, null);
  assert.deepEqual(seenAuthorization, [null, null]);
  await assert.rejects(() => loadConnectorTextFile(ref("/cross", "catalogue.csv", "text/csv"), "target.csv", 1024, undefined, undefined, mappedFetch, { allowSingleSameHostRedirect: true }), (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_download_forbidden");
});

test("declared byte size is enforced and included only as sanitized metadata", async () => {
  await assert.rejects(() => loadConnectorTextFile({ ...ref("/csv", "catalogue.csv", "text/csv"), size: 1 }, "target.csv", 1024, undefined, undefined, mappedFetch), (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_content_invalid");
  await assert.rejects(() => loadConnectorTextFile({ ...ref("/csv", "catalogue.csv", "text/csv"), size: 10_000 }, "target.csv", 1024, undefined, undefined, mappedFetch), (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_too_large");
});
