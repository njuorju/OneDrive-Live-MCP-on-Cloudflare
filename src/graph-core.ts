import { authStateGetToken, authStatePutToken } from "./auth-state-client";
import { getRuntimeConfig } from "./config";
import { ConnectorError, logSafeError } from "./errors";
import { extensionOf, normalizedMimeType } from "./file-types";
import { encodeGraphPath, openJson, sealJson, sha256Hex } from "./security";
import type { CompactItem, GraphCollection, GraphDriveItem, MicrosoftProfile, TokenRecord } from "./types";

export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
export const TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
export const REQUIRED_GRAPH_SCOPE = "Files.ReadWrite";
export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Files.ReadWrite",
  "https://graph.microsoft.com/User.Read",
].join(" ");

const ITEM_SELECT = [
  "id",
  "name",
  "size",
  "file",
  "folder",
  "package",
  "image",
  "photo",
  "parentReference",
  "lastModifiedDateTime",
  "eTag",
  "cTag",
  "remoteItem",
  "deleted",
].join(",");

function normalizedScopes(scope: string): Set<string> {
  return new Set(
    scope
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLocaleLowerCase("en")),
  );
}

export function hasRequiredGraphScope(scope: string): boolean {
  return normalizedScopes(scope).has(REQUIRED_GRAPH_SCOPE.toLocaleLowerCase("en"));
}

function assertRequiredGraphScope(scope: string): void {
  if (!hasRequiredGraphScope(scope)) {
    throw new ConnectorError(
      "fresh_consent_required",
      "Microsoft authorization does not include Files.ReadWrite. Disconnect and reconnect the ChatGPT app to grant fresh consent.",
    );
  }
}

function safeExpiry(raw: unknown): number {
  const value = Number(raw ?? 3600);
  if (!Number.isFinite(value) || value < 60 || value > 86_400) return 3600;
  return value;
}

export async function storeTokenRecord(
  env: Env,
  userId: string,
  tokenBody: Record<string, unknown>,
): Promise<void> {
  const accessToken = String(tokenBody.access_token ?? "");
  const refreshToken = String(tokenBody.refresh_token ?? "");
  const scope = String(tokenBody.scope ?? "");
  if (!accessToken || !refreshToken) {
    throw new ConnectorError("oauth_token_missing", "Microsoft did not return a complete authorization.");
  }
  assertRequiredGraphScope(scope);
  const record: TokenRecord = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.max(60, safeExpiry(tokenBody.expires_in) - 30) * 1000,
    scope,
  };
  const sealed = await sealJson(env.COOKIE_ENCRYPTION_KEY, record);
  const result = await authStatePutToken(env, userId, sealed);
  if (!result.ok) {
    throw new ConnectorError("oauth_storage_failed", "Unable to store Microsoft authorization.", { retryable: true });
  }
}

export async function getStoredTokenRecord(env: Env, userId: string): Promise<TokenRecord> {
  const stored = await authStateGetToken(env, userId);
  if (!stored.ok || !stored.value) {
    throw new ConnectorError(
      "authentication_required",
      "Microsoft authorization is missing. Reconnect the ChatGPT app.",
    );
  }
  let record: TokenRecord;
  try {
    record = await openJson<TokenRecord>(env.COOKIE_ENCRYPTION_KEY, stored.value);
  } catch {
    throw new ConnectorError(
      "authentication_invalid",
      "Stored Microsoft authorization is invalid. Reconnect the ChatGPT app.",
    );
  }
  assertRequiredGraphScope(record.scope);
  return record;
}

