import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  OPENCODE_GO_CHAT_ENDPOINT,
  OPENCODE_GO_FALLBACK_PRICING,
  OPENCODE_GO_MODE,
  OPENCODE_GO_MODEL,
  OPENCODE_GO_MODELS_ENDPOINT,
  OPENCODE_GO_PROVIDER,
  assertOpenCodeGoBudgetAvailable,
  initializeOpenCodeGoSpendLedger,
  parseOpenCodeGoUsage,
  recordOpenCodeGoAccounting,
  resolveOpenCodeGoPricing,
  selectOpenCodeGoCredentialBinding,
  validateOpenCodeGoBudgets,
} from "../src/visual-catalogue-opencode-go";
import { OPENCODE_ZEN_MODEL, resolveClassifierSelection } from "../src/visual-catalogue-opencode";
import { preciseOpenCodeGoBlocker } from "../src/visual-classifier-capability-go";

class MemoryR2 {
  values = new Map<string, Uint8Array>();
  async put(key: string, body: string | Uint8Array | ArrayBuffer): Promise<void> {
    this.values.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body));
  }
  async get(key: string): Promise<any | null> {
    const bytes = this.values.get(key);
    if (!bytes) return null;
    return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
  }
  async head(key: string): Promise<any | null> { return this.values.has(key) ? {} : null; }
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    OPENCODE_GO_API_KEY: "go-secret",
    OPENCODE_ZEN_API_KEY: "zen-secret",
    OPENAI_API_KEY: undefined,
    ARTIFACTS: new MemoryR2() as unknown as R2Bucket,
    ...overrides,
  } as unknown as Env;
}

test("OpenCode Go uses the exact paid endpoints and model", () => {
  assert.equal(OPENCODE_GO_MODELS_ENDPOINT, "https://opencode.ai/zen/go/v1/models");
  assert.equal(OPENCODE_GO_CHAT_ENDPOINT, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(OPENCODE_GO_PROVIDER, "opencode_go");
  assert.equal(OPENCODE_GO_MODE, "opencode_go_chat_completions");
  assert.equal(OPENCODE_GO_MODEL, "mimo-v2.5");
});

test("Go selection accepts only mimo-v2.5 and has no OpenAI dependency or fallback", () => {
  const selected = resolveClassifierSelection({
    classifierProvider: "opencode_go",
    classifierMode: "opencode_go_chat_completions",
    model: "mimo-v2.5",
    allowPaidFallback: false,
    dataSensitivity: "public",
    maxBillableRequests: 75,
    maxEstimatedSpendUsd: 1,
  }, env());
  assert.equal(selected.provider, "opencode_go");
  assert.equal(selected.model, "mimo-v2.5");
  assert.equal(selected.maxBillableRequests, 75);
  assert.throws(() => resolveClassifierSelection({ ...selected, classifierProvider: "opencode_go", classifierMode: "opencode_go_chat_completions", model: OPENCODE_ZEN_MODEL, dataSensitivity: "public", dryRun: true }, env()), /exact model/i);
  assert.throws(() => resolveClassifierSelection({ ...selected, classifierProvider: "opencode_go", classifierMode: "opencode_go_chat_completions", model: "mimo-v2.5-pro", dataSensitivity: "public", dryRun: true }, env()), /exact model/i);
  assert.throws(() => resolveClassifierSelection({ ...selected, classifierProvider: "opencode_go", classifierMode: "opencode_go_chat_completions", model: OPENCODE_GO_MODEL, allowPaidFallback: true, dataSensitivity: "public", dryRun: true }, env()), /fallback/i);
});

test("credential order prefers OPENCODE_GO_API_KEY and otherwise selects the existing Zen binding only for an access probe", () => {
  assert.equal(selectOpenCodeGoCredentialBinding(env()), "OPENCODE_GO_API_KEY");
  assert.equal(selectOpenCodeGoCredentialBinding(env({ OPENCODE_GO_API_KEY: "" })), "OPENCODE_ZEN_API_KEY");
  assert.throws(() => selectOpenCodeGoCredentialBinding(env({ OPENCODE_GO_API_KEY: "", OPENCODE_ZEN_API_KEY: "" })), /Neither/);
});

test("paid budgets are hard bounded", () => {
  assert.deepEqual(validateOpenCodeGoBudgets(75, 1), { maxBillableRequests: 75, maxEstimatedSpendUsd: 1 });
  assert.throws(() => validateOpenCodeGoBudgets(76, 1), /maxBillableRequests/);
  assert.throws(() => validateOpenCodeGoBudgets(75, 1.01), /maxEstimatedSpendUsd/);
});

test("fallback pricing and cached token usage match the frozen table", () => {
  assert.deepEqual(resolveOpenCodeGoPricing(null), OPENCODE_GO_FALLBACK_PRICING);
  assert.deepEqual(parseOpenCodeGoUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, total_tokens: 120 } }), {
    inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, totalTokens: 120, reported: true,
  });
});

test("accounting enforces request ceiling and treats absent usage conservatively", async () => {
  const testEnv = env();
  const initialized = await initializeOpenCodeGoSpendLedger(testEnv, { scopeId: "test-scope", credentialBindingName: "OPENCODE_GO_API_KEY", maxBillableRequests: 2, maxEstimatedSpendUsd: 1 });
  const first = await recordOpenCodeGoAccounting(testEnv, initialized.key, { context: "one", httpStatus: 200, costBearing: true, body: { usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } } });
  assert.equal(first.billableRequestCount, 1);
  assert.equal(first.estimatedSpendUsd, 0.42);
  const second = await recordOpenCodeGoAccounting(testEnv, initialized.key, { context: "two", httpStatus: 200, costBearing: true, body: {} });
  assert.equal(second.billableRequestCount, 2);
  assert.equal(second.estimatedSpendUsd, null);
  assert.equal(second.dollarEnforcement, "conservative_request_ceiling_only");
  await assert.rejects(() => assertOpenCodeGoBudgetAvailable(testEnv, initialized.key), /maxBillableRequests/);
});

test("Go access denial has a precise blocker and identities stay separate from free", () => {
  const blocker = preciseOpenCodeGoBlocker({
    credentialBindingName: "OPENCODE_ZEN_API_KEY",
    attempts: [{ probeStage: "model_discovery", normalizedResponseClass: "authorization_failed" }] as any,
  });
  assert.equal(blocker, "opencode_go_access_not_authorized");
  assert.notEqual(`${OPENCODE_GO_PROVIDER}|${OPENCODE_GO_MODE}|${OPENCODE_GO_MODEL}`, `opencode_zen|opencode_chat_completions|${OPENCODE_ZEN_MODEL}`);
});

test("implementation adds no catalogue mutation or rerender route", async () => {
  const go = await readFile(new URL("../src/visual-catalogue-opencode-go.ts", import.meta.url), "utf8");
  const capability = await readFile(new URL("../src/visual-classifier-capability-go.ts", import.meta.url), "utf8");
  assert.doesNotMatch(go, /createUploadSession|graph\.microsoft|publish_cached_visual_assets|commit_visual_catalogue_publication/i);
  assert.doesNotMatch(capability, /renderAndCache|save_document_visual|apply_visual_catalogue_review/i);
});
