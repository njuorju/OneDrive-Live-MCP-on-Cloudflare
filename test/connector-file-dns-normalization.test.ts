import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeConnectorDnsAnswer } from "../src/connector-dns-answer-normalizer";
import {
  isPublicRoutableAddress,
  validateConnectorFileDns,
  type ConnectorDnsResolver,
} from "../src/connector-file-dns";
import { ConnectorError } from "../src/errors";
import { loadConnectorTextFile, trustedConnectorFileUrl } from "../src/connector-files";

const HOST = "oaisdmntprindiasocentral.blob.core.windows.net";
const CNAME_1 = `${HOST}.`;
const CNAME_2 = "blob.mrs25prdstr20a.store.core.windows.net.";
const V4 = "20.60.10.1";
const V4_B = "20.60.10.2";
const V6 = "2603:1030:20e:3::23c";
const V6_EXPANDED = "2603:1030:020e:0003:0000:0000:0000:023c";

function dnsError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function resolver(
  resolve4: ConnectorDnsResolver["resolve4"],
  resolve6: ConnectorDnsResolver["resolve6"],
): ConnectorDnsResolver {
  return { implementationClass: "odl_req_031_test_resolver", resolve4, resolve6 };
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

test("production-observed Workers string arrays extract IPv4 and IPv6 after CNAME prefixes", async () => {
  const result = await validateConnectorFileDns(HOST, {
    resolver: resolver(
      async () => [CNAME_1, CNAME_2, V4],
      async () => [CNAME_1, CNAME_2, V6],
    ),
  });
  assert.deepEqual(result.addresses, [V4, V6].sort());
  assert.equal(result.receipt.ipv4.status, "success");
  assert.equal(result.receipt.ipv6.status, "success");
  assert.equal(result.receipt.revalidationResult, "passed");
});

test("CNAME-only successful answer is recognized no-data, not malformed", async () => {
  const result = await validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [CNAME_1, CNAME_2, V4], async () => [CNAME_1, CNAME_2]),
  });
  assert.deepEqual(result.addresses, [V4]);
  assert.equal(result.receipt.ipv6.status, "no_data");
});

test("documented exact address and TTL records are supported without accepting arbitrary objects", () => {
  assert.deepEqual(normalizeConnectorDnsAnswer([
    { address: CNAME_1, ttl: 30 },
    { address: V4, ttl: 30 },
  ], 4), { status: "success", addresses: [V4] });
  assert.deepEqual(normalizeConnectorDnsAnswer([
    { address: V6_EXPANDED, ttl: 60 },
  ], 6), { status: "success", addresses: [V6] });
  assert.equal(normalizeConnectorDnsAnswer([{ address: V4 }], 4).status, "malformed");
  assert.equal(normalizeConnectorDnsAnswer([{ address: V4, ttl: 30, family: 4 }], 4).status, "malformed");
});

test("addresses are canonicalized, deduplicated, family-preserving, and deterministically sorted", () => {
  assert.deepEqual(normalizeConnectorDnsAnswer([V4_B, V4, V4_B], 4), {
    status: "success",
    addresses: [V4, V4_B],
  });
  assert.deepEqual(normalizeConnectorDnsAnswer([V6_EXPANDED, V6], 6), {
    status: "success",
    addresses: [V6],
  });
  assert.equal(normalizeConnectorDnsAnswer([V6], 4).status, "malformed");
  assert.equal(normalizeConnectorDnsAnswer([V4], 6).status, "malformed");
});

test("empty, scalar, null, nested, mixed, missing, non-string, and unknown shapes fail closed precisely", () => {
  assert.deepEqual(normalizeConnectorDnsAnswer([], 4), { status: "no_data", addresses: [] });
  for (const value of [
    null,
    V4,
    4,
    { address: V4, ttl: 30 },
    [[V4]],
    [null],
    [{ address: 123, ttl: 30 }],
    [{ address: V4, ttl: "30" }],
    [V4, { address: V4, ttl: 30 }],
    [{ data: V4, ttl: 30 }],
  ]) assert.equal(normalizeConnectorDnsAnswer(value, 4).status, "malformed");
});

test("malformed IP text and unsupported alias placement never become no-data or public addresses", () => {
  for (const value of [
    ["999.1.1.1"],
    ["020.60.10.1"],
    ["2603:::23c"],
    ["fe80::1%eth0"],
    ["not-an-absolute-alias", V4],
    [V4, CNAME_1],
  ]) assert.equal(normalizeConnectorDnsAnswer(value, value[0]?.toString().includes(":") ? 6 : 4).status, "malformed");
});

