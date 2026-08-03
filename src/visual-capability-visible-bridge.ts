import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
};

type RegisteredTool = {
  handler?: (input: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
  __odlReq021VisibleBridge?: boolean;
};

function registeredTool(server: McpServer, name: string): RegisteredTool | undefined {
  return (server as any)._registeredTools?.[name] as RegisteredTool | undefined;
}

function resultErrorCode(result: ToolResult): string | null {
  const error = result.structuredContent?.error;
  return error && typeof error === "object"
    ? String((error as Record<string, unknown>).code ?? "") || null
    : null;
}

function addCompatibilityRoute(result: ToolResult): ToolResult {
  if (!result.structuredContent || result.isError) return result;
  const structuredContent = {
    ...result.structuredContent,
    prerequisite: "visual_classifier_capability",
    compatibilityStatusTool: "get_visual_catalogue_job",
  };
  return {
    ...result,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

/**
 * Backward-compatible bridge for clients whose cached action catalogue has not
 * yet learned the dedicated ODL-REQ-021 capability tool names.
 *
 * The dedicated tools remain authoritative. This bridge only:
 *  - starts the separate capability job when an OpenCode calibration request
 *    correctly fails at the capability-receipt gate; and
 *  - lets the already-visible visual-job status tool read that capability job.
 *
 * It never starts candidate classification before a passing receipt and never
 * mutates OneDrive or a Visual catalogue.
 */
export function registerODLReq021VisibleBridge(server: McpServer): void {
  const startVisual = registeredTool(server, "start_visual_catalogue_job");
  const startCapability = registeredTool(server, "start_visual_classifier_capability_job");
  if (startVisual?.handler && startCapability?.handler && !startVisual.__odlReq021VisibleBridge) {
    const originalStartVisual = startVisual.handler;
    const hiddenStartCapability = startCapability.handler;
    startVisual.handler = async (input, extra) => {
      const result = await originalStartVisual(input, extra);
      if (resultErrorCode(result) !== "provider_capability_receipt_required") return result;
      const capabilityResult = await hiddenStartCapability({
        provider: input.classifierProvider ?? "opencode_zen",
        mode: input.classifierMode ?? "opencode_chat_completions",
        model: input.model ?? "mimo-v2.5-free",
        forceFresh: true,
        maxBillableRequests: input.maxBillableRequests,
        maxEstimatedSpendUsd: input.maxEstimatedSpendUsd,
      }, extra);
      return addCompatibilityRoute(capabilityResult);
    };
    startVisual.__odlReq021VisibleBridge = true;
  }

  const getVisual = registeredTool(server, "get_visual_catalogue_job");
  const getCapability = registeredTool(server, "get_visual_classifier_capability_job");
  if (getVisual?.handler && getCapability?.handler && !getVisual.__odlReq021VisibleBridge) {
    const originalGetVisual = getVisual.handler;
    const hiddenGetCapability = getCapability.handler;
    getVisual.handler = async (input, extra) => {
      const result = await originalGetVisual(input, extra);
      const toolName = String(result.structuredContent?.toolName ?? "");
      if (!result.isError && toolName === "start_visual_classifier_capability_job") {
        const capabilityResult = await hiddenGetCapability(input, extra);
        return capabilityResult.isError ? result : addCompatibilityRoute(capabilityResult);
      }
      const code = resultErrorCode(result);
      if (!result.isError || !["artifact_not_found", "visual_job_not_found", "job_not_found"].includes(String(code))) {
        return result;
      }
      const capabilityResult = await hiddenGetCapability(input, extra);
      return capabilityResult.isError ? result : addCompatibilityRoute(capabilityResult);
    };
    getVisual.__odlReq021VisibleBridge = true;
  }
}
