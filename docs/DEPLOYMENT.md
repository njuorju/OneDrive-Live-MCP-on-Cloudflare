# Deployment and in-place upgrade guide

This guide deploys the connector as a Cloudflare Worker and connects it to ChatGPT as a remote OAuth MCP server. For an existing production Worker, follow the in-place path and preserve the live rollback target, bindings, secrets, and Durable Object migrations.

## Prerequisites

- Node.js 22.18 or newer.
- A Cloudflare account with Workers, KV, Durable Objects, Workers AI, and the Images binding available.
- A personal Microsoft account with OneDrive.
- A Microsoft Entra application configured for personal accounts.
- Delegated `Files.ReadWrite` and `User.Read` on that application.
- ChatGPT developer mode or an equivalent custom MCP app connection surface.

## 1. Capture the existing production deployment

Before changing source or configuration, inspect the live Worker and record:

- Worker name and account;
- currently active Worker version ID;
- current deployment ID and traffic allocation;
- immediate previous known-good version;
- compatibility date and flags;
- KV namespace bindings;
- Durable Object class/binding names and every migration tag;
- Workers AI and Images bindings;
- non-secret variables, especially `ONEDRIVE_ROOT`;
- secret names, never secret values;
- routes/custom domains and observability settings.

Confirm that the previous version can be selected as a rollback target through Cloudflare's version/deployment controls without rebuilding from source.

Do not use the repository's sanitized `wrangler.jsonc` as the production source of truth until it has been reconciled with live configuration.

## 2. Prepare the feature branch

```powershell
git fetch origin
git switch work/onedrive-write-images
npm ci
npx wrangler login
```

Confirm the repository has no local secrets or downloaded OneDrive content:

```powershell
git status --short
```

## 3. Reconcile Worker configuration

The tracked `wrangler.jsonc` is a sanitized template. Preserve the production Worker name and account-specific bindings while adding the new bounded settings and Images binding.

Required non-secret variables:

```jsonc
"vars": {
  "CONNECTOR_NAME": "OneDrive Live MCP",
  "ONEDRIVE_ROOT": "Work",
  "MAX_FILE_MB": "20",
  "MAX_ORIGINAL_FILE_MB": "25",
  "MAX_TEXT_WRITE_KB": "512",
  "MAX_READ_CHARS": "50000",
  "CACHE_TTL_SECONDS": "604800",
  "MAX_IMAGE_INPUT_MB": "15",
  "MAX_IMAGE_PIXELS": "40000000",
  "MAX_IMAGE_DIMENSION": "8192",
  "MAX_IMAGE_PAGES": "8",
  "IMAGE_PROCESSING_TIMEOUT_MS": "15000"
}
```

Required bindings:

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "MCP_OBJECT", "class_name": "OneDriveMCP" },
    { "name": "AUTH_STATE", "class_name": "AuthState" }
  ]
},
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "THE_EXISTING_PRODUCTION_NAMESPACE_ID" }
],
"ai": { "binding": "AI" },
"images": { "binding": "IMAGES" }
```

The existing migration history must remain unchanged:

```jsonc
"migrations": [
  { "new_sqlite_classes": ["OneDriveMCP"], "tag": "v1" },
  { "new_sqlite_classes": ["AuthState"], "tag": "v2" }
]
```

Do not rename classes, delete tags, reorder history, or introduce a new migration merely for this source upgrade.

## 4. Confirm secrets by name

The production Worker must reference these Cloudflare secrets:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `OWNER_MICROSOFT_ID`
- `COOKIE_ENCRYPTION_KEY`

Do not rotate, print, copy into chat, or commit secret values during a routine upgrade.

For a new deployment only, set them with:

```powershell
npx wrangler secret put MICROSOFT_CLIENT_ID
npx wrangler secret put MICROSOFT_CLIENT_SECRET
npx wrangler secret put OWNER_MICROSOFT_ID
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

## 5. Microsoft Entra configuration

The Entra application should support personal Microsoft accounts and have the exact Web callback:

```text
https://your-worker.your-subdomain.workers.dev/callback
```

Retain only delegated:

- `Files.ReadWrite`
- `User.Read`

The Worker requests `offline_access` during OAuth. Do not add application permissions or broader delegated scopes.

After this upgrade, the connector sends `prompt=consent` and rejects stored or refreshed sessions that do not contain `Files.ReadWrite`.

## 6. Validate source and bundle

```powershell
npm run type-check
npm test
npm audit --audit-level=high
npx wrangler deploy --dry-run --outdir dist
```

The dry run must use reconciled production bindings or a non-secret validation copy. It must not contain placeholders when used for deployment.

Review the diff for:

```powershell
git diff main...work/onedrive-write-images -- wrangler.jsonc
```

Confirm the migration array is unchanged and no unrelated Cloudflare resource is referenced.

## 7. Deploy a new Worker version

Deploy only after tests and bundle validation pass:

```powershell
npx wrangler deploy
```

Record:

- branch;
- commit SHA;
- new Worker version ID;
- new deployment ID;
- captured rollback version ID;
- migration status;
- bindings used;
- test commands and results.

Do not delete or overwrite the captured rollback version.

## 8. Check liveness and readiness

Liveness:

```text
GET https://your-worker.your-subdomain.workers.dev/health
```

Expected shape:

