import test from "node:test";
import assert from "node:assert/strict";
import { coordinatorRequest } from "../src/paid-core";

test("coordinatorRequest propagates the authoritative user identity into the request body", async () => {
  let selectedName = "";
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> | null = null;
  const durableId = { id: "fixture" };
  const env = {
    PAID_COORDINATOR: {
      idFromName(name: string) {
        selectedName = name;
        return durableId;
      },
      get(id: unknown) {
        assert.equal(id, durableId);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            requestedUrl = String(input);
            requestedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return new Response(JSON.stringify({ ok: true, result: { accepted: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        };
      },
    },
  } as unknown as Env;

  const result = await coordinatorRequest<{ accepted: boolean }>(env, "owner-user", "/jobs/begin", {
    jobId: "job-fixture",
    toolName: "start_visual_catalogue_job",
    requestHash: "a".repeat(64),
    userId: "untrusted-body-value",
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(selectedName, "owner-user");
  assert.equal(requestedUrl, "https://paid-coordinator/jobs/begin");
  assert.equal(requestedBody?.userId, "owner-user");
  assert.equal(requestedBody?.jobId, "job-fixture");
});
