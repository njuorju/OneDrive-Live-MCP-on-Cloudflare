import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AuthState } from "./auth-state";
import {
  getConnectionStatus,
  listAllowedFolder,
  readAllowedFile,
  searchAllowedRoot,
} from "./graph";
import { MicrosoftAuthHandler } from "./microsoft-auth";
import type { Props } from "./types";

export { AuthState };

function toolText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export class OneDriveMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: "OneDrive Live MCP",
    version: "0.2.0",
  });

  async init() {
    this.server.registerTool(
      "onedrive_status",
      {
        description:
          "Check the live Microsoft OneDrive connection and the single allowed root folder. This connector is read-only and does not use a corpus snapshot.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async () => {
        try {
          if (!this.props?.userId) throw new Error("No authorized Microsoft user is attached.");
          return toolText(await getConnectionStatus(this.env, this.props.userId));
        } catch (error) {
          return toolError(error);
        }
      },
    );

    this.server.registerTool(
      "search_onedrive",
      {
        description:
          "Search live OneDrive filenames, metadata, and Microsoft-indexed file contents, restricted to the configured allowed folder tree. Use this before reading files.",
        inputSchema: {
          query: z.string().min(1).max(300).describe("Search terms in Russian or English."),
          limit: z.number().int().min(1).max(50).default(20),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ query, limit }: { query: string; limit: number }) => {
        try {
          if (!this.props?.userId) throw new Error("No authorized Microsoft user is attached.");
          return toolText({
            query,
            allowedRoot: this.env.ONEDRIVE_ROOT,
            results: await searchAllowedRoot(this.env, this.props.userId, query, limit),
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );

    this.server.registerTool(
      "list_onedrive_folder",
      {
        description:
          "List files and subfolders inside the configured allowed OneDrive root. Paths are relative to that root; path traversal is rejected.",
        inputSchema: {
          path: z.string().max(1000).default("").describe("Relative path under the configured allowed root, or empty for the root."),
          limit: z.number().int().min(1).max(200).default(100),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ path, limit }: { path: string; limit: number }) => {
        try {
          if (!this.props?.userId) throw new Error("No authorized Microsoft user is attached.");
          return toolText({
            path,
            allowedRoot: this.env.ONEDRIVE_ROOT,
            results: await listAllowedFolder(this.env, this.props.userId, path, limit),
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );

    this.server.registerTool(
      "read_onedrive_file",
      {
        description:
          "Read a file previously found by search or folder listing. Downloads the current OneDrive version on demand, converts it to text/Markdown, and returns a bounded character slice. Supports PDF, DOCX, XLS/XLSX, CSV, HTML, XML, ODT/ODS, common images, PPTX, and plain-text/code files.",
        inputSchema: {
          itemId: z.string().min(1).max(500).describe("OneDrive item ID from a search/list result."),
          startChar: z.number().int().min(0).default(0),
          maxChars: z.number().int().min(1000).max(50000).default(30000),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ itemId, startChar, maxChars }: { itemId: string; startChar: number; maxChars: number }) => {
        try {
          if (!this.props?.userId) throw new Error("No authorized Microsoft user is attached.");
          return toolText(
            await readAllowedFile(this.env, this.props.userId, itemId, startChar, maxChars),
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
}

export default new OAuthProvider({
  apiHandler: OneDriveMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  tokenEndpoint: "/token",
  defaultHandler: MicrosoftAuthHandler as any,
});
