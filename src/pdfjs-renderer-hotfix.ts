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
import { IntegratedMicrosoftAuthHandler } from "./microsoft-auth-integrated";
import { openJson, sealJson } from "./security";
import {
  pdfBytesForRenderHotfix,
  pdfPageDimensions,
  registerIntegratedToolsWithVersion20Hotfix,
  type HotfixContext,
} from "./version20-hotfix";

const PDFJS_VERSION = "3.2.146";
const PDFJS_MAIN_ROUTE = "/__pdfjs-main.js";
const PDFJS_WORKER_ROUTE = "/__pdfjs-worker.js";
const RENDER_PAGE_PREFIX = "/__pdfjs-render/";
const RENDER_PDF_PREFIX = "/__pdfjs-pdf/";
const RENDER_ORIGIN = "https://nikolay-onedrive-mcp.fdas201290.workers.dev";

type Crop = { x: number; y: number; width: number; height: number };

type RenderToken = {
  kind?: string;
  userId?: string;
  itemId?: string;
  renderId?: string;
  expiresAt?: number;
};

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

function authStateStub(env: Env): DurableObjectStub {
  return env.AUTH_STATE.get(env.AUTH_STATE.idFromName("global"));
}

async function putRenderCache(
  env: Env,
  renderId: string,
  pdf: ArrayBuffer,
  expiresAt: number,
): Promise<void> {
  let response: Response;
  try {
    response = await authStateStub(env).fetch("https://auth-state/render-cache-put", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Render-Id": renderId,
        "X-Render-Expires-At": String(expiresAt),
      },
      body: pdf,
    });
  } catch {
    throw new ConnectorError(
      "render_cache_unavailable",
      "The short-lived render cache is unavailable.",
      { retryable: true },
    );
  }
  if (!response.ok) {
    throw new ConnectorError(
      "render_cache_unavailable",
      "The converted PDF could not be staged for deterministic rendering.",
      { retryable: response.status >= 500 },
    );
  }
}

