import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getGraphAccessToken,
  getStoredTokenRecord,
} from "../src/graph-core.ts";
import { sealJson } from "../src/security.ts";
import type { TokenRecord } from "../src/types.ts";

const KEY = "c".repeat(64);

async function envFor(record: TokenRecord): Promise<Env> {
  const sealed = await sealJson(KEY, record);
  const stub = {
    fetch: async () => Response.json({
      ok: true,
      found: true,
      expired: false,
      value: sealed,
      stage: "get_token_ok",
    }),
  };
  return {
    COOKIE_ENCRYPTION_KEY: KEY,
    MICROSOFT_CLIENT_ID: "client",
    MICROSOFT_CLIENT_SECRET: "secret",
    AUTH_STATE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    },
  } as unknown as Env;
}

describe("OAuth authorization hardening", () => {
  it("rejects stored sessions that only contain stale Files.Read consent", async () => {
    const env = await envFor({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
      scope: "openid offline_access Files.Read User.Read",
    });
    await assert.rejects(
      getStoredTokenRecord(env, "owner"),
      (error: unknown) => Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "fresh_consent_required",
      ),
    );
  });

  it("sanitizes refresh failures and never exposes upstream bodies or tokens", { concurrency: false }, async () => {
    const env = await envFor({
      accessToken: "expired-access-token",
      refreshToken: "super-secret-refresh-token",
      expiresAt: Date.now() - 1_000,
      scope: "openid offline_access Files.ReadWrite User.Read",
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json(
      {
        error: "invalid_grant",
        error_description: "UPSTREAM SECRET DETAIL super-secret-refresh-token",
        correlation_id: "raw-upstream-correlation",
      },
      { status: 400 },
    )) as typeof fetch;
    try {
      await assert.rejects(getGraphAccessToken(env, "owner"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Reconnect the ChatGPT app/);
        assert.doesNotMatch(error.message, /UPSTREAM SECRET DETAIL|refresh-token|raw-upstream/);
        return true;
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("reports missing authentication without leaking storage details", async () => {
    const stub = {
      fetch: async () => Response.json({ ok: false, found: false, expired: false }),
    };
    const env = {
      COOKIE_ENCRYPTION_KEY: KEY,
      AUTH_STATE: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => stub as unknown as DurableObjectStub,
      },
    } as unknown as Env;
    await assert.rejects(
      getStoredTokenRecord(env, "owner"),
      (error: unknown) => Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "authentication_required",
      ),
    );
  });
});
