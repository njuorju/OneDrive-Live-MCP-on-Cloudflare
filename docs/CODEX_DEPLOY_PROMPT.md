# Optional Codex deployment prompt

Paste this into Codex from the repository root after replacing nothing in the prompt itself; Codex should ask for account-specific values only at the relevant interactive steps.

```text
Deploy this repository as a private, read-only Cloudflare remote MCP server for ChatGPT.

Read README.md, SECURITY.md, docs/DEPLOYMENT.md, wrangler.jsonc, package.json, and all files under src/ before changing anything.

Security requirements:
- Keep Microsoft Graph permissions limited to delegated Files.Read and User.Read.
- Do not add upload, overwrite, rename, move, share, or delete tools.
- Preserve all allowed-root path checks and the immutable Microsoft owner-ID check.
- Never print, commit, or store account-specific values in tracked files.
- Store MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, OWNER_MICROSOFT_ID, and COOKIE_ENCRYPTION_KEY with Wrangler secrets.
- Do not log cookies, OAuth state, PKCE values, authorization codes, access tokens, refresh tokens, client secrets, or document contents.
- Preserve the AuthState Durable Object and its existing migrations.
- Do not move one-time OAuth state to Workers KV.

Tasks:
1. Inspect the repository and report any security or configuration issue before deploying.
2. Run npm ci and npm run check.
3. Log in to Wrangler if needed.
4. Create the OAUTH_KV namespace and put its ID into wrangler.jsonc.
5. Ask me for the exact allowed OneDrive folder path and update ONEDRIVE_ROOT.
6. Ask whether converted-document caching should remain enabled. Set CACHE_TTL_SECONDS to 0 if I decline caching.
7. Bootstrap-deploy and report the exact Worker base URL, /mcp URL, and /callback URL.
8. Pause while I create or update the Microsoft Entra app, add the Web callback, retain Files.Read and User.Read, and create a client-secret Value.
9. Ask me to obtain the immutable Graph /me id for the OneDrive owner.
10. Set all four Wrangler secrets through interactive prompts without echoing their values.
11. Run npm run deploy and test /health.
12. Start wrangler tail with safe logs available.
13. Pause while I create and authorize the ChatGPT OAuth connector.
14. Verify onedrive_status, one live search, one folder listing, and one bounded file read.
15. Report files changed, Cloudflare resources created, URLs, test results, OAuth outcome, tool-discovery outcome, and remaining limitations.

Execute every non-interactive step. Stop only when I must use Microsoft, Cloudflare, or ChatGPT account UI.
```
