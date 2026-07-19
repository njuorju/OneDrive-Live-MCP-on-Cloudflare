import { getRuntimeConfig } from "./config";
import { ConnectorError } from "./errors";
import {
  DIRECT_IMAGE_EXTENSIONS,
  extensionOf,
  isAllowedOriginalFile,
  isConvertibleImage,
  isVisualAsset,
} from "./file-types";
import {
  compactVerifiedItem,
  listVerifiedChildren,
  resolveRelativeFolder,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import {
  fetchImageForAnalysis as fetchImageForAnalysisBase,
  getImageMetadata,
} from "./onedrive-files";
import { openJson, sealJson, sha256Hex } from "./security";
import type { VisualAsset } from "./types";

export type VisualAssetInput = {
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
};

type VisualCursor = {
  version: 2;
  fingerprint: string;
  queue: string[];
  pendingItemIds: string[];
  currentFolderId?: string;
  nextUrl?: string;
};

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

function normalizedFilter(input: VisualAssetInput): Record<string, unknown> {
  return {
    path: input.path ?? "",
    recursive: input.recursive ?? false,
    query: input.query?.trim().toLocaleLowerCase("en") ?? "",
    fileTypes: [...(input.fileTypes ?? [])].map((value) => value.toLocaleLowerCase("en")).sort(),
    orientation: input.orientation ?? "any",
    minWidth: input.minWidth ?? null,
    minHeight: input.minHeight ?? null,
    modifiedAfter: input.modifiedAfter ?? null,
  };
}

async function cursorFingerprint(input: VisualAssetInput): Promise<string> {
  return sha256Hex(JSON.stringify(normalizedFilter(input)));
}

function validOpaqueIds(values: unknown, maximum: number): values is string[] {
  return Array.isArray(values) &&
    values.length <= maximum &&
    values.every((value) => typeof value === "string" && value.length > 0 && value.length <= 500);
}

async function decodeCursor(env: Env, input: VisualAssetInput): Promise<VisualCursor | undefined> {
  if (!input.cursor) return undefined;
  let state: VisualCursor;
  try {
    state = await openJson<VisualCursor>(env.COOKIE_ENCRYPTION_KEY, input.cursor);
  } catch {
    throw new ConnectorError("invalid_cursor", "The pagination cursor is invalid or expired.");
  }
  if (
    state.version !== 2 ||
    !validOpaqueIds(state.queue, 512) ||
    !validOpaqueIds(state.pendingItemIds, 200) ||
    (state.currentFolderId !== undefined &&
      (typeof state.currentFolderId !== "string" || state.currentFolderId.length > 500)) ||
    (state.nextUrl !== undefined &&
      (typeof state.nextUrl !== "string" || state.nextUrl.length > 4000))
  ) {
    throw new ConnectorError("invalid_cursor", "The pagination cursor is invalid.");
  }
  if (state.fingerprint !== await cursorFingerprint(input)) {
    throw new ConnectorError(
      "cursor_filter_mismatch",
      "The pagination cursor belongs to different visual-asset filters.",
    );
  }
  return state;
}

async function encodeCursor(env: Env, state: VisualCursor): Promise<string> {
  const sealed = await sealJson(env.COOKIE_ENCRYPTION_KEY, state);
  if (sealed.length > 12_000) {
    throw new ConnectorError(
      "visual_tree_too_wide",
      "The visual folder tree is too wide for a bounded pagination cursor. Narrow the path or query.",
    );
  }
  return sealed;
}

function matchesAsset(
  asset: VisualAsset,
  input: VisualAssetInput,
  allowedTypes: Set<string> | null,
  query: string,
  modifiedAfter: number | null,
): boolean {
  if (allowedTypes && !allowedTypes.has(asset.extension)) return false;
  if (
    query &&
    !`${asset.filename} ${asset.relativePath}`.toLocaleLowerCase("en").includes(query)
  ) return false;
  if (
    input.orientation &&
    input.orientation !== "any" &&
    asset.orientation !== input.orientation
  ) return false;
  if (input.minWidth && (asset.width ?? 0) < input.minWidth) return false;
  if (input.minHeight && (asset.height ?? 0) < input.minHeight) return false;
  if (modifiedAfter !== null && Date.parse(asset.modifiedDate ?? "") <= modifiedAfter) return false;
  return true;
}

export async function listVisualAssetsSecure(
  env: Env,
  userId: string,
  input: VisualAssetInput,
) {
  const start = await resolveRelativeFolder(env, userId, input.path ?? "");
  const fingerprint = await cursorFingerprint(input);
  const state: VisualCursor = await decodeCursor(env, input) ?? {
    version: 2,
    fingerprint,
    queue: [start.item.id],
    pendingItemIds: [],
  };
  const results: VisualAsset[] = [];
  const allowedTypes = input.fileTypes?.length
    ? new Set(
        input.fileTypes.map((value) =>
          value.startsWith(".")
            ? value.toLocaleLowerCase("en")
            : `.${value.toLocaleLowerCase("en")}`,
        ),
      )
    : null;
  const query = input.query?.trim().toLocaleLowerCase("en") ?? "";
  const modifiedAfter = input.modifiedAfter ? Date.parse(input.modifiedAfter) : null;
  if (modifiedAfter !== null && !Number.isFinite(modifiedAfter)) {
    throw new ConnectorError("invalid_date", "modifiedAfter must be an ISO date.");
  }

  while (
    results.length < input.limit &&
    (state.pendingItemIds.length > 0 || state.currentFolderId || state.queue.length > 0)
  ) {
    if (state.pendingItemIds.length > 0) {
      const itemId = state.pendingItemIds.shift();
      if (!itemId) continue;
      const child = await verifyItemInsideRoot(env, userId, itemId);
      if (child.item.folder || !isVisualAsset(child.item.name)) continue;
      const asset = assetFromVerified(child);
      if (matchesAsset(asset, input, allowedTypes, query, modifiedAfter)) results.push(asset);
      continue;
    }

    if (!state.currentFolderId) state.currentFolderId = state.queue.shift();
    if (!state.currentFolderId) break;
    const folder = await verifyItemInsideRoot(env, userId, state.currentFolderId);
    if (!folder.item.folder) {
      throw new ConnectorError("invalid_cursor", "The pagination cursor does not reference a folder.");
    }
    const page = await listVerifiedChildren(env, userId, folder, 200, state.nextUrl);
    state.nextUrl = page.nextUrl;
    for (const child of page.items) {
      if (child.item.folder) {
        if (input.recursive) {
          if (state.queue.length >= 512) {
            throw new ConnectorError(
              "visual_tree_too_wide",
              "The visual folder tree is too wide. Narrow the starting path.",
            );
          }
          state.queue.push(child.item.id);
        }
      } else if (isVisualAsset(child.item.name)) {
        state.pendingItemIds.push(child.item.id);
      }
    }
    if (!state.nextUrl) state.currentFolderId = undefined;
  }

  const hasMore = Boolean(
    state.pendingItemIds.length > 0 ||
    state.currentFolderId ||
    state.queue.length > 0,
  );
  return {
    results,
    cursor: hasMore ? await encodeCursor(env, state) : null,
  };
}

export { getImageMetadata };

export async function fetchImageForAnalysisSecure(
  env: Env,
  userId: string,
  itemId: string,
  detail: "auto" | "low" | "high",
  maxDimension?: number,
) {
  const result = await fetchImageForAnalysisBase(env, userId, itemId, detail, maxDimension);
  const config = getRuntimeConfig(env);
  const estimatedBytes = Math.floor((result.image.data.length * 3) / 4);
  const outputLimit = Math.min(config.maxImageInputBytes, 10 * 1024 * 1024);
  if (estimatedBytes > outputLimit) {
    throw new ConnectorError(
      "image_preview_too_large",
      "The generated analysis preview exceeds the configured output-size limit.",
    );
  }
  return result;
}
