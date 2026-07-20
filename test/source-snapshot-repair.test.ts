import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../src/errors";
import { sealJson } from "../src/security";
import {
  continueSourceSnapshotJob,
  reliableGraphResponse,
  snapshotRepairTestHooks,
} from "../src/source-snapshot-repair";
import type { StableStorage } from "../src/version20-hotfix";

class MemoryStorage implements StableStorage {
  values = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T = unknown>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T = unknown>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const prefix = options.prefix ?? "";
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>);
  }
}

async function fakeEnv(extra: Record<string, unknown> = {}): Promise<Env> {
  const secret = "test-cookie-secret";
  let sealed = await sealJson(secret, {
    accessToken: "ACCESS_TOKEN_MUST_NEVER_APPEAR",
    refreshToken: "REFRESH_TOKEN_MUST_NEVER_APPEAR",
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: "Files.ReadWrite User.Read offline_access",
  });
  const stub = {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const path = new URL(url).pathname;
      if (path === "/get-token") return Response.json({ ok: true, found: true, value: sealed });
      if (path === "/put-token") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sealed = String(body.sealed ?? sealed);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  };
  return {
    COOKIE_ENCRYPTION_KEY: secret,
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
    ...extra,
  } as Env;
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

test("Graph request retries 429 Retry-After, 503, and network failures", async () => {
  const env = await fakeEnv();
  const original = globalThis.fetch;
  try {
    for (const mode of ["429", "503", "network"] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          if (mode === "network") throw new TypeError("socket reset https://secret.invalid/token");
          return jsonResponse(
            { error: { code: mode === "429" ? "TooManyRequests" : "ServiceUnavailable" } },
            Number(mode),
            mode === "429" ? { "Retry-After": "0" } : {},
          );
        }
        return jsonResponse({ value: [1] }, 200, { "request-id": "request-ok" });
      }) as typeof fetch;
      const response = await reliableGraphResponse(env, "user", "/me/drive/root", {}, {
        operation: `test.${mode}`,
        endpointCategory: "root_metadata",
        maxAttempts: 2,
        timeoutMs: 500,
      });
      assert.equal(response.status, 200);
      assert.equal(calls, 2);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("retry exhaustion preserves terminal status and permanent 401/403 are not graph_unreachable", async () => {
  const env = await fakeEnv();
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ error: { code: "ServiceUnavailable" } }, 503);
    }) as typeof fetch;
    await assert.rejects(
      reliableGraphResponse(env, "user", "/me/drive/root", {}, {
        operation: "test.exhaust",
        endpointCategory: "root_metadata",
        maxAttempts: 2,
        timeoutMs: 500,
      }),
      (error: unknown) => error instanceof ConnectorError && error.code === "graph_transient_failure" && error.status === 503,
    );
    assert.equal(calls, 2);

    for (const [status, code] of [[401, "authentication_required"], [403, "graph_forbidden"]] as const) {
      calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return jsonResponse({ error: { code: "Denied" } }, status);
      }) as typeof fetch;
      await assert.rejects(
        reliableGraphResponse(env, "user", "/me/drive/root", {}, {
          operation: `test.${status}`,
          endpointCategory: "root_metadata",
          maxAttempts: 4,
          timeoutMs: 500,
        }),
        (error: unknown) => error instanceof ConnectorError && error.code === code && error.code !== "graph_unreachable",
      );
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("structured Graph logs are sanitized", async () => {
  const env = await fakeEnv();
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs: string[] = [];
  try {
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    globalThis.fetch = (async () => jsonResponse({ value: [] }, 200, { "request-id": "ms-request" })) as typeof fetch;
    await reliableGraphResponse(env, "user", "/me/drive/items/VERY_SECRET_ITEM_ID", {}, {
      operation: "test.logs",
      endpointCategory: "item_metadata",
      pathContext: "Legal/example.docx",
      maxAttempts: 1,
      timeoutMs: 500,
    });
    const output = logs.join("\n");
    assert.match(output, /clientRequestId/);
    assert.match(output, /endpointCategory/);
    assert.doesNotMatch(output, /ACCESS_TOKEN_MUST_NEVER_APPEAR|REFRESH_TOKEN_MUST_NEVER_APPEAR|VERY_SECRET_ITEM_ID|graph\.microsoft\.com|Authorization/i);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

function seedSnapshot(storage: MemoryStorage, rootCTag = "root-c1"): { jobId: string; snapshotId: string } {
  const jobId = crypto.randomUUID();
  const snapshotId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const input = {
    scopePath: "UCA/Modules/03_Source_Library",
    recursive: true,
    includeFiles: true,
    includeFolders: true,
    calculateSha256: false,
    calculateNormalizedTextHash: false,
    includeDocumentMetadata: false,
    includeExtractionStatus: true,
    maximumItems: 100,
    maximumDepth: 64,
  };
  storage.values.set(`integrated:job:${jobId}`, {
    jobId,
    type: "source_snapshot",
    status: "queued",
    progress: 0,
    currentStage: "queued",
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    resultReferences: { snapshotId },
    error: null,
  });
  storage.values.set(`integrated:snapshot:${snapshotId}:meta`, {
    snapshotId,
    scopePath: input.scopePath,
    createdAt,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    rootItemId: "root",
    rootETag: "root-e1",
    rootCTag,
    totalFiles: 0,
    totalFolders: 0,
    totalRecords: 0,
    complete: false,
    options: input,
    errors: [],
    jobId,
  });
  storage.values.set(`integrated:snapshot:${snapshotId}:checkpoint`, {
    version: 1,
    snapshotId,
    jobId,
    userId: "user",
    input,
    queue: [{ itemId: "root", relativePath: input.scopePath, depth: 0 }],
    recordIndex: 0,
    totalFiles: 0,
    totalFolders: 0,
    pageNumber: 0,
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
  });
  return { jobId, snapshotId };
}

function snapshotFetchRouter(rootCTag = "root-c1") {
  let active = 0;
  let maxActive = 0;
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      if (path.includes("/items/root/children")) return jsonResponse({
        value: [
          { id: "legal", name: "Legal", folder: { childCount: 1 }, parentReference: { id: "root" }, eTag: "legal-e1", cTag: "legal-c1" },
          { id: "root-file", name: "root.txt", size: 4, file: { mimeType: "text/plain" }, parentReference: { id: "root" }, eTag: "rf-e1" },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/test-next?page=2",
      }, 200, { "request-id": "page-1" });
      if (path.includes("/test-next?page=2")) return jsonResponse({
        value: [
          { id: "academic", name: "Academic", folder: { childCount: 1 }, parentReference: { id: "root" }, eTag: "academic-e1", cTag: "academic-c1" },
          { id: "donor", name: "Donor", folder: { childCount: 1 }, parentReference: { id: "root" }, eTag: "donor-e1", cTag: "donor-c1" },
        ],
      }, 200, { "request-id": "page-2" });
      if (path.includes("/items/legal/children")) return jsonResponse({
        value: [{ id: "legal-file", name: "law.pdf", size: 10, file: { mimeType: "application/pdf" }, parentReference: { id: "legal" }, eTag: "lf-e1" }],
      });
      if (path.includes("/items/academic/children")) return jsonResponse({
        value: [{ id: "academic-file", name: "paper.docx", size: 10, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, parentReference: { id: "academic" }, eTag: "af-e1" }],
      });
      if (path.includes("/items/donor/children")) return jsonResponse({
        value: [{ id: "donor-file", name: "report.txt", size: 10, file: { mimeType: "text/plain" }, parentReference: { id: "donor" }, eTag: "df-e1" }],
      });
      if (path.includes("/items/root?") || path.endsWith("/items/root")) {
        return jsonResponse({ id: "root", eTag: "root-e1", cTag: rootCTag });
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    } finally {
      active -= 1;
    }
  };
  return { fetcher: fetcher as typeof fetch, maxActive: () => maxActive };
}

test("multi-page recursive enumeration checkpoints, resumes, advances progress, and completes without duplicates", async () => {
  const storage = new MemoryStorage();
  const { jobId, snapshotId } = seedSnapshot(storage);
  const env = await fakeEnv({ SNAPSHOT_STEP_ITEMS: "1" });
  const original = globalThis.fetch;
  const router = snapshotFetchRouter();
  const scheduled: Array<{ jobId: string; userId: string; delay: number }> = [];
  const progress: number[] = [];
  try {
    globalThis.fetch = router.fetcher;
    const schedule = async (id: string, userId: string, delay = 1) => {
      scheduled.push({ jobId: id, userId, delay });
    };
    for (let iteration = 0; iteration < 30; iteration += 1) {
      await continueSourceSnapshotJob({ env, userId: "user", storage }, schedule, jobId);
      const job = await storage.get<any>(`integrated:job:${jobId}`);
      progress.push(job.progress);
      const checkpoint = await storage.get<any>(`integrated:snapshot:${snapshotId}:checkpoint`);
      if (iteration === 0) {
        assert.equal(checkpoint.pageNumber, 1);
        assert.ok(checkpoint.activePage, "successful page was checkpointed");
        assert.ok(job.progress > 0, "job progress advanced beyond zero");
      }
      if (job.status === "completed") break;
    }
    const job = await storage.get<any>(`integrated:job:${jobId}`);
    const meta = await storage.get<any>(`integrated:snapshot:${snapshotId}:meta`);
    const records = [...(await storage.list<any>({ prefix: `integrated:snapshot:${snapshotId}:item:` })).values()];
    assert.equal(job.status, "completed");
    assert.equal(job.progress, 100);
    assert.equal(meta.complete, true);
    assert.equal(meta.totalFolders, 3);
    assert.equal(meta.totalFiles, 4);
    assert.equal(meta.totalRecords, 7);
    assert.equal(new Set(records.map((record) => record.itemId)).size, records.length);
    assert.ok(records.some((record) => record.relativePath.includes("Legal/law.pdf")));
    assert.ok(records.some((record) => record.relativePath.includes("Academic/paper.docx")));
    assert.ok(records.some((record) => record.relativePath.includes("Donor/report.txt")));
    assert.ok(progress.some((value) => value > 0 && value < 100));
    assert.ok(scheduled.length > 0);
    assert.equal(router.maxActive(), 1, "Graph concurrency remained bounded at one");
  } finally {
    globalThis.fetch = original;
  }
});

test("live root mutation fails closed and expired failed jobs are cleaned up", async () => {
  const storage = new MemoryStorage();
  const { jobId, snapshotId } = seedSnapshot(storage, "root-c1");
  const env = await fakeEnv({ SNAPSHOT_STEP_ITEMS: "50" });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = snapshotFetchRouter("root-c2").fetcher;
    const schedule = async () => undefined;
    for (let iteration = 0; iteration < 10; iteration += 1) {
      await continueSourceSnapshotJob({ env, userId: "user", storage }, schedule, jobId);
      const job = await storage.get<any>(`integrated:job:${jobId}`);
      if (job.status === "failed") break;
    }
    const failed = await storage.get<any>(`integrated:job:${jobId}`);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "snapshot_source_changed");

    failed.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await storage.put(`integrated:job:${jobId}`, failed);
    await assert.rejects(
      snapshotRepairTestHooks.cleanupExpired(storage, failed),
      (error: unknown) => error instanceof ConnectorError && error.code === "job_not_found",
    );
    assert.equal(await storage.get(`integrated:job:${jobId}`), undefined);
    assert.equal((await storage.list({ prefix: `integrated:snapshot:${snapshotId}:item:` })).size, 0);
  } finally {
    globalThis.fetch = original;
  }
});
