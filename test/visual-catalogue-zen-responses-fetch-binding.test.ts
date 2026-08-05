import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ZEN_RESPONSES_ENDPOINT,
  ZEN_RESPONSES_MODEL,
  buildZenResponsesRequest,
  createBoundedZenResponsesRedirectFetch,
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

function requestBody() {
  return buildZenResponsesRequest({ text: "x", maxOutputTokens: 64 });
}

async function rejectCode(
  scope: string,
  fetchImpl: typeof fetch,
  expectedCode: string,
) {
  const { env, ledger } = await setup(scope);
  await assert.rejects(
    () => requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: requestBody(),
      context: "test",
      fetchImpl,
    }),
    (error: unknown) => isZenResponsesTransportError(error) && error.code === expectedCode,
  );
}

test("direct canonical 200 uses a fresh manual RequestInit and sanitized receipt", async () => {
  const { env, ledger, r2 } = await setup("direct");
  const inits: RequestInit[] = [];
  const result = await requestZenResponses({
    env,
    spendLedgerKey: ledger.key,
    body: requestBody(),
    context: "capability:text_structured_output",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(input, ZEN_RESPONSES_ENDPOINT);
      if (!init) throw new Error("missing request init");
      inits.push(init);
      return new Response(JSON.stringify(completed()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.equal(result.text, "ok");
  assert.equal(inits.length, 1);
  const init = inits[0];
  assert.equal(Object.getPrototypeOf(init), Object.prototype);
  assert.equal(Object.getPrototypeOf(init.headers as object), Object.prototype);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.equal(typeof init.body, "string");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal?.aborted, false);
  assert.equal("duplex" in init, false);
  assert.equal("keepalive" in init, false);
  assert.equal(result.transportReceipt.redirectMode, "manual");
  assert.equal((result.transportReceipt as any).redirectDisposition, "direct_canonical");
  assert.equal((result.transportReceipt as any).redirectHopCount, 0);

  for (const receipt of receipts(r2)) {
    const rendered = JSON.stringify(receipt);
    for (const forbidden of ["zen-secret", "Bearer ", ZEN_RESPONSES_ENDPOINT]) {
      assert.equal(rendered.includes(forbidden), false, forbidden);
    }
    assert.equal(receipt.body, undefined);
    assert.equal(receipt.headers, undefined);
    assert.equal(receipt.requestInit, undefined);
  }
});

test("exact same-origin 307 and 308 slash normalization preserves POST, body, authorization, and timeout signal", async () => {
  for (const status of [307, 308]) {
    const { env, ledger } = await setup(`allowed-${status}`);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: requestBody(),
      context: "test",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!init) throw new Error("missing request init");
        calls.push({ url: String(input), init });
        if (calls.length === 1) {
          return new Response(null, {
            status,
            headers: { location: "/zen/v1/responses/" },
          });
        }
        return new Response(JSON.stringify(completed("redirected")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    assert.equal(result.text, "redirected");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://opencode.ai/zen/v1/responses");
    assert.equal(calls[1].url, "https://opencode.ai/zen/v1/responses/");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[1].init.method, "POST");
    assert.equal(calls[0].init.body, calls[1].init.body);
    assert.equal(
      (calls[0].init.headers as Record<string, string>).authorization,
      (calls[1].init.headers as Record<string, string>).authorization,
    );
    assert.equal(calls[0].init.signal, calls[1].init.signal);
    assert.equal((result.transportReceipt as any).redirectDisposition, "accepted_bounded_redirect");
    assert.equal((result.transportReceipt as any).redirectStatus, status);
    assert.equal((result.transportReceipt as any).redirectHopCount, 1);
    assert.equal((result.transportReceipt as any).redirectOriginClass, "same_origin");
    assert.equal((result.transportReceipt as any).redirectAllowlistDecision, "allowed");
    assert.equal((result.transportReceipt as any).finalEndpointClass, "documented_slash_variant");
  }
});

test("absolute same-origin redirect is accepted but authorization never crosses an unallowlisted origin", async () => {
  const allowedCalls: string[] = [];
  const allowed = createBoundedZenResponsesRedirectFetch(
    (async (input: RequestInfo | URL) => {
      allowedCalls.push(String(input));
      return allowedCalls.length === 1
        ? new Response(null, {
            status: 308,
            headers: { location: "https://opencode.ai/zen/v1/responses/" },
          })
        : new Response("ok", { status: 200 });
    }) as typeof fetch,
  );
  const controller = new AbortController();
  await allowed(ZEN_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: { authorization: "Bearer private", "content-type": "application/json" },
    body: "{}",
    redirect: "error",
    signal: controller.signal,
  });
  assert.deepEqual(allowedCalls, [
    "https://opencode.ai/zen/v1/responses",
    "https://opencode.ai/zen/v1/responses/",
  ]);

  let calls = 0;
  await rejectCode(
    "cross-origin",
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer zen-secret");
      return new Response(null, {
        status: 307,
        headers: { location: "https://example.invalid/zen/v1/responses" },
      });
    }) as typeof fetch,
    "zen_responses_redirect_untrusted_host",
  );
  assert.equal(calls, 1);
});

