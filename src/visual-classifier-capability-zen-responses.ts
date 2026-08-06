import type { WorkflowStep } from "cloudflare:workers";
import { ConnectorError } from "./errors";
import { sha256Bytes } from "./integrated-core";
import { coordinatorRequest, errorResult, nowIso, putArtifact, requestHash, sha256HexUtf8, textResult, type PaidJobRecord } from "./paid-core";
import type { HotfixContext } from "./version20-hotfix";
import type { CapabilityStage } from "./visual-classifier-capability-common";
import { zenResponsesCapabilityOutputCeiling } from "./visual-classifier-capability-output-ceilings";
import { syntheticVisionProbeJpegBytes } from "./visual-catalogue-probe-fixture";
import {
  assertZenVisionFixtureRecognition,
  buildBoundedZenVisionDataUrl,
  inspectZenVisionProviderText,
  inspectZenVisionRequest,
  type ZenVisionProviderOutputClass,
  type ZenVisionRequestReceipt,
  type ZenVisionSemanticReceipt,
} from "./visual-zen-responses-vision";
import {
  ZEN_RESPONSES_CREDENTIAL_BINDING,
  ZEN_RESPONSES_ENDPOINT,
  ZEN_RESPONSES_ENDPOINT_FAMILY,
  ZEN_RESPONSES_MODE,
  ZEN_RESPONSES_MODEL,
  ZEN_RESPONSES_PROBE_VERSION,
  ZEN_RESPONSES_PROVIDER,
  buildZenResponsesRequest,
  initializeZenResponsesSpendLedger,
  readZenResponsesCapabilityCache,
  readZenResponsesSpendLedger,
  requestZenResponses,
  isZenResponsesTransportError,
  updateZenResponsesPricing,
  validateZenResponsesBudgets,
  writeZenResponsesCapabilityCache,
  zenResponsesCredential,
  type ZenResponsesCapabilityReceipt,
  type ZenResponsesModelMetadata,
  type ZenResponsesSpendLedger,
  type ZenResponsesStructuralReceipt,
  type ZenResponsesTransportReceipt,
  type ZenResponsesUsage,
} from "./visual-catalogue-zen-responses";
import {
  discoverZenResponsesModelWithReceipt,
  isZenModelsDiscoveryError,
  type ZenModelsDiscoveryReceipt,
} from "./visual-classifier-zen-model-discovery";

const PREFIX = `visual-compiler/provider-capability/${ZEN_RESPONSES_PROVIDER}/${ZEN_RESPONSES_MODEL}/${ZEN_RESPONSES_PROBE_VERSION}`;
const RECEIPT_TTL_MS = 60 * 60 * 1000;
export const ZEN_VISION_UNSTRUCTURED_PROBE_PROMPT = "Inspect the attached image. Reply with one short line that states every colored geometric shape with its left/right position, followed by the complete readable uppercase label. Do not explain.";
type StageState = "passed" | "failed" | "not_run";

export type ZenResponsesCapabilityAttempt = {
  version: 1;
  jobId: string;
  attemptNumber: number;
  stage: CapabilityStage;
  provider: typeof ZEN_RESPONSES_PROVIDER;
  mode: typeof ZEN_RESPONSES_MODE;
  exactModel: typeof ZEN_RESPONSES_MODEL;
  endpointFamily: typeof ZEN_RESPONSES_ENDPOINT_FAMILY;
  probeVersion: typeof ZEN_RESPONSES_PROBE_VERSION;
  credentialBindingName: typeof ZEN_RESPONSES_CREDENTIAL_BINDING;
  startedAt: string;
  completedAt: string;
  latencyMilliseconds: number;
  httpStatus: number | null;
  status: "passed" | "failed";
  parserResult: string;
  schemaValidationResult: string;
  structuralReceipt: ZenResponsesStructuralReceipt | null;
  transportReceipt: ZenResponsesTransportReceipt | null;
  discoveryReceipt: ZenModelsDiscoveryReceipt | null;
  usage: ZenResponsesUsage | null;
  accounting: ZenResponsesSpendLedger;
  errorCode: string | null;
  requestImageSha256: string | null;
  requestImageByteSize: number | null;
  requestImageMimeType: "image/jpeg" | null;
  visionRequestReceipt: ZenVisionRequestReceipt | null;
  providerOutputClass: ZenVisionProviderOutputClass | null;
  fixtureRecognitionBoolean: boolean | null;
  visionSemanticReceipt: ZenVisionSemanticReceipt | null;
  oneDriveAccessed: false;
  oneDriveMutationPerformed: false;
};

