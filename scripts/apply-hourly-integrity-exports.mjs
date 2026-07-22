import fs from "node:fs";

const path = new URL("../src/integrity-lease-tools.ts", import.meta.url);
let source = fs.readFileSync(path, "utf8");

const replacements = [
  ["async function executeWithLease(", "export async function executeWithLease("],
  ["async function executionState(", "export async function executionState("],
  ["async function startDiffWithCoordination(", "export async function startDiffWithCoordination("],
  ["async function getJobWithCoordination(", "export async function getJobWithCoordination("],
];

for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  if (!source.includes(before)) throw new Error(`Expected integrity scheduler export target is missing: ${before}`);
  source = source.replace(before, after);
}

fs.writeFileSync(path, source);