test("301, 302, and 303 are rejected rather than rewriting POST to GET", async () => {
  for (const status of [301, 302, 303]) {
    await rejectCode(
      `rewrite-${status}`,
      (async () => new Response(null, {
        status,
        headers: { location: "/zen/v1/responses/" },
      })) as typeof fetch,
      "zen_responses_redirect_unsafe_method_rewrite",
    );
  }
});

test("HTTP downgrade, userinfo, IP literals, unexpected ports, paths, queries, missing and malformed Location fail closed", async () => {
  const cases: Array<[string, string | null, string]> = [
    ["downgrade", "http://opencode.ai/zen/v1/responses", "zen_responses_redirect_protocol_downgrade"],
    ["userinfo", "https://user:pass@opencode.ai/zen/v1/responses", "zen_responses_redirect_userinfo_rejected"],
    ["ipv4", "https://127.0.0.1/zen/v1/responses", "zen_responses_redirect_ip_literal_rejected"],
    ["ipv6", "https://[::1]/zen/v1/responses", "zen_responses_redirect_ip_literal_rejected"],
    ["port", "https://opencode.ai:8443/zen/v1/responses", "zen_responses_redirect_unexpected_port"],
    ["path", "https://opencode.ai/zen/v1/messages", "zen_responses_redirect_untrusted_path"],
    ["query", "https://opencode.ai/zen/v1/responses?token=secret", "zen_responses_redirect_sensitive_query_rejected"],
    ["missing", null, "zen_responses_redirect_location_missing"],
    ["malformed", "https://[::1", "zen_responses_redirect_location_malformed"],
  ];
  for (const [name, location, code] of cases) {
    await rejectCode(
      name,
      (async () => {
        const headers = new Headers();
        if (location !== null) headers.set("location", location);
        return new Response(null, { status: 307, headers });
      }) as typeof fetch,
      code,
    );
  }
});

