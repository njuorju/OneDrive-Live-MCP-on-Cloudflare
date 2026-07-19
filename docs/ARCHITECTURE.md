# Architecture

## Request path

```text
ChatGPT
  -> Cloudflare OAuth provider
  -> MCP Durable Object (`OneDriveMCP`)
  -> centralized root-boundary and Graph client
  -> Microsoft Graph delegated Files.ReadWrite
  -> personal OneDrive
```

Visual analysis additionally uses the Cloudflare Images binding on authenticated source bytes. Rich-document text extraction may use Workers AI. Neither service receives a public OneDrive URL.

## OAuth layers

There are two separate OAuth relationships:

1. ChatGPT authorizes against the Worker-hosted MCP server.
2. The Worker authorizes against Microsoft Graph for the single allowed OneDrive owner.

Pending approvals, Microsoft callback state, and encrypted Microsoft tokens are stored in the `AuthState` Durable Object. Strong consistency is necessary because each one-time value is written and immediately consumed by a subsequent browser request.

The Microsoft request uses delegated `Files.ReadWrite`, `User.Read`, and `offline_access`. The callback and refresh path reject sessions lacking `Files.ReadWrite`.

Workers KV remains responsible for:

- Cloudflare OAuth-provider library storage;
- optional converted-document text cache.

## Root security boundary

Microsoft authorization is account-wide. The Worker narrows it to `ONEDRIVE_ROOT`.

The central validator:

1. resolves the configured root live;
2. resolves an item by opaque OneDrive item ID or a strict root-relative path;
3. walks the item's current parent chain one ID at a time;
4. requires the chain to reach the configured root on the same drive;
5. rejects remote/shared items, deleted items, cycles, missing parents, cross-drive references, and unproven ancestry.

Source and destination validation is not reused as a permanent authorization fact. Every retrieval and mutation revalidates immediately before the Graph operation.

Search and list results are also passed through the same validator. Unsafe results are omitted rather than returned with an unproven path.

## Tool layers

### Compatibility reads

Existing generic and personalized tools remain available:

- status;
- search;
- folder listing;
- bounded text/Markdown extraction.

Canonical `search` and `fetch` aliases return stable item IDs and concise document results.

### Visual discovery and analysis

`list_visual_assets` scans a verified folder tree and returns bounded metadata. Recursive pagination uses an AES-GCM encrypted, filter-bound cursor. Graph continuation URLs and opaque item IDs inside cursor state are not exposed as plaintext.

`get_image_metadata` downloads and signature-checks the current image where required, then returns dimensions, orientation, animation/preview information, modified date, size, and eTag without GPS EXIF.

`fetch_image_for_analysis`:

1. revalidates the source ancestry;
2. downloads the current bytes under the input-size limit;
3. checks extension, Microsoft MIME metadata, and file signature;
4. uses Cloudflare Images to inspect decoded dimensions;
5. rejects excessive dimensions/pixels and processing timeout;
6. produces a bounded non-animated PNG preview;
7. returns protocol-defined MCP `ImageContent`.

The preview is ephemeral and is not written to OneDrive or KV.

### Exact original-file resources

`fetch_original_file` returns an MCP `resource_link` with a private path-based URI:

```text
onedrive-original:///items/<opaque-item-id>?etag=<version>
```

The item ID is placed in the path, not the hostname, because URL hostnames are case-normalized and OneDrive IDs are opaque.

The authenticated resource handler revalidates root ancestry, exact eTag, allowlisted extension, normalized MIME type, signature, and size, then returns unchanged bytes as MCP binary resource contents.

No Microsoft Graph download URL or public share is returned.

### Bounded writes

Write tools are separate from original-file retrieval:

- `create_folder` posts one folder with conflict behavior `fail`;
- `create_text_file` uploads allowlisted UTF-8 text with conflict behavior `fail` and `If-None-Match: *`;
- `replace_text_file` requires an exact expected eTag and sends `If-Match`;
- `rename_item` validates the parent, checks name conflicts, revalidates, and conditionally patches the item;
- `move_item` independently validates source and destination, rejects circular/cross-drive moves, checks destination conflicts, revalidates, and conditionally patches the parent reference.

The configured root cannot be renamed or moved through the connector.

## File-read path

1. Resolve and validate the item by ID.
2. Enforce configured source-size limits.
3. Revalidate immediately before download.
4. Download the current version from Microsoft Graph.
5. Decode plain text, extract PPTX/POTX Open XML, or use Workers AI for supported rich formats.
6. Return only the requested character slice.
7. Optionally cache converted text using a one-way hash of item/version material.

`CACHE_TTL_SECONDS=0` bypasses both cache reads and cache writes.

## Conversion paths

- Plain text and code: UTF-8 `TextDecoder`.
- PPTX/POTX: Open XML ZIP extraction using `fflate`; slides and notes become Markdown sections.
- Rich documents: Cloudflare Workers AI `toMarkdown` where supported.
- Image analysis preview: Cloudflare Images raw-byte binding, normalized to bounded PNG.
- Exact originals: no conversion, rewriting, recompression, resizing, or metadata changes.

## Error and logging path

OAuth and Graph response bodies are parsed only enough to classify a failure, then discarded. Tool errors contain:

- stable connector error code;
- sanitized message;
- retryability;
- connector-generated correlation ID.

Logs use the same categories and do not include tokens, account IDs, drive IDs, Graph URLs, or content.

## Readiness

- `/health`: process liveness only.
- `/ready`: required configuration, bindings, `AuthState` storage, configured root, stored OAuth scope, and bounded Graph reachability.

Readiness is authenticated in the sense that it depends on the stored owner token; it never returns owner or drive identifiers.

## Durable Objects and migrations

- `OneDriveMCP`: MCP agent/session implementation.
- `AuthState`: strongly consistent OAuth state and encrypted Microsoft-token storage.

Existing migration history:

- `v1`: `OneDriveMCP`
- `v2`: `AuthState`

Do not delete, rename, reorder, or recreate these migration tags in an existing deployment.
