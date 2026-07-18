import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const indexSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const fileSource = await readFile(new URL("../src/onedrive-files.ts", import.meta.url), "utf8");
const authSource = await readFile(new URL("../src/microsoft-auth.ts", import.meta.url), "utf8");

describe("MCP tool discovery contract", () => {
  for (const tool of [
    "onedrive_status",
    "search_onedrive",
    "search_onedrive_work",
    "list_onedrive_folder",
    "list_onedrive_work_folder",
    "read_onedrive_file",
    "read_onedrive_work_file",
    "list_visual_assets",
    "get_image_metadata",
    "fetch_image_for_analysis",
    "fetch_original_file",
    "create_folder",
    "create_text_file",
    "replace_text_file",
    "rename_item",
    "move_item",
  ]) {
    it(`registers ${tool}`, () => {
      assert.match(indexSource, new RegExp(`["']${tool}["']`));
    });
  }

  it("preserves the standard search/fetch aliases", () => {
    assert.match(indexSource, /["']search["']/);
    assert.match(indexSource, /["']fetch["']/);
  });

  it("marks read tools and write tools distinctly", () => {
    assert.match(indexSource, /const READ_ONLY[\s\S]*readOnlyHint:\s*true/);
    assert.match(indexSource, /const MUTATING[\s\S]*readOnlyHint:\s*false/);
    assert.match(indexSource, /destructiveHint:\s*false/);
  });
});

describe("image and original-file protocol", () => {
  it("returns actual MCP image content", () => {
    assert.match(fileSource, /type:\s*["']image["']/);
    assert.match(fileSource, /mimeType:\s*["']image\/png["']/);
    assert.match(indexSource, /result\.image/);
  });

  it("returns an MCP resource link rather than a Graph URL", () => {
    assert.match(fileSource, /type:\s*["']resource_link["']/);
    assert.match(fileSource, /onedrive-original:\/\//);
    assert.match(indexSource, /registerResource/);
    assert.doesNotMatch(indexSource, /graph\.microsoft\.com/);
  });

  it("validates exact original bytes in the resource handler", () => {
    assert.match(fileSource, /validateFileSignature\(verified\.item\.name, buffer/);
    assert.match(fileSource, /verified\.item\.eTag !== expectedEtag/);
  });
});

describe("OAuth and readiness hardening", () => {
  it("forces fresh Microsoft consent", () => {
    assert.match(authSource, /prompt["'],\s*["']consent/);
    assert.match(authSource, /Files\.ReadWrite/);
  });

  it("keeps liveness and readiness separate", () => {
    assert.match(authSource, /app\.get\(["']\/health["']/);
    assert.match(authSource, /app\.get\(["']\/ready["']/);
  });

  it("does not expose raw upstream OAuth error descriptions", () => {
    assert.doesNotMatch(authSource, /error_description/);
  });
});