```json
{"ok":true,"service":"nikolay-onedrive-mcp"}
```

Authenticated readiness:

```text
GET https://your-worker.your-subdomain.workers.dev/ready
```

Readiness verifies required configuration, bindings, `AuthState` storage, the configured root, stored OAuth authorization, and bounded Microsoft Graph reachability. It returns sanitized error categories and correlation IDs, never tokens, account IDs, drive IDs, Graph URLs, or upstream response bodies.

A successful liveness response alone is not deployment acceptance.

## 9. Reconnect ChatGPT and complete fresh consent

Disconnect the existing OneDrive custom app/connector in ChatGPT, then connect the same MCP endpoint again:

```text
https://your-worker.your-subdomain.workers.dev/mcp
```

The browser sequence is:

```text
ChatGPT authorization
  -> Worker consent page
  -> Microsoft sign-in and fresh consent
  -> Worker callback
  -> ChatGPT
```

Confirm the Microsoft consent includes `Files.ReadWrite`. A session that still contains only `Files.Read` must be rejected with fresh-consent guidance.

Refresh MCP discovery and verify all expected tools and annotations.

## 10. Expected tool inventory

Read-only:

- `onedrive_status`
- `search_onedrive`
- `search_onedrive_work`
- `search`
- `list_onedrive_folder`
- `list_onedrive_work_folder`
- `read_onedrive_file`
- `read_onedrive_work_file`
- `fetch`
- `list_visual_assets`
- `get_image_metadata`
- `fetch_image_for_analysis`
- `fetch_original_file`

Mutating, non-destructive:

- `create_folder`
- `create_text_file`
- `replace_text_file`
- `rename_item`
- `move_item`

No deletion, sharing, permission, public-link, arbitrary upload, or arbitrary Graph tool should appear.

## 11. Bounded write acceptance

Inside the configured root:

1. Create `_MCP_WRITE_TEST`.
2. Create `_MCP_WRITE_TEST/destination`.
3. Create `_MCP_WRITE_TEST/acceptance.md` with known UTF-8 text.
4. Read it back with the existing text-extraction tool.
5. Replace it using the current eTag.
6. Attempt replacement with the old eTag and verify `etag_conflict`.
7. Rename it to `renamed.md`.
8. Move it into `destination`.
9. Read it back from the new location.
10. Verify an out-of-root source item is rejected.
11. Verify `../` or another out-of-root destination is rejected.

Keep the test folder because the connector intentionally has no deletion tool.

Record item IDs and eTags only in the private acceptance report, not public logs.

## 12. Bounded image acceptance

Use non-sensitive controlled fixtures inside `_MCP_WRITE_TEST`:

- one landscape JPG or PNG;
- one portrait JPG or PNG;
- one HEIC or SVG conversion fixture;
- one malformed or unsupported fixture.

Perform:

1. Discover them with `list_visual_assets`.
2. Verify dimensions, orientation, modified date, and eTag.
3. Fetch a JPG or PNG with `fetch_image_for_analysis`.
4. Confirm ChatGPT receives actual visual content and accurately describes a deliberate visible feature.
5. Confirm the response is not merely prose, Markdown, metadata, or OCR text.
6. Fetch the same item with `fetch_original_file`.
7. Verify exact bytes, filename, MIME type, size, item ID, and eTag.
8. Use the returned original in a one-slide test PPTX.
9. Reopen or render the PPTX and confirm the image is embedded and visible.
10. Test HEIC or SVG preview conversion.
11. Confirm `fetch_original_file` still returns unchanged source bytes.
12. Verify out-of-root, malformed, oversized, and excessive-pixel fixtures are rejected.
13. Inspect tool output and sanitized logs for token, account ID, drive ID, Graph URL, upstream-body, public-link, or anonymous-link leakage.

A successful Microsoft Graph download is not evidence that ChatGPT vision or PPTX embedding works. Both must be demonstrated through the deployed connector.

## 13. Rollback

Use Cloudflare's deployment/version controls to create a new deployment from the captured previous Worker version. Do not rebuild from `main` as the first rollback action.

After rollback:

1. confirm traffic is assigned to the rollback version;
2. verify `/health`;
3. verify the previous read tools through ChatGPT;
4. document the failed version/deployment and reason;
5. leave Durable Object migrations intact.

Because this patch preserves the existing migrations, source rollback should not require migration reversal. Binding compatibility must still be checked before rollback, especially if the new deployment added an Images binding or changed non-secret variables.

## 14. Final deployment record

Store a private report containing:

- repository and branch;
- commit SHA;
- deployed Worker version and deployment ID;
- rollback Worker version;
- OAuth scopes;
- migration status;
- binding names and account-specific resource IDs where appropriate;
- secret names only;
- final tool inventory;
- protocol mechanism for MCP image content and exact-file resources;
- tests and results;
- write acceptance results;
- image-analysis and original-file/PPTX acceptance results;
- unresolved limitations;
- rollback procedure.

## New deployment bootstrap

For a brand-new Worker rather than an in-place upgrade, create the KV namespace, reconcile the sanitized template, set the four secrets, deploy, configure the Entra callback, then complete the same readiness and acceptance process above.

## Removing a deployment

Deletion is a separate destructive administrative action and is not part of an upgrade. Disconnect ChatGPT first, then remove Worker, Entra, KV, and Durable Object resources only with explicit owner approval.
