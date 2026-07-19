# Validation

Validated in GitHub Actions on **2026-07-18** from branch `work/onedrive-write-images`.

## Repository and protocol validation

Successful CI run:

- workflow run: `29642802086`
- validated commit: `97b428fcfbe3e0c92d0ed4ae8824bd9b05e92ed0`
- pinned public-registry dependency install: passed
- `npm run type-check`: passed
- `npm test`: **108 passed, 0 failed, 0 skipped** across **19 suites**
- `npm audit --audit-level=high`: passed
- `wrangler deploy --dry-run` with non-secret temporary placeholder replacements: passed

The dry-run recognized:

- `OneDriveMCP` Durable Object through `MCP_OBJECT`;
- `AuthState` Durable Object through `AUTH_STATE`;
- the unchanged `v1` and `v2` Durable Object migration history;
- `OAUTH_KV`;
- Workers AI through `AI`;
- Cloudflare Images through `IMAGES`;
- all tracked bounded runtime variables.

## Test coverage

The passing suite covers:

- existing OAuth-state and CSRF regression behavior;
- valid `Files.ReadWrite`, stale `Files.Read`, missing authentication, and sanitized refresh failure;
- live in-root ancestry, outside-root items, remote items, cross-drive items, cycles, missing ancestry, and stale ancestry;
- plain and encoded traversal, ambiguous paths, deceptive names, and reserved names;
- strict numeric configuration and zero-cache behavior with no KV reads or writes;
- file allowlists, MIME normalization, signature mismatch, HEIF/WMF signatures, and PPTX/POTX/DOCX/XLSX package markers;
- folder and UTF-8 text creation, conflict rejection, mandatory eTag replacement, stale eTag rejection, rename, move, circular-move rejection, and read-back;
- visual discovery filters, dimensions, orientation, recursion, pagination, encrypted cursors, and cursor/filter binding;
- actual MCP image content for JPG, PNG, WebP, GIF, HEIC, and SVG fixtures;
- image signature mismatch, out-of-root rejection, source-size limits, decoded-pixel bomb rejection, and processing timeout;
- exact-byte PPTX and POTX original-file resource round trips, filename/MIME/eTag preservation, stale resource eTag rejection, folder/type/size/root rejection;
- MCP tool registration, compatibility aliases, annotations, image result shape, resource-link result shape, fresh consent, and liveness/readiness separation.

## Repository hygiene

- The previous lockfile referenced an internal package mirror and was removed.
- A clean `package-lock.json` was regenerated from `https://registry.npmjs.org/` and committed.
- `.gitignore` excludes secrets, `.dev.vars`, local state, downloaded OneDrive files, private fixtures, and generated acceptance output.
- `.dev.vars.example` contains variable names and explanations only.
- No secret values, OAuth tokens, downloaded OneDrive content, private image fixtures, account IDs, drive IDs, or production KV namespace IDs were added to the repository.

## Not yet performed

The following require the Cloudflare production control plane, the live ChatGPT app connection, and interactive Microsoft consent. They were **not** performed in this validation run:

- inspection and capture of the active `nikolay-onedrive-mcp` Worker version and deployment ID;
- confirmation of the immediate live rollback version;
- reconciliation of the sanitized repository `wrangler.jsonc` with the personalized production Worker bindings and non-secret values;
- live Worker deployment;
- fresh Microsoft consent through the deployed connector;
- ChatGPT disconnect/reconnect and live MCP tool rediscovery;
- live bounded write acceptance in `_MCP_WRITE_TEST`;
- live visual-analysis acceptance through ChatGPT;
- live exact-original retrieval into ChatGPT's artifact environment;
- one-slide PPTX image embedding and rendered visibility acceptance.

These steps are documented in `docs/DEPLOYMENT.md`. They must not be reported as successful merely because repository tests, a Worker dry-run, or a Microsoft Graph byte download succeeds.

## Current implementation limitation

Cloudflare Images provides the maintained raw-byte preview path used here for JPEG, PNG, GIF, WebP, SVG, and HEIC/HEIF inputs. TIFF, BMP, EMF, and WMF remain discoverable, metadata/signature checked, and exact-original retrievable, but visual preview conversion fails closed in this Worker release rather than relying on an unsafe or unmaintained decoder.
