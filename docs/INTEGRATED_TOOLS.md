# Integrated tool reference

All paths are relative to `ONEDRIVE_ROOT`. All item IDs are revalidated against the configured drive and root before retrieval or mutation. Existing compatibility tools retain their published schemas.

## Snapshot lifecycle

### `create_source_snapshot`

Inputs: `scopePath`, `recursive`, `includeFiles`, `includeFolders`, `calculateSha256`, `calculateNormalizedTextHash`, `includeDocumentMetadata`, `includeExtractionStatus`, `maximumItems`, `maximumDepth`, optional extension allow/deny lists.

Returns an immutable logical snapshot and a job ID for expensive requests. Records contain item/parent IDs, relative path, filename, extension, MIME type, size, timestamps, eTag, file/folder state, requested hashes, extraction status, metadata, and per-file structured errors. Creation never mutates OneDrive.

### `query_source_snapshot`

Filters by path, filename, extension, MIME, item type, size, language indicators, missing hashes, duplicate exact/normalized hashes, empty folders, forbidden filename patterns, administrative patterns, unsupported files, and extraction failures. Uses a sealed stable cursor.

### `compare_snapshot_to_live`

Reports live additions, removals, moves/renames, eTag/size/SHA changes, and changed folder structure. Mutation validation independently enforces matching item ID, path, eTag, size, and exact SHA where required.

## Inspection and hashing

### `inspect_document`

Accepts `itemId` or `snapshotItemId`, bounded start/output positions, extraction mode, and include flags. Returns title/application metadata where present, language indicators, headings, captions, hyperlinks, title-page/first-page evidence, header/footer text when extractable, page/slide and embedded-image counts, confidence, and representation status.

HTML diagnostics include visible body length, script text length, script count, empty app roots, OpenGraph-only metadata, meaningful offline text, and likely JavaScript-shell status. The connector reports evidence and does not decide legal authority or adoption status.

### `calculate_file_hashes`

Accepts one item, a bounded list, or a snapshot with pagination. Returns exact file SHA-256, normalized-text SHA-256 where possible, optional image dHash, source eTag, size, method, and representation status.

### `find_source_duplicates`

Groups `exact_binary_duplicate`, `normalized_text_duplicate`, `same_work_different_format`, `suspected_same_work`, and optionally `perceptually_similar_image`. It never decides deletion, edition equivalence, or retention policy.

## Visuals

### `scan_visual_sources`

Recursively inventories loose images and PDF/PPTX/POTX/PPSX/DOCX sources with likely visual counts, page/slide counts, original-media counts, composite-render requirements, and provenance.

### `list_document_visuals`

PPTX/POTX/PPSX: resolves `/ppt/media`, slide relationships, relationship IDs, object names, alt/title/description, hyperlinks, grouped/composite objects, charts, SmartArt, SVG/EMF/WMF references, and exact-original/render availability.

DOCX: resolves `/word/media`, document order, nearby headings/captions, Caption-style paragraphs, alt/title/description, and hyperlinks.

PDF: returns page candidates, page dimensions, safely identifiable exact raster streams, and render availability. Exact extraction is conservative.

Every visual ID is sealed, eTag-bound, root-bound, and expiring.

### `render_document_page`

Inputs: item ID, one-based page/slide, PNG/JPEG/WebP, width or DPI, optional height/crop, and transparency where supported. It renders the requested page; thumbnails or page 1 are never substituted. Office inputs are converted to PDF by Microsoft Graph first.

### `fetch_document_visual_for_analysis`

Modes: `original`, `rendered`, `region`. Returns actual bounded MCP image content.

### `fetch_document_visual_original`

Returns exact embedded bytes through an authenticated MCP resource. If exact unchanged bytes cannot be proven, returns `not_available`; it never substitutes a rasterized render.

### `save_document_visual`

Saves an exact original or render inside a verified destination. Conflict policy is `fail` by default or explicit `auto-rename`. Returns source provenance and output SHA-256.

### `create_visual_contact_sheet`

Accepts loose item IDs and/or visual IDs, optional custom labels, columns, thumbnail bounds, return/save options, and conflict policy. Aspect ratio is preserved. Large sheets scale to the render bound instead of cropping.

### `find_visual_duplicates`

Returns exact SHA-256 groups and bounded documented dHash similarity groups. No automatic move/recycle occurs.

## Copy and upload

### `copy_item`

Copies a file or folder within the same verified drive/root. It monitors the Graph long-running operation and does not treat HTTP 202 as completion. Conflict policy is `fail` or `auto-rename`; optional SHA-256 verification is available for files.

Binary uploads use direct upload at small sizes and upload sessions for larger outputs. Upload-session URLs are short-lived Microsoft URLs and receive no bearer token. Executable output extensions are not allowed.

## Integrity plans

### `create_integrity_plan`

Actions: `KEEP`, `RENAME`, `MOVE`, `RECYCLE`, `METADATA_ONLY`, `CATALOGUE_ONLY`, `CREATE_TEXT`, `REPLACE_TEXT`, `CREATE_FOLDER`, `RECYCLE_FOLDER`.

Every action supports source/destination paths, filenames, snapshot eTag/SHA/normalized SHA, reason, evidence, destructive/ambiguity/final-decision fields, order, dependencies, content, and placeholder protection. The tool returns JSON and CSV; it does not mutate OneDrive.

### `validate_integrity_plan`

Rejects out-of-scope operations, duplicate destinations, collisions, circular moves, dependency cycles/order errors, ambiguous destructive actions, missing approvals, stale IDs/paths/eTags/sizes/SHA values, missing recycle-log preparation, unsafe folder recycling, scope-root recycling, and protected placeholders. Success returns a signed 15-minute execution token.

### `execute_integrity_plan`

Runs serially under an overlap-aware scope lock. Before every action it revalidates root ancestry, item ID/path/eTag, destructive SHA, and destination availability. `RECYCLE`/`RECYCLE_FOLDER` use Microsoft Graph delete semantics to move approved items into the OneDrive recycle bin. Permanent deletion and recycle-bin emptying are absent.

Failures stop dependent actions, preserve successful unrelated actions, and return exact recovery state. No speculative automatic rollback is claimed.

### `get_integrity_plan_status` and `diff_scope_before_after`

Return plan/validation/execution status, completed/failed/skipped actions, operation-log evidence, expected/unexpected changes, final live additions/removals/moves/recycles/hash changes, administrative/substantive counts, empty folders, duplicates, and evidence of any operation outside scope.

## Catalogues

### `validate_catalogue`

Accepts CSV or JSON, snapshot/live scope, path/hash columns, exclusions, required columns, and controlled values. Reports missing files, uncatalogued substantive files, duplicate rows/IDs, non-sequential numeric IDs, exact/normalized hash mismatches, blanks, invalid codes, and administrative files included as substantive. It does not invent semantic metadata.

### `classify_administrative_files`

Uses caller-supplied filename/path patterns to classify manifests, reports, catalogues, logs, inventories, duplicate registers, audit tables, manual-download lists, and `_Catalogue` README files separately from substantive sources.

## Jobs and errors

`get_job_status` returns queued/running/completed/failed/cancelled state, progress, stage, result references, structured error/retryability, and expiry. Read-only inventories isolate malformed-file errors where safe. Mutation failures stop dependencies.

Errors contain a safe code, message, retryability, and correlation ID. They do not contain credentials, upstream bodies, signed URLs, or private file bytes.
