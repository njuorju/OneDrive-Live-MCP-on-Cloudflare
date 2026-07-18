import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchImageForAnalysis } from "../src/graph.ts";
import { sealJson } from "../src/security.ts";
import type { GraphDriveItem, TokenRecord } from "../src/types.ts";

const KEY = "d".repeat(64);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function webp(): Uint8Array {
  const value = new Uint8Array(16);
  value.set(new TextEncoder().encode("RIFF"), 0);
  value.set(new TextEncoder().encode("WEBP"), 8);
  return value;
}

function heic(): Uint8Array {
  const value = new Uint8Array(32);
  value.set(new TextEncoder().encode("ftyp"), 4);
  value.set(new TextEncoder().encode("heic"), 8);
  return value;
}

async function makeEnv(
  info: Record<string, unknown> | (() => Promise<Record<string, unknown>>) = { width: 1200, height: 800 },
  overrides: Record<string, unknown> = {},
): Promise<Env> {
  const token: TokenRecord = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    expiresAt: Date.now() + 3_600_000,
    scope: "Files.ReadWrite User.Read offline_access",
  };
  const sealed = await sealJson(KEY, token);
  const authStub = {
    fetch: async () => Response.json({ ok: true, found: true, expired: false, value: sealed }),
  };
  const imageInput = {
    transform() {
      return this;
    },
    async output() {
      return {
        response: () => new Response(PNG, { headers: { "Content-Type": "image/png" } }),
      };
    },
  };
  return {
    COOKIE_ENCRYPTION_KEY: KEY,
    ONEDRIVE_ROOT: "Work",
    MAX_IMAGE_INPUT_MB: "15",
    MAX_IMAGE_PIXELS: "40000000",
    MAX_IMAGE_DIMENSION: "8192",
    IMAGE_PROCESSING_TIMEOUT_MS: "1000",
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => authStub as unknown as DurableObjectStub,
    },
    IMAGES: {
      info: async () => typeof info === "function" ? info() : info,
      input: () => imageInput,
    },
    ...overrides,
  } as unknown as Env;
}

function installGraphMock(
  filename: string,
  content: Uint8Array,
  options: { size?: number; parentId?: string; mimeType?: string; photoOrientation?: number } = {},
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
  const file: GraphDriveItem = {
    id: "file-id",
    name: filename,
    size: options.size ?? content.byteLength,
    eTag: '"etag-1"',
    file: { mimeType: options.mimeType },
    photo: options.photoOrientation ? { orientation: options.photoOrientation } : undefined,
    parentReference: { id: options.parentId ?? "root-id", driveId: "drive-a" },
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes("/me/drive/root:/Work")) return Response.json(root);
    if (url.pathname.endsWith("/me/drive/items/root-id")) return Response.json(root);
    if (url.pathname.endsWith("/me/drive/items/drive-root")) return Response.json(driveRoot);
    if (url.pathname.endsWith("/me/drive/items/file-id")) return Response.json(file);
    if (url.pathname.endsWith("/me/drive/items/file-id/content")) {
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

describe("image analysis retrieval", () => {
  it("returns actual MCP image content for JPG, PNG, WEBP, GIF, HEIC, and SVG", { concurrency: false }, async () => {
    const fixtures: Array<[string, Uint8Array, string]> = [
      ["landscape.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]), "image/jpeg"],
      ["landscape.png", PNG, "image/png"],
      ["landscape.webp", webp(), "image/webp"],
      ["animated.gif", new TextEncoder().encode("GIF89a"), "image/gif"],
      ["photo.heic", heic(), "image/heic"],
      ["plan.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5"></svg>'), "image/svg+xml"],
    ];
    for (const [filename, content, mimeType] of fixtures) {
      const env = await makeEnv();
      const restore = installGraphMock(filename, content, { mimeType });
      try {
        const result = await fetchImageForAnalysis(env, "owner", "file-id", "auto", 1600);
        assert.equal(result.image.type, "image");
        assert.equal(result.image.mimeType, "image/png");
        assert.deepEqual(Buffer.from(result.image.data, "base64"), Buffer.from(PNG));
        assert.equal(result.metadata.sourceWidth, 1200);
        assert.equal(result.metadata.sourceHeight, 800);
        assert.doesNotMatch(JSON.stringify(result), /graph\.microsoft\.com|Bearer|test-access|drive-a/);
      } finally {
        restore();
      }
    }
  });

  it("reports orientation correction/conversion without rewriting the original", { concurrency: false }, async () => {
    const env = await makeEnv({ width: 800, height: 1200 });
    const restore = installGraphMock(
      "portrait.jpg",
      Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]),
      { mimeType: "image/jpeg", photoOrientation: 6 },
    );
    try {
      const result = await fetchImageForAnalysis(env, "owner", "file-id", "high");
      assert.equal(result.metadata.converted, true);
      assert.equal(result.metadata.previewMimeType, "image/png");
    } finally {
      restore();
    }
  });

  it("rejects material signature mismatches and malformed images", { concurrency: false }, async () => {
    const env = await makeEnv();
    const restore = installGraphMock(
      "fake.png",
      Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]),
      { mimeType: "image/png" },
    );
    try {
      await rejectsWithCode(
        fetchImageForAnalysis(env, "owner", "file-id", "auto"),
        "file_signature_mismatch",
      );
    } finally {
      restore();
    }
  });

  it("rejects files outside the configured root", { concurrency: false }, async () => {
    const env = await makeEnv();
    const restore = installGraphMock("outside.png", PNG, {
      mimeType: "image/png",
      parentId: "drive-root",
    });
    try {
      await rejectsWithCode(
        fetchImageForAnalysis(env, "owner", "file-id", "auto"),
        "outside_root",
      );
    } finally {
      restore();
    }
  });

  it("rejects oversized source bytes before decoding", { concurrency: false }, async () => {
    const env = await makeEnv();
    const restore = installGraphMock("huge.png", PNG, {
      mimeType: "image/png",
      size: 16 * 1024 * 1024,
    });
    try {
      await rejectsWithCode(
        fetchImageForAnalysis(env, "owner", "file-id", "auto"),
        "file_too_large",
      );
    } finally {
      restore();
    }
  });

  it("rejects excessive decoded dimensions as a decompression bomb", { concurrency: false }, async () => {
    const env = await makeEnv({ width: 100_000, height: 100_000 });
    const restore = installGraphMock("bomb.png", PNG, { mimeType: "image/png" });
    try {
      await rejectsWithCode(
        fetchImageForAnalysis(env, "owner", "file-id", "auto"),
        "image_dimensions_exceeded",
      );
    } finally {
      restore();
    }
  });

  it("fails closed when image inspection times out", { concurrency: false }, async () => {
    const env = await makeEnv(() => new Promise<Record<string, unknown>>(() => {}));
    const restore = installGraphMock("slow.png", PNG, { mimeType: "image/png" });
    try {
      await rejectsWithCode(
        fetchImageForAnalysis(env, "owner", "file-id", "auto"),
        "image_processing_timeout",
      );
    } finally {
      restore();
    }
  });
});
