from pathlib import Path

path = Path("test/integrity-coordination.test.ts")
text = path.read_text()
old = '''test("same invocation retries acquisition idempotently", async () => {
  const h = new TransactionHarness();
  const first = await h.run(acquire("same"));
  const second = await h.run(acquire("same"));
  assert.equal(second.acquired, true);
  assert.equal(second.idempotentRetry, true);
  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.fencingToken, first.fencingToken);
});'''
new = '''test("same active invocation is an idempotent safe no-op", async () => {
  const h = new TransactionHarness();
  const first = await h.run(acquire("same"));
  const second = await h.run(acquire("same"));
  assert.equal(second.acquired, false);
  assert.equal(second.alreadyExecuting, true);
  assert.equal(second.idempotentInvocation, true);
  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.fencingToken, first.fencingToken);
});'''
if text.count(old) != 1:
    raise SystemExit("expected the legacy same-invocation test exactly once")
path.write_text(text.replace(old, new, 1))
