import type { AuthStateKind, AuthStateOpResult } from "./auth-store";

export const AUTH_STATE_INSTANCE = "global";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type { AuthStateKind, AuthStateOpResult };

export function getAuthStateStub(env: Env): DurableObjectStub {
  return env.AUTH_STATE.get(env.AUTH_STATE.idFromName(AUTH_STATE_INSTANCE));
}

async function callAuthState(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<AuthStateOpResult> {
  if (!env.AUTH_STATE) {
    return {
      ok: false,
      found: false,
      expired: false,
      stage: "authstate_binding_missing",
    };
  }
  try {
    const stub = getAuthStateStub(env);
    const response = await stub.fetch(`https://auth-state.internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return {
        ok: false,
        found: false,
        expired: false,
        stage: `authstate_http_${response.status}`,
      };
    }
    return (await response.json()) as AuthStateOpResult;
  } catch {
    return {
      ok: false,
      found: false,
      expired: false,
      stage: "authstate_invoke_failed",
    };
  }
}

export async function authStatePut(
  env: Env,
  kind: AuthStateKind,
  id: string,
  value: string,
  expiresAt: number | null,
): Promise<AuthStateOpResult> {
  return callAuthState(env, "/put", { kind, id, value, expiresAt });
}

export async function authStateConsume(
  env: Env,
  kind: Exclude<AuthStateKind, "ms-token">,
  id: string,
): Promise<AuthStateOpResult> {
  return callAuthState(env, "/consume", { kind, id });
}

export async function authStateGetToken(
  env: Env,
  userId: string,
): Promise<AuthStateOpResult> {
  return callAuthState(env, "/get-token", { userId });
}

export async function authStatePutToken(
  env: Env,
  userId: string,
  sealed: string,
): Promise<AuthStateOpResult> {
  return callAuthState(env, "/put-token", { userId, sealed });
}
