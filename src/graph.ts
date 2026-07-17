import { authStateGetToken, authStatePutToken } from "./auth-state-client";
import { extractPptxText } from "./pptx";
import {
  encodeGraphPath,
  isPathInsideRoot,
  normalizeRelativePath,
  openJson,
  sealJson,
  sha256Hex,
} from "./security";
import type {
  GraphCollection,
  GraphDriveItem,
  MicrosoftProfile,
  TokenRecord,
} from "./types";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Files.Read",
  "https://graph.microsoft.com/User.Read",
].join(" ");

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".log",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".sql",
  ".ps1",
  ".bat",
  ".cmd",
  ".sh",
  ".r",
]);

const MARKDOWN_CONVERSION_EXTENSIONS = new Set([
  ".pdf",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ".svg",
  ".gif",
  ".bmp",
  ".html",
  ".htm",
  ".xml",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".xls",
  ".et",
  ".docx",
  ".ods",
  ".odt",
  ".csv",
  ".numbers",
]);

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLocaleLowerCase("en") : "";
}

export async function storeTokenRecord(
  env: Env,
  userId: string,
  tokenBody: Record<string, unknown>,
): Promise<void> {
  const accessToken = String(tokenBody.access_token ?? "");
  const refreshToken = String(tokenBody.refresh_token ?? "");
  const expiresIn = Number(tokenBody.expires_in ?? 3600);
  if (!accessToken || !refreshToken) {
    throw new Error("Microsoft did not return both access and refresh tokens.");
  }
  const record: TokenRecord = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.max(60, expiresIn - 30) * 1000,
    scope: String(tokenBody.scope ?? MICROSOFT_SCOPES),
  };
  const sealed = await sealJson(env.COOKIE_ENCRYPTION_KEY, record);
  const result = await authStatePutToken(env, userId, sealed);
  if (!result.ok) {
    throw new Error("Unable to store Microsoft authorization.");
  }
}

export async function getGraphAccessToken(env: Env, userId: string): Promise<string> {
  const stored = await authStateGetToken(env, userId);
  if (!stored.ok || !stored.value) {
    throw new Error("Microsoft authorization is missing. Reconnect the ChatGPT plugin.");
  }
  const record = await openJson<TokenRecord>(env.COOKIE_ENCRYPTION_KEY, stored.value);
  if (record.expiresAt > Date.now() + 120_000) {
    return record.accessToken;
  }

  const response = await fetch(TOKEN_ENDPOINT, {
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
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Microsoft token refresh failed: ${String(body.error_description ?? body.error ?? response.status)}`);
  }

  const refreshed: TokenRecord = {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token ?? record.refreshToken),
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in ?? 3600) - 30) * 1000,
    scope: String(body.scope ?? record.scope),
  };
  const sealed = await sealJson(env.COOKIE_ENCRYPTION_KEY, refreshed);
  const result = await authStatePutToken(env, userId, sealed);
  if (!result.ok) {
    throw new Error("Unable to store refreshed Microsoft authorization.");
  }
  return refreshed.accessToken;
}

export async function graphFetch<T>(
  env: Env,
  userId: string,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getGraphAccessToken(env, userId);
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_ROOT}${pathOrUrl}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Microsoft Graph ${response.status}: ${text.slice(0, 1000)}`);
  }
  return (await response.json()) as T;
}

export async function graphProfileWithToken(accessToken: string): Promise<MicrosoftProfile> {
  const response = await fetch(`${GRAPH_ROOT}/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Unable to read Microsoft profile: ${response.status}`);
  }
  return (await response.json()) as MicrosoftProfile;
}

export function fullItemPath(item: GraphDriveItem): string {
  const base = item.parentReference?.path ?? item.remoteItem?.parentReference?.path ?? "";
  return `${base}/${item.name}`.replace(/\/+/g, "/");
}

export function assertItemInsideAllowedRoot(item: GraphDriveItem, rootName: string): void {
  const path = fullItemPath(item);
  if (!isPathInsideRoot(path, rootName)) {
    throw new Error(`The requested item is outside the allowed OneDrive root '${rootName}'.`);
  }
}

