from pathlib import Path

path = Path("src/visual-classifier-capability-go-diagnostic.ts")
text = path.read_text()


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, got {count}: {old[:100]!r}")
    text = text.replace(old, new, 1)

replace_once(
'''type ProbeInternal = {
  receipt: GoDiagnosticProbeReceipt;
  finalContent: string | null;
  parsedBody: Record<string, unknown>;
};''',
'''type SanitizedModelMetadata = {
  id: string;
  object: string | null;
  created: number | null;
  ownedBy: string | null;
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  pricingMetadataPresent: boolean;
};

type ProbeInternal = {
  receipt: GoDiagnosticProbeReceipt;
  modelMetadata: SanitizedModelMetadata | null;
};''')

replace_once(
'''function textStructuredMatched(content: string | null): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed.ok === true && parsed.probe === "odl-req-024";
  } catch {
    return false;
  }
}

async function runProbe(input: {''',
'''function textStructuredMatched(content: string | null): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed.ok === true && parsed.probe === "odl-req-024";
  } catch {
    return false;
  }
}

function sanitizedModelMetadata(body: Record<string, unknown>): SanitizedModelMetadata | null {
  const models = Array.isArray(body.data) ? body.data as Record<string, unknown>[] : [];
  const model = models.find((entry) => String(entry?.id ?? entry?.name ?? "") === OPENCODE_GO_MODEL);
  if (!model) return null;
  return {
    id: String(model.id ?? model.name ?? OPENCODE_GO_MODEL).slice(0, 100),
    object: model.object === undefined || model.object === null ? null : String(model.object).slice(0, 100),
    created: Number.isFinite(Number(model.created)) ? Number(model.created) : null,
    ownedBy: model.owned_by === undefined || model.owned_by === null ? null : String(model.owned_by).slice(0, 100),
    contextLength: Number.isFinite(Number(model.context_length)) ? Number(model.context_length) : null,
    inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities.map(String).slice(0, 16) : [],
    outputModalities: Array.isArray(model.output_modalities) ? model.output_modalities.map(String).slice(0, 16) : [],
    pricingMetadataPresent: Boolean(model.pricing && typeof model.pricing === "object"),
  };
}

async function runProbe(input: {''')

replace_once(
'''  return {
    finalContent,
    parsedBody,
    receipt: {''',
'''  return {
    modelMetadata: input.probe === "model_discovery" ? sanitizedModelMetadata(parsedBody) : null,
    receipt: {''')

replace_once(
'''async function boundedBackoff(attempt: number): Promise<void> {
  const milliseconds = Math.min(4_000, 500 * (2 ** Math.max(0, attempt - 1)));
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}''',
'''async function boundedBackoff(step: WorkflowStep, label: string, attempt: number): Promise<void> {
  const seconds = Math.min(4, 2 ** Math.max(0, attempt - 1));
  await step.sleep(`${label} bounded backoff ${attempt}`, `${seconds} seconds`);
}''')

replace_once(
'''    const result = await runProbe({
      env,
      probe,
      attempt,
      fixture,
      credentialBindingName,
      spendLedgerKey: diagnosticLedger.key,
      retryReason,
    });''',
'''    const result = await step.do(
      `ODL-REQ-024 diagnostic ${probe} attempt ${attempt}`,
      { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" },
      async () => runProbe({
        env,
        probe,
        attempt,
        fixture,
        credentialBindingName,
        spendLedgerKey: diagnosticLedger.key,
        retryReason,
      }),
    );''')

replace_once(
'''    if (attempt < 3) await boundedBackoff(attempt);''',
'''    if (attempt < 3) await boundedBackoff(step, "ODL-REQ-024 diagnostic canonical vision", attempt);''')

replace_once(
'''        const result = await runProbe({
          env,
          probe,
          attempt,
          fixture,
          credentialBindingName,
          spendLedgerKey: capabilityLedger.key,
          retryReason: attempt > 1 ? "bounded_capability_retry" : null,
        });''',
'''        const result = await step.do(
          `ODL-REQ-024 capability ${probe} attempt ${attempt}`,
          { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" },
          async () => runProbe({
            env,
            probe,
            attempt,
            fixture,
            credentialBindingName,
            spendLedgerKey: capabilityLedger.key,
            retryReason: attempt > 1 ? "bounded_capability_retry" : null,
          }),
        );''')

replace_once(
'''        await boundedBackoff(attempt);''',
'''        await boundedBackoff(step, `ODL-REQ-024 capability ${probe}`, attempt);''')

replace_once(
'''      const modelBody = modelDiscovery.parsedBody;
      const models = Array.isArray(modelBody.data) ? modelBody.data as Record<string, unknown>[] : [];
      const model = models.find((entry) => String(entry?.id ?? entry?.name ?? "") === OPENCODE_GO_MODEL) ?? {};
      const cache: OpenCodeGoCapabilityReceipt = {''',
'''      const model = modelDiscovery.modelMetadata ?? {
        id: OPENCODE_GO_MODEL,
        object: null,
        created: null,
        ownedBy: null,
        contextLength: null,
        inputModalities: [],
        outputModalities: [],
        pricingMetadataPresent: false,
      };
      const cache: OpenCodeGoCapabilityReceipt = {''')

replace_once(
'''          id: String(model.id ?? model.name ?? OPENCODE_GO_MODEL).slice(0, 100),
          object: model.object === undefined || model.object === null ? null : String(model.object).slice(0, 100),
          created: Number.isFinite(Number(model.created)) ? Number(model.created) : null,
          ownedBy: model.owned_by === undefined || model.owned_by === null ? null : String(model.owned_by).slice(0, 100),
          contextLength: Number.isFinite(Number(model.context_length)) ? Number(model.context_length) : null,
          inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities.map(String).slice(0, 16) : [],
          outputModalities: Array.isArray(model.output_modalities) ? model.output_modalities.map(String).slice(0, 16) : [],
          pricingMetadataPresent: Boolean(model.pricing && typeof model.pricing === "object"),''',
'''          id: model.id,
          object: model.object,
          created: model.created,
          ownedBy: model.ownedBy,
          contextLength: model.contextLength,
          inputModalities: model.inputModalities,
          outputModalities: model.outputModalities,
          pricingMetadataPresent: model.pricingMetadataPresent,''')

probe_type = text.split("type ProbeInternal", 1)[1].split("function boundedKeys", 1)[0]
if "parsedBody" in probe_type or "finalContent" in probe_type:
    raise SystemExit("raw provider content remains in durable ProbeInternal")
path.write_text(text)
