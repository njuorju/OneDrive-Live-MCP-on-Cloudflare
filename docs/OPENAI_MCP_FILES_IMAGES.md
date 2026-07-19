# ChatGPT, MCP image content, and exact-file transfer

Reviewed on **2026-07-18** before implementing the visual and original-file tools.

## Selected mechanisms

### Visual analysis

`fetch_image_for_analysis` returns an MCP `ImageContent` block:

```json
{
  "type": "image",
  "data": "<base64 PNG bytes>",
  "mimeType": "image/png"
}
```

The base64 is used only in the protocol-defined image content block. It is not embedded in an ordinary JSON or text response. The Worker downloads the authenticated OneDrive bytes, revalidates the configured root, checks the signature and decoded dimensions, and returns a bounded PNG preview produced from raw bytes through the Cloudflare Images binding.

### Exact original-file reuse

`fetch_original_file` returns an MCP `resource_link` using a private `onedrive-original://` URI. The MCP resource handler then:

1. authenticates the current MCP session;
2. revalidates the item ancestry against the configured OneDrive root;
3. revalidates the current eTag, allowlisted extension, normalized MIME type, signature, and byte-size limit;
4. returns the exact original bytes as MCP binary resource contents (`blob`).

The connector does not return a Microsoft Graph download URL, public URL, anonymous share, or persistent OneDrive sharing link.

## Why ordinary JSON, prose, and Graph URLs were rejected

- A text description or extracted Markdown is not visual input.
- Base64 placed inside ordinary JSON is not an MCP image or file primitive.
- Microsoft Graph download URLs are temporary upstream implementation details and may carry sensitive access context.
- Public or anonymous links would broaden access outside the authenticated connector.

## Current platform limitations

Cloudflare Images supports raw-byte transformation for JPEG, PNG, GIF, WebP, SVG, and HEIC inputs. The connector therefore provides deterministic analysis previews for those supported inputs. TIFF, BMP, EMF, and WMF remain discoverable, metadata/signature checked, and retrievable unchanged through `fetch_original_file`, but the Worker fails closed rather than claiming a visual preview when the deployed conversion platform cannot safely decode them.

Animated GIF/WebP analysis uses a still first-frame PNG (`anim: false`). The original animation remains unchanged and can be retrieved through `fetch_original_file`.

PDF and Office document reading remain separate from image analysis. This patch does not silently rasterize whole documents as images.

## Official references

### OpenAI

- Apps SDK: build an MCP server: https://developers.openai.com/apps-sdk/build/mcp-server/
- OpenAI Apps SDK examples: https://github.com/openai/openai-apps-sdk-examples
- Build with the Apps SDK: https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk
- Developer mode and full MCP connectors: https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta

### Model Context Protocol

- Tool result content, including `ImageContent` and resource links: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Schema definitions for `ImageContent`, `ResourceLink`, and binary resource contents: https://modelcontextprotocol.io/specification/2025-11-25/schema
- Resource contents: https://modelcontextprotocol.io/specification/2025-06-18/server/resources

### Cloudflare

- Images binding for raw image bytes: https://developers.cloudflare.com/images/optimization/binding/
- Images supported formats and limits: https://developers.cloudflare.com/images/reference/supported-formats/

### Microsoft Graph

- `driveItem` resource, eTag, image, photo, remoteItem, and parentReference facets: https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0
- Upload or replace small-file content: https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0
- Create a folder: https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0
- Move a driveItem: https://learn.microsoft.com/en-us/graph/api/driveitem-move?view=graph-rest-1.0
