import test from "node:test";
import assert from "node:assert/strict";
import { classifyGraphFetchException } from "../src/graph-core.js";

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