export async function getGraphAccessToken(env: Env, userId: string): Promise<string> {
  const record = await getStoredTokenRecord(env, userId);
  if (record.expiresAt > Date.now() + 120_000) return record.accessToken;

  const correlationId = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.MICROSOFT_CLIENT_ID,
        client_secret: env.MICROSOFT_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: record.refreshToken,
        scope: MICROSOFT_SCOPES,
      }),
    });
  } catch {
    throw new ConnectorError("oauth_refresh_unreachable", "Microsoft token refresh is temporarily unavailable.", {
      retryable: true,
      correlationId,
    });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Never expose the upstream body.
  }
  if (!response.ok || !body.access_token) {
    const error = new ConnectorError(
      response.status === 400 || response.status === 401 ? "fresh_consent_required" : "oauth_refresh_failed",
      response.status === 400 || response.status === 401
        ? "Microsoft authorization must be refreshed. Disconnect and reconnect the ChatGPT app."
        : "Microsoft token refresh failed.",
      { retryable: response.status >= 500, status: response.status, correlationId },
    );
    logSafeError("microsoft_oauth_refresh_failed", error);
    throw error;
  }

  const scope = String(body.scope ?? record.scope);
  assertRequiredGraphScope(scope);
  const refreshed: TokenRecord = {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token ?? record.refreshToken),
    expiresAt: Date.now() + Math.max(60, safeExpiry(body.expires_in) - 30) * 1000,
    scope,
  };
  const sealed = await sealJson(env.COOKIE_ENCRYPTION_KEY, refreshed);
  const result = await authStatePutToken(env, userId, sealed);
  if (!result.ok) {
    throw new ConnectorError("oauth_storage_failed", "Unable to store refreshed Microsoft authorization.", {
      retryable: true,
    });
  }
  return refreshed.accessToken;
}

function graphUrl(pathOrUrl: string): string {
  if (!pathOrUrl.startsWith("https://")) return `${GRAPH_ROOT}${pathOrUrl}`;
  const url = new URL(pathOrUrl);
  if (url.protocol !== "https:" || url.hostname.toLocaleLowerCase("en") !== "graph.microsoft.com") {
    throw new ConnectorError("unsafe_graph_url", "The upstream continuation URL is not trusted.");
  }
  if (!url.pathname.startsWith("/v1.0/")) {
    throw new ConnectorError("unsafe_graph_url", "Only Microsoft Graph v1.0 URLs are allowed.");
  }
  return url.href;
}

async function graphResponse(
  env: Env,
  userId: string,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getGraphAccessToken(env, userId);
  const correlationId = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(graphUrl(pathOrUrl), {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "client-request-id": correlationId,
        "return-client-request-id": "true",
      },
    });
  } catch {
    throw new ConnectorError("graph_unreachable", "Microsoft Graph is temporarily unavailable.", {
      retryable: true,
      correlationId,
    });
  }
  if (!response.ok) {
    let graphCode = "";
    try {
      const body = (await response.clone().json()) as { error?: { code?: string } };
      graphCode = String(body.error?.code ?? "");
    } catch {
      // Upstream body is intentionally discarded.
    }
    const code =
      response.status === 401 ? "authentication_required" :
      response.status === 403 ? "graph_forbidden" :
      response.status === 404 ? "item_not_found" :
      response.status === 409 || graphCode === "nameAlreadyExists" ? "name_conflict" :
      response.status === 412 ? "etag_conflict" :
      response.status === 413 ? "file_too_large" :
      response.status === 429 ? "graph_rate_limited" :
      "graph_request_failed";
    const message =
      code === "name_conflict" ? "An item with that name already exists." :
      code === "etag_conflict" ? "The item changed since it was read. Fetch the current eTag and retry." :
      code === "item_not_found" ? "The requested OneDrive item was not found." :
      code === "authentication_required" ? "Microsoft authorization is no longer valid. Reconnect the ChatGPT app." :
      "Microsoft Graph could not complete the request.";
    const error = new ConnectorError(code, message, {
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
      correlationId,
    });
    logSafeError("microsoft_graph_error", error, { graphCode: graphCode || null });
    throw error;
  }
  return response;
}

export async function graphFetch<T>(
  env: Env,
  userId: string,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await graphResponse(env, userId, pathOrUrl, init);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ConnectorError("graph_invalid_response", "Microsoft Graph returned an invalid response.", {
      retryable: true,
    });
  }
}

export async function graphFetchBytes(
  env: Env,
  userId: string,
  pathOrUrl: string,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const response = await graphResponse(env, userId, pathOrUrl, { redirect: "follow" });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ConnectorError("file_too_large", "The file exceeds the configured size limit.");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ConnectorError("file_too_large", "The file exceeds the configured size limit.");
  }
  return buffer;
}

export async function graphProfileWithToken(accessToken: string): Promise<MicrosoftProfile> {
  const correlationId = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(`${GRAPH_ROOT}/me?$select=id,displayName,mail,userPrincipalName`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "client-request-id": correlationId,
        "return-client-request-id": "true",
      },
    });
  } catch {
    throw new ConnectorError("graph_unreachable", "Microsoft Graph is temporarily unavailable.", {
      retryable: true,
      correlationId,
    });
  }
  if (!response.ok) {
    throw new ConnectorError("profile_read_failed", "Unable to verify the Microsoft account.", {
      status: response.status,
      correlationId,
    });
  }
  return (await response.json()) as MicrosoftProfile;
}

