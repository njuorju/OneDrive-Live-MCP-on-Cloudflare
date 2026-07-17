# Troubleshooting

## `CSRF validation failed`

- Close old consent/error tabs and start a fresh connector authorization.
- Confirm the deployed consent form uses a native POST to `/authorize`.
- Confirm the current source includes the same-origin `Sec-Fetch-Site`/Origin/Referer fallback.
- Do not disable server-side CSRF checks.

## `Authorization request expired`

This usually indicates OAuth state was not available to the next request.

- Confirm the `AUTH_STATE` Durable Object binding exists.
- Confirm the `v2` migration for `AuthState` was deployed.
- Check `/health` for `"authState": true`.
- Do not move one-time state back to Workers KV; KV is not appropriate for immediate write-then-read state.

## Consent page remains on `Opening Microsoft...`

Open browser developer tools and inspect the Network tab.

Expected:

```text
POST /authorize -> 302
login.microsoftonline.com/... -> navigation
```

The consent-page CSP intentionally has no `form-action` directive because some browsers enforce it across the Microsoft redirect chain. Other restrictions remain in place.

## Microsoft redirect URI mismatch

The Entra Web redirect URI must exactly equal:

```text
https://your-worker.your-subdomain.workers.dev/callback
```

Check scheme, hostname, and path. Do not use `/mcp` as the Microsoft callback.

## Invalid Microsoft client

Confirm that `MICROSOFT_CLIENT_SECRET` contains the client-secret **Value**, not its Secret ID.

## Account rejected

The signed-in Microsoft account ID must exactly match the `OWNER_MICROSOFT_ID` Worker secret. Obtain the ID using Microsoft Graph `/me` while signed in as the OneDrive owner.

## Allowed root not found

- Use the exact OneDrive folder name or nested path.
- The path is relative to the OneDrive root.
- Do not include a leading slash.
- Check Unicode characters and spacing.

## Search misses a new file

Search is live but depends on Microsoft OneDrive indexing. List the folder directly to verify that the file exists, then retry content search later.

## Unsupported or oversized file

- Increase `MAX_FILE_MB` cautiously and redeploy.
- Check whether the extension is in the direct or Workers AI conversion lists.
- Large or complex conversions may exceed Cloudflare execution or product limits.

## Connector works in one ChatGPT conversation but not another

Developer connector support can be conversation-runtime dependent. Start a fresh conversation and explicitly enable the connector before assuming the Worker is broken.

## Logs

Run:

```powershell
npm run tail
```

OAuth logging intentionally records stages and safe categories only. Do not add raw cookies, OAuth state, PKCE values, authorization codes, access tokens, refresh tokens, or client secrets to logs.
