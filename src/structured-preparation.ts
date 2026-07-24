import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError } from "./errors";
import { errorResult, sha256HexUtf8, textResult } from "./paid-core";
import { verifyCataloguePairParity, type StructuredPatch } from "./structured-catalogue";
import {
  buildPreparedPlanActions,
  prepareOne,
  preparedContents,
  readPreparation,
  storePreparation,
} from "./structured-preparation-store";
import type { HotfixContext } from "./version20-hotfix";

const NON_DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const MAX_PATCHES = 500;
const MAX_PREVIEW = 10_000;

function tool(server: McpServer, name: string): any {
  return (server as any)._registeredTools?.[name];
}

const patchSchema = z.object({
  recordKey: z.string().min(1).max(500),
  expected: z.record(z.string(), z.unknown()).optional(),
  set: z.record(z.string(), z.unknown()).optional(),
  clear: z.array(z.string().min(1).max(200)).max(200).optional(),
  appendNote: z.object({
    field: z.string().min(1).max(200),
    note: z.string().min(1).max(20_000),
    separator: z.string().max(100).optional(),
  }).optional(),
});

export function registerStructuredPreparationTools(server: McpServer, contextFactory: () => HotfixContext): void {
  const createPlan = tool(server, "create_integrity_plan");
  if (!createPlan?.handler) throw new Error("create_integrity_plan must be registered before structured preparation tools.");

  server.registerTool("prepare_structured_text_patch", {
    title: "Prepare deterministic structured text patch",
    description: "Read one UTF-8 CSV or JSON-array catalogue, apply stable-key assertions and field patches without changing OneDrive, and store exact prepared bytes privately in R2.",
    inputSchema: {
      itemId: z.string().min(1).max(500),
      expectedETag: z.string().max(1000).optional(),
      format: z.enum(["auto", "csv", "json"]).default("auto"),
      recordKeyField: z.string().min(1).max(200),
      patches: z.array(patchSchema).min(1).max(MAX_PATCHES),
      previewCharacters: z.number().int().min(0).max(MAX_PREVIEW).default(2_000),
    },
    annotations: NON_DESTRUCTIVE,
  }, async (input) => {
    const context = contextFactory();
    try {
      const item = await prepareOne(context, input, "single");
      const result = await storePreparation(context, "single", input.recordKeyField, input.patches as StructuredPatch[], [item], null);
      return textResult({
        preparationId: result.definition.preparationId,
        fingerprint: result.definition.fingerprint,
        kind: result.definition.kind,
        items: result.definition.items,
        idempotentReplay: result.idempotentReplay,
        exactPreparedBytesStoredPrivately: true,
        oneDriveMutationPerformed: false,
        recommendedNextOperation: "commit_prepared_integrity_plan",
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("prepare_catalogue_pair_update", {
    title: "Prepare deterministic CSV and JSON catalogue pair",
    description: "Apply one semantic patch set to paired UTF-8 CSV and JSON-array catalogues, verify parity, and store exact prepared bytes privately without changing OneDrive.",
    inputSchema: {
      csvItemId: z.string().min(1).max(500),
      jsonItemId: z.string().min(1).max(500),
      expectedCsvETag: z.string().max(1000).optional(),
      expectedJsonETag: z.string().max(1000).optional(),
      recordKeyField: z.string().min(1).max(200),
      patches: z.array(patchSchema).min(1).max(MAX_PATCHES),
      previewCharacters: z.number().int().min(0).max(MAX_PREVIEW).default(2_000),
    },
    annotations: NON_DESTRUCTIVE,
  }, async (input) => {
    const context = contextFactory();
    try {
      const common = { recordKeyField: input.recordKeyField, patches: input.patches as StructuredPatch[], previewCharacters: input.previewCharacters };
      const csv = await prepareOne(context, { ...common, itemId: input.csvItemId, expectedETag: input.expectedCsvETag, format: "csv" }, "csv");
      const json = await prepareOne(context, { ...common, itemId: input.jsonItemId, expectedETag: input.expectedJsonETag, format: "json" }, "json");
      const semanticDigest = await sha256HexUtf8(verifyCataloguePairParity(csv.records, json.records, input.recordKeyField));
      const result = await storePreparation(context, "catalogue_pair", input.recordKeyField, input.patches as StructuredPatch[], [csv, json], semanticDigest);
      return textResult({
        preparationId: result.definition.preparationId,
        fingerprint: result.definition.fingerprint,
        kind: result.definition.kind,
        semanticCsvJsonParity: true,
        semanticDigest,
        items: result.definition.items,
        idempotentReplay: result.idempotentReplay,
        exactPreparedBytesStoredPrivately: true,
        oneDriveMutationPerformed: false,
        recommendedNextOperation: "commit_prepared_integrity_plan",
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("commit_prepared_integrity_plan", {
    title: "Commit prepared bytes into an integrity-plan draft",
    description: "Verify unchanged source eTags and the immutable preparation fingerprint, then create a non-executed integrity plan containing exactly the prepared R2 bytes. This does not mutate OneDrive.",
    inputSchema: {
      preparationId: z.string().regex(/^prep_[0-9a-f]{48}$/),
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      snapshotId: z.string().uuid(),
      scopePath: z.string().max(1000).optional(),
      reason: z.string().min(1).max(5_000).default("Commit deterministic structured catalogue preparation into a non-executed integrity plan."),
      actionIdPrefix: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100).default("prepared-catalogue"),
    },
    annotations: NON_DESTRUCTIVE,
  }, async (input) => {
    const context = contextFactory();
    try {
      const definition = await readPreparation(context, input.preparationId);
      if (definition.fingerprint !== input.fingerprint) throw new ConnectorError("preparation_fingerprint_changed", "The supplied preparation fingerprint does not match the immutable stored definition.");
      const actions = buildPreparedPlanActions(definition, await preparedContents(context, definition), input.reason, input.actionIdPrefix);
      const result = await createPlan.handler({ snapshotId: input.snapshotId, scopePath: input.scopePath, actions }, {}) as CallToolResult;
      if (result.isError) return result;
      const structured = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent as Record<string, unknown> : {};
      return textResult({
        ...structured,
        preparationId: definition.preparationId,
        preparationFingerprint: definition.fingerprint,
        preparedPayloadHashes: definition.items.map((item) => ({ role: item.role, sha256: item.outputSha256, byteLength: item.outputByteLength })),
        commitMutationPerformed: false,
        oneDriveMutationPerformed: false,
        planValidated: false,
        planExecuted: false,
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}
