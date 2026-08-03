import { readFile, writeFile } from "node:fs/promises";

const helperPath = "scripts/apply-odl-req-020-probe-fix.mjs";
let helper = await readFile(helperPath, "utf8");
const oldBlock = `if (source.split(functionNeedle).length - 1 !== 1) {
  throw new Error("synthetic probe function guard failed");
}
const updated = source.replace(importNeedle, importReplacement).replace(functionNeedle, functionReplacement);`;
const newBlock = `let updated = source.replace(importNeedle, importReplacement);
const functionStart = updated.indexOf("async function syntheticVisionProbeJpeg(env: Env): Promise<Uint8Array> {");
const nextFunction = updated.indexOf("\\n\\nfunction probePassed(", functionStart);
if (functionStart < 0 || nextFunction < 0) {
  throw new Error("synthetic probe function boundary guard failed");
}
updated = updated.slice(0, functionStart) + functionReplacement + updated.slice(nextFunction);`;

if (helper.split(oldBlock).length - 1 !== 1) {
  throw new Error("helper repair guard failed");
}
helper = helper.replace(oldBlock, newBlock);
await writeFile(helperPath, helper, "utf8");
await import(`./apply-odl-req-020-probe-fix.mjs?run=${Date.now()}`);