export type ZenResponsesCapabilityTerminalReceipt = {
  version: 1;
  capabilityJobId: string;
  provider: typeof ZEN_RESPONSES_PROVIDER;
  mode: typeof ZEN_RESPONSES_MODE;
  exactModel: typeof ZEN_RESPONSES_MODEL;
  endpoint: typeof ZEN_RESPONSES_ENDPOINT;
  endpointFamily: typeof ZEN_RESPONSES_ENDPOINT_FAMILY;
  probeVersion: typeof ZEN_RESPONSES_PROBE_VERSION;
  credentialBindingName: typeof ZEN_RESPONSES_CREDENTIAL_BINDING;
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  stageResults: Record<CapabilityStage, StageState>;
  attempts: ZenResponsesCapabilityAttempt[];
  modelDiscoveryWorked: boolean;
  textStructuredOutputWorked: boolean;
  visionUnstructuredWorked: boolean;
  visionStructuredOutputWorked: boolean;
  blockerClassification: string | null;
  modelDiscoveryReceipt: ZenModelsDiscoveryReceipt | null;
  accounting: ZenResponsesSpendLedger;
  oneDriveAccessed: false;
  oneDriveMutationPerformed: false;
  sourcePdfRead: false;
  providerFallbackUsed: false;
};

type Manifest = {
  version: 1;
  jobId: string;
  workflowId: string;
  userIdHash: string;
  status: "reserved" | "running" | "completed" | "failed";
  currentStage: CapabilityStage;
  forceFresh: boolean;
  maxBillableRequests: number;
  maxEstimatedSpendUsd: number;
  spendLedgerKey: string;
  modelMetadata: ZenResponsesModelMetadata | null;
  stageResults: Record<CapabilityStage, StageState>;
  attempts: ZenResponsesCapabilityAttempt[];
  terminalReceipt: ZenResponsesCapabilityTerminalReceipt | null;
  createdAt: string;
  updatedAt: string;
};

type Locator = { version: 1; jobId: string; maxBillableRequests: number; maxEstimatedSpendUsd: number };
type Payload = { jobId: string; workflowId: string; userId: string; input: Record<string, unknown> };

function manifestKey(jobId: string): string { return `${PREFIX}/jobs/${jobId}/manifest.json`; }
function locatorKey(jobId: string): string { return `${PREFIX}/locators/${jobId}.json`; }
function indexKey(requests: number, dollars: number): string { return `${PREFIX}/active-${requests}-${Math.round(dollars * 1_000_000)}.json`; }
function attemptKey(jobId: string, n: number, stage: CapabilityStage): string { return `${PREFIX}/jobs/${jobId}/attempts/${String(n).padStart(2, "0")}-${stage}.json`; }

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.ARTIFACTS.get(key);
  if (!object) return null;
  try { return JSON.parse(await object.text()) as T; } catch { return null; }
}

async function storeJson(env: Env, key: string, value: unknown, metadata: Record<string, string> = {}): Promise<void> {
  await putArtifact(env, key, JSON.stringify(value, null, 2), "application/json; charset=utf-8", metadata);
}

async function writeManifest(env: Env, manifest: Manifest): Promise<void> {
  manifest.updatedAt = nowIso();
  await storeJson(env, manifestKey(manifest.jobId), manifest, { jobId: manifest.jobId, status: manifest.status, stage: manifest.currentStage });
  await storeJson(env, indexKey(manifest.maxBillableRequests, manifest.maxEstimatedSpendUsd), {
    version: 1, jobId: manifest.jobId, maxBillableRequests: manifest.maxBillableRequests, maxEstimatedSpendUsd: manifest.maxEstimatedSpendUsd,
  }, { jobId: manifest.jobId, status: manifest.status });
}

async function updateJob(env: Env, userId: string, jobId: string, patch: Partial<PaidJobRecord>): Promise<void> {
  await coordinatorRequest(env, userId, "/jobs/update", { jobId, ...patch });
}

function stageOrder(): CapabilityStage[] {
  return ["model_discovery", "text_structured_output", "vision_unstructured", "vision_structured_output"];
}

