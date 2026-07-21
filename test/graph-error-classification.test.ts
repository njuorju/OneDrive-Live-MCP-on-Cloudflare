import test from "node:test";
import assert from "node:assert/strict";
import { classifyGraphFetchException, graphResponse } from "../src/graph-core.js";
import { sealJson } from "../src/security.js";

async function testEnv(): Promise<Env> {
  const key = "test-cookie-key-at-least-32-bytes-long";
  const sealed = await sealJson(key, {
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    scope: "Files.ReadWrite",
  });
  return {
    COOKIE_ENCRYPTION_KEY: key,
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: async () => Response.json({ ok: true, found: true, expired: false, value: sealed }),
      }) as unknown as DurableObjectStub,
    } as DurableObjectNamespace,
  } as Env;
}

test("classifies the Cloudflare external-subrequest limit without same-invocation retry", () => {
  const result = classifyGraphFetchException(new Error("Too many subrequests."));
  assert.equal(result.code, "graph_subrequest_limit");
  assert.equal(result.category, "resource_limit");
  assert.equal(result.retryable, true);
});

test("distinguishes timeout and network connection failures", () => {
  const timeout = new Error("The operation timed out"); timeout.name = "AbortError";
  assert.equal(classifyGraphFetchException(timeout).code, "graph_timeout");
  assert.equal(classifyGraphFetchException(new TypeError("fetch failed: connection reset")).code, "graph_network_error");
});

test("sanitizes URLs and long opaque values from exception diagnostics", () => {
  const result = classifyGraphFetchException(new Error(`fetch failed https://graph.microsoft.com/download?token=${"x".repeat(120)}`));
  assert.equal(result.exceptionMessage.includes("graph.microsoft.com"), false);
  assert.equal(result.exceptionMessage.includes("x".repeat(80)), false);
});

test("does not retry the Cloudflare subrequest-limit exception", async () => {
  const env = await testEnv();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("Too many subrequests."); }) as typeof fetch;
  try {
    await assert.rejects(() => graphResponse(env, "user", "/me"), (error: any) => error?.code === "graph_subrequest_limit");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries a transient GET 429 using bounded retry headers", async () => {
  const env = await testEnv();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 3) return Response.json({ error: { code: "activityLimitReached" } }, { status: 429, headers: { "x-ms-retry-after-ms": "1" } });
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const response = await graphResponse(env, "user", "/me");
    assert.equal(response.status, 200);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry an ambiguous mutation network failure in the same invocation", async () => {
  const env = await testEnv();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new TypeError("fetch failed: connection reset"); }) as typeof fetch;
  try {
    await assert.rejects(
      () => graphResponse(env, "user", "/me/drive/items/source", { method: "PATCH", headers: { "If-Match": "etag" }, body: "{}" }),
      (error: any) => error?.code === "graph_network_error" && error?.retryable === true,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
