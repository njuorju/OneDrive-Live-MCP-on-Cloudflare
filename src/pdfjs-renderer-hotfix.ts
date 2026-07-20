import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorError, safeErrorResult } from "./errors";
import { extensionOf, validateFileSignature } from "./file-types";
import pdfJsMainSource from "./generated/pdfjs-main";
import pdfJsWorkerSource from "./generated/pdfjs-worker";
import { compactVerifiedItem } from "./graph-core";
import {
  INTEGRATED_LIMITS,
  bytesToBase64,
  inspectPdfBytes,
} from "./integrated-core";
import {
  pdfBytesForRenderHotfix,
  pdfPageDimensions,
  registerIntegratedToolsWithVersion20Hotfix,
  type HotfixContext,
} from "./version20-hotfix";

type Crop = { x: number; y: number; width: number; height: number };

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.round(parsed)) : fallback;
}

function clampDimension(value: number): number {
  return Math.min(Math.max(value, 256), INTEGRATED_LIMITS.renderDimensionMax);
}

function escapeForInlineScript(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function safeInlineLibrary(source: string): string {
  return source
    .replace(/<\/script/gi, "<\\/script")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildPdfJsRenderHtml(input: {
  pdfBase64: string;
  page: number;
  width: number;
  height: number;
  crop?: Crop;
  mainSource?: string;
  workerSource?: string;
}): string {
  const crop = input.crop ?? null;
  const mainSource = safeInlineLibrary(input.mainSource ?? pdfJsMainSource);
  const workerSource = safeInlineLibrary(input.workerSource ?? pdfJsWorkerSource);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}
#page-canvas{display:block;margin:0;padding:0;background:#fff}
</style>
<script>try{Object.defineProperty(window,"Worker",{value:undefined,configurable:true});}catch{window.Worker=undefined;}</script>
<script>${mainSource}</script>
<script>${workerSource}</script>
</head>
<body>
<canvas id="page-canvas" aria-label="Rendered PDF page"></canvas>
<script>
(() => {
  const PDF_BASE64 = ${escapeForInlineScript(input.pdfBase64)};
  const PAGE = ${input.page};
  const TARGET_WIDTH = ${input.width};
  const TARGET_HEIGHT = ${input.height};
  const CROP = ${JSON.stringify(crop)};
  const output = document.getElementById("page-canvas");

  function decodePdf() {
    const binary = atob(PDF_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function validateCanvas(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255;
    let max = 0;
    let opaque = 0;
    const stride = Math.max(4, Math.floor(pixels.length / 8192 / 4) * 4);
    for (let i = 0; i < pixels.length; i += stride) {
      if (pixels[i + 3] > 0) opaque++;
      min = Math.min(min, pixels[i], pixels[i + 1], pixels[i + 2]);
      max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    if (!opaque || max - min < 2) throw new Error("blank_or_uniform_canvas");
  }

  async function render() {
    if (!window.pdfjsLib || !window.pdfjsWorker) throw new Error("pdfjs_not_loaded");
    const loadingTask = window.pdfjsLib.getDocument({
      data: decodePdf(),
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      isEvalSupported: false,
      useWorkerFetch: false,
    });
    const pdf = await loadingTask.promise;
    if (PAGE < 1 || PAGE > pdf.numPages) throw new Error("page_out_of_range");
    const page = await pdf.getPage(PAGE);
    const unitViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(TARGET_WIDTH / unitViewport.width, TARGET_HEIGHT / unitViewport.height);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("invalid_scale");
    const viewport = page.getViewport({ scale });
    const full = document.createElement("canvas");
    full.width = Math.max(1, Math.round(viewport.width));
    full.height = Math.max(1, Math.round(viewport.height));
    await page.render({
      canvasContext: full.getContext("2d", { alpha: false }),
      viewport,
      background: "rgb(255,255,255)",
    }).promise;

    if (CROP) {
      const sx = Math.min(Math.max(Math.round(CROP.x), 0), full.width - 1);
      const sy = Math.min(Math.max(Math.round(CROP.y), 0), full.height - 1);
      const sw = Math.min(Math.max(Math.round(CROP.width), 1), full.width - sx);
      const sh = Math.min(Math.max(Math.round(CROP.height), 1), full.height - sy);
      output.width = sw;
      output.height = sh;
      output.getContext("2d", { alpha: false }).drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
    } else {
      output.width = full.width;
      output.height = full.height;
      output.getContext("2d", { alpha: false }).drawImage(full, 0, 0);
    }

    output.style.width = output.width + "px";
    output.style.height = output.height + "px";
    validateCanvas(output);
    output.dataset.renderComplete = "true";
    output.dataset.renderWidth = String(output.width);
    output.dataset.renderHeight = String(output.height);
  }

  render().catch((error) => {
    document.body.dataset.renderError = String(error && error.message || error);
  });
})();
</script>
</body>
</html>`;
}

async function screenshotCompletedCanvas(
  context: Pick<HotfixContext, "env">,
  html: string,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  if (!context.env.BROWSER) {
    throw new ConnectorError("browser_binding_missing", "Cloudflare Browser Run is not configured.");
  }
  const browser = context.env.BROWSER as any;
  let response: Response;
  try {
    response = await browser.quickAction("screenshot", {
      html,
      waitForSelector: {
        selector: '#page-canvas[data-render-complete="true"]',
        visible: true,
        timeout: 40_000,
      },
      actionTimeout: 45_000,
      viewport: { width, height, deviceScaleFactor: 1 },
      screenshotOptions: {
        type: "png",
        fullPage: false,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height },
      },
    });
  } catch {
    throw new ConnectorError(
      "render_failed",
      "PDF.js did not complete the requested page render before the deadline.",
      { retryable: true },
    );
  }
  if (!(response instanceof Response) || !response.ok) {
    throw new ConnectorError(
      "render_failed",
      "Cloudflare Browser Run returned an invalid PDF.js render.",
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

async function renderDocumentPagePdfJs(
  context: HotfixContext,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const itemId = String(input.itemId ?? "");
    const page = positiveInteger(input.pageOrSlide, 1);
    const outputFormat = String(input.outputFormat ?? "png").toLowerCase() as "png" | "jpeg" | "webp";
    if (!["png", "jpeg", "webp"].includes(outputFormat)) {
      throw new ConnectorError("invalid_output_format", "Output format must be PNG, JPEG, or WebP.");
    }
    const requestedDpi = input.dpi === undefined
      ? null
      : Math.min(Math.max(Number(input.dpi), 36), 300);
    const widthFromDpi = requestedDpi ? Math.round(requestedDpi * 8.27) : 1600;
    const boundingWidth = clampDimension(positiveInteger(input.width, widthFromDpi));
    const { verified, pdf } = await pdfBytesForRenderHotfix(context, itemId);
    const pdfInfo = inspectPdfBytes(pdf);
    if (page > pdfInfo.pageCount) {
      throw new ConnectorError("page_out_of_range", "The requested page or slide number is outside the document.");
    }

    const dimensions = pdfPageDimensions(pdf, page);
    const naturalHeight = Math.round(boundingWidth * dimensions.height / dimensions.width);
    const boundingHeight = clampDimension(positiveInteger(input.height, naturalHeight));
    const scale = Math.min(
      boundingWidth / dimensions.width,
      boundingHeight / dimensions.height,
    );
    const renderedWidth = Math.max(1, Math.round(dimensions.width * scale));
    const renderedHeight = Math.max(1, Math.round(dimensions.height * scale));
    const cropRaw = input.cropRegion as Record<string, unknown> | undefined;
    const crop = cropRaw
      ? {
          x: Math.min(Math.max(Number(cropRaw.x ?? 0), 0), renderedWidth - 1),
          y: Math.min(Math.max(Number(cropRaw.y ?? 0), 0), renderedHeight - 1),
          width: Math.min(Math.max(Number(cropRaw.width ?? renderedWidth), 1), renderedWidth),
          height: Math.min(Math.max(Number(cropRaw.height ?? renderedHeight), 1), renderedHeight),
        }
      : undefined;
    if (crop) {
      crop.width = Math.min(crop.width, renderedWidth - crop.x);
      crop.height = Math.min(crop.height, renderedHeight - crop.y);
    }

    const outputWidth = Math.max(1, Math.round(crop?.width ?? renderedWidth));
    const outputHeight = Math.max(1, Math.round(crop?.height ?? renderedHeight));
    const html = buildPdfJsRenderHtml({
      pdfBase64: bytesToBase64(pdf),
      page,
      width: renderedWidth,
      height: renderedHeight,
      crop,
    });
    const png = await screenshotCompletedCanvas(context, html, outputWidth, outputHeight);
    const converted = await convertImageOutput(context, png, outputFormat);
    const metadata = {
      ...compactVerifiedItem(verified),
      requestedPageOrSlide: page,
      totalPagesOrSlides: pdfInfo.pageCount,
      outputFormat,
      mimeType: converted.mimeType,
      width: outputWidth,
      height: outputHeight,
      requestedDpi,
      cropRegion: crop ?? null,
      exactRequestedPage: true,
      officeConversion: extensionOf(verified.item.name) === ".pdf"
        ? "not_required"
        : "microsoft_graph_pdf",
      renderer: "cloudflare_browser_run_vendored_pdfjs_canvas",
      pdfConversions: 1,
      runtimeExternalDependencies: 0,
    };
    return {
      structuredContent: metadata,
      content: [
        { type: "text", text: JSON.stringify(metadata, null, 2) },
        { type: "image", data: bytesToBase64(converted.bytes), mimeType: converted.mimeType },
      ],
    } as CallToolResult;
  } catch (error) {
    return safeErrorResult(error) as CallToolResult;
  }
}

export function registerIntegratedToolsWithPdfJsHotfix(
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
                renderDocumentPagePdfJs(contextFactory(), input),
            );
          }
          return object.registerTool(name, config, callback);
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  registerIntegratedToolsWithVersion20Hotfix(proxy as McpServer, contextFactory);
}
