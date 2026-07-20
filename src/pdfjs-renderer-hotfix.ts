import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorError, safeErrorResult } from "./errors";
import { extensionOf, validateFileSignature } from "./file-types";
import { compactVerifiedItem } from "./graph-core";
import {
  INTEGRATED_LIMITS,
  bytesToBase64,
  inspectPdfBytes,
} from "./integrated-core";
import { IntegratedMicrosoftAuthHandler } from "./microsoft-auth-integrated";
import { openJson, sealJson } from "./security";
import {
  pdfBytesForRenderHotfix,
  pdfPageDimensions,
  registerIntegratedToolsWithVersion20Hotfix,
  type HotfixContext,
} from "./version20-hotfix";

const PDFJS_VERSION = "3.2.146";
const PDFJS_SCRIPT = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER_SCRIPT = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
const RENDER_ROUTE_PREFIX = "/__pdfjs-render/";
const PDF_ROUTE_PREFIX = "/__document-render/";
const RENDER_ORIGIN = "https://nikolay-onedrive-mcp.fdas201290.workers.dev";

type RenderToken = {
  kind?: string;
  userId?: string;
  itemId?: string;
  expiresAt?: number;
};

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

export function buildPdfJsRenderHtml(input: {
  token: string;
  page: number;
  width: number;
  height: number;
  crop?: Crop;
}): string {
  const pdfUrl = `${RENDER_ORIGIN}${PDF_ROUTE_PREFIX}${encodeURIComponent(input.token)}`;
  const crop = input.crop ?? null;
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
<script src="${PDFJS_SCRIPT}"></script>
<script src="${PDFJS_WORKER_SCRIPT}"></script>
</head>
<body>
<canvas id="page-canvas" aria-label="Rendered PDF page"></canvas>
<script>
(() => {
  const PDF_URL = ${escapeForInlineScript(pdfUrl)};
  const PAGE = ${input.page};
  const TARGET_WIDTH = ${input.width};
  const TARGET_HEIGHT = ${input.height};
  const CROP = ${JSON.stringify(crop)};
  const output = document.getElementById("page-canvas");

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
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = ${escapeForInlineScript(PDFJS_WORKER_SCRIPT)};
    const loadingTask = window.pdfjsLib.getDocument({
      url: PDF_URL,
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

async function validateRenderToken(url: URL, env: Env): Promise<{ token: string; payload: RenderToken }> {
  const encoded = url.pathname.slice(RENDER_ROUTE_PREFIX.length);
  const token = decodeURIComponent(encoded);
  const payload = await openJson<RenderToken>(env.COOKIE_ENCRYPTION_KEY, token);
  if (
    payload.kind !== "document-render" ||
    !payload.userId ||
    !payload.itemId ||
    Number(payload.expiresAt) <= Date.now()
  ) {
    throw new Error("expired");
  }
  return { token, payload };
}

function installPdfJsRenderRoute(): void {
  const handler = IntegratedMicrosoftAuthHandler as typeof IntegratedMicrosoftAuthHandler & {
    __pdfJsRenderRouteInstalled?: boolean;
  };
  if (handler.__pdfJsRenderRouteInstalled) return;
  const originalFetch = handler.fetch.bind(handler);
  handler.fetch = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith(RENDER_ROUTE_PREFIX)) {
      try {
        const { token } = await validateRenderToken(url, env);
        const page = positiveInteger(url.searchParams.get("page"), 1);
        const width = clampDimension(positiveInteger(url.searchParams.get("width"), 1600));
        const height = clampDimension(positiveInteger(url.searchParams.get("height"), 900));
        const crop = url.searchParams.has("cropX")
          ? {
              x: Math.max(0, Number(url.searchParams.get("cropX"))),
              y: Math.max(0, Number(url.searchParams.get("cropY"))),
              width: Math.max(1, Number(url.searchParams.get("cropWidth"))),
              height: Math.max(1, Number(url.searchParams.get("cropHeight"))),
            }
          : undefined;
        return new Response(buildPdfJsRenderHtml({ token, page, width, height, crop }), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, no-store, max-age=0",
            "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "X-Robots-Tag": "noindex, nofollow",
          },
        });
      } catch {
        return new Response("Render link expired or invalid.", {
          status: 410,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
    return originalFetch(request, env, ctx);
  };
  Object.defineProperty(handler, "__pdfJsRenderRouteInstalled", {
    value: true,
    enumerable: false,
  });
}

async function screenshotCompletedCanvas(
  context: Pick<HotfixContext, "env">,
  url: string,
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
      url,
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 60_000 },
      waitForSelector: {
        selector: '#page-canvas[data-render-complete="true"]',
        visible: true,
        timeout: 55_000,
      },
      actionTimeout: 60_000,
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
    const width = clampDimension(positiveInteger(input.width, widthFromDpi));
    const { verified, pdf } = await pdfBytesForRenderHotfix(context, itemId);
    const pdfInfo = inspectPdfBytes(pdf);
    if (page > pdfInfo.pageCount) {
      throw new ConnectorError("page_out_of_range", "The requested page or slide number is outside the document.");
    }
    const dimensions = pdfPageDimensions(pdf, page);
    const naturalHeight = Math.round(width * dimensions.height / dimensions.width);
    const height = clampDimension(positiveInteger(input.height, naturalHeight));
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

    const renderToken = await sealJson(context.env.COOKIE_ENCRYPTION_KEY, {
      kind: "document-render",
      userId: context.userId,
      itemId,
      expiresAt: Date.now() + 90_000,
    });
    const params = new URLSearchParams({
      page: String(page),
      width: String(width),
      height: String(height),
    });
    if (crop) {
      params.set("cropX", String(crop.x));
      params.set("cropY", String(crop.y));
      params.set("cropWidth", String(crop.width));
      params.set("cropHeight", String(crop.height));
    }
    const renderUrl = `${RENDER_ORIGIN}${RENDER_ROUTE_PREFIX}${encodeURIComponent(renderToken)}?${params}`;
    const outputWidth = Math.max(1, Math.round(crop?.width ?? width));
    const outputHeight = Math.max(1, Math.round(crop?.height ?? height));
    const png = await screenshotCompletedCanvas(context, renderUrl, outputWidth, outputHeight);
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
      renderer: "cloudflare_browser_run_pdfjs_canvas",
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
  installPdfJsRenderRoute();
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
