#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const LEGACY_TOOLS = [
  "onedrive_status",
  "list_onedrive_folder",
  "search",
  "fetch",
  "read_onedrive_file",
  "fetch_original_file",
  "create_integrity_plan",
  "get_integrity_plan_status",
  "calculate_file_hashes",
  "inspect_document",
  "list_document_visuals",
  "render_document_page",
];

const PAID_TOOLS = [
  "await_paid_job",
  "get_paid_job_result",
  "get_integrity_plan_definition",
  "list_integrity_plans",
  "abandon_integrity_plan",
  "supersede_integrity_plan",
  "get_paid_architecture_status",
  "prepare_structured_text_patch",
  "prepare_catalogue_pair_update",
  "commit_prepared_integrity_plan",
];

export function redact(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"}]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[redacted]")
    .replace(/\b(?:sk|cf|eyJ)[A-Za-z0-9._~+\/-]{24,}\b/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[redacted]");
}

export function assertCondition(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

export async function withTimeout(operation, timeoutMs, label = "operation") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseSse(text) {
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { messages.push(JSON.parse(payload)); } catch { /* ignore heartbeat/non-JSON events */ }
  }
  return messages.at(-1);
}

function toolStructured(result) {
  const value = result?.result ?? result;
  const toolResult = value?.structuredContent ? value : value?.content ? value : value?.result;
  if (toolResult?.isError) {
    const error = toolResult.structuredContent?.error ?? { message: "MCP tool returned an error" };
    const thrown = new Error(String(error.message ?? "MCP tool returned an error"));
    thrown.details = error;
    throw thrown;
  }
  if (toolResult?.structuredContent && typeof toolResult.structuredContent === "object") return toolResult.structuredContent;
  const text = toolResult?.content?.find?.((entry) => entry.type === "text")?.text;
  if (text) {
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return toolResult ?? {};
}

class McpHttpClient {
  constructor(endpoint, bearerToken, fetchImpl = fetch) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.bearerToken = bearerToken;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.requestId = 0;
  }

  async send(method, params, timeoutMs) {
    const id = method.startsWith("notifications/") ? undefined : ++this.requestId;
    const body = { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) };
    const response = await withTimeout((signal) => this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal,
    }), timeoutMs, `MCP ${method}`);
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const text = await response.text();
    assertCondition(response.ok || response.status === 202, `MCP ${method} failed with HTTP ${response.status}`, text.slice(0, 1000));
    if (id === undefined || response.status === 202 || !text.trim()) return {};
    const message = response.headers.get("content-type")?.includes("text/event-stream") ? parseSse(text) : JSON.parse(text);
    assertCondition(message, `MCP ${method} returned no JSON-RPC response`);
    if (message.error) {
      const error = new Error(String(message.error.message ?? `MCP ${method} failed`));
      error.details = message.error;
      throw error;
    }
    return message;
  }

  async initialize(timeoutMs) {
    const result = await this.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "onedrivelive-paid-smoke", version: "1.0.0" },
    }, timeoutMs);
    await this.send("notifications/initialized", {}, timeoutMs);
    return result.result;
  }

  async listTools(timeoutMs) {
    const response = await this.send("tools/list", {}, timeoutMs);
    return response.result?.tools ?? [];
  }

  async callTool(name, args, timeoutMs) {
    const response = await this.send("tools/call", { name, arguments: args }, timeoutMs);
    return toolStructured(response.result);
  }
}

async function cfRequest(fetchImpl, token, path, timeoutMs) {
  const response = await withTimeout((signal) => fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal,
  }), timeoutMs, `Cloudflare ${path}`);
  const body = await response.json();
  assertCondition(response.ok && body.success, `Cloudflare API request failed: ${path}`, body.errors);
  return body.result;
}

