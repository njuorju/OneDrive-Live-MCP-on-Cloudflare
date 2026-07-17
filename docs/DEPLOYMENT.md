# Deployment guide

This guide deploys the connector as a Cloudflare Worker and connects it to ChatGPT as a remote OAuth MCP server.

## Prerequisites

- Node.js 22.18 or newer.
- A Cloudflare account with Workers, KV, Durable Objects, and Workers AI available.
- A personal Microsoft account with OneDrive.
- Access to Microsoft Entra app registrations.
- ChatGPT access to developer-mode custom connectors.

## 1. Install and authenticate Wrangler

```powershell
npm ci
npx wrangler login
```

## 2. Create the KV namespace

```powershell
npx wrangler kv namespace create OAUTH_KV
```

Copy the namespace ID into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

## 3. Configure the Worker

Edit the non-secret values in `wrangler.jsonc`:

```jsonc
"name": "your-unique-worker-name",
"vars": {
  "CONNECTOR_NAME": "OneDrive Live MCP",
  "ONEDRIVE_ROOT": "Work",
  "MAX_FILE_MB": "20",
  "MAX_READ_CHARS": "50000",
  "CACHE_TTL_SECONDS": "604800"
}
```

`ONEDRIVE_ROOT` may be a nested path such as `Work/Projects`. It is interpreted relative to the OneDrive root.

To avoid retaining converted document text in KV, set:

```jsonc
"CACHE_TTL_SECONDS": "0"
```

Validate the repository:

```powershell
npm run check
npm run verify-config
```

## 4. Bootstrap-deploy the Worker

The first deployment gives you the stable callback URL. Worker secrets can be added afterward.

```powershell
npx wrangler deploy
```

Wrangler prints a base URL similar to:

```text
https://your-worker.your-subdomain.workers.dev
```

The relevant URLs are:

```text
MCP endpoint:       https://your-worker.your-subdomain.workers.dev/mcp
Microsoft callback: https://your-worker.your-subdomain.workers.dev/callback
Health endpoint:    https://your-worker.your-subdomain.workers.dev/health
```

## 5. Create the Microsoft Entra application

In Microsoft Entra:

1. Open **App registrations** and create a registration.
2. Choose an account type that includes **personal Microsoft accounts**. Personal-only is sufficient for this connector.
3. Leave the initial redirect URI blank if the form permits it.
4. After registration, copy the **Application (client) ID**.

### Add the Web callback

Open **Authentication**, add the **Web** platform, and enter the exact callback URL:

```text
https://your-worker.your-subdomain.workers.dev/callback
```

Do not enable implicit-grant access-token or ID-token checkboxes.

### Add delegated Graph permissions

Under **API permissions**, retain only:

- `Files.Read`
- `User.Read`

Do not add write permissions.

### Create the client secret

Open **Certificates & secrets**, create a client secret, and immediately copy its **Value**. The Secret ID is not the usable secret.

## 6. Obtain the immutable Microsoft Graph user ID

The connector rejects every Microsoft account except the configured owner.

One straightforward method:

1. Sign in to Microsoft Graph Explorer with the OneDrive owner account.
2. Run:

   ```http
   GET https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName
   ```

3. Copy the `id` field.

Treat it as private account metadata even though it is not a password.

## 7. Set Worker secrets

Set the Microsoft application ID:

```powershell
npx wrangler secret put MICROSOFT_CLIENT_ID
```

Set the client-secret **Value**:

```powershell
npx wrangler secret put MICROSOFT_CLIENT_SECRET
```

Set the immutable Graph user ID:

```powershell
npx wrangler secret put OWNER_MICROSOFT_ID
```

Generate a 32-byte encryption key in PowerShell:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToHexString($bytes)
```

Store the generated 64-character hexadecimal value:

```powershell
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

Do not place any of these values in `wrangler.jsonc`, source files, issues, screenshots, or logs.

## 8. Deploy the configured Worker

```powershell
npm run deploy
```

`npm run deploy` validates placeholders, runs the TypeScript check and tests, then deploys.

Check:

```text
https://your-worker.your-subdomain.workers.dev/health
```

Expected shape:

```json
{"ok":true,"mcp":"/mcp","authState":true}
```

A healthy endpoint confirms deployment and bindings, not the complete Microsoft/ChatGPT OAuth flow.

## 9. Create the ChatGPT connector

In ChatGPT developer-mode connector settings:

- **Name:** any descriptive name.
- **Connection:** Server URL.
- **Server URL:** `https://your-worker.your-subdomain.workers.dev/mcp`
- **Authentication:** OAuth.

Create or connect the app. The expected browser sequence is:

```text
ChatGPT connector authorization
  -> Worker consent page
  -> Microsoft sign-in and consent
  -> Worker callback
  -> ChatGPT
```

The Microsoft consent should request read access, not write access.

## 10. Test the connector

Start with:

```text
Use the OneDrive connector and run onedrive_status.
```

Then:

```text
Search the allowed OneDrive folder for a term that exists in several files.
```

Finally ask it to read a bounded excerpt from one returned file.

This verifies:

- ChatGPT OAuth;
- Microsoft OAuth and refresh-token storage;
- owner-account restriction;
- allowed-root restriction;
- live Graph search;
- on-demand download and conversion.

## Updating

```powershell
git pull
npm ci
npm run deploy
```

Migrations in `wrangler.jsonc` must not be removed or renamed after deployment.

## Removing the deployment

Disconnect and delete the custom connector in ChatGPT, then remove Cloudflare resources as appropriate:

```powershell
npx wrangler delete
```

Also remove or disable the Microsoft client secret and app registration when no longer needed. KV and Durable Object data should be deleted from Cloudflare separately if the account UI retains them.
