from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:100]!r}")
    target.write_text(text.replace(old, new, 1))


diagnostic = "src/visual-classifier-capability-go-diagnostic.ts"
replace_once(diagnostic, "        max_tokens: 80,\n", "        max_tokens: 256,\n")
replace_once(
    diagnostic,
    '''function retryableProbe(receipt: GoDiagnosticProbeReceipt): boolean {
  if (receipt.responseShape.httpStatus === null) return true;
  if (receipt.responseShape.httpStatus >= 500) return true;
  if (receipt.responseShape.httpStatus < 200 || receipt.responseShape.httpStatus >= 300) return false;
  return new Set<GoSuccessEnvelopeClass>([
    "empty_message_content",
    "finish_reason_length_without_content",
    "reasoning_only_no_final_content",
    "unknown_success_envelope",
  ]).has(receipt.responseShape.successEnvelopeClass ?? "unknown_success_envelope");
}
''',
    '''function retryableProbe(receipt: GoDiagnosticProbeReceipt): boolean {
  if (receipt.responseShape.httpStatus === null) return true;
  if (receipt.responseShape.httpStatus >= 500) return true;
  if (receipt.responseShape.httpStatus < 200 || receipt.responseShape.httpStatus >= 300) return false;
  return new Set<GoSuccessEnvelopeClass>([
    "empty_message_content",
    "finish_reason_length_without_content",
    "reasoning_only_no_final_content",
    "unknown_success_envelope",
  ]).has(receipt.responseShape.successEnvelopeClass ?? "unknown_success_envelope");
}

export function shouldRunOpenCodeGoTokenControl(receipt: GoDiagnosticProbeReceipt): boolean {
  if (receipt.usableFinalContent || receipt.responseShape.httpStatus !== 200) return false;
  if (receipt.responseShape.finishReason === "length") return true;
  return new Set<GoSuccessEnvelopeClass>([
    "finish_reason_length_without_content",
    "empty_message_content",
  ]).has(receipt.responseShape.successEnvelopeClass ?? "unknown_success_envelope");
}
''',
)
replace_once(
    diagnostic,
    '''  if (
    !successfulCanonical
    && lastCanonical?.receipt.responseShape.httpStatus === 200
    && new Set<GoSuccessEnvelopeClass>(["finish_reason_length_without_content", "empty_message_content"])
      .has(lastCanonical.receipt.responseShape.successEnvelopeClass ?? "unknown_success_envelope")
  ) {''',
    '''  if (lastCanonical && shouldRunOpenCodeGoTokenControl(lastCanonical.receipt)) {''',
)

test_file = "test/visual-opencode-go-diagnostic.test.ts"
replace_once(
    test_file,
    "  openCodeGoResponseShapeReceipt,\n  verifyOpenCodeGoDiagnosticFixture,\n",
    "  openCodeGoResponseShapeReceipt,\n  shouldRunOpenCodeGoTokenControl,\n  verifyOpenCodeGoDiagnosticFixture,\n",
)
replace_once(
    test_file,
    '''test("diagnostic and capability ceilings are immutable", () => {''',
    '''test("Probe D runs after a non-usable length-truncated content string, but not after HTTP 500", () => {
  const receipt = {
    probe: "canonical_vision_payload",
    attempt: 1,
    startedAt: "2026-08-03T00:00:00.000Z",
    completedAt: "2026-08-03T00:00:01.000Z",
    latencyMilliseconds: 1000,
    requestShape: {} as any,
    responseShape: {
      httpStatus: 200,
      finishReason: "length",
      successEnvelopeClass: "openai_message_content_string",
    } as any,
    usage: null,
    accounting: {} as any,
    usableFinalContent: false,
    visualFixtureMatched: false,
    structuredFixtureMatched: false,
    retryReason: null,
  } as any;
  assert.equal(shouldRunOpenCodeGoTokenControl(receipt), true);
  assert.equal(shouldRunOpenCodeGoTokenControl({ ...receipt, responseShape: { ...receipt.responseShape, httpStatus: 500 } }), false);
  assert.equal(shouldRunOpenCodeGoTokenControl({ ...receipt, usableFinalContent: true }), false);
});

test("diagnostic and capability ceilings are immutable", () => {''',
)

ci = ".github/workflows/ci.yml"
replace_once(ci, "      OPENING_VERSION_ID: da5558f0-fe88-455c-a4e1-803e2dd279d3\n", "      OPENING_VERSION_ID: e55f3e0d-b406-49c0-ab32-ce59e06cc041\n")
replace_once(ci, "      OPENING_DEPLOYMENT_ID: c2ce8604-3751-4c24-bfb8-76b80c0f81f6\n", "      OPENING_DEPLOYMENT_ID: 5ae11025-b08e-4528-95d4-6acb9617a0ec\n")
replace_once(ci, "__odlReq024GoVisionDiagnostic:true,maxBillableRequests:8,maxEstimatedSpendUsd:0.05", "__odlReq024GoVisionDiagnostic:true,maxBillableRequests:5,maxEstimatedSpendUsd:0.05")
replace_once(ci, ".diagnosticReceipt.accounting.billableRequestCount <= 8 and .diagnosticReceipt.accounting.maxBillableRequests <= 8", ".diagnosticReceipt.accounting.billableRequestCount <= 5 and .diagnosticReceipt.accounting.maxBillableRequests <= 5")
replace_once(ci, "|OPENCODE_(ZEN|GO)_API_KEY", "")

rollout = "test/production-rollout.test.ts"
replace_once(rollout, "/OPENING_VERSION_ID: da5558f0-fe88-455c-a4e1-803e2dd279d3/", "/OPENING_VERSION_ID: e55f3e0d-b406-49c0-ab32-ce59e06cc041/")
replace_once(rollout, "/OPENING_DEPLOYMENT_ID: c2ce8604-3751-4c24-bfb8-76b80c0f81f6/", "/OPENING_DEPLOYMENT_ID: 5ae11025-b08e-4528-95d4-6acb9617a0ec/")
replace_once(rollout, "/maxBillableRequests.*8/", "/maxBillableRequests.*5/")
