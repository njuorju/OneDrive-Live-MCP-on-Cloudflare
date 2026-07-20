# OneDrive Live MCP on Cloudflare

A private OAuth-protected MCP server that gives ChatGPT live access to one configured folder tree in a personal Microsoft OneDrive account. The Worker supports ordinary search/read/write operations, deterministic document and visual inspection, immutable source-library snapshots, catalogue validation, and tightly controlled integrity plans.

```text
ChatGPT -> authenticated MCP -> Cloudflare Worker
        -> Microsoft Graph delegated Files.ReadWrite
        -> one configured OneDrive root
```

Microsoft permission is account-wide, but every source and destination is resolved live and walked back to `ONEDRIVE_ROOT`. Cross-drive, remote/shared, ambiguous, stale, or out-of-root operations fail closed.

## Permission boundary

The Entra application requires only:

- delegated `Files.ReadWrite`;
- delegated `User.Read`;
- OAuth `offline_access`.

Do not add `.All`, Sites, directory, application, or tenant-wide SharePoint permissions. The connector does not expose sharing, public links, permission changes, permanent deletion, recycle-bin emptying, arbitrary Graph requests, arbitrary URL fetches, or unrestricted binary uploads.

## Existing compatibility tools

The following names and schemas remain compatible:

`onedrive_status`, `search`, `search_onedrive`, `search_onedrive_work`, `fetch`, `read_onedrive_file`, `read_onedrive_work_file`, `list_onedrive_folder`, `list_onedrive_work_folder`, `list_visual_assets`, `get_image_metadata`, `fetch_image_for_analysis`, `fetch_original_file`, `create_folder`, `create_text_file`, `replace_text_file`, `rename_item`, `move_item`.

## Integrated tools

### Snapshots and inspection

- `create_source_snapshot`
- `query_source_snapshot`
- `compare_snapshot_to_live`
- `inspect_document`
- `calculate_file_hashes`
- `find_source_duplicates`

### Document visuals and rendering

- `scan_visual_sources`
- `list_document_visuals`
- `render_document_page`
- `fetch_document_visual_for_analysis`
- `fetch_document_visual_original`
- `save_document_visual`
- `create_visual_contact_sheet`
- `find_visual_duplicates`

### Copy, plans, catalogues, and jobs

- `copy_item`
- `create_integrity_plan`
- `validate_integrity_plan`
- `execute_integrity_plan`
- `get_integrity_plan_status`
- `diff_scope_before_after`
- `validate_catalogue`
- `classify_administrative_files`
- `get_job_status`

`execute_integrity_plan` is the only tool marked destructive. It can move explicitly approved items to the OneDrive recycle bin, never permanently delete them. It requires a validated, signed, short-lived token and rechecks ancestry, path, eTag, SHA-256, destination availability, dependencies, ambiguity, final decision, and deletion-log preparation before mutation.

See [docs/INTEGRATED_TOOLS.md](docs/INTEGRATED_TOOLS.md) for schemas, lifecycle, error behavior, limits, and format details.

## Architecture

One service layer is shared by recursive enumeration, root validation, verified download/upload/copy, hashing, extraction, visual provenance, rendering, snapshots, jobs, plans, locks, and audit logs. Results are versioned by item ID, eTag, and operation options. An eTag change invalidates extracted, rendered, hashed, and inventoried results.

- Existing Durable Object storage holds bounded snapshot metadata/records, jobs, plans, locks, and operation logs.
- Existing KV caches deterministic extracted text by version material.
- Cloudflare Images handles bounded image conversion and previews.
- Browser Run is used only for actual requested page/slide/contact-sheet rendering.
- Office rendering uses Microsoft Graph PDF conversion followed by exact requested-page rendering.
- No R2 bucket is required.

See [docs/INTEGRATED_SOURCE_INTEGRITY_ARCHITECTURE.md](docs/INTEGRATED_SOURCE_INTEGRITY_ARCHITECTURE.md).

## Supported formats

