import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyItemInsideRoot } from "../src/graph-core.ts";
import { sealJson } from "../src/security.ts";
import type { GraphDriveItem, TokenRecord } from "../src/types.ts";

const KEY = "a".repeat(64);
const USER_ID = "owner-user";

function item(
  id: string,
  name: string,
  parentId: string | undefined,
  driveId = "drive-a",
  extra: Partial<GraphDriveItem> = {},
): GraphDriveItem {
  return {
    id,
    name,
    parentReference: { id: parentId, driveId },
    ...extra,
  };
}

async function makeEnv(): Promise<Env> {
  const token: TokenRecord = {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: "Files.ReadWrite User.Read offline_access",
  };
  const sealed = await sealJson(KEY, token);
  const stub = {
    fetch: async () => Response.json({
      ok: true,
      found: true,
      expired: false,
      value: sealed,
      stage: "get_token_ok",
    }),
  };
  return {
    COOKIE_ENCRYPTION_KEY: KEY,
    ONEDRIVE_ROOT: "Work",
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

function installGraphMock(items: Map<string, GraphDriveItem>, root: GraphDriveItem): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "graph.microsoft.com");
    if (url.pathname.includes("/me/drive/root:/Work")) return Response.json(root);
    const match = url.pathname.match(/\/me\/drive\/items\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const found = items.get(id);
      if (!found) {
        return Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
      }
      return Response.json(found);
    }
    return Response.json({ error: { code: "unexpectedRequest" } }, { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
  });
}

describe("centralized OneDrive root ancestry validation", () => {
  it("accepts only live, same-drive ancestry that reaches the configured root", { concurrency: false }, async () => {
    const env = await makeEnv();
    const root = item("root-id", "Work", "drive-root", "drive-a", { folder: { childCount: 1 } });
    const items = new Map<string, GraphDriveItem>([
      ["root-id", root],
      ["folder-id", item("folder-id", "Folder", "root-id", "drive-a", { folder: { childCount: 1 } })],
      ["file-id", item("file-id", "Map.png", "folder-id", "drive-a", { file: { mimeType: "image/png" } })],
      ["drive-root", item("drive-root", "root", undefined, "drive-a", { folder: { childCount: 2 } })],
      ["outside-id", item("outside-id", "Outside.txt", "drive-root", "drive-a", { file: { mimeType: "text/plain" } })],
      ["cross-drive", item("cross-drive", "Other.txt", "root-id", "drive-b", { file: { mimeType: "text/plain" } })],
      ["remote-id", item("remote-id", "Remote.png", "root-id", "drive-a", { remoteItem: item("remote-target", "Remote.png", undefined, "drive-b") })],
      ["cycle-a", item("cycle-a", "A", "cycle-b", "drive-a", { folder: { childCount: 1 } })],
      ["cycle-b", item("cycle-b", "B", "cycle-a", "drive-a", { folder: { childCount: 1 } })],
      ["missing-parent", item("missing-parent", "Missing.txt", "does-not-exist", "drive-a", { file: { mimeType: "text/plain" } })],
    ]);
    const restore = installGraphMock(items, root);
    try {
      const verified = await verifyItemInsideRoot(env, USER_ID, "file-id");
      assert.equal(verified.relativePath, "Folder/Map.png");
      assert.deepEqual(verified.ancestorIds.slice(0, 3), ["file-id", "folder-id", "root-id"]);

      await rejectsWithCode(verifyItemInsideRoot(env, USER_ID, "outside-id"), "outside_root");
      await rejectsWithCode(verifyItemInsideRoot(env, USER_ID, "cross-drive"), "cross_drive");
      await rejectsWithCode(verifyItemInsideRoot(env, USER_ID, "remote-id"), "outside_root");
      await rejectsWithCode(verifyItemInsideRoot(env, USER_ID, "cycle-a"), "ancestry_cycle");
      await rejectsWithCode(verifyItemInsideRoot(env, USER_ID, "missing-parent"), "item_not_found");

      // Prove ancestry is re-read instead of trusted from a stale cache.
      items.set("folder-id", item("folder-id", "Folder", "drive-root", "drive-a", { folder: { childCount: 1 } }));
      await rejectsWithCode(verifyItemInsideRoot(env, USER_ID, "file-id"), "outside_root");
    } finally {
      restore();
    }
  });
});
