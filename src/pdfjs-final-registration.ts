import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerIntegratedToolsWithPdfJsHotfix,
} from "./pdfjs-renderer-hotfix";
import type { HotfixContext } from "./version20-hotfix";

/**
 * The replacement server is assembled before it is attached to a transport.
 * Suppress SDK list-changed notifications during that assembly so updating the
 * final render callback cannot interfere with MCP initialization/reconnection.
 */
export function registerIntegratedToolsWithQuietPdfJsHotfix(
  server: McpServer,
  contextFactory: () => HotfixContext,
): void {
  const target = server as any;
  const originalSendToolListChanged = target.sendToolListChanged;
  target.sendToolListChanged = () => undefined;
  try {
    registerIntegratedToolsWithPdfJsHotfix(server, contextFactory);
  } finally {
    target.sendToolListChanged = originalSendToolListChanged;
  }
}
