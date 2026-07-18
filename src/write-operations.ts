import { getRuntimeConfig } from "./config";
import { ConnectorError } from "./errors";
import { isAllowedTextFile } from "./file-types";
import {
  compactVerifiedItem,
  graphFetch,
  listVerifiedChildren,
  resolveRelativeFolder,
  validateItemName,
  verifyItemInsideRoot,
  type VerifiedItem,
} from "./graph-core";
import type { GraphDriveItem } from "./types";

async function findNameConflict(
  env: Env,
  userId: string,
  folder: VerifiedItem,
  name: string,
  excludingItemId?: string,
): Promise<VerifiedItem | null> {
  const target = name.toLocaleLowerCase("en");
  let nextUrl: string | undefined;
  do {
    const page = await listVerifiedChildren(env, userId, folder, 200, nextUrl);
    for (const child of page.items) {
      if (child.item.id === excludingItemId) continue;
      if (child.item.name.toLocaleLowerCase("en") === target) return child;
    }
    nextUrl = page.nextUrl;
  } while (nextUrl);
  return null;
}

async function assertNameAvailable(
  env: Env,
  userId: string,
  folder: VerifiedItem,
  name: string,
  excludingItemId?: string,
): Promise<void> {
  const conflict = await findNameConflict(env, userId, folder, name, excludingItemId);
  if (conflict) {
    throw new ConnectorError("name_conflict", "An item with that name already exists in the destination folder.");
  }
}

function utf8Bytes(content: string, maxBytes: number): Uint8Array {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > maxBytes) {
    throw new ConnectorError("text_too_large", "The text content exceeds the configured write limit.");
  }
  return bytes;
}

export async function createFolderStrict(
  env: Env,
  userId: string,
  destinationPath: string,
  name: string,
) {
  const safeName = validateItemName(name);
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  await assertNameAvailable(env, userId, destination, safeName);

  // Revalidate immediately before the Graph mutation.
  const currentDestination = await verifyItemInsideRoot(env, userId, destination.item.id);
  await assertNameAvailable(env, userId, currentDestination, safeName);
  const created = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(currentDestination.item.id)}/children`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: safeName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, created.id));
}

export async function createTextFileStrict(
  env: Env,
  userId: string,
  destinationPath: string,
  filename: string,
  content: string,
) {
  const config = getRuntimeConfig(env);
  const safeName = validateItemName(filename);
  if (!isAllowedTextFile(safeName)) {
    throw new ConnectorError(
      "unsupported_text_extension",
      "The filename extension is not allowlisted for text creation.",
    );
  }
  const bytes = utf8Bytes(content, config.maxTextWriteBytes);
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  await assertNameAvailable(env, userId, destination, safeName);

  const currentDestination = await verifyItemInsideRoot(env, userId, destination.item.id);
  await assertNameAvailable(env, userId, currentDestination, safeName);
  const created = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(currentDestination.item.id)}:/${encodeURIComponent(safeName)}:/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "If-None-Match": "*",
      },
      body: bytes,
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, created.id));
}

export async function replaceTextFileStrict(
  env: Env,
  userId: string,
  itemId: string,
  expectedETag: string,
  content: string,
) {
  const config = getRuntimeConfig(env);
  if (!expectedETag) {
    throw new ConnectorError("etag_required", "expectedETag is required for replacement.");
  }
  const verified = await verifyItemInsideRoot(env, userId, itemId);
  if (verified.item.folder || !isAllowedTextFile(verified.item.name)) {
    throw new ConnectorError("not_text_file", "Only allowlisted text files can be replaced.");
  }
  const bytes = utf8Bytes(content, config.maxTextWriteBytes);

  const current = await verifyItemInsideRoot(env, userId, itemId);
  if (current.item.eTag !== expectedETag) {
    throw new ConnectorError(
      "etag_conflict",
      "The item changed since it was read. Fetch the current eTag and retry.",
    );
  }
  const replaced = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(current.item.id)}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "If-Match": expectedETag,
      },
      body: bytes,
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, replaced.id));
}

export async function renameItemStrict(
  env: Env,
  userId: string,
  itemId: string,
  newName: string,
) {
  const safeName = validateItemName(newName);
  const source = await verifyItemInsideRoot(env, userId, itemId);
  const parentId = source.item.parentReference?.id;
  if (!parentId) {
    throw new ConnectorError("root_rename_forbidden", "The configured root folder cannot be renamed through this tool.");
  }
  const parent = await verifyItemInsideRoot(env, userId, parentId);
  if (!parent.item.folder) {
    throw new ConnectorError("ancestry_unproven", "The source parent could not be verified as a folder.");
  }
  await assertNameAvailable(env, userId, parent, safeName, source.item.id);

  const current = await verifyItemInsideRoot(env, userId, source.item.id);
  const currentParent = await verifyItemInsideRoot(env, userId, parent.item.id);
  await assertNameAvailable(env, userId, currentParent, safeName, current.item.id);
  const renamed = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(current.item.id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(current.item.eTag ? { "If-Match": current.item.eTag } : {}),
      },
      body: JSON.stringify({ name: safeName }),
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, renamed.id));
}

export async function moveItemStrict(
  env: Env,
  userId: string,
  itemId: string,
  destinationPath: string,
) {
  const source = await verifyItemInsideRoot(env, userId, itemId);
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  if (source.item.id === source.root.id) {
    throw new ConnectorError("root_move_forbidden", "The configured root folder cannot be moved through this tool.");
  }
  if (source.driveId !== destination.driveId) {
    throw new ConnectorError("cross_drive", "Cross-drive moves are not allowed.");
  }
  if (source.item.folder && destination.ancestorIds.includes(source.item.id)) {
    throw new ConnectorError(
      "circular_move",
      "A folder cannot be moved into itself or one of its descendants.",
    );
  }
  await assertNameAvailable(env, userId, destination, source.item.name, source.item.id);

  // Independently revalidate source and destination immediately before mutation.
  const currentSource = await verifyItemInsideRoot(env, userId, source.item.id);
  const currentDestination = await verifyItemInsideRoot(env, userId, destination.item.id);
  if (currentSource.driveId !== currentDestination.driveId) {
    throw new ConnectorError("cross_drive", "Cross-drive moves are not allowed.");
  }
  if (currentSource.item.folder && currentDestination.ancestorIds.includes(currentSource.item.id)) {
    throw new ConnectorError(
      "circular_move",
      "A folder cannot be moved into itself or one of its descendants.",
    );
  }
  await assertNameAvailable(
    env,
    userId,
    currentDestination,
    currentSource.item.name,
    currentSource.item.id,
  );
  const moved = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(currentSource.item.id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(currentSource.item.eTag ? { "If-Match": currentSource.item.eTag } : {}),
      },
      body: JSON.stringify({
        parentReference: { id: currentDestination.item.id },
      }),
    },
  );
  return compactVerifiedItem(await verifyItemInsideRoot(env, userId, moved.id));
}
