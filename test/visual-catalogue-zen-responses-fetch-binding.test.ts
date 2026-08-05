import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ZEN_RESPONSES_ENDPOINT,
  ZEN_RESPONSES_MODEL,
  buildZenResponsesRequest,
  initializeZenResponsesSpendLedger,
  isZenResponsesTransportError,
  requestZenResponses,
} from "../src/visual-catalogue-zen-responses";

class MemoryR2 {
  values = new Map<string, Uint8Array>();

  async get(key: string) {
    const body = this.values.get(key);
    if (!body) return null;
    return {
      text: async () => new TextDecoder().decode(body),
      arrayBuffer: async () => body.slice().buffer,
    };
  }

  async put(key: string, body: string | ArrayBuffer | Uint8Array) {
    this.values.set(
      key,
      typeof body === "string"
        ? new TextEncoder().encode(body)
        : body instanceof Uint8Array
          ? body
          : new Uint8Array(body),
    );
  }
}

function completed(text = "ok") {
  return {
    id: "resp_test",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

async function setup(scope: string) {
  const r2 = new MemoryR2();
  const env = { ARTIFACTS: r2, OPENCODE_ZEN_API_KEY: "zen-secret" } as any;
  const ledger = await initializeZenResponsesSpendLedger(env, scope, 75, 1);
  return { r2, env, ledger };
}

function receipts(r2: MemoryR2): Array<Record<string, unknown>> {
  return [...r2.values.entries()]
    .filter(([key]) => key.includes("/provider-transport/"))
    .map(([, value]) => JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>);
}

test("reproduces and precisely classifies the Worker detached-fetch TypeError without leakage", async () => {
  const raw = "Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.";
  const { env, ledger } = await setup("illegal-invocation");
  await assert.rejects(
    () => requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: buildZenResponsesRequest({ text: "PRIVATE_PROMPT", maxOutputTokens: 64 }),
      context: "capability:text_structured_output",
      fetchImpl: (async () => {
        throw new TypeError(raw);
      }) as typeof fetch,
    }),
    (error: unknown) => {
      if (!isZenResponsesTransportError(error)) return false;
      assert.equal(error.code, "zen_responses_fetch_illegal_invocation");
      assert.equal(error.receipt.errorName, "TypeError");
      assert.equal(
        error.receipt.errorMessage,
        "Illegal invocation: function called with incorrect this reference. See [documentation URL removed] for details.",
      );
      assert.equal(
        error.receipt.codeLocation,
        "visual-catalogue-zen-responses.requestZenResponses.fetch",
      );
      assert.equal(error.receipt.localErrorClass, "runtime_fetch_binding");
      assert.equal(error.receipt.requestMethod, "POST");
      assert.deepEqual(error.receipt.headerNames, ["authorization", "content-type"]);
      assert.equal(error.receipt.signalPresent, true);
      assert.equal(error.receipt.redirectMode, "error");
      assert.equal(error.receipt.fetchImplementationClass, "explicit_injected");
      const rendered = JSON.stringify(error.receipt);
      for (const forbidden of [raw, "PRIVATE_PROMPT", "zen-secret", "https://", "Bearer ", ZEN_RESPONSES_ENDPOINT]) {
        assert.equal(rendered.includes(forbidden), false, forbidden);
      }
      return true;
    },
  );
});

test("binds the Worker global fetch receiver and dispatches a fresh plain RequestInit", async () => {
  const originalFetch = globalThis.fetch;
  const inits: RequestInit[] = [];
  const bodies: Record<string, unknown>[] = [];
  const runtimeFetch = async function(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    assert.equal(input, ZEN_RESPONSES_ENDPOINT);
    assert.ok(init);
    inits.push(init);
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(completed()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } as typeof fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: runtimeFetch,
  });
  try {
    const detached = globalThis.fetch;
    await assert.rejects(() => detached("https://example.invalid"), TypeError);
    const first = await setup("bound-global-1");
    const second = await setup("bound-global-2");
    const body = buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 });
    await requestZenResponses({
      env: first.env,
      spendLedgerKey: first.ledger.key,
      body,
      context: "test",
    });
    await requestZenResponses({
      env: second.env,
      spendLedgerKey: second.ledger.key,
      body,
      context: "test",
    });
    assert.equal(inits.length, 2);
    assert.notEqual(inits[0].signal, inits[1].signal);
    for (const init of inits) {
      assert.equal(Object.getPrototypeOf(init), Object.prototype);
      assert.equal(Object.getPrototypeOf(init.headers as object), Object.prototype);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(typeof init.body, "string");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.signal?.aborted, false);
      assert.equal("duplex" in init, false);
      assert.equal("keepalive" in init, false);
      for (const value of Object.values(init.headers as Record<string, unknown>)) {
        assert.equal(typeof value, "string");
      }
    }
    assert.deepEqual(bodies, [body, body]);
    for (const receipt of [...receipts(first.r2), ...receipts(second.r2)]) {
      assert.equal(receipt.body, undefined);
      assert.equal(receipt.headers, undefined);
      assert.equal(receipt.signal, undefined);
      assert.equal(receipt.requestInit, undefined);
      assert.equal(receipt.endpoint, undefined);
    }
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
});