function findFixtureItem(value, expectedPath) {
  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) queue.push(...current);
    else if (current && typeof current === "object") {
      const path = String(current.relativePath ?? current.path ?? "");
      const name = String(current.filename ?? current.name ?? "");
      if (path === expectedPath || (name === expectedPath.split("/").at(-1) && path.endsWith(expectedPath))) {
        return String(current.itemId ?? current.id ?? "");
      }
      queue.push(...Object.values(current));
    }
  }
  return "";
}

export async function runSmoke(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number(env.ONEDRIVELIVE_SMOKE_TIMEOUT_MS ?? 120_000);
  const requestTimeoutMs = Math.min(Number(env.ONEDRIVELIVE_SMOKE_REQUEST_TIMEOUT_MS ?? 25_000), timeoutMs);
  const endpoint = String(env.ONEDRIVELIVE_MCP_URL ?? "https://nikolay-onedrive-mcp.fdas201290.workers.dev/mcp");
  const workerOrigin = new URL(endpoint).origin;
  const bearerToken = String(env.ONEDRIVELIVE_BEARER_TOKEN ?? "");
  const cloudflareToken = String(env.CLOUDFLARE_API_TOKEN ?? "");
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID ?? "");
  const workerName = String(env.CLOUDFLARE_WORKER_NAME ?? "nikolay-onedrive-mcp");
  const fixturePath = String(env.ONEDRIVELIVE_SMOKE_FIXTURE_PATH ?? "__IntegrityLeaseAcceptance_ce4074d0_20260721/fixture-basic-collision.txt");
  assertCondition(bearerToken, "ONEDRIVELIVE_BEARER_TOKEN is required");
  assertCondition(cloudflareToken, "CLOUDFLARE_API_TOKEN is required");
  assertCondition(accountId, "CLOUDFLARE_ACCOUNT_ID is required");

  return withTimeout(async () => {
    const endpointResponse = await withTimeout((signal) => fetchImpl(workerOrigin, { redirect: "manual", signal }), requestTimeoutMs, "production endpoint");
    assertCondition(endpointResponse.status >= 200 && endpointResponse.status < 500, `Production endpoint returned HTTP ${endpointResponse.status}`);

    const client = new McpHttpClient(endpoint, bearerToken, fetchImpl);
    const initialization = await client.initialize(requestTimeoutMs);
    assertCondition(initialization?.protocolVersion, "MCP initialization did not return a protocol version");

    const tools = await client.listTools(requestTimeoutMs);
    const names = new Set(tools.map((entry) => entry.name));
    for (const name of [...LEGACY_TOOLS, ...PAID_TOOLS]) assertCondition(names.has(name), `Expected MCP tool is missing: ${name}`);

    const architecture = await client.callTool("get_paid_architecture_status", {}, requestTimeoutMs);
    for (const field of ["workflowBinding", "queueBinding", "r2Binding", "coordinatorBinding", "browserBinding", "r2Reachable"]) {
      assertCondition(architecture[field] === true, `Paid architecture status failed: ${field}`);
    }

    let fixtureItemId = String(env.ONEDRIVELIVE_SMOKE_FIXTURE_ITEM_ID ?? "");
    if (!fixtureItemId) {
      const search = await client.callTool("search", { query: fixturePath.split("/").at(-1), limit: 20 }, requestTimeoutMs);
      fixtureItemId = findFixtureItem(search, fixturePath);
    }
    assertCondition(fixtureItemId, `Dedicated acceptance fixture was not found: ${fixturePath}`);

    const hashInput = { itemId: fixtureItemId, calculateNormalizedTextHash: false, calculatePerceptualHash: false, limit: 1 };
    const first = await client.callTool("calculate_file_hashes", hashInput, requestTimeoutMs);
    const replay = await client.callTool("calculate_file_hashes", hashInput, requestTimeoutMs);
    assertCondition(first.jobId && replay.jobId, "Durable hash job did not return a job ID");
    assertCondition(first.jobId === replay.jobId, "Idempotent replay returned a different job ID", { first: first.jobId, replay: replay.jobId });
    const awaited = await client.callTool("await_paid_job", { jobId: first.jobId, maximumWaitSeconds: 25 }, 30_000);
    assertCondition(awaited.status === "completed", `Durable hash job did not complete: ${awaited.status}`);
    const hashResult = await client.callTool("get_paid_job_result", { jobId: first.jobId }, requestTimeoutMs);
    assertCondition(hashResult, "Durable hash result is empty");

    const settings = await cfRequest(fetchImpl, cloudflareToken, `/accounts/${accountId}/workers/scripts/${workerName}/settings`, requestTimeoutMs);
    const bindings = settings.bindings ?? [];
    const bindingNames = new Set(bindings.map((binding) => binding.name));
    for (const name of ["MCP_OBJECT", "AUTH_STATE", "PAID_COORDINATOR", "ARTIFACTS", "PAID_JOBS", "PAID_WORKFLOW", "OAUTH_KV", "AI", "IMAGES", "BROWSER"]) {
      assertCondition(bindingNames.has(name), `Production binding is missing: ${name}`);
    }

    const queues = await cfRequest(fetchImpl, cloudflareToken, `/accounts/${accountId}/queues`, requestTimeoutMs);
    const queue = queues.find((entry) => entry.queue_name === "onedrive-live-mcp-jobs");
    assertCondition(queue?.producers?.some((producer) => producer.script === workerName), "Queue producer is not attached to production Worker");
    const consumer = queue?.consumers?.find((entry) => entry.script === workerName);
    assertCondition(consumer, "Queue consumer is not attached to production Worker");
    assertCondition(consumer.dead_letter_queue === "onedrive-live-mcp-jobs-dlq", "Queue consumer DLQ is incorrect");
    assertCondition(consumer.settings?.batch_size === 1 && consumer.settings?.max_retries === 5 && consumer.settings?.max_concurrency === 3, "Queue consumer settings are incorrect", consumer.settings);
    const metrics = await cfRequest(fetchImpl, cloudflareToken, `/accounts/${accountId}/queues/${queue.queue_id}/metrics`, requestTimeoutMs);
    assertCondition(metrics.backlog_count === 0, `Queue backlog is not zero: ${metrics.backlog_count}`);

    const workflows = await cfRequest(fetchImpl, cloudflareToken, `/accounts/${accountId}/workflows`, requestTimeoutMs);
    const workflow = workflows.find((entry) => entry.name === "onedrive-live-mcp-durable-jobs");
    assertCondition(workflow?.script_name === workerName && workflow?.class_name === "PaidConnectorWorkflow", "Workflow binding is unhealthy", workflow);
    assertCondition(Number(workflow.instances?.queued ?? 0) === 0 && Number(workflow.instances?.running ?? 0) === 0 && Number(workflow.instances?.errored ?? 0) === 0, "Workflow has active or errored instances", workflow.instances);

    const managed = await cfRequest(fetchImpl, cloudflareToken, `/accounts/${accountId}/r2/buckets/onedrive-live-mcp-artifacts/domains/managed`, requestTimeoutMs);
    const custom = await cfRequest(fetchImpl, cloudflareToken, `/accounts/${accountId}/r2/buckets/onedrive-live-mcp-artifacts/domains/custom`, requestTimeoutMs);
    assertCondition(managed.enabled === false, "R2 managed public endpoint is enabled");
    assertCondition((custom.domains ?? []).length === 0, "R2 has a custom public domain");

    return {
      ok: true,
      endpoint: workerOrigin,
      protocolVersion: initialization.protocolVersion,
      toolCount: names.size,
      legacyToolsVerified: LEGACY_TOOLS.length,
      paidToolsVerified: PAID_TOOLS.length,
      fixturePath,
      hashJobId: first.jobId,
      idempotentReplay: true,
      queueBacklog: metrics.backlog_count,
      r2Private: true,
      oneDriveMutationPerformed: false,
    };
  }, timeoutMs, "paid architecture smoke");
}

async function main() {
  try {
    const result = await runSmoke();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(redact({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      details: error?.details,
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
