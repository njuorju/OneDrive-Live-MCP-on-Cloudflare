import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConnectorError, safeErrorResult } from "../src/errors";
import {
  isPublicRoutableAddress,
  validateConnectorFileDns,
  type ConnectorDnsResolver,
} from "../src/connector-file-dns";
import {
  loadConnectorTextFile,
  normalizeConnectorFileReference,
  trustedConnectorFileUrl,
} from "../src/connector-files";
import { replaceCataloguePairFromConnectorFilesStrict } from "../src/file-backed-text";

const HOST = "oaisdmntprnznorth.blob.core.windows.net";
const V4 = "20.60.10.1";
const V6 = "2603:1030:20e:3::23c";

function dnsError(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function resolver(
  resolve4: ConnectorDnsResolver["resolve4"],
  resolve6: ConnectorDnsResolver["resolve6"],
  implementationClass = "explicit_test_resolver",
): ConnectorDnsResolver {
  return { implementationClass, resolve4, resolve6 };
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<ConnectorError> {
  try {
    await run();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, code);
    return error;
  }
}

test("supported IPv4 and IPv6 resolution returns a bounded sanitized receipt", async () => {
  const result = await validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [V4], async () => [V6]),
    correlationId: "dns-both-public",
  });
  assert.deepEqual(result.addresses, [V4, V6].sort());
  assert.equal(result.receipt.normalizedHostname, HOST);
  assert.equal(result.receipt.resolverImplementationClass, "explicit_test_resolver");
  assert.deepEqual(result.receipt.methodsAttempted, ["resolve4", "resolve6"]);
  assert.equal(result.receipt.ipv4.status, "success");
  assert.equal(result.receipt.ipv6.status, "success");
  assert.equal(result.receipt.ipv4AddressCount, 1);
  assert.equal(result.receipt.ipv6AddressCount, 1);
  assert.equal(result.receipt.publicAddressValidationResult, "passed");
  assert.equal(result.receipt.revalidationResult, "passed");
  assert.equal(result.receipt.localErrorCode, null);
  assert.equal(result.receipt.correlationId, "dns-both-public");
});

test("A records are sufficient when AAAA returns ENODATA", async () => {
  const result = await validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [V4], async () => { throw dnsError("ENODATA"); }),
  });
  assert.deepEqual(result.addresses, [V4]);
  assert.equal(result.receipt.ipv4.status, "success");
  assert.equal(result.receipt.ipv6.status, "no_data");
  assert.equal(result.receipt.ipv6.errorCode, "ENODATA");
});

test("AAAA records are sufficient when A returns ENODATA", async () => {
  const result = await validateConnectorFileDns(HOST, {
    resolver: resolver(async () => { throw dnsError("ENODATA"); }, async () => [V6]),
  });
  assert.deepEqual(result.addresses, [V6]);
  assert.equal(result.receipt.ipv4.status, "no_data");
  assert.equal(result.receipt.ipv6.status, "success");
});

test("both families returning no data is classified precisely", async () => {
  const error = await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [], async () => { throw dnsError("ENODATA"); }),
  }), "connector_file_dns_no_records");
  assert.equal(error.retryable, true);
});

test("one family timing out is tolerated when the other returns valid records", async () => {
  const never = () => new Promise<never>(() => undefined);
  const result = await validateConnectorFileDns(HOST, {
    resolver: resolver(never, async () => [V6]),
    timeoutMs: 25,
  });
  assert.deepEqual(result.addresses, [V6]);
  assert.equal(result.receipt.ipv4.status, "timeout");
  assert.equal(result.receipt.ipv6.status, "success");
});

test("unsupported or non-callable DNS APIs fail closed without fallback", async () => {
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: { implementationClass: "missing_mock", resolve4: undefined, resolve6: async () => [V6] } as unknown as ConnectorDnsResolver,
  }), "connector_file_dns_api_unsupported");
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => { throw dnsError("ERR_NOT_IMPLEMENTED", "[unenv] resolve4 is not implemented yet!"); }, async () => [V6]),
  }), "connector_file_dns_api_unsupported");
});

test("ENOTFOUND and ENODATA are distinguished", async () => {
  const notFound = await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => { throw dnsError("ENOTFOUND"); }, async () => { throw dnsError("ENODATA"); }),
  }), "connector_file_dns_ipv4_failed");
  const receipt = notFound.details?.dnsReceipt as any;
  assert.equal(receipt.ipv4.status, "resolver_error");
  assert.equal(receipt.ipv4.errorCode, "ENOTFOUND");
  assert.equal(receipt.ipv6.status, "no_data");
});

test("malformed resolver responses are rejected", async () => {
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => ({ address: V4 }), async () => [V6]),
  }), "connector_file_dns_response_malformed");
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [V6], async () => [V6]),
  }), "connector_file_dns_response_malformed");
});

test("public IPv4 and IPv6 are accepted", () => {
  assert.equal(isPublicRoutableAddress(V4), true);
  assert.equal(isPublicRoutableAddress(V6), true);
});

test("private, loopback, link-local, CGNAT, multicast, documentation, reserved and metadata addresses are rejected", () => {
  for (const address of [
    "0.0.0.1", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1",
    "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
    "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2001::1", "::ffff:127.0.0.1",
  ]) assert.equal(isPublicRoutableAddress(address), false, address);
});

