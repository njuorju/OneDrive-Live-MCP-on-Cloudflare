# Changelog

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
