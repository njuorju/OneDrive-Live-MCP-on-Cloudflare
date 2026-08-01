import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { unzlibSync } from "fflate";
import { ConnectorError, safeErrorResult } from "./errors";
import { validateFileSignature } from "./file-types";
import {
  compactVerifiedItem,
  graphFetchBytes,
  graphResponse,
  listVerifiedChildren,
  resolveRelativeFolder,
  validateItemName,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import {
  INTEGRATED_LIMITS,
  base64ToBytes,
  extensionOfName,
  sha256Bytes,
  type DocumentVisualCandidate,
} from "./integrated-core";
import { openJson } from "./security";
import type { GraphDriveItem } from "./types";
import type { HotfixContext } from "./version20-hotfix";

type VisualToken = {
  version: 1;
  itemId: string;
  eTag: string | null;
  filename: string;
  extension: string;
  candidate: DocumentVisualCandidate;
  expiresAt: number;
};

type PixelSample = {
  width: number;
  height: number;
  rgba: Uint8Array;
};

export type RenderPixelStatistics = {
  sampleWidth: number;
  sampleHeight: number;
  sampledPixels: number;
  opaquePixels: number;
  transparentPixels: number;
  nearWhitePixels: number;
  nearBlackPixels: number;
  nonWhitePixels: number;
  luminanceMinimum: number;
  luminanceMaximum: number;
  luminanceVariance: number;
  alphaMinimum: number;
  alphaMaximum: number;
};

const OUTPUT_EXTENSIONS: Record<string, Set<string>> = {
  png: new Set([".png"]),
  jpeg: new Set([".jpg", ".jpeg"]),
  webp: new Set([".webp"]),
};

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const value = a + b - c;
  const distanceA = Math.abs(value - a);
  const distanceB = Math.abs(value - b);
  const distanceC = Math.abs(value - c);
  return distanceA <= distanceB && distanceA <= distanceC ? a : distanceB <= distanceC ? b : c;
}

function decodeBoundedPng(png: Uint8Array): PixelSample {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => png[index] === value)) {
    throw new ConnectorError("render_malformed", "The rendered-image sample is not a valid PNG.");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= png.length) {
    const length = readUint32(png, offset);
    if (length > png.length - offset - 12) {
      throw new ConnectorError("render_malformed", "The rendered-image sample contains a malformed PNG chunk.");
    }
    const type = String.fromCharCode(...png.slice(offset + 4, offset + 8));
    const data = png.slice(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (
    width < 1 || height < 1 || width > 128 || height > 128 ||
    bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType) || idat.length === 0
  ) {
    throw new ConnectorError("render_malformed", "The rendered-image sample has unsupported or invalid PNG dimensions or encoding.");
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const merged = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let mergedOffset = 0;
  for (const part of idat) {
    merged.set(part, mergedOffset);
    mergedOffset += part.length;
  }
  let inflated: Uint8Array;
  try {
    inflated = unzlibSync(merged);
  } catch {
    throw new ConnectorError("render_malformed", "The rendered-image sample could not be decoded.");
  }
  const stride = width * channels;
  if (inflated.length !== height * (stride + 1)) {
    throw new ConnectorError("render_malformed", "The rendered-image sample has an invalid decoded byte length.");
  }
  const rgba = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    if (filter > 4) throw new ConnectorError("render_malformed", "The rendered-image sample uses an invalid PNG filter.");
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] ?? 0;
      const upperLeft = x >= channels ? previous[x - channels] ?? 0 : 0;
      row[x] = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + up
            : filter === 3
              ? raw + Math.floor((left + up) / 2)
              : raw + paeth(left, up, upperLeft);
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (colorType === 0) {
        rgba[target] = row[source];
        rgba[target + 1] = row[source];
        rgba[target + 2] = row[source];
        rgba[target + 3] = 255;
      } else if (colorType === 2) {
        rgba[target] = row[source];
        rgba[target + 1] = row[source + 1];
        rgba[target + 2] = row[source + 2];
        rgba[target + 3] = 255;
      } else if (colorType === 4) {
        rgba[target] = row[source];
        rgba[target + 1] = row[source];
        rgba[target + 2] = row[source];
        rgba[target + 3] = row[source + 1];
      } else {
        rgba[target] = row[source];
        rgba[target + 1] = row[source + 1];
        rgba[target + 2] = row[source + 2];
        rgba[target + 3] = row[source + 3];
      }
    }
    previous.set(row);
  }
  return { width, height, rgba };
}

