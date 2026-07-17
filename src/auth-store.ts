export type AuthStateKind = "approval" | "ms-state" | "ms-token";

export type StoredEnvelope = {
  kind: AuthStateKind;
  value: string;
  expiresAt: number | null;
};

export type AuthStateOpResult = {
  ok: boolean;
  found: boolean;
  expired: boolean;
  value?: string;
  stage: string;
};

export function keyFor(kind: AuthStateKind, id: string): string {
  return `${kind}:${id}`;
}

export function putEnvelope(
  records: Map<string, StoredEnvelope>,
  kind: AuthStateKind,
  id: string,
  value: string,
  expiresAt: number | null,
): AuthStateOpResult {
  records.set(keyFor(kind, id), { kind, value, expiresAt });
  return { ok: true, found: true, expired: false, stage: `put_${kind}` };
}

export function consumeEnvelope(
  records: Map<string, StoredEnvelope>,
  kind: Exclude<AuthStateKind, "ms-token">,
  id: string,
  now = Date.now(),
): AuthStateOpResult {
  const key = keyFor(kind, id);
  const envelope = records.get(key);
  if (!envelope) {
    return { ok: false, found: false, expired: false, stage: `consume_${kind}_missing` };
  }
  records.delete(key);
  if (envelope.expiresAt !== null && envelope.expiresAt <= now) {
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

export function putTokenEnvelope(
  records: Map<string, StoredEnvelope>,
  userId: string,
  sealed: string,
): AuthStateOpResult {
  records.set(keyFor("ms-token", userId), {
    kind: "ms-token",
    value: sealed,
    expiresAt: null,
  });
  return { ok: true, found: true, expired: false, stage: "put_token_ok" };
}

export function getTokenEnvelope(
  records: Map<string, StoredEnvelope>,
  userId: string,
): AuthStateOpResult {
  const envelope = records.get(keyFor("ms-token", userId));
  if (!envelope) {
    return { ok: false, found: false, expired: false, stage: "get_token_missing" };
  }
  return {
    ok: true,
    found: true,
    expired: false,
    value: envelope.value,
    stage: "get_token_ok",
  };
}

/** In-memory strongly consistent store for unit tests (mirrors AuthState semantics). */
export class MemoryAuthStore {
  private records = new Map<string, StoredEnvelope>();

  put(kind: AuthStateKind, id: string, value: string, expiresAt: number | null): AuthStateOpResult {
    return putEnvelope(this.records, kind, id, value, expiresAt);
  }

  consume(kind: Exclude<AuthStateKind, "ms-token">, id: string): AuthStateOpResult {
    return consumeEnvelope(this.records, kind, id);
  }

  putToken(userId: string, sealed: string): AuthStateOpResult {
    return putTokenEnvelope(this.records, userId, sealed);
  }

  getToken(userId: string): AuthStateOpResult {
    return getTokenEnvelope(this.records, userId);
  }
}
