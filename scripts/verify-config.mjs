import { readFile } from "node:fs/promises";

const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const placeholders = [...config.matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)].map((match) => match[0]);

if (placeholders.length > 0) {
  console.error(`wrangler.jsonc still contains placeholders: ${[...new Set(placeholders)].join(", ")}`);
  process.exit(1);
}

console.log("wrangler.jsonc contains no deployment placeholders.");