export function strictRelativePath(path: string): string {
  let decoded = path;
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      throw new ConnectorError("invalid_path", "The relative path contains invalid encoding.");
    }
  }
  if (decoded.includes("\0") || /[\u0000-\u001f]/.test(decoded)) {
    throw new ConnectorError("invalid_path", "The relative path contains invalid characters.");
  }
  const normalized = decoded.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]+:\/\//i.test(normalized) || /^[a-z]:/i.test(normalized)) {
    throw new ConnectorError("invalid_path", "Only paths relative to the configured OneDrive root are allowed.");
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
      throw new ConnectorError("path_traversal", "Path traversal is not allowed.");
    }
    if (trimmed !== segment) {
      throw new ConnectorError("ambiguous_path", "Path segments may not have leading or trailing whitespace.");
    }
  }
  return segments.join("/");
}

export function validateItemName(name: string): string {
  const value = name.trim();
  if (!value || value !== name || value === "." || value === "..") {
    throw new ConnectorError("invalid_name", "The item name is empty or ambiguous.");
  }
  if (/[\\/:*?"<>|]/.test(value) || /[\u0000-\u001f]/.test(value)) {
    throw new ConnectorError("invalid_name", "The item name contains a reserved character.");
  }
  if (/[. ]$/.test(value)) {
    throw new ConnectorError("invalid_name", "The item name may not end with a period or space.");
  }
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (reserved.test(value)) {
    throw new ConnectorError("invalid_name", "The item name is reserved.");
  }
  if (new TextEncoder().encode(value).byteLength > 255) {
    throw new ConnectorError("invalid_name", "The item name is too long.");
  }
  return value;
}

export type VerifiedItem = {
  item: GraphDriveItem;
  root: GraphDriveItem;
  relativePath: string;
  ancestorIds: string[];
  driveId: string;
};

export async function resolveConfiguredRoot(env: Env, userId: string): Promise<GraphDriveItem> {
  const rootPath = strictRelativePath(env.ONEDRIVE_ROOT);
  if (!rootPath) throw new ConnectorError("root_not_configured", "The OneDrive root is not configured.");
  const item = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/root:/${encodeGraphPath(rootPath)}?$select=${ITEM_SELECT}`,
  );
  if (!item.folder || item.remoteItem || item.deleted || !item.parentReference?.driveId) {
    throw new ConnectorError("root_invalid", "The configured OneDrive root could not be verified.");
  }
  return item;
}

async function getItemById(env: Env, userId: string, itemId: string): Promise<GraphDriveItem> {
  if (!itemId || itemId.length > 500 || /[\u0000-\u001f]/.test(itemId)) {
    throw new ConnectorError("invalid_item_id", "The OneDrive item ID is invalid.");
  }
  return graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(itemId)}?$select=${ITEM_SELECT}`,
  );
}

export async function verifyItemInsideRoot(env: Env, userId: string, itemId: string): Promise<VerifiedItem> {
  const root = await resolveConfiguredRoot(env, userId);
  const rootDriveId = root.parentReference?.driveId;
  if (!rootDriveId) throw new ConnectorError("root_invalid", "The configured OneDrive root could not be verified.");

  let item = await getItemById(env, userId, itemId);
  if (item.remoteItem || item.deleted || !item.parentReference?.driveId) {
    throw new ConnectorError("outside_root", "Shared, remote, deleted, or ambiguous items are not allowed.");
  }
  if (item.parentReference.driveId !== rootDriveId) {
    throw new ConnectorError("cross_drive", "Cross-drive items are outside the configured OneDrive root.");
  }

  const original = item;
  const names: string[] = [];
  const ancestorIds: string[] = [item.id];
  const visited = new Set<string>();
  for (let depth = 0; depth < 256; depth += 1) {
    if (visited.has(item.id)) throw new ConnectorError("ancestry_cycle", "OneDrive ancestry could not be proven.");
    visited.add(item.id);
    if (item.id === root.id) {
      const relativePath = names.reverse().join("/");
      return { item: original, root, relativePath, ancestorIds, driveId: rootDriveId };
    }
    names.push(item.name);
    const parentId = item.parentReference?.id;
    if (!parentId) throw new ConnectorError("outside_root", "The item is outside the configured OneDrive root.");
    item = await getItemById(env, userId, parentId);
    if (item.remoteItem || item.deleted || item.parentReference?.driveId !== rootDriveId) {
      throw new ConnectorError("outside_root", "The item ancestry leaves the configured OneDrive root.");
    }
    ancestorIds.push(item.id);
  }
  throw new ConnectorError("ancestry_unproven", "OneDrive ancestry could not be proven within the safety limit.");
}

