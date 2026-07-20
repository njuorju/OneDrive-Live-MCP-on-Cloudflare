import assert from "node:assert/strict";
import test from "node:test";
import {
  createIntegratedStateStorage,
  pageClipGeometry,
  pdfPageDimensions,
} from "../src/version20-hotfix";

function fakeEnv(): Env {
  const records = new Map<string, unknown>();
  const stub = {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const key = String(body.key ?? "");
      if (path === "/state-put") {
        records.set(key, body.value);
        return Response.json({ ok: true, found: true, stage: "state_put_ok" });
      }
      if (path === "/state-get") {
        return records.has(key)
          ? Response.json({ ok: true, found: true, value: records.get(key), stage: "state_get_ok" })
          : Response.json({ ok: true, found: false, stage: "state_get_missing" });
      }
      if (path === "/state-delete") {
        const deleted = records.delete(key);
        return Response.json({ ok: true, found: deleted, deleted, stage: "state_delete_ok" });
      }
      if (path === "/state-list") {
        const prefix = String(body.prefix ?? "integrated:");
        const entries = [...records.entries()].filter(([entryKey]) => entryKey.startsWith(prefix));
        return Response.json({ ok: true, found: entries.length > 0, entries, stage: "state_list_ok" });
      }
      return Response.json({ ok: false, found: false, stage: "not_found" }, { status: 404 });
    },
  };
  return {
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    },
  } as unknown as Env;
}

test("integrated state survives independent storage adapters", async () => {
  const env = fakeEnv();
  const first = createIntegratedStateStorage(env, "user-1");
  const second = createIntegratedStateStorage(env, "user-1");

  await first.put("integrated:job:abc", { status: "completed" });
  assert.deepEqual(await second.get("integrated:job:abc"), { status: "completed" });
  assert.deepEqual(
    [...(await second.list({ prefix: "integrated:job:" })).keys()],
    ["integrated:job:abc"],
  );
  assert.equal(await second.delete("integrated:job:abc"), true);
  assert.equal(await first.get("integrated:job:abc"), undefined);
});

test("requested PDF page selects its own page box", () => {
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj << /MediaBox [0 0 960 540] >>\n2 0 obj << /CropBox [0 0 595 842] >>",
  );
  assert.deepEqual(pdfPageDimensions(bytes.buffer, 1), { width: 960, height: 540 });
  assert.deepEqual(pdfPageDimensions(bytes.buffer, 2), { width: 595, height: 842 });
});

test("page clip isolates one 16:9 slide without the next page", () => {
  const geometry = pageClipGeometry({ width: 960, height: 540 }, 1_600, 900);
  assert.deepEqual(geometry, {
    viewerWidth: 1_600,
    viewerHeight: 900,
    clip: { x: 160, y: 3, width: 1_280, height: 720 },
  });
});
