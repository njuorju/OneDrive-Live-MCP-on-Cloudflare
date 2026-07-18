import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listVisualAssets } from "../src/graph.ts";
import { sealJson } from "../src/security.ts";
import type { GraphDriveItem, TokenRecord } from "../src/types.ts";

const KEY = "1".repeat(64);

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
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    },
  } as unknown as Env;
}

function installGraphMock(): () => void {
  const previous = globalThis.fetch;
  const root: GraphDriveItem = {
    id: "root-id",
    name: "Work",
    folder: { childCount: 5 },
    parentReference: { id: "drive-root", driveId: "drive-a" },
  };
  const sub: GraphDriveItem = {
    id: "sub-id",
    name: "Maps",
    folder: { childCount: 1 },
    parentReference: { id: "root-id", driveId: "drive-a" },
  };
  const items = new Map<string, GraphDriveItem>([
    ["root-id", root],
    ["sub-id", sub],
    ["landscape-id", {
      id: "landscape-id",
      name: "Almaty panorama.jpg",
      size: 100,
      eTag: '"e1"',
      file: { mimeType: "image/jpeg" },
      image: { width: 1600, height: 900 },
      lastModifiedDateTime: "2026-07-17T10:00:00Z",
      parentReference: { id: "root-id", driveId: "drive-a" },
    }],
    ["portrait-id", {
      id: "portrait-id",
      name: "Portrait plan.png",
      size: 120,
      eTag: '"e2"',
      file: { mimeType: "image/png" },
      image: { width: 800, height: 1200 },
      lastModifiedDateTime: "2026-07-16T10:00:00Z",
      parentReference: { id: "root-id", driveId: "drive-a" },
    }],
    ["square-id", {
      id: "square-id",
      name: "Diagram.svg",
      size: 90,
      eTag: '"e3"',
      file: { mimeType: "image/svg+xml" },
      image: { width: 500, height: 500 },
      lastModifiedDateTime: "2026-07-15T10:00:00Z",
      parentReference: { id: "root-id", driveId: "drive-a" },
    }],
    ["note-id", {
      id: "note-id",
      name: "notes.txt",
      size: 20,
      eTag: '"e4"',
      file: { mimeType: "text/plain" },
      lastModifiedDateTime: "2026-07-14T10:00:00Z",
      parentReference: { id: "root-id", driveId: "drive-a" },
    }],
    ["map-id", {
      id: "map-id",
      name: "Transit map.webp",
      size: 130,
      eTag: '"e5"',
      file: { mimeType: "image/webp" },
      image: { width: 2000, height: 1200 },
      lastModifiedDateTime: "2026-07-18T10:00:00Z",
      parentReference: { id: "sub-id", driveId: "drive-a" },
    }],
  ]);
  const rootChildren = [
    items.get("landscape-id")!,
    items.get("portrait-id")!,
    items.get("square-id")!,
    items.get("note-id")!,
    sub,
  ];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes("/me/drive/root:/Work")) return Response.json(root);
    const childMatch = url.pathname.match(/\/me\/drive\/items\/([^/]+)\/children$/);
    if (childMatch) {
      const parentId = decodeURIComponent(childMatch[1]);
      if (parentId === "root-id") return Response.json({ value: rootChildren });
      if (parentId === "sub-id") return Response.json({ value: [items.get("map-id")] });
      return Response.json({ value: [] });
    }
    const itemMatch = url.pathname.match(/\/me\/drive\/items\/([^/]+)$/);
    if (itemMatch) {
      const found = items.get(decodeURIComponent(itemMatch[1]));
      return found
        ? Response.json(found)
        : Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
    }
    return Response.json({ error: { code: "unexpectedRequest" } }, { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => Boolean(
    error && typeof error === "object" && "code" in error && error.code === code,
  ));
}

describe("visual asset discovery", () => {
  it("paginates every result without exposing IDs or Graph continuation state", { concurrency: false }, async () => {
    const env = await makeEnv();
    const restore = installGraphMock();
    try {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listVisualAssets(env, "owner", {
          recursive: false,
          orientation: "any",
          limit: 1,
          cursor,
        });
        names.push(...page.results.map((entry) => entry.filename));
        cursor = page.cursor ?? undefined;
        if (cursor) {
          assert.doesNotMatch(cursor, /graph\.microsoft\.com|landscape-id|portrait-id|square-id|root-id/);
        }
      } while (cursor);
      assert.deepEqual(names, ["Almaty panorama.jpg", "Portrait plan.png", "Diagram.svg"]);
    } finally {
      restore();
    }
  });

  it("filters orientation, dimensions, type, query, date, and recursion", { concurrency: false }, async () => {
    const env = await makeEnv();
    const restore = installGraphMock();
    try {
      const portrait = await listVisualAssets(env, "owner", {
        recursive: false,
        orientation: "portrait",
        fileTypes: ["png"],
        minWidth: 700,
        minHeight: 1000,
        modifiedAfter: "2026-07-15T00:00:00Z",
        limit: 10,
      });
      assert.deepEqual(portrait.results.map((entry) => entry.filename), ["Portrait plan.png"]);
      assert.equal(portrait.results[0]?.orientation, "portrait");
      assert.equal(portrait.results[0]?.width, 800);
      assert.equal(portrait.results[0]?.height, 1200);

      const recursive = await listVisualAssets(env, "owner", {
        recursive: true,
        query: "transit map",
        orientation: "landscape",
        minWidth: 1900,
        limit: 10,
      });
      assert.deepEqual(recursive.results.map((entry) => entry.relativePath), ["Maps/Transit map.webp"]);
    } finally {
      restore();
    }
  });

  it("binds an encrypted cursor to the original filters", { concurrency: false }, async () => {
    const env = await makeEnv();
    const restore = installGraphMock();
    try {
      const first = await listVisualAssets(env, "owner", {
        recursive: false,
        query: "plan",
        orientation: "any",
        limit: 1,
      });
      assert.ok(first.cursor);
      await rejectsWithCode(
        listVisualAssets(env, "owner", {
          recursive: false,
          query: "different",
          orientation: "any",
          limit: 1,
          cursor: first.cursor ?? undefined,
        }),
        "cursor_filter_mismatch",
      );
    } finally {
      restore();
    }
  });
});
