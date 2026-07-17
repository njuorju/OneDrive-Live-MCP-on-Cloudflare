import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyAuthorizeCsrf,
  isSameOriginFormPost,
} from "../src/security.ts";

const ORIGIN = "https://onedrive-live-mcp.example.workers.dev";
const PATH = `${ORIGIN}/authorize`;

function post(headers: Record<string, string> = {}, cookie?: string): Request {
  const allHeaders: Record<string, string> = { ...headers };
  if (cookie) allHeaders.Cookie = cookie;
  return new Request(PATH, { method: "POST", headers: allHeaders });
}

describe("isSameOriginFormPost", () => {
  it("accepts exact matching Origin", () => {
    assert.equal(
      isSameOriginFormPost(post({ Origin: ORIGIN })),
      true,
    );
  });

  it("accepts exact same-origin Referer when Origin is absent", () => {
    assert.equal(
      isSameOriginFormPost(post({ Referer: `${ORIGIN}/authorize?x=1` })),
      true,
    );
  });

  it("accepts browser-controlled Sec-Fetch-Site: same-origin", () => {
    assert.equal(
      isSameOriginFormPost(post({ "Sec-Fetch-Site": "same-origin" })),
      true,
    );
  });

  it("treats Origin: null as unavailable and falls through to Referer", () => {
    assert.equal(
      isSameOriginFormPost(
        post({
          Origin: "null",
          Referer: `${ORIGIN}/authorize`,
        }),
      ),
      true,
    );
    assert.equal(
      isSameOriginFormPost(post({ Origin: "null" })),
      false,
    );
  });

  it("rejects cross-site Origin", () => {
    assert.equal(
      isSameOriginFormPost(post({ Origin: "https://evil.example" })),
      false,
    );
  });

  it("rejects cross-site Sec-Fetch-Site", () => {
    assert.equal(
      isSameOriginFormPost(
        post({
          "Sec-Fetch-Site": "cross-site",
          Origin: ORIGIN,
          Referer: `${ORIGIN}/authorize`,
        }),
      ),
      false,
    );
  });

  it("rejects arbitrary missing-header POST requests", () => {
    assert.equal(isSameOriginFormPost(post()), false);
  });

  it("rejects non-POST methods", () => {
    assert.equal(
      isSameOriginFormPost(new Request(PATH, { method: "GET", headers: { Origin: ORIGIN } })),
      false,
    );
  });
});

describe("classifyAuthorizeCsrf", () => {
  it("accepts valid CSRF cookie and form token", () => {
    const token = "csrf-token-value";
    const meta = classifyAuthorizeCsrf(
      post({}, `__Host-MCP-CSRF=${token}`),
      token,
    );
    assert.equal(meta.cookieTokenMatch, true);
    assert.equal(meta.accepted, true);
    assert.equal(meta.csrfCookiePresent, true);
    assert.equal(meta.csrfFieldPresent, true);
  });

  it("accepts same-origin Sec-Fetch-Site fallback without cookie", () => {
    const meta = classifyAuthorizeCsrf(
      post({ "Sec-Fetch-Site": "same-origin" }),
      "form-token",
    );
    assert.equal(meta.cookieTokenMatch, false);
    assert.equal(meta.sameOriginSubmission, true);
    assert.equal(meta.accepted, true);
    assert.equal(meta.secFetchSite, "same-origin");
  });

  it("accepts exact same-origin Referer fallback", () => {
    const meta = classifyAuthorizeCsrf(
      post({ Referer: `${ORIGIN}/authorize` }),
      "form-token",
    );
    assert.equal(meta.refererCategory, "same-origin");
    assert.equal(meta.accepted, true);
  });

  it("rejects cross-site Origin without matching cookie", () => {
    const meta = classifyAuthorizeCsrf(
      post({ Origin: "https://chatgpt.com" }),
      "form-token",
    );
    assert.equal(meta.originCategory, "cross-origin");
    assert.equal(meta.accepted, false);
  });

  it("rejects cross-site Sec-Fetch-Site without matching cookie", () => {
    const meta = classifyAuthorizeCsrf(
      post({ "Sec-Fetch-Site": "cross-site", Origin: ORIGIN }),
      "form-token",
    );
    assert.equal(meta.secFetchSite, "cross-site");
    assert.equal(meta.accepted, false);
  });

  it("rejects mismatched cookie token", () => {
    const meta = classifyAuthorizeCsrf(
      post({}, "__Host-MCP-CSRF=other-token"),
      "form-token",
    );
    assert.equal(meta.cookieTokenMatch, false);
    assert.equal(meta.accepted, false);
  });

  it("marks Origin null without treating it as accepted by itself", () => {
    const meta = classifyAuthorizeCsrf(post({ Origin: "null" }), "form-token");
    assert.equal(meta.originCategory, "null");
    assert.equal(meta.accepted, false);
  });
});
