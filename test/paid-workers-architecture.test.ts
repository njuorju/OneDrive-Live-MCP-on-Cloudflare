import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalJson, requestHash } from "../src/paid-core";

test("canonical JSON and paid request hashes are order independent", async () => {
  const left = { tool: "calculate_file_hashes", input: { snapshotId: "x", limit: 100, flags: { b: true, a: false } } };
  const right = { input: { flags: { a: false, b: true }, limit: 100, snapshotId: "x" }, tool: "calculate_file_hashes" };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(await requestHash("calculate_file_hashes", left.input), await requestHash("calculate_file_hashes", right.input));
});

test("wrangler config declares the complete paid architecture", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.ok(config.r2_buckets.some((entry: { binding: string }) => entry.binding === "ARTIFACTS"));
  assert.ok(config.queues.producers.some((entry: { binding: string }) => entry.binding === "PAID_JOBS"));
  assert.ok(config.queues.consumers.some((entry: { dead_letter_queue?: string }) => entry.dead_letter_queue === "onedrive-live-mcp-jobs-dlq"));
  assert.ok(config.workflows.some((entry: { class_name: string }) => entry.class_name === "PaidConnectorWorkflow"));
  assert.ok(config.durable_objects.bindings.some((entry: { class_name: string }) => entry.class_name === "PaidCoordinator"));
  assert.ok(config.migrations.some((entry: { tag: string }) => entry.tag === "v3"));
});

test("durable plan creation persists exact artifacts and payload bytes", () => {
  const source = readFileSync(new URL("../src/paid-tools.ts", import.meta.url), "utf8");
  for (const required of [
    "plans/begin",
    "plans/link",
    "plans/complete",
    "plan.json",
    "plan.csv",
    "payload-manifest.json",
    "payloads/",
    "exactPayloadBytesPersisted",
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("paid work is detached from MCP response lifetime", () => {
  const jobs = readFileSync(new URL("../src/paid-jobs.ts", import.meta.url), "utf8");
  assert.match(jobs, /extends WorkflowEntrypoint<Env, PaidJobMessage>/);
  assert.match(jobs, /PAID_JOBS\.send/);
  assert.match(jobs, /ARTIFACTS\.put|putArtifact/);
  assert.match(jobs, /cloudflare_browser_rendering_r2_pdfjs/);
  assert.doesNotMatch(jobs, /waitUntil\(/);
});

test("new paid modules never reference protected UCA visual-library paths", () => {
  const files = ["paid-core.ts", "paid-coordinator.ts", "paid-jobs.ts", "paid-tools.ts"];
  for (const filename of files) {
    const source = readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /UCA\/Modules\/04_Visual_Library/);
    assert.doesNotMatch(source, /validate_integrity_plan\s*\(/);
    assert.doesNotMatch(source, /execute_integrity_plan\s*\(/);
  }
});

test("stable visuals expose provenance, hashes and parent pages", () => {
  const source = readFileSync(new URL("../src/paid-jobs.ts", import.meta.url), "utf8");
  assert.match(source, /stableIdentityVersion: 2/);
  assert.match(source, /embeddedSha256/);
  assert.match(source, /perceptualHash/);
  assert.match(source, /parentPages/);
  assert.match(source, /pdf_dct_stream_with_page_relationship/);
});