test("explicit null fetch fails closed before global fetch and generic network errors remain precise", async () => {
  const originalFetch = globalThis.fetch;
  let globalCalls = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (async () => {
      globalCalls += 1;
      return new Response("{}");
    }) as typeof fetch,
  });
  try {
    const closed = await setup("null-fetch");
    await assert.rejects(
      () => requestZenResponses({
        env: closed.env,
        spendLedgerKey: closed.ledger.key,
        body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }),
        context: "test",
        fetchImpl: null as any,
      }),
      (error: unknown) => isZenResponsesTransportError(error)
        && error.code === "zen_responses_fetch_not_started"
        && error.receipt.fetchImplementationClass === "invalid_explicit",
    );
    assert.equal(globalCalls, 0);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }

  const network = await setup("network-error");
  await assert.rejects(
    () => requestZenResponses({
      env: network.env,
      spendLedgerKey: network.ledger.key,
      body: buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 }),
      context: "test",
      fetchImpl: (async () => {
        throw new TypeError("network down");
      }) as typeof fetch,
    }),
    (error: unknown) => isZenResponsesTransportError(error)
      && error.code === "zen_responses_network_error"
      && error.receipt.errorName === "TypeError"
      && error.receipt.errorMessage === "Fetch failed before an HTTP response.",
  );
});

test("redirect rejection, payload identity, timeout control, and 64 KiB response ceiling remain intact", async () => {
  const redirected = await setup("redirect");
  const body = buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 });
  await assert.rejects(
    () => requestZenResponses({
      env: redirected.env,
      spendLedgerKey: redirected.ledger.key,
      body,
      context: "test",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.redirect, "error");
        assert.deepEqual(JSON.parse(String(init?.body)), body);
        return new Response(JSON.stringify({ error: { type: "redirect" } }), {
          status: 302,
          headers: {
            "content-type": "application/json",
            location: "https://example.invalid",
          },
        });
      }) as typeof fetch,
    }),
    (error: unknown) => isZenResponsesTransportError(error)
      && error.code === "zen_responses_http_error"
      && error.receipt.httpStatus === 302,
  );

  const oversized = await setup("oversized");
  await assert.rejects(
    () => requestZenResponses({
      env: oversized.env,
      spendLedgerKey: oversized.ledger.key,
      body,
      context: "test",
      fetchImpl: (async () => new Response("x", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "65537",
        },
      })) as typeof fetch,
    }),
    (error: unknown) => isZenResponsesTransportError(error)
      && error.code === "zen_responses_body_too_large",
  );

  const timeout = await setup("timeout");
  await assert.rejects(
    () => requestZenResponses({
      env: timeout.env,
      spendLedgerKey: timeout.ledger.key,
      body,
      context: "test",
      timeoutMilliseconds: 20,
      fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
    }),
    (error: unknown) => isZenResponsesTransportError(error)
      && error.code === "zen_responses_timeout"
      && error.receipt.codeLocation
        === "visual-catalogue-zen-responses.requestZenResponses.timeout_race",
  );
});

test("provider, model, payload, discovery, attachment-host, and existing providers remain unchanged", async () => {
  const body = buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 });
  assert.equal(body.model, ZEN_RESPONSES_MODEL);
  assert.equal(body.store, false);
  const transport = await readFile(
    new URL("../src/visual-catalogue-zen-responses.ts", import.meta.url),
    "utf8",
  );
  assert.match(transport, /MAX_RESPONSE_BYTES = 64 \* 1024/);
  assert.match(transport, /ZEN_RESPONSES_TIMEOUT_MS = 60_000/);
  assert.match(transport, /globalThis\.fetch\.bind\(globalThis\)/);
  assert.doesNotMatch(
    transport,
    /duplex:|keepalive:|OPENCODE_GO|mimo-v2\.5|OPENAI_API_KEY|api\.openai\.com/,
  );
  const discovery = await readFile(
    new URL("../src/visual-classifier-zen-model-discovery.ts", import.meta.url),
    "utf8",
  );
  assert.match(discovery, /ZEN_RESPONSES_MODELS_ENDPOINT/);
  assert.doesNotMatch(discovery, /requestZenResponses|responses_post/);
  const attachments = await readFile(
    new URL("../src/connector-files.ts", import.meta.url),
    "utf8",
  );
  assert.match(attachments, /oaisdmntpr\[a-z0-9\]\+/);
});
