import { getRuntimeConfig } from "./config";
import { ConnectorError } from "./errors";
import {
  isAllowedOriginalFile,
  normalizedMimeType,
  validateFileSignature,
} from "./file-types";
import {
  compactVerifiedItem,
  downloadVerifiedItem,
  verifyItemInsideRoot,
} from "./graph-core";

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function originalResourceUri(itemId: string, eTag: string | null): string {
  const params = new URLSearchParams();
  if (eTag) params.set("etag", eTag);
  const query = params.toString();
  return `onedrive-original:///items/${encodeURIComponent(itemId)}${query ? `?${query}` : ""}`;
}

export async function fetchOriginalFileResource(env: Env, userId: string, itemId: string) {
  const config = getRuntimeConfig(env);
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder) {
    throw new ConnectorError("folder_not_file", "Folders cannot be fetched as original files.");
  }
  if (!isAllowedOriginalFile(verified.item.name)) {
    throw new ConnectorError(
      "unsupported_original_type",
      "This file type is not allowlisted for original retrieval.",
    );
  }
  if ((verified.item.size ?? 0) > config.maxOriginalFileBytes) {
    throw new ConnectorError("file_too_large", "The original file exceeds the configured size limit.");
  }
  return {
    metadata: compactVerifiedItem(verified),
    resource: {
      type: "resource_link" as const,
      uri: originalResourceUri(verified.item.id, verified.item.eTag ?? null),
      name: verified.item.name,
      title: verified.item.name,
      description:
        "Exact original OneDrive file bytes, fetched through the authenticated MCP resource handler.",
      mimeType: normalizedMimeType(verified.item.name, verified.item.file?.mimeType),
      size: verified.item.size,
      annotations: {
        audience: ["assistant", "user"] as Array<"assistant" | "user">,
        priority: 1,
      },
    },
  };
}

export async function readOriginalFileResource(env: Env, userId: string, uri: URL) {
  if (uri.protocol !== "onedrive-original:" || uri.hostname !== "") {
    throw new ConnectorError("invalid_resource", "The resource URI is invalid.");
  }
  const prefix = "/items/";
  if (!uri.pathname.startsWith(prefix) || uri.pathname.length <= prefix.length) {
    throw new ConnectorError("invalid_resource", "The resource URI is invalid.");
  }
  let itemId: string;
  try {
    itemId = decodeURIComponent(uri.pathname.slice(prefix.length));
  } catch {
    throw new ConnectorError("invalid_resource", "The resource item ID is invalid.");
  }
  if (!itemId || itemId.includes("/") || /[\u0000-\u001f]/.test(itemId)) {
    throw new ConnectorError("invalid_resource", "The resource item ID is invalid.");
  }

  const expectedETag = uri.searchParams.get("etag");
  const config = getRuntimeConfig(env);
  const { verified, buffer } = await downloadVerifiedItem(
    env,
    userId,
    itemId,
    config.maxOriginalFileBytes,
  );
  if (!isAllowedOriginalFile(verified.item.name)) {
    throw new ConnectorError(
      "unsupported_original_type",
      "This file type is not allowlisted for original retrieval.",
    );
  }
  if (expectedETag && verified.item.eTag !== expectedETag) {
    throw new ConnectorError(
      "etag_conflict",
      "The original file changed after the resource link was created. Fetch it again.",
    );
  }
  const signature = validateFileSignature(
    verified.item.name,
    buffer,
    verified.item.file?.mimeType,
  );
  if (!signature.compatible) {
    throw new ConnectorError(
      "file_signature_mismatch",
      signature.reason ?? "File signature mismatch.",
    );
  }
  return {
    uri: uri.href,
    mimeType: normalizedMimeType(verified.item.name, verified.item.file?.mimeType),
    blob: toBase64(buffer),
  };
}
