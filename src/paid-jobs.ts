import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerIntegratedToolsWithQuietPdfJsHotfix } from "./pdfjs-final-registration";
import { createIntegratedStateStorage } from "./version20-hotfix";
import { ConnectorError } from "./errors";
import { extensionOf, validateFileSignature } from "./file-types";
import {
  compactVerifiedItem,
  graphFetchBytes,
  graphResponse,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import {
  INTEGRATED_LIMITS,
  bytesToBase64,
  extractVisualBytes,
  hammingDistanceHex,
  inspectDocx,
  inspectPptx,
  pngDifferenceHash,
  safeUnzipOoxml,
  sha256Bytes,
  type DocumentVisualCandidate,
  type OoxmlEntryMap,
} from "./integrated-core";
import { openJson, sealJson } from "./security";
import {
  callToolError,
  canonicalJson,
  coordinatorRequest,
  errorResult,
  getArtifact,
  logPaidError,
  logPaidEvent,
  nowIso,
  ownedArrayBuffer,
  putArtifact,
  sha256HexUtf8,
  type PaidJobMessage,
  type PaidJobRecord,
  type StableVisualRecord,
} from "./paid-core";

const PAID_RENDER_PAGE_PREFIX = "/__paid-render-page/";
const PAID_RENDER_PDF_PREFIX = "/__paid-render-pdf/";
const PDFJS_MAIN_ROUTE = "/__pdfjs-main.js";
const PDFJS_WORKER_ROUTE = "/__pdfjs-worker.js";
const PAID_TOOL_RESULT_MIME = "application/vnd.onedrive-live.tool-result+json";
const QUEUED_TOOL_NAMES = new Set([
  "create_source_snapshot",
  "calculate_file_hashes",
  "find_source_duplicates",
  "find_visual_duplicates",
  "inspect_document",
  "list_document_visuals",
  "render_document_page",
]);

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.round(parsed)) : fallback;
}

function boundedMegabytes(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), maximum) : fallback;
}

function paidRenderOrigin(env: Env): string {
  const configured = String(env.PAID_RENDER_ORIGIN ?? "").trim().replace(/\/$/, "");
  return configured || "https://nikolay-onedrive-mcp.fdas201290.workers.dev";
}

function toolResultJson(result: CallToolResult): string {
  return JSON.stringify(result);
}

function parseToolResult(value: string): CallToolResult {
  return JSON.parse(value) as CallToolResult;
}

async function rawToolServer(env: Env, userId: string): Promise<McpServer> {
  const server = new McpServer({ name: "OneDrive Live paid queue worker", version: "0.5.0" });
  const contextFactory = () => ({
    env,
    userId,
    storage: createIntegratedStateStorage(env, userId),
  });
  registerIntegratedToolsWithQuietPdfJsHotfix(server, contextFactory);
  return server;
}

async function invokeRawTool(
  env: Env,
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = await rawToolServer(env, userId);
  const registered = (server as any)._registeredTools?.[toolName];
  if (!registered || typeof registered.handler !== "function") {
    throw new ConnectorError("paid_tool_not_found", `The queued tool ${toolName} is not registered.`);
  }
  return await registered.handler(input, {}) as CallToolResult;
}

function pdfCacheKey(jobId: string): string {
  return `jobs/${jobId}/render/source.pdf`;
}

function resultKey(jobId: string): string {
  return `jobs/${jobId}/result.json`;
}

function chunkKey(jobId: string, chunkIndex: number): string {
  return `jobs/${jobId}/chunks/${String(chunkIndex).padStart(6, "0")}.json`;
}

function manifestKey(jobId: string): string {
  return `jobs/${jobId}/manifest.json`;
}

async function updateJob(
  env: Env,
  userId: string,
  jobId: string,
  patch: Partial<PaidJobRecord>,
): Promise<PaidJobRecord> {
  return coordinatorRequest<PaidJobRecord>(env, userId, "/jobs/update", { jobId, ...patch });
}

async function stableVisual(env: Env, userId: string, stableId: string): Promise<StableVisualRecord | null> {
  return coordinatorRequest<StableVisualRecord | null>(env, userId, "/visuals/get", { stableId });
}

