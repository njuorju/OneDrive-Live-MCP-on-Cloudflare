import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const path = "src/visual-catalogue-probe-fixture.ts";
let source = await readFile(path, "utf8");
const match = source.match(/const OPENCODE_VISION_PROBE_JPEG_BASE64 = "([A-Za-z0-9+/=]+)";/);
if (!match) throw new Error("probe base64 guard failed");
const bytes = Buffer.from(match[1], "base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");
source = source
  .replace(/export const OPENCODE_VISION_PROBE_JPEG_SHA256 = "[0-9a-f]{64}";/, `export const OPENCODE_VISION_PROBE_JPEG_SHA256 = "${sha256}";`)
  .replace(/export const OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH = \d+;/, `export const OPENCODE_VISION_PROBE_JPEG_BYTE_LENGTH = ${bytes.byteLength};`);
await writeFile(path, source, "utf8");
console.log(JSON.stringify({ byteLength: bytes.byteLength, sha256 }));