export async function resolveRelativeItem(env: Env, userId: string, relativePath: string): Promise<VerifiedItem> {
  const clean = strictRelativePath(relativePath);
  const root = await resolveConfiguredRoot(env, userId);
  if (!clean) return verifyItemInsideRoot(env, userId, root.id);
  const rootPath = strictRelativePath(env.ONEDRIVE_ROOT);
  const item = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/root:/${encodeGraphPath(`${rootPath}/${clean}`)}?$select=${ITEM_SELECT}`,
  );
  return verifyItemInsideRoot(env, userId, item.id);
}

export async function resolveRelativeFolder(env: Env, userId: string, relativePath: string): Promise<VerifiedItem> {
  const verified = await resolveRelativeItem(env, userId, relativePath);
  if (!verified.item.folder) throw new ConnectorError("not_a_folder", "The destination is not a folder.");
  return verified;
}

export function compactVerifiedItem(verified: VerifiedItem): CompactItem {
  const item = verified.item;
  return {
    itemId: item.id,
    filename: item.name,
    relativePath: verified.relativePath,
    type: item.folder ? "folder" : "file",
    mimeType: item.folder ? null : normalizedMimeType(item.name, item.file?.mimeType),
    extension: extensionOf(item.name),
    byteSize: item.size ?? null,
    modifiedDate: item.lastModifiedDateTime ?? null,
    eTag: item.eTag ?? null,
  };
}

export function verifiedChildFromListedItem(folder: VerifiedItem, child: GraphDriveItem): VerifiedItem {
  if (!child.id || !child.name || child.remoteItem || child.deleted) {
    throw new ConnectorError("outside_root", "Shared, remote, deleted, or ambiguous child items are not allowed.");
  }
  const parentDriveId = child.parentReference?.driveId;
  const parentId = child.parentReference?.id;
  if (!parentDriveId || !parentId || parentDriveId !== folder.driveId || parentId !== folder.item.id) {
    throw new ConnectorError("outside_root", "The listed child does not belong to the verified parent folder.");
  }
  return {
    item: child,
    root: folder.root,
    relativePath: folder.relativePath ? `${folder.relativePath}/${child.name}` : child.name,
    ancestorIds: [child.id, ...folder.ancestorIds],
    driveId: folder.driveId,
  };
}

export async function listVerifiedChildren(
  env: Env,
  userId: string,
  folder: VerifiedItem,
  top = 200,
  nextUrl?: string,
): Promise<{ items: VerifiedItem[]; nextUrl?: string }> {
  const result = await graphFetch<GraphCollection<GraphDriveItem>>(
    env,
    userId,
    nextUrl ?? `/me/drive/items/${encodeURIComponent(folder.item.id)}/children?$select=${ITEM_SELECT}&$top=${Math.min(top, 200)}`,
  );
  const items: VerifiedItem[] = [];
  for (const child of result.value) {
    try {
      items.push(verifiedChildFromListedItem(folder, child));
    } catch (error) {
      logSafeError("root_boundary_rejected_child", error);
    }
  }
  return { items, nextUrl: result["@odata.nextLink"] };
}

export async function downloadVerifiedItem(
  env: Env,
  userId: string,
  itemId: string,
  maxBytes?: number,
): Promise<{ verified: VerifiedItem; buffer: ArrayBuffer }> {
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder) throw new ConnectorError("folder_not_file", "The requested item is a folder, not a file.");
  const limit = maxBytes ?? getRuntimeConfig(env).maxFileBytes;
  if ((verified.item.size ?? 0) > limit) {
    throw new ConnectorError("file_too_large", "The file exceeds the configured size limit.");
  }
  // Revalidate immediately before retrieval.
  const current = await verifyItemInsideRoot(env, userId, itemId);
  const buffer = await graphFetchBytes(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(current.item.id)}/content`,
    limit,
  );
  return { verified: current, buffer };
}

export async function safeCacheKey(itemId: string, eTag: string): Promise<string> {
  return `doc-cache:v2:${await sha256Hex(`${itemId}:${eTag}`)}`;
}
