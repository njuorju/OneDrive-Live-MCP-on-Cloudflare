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

test("ODL-REQ-024 deployment is exact-main, post-CI, leased, and runs only the synthetic diagnostic", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /deploy-production:/);
  assert.match(workflow, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /needs: validate/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(workflow, /OPENING_VERSION_ID: e06f333e-3343-433f-b876-4968e32d2f18/);
  assert.match(workflow, /OPENING_DEPLOYMENT_ID: 987e6b2d-1ad0-453f-a0de-6f17513e2223/);
  assert.match(workflow, /npx wrangler deploy --config wrangler\.production\.json/);
  assert.match(workflow, /odl-req-024-go-vision-contract-v1/);
  assert.match(workflow, /__odlReq024GoVisionDiagnostic/);
  assert.match(workflow, /maxBillableRequests.*8/);
  assert.match(workflow, /maxEstimatedSpendUsd.*0\.05/);
  assert.match(workflow, /oneDriveAccessed == false/);
  assert.match(workflow, /sourcePdfRead == false/);
  assert.match(workflow, /pages64Through219Blocked == true/);
  assert.match(workflow, /\.result\.deployments\[0\]\.versions\[0\]\.percentage==100/);
  assert.match(workflow, /cmp pre-bindings\.json post-bindings\.json/);
  assert.match(workflow, /cmp pre-secret-bindings\.json post-secret-bindings\.json/);
  assert.match(workflow, /healthHttp200:true/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /odl-req-024-workflow-failure\.json/);
  assert.doesNotMatch(workflow, /start_visual_catalogue_job|sourceItemId|pageStart|pageEnd|workflow_dispatch|deployment-only|transport branch/i);
});
