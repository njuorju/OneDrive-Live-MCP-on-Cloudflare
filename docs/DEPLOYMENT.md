# Deployment, acceptance, rollback, and Entra checks

## 1. Capture production before changing anything

Record the active Worker version/deployment/traffic, production-aligned Git commit, bindings, variables, secret names, compatibility date/flags, routes, observability, Durable Object migrations, and rollback procedure. Do not rebuild the rollback target.

For this repository, preserve migrations exactly:

```jsonc
"migrations": [
  { "new_sqlite_classes": ["OneDriveMCP"], "tag": "v1" },
  { "new_sqlite_classes": ["AuthState"], "tag": "v2" }
]
```

## 2. Reconcile bindings

Preserve account-specific values. Required bindings are:

```jsonc
"durable_objects": { "bindings": [
  { "name": "MCP_OBJECT", "class_name": "OneDriveMCP" },
  { "name": "AUTH_STATE", "class_name": "AuthState" }
]},
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "EXISTING_ID" }],
"ai": { "binding": "AI" },
"images": { "binding": "IMAGES" },
"browser": { "binding": "BROWSER" }
```

No new Durable Object migration, R2 bucket, D1 database, Queue, Workflow, route, or secret is needed. Scheduled execution ownership and idempotency records are stored as bounded keys inside the existing `AuthState` SQLite Durable Object.

## 3. Validate source

```bash
npm ci
npm run type-check
npm test
npm audit --audit-level=high --omit=dev
npm audit --audit-level=high
npx wrangler deploy --dry-run --outdir dist
```

The production dependency audit is a strict gate. Record the full dependency advisory report as well. Inspect bundle size and plan limits before uploading. All type checks, tests, production audits, and the Worker dry-run must pass.

## 4. Staged deployment

Upload a new Worker version with all live bindings/vars/secrets/routes/observability/migrations preserved. Route no production traffic until the staged checks pass where account controls permit. Record the staged version ID.

Check:

- `/health` returns a successful liveness response;
- `/ready` verifies configuration, state storage, authorization, root access, and required bindings;
- OAuth callback remains the production callback;
- existing compatibility tools remain discoverable;
- all integrated tools are discoverable with explicit schemas;
- `execute_integrity_plan` requires `executionToken`, `ownerType`, `ownerId`, caller UUID `invocationId`, and `correlationId`;
- `get_integrity_plan_execution_state` is present and `get_integrity_plan_status` maps to the same implementation;
- ordinary live search/list/read/image/original/text-write behavior remains compatible.

Inspect the built Worker bundle or authenticated MCP `tools/list` result before production traffic. Confirm the canonical execution-state name and every required execution input are present. A source-only schema assertion is not sufficient for final production acceptance.

## 5. Synthetic acceptance folder and non-mutating execution fixture

Do not reorganize the real source library during deployment. Create only:

`Connector_Integrated_Acceptance_Test_<UTC timestamp>`

inside the configured root when file-level acceptance is required. Populate it with deterministic generated fixtures: visual PDF, PPTX raster/composite, DOCX image/caption, substantive and shell HTML, normalized-equivalent document pair, exact/near images, nested and empty folders, >200 tiny files, and an intentionally flawed catalogue.

Acceptance must verify:

1. all existing tools;
2. recursive snapshot and >200 pagination;
3. stable parallel snapshot queries;
4. exact/normalized/perceptual hashing;
5. image-only status and HTML shell diagnostics;
6. PPTX/DOCX exact media extraction;
7. exact PDF/PowerPoint/Word page and region rendering;
8. contact sheet and binary save;
9. exact/near visual duplicates;
10. monitored copy completion;
11. catalogue error detection;
12. dry-run plan creation;
13. ambiguity/final-decision/eTag/SHA/scope/cross-drive blocks;
14. approved rename, move, file recycle, and generated-folder recycle;
15. absence of permanent deletion;
16. before/after diff limited to approved operations;
17. no changes outside the test scope;
18. no temporary Browser Run/R2 artefacts.

For scheduled execution and lease ownership, prefer an isolated non-mutating fixture that does not issue Microsoft Graph mutations. Verify:

1. `ownerType: scheduled_task`, the bounded owner ID, caller UUID, and correlation ID persist in lease, invocation, reservation, audit, logs, and result;
2. a concurrent invocation returns `alreadyExecuting: true`, the active owner and invocation, the same lease/fencing token, lease expiry, and retry guidance without mutation;
3. identical invocation metadata is idempotent;
4. conflicting invocation metadata is rejected;
5. a stale fencing token cannot write;
6. a later owner receives a strictly greater fencing token;
7. the fixture ends without an active lease or Graph mutation.

Record results first, then recycle any generated OneDrive test folder through its own validated scope-limited cleanup plan. Cleanup failure is deployment failure and must list every remaining generated item. Remove any temporary Worker, Cron Trigger, route, KV result key, or validation secret used by an isolated server-side fixture.

## 6. Merge and production deployment

After staged acceptance, merge the reviewed PR. Deploy production from the exact merged commit. Verify the Worker health, OAuth, configured root, old/new tool discovery, live reads, and one bounded production smoke test.

Verify that the active Worker version annotation and `WORKER_DEPLOYMENT_ID` equal the exact merged commit SHA. Preserve all Durable Object namespaces and migration tags. If any production check fails, immediately deploy the captured rollback Worker version. Do not perform repeated speculative fixes in production.

After success, remove the implementation branch, temporary routes/resources/fixtures, unused bindings/dependencies, and orphan objects. The merged PR should close normally.

## 7. Rollback

Create a new deployment pointing to the captured version ID. Confirm traffic, `/health`, OAuth, configured-root reads, and existing tools. Keep migrations intact. Record the failed version, failing check, and sanitized diagnostics.

## 8. Exact Microsoft Entra and ChatGPT manual checks

1. Open Microsoft Entra admin center.
2. Open **App registrations**.
3. Open the application used by `nikolay-onedrive-mcp`.
4. Open **API permissions**.
5. Confirm Microsoft Graph delegated `Files.ReadWrite`.
6. Confirm Microsoft Graph delegated `User.Read`.
7. Do not add `.All`, Sites, or application permissions.
8. Open **Authentication**.
9. Confirm the existing production Worker OAuth callback remains registered.
10. Do not enable implicit grant.
11. Do not create a second client secret unless the existing secret is actually expired.
12. If ChatGPT still shows a cached MCP schema after deployment, open **Settings → Apps → OneDrive Live**, disconnect and reconnect the existing app, then start a new chat for fresh tool discovery. Do not delete or recreate the app.
13. Repeat Microsoft consent only if the session lacks `Files.ReadWrite` or the connector deliberately invalidates stale sessions.
14. When consent is repeated, request only `openid profile offline_access User.Read Files.ReadWrite`.

## 9. Final deployment record

Record previous/new Worker version and deployment IDs, rollback target, default/implementation branch, merged SHA, PR, changed files, dependencies, bindings/migrations, temporary resources and cleanup, automated-test results, live acceptance and smoke results, exact execution and status schemas, persisted ownership evidence, overlap/fencing/idempotency evidence, verified old/new tools, formats, limits, known limitations, billing implications, Entra requirements, reconnection/reconsent, and proof that no test folder, temporary object, stale branch, abandoned PR, unused binding, placeholder, or dead implementation remains.