async function getRenderCache(env: Env, renderId: string): Promise<Response> {
  try {
    return await authStateStub(env).fetch("https://auth-state/render-cache-get", {
      method: "POST",
      headers: { "X-Render-Id": renderId },
    });
  } catch {
    return new Response("Render cache unavailable.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

async function deleteRenderCache(env: Env, renderId: string): Promise<void> {
  try {
    await authStateStub(env).fetch("https://auth-state/render-cache-delete", {
      method: "POST",
      headers: { "X-Render-Id": renderId },
    });
  } catch {
    // The entry is short-lived and AuthState removes expired entries lazily.
  }
}

export function buildPdfJsRenderHtml(input: {
  token: string;
  page: number;
  width: number;
  height: number;
  crop?: Crop;
}): string {
  const pdfUrl = `${RENDER_PDF_PREFIX}${encodeURIComponent(input.token)}`;
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
<script src="${PDFJS_MAIN_ROUTE}?v=${PDFJS_VERSION}"></script>
<script src="${PDFJS_WORKER_ROUTE}?v=${PDFJS_VERSION}"></script>
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
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "${PDFJS_WORKER_ROUTE}?v=${PDFJS_VERSION}";
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

async function validateRenderToken(
  url: URL,
  env: Env,
  prefix: string,
): Promise<Required<RenderToken>> {
  const encoded = url.pathname.slice(prefix.length);
  const payload = await openJson<RenderToken>(
    env.COOKIE_ENCRYPTION_KEY,
    decodeURIComponent(encoded),
  );
  if (
    payload.kind !== "document-render-cache" ||
    !payload.userId ||
    !payload.itemId ||
    !payload.renderId ||
    Number(payload.expiresAt) <= Date.now()
  ) {
    throw new Error("expired");
  }
  return payload as Required<RenderToken>;
}

function javascriptResponse(source: string): Response {
  return new Response(source, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function installPdfJsRenderRoutes(): void {
  const handler = IntegratedMicrosoftAuthHandler as typeof IntegratedMicrosoftAuthHandler & {
    __pdfJsRenderRoutesInstalled?: boolean;
  };
  if (handler.__pdfJsRenderRoutesInstalled) return;
  const originalFetch = handler.fetch.bind(handler);
  handler.fetch = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === PDFJS_MAIN_ROUTE) {
      return javascriptResponse(pdfJsMainSource);
    }
    if (request.method === "GET" && url.pathname === PDFJS_WORKER_ROUTE) {
      return javascriptResponse(pdfJsWorkerSource);
    }
    if (request.method === "GET" && url.pathname.startsWith(RENDER_PDF_PREFIX)) {
      try {
        const payload = await validateRenderToken(url, env, RENDER_PDF_PREFIX);
        const cached = await getRenderCache(env, payload.renderId);
        if (!cached.ok) {
          return new Response("Render cache entry unavailable.", {
            status: cached.status,
            headers: { "Cache-Control": "no-store" },
          });
        }
        const headers = new Headers(cached.headers);
        headers.set("Content-Disposition", "inline; filename=render.pdf");
        headers.set("Cache-Control", "private, no-store, max-age=0");
        return new Response(cached.body, { status: 200, headers });
      } catch {
        return new Response("Render link expired or invalid.", {
          status: 410,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
    if (request.method === "GET" && url.pathname.startsWith(RENDER_PAGE_PREFIX)) {
      try {
        const encoded = url.pathname.slice(RENDER_PAGE_PREFIX.length);
        const token = decodeURIComponent(encoded);
        await validateRenderToken(url, env, RENDER_PAGE_PREFIX);
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
            "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'",
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
  Object.defineProperty(handler, "__pdfJsRenderRoutesInstalled", {
    value: true,
    enumerable: false,
  });
}

installPdfJsRenderRoutes();

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
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 30_000 },
      waitForSelector: {
        selector: '#page-canvas[data-render-complete="true"]',
        visible: true,
        timeout: 25_000,
      },
      actionTimeout: 30_000,
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
  let renderId: string | null = null;
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

    renderId = crypto.randomUUID();
    const expiresAt = Date.now() + 90_000;
    await putRenderCache(context.env, renderId, pdf, expiresAt);
    const token = await sealJson(context.env.COOKIE_ENCRYPTION_KEY, {
      kind: "document-render-cache",
      userId: context.userId,
      itemId,
      renderId,
      expiresAt,
    });
    const params = new URLSearchParams({
      page: String(page),
      width: String(renderedWidth),
      height: String(renderedHeight),
    });
    if (crop) {
      params.set("cropX", String(crop.x));
      params.set("cropY", String(crop.y));
      params.set("cropWidth", String(crop.width));
      params.set("cropHeight", String(crop.height));
    }
    const renderUrl = `${RENDER_ORIGIN}${RENDER_PAGE_PREFIX}${encodeURIComponent(token)}?${params}`;
    const outputWidth = Math.max(1, Math.round(crop?.width ?? renderedWidth));
    const outputHeight = Math.max(1, Math.round(crop?.height ?? renderedHeight));
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
      renderer: "cloudflare_browser_run_vendored_pdfjs_authstate_cache",
      pdfConversions: 1,
      runtimeExternalDependencies: 0,
      renderCache: "authstate_ephemeral_memory",
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
  } finally {
    if (renderId) await deleteRenderCache(context.env, renderId);
  }
}

export function registerIntegratedToolsWithPdfJsHotfix(
  server: McpServer,
  contextFactory: () => HotfixContext,
): void {
  registerIntegratedToolsWithVersion20Hotfix(server, contextFactory);
  const registered = (server as any)._registeredTools?.render_document_page;
  if (!registered || typeof registered.update !== "function") {
    throw new Error("render_document_page was not registered by the integrated tool surface.");
  }
  registered.update({
    callback: async (input: Record<string, unknown>) =>
      renderDocumentPagePdfJs(contextFactory(), input),
  });
}