async function legacyVisualToken(env: Env, record: StableVisualRecord): Promise<string> {
  return sealJson(env.COOKIE_ENCRYPTION_KEY, {
    version: 1,
    itemId: record.sourceItemId,
    eTag: record.sourceETag,
    filename: record.sourceFilename,
    extension: record.sourceExtension,
    candidate: record.candidate,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
}

async function resolveStableVisualInputs(
  env: Env,
  userId: string,
  input: Record<string, unknown>,
): Promise<{ input: Record<string, unknown>; reverse: Map<string, string> }> {
  const resolved = { ...input };
  const reverse = new Map<string, string>();
  const one = typeof input.visualId === "string" ? input.visualId : null;
  if (one?.startsWith("vis_")) {
    const record = await stableVisual(env, userId, one);
    if (!record) throw new ConnectorError("stable_visual_not_found", "The stable document visual was not found.");
    const token = await legacyVisualToken(env, record);
    resolved.visualId = token;
    reverse.set(token, one);
  }
  if (Array.isArray(input.visualIds)) {
    const values: string[] = [];
    for (const raw of input.visualIds) {
      const value = String(raw);
      if (!value.startsWith("vis_")) {
        values.push(value);
        continue;
      }
      const record = await stableVisual(env, userId, value);
      if (!record) throw new ConnectorError("stable_visual_not_found", `Stable visual ${value} was not found.`);
      const token = await legacyVisualToken(env, record);
      values.push(token);
      reverse.set(token, value);
    }
    resolved.visualIds = values;
  }
  return { input: resolved, reverse };
}

function replaceLegacyTokens(value: unknown, reverse: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => replaceLegacyTokens(entry, reverse));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = replaceLegacyTokens(nested, reverse);
    }
    return result;
  }
  return typeof value === "string" && reverse.has(value) ? reverse.get(value) : value;
}

async function stagePdfForPaidRender(
  env: Env,
  userId: string,
  itemId: string,
  jobId: string,
): Promise<{ verified: VerifiedItem; key: string; byteSize: number; converted: boolean }> {
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "Rendering requires a file.");
  const extension = extensionOf(verified.item.name);
  const converted = extension !== ".pdf";
  if (converted && !new Set([".pptx", ".potx", ".ppsx", ".docx"]).has(extension)) {
    throw new ConnectorError("render_unsupported", "Rendering is supported for PDF, PPTX, POTX, PPSX, and DOCX.");
  }
  const maximum = boundedMegabytes(env.PAID_MAX_SOURCE_MB, 500, 2_000) * 1024 * 1024;
  if (!converted && Number(verified.item.size ?? 0) > maximum) {
    throw new ConnectorError("file_too_large", "The source exceeds the paid render-cache limit.", {
      details: { maximumBytes: maximum, actualBytes: verified.item.size ?? null },
    });
  }
  const path = converted
    ? `/me/drive/items/${encodeURIComponent(verified.item.id)}/content?format=pdf`
    : `/me/drive/items/${encodeURIComponent(verified.item.id)}/content`;
  const response = await graphResponse(env, userId, path, { redirect: "follow" });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maximum) {
    await response.body?.cancel();
    throw new ConnectorError("file_too_large", "The converted PDF exceeds the paid render-cache limit.", {
      details: { maximumBytes: maximum, actualBytes: length },
    });
  }
  if (!response.body) throw new ConnectorError("conversion_failed", "Microsoft Graph returned an empty PDF stream.");
  const key = pdfCacheKey(jobId);
  await putArtifact(env, key, response.body, "application/pdf", {
    sourceItemId: verified.item.id,
    sourceETag: verified.item.eTag ?? "",
    expiresAt: String(Date.now() + 15 * 60_000),
  });
  const stored = await env.ARTIFACTS.head(key);
  if (!stored || stored.size < 5 || stored.size > maximum) {
    await env.ARTIFACTS.delete(key);
    throw new ConnectorError("render_cache_unavailable", "The PDF stream was not stored completely in R2.", { retryable: true });
  }
  const signatureObject = await env.ARTIFACTS.get(key, { range: { offset: 0, length: 5 } });
  const signature = signatureObject ? new TextDecoder("latin1").decode(await signatureObject.arrayBuffer()) : "";
  if (signature !== "%PDF-") {
    await env.ARTIFACTS.delete(key);
    throw new ConnectorError("conversion_failed", "Microsoft Graph did not return a valid PDF conversion.");
  }
  return { verified, key, byteSize: stored.size, converted };
}

type PaidRenderToken = {
  kind: "paid-r2-document-render";
  userId: string;
  jobId: string;
  key: string;
  expiresAt: number;
};

async function readPaidRenderToken(env: Env, encoded: string): Promise<PaidRenderToken> {
  const token = decodeURIComponent(encoded);
  const payload = await openJson<PaidRenderToken>(env.COOKIE_ENCRYPTION_KEY, token);
  if (
    payload.kind !== "paid-r2-document-render" ||
    !payload.userId ||
    !payload.jobId ||
    !payload.key ||
    payload.expiresAt <= Date.now() ||
    !payload.key.startsWith(`jobs/${payload.jobId}/render/`)
  ) {
    throw new ConnectorError("render_link_expired", "The paid render link is invalid or expired.");
  }
  return payload;
}