export function summarizePixelSample(sample: PixelSample): RenderPixelStatistics {
  const pixels = sample.width * sample.height;
  if (pixels < 1 || sample.rgba.length !== pixels * 4) {
    throw new ConnectorError("render_malformed", "The decoded rendered-image sample is invalid.");
  }
  let opaque = 0;
  let transparent = 0;
  let nearWhite = 0;
  let nearBlack = 0;
  let nonWhite = 0;
  let luminanceMinimum = 255;
  let luminanceMaximum = 0;
  let alphaMinimum = 255;
  let alphaMaximum = 0;
  let mean = 0;
  let sumSquares = 0;
  for (let offset = 0, index = 0; offset < sample.rgba.length; offset += 4, index += 1) {
    const red = sample.rgba[offset];
    const green = sample.rgba[offset + 1];
    const blue = sample.rgba[offset + 2];
    const alpha = sample.rgba[offset + 3];
    alphaMinimum = Math.min(alphaMinimum, alpha);
    alphaMaximum = Math.max(alphaMaximum, alpha);
    if (alpha <= 8) transparent += 1;
    else opaque += 1;
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    luminanceMinimum = Math.min(luminanceMinimum, luminance);
    luminanceMaximum = Math.max(luminanceMaximum, luminance);
    const delta = luminance - mean;
    mean += delta / (index + 1);
    sumSquares += delta * (luminance - mean);
    if (alpha > 8 && red >= 250 && green >= 250 && blue >= 250) nearWhite += 1;
    else if (alpha > 8) nonWhite += 1;
    if (alpha > 8 && red <= 5 && green <= 5 && blue <= 5) nearBlack += 1;
  }
  return {
    sampleWidth: sample.width,
    sampleHeight: sample.height,
    sampledPixels: pixels,
    opaquePixels: opaque,
    transparentPixels: transparent,
    nearWhitePixels: nearWhite,
    nearBlackPixels: nearBlack,
    nonWhitePixels: nonWhite,
    luminanceMinimum,
    luminanceMaximum,
    luminanceVariance: pixels > 1 ? sumSquares / (pixels - 1) : 0,
    alphaMinimum,
    alphaMaximum,
  };
}

export function assertNonBlankPixelStatistics(statistics: RenderPixelStatistics): void {
  const minimumVariationPixels = Math.max(2, Math.ceil(statistics.sampledPixels * 0.0002));
  if (statistics.opaquePixels === 0 || statistics.transparentPixels === statistics.sampledPixels) {
    throw new ConnectorError("render_blank", "The rendered image is uniformly transparent.");
  }
  if (statistics.nearWhitePixels >= statistics.sampledPixels - minimumVariationPixels) {
    throw new ConnectorError("render_blank", "The rendered image is uniformly white.");
  }
  if (statistics.nearBlackPixels >= statistics.sampledPixels - minimumVariationPixels) {
    throw new ConnectorError("render_blank", "The rendered image is uniformly black.");
  }
  if (
    statistics.luminanceMaximum - statistics.luminanceMinimum < 3 &&
    statistics.luminanceVariance < 0.5
  ) {
    throw new ConnectorError("render_blank", "The rendered image has effectively zero pixel variance.");
  }
}

async function renderedPixelStatistics(
  context: Pick<HotfixContext, "env">,
  bytes: Uint8Array,
  mimeType: string,
): Promise<RenderPixelStatistics> {
  const images = context.env.IMAGES as any;
  if (!images) throw new ConnectorError("image_validation_unavailable", "Decoded rendered-image validation is unavailable.");
  const output = await images
    .input(new Blob([bytes.slice().buffer], { type: mimeType }).stream())
    .transform({ width: 128, height: 128, fit: "scale-down" })
    .output({ format: "image/png", anim: false });
  const response = output.response();
  if (!response.ok) throw new ConnectorError("render_malformed", "The rendered image could not be decoded for validation.");
  const sample = decodeBoundedPng(new Uint8Array(await response.arrayBuffer()));
  const statistics = summarizePixelSample(sample);
  assertNonBlankPixelStatistics(statistics);
  return statistics;
}

