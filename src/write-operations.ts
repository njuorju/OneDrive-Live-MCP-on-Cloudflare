import { getRuntimeConfig } from "./config";
import { ConnectorError } from "./errors";
import { isAllowedTextFile } from "./file-types";
import {
  compactVerifiedItem,
  graphFetch,
  listVerifiedChildren,
  resolveRelativeFolder,
  validateItemName,
  verifiedChildFromListedItem,
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
  if (conflict) throw new ConnectorError("name_conflict", "An item with that name already exists in the destination folder.");
}

function boundedUtf8Content(content: string, maxBytes: number): string {
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > maxBytes) throw new ConnectorError("text_too_large", "The text content exceeds the configured write limit.");
  return content;
}

function requireExpectedETag(source: VerifiedItem, expectedETag: string): void {
  if (!expectedETag) throw new ConnectorError("etag_required", "An expected eTag is required for this verified mutation.");
  if (source.item.eTag !== expectedETag) throw new ConnectorError("etag_conflict", "The item changed since the plan snapshot was created.");
}

async function compactCreatedChild(
  env: Env,
  userId: string,
  parent: VerifiedItem,
  item: GraphDriveItem,
) {
  try {
    return compactVerifiedItem(verifiedChildFromListedItem(parent, item));
  } catch {
    return compactVerifiedItem(await verifyItemInsideRoot(env, userId, item.id));
  }
}

export async function createFolderInVerifiedDestinationStrict(
  env: Env,
  userId: string,
  destination: VerifiedItem,
  name: string,
) {
  if (!destination.item.folder) throw new ConnectorError("not_a_folder", "The destination is not a folder.");
  const safeName = validateItemName(name);
  await assertNameAvailable(env, userId, destination, safeName);
  const created = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(destination.item.id)}/children`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: safeName, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    },
  );
  return compactCreatedChild(env, userId, destination, created);
}

export async function createFolderStrict(env: Env, userId: string, destinationPath: string, name: string) {
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  return createFolderInVerifiedDestinationStrict(env, userId, destination, name);
}

export async function createTextFileInVerifiedDestinationStrict(
  env: Env,
  userId: string,
  destination: VerifiedItem,
  filename: string,
  content: string,
) {
  const config = getRuntimeConfig(env);
  const safeName = validateItemName(filename);
  if (!isAllowedTextFile(safeName)) throw new ConnectorError("unsupported_text_extension", "The filename extension is not allowlisted for text creation.");
  if (!destination.item.folder) throw new ConnectorError("not_a_folder", "The destination is not a folder.");
  const body = boundedUtf8Content(content, config.maxTextWriteBytes);
  await assertNameAvailable(env, userId, destination, safeName);
  const created = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(destination.item.id)}:/${encodeURIComponent(safeName)}:/content?%40microsoft.graph.conflictBehavior=fail`,
    {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", "If-None-Match": "*" },
      body,
    },
  );
  return compactCreatedChild(env, userId, destination, created);
}

export async function createTextFileStrict(env: Env, userId: string, destinationPath: string, filename: string, content: string) {
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  return createTextFileInVerifiedDestinationStrict(env, userId, destination, filename, content);
}

export async function replaceVerifiedTextFileStrict(
  env: Env,
  userId: string,
  source: VerifiedItem,
  expectedETag: string,
  content: string,
) {
  const config = getRuntimeConfig(env);
  if (source.item.folder || !isAllowedTextFile(source.item.name)) throw new ConnectorError("not_text_file", "Only allowlisted text files can be replaced.");
  requireExpectedETag(source, expectedETag);
  const body = boundedUtf8Content(content, config.maxTextWriteBytes);
  const replaced = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(source.item.id)}/content`,
    {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", "If-Match": expectedETag },
      body,
    },
  );
  if (replaced.id !== source.item.id || replaced.parentReference?.driveId !== source.driveId) {
    throw new ConnectorError("mutation_result_invalid", "Microsoft Graph returned an unexpected replacement item.");
  }
  return compactVerifiedItem({ ...source, item: replaced });
}

export async function replaceTextFileStrict(env: Env, userId: string, itemId: string, expectedETag: string, content: string) {
  const source = await verifyItemInsideRoot(env, userId, itemId);
  return replaceVerifiedTextFileStrict(env, userId, source, expectedETag, content);
}

export async function renameVerifiedItemStrict(
  env: Env,
  userId: string,
  source: VerifiedItem,
  parent: VerifiedItem,
  newName: string,
  expectedETag: string,
) {
  const safeName = validateItemName(newName);
  if (source.item.id === source.root.id) throw new ConnectorError("root_rename_forbidden", "The configured root folder cannot be renamed through this tool.");
  if (!parent.item.folder || source.item.parentReference?.id !== parent.item.id || source.driveId !== parent.driveId) {
    throw new ConnectorError("ancestry_unproven", "The source parent could not be retained as a verified folder.");
  }
  requireExpectedETag(source, expectedETag);
  await assertNameAvailable(env, userId, parent, safeName, source.item.id);
  const renamed = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(source.item.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": expectedETag },
      body: JSON.stringify({ name: safeName }),
    },
  );
  return compactCreatedChild(env, userId, parent, renamed);
}

export async function renameItemStrict(env: Env, userId: string, itemId: string, newName: string) {
  const source = await verifyItemInsideRoot(env, userId, itemId);
  const parentId = source.item.parentReference?.id;
  if (!parentId) throw new ConnectorError("root_rename_forbidden", "The configured root folder cannot be renamed through this tool.");
  const parent = await verifyItemInsideRoot(env, userId, parentId);
  if (!source.item.eTag) throw new ConnectorError("etag_required", "The source eTag is required for rename.");
  return renameVerifiedItemStrict(env, userId, source, parent, newName, source.item.eTag);
}

export async function moveVerifiedItemStrict(
  env: Env,
  userId: string,
  source: VerifiedItem,
  destination: VerifiedItem,
  expectedETag: string,
  newName?: string | null,
) {
  if (source.item.id === source.root.id) throw new ConnectorError("root_move_forbidden", "The configured root folder cannot be moved through this tool.");
  if (!destination.item.folder) throw new ConnectorError("not_a_folder", "The destination is not a folder.");
  if (source.driveId !== destination.driveId) throw new ConnectorError("cross_drive", "Cross-drive moves are not allowed.");
  if (source.item.folder && destination.ancestorIds.includes(source.item.id)) throw new ConnectorError("circular_move", "A folder cannot be moved into itself or one of its descendants.");
  requireExpectedETag(source, expectedETag);
  const finalName = newName ? validateItemName(newName) : source.item.name;
  const exclude = destination.item.id === source.item.parentReference?.id ? source.item.id : undefined;
  await assertNameAvailable(env, userId, destination, finalName, exclude);
  const moved = await graphFetch<GraphDriveItem>(
    env,
    userId,
    `/me/drive/items/${encodeURIComponent(source.item.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": expectedETag },
      body: JSON.stringify({
        parentReference: { id: destination.item.id },
        ...(newName ? { name: finalName } : {}),
      }),
    },
  );
  return compactCreatedChild(env, userId, destination, moved);
}

export async function moveItemStrict(env: Env, userId: string, itemId: string, destinationPath: string) {
  const source = await verifyItemInsideRoot(env, userId, itemId);
  const destination = await resolveRelativeFolder(env, userId, destinationPath);
  if (!source.item.eTag) throw new ConnectorError("etag_required", "The source eTag is required for move.");
  return moveVerifiedItemStrict(env, userId, source, destination, source.item.eTag);
}
