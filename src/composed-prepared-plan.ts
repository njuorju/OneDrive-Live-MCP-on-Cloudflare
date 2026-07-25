import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult, textResult } from "./paid-core";
import {
  buildPreparedPlanActions,
  preparedContents,
  readPreparation,
} from "./structured-preparation-store";
import {
  assertPreparationFingerprint,
  composePreparedPlanActions,
} from "./prepared-plan-composition";
import type { HotfixContext } from "./version20-hotfix";

const NON_DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function tool(server: McpServer, name: string): any {
  return (server as any)._registeredTools?.[name];
}

const actionIdSchema = z.string().min(1).max(200);
const renameActionSchema = z.object({
  actionId: actionIdSchema,
  action: z.literal("RENAME"),
  sourceItemId: z.string().min(1).max(500),
  sourcePath: z.string().max(1000),
  destinationPath: z.string().max(1000).nullable().optional(),
  currentFilename: z.string().max(255),
  proposedFilename: z.string().max(255),
  snapshotETag: z.string().max(1000),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
  normalizedTextSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  reason: z.string().max(5000).nullable().optional(),
  evidence: z.unknown().optional(),
  destructive: z.boolean().optional(),
  ambiguity: z.union([z.boolean(), z.enum(["yes", "no"])]).optional(),
  finalDecision: z.string().max(200).nullable().optional(),
  operationOrder: z.number().int().min(0).optional(),
  dependencies: z.array(actionIdSchema).max(500).optional(),
  content: z.never().optional(),
  requiredStructuralPlaceholder: z.boolean().optional(),
}).strict();

export function registerComposedPreparedPlanTool(server: McpServer, contextFactory: () => HotfixContext): void {
  const createPlan = tool(server, "create_integrity_plan");
  if (!createPlan?.handler) throw new Error("create_integrity_plan must be registered before composed prepared-plan tools.");

  server.registerTool("commit_composed_prepared_integrity_plan", {
    title: "Commit composed prepared integrity-plan draft",
    description: "Compose caller-specified RENAME actions with exact immutable prepared payload actions, validate the dependency graph, and create one non-executed integrity-plan draft without mutating OneDrive.",
    inputSchema: {
      preparationId: z.string().regex(/^prep_[0-9a-f]{48}$/),
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      snapshotId: z.string().uuid(),
      scopePath: z.string().min(1).max(1000),
      reason: z.string().min(1).max(5000),
      actionIdPrefix: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100),
      additionalActions: z.array(renameActionSchema).min(1).max(5000),
      preparedActionIds: z.record(z.string(), actionIdSchema),
      preparedDependencies: z.record(z.string(), z.array(actionIdSchema).max(500)),
    },
    annotations: NON_DESTRUCTIVE,
  }, async (input) => {
    const context = contextFactory();
    try {
      const definition = await readPreparation(context, input.preparationId);
      assertPreparationFingerprint(definition, input.fingerprint);
      const contents = await preparedContents(context, definition);
      const preparedActions = buildPreparedPlanActions(definition, contents, input.reason, input.actionIdPrefix);
      const actions = composePreparedPlanActions({
        scopePath: input.scopePath,
        preparedItems: definition.items,
        preparedActions,
        additionalActions: input.additionalActions,
        preparedActionIds: input.preparedActionIds,
        preparedDependencies: input.preparedDependencies,
      });
      const result = await createPlan.handler({
        snapshotId: input.snapshotId,
        scopePath: input.scopePath,
        actions,
      }, {}) as CallToolResult;
      if (result.isError) return result;
      const structured = result.structuredContent && typeof result.structuredContent === "object"
        ? result.structuredContent as Record<string, unknown>
        : {};
      return textResult({
        ...structured,
        preparationId: definition.preparationId,
        preparationFingerprint: definition.fingerprint,
        preparedPayloadHashes: definition.items.map((item) => ({
          role: item.role,
          sha256: item.outputSha256,
          byteLength: item.outputByteLength,
        })),
        composedActionCount: actions.length,
        additionalActionCount: input.additionalActions.length,
        preparedActionCount: definition.items.length,
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
