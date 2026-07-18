import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { validateRequiredConfiguration } from "./config";
import { asConnectorError, ConnectorError, logSafeError } from "./errors";
import {
  graphProfileWithToken,
  MICROSOFT_SCOPES,
  readiness,
  storeTokenRecord,
  TOKEN_ENDPOINT,
} from "./graph";
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
    li { margin: .35rem 0; }
    #status { margin-top: 1rem; min-height: 1.25rem; }
    #status[hidden] { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${htmlEscape(connectorName)}</h1>
    <p><strong>${htmlEscape(clientName)}</strong> requests Microsoft <strong>Files.ReadWrite</strong> access.</p>
    <p>The connector enforces a narrower application boundary: only items under the configured OneDrive folder <strong>${htmlEscape(rootName)}</strong> may be searched, read, visually analysed, retrieved, created, replaced, renamed, or moved.</p>
    <ul>
      <li>No deletion or recycle-bin tools.</li>
      <li>No sharing, anonymous links, permission changes, or cross-drive moves.</li>
      <li>No arbitrary binary upload or arbitrary Graph requests.</li>
    </ul>
    <p class="muted">Microsoft will show a fresh consent screen next.</p>
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
        button.textContent = "Opening Microsoft...";
        status.hidden = false;
        status.textContent = "Opening Microsoft... please wait and do not click again.";
        setTimeout(function () { button.disabled = true; }, 0);
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

