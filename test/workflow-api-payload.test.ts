import test from "node:test";
import assert from "node:assert/strict";
import { extractWorkflowEventPayload, normalizeWorkflowApiPayload } from "../src/workflow-api-payload";

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

test("Workflow REST JSON-string params normalize to the immutable payload object", () => {
  assert.deepEqual(normalizeWorkflowApiPayload(JSON.stringify(payload)), payload);
});

test("binding-created WorkflowEvent payloads are extracted", () => {
  assert.deepEqual(extractWorkflowEventPayload({ payload }), payload);
  assert.deepEqual(extractWorkflowEventPayload({ payload: JSON.stringify(payload) }), payload);
});

test("REST-triggered raw events are extracted", () => {
  assert.deepEqual(extractWorkflowEventPayload(payload), payload);
  assert.deepEqual(extractWorkflowEventPayload(JSON.stringify(payload)), payload);
});

test("malformed and scalar strings remain strings for fail-closed routing", () => {
  assert.equal(normalizeWorkflowApiPayload("{not-json"), "{not-json");
  assert.equal(normalizeWorkflowApiPayload('"scalar"'), '"scalar"');
  assert.equal(extractWorkflowEventPayload("{not-json"), "{not-json");
});
