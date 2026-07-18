# OneDrive Live MCP on Cloudflare

A private remote MCP server that lets ChatGPT work with one configured folder tree in a **personal Microsoft OneDrive** account without a local workstation, tunnel, or recurring corpus snapshot.

```text
ChatGPT
  -> authenticated MCP over HTTPS
  -> Cloudflare Worker
  -> Microsoft Graph delegated Files.ReadWrite
  -> one configured OneDrive folder tree
```

The Microsoft permission is account-wide, but the Worker is deliberately narrower. Every source item and destination folder is independently resolved and its live ancestry is walked back to `ONEDRIVE_ROOT` before reading, retrieving, renaming, replacing, moving, or creating content.

The connector does **not** expose deletion, recycle-bin, sharing, public-link, permission-management, cross-drive move, arbitrary Graph request, arbitrary URL fetch, arbitrary binary upload, or Office-binary editing tools.

## Features

- Live Microsoft Graph search across filenames, metadata, and Microsoft-indexed contents.
- Folder browsing and bounded document-text extraction under one configured root.
- Direct PPTX slide and speaker-note extraction.
- Cloudflare Workers AI conversion for supported PDF, Office, image, HTML, XML, CSV, ODT/ODS, and related formats.
- Visual-asset discovery with dimensions, orientation, modified date, eTag, and analysis/original availability.
- Actual MCP image content for vision-capable model analysis.
- Exact original-file retrieval through an authenticated MCP resource link.
- Bounded creation of folders and UTF-8 text/code files.
- Mandatory eTag concurrency for text replacement.
- Root-scoped rename and move operations with conflict and circular-move checks.
- Fresh Microsoft consent for delegated `Files.ReadWrite`, `User.Read`, and `offline_access`.
- Immutable Microsoft-account allow-list.
- Strongly consistent one-time OAuth state in a Durable Object.
- Microsoft tokens encrypted before Durable Object storage.
- Optional converted-text cache in Workers KV; disabling it performs no cache reads or writes.
- Separate liveness and authenticated readiness endpoints.

## MCP tools

### Existing read compatibility

- `onedrive_status`
- `search_onedrive`
- `search_onedrive_work`
- `list_onedrive_folder`
- `list_onedrive_work_folder`
- `read_onedrive_file`
- `read_onedrive_work_file`
- canonical `search`
- canonical `fetch`

### Visual and exact-file retrieval

- `list_visual_assets`
- `get_image_metadata`
- `fetch_image_for_analysis`
- `fetch_original_file`

Recommended model sequence:

1. Discover candidates with `list_visual_assets`.
2. Inspect shortlisted candidates with `get_image_metadata`.
3. Call `fetch_image_for_analysis` to return actual MCP image content.
4. Select the relevant asset.
5. Call `fetch_original_file` to retrieve the unchanged original for reuse in an artifact.

### Bounded writes

- `create_folder`
- `create_text_file`
- `replace_text_file`
- `rename_item`
- `move_item`

All read tools are annotated read-only. Write tools are annotated mutating but non-destructive because no delete, recycle-bin, share, or permission operation exists.

## Image and file-transfer mechanisms

`fetch_image_for_analysis` returns a protocol-defined MCP `image` content block containing a bounded PNG preview. It does not return a prose description, extracted Markdown, ordinary JSON base64, a Graph download URL, or a public URL.

`fetch_original_file` returns an MCP `resource_link` using a private `onedrive-original:///items/...` URI. The authenticated resource handler revalidates the root boundary, eTag, allowlisted type, file signature, and size, then returns exact original bytes as binary MCP resource content.

See **[docs/OPENAI_MCP_FILES_IMAGES.md](docs/OPENAI_MCP_FILES_IMAGES.md)** for the protocol decision and official references.

## Quick start

1. Clone and install pinned dependencies:

   ```bash
   npm ci
   npx wrangler login
   ```

