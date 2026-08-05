# ODL-REQ-030 — bounded Zen Responses redirect handling

## Diagnosis

The documented OpenCode Zen Responses endpoint remains `https://opencode.ai/zen/v1/responses`, and the provider's current route source defines a POST handler at that exact path. Non-secret structural probes on 2026-08-05 reached both `/zen/v1/responses` and `/zen/v1/responses/` directly and received an authentication response without a `Location` header. The unrelated `console.opencode.ai` host did not expose this API route.

The production failure occurred with `redirect: "error"` before an HTTP response was exposed to the transport. The repair therefore keeps the documented canonical endpoint and replaces automatic redirect rejection with a manual, fail-closed policy rather than enabling unrestricted redirect following.

## Policy

The transport:

- dispatches the documented canonical URL directly;
- accepts at most one `307` or `308` redirect;
- accepts only a same-origin transition between the exact paths `/zen/v1/responses` and `/zen/v1/responses/` on `https://opencode.ai:443`;
- preserves POST, the serialized body, Authorization, Content-Type, AbortSignal, and the single end-to-end timeout only for that exact accepted transition;
- rejects `301`, `302`, and `303`, cross-origin targets, non-HTTPS targets, URL userinfo, IP literals, unexpected ports, other paths, query strings, fragments, missing or malformed `Location`, loops, and additional hops;
- never stores complete redirect URLs, headers, credentials, request bodies, prompts, or provider responses in redirect receipts.

The existing provider, mode, model, credential binding, spend limits, response-size ceiling, model discovery, attachment-host validation, connector-file DNS safety validation, and all non-Visual lanes remain unchanged.

## Validation boundary

All redirect tests are deterministic and use injected fetch mocks. CI and bundle construction make no live provider or DNS calls. Visual capability acceptance is deliberately excluded from this engineering tranche.
