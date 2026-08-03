import test from "node:test";
import assert from "node:assert/strict";
import { registerODLReq021VisibleBridge } from "../src/visual-capability-visible-bridge";

function error(code: string) {
  return {
    isError: true,
    structuredContent: { error: { code, message: code } },
    content: [{ type: "text", text: code }],
  };
}

function success(value: Record<string, unknown>) {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function serverWith(handlers: Record<string, (input: Record<string, unknown>) => Promise<any>>) {
  const registry = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, { handler }]));
  return { _registeredTools: registry } as any;
}

test("visible start tool reserves the separate capability prerequisite when the receipt gate blocks calibration", async () => {
  let capabilityStarts = 0;
  const server = serverWith({
    start_visual_catalogue_job: async () => error("provider_capability_receipt_required"),
    start_visual_classifier_capability_job: async (input) => {
      capabilityStarts += 1;
      assert.equal(input.provider, "opencode_zen");
      assert.equal(input.mode, "opencode_chat_completions");
      assert.equal(input.model, "mimo-v2.5-free");
      assert.equal(input.forceFresh, true);
      return success({ jobId: "00000000-0000-4000-8000-000000000021", status: "reserved" });
    },
  });
  registerODLReq021VisibleBridge(server);
  const result = await server._registeredTools.start_visual_catalogue_job.handler({ classifierProvider: "opencode_zen" });
  assert.equal(capabilityStarts, 1);
  assert.equal(result.structuredContent.jobId, "00000000-0000-4000-8000-000000000021");
  assert.equal(result.structuredContent.prerequisite, "visual_classifier_capability");
  assert.equal(result.structuredContent.compatibilityStatusTool, "get_visual_catalogue_job");
});

test("visible start tool does not intercept a calibration that already has a passing receipt", async () => {
  let capabilityStarts = 0;
  const server = serverWith({
    start_visual_catalogue_job: async () => success({ jobId: "00000000-0000-4000-8000-000000000022", status: "reserved" }),
    start_visual_classifier_capability_job: async () => {
      capabilityStarts += 1;
      return success({});
    },
  });
  registerODLReq021VisibleBridge(server);
  const result = await server._registeredTools.start_visual_catalogue_job.handler({ classifierProvider: "opencode_zen" });
  assert.equal(capabilityStarts, 0);
  assert.equal(result.structuredContent.jobId, "00000000-0000-4000-8000-000000000022");
});

test("visible visual-job status tool falls back to the capability status handler", async () => {
  const server = serverWith({
    get_visual_catalogue_job: async () => error("artifact_not_found"),
    get_visual_classifier_capability_job: async (input) => success({ jobId: input.jobId, status: "retry_wait", currentStage: "vision_unstructured" }),
  });
  registerODLReq021VisibleBridge(server);
  const result = await server._registeredTools.get_visual_catalogue_job.handler({ jobId: "00000000-0000-4000-8000-000000000023" });
  assert.equal(result.structuredContent.status, "retry_wait");
  assert.equal(result.structuredContent.currentStage, "vision_unstructured");
  assert.equal(result.structuredContent.compatibilityStatusTool, "get_visual_catalogue_job");
});

test("visible status tool preserves unrelated failures", async () => {
  let capabilityReads = 0;
  const server = serverWith({
    get_visual_catalogue_job: async () => error("source_identity_mismatch"),
    get_visual_classifier_capability_job: async () => {
      capabilityReads += 1;
      return success({});
    },
  });
  registerODLReq021VisibleBridge(server);
  const result = await server._registeredTools.get_visual_catalogue_job.handler({ jobId: "00000000-0000-4000-8000-000000000024" });
  assert.equal(capabilityReads, 0);
  assert.equal(result.structuredContent.error.code, "source_identity_mismatch");
});
