# Integrated source-integrity and visual architecture

This upgrade extends the existing root-scoped OneDrive MCP connector through one shared service layer. It does not add a parallel filesystem implementation.

## Invariants

- Microsoft Graph delegated permissions remain `Files.ReadWrite`, `User.Read`, and OAuth `offline_access` only.
- Every live item is re-resolved and ancestry-validated immediately before download, binary return, upload, copy, render, move, rename, or recycle.
- Cross-drive, remote/shared, path-traversal, ambiguous, stale, and overwrite-prone operations fail closed.
- Permanent deletion, recycle-bin emptying, sharing, public links, application permissions, and `.All` scopes remain unavailable.
- Existing MCP tool names and schemas remain unchanged.

## Shared layers

1. **Verified OneDrive access** — recursive enumeration, continuation handling, canonical root validation, verified downloads, conflict-safe uploads, Graph copy monitoring, and recycle semantics.
2. **Immutable snapshots** — eTag-keyed records stored in bounded Durable Object storage, paginated queries, stable filters, and live comparison.
3. **Deterministic extraction** — exact SHA-256, normalized-text hashing, OOXML package inspection, HTML shell diagnostics, document metadata, and bounded error isolation.
4. **Visual provenance** — loose images and document visuals share stable IDs derived from source item ID, eTag, object coordinates, and extraction mode.
5. **Rendering** — PDF pages render directly; Office documents are converted to PDF by Microsoft Graph and then rendered. Cloudflare Browser Run is used only for requested page/slide rendering and is bounded by the account's free-plan allowance.
6. **Jobs and plans** — one job model covers snapshots, hashes, rendering, copies, duplicate analysis, integrity execution, and final diffs. Mutations run serially under a scope lock with per-action preconditions.
7. **Audit evidence** — operation records contain IDs, paths, hashes, eTags, timestamps, and structured errors, but never tokens, authorization headers, Graph download URLs, render URLs, raw document bodies, image bytes, or secrets.

## Storage

Existing Durable Object storage is used for snapshot metadata, sharded snapshot records, plans, locks, jobs, and operation logs. Existing KV remains a deterministic content cache keyed by item ID, eTag, and operation options. No R2 bucket is required.

## Rendering and billing

The implementation adds a Browser Run binding but does not create a paid subscription or pay-as-you-go resource. Workers Free includes a capped Browser Run allowance; operations fail with a structured quota error rather than enabling billable overage.

## Cleanup

Synthetic acceptance fixtures are created only inside a timestamped folder under the configured root. The folder is recycled through its own validated cleanup plan after results are recorded. No placeholder files, temporary routes, public buckets, or orphan objects are retained.