async function decodePageVisualToken(context: HotfixContext, raw: string): Promise<{
  token: VisualToken;
  verified: VerifiedItem;
  page: number;
}> {
  let token: VisualToken;
  try {
    token = await openJson<VisualToken>(context.env.COOKIE_ENCRYPTION_KEY, raw);
  } catch {
    throw new ConnectorError("invalid_visual_id", "The visual ID is invalid or expired.");
  }
  if (token.version !== 1 || !token.itemId || token.expiresAt <= Date.now()) {
    throw new ConnectorError("invalid_visual_id", "The visual ID is invalid or expired.");
  }
  const match = /^pdf:page:(\d+)$/.exec(String(token.candidate?.visualKey ?? ""));
  const pageFromKey = match ? Number(match[1]) : NaN;
  const candidatePage = Number(token.candidate?.pageOrSlide ?? (token.candidate?.locator as Record<string, unknown> | undefined)?.page);
  if (
    token.candidate?.objectType !== "pdf_page" || token.candidate?.renderAvailable !== true ||
    !Number.isInteger(pageFromKey) || pageFromKey < 1 || pageFromKey > 500 ||
    !Number.isInteger(candidatePage) || candidatePage !== pageFromKey
  ) {
    throw new ConnectorError("unsupported_visual_id", "Rendered saving requires an exact pdf:page:<n> visual ID.");
  }
  const verified = await verifyItemInsideRoot(context.env, context.userId, token.itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "The visual source is not a file.");
  if (token.eTag && verified.item.eTag !== token.eTag) {
    throw new ConnectorError("etag_conflict", "The source document changed after the visual ID was created.");
  }
  return { token, verified, page: pageFromKey };
}

function resultError(result: CallToolResult): ConnectorError {
  const structured = result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent as Record<string, unknown>
    : {};
  const error = structured.error && typeof structured.error === "object"
    ? structured.error as Record<string, unknown>
    : {};
  return new ConnectorError(
    String(error.code ?? "render_failed"),
    String(error.message ?? "The requested page render failed."),
    { retryable: Boolean(error.retryable), details: error.details as Record<string, unknown> | undefined },
  );
}

async function assertNameAvailable(
  context: HotfixContext,
  folder: VerifiedItem,
  filename: string,
): Promise<boolean> {
  let nextUrl: string | undefined;
  do {
    const page = await listVerifiedChildren(context.env, context.userId, folder, 200, nextUrl);
    if (page.items.some((child) => child.item.name.toLocaleLowerCase("en") === filename.toLocaleLowerCase("en"))) {
      return false;
    }
    nextUrl = page.nextUrl;
  } while (nextUrl);
  return true;
}

