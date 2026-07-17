import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryAuthStore } from "../src/auth-store.ts";
import { openJson, sealJson } from "../src/security.ts";

describe("AuthState-compatible storage", () => {
  it("approval write followed immediately by consume succeeds", () => {
    const store = new MemoryAuthStore();
    const id = "approval-1";
    const payload = JSON.stringify({ clientId: "chatgpt", scope: ["openid"] });
    store.put("approval", id, payload, Date.now() + 600_000);
    const first = store.consume("approval", id);
    assert.equal(first.ok, true);
    assert.equal(first.found, true);
    assert.equal(first.expired, false);
    assert.equal(first.value, payload);
  });

  it("approval can only be consumed once", () => {
    const store = new MemoryAuthStore();
    const id = "approval-once";
    store.put("approval", id, JSON.stringify({ clientId: "x" }), Date.now() + 600_000);
    assert.equal(store.consume("approval", id).ok, true);
    const second = store.consume("approval", id);
    assert.equal(second.ok, false);
    assert.equal(second.found, false);
    assert.equal(second.stage, "consume_approval_missing");
  });

  it("expired approval is rejected", () => {
    const store = new MemoryAuthStore();
    const id = "approval-expired";
    store.put("approval", id, JSON.stringify({ clientId: "x" }), Date.now() - 1);
    const result = store.consume("approval", id);
    assert.equal(result.ok, false);
    assert.equal(result.found, true);
    assert.equal(result.expired, true);
    assert.equal(store.consume("approval", id).found, false);
  });

  it("Microsoft state survives an immediate callback lookup", () => {
    const store = new MemoryAuthStore();
    const state = "ms-state-1";
    const payload = JSON.stringify({ clientId: "chatgpt" });
    store.put("ms-state", state, payload, Date.now() + 600_000);
    const result = store.consume("ms-state", state);
    assert.equal(result.ok, true);
    assert.equal(result.value, payload);
  });

  it("Microsoft state can only be consumed once", () => {
    const store = new MemoryAuthStore();
    const state = "ms-state-once";
    store.put("ms-state", state, JSON.stringify({ clientId: "x" }), Date.now() + 600_000);
    assert.equal(store.consume("ms-state", state).ok, true);
    const second = store.consume("ms-state", state);
    assert.equal(second.ok, false);
    assert.equal(second.found, false);
  });

  it("expired Microsoft state is rejected", () => {
    const store = new MemoryAuthStore();
    const state = "ms-state-expired";
    store.put("ms-state", state, JSON.stringify({ clientId: "x" }), Date.now() - 5);
    const result = store.consume("ms-state", state);
    assert.equal(result.ok, false);
    assert.equal(result.expired, true);
  });

  it("encrypted Microsoft token round-trip", async () => {
    const store = new MemoryAuthStore();
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const record = {
      accessToken: "access-token-value",
      refreshToken: "refresh-token-value",
      expiresAt: Date.now() + 3_600_000,
      scope: "Files.Read",
    };
    const sealed = await sealJson(secret, record);
    assert.match(sealed, /^v1\./);
    store.putToken("user-1", sealed);
    const got = store.getToken("user-1");
    assert.equal(got.ok, true);
    const opened = await openJson<typeof record>(secret, got.value!);
    assert.equal(opened.accessToken, record.accessToken);
    assert.equal(opened.refreshToken, record.refreshToken);
  });

  it("refreshed token replaces the prior token", async () => {
    const store = new MemoryAuthStore();
    const secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const first = await sealJson(secret, { accessToken: "a1", refreshToken: "r1", expiresAt: 1, scope: "s" });
    const second = await sealJson(secret, { accessToken: "a2", refreshToken: "r2", expiresAt: 2, scope: "s" });
    store.putToken("user-2", first);
    store.putToken("user-2", second);
    const opened = await openJson<{ accessToken: string }>(secret, store.getToken("user-2").value!);
    assert.equal(opened.accessToken, "a2");
  });

  it("duplicate consent submission does not produce a second authorization", () => {
    const store = new MemoryAuthStore();
    const id = "dup-approval";
    store.put("approval", id, JSON.stringify({ clientId: "chatgpt" }), Date.now() + 600_000);
    const first = store.consume("approval", id);
    const second = store.consume("approval", id);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.found, false);
  });
});
