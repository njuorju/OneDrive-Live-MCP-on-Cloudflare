#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const kvNamespaceId = String(process.env.CLOUDFLARE_OAUTH_KV_NAMESPACE_ID ?? "").trim();
if (!/^[0-9a-f]{32}$/.test(kvNamespaceId)) {
  console.error("CLOUDFLARE_OAUTH_KV_NAMESPACE_ID must be the existing 32-character OAUTH_KV namespace ID.");
  process.exit(1);
}

const output = resolve(process.argv[2] ?? ".wrangler.production.generated.jsonc");
const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "nikolay-onedrive-mcp",
  main: "src/index-closeout.ts",
  compatibility_date: "2026-07-23",
  compatibility_flags: ["nodejs_compat"],
  keep_vars: true,
  workers_dev: true,
  preview_urls: false,
  routes: [],
  send_metrics: false,
  build: { command: "node scripts/prepare-pdfjs.mjs" },
  vars: {
    PAID_MAX_SOURCE_MB: "500",
    PAID_VISUAL_PARSE_MB: "40",
    PAID_RENDER_ORIGIN: "https://nikolay-onedrive-mcp.fdas201290.workers.dev",
  },
  secrets: {
    required: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "COOKIE_ENCRYPTION_KEY"],
  },
  migrations: [
    { new_sqlite_classes: ["OneDriveMCP"], tag: "v1" },
    { new_sqlite_classes: ["AuthState"], tag: "v2" },
    { new_sqlite_classes: ["PaidCoordinator"], tag: "v3" },
  ],
  durable_objects: {
    bindings: [
      { class_name: "OneDriveMCP", name: "MCP_OBJECT" },
      { class_name: "AuthState", name: "AUTH_STATE" },
      { class_name: "PaidCoordinator", name: "PAID_COORDINATOR" },
    ],
  },
  kv_namespaces: [{ binding: "OAUTH_KV", id: kvNamespaceId }],
  r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "onedrive-live-mcp-artifacts" }],
  queues: {
    producers: [{ binding: "PAID_JOBS", queue: "onedrive-live-mcp-jobs" }],
    consumers: [{
      queue: "onedrive-live-mcp-jobs",
      max_batch_size: 1,
      max_batch_timeout: 5,
      max_retries: 5,
      retry_delay: 10,
      max_concurrency: 3,
      dead_letter_queue: "onedrive-live-mcp-jobs-dlq",
    }],
  },
  workflows: [{
    name: "onedrive-live-mcp-durable-jobs",
    binding: "PAID_WORKFLOW",
    class_name: "PaidConnectorWorkflow",
    limits: { steps: 10000 },
  }],
  ai: { binding: "AI" },
  images: { binding: "IMAGES" },
  browser: { binding: "BROWSER" },
  observability: {
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
    traces: { enabled: true, head_sampling_rate: 0.1 },
  },
};

writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { flag: "w", mode: 0o600 });
console.log(output);
