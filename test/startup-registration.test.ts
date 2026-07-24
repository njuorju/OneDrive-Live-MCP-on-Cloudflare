import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const workersStub = [
  "export class WorkerEntrypoint {};",
  "export class DurableObject {};",
  "export class WorkflowEntrypoint {};",
  "export class RpcTarget {};",
  "export const env = {};",
  "export const exports = {};",
].join("\n");
const emailStub = "export class EmailMessage {};";
const hooks = `
const workers = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(workersStub)}`)};
const email = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(emailStub)}`)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: workers, shortCircuit: true };
  if (specifier === "cloudflare:email") return { url: email, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

test("production MCP initialization exposes structured tools after create_integrity_plan", async () => {
  const { OneDriveMCP } = await import("../src/index-closeout");
  const server = new McpServer({ name: "OneDriveLive production regression", version: "0.6.1" });
  const storage: any = {
    async get() { return undefined; },
    async put() {},
    async delete() { return false; },
    async list() { return new Map(); },
    async transaction(closure: (value: unknown) => unknown) { return closure(storage); },
  };
  const agent: any = Object.create(OneDriveMCP.prototype);
  agent.server = server;
  agent.props = { userId: "startup-regression-test" };
  agent.env = {};
  agent.ctx = { storage, waitUntil() {} };
  agent.schedule = async () => {};

  await assert.doesNotReject(() => agent.init());

  const toolsListHandler = (server as any).server?._requestHandlers?.get("tools/list");
  assert.equal(typeof toolsListHandler, "function");
  const listed = await toolsListHandler({ method: "tools/list", params: {} }, {});
  const names = listed.tools.map((tool: { name: string }) => tool.name);

  const structuredTools = [
    "prepare_structured_text_patch",
    "prepare_catalogue_pair_update",
    "commit_prepared_integrity_plan",
  ];
  const createPlanIndex = names.indexOf("create_integrity_plan");
  assert.notEqual(createPlanIndex, -1);
  for (const name of structuredTools) {
    const index = names.indexOf(name);
    assert.notEqual(index, -1, `${name} must be exposed by tools/list`);
    assert.ok(createPlanIndex < index, `create_integrity_plan must precede ${name}`);
  }

  for (const existing of [
    "onedrive_status",
    "search",
    "fetch",
    "get_integrity_plan_status",
    "get_paid_architecture_status",
  ]) assert.ok(names.includes(existing), `${existing} must remain registered`);
});