test("one valid family plus recognized no-data or timeout passes", async () => {
  const noData = await validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [V4], async () => { throw dnsError("ENODATA"); }),
  });
  assert.deepEqual(noData.addresses, [V4]);

  const never = () => new Promise<never>(() => undefined);
  const timeout = await validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [V4], never),
    timeoutMs: 25,
  });
  assert.deepEqual(timeout.addresses, [V4]);
  assert.equal(timeout.receipt.ipv6.status, "timeout");
});

test("one valid family plus malformed, and both families malformed, remain fail-closed", async () => {
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [V4], async () => ({ address: V6 })),
  }), "connector_file_dns_response_malformed");
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => ({ address: V4 }), async () => null),
  }), "connector_file_dns_response_malformed");
});

test("public-only answers pass while mixed private or prohibited ranges fail", async () => {
  const publicOnly = await validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [CNAME_1, V4], async () => [CNAME_1, V6]),
  });
  assert.equal(publicOnly.receipt.publicAddressValidationResult, "passed");

  for (const prohibited of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fe80::1", "ff02::1", "2001:db8::1"]) {
    assert.equal(isPublicRoutableAddress(prohibited), false, prohibited);
  }
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [CNAME_1, V4, "10.0.0.1"], async () => [CNAME_1]),
  }), "connector_file_dns_private_address");
});

test("initial lookup and revalidation share canonical normalization and reordered answers do not rebind", async () => {
  let calls = 0;
  const result = await validateConnectorFileDns(HOST, {
    resolver: resolver(
      async () => (++calls === 1 ? [CNAME_1, V4_B, V4] : [CNAME_1, V4, V4_B]),
      async () => [CNAME_1, V6_EXPANDED],
    ),
  });
  assert.deepEqual(result.addresses, [V4, V4_B, V6].sort());
  assert.equal(result.receipt.revalidationResult, "passed");
});

test("changed canonical address sets trigger rebinding failure", async () => {
  let calls = 0;
  const error = await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => [CNAME_1, ++calls === 1 ? V4 : V4_B], async () => [CNAME_1]),
  }), "connector_file_dns_rebinding_detected");
  assert.equal((error.details?.dnsReceipt as any).revalidationResult, "failed");
});

test("resolver rejection codes remain precise", async () => {
  const error = await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: resolver(async () => { throw dnsError("SERVFAIL"); }, async () => { throw dnsError("ENODATA"); }),
  }), "connector_file_dns_ipv4_failed");
  const receipt = error.details?.dnsReceipt as any;
  assert.equal(receipt.ipv4.status, "resolver_error");
  assert.equal(receipt.ipv4.errorCode, "SERVFAIL");
  assert.equal(receipt.ipv6.status, "no_data");
});

test("no fetch begins when DNS normalization or safety fails", async () => {
  let fetchCalls = 0;
  const fetchMock: typeof fetch = (async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  }) as typeof fetch;
  await expectCode(() => loadConnectorTextFile({
    download_url: `https://${HOST}/attachment?token=SECRET`,
    file_id: "file_SECRET",
    file_name: "catalogue.csv",
    mime_type: "text/csv",
    size: 10,
  }, "catalogue.csv", 1024, undefined, 10, fetchMock, {
    enforceAuthorizedFileParam: true,
    authorizedTopLevelFileParam: "csvFile",
    declaredFileParams: ["csvFile"],
    dnsResolver: resolver(async () => [CNAME_1, "bad-ip"], async () => [CNAME_1]),
  }), "connector_file_dns_response_malformed");
  assert.equal(fetchCalls, 0);
});

test("regional attachment matching and CI no-live-call invariants remain unchanged", () => {
  assert.equal(trustedConnectorFileUrl(`https://${HOST}/attachment`).hostname, HOST);
  assert.throws(() => trustedConnectorFileUrl("https://arbitrary.blob.core.windows.net/attachment"));

  const dnsSource = readFileSync(new URL("../src/connector-file-dns.ts", import.meta.url), "utf8");
  const normalizerSource = readFileSync(new URL("../src/connector-dns-answer-normalizer.ts", import.meta.url), "utf8");
  assert.match(dnsSource, /dnsPromises\.resolve4\(hostname\)/);
  assert.match(dnsSource, /dnsPromises\.resolve6\(hostname\)/);
  assert.match(dnsSource, /normalizeConnectorDnsAnswer\(value, family\)/);
  assert.doesNotMatch(`${dnsSource}\n${normalizerSource}`, /cloudflare-dns\.com|dns-query|OPENCODE|fetch\s*\(/);
});

test("explicit invalid mocks fail closed without fallback", async () => {
  await expectCode(() => validateConnectorFileDns(HOST, { resolver: null }), "connector_file_dns_api_unsupported");
  await expectCode(() => validateConnectorFileDns(HOST, {
    resolver: { implementationClass: "invalid", resolve4: async () => [V4], resolve6: null } as unknown as ConnectorDnsResolver,
  }), "connector_file_dns_api_unsupported");
});
