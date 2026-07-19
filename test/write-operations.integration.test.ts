import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFolder,
  createTextFile,
  moveItem,
  readAllowedFile,
  renameItem,
  replaceTextFile,
} from "../src/graph.ts";
import { sealJson } from "../src/security.ts";
import type { GraphDriveItem, TokenRecord } from "../src/types.ts";

const KEY = "f".repeat(64);

type Stored = GraphDriveItem & { content?: string };

async function makeEnv(): Promise<Env> {
  const token: TokenRecord = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    scope: "Files.ReadWrite User.Read offline_access",
  };
  const sealed = await sealJson(KEY, token);
  const stub = {
    fetch: async () => Response.json({ ok: true, found: true, expired: false, value: sealed }),
  };
  return {
    COOKIE_ENCRYPTION_KEY: KEY,
    ONEDRIVE_ROOT: "Work",
    MAX_TEXT_WRITE_KB: "1",
    CACHE_TTL_SECONDS: "0",
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    },
    OAUTH_KV: {
      get: async () => null,
      put: async () => undefined,
    },
  } as unknown as Env;
}

function installMutableGraph(): {
  restore: () => void;
  items: Map<string, Stored>;
  mutationCount: () => number;
} {
  const previous = globalThis.fetch;
  const items = new Map<string, Stored>();
  let nextId = 1;
  let etag = 1;
  let mutations = 0;
  const root: Stored = {
    id: "root-id",
    name: "Work",
    folder: { childCount: 0 },
    parentReference: { id: "drive-root", driveId: "drive-a" },
  };
  const driveRoot: Stored = {
    id: "drive-root",
    name: "root",
    folder: { childCount: 2 },
    parentReference: { driveId: "drive-a" },
  };
  const outside: Stored = {
    id: "outside-id",
    name: "outside.md",
    file: { mimeType: "text/markdown" },
    eTag: '"outside"',
    size: 7,
    content: "outside",
    parentReference: { id: "drive-root", driveId: "drive-a" },
  };
  items.set(root.id, root);
  items.set(driveRoot.id, driveRoot);
  items.set(outside.id, outside);

  const childrenOf = (parentId: string) => [...items.values()].filter((entry) => entry.parentReference?.id === parentId);
  const refreshChildCount = (parentId: string) => {
    const parent = items.get(parentId);
    if (parent?.folder) parent.folder.childCount = childrenOf(parentId).length;
  };
  const findByPath = (path: string): Stored | undefined => {
    const segments = path.split("/").filter(Boolean);
    if (segments.shift() !== "Work") return undefined;
    let current: Stored | undefined = root;
    for (const segment of segments) {
      current = childrenOf(current.id).find((entry) => entry.name === segment);
      if (!current) return undefined;
    }
    return current;
  };
  const newEtag = () => `"etag-${etag++}"`;
  const json = (value: unknown, status = 200) => Response.json(value, { status });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();

    const rootMarker = "/v1.0/me/drive/root:/";
    if (url.pathname.startsWith(rootMarker)) {
      const path = decodeURIComponent(url.pathname.slice(rootMarker.length));
      const found = findByPath(path);
      return found ? json(found) : json({ error: { code: "itemNotFound" } }, 404);
    }

    const contentMatch = url.pathname.match(/\/v1\.0\/me\/drive\/items\/([^/]+)\/content$/);
    if (contentMatch) {
      const id = decodeURIComponent(contentMatch[1]);
      const target = items.get(id);
      if (!target || target.folder) return json({ error: { code: "itemNotFound" } }, 404);
      if (method === "GET") {
        const body = new TextEncoder().encode(target.content ?? "");
        return new Response(body, {
          headers: {
            "Content-Length": String(body.byteLength),
            "Content-Type": target.file?.mimeType ?? "text/plain",
          },
        });
      }
      if (method === "PUT") {
        if (init?.headers && new Headers(init.headers).get("If-Match") !== target.eTag) {
          return json({ error: { code: "preconditionFailed" } }, 412);
        }
        target.content = String(init?.body ?? "");
        target.size = new TextEncoder().encode(target.content).byteLength;
        target.eTag = newEtag();
        mutations += 1;
        return json(target);
      }
    }

    const createTextMatch = url.pathname.match(/\/v1\.0\/me\/drive\/items\/([^:]+):\/([^:]+):\/content$/);
    if (createTextMatch && method === "PUT") {
      const parentId = decodeURIComponent(createTextMatch[1]);
      const name = decodeURIComponent(createTextMatch[2]);
      const conflict = childrenOf(parentId).find((entry) => entry.name.toLocaleLowerCase("en") === name.toLocaleLowerCase("en"));
      if (conflict) return json({ error: { code: "nameAlreadyExists" } }, 409);
      assert.equal(url.searchParams.get("@microsoft.graph.conflictBehavior"), "fail");
      assert.equal(new Headers(init?.headers).get("If-None-Match"), "*");
      const content = String(init?.body ?? "");
      const created: Stored = {
        id: `item-${nextId++}`,
        name,
        file: { mimeType: name.endsWith(".md") ? "text/markdown" : "text/plain" },
        size: new TextEncoder().encode(content).byteLength,
        eTag: newEtag(),
        content,
        parentReference: { id: parentId, driveId: "drive-a" },
      };
      items.set(created.id, created);
      refreshChildCount(parentId);
      mutations += 1;
      return json(created);
    }

    const childrenMatch = url.pathname.match(/\/v1\.0\/me\/drive\/items\/([^/]+)\/children$/);
    if (childrenMatch) {
      const parentId = decodeURIComponent(childrenMatch[1]);
      if (method === "GET") return json({ value: childrenOf(parentId) });
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; folder?: object; "@microsoft.graph.conflictBehavior"?: string };
        assert.equal(body["@microsoft.graph.conflictBehavior"], "fail");
        const name = String(body.name ?? "");
        if (childrenOf(parentId).some((entry) => entry.name.toLocaleLowerCase("en") === name.toLocaleLowerCase("en"))) {
          return json({ error: { code: "nameAlreadyExists" } }, 409);
        }
        const created: Stored = {
          id: `folder-${nextId++}`,
          name,
          folder: { childCount: 0 },
          eTag: newEtag(),
          parentReference: { id: parentId, driveId: "drive-a" },
        };
        items.set(created.id, created);
        refreshChildCount(parentId);
        mutations += 1;
        return json(created);
      }
    }

    const itemMatch = url.pathname.match(/\/v1\.0\/me\/drive\/items\/([^/]+)$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      const target = items.get(id);
      if (!target) return json({ error: { code: "itemNotFound" } }, 404);
      if (method === "GET") return json(target);
      if (method === "PATCH") {
        const ifMatch = new Headers(init?.headers).get("If-Match");
        if (ifMatch && ifMatch !== target.eTag) return json({ error: { code: "preconditionFailed" } }, 412);
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; parentReference?: { id?: string } };
        if (body.name) target.name = body.name;
        if (body.parentReference?.id) {
          const oldParent = target.parentReference?.id;
          target.parentReference = { id: body.parentReference.id, driveId: "drive-a" };
          if (oldParent) refreshChildCount(oldParent);
          refreshChildCount(body.parentReference.id);
        }
        target.eTag = newEtag();
        mutations += 1;
        return json(target);
      }
    }

    return json({ error: { code: "unexpectedRequest" } }, 500);
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = previous;
    },
    items,
    mutationCount: () => mutations,
  };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => Boolean(
    error && typeof error === "object" && "code" in error && error.code === code,
  ));
}

