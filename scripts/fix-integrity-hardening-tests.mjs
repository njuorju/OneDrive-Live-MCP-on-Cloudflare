import fs from "node:fs";

const path = "test/integrity-coordination.test.ts";
let text = fs.readFileSync(path, "utf8");

const oldForce = `test("ambiguous in-flight mutation cannot be force-invalidated", async () => {
  const h = new TransactionHarness();
  const lease = await owned(h);
  await h.run({ op: "reserve", ...lease, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  await h.run({ op: "mark-mutation-started", ...lease, actionId: "A1", leaseDurationSeconds: 600 });
  const forced = await h.run({ op: "force-invalidate", ...base, force: true, outcome: { reconciliationResult: "manual_review" } });
  assert.equal(forced.invalidated, false);
  assert.equal(forced.reason, "mutation_commit_in_progress");
});`;
const newForce = `test("ambiguous in-flight mutation cannot be force-invalidated", async () => {
  const h = new TransactionHarness();
  const lease = await owned(h);
  await h.run({ op: "reserve", ...lease, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  await h.run({ op: "mark-mutation-started", ...lease, actionId: "A1", leaseDurationSeconds: 600 });
  const claim = await h.run({ op: "claim-force-recovery", ...base, invocationId: "recovery", ownerId: "recovery", force: true });
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, "mutation_commit_in_progress");
});`;
if (text.includes(oldForce)) text = text.replace(oldForce, newForce);
else if (!text.includes(newForce)) throw new Error("Force-recovery test anchor not found");

const oldAudit = `test("audit history remains bounded", async () => {
  const h = new TransactionHarness();
  await h.run(acquire("owner"));
  for (let index = 0; index < MAX_INTEGRITY_AUDIT_RECORDS + 25; index += 1) await h.run({ ...acquire(\`denied-\${index}\`), ownerId: \`denied-\${index}\` });
  const page = await h.run({ op: "audit-page", userId: base.userId, planId: base.planId });
  assert.equal((page.records as unknown[]).length, MAX_INTEGRITY_AUDIT_RECORDS);
  assert.equal(page.bounded, true);
});`;
const newAudit = `test("audit history remains bounded", async () => {
  const h = new TransactionHarness();
  await h.run(acquire("owner"));
  for (let index = 0; index < MAX_INTEGRITY_AUDIT_RECORDS + 25; index += 1) await h.run({ ...acquire(\`denied-\${index}\`), ownerId: \`denied-\${index}\` });
  const page = await h.run({ op: "audit-page", userId: base.userId, planId: base.planId, limit: 50 });
  assert.equal((page.records as unknown[]).length, 50);
  assert.equal(page.totalRetained, MAX_INTEGRITY_AUDIT_RECORDS);
  assert.equal(page.bounded, true);
});`;
if (text.includes(oldAudit)) text = text.replace(oldAudit, newAudit);
else if (!text.includes(newAudit)) throw new Error("Bounded audit test anchor not found");

fs.writeFileSync(path, text);
console.log("Integrity hardening tests aligned.");