2. Create a Workers KV namespace:

   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```

3. Edit the tracked **sanitized template** `wrangler.jsonc`:

   - replace `REPLACE_WITH_KV_NAMESPACE_ID`;
   - replace `REPLACE_WITH_ALLOWED_ONEDRIVE_FOLDER` with the exact folder path, such as `Work` or `Work/Projects`;
   - preserve all existing Durable Object migrations;
   - ensure the `AI` and `IMAGES` bindings are available;
   - optionally rename the Worker and connector.

   Do not deploy the repository template over an existing personalized Worker until its live bindings, root, account-specific non-secret values, and rollback version have been captured.

4. Add Worker secrets by name only:

   ```bash
   npx wrangler secret put MICROSOFT_CLIENT_ID
   npx wrangler secret put MICROSOFT_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY
   npx wrangler secret put OWNER_MICROSOFT_ID
   ```

5. Validate before deployment:

   ```bash
   npm run check
   npx wrangler deploy --dry-run --outdir dist
   ```

6. Follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for in-place deployment, rollback capture, fresh Microsoft consent, and bounded acceptance tests.

## Configuration

Tracked non-secret configuration in `wrangler.jsonc`:

| Variable | Purpose | Default |
|---|---|---:|
| `CONNECTOR_NAME` | Human-readable consent/app name | `OneDrive Live MCP` |
| `ONEDRIVE_ROOT` | Exact allowed OneDrive folder path | required |
| `MAX_FILE_MB` | Maximum text-extraction download size | `20` |
| `MAX_ORIGINAL_FILE_MB` | Maximum exact original-file size | `25` |
| `MAX_TEXT_WRITE_KB` | Maximum UTF-8 text creation/replacement size | `512` |
| `MAX_READ_CHARS` | Maximum text characters returned per call | `50000` |
| `CACHE_TTL_SECONDS` | Converted-text cache lifetime; `0` fully disables cache I/O | `604800` |
| `MAX_IMAGE_INPUT_MB` | Maximum source image bytes accepted for analysis | `15` |
| `MAX_IMAGE_PIXELS` | Maximum decoded pixel count | `40000000` |
| `MAX_IMAGE_DIMENSION` | Maximum source width or height | `8192` |
| `MAX_IMAGE_PAGES` | Reserved bounded multi-page visual limit | `8` |
| `IMAGE_PROCESSING_TIMEOUT_MS` | Image inspection/conversion timeout | `15000` |

Malformed, negative, non-finite, fractional, or out-of-range numeric values fail closed during readiness and at use sites.

Cloudflare Worker secrets:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`
- `OWNER_MICROSOFT_ID`

Never commit these values, `.dev.vars`, OAuth state, tokens, downloaded OneDrive files, or private image fixtures.

## Data handling

There is no full OneDrive snapshot. Search and folder listing are live. A requested file is downloaded only for text extraction, visual analysis, or exact original retrieval.

Converted document text may be cached for the configured TTL. Cache keys are one-way hashes of item version material and contain no token, account identifier, drive identifier, raw item ID, or raw eTag. Set `CACHE_TTL_SECONDS` to `0` to perform no cache reads and no cache writes.

Original files and generated visual previews are not written back to OneDrive. Visual previews are ephemeral Worker results. No sharing link is created.

See **[SECURITY.md](SECURITY.md)** for the threat model and storage boundaries.

## Supported formats

### Text extraction

Direct decoding:

- text, Markdown, JSON, YAML, TOML, INI, logs;
- common programming and shell-script formats;
- PPTX/POTX slides and speaker notes.

Cloudflare Workers AI conversion includes supported PDF, DOCX, XLS/XLSX, CSV, HTML/XML, ODT/ODS, and image formats. Availability and account limits depend on Cloudflare.

### Visual analysis

Direct or deterministic Cloudflare Images preview support in this Worker:

- JPG/JPEG;
- PNG;
- WebP;
- GIF as a non-animated first-frame preview;
- HEIC/HEIF where Cloudflare Images accepts the input;
- SVG rasterized to PNG.

TIFF, BMP, EMF, and WMF are discoverable, signature-checked, and retrievable unchanged through `fetch_original_file`, but the current Cloudflare Images binding does not provide a safe maintained decoder for them. The connector fails closed instead of claiming an analysis preview.

PDF and Office documents remain separate document-reading workflows; they are not silently treated as whole-document images.

### Exact original retrieval

Allowlisted originals include common images plus PDF, PPTX, POTX, DOCX, XLSX, CSV, JSON, Markdown, plain text, and common source/configuration formats. Exact bytes, filename, normalized MIME type, size, item ID, and eTag are preserved.

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
src/                  Worker, OAuth, Graph, root-boundary, MCP, image, resource, and write code
test/                 Unit, integration, protocol, security, image, original-file, and write tests
docs/                 Deployment, architecture, protocol, and troubleshooting
scripts/              Configuration validation
.github/workflows/    CI
wrangler.jsonc        Sanitized bindings and non-secret settings template
```

## Important limitations

- The implementation targets personal Microsoft accounts through the `consumers` OAuth tenant.
- Microsoft `Files.ReadWrite` is account-wide; the configured root is an application boundary enforced by Worker code.
- OneDrive live search depends on Microsoft indexing, so newly uploaded content may not appear immediately.
- A fresh Microsoft consent flow is required after upgrading from `Files.Read`.
- Actual ChatGPT vision consumption and artifact-environment reuse of original files must be verified against the deployed connector; successful Graph download alone is not acceptance.
- Direct upload of generated PPTX/DOCX/XLSX files to OneDrive is intentionally outside this patch.

## License

MIT
