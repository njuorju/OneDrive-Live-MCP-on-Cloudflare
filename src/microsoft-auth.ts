import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { graphProfileWithToken, MICROSOFT_SCOPES, storeTokenRecord, TOKEN_ENDPOINT } from "./graph";
import {
  classifyAuthorizeCsrf,
  clearCookie,
  consumeApproval,
  consumeMicrosoftState,
  createApproval,
  htmlEscape,
  requestColo,
  secureCookie,
  storeMicrosoftState,
} from "./security";

const AUTHORIZE_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

function renderConsentPage(
  clientName: string,
  approvalId: string,
  csrfToken: string,
  scriptNonce: string,
  connectorName: string,
  rootName: string,
): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${htmlEscape(connectorName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 680px; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
    .card { border: 1px solid #ddd; border-radius: 14px; padding: 1.5rem; }
    button { font: inherit; padding: .7rem 1rem; border: 0; border-radius: 8px; cursor: pointer; }
    .approve { background: #111; color: white; }
    .approve:disabled { opacity: .7; cursor: wait; }
    .muted { color: #555; }
    #status { margin-top: 1rem; min-height: 1.25rem; }
    #status[hidden] { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${htmlEscape(connectorName)}</h1>
    <p><strong>${htmlEscape(clientName)}</strong> requests read-only access to tools that search and read files under the OneDrive folder <strong>${htmlEscape(rootName)}</strong>.</p>
    <p class="muted">The server cannot upload, edit, move, share, or delete files. Microsoft will show its own consent screen next.</p>
    <form id="consent-form" method="post" action="/authorize" accept-charset="utf-8">
      <input type="hidden" name="approval_id" value="${htmlEscape(approvalId)}">
      <input type="hidden" name="csrf_token" value="${htmlEscape(csrfToken)}">
      <button class="approve" id="continue-btn" type="submit">Continue to Microsoft</button>
    </form>
    <p class="muted" id="status" hidden aria-live="polite"></p>
  </div>
  <script nonce="${htmlEscape(scriptNonce)}">
    (function () {
      var form = document.getElementById("consent-form");
      var button = document.getElementById("continue-btn");
      var status = document.getElementById("status");
      if (!form || !button || !status) return;
      form.addEventListener("submit", function () {
        // Native form navigation only. No preventDefault, no fetch/XHR.
        // Disable after the browser has accepted the submit event so the POST is not cancelled.
        button.textContent = "Opening Microsoft...";
        status.hidden = false;
        status.textContent = "Opening Microsoft... please wait and do not click again.";
        setTimeout(function () {
          button.disabled = true;
        }, 0);
      });
    })();
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function logAuth(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

app.get("/", (c: any) =>
  c.json({
    name: c.env.CONNECTOR_NAME || "OneDrive Live MCP",
    mcp: "/mcp",
    authorization: "/authorize",
    readOnly: true,
    snapshotRequired: false,
  }),
);

app.get("/authorize", async (c: any) => {
  const oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthRequest.clientId) return c.text("Invalid OAuth client request", 400);

  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const { approvalId, csrfToken } = await createApproval(c.env, oauthRequest);
  const scriptNonce = crypto.randomUUID().replace(/-/g, "");
  logAuth("authorize_get_stored_approval", {
    method: "GET",
    path: "/authorize",
    stage: "approval_stored",
    found: true,
    expired: false,
    colo: requestColo(c.req.raw),
  });
  const response = renderConsentPage(
    client?.clientName ?? "ChatGPT",
    approvalId,
    csrfToken,
    scriptNonce,
    c.env.CONNECTOR_NAME || "OneDrive Live MCP",
    c.env.ONEDRIVE_ROOT,
  );
  response.headers.append(
    "Set-Cookie",
    secureCookie("__Host-MCP-CSRF", csrfToken, 600),
  );
  return response;
});

app.post("/authorize", async (c: any) => {
  const colo = requestColo(c.req.raw);
  logAuth("authorize_post_received", {
    method: "POST",
    path: "/authorize",
    stage: "post_received",
    colo,
  });

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    logAuth("authorize_post_form_parse_failed", {
      method: "POST",
      path: "/authorize",
      stage: "form_parse_failed",
      colo,
      success: false,
    });
    return c.text("Invalid authorization form", 400);
  }

  const approvalId = form.get("approval_id");
  const csrf = form.get("csrf_token");
  if (typeof approvalId !== "string" || typeof csrf !== "string") {
    logAuth("authorize_post_invalid_form", {
      method: "POST",
      path: "/authorize",
      stage: "invalid_form",
      approvalIdPresent: typeof approvalId === "string",
      csrfFieldPresent: typeof csrf === "string",
      colo,
    });
    return c.text("Invalid authorization form", 400);
  }
  const csrfMeta = classifyAuthorizeCsrf(c.req.raw, csrf);
  if (!csrfMeta.accepted) {
    logAuth("authorize_post_csrf_failed", { ...csrfMeta, colo, stage: "csrf_failed", success: false });
    return c.text("CSRF validation failed", 400);
  }

  let approval;
  try {
    approval = await consumeApproval(c.env, approvalId);
  } catch {
    logAuth("authorize_post_authstate_failed", {
      method: "POST",
      path: "/authorize",
      stage: "authstate_consume_failed",
      authStateOp: "consume_approval",
      colo,
      success: false,
    });
    return c.text("Authorization storage temporarily unavailable", 503);
  }
  if (!approval.request?.clientId) {
    logAuth("authorize_post_approval_failed", {
      ...csrfMeta,
      colo,
      stage: approval.stage,
      authStateOp: "consume_approval",
      found: approval.found,
      expired: approval.expired,
      success: false,
    });
    return c.text("Authorization request expired", 400);
  }

  let state: string;
  let cookie: string;
  try {
    ({ state, cookie } = await storeMicrosoftState(c.env, approval.request));
  } catch {
    logAuth("authorize_post_ms_state_failed", {
      method: "POST",
      path: "/authorize",
      stage: "ms_state_store_failed",
      authStateOp: "put_ms_state",
      colo,
      success: false,
    });
    return c.text("Unable to start Microsoft authorization", 503);
  }

  const callback = new URL("/callback", c.req.url).href;
  const upstream = new URL(AUTHORIZE_ENDPOINT);
  upstream.searchParams.set("client_id", c.env.MICROSOFT_CLIENT_ID);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("redirect_uri", callback);
  upstream.searchParams.set("response_mode", "query");
  upstream.searchParams.set("scope", MICROSOFT_SCOPES);
  upstream.searchParams.set("state", state);
  upstream.searchParams.set("prompt", "select_account");

  logAuth("authorize_post_redirecting", {
    method: "POST",
    path: "/authorize",
    stage: "redirect_to_microsoft",
    authStateOp: "put_ms_state",
    found: true,
    expired: false,
    success: true,
    responseStatus: 302,
    redirectHostCategory: "login.microsoftonline.com",
    colo,
  });

  const headers = new Headers({ Location: upstream.href });
  headers.append("Set-Cookie", clearCookie("__Host-MCP-CSRF"));
  headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
});

app.get("/callback", async (c: any) => {
  const url = new URL(c.req.url);
  const colo = requestColo(c.req.raw);
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    logAuth("callback_microsoft_error", {
      method: "GET",
      path: "/callback",
      stage: "microsoft_error",
      success: false,
      colo,
    });
    return c.text(
      `Microsoft authorization failed: ${url.searchParams.get("error_description") ?? upstreamError}`,
      400,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    logAuth("callback_missing_code", {
      method: "GET",
      path: "/callback",
      stage: "code_missing",
      success: false,
      colo,
    });
    return c.text("Microsoft did not return an authorization code", 400);
  }

  const oauth = await consumeMicrosoftState(c.req.raw, c.env);
  if (!oauth.request?.clientId) {
    logAuth("callback_state_failed", {
      method: "GET",
      path: "/callback",
      stage: oauth.stage,
      found: oauth.found,
      expired: oauth.expired,
      cookieValid: oauth.cookieValid,
      success: false,
      colo,
    });
    return c.text("OAuth state is invalid or expired", 400);
  }

  const callback = new URL("/callback", c.req.url).href;
  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.MICROSOFT_CLIENT_ID,
      client_secret: c.env.MICROSOFT_CLIENT_SECRET,
      code,
      redirect_uri: callback,
      grant_type: "authorization_code",
      scope: MICROSOFT_SCOPES,
    }),
  });
  const tokenBody = (await tokenResponse.json()) as Record<string, unknown>;
  if (!tokenResponse.ok || !tokenBody.access_token) {
    logAuth("callback_token_exchange_failed", {
      method: "GET",
      path: "/callback",
      stage: "token_exchange_failed",
      success: false,
      colo,
    });
    return c.text(
      `Microsoft token exchange failed: ${String(tokenBody.error_description ?? tokenBody.error ?? tokenResponse.status)}`,
      500,
    );
  }

  const accessToken = String(tokenBody.access_token);
  const profile = await graphProfileWithToken(accessToken);
  if (profile.id.toLocaleLowerCase("en") !== c.env.OWNER_MICROSOFT_ID.toLocaleLowerCase("en")) {
    logAuth("callback_owner_rejected", {
      method: "GET",
      path: "/callback",
      stage: "owner_rejected",
      success: false,
      colo,
    });
    return c.text("This Microsoft account is not authorized for this private connector.", 403);
  }

  await storeTokenRecord(c.env, profile.id, tokenBody);
  const email = profile.mail ?? profile.userPrincipalName ?? "";
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauth.request,
    userId: profile.id,
    metadata: { label: profile.displayName ?? email ?? profile.id },
    scope: oauth.request.scope,
    props: {
      userId: profile.id,
      displayName: profile.displayName ?? email ?? profile.id,
      email,
    },
  });

  logAuth("callback_complete", {
    method: "GET",
    path: "/callback",
    stage: "complete_authorization",
    found: true,
    expired: false,
    success: true,
    colo,
  });

  const headers = new Headers({ Location: redirectTo });
  headers.append("Set-Cookie", clearCookie("__Host-MS-OAUTH-STATE"));
  return new Response(null, { status: 302, headers });
});

app.get("/health", (c: any) => c.json({ ok: true, mcp: "/mcp", authState: true }));

export { app as MicrosoftAuthHandler };
