# Paid Workers architecture

## Purpose

This upgrade moves connector work that must survive an MCP response or WebSocket disconnection out of request-scoped `waitUntil()` execution and into Cloudflare Workflows and Queues. The existing OneDrive root boundary, OAuth implementation, integrity-plan validation, mutation executor, lease, fencing and reservation controls remain authoritative and unchanged.

## Logical architecture

```text
ChatGPT MCP request
        |
        v
Thin MCP gateway (existing Worker / MCP agent)
        |
        v
Cloudflare Workflow (durable admission and retry boundary)
        |
        +--> PaidCoordinator Durable Object (SQLite registry and audit)
        +--> Queue (hash, extraction, duplicate, visual and render workers)
        +--> private R2 bucket (exact plan/payload/result/source/render bytes)
        `--> Browser Rendering (bounded PDF.js page rendering)
```

## Durable plan registry

`create_integrity_plan` now calculates a canonical request hash and reserves an operation record before invoking the existing plan builder. Equivalent retries return the same plan. If the MCP response disconnects after the legacy plan was stored, the wrapper locates the matching stored plan and completes registration instead of creating another draft.

Private R2 artifacts are stored under `plans/<operation-id>/`:

- canonical request JSON;
- exact plan JSON and CSV;
- payload manifest;
- exact UTF-8 bytes for every `CREATE_TEXT` or `REPLACE_TEXT` action.

The registry retains plan identity and definition after the short-lived source plan expires. Expired records are returned as `expired`, not `plan_not_found`. They cannot be executed from the archival record; callers can recover the definition and construct a fresh successor plan.

The following non-OneDrive lifecycle tools are added:

- `get_integrity_plan_definition`;
- `list_integrity_plans`;
- `abandon_integrity_plan`;
- `supersede_integrity_plan`.

Abandon and supersede operations first refuse active leases, reservations or execution. They only update the private registry and never mutate OneDrive.

## Durable jobs

Expensive read-only tool calls are admitted synchronously, assigned a durable job ID, and started through a Workflow instance. The Workflow records admission and places one message on `onedrive-live-mcp-jobs`. The queue consumer runs independently of the MCP connection and writes the exact MCP tool result to private R2.

Queued tools include hashing, source and visual duplicate analysis, document inspection, document-visual enumeration and page rendering. Hash jobs persist cursor chunks and continue until complete. The existing resumable source-snapshot runner remains unchanged and continues using its validated Durable Object scheduling, checkpointing and lease implementation rather than being replaced by the generic queue wrapper.

Use `await_paid_job` for one bounded long-poll rather than repeatedly invoking `get_job_status`, then `get_paid_job_result` for the exact stored result.

## Large documents and rendering

Large PDF or Microsoft Office render sources are streamed directly from Microsoft Graph into private R2. The Worker does not materialize the entire source in request memory. Size and PDF signature checks fail closed. A short-lived signed route serves the private R2 object with byte-range support to vendored PDF.js inside Cloudflare Browser Rendering. Source render caches are deleted after completion.

Defaults:

- paid render source limit: 500 MB;
- queue-side in-memory document parsing limit: 40 MB;
- ordinary synchronous MCP document limit: unchanged at 20 MB;
- queue batch size: 1;
- queue concurrency: 3;
- queue retries: 5 with a dead-letter queue.

## Stable document visuals

Queued `list_document_visuals` returns stable IDs derived from the authenticated user, OneDrive item ID, source eTag, visual key and exact embedded SHA-256. Exact embedded bytes, SHA-256 and perceptual hashes are persisted. PDF DCT image objects include discovered parent-page relationships by traversing page resource and nested XObject references. IDs remain resolvable while the unchanged source record and private artifacts are retained; they are no longer expiring opaque tokens.

## Observability

The PaidCoordinator records an append-only audit for plan reservations, plan links, state transitions, job transitions and visual registration. Structured Worker logs include job, workflow and correlation IDs. Workers invocation logs are enabled at 100% and automatic traces at 10%.

## Required Cloudflare resources

- R2 bucket: `onedrive-live-mcp-artifacts` (private; no public access);
- Queue: `onedrive-live-mcp-jobs`;
- Dead-letter Queue: `onedrive-live-mcp-jobs-dlq`;
- Workflow: `onedrive-live-mcp-durable-jobs`;
- SQLite Durable Object class: `PaidCoordinator` (migration `v3`);
- existing Browser Rendering, Images, OAuth KV and Durable Object bindings.

R2 must be activated for the account before the bucket can be created or this version can be deployed. Do not deploy a partial configuration without all bindings.

## Acceptance gates

1. CI type-check and tests pass.
2. R2 is activated and the private bucket exists.
3. Both Queues exist and the worker consumer/DLQ bindings deploy.
4. Deployment reports the expected repository SHA and all paid bindings.
5. `get_paid_architecture_status` reports all components ready.
6. Read-only fixture tests prove idempotent plan creation, plan recovery after a deliberately disconnected response, queued job completion, large-PDF page rendering, stable visual IDs/hashes/parent pages, and durable audit retrieval.
7. Any connector-created OneDrive fixture is removed before completion.
8. No existing UCA integrity plan is validated or executed during acceptance.