test("mixed public and private DNS results are rejected fail-closed", async () => {
  const error = await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [V4, "169.254.169.254"], async () => []),
  }), "connector_file_dns_private_address");
  const receipt = error.details?.dnsReceipt as any;
  assert.equal(receipt.publicAddressValidationResult, "failed");
  assert.equal(JSON.stringify(receipt).includes("169.254.169.254"), false);
});

test("revalidation succeeds only for an identical address set", async () => {
  let v4Calls = 0;
  let v6Calls = 0;
  const result = await validateConnectorFileDns(HOST, {
    resolver: resolver(async () => { v4Calls += 1; return [V4]; }, async () => { v6Calls += 1; return [V6]; }),
  });
  assert.equal(v4Calls, 2);
  assert.equal(v6Calls, 2);
  assert.equal(result.receipt.revalidationResult, "passed");
});

test("revalidation address-set mismatch is rejected", async () => {
  let calls = 0;
  const error = await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [++calls === 1 ? V4 : "20.60.10.2"], async () => []),
  }), "connector_file_dns_rebinding_detected");
  const receipt = error.details?.dnsReceipt as any;
  assert.equal(receipt.revalidationResult, "failed");
  assert.equal(JSON.stringify(receipt).includes(V4), false);
});

test("the exact regional hostname is accepted and arbitrary Azure Blob hosts are rejected before DNS", async () => {
  assert.equal(trustedConnectorFileUrl(`https://${HOST}/file`).hostname, HOST);
  let calls = 0;
  const mock = resolver(async () => { calls += 1; return [V4]; }, async () => { calls += 1; return []; });
  assert.throws(
    () => trustedConnectorFileUrl("https://arbitrary.blob.core.windows.net/file"),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_download_forbidden",
  );
  assert.equal(calls, 0);
  await validateConnectorFileDns(HOST, { resolver: mock });
  assert.equal(calls, 4);
});

test("DNS promises are strictly bounded", async () => {
  const started = Date.now();
  const never = () => new Promise<never>(() => undefined);
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(never, never),
    timeoutMs: 25,
  }), "connector_file_dns_timeout");
  assert.ok(Date.now() - started < 250);
});

test("DNS errors and receipts do not leak URLs, tokens, file IDs, content, or addresses", async () => {
  const error = await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [V4, "10.0.0.1"], async () => []),
    correlationId: "sanitized-correlation",
  }), "connector_file_dns_private_address");
  const rendered = JSON.stringify(safeErrorResult(error));
  for (const forbidden of ["https://", "token=", "file_SECRET", "secret-content", V4, "10.0.0.1"]) {
    assert.equal(rendered.includes(forbidden), false, forbidden);
  }
  assert.equal(rendered.includes(HOST), true);
  assert.equal(rendered.includes("sanitized-correlation"), true);
});

test("connector-file loading uses explicit resolver mocks, revalidates, and never calls live DNS", async () => {
  const body = new TextEncoder().encode("source_record_id,name\nACA-0001,A\n");
  let fetchCalls = 0;
  const fetchMock: typeof fetch = (async () => {
    fetchCalls += 1;
    return new Response(body, { status: 200, headers: { "content-type": "text/csv", "content-length": String(body.byteLength) } });
  }) as typeof fetch;
  const loaded = await loadConnectorTextFile({
    download_url: `https://${HOST}/attachment?token=SECRET`,
    file_id: "file_SECRET",
    file_name: "catalogue.csv",
    mime_type: "text/csv",
    size: body.byteLength,
  }, "catalogue.csv", 1024, undefined, body.byteLength, fetchMock, {
    enforceAuthorizedFileParam: true,
    authorizedTopLevelFileParam: "csvFile",
    declaredFileParams: ["csvFile"],
    dnsResolver: resolver(async () => [V4], async () => { throw dnsError("ENODATA"); }),
    dnsCorrelationId: "load-dns-receipt",
  });
  assert.equal(fetchCalls, 1);
  assert.equal(loaded.networkReceipt?.hostname, HOST);
  assert.equal(loaded.networkReceipt?.dnsAddressCount, 1);
  assert.equal(loaded.networkReceipt?.dnsRevalidated, true);
  assert.equal(loaded.networkReceipt?.dns.resolverImplementationClass, "explicit_test_resolver");
  assert.equal(loaded.networkReceipt?.dns.correlationId, "load-dns-receipt");
  assert.equal(JSON.stringify(loaded.networkReceipt).includes("SECRET"), false);
});

test("connector parsing and paired publication ordering remain unchanged", () => {
  const normalized = normalizeConnectorFileReference({
    download_url: `https://${HOST}/attachment`,
    file_id: "file_x",
    file_name: "catalogue.csv",
    mime_type: "text/csv",
  });
  assert.equal(normalized.file_name, "catalogue.csv");
  const source = replaceCataloguePairFromConnectorFilesStrict.toString();
  assert.ok(source.indexOf("loadConnectorTextFile") >= 0);
  assert.ok(source.indexOf("coordinatePairReplacement") > source.indexOf("loadConnectorTextFile"));
});

test("production DNS implementation uses only Workers-supported resolve4 and resolve6 methods", () => {
  const source = readFileSync(new URL("../src/connector-file-dns.ts", import.meta.url), "utf8");
  assert.match(source, /from "node:dns"/);
  assert.match(source, /dnsPromises\.resolve4/);
  assert.match(source, /dnsPromises\.resolve6/);
  assert.doesNotMatch(source, /cloudflare-dns\.com|dns-query/);
  assert.doesNotMatch(source, /dnsPromises\.(?:lookup|lookupService|resolve)\s*\(/);
});