function paidRenderHtml(input: {
  pdfUrl: string;
  page: number;
  width: number;
  crop: { x: number; y: number; width: number; height: number } | null;
}): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}canvas{display:block;margin:0;padding:0;background:#fff}</style>
<script>try{Object.defineProperty(window,"Worker",{value:undefined,configurable:true});}catch{window.Worker=undefined;}</script>
<script src="${PDFJS_MAIN_ROUTE}"></script><script src="${PDFJS_WORKER_ROUTE}"></script></head>
<body><canvas id="page-canvas"></canvas><script>
(async()=>{try{
 const PDF_URL=${JSON.stringify(input.pdfUrl).replace(/</g, "\\u003c")};
 const PAGE=${input.page}; const TARGET_WIDTH=${input.width}; const CROP=${JSON.stringify(input.crop)};
 if(!window.pdfjsLib) throw new Error('pdfjs_not_loaded');
 window.pdfjsLib.GlobalWorkerOptions.workerSrc='${PDFJS_WORKER_ROUTE}';
 const loading=window.pdfjsLib.getDocument({url:PDF_URL,disableAutoFetch:false,disableStream:false,disableRange:false,isEvalSupported:false,useWorkerFetch:false});
 const pdf=await loading.promise; if(PAGE<1||PAGE>pdf.numPages) throw new Error('page_out_of_range');
 const page=await pdf.getPage(PAGE); const unit=page.getViewport({scale:1}); const scale=TARGET_WIDTH/unit.width; const viewport=page.getViewport({scale});
 const full=document.createElement('canvas'); full.width=Math.max(1,Math.round(viewport.width)); full.height=Math.max(1,Math.round(viewport.height));
 await page.render({canvasContext:full.getContext('2d',{alpha:false}),viewport,background:'rgb(255,255,255)'}).promise;
 const output=document.getElementById('page-canvas');
 if(CROP){const sx=Math.min(Math.max(Math.round(CROP.x),0),full.width-1);const sy=Math.min(Math.max(Math.round(CROP.y),0),full.height-1);const sw=Math.min(Math.max(Math.round(CROP.width),1),full.width-sx);const sh=Math.min(Math.max(Math.round(CROP.height),1),full.height-sy);output.width=sw;output.height=sh;output.getContext('2d',{alpha:false}).drawImage(full,sx,sy,sw,sh,0,0,sw,sh);}else{output.width=full.width;output.height=full.height;output.getContext('2d',{alpha:false}).drawImage(full,0,0);}
 document.body.style.width=output.width+'px'; document.body.style.height=output.height+'px'; output.dataset.renderComplete='true'; output.dataset.pageCount=String(pdf.numPages);
 }catch(error){document.body.dataset.renderError=String(error&&error.message||error);}})();
</script></body></html>`;
}

function parseRange(header: string | null, size: number): { offset: number; length: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

export async function handlePaidRenderRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET") return null;
  if (url.pathname.startsWith(PAID_RENDER_PDF_PREFIX)) {
    try {
      const payload = await readPaidRenderToken(env, url.pathname.slice(PAID_RENDER_PDF_PREFIX.length));
      const head = await env.ARTIFACTS.head(payload.key);
      if (!head) return new Response("Render source missing.", { status: 404 });
      const range = parseRange(request.headers.get("range"), head.size);
      const object = await env.ARTIFACTS.get(payload.key, range ? { range } : undefined);
      if (!object) return new Response("Render source missing.", { status: 404 });
      const headers = new Headers({
        "Content-Type": "application/pdf",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      });
      if (range) {
        headers.set("Content-Length", String(range.length));
        headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
        return new Response(object.body, { status: 206, headers });
      }
      headers.set("Content-Length", String(head.size));
      return new Response(object.body, { status: 200, headers });
    } catch {
      return new Response("Render link expired or invalid.", { status: 410, headers: { "Cache-Control": "no-store" } });
    }
  }
  if (url.pathname.startsWith(PAID_RENDER_PAGE_PREFIX)) {
    try {
      const encoded = url.pathname.slice(PAID_RENDER_PAGE_PREFIX.length);
      await readPaidRenderToken(env, encoded);
      const page = positiveInteger(url.searchParams.get("page"), 1);
      const width = Math.min(positiveInteger(url.searchParams.get("width"), 1600), INTEGRATED_LIMITS.renderDimensionMax);
      const crop = url.searchParams.has("cropX") ? {
        x: Math.max(0, Number(url.searchParams.get("cropX"))),
        y: Math.max(0, Number(url.searchParams.get("cropY"))),
        width: Math.max(1, Number(url.searchParams.get("cropWidth"))),
        height: Math.max(1, Number(url.searchParams.get("cropHeight"))),
      } : null;
      const pdfUrl = `${PAID_RENDER_PDF_PREFIX}${encoded}`;
      return new Response(paidRenderHtml({ pdfUrl, page, width, crop }), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store, max-age=0",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    } catch {
      return new Response("Render link expired or invalid.", { status: 410, headers: { "Cache-Control": "no-store" } });
    }
  }
  return null;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function convertRenderedImage(
  env: Env,
  png: ArrayBuffer,
  outputFormat: "png" | "jpeg" | "webp",
): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  if (outputFormat === "png") return { bytes: png, mimeType: "image/png" };
  const output = await env.IMAGES
    .input(new Blob([png], { type: "image/png" }).stream())
    .output({ format: outputFormat === "jpeg" ? "image/jpeg" : "image/webp", anim: false });
  const response = output.response();
  if (!response.ok) throw new ConnectorError("render_conversion_failed", "The page render could not be converted.", { retryable: true });
  return { bytes: await response.arrayBuffer(), mimeType: outputFormat === "jpeg" ? "image/jpeg" : "image/webp" };
}

async function paidRenderDocumentPage(
  env: Env,
  userId: string,
  jobId: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const itemId = String(input.itemId ?? "");
  const page = positiveInteger(input.pageOrSlide, 1);
  const outputFormat = String(input.outputFormat ?? "png").toLowerCase() as "png" | "jpeg" | "webp";
  if (!new Set(["png", "jpeg", "webp"]).has(outputFormat)) throw new ConnectorError("invalid_output_format", "Output format must be PNG, JPEG, or WebP.");
  const requestedDpi = input.dpi === undefined ? null : Math.min(Math.max(Number(input.dpi), 36), 300);
  const width = Math.min(positiveInteger(input.width, requestedDpi ? Math.round(requestedDpi * 8.27) : 1600), INTEGRATED_LIMITS.renderDimensionMax);
  const cropRaw = input.cropRegion as Record<string, unknown> | undefined;
  const crop = cropRaw ? {
    x: Math.max(0, Number(cropRaw.x ?? 0)),
    y: Math.max(0, Number(cropRaw.y ?? 0)),
    width: Math.max(1, Number(cropRaw.width ?? width)),
    height: Math.max(1, Number(cropRaw.height ?? width)),
  } : null;
  const staged = await stagePdfForPaidRender(env, userId, itemId, jobId);
  try {
    const expiresAt = Date.now() + 10 * 60_000;
    const token = await sealJson(env.COOKIE_ENCRYPTION_KEY, {
      kind: "paid-r2-document-render",
      userId,
      jobId,
      key: staged.key,
      expiresAt,
    } satisfies PaidRenderToken);
    const params = new URLSearchParams({ page: String(page), width: String(width) });
    if (crop) {
      params.set("cropX", String(crop.x));
      params.set("cropY", String(crop.y));
      params.set("cropWidth", String(crop.width));
      params.set("cropHeight", String(crop.height));
    }
    const renderUrl = `${paidRenderOrigin(env)}${PAID_RENDER_PAGE_PREFIX}${encodeURIComponent(token)}?${params}`;
    let response: Response;
    try {
      response = await (env.BROWSER as any).quickAction("screenshot", {
        url: renderUrl,
        gotoOptions: { waitUntil: "domcontentloaded", timeout: 60_000 },
        waitForSelector: { selector: '#page-canvas[data-render-complete="true"]', visible: true, timeout: 55_000 },
        actionTimeout: 60_000,
        viewport: { width: Math.max(width, 256), height: INTEGRATED_LIMITS.renderDimensionMax, deviceScaleFactor: 1 },
        screenshotOptions: { type: "png", fullPage: true, captureBeyondViewport: true },
      });
    } catch {
      throw new ConnectorError("render_failed", "Cloudflare Browser Rendering did not finish the requested page.", { retryable: true });
    }
    if (!response.ok) throw new ConnectorError("render_failed", "Cloudflare Browser Rendering returned an invalid response.", { retryable: true });
    const png = await response.arrayBuffer();
    const signature = validateFileSignature("render.png", png, "image/png");
    if (!signature.compatible) throw new ConnectorError("render_invalid", "The generated page render is not a valid PNG.");
    const dimensions = pngDimensions(new Uint8Array(png));
    const converted = await convertRenderedImage(env, png, outputFormat);
    const metadata = {
      ...compactVerifiedItem(staged.verified),
      requestedPageOrSlide: page,
      outputFormat,
      mimeType: converted.mimeType,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      requestedDpi,
      cropRegion: crop,
      exactRequestedPage: true,
      officeConversion: staged.converted ? "microsoft_graph_pdf" : "not_required",
      renderer: "cloudflare_browser_rendering_r2_pdfjs",
      sourceCache: "private_r2",
      sourceByteSize: staged.byteSize,
      renderJobId: jobId,
    };
    return {
      structuredContent: metadata,
      content: [
        { type: "text", text: JSON.stringify(metadata, null, 2) },
        { type: "image", data: bytesToBase64(converted.bytes), mimeType: converted.mimeType },
      ],
    } as CallToolResult;
  } finally {
    await env.ARTIFACTS.delete(staged.key).catch(() => undefined);
  }
}

type PdfObject = {
  id: number;
  generation: number;
  body: string;
  absoluteBodyStart: number;
};

function pdfObjects(binary: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  for (const match of binary.matchAll(/(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g)) {
    const id = Number(match[1]);
    const body = match[3] ?? "";
    const absoluteBodyStart = (match.index ?? 0) + match[0].indexOf(body);
    objects.set(id, { id, generation: Number(match[2]), body, absoluteBodyStart });
  }
  return objects;
}

function xObjectReferences(body: string, objects: Map<number, PdfObject>): number[] {
  let source = body;
  const resourcesRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(body);
  if (resourcesRef) source += `\n${objects.get(Number(resourcesRef[1]))?.body ?? ""}`;
  const result = new Set<number>();
  const dictionaries: string[] = [];
  for (const dictionary of source.matchAll(/\/XObject\s*<<([\s\S]*?)>>/g)) {
    dictionaries.push(dictionary[1] ?? "");
  }
  for (const indirect of source.matchAll(/\/XObject\s+(\d+)\s+\d+\s+R/g)) {
    const dictionaryObject = objects.get(Number(indirect[1]));
    if (dictionaryObject) dictionaries.push(dictionaryObject.body);
  }
  for (const dictionary of dictionaries) {
    for (const reference of dictionary.matchAll(/\/[A-Za-z0-9_.-]+\s+(\d+)\s+\d+\s+R/g)) {
      result.add(Number(reference[1]));
    }
  }
  return [...result];
}

function pageImageRelationships(objects: Map<number, PdfObject>): Map<number, number[]> {
  const pages = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/.test(object.body));
  const relationships = new Map<number, number[]>();
  const walk = (objectId: number, page: number, visited: Set<number>): void => {
    if (visited.has(objectId)) return;
    visited.add(objectId);
    const object = objects.get(objectId);
    if (!object) return;
    if (/\/Subtype\s*\/Image\b/.test(object.body)) {
      const values = relationships.get(objectId) ?? [];
      if (!values.includes(page)) values.push(page);
      relationships.set(objectId, values);
      return;
    }
    for (const nested of xObjectReferences(object.body, objects)) walk(nested, page, visited);
  };
  pages.forEach((pageObject, index) => {
    for (const objectId of xObjectReferences(pageObject.body, objects)) walk(objectId, index + 1, new Set());
  });
  return relationships;
}

function enhancedPdfVisuals(buffer: ArrayBuffer): { pageCount: number; visuals: DocumentVisualCandidate[] } {
  const bytes = new Uint8Array(buffer);
  const binary = new TextDecoder("latin1").decode(bytes);
  const objects = pdfObjects(binary);
  const pages = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/.test(object.body));
  const pageCount = Math.min(INTEGRATED_LIMITS.pdfPagesMax, pages.length || Number(/\/Count\s+(\d+)/.exec(binary)?.[1] ?? 1));
  const relationships = pageImageRelationships(objects);
  const visuals: DocumentVisualCandidate[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    visuals.push({
      visualKey: `pdf:page:${page}`,
      pageOrSlide: page,
      objectType: "pdf_page",
      relationshipId: null,
      originalFilename: null,
      mimeType: null,
      pixelWidth: null,
      pixelHeight: null,
      coordinates: null,
      caption: null,
      nearbyHeading: null,
      altText: null,
      title: null,
      description: null,
      sourceHyperlink: null,
      exactOriginalAvailable: false,
      renderAvailable: true,
      extractionMethod: "pdf_page_inventory",
      completenessConfidence: "high",
      locator: { kind: "render_page", page },
    });
  }
  for (const object of objects.values()) {
    if (!/\/Subtype\s*\/Image\b/.test(object.body) || !/\/Filter\s*(?:\[\s*)?\/DCTDecode\b/.test(object.body)) continue;
    const streamMarker = /stream\r?\n/g.exec(object.body);
    const endMarker = object.body.lastIndexOf("endstream");
    if (!streamMarker || endMarker <= streamMarker.index) continue;
    const start = object.absoluteBodyStart + streamMarker.index + streamMarker[0].length;
    const end = object.absoluteBodyStart + endMarker;
    if (start < 0 || end <= start || end > bytes.length) continue;
    const parents = relationships.get(object.id) ?? [];
    visuals.push({
      visualKey: `pdf:image:${object.id}:${object.generation}`,
      pageOrSlide: parents[0] ?? null,
      objectType: "embedded_raster",
      relationshipId: `${object.id} ${object.generation} R`,
      originalFilename: `pdf-image-${object.id}.jpg`,
      mimeType: "image/jpeg",
      pixelWidth: Number(/\/Width\s+(\d+)/.exec(object.body)?.[1] ?? 0) || null,
      pixelHeight: Number(/\/Height\s+(\d+)/.exec(object.body)?.[1] ?? 0) || null,
      coordinates: null,
      caption: null,
      nearbyHeading: null,
      altText: null,
      title: null,
      description: null,
      sourceHyperlink: null,
      exactOriginalAvailable: true,
      renderAvailable: true,
      extractionMethod: "pdf_dct_stream_with_page_relationship",
      completenessConfidence: parents.length ? "high" : "medium",
      locator: { kind: "pdf_range", start, end, objectId: object.id, generation: object.generation, parentPages: parents },
    });
  }
  return { pageCount, visuals };
}

function extensionForMime(mimeType: string | null): string {
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/tiff": ".tif",
    "image/svg+xml": ".svg",
  } as Record<string, string>)[String(mimeType ?? "").toLowerCase()] ?? ".bin";
}

async function perceptualHashForBytes(env: Env, bytes: Uint8Array, mimeType: string): Promise<string | null> {
  try {
    const output = await env.IMAGES
      .input(new Blob([ownedArrayBuffer(bytes)], { type: mimeType }).stream())
      .transform({ width: 9, height: 8, fit: "cover" })
      .output({ format: "image/png", anim: false });
    const response = output.response();
    if (!response.ok) return null;
    return pngDifferenceHash(new Uint8Array(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

async function stableVisualId(
  userId: string,
  verified: VerifiedItem,
  candidate: DocumentVisualCandidate,
  exactSha256: string | null,
): Promise<string> {
  const digest = await sha256HexUtf8(canonicalJson({
    version: 2,
    userId,
    itemId: verified.item.id,
    eTag: verified.item.eTag ?? null,
    visualKey: candidate.visualKey,
    pageOrSlide: candidate.pageOrSlide,
    exactSha256,
  }));
  return `vis_${digest.slice(0, 48)}`;
}

async function paidListDocumentVisuals(
  env: Env,
  userId: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const itemId = String(input.itemId ?? "");
  const cursor = Math.max(Number(input.cursor ?? 0), 0);
  const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 200);
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "Document visual enumeration requires a file.");
  const extension = extensionOf(verified.item.name);
  const maximum = boundedMegabytes(env.PAID_VISUAL_PARSE_MB, 100, 115) * 1024 * 1024;
  const buffer = await graphFetchBytes(env, userId, `/me/drive/items/${encodeURIComponent(itemId)}/content`, maximum, { redirect: "follow" });
  let entries: OoxmlEntryMap | null = null;
  let candidates: DocumentVisualCandidate[];
  let pageCount: number | null;
  if (new Set([".pptx", ".potx", ".ppsx"]).has(extension)) {
    entries = safeUnzipOoxml(buffer);
    const inspected = inspectPptx(entries);
    candidates = inspected.visuals;
    pageCount = inspected.pageCount;
  } else if (extension === ".docx") {
    entries = safeUnzipOoxml(buffer);
    const inspected = inspectDocx(entries);
    candidates = inspected.visuals;
    pageCount = inspected.pageCount;
  } else if (extension === ".pdf") {
    const inspected = enhancedPdfVisuals(buffer);
    candidates = inspected.visuals;
    pageCount = inspected.pageCount;
  } else {
    throw new ConnectorError("unsupported_visual_document", "Document visuals are supported for PDF, PPTX, POTX, PPSX, and DOCX.");
  }
  const selected = candidates.slice(cursor, cursor + limit);
  const results: Record<string, unknown>[] = [];
  for (const candidate of selected) {
    const originalBytes = candidate.exactOriginalAvailable
      ? extractVisualBytes(buffer, entries, candidate.locator)
      : null;
    const exactSha256 = originalBytes ? await sha256Bytes(originalBytes) : null;
    const perceptualHash = originalBytes && candidate.mimeType
      ? await perceptualHashForBytes(env, originalBytes, candidate.mimeType)
      : null;
    const stableId = await stableVisualId(userId, verified, candidate, exactSha256);
    const parentPages = Array.isArray((candidate.locator as any).parentPages)
      ? (candidate.locator as any).parentPages.map(Number).filter(Number.isInteger)
      : candidate.pageOrSlide ? [candidate.pageOrSlide] : [];
    let originalArtifactKey: string | null = null;
    if (originalBytes && candidate.mimeType) {
      originalArtifactKey = `visuals/${stableId}/original${extensionForMime(candidate.mimeType)}`;
      await putArtifact(env, originalArtifactKey, originalBytes, candidate.mimeType, {
        sourceItemId: verified.item.id,
        sourceETag: verified.item.eTag ?? "",
        visualKey: candidate.visualKey,
        sha256: exactSha256 ?? "",
      });
    }
    const record: StableVisualRecord = {
      stableId,
      userId,
      sourceItemId: verified.item.id,
      sourceETag: verified.item.eTag ?? null,
      sourceFilename: verified.item.name,
      sourceExtension: extension,
      visualKey: candidate.visualKey,
      pageOrSlide: candidate.pageOrSlide,
      parentPages,
      candidate: candidate as unknown as Record<string, unknown>,
      exactSha256,
      perceptualHash,
      originalArtifactKey,
      originalMimeType: candidate.mimeType,
      originalByteSize: originalBytes?.byteLength ?? null,
      createdAt: nowIso(),
    };
    await coordinatorRequest(env, userId, "/visuals/put", { record });
    const { locator: _locator, ...publicCandidate } = candidate;
    results.push({
      visualId: stableId,
      sourcePath: verified.relativePath,
      ...publicCandidate,
      parentPage: candidate.pageOrSlide === null ? null : {
        sourceItemId: verified.item.id,
        pageOrSlide: candidate.pageOrSlide,
        relationship: "contained_by_document_page",
      },
      parentPages,
      embeddedSha256: exactSha256,
      perceptualHash,
      exactOriginalArtifactAvailable: Boolean(originalArtifactKey),
      stableIdentityVersion: 2,
    });
  }
  const structuredContent = {
    source: compactVerifiedItem(verified),
    pageOrSlideCount: pageCount,
    totalVisuals: candidates.length,
    results,
    cursor: cursor + selected.length < candidates.length ? cursor + selected.length : null,
    stableVisualIds: true,
    embeddedHashesExposed: true,
    parentPageRelationshipsExposed: true,
  };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  } as CallToolResult;
}

async function paidFindVisualDuplicates(
  env: Env,
  userId: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const visualIds = Array.isArray(input.visualIds) ? input.visualIds.map(String) : [];
  const stableRecords: StableVisualRecord[] = [];
  const legacyIds: string[] = [];
  for (const visualId of visualIds) {
    if (!visualId.startsWith("vis_")) {
      legacyIds.push(visualId);
      continue;
    }
    const record = await stableVisual(env, userId, visualId);
    if (!record) throw new ConnectorError("stable_visual_not_found", `Stable visual ${visualId} was not found.`);
    stableRecords.push(record);
  }
  const entries: Array<Record<string, unknown> & { sha256: string | null; perceptualHash: string | null }> = stableRecords.map((record) => ({
    visualId: record.stableId,
    sourceItemId: record.sourceItemId,
    visualKey: record.visualKey,
    parentPages: record.parentPages,
    sha256: record.exactSha256,
    perceptualHash: record.perceptualHash,
  }));
  if (legacyIds.length || Array.isArray(input.itemIds) && input.itemIds.length) {
    const raw = await invokeRawTool(env, userId, "find_visual_duplicates", {
      ...input,
      visualIds: legacyIds,
    });
    const rawError = callToolError(raw);
    if (rawError) throw rawError;
    const content = raw.structuredContent as Record<string, unknown>;
    return {
      ...raw,
      structuredContent: {
        ...content,
        stableEntries: entries,
        stableVisualIdsEvaluated: stableRecords.length,
      },
      content: [{ type: "text", text: JSON.stringify({ ...content, stableEntries: entries, stableVisualIdsEvaluated: stableRecords.length }, null, 2) }],
    } as CallToolResult;
  }
  const exactGroups = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (!entry.sha256) continue;
    const group = exactGroups.get(entry.sha256) ?? [];
    group.push(entry);
    exactGroups.set(entry.sha256, group);
  }
  const exact = [...exactGroups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([hash, members]) => ({ groupId: hash, relationship: "exact_duplicate", members }));
  const threshold = Math.min(Math.max(Number(input.similarityThreshold ?? 8), 0), 16);
  const near: Record<string, unknown>[] = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left];
      const b = entries[right];
      if (!a.perceptualHash || !b.perceptualHash || a.sha256 === b.sha256) continue;
      const distance = hammingDistanceHex(a.perceptualHash, b.perceptualHash);
      if (distance <= threshold) near.push({
        groupId: await sha256HexUtf8(`near:${a.visualId}:${b.visualId}`),
        relationship: "perceptually_similar",
        distance,
        members: [a, b],
      });
    }
  }
  const structuredContent = { exactGroups: exact, nearGroups: near, similarityThreshold: threshold, deletionPerformed: false };
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }] } as CallToolResult;
}

async function executePaidOperation(env: Env, message: PaidJobMessage): Promise<CallToolResult> {
  if (message.toolName === "render_document_page") {
    return paidRenderDocumentPage(env, message.userId, message.jobId, message.input);
  }
  if (message.toolName === "list_document_visuals") {
    return paidListDocumentVisuals(env, message.userId, message.input);
  }
  if (message.toolName === "find_visual_duplicates") {
    return paidFindVisualDuplicates(env, message.userId, message.input);
  }
  const normalized = await resolveStableVisualInputs(env, message.userId, message.input);
  const result = await invokeRawTool(env, message.userId, message.toolName, normalized.input);
  if (normalized.reverse.size && result.structuredContent) {
    const structuredContent = replaceLegacyTokens(result.structuredContent, normalized.reverse) as Record<string, unknown>;
    return {
      ...result,
      structuredContent,
      content: result.content.map((entry) => entry.type === "text"
        ? { ...entry, text: JSON.stringify(structuredContent, null, 2) }
        : entry),
    } as CallToolResult;
  }
  return result;
}

async function processPaidMessage(message: PaidJobMessage, env: Env): Promise<void> {
  await updateJob(env, message.userId, message.jobId, {
    status: "running",
    progress: Math.min(95, Math.max(1, message.chunkIndex * 5)),
    stage: message.chunkIndex ? `processing_chunk_${message.chunkIndex}` : "processing",
  });
  const result = await executePaidOperation(env, message);
  const toolError = callToolError(result);
  if (toolError) throw toolError;
  const cursor = (result.structuredContent as Record<string, unknown> | undefined)?.cursor;
  if (cursor !== null && cursor !== undefined && message.toolName === "calculate_file_hashes") {
    const key = chunkKey(message.jobId, message.chunkIndex);
    await putArtifact(env, key, toolResultJson(result), PAID_TOOL_RESULT_MIME, {
      jobId: message.jobId,
      chunkIndex: String(message.chunkIndex),
      toolName: message.toolName,
    });
    const next: PaidJobMessage = {
      ...message,
      input: { ...message.input, cursor },
      chunkIndex: message.chunkIndex + 1,
    };
    await updateJob(env, message.userId, message.jobId, {
      status: "running",
      progress: Math.min(95, 5 + next.chunkIndex * 5),
      stage: `queued_chunk_${next.chunkIndex}`,
      resultKey: key,
      resultMimeType: PAID_TOOL_RESULT_MIME,
    });
    await env.PAID_JOBS.send(next);
    return;
  }
  let key: string;
  if (message.chunkIndex > 0 && message.toolName === "calculate_file_hashes") {
    const finalChunk = chunkKey(message.jobId, message.chunkIndex);
    await putArtifact(env, finalChunk, toolResultJson(result), PAID_TOOL_RESULT_MIME, {
      jobId: message.jobId,
      chunkIndex: String(message.chunkIndex),
      toolName: message.toolName,
    });
    const manifest = {
      jobId: message.jobId,
      toolName: message.toolName,
      chunkCount: message.chunkIndex + 1,
      chunks: Array.from({ length: message.chunkIndex + 1 }, (_, index) => chunkKey(message.jobId, index)),
      completedAt: nowIso(),
    };
    key = manifestKey(message.jobId);
    await putArtifact(env, key, JSON.stringify(manifest), "application/json", { jobId: message.jobId, manifest: "true" });
  } else {
    key = resultKey(message.jobId);
    await putArtifact(env, key, toolResultJson(result), PAID_TOOL_RESULT_MIME, {
      jobId: message.jobId,
      toolName: message.toolName,
    });
  }
  await updateJob(env, message.userId, message.jobId, {
    status: "completed",
    progress: 100,
    stage: "completed",
    resultKey: key,
    resultMimeType: message.chunkIndex > 0 ? "application/json" : PAID_TOOL_RESULT_MIME,
    error: null,
  });
  logPaidEvent("job_completed", { jobId: message.jobId, toolName: message.toolName, resultKey: key });
}

export class PaidConnectorWorkflow extends WorkflowEntrypoint<Env, PaidJobMessage> {
  async run(event: WorkflowEvent<PaidJobMessage>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const message = event.payload;
    await step.do("mark durable workflow queued", async () => {
      await updateJob(this.env, message.userId, message.jobId, {
        status: "queued",
        progress: 0,
        stage: "workflow_queued",
      });
    });
    await step.do(
      "enqueue paid connector work",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        await this.env.PAID_JOBS.send(message);
      },
    );
    return { jobId: message.jobId, queued: true, correlationId: message.correlationId };
  }
}

export async function processPaidQueueBatch(
  batch: MessageBatch<PaidJobMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    try {
      if (body.version !== 1 || !body.jobId || !body.userId || !QUEUED_TOOL_NAMES.has(body.toolName)) {
        throw new ConnectorError("invalid_paid_job_message", "The paid job message is invalid.");
      }
      await processPaidMessage(body, env);
      message.ack();
    } catch (error) {
      const value = error as { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> };
      const attempts = Number((message as any).attempts ?? 1);
      logPaidError("job_attempt_failed", error, { jobId: body.jobId, toolName: body.toolName, attempts });
      if (value.retryable !== false && attempts < 5) {
        await updateJob(env, body.userId, body.jobId, {
          status: "queued",
          stage: `retry_wait_${attempts}`,
          error: { code: value.code ?? "paid_job_failed", message: value.message ?? "Queued job attempt failed.", retryable: true },
        }).catch(() => undefined);
        message.retry({ delaySeconds: Math.min(300, 10 * 2 ** Math.max(0, attempts - 1)) });
      } else {
        await updateJob(env, body.userId, body.jobId, {
          status: "failed",
          stage: "failed",
          error: {
            code: value.code ?? "paid_job_failed",
            message: value instanceof Error ? value.message : String(value.message ?? error),
            retryable: Boolean(value.retryable),
            details: value.details ?? null,
          },
        }).catch(() => undefined);
        message.ack();
      }
    }
  }
}

export async function readPaidJobResult(env: Env, job: PaidJobRecord): Promise<CallToolResult> {
  if (job.status !== "completed" || !job.resultKey) {
    throw new ConnectorError("job_not_completed", "The paid job has not completed.", {
      retryable: job.status === "queued" || job.status === "running" || job.status === "reserved",
      details: { status: job.status, stage: job.stage, progress: job.progress },
    });
  }
  const artifact = await getArtifact(env, job.resultKey);
  const text = await artifact.text();
  if (job.resultMimeType === PAID_TOOL_RESULT_MIME) return parseToolResult(text);
  return {
    structuredContent: JSON.parse(text) as Record<string, unknown>,
    content: [{ type: "text", text }],
  } as CallToolResult;
}

export async function readStableVisualArtifact(
  env: Env,
  userId: string,
  stableId: string,
): Promise<{ record: StableVisualRecord; object: R2ObjectBody }> {
  const record = await stableVisual(env, userId, stableId);
  if (!record?.originalArtifactKey) {
    throw new ConnectorError("visual_original_not_available", "This stable visual does not have an exact embedded original.");
  }
  const object = await getArtifact(env, record.originalArtifactKey);
  return { record, object };
}