function errorCode(error: unknown): string {
  if (error instanceof ConnectorError) return error.code;
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).code === "string") return String((error as Record<string, unknown>).code);
  return "provider_capability_failed";
}

function structuredSchema(): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false,
    properties: {
      blue_shape: { type: "string" }, red_shape: { type: "string" }, visible_text: { type: "string" }, capability_ready: { type: "boolean" },
    }, required: ["blue_shape", "red_shape", "visible_text", "capability_ready"],
  };
}

function textSchema(): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, probe: { type: "string" } }, required: ["ok", "probe"] };
}

async function runStage(env: Env, manifest: Manifest, stage: CapabilityStage): Promise<ZenResponsesCapabilityAttempt> {
  const startedAt = nowIso();
  const started = Date.now();
  const attemptNumber = manifest.attempts.length + 1;
  let httpStatus: number | null = null;
  let parserResult = "not_run";
  let schemaValidationResult = "not_run";
  let structuralReceipt: ZenResponsesStructuralReceipt | null = null;
  let transportReceipt: ZenResponsesTransportReceipt | null = null;
  let discoveryReceipt: ZenModelsDiscoveryReceipt | null = null;
  let usage: ZenResponsesUsage | null = null;
  let accounting = await readZenResponsesSpendLedger(env, manifest.spendLedgerKey);
  let status: "passed" | "failed" = "failed";
  let failure: string | null = null;
  let imageSha256: string | null = null;
  let imageByteSize: number | null = null;
  let visionRequestReceipt: ZenVisionRequestReceipt | null = null;
  let providerOutputClass: ZenVisionProviderOutputClass | null = null;
  let fixtureRecognitionBoolean: boolean | null = null;
  let visionSemanticReceipt: ZenVisionSemanticReceipt | null = null;
  try {
    if (stage === "model_discovery") {
      const discovery = await discoverZenResponsesModelWithReceipt(env, { provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE, model: ZEN_RESPONSES_MODEL });
      discoveryReceipt = discovery.receipt;
      httpStatus = discovery.receipt.httpStatus;
      manifest.modelMetadata = discovery.metadata;
      accounting = await updateZenResponsesPricing(env, manifest.spendLedgerKey, discovery.metadata.pricing);
      parserResult = discovery.receipt.parserResult;
      schemaValidationResult = "exact_model_present";
      status = "passed";
    } else {
      const fixture = stage.startsWith("vision_") ? syntheticVisionProbeJpegBytes() : null;
      if (fixture) {
        imageByteSize = fixture.byteLength;
        imageSha256 = await sha256Bytes(fixture);
      }
      const imageDataUrl = fixture ? buildBoundedZenVisionDataUrl(fixture) : undefined;
      const maxOutputTokens = zenResponsesCapabilityOutputCeiling(stage);
      const request = stage === "text_structured_output"
        ? buildZenResponsesRequest({ text: "Return JSON with ok=true and probe=odl-req-025.", maxOutputTokens, schema: { name: "text_probe", schema: textSchema() } })
        : stage === "vision_unstructured"
          ? buildZenResponsesRequest({ text: ZEN_VISION_UNSTRUCTURED_PROBE_PROMPT, imageDataUrl, maxOutputTokens })
          : buildZenResponsesRequest({ text: "Return the visible blue shape, red shape, exact visible text, and capability_ready=true.", imageDataUrl, maxOutputTokens, schema: { name: "vision_probe", schema: structuredSchema() } });
      if (fixture) visionRequestReceipt = await inspectZenVisionRequest(request, fixture);
      const result = await requestZenResponses({ env, spendLedgerKey: manifest.spendLedgerKey, body: request, context: `capability:${stage}`, requestIdentity: `${manifest.jobId}:${stage}` });
      httpStatus = result.status;
      structuralReceipt = result.structuralReceipt;
      transportReceipt = result.transportReceipt;
      usage = result.usage;
      accounting = result.accounting;
      parserResult = "output_text_parsed";
      if (stage === "text_structured_output") {
        const parsed = JSON.parse(result.text) as Record<string, unknown>;
        if (parsed.ok !== true || parsed.probe !== "odl-req-025") throw new ConnectorError("provider_structured_output_unsupported", "The text structured-output stage did not satisfy the exact schema contract.");
        schemaValidationResult = "valid";
      } else if (stage === "vision_unstructured") {
        visionSemanticReceipt = await inspectZenVisionProviderText(result.text, {
          completionStatus: transportReceipt.completionStatus ?? null,
          requestedOutputCeiling: transportReceipt.requestedMaxOutputTokens ?? null,
          reportedOutputTokens: transportReceipt.reportedOutputTokens ?? null,
          outputTokensReachedRequestedCeiling: transportReceipt.outputTokensReachedRequestedCeiling ?? null,
          partialOutputPresent: transportReceipt.partialOutputTextPresent ?? false,
        });
        providerOutputClass = visionSemanticReceipt.semanticClass;
        fixtureRecognitionBoolean = visionSemanticReceipt.fixtureRecognitionStatus === "recognized";
        assertZenVisionFixtureRecognition(visionSemanticReceipt);
        schemaValidationResult = "visual_fixture_matched";
      } else {
        const parsed = JSON.parse(result.text) as Record<string, unknown>;
        const rendered = `${parsed.blue_shape ?? ""} ${parsed.red_shape ?? ""} ${parsed.visible_text ?? ""}`;
        visionSemanticReceipt = await inspectZenVisionProviderText(rendered, {
          completionStatus: transportReceipt.completionStatus ?? null,
          requestedOutputCeiling: transportReceipt.requestedMaxOutputTokens ?? null,
          reportedOutputTokens: transportReceipt.reportedOutputTokens ?? null,
          outputTokensReachedRequestedCeiling: transportReceipt.outputTokensReachedRequestedCeiling ?? null,
          partialOutputPresent: transportReceipt.partialOutputTextPresent ?? false,
        });
        providerOutputClass = visionSemanticReceipt.semanticClass;
        fixtureRecognitionBoolean = visionSemanticReceipt.fixtureRecognitionStatus === "recognized";
        assertZenVisionFixtureRecognition(visionSemanticReceipt);
        if (parsed.capability_ready !== true) throw new ConnectorError("provider_structured_output_contract_failed", "The structured vision output did not set capability_ready=true.");
        schemaValidationResult = "valid";
      }
      status = "passed";
    }
  } catch (error) {
    failure = errorCode(error);
    if (isZenModelsDiscoveryError(error)) {
      discoveryReceipt = error.receipt;
      httpStatus = error.receipt.httpStatus;
      parserResult = error.receipt.parserResult;
      schemaValidationResult = error.code === "zen_model_exact_id_absent" ? "exact_model_absent" : "failed";
    } else if (isZenResponsesTransportError(error)) {
      transportReceipt = error.receipt;
      httpStatus = error.receipt.httpStatus;
      parserResult = error.receipt.parserResult;
      schemaValidationResult = error.receipt.schemaResult;
    } else {
      parserResult = parserResult === "not_run" ? "stage_failed" : parserResult;
      schemaValidationResult = schemaValidationResult === "not_run" ? "failed" : schemaValidationResult;
    }
  }
  return {
    version: 1, jobId: manifest.jobId, attemptNumber, stage, provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE,
    exactModel: ZEN_RESPONSES_MODEL, endpointFamily: ZEN_RESPONSES_ENDPOINT_FAMILY, probeVersion: ZEN_RESPONSES_PROBE_VERSION,
    credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING, startedAt, completedAt: nowIso(), latencyMilliseconds: Date.now() - started,
    httpStatus, status, parserResult, schemaValidationResult, structuralReceipt, transportReceipt, discoveryReceipt, usage, accounting, errorCode: failure,
    requestImageSha256: imageSha256, requestImageByteSize: imageByteSize, requestImageMimeType: imageByteSize === null ? null : "image/jpeg",
    visionRequestReceipt, providerOutputClass, fixtureRecognitionBoolean, visionSemanticReceipt,
    oneDriveAccessed: false, oneDriveMutationPerformed: false,
  };
}

