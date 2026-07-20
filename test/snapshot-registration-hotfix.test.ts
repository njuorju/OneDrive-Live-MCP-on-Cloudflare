import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSourceSnapshotRepairTools } from "../src/source-snapshot-repair";
import type { HotfixContext } from "../src/version20-hotfix";

test("repaired snapshot tools replace existing integrated registrations", () => {
  const server = new McpServer({ name: "registration-test", version: "1.0.0" });
  server.registerTool(
    "create_source_snapshot",
    { description: "legacy snapshot", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "legacy" }] }),
  );
  server.registerTool(
    "get_job_status",
    { description: "legacy status", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "legacy" }] }),
  );

  assert.doesNotThrow(() => registerSourceSnapshotRepairTools(
    server,
    () => ({} as HotfixContext),
    async () => undefined,
  ));

  const tools = (server as any)._registeredTools as Record<string, { description?: string }>;
  assert.match(tools.create_source_snapshot.description ?? "", /resumable|checkpoint/i);
  assert.match(tools.get_job_status.description ?? "", /resumable snapshot progress/i);
  assert.equal(Object.keys(tools).filter((name) => name === "create_source_snapshot").length, 1);
  assert.equal(Object.keys(tools).filter((name) => name === "get_job_status").length, 1);
});
