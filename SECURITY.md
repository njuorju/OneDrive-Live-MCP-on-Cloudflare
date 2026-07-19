# Security policy and data boundaries

## Intended use

This project is a private, single-owner connector for one configured folder tree in a personal Microsoft OneDrive account. It supports live reads, visual analysis, exact original-file retrieval, and a deliberately small set of non-destructive writes.

It is not a general Microsoft Graph proxy and must not be expanded into one.

## Microsoft permissions

The Entra application should have only delegated:

- `Files.ReadWrite`
- `User.Read`
- `offline_access` requested during OAuth

Do not grant application permissions or broader delegated Graph permissions.

The OAuth callback and token refresh path reject sessions whose returned scope does not contain `Files.ReadWrite`. Upgrading from a prior `Files.Read` deployment requires fresh Microsoft consent.

## Application-level root boundary

Microsoft `Files.ReadWrite` is account-wide. `ONEDRIVE_ROOT` is therefore the critical application boundary.

For every applicable operation, the Worker:

1. resolves the configured root live;
2. resolves the source item or destination folder live;
3. walks the current parent chain to the configured root;
4. requires every ancestor to remain on the same drive;
5. rejects remote/shared items, deleted items, ancestry cycles, missing parents, cross-drive references, and any ancestry it cannot prove;
6. independently revalidates sources and destinations immediately before retrieval or mutation.

Paths are relative to the configured root. The parser repeatedly decodes URL encoding and rejects absolute paths, encoded traversal, ambiguous separators, root aliases, control characters, leading/trailing segment whitespace, and `.`/`..` segments.

No tool returns account IDs, drive IDs, SharePoint site IDs, unrestricted Graph URLs, or absolute OneDrive paths outside the configured root.

## Excluded operations

The MCP surface intentionally excludes:

- deletion and recycle-bin actions;
- sharing, anonymous links, and public links;
- permission changes;
- cross-drive moves;
- arbitrary Graph requests;
- arbitrary URL fetching;
- arbitrary binary upload;
- Office binary editing;
- direct upload of generated artifacts.

## Write safety

- Folder and text-file creation fail on naming conflicts.
- Names reject separators, traversal, control characters, reserved device names, trailing periods/spaces, and overlong UTF-8 values.
- Text creation and replacement are allowlisted by extension and bounded by UTF-8 byte length.
- Text replacement requires an exact current eTag and sends `If-Match`.
- Rename and move revalidate current ancestry and use eTag preconditions where available.
- Move independently validates source and destination, rejects cross-drive moves, and rejects moving a folder into itself or a descendant.
- The configured root itself cannot be renamed or moved through connector tools.

## Image and file safety

Visual analysis is performed from authenticated OneDrive bytes, never a Microsoft Graph download URL or public sharing link.

Before analysis or original-file delivery, the Worker applies:

- source-byte limits;
- allowlisted extensions and normalized MIME types;
- material MIME/extension/signature consistency checks;
- decoded width, height, and pixel-count limits;
- bounded output dimensions and output size;
- processing timeout;
- first-frame policy for animated GIF/WebP previews;
- eTag validation for exact original-file resource reads.

The Worker uses Cloudflare Images only for formats the binding safely accepts. Unsupported conversion formats fail closed. Original files are never resized, recompressed, rasterized, or rewritten by `fetch_original_file`.

Sensitive EXIF such as GPS coordinates is not returned by default.

## Secrets

The following values must remain Cloudflare Worker secrets:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `OWNER_MICROSOFT_ID`
- `COOKIE_ENCRYPTION_KEY`

The client ID is not a credential by itself, but keeping account-specific values outside the repository prevents accidental personalization and disclosure.

Never commit `.dev.vars`, OAuth state, authorization codes, generated tokens, test credentials, downloaded OneDrive files, or private fixtures.

## Token storage

Microsoft access and refresh tokens are encrypted using AES-GCM before storage in the `AuthState` Durable Object. The encryption key is a Worker secret.

Rotating `COOKIE_ENCRYPTION_KEY` invalidates existing stored Microsoft authorization. Reconnect the ChatGPT connector after an authorized rotation.

## OAuth state

One-time ChatGPT approval records and Microsoft callback state are stored in a strongly consistent Durable Object with explicit expiration. They are consumed once and deleted.

OAuth and Graph upstream response bodies are never returned to tools or logged. Failures expose only a sanitized category, retryability, and a connector-generated correlation ID.

## Document-content caching

Converted document text may be cached in Workers KV.

- Default retention: seven days.
- Cache key: one-way hash of item/version material; no raw token, account ID, drive ID, item ID, or eTag.
- Maximum cached text: 10 million characters per converted document.
- `CACHE_TTL_SECONDS=0`: no cache read and no cache write.

OAuth provider records also use the configured KV namespace.

Image previews and exact original-file bytes are not written to the document-text cache.

## Logging

Logs must never contain:

- cookies;
- approval IDs or OAuth state values;
- PKCE challenges/verifiers;
- Microsoft authorization codes;
- access or refresh tokens;
- client secrets;
- raw upstream OAuth/Graph response bodies;
- account IDs, drive IDs, or unrestricted Graph URLs;
- document or image contents.

Sanitized error logs contain an event name, category, retryability, optional HTTP status, and connector-generated correlation ID.

## Deployment and rollback

Before an in-place upgrade:

- capture the currently active Worker version and deployment identifier;
- confirm account-specific bindings and non-secret values;
- preserve every existing Durable Object migration;
- keep the previous version available as the immediate rollback target;
- never deploy the repository's sanitized `wrangler.jsonc` over the personalized Worker without reconciling live configuration.

A successful source build is not evidence that ChatGPT vision or artifact-file reuse works. Both require deployed connector acceptance tests.

## Reporting vulnerabilities

Do not publish credentials, account identifiers, private Worker URLs, OAuth URLs, OneDrive content, private fixtures, or generated resource URIs in a public issue. Use a private disclosure channel maintained by the repository owner.
