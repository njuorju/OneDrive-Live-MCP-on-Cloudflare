import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkflowApiPayload } from "../src/workflow-api-payload";

test("Workflow REST JSON-string params normalize to the immutable payload object", () => {
  const payload = {
    jobId: "odl-req-024-test",
    workflowId: "odl-req-024-test",
    userId: "system-recovery-odl-req-024",
    input: {
      __odlReq024GoVisionDiagnostic: true,
      maxBillableRequests: 8,
      maxEstimatedSpendUsd: 0.05,
    },
  };
  assert.deepEqual(normalizeWorkflowApiPayload(JSON.stringify(payload)), payload);
});

test("Workflow binding objects pass through unchanged", () => {
  const payload = { input: { provider: "opencode_go" } };
  assert.equal(normalizeWorkflowApiPayload(payload), payload);
});

test("malformed and scalar strings remain strings for fail-closed routing", () => {
  assert.equal(normalizeWorkflowApiPayload("{not-json"), "{not-json");
  assert.equal(normalizeWorkflowApiPayload('"scalar"'), '"scalar"');
});