async function authStateReady(env: Env): Promise<boolean> {
  try {
    const stub = env.AUTH_STATE.get(env.AUTH_STATE.idFromName("global"));
    const response = await stub.fetch("https://auth-state.internal/ready", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}

app.get("/", (c: any) =>
  c.json({
    name: c.env.CONNECTOR_NAME || "OneDrive Live MCP",
    mcp: "/mcp",
    authorization: "/authorize",
    access: "read-write within configured root",
    deletion: false,
    sharing: false,
    snapshotRequired: false,
  }),
);

app.get("/authorize", async (c: any) => {
  try {
    validateRequiredConfiguration(c.env);
    const oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    if (!oauthRequest.clientId) return c.text("Invalid OAuth client request", 400);
    const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    const { approvalId, csrfToken } = await createApproval(c.env, oauthRequest);
    const scriptNonce = crypto.randomUUID().replace(/-/g, "");
    const response = renderConsentPage(
      client?.clientName ?? "ChatGPT",
      approvalId,
      csrfToken,
      scriptNonce,
      c.env.CONNECTOR_NAME || "OneDrive Live MCP",
      c.env.ONEDRIVE_ROOT,
    );
    response.headers.append("Set-Cookie", secureCookie("__Host-MCP-CSRF", csrfToken, 600));
    logAuth("authorize_get_ready", {
      stage: "approval_stored",
      success: true,
      colo: requestColo(c.req.raw),
    });
    return response;
  } catch (error) {
    logSafeError("authorize_get_failed", error, { colo: requestColo(c.req.raw) });
    return c.text("Unable to start authorization", 503);
  }
});

app.post("/authorize", async (c: any) => {
  const colo = requestColo(c.req.raw);
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return c.text("Invalid authorization form", 400);
  }

  const approvalId = form.get("approval_id");
  const csrf = form.get("csrf_token");
  if (typeof approvalId !== "string" || typeof csrf !== "string") {
    return c.text("Invalid authorization form", 400);
  }
  const csrfMeta = classifyAuthorizeCsrf(c.req.raw, csrf);
  if (!csrfMeta.accepted) {
    logAuth("authorize_post_csrf_failed", { ...csrfMeta, colo, success: false });
    return c.text("CSRF validation failed", 400);
  }

  try {
    const approval = await consumeApproval(c.env, approvalId);
    if (!approval.request?.clientId) return c.text("Authorization request expired", 400);
    const { state, cookie } = await storeMicrosoftState(c.env, approval.request);
    const callback = new URL("/callback", c.req.url).href;
    const upstream = new URL(AUTHORIZE_ENDPOINT);
    upstream.searchParams.set("client_id", c.env.MICROSOFT_CLIENT_ID);
    upstream.searchParams.set("response_type", "code");
    upstream.searchParams.set("redirect_uri", callback);
    upstream.searchParams.set("response_mode", "query");
    upstream.searchParams.set("scope", MICROSOFT_SCOPES);
    upstream.searchParams.set("state", state);
    upstream.searchParams.set("prompt", "consent");

    const headers = new Headers({ Location: upstream.href });
    headers.append("Set-Cookie", clearCookie("__Host-MCP-CSRF"));
    headers.append("Set-Cookie", cookie);
    logAuth("authorize_post_redirecting", {
      stage: "redirect_to_microsoft",
      success: true,
      responseStatus: 302,
      redirectHostCategory: "login.microsoftonline.com",
      colo,
    });
    return new Response(null, { status: 302, headers });
  } catch (error) {
    logSafeError("authorize_post_failed", error, { colo });
    return c.text("Unable to start Microsoft authorization", 503);
  }
});

app.get("/callback", async (c: any) => {
  const url = new URL(c.req.url);
  const colo = requestColo(c.req.raw);
  const oauth = await consumeMicrosoftState(c.req.raw, c.env);
  if (!oauth.request?.clientId) {
    return c.text("OAuth state is invalid or expired", 400);
  }
  if (url.searchParams.get("error")) {
    logAuth("callback_microsoft_error", { stage: "microsoft_error", success: false, colo });
    return c.text("Microsoft authorization was not completed.", 400);
  }

  const code = url.searchParams.get("code");
  if (!code) return c.text("Microsoft did not return an authorization code", 400);
  const callback = new URL("/callback", c.req.url).href;
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(TOKEN_ENDPOINT, {
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
  } catch {
    const error = new ConnectorError("oauth_token_unreachable", "Microsoft token exchange is temporarily unavailable.", { retryable: true });
    logSafeError("callback_token_exchange_unreachable", error, { colo });
    return c.text("Microsoft token exchange is temporarily unavailable.", 503);
  }

  let tokenBody: Record<string, unknown> = {};
  try {
    tokenBody = (await tokenResponse.json()) as Record<string, unknown>;
  } catch {
    // Never expose or log the upstream body.
  }
  if (!tokenResponse.ok || !tokenBody.access_token) {
    const error = new ConnectorError("oauth_token_exchange_failed", "Microsoft token exchange failed.", {
      retryable: tokenResponse.status >= 500,
      status: tokenResponse.status,
    });
    logSafeError("callback_token_exchange_failed", error, { colo });
    return c.text("Microsoft token exchange failed.", tokenResponse.status >= 500 ? 503 : 400);
  }

  try {
    const accessToken = String(tokenBody.access_token);
    const profile = await graphProfileWithToken(accessToken);
    if (profile.id.toLocaleLowerCase("en") !== c.env.OWNER_MICROSOFT_ID.toLocaleLowerCase("en")) {
      logAuth("callback_owner_rejected", { stage: "owner_rejected", success: false, colo });
      return c.text("This Microsoft account is not authorized for this private connector.", 403);
    }

    await storeTokenRecord(c.env, profile.id, tokenBody);
    const email = profile.mail ?? profile.userPrincipalName ?? "";
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauth.request,
      userId: profile.id,
      metadata: { label: profile.displayName ?? "Authorized Microsoft account" },
      scope: oauth.request.scope,
      props: {
        userId: profile.id,
        displayName: profile.displayName ?? "Authorized Microsoft account",
        email,
      },
    });

    logAuth("callback_complete", { stage: "complete_authorization", success: true, colo });
    const headers = new Headers({ Location: redirectTo });
    headers.append("Set-Cookie", clearCookie("__Host-MS-OAUTH-STATE"));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    const safe = asConnectorError(error);
    logSafeError("callback_completion_failed", safe, { colo });
    return c.text(safe.message, safe.status && safe.status < 500 ? safe.status : 503);
  }
});

app.get("/health", (c: any) => c.json({ ok: true, service: "nikolay-onedrive-mcp" }));

app.get("/ready", async (c: any) => {
  try {
    validateRequiredConfiguration(c.env);
    const bindingsPresent = Boolean(
      c.env.AUTH_STATE && c.env.MCP_OBJECT && c.env.OAUTH_KV && c.env.AI && c.env.IMAGES && c.env.OAUTH_PROVIDER,
    );
    if (!bindingsPresent) throw new ConnectorError("binding_missing", "A required Worker binding is missing.");
    if (!(await authStateReady(c.env))) throw new ConnectorError("auth_state_unavailable", "OAuth state storage is unavailable.", { retryable: true });
    const graph = await readiness(c.env, c.env.OWNER_MICROSOFT_ID);
    return c.json({ bindings: true, authState: true, ...graph });
  } catch (error) {
    const safe = asConnectorError(error);
    logSafeError("readiness_failed", safe);
    return c.json(
      {
        ready: false,
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
          correlationId: safe.correlationId,
        },
      },
      503,
    );
  }
});

export { app as MicrosoftAuthHandler };
