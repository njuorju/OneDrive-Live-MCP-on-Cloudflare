import test from "node:test";
import assert from "node:assert/strict";
import { redact, runSmoke, withTimeout } from "../scripts/smoke-paid-architecture.mjs";

const legacy = ["onedrive_status","list_onedrive_folder","search","fetch","read_onedrive_file","fetch_original_file","create_integrity_plan","get_integrity_plan_status","calculate_file_hashes","inspect_document","list_document_visuals","render_document_page"];
const paid = ["await_paid_job","get_paid_job_result","get_integrity_plan_definition","list_integrity_plans","abandon_integrity_plan","supersede_integrity_plan","get_paid_architecture_status","prepare_structured_text_patch","prepare_catalogue_pair_update","commit_prepared_integrity_plan"];

function json(value: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(options: { missingTool?: string; endpointFailure?: boolean } = {}) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "https://worker.example") return new Response("ok", { status: options.endpointFailure ? 503 : 200 });
    if (url === "https://worker.example/mcp") {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }, 200, { "mcp-session-id": "session" });
      if (body.method === "tools/list") {
        return json({ jsonrpc: "2.0", id: body.id, result: { tools: [...legacy, ...paid].filter((name) => name !== options.missingTool).map((name) => ({ name })) } });
      }
      if (body.method === "tools/call") {
        const name = body.params.name;
        let structuredContent: Record<string, unknown> = {};
        if (name === "get_paid_architecture_status") structuredContent = { workflowBinding: true, queueBinding: true, r2Binding: true, coordinatorBinding: true, browserBinding: true, r2Reachable: true };
        else if (name === "search") structuredContent = { results: [{ itemId: "fixture-id", relativePath: "__IntegrityLeaseAcceptance_ce4074d0_20260721/fixture-basic-collision.txt" }] };
        else if (name === "calculate_file_hashes") structuredContent = { jobId: "11111111-1111-4111-8111-111111111111", status: "queued" };
        else if (name === "await_paid_job") structuredContent = { jobId: "11111111-1111-4111-8111-111111111111", status: "completed" };
        else if (name === "get_paid_job_result") structuredContent = { hashes: [{ sha256: "a".repeat(64) }] };
        return json({ jsonrpc: "2.0", id: body.id, result: { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] } });
      }
    }
    if (url.endsWith("/workers/scripts/nikolay-onedrive-mcp/settings")) {
      const names = ["MCP_OBJECT","AUTH_STATE","PAID_COORDINATOR","ARTIFACTS","PAID_JOBS","PAID_WORKFLOW","OAUTH_KV","AI","IMAGES","BROWSER"];
      return json({ success: true, result: { bindings: names.map((name) => ({ name })) } });
    }
    if (url.endsWith("/queues")) return json({ success: true, result: [{ queue_id: "queue", queue_name: "onedrive-live-mcp-jobs", producers: [{ script: "nikolay-onedrive-mcp" }], consumers: [{ script: "nikolay-onedrive-mcp", dead_letter_queue: "onedrive-live-mcp-jobs-dlq", settings: { batch_size: 1, max_retries: 5, max_concurrency: 3 } }] }] });
    if (url.endsWith("/queues/queue/metrics")) return json({ success: true, result: { backlog_count: 0 } });
    if (url.endsWith("/workflows")) return json({ success: true, result: [{ name: "onedrive-live-mcp-durable-jobs", script_name: "nikolay-onedrive-mcp", class_name: "PaidConnectorWorkflow", instances: { queued: 0, running: 0, errored: 0 } }] });
    if (url.endsWith("/domains/managed")) return json({ success: true, result: { enabled: false } });
    if (url.endsWith("/domains/custom")) return json({ success: true, result: { domains: [] } });
    throw new Error(`Unexpected URL ${url}`);
  };
}

const env = {
  ONEDRIVELIVE_MCP_URL: "https://worker.example/mcp",
  ONEDRIVELIVE_BEARER_TOKEN: "secret-bearer-token-value",
  CLOUDFLARE_API_TOKEN: "secret-cloudflare-token-value",
  CLOUDFLARE_ACCOUNT_ID: "account",
  ONEDRIVELIVE_SMOKE_TIMEOUT_MS: "5000",
};

test("smoke harness succeeds with complete live architecture", async () => {
  const result = await runSmoke({ env, fetchImpl: fakeFetch() });
  assert.equal(result.ok, true);
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.queueBacklog, 0);
  assert.equal(result.oneDriveMutationPerformed, false);
});

test("smoke harness times out deterministically", async () => {
  await assert.rejects(() => withTimeout(() => new Promise(() => {}), 10, "test"), /timed out/);
});

test("smoke harness redacts bearer tokens", () => {
  const value = redact("Authorization: Bearer eyJabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  assert.doesNotMatch(value, /eyJabcdefghijklmnopqrstuvwxyz/);
  assert.match(value, /redacted/);
});

test("smoke harness returns failure for a missing expected tool", async () => {
  await assert.rejects(() => runSmoke({ env, fetchImpl: fakeFetch({ missingTool: "prepare_catalogue_pair_update" }) }), /Expected MCP tool is missing/);
});
