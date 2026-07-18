import { getRuntimeConfig } from "./config";
import { ConnectorError } from "./errors";
import {
  DIRECT_IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  extensionOf,
  isAllowedOriginalFile,
  isAllowedTextFile,
  isConvertibleImage,
  isDirectImage,
  isVisualAsset,
  normalizedMimeType,
  validateFileSignature,
} from "./file-types";
import {
  compactVerifiedItem,
  downloadVerifiedItem,
  graphFetch,
  listVerifiedChildren,
  resolveConfiguredRoot,
  resolveRelativeFolder,
  resolveRelativeItem,
  safeCacheKey,
  strictRelativePath,
  validateItemName,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import { extractPptxText } from "./pptx";
import type { GraphCollection, GraphDriveItem, ImageMetadata, VisualAsset } from "./types";

const WORKERS_AI_EXTENSIONS = new Set([
  ".pdf", ".docx", ".xlsx", ".xls", ".csv", ".html", ".htm", ".xml", ".odt", ".ods",
  ".jpg", ".jpeg", ".png", ".webp", ".svg", ".gif", ".bmp",
]);
const IMAGES_BINDING_CONVERTIBLE = new Set([".heic", ".heif", ".svg"]);
const VISUAL_INPUT_FORMATS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".svg"]);

function orientation(width: number | null, height: number | null): VisualAsset["orientation"] {
  if (!width || !height) return "unknown";
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

function assetFromVerified(verified: VerifiedItem): VisualAsset {
  const base = compactVerifiedItem(verified);
  const width = verified.item.image?.width ?? null;
  const height = verified.item.image?.height ?? null;
  const extension = extensionOf(verified.item.name);
  return {
    ...base,
    width,
    height,
    orientation: orientation(width, height),
    directlyAnalysable: DIRECT_IMAGE_EXTENSIONS.has(extension),
    conversionRequired: isConvertibleImage(verified.item.name),
    originalFetchAvailable: isAllowedOriginalFile(verified.item.name),
  };
}

function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor<T>(cursor?: string): T | undefined {
  if (!cursor) return undefined;
  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((cursor.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new ConnectorError("invalid_cursor", "The pagination cursor is invalid.");
  }
}

export async function getConnectionStatus(env: Env, userId: string) {
  const root = await resolveConfiguredRoot(env, userId);
  await verifyItemInsideRoot(env, userId, root.id);
  return {
    connected: true,
    rootConfigured: true,
    access: "read-write within configured root",
    snapshotRequired: false,
    requiredPermission: "Files.ReadWrite",
  };
}

export async function listAllowedFolder(env: Env, userId: string, path: string, limit: number) {
  const folder = await resolveRelativeFolder(env, userId, path);
  const page = await listVerifiedChildren(env, userId, folder, Math.min(limit, 200));
  return page.items.slice(0, limit).map(compactVerifiedItem);
}

export async function searchAllowedRoot(env: Env, userId: string, query: string, limit: number) {
  const term = query.trim();
  if (!term) throw new ConnectorError("invalid_query", "Search text is required.");
  const escaped = encodeURIComponent(term.replace(/'/g, "''"));
  const result = await graphFetch<GraphCollection<GraphDriveItem>>(
    env,
    userId,
    `/me/drive/root/search(q='${escaped}')?$select=id,name,size,file,folder,package,image,photo,parentReference,lastModifiedDateTime,eTag,cTag,remoteItem,deleted&$top=${Math.min(limit * 3, 100)}`,
  );
  const verified: ReturnType<typeof compactVerifiedItem>[] = [];
  for (const item of result.value) {
    if (verified.length >= limit) break;
    try {
      verified.push(compactVerifiedItem(await verifyItemInsideRoot(env, userId, item.id)));
    } catch {
      // Root boundary failures are intentionally omitted from search results.
    }
  }
  return verified;
}

async function convertBufferToText(env: Env, item: GraphDriveItem, buffer: ArrayBuffer): Promise<string> {
  const extension = extensionOf(item.name);
  if (TEXT_EXTENSIONS.has(extension)) {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
  if (extension === ".pptx" || extension === ".potx") return extractPptxText(buffer);
  if (!WORKERS_AI_EXTENSIONS.has(extension)) {
    throw new ConnectorError("unsupported_text_extraction", "This file type is not supported for text extraction. Use fetch_original_file instead.");
  }
  const result = await env.AI.toMarkdown([
    {
      name: item.name,
      blob: new Blob([buffer], { type: normalizedMimeType(item.name, item.file?.mimeType) }),
    },
  ]);
  const first = Array.isArray(result) ? result[0] : result;
  if (!first || typeof first !== "object") {
    throw new ConnectorError("conversion_failed", "The document could not be converted to text.");
  }
  const record = first as Record<string, unknown>;
  const text = String(record.data ?? record.markdown ?? record.text ?? "");
  if (!text) throw new ConnectorError("conversion_failed", "The document could not be converted to text.");
  return text;
}

export async function readAllowedFile(
  env: Env,
  userId: string,
  itemId: string,
  startChar: number,
  requestedMaxChars: number,
) {
  const config = getRuntimeConfig(env);
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "The requested item is a folder.");
  const maxChars = Math.min(requestedMaxChars, config.maxReadChars);
  const cacheEnabled = config.cacheTtlSeconds > 0;
  const key = await safeCacheKey(verified.item.id, verified.item.eTag ?? "no-etag");
  let text: string | null = null;
  if (cacheEnabled) text = await env.OAUTH_KV.get(key);
  if (text === null) {
    const { verified: current, buffer } = await downloadVerifiedItem(env, userId, itemId, config.maxFileBytes);
    text = await convertBufferToText(env, current.item, buffer);
    if (cacheEnabled) {
      await env.OAUTH_KV.put(key, text.slice(0, 10_000_000), { expirationTtl: config.cacheTtlSeconds });
    }
  }
  const safeStart = Math.min(Math.max(0, startChar), text.length);
  const slice = text.slice(safeStart, safeStart + maxChars);
  return {
    ...compactVerifiedItem(verified),
    startChar: safeStart,
    returnedChars: slice.length,
    totalChars: text.length,
    hasMore: safeStart + slice.length < text.length,
    content: slice,
  };
}

type VisualCursor = { queue: string[]; currentFolderId?: string; nextUrl?: string };

export async function listVisualAssets(
  env: Env,
  userId: string,
  input: {
    path?: string;
    recursive?: boolean;
    query?: string;
    fileTypes?: string[];
    orientation?: "landscape" | "portrait" | "square" | "any";
    minWidth?: number;
    minHeight?: number;
    modifiedAfter?: string;
    limit: number;
    cursor?: string;
  },
) {
  const start = await resolveRelativeFolder(env, userId, input.path ?? "");
  const state = decodeCursor<VisualCursor>(input.cursor) ?? { queue: [start.item.id] };
  const results: VisualAsset[] = [];
  const allowedTypes = input.fileTypes?.length
    ? new Set(input.fileTypes.map((value) => value.startsWith(".") ? value.toLocaleLowerCase("en") : `.${value.toLocaleLowerCase("en")}`))
    : null;
  const query = input.query?.trim().toLocaleLowerCase("en") ?? "";
  const modifiedAfter = input.modifiedAfter ? Date.parse(input.modifiedAfter) : null;
  if (modifiedAfter !== null && !Number.isFinite(modifiedAfter)) {
    throw new ConnectorError("invalid_date", "modifiedAfter must be an ISO date.");
  }

  while (results.length < input.limit && (state.currentFolderId || state.queue.length > 0)) {
    if (!state.currentFolderId) state.currentFolderId = state.queue.shift();
    if (!state.currentFolderId) break;
    const folder = await verifyItemInsideRoot(env, userId, state.currentFolderId);
    if (!folder.item.folder) throw new ConnectorError("invalid_cursor", "The pagination cursor does not reference a folder.");
    const page = await listVerifiedChildren(env, userId, folder, 200, state.nextUrl);
    state.nextUrl = page.nextUrl;
    for (const child of page.items) {
      if (child.item.folder) {
        if (input.recursive) state.queue.push(child.item.id);
        continue;
      }
      if (!isVisualAsset(child.item.name)) continue;
      const asset = assetFromVerified(child);
      if (allowedTypes && !allowedTypes.has(asset.extension)) continue;
      if (query && !`${asset.filename} ${asset.relativePath}`.toLocaleLowerCase("en").includes(query)) continue;
      if (input.orientation && input.orientation !== "any" && asset.orientation !== input.orientation) continue;
      if (input.minWidth && (asset.width ?? 0) < input.minWidth) continue;
      if (input.minHeight && (asset.height ?? 0) < input.minHeight) continue;
      if (modifiedAfter !== null && Date.parse(asset.modifiedDate ?? "") <= modifiedAfter) continue;
      results.push(asset);
      if (results.length >= input.limit) break;
    }
    if (!state.nextUrl) state.currentFolderId = undefined;
  }

  const hasMore = Boolean(state.currentFolderId || state.queue.length > 0);
  return {
    results,
    cursor: hasMore ? encodeCursor(state) : null,
  };
}

function blobStream(buffer: ArrayBuffer, mimeType: string): ReadableStream {
  return new Blob([buffer], { type: mimeType }).stream();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new ConnectorError("image_processing_timeout", "Image processing exceeded the configured time limit.")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

async function inspectImage(env: Env, verified: VerifiedItem, buffer: ArrayBuffer) {
  const config = getRuntimeConfig(env);
  const signature = validateFileSignature(verified.item.name, buffer, verified.item.file?.mimeType);
  if (!signature.compatible) throw new ConnectorError("file_signature_mismatch", signature.reason ?? "Image signature mismatch.");
  const extension = extensionOf(verified.item.name);
  if (!VISUAL_INPUT_FORMATS.has(extension)) {
    throw new ConnectorError("conversion_unavailable", "A safe analysis preview is not available for this image format on the current Worker platform.");
  }
  const images = env.IMAGES as any;
  const info = await withTimeout(
    Promise.resolve(images.info(blobStream(buffer, normalizedMimeType(verified.item.name, verified.item.file?.mimeType)))),
    config.imageProcessingTimeoutMs,
  ) as Record<string, unknown>;
  const width = Number(info.width ?? verified.item.image?.width ?? 0);
  const height = Number(info.height ?? verified.item.image?.height ?? 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ConnectorError("malformed_image", "Image dimensions could not be verified.");
  }
  if (width > config.maxImageDimension || height > config.maxImageDimension || width * height > config.maxImagePixels) {
    throw new ConnectorError("image_dimensions_exceeded", "The image exceeds configured decoded-dimension limits.");
  }
  return { info, width, height, signature };
}

export async function getImageMetadata(env: Env, userId: string, itemId: string): Promise<ImageMetadata> {
  const config = getRuntimeConfig(env);
  const { verified, buffer } = await downloadVerifiedItem(env, userId, itemId, config.maxImageInputBytes);
  if (!isVisualAsset(verified.item.name)) throw new ConnectorError("not_visual_asset", "The item is not a supported visual asset.");
  const extension = extensionOf(verified.item.name);
  let width = verified.item.image?.width ?? null;
  let height = verified.item.image?.height ?? null;
  let animated: boolean | null = extension === ".gif" || extension === ".webp" ? null : false;
  let conversionAvailable = isDirectImage(verified.item.name) || IMAGES_BINDING_CONVERTIBLE.has(extension);
  if (conversionAvailable) {
    const inspected = await inspectImage(env, verified, buffer);
    width = inspected.width;
    height = inspected.height;
    animated = Boolean((inspected.info as Record<string, unknown>).animated ?? animated);
  } else {
    const signature = validateFileSignature(verified.item.name, buffer, verified.item.file?.mimeType);
    if (!signature.compatible) throw new ConnectorError("file_signature_mismatch", signature.reason ?? "File signature mismatch.");
  }
  return {
    ...assetFromVerified(verified),
    width,
    height,
    orientation: orientation(width, height),
    animated,
    pageCount: null,
    exifOrientationCorrectionNeeded: Boolean(verified.item.photo?.orientation && verified.item.photo.orientation !== 1),
    convertedPreviewAvailable: conversionAvailable,
  };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export async function fetchImageForAnalysis(
  env: Env,
  userId: string,
  itemId: string,
  detail: "auto" | "low" | "high",
  maxDimension?: number,
) {
  const config = getRuntimeConfig(env);
  const { verified, buffer } = await downloadVerifiedItem(env, userId, itemId, config.maxImageInputBytes);
  const extension = extensionOf(verified.item.name);
  if (!isVisualAsset(verified.item.name)) throw new ConnectorError("not_visual_asset", "The item is not a supported visual asset.");
  if (!VISUAL_INPUT_FORMATS.has(extension)) {
    throw new ConnectorError("conversion_unavailable", "A safe analysis preview is not available for this format. Fetch the unchanged original file instead.");
  }
  const inspected = await inspectImage(env, verified, buffer);
  const detailLimit = detail === "low" ? 768 : detail === "high" ? 3000 : 1600;
  const target = Math.min(maxDimension ?? detailLimit, detailLimit, config.maxImageDimension);
  const images = env.IMAGES as any;
  const input = images.input(blobStream(buffer, normalizedMimeType(verified.item.name, verified.item.file?.mimeType)));
  const transformed = Math.max(inspected.width, inspected.height) > target
    ? input.transform({ width: target, height: target, fit: "scale-down" })
    : input;
  const response = await withTimeout(
    Promise.resolve(transformed.output({ format: "image/png", anim: false }).response()),
    config.imageProcessingTimeoutMs,
  ) as Response;
  const preview = await response.arrayBuffer();
  const previewSignature = validateFileSignature("preview.png", preview, "image/png");
  if (!previewSignature.compatible) throw new ConnectorError("preview_invalid", "The generated analysis preview is invalid.");
  return {
    metadata: {
      ...assetFromVerified(verified),
      sourceWidth: inspected.width,
      sourceHeight: inspected.height,
      previewMimeType: "image/png",
      converted: extension !== ".png" || Boolean(verified.item.photo?.orientation && verified.item.photo.orientation !== 1),
      animationPolicy: extension === ".gif" || extension === ".webp" ? "first-frame" : "not-animated",
    },
    image: {
      type: "image" as const,
      data: toBase64(preview),
      mimeType: "image/png",
      annotations: { audience: ["assistant", "user"] as Array<"assistant" | "user">, priority: 1 },
    },
  };
}

function originalResourceUri(itemId: string, eTag: string | null): string {
  const params = new URLSearchParams();
  if (eTag) params.set("etag", eTag);
  return `onedrive-original://${encodeURIComponent(itemId)}?${params.toString()}`;
}

export async function fetchOriginalFile(env: Env, userId: string, itemId: string) {
  const config = getRuntimeConfig(env);
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "Folders cannot be fetched as original files.");
  if (!isAllowedOriginalFile(verified.item.name)) throw new ConnectorError("unsupported_original_type", "This file type is not allowlisted for original retrieval.");
  if ((verified.item.size ?? 0) > config.maxOriginalFileBytes) throw new ConnectorError("file_too_large", "The original file exceeds the configured size limit.");
  return {
    metadata: compactVerifiedItem(verified),
    resource: {
      type: "resource_link" as const,
      uri: originalResourceUri(verified.item.id, verified.item.eTag ?? null),
      name: verified.item.name,
      title: verified.item.name,
      description: "Exact original OneDrive file bytes, fetched through the authenticated MCP resource handler.",
      mimeType: normalizedMimeType(verified.item.name, verified.item.file?.mimeType),
      size: verified.item.size,
      annotations: { audience: ["assistant", "user"] as Array<"assistant" | "user">, priority: 1 },
    },
  };
}

export async function readOriginalResource(env: Env, userId: string, uri: URL) {
  if (uri.protocol !== "onedrive-original:") throw new ConnectorError("invalid_resource", "The resource URI is invalid.");
  const itemId = decodeURIComponent(uri.hostname || uri.pathname.replace(/^\//, ""));
  const expectedEtag = uri.searchParams.get("etag");
  const config = getRuntimeConfig(env);
  const { verified, buffer } = await downloadVerifiedItem(env, userId, itemId, config.maxOriginalFileBytes);
  if (!isAllowedOriginalFile(verified.item.name)) throw new ConnectorError("unsupported_original_type", "This file type is not allowlisted for original retrieval.");
  if (expectedEtag && verified.item.eTag !== expectedEtag) throw new ConnectorError("etag_conflict", "The original file changed after the resource link was created. Fetch it again.");
  const signature = validateFileSignature(verified.item.name, buffer, verified.item.file?.mimeType);
  if (!signature.compatible) throw new ConnectorError("file_signature_mismatch", signature.reason ?? "File signature mismatch.");
  return {
    uri: uri.href,
    mimeType: normalizedMimeType(verified.item.name, verified.item.file?.mimeType),
    blob: toBase64(buffer),
  };
}

export async function createFolder(env: Env, userId: string, destinationPath: string, name: string) {
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  const safeName = validateItemName(name);
  // Revalidate immediately before mutation.
  const currentDestination = await verifyItemInsideRoot(env, userId, destination.item.id);
  const created = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(currentDestination.item.id)}/children`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: safeName, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, created.id));
}

export async function createTextFile(
  env: Env,
  userId: string,
  destinationPath: string,
  filename: string,
  content: string,
) {
  const config = getRuntimeConfig(env);
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  const safeName = validateItemName(filename);
  if (!isAllowedTextFile(safeName)) throw new ConnectorError("unsupported_text_extension", "The filename extension is not allowlisted for text creation.");
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > config.maxTextWriteBytes) throw new ConnectorError("text_too_large", "The text content exceeds the configured write limit.");
  const currentDestination = await verifyItemInsideRoot(env, userId, destination.item.id);
  const created = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(currentDestination.item.id)}:/${encodeURIComponent(safeName)}:/content`,
    {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", "If-None-Match": "*" },
      body: bytes,
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, created.id));
}

export async function replaceTextFile(
  env: Env,
  userId: string,
  itemId: string,
  expectedETag: string,
  content: string,
) {
  const config = getRuntimeConfig(env);
  if (!expectedETag) throw new ConnectorError("etag_required", "expectedETag is required for replacement.");
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder || !isAllowedTextFile(verified.item.name)) throw new ConnectorError("not_text_file", "Only allowlisted text files can be replaced.");
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > config.maxTextWriteBytes) throw new ConnectorError("text_too_large", "The text content exceeds the configured write limit.");
  const current = await verifyItemInsideRoot(env, userId, itemId);
  if (current.item.eTag !== expectedETag) throw new ConnectorError("etag_conflict", "The item changed since it was read. Fetch the current eTag and retry.");
  const replaced = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(current.item.id)}/content`,
    {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", "If-Match": expectedETag },
      body: bytes,
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, replaced.id));
}

export async function renameItem(env: Env, userId: string, itemId: string, newName: string) {
  const safeName = validateItemName(newName);
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  const current = await verifyItemInsideRoot(env, userId, verified.item.id);
  const renamed = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(current.item.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: safeName, "@microsoft.graph.conflictBehavior": "fail" }),
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, renamed.id));
}

export async function moveItem(env: Env, userId: string, itemId: string, destinationPath: string) {
  const source = await verifyItemInsideRoot(env, userId, itemId);
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  const currentSource = await verifyItemInsideRoot(env, userId, source.item.id);
  const currentDestination = await verifyItemInsideRoot(env, userId, destination.item.id);
  if (currentSource.driveId !== currentDestination.driveId) throw new ConnectorError("cross_drive", "Cross-drive moves are not allowed.");
  if (currentSource.item.folder && currentDestination.ancestorIds.includes(currentSource.item.id)) {
    throw new ConnectorError("circular_move", "A folder cannot be moved into itself or one of its descendants.");
  }
  const moved = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(currentSource.item.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentReference: { id: currentDestination.item.id },
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, moved.id));
}

export async function readiness(env: Env, userId: string) {
  const root = await resolveConfiguredRoot(env, userId);
  await verifyItemInsideRoot(env, userId, root.id);
  return { ready: true, graphReachable: true, rootResolved: true };
}
