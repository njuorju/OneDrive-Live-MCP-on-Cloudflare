# Changelog

## Unreleased — root-scoped writes and visual assets

- Preserved the existing generic and personalized read-tool names and added canonical `search`/`fetch` aliases.
- Upgraded Microsoft OAuth to delegated `Files.ReadWrite`, `User.Read`, and `offline_access` with mandatory fresh consent and stale-scope rejection.
- Added a centralized live root-ancestry validator used by reads, visual retrieval, exact-file retrieval, and mutations.
- Added `list_visual_assets`, `get_image_metadata`, `fetch_image_for_analysis`, and `fetch_original_file`.
- Added protocol-defined MCP image content for actual model vision input.
- Added authenticated exact-byte MCP resources for original-file reuse without Graph URLs or sharing links.
- Added bounded `create_folder`, `create_text_file`, `replace_text_file`, `rename_item`, and `move_item` tools.
- Added mandatory eTag concurrency for text replacement and eTag preconditions for rename/move where available.
- Added conflict checks, circular-move checks, strict names, UTF-8 byte limits, signature validation, image dimension/pixel/output limits, and processing timeouts.
- Added encrypted filter-bound visual pagination cursors.
- Made malformed numeric configuration fail closed.
- Made `CACHE_TTL_SECONDS=0` perform no cache reads or writes and replaced identity-bearing cache keys with hashes.
- Sanitized OAuth, Graph, status, readiness, and log errors.
- Split liveness and authenticated readiness.
- Added the Cloudflare Images binding while preserving all existing Durable Object migrations.
- Added `.gitignore`, `.dev.vars.example`, deterministic public-registry lockfile, and CI type/test/audit/bundle checks.
- Added unit, integration, and protocol tests for OAuth scope, refresh sanitization, root ancestry, traversal, cache disablement, writes, visual discovery, image analysis, original resources, file signatures, and tool contracts.

Known conversion limitation: Cloudflare Images safely accepts JPEG, PNG, GIF, WebP, SVG, and HEIC inputs. TIFF, BMP, EMF, and WMF remain discoverable and exact-original retrievable but fail closed for visual preview conversion in this release.

## 0.2.0

- Generalized the connector for publication.
- Removed account-specific IDs, folder names, Worker URLs, backups, generated files, and local caches.
- Renamed MCP tools to generic names.
- Added strongly documented Cloudflare and Microsoft deployment flow.
- Added optional document-cache disablement through `CACHE_TTL_SECONDS=0`.
- Moved the owner Graph ID to a Worker secret.
- Added CI, configuration validation, architecture, security, and troubleshooting documentation.

## 0.1.x

- Initial private deployment.
- Added encrypted Microsoft token storage.
- Added CSRF same-origin browser fallback.
- Replaced eventually consistent OAuth state storage with a Durable Object.
- Fixed consent redirect behavior for Microsoft authorization.