describe("bounded write acceptance lifecycle", () => {
  it("creates, reads, replaces with eTag, rejects stale eTag, renames, moves, and rereads", { concurrency: false }, async () => {
    const env = await makeEnv();
    const graph = installMutableGraph();
    try {
      const testFolder = await createFolder(env, "owner", "", "_MCP_WRITE_TEST");
      assert.equal(testFolder.relativePath, "_MCP_WRITE_TEST");
      const destination = await createFolder(env, "owner", "_MCP_WRITE_TEST", "destination");
      assert.equal(destination.relativePath, "_MCP_WRITE_TEST/destination");

      const created = await createTextFile(
        env,
        "owner",
        "_MCP_WRITE_TEST",
        "acceptance.md",
        "version one",
      );
      const firstRead = await readAllowedFile(env, "owner", created.itemId, 0, 10_000);
      assert.equal(firstRead.content, "version one");
      const oldETag = created.eTag;
      assert.ok(oldETag);

      const replaced = await replaceTextFile(env, "owner", created.itemId, oldETag, "version two");
      assert.notEqual(replaced.eTag, oldETag);
      await rejectsWithCode(
        replaceTextFile(env, "owner", created.itemId, oldETag, "stale overwrite"),
        "etag_conflict",
      );

      const renamed = await renameItem(env, "owner", created.itemId, "renamed.md");
      assert.equal(renamed.filename, "renamed.md");
      const moved = await moveItem(env, "owner", created.itemId, "_MCP_WRITE_TEST/destination");
      assert.equal(moved.relativePath, "_MCP_WRITE_TEST/destination/renamed.md");
      const finalRead = await readAllowedFile(env, "owner", created.itemId, 0, 10_000);
      assert.equal(finalRead.content, "version two");

      await rejectsWithCode(renameItem(env, "owner", "outside-id", "nope.md"), "outside_root");
      await rejectsWithCode(moveItem(env, "owner", created.itemId, "../outside"), "path_traversal");
      assert.equal(graph.mutationCount(), 6);
    } finally {
      graph.restore();
    }
  });

  it("fails on conflicts, unsupported text, oversized text, and circular folder moves", { concurrency: false }, async () => {
    const env = await makeEnv();
    const graph = installMutableGraph();
    try {
      const folder = await createFolder(env, "owner", "", "Folder");
      await rejectsWithCode(createFolder(env, "owner", "", "folder"), "name_conflict");
      await rejectsWithCode(
        createTextFile(env, "owner", "", "binary.bin", "not allowed"),
        "unsupported_text_extension",
      );
      await rejectsWithCode(
        createTextFile(env, "owner", "", "too-large.md", "x".repeat(2048)),
        "text_too_large",
      );
      await createFolder(env, "owner", "Folder", "Child");
      await rejectsWithCode(moveItem(env, "owner", folder.itemId, "Folder/Child"), "circular_move");
    } finally {
      graph.restore();
    }
  });
});
