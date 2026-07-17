import { DurableObject } from "cloudflare:workers";
import {
  getTokenEnvelope,
  keyFor,
  putTokenEnvelope,
  type AuthStateKind,
  type AuthStateOpResult,
  type StoredEnvelope,
} from "./auth-store";

/**
 * Strongly consistent OAuth/session storage.
 * Single global instance via idFromName("global").
 * DO request serialization makes put/get/consume atomic without KV eventual consistency.
 */
export class AuthState extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json(
        { ok: false, found: false, expired: false, stage: "method_not_allowed" },
        { status: 405 },
      );
    }

    const url = new URL(request.url);
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
      default:
        return Response.json(
          { ok: false, found: false, expired: false, stage: "not_found" },
          { status: 404 },
        );
    }
  }

  private async putRecord(body: Record<string, unknown>): Promise<AuthStateOpResult> {
    const kind = body.kind as AuthStateKind;
    const id = String(body.id ?? "");
    const value = String(body.value ?? "");
    const expiresAt =
      body.expiresAt === null || body.expiresAt === undefined
        ? null
        : Number(body.expiresAt);
    if (!kind || !id || !value) {
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
