import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
  authStateConsume,
  authStatePut,
  OAUTH_STATE_TTL_MS,
} from "./auth-state-client";

const APPROVAL_TTL_SECONDS = 600;

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }
  return null;
}

export function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
  return secureCookie(name, "", 0);
}

export function isSameOriginFormPost(request: Request): boolean {
  if (request.method.toUpperCase() !== "POST") return false;

  const expectedOrigin = new URL(request.url).origin;

  // Fetch Metadata headers are browser-controlled and survive privacy settings
  // that can suppress Origin and Referer on ordinary form submissions.
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite === "same-origin") return true;
  if (fetchSite === "cross-site") return false;

  const origin = request.headers.get("Origin");
  if (origin && origin !== "null") return origin === expectedOrigin;

  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export type AuthorizeCsrfMeta = {
  method: string;
  path: string;
  originCategory: "missing" | "null" | "same-origin" | "cross-origin";
  refererCategory: "missing" | "same-origin" | "cross-origin" | "invalid";
  secFetchSite: string | null;
  csrfCookiePresent: boolean;
  csrfFieldPresent: boolean;
  cookieTokenMatch: boolean;
  sameOriginSubmission: boolean;
  accepted: boolean;
};

export function classifyAuthorizeCsrf(
  request: Request,
  formCsrf: string | null,
): AuthorizeCsrfMeta {
  const url = new URL(request.url);
  const expectedOrigin = url.origin;
  const origin = request.headers.get("Origin");
  let originCategory: AuthorizeCsrfMeta["originCategory"] = "missing";
  if (origin === "null") originCategory = "null";
  else if (origin) originCategory = origin === expectedOrigin ? "same-origin" : "cross-origin";

  const referer = request.headers.get("Referer");
  let refererCategory: AuthorizeCsrfMeta["refererCategory"] = "missing";
  if (referer) {
    try {
      refererCategory =
        new URL(referer).origin === expectedOrigin ? "same-origin" : "cross-origin";
    } catch {
      refererCategory = "invalid";
    }
  }

  const csrfCookie = getCookie(request, "__Host-MCP-CSRF");
  const csrfFieldPresent = typeof formCsrf === "string" && formCsrf.length > 0;
  const cookieTokenMatch = Boolean(csrfCookie) && csrfCookie === formCsrf;
  const sameOriginSubmission = isSameOriginFormPost(request);
  return {
    method: request.method.toUpperCase(),
    path: url.pathname,
    originCategory,
    refererCategory,
    secFetchSite: request.headers.get("Sec-Fetch-Site"),
    csrfCookiePresent: Boolean(csrfCookie),
    csrfFieldPresent,
    cookieTokenMatch,
    sameOriginSubmission,
    accepted: cookieTokenMatch || sameOriginSubmission,
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importEncryptionKey(secret: string): Promise<CryptoKey> {
  const trimmed = secret.trim();
  let raw: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    raw = Uint8Array.from(trimmed.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  } else {
    raw = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(trimmed)),
    );
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealJson(secret: string, value: unknown): Promise<string> {
  const key = await importEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("onedrive-live-mcp:v1") },
      key,
      plaintext,
    ),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

export async function openJson<T>(secret: string, sealed: string): Promise<T> {
  const [version, ivEncoded, ciphertextEncoded] = sealed.split(".");
  if (version !== "v1" || !ivEncoded || !ciphertextEncoded) {
    throw new Error("Stored Microsoft authorization is invalid. Reconnect the plugin.");
  }
  const key = await importEncryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(ivEncoded) as BufferSource,
      additionalData: new TextEncoder().encode("onedrive-live-mcp:v1"),
    },
    key,
    base64UrlToBytes(ciphertextEncoded) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createApproval(
  env: Env,
  oauthRequest: AuthRequest,
): Promise<{ approvalId: string; csrfToken: string }> {
  const approvalId = crypto.randomUUID();
  const csrfToken = crypto.randomUUID();
  const result = await authStatePut(
    env,
    "approval",
    approvalId,
    JSON.stringify(oauthRequest),
    Date.now() + OAUTH_STATE_TTL_MS,
  );
  if (!result.ok) {
    throw new Error("Unable to store authorization request.");
  }
  return { approvalId, csrfToken };
}

export async function consumeApproval(
  env: Env,
  approvalId: string,
): Promise<{ request: AuthRequest | null; found: boolean; expired: boolean; stage: string }> {
  const result = await authStateConsume(env, "approval", approvalId);
  if (!result.ok || !result.value) {
    return {
      request: null,
      found: result.found,
      expired: result.expired,
      stage: result.stage,
    };
  }
  return {
    request: JSON.parse(result.value) as AuthRequest,
    found: true,
    expired: false,
    stage: result.stage,
  };
}

export async function storeMicrosoftState(
  env: Env,
  oauthRequest: AuthRequest,
): Promise<{ state: string; cookie: string }> {
  const state = crypto.randomUUID();
  const result = await authStatePut(
    env,
    "ms-state",
    state,
    JSON.stringify(oauthRequest),
    Date.now() + OAUTH_STATE_TTL_MS,
  );
  if (!result.ok) {
    throw new Error("Unable to store Microsoft OAuth state.");
  }
  const stateHash = await sha256Hex(state);
  return {
    state,
    cookie: secureCookie("__Host-MS-OAUTH-STATE", stateHash, APPROVAL_TTL_SECONDS),
  };
}

export async function consumeMicrosoftState(
  request: Request,
  env: Env,
): Promise<{ request: AuthRequest | null; found: boolean; expired: boolean; stage: string; cookieValid: boolean }> {
  const state = new URL(request.url).searchParams.get("state");
  if (!state) {
    return { request: null, found: false, expired: false, stage: "state_missing", cookieValid: false };
  }
  const expectedHash = getCookie(request, "__Host-MS-OAUTH-STATE");
  if (!expectedHash || (await sha256Hex(state)) !== expectedHash) {
    return { request: null, found: false, expired: false, stage: "state_cookie_mismatch", cookieValid: false };
  }

  const result = await authStateConsume(env, "ms-state", state);
  if (!result.ok || !result.value) {
    return {
      request: null,
      found: result.found,
      expired: result.expired,
      stage: result.stage,
      cookieValid: true,
    };
  }
  return {
    request: JSON.parse(result.value) as AuthRequest,
    found: true,
    expired: false,
    stage: result.stage,
    cookieValid: true,
  };
}

export function requestColo(request: Request): string | null {
  return request.cf && typeof request.cf === "object" && "colo" in request.cf
    ? String((request.cf as { colo?: string }).colo ?? "") || null
    : null;
}

export function normalizeRelativePath(path: string): string {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path traversal is not allowed.");
  }
  return segments.join("/");
}

export function encodeGraphPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function isPathInsideRoot(fullPath: string, rootName: string): boolean {
  let decoded = fullPath;
  try {
    decoded = decodeURIComponent(fullPath);
  } catch {
    // Microsoft paths should be valid URI text; retain the original if they are not.
  }
  const normalized = decoded.replace(/\\/g, "/").toLocaleLowerCase("ru");
  const marker = `/drive/root:/${rootName}`.toLocaleLowerCase("ru");
  return normalized === marker || normalized.startsWith(`${marker}/`);
}
