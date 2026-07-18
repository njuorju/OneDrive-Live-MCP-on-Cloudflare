import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AuthState } from "./auth-state";
import { safeErrorResult } from "./errors";
import {
  createFolder,
  createTextFile,
  fetchImageForAnalysis,
  fetchOriginalFile,
  getConnectionStatus,
  getImageMetadata,
  listAllowedFolder,
  listVisualAssets,
  moveItem,
  readAllowedFile,
  readOriginalResource,
  renameItem,
  replaceTextFile,
  searchAllowedRoot,
} from "./graph";
import { MicrosoftAuthHandler } from "./microsoft-auth";
import type { Props } from "./types";

export { AuthState } from "./auth-state";

type ToolResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function textResult(data: unknown): ToolResult {
  const structuredContent = data && typeof data === "object"
    ? data as Record<string, unknown>
    : { value: data };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export class OneDriveMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: "Nikolay OneDrive Live",
    version: "0.3.0",
  });

  private userId(): string {
    if (!this.props?.userId) throw new Error("No authorized Microsoft user is attached.");
    return this.props.userId;
  }

  private registerReadAliases(
    names: string[],
    config: Parameters<McpServer["registerTool"]>[1],
    callback: Parameters<McpServer["registerTool"]>[2],
  ): void {
    for (const name of names) this.server.registerTool(name, config, callback);
  }

  async init() {
    this.server.registerResource(
      "onedrive-original-file",
      new ResourceTemplate("onedrive-original://{itemId}{?etag}", { list: undefined }),
      {
        title: "Original OneDrive file",
        description:
          "Authenticated exact-byte resource returned by fetch_original_file. The handler revalidates the configured OneDrive root and eTag before every read.",
        mimeType: "application/octet-stream",
      },
      async (uri) => ({
        contents: [await readOriginalResource(this.env, this.userId(), uri)],
      }),
    );

    this.server.registerTool(
      "onedrive_status",
      {
        title: "Check OneDrive connection",
        description:
          "Check whether Microsoft authorization includes Files.ReadWrite and the configured OneDrive root can be resolved. Returns only sanitized readiness information, never account IDs, drive IDs, tokens, or Graph URLs.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => {
        try {
          return textResult(await getConnectionStatus(this.env, this.userId()));
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    const searchConfig = {
      title: "Search OneDrive work files",
      description:
        "Search live OneDrive filenames, metadata, and Microsoft-indexed contents inside the configured root. Use this for documents and general files. For photographs, maps, plans, diagrams, screenshots, charts, and illustrations, prefer list_visual_assets.",
      inputSchema: {
        query: z.string().min(1).max(300).describe("Search terms in Russian or English."),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_ONLY,
    };
    this.registerReadAliases(
      ["search_onedrive", "search_onedrive_work", "search"],
      searchConfig,
      async ({ query, limit }: { query: string; limit: number }) => {
        try {
          return textResult({ query, results: await searchAllowedRoot(this.env, this.userId(), query, limit) });
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    const listConfig = {
      title: "List a OneDrive work folder",
      description:
        "List files and subfolders inside the configured OneDrive root. Paths are relative to that root and are independently resolved and ancestry-checked.",
      inputSchema: {
        path: z.string().max(1000).default("").describe("Relative folder path under the configured root, or empty for the root."),
        limit: z.number().int().min(1).max(200).default(100),
      },
      annotations: READ_ONLY,
    };
    this.registerReadAliases(
      ["list_onedrive_folder", "list_onedrive_work_folder"],
      listConfig,
      async ({ path, limit }: { path: string; limit: number }) => {
        try {
          return textResult({ path, results: await listAllowedFolder(this.env, this.userId(), path, limit) });
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    const readConfig = {
      title: "Extract text from a OneDrive file",
      description:
        "Read the current OneDrive version of a file and return a bounded text or Markdown extraction. Use this for document contents, not for visual analysis or exact-file reuse. Use fetch_image_for_analysis for vision and fetch_original_file for exact original bytes.",
      inputSchema: {
        itemId: z.string().min(1).max(500).describe("OneDrive item ID from search or folder listing."),
        startChar: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(1000).max(50000).default(30000),
      },
      annotations: READ_ONLY,
    };
    this.registerReadAliases(
      ["read_onedrive_file", "read_onedrive_work_file", "fetch"],
      readConfig,
      async ({ itemId, startChar, maxChars }: { itemId: string; startChar: number; maxChars: number }) => {
        try {
          return textResult(await readAllowedFile(this.env, this.userId(), itemId, startChar, maxChars));
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "list_visual_assets",
      {
        title: "Discover OneDrive visual assets",
        description:
          "Find photographs, maps, diagrams, screenshots, rendered plans, charts, illustrations, and other image assets inside the configured OneDrive root. Use this first, inspect shortlisted candidates with get_image_metadata, then call fetch_image_for_analysis, and finally fetch_original_file for the selected asset when embedding it in a presentation or document.",
        inputSchema: {
          path: z.string().max(1000).optional(),
          recursive: z.boolean().default(false),
          query: z.string().max(300).optional(),
          fileTypes: z.array(z.enum(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "tif", "tiff", "bmp", "svg", "emf", "wmf"])).max(16).optional(),
          orientation: z.enum(["landscape", "portrait", "square", "any"]).default("any"),
          minWidth: z.number().int().min(1).max(16384).optional(),
          minHeight: z.number().int().min(1).max(16384).optional(),
          modifiedAfter: z.string().max(40).optional(),
          limit: z.number().int().min(1).max(100).default(30),
          cursor: z.string().max(12000).optional(),
        },
        annotations: READ_ONLY,
      },
      async (input: any) => {
        try {
          return textResult(await listVisualAssets(this.env, this.userId(), input));
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "get_image_metadata",
      {
        title: "Inspect image metadata",
        description:
          "Inspect a shortlisted visual asset inside the configured root. Returns dimensions, orientation, eTag, safe animation/page information, and preview availability without exposing GPS EXIF, Graph URLs, account IDs, or drive IDs.",
        inputSchema: { itemId: z.string().min(1).max(500) },
        annotations: READ_ONLY,
      },
      async ({ itemId }: { itemId: string }) => {
        try {
          return textResult(await getImageMetadata(this.env, this.userId(), itemId));
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "fetch_image_for_analysis",
      {
        title: "Fetch image for visual analysis",
        description:
          "Return actual MCP image content that a vision-capable model can inspect. The Worker validates root ancestry and file signatures, applies decoded-pixel and dimension limits, corrects orientation through Cloudflare Images, converts supported inputs to a bounded PNG preview, and never exposes a Graph download URL.",
        inputSchema: {
          itemId: z.string().min(1).max(500),
          detail: z.enum(["auto", "low", "high"]).default("auto"),
          page: z.number().int().min(1).max(32).optional().describe("Reserved for supported multi-page visual formats; currently only page 1 is accepted."),
          maxDimension: z.number().int().min(256).max(8192).optional(),
        },
        annotations: READ_ONLY,
      },
      async ({ itemId, detail, page, maxDimension }: { itemId: string; detail: "auto" | "low" | "high"; page?: number; maxDimension?: number }) => {
        try {
          if (page && page !== 1) throw new Error("Only page 1 is currently supported for visual previews.");
          const result = await fetchImageForAnalysis(this.env, this.userId(), itemId, detail, maxDimension);
          return {
            structuredContent: result.metadata,
            content: [
              { type: "text", text: JSON.stringify(result.metadata, null, 2) },
              result.image,
            ],
          } as ToolResult;
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "fetch_original_file",
      {
        title: "Fetch exact original OneDrive file",
        description:
          "Return a resource_link to the unchanged original file for reuse in generated artifacts such as PowerPoint presentations. The authenticated MCP resource handler revalidates root ancestry, current eTag, allowlisted type, signature, and size before returning exact bytes. This is separate from text extraction and image analysis.",
        inputSchema: { itemId: z.string().min(1).max(500) },
        annotations: READ_ONLY,
      },
      async ({ itemId }: { itemId: string }) => {
        try {
          const result = await fetchOriginalFile(this.env, this.userId(), itemId);
          return {
            structuredContent: result.metadata,
            content: [
              { type: "text", text: JSON.stringify(result.metadata, null, 2) },
              result.resource,
            ],
          } as ToolResult;
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "create_folder",
      {
        title: "Create OneDrive folder",
        description: "Create one folder inside a verified destination under the configured OneDrive root. Conflicts fail; nothing is overwritten.",
        inputSchema: {
          destinationPath: z.string().max(1000).default(""),
          name: z.string().min(1).max(255),
        },
        annotations: MUTATING,
      },
      async ({ destinationPath, name }: { destinationPath: string; name: string }) => {
        try {
          return textResult(await createFolder(this.env, this.userId(), destinationPath, name));
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "create_text_file",
      {
        title: "Create UTF-8 text file",
        description:
          "Create an allowlisted UTF-8 text, Markdown, CSV, JSON, source-code, or configuration file inside a verified OneDrive folder. Binary payloads and silent overwrites are not supported.",
        inputSchema: {
          destinationPath: z.string().max(1000).default(""),
          filename: z.string().min(1).max(255),
          content: z.string().max(4_194_304),
        },
        annotations: MUTATING,
      },
      async ({ destinationPath, filename, content }: { destinationPath: string; filename: string; content: string }) => {
        try {
          return textResult(await createTextFile(this.env, this.userId(), destinationPath, filename, content));
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "replace_text_file",
      {
        title: "Replace UTF-8 text file",
        description:
          "Replace an allowlisted text file only when expectedETag exactly matches the current OneDrive version. Missing or stale eTags fail closed and the new eTag is returned.",
        inputSchema: {
          itemId: z.string().min(1).max(500),
          expectedETag: z.string().min(1).max(1000),
          content: z.string().max(4_194_304),
        },
        annotations: MUTATING,
      },
      async ({ itemId, expectedETag, content }: { itemId: string; expectedETag: string; content: string }) => {
        try {
          return textResult(await replaceTextFile(this.env, this.userId(), itemId, expectedETag, content));
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "rename_item",
      {
        title: "Rename OneDrive item",
        description:
          "Rename one verified file or folder inside the configured root. The new name cannot contain path separators or reserved OneDrive/Windows names, and conflicts fail.",
        inputSchema: {
          itemId: z.string().min(1).max(500),
          newName: z.string().min(1).max(255),
        },
        annotations: MUTATING,
      },
      async ({ itemId, newName }: { itemId: string; newName: string }) => {
        try {
          return textResult(await renameItem(this.env, this.userId(), itemId, newName));
        } catch (error) {
          return safeErrorResult(error);
        }
      },
    );

    this.server.registerTool(
      "move_item",
      {
        title: "Move OneDrive item",
        description:
          "Move one verified file or folder between verified folders inside the configured root. Cross-drive, out-of-root, circular, ambiguous, and conflicting moves fail.",
        inputSchema: {
          itemId: z.string().min(1).max(500),
          destinationPath: z.string().max(1000),
        },
        annotations: MUTATING,
      },
      async ({ itemId, destinationPath }: { itemId: string; destinationPath: string }) => {
        try {
          return textResult(await moveItem(this.env, this.userId(), itemId, destinationPath));
        } catch (error) {
          return safeErrorResult(error);
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
