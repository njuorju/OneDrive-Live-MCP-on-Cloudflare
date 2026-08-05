import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repository = new URL("..", import.meta.url);

test("production materializer emits the complete sanitized v3 deployment definition", () => {
  const directory = mkdtempSync(join(tmpdir(), "onedrive-wrangler-"));
  const output = join(directory, "production.jsonc");
  try {
    const result = spawnSync(process.execPath, [new URL("../scripts/materialize-production-wrangler.mjs", import.meta.url).pathname, output], {
      env: { ...process.env, CLOUDFLARE_OAUTH_KV_NAMESPACE_ID: "a".repeat(32) },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(config.name, "nikolay-onedrive-mcp");
    assert.equal(config.main, "src/index-closeout.ts");
    assert.equal(config.keep_vars, true);
    assert.equal(config.workers_dev, true);
    assert.deepEqual(config.routes, []);
    assert.equal(config.vars.PAID_MAX_SOURCE_MB, "500");
    assert.equal(config.vars.PAID_VISUAL_PARSE_MB, "40");
    assert.equal(config.vars.PAID_RENDER_ORIGIN, "https://nikolay-onedrive-mcp.fdas201290.workers.dev");
    assert.deepEqual(config.migrations.map((entry: { tag: string }) => entry.tag), ["v1", "v2", "v3"]);
    assert.ok(config.durable_objects.bindings.some((entry: { name: string; class_name: string }) => entry.name === "PAID_COORDINATOR" && entry.class_name === "PaidCoordinator"));
    assert.ok(config.r2_buckets.some((entry: { binding: string; bucket_name: string }) => entry.binding === "ARTIFACTS" && entry.bucket_name === "onedrive-live-mcp-artifacts"));
    const consumer = config.queues.consumers[0];
    assert.deepEqual({ batch: consumer.max_batch_size, timeout: consumer.max_batch_timeout, retries: consumer.max_retries, delay: consumer.retry_delay, concurrency: consumer.max_concurrency, dlq: consumer.dead_letter_queue }, { batch: 1, timeout: 5, retries: 5, delay: 10, concurrency: 3, dlq: "onedrive-live-mcp-jobs-dlq" });
    assert.ok(config.workflows.some((entry: { binding: string; class_name: string; name: string }) => entry.binding === "PAID_WORKFLOW" && entry.class_name === "PaidConnectorWorkflow" && entry.name === "onedrive-live-mcp-durable-jobs"));
    assert.deepEqual(config.secrets.required.sort(), ["COOKIE_ENCRYPTION_KEY", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]);
    const text = readFileSync(output, "utf8");
    assert.doesNotMatch(text, /account[_-]?id|client_secret\s*[:=]\s*["'][^"']+/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production runbook requires forward recovery and plugin refresh", () => {
  const runbook = readFileSync(new URL("../docs/PRODUCTION_ROLLOUT.md", import.meta.url), "utf8");
  assert.match(runbook, /Version 68 cannot be restored directly/);
  assert.match(runbook, /Recovery must be a forward deployment that retains migration history through `v3`/);
  assert.match(runbook, /--keep-vars/);
  assert.match(runbook, /Plugin → OneDriveLive → Refresh/);
  assert.match(runbook, /Deleting and recreating the plugin is not the normal update method/);
  assert.match(runbook, /Never create replacement production resources/);
});

test("production deployment is manual, exact-main, leased, and isolated from validation", () => {
  const validation = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const deployment = readFileSync(new URL("../.github/workflows/deploy-production.yml", import.meta.url), "utf8");

  assert.match(validation, /push:\n    branches: \[main\]/);
  assert.match(validation, /pull_request:\n    branches: \[main\]/);
  assert.match(validation, /cancel-in-progress: true/);
  assert.match(validation, /fetch-depth: 2/);
  assert.match(validation, /Verify exact pull-request merge tree/);
  assert.match(validation, /git rev-parse HEAD\^1/);
  assert.match(validation, /git rev-parse HEAD\^2/);
  assert.doesNotMatch(validation, /work\/\*\*|deploy-production:|CLOUDFLARE_API_TOKEN|npx wrangler deploy --config wrangler\.production\.json/);

  assert.match(deployment, /workflow_dispatch:/);
  assert.match(deployment, /request_id:/);
  assert.match(deployment, /expected_main_sha:/);
  assert.match(deployment, /expected_opening_version_id:/);
  assert.match(deployment, /expected_opening_deployment_id:/);
  assert.match(deployment, /group: onedrive-live-production-deployment/);
  assert.match(deployment, /cancel-in-progress: false/);
  assert.match(deployment, /deploy-production:/);
  assert.match(deployment, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(deployment, /SOURCE_SHA: \$\{\{ inputs\.expected_main_sha \}\}/);
  assert.match(deployment, /OPENING_VERSION_ID: \$\{\{ inputs\.expected_opening_version_id \}\}/);
  assert.match(deployment, /OPENING_DEPLOYMENT_ID: \$\{\{ inputs\.expected_opening_deployment_id \}\}/);
  assert.match(deployment, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/);
  assert.match(deployment, /npx wrangler deploy/);
  assert.match(deployment, /Deploy \$REQUEST_ID exact main \$SOURCE_SHA/);
  assert.match(deployment, /--tag "\$\{REQUEST_SLUG\}-\$\{SOURCE_SHA:0:12\}"/);
  assert.match(deployment, /\.result\.deployments\[0\]\.versions\[0\]\.percentage==100/);
  assert.match(deployment, /WORKER_DEPLOYMENT_ID/);
  assert.match(deployment, /repo-\$SOURCE_SHA/);
  assert.match(deployment, /test "\$\(jq length pre-bindings\.json\)" = "44"/);
  assert.match(deployment, /test "\$\(jq length post-bindings\.json\)" = "44"/);
  assert.match(deployment, /test "\$\(jq length pre-secret-bindings\.json\)" = "4"/);
  assert.match(deployment, /test "\$\(jq length post-secret-bindings\.json\)" = "4"/);
  assert.match(deployment, /cmp pre-bindings\.json post-bindings\.json/);
  assert.match(deployment, /cmp pre-secret-bindings\.json post-secret-bindings\.json/);
  assert.match(deployment, /OPENCODE_ZEN_API_KEY/);
  assert.match(deployment, /MCP_OBJECT/);
  assert.match(deployment, /OAUTH_KV/);
  assert.match(deployment, /healthHttp200:true/);
  assert.match(deployment, /if: always\(\)/);
  assert.match(deployment, /production-deployment-evidence-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(deployment, /^\s+push:|^\s+pull_request:/m);
  assert.doesNotMatch(deployment, /ODL-REQ-029|b1c31b28-4c1a-4425-a176-4b11b894d091|a5abdd4a-c481-4188-86a3-516486c9295d/);
  assert.doesNotMatch(deployment, /__odlReq024GoVisionDiagnostic|Run bounded synthetic OpenCode Go diagnostic|mimo-v2\.5-pro/);
  assert.doesNotMatch(deployment, /start_visual_catalogue_job|sourceItemId|pageStart|pageEnd|deployment-only|transport branch/i);
});
