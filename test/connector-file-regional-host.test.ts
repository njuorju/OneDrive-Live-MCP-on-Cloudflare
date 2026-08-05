import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorError, safeErrorResult } from "../src/errors";
import {
  loadConnectorTextFile,
  normalizeConnectorFileReference,
  trustedConnectorFileUrl,
} from "../src/file-backed-text";

const REGIONAL_HOST = "oaisdmntprnznorth.blob.core.windows.net";
const reference = {
  download_url: `https://${REGIONAL_HOST}/catalogue.csv`,
  file_id: "file_regional",
  file_name: "catalogue.csv",
  mime_type: "text/csv",
};

const csv = "source_record_id,name\nACA-0001,A\n";

function csvResponse(status = 200): Response {
  return new Response(csv, {
    status,
    headers: {
      "content-type": "text/csv",
      "content-length": String(new TextEncoder().encode(csv).byteLength),
    },
  });
}

test("bounded ChatGPT regional attachment-host family accepts proven and future platform labels", () => {
  for (const hostname of [
    "oaisdmntprindiasocentral.blob.core.windows.net",
    "oaisdmntprnznorth.blob.core.windows.net",
    "oaisdmntprwestus3.blob.core.windows.net",
    "OAISDMNTPRNZNORTH.BLOB.CORE.WINDOWS.NET",
    "oaisdmntprnznorth.blob.core.windows.net.",
  ]) {
    const expected = hostname.toLocaleLowerCase("en").replace(/\.$/, "");
    assert.equal(trustedConnectorFileUrl(`https://${hostname}/mounted`).hostname, expected);
  }
});

test("bounded family rejects broadened Azure, prefix, label, suffix, punycode and transport variants", () => {
  const forbidden = [
    "https://nznorth.blob.core.windows.net/file",
    "https://oaisdmnt.blob.core.windows.net/file",
    "https://oaisdmntpr.example.blob.core.windows.net/file",
    "https://oaisdmntprnznorth.extra.blob.core.windows.net/file",
    "https://oaisdmntprnznorth.blob.core.windows.net.attacker.example/file",
    "https://oaisdmntpr-nznorth.blob.core.windows.net/file",
    "https://oaisdmntpr_nznorth.blob.core.windows.net/file",
    "https://oaisdmntprnz.north.blob.core.windows.net/file",
    "https://oaisdmntprxn--nznorth-9za.blob.core.windows.net/file",
    "http://oaisdmntprnznorth.blob.core.windows.net/file",
    "https://oaisdmntprnznorth.blob.core.windows.net:444/file",
    "https://user@oaisdmntprnznorth.blob.core.windows.net/file",
    "https://127.0.0.1/file",
    "https://[::1]/file",
  ];
  for (const value of forbidden) {
    assert.throws(
      () => trustedConnectorFileUrl(value),
      (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_download_forbidden",
      value,
    );
  }
});

test("arbitrary URL strings remain invalid connector-file references", () => {
  assert.throws(
    () => normalizeConnectorFileReference(`https://${REGIONAL_HOST}/catalogue.csv`),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_reference_malformed",
  );
});

test("regional host still requires the declared top-level fileParams field", async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => { fetchCalls += 1; return csvResponse(); }) as typeof fetch;
  await assert.rejects(
    () => loadConnectorTextFile(reference, "catalogue.csv", 1024, undefined, undefined, fetchImpl, {
      enforceAuthorizedFileParam: true,
      authorizedTopLevelFileParam: "file",
      declaredFileParams: [],
    }),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_parameter_not_authorized",
  );
  assert.equal(fetchCalls, 0);
});

test("regional host retains private-address and DNS-rebinding rejection before fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => { fetchCalls += 1; return csvResponse(); }) as typeof fetch;
  const baseOptions = {
    enforceAuthorizedFileParam: true,
    authorizedTopLevelFileParam: "file",
    declaredFileParams: ["file"],
  } as const;

  await assert.rejects(
    () => loadConnectorTextFile(reference, "catalogue.csv", 1024, undefined, undefined, fetchImpl, {
      ...baseOptions,
      resolveHost: async () => ["169.254.169.254"],
    }),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_dns_forbidden",
  );

  let resolutions = 0;
  await assert.rejects(
    () => loadConnectorTextFile(reference, "catalogue.csv", 1024, undefined, undefined, fetchImpl, {
      ...baseOptions,
      resolveHost: async () => (++resolutions === 1 ? ["20.60.10.1"] : ["20.60.10.2"]),
    }),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_dns_rebinding_detected",
  );
  assert.equal(fetchCalls, 0);
});

test("regional host retains default redirect denial and explicit one-hop same-host policy", async () => {
  let calls = 0;
  const sameHostFetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: `https://${REGIONAL_HOST}/final.csv` } });
    return csvResponse();
  }) as typeof fetch;

  await assert.rejects(
    () => loadConnectorTextFile(reference, "catalogue.csv", 1024, undefined, undefined, sameHostFetch),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_download_forbidden",
  );

  calls = 0;
  const loaded = await loadConnectorTextFile(reference, "catalogue.csv", 1024, undefined, undefined, sameHostFetch, {
    allowSingleSameHostRedirect: true,
  });
  assert.equal(loaded.text, csv);
  assert.equal(calls, 2);

  const crossOriginFetch = (async () => new Response(null, {
    status: 302,
    headers: { location: "https://attacker.example/final.csv" },
  })) as typeof fetch;
  await assert.rejects(
    () => loadConnectorTextFile(reference, "catalogue.csv", 1024, undefined, undefined, crossOriginFetch, {
      allowSingleSameHostRedirect: true,
    }),
    (error: unknown) => error instanceof ConnectorError && error.code === "connector_file_download_forbidden",
  );
});

test("regional-host failures leak no URL, query, file ID, token or content", async () => {
  const secretReference = {
    ...reference,
    download_url: "https://oaisdmntpr-nznorth.blob.core.windows.net/catalogue.csv?token=REGIONAL_SECRET",
    file_id: "file_REGIONAL_SECRET",
  };
  let caught: unknown;
  try {
    await loadConnectorTextFile(secretReference, "catalogue.csv", 1024, undefined, undefined, (async () => csvResponse()) as typeof fetch);
  } catch (error) {
    caught = error;
  }
  const rendered = JSON.stringify(safeErrorResult(caught));
  for (const forbidden of ["REGIONAL_SECRET", "download_url", "file_REGIONAL_SECRET", csv]) {
    assert.equal(rendered.includes(forbidden), false, forbidden);
  }
});