function blocker(manifest: Manifest): string | null {
  const failed = manifest.attempts.find((attempt) => attempt.status === "failed");
  if (!failed) return null;
  return failed.errorCode === "zen_model_exact_id_absent" ? "opencode_zen_gpt_5_6_luna_unavailable" : failed.errorCode ?? "opencode_zen_responses_capability_failed";
}

export function isZenResponsesCapabilityWorkflowPayload(payload: { input?: Record<string, unknown> } | undefined): boolean {
  return Boolean(payload?.input?.__odlReq025ZenResponsesCapability);
}

export async function runZenResponsesCapabilityWorkflow(env: Env, payload: Payload, step: WorkflowStep): Promise<Record<string, unknown>> {
  const manifest = await readJson<Manifest>(env, manifestKey(payload.jobId));
  if (!manifest) throw new ConnectorError("capability_manifest_missing", "The Zen Responses capability manifest is missing.");
  manifest.status = "running";
  await writeManifest(env, manifest);
  await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: 1, stage: manifest.currentStage });
  for (const stage of stageOrder()) {
    if (manifest.stageResults[stage] === "passed") continue;
    manifest.currentStage = stage;
    await writeManifest(env, manifest);
    const attempt = await step.do(`Zen Responses capability ${stage}`, { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "2 minutes" }, async () => runStage(env, manifest, stage));
    manifest.attempts.push(attempt);
    manifest.stageResults[stage] = attempt.status;
    await storeJson(env, attemptKey(manifest.jobId, attempt.attemptNumber, stage), attempt, { jobId: manifest.jobId, stage, status: attempt.status });
    if (attempt.status === "failed") {
      manifest.status = "failed";
      const accounting = await readZenResponsesSpendLedger(env, manifest.spendLedgerKey);
      manifest.terminalReceipt = {
        version: 1, capabilityJobId: manifest.jobId, provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE,
        exactModel: ZEN_RESPONSES_MODEL, endpoint: ZEN_RESPONSES_ENDPOINT, endpointFamily: ZEN_RESPONSES_ENDPOINT_FAMILY,
        probeVersion: ZEN_RESPONSES_PROBE_VERSION, credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING,
        status: "failed", startedAt: manifest.createdAt, completedAt: nowIso(), stageResults: { ...manifest.stageResults }, attempts: manifest.attempts,
        modelDiscoveryWorked: manifest.stageResults.model_discovery === "passed", textStructuredOutputWorked: manifest.stageResults.text_structured_output === "passed",
        visionUnstructuredWorked: manifest.stageResults.vision_unstructured === "passed", visionStructuredOutputWorked: manifest.stageResults.vision_structured_output === "passed",
        blockerClassification: blocker(manifest), modelDiscoveryReceipt: manifest.attempts.find((entry) => entry.stage === "model_discovery")?.discoveryReceipt ?? null, accounting, oneDriveAccessed: false, oneDriveMutationPerformed: false, sourcePdfRead: false, providerFallbackUsed: false,
      };
      await writeManifest(env, manifest);
      await updateJob(env, payload.userId, payload.jobId, { status: "failed", progress: 100, stage: "failed", error: { code: manifest.terminalReceipt.blockerClassification ?? "opencode_zen_responses_capability_failed", message: "A mandatory Zen Responses capability stage failed.", retryable: false } });
      return manifest.terminalReceipt as unknown as Record<string, unknown>;
    }
    await updateJob(env, payload.userId, payload.jobId, { status: "running", progress: Math.min(90, 10 + manifest.attempts.length * 20), stage });
  }
  const accounting = await readZenResponsesSpendLedger(env, manifest.spendLedgerKey);
  const vision = manifest.attempts.find((attempt) => attempt.stage === "vision_structured_output") as ZenResponsesCapabilityAttempt;
  const capability: ZenResponsesCapabilityReceipt = {
    provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE, model: ZEN_RESPONSES_MODEL, exactModel: ZEN_RESPONSES_MODEL,
    endpoint: ZEN_RESPONSES_ENDPOINT, endpointFamily: ZEN_RESPONSES_ENDPOINT_FAMILY, probeVersion: ZEN_RESPONSES_PROBE_VERSION,
    credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING, discoveryTimestamp: nowIso(), discoveryCacheHit: false, modelPresent: true,
    modelMetadata: manifest.modelMetadata as ZenResponsesModelMetadata,
    visionProbe: { passed: true, status: vision.httpStatus ?? 200, latencyMilliseconds: vision.latencyMilliseconds, exactTextObserved: true, blueSquareObserved: true, redCircleObserved: true, detailFieldAccepted: false, sanitizedUsage: vision.usage ?? { inputTokens: null, outputTokens: null, cachedReadTokens: null, cachedWriteTokens: null, totalTokens: null, reported: false } },
    structuredOutput: { responseFormatAccepted: true, jsonObjectReliable: true }, spendScopeId: manifest.jobId, spendLedgerKey: manifest.spendLedgerKey,
    maxBillableRequests: manifest.maxBillableRequests, maxEstimatedSpendUsd: manifest.maxEstimatedSpendUsd, accounting,
    costClassification: accounting.estimatedSpendUsd === null ? "usage_not_reported" : "provider_metered_or_fallback_estimate",
  };
  await writeZenResponsesCapabilityCache(env, capability);
  manifest.status = "completed";
  manifest.terminalReceipt = {
    version: 1, capabilityJobId: manifest.jobId, provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE,
    exactModel: ZEN_RESPONSES_MODEL, endpoint: ZEN_RESPONSES_ENDPOINT, endpointFamily: ZEN_RESPONSES_ENDPOINT_FAMILY,
    probeVersion: ZEN_RESPONSES_PROBE_VERSION, credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING,
    status: "passed", startedAt: manifest.createdAt, completedAt: nowIso(), stageResults: { ...manifest.stageResults }, attempts: manifest.attempts,
    modelDiscoveryWorked: true, textStructuredOutputWorked: true, visionUnstructuredWorked: true, visionStructuredOutputWorked: true,
    blockerClassification: null, modelDiscoveryReceipt: manifest.attempts.find((entry) => entry.stage === "model_discovery")?.discoveryReceipt ?? null, accounting, oneDriveAccessed: false, oneDriveMutationPerformed: false, sourcePdfRead: false, providerFallbackUsed: false,
  };
  await writeManifest(env, manifest);
  await updateJob(env, payload.userId, payload.jobId, { status: "completed", progress: 100, stage: "completed", error: null });
  return manifest.terminalReceipt as unknown as Record<string, unknown>;
}

