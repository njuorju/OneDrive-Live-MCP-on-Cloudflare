import { DurableObject } from "cloudflare:workers";
import {
  getTokenEnvelope,
  keyFor,
  putTokenEnvelope,
  type AuthStateKind,
  type AuthStateOpResult,
  type StoredEnvelope,
} from "./auth-store";

type RenderCacheEntry = {
  bytes: ArrayBuffer;
  expiresAt: number;
};

const RENDER_CACHE_MAX_BYTES = 25 * 1024 * 1024;
const RENDER_ID_PATTERN = /^[0-9a-zA-Z-]{1,200}$/;

/**
 * Strongly consistent OAuth/session and integrated-workflow storage.
 * Single global instance via idFromName("global").
 * DO request serialization makes put/get/consume atomic without KV eventual consistency.
 */
export class AuthState extends DurableObject {
  private readonly renderCache = new Map<string, RenderCacheEntry>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return Response.json(
        { ok: false, found: false, expired: false, stage: "method_not_allowed" },
        { status: 405 },
      );
    }

    if (url.pathname === "/render-cache-put") {
      return this.putRenderCache(request);
    }
    if (url.pathname === "/render-cache-get") {
      return this.getRenderCache(request);
    }
    if (url.pathname === "/render-cache-delete") {
      return this.deleteRenderCache(request);
    }

    if (url.pathname === "/ready") {
      try {
        await this.ctx.storage.get("__readiness_probe__");
        return Response.json({ ok: true, stage: "ready" });
      } catch {
        return Response.json({ ok: false, stage: "storage_unavailable" }, { status: 503 });
      }
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { ok: false, found: false, expired: false, stage: "invalid_json" },
        { status: 400 },
      );
    }

    switch (url.pathname) {
      case "/put":
        return Response.json(await this.putRecord(body));
      case "/consume":
        return Response.json(await this.consumeRecord(body));
      case "/put-token":
        return Response.json(await this.putToken(body));
      case "/get-token":
        return Response.json(await this.getToken(body));
      case "/state-get":
        return Response.json(await this.getState(body));
      case "/state-put":
        return Response.json(await this.putState(body));
      case "/state-delete":
        return Response.json(await this.deleteState(body));
      case "/state-list":
        return Response.json(await this.listState(body));
      default:
        return Response.json(
          { ok: false, found: false, expired: false, stage: "not_found" },
          { status: 404 },
        );
    }
  }

  private cleanupRenderCache(now = Date.now()): void {
    for (const [id, entry] of this.renderCache) {
      if (entry.expiresAt <= now) this.renderCache.delete(id);
    }
  }

  private renderId(request: Request): string | null {
    const id = request.headers.get("x-render-id") ?? "";
    return RENDER_ID_PATTERN.test(id) ? id : null;
  }

  private async putRenderCache(request: Request): Promise<Response> {
    this.cleanupRenderCache();
    const id = this.renderId(request);
    const expiresAt = Number(request.headers.get("x-render-expires-at"));
    if (
      !id ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 5 * 60_000
    ) {
      return Response.json({ ok: false, found: false, stage: "render_cache_put_invalid" }, {
        status: 400,
      });
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 5 || bytes.byteLength > RENDER_CACHE_MAX_BYTES) {
      return Response.json({ ok: false, found: false, stage: "render_cache_size_invalid" }, {
        status: 413,
      });
    }
    const signature = new TextDecoder("latin1").decode(bytes.slice(0, 5));
    if (signature !== "%PDF-") {
      return Response.json({ ok: false, found: false, stage: "render_cache_signature_invalid" }, {
        status: 415,
      });
    }
    this.renderCache.set(id, { bytes: bytes.slice(0), expiresAt });
    return Response.json({
      ok: true,
      found: true,
      byteSize: bytes.byteLength,
      stage: "render_cache_put_ok",
    });
  }

  private getRenderCache(request: Request): Response {
    this.cleanupRenderCache();
    const id = this.renderId(request);
    if (!id) {
      return Response.json({ ok: false, found: false, stage: "render_cache_get_invalid" }, {
        status: 400,
      });
    }
    const entry = this.renderCache.get(id);
    if (!entry) {
      return Response.json({ ok: true, found: false, stage: "render_cache_get_missing" }, {
        status: 404,
      });
    }
    return new Response(entry.bytes.slice(0), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(entry.bytes.byteLength),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  private deleteRenderCache(request: Request): Response {
    this.cleanupRenderCache();
    const id = this.renderId(request);
    if (!id) {
      return Response.json({ ok: false, found: false, stage: "render_cache_delete_invalid" }, {
        status: 400,
      });
    }
    const deleted = this.renderCache.delete(id);
    return Response.json({
      ok: true,
      found: deleted,
      deleted,
      stage: "render_cache_delete_ok",
    });
  }

  private async putRecord(body: Record<string, unknown>): Promise<AuthStateOpResult> {
    const kind = body.kind as AuthStateKind;
    const id = String(body.id ?? "");
    const value = String(body.value ?? "");
    const expiresAt =
      body.expiresAt === null || body.expiresAt === undefined
        ? null
        : Number(body.expiresAt);
    if (!kind || !id || !value || (expiresAt !== null && !Number.isFinite(expiresAt))) {
      return { ok: false, found: false, expired: false, stage: "put_invalid" };
    }
    const envelope: StoredEnvelope = { kind, value, expiresAt };
    await this.ctx.storage.put(keyFor(kind, id), envelope);
    return { ok: true, found: true, expired: false, stage: `put_${kind}` };
  }

  private async consumeRecord(body: Record<string, unknown>): Promise<AuthStateOpResult> {
    const kind = body.kind as Exclude<AuthStateKind, "ms-token">;
    const id = String(body.id ?? "");
    if ((kind !== "approval" && kind !== "ms-state") || !id) {
      return { ok: false, found: false, expired: false, stage: "consume_invalid" };
    }
    const key = keyFor(kind, id);
    const envelope = await this.ctx.storage.get<StoredEnvelope>(key);
    if (!envelope) {
      return { ok: false, found: false, expired: false, stage: `consume_${kind}_missing` };
    }
    await this.ctx.storage.delete(key);
    if (envelope.expiresAt !== null && envelope.expiresAt <= Date.now()) {
      return { ok: false, found: true, expired: true, stage: `consume_${kind}_expired` };
    }
    return {
      ok: true,
      found: true,
      expired: false,
      value: envelope.value,
      stage: `consume_${kind}_ok`,
    };
  }

  private integratedStateKey(userId: string, key: string): string | null {
    if (
      !userId ||
      !key ||
      !key.startsWith("integrated:") ||
      key.length > 1_200 ||
      /[\u0000-\u001f]/.test(key)
    ) {
      return null;
    }
    return `integrated-state:${userId}:${key}`;
  }

  private async getState(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = String(body.userId ?? "");
    const logicalKey = String(body.key ?? "");
    const key = this.integratedStateKey(userId, logicalKey);
    if (!key) return { ok: false, found: false, stage: "state_get_invalid" };
    const value = await this.ctx.storage.get(key);
    return value === undefined
      ? { ok: true, found: false, stage: "state_get_missing" }
      : { ok: true, found: true, value, stage: "state_get_ok" };
  }

  private async putState(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = String(body.userId ?? "");
    const logicalKey = String(body.key ?? "");
    const key = this.integratedStateKey(userId, logicalKey);
    if (!key || !("value" in body)) {
      return { ok: false, found: false, stage: "state_put_invalid" };
    }
    await this.ctx.storage.put(key, body.value);
    return { ok: true, found: true, stage: "state_put_ok" };
  }

  private async deleteState(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = String(body.userId ?? "");
    const logicalKey = String(body.key ?? "");
    const key = this.integratedStateKey(userId, logicalKey);
    if (!key) return { ok: false, found: false, stage: "state_delete_invalid" };
    const deleted = await this.ctx.storage.delete(key);
    return {
      ok: true,
      found: Boolean(deleted),
      deleted: Boolean(deleted),
      stage: "state_delete_ok",
    };
  }

  private async listState(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = String(body.userId ?? "");
    const logicalPrefix = String(body.prefix ?? "integrated:");
    const prefix = this.integratedStateKey(userId, logicalPrefix || "integrated:");
    if (!prefix) {
      return { ok: false, found: false, entries: [], stage: "state_list_invalid" };
    }
    const values = await this.ctx.storage.list({ prefix });
    const storagePrefix = `integrated-state:${userId}:`;
    return {
      ok: true,
      found: values.size > 0,
      entries: [...values.entries()].map(([key, value]) => [
        key.slice(storagePrefix.length),
        value,
      ]),
      stage: "state_list_ok",
    };
  }

  private async putToken(body: Record<string, unknown>): Promise<AuthStateOpResult> {
    const userId = String(body.userId ?? "");
    const sealed = String(body.sealed ?? "");
    if (!userId || !sealed) {
      return { ok: false, found: false, expired: false, stage: "put_token_invalid" };
    }
    const map = new Map<string, StoredEnvelope>();
    const result = putTokenEnvelope(map, userId, sealed);
    const envelope = map.get(keyFor("ms-token", userId));
    if (envelope) await this.ctx.storage.put(keyFor("ms-token", userId), envelope);
    return result;
  }

  private async getToken(body: Record<string, unknown>): Promise<AuthStateOpResult> {
    const userId = String(body.userId ?? "");
    if (!userId) {
      return { ok: false, found: false, expired: false, stage: "get_token_invalid" };
    }
    const envelope = await this.ctx.storage.get<StoredEnvelope>(keyFor("ms-token", userId));
    const map = new Map<string, StoredEnvelope>();
    if (envelope) map.set(keyFor("ms-token", userId), envelope);
    return getTokenEnvelope(map, userId);
  }
}
