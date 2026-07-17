# Architecture

## Request path

```text
ChatGPT
  -> Cloudflare OAuth provider
  -> MCP Durable Object
  -> Microsoft Graph
  -> personal OneDrive
```

## OAuth layers

There are two separate OAuth relationships:

1. ChatGPT authorizes against the Worker-hosted MCP server.
2. The Worker authorizes against Microsoft Graph for the OneDrive owner.

Pending approvals, Microsoft callback state, and encrypted Microsoft tokens are stored in the `AuthState` Durable Object. Strong consistency is necessary because each value is written and immediately consumed by a subsequent browser request.

Workers KV remains responsible for:

- the Cloudflare OAuth-provider library storage;
- optional converted-document text cache.

## Access restrictions

The Microsoft delegated `Files.Read` permission applies to the signed-in account. The narrower folder restriction is enforced by the Worker:

- searches are filtered by the resolved Graph parent path;
- folder listing accepts only normalized relative paths;
- every file ID is resolved and path-checked before download;
- `.` and `..` traversal segments are rejected;
- a single immutable Graph user ID is accepted during Microsoft OAuth.

## File reads

1. Resolve item metadata from the item ID.
2. Verify the item is below `ONEDRIVE_ROOT`.
3. Enforce the configured file-size limit.
4. Download the current file from Microsoft Graph.
5. Convert or decode it.
6. Return only the requested character slice.
7. Optionally cache converted text by user ID, item ID, and eTag hash.

## Conversion paths

- Plain text and code: `TextDecoder`.
- PPTX: Open XML ZIP extraction using `fflate`; slides and notes are returned as Markdown sections.
- Rich documents and images: Cloudflare Workers AI `toMarkdown`.

## Durable Objects

- `OneDriveMCP`: MCP agent/session implementation.
- `AuthState`: strongly consistent OAuth state and encrypted Microsoft-token storage.

Do not delete or reorder existing migration tags in a deployed Worker.