export async function startZenResponsesCapabilityJob(context: HotfixContext, raw: Record<string, unknown>): Promise<ReturnType<typeof textResult>> {
  if (String(raw.provider ?? "") !== ZEN_RESPONSES_PROVIDER || String(raw.mode ?? "") !== ZEN_RESPONSES_MODE) throw new ConnectorError("classifier_configuration_invalid", "Zen Responses capability jobs require exact provider and mode identity.");
  if (String(raw.model ?? "") !== ZEN_RESPONSES_MODEL) throw new ConnectorError("provider_model_not_allowed", "Zen Responses capability jobs require exact model gpt-5.6-luna.");
  zenResponsesCredential(context.env);
  const budgets = validateZenResponsesBudgets(raw.maxBillableRequests, raw.maxEstimatedSpendUsd);
  const index = await readJson<Locator>(context.env, indexKey(budgets.maxBillableRequests, budgets.maxEstimatedSpendUsd));
  if (index) {
    const existing = await readJson<Manifest>(context.env, manifestKey(index.jobId));
    if (existing && ["reserved", "running"].includes(existing.status)) return textResult({ jobId: existing.jobId, workflowId: existing.workflowId, status: existing.status, currentStage: existing.currentStage, idempotentReplay: true, oneDriveMutationPerformed: false, recommendedNextOperation: "get_visual_classifier_capability_job" });
    if (!raw.forceFresh && existing?.terminalReceipt?.status === "passed" && Date.now() - Date.parse(existing.terminalReceipt.completedAt) <= RECEIPT_TTL_MS) return textResult({ jobId: existing.jobId, workflowId: existing.workflowId, status: existing.status, terminalReceipt: existing.terminalReceipt, idempotentReplay: true, oneDriveMutationPerformed: false, recommendedNextOperation: "get_visual_classifier_capability_job" });
  }
  const reservation = { provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE, model: ZEN_RESPONSES_MODEL, probeVersion: ZEN_RESPONSES_PROBE_VERSION, credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING, ...budgets, forceFresh: Boolean(raw.forceFresh), forceNonce: raw.forceFresh ? crypto.randomUUID() : null };
  const hash = await requestHash("start_visual_classifier_capability_job", reservation);
  const requestedJobId = crypto.randomUUID();
  const job = await coordinatorRequest<PaidJobRecord>(context.env, context.userId, "/jobs/begin", { jobId: requestedJobId, workflowId: requestedJobId, toolName: "start_visual_classifier_capability_job", requestHash: hash });
  const ledger = await initializeZenResponsesSpendLedger(context.env, job.jobId, budgets.maxBillableRequests, budgets.maxEstimatedSpendUsd);
  const timestamp = nowIso();
  const manifest: Manifest = {
    version: 1, jobId: job.jobId, workflowId: job.workflowId, userIdHash: await sha256HexUtf8(context.userId), status: "reserved", currentStage: "model_discovery",
    forceFresh: Boolean(raw.forceFresh), ...budgets, spendLedgerKey: ledger.key, modelMetadata: null,
    stageResults: { model_discovery: "not_run", text_structured_output: "not_run", vision_unstructured: "not_run", vision_structured_output: "not_run" }, attempts: [], terminalReceipt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  await storeJson(context.env, locatorKey(job.jobId), { version: 1, jobId: job.jobId, ...budgets } satisfies Locator, { jobId: job.jobId });
  await writeManifest(context.env, manifest);
  const payload: Payload = { jobId: job.jobId, workflowId: job.workflowId, userId: context.userId, input: { __odlReq025ZenResponsesCapability: true, ...budgets } };
  try { await (context.env.VISUAL_CATALOGUE_WORKFLOW as any).create({ id: job.workflowId, params: payload }); }
  catch (error) { if (!/already exists|duplicate|conflict/i.test(error instanceof Error ? error.message : String(error))) throw error; }
  return textResult({ jobId: job.jobId, workflowId: job.workflowId, status: job.status, currentStage: "model_discovery", asynchronous: true, provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE, model: ZEN_RESPONSES_MODEL, endpointFamily: ZEN_RESPONSES_ENDPOINT_FAMILY, probeVersion: ZEN_RESPONSES_PROBE_VERSION, credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING, ...budgets, idempotentReplay: job.jobId !== requestedJobId, oneDriveMutationPerformed: false, recommendedNextOperation: "get_visual_classifier_capability_job" });
}

export async function getZenResponsesCapabilityJob(context: HotfixContext, jobId: string): Promise<ReturnType<typeof textResult> | null> {
  const locator = await readJson<Locator>(context.env, locatorKey(jobId));
  if (!locator) return null;
  const manifest = await readJson<Manifest>(context.env, manifestKey(jobId));
  if (!manifest) return null;
  const accounting = await readZenResponsesSpendLedger(context.env, manifest.spendLedgerKey);
  return textResult({ jobId, workflowId: manifest.workflowId, status: manifest.status, currentStage: manifest.currentStage, provider: ZEN_RESPONSES_PROVIDER, mode: ZEN_RESPONSES_MODE, model: ZEN_RESPONSES_MODEL, endpointFamily: ZEN_RESPONSES_ENDPOINT_FAMILY, probeVersion: ZEN_RESPONSES_PROBE_VERSION, credentialBindingName: ZEN_RESPONSES_CREDENTIAL_BINDING, stageResults: manifest.stageResults, attemptHistorySummary: manifest.attempts.map((attempt) => ({ attemptNumber: attempt.attemptNumber, stage: attempt.stage, status: attempt.status, httpStatus: attempt.httpStatus, latencyMilliseconds: attempt.latencyMilliseconds, parserResult: attempt.parserResult, schemaValidationResult: attempt.schemaValidationResult, structuralReceipt: attempt.structuralReceipt, transportReceipt: attempt.transportReceipt ?? null, discoveryReceipt: attempt.discoveryReceipt ?? null, errorCode: attempt.errorCode })), accounting, terminalReceipt: manifest.terminalReceipt, privateUrlsReturned: false, secretValuesReturned: false, generatedContentReturned: false, oneDriveMutationPerformed: false });
}

export async function readSuccessfulZenResponsesCapabilityReceipt(env: Env, expected: { maxBillableRequests?: number; maxEstimatedSpendUsd?: number }): Promise<ZenResponsesCapabilityReceipt | null> {
  const budgets = validateZenResponsesBudgets(expected.maxBillableRequests, expected.maxEstimatedSpendUsd);
  const cached = await readZenResponsesCapabilityCache(env);
  if (!cached || cached.maxBillableRequests !== budgets.maxBillableRequests || cached.maxEstimatedSpendUsd !== budgets.maxEstimatedSpendUsd) return null;
  if (cached.credentialBindingName !== ZEN_RESPONSES_CREDENTIAL_BINDING || cached.endpoint !== ZEN_RESPONSES_ENDPOINT) return null;
  return cached;
}

export function errorZenResponsesCapability(error: unknown) { return errorResult(error); }