function compactItem(item: GraphDriveItem) {
  return {
    id: item.id,
    name: item.name,
    path: fullItemPath(item).replace(/^\/drive\/root:\//, ""),
    type: item.folder ? "folder" : "file",
    mimeType: item.file?.mimeType ?? null,
    size: item.size ?? null,
    lastModifiedDateTime: item.lastModifiedDateTime ?? null,
    webUrl: item.webUrl ?? null,
  };
}

function escapeSearchQuery(query: string): string {
  return encodeURIComponent(query.replace(/'/g, "''"));
}

export async function searchAllowedRoot(
  env: Env,
  userId: string,
  query: string,
  limit: number,
): Promise<ReturnType<typeof compactItem>[]> {
  const selected = [
    "id",
    "name",
    "webUrl",
    "size",
    "file",
    "folder",
    "parentReference",
    "lastModifiedDateTime",
    "eTag",
  ].join(",");
  let nextUrl: string | undefined = `/me/drive/root/search(q='${escapeSearchQuery(query)}')?$select=${selected}&$top=100`;
  const matches: ReturnType<typeof compactItem>[] = [];
  let pages = 0;

  while (nextUrl && matches.length < limit && pages < 8) {
    const result: GraphCollection<GraphDriveItem> = await graphFetch(env, userId, nextUrl);
    for (const item of result.value) {
      if (isPathInsideRoot(fullItemPath(item), env.ONEDRIVE_ROOT)) {
        matches.push(compactItem(item));
        if (matches.length >= limit) break;
      }
    }
    nextUrl = result["@odata.nextLink"];
    pages += 1;
  }
  return matches;
}

export async function listAllowedFolder(
  env: Env,
  userId: string,
  relativePath: string,
  limit: number,
): Promise<ReturnType<typeof compactItem>[]> {
  const cleanRelative = normalizeRelativePath(relativePath);
  const combined = [env.ONEDRIVE_ROOT, cleanRelative].filter(Boolean).join("/");
  const encoded = encodeGraphPath(combined);
  const selected = [
    "id",
    "name",
    "webUrl",
    "size",
    "file",
    "folder",
    "parentReference",
    "lastModifiedDateTime",
    "eTag",
  ].join(",");
  const result = await graphFetch<GraphCollection<GraphDriveItem>>(
    env,
    userId,
    `/me/drive/root:/${encoded}:/children?$select=${selected}&$top=${Math.min(limit, 200)}`,
  );
  return result.value.filter((item) => isPathInsideRoot(fullItemPath(item), env.ONEDRIVE_ROOT)).map(compactItem);
}

export async function getAllowedItem(
  env: Env,
  userId: string,
  itemId: string,
): Promise<GraphDriveItem> {
  const selected = [
    "id",
    "name",
    "webUrl",
    "size",
    "file",
    "folder",
    "parentReference",
    "lastModifiedDateTime",
    "eTag",
  ].join(",");
  const item = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(itemId)}?$select=${selected}`,
  );
  assertItemInsideAllowedRoot(item, env.ONEDRIVE_ROOT);
  return item;
}

async function downloadAllowedItem(
  env: Env,
  userId: string,
  item: GraphDriveItem,
): Promise<ArrayBuffer> {
  assertItemInsideAllowedRoot(item, env.ONEDRIVE_ROOT);
  const maxBytes = Math.max(1, Number(env.MAX_FILE_MB || 20)) * 1024 * 1024;
  if ((item.size ?? 0) > maxBytes) {
    throw new Error(`File is larger than the configured ${env.MAX_FILE_MB || 20} MB read limit.`);
  }
  const token = await getGraphAccessToken(env, userId);
  const response = await fetch(
    `${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(item.id)}/content`,
    { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" },
  );
  if (!response.ok) {
    throw new Error(`OneDrive download failed: ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new Error(`Downloaded file exceeds the configured ${env.MAX_FILE_MB || 20} MB read limit.`);
  }
  return response.arrayBuffer();
}

function cacheKey(userId: string, item: GraphDriveItem, etagHash: string): string {
  return `doc-cache:${userId}:${item.id}:${etagHash}`;
}

async function convertBufferToText(env: Env, item: GraphDriveItem, buffer: ArrayBuffer): Promise<string> {
  const extension = extensionOf(item.name);
  if (TEXT_EXTENSIONS.has(extension)) {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
  if (extension === ".pptx") {
    return extractPptxText(buffer);
  }
  if (!MARKDOWN_CONVERSION_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported file type '${extension || "unknown"}'. Supported live reading includes PDF, DOCX, XLS/XLSX, CSV, HTML, XML, ODT/ODS, common images, PPTX, and plain-text/code formats.`,
    );
  }

  const result = (await env.AI.toMarkdown({
    name: item.name,
    blob: new Blob([buffer], { type: item.file?.mimeType ?? "application/octet-stream" }),
  })) as { format?: string; data?: string; error?: string };
  if (result.format === "error" || !result.data) {
    throw new Error(`Cloudflare document conversion failed: ${result.error ?? "no text returned"}`);
  }
  return result.data;
}

export async function readAllowedFile(
  env: Env,
  userId: string,
  itemId: string,
  startChar: number,
  requestedChars: number,
) {
  const item = await getAllowedItem(env, userId, itemId);
  if (item.folder) throw new Error("The requested item is a folder, not a file.");

  const etagHash = await sha256Hex(item.eTag ?? `${item.lastModifiedDateTime}:${item.size}`);
  const key = cacheKey(userId, item, etagHash);
  let text = await env.OAUTH_KV.get(key);
  let cached = true;
  if (text === null) {
    cached = false;
    const buffer = await downloadAllowedItem(env, userId, item);
    text = await convertBufferToText(env, item, buffer);
    const cacheTtl = Math.max(0, Number(env.CACHE_TTL_SECONDS || 604800));
    if (cacheTtl > 0 && text.length <= 10_000_000) {
      await env.OAUTH_KV.put(key, text, { expirationTtl: cacheTtl });
    }
  }

  const safeStart = Math.max(0, Math.floor(startChar));
  const configuredMax = Math.max(1000, Number(env.MAX_READ_CHARS || 50_000));
  const safeLength = Math.min(Math.max(1000, Math.floor(requestedChars)), configuredMax);
  const end = Math.min(text.length, safeStart + safeLength);
  return {
    ...compactItem(item),
    text: text.slice(safeStart, end),
    startChar: safeStart,
    endChar: end,
    totalChars: text.length,
    nextStartChar: end < text.length ? end : null,
    cached,
  };
}

export async function getConnectionStatus(env: Env, userId: string) {
  const profile = await graphFetch<MicrosoftProfile>(
    env,
    userId,
    "/me?$select=id,displayName,mail,userPrincipalName",
  );
  const root = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/root:/${encodeGraphPath(env.ONEDRIVE_ROOT)}?$select=id,name,webUrl,parentReference,folder,lastModifiedDateTime`,
  );
  assertItemInsideAllowedRoot(root, env.ONEDRIVE_ROOT);
  return {
    connected: true,
    displayName: profile.displayName ?? null,
    allowedRoot: env.ONEDRIVE_ROOT,
    rootId: root.id,
    rootWebUrl: root.webUrl ?? null,
    snapshotRequired: false,
    accessMode: "live Microsoft Graph search and on-demand document conversion",
  };
}

export { MICROSOFT_SCOPES, TOKEN_ENDPOINT };
