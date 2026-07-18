import assert from "node:assert/strict";
import { it } from "node:test";
import { readAllowedFile } from "../src/onedrive-files.ts";
import { sealJson } from "../src/security.ts";
import type { GraphDriveItem, TokenRecord } from "../src/types.ts";

it("CACHE_TTL_SECONDS=0 performs no cache reads or writes", { concurrency: false }, async () => {
  const key = "b".repeat(64);
  const token: TokenRecord = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    scope: "Files.ReadWrite User.Read offline_access",
  };
  const sealed = await sealJson(key, token);
  let cacheReads = 0;
  let cacheWrites = 0;
  const root: GraphDriveItem = {
    id: "root-id",
    name: "Work",
    folder: { childCount: 1 },
    parentReference: { id: "drive-root", driveId: "drive-a" },
  };
  const file: GraphDriveItem = {
    id: "file-id",
    name: "notes.txt",
    size: 5,
    eTag: '"etag-1"',
    file: { mimeType: "text/plain" },
    parentReference: { id: "root-id", driveId: "drive-a" },
  };
  const stub = {
    fetch: async () => Response.json({ ok: true, found: true, expired: false, value: sealed }),
  };
  const env = {
    COOKIE_ENCRYPTION_KEY: key,
    ONEDRIVE_ROOT: "Work",
    CACHE_TTL_SECONDS: "0",
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    },
    OAUTH_KV: {
      get: async () => {
        cacheReads += 1;
        return null;
      },
      put: async () => {
        cacheWrites += 1;
      },
    },
  } as unknown as Env;

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes("/me/drive/root:/Work")) return Response.json(root);
    if (url.pathname.endsWith("/me/drive/items/root-id")) return Response.json(root);
    if (url.pathname.endsWith("/me/drive/items/file-id")) return Response.json(file);
    if (url.pathname.endsWith("/me/drive/items/file-id/content")) {
      return new Response(new TextEncoder().encode("hello"), {
        headers: { "Content-Length": "5", "Content-Type": "text/plain" },
      });
    }
    return Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
  }) as typeof fetch;

  try {
    const result = await readAllowedFile(env, "owner", "file-id", 0, 10_000);
    assert.equal(result.content, "hello");
    assert.equal(cacheReads, 0);
    assert.equal(cacheWrites, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
