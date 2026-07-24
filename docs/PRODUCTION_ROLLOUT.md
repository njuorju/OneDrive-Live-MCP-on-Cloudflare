# OneDriveLive production rollout and recovery

This is the bounded release procedure for Worker `nikolay-onedrive-mcp`. Reuse the existing R2 bucket, Queues, Workflow, Durable Object namespaces, KV namespace, Images, Browser Rendering and Workers AI bindings. Never create replacement production resources as part of a routine release.

> **Version 68 cannot be restored directly because production has crossed Durable Object migration boundary `v3`. Recovery must be a forward deployment that retains migration history through `v3`.**

## Normal release

1. Merge CI-green code through the repository's normal pull-request process and record the immutable merged source SHA.
2. Download the exact `worker-bundle-<sha>` artifact produced by CI. Do not rebuild a different tree for deployment.
3. Calculate and record SHA-256 for the downloaded artifact archive and every deployable bundle file. Compare these hashes with the downloaded artifact before upload.
4. Materialize the untracked production configuration:

   ```bash
   CLOUDFLARE_OAUTH_KV_NAMESPACE_ID=<existing OAUTH_KV namespace ID> \
     node scripts/materialize-production-wrangler.mjs
   ```

   The generated `.wrangler.production.generated.jsonc` contains no secrets, OAuth credentials, account IDs, Graph URLs or private file contents. It is ignored by Git.
5. Run the production dry run against the exact merged source or the exact validated artifact:

   ```bash
   npx wrangler deploy --dry-run --config .wrangler.production.generated.jsonc \
     --keep-vars --outdir dist-production
   ```

   When deploying the downloaded CI bundle, use Wrangler's `--no-bundle` mode and the exact artifact entry point so Wrangler does not rebuild different bytes.
6. Verify the dry-run bundle SHA-256 against the validated CI artifact. Stop on any mismatch.
7. Deploy with the generated configuration and `--keep-vars`. Existing encrypted secrets are preserved by Wrangler; `keep_vars` also preserves inherited production variables that are intentionally absent from the sanitized file.
8. Verify the deployed version has migration history `v1`, `v2`, `v3`; bindings `MCP_OBJECT`, `AUTH_STATE`, `PAID_COORDINATOR`, `ARTIFACTS`, `PAID_JOBS`, `PAID_WORKFLOW`, `OAUTH_KV`, `AI`, `IMAGES`, and `BROWSER`; Workers.dev enabled; no custom route; and no public R2 endpoint.
9. Run the bounded read-only smoke command:

   ```bash
   ONEDRIVELIVE_BEARER_TOKEN=<short-lived MCP token> \
   CLOUDFLARE_API_TOKEN=<scoped read token> \
   CLOUDFLARE_ACCOUNT_ID=<account ID> \
     npm run smoke:paid
   ```

   The smoke uses the existing dedicated acceptance fixture, performs one read-only durable hash job, checks idempotent replay, and makes no OneDrive mutation.
10. In ChatGPT, open **Plugin → OneDriveLive → Refresh** once.
11. Start a new conversation before testing newly added tools or changed schemas.

Remove `.wrangler.production.generated.jsonc`, `dist-production/`, downloaded artifact archives and temporary worktrees after the deployment record is complete.

## Failed release

Do not blindly roll back across a Durable Object migration. Do not delete or rename Durable Object classes or namespaces. Retain the complete migration history through `v3` and repair forward by deploying the last known-good source with the complete current binding inventory.

Do not recreate R2, Queue, DLQ, Workflow, KV or Durable Object resources. Do not create transport branches, deployment-only commits or push-triggered rollout workflows. A failed upload must not receive production traffic; promote a version to 100% only after the upload and binding operation succeeds completely.

## Plugin updates

Ordinary MCP tool additions, removals or schema changes require **Refresh** in the existing OneDriveLive plugin settings. Deleting and recreating the plugin is not the normal update method.

Recreate the plugin only when the endpoint or OAuth metadata changes, or when repeated Refresh attempts demonstrably fail after the production endpoint and live MCP catalogue have been verified.
