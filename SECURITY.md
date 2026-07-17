# Security policy and data boundaries

## Intended use

This project is intended as a private, single-owner, read-only connector for a personal Microsoft OneDrive folder tree.

## Permissions

The Entra application should have only delegated:

- `Files.Read`
- `User.Read`

Do not grant write permissions unless the implementation is separately redesigned and audited for write operations.

## Secrets

The following values must be stored using Wrangler secrets:

- Microsoft client ID;
- Microsoft client secret;
- immutable Microsoft Graph owner ID;
- cookie/token encryption key.

The client ID is not a credential by itself, but keeping all account-specific values outside the repository prevents accidental personalization and disclosure.

## Token storage

Microsoft access and refresh tokens are encrypted using AES-GCM before storage in the `AuthState` Durable Object. The encryption key is a Worker secret.

Rotating `COOKIE_ENCRYPTION_KEY` invalidates existing stored Microsoft authorization. Reconnect the ChatGPT connector after rotation.

## OAuth state

One-time ChatGPT approval records and Microsoft callback state are stored in a strongly consistent Durable Object with explicit expiration. They are consumed once and deleted.

## Folder boundary

Microsoft `Files.Read` is broader than the configured folder. The application-level boundary is therefore critical. Every search result, list result, item lookup, and download is checked against `ONEDRIVE_ROOT`.

## Document-content caching

Converted document text may be cached in Workers KV. This means selected document content can be stored in Cloudflare after a read.

- Default retention: seven days.
- Cache key: user ID + item ID + eTag-derived hash.
- Maximum cached text: 10 million characters per converted document.
- Disable by setting `CACHE_TTL_SECONDS` to `0`.

OAuth provider records also use the configured KV namespace.

## Logging

The OAuth flow logs stages and safe metadata categories. It must never log:

- cookies;
- approval IDs or OAuth state values;
- PKCE challenges/verifiers;
- Microsoft authorization codes;
- access or refresh tokens;
- client secrets;
- document contents.

## Reporting vulnerabilities

Do not publish an issue containing credentials, account identifiers, private Worker URLs, OAuth URLs, or OneDrive content. Use a private disclosure channel maintained by the repository owner.