function autoRename(filename: string, index: number): string {
  const extension = extensionOfName(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem} (${index})${extension}`;
}

async function chooseFilename(
  context: HotfixContext,
  folder: VerifiedItem,
  requested: string,
  conflictPolicy: string,
): Promise<string> {
  const filename = validateItemName(requested);
  if (await assertNameAvailable(context, folder, filename)) return filename;
  if (conflictPolicy !== "auto-rename") {
    throw new ConnectorError("name_conflict", "An item with that name already exists in the destination folder.");
  }
  for (let index = 2; index <= 999; index += 1) {
    const candidate = validateItemName(autoRename(filename, index));
    if (await assertNameAvailable(context, folder, candidate)) return candidate;
  }
  throw new ConnectorError("name_conflict", "No conflict-free auto-renamed filename could be found.");
}

function trustedUploadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError("unsafe_upload_url", "Microsoft Graph returned an invalid upload URL.");
  }
  const host = url.hostname.toLocaleLowerCase("en");
  const trusted = host === "api.onedrive.com" || host.endsWith(".onedrive.com") || host.endsWith(".1drv.com") || host.endsWith(".sharepoint.com");
  if (url.protocol !== "https:" || !trusted || url.username || url.password || url.hash) {
    throw new ConnectorError("unsafe_upload_url", "Microsoft Graph returned an untrusted upload URL.");
  }
  return url;
}

async function uploadBytes(
  context: HotfixContext,
  destinationPath: string,
  requestedFilename: string,
  bytes: Uint8Array,
  mimeType: string,
  conflictPolicy: string,
): Promise<Record<string, unknown>> {
  const destination = await resolveRelativeFolder(context.env, context.userId, destinationPath);
  const filename = await chooseFilename(context, destination, requestedFilename, conflictPolicy);
  const currentDestination = await verifyItemInsideRoot(context.env, context.userId, destination.item.id);
  if (!(await assertNameAvailable(context, currentDestination, filename))) {
    throw new ConnectorError("name_conflict", "The destination changed before upload.");
  }
  let created: GraphDriveItem;
  if (bytes.byteLength <= 4 * 1024 * 1024) {
    const response = await graphResponse(
      context.env,
      context.userId,
      `/me/drive/items/${encodeURIComponent(currentDestination.item.id)}:/${encodeURIComponent(filename)}:/content?%40microsoft.graph.conflictBehavior=fail`,
      {
        method: "PUT",
        headers: { "Content-Type": mimeType, "If-None-Match": "*" },
        body: new Blob([bytes.slice().buffer], { type: mimeType }),
      },
    );
    created = await response.json() as GraphDriveItem;
  } else {
    const sessionResponse = await graphResponse(
      context.env,
      context.userId,
      `/me/drive/items/${encodeURIComponent(currentDestination.item.id)}:/${encodeURIComponent(filename)}:/createUploadSession`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: { name: filename, "@microsoft.graph.conflictBehavior": "fail" } }),
      },
    );
    const session = await sessionResponse.json() as { uploadUrl?: string };
    if (!session.uploadUrl) throw new ConnectorError("upload_session_failed", "Microsoft Graph did not create an upload session.");
    const uploadUrl = trustedUploadUrl(session.uploadUrl);
    const chunkSize = 10 * 320 * 1024;
    let finalItem: GraphDriveItem | null = null;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      await verifyItemInsideRoot(context.env, context.userId, currentDestination.item.id);
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(end - offset),
          "Content-Range": `bytes ${offset}-${end - 1}/${bytes.byteLength}`,
        },
        body: new Blob([bytes.slice(offset, end).buffer], { type: "application/octet-stream" }),
      });
      if (!response.ok) {
        throw new ConnectorError("upload_failed", "The rendered-image upload session failed.", {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      if (response.status !== 202) finalItem = await response.json() as GraphDriveItem;
    }
    if (!finalItem) throw new ConnectorError("upload_incomplete", "Microsoft Graph did not confirm the final rendered-image upload.");
    created = finalItem;
  }
  const verified = await verifyItemInsideRoot(context.env, context.userId, created.id);
  const expectedSha256 = await sha256Bytes(bytes);
  const readBack = await graphFetchBytes(
    context.env,
    context.userId,
    `/me/drive/items/${encodeURIComponent(verified.item.id)}/content`,
    Math.max(bytes.byteLength + 1, INTEGRATED_LIMITS.fileBytesDefault),
    verified.item.eTag ? { headers: { "If-Match": verified.item.eTag } } : {},
  );
  const readBackSha256 = await sha256Bytes(readBack);
  if (readBack.byteLength !== bytes.byteLength || readBackSha256 !== expectedSha256) {
    if (verified.item.eTag) {
      await graphResponse(context.env, context.userId, `/me/drive/items/${encodeURIComponent(verified.item.id)}`, {
        method: "DELETE",
        headers: { "If-Match": verified.item.eTag },
      }).catch(() => undefined);
    }
    throw new ConnectorError("upload_readback_mismatch", "The created rendered image did not match the exact uploaded bytes.");
  }
  return {
    ...compactVerifiedItem(verified),
    filename: verified.item.name,
    byteSize: readBack.byteLength,
    sha256: expectedSha256,
    readBackSha256,
    exactBytesWritten: bytes.byteLength,
    readBackVerified: true,
    conflictPolicy,
  };
}

async function saveRenderedPage(
  context: HotfixContext,
  renderHandler: (input: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const { token, verified: sourceBefore, page } = await decodePageVisualToken(context, String(input.visualId ?? ""));
    const outputFormat = String(input.outputFormat ?? "png").toLocaleLowerCase("en");
    if (!OUTPUT_EXTENSIONS[outputFormat]) {
      throw new ConnectorError("invalid_output_format", "Output format must be PNG, JPEG, or WebP.");
    }
    const defaultExtension = outputFormat === "jpeg" ? "jpg" : outputFormat;
    const defaultName = `${token.filename.replace(/\.[^.]+$/, "")}_page_${page}.${defaultExtension}`;
    const filename = String(input.filename ?? defaultName);
    if (!OUTPUT_EXTENSIONS[outputFormat].has(extensionOfName(filename))) {
      throw new ConnectorError("filename_format_mismatch", "The rendered-image filename extension does not match outputFormat.");
    }
    const renderInput: Record<string, unknown> = {
      itemId: token.itemId,
      pageOrSlide: page,
      outputFormat,
      width: input.width,
      dpi: input.dpi,
      cropRegion: input.cropRegion,
      transparentBackground: false,
    };
    const rendered = await renderHandler(renderInput, {});
    if (rendered.isError) throw resultError(rendered);
    const image = rendered.content?.find((entry) => entry.type === "image") as { type: "image"; data: string; mimeType: string } | undefined;
    if (!image?.data || !image.mimeType) {
      throw new ConnectorError("render_invalid", "The page renderer did not return image bytes.");
    }
    const bytes = base64ToBytes(image.data);
    if (bytes.byteLength < 512) throw new ConnectorError("render_blank", "The rendered image is implausibly small.");
    const signature = validateFileSignature(filename, bytes.slice().buffer, image.mimeType);
    if (!signature.compatible) throw new ConnectorError("render_malformed", "The rendered image signature is invalid.");
    const metadata = rendered.structuredContent && typeof rendered.structuredContent === "object"
      ? rendered.structuredContent as Record<string, unknown>
      : {};
    const renderedPage = Number(metadata.requestedPageOrSlide ?? metadata.pageOrSlide);
    const width = Number(metadata.width);
    const height = Number(metadata.height);
    if (renderedPage !== page) throw new ConnectorError("render_page_mismatch", "The renderer returned a different page than requested.");
    if (
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > INTEGRATED_LIMITS.renderDimensionMax || height > INTEGRATED_LIMITS.renderDimensionMax
    ) {
      throw new ConnectorError("render_dimensions_invalid", "The rendered image dimensions are invalid or out of bounds.");
    }
    const statistics = await renderedPixelStatistics(context, bytes, image.mimeType);
    const sourceAfter = await verifyItemInsideRoot(context.env, context.userId, token.itemId);
    if (
      sourceAfter.item.eTag !== sourceBefore.item.eTag ||
      (token.eTag && sourceAfter.item.eTag !== token.eTag)
    ) {
      throw new ConnectorError("etag_conflict", "The source document changed during rendering.");
    }
    const saved = await uploadBytes(
      context,
      String(input.destinationPath ?? ""),
      filename,
      bytes,
      image.mimeType,
      String(input.conflictPolicy ?? "fail"),
    );
    const result = {
      ...saved,
      dimensions: { width, height },
      width,
      height,
      sourceItemId: token.itemId,
      sourceETag: token.eTag,
      pageNumber: page,
      visualKey: token.candidate.visualKey,
      mode: String(input.mode ?? "rendered"),
      renderParameters: {
        outputFormat,
        width: input.width ?? null,
        dpi: input.dpi ?? null,
        cropRegion: input.cropRegion ?? null,
      },
      renderer: metadata.renderer ?? "pdfjs_canvas",
      pixelStatistics: statistics,
      blankValidation: "passed",
      exactRequestedPage: true,
    };
    return {
      structuredContent: result,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return safeErrorResult(error) as CallToolResult;
  }
}

export function registerRenderedSaveHotfix(
  server: McpServer,
  contextFactory: () => HotfixContext,
): void {
  const target = server as any;
  const saveTool = target._registeredTools?.save_document_visual;
  const renderTool = target._registeredTools?.render_document_page;
  if (!saveTool?.handler || !renderTool?.handler) {
    throw new Error("save_document_visual and render_document_page must be registered before the rendered-save hotfix.");
  }
  const originalSave = saveTool.handler.bind(saveTool) as (input: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
  const provenRender = renderTool.handler.bind(renderTool) as (input: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
  saveTool.handler = async (input: Record<string, unknown>) => {
    const mode = String(input.mode ?? "original");
    if (mode === "original") return originalSave(input, {});
    if (mode !== "rendered" && mode !== "region") {
      return safeErrorResult(new ConnectorError("invalid_visual_mode", "Visual mode must be original, rendered, or region.")) as CallToolResult;
    }
    return saveRenderedPage(contextFactory(), provenRender, input);
  };
}
