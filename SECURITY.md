# Security policy and data boundaries

## Intended use

This is a private single-owner connector for one configured folder tree in personal OneDrive. It is not a general Microsoft Graph proxy.

## Microsoft permissions

Only delegated `Files.ReadWrite`, delegated `User.Read`, and OAuth `offline_access` are allowed. Do not grant `.All`, Sites, directory, application, or tenant-wide permissions. Stored/refreshed sessions lacking `Files.ReadWrite` fail closed.

## Root boundary

For every read, binary return, render, upload, copy, rename, move, and recycle operation, the Worker resolves the configured root and live item, walks ancestry on the same drive, rejects remote/shared/deleted/ambiguous/cyclic items, and revalidates immediately before the operation. Paths are root-relative and repeatedly decoded before traversal/control/absolute/ambiguous path checks.

## Excluded operations

The MCP surface has no sharing/public-link/permission tool, cross-drive operation, arbitrary Graph request, arbitrary URL fetch, unrestricted upload, permanent deletion, or recycle-bin emptying. There is no generic delete tool.

The only recycle path is `execute_integrity_plan`. A file/folder can be recycled only when explicitly present in a successfully validated plan, unambiguous, approved by final decision, covered by a prepared deletion-log record, still inside scope, and still matching live ID/path/eTag/size/SHA preconditions. Folder recycling additionally requires represented descendants, completed child actions, safe emptiness/approval, non-root status, and no structural-placeholder protection.

## Snapshots, plans, and jobs

Snapshot/plan/job data is bounded, expires after 24 hours, and is stored in existing Durable Object storage. Execution tokens are encrypted/signed with the connector key and expire after 15 minutes. Overlapping mutation scopes are locked. Individual read failures may be isolated; mutation dependency failures stop dependent actions.

## Document and OOXML safety

OOXML parsing rejects ZIP traversal, excessive entries, compressed/uncompressed limits, excessive ratios, malformed packages, and time/memory bounds. No executable extraction occurs. Bulk OCR is disabled. Image-only files return evidence instead of guessed text.

## Rendering and binary safety

Cloudflare Browser Run is used only for requested page/slide/region/contact-sheet rendering. Office inputs are converted to PDF through authenticated Graph first. No signed render URL is returned. Generated uploads are allowlisted, conflict-safe, root-validated, and hash-reported. Upload-session URLs are short-lived Microsoft URLs and never receive the Graph bearer token. Copy monitors are polled to completion; HTTP 202 is not success.

## Secrets and logging

Worker secrets: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `OWNER_MICROSOFT_ID`, `COOKIE_ENCRYPTION_KEY`.

Never log or return access/refresh tokens, authorization headers, OAuth codes/state, cookies, Graph download URLs, upload-session URLs, copy-monitor URLs, Browser Run URLs, raw upstream bodies, raw document content, image bytes, secrets, or unnecessary account/drive identifiers. Sanitized errors contain category, retryability, optional status, and a connector correlation ID.

## Caching and temporary data

Deterministic cache keys include item/version/options material so eTag changes invalidate results. Image previews and exact originals are not written to the text cache. No R2 bucket is required by this architecture. Synthetic acceptance fixtures must be recycled through their own approved cleanup plan.

## Deployment and rollback

Capture the active Worker version, deployment, bindings, variables, secret names, routes, compatibility settings, observability, and migrations before upgrade. Preserve `v1 OneDriveMCP` and `v2 AuthState`. Roll back by deploying the captured version. Source tests are not evidence of deployed rendering, OAuth, or mutation acceptance.

## Vulnerability reporting

Do not publish credentials, private Worker URLs, account identifiers, OneDrive content, OAuth URLs, or resource tokens in a public issue. Use the repository owner's private disclosure channel.