Deterministic inspection and normalized-text hashing: PDF, DOCX, PPTX, POTX, PPSX, HTML, TXT, Markdown, CSV, and JSON where readable text exists.

Visual inventory: common loose images plus PDF, DOCX, PPTX, POTX, and PPSX embedded media/composite objects. Exact embedded originals are distinguished from objects that require rendering. PDF exact image extraction is limited to safely identifiable embedded streams; page/region rendering is available separately.

Original loose-file retrieval retains the existing allowlist. Generated binary saving is restricted to PNG, JPEG, WebP, safe unchanged originals, and PDF where applicable. Silent overwrite is never allowed.

## Deterministic text normalization

Normalized-text SHA-256 uses UTF-8 text after Unicode NFKC normalization, BOM removal, normalized line endings, repeated-whitespace collapse, confident page-number-only line removal, and safe removal of obvious repeated extraction artefacts. Substantive word order is retained. Image-only/unextractable files return no normalized hash and `representation_status=image_only_or_unextractable`; bulk OCR is not automatic.

## Hard limits

| Limit | Value |
|---|---:|
| Snapshot records | 5,000 |
| Default snapshot records | 1,000 |
| Recursion depth | 128 |
| File processing | 100 MiB |
| Normalized extracted text | 2,000,000 characters |
| OOXML ZIP entries | 8,000 |
| OOXML compressed/uncompressed | 50/250 MiB |
| OOXML compression ratio | 200:1 |
| PDF pages | 500 |
| Presentation slides | 500 |
| Render dimension | 4,096 px |
| Visual candidates | 1,000 |
| Contact-sheet items | 64 |
| Hash batch | 100 |
| Snapshot/job/plan retention | 24 hours |
| Execution-token validity | 15 minutes |

Ordinary existing tool limits remain controlled by `wrangler.jsonc` variables.

## Cloudflare bindings

Required bindings:

- Durable Objects: `MCP_OBJECT`, `AUTH_STATE`;
- KV: `OAUTH_KV`;
- Workers AI: `AI`;
- Images: `IMAGES`;
- Browser Run: `BROWSER`.

Existing migrations remain unchanged: `v1 OneDriveMCP`, `v2 AuthState`. No R2, D1, Queue, Workflow, route, or additional secret is required.

## Development and validation

```bash
npm ci
npm run type-check
npm test
npm audit --audit-level=high
npx wrangler deploy --dry-run --outdir dist
```

CI verifies existing registrations, integrated registrations, deterministic fixtures, security boundaries, type checking, audit status, and the Worker bundle.

## Deployment

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Capture the current Worker version and live bindings before deployment. Deploy a staged version, run the synthetic acceptance workflow inside a timestamped folder under the configured root, recycle that folder through its own approved cleanup plan, then deploy production from the merged commit. Roll back by redeploying the captured version, not by rebuilding old source.

After production deployment, reconnect the ChatGPT app so the new MCP schemas are discovered. Microsoft reconsent is required only when the stored session lacks delegated `Files.ReadWrite` or the connector invalidates stale authorization.

## Security and data handling

Tokens are encrypted in `AuthState`. Logs exclude tokens, authorization headers, Graph download URLs, Browser Run URLs, raw document content, image bytes, secrets, and unnecessary account/drive identifiers. No sharing link is created. See [SECURITY.md](SECURITY.md).

## Known limitations

- Personal Microsoft accounts are targeted through the `consumers` OAuth tenant.
- Snapshot/job/plan state is deliberately bounded and expires after 24 hours.
- Bulk OCR is not performed.
- Exact PDF embedded-image extraction is conservative; use page/region rendering when an exact original cannot be proven.
- Word page rendering depends on Microsoft Graph PDF conversion; page boundaries are those of the converted PDF.
- Browser Run quota exhaustion returns a structured retryable error; the connector does not enable paid overage automatically.
- Rendering and OneDrive live mutations require deployed acceptance testing; source tests alone are not production acceptance.

## License

MIT
