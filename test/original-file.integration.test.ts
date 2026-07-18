import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchOriginalFile,
  readOriginalResource,
} from "../src/graph.ts";
import { sealJson } from "../src/security.ts";
import type { GraphDriveItem, TokenRecord } from "../src/types.ts";

const KEY = "e".repeat(64);

function officePackage(): Uint8Array {
  const prefix = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
  const labels = new TextEncoder().encode("[Content_Types].xml\0ppt/presentation.xml\0fixture-bytes");
  const result = new Uint8Array(prefix.length + labels.length);
  result.set(prefix);
  result.set(labels, prefix.length);
  return result;
}

async function makeEnv(maxMb = "25"): Promise<Env> {
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
    MAX_ORIGINAL_FILE_MB: maxMb,
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    },
  } as unknown as Env;
}

function installGraphMock(
  name: string,
  content: Uint8Array,
  options: {
    mimeType?: string;
    size?: number;
    folder?: boolean;
    parentId?: string;
  } = {},
): () => void {
  const previous = globalThis.fetch;
  const root: GraphDriveItem = {
    id: "root-id",
    name: "Work",
    folder: { childCount: 1 },
    parentReference: { id: "drive-root", driveId: "drive-a" },
  };
  const driveRoot: GraphDriveItem = {
    id: "drive-root",
    name: "root",
    folder: { childCount: 2 },
    parentReference: { driveId: "drive-a" },
  };
  const target: GraphDriveItem = {
    id: "CaseSensitiveItemID",
    name,
    size: options.size ?? content.byteLength,
    eTag: '"etag-current"',
    file: options.folder ? undefined : { mimeType: options.mimeType },
    folder: options.folder ? { childCount: 0 } : undefined,
    parentReference: { id: options.parentId ?? "root-id", driveId: "drive-a" },
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes("/me/drive/root:/Work")) return Response.json(root);
    if (url.pathname.endsWith("/me/drive/items/root-id")) return Response.json(root);
    if (url.pathname.endsWith("/me/drive/items/drive-root")) return Response.json(driveRoot);
    if (url.pathname.endsWith("/me/drive/items/CaseSensitiveItemID")) return Response.json(target);
    if (url.pathname.endsWith("/me/drive/items/CaseSensitiveItemID/content")) {
      return new Response(content, {
        headers: {
          "Content-Length": String(content.byteLength),
          "Content-Type": options.mimeType ?? "application/octet-stream",
        },
      });
    }
    return Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
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

describe("exact original-file retrieval", () => {
  for (const [name, mimeType] of [
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["template.potx", "application/vnd.openxmlformats-officedocument.presentationml.template"],
  ] as const) {
    it(`round-trips exact ${name} bytes and metadata`, { concurrency: false }, async () => {
      const env = await makeEnv();
      const content = officePackage();
      const restore = installGraphMock(name, content, { mimeType });
      try {
        const result = await fetchOriginalFile(env, "owner", "CaseSensitiveItemID");
        assert.equal(result.metadata.filename, name);
        assert.equal(result.metadata.byteSize, content.byteLength);
        assert.equal(result.metadata.eTag, '"etag-current"');
        assert.equal(result.resource.type, "resource_link");
        assert.equal(result.resource.mimeType, mimeType);
        assert.match(result.resource.uri, /^onedrive-original:\/\/\/items\/CaseSensitiveItemID/);
        assert.doesNotMatch(JSON.stringify(result), /graph\.microsoft\.com|Bearer|drive-a|access/);

        const resource = await readOriginalResource(env, "owner", new URL(result.resource.uri));
        assert.equal(resource.mimeType, mimeType);
        assert.deepEqual(Buffer.from(resource.blob, "base64"), Buffer.from(content));
      } finally {
        restore();
      }
    });
  }

  it("rejects a stale resource eTag", { concurrency: false }, async () => {
    const env = await makeEnv();
    const content = officePackage();
    const restore = installGraphMock("deck.pptx", content, {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    try {
      const stale = new URL("onedrive-original:///items/CaseSensitiveItemID?etag=stale");
      await rejectsWithCode(readOriginalResource(env, "owner", stale), "etag_conflict");
    } finally {
      restore();
    }
  });

  it("rejects folders, unsupported types, oversized originals, and out-of-root items", { concurrency: false }, async () => {
    const content = officePackage();

    let env = await makeEnv();
    let restore = installGraphMock("folder", content, { folder: true });
    try {
      await rejectsWithCode(fetchOriginalFile(env, "owner", "CaseSensitiveItemID"), "folder_not_file");
    } finally {
      restore();
    }

    env = await makeEnv();
    restore = installGraphMock("archive.exe", Uint8Array.from([0x4d, 0x5a]), {
      mimeType: "application/vnd.microsoft.portable-executable",
    });
    try {
      await rejectsWithCode(fetchOriginalFile(env, "owner", "CaseSensitiveItemID"), "unsupported_original_type");
    } finally {
      restore();
    }

    env = await makeEnv("1");
    restore = installGraphMock("deck.pptx", content, {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      size: 2 * 1024 * 1024,
    });
    try {
      await rejectsWithCode(fetchOriginalFile(env, "owner", "CaseSensitiveItemID"), "file_too_large");
    } finally {
      restore();
    }

    env = await makeEnv();
    restore = installGraphMock("deck.pptx", content, {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      parentId: "drive-root",
    });
    try {
      await rejectsWithCode(fetchOriginalFile(env, "owner", "CaseSensitiveItemID"), "outside_root");
    } finally {
      restore();
    }
  });
});
