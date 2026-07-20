import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sealJson } from "../src/security";
import { snapshotEnrichTestHooks } from "../src/snapshot-enrich";
import { reliableGraphSha256 } from "../src/snapshot-graph";

async function fakeEnv(): Promise<Env> {
  const secret = "streaming-hash-test-secret";
  const sealed = await sealJson(secret, {
    accessToken: "STREAM_TEST_ACCESS_TOKEN",
    refreshToken: "STREAM_TEST_REFRESH_TOKEN",
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: "Files.ReadWrite User.Read offline_access",
  });
  const stub = {
    async fetch(url: string): Promise<Response> {
      if (new URL(url).pathname === "/get-token") return Response.json({ ok: true, found: true, value: sealed });
      return Response.json({ ok: false }, { status: 404 });
    },
  };
  return {
    COOKIE_ENCRYPTION_KEY: secret,
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
    SNAPSHOT_HASH_MAX_MB: "64",
  } as unknown as Env;
}

test("large files are SHA-256 hashed incrementally without the extraction buffer limit", async () => {
  const env = await fakeEnv();
  const originalFetch = globalThis.fetch;
  const chunk = new Uint8Array(1024 * 1024).fill(0x5a);
  const chunks = 21;
  const totalBytes = chunk.byteLength * chunks;
  const expected = createHash("sha256");
  for (let index = 0; index < chunks; index += 1) expected.update(chunk);

  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/items/large-file/content")) {
        let emitted = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (emitted >= chunks) {
              controller.close();
              return;
            }
            controller.enqueue(chunk);
            emitted += 1;
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": String(totalBytes), "request-id": "stream-request" } });
      }
      if (url.pathname.includes("/items/large-file")) {
        return Response.json({ id: "large-file", eTag: "etag-1", size: totalBytes, file: { mimeType: "application/pdf" } });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }) as typeof fetch;

    const result = await reliableGraphSha256(env, "user", "large-file", "etag-1", {
      operation: "test.streaming_hash",
      endpointCategory: "file_content_stream",
      maxAttempts: 1,
      timeoutMs: 500,
    });
    assert.equal(result.byteLength, totalBytes);
    assert.equal(result.sha256, expected.digest("hex"));
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("large files use streaming hash while bounded extraction remains size-limited", () => {
  assert.equal(snapshotEnrichTestHooks.oversizedForDeterministicExtraction(20 * 1024 * 1024), false);
  assert.equal(snapshotEnrichTestHooks.oversizedForDeterministicExtraction(20 * 1024 * 1024 + 1), true);
});
