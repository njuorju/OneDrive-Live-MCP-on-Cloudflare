# OneDrive Live MCP on Cloudflare

A private, read-only remote MCP server that lets ChatGPT search and read a selected folder in a **personal Microsoft OneDrive** account without a local workstation, tunnel, or recurring corpus snapshot.

```text
ChatGPT
  -> remote MCP over HTTPS
  -> Cloudflare Worker
  -> Microsoft Graph
  -> one configured OneDrive folder tree
```

The server searches OneDrive live and downloads only the files requested for reading. It does not expose upload, edit, move, share, or delete tools.

## Features

- Live Microsoft Graph search across filenames, metadata, and Microsoft-indexed contents.
- Folder browsing under one configured root.
- On-demand bounded reads rather than a full local index.
- Direct PPTX slide and speaker-note extraction.
- Cloudflare Workers AI conversion for PDF, Office, image, HTML, XML, CSV, ODT/ODS, and other supported formats.
- Plain-text and source-code decoding without AI conversion.
- Microsoft OAuth delegated permissions limited to `Files.Read` and `User.Read`.
- Immutable Microsoft-account allow-list.
- Exact allowed-root path enforcement on search, listing, and reads.
- Strongly consistent one-time OAuth state in a Durable Object.
- Microsoft tokens encrypted before Durable Object storage.
- Optional converted-text cache in Workers KV.

## MCP tools

- `onedrive_status`
- `search_onedrive`
- `list_onedrive_folder`
- `read_onedrive_file`

All tools are annotated as read-only.

## Quick start

1. Clone the repository and install dependencies:

   ```bash
   npm ci
   npx wrangler login
   ```

2. Create a Workers KV namespace:

   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```

3. Edit `wrangler.jsonc`:

   - replace `REPLACE_WITH_KV_NAMESPACE_ID`;
   - replace `REPLACE_WITH_ALLOWED_ONEDRIVE_FOLDER` with the exact folder path, such as `Work` or `Work/Projects`;
   - optionally rename the Worker and connector.

4. Follow the complete deployment guide:

   **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

   An optional deployment-agent prompt is available at **[docs/CODEX_DEPLOY_PROMPT.md](docs/CODEX_DEPLOY_PROMPT.md)**.

5. Validate locally before deployment:

   ```bash
   npm run check
   ```

## Configuration

Tracked configuration in `wrangler.jsonc`:

| Variable | Purpose | Default |
|---|---|---:|
| `CONNECTOR_NAME` | Human-readable consent/app name | `OneDrive Live MCP` |
| `ONEDRIVE_ROOT` | Exact allowed OneDrive folder path | required |
| `MAX_FILE_MB` | Maximum downloaded file size | `20` |
| `MAX_READ_CHARS` | Maximum characters returned per tool call | `50000` |
| `CACHE_TTL_SECONDS` | Converted-text cache lifetime; `0` disables it | `604800` |

Cloudflare Worker secrets:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`
- `OWNER_MICROSOFT_ID`

Never commit these values.

## Data handling

There is no full OneDrive snapshot. Search and folder listing are live. A requested file is downloaded only when `read_onedrive_file` is called.

By default, converted text up to 10 million characters is cached in Workers KV for seven days using a key derived from the file ID and eTag. Set `CACHE_TTL_SECONDS` to `0` to disable document-content caching.

See **[SECURITY.md](SECURITY.md)** for the threat model and storage boundaries.

## Supported documents

Direct decoding:

- text, Markdown, JSON, YAML, TOML, INI, logs;
- common programming and shell-script formats;
- PPTX slides and speaker notes.

Cloudflare Workers AI conversion:

- PDF;
- DOCX;
- XLS/XLSX/XLSM/XLSB;
- CSV;
- HTML and XML;
- ODT and ODS;
- common image formats;
- other formats supported by the Cloudflare conversion API.

Conversion availability and usage limits depend on the Cloudflare account.

## Development

```bash
npm run dev
npm run type-check
npm test
npm run check
```

For local secrets, copy `.dev.vars.example` to `.dev.vars`. The real `.dev.vars` file is ignored by Git.

## Repository layout

```text
src/                  Worker, OAuth, Graph, MCP, and extraction code
test/                 OAuth state and CSRF tests
docs/                 Deployment, architecture, and troubleshooting
scripts/               Configuration validation
.github/workflows/     CI
wrangler.jsonc         Cloudflare bindings and non-secret settings
```

## Important limitations

- This implementation targets personal Microsoft accounts through the `consumers` OAuth tenant.
- OneDrive live search depends on Microsoft indexing, so newly uploaded content may not appear immediately.
- The configured root is enforced by application code; Microsoft `Files.Read` itself is account-wide.
- The Worker must remain deployed and the Microsoft authorization must remain valid.
- This repository does not include write-capable tools.

## License

MIT
