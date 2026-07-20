import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorError, safeErrorResult } from "./errors";
import { extensionOf, validateFileSignature } from "./file-types";
import {
  compactVerifiedItem,
  graphFetchBytes,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import {
  INTEGRATED_LIMITS,
  bytesToBase64,
  inspectPdfBytes,
} from "./integrated-core";
import { registerIntegratedTools } from "./integrated-tools";
import { sealJson } from "./security";

export type StableStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
};

export type HotfixContext = {
  env: Env;
  userId: string;
  storage: StableStorage;
  waitUntil?: (promise: Promise<unknown>) => void;
};

type IntegratedStateResult = {
  ok?: boolean;
  found?: boolean;
  value?: unknown;
  entries?: Array<[string, unknown]>;
  deleted?: boolean;
  stage?: string;
};

async function callIntegratedState(
  env: Env,
  path: "/state-get" | "/state-put" | "/state-delete" | "/state-list",
  body: Record<string, unknown>,
): Promise<IntegratedStateResult> {
  const id = env.AUTH_STATE.idFromName("global");
  const stub = env.AUTH_STATE.get(id);
  let response: Response;
  try {
    response = await stub.fetch(`https://auth-state${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ConnectorError(
      "state_storage_unavailable",
      "Integrated state storage is unavailable.",
      { retryable: true },
    );
  }
  let result: IntegratedStateResult;
  try {
    result = await response.json() as IntegratedStateResult;
  } catch {
    throw new ConnectorError(
      "state_storage_unavailable",
      "Integrated state storage returned an invalid response.",
      { retryable: true },
    );
  }
  if (!response.ok || !result.ok) {
    throw new ConnectorError(
      "state_storage_unavailable",
      "Integrated state storage could not complete the request.",
      { retryable: response.status >= 500 },
    );
  }
  return result;
}

export function createIntegratedStateStorage(env: Env, userId: string): StableStorage {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const result = await callIntegratedState(env, "/state-get", { userId, key });
      return result.found ? result.value as T : undefined;
    },
    async put<T = unknown>(key: string, value: T): Promise<void> {
      await callIntegratedState(env, "/state-put", { userId, key, value });
    },
    async delete(key: string): Promise<boolean> {
      const result = await callIntegratedState(env, "/state-delete", { userId, key });
      return Boolean(result.deleted);
    },
    async list<T = unknown>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
      const result = await callIntegratedState(env, "/state-list", {
        userId,
        prefix: String(options.prefix ?? "integrated:"),
      });
      return new Map((result.entries ?? []) as Array<[string, T]>);
    },
  };
}

const RENDERABLE_PRESENTATIONS = new Set([".pptx", ".potx", ".ppsx"]);
const RENDERABLE_WORD = new Set([".docx"]);

export async function pdfBytesForRenderHotfix(
  context: Pick<HotfixContext, "env" | "userId">,
  itemId: string,
): Promise<{ verified: VerifiedItem; pdf: ArrayBuffer }> {
  const verified = await verifyItemInsideRoot(context.env, context.userId, itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "Rendering requires a file.");
  const extension = extensionOf(verified.item.name);
  const current = await verifyItemInsideRoot(context.env, context.userId, itemId);
  let path: string;
  if (extension === ".pdf") {
    path = `/me/drive/items/${encodeURIComponent(current.item.id)}/content`;
  } else if (RENDERABLE_PRESENTATIONS.has(extension) || RENDERABLE_WORD.has(extension)) {
    path = `/me/drive/items/${encodeURIComponent(current.item.id)}/content?format=pdf`;
  } else {
    throw new ConnectorError(
      "render_unsupported",
      "Rendering is supported for PDF, PPTX, POTX, PPSX, and DOCX.",
    );
  }
  const pdf = await graphFetchBytes(
    context.env,
    context.userId,
    path,
    INTEGRATED_LIMITS.fileBytesMax,
  );
  const signature = validateFileSignature("render.pdf", pdf, "application/pdf");
  if (!signature.compatible) {
    throw new ConnectorError(
      "conversion_failed",
      "Microsoft Graph did not return a valid PDF conversion.",
    );
  }
  return { verified: current, pdf };
}

export function pdfPageDimensions(
  buffer: ArrayBuffer,
  page: number,
): { width: number; height: number } {
  const binary = new TextDecoder("latin1").decode(new Uint8Array(buffer));
  const boxes = [...binary.matchAll(
    /\/(?:CropBox|MediaBox)\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/g,
  )]
    .map((match) => {
      const x1 = Number(match[1]);
      const y1 = Number(match[2]);
      const x2 = Number(match[3]);
      const y2 = Number(match[4]);
      return { width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    })
    .filter((box) =>
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      box.width > 0 &&
      box.height > 0
    );
  const selected = boxes[Math.min(Math.max(page - 1, 0), boxes.length - 1)] ?? boxes[0];
  return selected ?? { width: 595, height: 842 };
}

export function pageClipGeometry(
  pageDimensions: { width: number; height: number },
  requestedWidth: number,
  requestedHeight: number,
  crop?: { x: number; y: number; width: number; height: number },
): {
  viewerWidth: number;
  viewerHeight: number;
  clip: { x: number; y: number; width: number; height: number };
} {
  const pageCssWidth = Math.max(1, Math.round(pageDimensions.width * 96 / 72));
  const pageCssHeight = Math.max(1, Math.round(pageDimensions.height * 96 / 72));
  const viewerMarginX = 32;
  const viewerPageTop = 3;
  const viewerBottom = 12;
  const viewerWidth = Math.min(
    Math.max(requestedWidth, pageCssWidth + viewerMarginX * 2, 256),
    INTEGRATED_LIMITS.renderDimensionMax,
  );
  const viewerHeight = Math.min(
    Math.max(requestedHeight, pageCssHeight + viewerPageTop + viewerBottom, 256),
    INTEGRATED_LIMITS.renderDimensionMax,
  );
  const scaleX = pageCssWidth / requestedWidth;
  const scaleY = pageCssHeight / requestedHeight;
  const pageLeft = Math.max(0, Math.round((viewerWidth - pageCssWidth) / 2));
  const clip = crop
    ? {
        x: pageLeft + crop.x * scaleX,
        y: viewerPageTop + crop.y * scaleY,
        width: crop.width * scaleX,
        height: crop.height * scaleY,
      }
    : { x: pageLeft, y: viewerPageTop, width: pageCssWidth, height: pageCssHeight };
  return { viewerWidth, viewerHeight, clip };
}

async function browserPageScreenshot(
  context: Pick<HotfixContext, "env">,
  url: string,
  width: number,
  height: number,
  clip: { x: number; y: number; width: number; height: number },
): Promise<ArrayBuffer> {
  if (!context.env.BROWSER) {
    throw new ConnectorError(
      "browser_binding_missing",
      "Cloudflare Browser Run is not configured.",
    );
  }
  const browser = context.env.BROWSER as any;
  let response: Response;
  try {
    response = await browser.quickAction("screenshot", {
      url,
      gotoOptions: { waitUntil: "load", timeout: 60_000 },
      waitForTimeout: 5_000,
      viewport: { width, height, deviceScaleFactor: 1 },
      screenshotOptions: { type: "png", fullPage: false, clip },
    });
  } catch {
    throw new ConnectorError(
      "render_failed",
      "Cloudflare Browser Run could not render the requested page.",
      { retryable: true },
    );
  }
  if (!(response instanceof Response) || !response.ok) {
    throw new ConnectorError(
      "render_failed",
      "Cloudflare Browser Run returned an invalid render.",
      { retryable: true },
    );
  }
  const result = await response.arrayBuffer();
  const signature = validateFileSignature("render.png", result, "image/png");
  if (!signature.compatible) {
    throw new ConnectorError("render_invalid", "The generated page render is not a valid PNG.");
  }
  return result;
}

async function convertImageOutput(
  context: Pick<HotfixContext, "env">,
  buffer: ArrayBuffer,
  format: "png" | "jpeg" | "webp",
): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  if (format === "png") return { bytes: buffer, mimeType: "image/png" };
  const images = context.env.IMAGES as any;
  const output = await images
    .input(new Blob([buffer], { type: "image/png" }).stream())
    .output({ format: format === "jpeg" ? "image/jpeg" : "image/webp", anim: false });
  const response = output.response();
  if (!response.ok) {
    throw new ConnectorError(
      "render_conversion_failed",
      "The isolated page could not be converted to the requested image format.",
      { retryable: true },
    );
  }
  return {
    bytes: await response.arrayBuffer(),
    mimeType: format === "jpeg" ? "image/jpeg" : "image/webp",
  };
}

async function renderDocumentPageHotfix(
  context: HotfixContext,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const itemId = String(input.itemId ?? "");
    const page = Math.max(Number(input.pageOrSlide ?? 1), 1);
    const outputFormat = String(input.outputFormat ?? "png").toLocaleLowerCase("en") as
      | "png"
      | "jpeg"
      | "webp";
    if (!["png", "jpeg", "webp"].includes(outputFormat)) {
      throw new ConnectorError(
        "invalid_output_format",
        "Output format must be PNG, JPEG, or WebP.",
      );
    }
    const requestedDpi = input.dpi === undefined
      ? null
      : Math.min(Math.max(Number(input.dpi), 36), 300);
    const widthFromDpi = requestedDpi ? Math.round(requestedDpi * 8.27) : 1_600;
    const width = Math.min(
      Math.max(Number(input.width ?? widthFromDpi), 256),
      INTEGRATED_LIMITS.renderDimensionMax,
    );
    const { verified, pdf } = await pdfBytesForRenderHotfix(context, itemId);
    const pdfInfo = inspectPdfBytes(pdf);
    if (page > pdfInfo.pageCount) {
      throw new ConnectorError(
        "page_out_of_range",
        "The requested page or slide number is outside the document.",
      );
    }
    const dimensions = pdfPageDimensions(pdf, page);
    const height = Math.min(
      Math.max(Math.round(width * dimensions.height / dimensions.width), 256),
      INTEGRATED_LIMITS.renderDimensionMax,
    );
    const cropRaw = input.cropRegion as Record<string, unknown> | undefined;
    const crop = cropRaw
      ? {
          x: Math.min(Math.max(Number(cropRaw.x ?? 0), 0), width - 1),
          y: Math.min(Math.max(Number(cropRaw.y ?? 0), 0), height - 1),
          width: Math.min(Math.max(Number(cropRaw.width ?? width), 1), width),
          height: Math.min(Math.max(Number(cropRaw.height ?? height), 1), height),
        }
      : undefined;
    if (crop) {
      crop.width = Math.min(crop.width, width - crop.x);
      crop.height = Math.min(crop.height, height - crop.y);
    }
    const geometry = pageClipGeometry(dimensions, width, height, crop);
    const renderToken = await sealJson(context.env.COOKIE_ENCRYPTION_KEY, {
      kind: "document-render",
      userId: context.userId,
      itemId,
      expiresAt: Date.now() + 60_000,
    });
    const renderUrl =
      `https://nikolay-onedrive-mcp.fdas201290.workers.dev/__document-render/${encodeURIComponent(renderToken)}` +
      `#page=${page}&zoom=page-fit&toolbar=0&navpanes=0&scrollbar=0`;
    const png = await browserPageScreenshot(
      context,
      renderUrl,
      geometry.viewerWidth,
      geometry.viewerHeight,
      geometry.clip,
    );
    const converted = await convertImageOutput(context, png, outputFormat);
    const metadata = {
      ...compactVerifiedItem(verified),
      requestedPageOrSlide: page,
      totalPagesOrSlides: pdfInfo.pageCount,
      outputFormat,
      mimeType: converted.mimeType,
      width: Math.max(1, Math.round(geometry.clip.width)),
      height: Math.max(1, Math.round(geometry.clip.height)),
      requestedDpi,
      cropRegion: crop ?? null,
      exactRequestedPage: true,
      officeConversion: extensionOf(verified.item.name) === ".pdf"
        ? "not_required"
        : "microsoft_graph_pdf",
      renderer: "cloudflare_browser_run_page_clip",
    };
    return {
      structuredContent: metadata,
      content: [
        { type: "text", text: JSON.stringify(metadata, null, 2) },
        {
          type: "image",
          data: bytesToBase64(converted.bytes),
          mimeType: converted.mimeType,
        },
      ],
    } as CallToolResult;
  } catch (error) {
    return safeErrorResult(error) as CallToolResult;
  }
}

export function registerIntegratedToolsWithVersion20Hotfix(
  server: McpServer,
  contextFactory: () => HotfixContext,
): void {
  const target = server as any;
  const proxy = new Proxy(target, {
    get(object, property) {
      if (property === "registerTool") {
        return (name: string, config: unknown, callback: unknown) => {
          if (name === "render_document_page") {
            return object.registerTool(
              name,
              config,
              async (input: Record<string, unknown>) =>
                renderDocumentPageHotfix(contextFactory(), input),
            );
          }
          return object.registerTool(name, config, callback);
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  registerIntegratedTools(proxy as McpServer, contextFactory as any);
}