test("redirect loop and hop ceiling are deterministic", async () => {
  let loopCalls = 0;
  await rejectCode(
    "loop",
    (async () => {
      loopCalls += 1;
      return loopCalls === 1
        ? new Response(null, { status: 307, headers: { location: "/zen/v1/responses/" } })
        : new Response(null, { status: 307, headers: { location: "/zen/v1/responses" } });
    }) as typeof fetch,
    "zen_responses_redirect_hop_ceiling_exceeded",
  );
  assert.equal(loopCalls, 2);

  const controller = new AbortController();
  const loopFetch = createBoundedZenResponsesRedirectFetch(
    (async () => new Response(null, {
      status: 307,
      headers: { location: "/zen/v1/responses" },
    })) as typeof fetch,
  );
  await assert.rejects(
    () => loopFetch(ZEN_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { authorization: "Bearer private", "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.message === "zen_responses_redirect_loop",
  );
});

test("detached fetch and generic network TypeErrors remain precisely classified without leakage", async () => {
  const raw = "Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.";
  const { env, ledger } = await setup("illegal-invocation");
  await assert.rejects(
    () => requestZenResponses({
      env,
      spendLedgerKey: ledger.key,
      body: buildZenResponsesRequest({ text: "PRIVATE_PROMPT", maxOutputTokens: 64 }),
      context: "test",
      fetchImpl: (async () => {
        throw new TypeError(raw);
      }) as typeof fetch,
    }),
    (error: unknown) => {
      if (!isZenResponsesTransportError(error)) return false;
      assert.equal(error.code, "zen_responses_fetch_illegal_invocation");
      assert.equal(error.receipt.localErrorClass, "runtime_fetch_binding");
      assert.equal((error.receipt as any).redirectMode, "manual");
      const rendered = JSON.stringify(error.receipt);
      for (const forbidden of [raw, "PRIVATE_PROMPT", "zen-secret", "https://", "Bearer "]) {
        assert.equal(rendered.includes(forbidden), false, forbidden);
      }
      return true;
    },
  );

  await rejectCode(
    "network-error",
    (async () => {
      throw new TypeError("network down");
    }) as typeof fetch,
    "zen_responses_network_error",
  );
});

test("global fetch is receiver-bound and every dispatch receives a fresh plain RequestInit", async () => {
  const originalFetch = globalThis.fetch;
  const inits: RequestInit[] = [];
  const runtimeFetch = async function(
    this: unknown,
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    if (!init) throw new Error("missing request init");
    inits.push(init);
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
    const first = await setup("bound-global-1");
    const second = await setup("bound-global-2");
    for (const current of [first, second]) {
      await requestZenResponses({
        env: current.env,
        spendLedgerKey: current.ledger.key,
        body: requestBody(),
        context: "test",
      });
    }
    assert.equal(inits.length, 2);
    assert.notEqual(inits[0], inits[1]);
    assert.notEqual(inits[0].signal, inits[1].signal);
    assert.equal(inits[0].redirect, "manual");
    assert.equal(inits[1].redirect, "manual");
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
});

test("explicit null fails closed before global fetch", async () => {
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
        body: requestBody(),
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
});

test("one 60-second budget spans redirect handling and response ceilings still apply", async () => {
  const timeout = await setup("timeout");
  await assert.rejects(
    () => requestZenResponses({
      env: timeout.env,
      spendLedgerKey: timeout.ledger.key,
      body: requestBody(),
      context: "test",
      timeoutMilliseconds: 20,
      fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
    }),
    (error: unknown) => isZenResponsesTransportError(error)
      && error.code === "zen_responses_timeout"
      && error.receipt.codeLocation === "visual-catalogue-zen-responses.requestZenResponses.timeout_race",
  );

  const oversized = await setup("oversized");
  await assert.rejects(
    () => requestZenResponses({
      env: oversized.env,
      spendLedgerKey: oversized.ledger.key,
      body: requestBody(),
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
});

test("model discovery, provider identity, attachment DNS safety, timeout, and 64 KiB ceiling remain unchanged", async () => {
  const body = requestBody();
  assert.equal(body.model, ZEN_RESPONSES_MODEL);
  assert.equal(body.store, false);

  const base = await readFile(
    new URL("../src/visual-catalogue-zen-responses-base.ts", import.meta.url),
    "utf8",
  );
  assert.match(base, /MAX_RESPONSE_BYTES = 64 \* 1024/);
  assert.match(base, /ZEN_RESPONSES_TIMEOUT_MS = 60_000/);
  assert.match(base, /globalThis\.fetch\.bind\(globalThis\)/);
  assert.doesNotMatch(base, /OPENCODE_GO|mimo-v2\.5|OPENAI_API_KEY|api\.openai\.com/);

  const wrapper = await readFile(
    new URL("../src/visual-catalogue-zen-responses.ts", import.meta.url),
    "utf8",
  );
  assert.match(wrapper, /ZEN_RESPONSES_REDIRECT_MAX_HOPS = 1/);
  assert.match(wrapper, /target\.hostname\.toLowerCase\(\) !== ZEN_RESPONSES_ALLOWED_HOST/);
  assert.match(wrapper, /target\.search !== "" \|\| target\.hash !== ""/);
  assert.doesNotMatch(wrapper, /redirect:\s*"follow"/);

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
