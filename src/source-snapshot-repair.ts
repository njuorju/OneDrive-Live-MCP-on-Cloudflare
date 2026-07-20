import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { safeErrorResult } from "./errors";
import { INTEGRATED_LIMITS } from "./integrated-core";
import type { HotfixContext } from "./version20-hotfix";
import {
  continueSourceSnapshotJob,
  createSourceSnapshot,
  getJobStatus,
  snapshotRunnerTestHooks,
  type ScheduleSnapshot,
  type SnapshotInput,
} from "./snapshot-runner";
import { reliableGraphResponse, snapshotGraphTestHooks } from "./snapshot-graph";

function textResult(data: unknown): CallToolResult {
  const structuredContent = data && typeof data === "object" ? data as Record<string, unknown> : { value: data };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  return safeErrorResult(error) as CallToolResult;
}

export function registerSourceSnapshotRepairTools(
  server: McpServer,
  contextFactory: () => HotfixContext,
  schedule: ScheduleSnapshot,
): void {
  const target = server as any;
  const originalSend = target.sendToolListChanged;
  target.sendToolListChanged = () => undefined;
  try {
    server.registerTool(
      "create_source_snapshot",
      {
        title: "Create resumable immutable source snapshot",
        description: "Create a bounded immutable logical snapshot with retrying Graph requests, page checkpoints, resumable Durable Object scheduling, and live-mutation detection.",
        inputSchema: {
          scopePath: z.string().max(1000).default(""),
          recursive: z.boolean().default(true),
          includeFiles: z.boolean().default(true),
          includeFolders: z.boolean().default(true),
          calculateSha256: z.boolean().default(false),
          calculateNormalizedTextHash: z.boolean().default(false),
          includeDocumentMetadata: z.boolean().default(false),
          includeExtractionStatus: z.boolean().default(true),
          maximumItems: z.number().int().min(1).max(INTEGRATED_LIMITS.snapshotItemsMax).default(INTEGRATED_LIMITS.snapshotItemsDefault),
          maximumDepth: z.number().int().min(0).max(INTEGRATED_LIMITS.recursionDepthMax).default(INTEGRATED_LIMITS.recursionDepthDefault),
          extensionAllowlist: z.array(z.string().max(20)).max(100).optional(),
          extensionDenylist: z.array(z.string().max(20)).max(100).optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (input) => {
        try {
          return textResult(await createSourceSnapshot(contextFactory(), schedule, input as SnapshotInput));
        } catch (error) {
          return errorResult(error);
        }
      },
    );
    server.registerTool(
      "get_job_status",
      {
        title: "Get integrated job status",
        description: "Return queued, running, completed, failed, or cancelled status with resumable snapshot progress and structured terminal errors.",
        inputSchema: { jobId: z.string().uuid() },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ jobId }) => {
        try {
          return textResult(await getJobStatus(contextFactory(), schedule, jobId));
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  } finally {
    target.sendToolListChanged = originalSend;
  }
}

export { continueSourceSnapshotJob, reliableGraphResponse };
export const snapshotRepairTestHooks = {
  ...snapshotGraphTestHooks,
  ...snapshotRunnerTestHooks,
};
