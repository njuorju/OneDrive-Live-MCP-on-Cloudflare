import fs from "node:fs";

function patch(path, from, to, label) {
  let text = fs.readFileSync(path, "utf8");
  if (text.includes(to)) return;
  if (!text.includes(from)) throw new Error(`Missing ${label}`);
  text = text.replace(from, to);
  fs.writeFileSync(path, text);
}

patch(
  "src/integrity-lease-tools.ts",
  `  if (mode === "acquire_and_release") {
    if (input.simulateMutationInProgress) throw new ConnectorError("probe_inflight_cannot_release", "A simulated in-flight action must be recovered after lease expiry rather than released.");
    await releaseLease(context, acquired, { acceptanceProbe: true });
  }`,
  `  if (mode === "acquire_and_release") {
    if (input.simulateMutationInProgress) throw new ConnectorError("probe_inflight_cannot_release", "A simulated in-flight action must be recovered after lease expiry rather than released.");
    if (reservation && input.actionId) {
      await callIntegrityCoordination(context.env, context.userId, {
        op: "finalize-action",
        ...lease,
        actionId: input.actionId,
        reservationState: "ready_for_retry",
        outcome: { acceptanceProbeReleasedBeforeMutation: true },
      });
      reservation = { ...reservation, state: "ready_for_retry" };
    }
    await releaseLease(context, acquired, { acceptanceProbe: true });
  }`,
  "probe release finalization",
);

patch(
  "src/integrity-lease-tools.ts",
  `  if (acquired.acquired !== true) return { jobId, alreadyExecuting: true, safeToRetry: true, ...acquired };
  const lease: JobLeaseReference = { jobId, invocationId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken) };
  try {
    await continueSourceSnapshotJob`,
  `  if (acquired.acquired !== true) {
    await schedule(jobId, context.userId, Math.min(60, Math.max(2, Number(acquired.retryAfterSeconds ?? 5))));
    return { jobId, alreadyExecuting: true, safeToRetry: true, retryScheduled: true, ...acquired };
  }
  const lease: JobLeaseReference = { jobId, invocationId, leaseId: String(acquired.leaseId), fencingToken: Number(acquired.fencingToken) };
  try {
    await continueSourceSnapshotJob`,
  "scheduled snapshot collision reschedule",
);

let tests = fs.readFileSync("test/integrity-coordination.test.ts", "utf8");
if (!tests.includes("a released pre-mutation reservation can be reserved by a newer lease")) {
  tests += `

test("a released pre-mutation reservation can be reserved by a newer lease", async () => {
  const h = new TransactionHarness();
  const first = await owned(h, "first");
  await h.run({ op: "reserve", ...first, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  await h.run({ op: "finalize-action", ...first, actionId: "A1", reservationState: "ready_for_retry", outcome: { probe: true } });
  await h.run({ op: "release", ...first });
  const secondResult = await h.run({ ...acquire("second"), ownerId: "second" });
  const second = { userId: base.userId, planId: base.planId, invocationId: "second", leaseId: String(secondResult.leaseId), fencingToken: Number(secondResult.fencingToken) };
  const reservation = await h.run({ op: "reserve", ...second, actionId: "A1", expectedPreconditions: {}, intendedPostcondition: {} });
  assert.equal(reservation.reserved, true);
  assert.equal((reservation.reservation as any).attempt, 2);
});
`;
  fs.writeFileSync("test/integrity-coordination.test.ts", tests);
}

console.log("Final integrity lease edge fixes applied.");
